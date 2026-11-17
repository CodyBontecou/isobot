import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanNotes, fallbackNotes, LAUNCH_MAX_CHARS, launchMessage, mediaRefs, summaryText } from "./launch.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";

test("model notes are cleaned before they go public", () => {
  const notes = cleanNotes({
    headline: "## Big\nnews <@123> @everyone https://x.example/y",
    items: [{ kind: "new", text: "  Export\nto PDF  " }, { kind: "bogus", text: "Faster sync" }, { kind: "fixed", text: "   " }],
    whatsNew: "",
  });
  assert.equal(notes.headline, "Big news everyone");
  assert.deepEqual(notes.items, [{ kind: "new", text: "Export to PDF" }, { kind: "improved", text: "Faster sync" }]);
  assert.equal(notes.whatsNew, "• Export to PDF\n• Faster sync", "a missing What's New is built from the items");
  assert.equal(cleanNotes(null).whatsNew, "Bug fixes and improvements.");
});

test("the fallback keeps today's What's New", () => {
  assert.equal(fallbackNotes([{ title: "Fix  export\ncrash" }]).whatsNew, "Fixes and improvements in this update:\n• Fix export crash");
});

test("the launch post groups changes by kind, or shows What's New when there are none", () => {
  const url = "https://apps.apple.com/app/id1";
  const grouped = launchMessage("Sync.md", "1.2.3", { headline: "Hi", items: [
    { kind: "fixed", text: "B" }, { kind: "new", text: "A" }, { kind: "improved", text: "C" },
  ], whatsNew: "" }, url);
  assert.equal(grouped, "# 🎉 Sync.md 1.2.3 is out\n\nHi\n\n✨ **New**\n• A\n\n🐛 **Fixed**\n• B\n\n💅 **Improved**\n• C\n\n📲 Update on the App Store: <https://apps.apple.com/app/id1>");
  assert.match(launchMessage("X", "1", { headline: "", items: [], whatsNew: "Bug fixes." }, url), /is out\n\nBug fixes\.\n\n📲/);
});

test("a long launch post leaves out its last items, never the App Store link", () => {
  const url = "https://apps.apple.com/app/id1";
  const items = Array.from({ length: 20 }, (_, i) => ({ kind: "new" as const, text: `${i} ${"x".repeat(290)}` }));
  const post = launchMessage("App", "2.0", { headline: "h".repeat(200), items, whatsNew: "" }, url);
  assert.ok(post.length <= LAUNCH_MAX_CHARS, `${post.length} characters`);
  assert.match(post, /…and \d+ more\n\n📲 Update on the App Store: <https:\/\/apps\.apple\.com\/app\/id1>$/);
  const plain = launchMessage("App", "2.0", { headline: "", items: [], whatsNew: "w".repeat(4000) }, url);
  assert.ok(plain.length <= LAUNCH_MAX_CHARS);
  assert.match(plain, /w…\n\n📲 Update on the App Store/);
});

test("captures come only from the repo's own media commits, images first", () => {
  const body = [
    `🎬 [Demo](https://github.com/o/r/blob/${SHA}/7/a/02-demo.mp4?raw=true) (video, 3 MB)`,
    `<img src="https://github.com/o/r/blob/${SHA}/7/a/01-after.png?raw=true" width="320">`,
    `<img src="https://github.com/other/r/blob/${SHA}/7/a/evil.png?raw=true">`,
    `<img src="https://github.com/o/r/blob/${SHA}/7/../../secret.png?raw=true">`,
    `<img src="https://github.com/o/r/blob/${SHA}/7/a/01-after.png?raw=true">`,
  ].join("\n");
  assert.deepEqual(mediaRefs(body, "o", "r").map(r => `${r.kind}:${r.path}`), ["image:7/a/01-after.png", "video:7/a/02-demo.mp4"]);
});

test("summaries drop media markup", () => {
  assert.equal(summaryText(`Did it.\n\n<img src="x">\n\n\n🎬 [Demo](https://github.com/o/r/blob/${SHA}/a.mp4?raw=true)`), "Did it.\n\n🎬 [Demo]()");
});
