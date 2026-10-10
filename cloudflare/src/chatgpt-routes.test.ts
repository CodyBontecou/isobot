import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions, type V4MiniflareOptions } from "miniflare";

test("ChatGPT administration is isolated from prompt and bridge credentials", async t => {
  const directory = await mkdtemp(join(tmpdir(), "isobot-chatgpt-routes-"));
  const bundle = join(directory, "worker.mjs");
  await build({
    stdin: { contents: `import { handleChatGPTRequest } from './chatgpt-routes.ts';
      export default { async fetch(request, env) {
        const calls = [];
        const status = {connected:true,reconnectRequired:false,expiresAt:'2030-01-01T00:00:00.000Z',models:['gpt-6-sol'],selectedModel:null,revision:1};
        const response = await handleChatGPTRequest(request, {...env, ChatGPTAuth:{getByName(name){
          calls.push({name}); return {
            async status(){calls.push({method:'status'});return status;},
            async refreshCatalog(){calls.push({method:'refreshCatalog'});if(new URL(request.url).searchParams.has('fail'))throw new Error('secret-catalog-upstream');return {...status,models:['gpt-6.1-sol','unknown-model']};},
            async importCredential(credential){calls.push({method:'importCredential',clientId:credential.clientId});return status;},
            async selectModel(model,verifyUnlisted){calls.push({method:'selectModel',model,verifyUnlisted});throw new Error('secret-credential-from-upstream');},
            async disconnect(){calls.push({method:'disconnect'});return {revoked:false};},
            async useWorkersAI(){calls.push({method:'useWorkersAI'});return status;}
          };
        }}});
        const headers = new Headers(response.headers);headers.set('X-Test-Calls',JSON.stringify(calls));
        return new Response(response.body,{status:response.status,headers});
      }};`, resolveDir: new URL(".", import.meta.url).pathname, sourcefile: "chatgpt-routes-test.ts", loader: "ts" },
    bundle: true, format: "esm", platform: "browser", conditions: ["workerd"], external: ["cloudflare:*", "node:*", "path"], outfile: bundle,
  });
  const options: V4MiniflareOptions = { workers: [{
    name: "isobot-chatgpt-routes", modules: true, scriptPath: bundle, modulesRoot: directory,
    compatibilityDate: "2026-10-07", compatibilityFlags: ["nodejs_compat"],
    bindings: { CHATGPT_ADMIN_TOKEN: "admin-token", ISOBOT_API_TOKEN: "bridge-token", PROMPT_API_TOKEN: "prompt-token" },
  }] };
  const runtime = new Miniflare(convertV4MiniflareOptions(options));
  const request = (path = "connection", method = "GET", token: string | null = "admin-token", body?: unknown) => runtime.dispatchFetch(`https://test/api/chatgpt/${path}`, {
    method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const calls = (response: Awaited<ReturnType<typeof runtime.dispatchFetch>>) => JSON.parse(response.headers.get("X-Test-Calls")!);
  try {
    await t.test("only the dedicated admin token can look up credentials", async () => {
      for (const token of [null, "incorrect", "bridge-token", "prompt-token"]) {
        const response = await request("connection", "GET", token);
        assert.equal(response.status, 401);
        assert.equal(response.headers.get("Cache-Control"), "no-store");
        assert.deepEqual(calls(response), []);
      }
    });
    await t.test("unsafe methods and invalid imports never touch credential storage", async () => {
      const method = await request("connection", "POST");
      assert.equal(method.status, 405);
      assert.equal(method.headers.get("Allow"), "GET, PUT, DELETE");
      assert.deepEqual(calls(method), []);
      const bad = await request("connection", "PUT", undefined, { credential: { type: "api_key", key: "sk-test" } });
      assert.equal(bad.status, 400);
      assert.deepEqual(calls(bad), []);
      const badModel = await request("model", "POST", undefined, { model: "unsupported" });
      assert.equal(badModel.status, 400);
      assert.deepEqual(calls(badModel), []);
    });
    await t.test("catalog is fetched fresh, excludes models Pi cannot run, and disconnect reports revocation", async () => {
      const catalog = await request("models");
      assert.deepEqual(await catalog.json(), { models: ["gpt-6.1-sol"], selectedModel: null });
      assert.deepEqual(calls(catalog), [{ name: "primary" }, { method: "refreshCatalog" }]);
      const result = await request("connection", "DELETE");
      assert.deepEqual(await result.json(), { connected: false, revoked: false });
      assert.deepEqual(calls(result), [{ name: "primary" }, { method: "disconnect" }]);
    });
    await t.test("provider errors never expose credential-bearing details", async () => {
      const response = await request("model", "POST", undefined, { model: "gpt-6.1-sol" });
      assert.equal(response.status, 503);
      assert.doesNotMatch(await response.text(), /secret-credential/);
      assert.deepEqual(calls(response), [{ name: "primary" }, { method: "selectModel", model: "gpt-6.1-sol", verifyUnlisted: true }]);
      const catalog = await request("models?fail=1");
      assert.equal(catalog.status, 503);
      assert.doesNotMatch(await catalog.text(), /secret-catalog/);
      assert.deepEqual(calls(catalog), [{ name: "primary" }, { method: "refreshCatalog" }]);
    });
  } finally { await runtime.dispose(); await rm(directory, { recursive: true, force: true }); }
});
