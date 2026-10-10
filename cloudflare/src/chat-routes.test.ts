import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions, type V4MiniflareOptions } from "miniflare";

// Real Durable Object SQLite and RPC validate admission recovery; the fake harness never runs AI.
test("chat admits durable work promptly, isolates conversations, and recovers retries and cancellation", async t => {
  const directory = await mkdtemp(join(tmpdir(), "isobot-chat-"));
  const bundle = join(directory, "worker.mjs");
  await build({
    stdin: {
      contents: `import { DurableObject } from 'cloudflare:workers';
        import { handleChatRequest, submitChatOperation, chatOperationStatus, abortChatOperation } from './chat-routes.ts';
        export class ChatFixture extends DurableObject {
          constructor(ctx, env) {
            super(ctx, env); this.sql = ctx.storage.sql;
            this.sql.exec('CREATE TABLE IF NOT EXISTS fixture_operations (id TEXT PRIMARY KEY, prompt TEXT, status TEXT, text TEXT, reason TEXT)');
            this.sql.exec('CREATE TABLE IF NOT EXISTS fixture_counts (name TEXT PRIMARY KEY, count INTEGER)');
            this.harness = {
              submit: async (prompt, options) => {
                this.count('submit');
                if (options.operationId === 'interrupted' && !this.counter('interrupted')) {
                  this.count('interrupted'); throw new Error('Interrupted before durable admission');
                }
                const exists = this.sql.exec('SELECT id FROM fixture_operations WHERE id = ?', options.operationId).toArray().length > 0;
                this.sql.exec('INSERT OR IGNORE INTO fixture_operations VALUES (?, ?, ?, ?, ?)', options.operationId, prompt, 'queued', '', null);
                return { operationId: options.operationId, accepted: !exists, session: '1' };
              },
              pending: async () => this.sql.exec("SELECT id AS operationId, status FROM fixture_operations WHERE status IN ('queued', 'running')").toArray().map(row => ({ ...row, session: '1' })),
              wait: async id => {
                this.count('wait');
                const row = this.sql.exec('SELECT * FROM fixture_operations WHERE id = ?', id).toArray()[0];
                if (!row || !['done', 'unanswered'].includes(row.status)) throw new Error('Status attempted to wait for unknown or pending inference');
                return { operationId: id, session: '1', status: row.status, text: row.text, reason: row.reason ?? undefined };
              },
              abort: async options => {
                this.count('abort');
                const row = this.sql.exec('SELECT status FROM fixture_operations WHERE id = ?', options.operationId).toArray()[0];
                if (!row || !['queued', 'running'].includes(row.status)) return false;
                if (options.operationId === 'cancel-delayed') return true;
                this.sql.exec("UPDATE fixture_operations SET status = 'unanswered', reason = 'aborted' WHERE id = ?", options.operationId);
                return true;
              },
            };
          }
          count(name) { this.sql.exec('INSERT INTO fixture_counts VALUES (?, 1) ON CONFLICT(name) DO UPDATE SET count = count + 1', name); }
          counter(name) { return this.sql.exec('SELECT count FROM fixture_counts WHERE name = ?', name).toArray()[0]?.count ?? 0; }
          sync = async () => { this.count('sync'); };
          submitChat(prompt, id) { return submitChatOperation(this.sql, this.harness, this.sync, prompt, id); }
          chatStatus(id) { return chatOperationStatus(this.sql, this.harness, this.sync, id); }
          cancelChat(id) { return abortChatOperation(this.sql, this.harness, this.sync, id); }
          fixture(input) {
            if (input.status) this.sql.exec('UPDATE fixture_operations SET status = ?, text = ?, reason = ? WHERE id = ?', input.status, input.text ?? '', input.reason ?? null, input.id);
            return { operations: this.sql.exec('SELECT * FROM fixture_operations ORDER BY id').toArray(), counts: Object.fromEntries(this.sql.exec('SELECT * FROM fixture_counts').toArray().map(row => [row.name, row.count])) };
          }
        }
        export default { async fetch(request, env) {
          const url = new URL(request.url);
          if (url.pathname === '/__fixture') return Response.json(await env.Assistant.getByName('http:' + (url.searchParams.get('conversation') ?? 'vox')).fixture(await request.json()));
          let lookups = 0;
          const bindings = { Assistant: { getByName(name) { lookups++; return env.Assistant.getByName(name); } } };
          try {
            const response = await handleChatRequest(request, bindings);
            const headers = new Headers(response.headers); headers.set('X-Test-Lookups', String(lookups));
            return new Response(response.body, { status: response.status, headers });
          } catch { return Response.json({ error: 'Test admission interrupted' }, { status: 500 }); }
        } };`,
      resolveDir: new URL(".", import.meta.url).pathname,
      sourcefile: "chat-test.ts", loader: "ts",
    },
    bundle: true, format: "esm", platform: "browser", external: ["cloudflare:workers"], outfile: bundle,
  });
  const options: V4MiniflareOptions = {
    resourcePersistencePath: join(directory, "storage"),
    workers: [{
      name: "isobot-chat-test", modules: true, scriptPath: bundle, modulesRoot: directory,
      compatibilityDate: "2026-10-07", durableObjects: { Assistant: { className: "ChatFixture", useSQLite: true } },
    }],
  };
  let runtime = new Miniflare(convertV4MiniflareOptions(options));
  const request = (path: string, method = "GET", body?: unknown, rawBody?: string) => runtime.dispatchFetch(`https://test${path}`, {
    method, headers: { "Content-Type": "application/json" }, body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const send = (id: string, prompt = "Hello Pi", conversation?: string) => request("/api/chat", "POST", { prompt, requestId: id, ...(conversation ? { conversation } : {}) });
  const fixture = async (input: object = {}, conversation = "vox") => (await request(`/__fixture?conversation=${conversation}`, "POST", input)).json() as Promise<{
    operations: { id: string; prompt: string; status: string }[]; counts: Record<string, number>;
  }>;
  try {
    await t.test("invalid input and unsupported methods cannot reach the agent", async () => {
      for (const body of [{ prompt: " " }, { prompt: "x".repeat(16_001) }, { prompt: "Hi", conversation: "../other" }, { prompt: "Hi", requestId: "a/b" }]) {
        const response = await request("/api/chat", "POST", body);
        assert.equal(response.status, 400); assert.equal(response.headers.get("X-Test-Lookups"), "0");
      }
      for (const rawBody of ["{", "x".repeat(256_001)]) assert.equal((await request("/api/chat", "POST", undefined, rawBody)).status, 400);
      assert.equal((await request("/api/chat", "POST")).status, 400);
      for (const path of ["/api/chat/id?conversation=one&conversation=two", "/api/chat/id?conversation=../other"]) {
        const response = await request(path); assert.equal(response.status, 400); assert.equal(response.headers.get("X-Test-Lookups"), "0");
      }
      const wrongMethod = await request("/api/chat/id", "PUT");
      assert.equal(wrongMethod.status, 405); assert.equal(wrongMethod.headers.get("Allow"), "GET, DELETE");
      assert.equal((await request("/api/chat/invalid/id")).status, 404);
    });
    await t.test("submission returns a durable receipt without waiting for inference", async () => {
      const response = await send("stable"); assert.equal(response.status, 202); assert.equal(response.headers.get("Cache-Control"), "no-store");
      assert.deepEqual(await response.json(), { conversation: "vox", requestId: "stable", operationId: "stable", accepted: true, status: "queued", statusUrl: "https://test/api/chat/stable?conversation=vox" });
      assert.equal((await fixture()).counts.wait ?? 0, 0);
      const pending = await request("/api/chat/stable");
      assert.deepEqual(await pending.json(), { conversation: "vox", requestId: "stable", operationId: "stable", status: "queued" });
      assert.equal((await fixture()).counts.wait ?? 0, 0);
      await fixture({ id: "stable", status: "running" });
      assert.equal((await (await request("/api/chat/stable")).json() as { status: string }).status, "running");
      assert.equal((await fixture()).counts.wait ?? 0, 0);
    });
    await t.test("retry ids dedupe and reject changed prompts, with conversation isolation", async () => {
      assert.equal((await (await send("stable")).json() as { accepted: boolean }).accepted, false);
      assert.equal((await send("stable", "Changed")).status, 409);
      const candidates = ["First", "Second", "First", "Second"];
      const responses = await Promise.all(candidates.map(prompt => send("concurrent", prompt)));
      const admitted = candidates[responses.findIndex(response => response.status === 202)];
      assert.deepEqual(responses.map(response => response.status), candidates.map(prompt => prompt === admitted ? 202 : 409));
      assert.equal((await (await send("stable", "Another conversation", "separate")).json() as { accepted: boolean }).accepted, true);
      assert.equal((await fixture()).operations.filter(operation => operation.id === "stable").length, 1);
      assert.equal((await fixture({}, "separate")).operations[0].prompt, "Another conversation");
      const before = await fixture();
      assert.equal((await request("/api/chat/missing")).status, 404);
      assert.equal((await request("/api/chat/missing", "DELETE")).status, 404);
      assert.deepEqual((await fixture()).counts, before.counts);
    });
    await t.test("status repairs interrupted admission and returns terminal output and failure reasons", async () => {
      assert.equal((await send("interrupted", "Preserved prompt")).status, 500);
      assert.equal((await (await request("/api/chat/interrupted")).json() as { status: string }).status, "queued");
      assert.equal((await fixture()).operations.find(operation => operation.id === "interrupted")?.prompt, "Preserved prompt");
      await fixture({ id: "stable", status: "done", text: "# Answer\n\nKept **Markdown**." });
      assert.deepEqual(await (await request("/api/chat/stable")).json(), { conversation: "vox", requestId: "stable", operationId: "stable", status: "done", text: "# Answer\n\nKept **Markdown**." });
      await send("failed"); await fixture({ id: "failed", status: "unanswered", reason: "Model was unavailable" });
      assert.equal((await (await request("/api/chat/failed")).json() as { reason: string }).reason, "Model was unavailable");
    });
    await t.test("DELETE stops queued and running operations while preserving completed replies", async () => {
      for (const status of ["queued", "running"]) {
        await send(`cancel-${status}`); await fixture({ id: `cancel-${status}`, status });
        const response = await request(`/api/chat/cancel-${status}`, "DELETE"); assert.equal(response.status, 200);
        const body = await response.json() as { cancelled: boolean; status: string; reason: string };
        assert.equal(body.cancelled, true); assert.equal(body.status, "unanswered"); assert.equal(body.reason, "aborted");
      }
      const before = (await fixture()).counts.abort;
      const complete = await (await request("/api/chat/stable", "DELETE")).json() as { cancelled: boolean; status: string };
      assert.equal(complete.cancelled, false); assert.equal(complete.status, "done");
      assert.equal((await fixture()).counts.abort, before);
      await send("cancel-delayed"); await fixture({ id: "cancel-delayed", status: "running" });
      const waitCount = (await fixture()).counts.wait;
      const delayed = await (await request("/api/chat/cancel-delayed", "DELETE")).json() as { cancelled: boolean; status: string };
      assert.equal(delayed.cancelled, true); assert.equal(delayed.status, "running");
      assert.equal((await fixture()).counts.wait, waitCount);
      await fixture({ id: "cancel-delayed", status: "unanswered", reason: "aborted" });
      assert.equal((await (await request("/api/chat/cancel-delayed")).json() as { status: string }).status, "unanswered");
    });
    await t.test("saved prompts, settled output, and retry guards survive a runtime restart", async () => {
      await runtime.dispose(); runtime = new Miniflare(convertV4MiniflareOptions(options));
      assert.equal((await (await request("/api/chat/stable")).json() as { status: string }).status, "done");
      assert.equal((await (await request("/api/chat/interrupted")).json() as { status: string }).status, "queued");
      assert.equal((await (await send("stable")).json() as { accepted: boolean }).accepted, false);
      assert.equal((await send("stable", "Changed after restart")).status, 409);
      assert.equal((await fixture()).operations.filter(operation => operation.id === "stable").length, 1);
    });
  } finally {
    await runtime.dispose(); await rm(directory, { recursive: true, force: true });
  }
});
