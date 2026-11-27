import assert from "node:assert/strict";
import { mkdtempSync, existsSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runChecks } from "./checks.js";
import { sandboxProfile } from "./sandbox.js";
import { canSandbox } from "./testing.js";

const mac = canSandbox;

test("sandboxed checks can work in the workspace but not read secrets, the keychain or write elsewhere", { skip: !mac }, async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "isobot-sbx-ws-"));
  const secretDir = mkdtempSync(path.join(homedir(), ".isobot-sbx-secret-"));
  const secret = path.join(secretDir, "runner.env");
  writeFileSync(secret, "TOKEN=x\n");
  const outside = path.join(secretDir, "planted.txt");
  const profile = sandboxProfile({ workspace, secrets: [secret] });
  try {
    const report = await runChecks(workspace, [
      "echo ok > built.txt",
      `if cat "${secret}" >/dev/null 2>&1; then exit 10; fi`,
      `if echo x > "${outside}" 2>/dev/null; then exit 11; fi`,
      `if echo x > "$HOME/.zshrc.isobot-sbx" 2>/dev/null; then exit 12; fi`,
      "if security find-generic-password -s isobot-sandbox-probe >/dev/null 2>&1; then exit 13; fi; security list-keychains >/dev/null 2>&1; true",
    ], { sandboxProfile: profile, timeoutMs: 60_000 });
    assert.deepEqual(report.results.map(r => [r.command.slice(0, 20), r.ok]), report.results.map(r => [r.command.slice(0, 20), true]),
      report.results.map(r => `${r.command}: ${r.output}`).join("\n"));
    assert.ok(existsSync(path.join(workspace, "built.txt")));
    assert.ok(!existsSync(outside));
  } finally {
    const { rmSync } = await import("node:fs");
    rmSync(secretDir, { recursive: true, force: true });
    rmSync(path.join(homedir(), ".zshrc.isobot-sbx"), { force: true });
  }
});

test("the same commands run unsandboxed only when no profile is given", { skip: !mac }, async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "isobot-sbx-ws-"));
  const report = await runChecks(workspace, ["echo hi > out.txt"], { timeoutMs: 30_000 });
  assert.equal(report.passed, true);
});

test("swift and xcodebuild work inside the check sandbox through the shims", { skip: !mac || !existsSync("/usr/bin/xcodebuild") }, async () => {
  const { ensureShims } = await import("./shims.js");
  const { mkdirSync } = await import("node:fs");
  const home = mkdtempSync(path.join(tmpdir(), "isobot-shims-"));
  const workspace = mkdtempSync(path.join(tmpdir(), "isobot-swift-"));
  mkdirSync(path.join(workspace, "Sources", "Demo"), { recursive: true });
  writeFileSync(path.join(workspace, "Package.swift"), '// swift-tools-version:5.9\nimport PackageDescription\nlet package = Package(name: "Demo", targets: [.target(name: "Demo")])\n');
  writeFileSync(path.join(workspace, "Sources", "Demo", "Demo.swift"), "public func sum(_ a: Int, _ b: Int) -> Int { a + b }\n");
  const report = await runChecks(workspace, ["swift build", "xcodebuild -version"], {
    sandboxProfile: sandboxProfile({ workspace, secrets: [] }), shimDir: ensureShims(home), timeoutMs: 5 * 60_000,
  });
  assert.ok(report.passed, report.results.map(r => `${r.command}: ${r.output.slice(-800)}`).join("\n"));
});
