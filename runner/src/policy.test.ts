import assert from "node:assert/strict";
import { test } from "node:test";
import type { RepoPolicy } from "./config.js";
import { evaluateGate, matchesGlob, type GateInput } from "./policy.js";

const policy: RepoPolicy = {
  autonomy: "merge", checks: ["npm test"], protectedPaths: [".github/**", "**/*auth*/**", "**/Info.plist"],
  maxChangedLines: 100, minReviewConfidence: 0.85, requireCi: true, release: { onMerge: [], onShip: [] },
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
    [{ diff: { files: [{ path: "a.ts", added: 200, removed: 0, binary: false }], changedLines: 200 } }, /exceed/],
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
