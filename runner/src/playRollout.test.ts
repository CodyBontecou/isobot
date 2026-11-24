import assert from "node:assert/strict";
import { test } from "node:test";
import { validateConfig, type RunnerConfig } from "./config.js";
import type { PlayIssue } from "./crashes.js";
import { nextStage, PlayRollout, stageIndex, type TrackRelease } from "./playRollout.js";
import { Store } from "./store.js";
import { testConfig } from "./testing.js";

const PKG = "com.example.app";

/** A Play with one production track, recording every change; shapes as the Publisher and Reporting APIs return them. */
class FakePlay {
  releases: TrackRelease[] = [
    { name: "2.1.0", versionCodes: ["21"], status: "inProgress", userFraction: 0.2, releaseNotes: [{ language: "en-US", text: "Fixes" }] },
    { name: "2.0.0", versionCodes: ["20"], status: "completed" },
  ];
  lifecycle = "RELEASE_LIFECYCLE_STATE_PUBLISHED";
  issues: PlayIssue[] = [];
  rateRows: unknown[] = [];
  puts: TrackRelease[][] = [];
  commits = 0;
  deleted = 0;
  private draft: TrackRelease[] | null = null;

  async json(_scope: string, url: string, init: { method?: string; body?: unknown } = {}): Promise<unknown> {
    const method = init.method ?? "GET";
    if (url.endsWith("/edits") && method === "POST") { this.draft = structuredClone(this.releases); return { id: "e1" }; }
    if (url.endsWith("/edits/e1/tracks/production") && method === "GET") return { track: "production", releases: this.draft };
    if (url.endsWith("/edits/e1/tracks/production") && method === "PUT") {
      this.draft = (init.body as { releases: TrackRelease[] }).releases;
      this.puts.push(this.draft);
      return init.body;
    }
    if (url.includes("/edits/e1:commit")) { this.releases = this.draft!; this.commits++; return {}; }
    if (url.endsWith("/edits/e1") && method === "DELETE") { this.deleted++; return null; }
    if (url.endsWith("/tracks/production/releases")) {
      return { releases: this.releases.map(r => ({ releaseName: r.name, activeArtifacts: r.versionCodes!.map(c => ({ versionCode: Number(c) })), releaseLifecycleState: r.name === "2.1.0" ? this.lifecycle : "RELEASE_LIFECYCLE_STATE_PUBLISHED" })) };
    }
    if (url.includes("errorIssues:search")) return { errorIssues: this.issues };
    if (url.includes("RateMetricSet:query")) return { rows: this.rateRows };
    throw new Error(`unexpected ${method} ${url}`);
  }
}

const issue = (id: string, users: number, first: string): PlayIssue => ({
  name: `apps/${PKG}/${id}`, type: "CRASH", cause: "com.example.export.Exporter.write", location: "java.lang.IllegalStateException",
  errorReportCount: String(users * 2), distinctUsers: String(users), lastErrorReportTime: "2026-11-24T02:00:00Z",
  firstAppVersion: { versionCode: first }, lastAppVersion: { versionCode: first },
});

function setup(extra: Partial<RunnerConfig> = {}) {
  const config = { ...testConfig(), playRollout: {}, ...extra } as RunnerConfig;
  config.repos = { "owner/app": { aso: { appId: "123", play: { packageName: PKG } } } as RunnerConfig["repos"][string] };
  const store = new Store(":memory:");
  const play = new FakePlay();
  const posts: string[] = [];
  let now = new Date("2026-11-24T12:00:00Z");
  const rollout = new PlayRollout({ config, store, google: play, notify: async t => { posts.push(t); }, now: () => now });
  return { rollout, play, posts, store, later: (days: number) => { now = new Date(now.getTime() + days * 86_400_000); } };
}

test("stages: where a fraction sits and what comes next", () => {
  const stages = [0.2, 0.5, 1];
  assert.equal(stageIndex(stages, 0.05), 0);
  assert.equal(stageIndex(stages, 0.2), 0);
  assert.equal(stageIndex(stages, 0.3), 0);
  assert.equal(stageIndex(stages, 0.5), 1);
  assert.equal(nextStage(stages, 0.05), 0.2);
  assert.equal(nextStage(stages, 0.3), 0.5);
  assert.equal(nextStage(stages, 0.5), 1);
});

test("a live rollout holds 2 days at 20%, 5 at 50%, then goes to everyone", async () => {
  const { rollout, play, posts, later } = setup();
  assert.equal((await rollout.tick(true))[0].action, "wait");
  assert.equal(play.commits, 0);
  later(1.9);
  assert.equal((await rollout.tick(true))[0].action, "wait");
  later(0.2);
  assert.equal((await rollout.tick(true))[0].action, "advance");
  assert.equal(play.commits, 1);
  // Only the staged release changes; the completed one it replaces stays.
  assert.deepEqual(play.releases.map(r => [r.name, r.status, r.userFraction]), [["2.1.0", "inProgress", 0.5], ["2.0.0", "completed", undefined]]);
  assert.match(posts.at(-1)!, /20% → \*\*50%\*\* of users/);
  later(4.9);
  assert.equal((await rollout.tick(true))[0].action, "wait");
  later(0.2);
  assert.equal((await rollout.tick(true))[0].action, "advance");
  assert.equal(play.releases[0].status, "completed");
  assert.equal("userFraction" in play.releases[0], false);
  assert.match(posts.at(-1)!, /\*\*everyone\*\*/);
  assert.equal((await rollout.tick(true))[0].action, "none");
});

test("nothing moves while Google is reviewing the release, and hold time starts once it's live", async () => {
  const { rollout, play, later } = setup();
  play.lifecycle = "RELEASE_LIFECYCLE_STATE_IN_REVIEW";
  later(10);
  const plan = await rollout.plan(PKG);
  assert.equal(plan.action, "wait");
  assert.match((plan as { why: string }).why, /review/);
  play.lifecycle = "RELEASE_LIFECYCLE_STATE_APPROVED_NOT_PUBLISHED";
  assert.match((await rollout.plan(PKG) as { why: string }).why, /press Publish/);
  play.lifecycle = "RELEASE_LIFECYCLE_STATE_PUBLISHED";
  assert.equal((await rollout.plan(PKG)).action, "wait");
  later(2.1);
  assert.equal((await rollout.plan(PKG)).action, "advance");
});

test("a percentage changed by hand starts its hold again", async () => {
  const { rollout, play, later } = setup();
  await rollout.plan(PKG);
  later(1.5);
  play.releases[0].userFraction = 0.3;
  assert.equal((await rollout.plan(PKG)).action, "wait");
  later(1);
  assert.equal((await rollout.plan(PKG)).action, "wait");
  later(1.1);
  const plan = await rollout.plan(PKG);
  assert.equal(plan.action, "advance");
  assert.equal((plan as { next: number }).next, 0.5);
});

test("a crash new in this version halts the rollout; older crashes don't", async () => {
  const { rollout, play, posts, later } = setup();
  play.issues = [issue("old", 9, "20"), issue("tiny", 1, "21")];
  await rollout.plan(PKG);
  later(3);
  assert.equal((await rollout.plan(PKG)).action, "advance");
  play.issues.push(issue("new", 3, "21"));
  const [plan] = await rollout.tick(true);
  assert.equal(plan.action, "halt");
  assert.equal(play.releases[0].status, "halted");
  assert.equal(play.releases[0].userFraction, 0.2);
  assert.match(posts.at(-1)!, /halted the Google Play rollout at 20%/);
  assert.match(posts.at(-1)!, /IllegalStateException in Exporter\.write.*new in this version/);
  // Halted stays halted until someone resumes it.
  later(10);
  assert.equal((await rollout.tick(true))[0].action, "wait");
  assert.equal(play.commits, 1);
});

test("resume accepts the crashes it halted for, so they don't halt it again", async () => {
  const { rollout, play, later } = setup();
  play.issues = [issue("new", 3, "21")];
  await rollout.tick(true);
  assert.equal(play.releases[0].status, "halted");
  assert.match(await rollout.resume(PKG), /resumed 2\.1\.0 at 20%/);
  assert.equal(play.releases[0].status, "inProgress");
  later(2.1);
  assert.equal((await rollout.plan(PKG)).action, "advance");
  // A different new crash still halts.
  play.issues.push({ ...issue("other", 4, "21"), cause: "com.example.sync.Worker.run" });
  assert.equal((await rollout.plan(PKG)).action, "halt");
});

test("a bad user-perceived crash rate for this version halts it, when Play has enough users to report one", async () => {
  const { rollout, play, later } = setup();
  const row = (code: string, rate: string, users: string) => ({
    dimensions: [{ dimension: "versionCode", stringValue: code }],
    metrics: [{ metric: "userPerceivedCrashRate", decimalValue: { value: rate } }, { metric: "distinctUsers", decimalValue: { value: users } }],
  });
  await rollout.plan(PKG);
  later(3);
  play.rateRows = [row("21", "0.03", "20"), row("20", "0.05", "900")];
  assert.equal((await rollout.plan(PKG)).action, "advance");
  play.rateRows = [row("21", "0.03", "120")];
  const plan = await rollout.plan(PKG);
  assert.equal(plan.action, "halt");
  assert.match((plan as { why: string[] }).why[0], /crash rate 3\.00%/);
});

test("a failed read waits and is posted once", async () => {
  const { rollout, play, posts } = setup();
  play.json = async () => { throw new Error("HTTP 500"); };
  await rollout.tick(true);
  await rollout.tick(true);
  assert.equal(posts.filter(p => p.includes("couldn't check")).length, 1);
  assert.equal(play.commits, 0);
});

test("playRollout config is checked", () => {
  const bad = (playRollout: unknown) => assert.throws(() => validateConfig({ ...testConfig(), playRollout } as RunnerConfig));
  bad({ stages: [0.5, 0.2, 1] });
  bad({ stages: [0.2, 0.5] });
  bad({ holdDays: [2] });
  bad({ minUsers: 0 });
  validateConfig({ ...testConfig(), playRollout: { stages: [0.1, 1], holdDays: [3] } } as RunnerConfig);
  assert.deepEqual(testConfig().playRollout, {});
});
