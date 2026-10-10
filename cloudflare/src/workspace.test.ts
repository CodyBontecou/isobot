import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions, type V4MiniflareOptions } from "miniflare";
import { isWorkspaceContent, isWorkspacePath, MAX_WORKSPACE_FILE_BYTES, type WorkspaceFile, type WorkspaceListing } from "./workspace.js";

test("workspace validates relative paths and actual UTF-8 content size", () => {
  for (const path of ["../private", "a/../../private", "/etc/passwd", "a//b", "a/./b", "a/../b", "a/", "C:\\secret", "C:/secret", "bad\nname", "\u0000", "\ud800", " leading", "trailing ", "a/ b", "x".repeat(257)]) {
    assert.equal(isWorkspacePath(path), false, path);
  }
  for (const path of ["notes/Portugal.md", "config.json", ".gitignore", "Café notes.txt", "quotes-' OR 1=1 --.md"]) assert.equal(isWorkspacePath(path), true, path);
  assert.equal(isWorkspacePath("é".repeat(129)), false);
  assert.equal(isWorkspaceContent(""), true);
  assert.equal(isWorkspaceContent("é".repeat(MAX_WORKSPACE_FILE_BYTES / 2)), true);
  assert.equal(isWorkspaceContent("é".repeat(MAX_WORKSPACE_FILE_BYTES / 2 + 1)), false);
  assert.equal(isWorkspaceContent("a\u0000b"), false);
  assert.equal(isWorkspaceContent("\ud800"), false);
  assert.equal(isWorkspaceContent("\udfff"), false);
  assert.equal(isWorkspaceContent("🌍"), true);
});

test("workspace HTTP CRUD persists with atomic revision checks and isolated conversations", { timeout: 120_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "isobot-workspace-"));
  const bundle = join(directory, "worker.mjs");
  await build({
    stdin: {
      contents: `import { DurableObject } from 'cloudflare:workers';
        import { Workspace } from './workspace.ts';
        import { handleWorkspaceRequest } from './workspace-routes.ts';
        export class Files extends DurableObject {
          constructor(ctx, env) { super(ctx, env); this.workspace = new Workspace(ctx.storage); }
          workspaceList() { return this.workspace.list(); }
          workspaceRead(path) { return this.workspace.get(path); }
          workspaceWrite(path, content, revision) { return this.workspace.put(path, content, revision); }
          workspaceDelete(path, revision) { return this.workspace.delete(path, revision); }
          resourcesSnapshot() { return JSON.stringify({ storage: { databaseBytes: this.ctx.storage.sql.databaseSize } }); }
          search(query) { return this.workspace.search(query); }
        }
        export default { async fetch(request, env) {
          if (new URL(request.url).pathname === '/search') return Response.json(await env.Files.getByName('vox').search(new URL(request.url).searchParams.get('q')));
          return handleWorkspaceRequest(request, conversation => env.Files.getByName(conversation));
        } };`,
      resolveDir: new URL(".", import.meta.url).pathname, sourcefile: "workspace-test.ts", loader: "ts",
    },
    bundle: true, format: "esm", platform: "browser", external: ["cloudflare:workers"], outfile: bundle,
  });
  const options: V4MiniflareOptions = {
    resourcePersistencePath: join(directory, "storage"),
    workers: [{ name: "isobot-workspace-test", modules: true, scriptPath: bundle, modulesRoot: directory,
      compatibilityDate: "2026-10-07", durableObjects: { Files: { className: "Files", useSQLite: true } } }],
  };
  let runtime = new Miniflare(convertV4MiniflareOptions(options));
  const call = (path = "", method = "GET", body?: unknown, conversation = "vox") => runtime.dispatchFetch(
    `http://test/api/workspace${path ? `/file?conversation=${conversation}&path=${encodeURIComponent(path)}` : `?conversation=${conversation}`}`,
    { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
  );
  const put = (path: string, content: string, expectedRevision: number | null) => call(path, "PUT", { content, expectedRevision });
  const read = async (path: string): Promise<WorkspaceFile> => {
    const response = await call(path); assert.equal(response.status, 200);
    return (await response.json() as { file: WorkspaceFile }).file;
  };
  const list = async (): Promise<WorkspaceListing> => await (await call()).json() as WorkspaceListing;
  let original: WorkspaceFile;
  let updated: WorkspaceFile;
  try {
    await t.test("stores exact text and measured bytes without content in listings", async () => {
      const content = "# Café\r\n\r\nKeep the trailing spaces.  \r\n🌍\n";
      const response = await put("notes/Portugal.md", content, null);
      assert.equal(response.status, 201);
      assert.equal(response.headers.get("Cache-Control"), "no-store");
      original = (await response.json() as { file: WorkspaceFile }).file;
      assert.equal(original.bytes, new TextEncoder().encode(content).byteLength);
      assert.equal(original.content, content);
      assert.ok(original.revision > 0);
      assert.equal(new Date(original.updatedAt).toISOString(), original.updatedAt);
      assert.deepEqual(await read(original.path), original);
      const listing = await list();
      assert.equal(listing.files.length, 1);
      assert.equal(listing.totalBytes, original.bytes);
      assert.equal("content" in listing.files[0], false);
      assert.equal((await call("notes/Portugal.md", "GET", undefined, "another")).status, 404);
    });
    await t.test("concurrent editors admit exactly one revision and reject stale deletion", async () => {
      const responses = await Promise.all([put(original.path, "first editor", original.revision), put(original.path, "second editor", original.revision)]);
      assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
      updated = await read(original.path);
      assert.ok(updated.revision > original.revision);
      const conflict = await (responses.find(response => response.status === 409)!).json() as { currentRevision: number };
      assert.equal(conflict.currentRevision, updated.revision);
      assert.equal((await call(original.path, "DELETE", { expectedRevision: original.revision })).status, 409);
      assert.deepEqual(await read(original.path), updated);
      assert.equal((await put(original.path, "create over existing", null)).status, 409);
    });
    await t.test("delete-and-recreate cannot revive a stale revision", async () => {
      assert.equal((await call(updated.path, "DELETE", { expectedRevision: updated.revision })).status, 200);
      assert.equal((await call(updated.path)).status, 404);
      const recreated = await put(updated.path, "recreated", null);
      assert.equal(recreated.status, 201);
      updated = (await recreated.json() as { file: WorkspaceFile }).file;
      assert.ok(updated.revision > original.revision);
      assert.equal((await put(updated.path, "stale", original.revision)).status, 409);
    });
    await t.test("rejects malformed bodies, duplicate query parameters and unsafe paths", async () => {
      assert.equal((await call("../escape", "PUT", { content: "x", expectedRevision: null })).status, 400);
      assert.equal((await call("valid.md", "PUT", { content: "x" })).status, 400);
      assert.equal((await call("valid.md", "PUT", { content: "x", expectedRevision: 0 })).status, 400);
      assert.equal((await call("valid.md", "PUT", { content: "é".repeat(MAX_WORKSPACE_FILE_BYTES / 2 + 1), expectedRevision: null })).status, 400);
      assert.equal((await call(updated.path, "DELETE", {})).status, 400);
      assert.equal((await runtime.dispatchFetch("http://test/api/workspace?conversation=vox&conversation=other")).status, 400);
      assert.equal((await runtime.dispatchFetch("http://test/api/workspace/file?path=a&path=b")).status, 400);
      assert.equal((await runtime.dispatchFetch("http://test/api/workspace/file?path=valid.md", { method: "PUT", body: "{broken" })).status, 400);
      const wrongMethod = await call("", "POST", {});
      assert.equal(wrongMethod.status, 405);
      assert.equal(wrongMethod.headers.get("Allow"), "GET");
    });
    await t.test("literal search safely handles SQL-looking characters and bounded previews", async () => {
      await put("quotes.md", `${"before ".repeat(100)}50%_discount ' OR 1=1 -- ${"after ".repeat(100)}`, null);
      const search = async (query: string) => await (await runtime.dispatchFetch(`http://test/search?q=${encodeURIComponent(query)}`)).json() as { path: string; snippet: string }[];
      const matches = await search("50%_discount");
      assert.equal(matches.length, 1);
      assert.equal(matches[0].path, "quotes.md");
      assert.ok(matches[0].snippet.includes("50%_discount"));
      assert.ok(matches[0].snippet.length <= 480);
      assert.deepEqual((await search("' OR 1=1 --")).map(file => file.path), ["quotes.md"]);
      assert.deepEqual(await search("50___discount"), []);
    });
    await t.test("preserves files and revision conflicts after runtime restart", async () => {
      await runtime.dispose(); runtime = new Miniflare(convertV4MiniflareOptions(options));
      assert.deepEqual(await read(updated.path), updated);
      assert.equal((await put(updated.path, "stale after restart", original.revision)).status, 409);
      assert.equal((await list()).files.length, 2);
    });
    await t.test("enforces workspace file capacity while permitting edits of existing files", async () => {
      for (let batch = 0; batch < 5; batch++) {
        const responses = await Promise.all(Array.from({ length: batch === 4 ? 98 : 100 }, (_, index) =>
          put(`capacity/${batch}-${index}.txt`, "x", null)));
        for (const response of responses) assert.equal(response.status, 201);
      }
      assert.equal((await list()).files.length, 500);
      assert.equal((await put("over-capacity.txt", "x", null)).status, 413);
      assert.equal((await put(updated.path, "allowed edit", updated.revision)).status, 200);
    });
  } finally {
    await runtime.dispose(); await rm(directory, { recursive: true, force: true });
  }
});
