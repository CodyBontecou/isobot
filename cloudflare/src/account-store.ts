export type ApiTokenScope = "read" | "write";
export type ApiTokenScopes = "read" | "read write";

export interface AccountProfile {
  accountId: string;
  githubId: string;
  login: string;
  name?: string;
  avatarUrl?: string;
}
export interface AccountInput { githubId: string; login: string; name?: string; avatarUrl?: string }
export interface OAuthFlowInput { state: string; codeVerifier: string; returnTo: string; expiresAt: number; nativeCodeChallenge?: string }
export interface OAuthFlow { codeVerifier: string; returnTo: string; expiresAt: number; nativeCodeChallenge?: string }
export interface NativeCodeInput { code: string; accountId: string; codeChallenge: string; expiresAt: number }
export interface SessionInput { accountId: string; credential: string; csrfToken: string; expiresAt: number }
export interface AccountSession { account: AccountProfile; csrfToken: string; expiresAt: number }
export interface ApiTokenInput { accountId: string; credential: string; name: string; scopes: ApiTokenScopes; expiresAt?: number }
export interface ApiTokenRecord {
  id: string;
  name: string;
  scopes: ApiTokenScopes;
  prefix: string;
  last4: string;
  createdAt: number;
  lastUsedAt?: number;
  expiresAt?: number;
  revokedAt?: number;
}
export interface ValidApiToken { account: AccountProfile; token: ApiTokenRecord }

type AccountRow = { account_id: string; github_id: string; login: string; name: string | null; avatar_url: string | null };
type SessionRow = { account_id: string; csrf_token: string; expires_at: number };
type TokenRow = {
  id: string; account_id: string; name: string; scopes: ApiTokenScopes; prefix: string; last4: string;
  created_at: number; last_used_at: number | null; expires_at: number | null; revoked_at: number | null;
};

export async function hashCredential(credential: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(credential));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

function credentialValue(value: string): void {
  if (typeof value !== "string" || value.length < 32 || value.length > 200 || /\s/.test(value)) throw new TypeError("Invalid credential");
}
function validExpiry(value: number, now: number): void {
  if (!Number.isSafeInteger(value) || value <= now || value > 8.64e15) throw new RangeError("Invalid expiry");
}
function accountProfile(row: AccountRow): AccountProfile {
  return { accountId: row.account_id, githubId: row.github_id, login: row.login,
    ...(row.name === null ? {} : { name: row.name }), ...(row.avatar_url === null ? {} : { avatarUrl: row.avatar_url }) };
}
function tokenRecord(row: TokenRow): ApiTokenRecord {
  return { id: row.id, name: row.name, scopes: row.scopes, prefix: row.prefix, last4: row.last4, createdAt: row.created_at,
    ...(row.last_used_at === null ? {} : { lastUsedAt: row.last_used_at }),
    ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
    ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at }) };
}

/** Account credentials stay in a separate SQLite object, with only SHA-256 lookup hashes. */
export class AccountStore {
  private readonly sql: SqlStorage;
  constructor(private readonly storage: Pick<DurableObjectStorage, "sql" | "transactionSync">, private readonly clock: () => number = Date.now) {
    this.sql = storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS auth_accounts (
      account_id TEXT PRIMARY KEY, github_id TEXT NOT NULL UNIQUE, login TEXT NOT NULL,
      name TEXT, avatar_url TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS auth_oauth_flows (
      state_hash TEXT PRIMARY KEY, code_verifier TEXT NOT NULL, return_to TEXT NOT NULL,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
    )`);
    this.sql.exec("CREATE INDEX IF NOT EXISTS auth_oauth_flow_expiry ON auth_oauth_flows(expires_at)");
    // Separate metadata preserves existing browser flows without altering their schema.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS auth_native_oauth_flows (
      state_hash TEXT PRIMARY KEY, code_challenge TEXT NOT NULL
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS auth_native_codes (
      code_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES auth_accounts(account_id),
      code_challenge TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
    )`);
    this.sql.exec("CREATE INDEX IF NOT EXISTS auth_native_code_expiry ON auth_native_codes(expires_at)");
    this.sql.exec(`CREATE TABLE IF NOT EXISTS auth_sessions (
      credential_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES auth_accounts(account_id),
      csrf_token TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER
    )`);
    this.sql.exec("CREATE INDEX IF NOT EXISTS auth_session_expiry ON auth_sessions(expires_at)");
    this.sql.exec(`CREATE TABLE IF NOT EXISTS auth_api_tokens (
      id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES auth_accounts(account_id), credential_hash TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL, scopes TEXT NOT NULL CHECK(scopes IN ('read', 'read write')),
      prefix TEXT NOT NULL, last4 TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER,
      expires_at INTEGER, revoked_at INTEGER
    )`);
    this.sql.exec("CREATE INDEX IF NOT EXISTS auth_token_account ON auth_api_tokens(account_id, created_at)");
  }

  private requireAccount(accountId: string): AccountProfile {
    const account = this.getAccount(accountId);
    if (!account) throw new Error("Account not found");
    return account;
  }

  getAccount(accountId: string): AccountProfile | null {
    const row = this.sql.exec<AccountRow>("SELECT account_id, github_id, login, name, avatar_url FROM auth_accounts WHERE account_id = ?", accountId).toArray()[0];
    return row ? accountProfile(row) : null;
  }

  upsertAccount(input: AccountInput): AccountProfile {
    if (typeof input.githubId !== "string" || typeof input.login !== "string"
      || !/^[1-9]\d{0,31}$/.test(input.githubId) || !/^[A-Za-z0-9-]{1,100}$/.test(input.login)) throw new TypeError("Invalid GitHub account");
    if (input.name !== undefined && (typeof input.name !== "string" || input.name.length > 200)) throw new TypeError("Invalid account name");
    if (input.avatarUrl !== undefined && (typeof input.avatarUrl !== "string" || input.avatarUrl.length > 2_048 || !input.avatarUrl.startsWith("https://"))) throw new TypeError("Invalid account avatar");
    const accountId = `github:${input.githubId}`;
    const now = this.clock();
    this.sql.exec(`INSERT INTO auth_accounts(account_id, github_id, login, name, avatar_url, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET
      login = excluded.login, name = excluded.name, avatar_url = excluded.avatar_url, updated_at = excluded.updated_at`,
    accountId, input.githubId, input.login, input.name ?? null, input.avatarUrl ?? null, now, now);
    return this.requireAccount(accountId);
  }

  async createFlow(input: OAuthFlowInput): Promise<{ expiresAt: number }> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(input.state) || !/^[A-Za-z0-9._~-]{43,128}$/.test(input.codeVerifier)) throw new TypeError("Invalid OAuth flow");
    if (typeof input.returnTo !== "string" || input.returnTo.length > 2_048
      || !/^\/console(?:\?|$)/.test(input.returnTo) || input.returnTo.includes("\\")) throw new TypeError("Invalid OAuth return location");
    const now = this.clock();
    validExpiry(input.expiresAt, now);
    if (input.nativeCodeChallenge !== undefined && (typeof input.nativeCodeChallenge !== "string"
      || !/^[A-Za-z0-9_-]{43}$/.test(input.nativeCodeChallenge))) throw new TypeError("Invalid native code challenge");
    const hash = await hashCredential(input.state);
    this.storage.transactionSync(() => {
      this.cleanup();
      this.sql.exec("INSERT INTO auth_oauth_flows(state_hash, code_verifier, return_to, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
        hash, input.codeVerifier, input.returnTo, now, input.expiresAt);
      if (input.nativeCodeChallenge !== undefined) {
        this.sql.exec("INSERT INTO auth_native_oauth_flows(state_hash, code_challenge) VALUES (?, ?)", hash, input.nativeCodeChallenge);
      }
    });
    return { expiresAt: input.expiresAt };
  }

  async consumeFlow(input: { state: string }): Promise<OAuthFlow | null> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(input.state)) return null;
    const hash = await hashCredential(input.state);
    return this.storage.transactionSync(() => {
      const row = this.sql.exec<{ code_verifier: string; return_to: string; expires_at: number }>(
        "DELETE FROM auth_oauth_flows WHERE state_hash = ? RETURNING code_verifier, return_to, expires_at", hash,
      ).toArray()[0];
      const native = this.sql.exec<{ code_challenge: string }>("DELETE FROM auth_native_oauth_flows WHERE state_hash = ? RETURNING code_challenge", hash).toArray()[0];
      if (!row || row.expires_at <= this.clock()) return null;
      return { codeVerifier: row.code_verifier, returnTo: row.return_to, expiresAt: row.expires_at,
        ...(native ? { nativeCodeChallenge: native.code_challenge } : {}) };
    });
  }

  /** A callback exposes only this two-minute, PKCE-bound code, never a session secret. */
  async createNativeCode(input: NativeCodeInput): Promise<{ expiresAt: number }> {
    if (typeof input.code !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(input.code)
      || typeof input.codeChallenge !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(input.codeChallenge)) throw new TypeError("Invalid native authorization code");
    const now = this.clock();
    validExpiry(input.expiresAt, now);
    if (input.expiresAt > now + 120_000) throw new RangeError("Native authorization code expiry is too long");
    const hash = await hashCredential(input.code);
    this.storage.transactionSync(() => {
      this.requireAccount(input.accountId);
      this.cleanup();
      this.sql.exec("INSERT INTO auth_native_codes(code_hash, account_id, code_challenge, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
        hash, input.accountId, input.codeChallenge, now, input.expiresAt);
    });
    return { expiresAt: input.expiresAt };
  }

  async consumeNativeCode(input: { code: string; codeVerifier: string }): Promise<AccountProfile | null> {
    if (typeof input.code !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(input.code)
      || typeof input.codeVerifier !== "string" || !/^[A-Za-z0-9._~-]{43,128}$/.test(input.codeVerifier)) return null;
    const [hash, digest] = await Promise.all([
      hashCredential(input.code), crypto.subtle.digest("SHA-256", new TextEncoder().encode(input.codeVerifier)),
    ]);
    const challenge = btoa(String.fromCharCode(...new Uint8Array(digest))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
    return this.storage.transactionSync(() => {
      const row = this.sql.exec<{ account_id: string; code_challenge: string; expires_at: number }>(
        "SELECT account_id, code_challenge, expires_at FROM auth_native_codes WHERE code_hash = ?", hash,
      ).toArray()[0];
      if (!row) return null;
      if (row.expires_at <= this.clock()) {
        this.sql.exec("DELETE FROM auth_native_codes WHERE code_hash = ?", hash);
        return null;
      }
      if (!crypto.subtle.timingSafeEqual(new TextEncoder().encode(challenge), new TextEncoder().encode(row.code_challenge))) return null;
      const account = this.getAccount(row.account_id);
      this.sql.exec("DELETE FROM auth_native_codes WHERE code_hash = ?", hash);
      return account;
    });
  }

  async createSession(input: SessionInput): Promise<{ expiresAt: number }> {
    credentialValue(input.credential);
    credentialValue(input.csrfToken);
    const now = this.clock();
    validExpiry(input.expiresAt, now);
    const hash = await hashCredential(input.credential);
    this.storage.transactionSync(() => {
      this.requireAccount(input.accountId);
      this.cleanup();
      this.sql.exec("INSERT INTO auth_sessions(credential_hash, account_id, csrf_token, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
        hash, input.accountId, input.csrfToken, now, input.expiresAt);
    });
    return { expiresAt: input.expiresAt };
  }

  async validateSession(input: { credential: string }): Promise<AccountSession | null> {
    if (typeof input.credential !== "string" || input.credential.length < 32 || input.credential.length > 200) return null;
    const hash = await hashCredential(input.credential);
    const row = this.sql.exec<SessionRow>("SELECT account_id, csrf_token, expires_at FROM auth_sessions WHERE credential_hash = ? AND revoked_at IS NULL AND expires_at > ?",
      hash, this.clock()).toArray()[0];
    if (!row) return null;
    const account = this.getAccount(row.account_id);
    return account ? { account, csrfToken: row.csrf_token, expiresAt: row.expires_at } : null;
  }

  async revokeSession(input: { credential: string }): Promise<boolean> {
    if (typeof input.credential !== "string" || input.credential.length < 32 || input.credential.length > 200) return false;
    const hash = await hashCredential(input.credential);
    return this.sql.exec<{ credential_hash: string }>("UPDATE auth_sessions SET revoked_at = ? WHERE credential_hash = ? AND revoked_at IS NULL RETURNING credential_hash",
      this.clock(), hash).toArray().length > 0;
  }

  async createApiToken(input: ApiTokenInput): Promise<ApiTokenRecord | null> {
    credentialValue(input.credential);
    if (typeof input.name !== "string") throw new TypeError("Invalid API token name");
    const name = input.name.trim();
    if (!name || name.length > 80 || (input.scopes !== "read" && input.scopes !== "read write")) throw new TypeError("Invalid API token metadata");
    const now = this.clock();
    if (input.expiresAt !== undefined) validExpiry(input.expiresAt, now);
    const hash = await hashCredential(input.credential);
    return this.storage.transactionSync(() => {
      this.requireAccount(input.accountId);
      const active = this.sql.exec<{ count: number }>("SELECT count(*) AS count FROM auth_api_tokens WHERE account_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)",
        input.accountId, now).one().count;
      if (active >= 50) return null;
      const id = crypto.randomUUID();
      const value = input.credential.startsWith("isobot_pat_") ? input.credential.slice("isobot_pat_".length) : input.credential;
      const prefix = `isobot_pat_${value.slice(0, 6)}`;
      this.sql.exec(`INSERT INTO auth_api_tokens(id, account_id, credential_hash, name, scopes, prefix, last4, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, input.accountId, hash, name, input.scopes, prefix, value.slice(-4), now, input.expiresAt ?? null);
      return tokenRecord(this.sql.exec<TokenRow>("SELECT * FROM auth_api_tokens WHERE id = ?", id).one());
    });
  }

  async validateApiToken(input: { credential: string; scope: ApiTokenScope }): Promise<ValidApiToken | null> {
    if (typeof input.credential !== "string" || input.credential.length < 32 || input.credential.length > 200 || (input.scope !== "read" && input.scope !== "write")) return null;
    const hash = await hashCredential(input.credential);
    return this.storage.transactionSync(() => {
      const now = this.clock();
      const row = this.sql.exec<TokenRow>("SELECT * FROM auth_api_tokens WHERE credential_hash = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)", hash, now).toArray()[0];
      if (!row || (input.scope === "write" && row.scopes !== "read write")) return null;
      const account = this.getAccount(row.account_id);
      if (!account) return null;
      this.sql.exec("UPDATE auth_api_tokens SET last_used_at = ? WHERE id = ?", now, row.id);
      return { account, token: tokenRecord({ ...row, last_used_at: now }) };
    });
  }

  listApiTokens(input: { accountId: string }): ApiTokenRecord[] {
    return this.sql.exec<TokenRow>(`SELECT * FROM auth_api_tokens WHERE account_id = ?
      ORDER BY (revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)) DESC, created_at DESC, id DESC LIMIT 200`,
    input.accountId, this.clock()).toArray().map(tokenRecord);
  }

  revokeApiToken(input: { accountId: string; tokenId: string }): boolean {
    return this.sql.exec<{ id: string }>("UPDATE auth_api_tokens SET revoked_at = ? WHERE id = ? AND account_id = ? AND revoked_at IS NULL RETURNING id",
      this.clock(), input.tokenId, input.accountId).toArray().length > 0;
  }

  /** Expired flows, sessions and native handoffs leave permanent token audit records intact. */
  cleanup(): { flows: number; sessions: number } {
    const now = this.clock();
    const expiredFlows = this.sql.exec<{ state_hash: string }>("DELETE FROM auth_oauth_flows WHERE state_hash IN (SELECT state_hash FROM auth_oauth_flows WHERE expires_at <= ? LIMIT 100) RETURNING state_hash", now).toArray();
    for (const flow of expiredFlows) this.sql.exec("DELETE FROM auth_native_oauth_flows WHERE state_hash = ?", flow.state_hash);
    this.sql.exec("DELETE FROM auth_native_codes WHERE code_hash IN (SELECT code_hash FROM auth_native_codes WHERE expires_at <= ? LIMIT 100)", now);
    const sessions = this.sql.exec<{ credential_hash: string }>("DELETE FROM auth_sessions WHERE credential_hash IN (SELECT credential_hash FROM auth_sessions WHERE expires_at <= ? LIMIT 100) RETURNING credential_hash", now).toArray().length;
    return { flows: expiredFlows.length, sessions };
  }
}
