import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * SwiftPM and xcodebuild sandbox package manifests and plugins with sandbox-exec, and macOS
 * can't nest one Seatbelt sandbox inside another. Inside isobot's sandbox (which already
 * confines the whole build) these wrappers turn the inner sandbox off, so `swift test` and
 * `xcodebuild` just work for builders and checks. They are only put on PATH for sandboxed runs.
 */
const SHIMS: Record<string, string> = {
  xcodebuild: `#!/bin/sh
exec /usr/bin/xcodebuild -IDEPackageSupportDisableManifestSandbox=YES -IDEPackageSupportDisablePluginExecutionSandbox=YES "$@"
`,
  swift: `#!/bin/sh
case "$1" in
  build|test|run|package) sub="$1"; shift; exec /usr/bin/swift "$sub" --disable-sandbox "$@" ;;
  *) exec /usr/bin/swift "$@" ;;
esac
`,
};

/** Writes the wrappers into `<home>/shims` and returns that directory. */
export function ensureShims(home: string): string {
  const dir = path.join(home, "shims");
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(SHIMS)) {
    const file = path.join(dir, name);
    writeFileSync(file, body);
    chmodSync(file, 0o755);
  }
  return dir;
}
