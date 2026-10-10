import assert from "node:assert/strict";
import test from "node:test";
import { chatgptPayload, chatgptStreamEvent, chatgptProvider } from "./chatgpt-provider.js";

test("subscription requests preserve tool replay while enforcing the plan's wire contract", () => {
  const payload = {
    model: "gpt-6.1-sol", store: true, stream: false,
    temperature: 0.5, max_output_tokens: 100, previous_response_id: "old-response", metadata: { secret: "private" },
    tools: [{ type: "function", name: "read_captured_note", parameters: { type: "object" } }],
    input: [
      { type: "message", role: "system", content: "Use saved notes." },
      { type: "function_call", call_id: "call-1", name: "read_captured_note", arguments: '{"id":"note-1"}' },
      { type: "function_call_output", call_id: "call-1", output: "Saved note" },
    ],
    tool_choice: { type: "function", name: "read_captured_note" },
  };
  assert.deepEqual(chatgptPayload(payload, { provider: "openai" }), {
    model: "gpt-6.1-sol", store: false, stream: true,
    tools: [{ type: "namespace", name: "isobot", description: "Isobot's tools", tools: payload.tools }],
    input: [
      { type: "message", role: "developer", content: "Use saved notes." },
      { ...payload.input[1], namespace: "isobot" },
      payload.input[2],
    ],
    tool_choice: { ...payload.tool_choice, namespace: "isobot" },
  });
  assert.equal(payload.input[0].role, "system");
  assert.equal(payload.store, true);
  assert.equal(chatgptPayload(payload, { provider: "workers-ai" }), payload);
});

test("existing tool namespaces remain available and incomplete inference fails", () => {
  const payload = { input: [{ role: "user", content: "Hello" }], tools: [{ type: "namespace", name: "existing", tools: [] }] };
  assert.deepEqual(chatgptPayload(payload, { provider: "openai" }), { ...payload, store: false, stream: true });
  assert.throws(() => chatgptStreamEvent({ type: "response.incomplete" }, { provider: "openai" }), /did not complete/);
  assert.doesNotThrow(() => chatgptStreamEvent({ type: "response.completed" }, { provider: "openai" }));
  assert.doesNotThrow(() => chatgptStreamEvent({ type: "response.incomplete" }, { provider: "workers-ai" }));
});

test("tools anchored in the transcript retain their namespace after a model switch", () => {
  const payload = { input: [
    { type: "additional_tools", role: "developer", tools: [{ type: "function", name: "search_captured_notes", parameters: { type: "object" } }] },
    { type: "function_call", name: "search_captured_notes", call_id: "call-note", arguments: "{}" },
    { type: "function_call_output", call_id: "call-note", output: "The saved note" },
  ] };
  assert.deepEqual(chatgptPayload(payload, { provider: "openai" }), { store: false, stream: true, input: [
    { ...payload.input[0], tools: [{ type: "namespace", name: "isobot", description: "Isobot's tools", tools: payload.input[0].tools }] },
    { ...payload.input[1], namespace: "isobot" },
    payload.input[2],
  ] });
});

test("the Worker provider resolves only the shared OAuth bearer and preserves failures", async () => {
  let requests = 0;
  const provider = chatgptProvider({
    async getAccessToken() { requests++; return "subscription-access"; },
    async getSelection() { return { model: null, revision: 0 }; },
  });
  assert.equal(provider.auth.oauth, undefined); // No lazy Node callback module can execute in the Worker.
  assert.ok(provider.auth.apiKey);
  const auth = await provider.auth.apiKey.resolve({
    signal: new AbortController().signal,
    ctx: { async env() { throw new Error("Ambient API keys must not be consulted"); }, async fileExists() { return false; } },
  });
  assert.deepEqual(auth, { auth: { apiKey: "subscription-access" }, source: "ChatGPT subscription" });
  assert.equal(requests, 1);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(provider.auth.apiKey.resolve({ signal: controller.signal, ctx: { async env() { return undefined; }, async fileExists() { return false; } } }));
  assert.equal(requests, 1);
});
