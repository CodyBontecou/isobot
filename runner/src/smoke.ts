/**
 * End-to-end smoke test with the real Claude Code builder and reviewer, a real
 * git repository and real checks, but an in-memory GitHub and a throwaway local
 * origin, so nothing outside this machine changes. Uses subscription usage.
 *
 *   npm --prefix runner run smoke
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ClaudeCodeBuilder } from "./builder.js";
import { loadConfig } from "./config.js";
import { Repo } from "./git.js";
import { Notifier } from "./notify.js";
import { Pipeline } from "./pipeline.js";
import { setGitIdentity } from "./proc.js";
import { runChecks } from "./checks.js";
import { sandboxProfile } from "./sandbox.js";
import { ensureShims } from "./shims.js";
import { Store } from "./store.js";
import { FakeGitHub } from "./testing.js";

const root = mkdtempSync(path.join(tmpdir(), "isobot-smoke-"));
const origin = path.join(root, "origin.git");
const seed = path.join(root, "seed");
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

execFileSync("git", ["init", "--bare", "-q", "-b", "main", origin]);
execFileSync("git", ["clone", "-q", origin, seed]);
// `--swift` exercises the Xcode toolchain inside the builder and check sandboxes.
const swift = process.argv.includes("--swift");
if (swift) {
  mkdirSync(path.join(seed, "Sources", "Demo"), { recursive: true });
  mkdirSync(path.join(seed, "Tests", "DemoTests"), { recursive: true });
  writeFileSync(path.join(seed, "Package.swift"), [
    "// swift-tools-version:5.9",
    "import PackageDescription",
    'let package = Package(name: "Demo", platforms: [.macOS(.v14)], targets: [.target(name: "Demo"), .testTarget(name: "DemoTests", dependencies: ["Demo"])])',
    "",
  ].join("\n"));
  writeFileSync(path.join(seed, "Sources", "Demo", "Math.swift"), "public func sum(_ a: Int, _ b: Int) -> Int { a + b }\n");
  writeFileSync(path.join(seed, "Tests", "DemoTests", "MathTests.swift"),
    "import XCTest\n@testable import Demo\nfinal class MathTests: XCTestCase {\n  func testSum() { XCTAssertEqual(Demo.sum(2, 3), 5) }\n}\n");
  writeFileSync(path.join(seed, ".gitignore"), ".build/\n");
} else {
  mkdirSync(path.join(seed, "test"));
  writeFileSync(path.join(seed, "package.json"), JSON.stringify({ name: "demo", type: "module", scripts: { test: "node --test" } }, null, 2));
  writeFileSync(path.join(seed, "math.js"), "export function add(a, b) {\n  return a + b;\n}\n");
  writeFileSync(path.join(seed, "test", "math.test.js"), [
    'import assert from "node:assert/strict";',
    'import { test } from "node:test";',
    'import { add } from "../math.js";',
    "",
    'test("add", () => assert.equal(add(2, 3), 5));',
    "",
  ].join("\n"));
}
git(seed, "add", "-A");
git(seed, "commit", "-q", "-m", "init");
git(seed, "push", "-q", "origin", "HEAD:main");

setGitIdentity("isobot smoke", "smoke@example.com");
const config = loadConfig();
config.repos = { "local/demo": { autonomy: "merge", checks: [swift ? "swift test" : "npm test"], requireCi: false } };
config.trustedAuthors = ["owner"];
config.builder.timeoutMinutes = 15;
config.builder.maxTurns = 80;
const github = new FakeGitHub();
github.add("local", "demo", 1, "Add a multiply function", ["isobot:ready"], swift
  ? "Add `public func multiply(_ a: Int, _ b: Int) -> Int` next to `sum` in Sources/Demo/Math.swift, with an XCTest next to the existing one. Run `swift test` to verify."
  : "Add `multiply(a, b)` to math.js, exported like `add`, with a unit test next to the existing one.");
const store = new Store(path.join(root, "runner.sqlite"));
const shimDir = ensureShims(path.join(root, "home"));
const pipeline = new Pipeline({
  config, env: { home: root }, store, github,
  builder: new ClaudeCodeBuilder(config.builder, { secrets: [path.join(root, "runner.sqlite")], noWrite: [path.join(root, "home", "repos")] }, process.env.ISOBOT_CLAUDE_BIN ?? "claude", shimDir),
  notifier: new Notifier(),
  repo: (owner, repo) => new Repo(path.join(root, "home"), owner, repo, "unused-token", origin),
  // The same confinement the service uses for checks.
  checks: (cwd, commands, options) => runChecks(cwd, commands, {
    timeoutMs: options.timeoutMs,
    sandboxProfile: options.sandbox ? sandboxProfile({ workspace: cwd, secrets: [path.join(root, "runner.sqlite")] }) : undefined,
    shimDir,
  }),
});

const started = Date.now();
console.log(`[smoke] workspace ${root}`);
await pipeline.discover();
await Promise.all(pipeline.startQueued());
const job = store.get("local/demo#1")!;
const pr = job.prNumber ? github.pulls.get(job.prNumber) : undefined;
console.log(`[smoke] finished in ${Math.round((Date.now() - started) / 1000)}s: state=${job.state}${job.lastError ? ` error=${job.lastError}` : ""}`);
console.log(`[smoke] events:\n${store.events(job.id).reverse().map(e => `  ${e.kind}: ${(e.detail ?? "").split("\n")[0].slice(0, 160)}`).join("\n")}`);
if (pr) console.log(`[smoke] PR body:\n${pr.body}`);
console.log(`[smoke] issue comments:\n${github.commentsFor("local", "demo", 1).map(c => `  - ${c.split("\n")[0]}`).join("\n")}`);
const branch = job.branch ?? "";
const pushed = branch ? git(origin, "branch", "--list", branch) : "";
const source = pushed ? git(origin, "show", `${branch}:${swift ? "Sources/Demo/Math.swift" : "math.js"}`) : "";
const ok = job.state === "merged" && /multiply/.test(source);
console.log(ok ? "[smoke] PASS: built, verified, reviewed, pushed and merged" : "[smoke] FAIL");
process.exit(ok ? 0 : 1);
