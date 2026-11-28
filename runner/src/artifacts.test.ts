import assert from "node:assert/strict";
import { test } from "node:test";
import { ArtifactSync, artifactResults, fileArtifacts, parseListing } from "./artifacts.js";

const PAGE = `3 artifacts, published by you or shared with you (your own first):
- (mine, Design, pinned) Vox.md — Signal redesign — https://claude.ai/artifact/8EJciB6JF25MoGar53CuA8 — updated 2026-11-06
- (mine, web page, not a Doc) Health.md Drive Picker Fixes — https://claude.ai/artifact/VPELE64sj3CAJH6BKUGHaZ — updated 2026-11-21
- (shared) Saltline — https://claude.ai/artifact/BGY1SztrAYcJQHSsnHHGmp
(More exist: pass \`page_token\` "abc" with the same \`scope\` to list the next ones.)`;

const PROJECTS = [
  { project: "Vox.md", repo: "codybontecou/vox.md", match: ["Vox.md"] },
  { project: "Health.md", repo: "codybontecou/health-md", match: ["health.md"] },
];

test("parses the Artifact tool's list lines", () => {
  assert.deepEqual(parseListing(PAGE), [
    { title: "Vox.md — Signal redesign", url: "https://claude.ai/artifact/8EJciB6JF25MoGar53CuA8", kind: "Design", updatedAt: "2026-11-06", pinned: true, shared: false },
    { title: "Health.md Drive Picker Fixes", url: "https://claude.ai/artifact/VPELE64sj3CAJH6BKUGHaZ", kind: "Page", updatedAt: "2026-11-21", pinned: false, shared: false },
    { title: "Saltline", url: "https://claude.ai/artifact/BGY1SztrAYcJQHSsnHHGmp", kind: "Page", updatedAt: null, pinned: false, shared: true },
  ]);
});

test("files artifacts by title, once each, Other when nothing matches", () => {
  const filed = fileArtifacts([...parseListing(PAGE), ...parseListing(PAGE)], PROJECTS);
  assert.deepEqual(filed.map(a => [a.project, a.repo]), [["Vox.md", "codybontecou/vox.md"], ["Health.md", "codybontecou/health-md"], ["Other", null]]);
});

const stream = (results: { text: string; error?: boolean; name?: string }[]) => results.flatMap((r, i) => [
  JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: `t${i}`, name: r.name ?? "Artifact", input: { action: "list" } }] } }),
  JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: `t${i}`, is_error: r.error ?? false, content: [{ type: "text", text: r.text }] }] } }),
]).join("\n");

test("reads only the Artifact tool's successful results from the stream", () => {
  assert.deepEqual(artifactResults(`not json\n${stream([{ text: "a" }, { text: "b", error: true }, { text: "c", name: "Other" }, { text: "d" }])}`), ["a", "d"]);
});

test("a sync pushes the filed list, then waits everyHours", async () => {
  const cursors = new Map<string, string>();
  const pushed: unknown[] = [];
  const sync = new ArtifactSync({
    config: { projects: PROJECTS, everyHours: 6 }, bin: "claude", dir: "/tmp", board: { url: "https://bot.example", token: "t" },
    cursor: k => cursors.get(k) ?? null, setCursor: (k, v) => cursors.set(k, v),
    list: async () => stream([{ text: PAGE }]),
    fetch: (async (url: URL, init: RequestInit) => { pushed.push([String(url), JSON.parse(String(init.body))]); return new Response("{}"); }) as unknown as typeof fetch,
  });
  const now = new Date("2026-11-27T12:00:00Z");
  assert.deepEqual(await sync.tick(now), { pushed: 3 });
  const [url, body] = pushed[0] as [string, { v: number; artifacts: { project: string }[] }];
  assert.equal(url, "https://bot.example/api/ingest/artifacts");
  assert.equal(body.v, 1);
  assert.equal(body.artifacts[2].project, "Other");
  assert.equal(await sync.tick(new Date("2026-11-27T15:00:00Z")), null, "not due yet");
  assert.deepEqual(await sync.tick(new Date("2026-11-27T18:00:01Z")), { pushed: 3 });
});

test("an empty listing keeps the board's list", async () => {
  let pushes = 0;
  const sync = new ArtifactSync({
    config: { projects: PROJECTS }, bin: "claude", dir: "/tmp", board: { url: "https://bot.example", token: "t" },
    cursor: () => null, setCursor: () => {}, list: async () => stream([{ text: "0 artifacts" }]),
    fetch: (async () => { pushes++; return new Response("{}"); }) as unknown as typeof fetch,
  });
  await assert.rejects(sync.tick(), /listed nothing/);
  assert.equal(pushes, 0);
});
