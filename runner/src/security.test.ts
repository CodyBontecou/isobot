import assert from "node:assert/strict";
import { test } from "node:test";
import { formatCheckIn, type NeedsMe } from "./chatTools.js";
import { validateConfig } from "./config.js";
import { itemSource } from "./dashboard.js";
import { cvssSeverity, findingId, leakHints, parseFindings, parseOsv, SecurityAudit, securityDetailKey, securityTask } from "./security.js";
import { Store } from "./store.js";
import { FakeGitHub, testConfig } from "./testing.js";

// Shapes as osv-scanner 2.7 prints them (2026-11); packages and ids are real advisories, paths made up.
const OSV = {
  results: [
    {
      source: { path: "/w/repo/worker/package-lock.json" },
      packages: [
        {
          package: { name: "undici", version: "7.28.0", ecosystem: "npm" },
          vulnerabilities: [
            { id: "GHSA-2m5v-pch6-74hx", summary: "undici smuggling", affected: [{ package: { name: "undici" }, ranges: [{ events: [{ introduced: "7.0.0" }, { fixed: "7.29.2" }] }] }] },
            { id: "GHSA-2gqq-gqf2-x968", summary: "minor", affected: [{ package: { name: "undici" }, ranges: [{ events: [{ fixed: "7.28.1" }] }] }] },
          ],
          groups: [{ ids: ["GHSA-2m5v-pch6-74hx"], max_severity: "7.4" }, { ids: ["GHSA-2gqq-gqf2-x968"], max_severity: "3.7" }],
        },
        {
          package: { name: "devalue", version: "5.8.2", ecosystem: "npm" },
          vulnerabilities: [{ id: "GHSA-4q55-j62x-fr9h", affected: [{ ranges: [{ events: [{ fixed: "5.8.3" }] }] }] }],
          groups: [{ ids: ["GHSA-4q55-j62x-fr9h"], max_severity: "6.3" }],
        },
      ],
    },
    {
      source: { path: "/w/repo/docs/package-lock.json" },
      packages: [{
        package: { name: "astro", version: "7.1.5", ecosystem: "npm" },
        vulnerabilities: [{ id: "GHSA-26w7-cxv4-gfx2", affected: [{ ranges: [{ events: [{ fixed: "7.1.6" }] }] }] }],
        groups: [{ ids: ["GHSA-26w7-cxv4-gfx2"], max_severity: "9.8" }],
      }],
    },
    {
      source: { path: "/w/repo/core/vendor/askama/Cargo.lock" },
      packages: [{ package: { name: "anyhow", version: "1.0.0", ecosystem: "crates.io" }, vulnerabilities: [{ id: "RUSTSEC-2026-0190" }], groups: [{ ids: ["RUSTSEC-2026-0190"], max_severity: "" }] }],
    },
  ],
};

test("cvssSeverity buckets CVSS scores; unscored advisories are low", () => {
  assert.equal(cvssSeverity("9.8"), "critical");
  assert.equal(cvssSeverity("7.0"), "high");
  assert.equal(cvssSeverity("6.3"), "medium");
  assert.equal(cvssSeverity(""), "low");
});

test("parseOsv groups by lockfile, worst first, skips vendored code, and finds the lowest fix", () => {
  const reports = parseOsv(OSV, "/w/repo");
  assert.deepEqual(reports.map(r => r.path), ["docs/package-lock.json", "worker/package-lock.json"]);
  assert.equal(reports[0].severity, "critical");
  const undici = reports[1].packages.find(p => p.name === "undici")!;
  assert.deepEqual(undici.advisories.map(a => [a.id, a.severity, a.fixed]), [["GHSA-2m5v-pch6-74hx", "high", "7.29.2"], ["GHSA-2gqq-gqf2-x968", "low", "7.28.1"]]);
});

test("leakHints drops generic-api-key noise outside source files but keeps specific rules", () => {
  const hints = leakHints([
    { RuleID: "generic-api-key", File: "app/src/test/resources/signature.json", StartLine: 6503 },
    { RuleID: "generic-api-key", File: "marketing/public/404.html", StartLine: 285 },
    { RuleID: "generic-api-key", File: "apps/android/screenshots/enhance.py", StartLine: 18 },
    { RuleID: "generic-api-key", File: "app/src/test/java/ExportTest.kt", StartLine: 20 },
    { RuleID: "private-key", File: "docs/sample.pem", StartLine: 1 },
    { RuleID: "private-key", File: "vendor/lib/key.pem", StartLine: 1 },
  ]);
  assert.deepEqual(hints.map(h => `${h.rule} ${h.file}`), ["private-key docs/sample.pem", "generic-api-key apps/android/screenshots/enhance.py"]);
});

test("parseFindings cleans the agent's answer and findingId ignores line numbers and titles", () => {
  const { findings } = parseFindings({ summary: "ok", findings: [
    { title: "Token in script", publicTitle: "", severity: "huge", category: "Hardcoded Secret", files: ["a.py:18"], detail: "d", fix: "f", confidence: 3, ownerAction: "" },
    { title: "", files: ["x"] },
  ] });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "low");
  assert.equal(findings[0].category, "hardcoded-secret");
  assert.equal(findings[0].publicTitle, "Token in script");
  assert.equal(findings[0].confidence, 1);
  assert.equal(findingId("o/r", { category: "hardcoded-secret", files: ["a.py:18"] }), findingId("O/R", { category: "hardcoded-secret", files: ["a.py:40"] }));
});

function setup(agentOutput: unknown) {
  const config = testConfig();
  config.security = { autoApprove: true, repos: ["codybontecou/health-md"] };
  const store = new Store(":memory:");
  const github = new FakeGitHub();
  github.publicRepos.add("codybontecou/health-md");
  github.secretAlerts.set("codybontecou/health-md", [{ number: 1, type: "Replicate API Token", url: "https://github.com/codybontecou/health-md/security/secret-scanning/1", publiclyLeaked: true, createdAt: "2026-07-25T02:48:21Z", locations: ["scripts/enhance.py:18"] }]);
  let sha = "a".repeat(40);
  const prompts: string[] = [];
  const posted: string[] = [];
  const audit = new SecurityAudit({
    config, store, github,
    repo: () => ({ sync: async () => sha, checkoutAt: async () => "/w/repo", removeWorkspace: async () => undefined, diff: async () => "+const x = 1" }),
    exec: async cmd => cmd === "osv-scanner"
      ? { code: 1, stdout: JSON.stringify(OSV), stderr: "", timedOut: false }
      : { code: 0, stdout: "[]", stderr: "", timedOut: false },
    agent: async input => { prompts.push(input.prompt); return { output: agentOutput }; },
    notify: async text => { posted.push(text); },
    now: () => new Date(2026, 10, 28, 2, 0),
  });
  return { audit, store, github, prompts, posted, setSha: (s: string) => { sha = s; } };
}

const FINDING = {
  title: "Replicate token hardcoded in scripts/enhance.py", publicTitle: "Move the screenshot script's API token to configuration",
  severity: "high", category: "hardcoded-secret", files: ["scripts/enhance.py:18"],
  detail: "The token is in a public repository; anyone can bill the account.", fix: "Read REPLICATE_API_TOKEN from the environment.",
  confidence: 0.95, ownerAction: "Revoke the Replicate token and issue a new one.",
};

test("a night's audit files dependency and code issues, keeps details off a public repo, and doesn't refile", async () => {
  const { audit, store, github, prompts, posted, setSha } = setup({ summary: "One leaked token.", findings: [FINDING, { ...FINDING, title: "Low thing", severity: "low", category: "other", files: ["b.ts"] }] });
  const { repo, filed } = await audit.tick();
  assert.equal(repo, "codybontecou/health-md");
  // Critical docs lockfile, high worker lockfile, the high code finding; the low one isn't filed.
  assert.equal(filed.length, 3);
  assert.match(prompts[0], /Review the whole repository/);
  assert.match(prompts[0], /Replicate API Token \(publicly leaked\)/);
  const issues = [...github.issues.values()];
  const code = issues.find(i => i.title.startsWith("Security hardening"))!;
  assert.equal(code.title, "Security hardening: Move the screenshot script's API token to configuration");
  assert.ok(!code.body.includes("bill the account"), "details stay off the public issue");
  assert.deepEqual(code.labels, ["isobot:ready", "isobot:auto", "security"]);
  const dep = issues.find(i => i.title === "Update vulnerable dependencies in worker/package-lock.json")!;
  assert.match(dep.body, /GHSA-2m5v-pch6-74hx/);
  assert.ok(!dep.body.includes("GHSA-2gqq-gqf2-x968"), "only high-or-worse advisories are listed");
  assert.match(dep.body, /\| undici \| 7\.28\.0 \|.*\| 7\.29\.2 \|/);
  assert.equal(itemSource(code.body).kind, "security");
  // The builder's task gets the private details back.
  const task = securityTask(code.body, store)!;
  assert.match(task, /bill the account/);
  assert.match(task, /Security fix rules/);
  assert.match(securityTask(dep.body, store)!, /dependency bump/);
  assert.equal(securityTask("an ordinary issue", store), null);
  assert.match(posted[0], /Security audit.*opened 3 issues/s);

  // Same day: nothing to do. Next night with a new commit: a diff review, nothing filed twice.
  assert.equal((await audit.tick()).repo, null);
  setSha("b".repeat(40));
  const later = setup({ summary: "", findings: [FINDING] });
  void later;
  const next = new SecurityAudit({ ...(audit as unknown as { deps: ConstructorParameters<typeof SecurityAudit>[0] }).deps, now: () => new Date(2026, 10, 29, 2, 0) });
  const again = await next.tick();
  assert.equal(again.filed.length, 0);
  assert.match(prompts[1], /Review the commits since the last audit/);
  assert.match(prompts[1], /Findings already filed earlier/);

  const { flags, lines } = next.checkIn();
  assert.ok(flags.some(f => /rotate the leaked Replicate API Token/.test(f)));
  assert.ok(flags.some(f => /Revoke the Replicate token/.test(f)));
  assert.match(lines[0], /codybontecou\/health-md/);
  const text = formatCheckIn({ review: [], ship: [], failed: [], releaseFailed: [], proposals: [], pulls: [], runner: { paused: false, usageLimitPauseUntil: null, lastCycleError: null } } as NeedsMe, [], undefined, undefined, undefined, { lines, flags })!;
  assert.match(text, /\*\*Security\*\*/);
  assert.ok(store.cursor(securityDetailKey(findingId("codybontecou/health-md", { category: "hardcoded-secret", files: ["scripts/enhance.py"] }))));
});

test("a private repository's code issue carries the details", async () => {
  const { audit, github } = setup({ summary: "", findings: [FINDING] });
  github.publicRepos.clear();
  await audit.tick(true);
  const code = [...github.issues.values()].find(i => i.title.startsWith("Security:"))!;
  assert.match(code.body, /bill the account/);
});

test("outside its hours the audit waits; a scanner failure is reported, not fatal", async () => {
  const { audit, store } = setup({ summary: "", findings: [] });
  const day = new SecurityAudit({ ...(audit as unknown as { deps: ConstructorParameters<typeof SecurityAudit>[0] }).deps, now: () => new Date(2026, 10, 28, 14, 0) });
  assert.equal((await day.tick()).repo, null);
  const broken = new SecurityAudit({
    ...(audit as unknown as { deps: ConstructorParameters<typeof SecurityAudit>[0] }).deps,
    exec: async () => ({ code: 2, stdout: "", stderr: "boom", timedOut: false }),
  });
  await broken.tick(true);
  assert.ok(store.cursor("security:error:osv-scanner"));
  assert.ok(broken.checkIn().flags.some(f => /couldn't run.*osv-scanner/.test(f)));
});

test("validateConfig checks the security block", () => {
  const config = testConfig();
  config.security = { minSeverity: "low" as never };
  assert.throws(() => validateConfig(config), /security.minSeverity/);
  config.security = { repos: ["nobody/nothing"] };
  assert.throws(() => validateConfig(config), /security.repos/);
});
