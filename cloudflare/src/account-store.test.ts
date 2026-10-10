import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions, type V4MiniflareOptions } from "miniflare";
import type { AccountProfile, AccountSession, ApiTokenRecord, OAuthFlow, ValidApiToken } from "./account-store.js";

const baseTime = 1_800_000_000_000;
const credential = (character: string) => `isobot_pat_${character.repeat(43)}`;
const csrfToken = "csrf_" + "c".repeat(43);
const sessionCredential = "session_" + "s".repeat(43);

test("account OAuth state, sessions and scoped tokens persist securely in Workers SQLite", async t => {
  const directory = await mkdtemp(join(tmpdir(), "isobot-accounts-"));
  const bundle = join(directory, "worker.mjs");
  await build({
    stdin: {
      contents: `import { DurableObject } from 'cloudflare:workers';
        import { AccountStore } from './account-store.ts';
        import { AccountAuth } from './account-auth.ts';
        export { AccountAuth };
        export class TestAccounts extends DurableObject {
          constructor(ctx, env) {
            super(ctx, env);
            ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS test_clock (id INTEGER PRIMARY KEY, now INTEGER NOT NULL)');
            ctx.storage.sql.exec('INSERT OR IGNORE INTO test_clock(id,now) VALUES (1,${baseTime})');
            this.clock = ctx.storage.sql.exec('SELECT now FROM test_clock WHERE id=1').one().now;
            this.accounts = new AccountStore(ctx.storage, () => this.clock);
          }
          async action(input) {
            if (input.kind === 'clock') {
              this.clock = input.now;
              this.ctx.storage.sql.exec('UPDATE test_clock SET now = ? WHERE id = 1', input.now);
              return { now: this.clock };
            }
            if (input.kind === 'raw') return {
              accounts: this.ctx.storage.sql.exec('SELECT * FROM auth_accounts').toArray(),
              flows: this.ctx.storage.sql.exec('SELECT * FROM auth_oauth_flows').toArray(),
              sessions: this.ctx.storage.sql.exec('SELECT * FROM auth_sessions').toArray(),
              tokens: this.ctx.storage.sql.exec('SELECT * FROM auth_api_tokens').toArray(),
            };
            if (input.kind === 'getAccount') return this.accounts.getAccount(input.input.accountId);
            return this.accounts[input.kind](input.input);
          }
        }
        export default { async fetch(request, env) {
          const input = await request.json();
          try {
            const result = input.production
              ? await env.Auth.getByName('accounts')[input.kind](input.input)
              : await env.Test.getByName('accounts').action(input);
            return Response.json(result);
          } catch (error) { return Response.json({ error: error.message }, { status: 400 }); }
        } };`,
      resolveDir: new URL(".", import.meta.url).pathname,
      sourcefile: "account-store-worker.ts", loader: "ts",
    },
    bundle: true, format: "esm", platform: "browser", external: ["cloudflare:workers"], outfile: bundle,
  });
  const options: V4MiniflareOptions = {
    resourcePersistencePath: join(directory, "storage"),
    workers: [{
      name: "isobot-account-test", modules: true, scriptPath: bundle, modulesRoot: directory,
      compatibilityDate: "2026-10-07",
      durableObjects: { Test: { className: "TestAccounts", useSQLite: true }, Auth: { className: "AccountAuth", useSQLite: true } },
    }],
  };
  let runtime = new Miniflare(convertV4MiniflareOptions(options));
  const response = (kind: string, input: object = {}, production = false) => runtime.dispatchFetch("http://test/accounts", {
    method: "POST", body: JSON.stringify({ kind, input, production }),
  });
  const call = async <T>(kind: string, input: object = {}, production = false): Promise<T> => {
    const result = await response(kind, input, production);
    assert.equal(result.status, 200);
    return await result.json() as T;
  };
  const clock = async (now: number) => {
    const result = await runtime.dispatchFetch("http://test/accounts", { method: "POST", body: JSON.stringify({ kind: "clock", now }) });
    assert.equal(result.status, 200);
  };
  const createToken = (accountId: string, token: string, name = "Vox", scopes: "read" | "read write" = "read write", expiresAt?: number) =>
    call<ApiTokenRecord | null>("createApiToken", { accountId, credential: token, name, scopes, ...(expiresAt === undefined ? {} : { expiresAt }) });
  const validate = (token: string, scope: "read" | "write" = "read") => call<ValidApiToken | null>("validateApiToken", { credential: token, scope });
  let owner: AccountProfile;
  let other: AccountProfile;
  let longToken: ApiTokenRecord;
  try {
    await t.test("updates stable GitHub account identity and returns public profile fields", async () => {
      owner = await call<AccountProfile>("upsertAccount", { githubId: "123", login: "owner", name: "Owner", avatarUrl: "https://avatars.githubusercontent.com/u/123" });
      assert.deepEqual(owner, { accountId: "github:123", githubId: "123", login: "owner", name: "Owner", avatarUrl: "https://avatars.githubusercontent.com/u/123" });
      other = await call<AccountProfile>("upsertAccount", { githubId: "456", login: "other" });
      const updated = await call<AccountProfile>("upsertAccount", { githubId: "123", login: "renamed", name: "Owner" });
      assert.equal(updated.accountId, owner.accountId);
      assert.equal(updated.login, "renamed");
      assert.equal(await call("getAccount", { accountId: "github:999" }), null);
    });

    await t.test("stores only state hashes and atomically consumes each live OAuth flow once", async () => {
      const state = "a".repeat(43);
      const verifier = "v".repeat(43);
      await call("createFlow", { state, codeVerifier: verifier, returnTo: "/console?conversation=vox", expiresAt: baseTime + 1_000 });
      const raw = await call<{ flows: { state_hash: string }[] }>("raw");
      assert.equal(raw.flows.length, 1);
      assert.match(raw.flows[0].state_hash, /^[a-f0-9]{64}$/);
      assert.equal(JSON.stringify(raw).includes(state), false);
      const concurrent = await Promise.all(Array.from({ length: 6 }, () => call<OAuthFlow | null>("consumeFlow", { state })));
      assert.equal(concurrent.filter(Boolean).length, 1);
      assert.deepEqual(concurrent.find(Boolean), { codeVerifier: verifier, returnTo: "/console?conversation=vox", expiresAt: baseTime + 1_000 });
      assert.equal(await call("consumeFlow", { state }), null);
      assert.equal(await call("consumeFlow", { state: "bad" }), null);
      await call("createFlow", { state: "b".repeat(43), codeVerifier: verifier, returnTo: "/console", expiresAt: baseTime + 100 });
      await clock(baseTime + 100);
      assert.equal(await call("consumeFlow", { state: "b".repeat(43) }), null);
      await clock(baseTime);
    });

    await t.test("hashes session and API credentials, preserves scopes and enforces ownership", async () => {
      await call("createSession", { accountId: owner.accountId, credential: sessionCredential, csrfToken, expiresAt: baseTime + 10_000 });
      const session = await call<AccountSession | null>("validateSession", { credential: sessionCredential });
      assert.ok(session);
      assert.equal(session.account.accountId, owner.accountId);
      assert.equal(session.csrfToken, csrfToken);
      assert.equal(await call("validateSession", { credential: sessionCredential + "wrong" }), null);
      const created = await createToken(owner.accountId, credential("L"), "  Long lived Vox  ");
      assert.ok(created);
      longToken = created;
      assert.equal(created.name, "Long lived Vox");
      assert.match(created.id, /^[0-9a-f-]{36}$/);
      assert.equal(created.prefix, "isobot_pat_LLLLLL");
      assert.equal(created.last4, "LLLL");
      assert.equal(created.createdAt, baseTime);
      assert.equal(created.lastUsedAt, undefined);
      assert.equal((await validate(credential("L"), "write"))?.account.accountId, owner.accountId);
      assert.equal(await call("revokeApiToken", { accountId: other.accountId, tokenId: created.id }), false);
      assert.equal((await validate(credential("L")))?.token.id, created.id);
      assert.deepEqual(await call("listApiTokens", { accountId: other.accountId }), []);
      const readOnly = await createToken(other.accountId, credential("R"), "Read", "read");
      assert.ok(readOnly);
      assert.equal(await validate(credential("R"), "write"), null);
      assert.equal((await validate(credential("R")))?.account.accountId, other.accountId);
      const raw = JSON.stringify(await call("raw"));
      for (const value of [sessionCredential, credential("L"), credential("R")]) assert.equal(raw.includes(value), false);
      assert.equal(JSON.stringify(created).includes("credential_hash"), false);
      const missing = await response("createSession", { accountId: "github:999", credential: credential("N"), csrfToken, expiresAt: baseTime + 1_000 });
      assert.equal(missing.status, 400);
      assert.equal((await response("createApiToken", { accountId: "github:999", credential: credential("N"), name: "No owner", scopes: "read" })).status, 400);
    });

    await t.test("retains OAuth flows, profiles, sessions, hashes and token metadata after restart", async () => {
      await call("createFlow", { state: "p".repeat(43), codeVerifier: "q".repeat(43), returnTo: "/console", expiresAt: baseTime + 1_000 });
      await runtime.dispose();
      runtime = new Miniflare(convertV4MiniflareOptions(options));
      assert.equal((await call<AccountSession | null>("validateSession", { credential: sessionCredential }))?.account.login, "renamed");
      const token = await validate(credential("L"));
      assert.ok(token);
      assert.equal(token.token.id, longToken.id);
      assert.equal(token.token.lastUsedAt, baseTime);
      assert.deepEqual(await call("consumeFlow", { state: "p".repeat(43) }), { codeVerifier: "q".repeat(43), returnTo: "/console", expiresAt: baseTime + 1_000 });
      assert.equal(await call("consumeFlow", { state: "p".repeat(43) }), null);
    });

    await t.test("expiry and revocation immediately invalidate sessions and tokens", async () => {
      const expiring = await createToken(owner.accountId, credential("E"), "Expiring", "read write", baseTime + 200);
      assert.ok(expiring);
      await clock(baseTime + 199);
      assert.ok(await validate(credential("E")));
      await clock(baseTime + 200);
      assert.equal(await validate(credential("E")), null);
      assert.equal(await call("revokeApiToken", { accountId: owner.accountId, tokenId: longToken.id }), true);
      assert.equal(await validate(credential("L")), null);
      assert.equal(await call("revokeApiToken", { accountId: owner.accountId, tokenId: longToken.id }), false);
      const tokens = await call<ApiTokenRecord[]>("listApiTokens", { accountId: owner.accountId });
      assert.equal(tokens.find(token => token.id === longToken.id)?.revokedAt, baseTime + 200);
      assert.equal(await call("revokeSession", { credential: sessionCredential }), true);
      assert.equal(await call("validateSession", { credential: sessionCredential }), null);
      assert.equal(await call("revokeSession", { credential: sessionCredential }), false);
      await call("createSession", { accountId: other.accountId, credential: credential("S"), csrfToken, expiresAt: baseTime + 300 });
      await clock(baseTime + 300);
      assert.equal(await call("validateSession", { credential: credential("S") }), null);
    });

    await t.test("concurrent token creation respects fifty active tokens and frees revoked slots", async () => {
      const capacity = await call<AccountProfile>("upsertAccount", { githubId: "789", login: "capacity" });
      const results = await Promise.all(Array.from({ length: 55 }, (_, index) =>
        createToken(capacity.accountId, `isobot_pat_${String(index).padStart(43, "0")}`, `Token ${index}`)));
      const tokens = results.filter((value): value is ApiTokenRecord => value !== null);
      assert.equal(tokens.length, 50);
      assert.equal((await call<ApiTokenRecord[]>("listApiTokens", { accountId: capacity.accountId })).length, 50);
      assert.equal(await call("revokeApiToken", { accountId: capacity.accountId, tokenId: tokens[0].id }), true);
      assert.ok(await createToken(capacity.accountId, credential("Z"), "Replacement"));
      assert.equal(await createToken(capacity.accountId, credential("Y"), "Overflow"), null);
      assert.equal(await call("revokeApiToken", { accountId: capacity.accountId, tokenId: tokens[1].id }), true);
      assert.ok(await createToken(capacity.accountId, credential("T"), "Temporary", "read write", baseTime + 400));
      await clock(baseTime + 400);
      assert.equal(await validate(credential("T")), null);
      assert.ok(await createToken(capacity.accountId, credential("F"), "Expired slot replacement"));
      await clock(baseTime + 300);
    });

    await t.test("cleanup removes at most one hundred expired flows and sessions per pass", async () => {
      const account = await call<AccountProfile>("upsertAccount", { githubId: "890", login: "cleanup" });
      for (let index = 0; index < 105; index++) {
        const value = String(index).padStart(43, "c");
        await call("createFlow", { state: value, codeVerifier: "v".repeat(43), returnTo: "/console", expiresAt: baseTime + 500 });
        await call("createSession", { accountId: account.accountId, credential: `session_${value}`, csrfToken, expiresAt: baseTime + 500 });
      }
      await clock(baseTime + 500);
      const first = await call<{ flows: number; sessions: number }>("cleanup");
      assert.equal(first.flows, 100);
      assert.equal(first.sessions, 100);
      const second = await call<{ flows: number; sessions: number }>("cleanup");
      assert.equal(second.flows, 5);
      assert.equal(second.sessions, 5);
      assert.deepEqual(await call("cleanup"), { flows: 0, sessions: 0 });
    });

    await t.test("production AccountAuth wrapper exposes RPC-safe persisted metadata", async () => {
      const account = await call<AccountProfile>("upsertAccount", { githubId: "321", login: "production" }, true);
      const token = await call<ApiTokenRecord>("createApiToken", { accountId: account.accountId, credential: credential("P"), name: "Vox", scopes: "read write" }, true);
      assert.equal((await call<ValidApiToken>("validateApiToken", { credential: credential("P"), scope: "write" }, true)).token.id, token.id);
      assert.deepEqual(await call("getAccount", { accountId: account.accountId }, true), account);
      assert.equal(await call("revokeApiToken", { accountId: account.accountId, tokenId: token.id }, true), true);
      assert.equal(await call("validateApiToken", { credential: credential("P"), scope: "read" }, true), null);
    });
  } finally {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
