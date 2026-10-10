import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions, type V4MiniflareOptions } from "miniflare";
import type { ResourceSnapshot } from "./resources.js";
import type { WorkspaceFile, WorkspaceFileMetadata } from "./workspace.js";

type Json = Record<string, unknown>;
const model = "gpt-6.1-sol";
const fallback = "@cf/moonshotai/kimi-k2.7-code";
const adminToken = "test-workspace-administrator-token-0001";
const promptToken = "test-workspace-prompt-token";

function credential() {
  const expires = Date.now() + 3_600_000;
  const scopes = ["openid", "profile", "email", "offline_access", "resource.invoke", "chatgpt.tokens.use.direct"];
  const claims = { iss: "https://auth.openai.com", aud: "https://api.openai.com/v1", client_id: "oaiapp_isobot_test",
    scope: scopes.join(" "), exp: Math.ceil(expires / 1000) };
  return { type: "oauth", access: `test.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.test-signature`,
    refresh: "test-workspace-refresh-token-not-real", expires, clientId: claims.client_id, scopes };
}

function sse(output: Json[]) {
  const events: Json[] = [{ type: "response.created", response: { id: "resp_workspace" } }];
  for (const [output_index, item] of output.entries()) {
    events.push({ type: "response.output_item.added", output_index,
      item: { ...item, ...(item.type === "message" ? { content: [] } : { arguments: "" }) } });
    if (item.type === "function_call") {
      events.push({ type: "response.function_call_arguments.delta", output_index, delta: item.arguments });
      events.push({ type: "response.function_call_arguments.done", output_index, arguments: item.arguments });
    }
    events.push({ type: "response.output_item.done", output_index, item });
  }
  events.push({ type: "response.completed", response: { id: "resp_workspace", status: "completed", output,
    usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 } } });
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "Content-Type": "text/event-stream", "x-request-id": "request-workspace" },
  });
}

const answer = (text: string): Json => ({ type: "message", id: "msg_workspace", role: "assistant", status: "completed",
  content: [{ type: "output_text", text, annotations: [] }] });
const tool = (id: string, name: string, argumentsValue: unknown): Json => ({ type: "function_call", id: `fc_${id}`,
  call_id: id, name, namespace: "isobot", arguments: JSON.stringify(argumentsValue), status: "completed" });

/** Run the production Worker, Pi registry and both UI/agent file paths in workerd, with all inference mocked. */
test("real Pi workspace tools share console files, persisted revisions and measured resource usage", { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "isobot-workspace-integration-"));
  const bundle = join(directory, "worker.mjs");
  const imported = credential();
  let inferenceRequests = 0;
  await build({ entryPoints: [new URL("./index.ts", import.meta.url).pathname],
    bundle: true, format: "esm", platform: "browser", conditions: ["workerd"],
    external: ["cloudflare:*", "node:*", "path"], outfile: bundle,
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire('/worker.mjs');" } });
  const options: V4MiniflareOptions = {
    resourcePersistencePath: join(directory, "storage"),
    workers: [{ name: "isobot-workspace-integration-test", modules: true, scriptPath: bundle, modulesRoot: directory,
      compatibilityDate: "2026-10-07", compatibilityFlags: ["nodejs_compat"],
      bindings: { CHATGPT_ADMIN_TOKEN: adminToken, PROMPT_API_TOKEN: promptToken, PI_MODEL: fallback },
      serviceBindings: { AI: "blocked-workers-ai" },
      durableObjects: { Assistant: { className: "Assistant", useSQLite: true }, ChatGPTAuth: { className: "ChatGPTAuth", useSQLite: true } },
      outboundService: async request => {
        const url = new URL(request.url);
        assert.equal(url.origin, "https://api.openai.com", "No unmocked service may be called");
        assert.equal(request.headers.get("Authorization"), `Bearer ${imported.access}`);
        if (url.pathname === "/v1/models") return Response.json({ models: [{ slug: model, display_name: "Test Sol", visibility: "list" }] });
        assert.equal(url.pathname, "/v1/responses");
        const body = await request.json() as Json;
        assert.equal(body.model, model);
        const tools = Array.isArray(body.tools) ? body.tools as Json[] : [];
        const input = body.input as Json[];
        const additions = input.flatMap(item => item.type === "additional_tools" && Array.isArray(item.tools) ? item.tools as Json[] : []);
        const declared = [...tools, ...additions].flatMap(item => Array.isArray(item.tools) ? item.tools as Json[] : []);
        if (!declared.length) return sse([answer("OK")]); // Credential activation probe.
        assert.ok(declared.some(item => item.name === "read_workspace_file"));
        assert.ok(declared.some(item => item.name === "write_workspace_file"));
        inferenceRequests++;
        let lastUser = -1;
        for (let index = 0; index < input.length; index++) if (input[index].role === "user") lastUser = index;
        assert.ok(lastUser >= 0);
        const editing = JSON.stringify(input[lastUser]).includes("Edit the saved workspace result");
        const currentRound = input.slice(lastUser + 1);
        const results = currentRound.filter(item => item.type === "function_call_output");
        const readResult = results.find(item => item.call_id === (editing ? "read-edit" : "read-seed"));
        if (!readResult) return sse([tool(editing ? "read-edit" : "read-seed", "read_workspace_file", {
          path: editing ? "notes/result.md" : "notes/seed.md",
        })]);
        const readFile = JSON.parse(String(readResult.output)) as WorkspaceFile;
        assert.equal(readFile.content, editing ? "# Agent result\nCafé from the console.\n" : "# Console seed\nCafé from the console.\n");
        const writeResult = results.find(item => item.call_id === (editing ? "write-edit" : "write-result"));
        if (!writeResult) return sse([tool(editing ? "write-edit" : "write-result", "write_workspace_file", {
          path: "notes/result.md", content: editing ? "# Edited after restart\nCafé from the console.\n" : "# Agent result\nCafé from the console.\n",
          expectedRevision: editing ? readFile.revision : null,
        })]);
        const saved = JSON.parse(String(writeResult.output)) as { ok: boolean; file: WorkspaceFileMetadata };
        assert.equal(saved.ok, true);
        assert.equal(saved.file.path, "notes/result.md");
        assert.ok(saved.file.revision > readFile.revision);
        assert.equal("content" in saved.file, false, "Write tool returns metadata rather than echoing the full file");
        return sse([answer(editing ? "Edited your workspace file after restart." : "Created your workspace file.")]);
      },
    }, { name: "blocked-workers-ai", modules: true,
      script: "export default { fetch() { throw new Error('Workers AI inference is not permitted in this test'); } };" }],
  };
  let runtime = new Miniflare(convertV4MiniflareOptions(options));
  const call = async <T = Json>(path: string, method = "GET", body?: unknown, token = promptToken): Promise<T> => {
    const response = await runtime.dispatchFetch(`https://test${path}`, { method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json() as T;
    assert.ok(response.ok, `${path}: ${response.status} ${JSON.stringify(value)}`);
    return value;
  };
  const filePath = (path: string) => `/api/workspace/file?conversation=workspace&path=${encodeURIComponent(path)}`;
  const resources = () => call<ResourceSnapshot>("/api/resources?conversation=workspace");
  try {
    await call("/api/chatgpt/connection", "PUT", { credential: imported }, adminToken);
    await call("/api/chatgpt/model", "POST", { model }, adminToken);
    await call(filePath("notes/seed.md"), "PUT", { content: "# Console seed\nCafé from the console.\n", expectedRevision: null });
    const first = await call("/api/prompt", "POST", { conversation: "workspace", requestId: "workspace-create", prompt: "Read my console seed and create a workspace result." });
    assert.equal(first.status, "done");
    assert.equal(first.text, "Created your workspace file.");
    assert.equal(inferenceRequests, 3);
    const result = (await call(filePath("notes/result.md"))).file as WorkspaceFile;
    assert.equal(result.content, "# Agent result\nCafé from the console.\n");
    const snapshot = await resources();
    assert.equal(snapshot.runtime.model, model);
    assert.equal(snapshot.runtime.provider, "chatgpt");
    assert.equal(snapshot.runtime.busy, false);
    assert.equal(snapshot.storage.workspaceFiles, 2);
    assert.ok(snapshot.storage.databaseBytes >= snapshot.storage.workspaceBytes);
    assert.equal(snapshot.storage.captures, 0);
    assert.equal(snapshot.usage.inputTokens, 60);
    assert.equal(snapshot.usage.outputTokens, 30);
    assert.equal(snapshot.usage.totalTokens, 90);
    assert.equal(snapshot.pricing.actualBill, null);
    assert.equal(snapshot.pricing.model.inputPerMillion, undefined);
    assert.equal(inferenceRequests, 3, "Reading resources never runs the model");

    await runtime.dispose(); runtime = new Miniflare(convertV4MiniflareOptions(options));
    assert.deepEqual((await call(filePath("notes/result.md"))).file, result);
    assert.deepEqual((await resources()).usage, snapshot.usage);
    const second = await call("/api/prompt", "POST", { conversation: "workspace", requestId: "workspace-edit", prompt: "Edit the saved workspace result after restart." });
    assert.equal(second.status, "done");
    assert.equal(second.text, "Edited your workspace file after restart.");
    const edited = (await call(filePath("notes/result.md"))).file as WorkspaceFile;
    assert.equal(edited.content, "# Edited after restart\nCafé from the console.\n");
    assert.ok(edited.revision > result.revision);
    const finalResources = await resources();
    assert.equal(finalResources.usage.inputTokens, 120);
    assert.equal(finalResources.usage.outputTokens, 60);
    assert.equal(finalResources.usage.totalTokens, 180);
    assert.equal(inferenceRequests, 6);
  } finally {
    await runtime.dispose(); await rm(directory, { recursive: true, force: true });
  }
});
