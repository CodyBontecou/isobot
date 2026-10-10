import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions, type V4MiniflareOptions } from "miniflare";
import { createTicketIssue, type TicketIssueInput } from "./github.js";

const eventId = String((BigInt(Date.UTC(2026, 9, 7)) - 1_420_070_400_000n) << 22n);
const input: TicketIssueInput = {
  token: "secret-test-token",
  repo: { owner: "CODYBONTECOU", repo: "sync.MD" },
  eventId,
  parent: { content: "First line\n\nSecond line", jumpUrl: "https://discord.com/channels/123/456/789" },
  title: " Fix syncing ", body: "Fix the reported syncing failure.", labels: ["bug"],
};
const marker = `<!-- isobot:discord-event:${eventId} -->`;
function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

test("creates only in mapped repo and appends deterministic source, quote, marker and Codex instruction", async () => {
  const calls: { url: URL; init?: RequestInit }[] = [];
  const fetcher: typeof fetch = async (request, init) => {
    assert.equal(typeof request, "string");
    calls.push({ url: new URL(String(request)), init });
    return init?.method === "POST" ? json({ number: 42 }, 201) : json([]);
  };
  const result = await createTicketIssue(input, fetcher);
  assert.deepEqual(result, { number: 42, url: "https://github.com/codybontecou/Sync.md/issues/42" });
  assert.equal(calls.length, 2);
  const query = calls[0].url.searchParams;
  assert.equal(query.get("state"), "all");
  assert.equal(query.get("sort"), "created");
  assert.equal(query.get("direction"), "desc");
  assert.equal(query.get("per_page"), "100");
  assert.equal(query.get("since"), "2026-10-06T00:00:00.000Z");
  const posted = JSON.parse(String(calls[1].init?.body));
  assert.equal(posted.title, "Fix syncing");
  assert.deepEqual(posted.labels, ["bug"]);
  assert.equal(posted.body, `${input.body}\n\n### Original Discord message\n\n> First line\n> \n> Second line\n\nSource: [Discord message](${input.parent.jumpUrl})\n\n${marker}\n\n@codex implement this`);
  assert.ok(calls.every(call => call.init?.redirect === "manual"));
  assert.ok(calls[1].init?.signal instanceof AbortSignal);
});

test("retry finds existing issue across pages, including closed issues, and ignores PRs", async () => {
  const pages: string[] = [];
  const fetcher: typeof fetch = async (request, init) => {
    assert.notEqual(init?.method, "POST");
    const page = new URL(String(request)).searchParams.get("page") ?? "";
    pages.push(page);
    return json(page === "1"
      ? Array.from({ length: 100 }, (_, index) => ({ number: index + 1, body: marker, pull_request: {} }))
      : [{ number: 101, body: marker, state: "closed" }]);
  };
  assert.equal((await createTicketIssue(input, fetcher)).number, 101);
  assert.deepEqual(pages, ["1", "2"]);
});

test("unmapped repo and invalid event or link are rejected before network access", async () => {
  let called = false;
  const fetcher: typeof fetch = async () => { called = true; return json([]); };
  await assert.rejects(createTicketIssue({ ...input, repo: { owner: "other", repo: "Sync.md" } }, fetcher), /not allowed/);
  await assert.rejects(createTicketIssue({ ...input, eventId: "123 -->" }, fetcher), /event ID/);
  await assert.rejects(createTicketIssue({ ...input, parent: { ...input.parent, jumpUrl: "https://example.com" } }, fetcher), /source link/);
  assert.equal(called, false);
});

test("full bounded scan fails closed instead of risking duplicate creation", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async (_request, init) => {
    assert.notEqual(init?.method, "POST");
    calls++;
    return json(Array.from({ length: 100 }, () => ({ number: 1, body: "another event" })));
  };
  await assert.rejects(createTicketIssue(input, fetcher), /page limit/);
  assert.equal(calls, 10);
});

test("does not expose GitHub error bodies or transport errors containing credentials", async () => {
  await assert.rejects(createTicketIssue(input, async () => new Response(input.token, { status: 403 })),
    (error: unknown) => error instanceof Error && error.message === "GitHub request failed (HTTP 403)");
  await assert.rejects(createTicketIssue(input, async () => { throw new Error(input.token); }),
    (error: unknown) => error instanceof Error && !error.message.includes(input.token) && error.message.includes("no issue was created"));
});

test("rejects redirects during duplicate checks without creating an issue or following Location", async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    let requests = 0;
    let cancelled = false;
    const fetcher: typeof fetch = async (request, init) => {
      requests++;
      assert.equal(new URL(String(request)).hostname, "api.github.com");
      assert.notEqual(init?.method, "POST");
      assert.equal(init?.redirect, "manual");
      return new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
        status, headers: { Location: `https://attacker.invalid/${input.token}` },
      });
    };
    await assert.rejects(createTicketIssue(input, fetcher),
      (error: unknown) => error instanceof Error && error.message === `GitHub request failed (HTTP ${status})`);
    assert.equal(requests, 1);
    assert.equal(cancelled, true);
  }
});

test("rejects creation redirects without a second POST or following Location", async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    let requests = 0;
    let posts = 0;
    let cancelled = false;
    const fetcher: typeof fetch = async (request, init) => {
      requests++;
      assert.equal(new URL(String(request)).hostname, "api.github.com");
      assert.equal(init?.redirect, "manual");
      if (init?.method !== "POST") return json([]);
      posts++;
      return new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
        status, headers: { Location: `https://attacker.invalid/${input.token}` },
      });
    };
    await assert.rejects(createTicketIssue(input, fetcher),
      (error: unknown) => error instanceof Error && error.message === `GitHub request failed (HTTP ${status})`);
    assert.equal(requests, 2);
    assert.equal(posts, 1);
    assert.equal(cancelled, true);
  }
});

test("ambiguous create is never automatically retried and a later call reconciles its marker", async () => {
  let requests = 0;
  let posts = 0;
  let committed = false;
  const fetcher: typeof fetch = async (_request, init) => {
    requests++;
    if (init?.method === "POST") {
      posts++;
      committed = true;
      throw new Error("connection ended after GitHub committed");
    }
    return json(committed ? [{ number: 77, body: marker }] : []);
  };
  await assert.rejects(createTicketIssue(input, fetcher), /may have completed/);
  assert.equal(requests, 2);
  assert.equal((await createTicketIssue(input, fetcher)).number, 77);
  assert.equal(posts, 1);
});

test("enforces response size even when no content-length is supplied", async () => {
  const fetcher: typeof fetch = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1));
      controller.close();
    },
  }));
  await assert.rejects(createTicketIssue(input, fetcher), /size limit/);
});

test("invalid JSON and invalid issue numbers fail without creating a second issue", async () => {
  await assert.rejects(createTicketIssue(input, async () => new Response("not JSON")), /invalid JSON/);
  await assert.rejects(createTicketIssue(input, async () => json([{ number: 99 }])), /invalid issue listing/);
  await assert.rejects(createTicketIssue(input, async () => json([{ number: "99", body: marker }])), /invalid issue response/);
});

test("native Workers fetch creates issues and refuses secret-bearing redirects", async t => {
  const directory = await mkdtemp(join(tmpdir(), "isobot-github-http-"));
  const bundle = join(directory, "worker.mjs");
  await build({
    stdin: {
      contents: `import { createTicketIssue } from './github.ts';
        export default { async fetch(request) {
          if(new URL(request.url).pathname === '/__calls') return fetch('https://api.github.com/__calls', {redirect:'manual'});
          try {
            return Response.json(await createTicketIssue({...${JSON.stringify(input)}, token:new URL(request.url).searchParams.get('scenario')}));
          } catch(error) { return Response.json({error:error.message}, {status:502}); }
        }};`,
      resolveDir: new URL(".", import.meta.url).pathname, sourcefile: "github-http-test.ts", loader: "ts",
    },
    bundle: true, format: "esm", platform: "browser", outfile: bundle,
  });
  const options: V4MiniflareOptions = { workers: [{
    name: "isobot-github-http-test", modules: true, scriptPath: bundle, modulesRoot: directory,
    compatibilityDate: "2026-10-07", outboundService: "github-origin",
  }, {
    name: "github-origin", modules: true, compatibilityDate: "2026-10-07",
    script: `const calls = [];
      export default { async fetch(request) {
        const url = new URL(request.url);
        if(url.pathname === '/__calls') return Response.json(calls);
        const scenario = request.headers.get('Authorization').slice('Bearer '.length);
        calls.push({host:url.hostname,method:request.method,scenario});
        if(url.hostname !== 'api.github.com') return new Response('Unexpected credential destination', {status:500});
        if(scenario === 'redirect-get' || scenario === 'redirect-post' && request.method === 'POST') {
          return new Response('Do not disclose response body', {status:307,headers:{Location:'https://attacker.invalid/collect'}});
        }
        return Response.json(request.method === 'POST' ? {number:42} : [], {status:request.method === 'POST' ? 201 : 200});
      }};`,
  }] };
  const runtime = new Miniflare(convertV4MiniflareOptions(options));
  try {
    await t.test("native fetch performs the duplicate check and creation", async () => {
      const response = await runtime.dispatchFetch("https://test/?scenario=success");
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { number: 42, url: "https://github.com/codybontecou/Sync.md/issues/42" });
    });
    for (const scenario of ["redirect-get", "redirect-post"]) {
      await t.test(`native fetch rejects ${scenario}`, async () => {
        const response = await runtime.dispatchFetch(`https://test/?scenario=${scenario}`);
        assert.equal(response.status, 502);
        assert.deepEqual(await response.json(), { error: "GitHub request failed (HTTP 307)" });
      });
    }
    const calls = await (await runtime.dispatchFetch("https://test/__calls")).json();
    assert.deepEqual(calls, [
      { host: "api.github.com", method: "GET", scenario: "success" },
      { host: "api.github.com", method: "POST", scenario: "success" },
      { host: "api.github.com", method: "GET", scenario: "redirect-get" },
      { host: "api.github.com", method: "GET", scenario: "redirect-post" },
      { host: "api.github.com", method: "POST", scenario: "redirect-post" },
    ]);
  } finally {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
