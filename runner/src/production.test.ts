import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunnerConfig, ProductionConfig } from "./config.js";
import { Notifier } from "./notify.js";
import { lastSlot, nextSlot, ProductionRelease } from "./production.js";
import { Store } from "./store.js";
import { FakeGitHub, testConfig } from "./testing.js";
import type { AppStatus, BetaBuild } from "./train.js";

const REPO = "codybontecou/vox.md";
const [OWNER, NAME] = REPO.split("/");
const key = (what: string) => `train:${REPO}:${what}`.toLowerCase();

/** Local times, so the weekday and hour match however the machine's clock is set. Nov 24 2026 is a Tuesday. */
const local = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute);

function setup(opts: { production?: ProductionConfig; status?: AppStatus; now?: Date } = {}) {
  const config: RunnerConfig = testConfig();
  config.repos = {
    [REPO]: { ownerAutonomy: "merge", checks: ["make test"], train: {
      appId: "6758967337", project: "Voxboard.xcodeproj", scheme: "Voxboard", everyHours: 24, holdMinutes: 60,
      testflight: { group: "Public beta" }, launch: { channelId: "123456789012345678", name: "Vox.md" },
      production: opts.production ?? {},
    } },
  };
  const store = new Store(":memory:");
  const github = new FakeGitHub();
  let now = opts.now ?? local(24, 10, 5);
  const app = { status: opts.status ?? { version: "3.0.4", state: "READY_FOR_DISTRIBUTION" } as AppStatus };
  const beta = new Map<string, string>();
  const calls: string[][] = [];
  const failing = new Set<string>();
  const state = { phased: false, phasedSticks: true };
  const posted: string[] = [];
  const notifier = new Notifier({ webhookUrl: "https://discord.test/hook", fetcher: (async (_url: string, init: RequestInit) => {
    posted.push(JSON.parse(String(init.body)).content);
    return new Response(null, { status: 204 });
  }) as typeof fetch });
  const release = new ProductionRelease({
    config, store, github, notifier,
    now: () => now,
    appStatus: async () => app.status,
    betaState: async (_app, _platform, build) => beta.get(build) ?? null,
    asc: async args => {
      calls.push(args);
      const verb = args.slice(0, 3).join(" ");
      if ([...failing].some(f => verb.startsWith(f))) return { ok: false, stdout: "", output: "boom" };
      if (verb.startsWith("builds list")) return { ok: true, stdout: JSON.stringify({ data: [{ id: "build-id-1" }] }), output: "" };
      if (verb.startsWith("versions list")) return { ok: true, stdout: JSON.stringify({ data: [{ id: "version-id-1" }] }), output: "" };
      if (verb.startsWith("localizations list")) return { ok: true, stdout: JSON.stringify({ data: [{ id: "loc-en" }, { id: "loc-de" }] }), output: "" };
      if (verb === "versions phased-release view") return { ok: true, stdout: JSON.stringify({ data: { id: state.phased ? "phased-1" : "" } }), output: "" };
      if (verb === "versions phased-release create") { state.phased = state.phasedSticks; return { ok: true, stdout: "{}", output: "" }; }
      return { ok: true, stdout: "{}", output: "" };
    },
  });
  const betas = (entries: BetaBuild[]) => store.setCursor(key("betas"), JSON.stringify(entries));
  const run = async () => { for (const p of await release.tick()) await p; };
  return {
    store, github, app, beta, calls, failing, state, posted, betas, run, release,
    // Past the 5-minute check spacing.
    advance: (minutes: number) => { now = new Date(now.getTime() + minutes * 60_000); },
    releaseIssue: () => [...github.issues.values()].find(i => i.title.startsWith("Release ")),
  };
}

const job = (number: number, title: string) => ({ id: `${REPO}#${number}`, number, title, prNumber: number + 100 });
const entry = (version: string, build: string, at: Date, jobs: BetaBuild["jobs"]): BetaBuild => ({ version, build, at: at.toISOString(), jobs });

test("weekly slots are local weekday and hour", () => {
  assert.deepEqual(lastSlot(local(24, 10, 5), 2, 10), local(24, 10));
  assert.deepEqual(lastSlot(local(24, 9, 59), 2, 10), local(17, 10), "before the hour, last week's slot");
  assert.deepEqual(lastSlot(local(27, 8), 2, 10), local(24, 10));
  assert.deepEqual(nextSlot(local(24, 10, 5), 2, 10), new Date(2026, 11, 1, 10));
});

test("the first weekly release waits for the owner, then stages, turns on phased release and submits the soaked build", async () => {
  const t = setup();
  t.betas([
    entry("3.0.5", "202611201000", local(20, 10), [job(85, "One-tap recording")]),
    entry("3.0.5", "202611211000", local(21, 10), [job(86, "Lock screen fix")]),
    entry("3.0.5", "202611240900", local(24, 9), [job(87, "Too fresh")]),
  ]);
  t.beta.set("202611201000", "IN_BETA_TESTING").set("202611211000", "IN_BETA_TESTING").set("202611240900", "IN_BETA_TESTING");
  await t.run();
  const issue = t.releaseIssue()!;
  assert.equal(issue.title, "Release 3.0.5 to the App Store");
  assert.match(issue.body, /TestFlight build \*\*3\.0\.5 \(202611211000\)\*\*, with external testers for 72 h/);
  assert.match(issue.body, /#85 One-tap recording[\s\S]*#86 Lock screen fix/);
  assert.doesNotMatch(issue.body, /Too fresh/, "a build younger than minBetaHours isn't included");
  assert.match(issue.body, /7-day phased release/);
  assert.match(issue.body, /first weekly App Store release from isobot, so it waits for you/);

  t.advance(10 * 60);
  await t.run();
  assert.equal(t.calls.length, 0, "no submission without the owner's ready label on the first release");

  await t.github.addLabels(OWNER, NAME, issue.number, ["isobot:ready"]);
  t.advance(6);
  await t.run();
  const verbs = t.calls.map(c => c.slice(0, 3).join(" "));
  assert.deepEqual(verbs, [
    "builds list --app", "release stage --app", "versions list --app", "localizations list --version",
    "localizations update --id", "localizations update --id", "versions update --version-id",
    "versions phased-release view", "versions phased-release create", "versions phased-release view", "review submit --app",
  ]);
  const stage = t.calls[1];
  assert.deepEqual(stage.slice(stage.indexOf("--version"), stage.indexOf("--version") + 4), ["--version", "3.0.5", "--build-id", "build-id-1"]);
  assert.ok(stage.join(" ").includes("--copy-metadata-from 3.0.4 --exclude-fields whatsNew"));
  assert.ok(t.calls[0].join(" ").includes("--build-number 202611211000"));
  assert.ok(t.calls[6].join(" ").includes("--release-type AFTER_APPROVAL"));
  assert.ok(t.calls.at(-1)!.join(" ").includes("--version-id version-id-1 --build-id build-id-1"));

  assert.equal(t.github.get(OWNER, NAME, issue.number).state, "closed");
  const left = JSON.parse(t.store.cursor(key("betas"))!) as BetaBuild[];
  assert.deepEqual(left.map(e => e.build), ["202611240900"], "released builds leave the history; the fresh one waits for next week");
  assert.equal(JSON.parse(t.store.cursor(key("launch-appstore"))!).version, "3.0.5");
  assert.ok(t.posted.some(m => /submitted for App Review with a 7-day phased release/.test(m)));
});

test("a later week goes on its own after the hold, and only once per week", async () => {
  const t = setup({ production: { holdHours: 4 } });
  t.store.setCursor(key("production-confirmed"), "1");
  t.betas([entry("3.0.5", "202611201000", local(20, 10), [job(85, "One-tap recording")])]);
  t.beta.set("202611201000", "IN_BETA_TESTING");
  await t.run();
  assert.match(t.releaseIssue()!.body, /Submits 4 h after/);
  t.advance(3 * 60);
  await t.run();
  assert.equal(t.calls.length, 0, "still in the hold");
  t.advance(61);
  await t.run();
  assert.ok(t.calls.some(c => c[0] === "review"));
  const issues = t.github.issues.size;
  t.app.status = { version: "3.0.5", state: "READY_FOR_DISTRIBUTION" };
  t.advance(24 * 60);
  await t.run();
  assert.equal(t.github.issues.size, issues, "no second release the same week");
});

test("without a soaked build, the week is skipped with one note", async () => {
  const t = setup();
  t.betas([entry("3.0.5", "202611240900", local(24, 9), [job(87, "Fresh")])]);
  t.beta.set("202611240900", "IN_BETA_TESTING");
  await t.run();
  assert.equal(t.releaseIssue(), undefined);
  assert.equal(t.posted.length, 1);
  assert.match(t.posted[0], /no weekly App Store release\. No TestFlight build ahead of 3\.0\.4 has been with external testers for 48 h yet/);
  t.advance(60);
  await t.run();
  assert.equal(t.posted.length, 1, "said once");
});

test("builds testers can't install, and builds the App Store already has, aren't released", async () => {
  const t = setup({ status: { version: "3.0.5", state: "READY_FOR_DISTRIBUTION" } });
  t.betas([
    entry("3.0.5", "202611180000", local(18, 0), [job(80, "Shipped by hand")]),
    entry("3.0.6", "202611200000", local(20, 0), [job(81, "Rejected beta")]),
  ]);
  t.beta.set("202611200000", "BETA_REJECTED");
  await t.run();
  assert.equal(t.releaseIssue(), undefined);
  assert.deepEqual((JSON.parse(t.store.cursor(key("betas"))!) as BetaBuild[]).map(e => e.version), ["3.0.6"], "3.0.5 is on the App Store, so its builds are dropped");
});

test("a version already in App Review holds the weekly release until it clears", async () => {
  const t = setup({ status: { version: "3.0.5", state: "WAITING_FOR_REVIEW" } });
  t.betas([entry("3.0.6", "202611200000", local(20, 0), [job(81, "Fix")])]);
  t.beta.set("202611200000", "IN_BETA_TESTING");
  await t.run();
  assert.equal(t.releaseIssue(), undefined);
  assert.equal(t.posted.length, 0);
  t.app.status = { version: "3.0.5", state: "READY_FOR_DISTRIBUTION" };
  t.advance(24 * 60);
  await t.run();
  assert.equal(t.releaseIssue()!.title, "Release 3.0.6 to the App Store", "it catches up later in the week");
});

test("never submits when the phased release can't be confirmed", async () => {
  const t = setup();
  t.store.setCursor(key("production-confirmed"), "1");
  t.state.phasedSticks = false;
  t.betas([entry("3.0.5", "202611200000", local(20, 0), [job(85, "Fix")])]);
  t.beta.set("202611200000", "IN_BETA_TESTING");
  await t.run();
  t.advance(5 * 60);
  await t.run();
  assert.equal(t.calls.some(c => c[0] === "review"), false);
  const issue = t.releaseIssue()!;
  assert.match(t.github.commentsFor(OWNER, NAME, issue.number).at(-1)!, /❌ Couldn't check phased release/);
  assert.equal(t.store.cursor(key("production-pending")), "");
  assert.equal((JSON.parse(t.store.cursor(key("betas"))!) as BetaBuild[]).length, 1, "the build waits for next week");
});

test("the stop label skips the week", async () => {
  const t = setup();
  t.store.setCursor(key("production-confirmed"), "1");
  t.betas([entry("3.0.5", "202611200000", local(20, 0), [job(85, "Fix")])]);
  t.beta.set("202611200000", "IN_BETA_TESTING");
  await t.run();
  await t.github.addLabels(OWNER, NAME, t.releaseIssue()!.number, ["isobot:stop"]);
  t.advance(5 * 60);
  await t.run();
  assert.equal(t.calls.length, 0);
  assert.ok(t.posted.some(m => /App Store release skipped/.test(m)));
});

test("before the TestFlight train has recorded any build, the week passes quietly", async () => {
  const t = setup();
  await t.run();
  assert.equal(t.posted.length, 0);
  assert.equal(t.releaseIssue(), undefined);
  assert.ok(t.store.cursor(key("production-slot")));
});

test("production config is validated", async () => {
  const { validateConfig } = await import("./config.js");
  const config = testConfig();
  const train = { appId: "6758967337", project: "Voxboard.xcodeproj", scheme: "Voxboard", everyHours: 24, holdMinutes: 60 };
  config.repos = { [REPO]: { ownerAutonomy: "merge", checks: ["x"], train: { ...train, production: {} } } };
  assert.throws(() => validateConfig(config), /needs train\.testflight/);
  config.repos[REPO] = { ownerAutonomy: "merge", checks: ["x"], train: { ...train, testflight: { group: "Beta" }, production: { weekday: 7 } } };
  assert.throws(() => validateConfig(config), /weekday must be 0–6/);
  config.repos[REPO] = { ownerAutonomy: "merge", checks: ["x"], train: { ...train, testflight: { group: "Beta" }, production: { weekday: 2, hour: 10 } } };
  validateConfig(config);
});
