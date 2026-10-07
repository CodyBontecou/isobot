import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions, type V4MiniflareOptions } from "miniflare";

const memoryId = "a1111111-b111-4111-8111-111111111111";
const queuedId = "22222222-2222-4222-8222-222222222222";
const doneId = "33333333-3333-4333-8333-333333333333";
const unansweredId = "44444444-4444-4444-8444-444444444444";
const missingId = "99999999-9999-4999-8999-999999999999";
const markdown = "---\ntitle: Original\n---\n\n# Capture 🦊\n\nKeep **Markdown** and trailing spaces.  \n";
type AgentCall = { method: string; name?: string; input?: Record<string, unknown>; id?: string; options?: { before?: number; limit: number } };

// Exercise production HTTP parsing and routing with fake RPC results, without AI or external requests.
test("Vox HTTP captures archive Markdown and route prompts without awaiting inference", async t => {
  const directory = await mkdtemp(join(tmpdir(), "isobot-vox-http-"));
  const bundle = join(directory, "worker.mjs");
  await build({
    stdin: {
      contents: `import worker from './index.ts';
        const markdown = ${JSON.stringify(markdown)};
        const ids = ${JSON.stringify({ memoryId, queuedId, doneId, unansweredId })};
        function fixture(id) {
          if (!Object.values(ids).includes(id)) return null;
          const mode = id === ids.memoryId ? 'memory' : 'prompt';
          const note = { sequence: 1, id, mode, markdown,
            payloadJson: JSON.stringify({ id, text: markdown, source: 'vox', recorded_at: '2026-10-07T12:00:00Z' }),
            receivedAt: '2026-10-07T12:01:00Z' };
          if (id === ids.doneId) note.result = { operationId: 'vox:' + id, status: 'done', text: ${JSON.stringify("# Pi answer\n\nSaved response.\n")} };
          if (id === ids.unansweredId) note.result = { operationId: 'vox:' + id, status: 'unanswered', text: '', reason: 'Model returned no answer' };
          return note;
        }
        export default { async fetch(request, env) {
          const calls = [];
          const bindings = { ...env, Assistant: { getByName(name) {
            calls.push({ method: 'getByName', name });
            return {
              async storeCapture(input) {
                calls.push({ method: 'storeCapture', input });
                if (input.markdown === 'conflict') return { conflict: true };
                return { conflict: false, duplicate: input.markdown === 'duplicate',
                  note: { sequence: 1, ...input, receivedAt: '2026-10-07T12:01:00Z' } };
              },
              async archivedNote(id) { calls.push({ method: 'archivedNote', id }); return fixture(id); },
              async captureStatus(id) {
                calls.push({ method: 'captureStatus', id });
                const note = fixture(id);
                if (!note) return null;
                return { ...note, status: note.result?.status ?? (note.mode === 'memory' ? 'stored' : 'queued'),
                  ...(note.mode === 'prompt' ? { operationId: 'vox:' + id } : {}) };
              },
              async listCaptures(options) {
                calls.push({ method: 'listCaptures', options });
                return { items: [{ sequence: 6, id: ids.memoryId, mode: 'memory',
                  receivedAt: '2026-10-07T12:01:00Z', preview: 'Stored note', status: 'stored' }], nextCursor: 6 };
              },
              async ask() { throw new Error('Capture ingestion must not wait for a model'); },
              async runPrompt() { throw new Error('Capture ingestion must not wait for a model'); },
            };
          } } };
          const response = await worker.fetch(request, bindings);
          const headers = new Headers(response.headers);
          headers.set('X-Test-Agent-Calls', encodeURIComponent(JSON.stringify(calls.map(call =>
            call.input?.markdown.length > 4000 ? { ...call, input: { id: call.input.id, mode: call.input.mode,
              markdownLength: call.input.markdown.length } } : call))));
          return new Response(response.body, { status: response.status, headers });
        } };`,
      resolveDir: new URL(".", import.meta.url).pathname,
      sourcefile: "vox-http-test.ts", loader: "ts",
    },
    bundle: true, format: "esm", platform: "browser", conditions: ["workerd"],
    external: ["cloudflare:*", "node:*", "path"], outfile: bundle,
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire('/worker.mjs');" },
  });
  const options: V4MiniflareOptions = {
    workers: [{
      name: "isobot-vox-http-test", modules: true, scriptPath: bundle, modulesRoot: directory,
      compatibilityDate: "2026-10-07", compatibilityFlags: ["nodejs_compat"],
      bindings: { ISOBOT_API_TOKEN: "test-isobot-token", PROMPT_API_TOKEN: "test-prompt-token", PI_MODEL: "test-model" },
    }],
  };
  const runtime = new Miniflare(convertV4MiniflareOptions(options));
  const request = (path: string, options: {
    method?: string; body?: unknown; rawBody?: string; token?: string | null; idempotencyKey?: string | null;
  } = {}) => {
    const headers: Record<string, string> = { "Content-Type": "application/json; charset=utf-8" };
    const token = options.token === undefined ? "test-prompt-token" : options.token;
    if (token !== null) headers.Authorization = `Bearer ${token}`;
    const bodyId = options.body && typeof options.body === "object" && "id" in options.body ? options.body.id : undefined;
    const key = options.idempotencyKey === undefined ? (typeof bodyId === "string" ? bodyId.toLowerCase() : memoryId) : options.idempotencyKey;
    if (key !== null) headers["Idempotency-Key"] = key;
    return runtime.dispatchFetch(`https://test${path}`, {
      method: options.method ?? (path.startsWith("/api/vox") ? "POST" : "GET"), headers,
      body: options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
    });
  };
  const calls = (response: Awaited<ReturnType<typeof runtime.dispatchFetch>>) => JSON.parse(decodeURIComponent(response.headers.get("X-Test-Agent-Calls")!)) as AgentCall[];
  const body = (text = markdown) => ({ id: memoryId, text, source: "vox", recorded_at: "2026-10-07T12:00:00Z" });
  try {
    await t.test("prompt and bridge tokens grant Vox and note access while prompt credentials stay scoped", async () => {
      for (const token of ["test-prompt-token", "test-isobot-token"]) {
        assert.equal((await request("/api/vox", { token, body: body() })).status, 201);
        assert.equal((await request("/api/notes", { token })).status, 200);
        assert.equal((await request(`/api/notes/${memoryId}.md`, { token })).status, 200);
      }
      for (const path of ["/api/status", "/api/pending", "/api/tickets"]) {
        const response = await request(path);
        assert.equal(response.status, 401);
        assert.deepEqual(calls(response), []);
      }
    });
    await t.test("authentication rejects capture and archive access before agent lookup", async () => {
      for (const token of [null, "incorrect"]) {
        for (const path of ["/api/vox", "/api/notes", `/api/notes/${memoryId}`, `/api/notes/${memoryId}/source.json`]) {
          const response = await request(path, { token, ...(path === "/api/vox" ? { body: body() } : {}) });
          assert.equal(response.status, 401);
          assert.deepEqual(calls(response), []);
        }
      }
    });
    await t.test("default memory captures retain Markdown and return retrievable URLs", async () => {
      const response = await request("/api/vox", { body: body() });
      const result = await response.json() as Record<string, unknown>;
      assert.equal(response.status, 201);
      assert.equal(response.headers.get("Cache-Control"), "no-store");
      assert.equal(result.id, memoryId);
      assert.equal(result.mode, "memory");
      assert.equal(result.conversation, "vox");
      assert.equal(result.duplicate, false);
      assert.equal(result.status, "stored");
      assert.equal(result.operationId, undefined);
      assert.equal(result.noteUrl, `https://test/api/notes/${memoryId}?conversation=vox`);
      assert.equal(result.markdownUrl, `https://test/api/notes/${memoryId}.md?conversation=vox`);
      assert.deepEqual(calls(response), [{ method: "getByName", name: "http:vox" },
        { method: "storeCapture", input: { id: memoryId, mode: "memory", markdown, payloadJson: JSON.stringify(body()) } }]);
    });
    await t.test("prompt presets route to their conversation and enqueue without waiting for a model", async () => {
      const response = await request("/api/vox?mode=prompt&conversation=Tasks_2", { body: body("Create a plan") });
      const result = await response.json() as Record<string, unknown>;
      assert.equal(response.status, 202);
      assert.equal(result.mode, "prompt");
      assert.equal(result.conversation, "Tasks_2");
      assert.equal(result.status, "queued");
      assert.equal(result.operationId, `vox:${memoryId}`);
      assert.equal(calls(response)[0].name, "http:Tasks_2");
      assert.deepEqual(calls(response).map(call => call.method), ["getByName", "storeCapture"]);
    });
    await t.test("connection tests validate auth and routing without storing or invoking Pi", async () => {
      for (const mode of ["memory", "prompt"]) {
        const response = await request(`/api/vox?mode=${mode}&conversation=connection-test`, {
          body: { id: memoryId, text: "Vox.md delivery test", test: true },
        });
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { ok: true, test: true, mode, conversation: "connection-test" });
        assert.deepEqual(calls(response), []);
      }
    });
    await t.test("Vox UUID case is normalized and recording metadata is retained", async () => {
      const recording = { id: memoryId.toUpperCase(), text: "Raw text", cleanedText: "# Cleaned Markdown", date: 813024000,
        duration: 12.5, modelUsed: "base", language: "en", title: "Recording", tags: ["voice"], category: "ideas" };
      const response = await request("/api/vox?mode=memory", { body: recording, idempotencyKey: memoryId });
      assert.equal(response.status, 201);
      const input = calls(response).find(call => call.method === "storeCapture")!.input!;
      assert.equal(input.id, memoryId);
      assert.equal(input.markdown, recording.text);
      assert.deepEqual(JSON.parse(String(input.payloadJson)), recording);
    });
    await t.test("retry duplicates return success while changed captures return conflict", async () => {
      const duplicate = await request("/api/vox", { body: body("duplicate") });
      assert.equal(duplicate.status, 200);
      assert.equal((await duplicate.json() as { duplicate: boolean }).duplicate, true);
      const promptDuplicate = await request("/api/vox?mode=prompt", { body: body("duplicate") });
      assert.equal(promptDuplicate.status, 202);
      assert.equal((await promptDuplicate.json() as { duplicate: boolean }).duplicate, true);
      const conflict = await request("/api/vox", { body: body("conflict") });
      assert.equal(conflict.status, 409);
      assert.equal(conflict.headers.get("Cache-Control"), "no-store");
    });
    await t.test("methods and malformed JSON fail before any storage lookup", async () => {
      for (const method of ["GET", "PUT", "DELETE"]) {
        const response = await request("/api/vox", { method });
        assert.equal(response.status, 405);
        assert.equal(response.headers.get("Allow"), "POST");
        assert.deepEqual(calls(response), []);
      }
      for (const path of ["/api/notes", `/api/notes/${memoryId}`, `/api/notes/${memoryId}.md`]) {
        const response = await request(path, { method: "POST" });
        assert.equal(response.status, 405);
        assert.equal(response.headers.get("Allow"), "GET");
        assert.deepEqual(calls(response), []);
      }
      for (const rawBody of [undefined, "{", " ", "x".repeat(1_048_577)]) {
        const response = await request("/api/vox", { rawBody });
        assert.equal(response.status, 400);
        assert.deepEqual(calls(response), []);
      }
    });
    await t.test("invalid body identifiers, metadata, idempotency keys and routing are rejected", async () => {
      for (const invalid of [null, [], {}, { ...body(), id: "bad-id" }, { ...body(), text: " \n\t" },
        { ...body(), text: 123 }, { ...body(), cleanedText: 123 }, { ...body(), test: "true" },
        { ...body(), duration: -1 }, { ...body(), recorded_at: "yesterday" }, { ...body(), title: 123 }]) {
        const response = await request("/api/vox", { body: invalid });
        assert.equal(response.status, 400, JSON.stringify(invalid));
        assert.deepEqual(calls(response), []);
      }
      for (const idempotencyKey of [null, "invalid", missingId]) {
        const response = await request("/api/vox", { body: body(), idempotencyKey });
        assert.equal(response.status, 400);
        assert.deepEqual(calls(response), []);
      }
      for (const query of ["mode=archive", "mode=", "conversation=", "conversation=one%2Ftwo", "conversation=" + "x".repeat(101)]) {
        const response = await request(`/api/vox?${query}`, { body: body() });
        assert.equal(response.status, 400, query);
        assert.deepEqual(calls(response), []);
      }
    });
    await t.test("Vox supports larger captures than the original prompt API JSON limit", async () => {
      const response = await request("/api/vox", { body: body("# Note\n\n" + "x".repeat(260_000)) });
      assert.equal(response.status, 201);
      assert.equal(calls(response).find(call => call.method === "storeCapture")!.input!.markdownLength, 260_008);
      const oldPrompt = await request("/api/prompt", { method: "POST", body: { prompt: "x".repeat(260_000) } });
      assert.equal(oldPrompt.status, 400);
    });
    await t.test("Markdown downloads preserve bytes and original payload is available separately", async () => {
      const raw = await request(`/api/notes/${memoryId}.md?conversation=journal`);
      assert.equal(raw.status, 200);
      assert.match(raw.headers.get("Content-Type")!, /^text\/markdown;\s*charset=utf-8/i);
      assert.equal(raw.headers.get("Cache-Control"), "no-store");
      assert.deepEqual(new Uint8Array(await raw.arrayBuffer()), new TextEncoder().encode(markdown));
      assert.equal(calls(raw)[0].name, "http:journal");
      const source = await request(`/api/notes/${memoryId}/source.json`);
      assert.equal(source.status, 200);
      assert.deepEqual(await source.json(), body());
    });
    await t.test("note status and Pi responses distinguish queued, done and unanswered", async () => {
      const stored = await request(`/api/notes/${memoryId}`);
      assert.equal(stored.status, 200);
      assert.equal((await stored.json() as { status: string }).status, "stored");
      const queued = await request(`/api/notes/${queuedId}`);
      assert.equal((await queued.json() as { status: string }).status, "queued");
      const waiting = await request(`/api/notes/${queuedId}/response.md`);
      assert.equal(waiting.status, 202);
      const done = await request(`/api/notes/${doneId}/response.md`);
      assert.equal(done.status, 200);
      assert.match(done.headers.get("Content-Type")!, /^text\/markdown;\s*charset=utf-8/i);
      assert.equal(await done.text(), "# Pi answer\n\nSaved response.\n");
      const unanswered = await request(`/api/notes/${unansweredId}/response.md`);
      assert.equal(unanswered.status, 422);
      const result = await unanswered.json() as { status?: string; reason?: string };
      assert.equal(result.status, "unanswered");
      assert.equal(result.reason, "Model returned no answer");
    });
    await t.test("missing notes return 404 for each representation", async () => {
      for (const suffix of ["", ".md", "/source.json", "/response.md"]) {
        const response = await request(`/api/notes/${missingId}${suffix}`);
        assert.equal(response.status, 404, suffix);
      }
    });
    await t.test("list pagination uses bounded numeric options and conversation routing", async () => {
      const response = await request("/api/notes?conversation=journal&limit=5&before=12");
      assert.equal(response.status, 200);
      const result = await response.json() as { items: { id: string }[]; nextCursor: number };
      assert.equal(result.items[0].id, memoryId);
      assert.equal(result.nextCursor, 6);
      assert.deepEqual(calls(response), [{ method: "getByName", name: "http:journal" },
        { method: "listCaptures", options: { before: 12, limit: 5 } }]);
      const defaults = await request("/api/notes");
      assert.deepEqual(calls(defaults), [{ method: "getByName", name: "http:vox" },
        { method: "listCaptures", options: { limit: 25 } }]);
      for (const query of ["limit=0", "limit=101", "limit=1.5", "limit=foo", "before=0", "before=-1", "before=1.5", "before=foo", "conversation=bad%2Fpath"]) {
        const invalid = await request(`/api/notes?${query}`);
        assert.equal(invalid.status, 400, query);
        assert.deepEqual(calls(invalid), []);
      }
    });
  } finally {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
