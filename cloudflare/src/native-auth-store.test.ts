import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions, type V4MiniflareOptions } from "miniflare";
import type { AccountProfile, OAuthFlow } from "./account-store.js";

const baseTime = 1_800_000_000_000;
const verifier = "v".repeat(43);
const challenge = (value: string) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  .then(digest => Buffer.from(digest).toString("base64url"));

test("native authorization codes persist hashed, bind PKCE and consume once in Workers SQLite", async t => {
  const directory = await mkdtemp(join(tmpdir(), "isobot-native-store-"));
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
            ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS test_clock(id INTEGER PRIMARY KEY,now INTEGER NOT NULL)');
            ctx.storage.sql.exec('INSERT OR IGNORE INTO test_clock(id,now) VALUES(1,${baseTime})');
            this.clock=ctx.storage.sql.exec('SELECT now FROM test_clock WHERE id=1').one().now;
            // This is the deployed web schema, predating the native tables.
            ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS auth_oauth_flows(state_hash TEXT PRIMARY KEY,code_verifier TEXT NOT NULL,return_to TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL)');
            this.accounts=new AccountStore(ctx.storage,()=>this.clock);
          }
          async action(input) {
            if(input.kind==='clock') {
              this.clock=input.now; this.ctx.storage.sql.exec('UPDATE test_clock SET now=? WHERE id=1',input.now);
              return {now:this.clock};
            }
            if(input.kind==='raw') return {
              flows:this.ctx.storage.sql.exec('SELECT * FROM auth_oauth_flows').toArray(),
              nativeFlows:this.ctx.storage.sql.exec('SELECT * FROM auth_native_oauth_flows').toArray(),
              codes:this.ctx.storage.sql.exec('SELECT * FROM auth_native_codes').toArray(),
              sessions:this.ctx.storage.sql.exec('SELECT * FROM auth_sessions').toArray()
            };
            return this.accounts[input.kind](input.input);
          }
        }
        export default {async fetch(request,env) {
          const input=await request.json();
          try {
            const result=input.production
              ? await env.Auth.getByName('accounts')[input.kind](input.input)
              : await env.Test.getByName('accounts').action(input);
            return Response.json(result);
          } catch(error) {return Response.json({error:error.message},{status:400});}
        }};`,
      resolveDir: new URL(".", import.meta.url).pathname, sourcefile: "native-store-worker.ts", loader: "ts",
    },
    bundle: true, format: "esm", platform: "browser", external: ["cloudflare:workers"], outfile: bundle,
  });
  const options: V4MiniflareOptions = {
    resourcePersistencePath: join(directory, "storage"),
    workers: [{ name: "isobot-native-store-test", modules: true, scriptPath: bundle, modulesRoot: directory,
      compatibilityDate: "2026-10-07",
      durableObjects: { Test: { className: "TestAccounts", useSQLite: true }, Auth: { className: "AccountAuth", useSQLite: true } },
    }],
  };
  let runtime = new Miniflare(convertV4MiniflareOptions(options));
  const response = (kind: string, input: object = {}, production = false) => runtime.dispatchFetch("http://test/accounts", {
    method: "POST", body: JSON.stringify({ kind, input, production }),
  });
  const call = async <T = unknown>(kind: string, input: object = {}, production = false): Promise<T> => {
    const result = await response(kind, input, production);
    assert.equal(result.status, 200, await result.clone().text());
    return await result.json() as T;
  };
  const clock = (now: number) => runtime.dispatchFetch("http://test/accounts", { method: "POST", body: JSON.stringify({ kind: "clock", now }) });
  const raw = () => call<{ flows: { state_hash: string }[]; nativeFlows: { state_hash: string; code_challenge: string }[];
    codes: { code_hash: string; account_id: string; code_challenge: string }[]; sessions: object[] }>("raw");
  const codeChallenge = await challenge(verifier);
  let owner: AccountProfile;
  try {
    owner = await call<AccountProfile>("upsertAccount", { githubId: "42", login: "owner" });
    await t.test("adds native metadata alongside the existing web schema and preserves web return values", async () => {
      const web = { state: "w".repeat(43), codeVerifier: verifier, returnTo: "/console?conversation=vox", expiresAt: baseTime + 1000 };
      await call("createFlow", web);
      assert.deepEqual(await call("consumeFlow", { state: web.state }), { codeVerifier: verifier, returnTo: web.returnTo, expiresAt: web.expiresAt });
      const native = { ...web, state: "n".repeat(43), nativeCodeChallenge: codeChallenge };
      await call("createFlow", native);
      const saved = await raw();
      assert.equal(saved.nativeFlows[0].code_challenge, codeChallenge);
      assert.equal(saved.nativeFlows[0].state_hash, saved.flows[0].state_hash);
      assert.equal(JSON.stringify(saved).includes(native.state), false);
      assert.deepEqual(await call<OAuthFlow>("consumeFlow", { state: native.state }), {
        codeVerifier: verifier, returnTo: native.returnTo, expiresAt: native.expiresAt, nativeCodeChallenge: codeChallenge,
      });
      assert.equal((await raw()).nativeFlows.length, 0);
      for (const invalid of ["x", "x".repeat(44), "x".repeat(42) + "+", 123, null]) {
        assert.equal((await response("createFlow", { ...native, nativeCodeChallenge: invalid })).status, 400);
      }
    });
    await t.test("stores hashes only, rejects missing owners, malformed challenges and excessive expiry", async () => {
      const code = "c".repeat(43);
      const input = { code, accountId: owner.accountId, codeChallenge, expiresAt: baseTime + 120_000 };
      await call("createNativeCode", input);
      const saved = await raw();
      assert.equal(saved.codes.length, 1);
      assert.equal(saved.codes[0].account_id, owner.accountId);
      assert.match(saved.codes[0].code_hash, /^[a-f0-9]{64}$/);
      assert.equal(JSON.stringify(saved).includes(code), false);
      assert.equal(JSON.stringify(saved).includes(verifier), false);
      assert.equal(saved.sessions.length, 0);
      for (const change of [
        { accountId: "github:999" }, { code: "bad" }, { code: "x".repeat(42) + "/" },
        { codeChallenge: "bad" }, { codeChallenge: 123 }, { expiresAt: baseTime }, { expiresAt: baseTime + 120_001 },
      ]) assert.equal((await response("createNativeCode", { ...input, ...change })).status, 400);
      assert.equal((await raw()).codes.length, 1);
    });
    await t.test("incorrect verifiers cannot consume the code and concurrent correct exchanges have one winner", async () => {
      const input = { code: "c".repeat(43), codeVerifier: verifier };
      for (const codeVerifier of ["bad", "z".repeat(43), "v".repeat(129), "v".repeat(42) + "/", 123, null]) {
        assert.equal(await call("consumeNativeCode", { ...input, codeVerifier }), null);
      }
      assert.equal((await raw()).codes.length, 1);
      const results = await Promise.all(Array.from({ length: 12 }, () => call<AccountProfile | null>("consumeNativeCode", input)));
      assert.equal(results.filter(Boolean).length, 1);
      assert.deepEqual(results.find(Boolean), owner);
      assert.equal(await call("consumeNativeCode", input), null);
      assert.equal(await call("consumeNativeCode", { code: "bad", codeVerifier: verifier }), null);
      assert.equal((await raw()).codes.length, 0);
    });
    await t.test("accepts RFC7636 verifier punctuation and inclusive length boundaries", async () => {
      for (const value of ["a".repeat(39) + "._~-", "a".repeat(124) + "._~-"]) {
        const code = value.length === 43 ? "a".repeat(43) : "b".repeat(43);
        await call("createNativeCode", { code, accountId: owner.accountId, codeChallenge: await challenge(value), expiresAt: baseTime + 1000 });
        assert.deepEqual(await call("consumeNativeCode", { code, codeVerifier: value }), owner);
      }
    });
    await t.test("expiry takes effect at the boundary and removes unusable codes", async () => {
      await call("createNativeCode", { code: "e".repeat(43), accountId: owner.accountId, codeChallenge, expiresAt: baseTime + 100 });
      await clock(baseTime + 100);
      assert.equal(await call("consumeNativeCode", { code: "e".repeat(43), codeVerifier: verifier }), null);
      assert.equal((await raw()).codes.length, 0);
      await clock(baseTime);
    });
    await t.test("native flow and authorization proof survive a Durable Object restart", async () => {
      await call("createFlow", { state: "r".repeat(43), codeVerifier: "g".repeat(43), returnTo: "/console", nativeCodeChallenge: codeChallenge, expiresAt: baseTime + 1000 });
      await call("createNativeCode", { code: "r".repeat(43), accountId: owner.accountId, codeChallenge, expiresAt: baseTime + 1000 });
      await runtime.dispose();
      runtime = new Miniflare(convertV4MiniflareOptions(options));
      assert.equal((await call<OAuthFlow>("consumeFlow", { state: "r".repeat(43) })).nativeCodeChallenge, codeChallenge);
      assert.deepEqual(await call("consumeNativeCode", { code: "r".repeat(43), codeVerifier: verifier }), owner);
      assert.equal(await call("consumeNativeCode", { code: "r".repeat(43), codeVerifier: verifier }), null);
    });
    await t.test("cleanup removes bounded expired codes and their native flow metadata", async () => {
      for (let index = 0; index < 105; index++) {
        const code = String(index).padStart(43, "x");
        await call("createNativeCode", { code, accountId: owner.accountId, codeChallenge, expiresAt: baseTime + 100 });
        await call("createFlow", { state: code, codeVerifier: verifier, returnTo: "/console", nativeCodeChallenge: codeChallenge, expiresAt: baseTime + 100 });
      }
      await clock(baseTime + 100);
      await call("cleanup");
      const first = await raw();
      assert.equal(first.codes.length, 5);
      assert.equal(first.flows.length, 5);
      assert.equal(first.nativeFlows.length, 5);
      await call("cleanup");
      const second = await raw();
      assert.equal(second.codes.length, 0);
      assert.equal(second.flows.length, 0);
      assert.equal(second.nativeFlows.length, 0);
    });
    await t.test("production AccountAuth RPC exposes the native handoff without returning credentials", async () => {
      const account = await call<AccountProfile>("upsertAccount", { githubId: "99", login: "production" }, true);
      const code = "p".repeat(43);
      await call("createNativeCode", { code, accountId: account.accountId, codeChallenge, expiresAt: Date.now() + 10_000 }, true);
      assert.deepEqual(await call("consumeNativeCode", { code, codeVerifier: verifier }, true), account);
      assert.equal(await call("consumeNativeCode", { code, codeVerifier: verifier }, true), null);
    });
  } finally {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
