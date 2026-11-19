import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { loadConfig, type RepoPolicy } from "./config.js";
import { evaluateGate, matchesGlob, reviewStopReason, skipMarkers, type GateInput } from "./policy.js";
import type { Review } from "./builder.js";

const policy: RepoPolicy = {
  autonomy: "merge", checks: ["npm test"], protectedPaths: [".github/**", "**/*auth*/**", "**/Info.plist"],
  minReviewConfidence: 0.85, requireCi: true, release: { onMerge: [], onShip: [] },
};

function input(overrides: Partial<GateInput> = {}): GateInput {
  return {
    policy,
    diff: { files: [{ path: "src/view.swift", added: 10, removed: 2, binary: false }], changedLines: 12 },
    checks: { configured: true, passed: true, results: [{ command: "npm test", ok: true, output: "" }] },
    review: { verdict: "approve", confidence: 0.9, risk: "low", summary: "ok", concerns: [] },
    issueLabels: [], stopLabel: "isobot:stop",
    ...overrides,
  };
}

test("globs match directories, files and case-insensitively", () => {
  assert.ok(matchesGlob(".github/workflows/ci.yml", ".github/**"));
  assert.ok(matchesGlob("App/Auth/Login.swift", "**/*auth*/**"));
  assert.ok(matchesGlob("Auth/Login.swift", "**/*auth*/**"));
  assert.ok(matchesGlob("App/Info.plist", "**/Info.plist"));
  assert.ok(matchesGlob("Info.plist", "**/Info.plist"));
  assert.ok(!matchesGlob("App/View.swift", "**/*auth*/**"));
  assert.ok(!matchesGlob("src/github.ts", ".github/**"));
  assert.ok(matchesGlob("a/b.ts", "a/?.ts"));
  assert.ok(!matchesGlob("a/b/c.ts", "a/*.ts"));
});

test("a clean, approved, verified change merges", () => {
  assert.deepEqual(evaluateGate(input()), { merge: true, reasons: [] });
});

test("pr autonomy never merges", () => {
  const decision = evaluateGate(input({ policy: { ...policy, autonomy: "pr" } }));
  assert.equal(decision.merge, false);
  assert.match(decision.reasons[0], /human merges/);
});

test("every gate blocks on its own", () => {
  const cases: [Partial<GateInput>, RegExp][] = [
    [{ checks: { configured: false, passed: true, results: [] } }, /no runner checks/],
    [{ checks: { configured: true, passed: false, results: [] } }, /checks failed/],
    [{ review: { verdict: "request_changes", confidence: 0.9, risk: "low", summary: "", concerns: [] } }, /requested changes/],
    [{ review: { verdict: "approve", confidence: 0.5, risk: "low", summary: "", concerns: [] } }, /confidence 0.50/],
    [{ review: { verdict: "approve", confidence: 0.99, risk: "high", summary: "", concerns: [] } }, /high risk/],
    [{ diff: { files: [{ path: "App/Auth/Token.swift", added: 1, removed: 0, binary: false }], changedLines: 1 } }, /protected paths: App\/Auth\/Token.swift/],
    [{ diff: { files: [{ path: "AppTests/LoginTests.swift", added: 1, removed: 9, binary: false }], changedLines: 10 } }, /removes more test lines/],
    [{ diff: { files: [{ path: "src/x.test.ts", added: 0, removed: 4, binary: false }], changedLines: 4 } }, /removes more test lines/],
    [{ issueLabels: ["ISOBOT:STOP"] }, /stop label/],
    [{ diff: { files: [], changedLines: 0 } }, /empty/],
  ];
  for (const [overrides, reason] of cases) {
    const decision = evaluateGate(input(overrides));
    assert.equal(decision.merge, false, `expected block for ${reason}`);
    assert.ok(decision.reasons.some(r => reason.test(r)), `${reason} not in ${decision.reasons.join("; ")}`);
  }
});

test("adding tests is not treated as weakening them", () => {
  const decision = evaluateGate(input({ diff: { files: [{ path: "AppTests/NewTests.swift", added: 30, removed: 2, binary: false }], changedLines: 32 } }));
  assert.equal(decision.merge, true);
});

test("the default protected paths cover auth, purchase and credential files, not just folders", () => {
  const globs = loadConfig(path.join(import.meta.dirname, "..", "config", "isobot.json")).defaults.protectedPaths;
  const isProtected = (file: string) => globs.some(glob => matchesGlob(file, glob));
  for (const file of [
    "Sources/AuthManager.swift", "App/PurchaseManager.swift", "IsoMe/Services/StoreManager.swift",
    "Sync.md/Services/OAuthService.swift", "Sync.md/Services/KeychainService.swift", "cloudflare/src/account-auth.ts",
    "ios/Isobot/App/GitHubSignIn.swift", "ios/Isobot/App/CredentialStore.swift", "src/auth.ts",
    "android/app/src/main/kotlin/x/billing/BillingGateway.kt", "InstaReply/PaywallView.swift",
    "Sync.md/Services/AppUnlock.swift", "app/src/main/AndroidManifest.xml", "App/PrivacyInfo.xcprivacy",
    "App/HealthAuthorizationView.swift", "LoginScreen.kt",
  ]) assert.ok(isProtected(file), `${file} should be protected`);
  for (const file of [
    "src/view.swift", "HealthProviderCaptureAuthority.kt", "CaptureDateTokenValues.swift", "docs/authors.md", "src/github.ts",
  ]) assert.ok(!isProtected(file), `${file} should not be protected`);
});

function patch(file: string, lines: string): string {
  return `diff --git a/${file} b/${file}\nindex 1..2 100644\n--- a/${file}\n+++ b/${file}\n@@ -1,0 +1,1 @@\n${lines}\n`;
}

test("skip markers: adding one anywhere counts, moving or removing one doesn't", () => {
  const added = [
    ["src/a.test.ts", `+  it.skip("flaky", () => {});`],
    ["src/b.test.ts", `+test("x", { skip: true }, () => {});`],
    ["src/c.spec.ts", `+  describe.only("focus", () => {});`],
    ["src/d.spec.ts", `+  xit("later", () => {});`],
    ["AppTests/LoginTests.swift", `+    throw XCTSkip("simulator")`],
    ["AppTests/NewTests.swift", `+  @Test("sync", .disabled("broken")) func f() {}`],
    ["scripts/test-ios.sh", `+xcodebuild test -skip-testing:AppTests/StoreTests`],
    ["app/src/test/FooTest.kt", `+    @Ignore`],
    ["tests/test_x.py", `+@pytest.mark.skip(reason="no")`],
    ["src/lib.rs", `+#[ignore]`],
    ["pkg/x_test.go", `+\tt.Skip("later")`],
  ];
  for (const [file, line] of added) assert.equal(skipMarkers(patch(file, line)).length, 1, `${file}: ${line}`);
  assert.deepEqual(skipMarkers(patch("src/a.test.ts", `-  it.skip("flaky", () => {});\n+  it.skip("flaky (renamed)", () => {});`)), []);
  assert.deepEqual(skipMarkers(patch("src/a.test.ts", `-  it.skip("flaky", () => {});`)), []);
  assert.deepEqual(skipMarkers(patch("src/view.ts", `+  const skipped = items.filter(i => i.skipped);`)), []);
  assert.deepEqual(skipMarkers(patch("App/View.swift", `+    image.fit(in: rect)`)), [], "fit( is only a focus marker in JavaScript");
  assert.deepEqual(skipMarkers(patch("src/layout.ts", `+  layout.fit(rect)`)), [], "a method named fit isn't fit()");
  assert.deepEqual(skipMarkers(patch("App/Sync.kt", `+  val opts = Options(skip: true)`)), []);
  assert.deepEqual(skipMarkers(patch("App/Views/Save.swift", `+        .disabled(isSaving)`)), [], "SwiftUI's .disabled modifier");
  assert.deepEqual(skipMarkers(patch("docs/testing.md", `+Run with -skip-testing:AppTests/Slow`)), [], "docs don't run");
  const created = `diff --git a/t/new.test.ts b/t/new.test.ts\nnew file mode 100644\nindex 0..1\n--- /dev/null\n+++ b/t/new.test.ts\n@@ -0,0 +1 @@\n+it.skip("later", () => {});\n`;
  assert.deepEqual(skipMarkers(created), [], "a new file disables nothing that existed");
  // A content line that happens to look like a file header is still content.
  assert.equal(skipMarkers(patch("db/q.sql", `--- comment\n+++ x\n+-- it.skip( in sql`)).length, 1);
});

test("a change that adds a skip marker leaves the merge to a human", () => {
  const decision = evaluateGate(input({ diff: {
    files: [{ path: "src/x.test.ts", added: 1, removed: 1, binary: false }], changedLines: 2,
    skipMarkers: [{ path: "src/x.test.ts", marker: "skip/only/todo" }],
  } }));
  assert.equal(decision.merge, false);
  assert.match(decision.reasons.join(";"), /disables or narrows tests: skip\/only\/todo in src\/x.test.ts/);
});

test("reviewStopReason stops on owner-only doubts and on a stalled approval", () => {
  const review = (over: Partial<Review>): Review => ({ verdict: "approve", confidence: 0.8, risk: "medium", summary: "", concerns: ["Edge case"], blockers: [], ...over });
  assert.match(reviewStopReason(review({ concerns: [], blockers: ["Needs a device"] }), [0.8])!, /needs you/);
  assert.match(reviewStopReason(review({ verdict: "request_changes", concerns: [], blockers: ["Product call"] }), [0.5])!, /needs you/);
  // Fixable concerns alongside blockers still earn a round.
  assert.equal(reviewStopReason(review({ blockers: ["Needs a device"] }), [0.8]), null);
  // No concerns and no blockers: the builder is still asked to re-check (older behaviour).
  assert.equal(reviewStopReason(review({ concerns: [] }), [0.8]), null);
  assert.equal(reviewStopReason(review({}), [0.8, 0.8]), null);
  assert.match(reviewStopReason(review({ confidence: 0.82 }), [0.8, 0.81, 0.82])!, /stopped improving \(0\.80 → 0\.81 → 0\.82\)/);
  assert.match(reviewStopReason(review({ confidence: 0.74 }), [0.8, 0.8, 0.74])!, /stopped improving/);
  assert.equal(reviewStopReason(review({ confidence: 0.84 }), [0.72, 0.78, 0.84]), null);
  // A change request keeps going while it has fixable concerns, however the score moves.
  assert.equal(reviewStopReason(review({ verdict: "request_changes", confidence: 0.6 }), [0.6, 0.6, 0.6]), null);
});
