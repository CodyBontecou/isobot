import assert from "node:assert/strict";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { captionFor, collectMedia, mediaMarkdown } from "./media.js";
import { MP4, PNG } from "./testing.js";


test("captions come from the file name, without the ordering number", () => {
  assert.equal(captionFor("02-after-export_sheet.png"), "After export sheet");
  assert.equal(captionFor("flow.mp4"), "Flow");
});

test("collects real images and videos in name order, and explains everything it leaves out", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "isobot-media-test-"));
  writeFileSync(path.join(dir, "02-after.png"), PNG);
  writeFileSync(path.join(dir, "01 before (1).png"), PNG);
  writeFileSync(path.join(dir, "03-flow.mp4"), MP4);
  writeFileSync(path.join(dir, "fake.png"), "<html>not an image</html>");
  writeFileSync(path.join(dir, "notes.txt"), "hi");
  writeFileSync(path.join(dir, ".DS_Store"), "x");
  symlinkSync("/etc/hosts", path.join(dir, "link.png"));
  const { files, skipped } = collectMedia(dir);
  assert.deepEqual(files.map(f => [f.name, f.kind, f.caption]), [
    ["01-before-1-.png", "image", "Before (1)"],
    ["02-after.png", "image", "After"],
    ["03-flow.mp4", "video", "Flow"],
  ]);
  assert.equal(skipped.length, 3);
  assert.match(skipped.join("\n"), /fake\.png: contents don't match/);
  assert.match(skipped.join("\n"), /link\.png: not a regular file/);
  assert.match(skipped.join("\n"), /notes\.txt: not a PNG/);
});

test("a missing folder is simply no media", () => {
  assert.deepEqual(collectMedia("/nonexistent/isobot-media"), { files: [], skipped: [] });
});

test("markdown shows images inline and links videos", () => {
  const files = [
    { file: "/x/a.png", name: "a.png", kind: "image" as const, bytes: 10, caption: "After \"export\"" },
    { file: "/x/b.mp4", name: "b.mp4", kind: "video" as const, bytes: 3 * 1024 * 1024, caption: "Flow" },
  ];
  const md = mediaMarkdown(files, { "a.png": "https://github.com/o/r/blob/c/a.png?raw=true", "b.mp4": "https://github.com/o/r/blob/c/b.mp4?raw=true" });
  assert.match(md, /<img src="https:\/\/github.com\/o\/r\/blob\/c\/a.png\?raw=true" alt="After 'export'"/);
  assert.match(md, /🎬 \[Flow\]\(https:\/\/github.com\/o\/r\/blob\/c\/b.mp4\?raw=true\) \(video, 3.0 MB\)/);
});
