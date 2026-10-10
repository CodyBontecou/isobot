import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions, type V4MiniflareOptions } from "miniflare";
import {
  ChatGPTAuthController, ChatGPTAuthError, validateChatGPTCredential,
  type ChatGPTAuthState, type ChatGPTAuthStorage, type ChatGPTCredential,
} from "./chatgpt-auth-store.js";

const RESOURCE = "https://api.openai.com/v1";
const SCOPES = ["openid", "profile", "email", "offline_access", "resource.invoke", "chatgpt.tokens.use.direct"];
const NOW = 1_790_000_000_000;
function credential(now = NOW, clientId = "test-client"): ChatGPTCredential {
  const claims = {
    iss: "https://auth.openai.com", aud: RESOURCE, client_id: clientId,
    scope: SCOPES.join(" "), exp: Math.floor((now + 3_600_000) / 1000), sub: "test-account",
  };
  const access = `test-header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.test-signature`;
  return { type: "oauth", access, refresh: "test-refresh-token-original", expires: claims.exp * 1000, clientId, scopes: [...SCOPES] };
}

class MemoryStorage implements ChatGPTAuthStorage {
  state?: ChatGPTAuthState;
  failReplacement = false;
  async read() { return this.state ? structuredClone(this.state) : undefined; }
  async write(state: ChatGPTAuthState) {
    if (this.failReplacement && this.state?.reconnectReason === "refresh_pending" && state.reconnectReason === null) throw new Error("simulated disk failure");
    this.state = structuredClone(state);
  }
}
function models() {
  return Response.json({ models: [
    { slug: "gpt-6.1-sol", display_name: "GPT-6.1 Sol", visibility: "list" },
    { slug: "hidden-test", display_name: "Hidden", visibility: "hidden" },
    { slug: "gpt-6-sol", display_name: "GPT-6 Sol", visibility: "list" },
  ] });
}
function stream(events: unknown[], chunkWidth = 17): Response {
  const text = events.map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join("");
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += chunkWidth) controller.enqueue(bytes.slice(offset, offset + chunkWidth));
      controller.close();
    },
  }), { headers: { "Content-Type": "text/event-stream" } });
}
function completed() { return stream([{ type: "response.created", response: { status: "in_progress" } }, { type: "response.completed", response: { status: "completed" } }]); }
function failure(code: string) {
  return (error: unknown) => error instanceof ChatGPTAuthError && error.code === code
    && !error.message.includes("test-refresh") && !error.message.includes("test-signature");
}

test("credential import verifies canonical direct-token claims and returns only safe metadata", async () => {
  let requests = 0;
  const storage = new MemoryStorage();
  const auth = new ChatGPTAuthController(storage, async () => { requests++; return models(); }, () => NOW);
  assert.deepEqual(await auth.status(), { connected: false, reconnectRequired: false, expiresAt: null, models: [], selectedModel: null, revision: 0 });
  const original = credential();
  const status = await auth.connect(original);
  assert.equal(requests, 1);
  assert.deepEqual(status, {
    connected: true, reconnectRequired: false, expiresAt: new Date(original.expires).toISOString(),
    models: ["gpt-6.1-sol", "gpt-6-sol"], selectedModel: null, revision: 1,
  });
  assert.equal(JSON.stringify(status).includes(original.access), false);
  assert.equal(JSON.stringify(status).includes(original.refresh), false);
  assert.deepEqual(await auth.getSelection(), { model: null, revision: 1 });
  for (const invalid of [
    { ...original, type: "api_key" }, { ...original, access: "sk-test-api-key-with-no-subscription" },
    { ...original, refresh: "short" }, { ...original, expires: NOW }, { ...original, expires: Infinity },
    { ...original, clientId: "different-client" }, { ...original, clientId: "dynamic_agent_client" },
    { ...original, scopes: SCOPES.filter(scope => scope !== "chatgpt.tokens.use.direct") },
    { ...original, access: original.access.replace("test-header.", "test-header.invalid") },
  ]) assert.throws(() => validateChatGPTCredential(invalid, NOW), failure("invalid_credential"));
  assert.equal(requests, 1);
  assert.deepEqual(await auth.status(), status);
});

test("a rejected replacement connection preserves the previous connection", async () => {
  let deny = false;
  const storage = new MemoryStorage();
  const auth = new ChatGPTAuthController(storage, async () => deny ? new Response("private upstream diagnostic", { status: 401 }) : models(), () => NOW);
  const saved = await auth.connect(credential());
  deny = true;
  await assert.rejects(auth.connect(credential(NOW, "second-client")), failure("invalid_credential"));
  assert.deepEqual(await auth.status(), saved);
  assert.equal(storage.state?.credential?.clientId, "test-client");
});

test("catalog refresh uses renewed credentials and preserves the active model revision", async () => {
  const storage = new MemoryStorage();
  let now = NOW;
  let catalogs = 0;
  const auth = new ChatGPTAuthController(storage, async (url, options) => {
    if (String(url).endsWith("/responses")) return completed();
    if (String(url).endsWith("/oauth/token")) return Response.json({
      access_token: credential(now).access, refresh_token: "test-refresh-token-replacement",
      expires_in: 3600, scope: SCOPES.join(" "),
    });
    assert.equal(String(url), `${RESOURCE}/models`);
    catalogs++;
    assert.equal(new Headers(options?.headers).get("Authorization"), `Bearer ${credential(now).access}`);
    return catalogs === 1 ? Response.json({ models: [{ slug: "gpt-6-sol", visibility: "list" }] }) : models();
  }, () => now);
  await auth.connect(credential());
  const selected = await auth.selectModel("gpt-6-sol");
  now += 3_550_000;
  const refreshed = await auth.refreshCatalog();
  assert.deepEqual(refreshed.models, ["gpt-6.1-sol", "gpt-6-sol"]);
  assert.equal(refreshed.selectedModel, selected.selectedModel);
  assert.equal(refreshed.revision, selected.revision);
  assert.equal(storage.state?.credential?.refresh, "test-refresh-token-replacement");
  assert.equal(storage.state?.credential?.access, credential(now).access);
  assert.equal(refreshed.expiresAt, new Date(credential(now).expires).toISOString());
  assert.equal(refreshed.reconnectRequired, false);
  assert.equal(JSON.stringify(refreshed).includes(credential(now).access), false);
  assert.equal(JSON.stringify(refreshed).includes("test-refresh"), false);
});

test("selecting a newly listed GPT-6.1 Sol refreshes the catalog and verifies medium reasoning", async t => {
  t.mock.method(console, "warn", () => undefined);
  let catalogs = 0;
  const probes: Record<string, unknown>[] = [];
  const auth = new ChatGPTAuthController(new MemoryStorage(), async (url, options) => {
    if (String(url).endsWith("/models")) {
      catalogs++;
      return catalogs === 1 ? Response.json({ models: [{ slug: "gpt-6-sol", visibility: "list" }] }) : models();
    }
    probes.push(JSON.parse(String(options?.body)));
    return completed();
  }, () => NOW);
  await auth.connect(credential());
  await auth.selectModel("gpt-6-sol");
  const selected = await auth.selectModel("gpt-6.1-sol");
  assert.equal(catalogs, 2);
  assert.equal(selected.selectedModel, "gpt-6.1-sol");
  assert.equal(selected.revision, 3);
  assert.equal("reasoning" in probes[0], false);
  assert.deepEqual(probes[1].reasoning, { effort: "medium" });
  await assert.rejects(auth.selectModel("missing-model"), failure("model_unavailable"));
  assert.equal(catalogs, 3);
  assert.equal(probes.length, 2);
  assert.deepEqual(await auth.getSelection(), { model: "gpt-6.1-sol", revision: 3 });
});

test("explicit verification of unlisted GPT-6.1 Sol requires completed medium inference and preserves selection on denial", async t => {
  t.mock.method(console, "warn", () => undefined);
  for (const permitted of [true, false]) {
    await t.test(permitted ? "completed" : "denied", async () => {
      let catalogs = 0;
      const probes: Record<string, unknown>[] = [];
      const auth = new ChatGPTAuthController(new MemoryStorage(), async (url, options) => {
        if (String(url).endsWith("/models")) {
          catalogs++;
          return Response.json({ models: [{ slug: "gpt-6-sol", visibility: "list" }] });
        }
        const body = JSON.parse(String(options?.body));
        probes.push(body);
        if (body.model === "gpt-6.1-sol" && !permitted) return Response.json({ error: { code: "model_not_found" } }, { status: 403 });
        return completed();
      }, () => NOW);
      await auth.connect(credential());
      const prior = await auth.selectModel("gpt-6-sol");
      if (permitted) {
        const selected = await auth.selectModel("gpt-6.1-sol", true);
        assert.equal(selected.selectedModel, "gpt-6.1-sol");
        assert.equal(selected.revision, prior.revision + 1);
      } else {
        await assert.rejects(auth.selectModel("gpt-6.1-sol", true), failure("model_unavailable"));
        assert.deepEqual(await auth.status(), prior);
      }
      assert.equal(catalogs, 2);
      assert.equal(probes.length, 2);
      assert.deepEqual(probes[1].reasoning, { effort: "medium" });
      const selection = await auth.getSelection();
      await assert.rejects(auth.selectModel("unknown-model"), failure("model_unavailable"));
      assert.equal(probes.length, 2);
      assert.deepEqual(await auth.getSelection(), selection);
    });
  }
});

test("catalog failures preserve selection and expose no upstream or credential details", async t => {
  t.mock.method(console, "warn", () => undefined);
  const storage = new MemoryStorage();
  let problem: "http" | "malformed" | "empty" | null = null;
  const secret = "private-catalog-body-and-credential";
  const auth = new ChatGPTAuthController(storage, async url => {
    if (String(url).endsWith("/responses")) return completed();
    if (problem === "http") return Response.json({ error: { message: secret, token: credential().access } }, { status: 503 });
    if (problem === "malformed") return Response.json({ data: [{ id: secret }], credential: credential() });
    if (problem === "empty") return Response.json({ models: [{ slug: secret, visibility: "hidden" }] });
    return Response.json({ models: [{ slug: "gpt-6-sol", visibility: "list" }] });
  }, () => NOW);
  await auth.connect(credential());
  const selected = await auth.selectModel("gpt-6-sol");
  const saved = structuredClone(storage.state);
  for (const kind of ["http", "malformed", "empty"] as const) {
    problem = kind;
    for (const operation of [() => auth.refreshCatalog(), () => auth.selectModel("gpt-6.1-sol")]) {
      await assert.rejects(operation(), error => error instanceof ChatGPTAuthError
        && !error.message.includes(secret) && !error.message.includes(credential().access));
      assert.deepEqual(storage.state, saved);
      assert.deepEqual(await auth.status(), selected);
    }
  }
});

test("remote host identity is stable and cannot be replaced by imported laptop metadata", async () => {
  const storage = new MemoryStorage();
  const auth = new ChatGPTAuthController(storage, async url => String(url).endsWith("/models")
    ? models() : Response.json({ revocation_endpoint: "https://auth.openai.com/api/accounts/oauth/revoke" }), () => NOW);
  const hostId = await auth.getHostId();
  assert.match(hostId, /^urn:uuid:[0-9a-f-]{36}$/);
  assert.equal(await auth.getHostId(), hostId);
  const laptopCredential = { ...credential(), hostId: "urn:uuid:laptop-metadata" };
  await auth.connect(laptopCredential);
  assert.equal(await auth.getHostId(), hostId);
  await auth.disconnect();
  const reopened = new ChatGPTAuthController(storage, async () => { throw new Error("unused"); }, () => NOW);
  assert.equal(await reopened.getHostId(), hostId);
});

test("concurrent model requests redeem once and persist the replacement before exposing it", async () => {
  const storage = new MemoryStorage();
  let now = NOW;
  let refreshes = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const auth = new ChatGPTAuthController(storage, async (url, options) => {
    assert.equal(options?.redirect, "manual");
    assert.ok(options?.signal);
    if (String(url).endsWith("/models")) return models();
    refreshes++;
    assert.equal(storage.state?.reconnectReason, "refresh_pending");
    assert.equal(String(url), "https://auth.openai.com/api/accounts/oauth/token");
    const body = new URLSearchParams(String(options?.body));
    assert.equal(body.get("grant_type"), "refresh_token");
    assert.equal(body.get("client_id"), "test-client");
    assert.equal(body.get("refresh_token"), "test-refresh-token-original");
    assert.equal(body.get("resource"), RESOURCE);
    assert.equal(body.has("scope"), false);
    await gate;
    return Response.json({ access_token: credential(now).access, refresh_token: "test-refresh-token-replacement", expires_in: 3600, scope: SCOPES.join(" "), token_type: "Bearer" });
  }, () => now);
  await auth.connect(credential());
  now += 3_550_000;
  const pending = Array.from({ length: 20 }, () => auth.getAccessToken());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(refreshes, 1);
  release?.();
  const tokens = await Promise.all(pending);
  assert.equal(new Set(tokens).size, 1);
  assert.equal(storage.state?.credential?.refresh, "test-refresh-token-replacement");
  assert.equal(storage.state?.credential?.access, tokens[0]);
  assert.equal(storage.state?.reconnectReason, null);
  const reopened = new ChatGPTAuthController(storage, async () => { throw new Error("must not refresh twice"); }, () => now);
  assert.equal(await reopened.getAccessToken(), tokens[0]);
  assert.equal(refreshes, 1);
});

test("ambiguous or rejected refreshes keep their credential but never redeem the same token again", async t => {
  for (const problem of ["invalid_grant", "network", "malformed", "save_failure"]) {
    await t.test(problem, async () => {
      const storage = new MemoryStorage();
      let now = NOW;
      let attempts = 0;
      const original = credential();
      const auth = new ChatGPTAuthController(storage, async url => {
        if (String(url).endsWith("/models")) return models();
        attempts++;
        if (problem === "network") throw new Error(`upstream included ${original.refresh}`);
        if (problem === "malformed") return Response.json({ access_token: "invalid", refresh_token: original.refresh });
        if (problem === "save_failure") return Response.json({ access_token: credential(now).access, refresh_token: "test-refresh-token-replacement", expires_in: 3600, scope: SCOPES.join(" ") });
        return Response.json({ error: "invalid_grant", error_description: original.refresh }, { status: 400 });
      }, () => now);
      await auth.connect(original);
      storage.failReplacement = problem === "save_failure";
      now += 3_550_000;
      await assert.rejects(auth.getAccessToken(), failure("reconnect_required"));
      assert.equal((await auth.status()).reconnectRequired, true);
      assert.deepEqual(storage.state?.credential, original);
      const reopened = new ChatGPTAuthController(storage, async () => { attempts++; throw new Error("must not replay"); }, () => now);
      await assert.rejects(reopened.getAccessToken(), failure("reconnect_required"));
      assert.equal(attempts, 1);
    });
  }
});

test("an interrupted refresh marker survives a new controller and blocks redemption", async () => {
  const storage = new MemoryStorage();
  const original = credential();
  await storage.write({ credential: original, models: ["gpt-6.1-sol"], selectedModel: "gpt-6.1-sol", revision: 2, reconnectReason: "refresh_pending" });
  const auth = new ChatGPTAuthController(storage, async () => { throw new Error("must never be called"); }, () => NOW);
  await assert.rejects(auth.getAccessToken(), failure("reconnect_required"));
  assert.equal((await auth.status()).reconnectRequired, true);
});

test("disconnect waits for an in-flight refresh and cannot resurrect credentials afterward", async () => {
  const storage = new MemoryStorage();
  let now = NOW;
  let release: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const auth = new ChatGPTAuthController(storage, async (url, options) => {
    if (String(url).endsWith("/models")) return models();
    if (String(url).endsWith("/oauth/token")) {
      await gate;
      return Response.json({ access_token: credential(now).access, refresh_token: "test-refresh-token-replacement", expires_in: 3600, scope: SCOPES.join(" ") });
    }
    if (String(url).includes("openid-configuration")) return Response.json({ revocation_endpoint: "https://auth.openai.com/api/accounts/oauth/revoke" });
    assert.equal(new URLSearchParams(String(options?.body)).get("token"), "test-refresh-token-replacement");
    return new Response(null, { status: 200 });
  }, () => now);
  await auth.connect(credential());
  now += 3_550_000;
  const refreshing = auth.getAccessToken();
  const disconnecting = auth.disconnect();
  const nextRequest = assert.rejects(auth.getAccessToken(), failure("not_connected"));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(storage.state?.reconnectReason, "refresh_pending");
  release?.();
  await refreshing;
  assert.deepEqual(await disconnecting, { revoked: true });
  await nextRequest;
  assert.equal(storage.state?.credential, null);
  assert.equal((await auth.status()).connected, false);
});

test("refresh restrictions avoid premature redemption while a token remains usable", async () => {
  const storage = new MemoryStorage();
  let now = NOW;
  let refreshes = 0;
  const imported = { ...credential(), earliestRefreshAt: NOW + 3_590_000 };
  const auth = new ChatGPTAuthController(storage, async url => {
    if (String(url).endsWith("/models")) return models();
    refreshes++;
    const next = credential(now);
    return Response.json({ access_token: next.access, refresh_token: "test-refresh-token-replacement", expires_in: 3600, scope: SCOPES.join(" "), earliest_refresh_at: Math.floor((now + 3_540_000) / 1000) });
  }, () => now);
  await auth.connect(imported);
  now += 3_550_000;
  assert.equal(await auth.getAccessToken(), imported.access);
  assert.equal(refreshes, 0);
  now += 40_000;
  await auth.getAccessToken();
  assert.equal(refreshes, 1);
  assert.equal(storage.state?.credential?.earliestRefreshAt, now + 3_540_000);
});

test("model selection requires completed inference; partial and failed streams preserve the active selection", async () => {
  const storage = new MemoryStorage();
  let responseKind = "completed";
  const auth = new ChatGPTAuthController(storage, async (url, options) => {
    if (String(url).endsWith("/models")) return models();
    assert.equal(String(url), `${RESOURCE}/responses`);
    const body = JSON.parse(String(options?.body));
    assert.equal(body.store, false);
    assert.equal(body.stream, true);
    assert.deepEqual(body.input, [{ role: "user", content: "Reply exactly OK." }]);
    assert.equal("max_output_tokens" in body, false);
    if (responseKind === "partial") return stream([{ type: "response.output_text.delta", delta: "OK" }]);
    if (responseKind === "failed") return stream([{ type: "response.failed", response: { error: { message: credential().refresh } } }]);
    if (responseKind === "denied") return new Response("denied", { status: 403 });
    return completed();
  }, () => NOW);
  await auth.connect(credential());
  const selected = await auth.selectModel("gpt-6.1-sol");
  assert.equal(selected.selectedModel, "gpt-6.1-sol");
  assert.equal(selected.revision, 2);
  for (const kind of ["partial", "failed", "denied"]) {
    responseKind = kind;
    await assert.rejects(auth.selectModel("gpt-6-sol"), failure("model_unavailable"));
    assert.deepEqual(await auth.getSelection(), { model: "gpt-6.1-sol", revision: 2 });
  }
  await assert.rejects(auth.selectModel("unknown"), failure("model_unavailable"));
  assert.equal((await auth.useWorkersAI()).selectedModel, null);
  assert.deepEqual(await auth.getSelection(), { model: null, revision: 3 });
});

test("verification diagnostics contain only fixed phases, statuses, and allowlisted codes", async t => {
  const warnings: string[] = [];
  t.mock.method(console, "warn", (message: string) => { warnings.push(message); });
  const secret = "private-upstream-body-and-credential";
  for (const kind of ["transport", "http_known", "http_secret", "failed", "incomplete", "error"]) {
    const storage = new MemoryStorage();
    const auth = new ChatGPTAuthController(storage, async url => {
      if (String(url).endsWith("/models")) return models();
      if (kind === "transport") throw new Error(`${secret} ${credential().access}`);
      if (kind === "http_known") return Response.json({ error: { code: "unsupported_parameter", message: secret } }, { status: 400 });
      if (kind === "http_secret") return Response.json({ error: { code: secret, message: credential().refresh } }, { status: 503 });
      if (kind === "failed") return stream([{ type: "response.failed", response: { error: { code: "internal_error", message: secret } } }]);
      if (kind === "incomplete") return stream([{ type: "response.incomplete", response: { error: { code: secret, message: secret } } }]);
      return stream([{ type: "error", code: "invalid_request_error", message: secret }]);
    }, () => NOW);
    await auth.connect(credential());
    await assert.rejects(auth.selectModel("gpt-6.1-sol"), error => error instanceof ChatGPTAuthError);
    assert.deepEqual(await auth.getSelection(), { model: null, revision: 1 });
  }
  const diagnostics = warnings.map(message => JSON.parse(message));
  assert.ok(diagnostics.some(item => item.phase === "request" && item.result === "transport_error" && item.timedOut === false));
  assert.ok(diagnostics.some(item => item.result === "http_error" && item.status === 400 && item.upstreamCode === "unsupported_parameter"));
  assert.ok(diagnostics.some(item => item.result === "http_error" && item.status === 503 && item.upstreamCode === undefined));
  assert.ok(diagnostics.some(item => item.result === "failed" && item.upstreamCode === "internal_error"));
  assert.ok(diagnostics.some(item => item.result === "incomplete" && item.upstreamCode === undefined));
  assert.ok(diagnostics.some(item => item.result === "error" && item.upstreamCode === "invalid_request_error"));
  const serialized = JSON.stringify(diagnostics);
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes(credential().access), false);
  assert.equal(serialized.includes(credential().refresh), false);
  for (const diagnostic of diagnostics) {
    assert.equal(diagnostic.event, "chatgpt_model_verification");
    assert.ok(Object.keys(diagnostic).every(key => ["event", "phase", "result", "status", "upstreamCode", "timedOut", "contentType", "payloadType", "responseStatus"].includes(key)));
  }
});

test("HTTP 200 without event-stream exposes only classified media, shape, status, and known error codes", async t => {
  const warnings: string[] = [];
  t.mock.method(console, "warn", (message: string) => { warnings.push(message); });
  const secret = "never-log-this-body-or-header";
  for (const kind of ["json_error", "json_response", "plain", "secret_header"]) {
    const auth = new ChatGPTAuthController(new MemoryStorage(), async url => {
      if (String(url).endsWith("/models")) return models();
      if (kind === "json_error") return Response.json({ error: { code: "subscription_sharing_usage_unavailable", message: secret } });
      if (kind === "json_response") return Response.json({ object: "response", status: "completed", output: secret });
      if (kind === "plain") return new Response(secret, { headers: { "Content-Type": "text/plain" } });
      return new Response(JSON.stringify({ error: { code: secret }, status: secret }), { headers: { "Content-Type": secret } });
    }, () => NOW);
    await auth.connect(credential());
    await assert.rejects(auth.selectModel("gpt-6.1-sol"), failure("model_unavailable"));
  }
  const details = warnings.map(message => JSON.parse(message)).filter(item => item.result === "unexpected_content_type");
  assert.equal(details.length, 4);
  assert.deepEqual(details[0], { event: "chatgpt_model_verification", phase: "stream", result: "unexpected_content_type", contentType: "application/json", payloadType: "error", upstreamCode: "subscription_sharing_usage_unavailable" });
  assert.deepEqual(details[1], { event: "chatgpt_model_verification", phase: "stream", result: "unexpected_content_type", contentType: "application/json", payloadType: "response", responseStatus: "completed" });
  assert.equal(details[2].contentType, "text/plain");
  assert.equal(details[2].payloadType, "unreadable");
  assert.equal(details[3].contentType, "other");
  assert.equal(details[3].payloadType, "error");
  assert.equal(details[3].upstreamCode, undefined);
  assert.equal(JSON.stringify(warnings).includes(secret), false);
  assert.equal(JSON.stringify(warnings).includes(credential().access), false);
  assert.equal(JSON.stringify(warnings).includes(credential().refresh), false);
});

test("headerless completed SSE verifies a model while headerless JSON, text, and empty events cannot activate it", async t => {
  t.mock.method(console, "warn", () => undefined);
  let kind = "sse";
  const auth = new ChatGPTAuthController(new MemoryStorage(), async url => {
    if (String(url).endsWith("/models")) return models();
    if (kind === "sse") {
      const response = completed();
      response.headers.delete("Content-Type");
      return response;
    }
    const contents = kind === "json" ? JSON.stringify({ object: "response", status: "completed" })
      : kind === "plain" ? "OK" : "data: [DONE]\n\n";
    return new Response(new TextEncoder().encode(contents));
  }, () => NOW);
  await auth.connect(credential());
  const selected = await auth.selectModel("gpt-6.1-sol");
  assert.equal(selected.selectedModel, "gpt-6.1-sol");
  assert.equal(selected.revision, 2);
  for (const nonstream of ["json", "plain", "empty_events"]) {
    kind = nonstream;
    await assert.rejects(auth.selectModel("gpt-6-sol"), failure("model_unavailable"));
    assert.deepEqual(await auth.getSelection(), { model: "gpt-6.1-sol", revision: 2 });
  }
});

test("disconnect revokes the renewable session and clears local tokens even if revocation fails", async t => {
  for (const remoteWorks of [true, false]) {
    await t.test(remoteWorks ? "confirmed" : "unconfirmed", async () => {
      const storage = new MemoryStorage();
      const auth = new ChatGPTAuthController(storage, async (url, options) => {
        if (String(url).endsWith("/models")) return models();
        assert.equal(storage.state?.selectedModel, null);
        assert.equal(storage.state?.reconnectReason, "disconnect_pending");
        if (String(url).includes("openid-configuration")) return Response.json({ revocation_endpoint: "https://auth.openai.com/api/accounts/oauth/revoke" });
        const form = new URLSearchParams(String(options?.body));
        assert.equal(form.get("token"), "test-refresh-token-original");
        assert.equal(form.get("token_type_hint"), "refresh_token");
        assert.equal(form.get("client_id"), "test-client");
        return new Response(null, { status: remoteWorks ? 200 : 503 });
      }, () => NOW);
      await auth.connect(credential());
      assert.deepEqual(await auth.disconnect(), { revoked: remoteWorks });
      assert.deepEqual(await auth.status(), { connected: false, reconnectRequired: false, expiresAt: null, models: [], selectedModel: null, revision: 2 });
      assert.equal(storage.state?.credential, null);
      await assert.rejects(auth.getAccessToken(), failure("not_connected"));
    });
  }
});

test("the auth Durable Object persists selection revisions across real Workers runtime restarts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "isobot-chatgpt-auth-"));
  const bundle = join(directory, "worker.mjs");
  await build({
    stdin: {
      contents: `import { ChatGPTAuth } from './chatgpt-auth.ts';
        export { ChatGPTAuth };
        export default { async fetch(request, env) {
          const auth = env.Auth.getByName('primary');
          const path = new URL(request.url).pathname;
          if (path === '/fallback') return Response.json(await auth.useWorkersAI());
          if (path === '/disconnect') return Response.json(await auth.disconnect());
          if (path === '/host') return Response.json(await auth.getHostId());
          return Response.json(await auth.status());
        } };`,
      resolveDir: new URL(".", import.meta.url).pathname, sourcefile: "chatgpt-auth-test.ts", loader: "ts",
    },
    bundle: true, format: "esm", platform: "browser", external: ["cloudflare:workers"], outfile: bundle,
  });
  const options: V4MiniflareOptions = {
    resourcePersistencePath: join(directory, "storage"),
    workers: [{ name: "isobot-chatgpt-auth-test", modules: true, scriptPath: bundle, modulesRoot: directory,
      compatibilityDate: "2026-10-07", durableObjects: { Auth: { className: "ChatGPTAuth", useSQLite: true } } }],
  };
  let runtime = new Miniflare(convertV4MiniflareOptions(options));
  const call = async (path: string): Promise<unknown> => (await runtime.dispatchFetch(`http://test${path}`)).json();
  try {
    const hostId = await call("/host");
    await call("/fallback");
    await runtime.dispose();
    runtime = new Miniflare(convertV4MiniflareOptions(options));
    assert.deepEqual(await call("/status"), { connected: false, reconnectRequired: false, expiresAt: null, models: [], selectedModel: null, revision: 1 });
    assert.equal(await call("/host"), hostId);
    assert.deepEqual(await call("/disconnect"), { revoked: true });
    await runtime.dispose();
    runtime = new Miniflare(convertV4MiniflareOptions(options));
    assert.deepEqual(await call("/status"), { connected: false, reconnectRequired: false, expiresAt: null, models: [], selectedModel: null, revision: 2 });
    assert.equal(await call("/host"), hostId);
  } finally {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
