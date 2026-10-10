import assert from "node:assert/strict";
import test from "node:test";
import { authenticateAccountToken, checkSessionMutation, handleAccountRequest, isAccountRoute, resolveAccountSession, type AccountEnvironment } from "./account-routes.js";
import type { AccountProfile, AccountSession, ApiTokenInput, ApiTokenRecord, OAuthFlow, OAuthFlowInput, SessionInput } from "./account-store.js";

const origin = "https://isobot-pi.costream.workers.dev";
const sessionCredential = "S".repeat(43);
const csrfToken = "C".repeat(43);
const tokenId = "99e41d5f-0c74-42bd-a942-64d36fbaf447";
const pat = `isobot_pat_${"P".repeat(43)}`;

class FakeAccounts {
  account: AccountProfile = { accountId: "github:20440899", githubId: "20440899", login: "codybontecou", name: "Cody" };
  flows = new Map<string, OAuthFlow>();
  flowInputs: OAuthFlowInput[] = [];
  sessionInputs: SessionInput[] = [];
  tokenInputs: ApiTokenInput[] = [];
  upserts: Parameters<FakeAccounts["upsertAccount"]>[0][] = [];
  consumed: string[] = [];
  revokedSessions: string[] = [];
  revokedTokens: { accountId: string; tokenId: string }[] = [];
  validations: { credential: string; scope: "read" | "write" }[] = [];
  token: ApiTokenRecord = { id: tokenId, name: "Vox.md", prefix: "isobot_pat_PPPPPP", last4: "PPPP", scopes: "read write", createdAt: 100 };
  tokenLimit = false;
  revokeResult = true;
  failure = false;

  async createFlow(input: OAuthFlowInput) { this.flowInputs.push(input); this.flows.set(input.state, input); return { expiresAt: input.expiresAt }; }
  async consumeFlow({ state }: { state: string }) { this.consumed.push(state); const flow = this.flows.get(state) ?? null; this.flows.delete(state); return flow; }
  async upsertAccount(input: { githubId: string; login: string; name?: string; avatarUrl?: string }) { this.upserts.push(input); return { ...this.account, ...input }; }
  async createSession(input: SessionInput) { this.sessionInputs.push(input); return { expiresAt: input.expiresAt }; }
  async validateSession({ credential }: { credential: string }): Promise<AccountSession | null> {
    if (this.failure) throw new Error("secret database detail");
    return credential === sessionCredential ? { account: this.account, csrfToken, expiresAt: Date.now() + 100_000 } : null;
  }
  async revokeSession({ credential }: { credential: string }) { this.revokedSessions.push(credential); return true; }
  async createApiToken(input: ApiTokenInput) {
    if (this.failure) throw new Error("secret database detail");
    this.tokenInputs.push(input);
    return this.tokenLimit ? null : { ...this.token, name: input.name, scopes: input.scopes, prefix: input.credential.slice(0, 17),
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}) };
  }
  async validateApiToken(input: { credential: string; scope: "read" | "write" }) {
    this.validations.push(input);
    return input.credential === pat && (input.scope === "read" || this.token.scopes === "read write")
      ? { account: this.account, token: this.token } : null;
  }
  async listApiTokens({ accountId }: { accountId: string }) {
    assert.equal(accountId, this.account.accountId);
    return [this.token];
  }
  async revokeApiToken(input: { accountId: string; tokenId: string }) { this.revokedTokens.push(input); return this.revokeResult; }
}

function fixture() {
  const auth = new FakeAccounts();
  const env: AccountEnvironment = {
    AUTH_ORIGIN: origin, GITHUB_OAUTH_CLIENT_ID: "test-client", GITHUB_OAUTH_CLIENT_SECRET: "test-client-secret",
    GITHUB_OAUTH_ALLOWED_IDS: "20440899", AccountAuth: { getByName(name) { assert.equal(name, "accounts"); return auth; } },
  };
  return { auth, env };
}

function request(path: string, options: { method?: string; session?: boolean; csrf?: string | null; origin?: string | null; body?: unknown; authorization?: string; rawBody?: string } = {}) {
  const headers = new Headers();
  if (options.session) headers.set("Cookie", `__Host-isobot_session=${sessionCredential}`);
  if (options.csrf !== null && options.session) headers.set("X-CSRF-Token", options.csrf ?? csrfToken);
  if (options.origin !== null && options.session) headers.set("Origin", options.origin ?? origin);
  if (options.authorization) headers.set("Authorization", options.authorization);
  const body = options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
  if (body !== undefined) headers.set("Content-Type", "application/json");
  return new Request(`${origin}${path}`, { method: options.method ?? "GET", headers, body });
}

function githubFetcher(profile: Record<string, unknown> = { id: 20440899, login: "codybontecou", name: "Cody", avatar_url: "https://avatars.githubusercontent.com/u/20440899" }) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    return Response.json(url.includes("/access_token") ? { access_token: "synthetic-github-token", token_type: "bearer", scope: "" } : profile);
  };
  return { calls, fetcher };
}

async function login(env: AccountEnvironment, conversation = "vox") {
  const response = await handleAccountRequest(request(`/auth/github/login?conversation=${conversation}`), env);
  const authorize = new URL(response.headers.get("Location")!);
  const state = authorize.searchParams.get("state")!;
  return { response, authorize, state, callback: new Request(`${origin}/auth/github/callback?state=${state}&code=github-code`, {
    headers: { Cookie: `__Host-isobot_oauth=${state}` },
  }) };
}

test("public session reports configuration without accepting bearer credentials or exposing secrets", async () => {
  const { env } = fixture();
  const response = await handleAccountRequest(request("/api/auth/session", { authorization: `Bearer ${pat}` }), env);
  assert.deepEqual(await response.json(), { authenticated: false, oauthConfigured: true });
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await (await handleAccountRequest(request("/api/auth/session"), { ...env, GITHUB_OAUTH_CLIENT_SECRET: undefined })).json(), { authenticated: false, oauthConfigured: false });
  assert.deepEqual(await (await handleAccountRequest(request("/api/auth/session"), { ...env, GITHUB_OAUTH_ALLOWED_IDS: "20440899,wrong" })).json(), { authenticated: false, oauthConfigured: false });
  const signedIn = await handleAccountRequest(request("/api/auth/session", { session: true }), env);
  assert.deepEqual(await signedIn.json(), { authenticated: true, user: { id: "20440899", login: "codybontecou", name: "Cody" }, csrfToken });
  assert.equal(isAccountRoute("/api/auth/tokens/abc"), true);
  assert.equal(isAccountRoute("/api/prompt"), false);
});

test("GitHub login binds a ten-minute durable flow to a secure browser cookie and S256 challenge", async () => {
  const { auth, env } = fixture();
  const before = Date.now();
  const { response, authorize, state } = await login(env);
  assert.equal(response.status, 302);
  assert.equal(authorize.origin, "https://github.com");
  assert.equal(authorize.pathname, "/login/oauth/authorize");
  assert.equal(authorize.searchParams.get("redirect_uri"), `${origin}/auth/github/callback`);
  assert.equal(authorize.searchParams.get("scope"), "");
  assert.equal(authorize.searchParams.has("scope"), true);
  assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
  assert.match(state, /^[A-Za-z0-9_-]{43}$/);
  const stored = auth.flowInputs[0];
  assert.equal(stored.state, state);
  assert.match(stored.codeVerifier, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(stored.codeVerifier, state);
  assert.equal(stored.returnTo, "/console?conversation=vox");
  assert.ok(stored.expiresAt >= before + 600_000 && stored.expiresAt <= Date.now() + 600_000);
  const challenge = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stored.codeVerifier))).toString("base64url");
  assert.equal(authorize.searchParams.get("code_challenge"), challenge);
  const cookies = response.headers.get("Set-Cookie")!;
  assert.equal(cookies, `__Host-isobot_oauth=${state}; Max-Age=600; Path=/; Secure; HttpOnly; SameSite=Lax`);
  assert.equal(authorize.searchParams.has("client_secret"), false);
});

test("login only permits fixed console returns and validates the optional conversation", async () => {
  const { auth, env } = fixture();
  await handleAccountRequest(request("/auth/github/login?returnTo=https://attacker.invalid"), env);
  assert.equal(auth.flowInputs[0].returnTo, "/console");
  for (const query of ["conversation=../private", "conversation=one&conversation=two", "conversation="]) {
    assert.equal((await handleAccountRequest(request(`/auth/github/login?${query}`), env)).status, 400);
  }
  assert.equal(auth.flowInputs.length, 1);
  assert.equal((await handleAccountRequest(request("/auth/github/login", { method: "POST" }), env)).status, 405);
  const wrongOrigin = await handleAccountRequest(new Request("https://attacker.invalid/auth/github/login"), env);
  assert.equal(wrongOrigin.headers.get("Location"), "/console?authError=not_configured");
});

test("callback exchanges PKCE code, checks identity, and creates a new seven-day browser session", async () => {
  const { auth, env } = fixture();
  const { callback, state } = await login(env);
  const { fetcher, calls } = githubFetcher();
  const before = Date.now();
  const response = await handleAccountRequest(callback, env, fetcher);
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("Location"), "/console?conversation=vox");
  assert.deepEqual(auth.consumed, [state]);
  assert.equal(calls.length, 2);
  const exchange = calls[0].init!;
  const exchangedBody = new URLSearchParams(String(exchange.body));
  assert.equal(exchangedBody.get("code_verifier"), auth.flowInputs[0].codeVerifier);
  assert.equal(exchangedBody.get("redirect_uri"), `${origin}/auth/github/callback`);
  assert.equal(exchangedBody.get("client_secret"), "test-client-secret");
  assert.equal(exchange.redirect, "manual");
  assert.equal(new Headers(exchange.headers).get("User-Agent"), "isobot-pi");
  assert.ok(exchange.signal instanceof AbortSignal);
  assert.equal(new Headers(calls[1].init?.headers).get("Authorization"), "Bearer synthetic-github-token");
  assert.deepEqual(auth.upserts, [{ githubId: "20440899", login: "codybontecou", name: "Cody", avatarUrl: "https://avatars.githubusercontent.com/u/20440899" }]);
  const session = auth.sessionInputs[0];
  assert.equal(session.accountId, "github:20440899");
  assert.match(session.credential, /^[A-Za-z0-9_-]{43}$/);
  assert.match(session.csrfToken, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(session.csrfToken, session.credential);
  assert.ok(session.expiresAt >= before + 7 * 86_400_000 && session.expiresAt <= Date.now() + 7 * 86_400_000);
  assert.ok(response.headers.get("Set-Cookie")?.includes(`__Host-isobot_session=${session.credential}; Max-Age=604800; Path=/; Secure; HttpOnly; SameSite=Lax`));
  assert.ok(response.headers.get("Set-Cookie")?.includes("__Host-isobot_oauth=; Max-Age=0"));
  assert.equal(JSON.stringify({ upserts: auth.upserts, sessions: auth.sessionInputs }).includes("synthetic-github-token"), false);
  assert.equal((await handleAccountRequest(callback, env, fetcher)).headers.get("Location"), "/console?authError=invalid_state");
  assert.equal(calls.length, 2);
});

test("callback rejects state mismatches, missing cookies, duplicates and expired flows before upstream calls", async () => {
  const { auth, env } = fixture();
  const { state } = await login(env);
  const { fetcher, calls } = githubFetcher();
  const variants = [
    new Request(`${origin}/auth/github/callback?state=${state}&code=x`),
    new Request(`${origin}/auth/github/callback?state=${"Z".repeat(43)}&code=x`, { headers: { Cookie: `__Host-isobot_oauth=${state}` } }),
    new Request(`${origin}/auth/github/callback?state=${state}&state=${state}&code=x`, { headers: { Cookie: `__Host-isobot_oauth=${state}` } }),
    new Request(`${origin}/auth/github/callback?state=${state}&code=x`, { headers: { Cookie: `__Host-isobot_oauth=${state}; __Host-isobot_oauth=${state}` } }),
  ];
  for (const callback of variants) {
    const response = await handleAccountRequest(callback, env, fetcher);
    assert.equal(response.headers.get("Location"), "/console?authError=invalid_state");
    assert.match(response.headers.get("Set-Cookie")!, /Max-Age=0/);
  }
  assert.equal(auth.consumed.length, 0);
  auth.flows.set(state, { codeVerifier: "V".repeat(43), returnTo: "/console", expiresAt: Date.now() - 1 });
  const expired = await handleAccountRequest(new Request(`${origin}/auth/github/callback?state=${state}&code=x`, { headers: { Cookie: `__Host-isobot_oauth=${state}` } }), env, fetcher);
  assert.equal(expired.headers.get("Location"), "/console?authError=invalid_state");
  assert.equal(calls.length, 0);
});

test("denied logins and unapproved GitHub identities never create accounts or sessions", async () => {
  const { auth, env } = fixture();
  const first = await login(env);
  const { fetcher, calls } = githubFetcher({ id: 123, login: "outsider", name: null });
  const denied = await handleAccountRequest(new Request(`${origin}/auth/github/callback?state=${first.state}&error=access_denied&error_description=secret`, {
    headers: { Cookie: `__Host-isobot_oauth=${first.state}` },
  }), env, fetcher);
  assert.equal(denied.headers.get("Location"), "/console?authError=denied");
  assert.equal(calls.length, 0);
  assert.deepEqual(auth.consumed, [first.state]);
  const second = await login(env);
  const blocked = await handleAccountRequest(second.callback, env, fetcher);
  assert.equal(blocked.headers.get("Location"), "/console?authError=not_allowed");
  assert.equal(auth.upserts.length, 0);
  assert.equal(auth.sessionInputs.length, 0);
});

test("OAuth diagnostics identify the failing boundary without provider content or credentials", async t => {
  const warnings = t.mock.method(console, "warn", () => undefined);
  const cases: { fetcher: typeof fetch; phase: string; reason: string; status?: number }[] = [
    { fetcher: async () => new Response("test-client-secret and github-code", { status: 403 }), phase: "token_exchange", reason: "http_error", status: 403 },
    { fetcher: async () => Response.json({ error: "incorrect_client_credentials", error_description: "test-client-secret and github-code" }), phase: "token_exchange", reason: "incorrect_client_credentials", status: 200 },
    { fetcher: async () => Response.json({ error: "test-client-secret", error_description: "github-code" }), phase: "token_exchange", reason: "invalid_token_response", status: 200 },
    { fetcher: async input => {
      if (String(input).includes("access_token")) return Response.json({ access_token: "synthetic-github-token", token_type: "bearer" });
      throw new Error("synthetic-github-token and secret provider detail");
    }, phase: "identity_lookup", reason: "fetch_error" },
  ];
  for (const item of cases) {
    const { env } = fixture();
    const { callback, state } = await login(env);
    const before = warnings.mock.callCount();
    const response = await handleAccountRequest(callback, env, item.fetcher);
    assert.equal(response.headers.get("Location"), "/console?authError=login_failed");
    assert.equal(warnings.mock.callCount(), before + 1);
    const logged = String(warnings.mock.calls[before].arguments[0]);
    assert.deepEqual(JSON.parse(logged), { event: "github_oauth_failed", phase: item.phase, reason: item.reason,
      ...(item.status !== undefined ? { status: item.status } : {}) });
    for (const secret of ["test-client-secret", "github-code", "synthetic-github-token", "secret provider detail", state]) assert.equal(logged.includes(secret), false);
  }
});

test("GitHub failures and oversized upstream payloads produce fixed safe errors", async () => {
  const { auth, env } = fixture();
  const upstreams: (typeof fetch)[] = [
    async () => { throw new Error("secret upstream detail"); },
    async () => new Response("secret upstream detail", { status: 500 }),
    async () => Response.json({ error: "secret-provider-error", error_description: "secret detail" }),
    async () => new Response("invalid secret JSON"),
    async () => Response.json({ access_token: "synthetic-github-token", token_type: "bearer", filler: "x".repeat(65_536) }),
    githubFetcher({ id: "20440899", login: "codybontecou" }).fetcher,
    githubFetcher({ id: 20440899, login: "codybontecou", name: "x".repeat(201) }).fetcher,
    githubFetcher({ id: 20440899, login: "codybontecou", name: "x".repeat(65_536) }).fetcher,
  ];
  for (const fetcher of upstreams) {
    const { callback } = await login(env);
    const response = await handleAccountRequest(callback, env, fetcher);
    assert.equal(response.headers.get("Location"), "/console?authError=login_failed");
    assert.equal(await response.text(), "");
  }
  assert.equal(auth.upserts.length, 0);
  assert.equal(auth.sessionInputs.length, 0);
});

test("session and token resolution immediately honor the current numeric account allowlist", async () => {
  const { env } = fixture();
  assert.ok(await resolveAccountSession(request("/api/prompt", { session: true }), env));
  assert.equal(await resolveAccountSession(request("/api/prompt", { session: true }), { ...env, GITHUB_OAUTH_ALLOWED_IDS: "123" }), null);
  assert.equal(await resolveAccountSession(request("/api/prompt", { session: true }), { ...env, GITHUB_OAUTH_ALLOWED_IDS: "" }), null);
  const wrongOrigin = new Request("https://alternate.invalid/api/prompt", { headers: { Cookie: `__Host-isobot_session=${sessionCredential}` } });
  assert.equal(await resolveAccountSession(wrongOrigin, env), null);
  const identity = await authenticateAccountToken(request("/api/prompt", { authorization: `Bearer ${pat}` }), env, "write");
  assert.equal(identity?.account.accountId, "github:20440899");
  assert.equal(await authenticateAccountToken(request("/api/prompt", { authorization: `Bearer ${pat}` }), { ...env, GITHUB_OAUTH_ALLOWED_IDS: "123" }, "read"), null);
  assert.equal(await authenticateAccountToken(new Request("https://alternate.invalid/api/prompt", { headers: { Authorization: `Bearer ${pat}` } }), env, "read"), null);
});

test("browser mutations require their session's CSRF token and an exact configured Origin", async () => {
  const { env } = fixture();
  const session = (await resolveAccountSession(request("/api/auth/session", { session: true }), env))!;
  assert.equal(await checkSessionMutation(request("/api/auth/tokens", { session: true, method: "POST" }), env, session), true);
  for (const options of [{ csrf: null }, { csrf: "D".repeat(43) }, { origin: null }, { origin: "https://attacker.invalid" }, { origin: `${origin}/` }]) {
    assert.equal(await checkSessionMutation(request("/api/auth/tokens", { session: true, method: "POST", ...options }), env, session), false);
    assert.equal((await handleAccountRequest(request("/api/auth/tokens", { session: true, method: "POST", body: { name: "Test", scopes: ["read"] }, ...options }), env)).status, 403);
  }
});

test("token administration cannot be bootstrapped with bearer tokens", async () => {
  const { auth, env } = fixture();
  for (const authorization of ["Bearer bridge-token", `Bearer ${pat}`]) {
    for (const [path, method] of [["/api/auth/tokens", "GET"], ["/api/auth/tokens", "POST"], [`/api/auth/tokens/${tokenId}`, "DELETE"], ["/auth/logout", "POST"]]) {
      const response = await handleAccountRequest(request(path, { method, authorization, body: method === "POST" ? { name: "Test", scopes: ["read"] } : undefined }), env);
      assert.equal(response.status, 401);
    }
  }
  assert.equal(auth.tokenInputs.length, 0);
  assert.equal(auth.revokedTokens.length, 0);
  assert.equal(auth.revokedSessions.length, 0);
});

test("explicit Authorization never falls back to a browser cookie for sessions or account administration", async () => {
  const { auth, env } = fixture();
  for (const authorization of ["Bearer invalid-token", `Bearer ${pat}`, "Basic invalid"]) {
    const publicSession = await handleAccountRequest(request("/api/auth/session", { session: true, authorization }), env);
    assert.deepEqual(await publicSession.json(), { authenticated: false, oauthConfigured: true });
    assert.equal(await resolveAccountSession(request("/api/prompt", { session: true, authorization }), env), null);
    for (const [path, method] of [["/api/auth/tokens", "GET"], ["/api/auth/tokens", "POST"], [`/api/auth/tokens/${tokenId}`, "DELETE"], ["/auth/logout", "POST"]]) {
      assert.equal((await handleAccountRequest(request(path, { session: true, method, authorization,
        body: method === "POST" ? { name: "Test", scopes: ["read"] } : undefined }), env)).status, 401);
    }
  }
  const emptyHeader = request("/api/auth/tokens", { session: true });
  emptyHeader.headers.set("Authorization", "");
  assert.equal((await handleAccountRequest(emptyHeader, env)).status, 401);
  assert.equal(auth.tokenInputs.length, 0);
  assert.equal(auth.revokedTokens.length, 0);
  assert.equal(auth.revokedSessions.length, 0);
});

test("sessions create a one-time scoped PAT and list only sanitized token metadata", async () => {
  const { auth, env } = fixture();
  const before = Date.now();
  const created = await handleAccountRequest(request("/api/auth/tokens", { session: true, method: "POST", body: { name: " Vox preset ", scopes: ["write", "read"], expiresInDays: 30 } }), env);
  assert.equal(created.status, 201);
  const result = await created.json() as { token: string; scopes: string[]; name: string; expiresAt: string };
  assert.match(result.token, /^isobot_pat_[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(result.scopes, ["read", "write"]);
  assert.equal(result.name, "Vox preset");
  assert.ok(Date.parse(result.expiresAt) >= before + 30 * 86_400_000 && Date.parse(result.expiresAt) <= Date.now() + 30 * 86_400_000);
  assert.equal(auth.tokenInputs[0].credential, result.token);
  assert.equal(auth.tokenInputs[0].accountId, "github:20440899");
  const listed = await handleAccountRequest(request("/api/auth/tokens", { session: true }), env);
  assert.deepEqual(await listed.json(), { tokens: [{ id: tokenId, name: "Vox.md", prefix: "isobot_pat_PPPPPP…PPPP", scopes: ["read", "write"], createdAt: "1970-01-01T00:00:00.100Z", expiresAt: null, lastUsedAt: null, revokedAt: null }] });
  const permanent = await handleAccountRequest(request("/api/auth/tokens", { session: true, method: "POST", body: { name: "Reader", scopes: ["read"], expiresInDays: null } }), env);
  assert.equal(permanent.status, 201);
  assert.equal(auth.tokenInputs[1].expiresAt, undefined);
  auth.tokenLimit = true;
  const limited = await handleAccountRequest(request("/api/auth/tokens", { session: true, method: "POST", body: { name: "Reader", scopes: ["read"] } }), env);
  assert.equal(limited.status, 409);
  assert.equal((await limited.text()).includes("isobot_pat_"), false);
});

test("token creation rejects malformed JSON and invalid settings before issuing credentials", async () => {
  const { auth, env } = fixture();
  const values = [null, [], {}, { name: " ", scopes: ["read"] }, { name: "x".repeat(81), scopes: ["read"] },
    { name: "Test", scopes: ["write"] }, { name: "Test", scopes: ["read", "read"] }, { name: "Test", scopes: ["read", "admin"] },
    { name: "Test", scopes: "read" }, { name: "Test", scopes: ["read"], expiresInDays: "90" }, { name: "Test", scopes: ["read"], expiresInDays: 1 }];
  for (const body of values) {
    assert.equal((await handleAccountRequest(request("/api/auth/tokens", { session: true, method: "POST", body }), env)).status, 400);
  }
  for (const rawBody of ["", "{", "x".repeat(8193)]) {
    assert.equal((await handleAccountRequest(request("/api/auth/tokens", { session: true, method: "POST", rawBody }), env)).status, 400);
  }
  assert.equal(auth.tokenInputs.length, 0);
});

test("session owners can revoke tokens and logout while malformed IDs and absent tokens are rejected", async () => {
  const { auth, env } = fixture();
  assert.equal((await handleAccountRequest(request(`/api/auth/tokens/${tokenId}`, { session: true, method: "DELETE" }), env)).status, 200);
  assert.deepEqual(auth.revokedTokens, [{ accountId: "github:20440899", tokenId }]);
  assert.equal((await handleAccountRequest(request("/api/auth/tokens/not-a-uuid", { session: true, method: "DELETE" }), env)).status, 400);
  auth.revokeResult = false;
  assert.equal((await handleAccountRequest(request(`/api/auth/tokens/${tokenId}`, { session: true, method: "DELETE" }), env)).status, 404);
  const logout = await handleAccountRequest(request("/auth/logout", { session: true, method: "POST" }), env);
  assert.equal(logout.status, 200);
  assert.deepEqual(auth.revokedSessions, [sessionCredential]);
  assert.match(logout.headers.get("Set-Cookie")!, /^__Host-isobot_session=; Max-Age=0; Path=\/; Secure; HttpOnly; SameSite=Lax$/);
  assert.equal((await handleAccountRequest(request("/auth/logout", { session: true }), env)).status, 405);
});

test("PAT authentication forwards requested scope but does not accept bootstrap or malformed credentials", async () => {
  const { auth, env } = fixture();
  for (const authorization of ["Bearer bridge-token", "Bearer isobot_pat_short", `Bearer ${pat} extra`, "Basic xyz"]) {
    assert.equal(await authenticateAccountToken(request("/api/prompt", { authorization }), env, "read"), null);
  }
  assert.equal(auth.validations.length, 0);
  auth.token.scopes = "read";
  assert.ok(await authenticateAccountToken(request("/api/notes", { authorization: `Bearer ${pat}` }), env, "read"));
  assert.equal(await authenticateAccountToken(request("/api/prompt", { authorization: `Bearer ${pat}` }), env, "write"), null);
  assert.deepEqual(auth.validations.map(call => call.scope), ["read", "write"]);
});

test("account service failures expose no stored or provider error details", async () => {
  const { auth, env } = fixture();
  auth.failure = true;
  const response = await handleAccountRequest(request("/api/auth/tokens", { session: true }), env);
  assert.equal(response.status, 503);
  assert.equal((await response.text()).includes("secret"), false);
  const session = await handleAccountRequest(request("/api/auth/session", { session: true }), env);
  assert.equal(session.status, 503);
  assert.equal((await session.text()).includes("secret"), false);
});
