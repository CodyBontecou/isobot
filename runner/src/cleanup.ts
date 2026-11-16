import { readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Xcode keeps one DerivedData folder per project path, and every isobot job builds in a fresh
 * workspace path, so each job leaves gigabytes behind that nothing will reuse. This removes the
 * DerivedData folders whose project lived under `prefix` (a workspace, or the whole work root),
 * once that project is gone. Shared caches (ModuleCache.noindex and friends) have no project and
 * are never touched, nor is anything belonging to a path that still exists.
 */
export function removeDerivedData(prefix: string, root = path.join(homedir(), "Library", "Developer", "Xcode", "DerivedData")): number {
  const prefixes = new Set([prefix, real(prefix), prefix.replace(/^\/private\//, "/")].map(p => p.replace(/\/+$/, "")));
  let entries: string[];
  try { entries = readdirSync(root); } catch { return 0; }
  let removed = 0;
  for (const entry of entries) {
    const dir = path.join(root, entry);
    let plist: string;
    try { plist = readFileSync(path.join(dir, "info.plist"), "utf8"); } catch { continue; }
    const project = /<key>WorkspacePath<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1];
    if (!project) continue;
    const variants = [project, project.startsWith("/tmp/") ? `/private${project}` : project];
    if (!variants.some(p => [...prefixes].some(pre => p === pre || p.startsWith(`${pre}/`)))) continue;
    if (variants.some(exists)) continue;
    rmSync(dir, { recursive: true, force: true });
    removed++;
  }
  return removed;
}

function exists(p: string): boolean {
  try { realpathSync(p); return true; } catch { return false; }
}

function real(p: string): string {
  try { return realpathSync(p); } catch { return p; }
}
