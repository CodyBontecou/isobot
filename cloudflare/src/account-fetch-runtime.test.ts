import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions, type V4MiniflareOptions } from "miniflare";

const origin = "https://isobot-pi.costream.workers.dev";
const exchangeUrl = "https://github.com/login/oauth/access_token";
const identityUrl = "https://api.github.com/user";
const clientId = "synthetic-workers-client";
const clientSecret = "synthetic-workers-secret";
const upstreamToken = "synthetic-github-access-token";

/** The callback must use workerd's fetch implementation, rather than an injected Node fetch. */
test("GitHub callback uses Workers fetch and refuses upstream redirects", async t => {
  const directory = await mkdtemp(join(tmpdir(), "isobot-account-fetch-runtime-"));
  const bundle = join(directory, "worker.mjs");
  await build({
    stdin: {
      contents: `import { handleAccountRequest } from './account-routes.ts';
        const flows = new Map();
        let accountWrites = 0, sessionWrites = 0;
        const accounts = {
          createFlow(input) { flows.set(input.state, input); return {expiresAt:input.expiresAt}; },
          consumeFlow({state}) { const flow = flows.get(state) ?? null; flows.delete(state); return flow; },
          upsertAccount(input) { accountWrites++; return {accountId:'github:'+input.githubId,...input}; },
          createSession(input) {
            if (input.accountId !== 'github:20440899' || !/^[A-Za-z0-9_-]{43}$/.test(input.credential)
              || !/^[A-Za-z0-9_-]{43}$/.test(input.csrfToken) || input.expiresAt <= Date.now()) throw new Error('Invalid test session');
            sessionWrites++; return {expiresAt:input.expiresAt};
          }
        };
        export default { async fetch(request, env) {
          const path = new URL(request.url).pathname;
          if (path === '/__test/reset') {flows.clear(); accountWrites=0; sessionWrites=0; return Response.json({reset:true});}
          if (path === '/__test/state') return Response.json({accountWrites,sessionWrites,remainingFlows:flows.size});
          return handleAccountRequest(request, {...env,AccountAuth:{getByName(name) {
            if(name !== 'accounts') throw new Error('Unexpected test object'); return accounts;
          }}});
        }};`,
      resolveDir: new URL(".", import.meta.url).pathname,
      sourcefile: "account-fetch-runtime-worker.ts", loader: "ts",
    },
    bundle: true, format: "esm", platform: "browser", outfile: bundle,
  });
  type Scenario = "success" | "exchange-redirect" | "identity-redirect";
  let scenario: Scenario = "success";
  const calls: { url: string; authorization: string | null }[] = [];
  const options: V4MiniflareOptions = { workers: [{
    name: "isobot-account-fetch-runtime", modules: true, scriptPath: bundle, modulesRoot: directory,
    compatibilityDate: "2026-10-07", compatibilityFlags: ["nodejs_compat"],
    bindings: { AUTH_ORIGIN: origin, GITHUB_OAUTH_CLIENT_ID: clientId,
      GITHUB_OAUTH_CLIENT_SECRET: clientSecret, GITHUB_OAUTH_ALLOWED_IDS: "20440899" },
    outboundService: async request => {
      calls.push({ url: request.url, authorization: request.headers.get("Authorization") });
      // Every outbound call is intercepted; this test cannot contact GitHub or a redirect destination.
      if (request.url === exchangeUrl) {
        assert.equal(request.method, "POST");
        assert.equal(request.headers.get("Authorization"), null);
        assert.equal(request.headers.get("Content-Type"), "application/x-www-form-urlencoded");
        const body = new URLSearchParams(await request.text());
        assert.equal(body.get("client_id"), clientId);
        assert.equal(body.get("client_secret"), clientSecret);
        assert.equal(body.get("code"), "synthetic-authorization-code");
        assert.equal(body.get("redirect_uri"), `${origin}/auth/github/callback`);
        assert.match(body.get("code_verifier")!, /^[A-Za-z0-9_-]{43}$/);
        if (scenario === "exchange-redirect") {
          return new Response(null, { status: 302, headers: { Location: "https://redirect.invalid/exchange" } });
        }
        return Response.json({ access_token: upstreamToken, token_type: "bearer", scope: "" });
      }
      if (request.url === identityUrl) {
        assert.equal(request.method, "GET");
        assert.equal(request.headers.get("Authorization"), `Bearer ${upstreamToken}`);
        if (scenario === "identity-redirect") {
          return new Response(null, { status: 302, headers: { Location: "https://redirect.invalid/identity" } });
        }
        return Response.json({ id: 20440899, login: "codybontecou", name: "Synthetic test user" });
      }
      return new Response(null, { status: 500 });
    },
  }] };
  const runtime = new Miniflare(convertV4MiniflareOptions(options));
  const local = (path: string, headers?: Record<string, string>) => runtime.dispatchFetch(`${origin}${path}`, { headers, redirect: "manual" });
  const callback = async () => {
    await local("/__test/reset");
    calls.length = 0;
    const login = await local("/auth/github/login?conversation=vox");
    assert.equal(login.status, 302);
    const authorize = new URL(login.headers.get("Location")!);
    assert.equal(authorize.origin, "https://github.com");
    const state = authorize.searchParams.get("state")!;
    assert.match(state, /^[A-Za-z0-9_-]{43}$/);
    return local(`/auth/github/callback?state=${state}&code=synthetic-authorization-code`, {
      Cookie: `__Host-isobot_oauth=${state}`,
    });
  };
  const saved = async () => await (await local("/__test/state")).json();
  try {
    await t.test("public-only GitHub consent creates a session and returns to Vox", async () => {
      scenario = "success";
      const response = await callback();
      assert.equal(response.status, 302);
      assert.equal(response.headers.get("Location"), "/console?conversation=vox");
      assert.match(response.headers.get("Set-Cookie")!, /__Host-isobot_session=[A-Za-z0-9_-]{43}; Max-Age=604800; Path=\/; Secure; HttpOnly; SameSite=Lax/);
      assert.deepEqual(calls, [{ url: exchangeUrl, authorization: null }, { url: identityUrl, authorization: `Bearer ${upstreamToken}` }]);
      assert.deepEqual(await saved(), { accountWrites: 1, sessionWrites: 1, remainingFlows: 0 });
    });
    for (const redirect of ["exchange-redirect", "identity-redirect"] as const) {
      await t.test(`${redirect} fails closed without forwarding credentials or creating a session`, async () => {
        scenario = redirect;
        const response = await callback();
        assert.equal(response.status, 302);
        assert.equal(response.headers.get("Location"), "/console?authError=login_failed");
        assert.doesNotMatch(response.headers.get("Set-Cookie")!, /__Host-isobot_session=/);
        assert.deepEqual(calls.map(call => call.url), redirect === "exchange-redirect" ? [exchangeUrl] : [exchangeUrl, identityUrl]);
        assert.equal(calls.some(call => new URL(call.url).origin === "https://redirect.invalid"), false);
        assert.deepEqual(await saved(), { accountWrites: 0, sessionWrites: 0, remainingFlows: 0 });
      });
    }
  } finally {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
