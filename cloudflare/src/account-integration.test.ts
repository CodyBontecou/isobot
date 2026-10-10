import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions, type V4MiniflareOptions } from "miniflare";

test("account credentials protect production HTTP routes without changing the Discord bridge", async t => {
  const directory = await mkdtemp(join(tmpdir(), "isobot-account-http-"));
  const bundle = join(directory, "worker.mjs");
  const sessionCredential = "s".repeat(43);
  const csrfToken = "c".repeat(43);
  await build({
    stdin: {
      contents: `import worker, { AccountAuth } from './index.ts';
        export { AccountAuth };
        export default { async fetch(request, env) {
          if (new URL(request.url).pathname === '/__test/seed') {
            const auth = env.AccountAuth.getByName('accounts');
            const account = await auth.upsertAccount({githubId:'42',login:'owner'});
            await auth.createSession({accountId:account.accountId,credential:'${sessionCredential}',csrfToken:'${csrfToken}',expiresAt:Date.now()+600000});
            return Response.json({seeded:true});
          }
          return worker.fetch(request, {...env,
            Assistant:{getByName() {return {
              async conversationSnapshot(){return JSON.stringify({model:'test',busy:false,pending:[],entries:[]})},
              async runPrompt(prompt,requestId){return {conflict:false,operationId:requestId,status:'done',text:'test reply'}},
              async submitChat(prompt,requestId){return {conflict:false,accepted:true,operationId:requestId,status:'queued'}},
              async chatStatus(requestId){return {operationId:requestId,status:'done',text:'test reply'}},
              async cancelChat(requestId){return {operationId:requestId,status:'unanswered',cancelled:true,reason:'aborted'}},
              workspaceList(){return {files:[],totalBytes:0,maxFileBytes:131072,maxFiles:500,maxBytes:33554432}},
              workspaceRead(path){return {path,content:'test',bytes:4,revision:1,updatedAt:'2026-10-07T00:00:00Z'}},
              workspaceWrite(path,content){return {ok:true,file:{path,content,bytes:content.length,revision:2,updatedAt:'2026-10-07T00:00:00Z'}}},
              workspaceDelete(){return {ok:true,deleted:true}},
              async resourcesSnapshot(){return JSON.stringify({runtime:{model:'test'},storage:{workspaceFiles:0}})}
            }}},
            DeliveryInbox:{getByName(){return {async pending(){return []}}}}
          });
        }};`,
      resolveDir: new URL(".", import.meta.url).pathname, sourcefile: "account-http-test.ts", loader: "ts",
    },
    bundle: true, format: "esm", platform: "browser", conditions: ["workerd"],
    external: ["cloudflare:*", "node:*", "path"], outfile: bundle,
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire('/worker.mjs');" },
  });
  const options: V4MiniflareOptions = { workers: [{
    name: "isobot-account-http-test", modules: true, scriptPath: bundle, modulesRoot: directory,
    compatibilityDate: "2026-10-07", compatibilityFlags: ["nodejs_compat"],
    durableObjects: { AccountAuth: { className: "AccountAuth", useSQLite: true } },
    bindings: { AUTH_ORIGIN: "https://test", GITHUB_OAUTH_ALLOWED_IDS: "42", ISOBOT_API_TOKEN: "legacy-service", PROMPT_API_TOKEN: "legacy-prompt", PI_MODEL: "test" },
  }] };
  const runtime = new Miniflare(convertV4MiniflareOptions(options));
  const request = (path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}) => runtime.dispatchFetch(`https://test${path}`, options);
  const cookie = `__Host-isobot_session=${sessionCredential}`;
  const sessionHeaders = { Cookie: cookie, Origin: "https://test", "X-CSRF-Token": csrfToken, "Content-Type": "application/json" };
  const issue = async (scopes: string[]) => {
    const response = await request("/api/auth/tokens", { method: "POST", headers: sessionHeaders, body: JSON.stringify({ name: "Vox test", scopes, expiresInDays: 30 }) });
    assert.equal(response.status, 201);
    return await response.json() as { token: string; id: string };
  };
  try {
    assert.equal((await request("/__test/seed")).status, 200);
    await t.test("browser session reads saved history and receives account identity", async () => {
      assert.equal((await request("/api/conversation", { headers: { Cookie: cookie } })).status, 200);
      const session = await request("/api/auth/session", { headers: { Cookie: cookie } });
      assert.equal(session.headers.get("Cache-Control"), "no-store");
      assert.deepEqual(await session.json(), { authenticated: true, user: { id: "42", login: "owner", name: null }, csrfToken });
    });
    await t.test("browser prompt mutations require matching origin and CSRF", async () => {
      const body = JSON.stringify({ prompt: "Hello", requestId: "browser-prompt" });
      for (const headers of [{ Cookie: cookie }, { ...sessionHeaders, Origin: "https://other.example" }, { ...sessionHeaders, "X-CSRF-Token": "x".repeat(43) }]) {
        assert.equal((await request("/api/prompt", { method: "POST", headers, body })).status, 403);
      }
      assert.equal((await request("/api/prompt", { method: "POST", headers: sessionHeaders, body })).status, 200);
    });
    await t.test("read tokens cannot submit prompts and never reveal their secret again", async () => {
      const token = await issue(["read"]);
      assert.match(token.token, /^isobot_pat_[A-Za-z0-9_-]{43}$/);
      const headers = { Authorization: `Bearer ${token.token}`, "Content-Type": "application/json" };
      assert.equal((await request("/api/conversation", { headers })).status, 200);
      assert.equal((await request("/api/prompt", { method: "POST", headers, body: JSON.stringify({ prompt: "Hello" }) })).status, 401);
      const listed = await request("/api/auth/tokens", { headers: { Cookie: cookie } });
      assert.equal(listed.status, 200);
      assert.ok(!(await listed.text()).includes(token.token));
    });
    await t.test("Vox tokens permit prompts but cannot administer credentials or Discord", async () => {
      const token = await issue(["read", "write"]);
      const headers = { Authorization: `Bearer ${token.token}`, "Content-Type": "application/json" };
      assert.equal((await request("/api/prompt", { method: "POST", headers, body: JSON.stringify({ prompt: "Hello", requestId: "vox-token" }) })).status, 200);
      for (const path of ["/api/auth/tokens", "/api/pending", "/api/status", "/api/chatgpt/connection"]) {
        assert.equal((await request(path, { headers })).status, 401);
      }
      assert.equal((await request("/api/auth/tokens", { headers: { ...headers, Cookie: cookie } })).status, 401);
      const revoked = await request(`/api/auth/tokens/${token.id}`, { method: "DELETE", headers: sessionHeaders });
      assert.equal(revoked.status, 200);
      assert.equal((await request("/api/conversation", { headers })).status, 401);
    });
    await t.test("invalid explicit bearer never falls back to the browser session", async () => {
      assert.equal((await request("/api/conversation", { headers: { Cookie: cookie, Authorization: "Bearer wrong" } })).status, 401);
    });
    await t.test("legacy Vox and Discord bearer tokens retain their original scopes", async () => {
      assert.equal((await request("/api/conversation", { headers: { Authorization: "Bearer legacy-prompt" } })).status, 200);
      assert.equal((await request("/api/pending", { headers: { Authorization: "Bearer legacy-service" } })).status, 200);
      assert.equal((await request("/api/pending", { headers: { Authorization: "Bearer legacy-prompt" } })).status, 401);
    });
    await t.test("chat and workspace reads accept scoped tokens and reject unauthenticated callers", async () => {
      const token = await issue(["read"]);
      for (const path of ["/api/workspace", "/api/workspace/file?path=notes/test.md", "/api/resources", "/api/chat/test-request"]) {
        assert.equal((await request(path)).status, 401, path);
        assert.equal((await request(path, { headers: { Authorization: `Bearer ${token.token}` } })).status, 200, path);
        assert.equal((await request(path, { headers: { Cookie: cookie } })).status, 200, path);
        assert.equal((await request(path, { headers: { Authorization: "Bearer legacy-prompt" } })).status, 200, path);
      }
    });
    await t.test("chat submission, cancellation and file mutations require write scope or session CSRF", async () => {
      const read = await issue(["read"]);
      const write = await issue(["read", "write"]);
      const mutations = [
        { path: "/api/chat", method: "POST", body: JSON.stringify({ prompt: "Hello", requestId: "scope-test" }), status: 202 },
        { path: "/api/chat/scope-test", method: "DELETE", status: 200 },
        { path: "/api/workspace/file?path=notes/test.md", method: "PUT", body: JSON.stringify({ content: "test", expectedRevision: null }), status: 201 },
        { path: "/api/workspace/file?path=notes/test.md", method: "DELETE", body: JSON.stringify({ expectedRevision: 1 }), status: 200 },
      ];
      for (const mutation of mutations) {
        const options = { method: mutation.method, body: mutation.body };
        assert.equal((await request(mutation.path, { ...options, headers: { Authorization: `Bearer ${read.token}`, "Content-Type": "application/json" } })).status, 401, mutation.path);
        assert.equal((await request(mutation.path, { ...options, headers: { Cookie: cookie } })).status, 403, mutation.path);
        assert.equal((await request(mutation.path, { ...options, headers: { ...sessionHeaders, Origin: "https://other.example" } })).status, 403, mutation.path);
        assert.equal((await request(mutation.path, { ...options, headers: { Authorization: `Bearer ${write.token}`, "Content-Type": "application/json" } })).status, mutation.status, mutation.path);
        assert.equal((await request(mutation.path, { ...options, headers: sessionHeaders })).status, mutation.status, mutation.path);
        assert.equal((await request(mutation.path, { ...options, headers: { Authorization: "Bearer legacy-prompt", "Content-Type": "application/json" } })).status, mutation.status, mutation.path);
      }
    });
    await t.test("logout clears the cookie and invalidates the stored session immediately", async () => {
      const response = await request("/auth/logout", { method: "POST", headers: sessionHeaders });
      assert.equal(response.status, 200);
      assert.match(response.headers.get("Set-Cookie")!, /Max-Age=0/);
      assert.equal((await request("/api/conversation", { headers: { Cookie: cookie } })).status, 401);
    });
  } finally {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
