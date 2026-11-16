import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { removeDerivedData } from "./cleanup.js";

function derived(root: string, name: string, project?: string): string {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  if (project) writeFileSync(path.join(dir, "info.plist"), `<?xml version="1.0"?><plist><dict><key>WorkspacePath</key>\n\t<string>${project}</string></dict></plist>`);
  return dir;
}

test("removes DerivedData only for vanished projects under the prefix", () => {
  const base = mkdtempSync(path.join(tmpdir(), "isobot-dd-"));
  const root = path.join(base, "DerivedData");
  const work = path.join(base, "work");
  const live = path.join(work, "o", "r", "live-job");
  mkdirSync(live, { recursive: true });
  const gone = derived(root, "App-gone", path.join(work, "o", "r", "isobot__1-x", "App.xcodeproj"));
  const stillThere = derived(root, "App-live", path.join(live, "App.xcodeproj"));
  mkdirSync(path.join(live, "App.xcodeproj"));
  const elsewhere = derived(root, "Mine-x", path.join(base, "elsewhere", "Mine.xcodeproj"));
  const shared = derived(root, "ModuleCache.noindex");
  assert.equal(removeDerivedData(work, root), 1);
  assert.ok(!existsSync(gone));
  for (const kept of [stillThere, elsewhere, shared]) assert.ok(existsSync(kept), kept);
});
