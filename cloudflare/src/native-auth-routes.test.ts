import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions, type V4MiniflareOptions } from "miniflare";

const origin = "https://native.test";
const verifier = "v".repeat(43);
const challenge = async (value: string) => Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))).toString("base64url");
type NativeSession = { credential: string; csrfToken: string; user: { id: string; login: string; name: string | null }; expiresAt: string };

test("iOS PKCE handoff uses production HTTP routes and preserves cookie-only account protections", async t => {
  const directory = await mkdtemp(join(tmpdir(), "isobot-native-http-"));
  const bundle = join(directory, "worker.mjs");
  const clientChallenge = await challenge(verifier);
  await build({
    stdin: {
      contents: `import worker, { AccountAuth } from './index.ts';
        export {AccountAuth};
        export default {async fetch(request,env) {
          const url=new URL(request.url);
          if(url.pathname==='/__test/seed') {
            const input=await request.json();
            const auth=env.AccountAuth.getByName('accounts');
            const account=await auth.upsertAccount({githubId:input.githubId??'42',login:'owner'});
            await auth.createNativeCode({code:input.code,accountId:account.accountId,codeChallenge:input.codeChallenge,expiresAt:Date.now()+10000});
            return Response.json({seeded:true});
          }
          const effective=url.searchParams.has('disableOAuth')?{...env,GITHUB_OAUTH_CLIENT_SECRET:undefined}:env;
          return worker.fetch(request,{...effective,
            Assistant:{getByName(){return {
              async conversationSnapshot(){return JSON.stringify({model:'test',busy:false,pending:[],entries:[]})},
              async submitChat(prompt,requestId){return {conflict:false,accepted:true,operationId:requestId,status:'queued'}},
              async chatStatus(requestId){return {operationId:requestId,status:'done',text:'test reply'}},
              workspaceList(){return {files:[],totalBytes:0,maxFileBytes:131072,maxFiles:500,maxBytes:33554432}},
              async resourcesSnapshot(){return JSON.stringify({runtime:{model:'test'},storage:{workspaceFiles:0}})}
            }}}
          });
        }};`,
      resolveDir: new URL(".", import.meta.url).pathname, sourcefile: "native-auth-http-worker.ts", loader: "ts",
    },
    bundle: true, format: "esm", platform: "browser", conditions: ["workerd"],
    external: ["cloudflare:*", "node:*", "path"], outfile: bundle,
    banner: { js: "import { createRequire } from 'node:module'; const require=createRequire('/worker.mjs');" },
  });
  let scenario: "allowed" | "blocked" | "failure" | "redirect" = "allowed";
  let githubChallenge: string | undefined;
  const calls: string[] = [];
  const options: V4MiniflareOptions = {
    resourcePersistencePath: join(directory, "storage"),
    workers: [{ name: "isobot-native-http-test", modules: true, scriptPath: bundle, modulesRoot: directory,
      compatibilityDate: "2026-10-07", compatibilityFlags: ["nodejs_compat"],
      durableObjects: { AccountAuth: { className: "AccountAuth", useSQLite: true } },
      bindings: { AUTH_ORIGIN: origin, GITHUB_OAUTH_ALLOWED_IDS: "42", GITHUB_OAUTH_CLIENT_ID: "synthetic-client",
        GITHUB_OAUTH_CLIENT_SECRET: "synthetic-secret", PI_MODEL: "test" },
      outboundService: async request => {
        calls.push(request.url);
        if (request.url === "https://github.com/login/oauth/access_token") {
          const input = new URLSearchParams(await request.text());
          assert.equal(input.get("redirect_uri"), `${origin}/auth/github/callback`);
          assert.equal(input.get("client_secret"), "synthetic-secret");
          assert.equal(await challenge(input.get("code_verifier")!), githubChallenge);
          assert.notEqual(input.get("code_verifier"), verifier);
          if (scenario === "failure") return Response.json({ error: "bad_verification_code", error_description: "synthetic-secret" });
          if (scenario === "redirect") return new Response(null, { status: 302, headers: { Location: "https://attacker.invalid/token" } });
          return Response.json({ access_token: "synthetic-github-token", token_type: "bearer" });
        }
        if (request.url === "https://api.github.com/user") {
          assert.equal(request.headers.get("Authorization"), "Bearer synthetic-github-token");
          return Response.json({ id: scenario === "blocked" ? 99 : 42, login: "owner", name: "Owner" });
        }
        return new Response(null, { status: 500 });
      },
    }],
  };
  let runtime = new Miniflare(convertV4MiniflareOptions(options));
  const local = (path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
    runtime.dispatchFetch(`${origin}${path}`, { ...init, redirect: "manual" });
  const start = async (native = true, extra = "") => {
    const response = await local(`/auth/github/login?conversation=vox${native ? `&client=ios&code_challenge=${clientChallenge}` : ""}${extra}`);
    assert.equal(response.status, 302);
    const authorize = new URL(response.headers.get("Location")!);
    githubChallenge = authorize.searchParams.get("code_challenge")!;
    return { response, authorize, state: authorize.searchParams.get("state")! };
  };
  const callback = (state: string, query = "code=synthetic-github-code", headers: Record<string, string> = { Cookie: `__Host-isobot_oauth=${state}` }) =>
    local(`/auth/github/callback?state=${state}&${query}`, { headers });
  const exchange = (code: string, codeVerifier: unknown = verifier, headers: Record<string, string> = { Origin: origin, "Content-Type": "application/json" }) =>
    local("/api/auth/native/exchange", { method: "POST", headers, body: JSON.stringify({ code, codeVerifier }) });
  const seed = async (code: string, githubId = "42") => {
    assert.equal((await local("/__test/seed", { method: "POST", body: JSON.stringify({ code, githubId, codeChallenge: clientChallenge }) })).status, 200);
    return code;
  };
  const nativeCode = async () => {
    const login = await start();
    const response = await callback(login.state);
    const location = new URL(response.headers.get("Location")!);
    assert.equal(location.protocol, "isobot:");
    assert.equal(location.host, "auth");
    assert.equal(location.pathname, "");
    assert.deepEqual([...location.searchParams.keys()], ["code"]);
    assert.doesNotMatch(response.headers.get("Set-Cookie")!, /__Host-isobot_session/);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
    assert.match(location.searchParams.get("code")!, /^[A-Za-z0-9_-]{43}$/);
    return location.searchParams.get("code")!;
  };
  let session: NativeSession;
  let consumedCode: string;
  try {
    await t.test("validates native parameters and always uses the configured GitHub callback", async () => {
      for (const query of [
        "client=ios", "client=android&code_challenge=" + clientChallenge, "client=ios&client=ios&code_challenge=" + clientChallenge,
        "client=ios&code_challenge=plain", "client=ios&code_challenge=" + "x".repeat(44),
        "client=ios&code_challenge=" + clientChallenge + "&code_challenge=" + clientChallenge,
        "code_challenge=" + clientChallenge, "client=ios&code_challenge=" + clientChallenge + "&code_challenge_method=plain",
      ]) {
        const response = await local(`/auth/github/login?${query}`);
        assert.equal(response.status, 400, query);
        assert.equal(response.headers.has("Set-Cookie"), false);
      }
      const { response, authorize } = await start(true, "&returnTo=https://attacker.invalid&redirect_uri=evil://auth");
      assert.equal(authorize.searchParams.get("redirect_uri"), `${origin}/auth/github/callback`);
      assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
      assert.notEqual(githubChallenge, clientChallenge);
      assert.equal(authorize.searchParams.get("scope"), "");
      assert.match(response.headers.get("Set-Cookie")!, /Secure; HttpOnly; SameSite=Lax/);
    });
    await t.test("requires the bound browser state before accepting native OAuth callbacks", async () => {
      const { state } = await start();
      const before = calls.length;
      const invalidHeaders: Record<string, string>[] = [{}, { Cookie: `__Host-isobot_oauth=${"z".repeat(43)}` },
        { Cookie: `__Host-isobot_oauth=${state}; __Host-isobot_oauth=${state}` }];
      for (const headers of invalidHeaders) {
        const response = await callback(state, "code=x", headers);
        assert.equal(response.headers.get("Location"), "/console?authError=invalid_state");
      }
      assert.equal(calls.length, before);
      const code = new URL((await callback(state)).headers.get("Location")!).searchParams.get("code");
      assert.ok(code);
      assert.equal((await callback(state)).headers.get("Location"), "/console?authError=invalid_state");
    });
    await t.test("native error marker resolves failed or lost state without authorizing any callback", async () => {
      const { response: login, state } = await start();
      assert.match(login.headers.get("Set-Cookie")!, /__Host-isobot_oauth_client=ios; Max-Age=1200; Path=\/; Secure; HttpOnly; SameSite=Lax/);
      const before = calls.length;
      for (const headers of [
        { Cookie: "__Host-isobot_oauth_client=ios" },
        { Cookie: `__Host-isobot_oauth_client=ios; __Host-isobot_oauth=${"z".repeat(43)}` },
        { Cookie: `__Host-isobot_oauth_client=ios; __Host-isobot_oauth=${state}; __Host-isobot_oauth=${state}` },
      ]) {
        const response = await callback(state, "code=x", headers);
        assert.equal(response.headers.get("Location"), "isobot://auth?error=invalid_state");
        assert.match(response.headers.get("Set-Cookie")!, /__Host-isobot_oauth_client=; Max-Age=0/);
        assert.doesNotMatch(response.headers.get("Set-Cookie")!, /__Host-isobot_session/);
      }
      assert.equal(calls.length, before);
      const finished = await callback(state);
      assert.match(finished.headers.get("Set-Cookie")!, /__Host-isobot_oauth_client=; Max-Age=0/);
      assert.equal((await callback(state, "code=x", { Cookie: `__Host-isobot_oauth_client=ios; __Host-isobot_oauth=${state}` })).headers.get("Location"),
        "isobot://auth?error=invalid_state");
      const unknown = "u".repeat(43);
      assert.equal((await callback(unknown, "code=x", { Cookie: `__Host-isobot_oauth_client=ios; __Host-isobot_oauth=${unknown}` })).headers.get("Location"),
        "isobot://auth?error=invalid_state");
      const web = await start(false);
      const webResponse = await callback(web.state, "code=synthetic-github-code", {
        Cookie: `__Host-isobot_oauth_client=ios; __Host-isobot_oauth=${web.state}`,
      });
      assert.equal(webResponse.headers.get("Location"), "/console?conversation=vox");
      assert.match(webResponse.headers.get("Set-Cookie")!, /__Host-isobot_session=/);
      const restarted = await local("/auth/github/login?conversation=vox", { headers: { Cookie: "__Host-isobot_oauth_client=ios" } });
      assert.match(restarted.headers.get("Set-Cookie")!, /__Host-isobot_oauth_client=; Max-Age=0/);
    });
    await t.test("native callback returns a proof-bound code and exchange creates a seven-day session", async () => {
      consumedCode = await nativeCode();
      assert.equal((await exchange(consumedCode, "z".repeat(43))).status, 401);
      const before = Date.now();
      const response = await exchange(consumedCode);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("Cache-Control"), "no-store");
      assert.equal(response.headers.has("Set-Cookie"), false);
      session = await response.json() as NativeSession;
      assert.deepEqual(Object.keys(session).sort(), ["credential", "csrfToken", "expiresAt", "user"]);
      assert.match(session.credential, /^[A-Za-z0-9_-]{43}$/);
      assert.match(session.csrfToken, /^[A-Za-z0-9_-]{43}$/);
      assert.notEqual(session.credential, session.csrfToken);
      assert.notEqual(session.credential, consumedCode);
      assert.deepEqual(session.user, { id: "42", login: "owner", name: "Owner" });
      assert.ok(Date.parse(session.expiresAt) >= before + 604_800_000 && Date.parse(session.expiresAt) <= Date.now() + 604_800_000);
      assert.equal((await exchange(consumedCode)).status, 401);
    });
    await t.test("session remains usable after restart and the authorization code remains consumed", async () => {
      await runtime.dispose();
      runtime = new Miniflare(convertV4MiniflareOptions(options));
      assert.equal((await exchange(consumedCode)).status, 401);
      const response = await local("/api/auth/session", { headers: { Cookie: `__Host-isobot_session=${session.credential}` } });
      assert.deepEqual(await response.json(), { authenticated: true, user: session.user, csrfToken: session.csrfToken });
    });
    await t.test("rejects wrong origins, malformed bodies, bearer headers and methods without consuming valid codes", async () => {
      const code = await seed("i".repeat(43));
      assert.equal((await local("/api/auth/native/exchange")).status, 405);
      const invalidHeaders: Record<string, string>[] = [
        { "Content-Type": "application/json" }, { Origin: "https://attacker.invalid", "Content-Type": "application/json" },
        { Origin: origin, "Content-Type": "application/json", Authorization: "Bearer any-token" },
      ];
      for (const headers of invalidHeaders) assert.equal((await exchange(code, verifier, headers)).status, 403);
      assert.equal((await exchange(code, verifier, { Origin: origin, "Content-Type": "text/plain" })).status, 415);
      for (const body of ["bad-json", "null", "[]", JSON.stringify({ code }), JSON.stringify({ code, codeVerifier: 123 }),
        JSON.stringify({ code, codeVerifier: "x".repeat(129) }), JSON.stringify({ code: "bad", codeVerifier: verifier }),
        JSON.stringify({ code, codeVerifier: verifier, padding: "x".repeat(4096) })]) {
        assert.equal((await local("/api/auth/native/exchange", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body })).status, 400);
      }
      assert.equal((await exchange(code)).status, 200);
    });
    await t.test("concurrent HTTP exchanges issue one session and enforce the current account allowlist", async () => {
      const code = await seed("j".repeat(43));
      const responses = await Promise.all(Array.from({ length: 8 }, () => exchange(code)));
      assert.equal(responses.filter(response => response.status === 200).length, 1);
      assert.equal(responses.filter(response => response.status === 401).length, 7);
      const denied = await seed("k".repeat(43), "99");
      assert.equal((await exchange(denied)).status, 401);
      assert.equal((await exchange(denied)).status, 401);
    });
    await t.test("recognized native flows report failures through the fixed native callback", async () => {
      const denied = await start();
      assert.equal((await callback(denied.state, "error=access_denied&error_description=secret")).headers.get("Location"), "isobot://auth?error=denied");
      for (const failure of ["blocked", "failure", "redirect"] as const) {
        scenario = failure;
        const { state } = await start();
        const response = await callback(state);
        assert.equal(response.headers.get("Location"), `isobot://auth?error=${failure === "blocked" ? "not_allowed" : "login_failed"}`);
        assert.doesNotMatch(response.headers.get("Set-Cookie")!, /__Host-isobot_session/);
      }
      assert.equal(calls.some(url => url.startsWith("https://attacker.invalid")), false);
      scenario = "allowed";
      const missingCode = await start();
      assert.equal((await callback(missingCode.state, "")).headers.get("Location"), "isobot://auth?error=login_failed");
      const disabled = await local(`/auth/github/login?client=ios&code_challenge=${clientChallenge}&disableOAuth=1`);
      assert.equal(disabled.headers.get("Location"), "isobot://auth?error=not_configured");
    });
    await t.test("web login still returns to the console with the normal secure session cookie", async () => {
      const { state } = await start(false, "&returnTo=evil://auth");
      const response = await callback(state);
      assert.equal(response.headers.get("Location"), "/console?conversation=vox");
      assert.match(response.headers.get("Set-Cookie")!, /__Host-isobot_session=[A-Za-z0-9_-]{43}; Max-Age=604800; Path=\/; Secure; HttpOnly; SameSite=Lax/);
    });
    await t.test("native session can use chat and account APIs only with their existing authentication rules", async () => {
      const cookie = `__Host-isobot_session=${session.credential}`;
      const headers = { Cookie: cookie, Origin: origin, "X-CSRF-Token": session.csrfToken, "Content-Type": "application/json" };
      for (const path of ["/api/conversation", "/api/workspace", "/api/resources", "/api/auth/tokens"]) {
        assert.equal((await local(path, { headers: { Cookie: cookie } })).status, 200, path);
      }
      const body = JSON.stringify({ prompt: "Hello", requestId: "ios-native-test" });
      assert.equal((await local("/api/chat", { method: "POST", headers: { Cookie: cookie }, body })).status, 403);
      assert.equal((await local("/api/chat", { method: "POST", headers, body })).status, 202);
      const issued = await local("/api/auth/tokens", { method: "POST", headers,
        body: JSON.stringify({ name: "iOS", scopes: ["read", "write"], expiresInDays: 30 }) });
      assert.equal(issued.status, 201);
      const token = await issued.json() as { token: string };
      assert.equal((await local("/api/auth/tokens", { headers: { Authorization: `Bearer ${token.token}`, Cookie: cookie } })).status, 401);
      const logout = await local("/auth/logout", { method: "POST", headers });
      assert.equal(logout.status, 200);
      assert.deepEqual(await (await local("/api/auth/session", { headers: { Cookie: cookie } })).json(), { authenticated: false, oauthConfigured: true });
    });
  } finally {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
