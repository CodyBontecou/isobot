import assert from "node:assert/strict";
import test from "node:test";
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
  assert.equal(calls[1].init?.redirect, "error");
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
