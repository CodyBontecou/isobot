import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions, type V4MiniflareOptions } from "miniflare";
import type { NoteInput, NoteMetadata, NoteResult, StoredNote } from "./notes.js";

type Remembered = { conflict: true } | { conflict: false; duplicate: boolean; note: StoredNote };
type Page = { items: NoteMetadata[]; nextCursor?: number };

test("captured Markdown stays immutable and searchable in durable SQLite", async t => {
  const directory = await mkdtemp(join(tmpdir(), "isobot-notes-"));
  const bundle = join(directory, "worker.mjs");
  await build({
    stdin: {
      contents: `import { DurableObject } from 'cloudflare:workers';
        import { NoteArchive } from './notes.ts';
        export class Captures extends DurableObject {
          constructor(ctx, env) { super(ctx, env); this.archive = new NoteArchive(ctx.storage.sql); }
          async action(input) {
            if (input.kind === 'remember') return this.archive.remember(input.note);
            if (input.kind === 'get') return this.archive.get(input.id);
            if (input.kind === 'list') return this.archive.list(input.options);
            if (input.kind === 'search') return this.archive.search(input.query, input.limit);
            if (input.kind === 'saveResult') { this.archive.saveResult(input.id, input.result); return this.archive.get(input.id); }
          }
        }
        export default { async fetch(request, env) {
          return Response.json(await env.Notes.getByName('vox').action(await request.json()));
        } };`,
      resolveDir: new URL(".", import.meta.url).pathname,
      sourcefile: "notes-test.ts", loader: "ts",
    },
    bundle: true, format: "esm", platform: "browser", external: ["cloudflare:workers"], outfile: bundle,
  });
  const options: V4MiniflareOptions = {
    resourcePersistencePath: join(directory, "storage"),
    workers: [{
      name: "isobot-notes-test", modules: true, scriptPath: bundle, modulesRoot: directory,
      compatibilityDate: "2026-10-07",
      durableObjects: { Notes: { className: "Captures", useSQLite: true } },
    }],
  };
  let runtime = new Miniflare(convertV4MiniflareOptions(options));
  const call = async <T>(input: unknown): Promise<T> => {
    const response = await runtime.dispatchFetch("http://test/archive", { method: "POST", body: JSON.stringify(input) });
    assert.equal(response.status, 200);
    return await response.json() as T;
  };
  const remember = (note: NoteInput) => call<Remembered>({ kind: "remember", note });
  const get = (id: string) => call<StoredNote | null>({ kind: "get", id });
  const list = (limit: number, before?: number) => call<Page>({ kind: "list", options: { limit, before } });
  const search = (query: string, limit = 10) => call<(NoteMetadata & { snippet: string })[]>({ kind: "search", query, limit });
  const original: NoteInput = {
    id: "original", mode: "memory",
    markdown: "---\r\ntitle: Café notes\r\n---\r\n# Café notes\r\n\r\nKeep the trailing spaces.  \r\n\n",
    payload: { title: "Café notes", custom: { tags: ["voice", "idea"], at: null }, source: "vox.md" },
  };
  let originalSaved: StoredNote;
  try {
    await t.test("preserves exact Markdown, metadata, capture mode and server timestamp", async () => {
      const saved = await remember(original);
      assert.equal(saved.conflict, false);
      assert.ok(!saved.conflict);
      assert.equal(saved.duplicate, false);
      originalSaved = saved.note;
      assert.deepEqual(saved.note, { ...original, sequence: saved.note.sequence, receivedAt: saved.note.receivedAt });
      assert.ok(saved.note.sequence > 0);
      assert.equal(new Date(saved.note.receivedAt).toISOString(), saved.note.receivedAt);
      assert.deepEqual(await get(original.id), saved.note);
      assert.equal(await get("missing"), null);

      const reordered = await remember({ ...original, payload: { source: "vox.md", custom: { at: null, tags: ["voice", "idea"] }, title: "Café notes" } });
      assert.ok(!reordered.conflict);
      assert.equal(reordered.duplicate, true);
      assert.deepEqual(reordered.note, saved.note);
    });

    await t.test("rejects changed content, mode and metadata for an existing capture id", async () => {
      assert.deepEqual(await remember({ ...original, markdown: `${original.markdown}\nChanged` }), { conflict: true });
      assert.deepEqual(await remember({ ...original, mode: "prompt" }), { conflict: true });
      assert.deepEqual(await remember({ ...original, payload: { ...original.payload, title: "Changed" } }), { conflict: true });
      assert.deepEqual(await remember({ ...original, payload: { ...original.payload, custom: { tags: ["idea", "voice"], at: null } } }), { conflict: true });
      assert.deepEqual(await get(original.id), originalSaved);
    });

    await t.test("concurrent duplicate requests admit one immutable input", async () => {
      const candidates = ["first", "second", "first", "second", "first", "second"];
      const results = await Promise.all(candidates.map(markdown => remember({ id: "concurrent", mode: "prompt", markdown, payload: {} })));
      const saved = await get("concurrent");
      assert.ok(saved);
      assert.equal(results.filter(result => !result.conflict && !result.duplicate).length, 1);
      for (const [index, result] of results.entries()) assert.equal(result.conflict, candidates[index] !== saved.markdown);
      assert.equal((await get("concurrent"))?.mode, "prompt");
    });

    await t.test("lists newest first with stable exclusive cursors and bounded metadata", async () => {
      for (let index = 0; index < 5; index++) {
        await remember({ id: `page-${index}`, mode: "memory", markdown: `# Page ${index}\n${"x".repeat(1000)}`, payload: { index } });
      }
      const first = await list(3);
      assert.equal(first.items.length, 3);
      assert.deepEqual(first.items.map(item => item.id), ["page-4", "page-3", "page-2"]);
      assert.equal(first.nextCursor, first.items[2].sequence);
      for (const item of first.items) {
        assert.equal(item.status, "stored");
        assert.ok(item.preview.length <= 240);
        assert.equal("markdown" in item, false);
        assert.equal("payload" in item, false);
      }
      await remember({ id: "later", mode: "memory", markdown: "arrived after page one", payload: {} });
      const remaining: NoteMetadata[] = [];
      let cursor: number | undefined = first.nextCursor;
      while (cursor !== undefined) {
        const page = await list(3, cursor);
        remaining.push(...page.items);
        cursor = page.nextCursor;
      }
      assert.deepEqual(remaining.map(item => item.id), ["page-1", "page-0", "concurrent", "original"]);
      assert.equal(remaining.find(item => item.id === "concurrent")?.status, "queued");
      assert.equal(new Set([...first.items, ...remaining].map(item => item.id)).size, first.items.length + remaining.length);
    });

    await t.test("searches literal case-insensitive substrings without SQL or wildcard interpretation", async () => {
      const body = `${"before ".repeat(100)}A literal 50%_discount and quote ' OR 1=1 -- are just text. ${"after ".repeat(100)}`;
      await remember({ id: "literal", mode: "memory", markdown: body, payload: {} });
      const found = await search("50%_discount");
      assert.deepEqual(found.map(item => item.id), ["literal"]);
      assert.ok(found[0].snippet.includes("50%_discount"));
      assert.ok(found[0].snippet.length <= 480);
      assert.equal("markdown" in found[0], false);
      assert.deepEqual((await search("' OR 1=1 --")).map(item => item.id), ["literal"]);
      assert.deepEqual((await search("LITERAL")).map(item => item.id), ["literal"]);
      assert.deepEqual(await search("50___discount"), []);
      assert.deepEqual(await search("not found"), []);
      const recent = await search(" \n", 2);
      assert.equal(recent.length, 2);
      assert.equal(recent[0].id, "literal");
      assert.equal(recent[0].snippet, recent[0].preview);
    });

    await t.test("retains the first terminal Pi result without changing capture data", async () => {
      const result: NoteResult = { operationId: "vox-concurrent", status: "done", text: "# Saved response\n\nA useful answer." };
      const saved = await call<StoredNote>({ kind: "saveResult", id: "concurrent", result });
      assert.deepEqual(saved.result, result);
      assert.equal(saved.mode, "prompt");
      assert.deepEqual((await call<StoredNote>({ kind: "saveResult", id: "concurrent", result: { ...result, status: "unanswered", text: "", reason: "later failure" } })).result, result);
      assert.equal((await list(100)).items.find(item => item.id === "concurrent")?.status, "done");

      await remember({ id: "failed", mode: "prompt", markdown: "A prompt that could not finish", payload: {} });
      const failed: NoteResult = { operationId: "vox-failed", status: "unanswered", text: "", reason: "model unavailable" };
      assert.deepEqual((await call<StoredNote>({ kind: "saveResult", id: "failed", result: failed })).result, failed);
      assert.equal((await search("could not finish"))[0].status, "unanswered");
    });

    await t.test("bounds list and search page sizes", async () => {
      await Promise.all(Array.from({ length: 105 }, (_, index) => remember({ id: `bounded-${index}`, mode: "memory", markdown: `bounded marker ${index}`, payload: {} })));
      assert.equal((await list(1000)).items.length, 100);
      assert.equal((await list(0)).items.length, 1);
      assert.equal((await search("bounded marker", 1000)).length, 10);
      assert.equal((await search("bounded marker", 2)).length, 2);
    });

    await t.test("preserves originals, retry reservations and results after a full runtime restart", async () => {
      await runtime.dispose();
      runtime = new Miniflare(convertV4MiniflareOptions(options));
      assert.deepEqual(await get("original"), originalSaved);
      const duplicate = await remember(original);
      assert.ok(!duplicate.conflict);
      assert.equal(duplicate.duplicate, true);
      assert.deepEqual(duplicate.note, originalSaved);
      assert.deepEqual(await remember({ ...original, mode: "prompt" }), { conflict: true });
      assert.equal((await get("concurrent"))?.result?.text, "# Saved response\n\nA useful answer.");
      assert.equal((await get("failed"))?.result?.reason, "model unavailable");
      assert.deepEqual((await search("50%_discount")).map(item => item.id), ["literal"]);
      assert.equal((await list(3)).items.length, 3);
    });
  } finally {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
