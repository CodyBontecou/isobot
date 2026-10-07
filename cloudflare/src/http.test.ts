import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions, type V4MiniflareOptions } from "miniflare";

type AgentCall = { method: string; name?: string; prompt?: string; requestId?: string };

// Exercise the production router and Workers crypto without invoking a model or external service.
test("HTTP prompt routes authenticate, validate and preserve conversation routing", async t => {
  const directory = await mkdtemp(join(tmpdir(), "isobot-http-"));
  const bundle = join(directory, "worker.mjs");
  await build({
    stdin: {
      contents: `import worker from './index.ts';
        export default { async fetch(request, env) {
          const calls = [];
          const bindings = { ...env, Assistant: { getByName(name) {
            calls.push({ method: 'getByName', name });
            return {
              async ask(prompt) {
                calls.push({ method: 'ask', prompt });
                return { text: 'legacy answer', status: 'done' };
              },
              async runPrompt(prompt, requestId) {
                calls.push({ method: 'runPrompt', prompt, requestId });
                if (prompt === 'conflict') return { conflict: true };
                return {
                  conflict: false, operationId: requestId,
                  text: prompt === 'unanswered' ? '' : 'prompt answer',
                  status: prompt === 'unanswered' ? 'unanswered' : 'done',
                  reason: prompt === 'unanswered' ? 'No model answer was available' : undefined,
                };
              },
            };
          } } };
          if (request.headers.get('X-Test-No-Tokens') === 'true') {
            bindings.ISOBOT_API_TOKEN = undefined;
            bindings.PROMPT_API_TOKEN = undefined;
          }
          const response = await worker.fetch(request, bindings);
          const headers = new Headers(response.headers);
          headers.set('X-Test-Agent-Calls', JSON.stringify(calls));
          return new Response(response.body, { status: response.status, headers });
        } };`,
      resolveDir: new URL(".", import.meta.url).pathname,
      sourcefile: "http-test.ts", loader: "ts",
    },
    bundle: true, format: "esm", platform: "browser", conditions: ["workerd"],
    external: ["cloudflare:*", "node:*", "path"], outfile: bundle,
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire('/worker.mjs');" },
  });
  const options: V4MiniflareOptions = {
    workers: [{
      name: "isobot-http-test", modules: true, scriptPath: bundle, modulesRoot: directory,
      compatibilityDate: "2026-10-07", compatibilityFlags: ["nodejs_compat"],
      bindings: { ISOBOT_API_TOKEN: "test-isobot-token", PROMPT_API_TOKEN: "test-prompt-token", PI_MODEL: "test-model" },
    }],
  };
  const runtime = new Miniflare(convertV4MiniflareOptions(options));
  const request = (path: string, options: { method?: string; body?: unknown; rawBody?: string; token?: string | null; noTokens?: boolean } = {}) => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const token = options.token === undefined ? "test-prompt-token" : options.token;
    if (token !== null) headers.Authorization = `Bearer ${token}`;
    if (options.noTokens) headers["X-Test-No-Tokens"] = "true";
    return runtime.dispatchFetch(`http://test${path}`, {
      method: options.method ?? "POST", headers,
      body: options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
    });
  };
  const calls = (response: Awaited<ReturnType<typeof runtime.dispatchFetch>>) => JSON.parse(response.headers.get("X-Test-Agent-Calls")!) as AgentCall[];
  try {
    await t.test("prompt token grants access to both prompt endpoints", async () => {
      for (const path of ["/api/prompt", "/api/ask"]) {
        const response = await request(path, { body: { prompt: "Hello" } });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("Cache-Control"), "no-store");
        assert.equal(calls(response).length, 2);
      }
      for (const [path, method] of [["/api/tickets", "POST"], ["/api/status", "GET"]]) {
        const response = await request(path, { method });
        assert.equal(response.status, 401);
        assert.deepEqual(calls(response), []);
      }
    });
    await t.test("existing isobot token retains prompt and service access", async () => {
      for (const path of ["/api/prompt", "/api/ask"]) {
        assert.equal((await request(path, { token: "test-isobot-token", body: { prompt: "Hello" } })).status, 200);
      }
      const status = await request("/api/status", { token: "test-isobot-token", method: "GET" });
      assert.equal(status.status, 200);
      assert.deepEqual(await status.json(), { ready: false, model: "test-model" });
      assert.equal((await request("/api/tickets", { token: "test-isobot-token", body: {} })).status, 400);
    });
    await t.test("missing, incorrect and unconfigured tokens fail before agent lookup", async () => {
      for (const auth of [{ token: null }, { token: "incorrect" }, { noTokens: true }]) {
        for (const path of ["/api/prompt", "/api/ask"]) {
          const response = await request(path, { ...auth, body: { prompt: "Hello" } });
          assert.equal(response.status, 401);
          assert.deepEqual(await response.json(), { error: "Unauthorized" });
          assert.deepEqual(calls(response), []);
        }
      }
    });
    await t.test("prompt requires POST and returns the allowed method", async () => {
      for (const method of ["GET", "PUT", "DELETE"]) {
        const response = await request("/api/prompt", { method });
        assert.equal(response.status, 405);
        assert.equal(response.headers.get("Allow"), "POST");
        assert.deepEqual(calls(response), []);
      }
    });
    await t.test("missing, malformed and oversized JSON fail validation", async () => {
      for (const path of ["/api/prompt", "/api/ask"]) {
        for (const rawBody of [undefined, "{", " ", "x".repeat(256_001)]) {
          const response = await request(path, { rawBody });
          assert.equal(response.status, 400);
          assert.deepEqual(await response.json(), { error: "Invalid JSON request body" });
          assert.deepEqual(calls(response), []);
        }
      }
    });
    await t.test("invalid prompt fields never reach an agent", async () => {
      const invalid = [null, [], {}, { prompt: 1 }, { prompt: "" }, { prompt: " \n\t" },
        { prompt: "x".repeat(16_001) }, { prompt: "Hi", conversation: "" },
        { prompt: "Hi", conversation: "one/two" }, { prompt: "Hi", conversation: 1 },
        { prompt: "Hi", conversation: "x".repeat(101) }, { prompt: "Hi", requestId: "" },
        { prompt: "Hi", requestId: "with spaces" }, { prompt: "Hi", requestId: null },
        { prompt: "Hi", requestId: "x".repeat(101) }];
      for (const body of invalid) {
        const response = await request("/api/prompt", { body });
        assert.equal(response.status, 400, JSON.stringify(body));
        assert.deepEqual(calls(response), []);
      }
    });
    await t.test("default conversation and generated requestId are returned and routed", async () => {
      const response = await request("/api/prompt", { body: { prompt: "Hello" } });
      const result = await response.json() as { conversation: string; requestId: string; operationId: string; status: string; text: string };
      assert.equal(response.status, 200);
      assert.equal(result.conversation, "default");
      assert.match(result.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      assert.equal(result.operationId, result.requestId);
      assert.equal(result.status, "done");
      assert.equal(result.text, "prompt answer");
      assert.deepEqual(calls(response), [{ method: "getByName", name: "http:default" },
        { method: "runPrompt", prompt: "Hello", requestId: result.requestId }]);
    });
    await t.test("caller conversation and requestId survive routing", async () => {
      const response = await request("/api/prompt", { body: { prompt: "Hello", conversation: "my_thread-2", requestId: "request_1" } });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { conversation: "my_thread-2", requestId: "request_1", operationId: "request_1", status: "done", text: "prompt answer" });
      assert.deepEqual(calls(response), [{ method: "getByName", name: "http:my_thread-2" },
        { method: "runPrompt", prompt: "Hello", requestId: "request_1" }]);
    });
    await t.test("requestId conflict returns identifiers with HTTP 409", async () => {
      const response = await request("/api/prompt", { body: { prompt: "conflict", conversation: "thread", requestId: "already-used" } });
      assert.equal(response.status, 409);
      assert.equal(response.headers.get("Cache-Control"), "no-store");
      assert.deepEqual(await response.json(), { error: "requestId was already used with a different prompt", conversation: "thread", requestId: "already-used" });
    });
    await t.test("unanswered provider result includes status, empty text and reason", async () => {
      const response = await request("/api/prompt", { body: { prompt: "unanswered", requestId: "no-answer" } });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { conversation: "default", requestId: "no-answer", operationId: "no-answer", status: "unanswered", text: "", reason: "No model answer was available" });
    });
    await t.test("legacy ask keeps default routing and its existing response body", async () => {
      const response = await request("/api/ask", { body: { prompt: "Hello" } });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { text: "legacy answer", status: "done" });
      assert.deepEqual(calls(response), [{ method: "getByName", name: "demo:first-agent" }, { method: "ask", prompt: "Hello" }]);
      const named = await request("/api/ask", { body: { prompt: "Hello", conversation: "old-thread" } });
      assert.deepEqual(calls(named), [{ method: "getByName", name: "demo:old-thread" }, { method: "ask", prompt: "Hello" }]);
      const get = await request("/api/ask", { method: "GET" });
      assert.equal(get.status, 404);
      assert.deepEqual(await get.json(), { error: "Not found" });
      assert.deepEqual(calls(get), []);
    });
  } finally {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
