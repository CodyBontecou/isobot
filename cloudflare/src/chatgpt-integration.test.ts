import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions, type V4MiniflareOptions } from "miniflare";

type Json = Record<string, unknown>;
const model = "gpt-6.1-sol";
const fallback = "@cf/moonshotai/kimi-k2.7-code";
const adminToken = "test-chatgpt-administrator-token-0001";
const promptToken = "test-chatgpt-prompt-token";
const captureId = "8da2b4ca-0515-4245-99e9-05296495e173";
const scopes = ["openid", "profile", "email", "offline_access", "resource.invoke", "chatgpt.tokens.use.direct"];

function testCredential(lifetimeMs = 3_600_000) {
  const expires = Date.now() + lifetimeMs;
  const claims = { iss: "https://auth.openai.com", aud: "https://api.openai.com/v1", client_id: "oaiapp_isobot_test",
    scope: scopes.join(" "), exp: Math.ceil(expires / 1000) };
  return { type: "oauth", access: `test.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.test-signature`,
    refresh: "test-refresh-token-not-a-real-credential", expires, clientId: claims.client_id, scopes };
}

function sse(output: Json[]) {
  const events: Json[] = [{ type: "response.created", response: { id: "resp_test" } }];
  for (const [output_index, item] of output.entries()) {
    events.push({ type: "response.output_item.added", output_index, item: {
      ...item, ...(item.type === "message" ? { content: [] } : { arguments: "" }),
    } });
    if (item.type === "function_call") {
      events.push({ type: "response.function_call_arguments.delta", output_index, delta: item.arguments });
      events.push({ type: "response.function_call_arguments.done", output_index, arguments: item.arguments });
    }
    events.push({ type: "response.output_item.done", output_index, item });
  }
  events.push({ type: "response.completed", response: { id: "resp_test", status: "completed", output,
    usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 } } });
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "Content-Type": "text/event-stream", "x-request-id": "request-test" },
  });
}

const answer = (text: string): Json => ({ type: "message", id: "msg_test", role: "assistant", status: "completed",
  content: [{ type: "output_text", text, annotations: [] }] });
function declaredTools(body?: Json): Json[] {
  if (!body) return [];
  const top = Array.isArray(body.tools) ? body.tools as Json[] : [];
  const additions = Array.isArray(body.input) ? (body.input as Json[])
    .flatMap(item => item.type === "additional_tools" && Array.isArray(item.tools) ? item.tools as Json[] : []) : [];
  return [...top, ...additions];
}

// The production Worker, auth DO, Pi session, memory tool and provider run in workerd.
// Every outbound request is intercepted, so this cannot consume real account usage.
test("ChatGPT selection migrates a durable Pi session and preserves namespaced tool history after restart", { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "isobot-chatgpt-integration-"));
  const bundle = join(directory, "worker.mjs");
  const credential = testCredential(30_000);
  const renewed = testCredential();
  let currentAccess = credential.access;
  let refreshCalls = 0;
  const requests: { path: string; body?: Json }[] = [];
  await build({
    stdin: { contents: `import worker from './index.ts'; export * from './index.ts';
      export default { async fetch(request, env) {
        if (new URL(request.url).pathname === '/test/access') {
          return Response.json({ access: await env.ChatGPTAuth.getByName('primary').getAccessToken() });
        }
        return worker.fetch(request, env);
      } };`,
      resolveDir: new URL(".", import.meta.url).pathname, sourcefile: "chatgpt-integration-test.ts", loader: "ts" },
    bundle: true, format: "esm", platform: "browser", conditions: ["workerd"],
    external: ["cloudflare:*", "node:*", "path"], outfile: bundle,
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire('/worker.mjs');" },
  });
  const options: V4MiniflareOptions = {
    resourcePersistencePath: join(directory, "storage"),
    workers: [{
      name: "isobot-chatgpt-integration-test", modules: true, scriptPath: bundle, modulesRoot: directory,
      compatibilityDate: "2026-10-07", compatibilityFlags: ["nodejs_compat"],
      bindings: { CHATGPT_ADMIN_TOKEN: adminToken, PROMPT_API_TOKEN: promptToken, PI_MODEL: fallback },
      serviceBindings: { AI: "blocked-workers-ai" },
      durableObjects: { Assistant: { className: "Assistant", useSQLite: true }, ChatGPTAuth: { className: "ChatGPTAuth", useSQLite: true } },
      outboundService: async request => {
        const url = new URL(request.url);
        if (url.origin === "https://auth.openai.com" && url.pathname === "/api/accounts/oauth/token") {
          const body = new URLSearchParams(await request.text());
          assert.equal(request.method, "POST");
          assert.equal(body.get("grant_type"), "refresh_token");
          assert.equal(body.get("client_id"), credential.clientId);
          assert.equal(body.get("refresh_token"), credential.refresh);
          assert.equal(body.get("resource"), "https://api.openai.com/v1");
          assert.equal(body.has("scope"), false);
          refreshCalls++;
          currentAccess = renewed.access;
          return Response.json({ access_token: renewed.access, refresh_token: "test-rotated-refresh-token-current",
            expires_in: 3600, scope: scopes.join(" "), token_type: "Bearer" });
        }
        assert.equal(url.origin, "https://api.openai.com", "No other service may be called");
        assert.equal(request.headers.get("Authorization"), `Bearer ${currentAccess}`);
        if (url.pathname === "/v1/models") {
          requests.push({ path: url.pathname });
          return Response.json({ models: [{ slug: model, display_name: "Test Sol", visibility: "list" }] });
        }
        assert.equal(url.pathname, "/v1/responses");
        assert.equal(request.method, "POST");
        const body = await request.json() as Json;
        requests.push({ path: url.pathname, body });
        assert.equal(body.model, model);
        assert.equal(body.store, false);
        assert.equal(body.stream, true);
        assert.equal((body.reasoning as Json | undefined)?.effort, "medium", "GPT-6.1 Sol uses medium reasoning for verification and every Pi request");
        assert.ok(Array.isArray(body.input));
        for (const field of ["background", "conversation", "max_output_tokens", "max_tool_calls", "metadata", "moderation", "multi_agent", "prompt",
          "prompt_cache_retention", "safety_identifier", "temperature", "top_logprobs", "top_p", "truncation", "user", "previous_response_id"]) {
          assert.equal(field in body, false, `${field} must be omitted`);
        }
        const input = body.input as Json[];
        assert.equal(input.some(item => item.role === "system"), false);
        const tools = declaredTools(body);
        if (tools.length === 0) return sse([answer("OK")]); // Activation probe.
        assert.ok(input.some(item => item.role === "developer"));
        assert.equal(tools.length, 1);
        assert.equal(tools[0].type, "namespace");
        assert.equal(tools[0].name, "isobot");
        assert.ok((tools[0].tools as Json[]).some(tool => tool.name === "search_captured_notes"));
        const result = input.find(item => item.type === "function_call_output");
        if (!result) return sse([{ type: "function_call", id: "fc_search", call_id: "call_search", name: "search_captured_notes",
          namespace: "isobot", arguments: JSON.stringify({ query: "Portugal", limit: 5 }), status: "completed" }]);
        const call = input.find(item => item.type === "function_call");
        assert.equal(call?.namespace, "isobot");
        assert.equal(result.call_id, call?.call_id);
        assert.match(String(result.output), /Portugal/);
        const userText = JSON.stringify(input.filter(item => item.role === "user"));
        if (userText.includes("Remember our note")) return sse([answer("Follow-up preserved the Portugal note.")]);
        return sse([answer(`Found your Portugal note (${captureId}).`)]);
      },
    }, {
      name: "blocked-workers-ai", modules: true,
      script: "export default { fetch() { throw new Error('Workers AI inference is not permitted in this test'); } };",
    }],
  };
  let runtime = new Miniflare(convertV4MiniflareOptions(options));
  const call = async (path: string, method = "GET", body?: unknown, token = promptToken, extraHeaders: Record<string, string> = {}) => {
    const response = await runtime.dispatchFetch(`https://test${path}`, { method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...extraHeaders },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json() as Json;
    assert.ok(response.ok, `${path}: ${response.status} ${JSON.stringify(value)}`);
    return value;
  };
  try {
    const before = await call("/api/conversation?conversation=subscription");
    assert.equal(before.model, fallback);
    assert.equal(requests.length, 0);
    await call("/api/vox?conversation=subscription&mode=memory", "POST", { id: captureId, text: "# Travel\n\nPortugal note from Lisbon." },
      promptToken, { "Idempotency-Key": captureId });
    const connected = await call("/api/chatgpt/connection", "PUT", { credential }, adminToken);
    assert.equal(connected.connected, true);
    assert.equal(connected.selectedModel, null);
    const accesses = await Promise.all(Array.from({ length: 8 }, () => call("/test/access")));
    assert.ok(accesses.every(result => result.access === renewed.access));
    assert.equal(refreshCalls, 1, "Concurrent DO callers redeem one rotating refresh token");
    const selected = await call("/api/chatgpt/model", "POST", { model }, adminToken);
    assert.equal(selected.selectedModel, model);
    const first = await call("/api/prompt", "POST", { conversation: "subscription", requestId: "subscription-first", prompt: "Find my saved Portugal note." });
    assert.equal(first.status, "done");
    assert.equal(first.text, `Found your Portugal note (${captureId}).`);
    const transcript = await call("/api/conversation?conversation=subscription");
    assert.equal(transcript.model, model);
    assert.ok((transcript.entries as Json[]).some(entry => entry.role === "tool" && String(entry.text).includes(captureId)));
    assert.equal(requests.filter(request => declaredTools(request.body).length > 0).length, 2);

    await runtime.dispose();
    runtime = new Miniflare(convertV4MiniflareOptions(options));
    const restored = await call("/api/chatgpt/connection", "GET", undefined, adminToken);
    assert.equal(restored.connected, true);
    assert.equal(restored.selectedModel, model);
    assert.equal((await call("/test/access")).access, renewed.access);
    assert.equal(refreshCalls, 1, "Restart reuses the saved replacement access token");
    const persistedTranscript = await call("/api/conversation?conversation=subscription");
    assert.deepEqual(persistedTranscript.entries, transcript.entries);
    const second = await call("/api/prompt", "POST", { conversation: "subscription", requestId: "subscription-second", prompt: "Remember our note and continue." });
    assert.equal(second.status, "done");
    assert.equal(second.text, "Follow-up preserved the Portugal note.");
    assert.equal(requests.filter(request => request.path === "/v1/models").length, 1, "Restart retains imported credentials/catalog");
    assert.equal(requests.filter(request => declaredTools(request.body).length > 0).length, 3);
    const final = await call("/api/conversation?conversation=subscription");
    assert.ok((final.entries as Json[]).some(entry => entry.text === first.text));
    assert.ok((final.entries as Json[]).some(entry => entry.text === second.text));
  } finally {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
