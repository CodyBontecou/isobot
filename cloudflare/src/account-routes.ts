import { readJson } from "./http-body.js";
import type { NativeCodeInput, OAuthFlow, OAuthFlowInput } from "./account-store.js";

interface AccountProfile {
  accountId: string;
  githubId: string;
  login: string;
  name?: string;
  avatarUrl?: string;
}

interface TokenRecord {
  id: string;
  name: string;
  scopes: "read" | "read write";
  prefix: string;
  last4: string;
  createdAt: number;
  expiresAt?: number;
  lastUsedAt?: number;
  revokedAt?: number;
}

export interface AccountSession {
  account: AccountProfile;
  csrfToken: string;
  expiresAt: number;
}

export interface AccountTokenIdentity {
  account: AccountProfile;
  token: TokenRecord;
}

interface AccountRpc {
  createFlow(input: OAuthFlowInput): Promise<unknown>;
  consumeFlow(input: { state: string }): Promise<OAuthFlow | null>;
  // Older bindings can still serve web sessions while the native handoff is unavailable.
  createNativeCode?(input: NativeCodeInput): Promise<unknown>;
  consumeNativeCode?(input: { code: string; codeVerifier: string }): Promise<AccountProfile | null>;
  upsertAccount(input: { githubId: string; login: string; name?: string; avatarUrl?: string }): Promise<AccountProfile>;
  createSession(input: { accountId: string; credential: string; csrfToken: string; expiresAt: number }): Promise<unknown>;
  validateSession(input: { credential: string }): Promise<AccountSession | null>;
  revokeSession(input: { credential: string }): Promise<unknown>;
  createApiToken(input: { accountId: string; credential: string; name: string; scopes: "read" | "read write"; expiresAt?: number }): Promise<TokenRecord | null>;
  validateApiToken(input: { credential: string; scope: "read" | "write" }): Promise<AccountTokenIdentity | null>;
  listApiTokens(input: { accountId: string }): Promise<TokenRecord[]>;
  revokeApiToken(input: { accountId: string; tokenId: string }): Promise<boolean>;
}

/** Structural RPC binding keeps browser authentication independent of the Pi model. */
export interface AccountEnvironment {
  AUTH_ORIGIN?: string;
  GITHUB_OAUTH_CLIENT_ID?: string;
  GITHUB_OAUTH_CLIENT_SECRET?: string;
  GITHUB_OAUTH_ALLOWED_IDS?: string;
  AccountAuth: { getByName(name: string): AccountRpc };
}

const PRIVATE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };
const FLOW_COOKIE = "__Host-isobot_oauth";
const FLOW_CLIENT_COOKIE = "__Host-isobot_oauth_client";
const SESSION_COOKIE = "__Host-isobot_session";
const RANDOM = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = 86_400_000;
const SESSION_SECONDS = 7 * 24 * 60 * 60;
const NATIVE_CALLBACK = "isobot://auth";
const NATIVE_CODE_SECONDS = 120;

function fixedOrigin(env: AccountEnvironment): string | null {
  try {
    const url = new URL(env.AUTH_ORIGIN ?? "");
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash && url.pathname === "/"
      ? url.origin : null;
  } catch { return null; }
}

function allowedIds(env: AccountEnvironment): Set<string> | null {
  const ids = (env.GITHUB_OAUTH_ALLOWED_IDS ?? "").split(",").map(id => id.trim());
  return ids.length && ids.every(id => /^[1-9]\d*$/.test(id)) ? new Set(ids) : null;
}

function oauthConfigured(env: AccountEnvironment): boolean {
  return Boolean(fixedOrigin(env) && env.GITHUB_OAUTH_CLIENT_ID?.trim() && env.GITHUB_OAUTH_CLIENT_SECRET?.trim() && allowedIds(env));
}

function randomCredential(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function equalSecret(actual: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const hashes = await Promise.all([actual, expected].map(value => crypto.subtle.digest("SHA-256", encoder.encode(value))));
  const a = new Uint8Array(hashes[0]), b = new Uint8Array(hashes[1]);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}

function cookieValue(request: Request, name: string): string | null {
  const matches = (request.headers.get("Cookie") ?? "").split(";").map(value => value.trim())
    .filter(value => value.startsWith(`${name}=`));
  if (matches.length !== 1) return null;
  const value = matches[0].slice(name.length + 1);
  return RANDOM.test(value) ? value : null;
}

/** This marker selects a fixed error callback only; persisted state decides successful login. */
function nativeErrorCallback(request: Request): boolean {
  const matches = (request.headers.get("Cookie") ?? "").split(";").map(value => value.trim())
    .filter(value => value.startsWith(`${FLOW_CLIENT_COOKIE}=`));
  return matches.length === 1 && matches[0] === `${FLOW_CLIENT_COOKIE}=ios`;
}

function cookie(name: string, value: string, seconds: number): string {
  return `${name}=${value}; Max-Age=${seconds}; Path=/; Secure; HttpOnly; SameSite=Lax`;
}

function json(body: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  return Response.json(body, { status, headers: { ...PRIVATE, ...extraHeaders } });
}

function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ ...PRIVATE, Location: location });
  for (const value of cookies) headers.append("Set-Cookie", value);
  return new Response(null, { status: 302, headers });
}

function failedLogin(code: "not_configured" | "invalid_state" | "denied" | "not_allowed" | "login_failed", native = false): Response {
  return redirect(native ? `${NATIVE_CALLBACK}?error=${code}` : `/console?authError=${code}`,
    [cookie(FLOW_COOKIE, "", 0), cookie(FLOW_CLIENT_COOKIE, "", 0)]);
}

export function isAccountRoute(path: string): boolean {
  return ["/auth/github/login", "/auth/github/callback", "/auth/logout", "/api/auth/session", "/api/auth/native/exchange", "/api/auth/tokens"].includes(path)
    || path.startsWith("/api/auth/tokens/");
}

/** Browser sessions are cookie-only: bootstrap and API bearer tokens cannot become administrators. */
export async function resolveAccountSession(request: Request, env: AccountEnvironment): Promise<AccountSession | null> {
  if (request.headers.has("Authorization")) return null;
  const origin = fixedOrigin(env);
  const credential = cookieValue(request, SESSION_COOKIE);
  if (!origin || new URL(request.url).origin !== origin || !credential) return null;
  const session = await env.AccountAuth.getByName("accounts").validateSession({ credential });
  return session && allowedIds(env)?.has(session.account.githubId) ? session : null;
}

/** Every browser mutation needs the configured origin and its own session's CSRF secret. */
export async function checkSessionMutation(request: Request, env: AccountEnvironment, session: AccountSession): Promise<boolean> {
  const origin = fixedOrigin(env);
  const csrf = request.headers.get("X-CSRF-Token");
  return Boolean(origin && new URL(request.url).origin === origin && request.headers.get("Origin") === origin
    && csrf && RANDOM.test(csrf) && await equalSecret(csrf, session.csrfToken));
}

export async function authenticateAccountToken(request: Request, env: AccountEnvironment, scope: "read" | "write"): Promise<AccountTokenIdentity | null> {
  const origin = fixedOrigin(env);
  if (!origin || new URL(request.url).origin !== origin) return null;
  const authorization = request.headers.get("Authorization") ?? "";
  const match = /^Bearer (isobot_pat_[A-Za-z0-9_-]{43})$/i.exec(authorization);
  if (!match) return null;
  const identity = await env.AccountAuth.getByName("accounts").validateApiToken({ credential: match[1], scope });
  return identity && allowedIds(env)?.has(identity.account.githubId) ? identity : null;
}

type OAuthPhase = "flow_create" | "flow_consume" | "token_exchange" | "identity_lookup" | "account_write" | "session_write" | "native_code_write";
class OAuthFailure extends Error {
  constructor(readonly phase: OAuthPhase, readonly reason: string, readonly status?: number) { super("GitHub OAuth failed"); }
}

async function upstreamJson(response: Response, limit: number, phase: OAuthPhase): Promise<Record<string, unknown>> {
  if (!response.ok || !response.body) throw new OAuthFailure(phase, "http_error", response.status);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0, finished = false;
  try {
    while (true) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try { result = await reader.read(); } catch { throw new OAuthFailure(phase, "response_read_error", response.status); }
      const { value, done } = result;
      if (done) { finished = true; break; }
      length += value.byteLength;
      if (length > limit) throw new OAuthFailure(phase, "response_too_large", response.status);
      chunks.push(value);
    }
  } finally {
    if (!finished) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let body: unknown;
  try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new OAuthFailure(phase, "invalid_json", response.status); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new OAuthFailure(phase, "invalid_response", response.status);
  return body as Record<string, unknown>;
}

async function githubIdentity(code: string, verifier: string, env: AccountEnvironment, fetcher: typeof fetch): Promise<{ githubId: string; login: string; name?: string; avatarUrl?: string }> {
  const body = new URLSearchParams({
    client_id: env.GITHUB_OAUTH_CLIENT_ID!, client_secret: env.GITHUB_OAUTH_CLIENT_SECRET!, code,
    redirect_uri: `${fixedOrigin(env)}/auth/github/callback`, code_verifier: verifier,
  });
  // GitHub's access token is used only for this identity lookup; it never crosses an RPC or enters storage/logs.
  const githubJson = async (url: string, init: RequestInit, phase: OAuthPhase) => {
    let response: Response;
    try { response = await fetcher(url, init); }
    catch (error) {
      const reason = error instanceof TypeError && error.message === "Illegal invocation" ? "invalid_fetch_receiver"
        : error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError") ? "fetch_timeout" : "fetch_error";
      throw new OAuthFailure(phase, reason);
    }
    return upstreamJson(response, 65_536, phase);
  };
  const exchanged = await githubJson("https://github.com/login/oauth/access_token", {
    method: "POST", body, headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "isobot-pi" },
    redirect: "manual", signal: AbortSignal.timeout(10_000),
  }, "token_exchange");
  if (typeof exchanged.access_token !== "string" || !exchanged.access_token || exchanged.access_token.length > 4096
    || exchanged.error || typeof exchanged.token_type !== "string" || exchanged.token_type.toLowerCase() !== "bearer") {
    // Only known protocol codes enter diagnostics; provider messages may contain credentials.
    const knownErrors = ["incorrect_client_credentials", "redirect_uri_mismatch", "bad_verification_code", "invalid_request", "invalid_grant", "unsupported_grant_type", "code_verifier_mismatch"];
    const reason = typeof exchanged.error === "string" && knownErrors.includes(exchanged.error) ? exchanged.error : "invalid_token_response";
    throw new OAuthFailure("token_exchange", reason, 200);
  }
  const profile = await githubJson("https://api.github.com/user", {
    headers: { Authorization: `Bearer ${exchanged.access_token}`, Accept: "application/vnd.github+json", "User-Agent": "isobot-pi", "X-GitHub-Api-Version": "2022-11-28" },
    redirect: "manual", signal: AbortSignal.timeout(10_000),
  }, "identity_lookup");
  if (typeof profile.id !== "number" || !Number.isSafeInteger(profile.id) || profile.id < 1
    || typeof profile.login !== "string" || !/^[A-Za-z0-9-]{1,39}$/.test(profile.login)
    || (profile.name !== undefined && profile.name !== null && (typeof profile.name !== "string" || profile.name.length > 200))) {
    throw new OAuthFailure("identity_lookup", "invalid_profile", 200);
  }
  const avatarUrl = typeof profile.avatar_url === "string" && profile.avatar_url.length <= 2048 && profile.avatar_url.startsWith("https://")
    ? profile.avatar_url : undefined;
  return { githubId: String(profile.id), login: profile.login,
    ...(typeof profile.name === "string" ? { name: profile.name } : {}), ...(avatarUrl ? { avatarUrl } : {}) };
}

function tokenView(token: TokenRecord) {
  const timestamp = (value: number | undefined) => value === undefined ? null : new Date(value).toISOString();
  return { id: token.id, name: token.name, prefix: `${token.prefix}…${token.last4}`, scopes: token.scopes.split(" "), createdAt: timestamp(token.createdAt),
    expiresAt: timestamp(token.expiresAt), lastUsedAt: timestamp(token.lastUsedAt), revokedAt: timestamp(token.revokedAt) };
}

export async function handleAccountRequest(request: Request, env: AccountEnvironment, fetcher: typeof fetch = fetch): Promise<Response> {
  const url = new URL(request.url), path = url.pathname;
  if (path === "/auth/github/login" || path === "/auth/github/callback") {
    if (request.method !== "GET") return json({ error: "Use GET for GitHub sign in" }, 405, { Allow: "GET" });
    let native = path === "/auth/github/callback" && nativeErrorCallback(request);
    let nativeCodeChallenge: string | undefined;
    if (path === "/auth/github/login") {
      const client = url.searchParams.get("client"), challenge = url.searchParams.get("code_challenge");
      if (url.searchParams.getAll("client").length > 1 || (client !== null && client !== "ios")
        || url.searchParams.getAll("code_challenge").length > 1
        || (client === "ios" ? !challenge || !RANDOM.test(challenge) : challenge !== null)
        || (url.searchParams.has("code_challenge_method") && (url.searchParams.getAll("code_challenge_method").length !== 1
          || url.searchParams.get("code_challenge_method") !== "S256"))) {
        return json({ error: "Invalid native sign-in settings" }, 400);
      }
      native = client === "ios";
      nativeCodeChallenge = native ? challenge! : undefined;
    }
    if (!oauthConfigured(env) || url.origin !== fixedOrigin(env)) return failedLogin("not_configured", native);
    let phase: OAuthPhase = path === "/auth/github/login" ? "flow_create" : "flow_consume";
    try {
      const auth = env.AccountAuth.getByName("accounts");
      if (path === "/auth/github/login") {
        const conversation = url.searchParams.get("conversation");
        if (url.searchParams.getAll("conversation").length > 1 || (conversation !== null && !/^[A-Za-z0-9_-]{1,100}$/.test(conversation))) {
          return json({ error: "Invalid conversation" }, 400);
        }
        const state = randomCredential(), codeVerifier = randomCredential();
        const returnTo = conversation === null ? "/console" : `/console?conversation=${encodeURIComponent(conversation)}`;
        if (native && !auth.createNativeCode) return failedLogin("not_configured", true);
        await auth.createFlow({ state, codeVerifier, returnTo, expiresAt: Date.now() + 600_000,
          ...(nativeCodeChallenge ? { nativeCodeChallenge } : {}) });
        const authorize = new URL("https://github.com/login/oauth/authorize");
        const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier))));
        authorize.search = new URLSearchParams({ client_id: env.GITHUB_OAUTH_CLIENT_ID!, redirect_uri: `${fixedOrigin(env)}/auth/github/callback`,
          scope: "", state, code_challenge: challenge, code_challenge_method: "S256", allow_signup: "false" }).toString();
        const cookies = [cookie(FLOW_COOKIE, state, 600)];
        if (native) cookies.push(cookie(FLOW_CLIENT_COOKIE, "ios", 1200));
        else if ((request.headers.get("Cookie") ?? "").split(";").some(value => value.trim().startsWith(`${FLOW_CLIENT_COOKIE}=`))) {
          cookies.push(cookie(FLOW_CLIENT_COOKIE, "", 0));
        }
        return redirect(authorize.href, cookies);
      }
      const state = url.searchParams.get("state"), boundState = cookieValue(request, FLOW_COOKIE);
      if (!state || !RANDOM.test(state) || !boundState || url.searchParams.getAll("state").length !== 1 || !await equalSecret(state, boundState)) {
        return failedLogin("invalid_state", native);
      }
      const flow = await auth.consumeFlow({ state });
      if (flow) native = flow.nativeCodeChallenge !== undefined;
      if (!flow || flow.expiresAt <= Date.now()) return failedLogin("invalid_state", native);
      if (url.searchParams.has("error")) return failedLogin("denied", native);
      const code = url.searchParams.get("code");
      if (!code || code.length > 1024 || url.searchParams.getAll("code").length !== 1) return failedLogin("login_failed", native);
      const identity = await githubIdentity(code, flow.codeVerifier, env, fetcher);
      if (!allowedIds(env)!.has(identity.githubId)) return failedLogin("not_allowed", native);
      phase = "account_write";
      const account = await auth.upsertAccount(identity);
      if (native) {
        phase = "native_code_write";
        if (!auth.createNativeCode || !flow.nativeCodeChallenge || !RANDOM.test(flow.nativeCodeChallenge)) throw new Error("Native sign-in unavailable");
        const nativeCode = randomCredential();
        await auth.createNativeCode({ code: nativeCode, accountId: account.accountId, codeChallenge: flow.nativeCodeChallenge,
          expiresAt: Date.now() + NATIVE_CODE_SECONDS * 1000 });
        return redirect(`${NATIVE_CALLBACK}?code=${nativeCode}`, [cookie(FLOW_COOKIE, "", 0), cookie(FLOW_CLIENT_COOKIE, "", 0)]);
      }
      const credential = randomCredential(), csrfToken = randomCredential();
      phase = "session_write";
      await auth.createSession({ accountId: account.accountId, credential, csrfToken, expiresAt: Date.now() + SESSION_SECONDS * 1000 });
      // Return paths are generated at login and checked again before redirecting.
      const returnTo = /^\/console(?:\?conversation=[A-Za-z0-9_-]{1,100})?$/.test(flow.returnTo) ? flow.returnTo : "/console";
      return redirect(returnTo, [cookie(FLOW_COOKIE, "", 0), cookie(FLOW_CLIENT_COOKIE, "", 0), cookie(SESSION_COOKIE, credential, SESSION_SECONDS)]);
    } catch (error) {
      console.warn(JSON.stringify({ event: "github_oauth_failed", phase: error instanceof OAuthFailure ? error.phase : phase,
        reason: error instanceof OAuthFailure ? error.reason : "internal_error",
        ...(error instanceof OAuthFailure && error.status !== undefined ? { status: error.status } : {}) }));
      return failedLogin("login_failed", native);
    }
  }
  if (path === "/api/auth/native/exchange") {
    if (request.method !== "POST") return json({ error: "Use POST to exchange native authorization codes" }, 405, { Allow: "POST" });
    const origin = fixedOrigin(env);
    if (!origin || url.origin !== origin || request.headers.get("Origin") !== origin || request.headers.has("Authorization")) {
      return json({ error: "Invalid request origin" }, 403);
    }
    if ((request.headers.get("Content-Type") ?? "").split(";", 1)[0].trim().toLowerCase() !== "application/json") {
      return json({ error: "Use an application/json request body" }, 415);
    }
    let value: unknown;
    try { value = await readJson(request, 4096); } catch { return json({ error: "Invalid JSON request body" }, 400); }
    if (!value || typeof value !== "object" || Array.isArray(value)) return json({ error: "Invalid native authorization code" }, 400);
    const input = value as Record<string, unknown>;
    if (typeof input.code !== "string" || !RANDOM.test(input.code)
      || typeof input.codeVerifier !== "string" || !/^[A-Za-z0-9._~-]{43,128}$/.test(input.codeVerifier)) {
      return json({ error: "Invalid native authorization code" }, 400);
    }
    try {
      const auth = env.AccountAuth.getByName("accounts");
      if (!oauthConfigured(env) || !auth.consumeNativeCode) return json({ error: "Native sign-in is unavailable" }, 503);
      const account = await auth.consumeNativeCode({ code: input.code, codeVerifier: input.codeVerifier });
      if (!account || !allowedIds(env)!.has(account.githubId)) return json({ error: "Native authorization code is invalid or expired" }, 401);
      const credential = randomCredential(), csrfToken = randomCredential(), expiresAt = Date.now() + SESSION_SECONDS * 1000;
      await auth.createSession({ accountId: account.accountId, credential, csrfToken, expiresAt });
      return json({ credential, csrfToken, user: { id: account.githubId, login: account.login, name: account.name ?? null },
        expiresAt: new Date(expiresAt).toISOString() });
    } catch { return json({ error: "Session service is unavailable" }, 503); }
  }
  if (path === "/api/auth/session") {
    if (request.method !== "GET") return json({ error: "Use GET to view the session" }, 405, { Allow: "GET" });
    try {
      const session = await resolveAccountSession(request, env);
      if (!session) return json({ authenticated: false, oauthConfigured: oauthConfigured(env) });
      return json({ authenticated: true, user: { id: session.account.githubId, login: session.account.login, name: session.account.name ?? null }, csrfToken: session.csrfToken });
    } catch { return json({ error: "Session service is unavailable" }, 503); }
  }
  try {
    const session = await resolveAccountSession(request, env);
    if (!session) return json({ error: "Sign in with GitHub to manage your account" }, 401);
    const auth = env.AccountAuth.getByName("accounts");
    if (path === "/api/auth/tokens" && request.method === "GET") {
      return json({ tokens: (await auth.listApiTokens({ accountId: session.account.accountId })).map(tokenView) });
    }
    const allowed = path === "/auth/logout" || path === "/api/auth/tokens" ? "POST" : "DELETE";
    if (request.method !== allowed) return json({ error: "Method not allowed" }, 405, { Allow: path === "/api/auth/tokens" ? "GET, POST" : allowed });
    if (!await checkSessionMutation(request, env, session)) return json({ error: "Invalid request origin or CSRF token" }, 403);
    if (path === "/auth/logout") {
      await auth.revokeSession({ credential: cookieValue(request, SESSION_COOKIE)! });
      return json({ authenticated: false }, 200, { "Set-Cookie": cookie(SESSION_COOKIE, "", 0) });
    }
    if (path === "/api/auth/tokens") {
      let value: unknown;
      try { value = await readJson(request, 8192); } catch { return json({ error: "Invalid JSON request body" }, 400); }
      if (!value || typeof value !== "object" || Array.isArray(value)) return json({ error: "Invalid token settings" }, 400);
      const input = value as Record<string, unknown>;
      const expiry = input.expiresInDays === undefined ? 90 : input.expiresInDays;
      if (typeof input.name !== "string" || !input.name.trim() || input.name.trim().length > 80
        || !Array.isArray(input.scopes) || input.scopes.length < 1 || input.scopes.length > 2
        || !input.scopes.includes("read") || input.scopes.some(scope => scope !== "read" && scope !== "write")
        || new Set(input.scopes).size !== input.scopes.length || ![30, 90, 365, null].includes(expiry as number | null)) {
        return json({ error: "Provide a name (1–80 characters), read or read/write scopes, and expiry of 30, 90, 365 days or null" }, 400);
      }
      const credential = `isobot_pat_${randomCredential()}`;
      const record = await auth.createApiToken({ accountId: session.account.accountId, credential, name: input.name.trim(),
        scopes: input.scopes.includes("write") ? "read write" : "read", ...(expiry === null ? {} : { expiresAt: Date.now() + Number(expiry) * DAY }) });
      if (!record) return json({ error: "Revoke an existing token before creating another (limit: 50 active tokens)" }, 409);
      return json({ token: credential, ...tokenView(record) }, 201);
    }
    const tokenId = path.slice("/api/auth/tokens/".length);
    if (!path.startsWith("/api/auth/tokens/") || !UUID.test(tokenId)) return json({ error: "Invalid token id" }, 400);
    if (!await auth.revokeApiToken({ accountId: session.account.accountId, tokenId })) return json({ error: "Token not found" }, 404);
    return json({ id: tokenId, revoked: true });
  } catch {
    return json({ error: "Account service could not complete the request" }, 503);
  }
}
