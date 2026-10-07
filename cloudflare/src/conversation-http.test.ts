import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions, type V4MiniflareOptions } from "miniflare";

test("conversation viewer protects transcripts and provides a credential-free browser shell", async t => {
  const directory = await mkdtemp(join(tmpdir(), "isobot-conversation-http-"));
  const bundle = join(directory, "worker.mjs");
  await build({
    stdin: {
      contents: `import worker from './index.ts';
        export default { async fetch(request, env) {
          const calls = [];
          const bindings = { ...env, Assistant: { getByName(name) {
            calls.push({ name });
            return { async conversationSnapshot(options) {
              calls.push({ options });
              return JSON.stringify({model:'test-model',busy:false,pending:[],entries:[{id:'2',role:'user',text:'Hello'}],nextCursor:'1'});
            } };
          } } };
          const response = await worker.fetch(request, bindings);
          const headers = new Headers(response.headers);
          headers.set('X-Test-Calls', JSON.stringify(calls));
          return new Response(response.body,{status:response.status,headers});
        } };`,
      resolveDir: new URL(".", import.meta.url).pathname,
      sourcefile: "conversation-http-test.ts", loader: "ts",
    },
    bundle: true, format: "esm", platform: "browser", conditions: ["workerd"],
    external: ["cloudflare:*", "node:*", "path"], outfile: bundle,
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire('/worker.mjs');" },
  });
  const options: V4MiniflareOptions = { workers: [{
    name: "isobot-conversation-http-test", modules: true, scriptPath: bundle, modulesRoot: directory,
    compatibilityDate: "2026-10-07", compatibilityFlags: ["nodejs_compat"],
    bindings: { ISOBOT_API_TOKEN: "test-service-token", PROMPT_API_TOKEN: "test-viewer-token", PI_MODEL: "test-model" },
  }] };
  const runtime = new Miniflare(convertV4MiniflareOptions(options));
  const request = (path: string, token: string | null = "test-viewer-token", method = "GET") => runtime.dispatchFetch(`https://test${path}`, {
    method, headers: token === null ? {} : { Authorization: `Bearer ${token}` },
  });
  const calls = (response: Awaited<ReturnType<typeof request>>) => JSON.parse(response.headers.get("X-Test-Calls")!);
  try {
    await t.test("browser shell is public and restrictive but contains no credentials or private transcript", async () => {
      const response = await request("/console", null);
      assert.equal(response.status, 200);
      assert.match(response.headers.get("Content-Type")!, /text\/html/);
      assert.equal(response.headers.get("Cache-Control"), "no-store");
      assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
      assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
      assert.match(response.headers.get("Content-Security-Policy")!, /connect-src 'self'/);
      const html = await response.text();
      assert.match(html, /type="password"/);
      assert.doesNotMatch(html, /test-service-token|test-viewer-token|localStorage|sessionStorage/);
      assert.deepEqual(calls(response), []);
      const method = await request("/console", null, "POST");
      assert.equal(method.status, 405);
      assert.equal(method.headers.get("Allow"), "GET");
    });
    await t.test("invalid credentials cannot look up or read an agent", async () => {
      for (const token of [null, "incorrect"]) {
        const response = await request("/api/conversation", token);
        assert.equal(response.status, 401);
        assert.deepEqual(calls(response), []);
      }
    });
    await t.test("prompt and service tokens can read the default conversation", async () => {
      for (const token of ["test-viewer-token", "test-service-token"]) {
        const response = await request("/api/conversation", token);
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("Cache-Control"), "no-store");
        assert.deepEqual(await response.json(), { conversation: "vox", model: "test-model", busy: false, pending: [], entries: [{ id: "2", role: "user", text: "Hello" }], nextCursor: "1" });
        assert.deepEqual(calls(response), [{ name: "http:vox" }, { options: { limit: 100 } }]);
      }
      assert.equal((await request("/api/status")).status, 401);
    });
    await t.test("names and cursor routing stay within the requested conversation", async () => {
      const response = await request("/api/conversation?conversation=work_2&limit=25&before=42");
      assert.equal(response.status, 200);
      assert.deepEqual(calls(response), [{ name: "http:work_2" }, { options: { limit: 25, before: "42" } }]);
    });
    await t.test("bad pagination and conversation inputs fail before RPC", async () => {
      for (const query of ["conversation=", "conversation=../other", "conversation=a&conversation=b", "limit=0", "limit=101", "limit=1.5", "limit=NaN", "before=0", "before=-1", "before=1.2", "before=Infinity", "before=9007199254740992"]) {
        const response = await request(`/api/conversation?${query}`);
        assert.equal(response.status, 400, query);
        assert.deepEqual(calls(response), []);
      }
    });
    await t.test("transcript access is GET only", async () => {
      const response = await request("/api/conversation", undefined, "POST");
      assert.equal(response.status, 405);
      assert.equal(response.headers.get("Allow"), "GET");
      assert.deepEqual(calls(response), []);
    });
  } finally {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
