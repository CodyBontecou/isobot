import assert from "node:assert/strict";
import { test } from "node:test";
import { formatCheckIn, type NeedsMe } from "./chatTools.js";
import { validateConfig } from "./config.js";
import { CrashAudit, crashExcerpt, groupIssues, iosPeriods, shortWhere, stackExcerpt, type PlayIssue } from "./crashes.js";
import { itemSource } from "./dashboard.js";
import { Store } from "./store.js";
import { FakeGitHub, testConfig } from "./testing.js";

// Shapes as Play's errorIssues:search returns them (2026-11); names and numbers are made up.
const issue = (id: string, type: string, cause: string, location: string, reports: number, users: number, first: string, last = first, at = "2026-11-20T02:00:00Z"): PlayIssue => ({
  name: `apps/com.example.app/${id}`, type, cause, location, errorReportCount: String(reports), distinctUsers: String(users),
  lastErrorReportTime: at, issueUri: `https://play.google.com/console/developers/1/app/2/vitals/crashes/${id}/details`,
  firstAppVersion: { versionCode: first }, lastAppVersion: { versionCode: last },
});

const ISSUES = [
  issue("a1", "CRASH", "com.example.scheduler.Occurrence.toWorkData", "java.lang.IllegalStateException", 63, 6, "41", "48"),
  issue("a2", "CRASH", "com.example.export.JsonExporter.render", "java.lang.OutOfMemoryError", 48, 3, "48"),
  issue("a3", "CRASH", "com.example.export.JsonExporter.putTimestamp$lambda$1", "java.lang.OutOfMemoryError", 2, 1, "48"),
  issue("a4", "APPLICATION_NOT_RESPONDING", "com.example.storage.FileManager.findExistingFile", "Input dispatching timed out", 12, 1, "41"),
  issue("a5", "APPLICATION_NOT_RESPONDING", "com.example.storage.FileManager.findExistingFile", "Broadcast of Intent { act=TIME_SET }", 4, 1, "48"),
  issue("a6", "CRASH", "SourceFile - d7.a.M", "java.lang.IllegalStateException", 9, 5, "48"),
  issue("a7", "CRASH", "Widget.kt - com.example.widget.Receiver$reconcile$1.invokeSuspend", "java.lang.NullPointerException", 10, 3, "41", "48"),
];

test("groupIssues folds Play's clusters into bugs", () => {
  const groups = groupIssues(ISSUES);
  const by = (where: string) => groups.find(g => g.where === where)!;
  // Out-of-memory crashes group by class: the frame is only where the last allocation failed.
  assert.equal(by("com.example.export.JsonExporter").reports, 50);
  assert.equal(shortWhere(by("com.example.export.JsonExporter")), "JsonExporter");
  // ANRs group by the frame they block in, whatever Play's reason text says.
  const anr = by("com.example.storage.FileManager.findExistingFile");
  assert.equal(anr.kind, "anr");
  assert.equal(anr.reports, 16);
  assert.deepEqual(anr.versions, ["41", "48"]);
  // Obfuscated frames are pooled, and file names and coroutine suffixes are stripped.
  assert.equal(by("obfuscated frames").obfuscated, true);
  assert.ok(by("com.example.widget.Receiver.reconcile"));
  // Most users first.
  assert.equal(groups[0].where, "com.example.scheduler.Occurrence.toWorkData");
});

test("iosPeriods sums Apple's App Crashes rows by date and version", () => {
  const rows: Record<string, string>[] = [
    { Date: "2026-10-01", "App Version": "3.4.3", Crashes: "15", "Unique Devices": "5" },
    { Date: "2026-10-01", "App Version": "3.4.2", Crashes: "2", "Unique Devices": "1" },
    { Date: "bad", Crashes: "9" },
  ];
  const p = iosPeriods(rows, "2026-11-05").get("2026-10-01")!;
  assert.equal(p.crashes, 17);
  assert.equal(p.devices, 6);
  assert.deepEqual(p.versions["3.4.3"], { crashes: 15, devices: 5 });
});

test("crashExcerpt keeps the exception and crashed thread, not device identifiers", () => {
  const log = [
    "Incident Identifier: 1234-ABCD", "CrashReporter Key: deadbeef", "Hardware Model: iPhone17,1",
    "Exception Type:  EXC_BREAKPOINT (SIGTRAP)", "Termination Reason: SIGNAL 5 Trace/BPT trap: 5", "",
    "Thread 0 Crashed:", "0   HealthMd   0x0000000100abc123 ExportView.body.getter + 120", "1   SwiftUI    0x00000001a0000000 ViewGraph.update + 40", "",
    "Thread 1:", "0   libsystem_kernel.dylib 0x1 mach_msg + 8",
  ].join("\n");
  const text = crashExcerpt(log);
  assert.match(text, /EXC_BREAKPOINT/);
  assert.match(text, /HealthMd ExportView\.body\.getter/);
  assert.doesNotMatch(text, /Incident Identifier|CrashReporter Key|1234-ABCD|mach_msg/);
});

test("stackExcerpt keeps the app's frames and causes, and collapses recursion", () => {
  const frames = [
    "Exception java.lang.OutOfMemoryError:",
    "  at java.util.Arrays.copyOf (Arrays.java:4396)",
    ...Array.from({ length: 30 }, () => "  at kotlinx.serialization.json.JsonObjectSerializer.serialize (JsonElementSerializers.kt:159)"),
    "  at com.healthmd.data.export.JsonExporter.render (JsonExporter.kt:88)",
    "  at com.healthmd.data.export.JsonExporter.render (JsonExporter.kt:88)",
    "  at kotlinx.coroutines.DispatchedTask.run (DispatchedTask.kt:99)",
    "Caused by java.lang.IllegalStateException: too big",
    "  at androidx.work.Data.build (Data.java:525)",
  ].join("\n");
  const text = stackExcerpt(frames, "com.healthmd");
  assert.match(text, /JsonExporter\.render \(JsonExporter\.kt:88\)\n  … \d+ more frames/);
  assert.match(text, /Caused by java\.lang\.IllegalStateException/);
  assert.ok(text.split("\n").length < 15, text);
});

/** Play's reporting API, answering from fixtures. */
class FakeGoogle {
  issues = new Map<string, PlayIssue[]>();
  calls: string[] = [];
  /** Version codes live on production; empty is a track with nothing released. */
  production: number[] = [];
  productionError: Error | null = null;
  async json(_scope: string, url: string): Promise<unknown> {
    this.calls.push(url);
    if (url.endsWith("/tracks/production/releases")) {
      if (this.productionError) throw this.productionError;
      return { releases: [
        ...this.production.map(c => ({ activeArtifacts: [{ versionCode: c }], releaseLifecycleState: "RELEASE_LIFECYCLE_STATE_PUBLISHED" })),
        { activeArtifacts: [{ versionCode: 1 }], releaseLifecycleState: "RELEASE_LIFECYCLE_STATE_DRAFT" },
      ] };
    }
    const pkg = /\/apps\/([^/]+)\//.exec(url)?.[1] ?? "";
    if (url.includes("errorIssues:search")) return { errorIssues: this.issues.get(pkg) ?? [] };
    if (url.includes("errorReports:search")) return { errorReports: [{ reportText: "Exception X:\n  at com.example.Foo.bar (Foo.kt:1)", deviceModel: { marketingName: "Pixel 9" }, osVersion: { apiLevel: "36" } }] };
    if (url.includes("MetricSet:query")) return {};
    throw new Error(`unexpected ${url}`);
  }
}

/** App Store Connect through asc api, answering from fixtures. */
class FakeAsc {
  calls: string[][] = [];
  submissions: { id: string; attributes: Record<string, unknown>; relationships: { build: { data: { id: string } } } }[] = [];
  crashRows = "Date\tApp Name\tApp Apple Identifier\tApp Version\tDevice\tPlatform Version\tCrashes\tUnique Devices\n2026-11-19\tHealth.md\t6757763969\t4.0.0\tiPhone\tiOS 27.1\t3\t2\n2026-11-18\tHealth.md\t6757763969\t4.0.0\tiPhone\tiOS 27.1\t1\t1";
  async run(args: string[]) {
    this.calls.push(args);
    const path = args[2];
    const ok = (data: unknown, included: unknown[] = []) => ({ ok: true, stdout: JSON.stringify({ data, included }), stderr: "" });
    if (path.endsWith("/reports")) return ok([{ id: "r2", attributes: { name: "App Crashes" } }, { id: "r8", attributes: { name: "App Sessions Standard" } }]);
    if (path === "/v1/analyticsReports/r2/instances") return ok([{ id: "i1", attributes: { granularity: "DAILY", processingDate: "2026-11-20" } }]);
    if (path === "/v1/analyticsReportInstances/i1/segments") return ok([{ id: "s1", attributes: { url: "https://example.com/seg.gz" } }]);
    if (path.endsWith("/betaFeedbackCrashSubmissions")) return ok(this.submissions, [{ id: "b1", type: "builds", attributes: { version: "412" } }]);
    if (path.endsWith("/crashLog")) return ok({ id: "l1", attributes: { logText: "Exception Type: EXC_CRASH (SIGABRT)\nThread 0 Crashed:\n0   libsystem_kernel.dylib 0x1 __pthread_kill + 8\n1   HealthMd 0x0000000100abc123 SyncEngine.flush() + 44" } });
    return { ok: false, stdout: "", stderr: `unknown ${path}` };
  }
}

const HEALTH = "6757763969";

function setup(now = "2026-11-22T09:00:00Z") {
  const config = testConfig();
  config.crashes = {};
  const healthRepo = config.appStore!.apps[HEALTH];
  config.appStore!.apps = { [HEALTH]: healthRepo };
  const store = new Store(":memory:");
  const github = new FakeGitHub();
  const google = new FakeGoogle();
  const asc = new FakeAsc();
  const posted: string[] = [];
  const audit = new CrashAudit({
    config, store, github, google,
    asc: args => asc.run(args),
    fetchGz: async () => asc.crashRows,
    requestId: async () => "req1",
    notify: async (text, reactions = []) => { posted.push(`${text}${reactions.length ? ` [${reactions.join("")}]` : ""}`); },
    now: () => new Date(now),
  });
  const play = audit.playApps().find(a => a.repo.toLowerCase() === healthRepo.toLowerCase())!;
  return { config, store, github, google, asc, posted, audit, play, healthRepo };
}

test("a Play pass files the biggest groups as proposals, once, capped per pass", async () => {
  const t = setup();
  t.config.crashes = { issuesPerPass: 2 };
  t.google.issues.set(t.play.pkg, ISSUES);
  const [owner, repo] = t.play.repo.split("/");
  const { filed } = await t.audit.tick(true);
  assert.equal(filed.length, 2);
  const issues = [...t.github.issues.values()].filter(i => i.owner === owner && i.repo === repo);
  assert.deepEqual(issues.map(i => i.title), ["Android IllegalStateException in Occurrence.toWorkData", "Android OutOfMemoryError in JsonExporter"]);
  assert.deepEqual(issues[0].labels, [t.config.labels.proposed, "bug"]);
  assert.match(issues[0].body, /63 reports from about 6 users/);
  assert.match(issues[0].body, /at com\.example\.Foo\.bar/);
  assert.equal(itemSource(issues[0].body).kind, "crash");
  assert.match(t.posted[0], /opened 2 issues/);
  // Each issue gets its own message with ✅ / 🧹, so a reaction approves exactly that one.
  assert.equal(t.posted.length, 3);
  assert.match(t.posted[1], /^🗳 .*Occurrence\.toWorkData <https:\/\/github\.com\/.*> \[✅🧹\]$/);

  // Next pass: the rest at minUsers (2) or more; the obfuscated pool (5 users) is never filed, nor groups under 2.
  const again = await t.audit.tick(true);
  assert.deepEqual(again.filed.map(f => /: (Android .*?) </.exec(f)![1]), ["Android NullPointerException in Receiver.reconcile", "Android ANR in FileManager.findExistingFile"]);
  assert.equal((await t.audit.tick(true)).filed.length, 0);
});

test("groups seen only on versions older than every live production release aren't filed", async () => {
  const t = setup();
  t.config.crashes = { issuesPerPass: 10 };
  // 48 is live alongside 49: everything reported on 48 still files, only the 41-only ANR cluster is dropped.
  t.google.issues.set(t.play.pkg, [...ISSUES.slice(0, 2), issue("b1", "APPLICATION_NOT_RESPONDING", "com.example.Old.wait", "Input dispatching timed out", 9, 4, "41")]);
  t.google.production = [49, 48];
  const { filed } = await t.audit.tick(true);
  assert.deepEqual(filed.map(f => /: (Android .*?) </.exec(f)![1]), ["Android IllegalStateException in Occurrence.toWorkData", "Android OutOfMemoryError in JsonExporter"]);

  // Once 52 and 53 are live, nothing reported only on 48 or older files; a group that reaches 52 does.
  const u = setup();
  u.config.crashes = { issuesPerPass: 10 };
  u.google.production = [53, 52];
  u.google.issues.set(u.play.pkg, [...ISSUES, issue("c1", "CRASH", "com.example.New.go", "java.lang.IllegalStateException", 5, 2, "48", "52")]);
  assert.deepEqual((await u.audit.tick(true)).filed.map(f => /: (Android .*?) </.exec(f)![1]), ["Android IllegalStateException in New.go"]);

  // The old groups aren't remembered as filed: if one comes back on a live version, it files then.
  u.google.issues.set(u.play.pkg, [issue("a1", "CRASH", "com.example.scheduler.Occurrence.toWorkData", "java.lang.IllegalStateException", 70, 7, "41", "53")]);
  assert.deepEqual((await u.audit.tick(true)).filed.map(f => /: (Android .*?) </.exec(f)![1]), ["Android IllegalStateException in Occurrence.toWorkData"]);
});

test("without the production track, every group files as before", async () => {
  const t = setup();
  t.config.crashes = { issuesPerPass: 10 };
  t.google.productionError = new Error("403 forbidden");
  t.google.issues.set(t.play.pkg, ISSUES);
  assert.equal((await t.audit.tick(true)).filed.length, 4);
});

test("autoApprove queues crash fixes to build without waiting", async () => {
  const t = setup();
  t.config.crashes = { autoApprove: true, issuesPerPass: 1 };
  t.google.issues.set(t.play.pkg, ISSUES);
  await t.audit.tick(true);
  const filed = [...t.github.issues.values()][0];
  assert.deepEqual(filed.labels, [t.config.labels.ready, t.config.labels.auto, "bug"]);
  assert.match(filed.body, /approved automatically .*isobot:stop/);
  assert.equal(t.posted.length, 1);
  assert.match(t.posted[0], /queued to fix, merge and ship/);
  // The shipped config has it on.
  assert.equal(testConfig().crashes?.autoApprove, true);
});

test("an open issue that already names the crashing method counts as filed", async () => {
  const t = setup();
  t.config.crashes = { minUsers: 6 };
  t.google.issues.set(t.play.pkg, ISSUES);
  const [owner, repo] = t.play.repo.split("/");
  await t.github.createIssue(owner, repo, "Scheduled export crashes: Occurrence.toWorkData too large", "WorkManager Data > 10 KB", ["bug"]);
  const { filed } = await t.audit.tick(true);
  assert.equal(filed.length, 0);
  assert.equal(t.github.issues.size, 1);
});

test("fileIssues: false reports without opening issues", async () => {
  const t = setup();
  t.config.crashes = { fileIssues: false };
  t.google.issues.set(t.play.pkg, ISSUES);
  assert.equal((await t.audit.tick(true)).filed.length, 0);
  assert.equal(t.github.issues.size, 0);
  const { lines } = t.audit.checkIn();
  assert.ok(lines.some(l => /\(Android\)\*\*, last 7 days: 132 crash reports .*16 ANRs .*top: IllegalStateException in Occurrence\.toWorkData .*obfuscated/.test(l)), lines.join("\n"));
});

test("App Store crash counts and TestFlight crash logs", async () => {
  const t = setup();
  t.asc.submissions = [
    { id: "tf-new", attributes: { createdDate: "2026-11-21T10:00:00Z", comment: "it crashed when syncing", deviceModel: "iPhone17,1", osVersion: "27.1", appPlatform: "IOS" }, relationships: { build: { data: { id: "b1" } } } },
    { id: "tf-old", attributes: { createdDate: "2026-10-01T10:00:00Z", comment: "", deviceModel: "iPhone16,2", osVersion: "27.0", appPlatform: "IOS" }, relationships: { build: { data: { id: "b1" } } } },
  ];
  const { filed } = await t.audit.tick(true);
  // The first pass files only the last week's submissions.
  assert.equal(filed.length, 1);
  assert.match(filed[0], /TestFlight crash in build 412/);
  const [owner, repo] = t.healthRepo.split("/");
  const tf = [...t.github.issues.values()].find(i => i.owner === owner && i.repo === repo && /TestFlight/.test(i.title))!;
  assert.match(tf.body, /HealthMd SyncEngine\.flush\(\)/);
  // A private repo gets the tester's note; the tester's email and name are never requested.
  assert.match(tf.body, /it crashed when syncing/);
  const fields = t.asc.calls.find(c => c[2].endsWith("/betaFeedbackCrashSubmissions"))!.join(" ");
  assert.doesNotMatch(fields, /email|tester\b|firstName/);
  // Apple's daily App Crashes rows are stored and read back.
  assert.deepEqual(t.audit.iosDays(HEALTH, "daily").map(d => [d.day, d.p.crashes]), [["2026-11-18", 1], ["2026-11-19", 3]]);
  assert.ok(t.audit.checkIn().lines.some(l => /\(iOS\)\*\*, Nov 19: 3 crashes on 2 devices \(4\.0\.0: 3\)/.test(l)));
  // Seen submissions aren't filed again.
  assert.equal((await t.audit.tick(true)).filed.length, 0);
});

test("a public repository never gets the tester's note", async () => {
  const t = setup();
  t.github.publicRepos.add(t.healthRepo);
  t.asc.submissions = [{ id: "tf1", attributes: { createdDate: "2026-11-21T10:00:00Z", comment: "my email is someone@example.com", appPlatform: "IOS" }, relationships: { build: { data: { id: "b1" } } } }];
  await t.audit.tick(true);
  const tf = [...t.github.issues.values()].find(i => /TestFlight/.test(i.title))!;
  assert.doesNotMatch(tf.body, /someone@example\.com/);
});

test("check-in flags a jump week over week and a source that can't be read", async () => {
  const t = setup();
  t.config.crashes = { fileIssues: false };
  t.google.issues.set(t.play.pkg, ISSUES.slice(0, 1).map(i => ({ ...i, errorReportCount: "3" })));
  await t.audit.tick(true);
  const later = new CrashAudit({ ...(t.audit as unknown as { deps: ConstructorParameters<typeof CrashAudit>[0] }).deps, now: () => new Date("2026-11-29T09:00:00Z") });
  t.google.issues.set(t.play.pkg, ISSUES);
  t.asc.run = async () => ({ ok: false, stdout: "", stderr: "HTTP 500" });
  await later.tick(true);
  const { flags } = later.checkIn();
  assert.ok(flags.some(f => /📈 .*\(Android\): 148 crash and ANR reports in the last 7 days, up from 3/.test(f)), flags.join("\n"));
  assert.ok(flags.some(f => /couldn't read ios:6757763969/.test(f)), flags.join("\n"));
});

test("formatCheckIn: crash lines ride along, a crash flag posts on its own", () => {
  const quiet: NeedsMe = { review: [], ship: [], failed: [], releaseFailed: [], proposals: [], runner: { paused: false, usageLimitPauseUntil: null, lastCycleError: null } };
  assert.equal(formatCheckIn(quiet, [], undefined, { lines: ["**Health.md** (Android): 3 crash reports"], flags: [] }), null);
  const flagged = formatCheckIn(quiet, [], undefined, { lines: ["**Health.md** (Android): 30 crash reports"], flags: ["📈 Health.md (Android): up"] })!;
  assert.match(flagged, /\*\*Crashes\*\*\n📈 Health\.md \(Android\): up\n- \*\*Health\.md\*\* \(Android\): 30 crash reports/);
});

test("config validates the crashes block", () => {
  const config = testConfig();
  config.crashes = { minUsers: 0 };
  assert.throws(() => validateConfig(config), /crashes\.minUsers/);
  config.crashes = { issuesPerPass: 50 };
  assert.throws(() => validateConfig(config), /crashes\.issuesPerPass/);
  config.crashes = { autoApprove: "yes" as unknown as boolean };
  assert.throws(() => validateConfig(config), /crashes\.autoApprove/);
  config.crashes = { minUsers: 3, issuesPerPass: 2, fileIssues: false, autoApprove: true };
  validateConfig(config);
});
