import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { RunnerConfig } from "./config.js";
import { Notifier } from "./notify.js";
import { Store } from "./store.js";
import { FakeGitHub, testConfig } from "./testing.js";
import { compareVersions, isBusy, nextVersion, publishCommand, ReleaseTrain, timestampBuildNumber, trainVersion, whatsNew, type AppStatus } from "./train.js";

const REPO = "codybontecou/vox.md";
const [OWNER, NAME] = REPO.split("/");

function setup(status: AppStatus = { version: "3.0", state: "READY_FOR_DISTRIBUTION" }) {
  const config: RunnerConfig = testConfig();
  config.repos = {
    [REPO]: { ownerAutonomy: "merge", checks: ["make test"], train: { appId: "6758967337", project: "Voxboard.xcodeproj", scheme: "Voxboard", everyHours: 24, holdMinutes: 60 } },
  };
  const store = new Store(":memory:");
  const github = new FakeGitHub();
  let now = new Date("2026-11-16T12:00:00Z");
  const commands: string[] = [];
  const tags: string[] = [];
  const posted: string[] = [];
  let outcome = { ok: true, output: "uploaded" };
  const app = { status };
  const notifier = new Notifier({ webhookUrl: "https://discord.test/hook", fetcher: (async (_url: string, init: RequestInit) => {
    posted.push(JSON.parse(String(init.body)).content);
    return new Response(null, { status: 204 });
  }) as typeof fetch });
  const train = new ReleaseTrain({
    config, store, github, notifier,
    now: () => now,
    repo: () => ({
      sync: async () => "abc123def4567890",
      checkoutAt: async () => "/tmp/isobot-train-test",
      removeWorkspace: async () => {},
      pushTag: async (sha, tag) => { tags.push(`${tag}@${sha}`); },
    }),
    run: async (_cwd, command) => { commands.push(command); return outcome; },
    appStatus: async () => app.status,
  });
  const merged = (number: number, title: string) => {
    store.enqueue(OWNER, NAME, number, title);
    store.update(`${REPO}#${number}`, { state: "merged", prNumber: number + 100 });
    github.add(OWNER, NAME, number, title, []);
  };
  const run = async () => { for (const ship of await train.tick()) await ship; };
  return {
    config, store, github, train, commands, tags, posted, app, merged, run,
    advance: (minutes: number) => { now = new Date(now.getTime() + minutes * 60_000); },
    fail: (output: string) => { outcome = { ok: false, output }; },
  };
}

test("versions, build numbers and release notes", () => {
  assert.equal(nextVersion("3.0"), "3.0.1");
  assert.equal(nextVersion("2.0.2"), "2.0.3");
  assert.equal(nextVersion(null), "1.0.1");
  assert.equal(timestampBuildNumber(new Date("2026-11-16T09:05:00Z")), "202611160905");
  assert.equal(whatsNew([{ title: "Fix  export\ncrash" }, { title: "One-tap recording" }]), "Fixes and improvements in this update:\n• Fix export crash\n• One-tap recording");
  assert.equal(isBusy({ version: "3.0", state: "WAITING_FOR_REVIEW" }), true);
  assert.equal(isBusy({ version: "3.0", state: "READY_FOR_DISTRIBUTION" }), false);
  assert.equal(isBusy({ version: null, state: null }), false);
  assert.equal(compareVersions("3.0.10", "3.0.9"), 1);
  assert.equal(compareVersions("3.0", "3.0.0"), 0);
  assert.equal(compareVersions("2.9.9", "3.0"), -1);
  const beta = { testflight: { group: "Beta" } };
  assert.equal(trainVersion(beta, { version: "3.5.0", state: "READY_FOR_DISTRIBUTION", latestBuild: "4.0.0" }), "4.0.0", "an open beta version ahead of the App Store is kept");
  assert.equal(trainVersion(beta, { version: "3.0.2", state: "WAITING_FOR_REVIEW", latestBuild: "3.0.2" }), "3.0.3");
  assert.equal(trainVersion({}, { version: "3.5.0", state: "READY_FOR_DISTRIBUTION", latestBuild: "4.0.0" }), "3.5.1", "App Store trains ignore betas");
  const command = publishCommand({ appId: "1", project: "It's.xcodeproj", scheme: "App", everyHours: 24, holdMinutes: 60 }, "1.2.3", "202611160905", "/m");
  assert.match(command, /--project 'It'\\''s\.xcodeproj'/);
  assert.match(command, /--archive-xcodebuild-flag 'MARKETING_VERSION=1\.2\.3' --archive-xcodebuild-flag 'CURRENT_PROJECT_VERSION=202611160905'/);
  assert.match(command, /--submit --confirm/);
});

test("nothing merged, nothing announced", async () => {
  const t = setup();
  await t.run();
  assert.equal(t.github.issues.size, 0);
});

test("the first train waits for the owner's ready label, then ships, tags and reports", async () => {
  const t = setup();
  t.merged(85, "Lock screen capture fix");
  t.merged(86, "One-tap recording");
  await t.run();
  const ship = [...t.github.issues.values()].find(i => i.title === "Ship 3.0.1")!;
  assert.ok(ship, "a ship issue announces the version");
  assert.match(ship.body, /#85 Lock screen capture fix \(PR #185\)/);
  assert.match(ship.body, /first release train, so it waits for you/);
  assert.match(t.posted[0], /First train, so it waits for `isobot:ready`/);

  t.advance(120);
  await t.run();
  assert.equal(t.commands.length, 0, "no ship without the owner's approval on the first train");

  await t.github.addLabels(OWNER, NAME, ship.number, ["isobot:ready"]);
  await t.run();
  assert.equal(t.commands.length, 1);
  assert.match(t.commands[0], /^asc publish appstore --app '6758967337' --project 'Voxboard.xcodeproj' --scheme 'Voxboard'/);
  assert.match(t.commands[0], /--version '3\.0\.1'/);
  assert.deepEqual(t.tags, ["v3.0.1@abc123def4567890"]);
  assert.equal(t.store.get(`${REPO}#85`)!.state, "shipped");
  assert.equal(t.github.get(OWNER, NAME, ship.number).state, "closed");
  assert.match(t.github.commentsFor(OWNER, NAME, 86).at(-1)!, /Submitted to App Review in 3\.0\.1/);
  assert.match(t.posted.at(-1)!, /🚀 \*\*codybontecou\/vox.md 3\.0\.1\*\* submitted/);
});

test("later trains ship on their own after the hold, at most once per interval", async () => {
  const t = setup();
  t.store.setCursor(`train:${REPO}:confirmed`.toLowerCase(), "1");
  t.merged(90, "Remote-only routes");
  await t.run();
  t.advance(30);
  await t.run();
  assert.equal(t.commands.length, 0, "still inside the hold window");
  t.advance(31);
  await t.run();
  assert.equal(t.commands.length, 1);

  t.merged(91, "Another fix");
  t.app.status = { version: "3.0.1", state: "READY_FOR_DISTRIBUTION" };
  t.advance(60);
  await t.run();
  assert.equal([...t.github.issues.values()].filter(i => i.title.startsWith("Ship")).length, 1, "the next train waits out everyHours");
  t.advance(24 * 60);
  await t.run();
  assert.ok([...t.github.issues.values()].some(i => i.title === "Ship 3.0.2"));
});

test("a version in App Review holds the train, and the stop label cancels one", async () => {
  const t = setup({ version: "3.0", state: "WAITING_FOR_REVIEW" });
  t.store.setCursor(`train:${REPO}:confirmed`.toLowerCase(), "1");
  t.merged(90, "Remote-only routes");
  await t.run();
  assert.equal(t.github.issues.size, 1, "only the job's own issue: nothing announced while Apple reviews");

  t.app.status = { version: "3.0", state: "READY_FOR_DISTRIBUTION" };
  await t.run();
  const ship = [...t.github.issues.values()].find(i => i.title === "Ship 3.0.1")!;
  await t.github.addLabels(OWNER, NAME, ship.number, ["isobot:stop"]);
  t.advance(90);
  await t.run();
  assert.equal(t.commands.length, 0);
  assert.match(t.github.commentsFor(OWNER, NAME, ship.number).at(-1)!, /Held/);
  assert.equal(t.store.get(`${REPO}#90`)!.state, "merged", "held work stays queued");
});

test("a failed ship reports the output and keeps the work for the next train", async () => {
  const t = setup();
  t.store.setCursor(`train:${REPO}:confirmed`.toLowerCase(), "1");
  t.merged(90, "Remote-only routes");
  t.fail("error: No signing certificate");
  await t.run();
  t.advance(61);
  await t.run();
  const ship = [...t.github.issues.values()].find(i => i.title === "Ship 3.0.1")!;
  assert.match(t.github.commentsFor(OWNER, NAME, ship.number).at(-1)!, /failed[\s\S]*No signing certificate/);
  assert.deepEqual(t.tags, []);
  assert.equal(t.store.get(`${REPO}#90`)!.state, "merged");
  assert.match(t.posted.at(-1)!, /failed to ship/);
});

test("train config is validated", async () => {
  const { validateConfig } = await import("./config.js");
  const config = testConfig();
  config.repos[REPO] = { ownerAutonomy: "merge", checks: ["x"], train: { appId: "abc", project: "a", scheme: "s", everyHours: 24, holdMinutes: 60 } };
  assert.throws(() => validateConfig(config), /train.appId/);
  config.repos[REPO] = { ownerAutonomy: "merge", checks: ["x"], train: { appId: "123456", scheme: "s", everyHours: 24, holdMinutes: 60 } };
  assert.throws(() => validateConfig(config), /exactly one of project or workspace/);
  config.repos[REPO] = { train: { appId: "123456", project: "a", scheme: "s", everyHours: 24, holdMinutes: 60 } };
  assert.throws(() => validateConfig(config), /only makes sense where isobot merges/);
});

const CHANNEL = "123456789012345678";
const SHA = "0123456789abcdef0123456789abcdef01234567";

/** A train with a Discord bot, model-written notes and a capture on each PR, for the launch post. */
function launchSetup() {
  const config: RunnerConfig = testConfig();
  config.repos = {
    [REPO]: { ownerAutonomy: "merge", checks: ["make test"], train: {
      appId: "6758967337", project: "Voxboard.xcodeproj", scheme: "Voxboard", everyHours: 24, holdMinutes: 60,
      launch: { channelId: CHANNEL },
    } },
  };
  const store = new Store(":memory:");
  store.setCursor(`train:${REPO}:confirmed`.toLowerCase(), "1");
  const github = new FakeGitHub();
  let now = new Date("2026-11-16T12:00:00Z");
  const metadata: string[] = [];
  const staff: string[] = [];
  const launches: { channel: string; content: string; files: string[] }[] = [];
  const app = { status: { version: "3.0", state: "READY_FOR_DISTRIBUTION" } as AppStatus };
  const notifier = new Notifier({ bot: { token: "t", channelId: "999999999999999999" }, fetcher: (async (url: string, init: RequestInit) => {
    const channel = /channels\/(\d+)\/messages/.exec(url)?.[1] ?? "";
    if (init.body instanceof FormData) {
      const payload = JSON.parse(String(init.body.get("payload_json")));
      launches.push({ channel, content: payload.content, files: payload.attachments.map((a: { filename: string }) => a.filename) });
    } else if (init.body) {
      staff.push(JSON.parse(String(init.body)).content);
    }
    return Response.json({ id: "1" });
  }) as typeof fetch });
  const inputs: unknown[] = [];
  const train = new ReleaseTrain({
    config, store, github, notifier,
    now: () => now,
    repo: () => ({ sync: async () => "abc123def4567890", checkoutAt: async () => "/tmp/isobot-train-test", removeWorkspace: async () => {}, pushTag: async () => {} }),
    run: async (cwd, command) => {
      if (command.startsWith("asc publish")) metadata.push(readFileSync(path.join(cwd, ".isobot-release/version/3.0.1/en-US.json"), "utf8"));
      return { ok: true, output: "uploaded" };
    },
    appStatus: async () => app.status,
    notes: async input => {
      inputs.push(input);
      return { headline: "Recording is one tap away", items: [
        { kind: "new", text: "Start recording with one tap. Details at https://evil.example" },
        { kind: "fixed", text: "Lock screen captures no longer stop early" },
      ], whatsNew: "This update makes recording faster.\n• One-tap recording\n• Lock screen fix" };
    },
    pullBody: async (_o, _r, number) =>
      `Summary of PR ${number}\n\n<img src="https://github.com/${REPO}/blob/${SHA}/${number - 100}/x/01-after.png?raw=true" width="320">`,
    fileAt: async (_o, _r, ref, file) => { assert.equal(ref, SHA); return Buffer.from(`png:${file}`); },
  });
  const merged = (number: number, title: string) => {
    store.enqueue(OWNER, NAME, number, title);
    store.update(`${REPO}#${number}`, { state: "merged", prNumber: number + 100 });
    github.add(OWNER, NAME, number, title, []);
  };
  const run = async () => { for (const ship of await train.tick()) await ship; };
  return { store, github, app, merged, run, metadata, staff, launches, inputs, advance: (minutes: number) => { now = new Date(now.getTime() + minutes * 60_000); } };
}

test("model-written notes show on the ship issue, become What's New, and post to the app's channel once live", async () => {
  const t = launchSetup();
  t.merged(85, "Lock screen capture fix");
  t.merged(86, "One-tap recording");
  await t.run();
  assert.deepEqual((t.inputs[0] as { changes: { summary: string }[] }).changes.map(c => c.summary), ["Summary of PR 185", "Summary of PR 186"],
    "the model sees each PR's description without its media markup");
  const ship = [...t.github.issues.values()].find(i => i.title === "Ship 3.0.1")!;
  assert.match(ship.body, /> This update makes recording faster\./);
  assert.match(ship.body, new RegExp(`Discord launch post\\*\\* \\(in <#${CHANNEL}>`));
  assert.doesNotMatch(ship.body, /evil\.example/, "links in the model's notes are dropped");

  t.advance(61);
  t.app.status = { version: "3.0", state: "READY_FOR_DISTRIBUTION" };
  await t.run();
  assert.equal(JSON.parse(t.metadata[0]).whatsNew, "This update makes recording faster.\n• One-tap recording\n• Lock screen fix");
  assert.equal(t.launches.length, 0, "nothing goes to users at submission");

  t.app.status = { version: "3.0.1", state: "WAITING_FOR_REVIEW" };
  t.advance(20);
  await t.run();
  assert.equal(t.launches.length, 0, "nothing while Apple reviews");

  t.app.status = { version: "3.0.1", state: "READY_FOR_DISTRIBUTION" };
  t.advance(5);
  await t.run();
  assert.equal(t.launches.length, 0, "the App Store is checked at most every 15 minutes");
  t.advance(15);
  await t.run();
  assert.equal(t.launches.length, 1);
  const post = t.launches[0];
  assert.equal(post.channel, CHANNEL);
  assert.match(post.content, /^# 🎉 Voxboard 3\.0\.1 is out\n\nRecording is one tap away/);
  assert.match(post.content, /✨ \*\*New\*\*\n• Start recording with one tap\. Details at\n\n🐛 \*\*Fixed\*\*\n• Lock screen captures/);
  assert.match(post.content, /<https:\/\/apps\.apple\.com\/app\/id6758967337>/);
  assert.deepEqual(post.files, ["85-01-after.png", "86-01-after.png"]);
  assert.match(t.staff.at(-1)!, /📣 \*\*Voxboard 3\.0\.1\*\* is live/);

  t.advance(60);
  await t.run();
  assert.equal(t.launches.length, 1, "posted once");
});

test("a version replaced before going live gets no launch post", async () => {
  const t = launchSetup();
  t.store.setCursor(`train:${REPO}:launch`.toLowerCase(), JSON.stringify({
    version: "3.0.1", jobs: [], notes: { headline: "", items: [], whatsNew: "Bug fixes and improvements." },
  }));
  t.app.status = { version: "3.0.2", state: "READY_FOR_DISTRIBUTION" };
  await t.run();
  assert.equal(t.launches.length, 0);
  assert.equal(t.store.cursor(`train:${REPO}:launch`.toLowerCase()), "");
});

/** A TestFlight train: same flow, but builds go to an external beta group. */
function betaSetup() {
  const config: RunnerConfig = testConfig();
  config.repos = {
    [REPO]: { ownerAutonomy: "merge", checks: ["make test"], train: {
      appId: "6758967337", project: "Voxboard.xcodeproj", scheme: "Voxboard", everyHours: 24, holdMinutes: 60,
      launch: { channelId: CHANNEL, name: "Vox.md" },
      testflight: { group: "Public beta", joinUrl: "https://testflight.apple.com/join/dQXXSTxv" },
    } },
  };
  const store = new Store(":memory:");
  store.setCursor(`train:${REPO}:confirmed`.toLowerCase(), "1");
  const github = new FakeGitHub();
  let now = new Date("2026-11-16T12:00:00Z");
  const commands: string[] = [];
  const tags: string[] = [];
  const staff: string[] = [];
  const launches: string[] = [];
  const beta = { state: "WAITING_FOR_BETA_REVIEW" as string | null, asked: [] as string[] };
  const notifier = new Notifier({ bot: { token: "t", channelId: "999999999999999999" }, fetcher: (async (url: string, init: RequestInit) => {
    const channel = /channels\/(\d+)\/messages/.exec(url)?.[1] ?? "";
    const body = init.body instanceof FormData ? JSON.parse(String(init.body.get("payload_json"))) : init.body ? JSON.parse(String(init.body)) : null;
    if (body) (channel === CHANNEL ? launches : staff).push(body.content);
    return Response.json({ id: "1" });
  }) as typeof fetch });
  const train = new ReleaseTrain({
    config, store, github, notifier,
    now: () => now,
    repo: () => ({ sync: async () => "abc123def4567890", checkoutAt: async () => "/tmp/isobot-train-test", removeWorkspace: async () => {},
      pushTag: async (sha, tag) => { tags.push(`${tag}@${sha}`); } }),
    run: async (_cwd, command) => { commands.push(command); return { ok: true, output: "uploaded" }; },
    // App Review state is irrelevant to TestFlight: even a version in review doesn't hold the train.
    appStatus: async () => ({ version: "3.0", state: "WAITING_FOR_REVIEW" }),
    betaState: async (_app, _platform, build) => { beta.asked.push(build); return beta.state; },
  });
  const merged = (number: number, title: string) => {
    store.enqueue(OWNER, NAME, number, title);
    store.update(`${REPO}#${number}`, { state: "merged", prNumber: number + 100 });
    github.add(OWNER, NAME, number, title, []);
  };
  const run = async () => { for (const ship of await train.tick()) await ship; };
  return { store, github, commands, tags, staff, launches, beta, merged, run, advance: (minutes: number) => { now = new Date(now.getTime() + minutes * 60_000); } };
}

test("a TestFlight train uploads to the external group, waits out Beta App Review, then posts the beta", async () => {
  const t = betaSetup();
  t.merged(85, "One-tap recording");
  await t.run();
  const ship = [...t.github.issues.values()].find(i => i.title === "Ship 3.0.1")!;
  assert.match(ship.body, /goes to TestFlight \(external group \*\*Public beta\*\*, after Beta App Review\)/);
  assert.match(ship.body, /\*\*What to Test\*\*/);
  assert.match(ship.body, /beta is on TestFlight/);

  t.advance(61);
  await t.run();
  assert.equal(t.commands.length, 1);
  assert.match(t.commands[0], /^asc publish testflight --app '6758967337' --project 'Voxboard.xcodeproj' --scheme 'Voxboard' --platform IOS --version '3\.0\.1' --group 'Public beta' --test-notes 'Fixes and improvements in this update:\n• One-tap recording' --locale en-US/);
  assert.match(t.commands[0], /CURRENT_PROJECT_VERSION=202611161301'.* --submit --confirm/);
  assert.doesNotMatch(t.commands[0], /appstore|--metadata-dir/);
  assert.deepEqual(t.tags, ["testflight/3.0.1-202611161301@abc123def4567890"]);
  assert.equal(t.store.get(`${REPO}#85`)!.state, "shipped");
  assert.match(t.github.commentsFor(OWNER, NAME, 85).at(-1)!, /Submitted to TestFlight in 3\.0\.1 \(build 202611161301/);
  assert.match(t.staff.at(-1)!, /🧪 \*\*codybontecou\/vox.md 3\.0\.1\*\* \(build 202611161301\) submitted to TestFlight for Public beta/);

  t.advance(20);
  await t.run();
  assert.equal(t.launches.length, 0, "nothing while Apple reviews the beta");

  t.merged(86, "Lock screen fix");
  t.advance(24 * 60);
  await t.run();
  assert.equal([...t.github.issues.values()].filter(i => i.title.startsWith("Ship")).length, 1, "a build in Beta App Review holds the next train");

  t.beta.state = "IN_BETA_TESTING";
  t.advance(15);
  await t.run();
  assert.equal(t.launches.length, 1);
  assert.match(t.launches[0], /^# 🧪 Vox\.md 3\.0\.1 beta is on TestFlight/);
  assert.match(t.launches[0], /Join the beta on TestFlight: <https:\/\/testflight\.apple\.com\/join\/dQXXSTxv>/);
  assert.doesNotMatch(t.launches[0], /apps\.apple\.com/);
  assert.ok(t.staff.some(m => /on TestFlight for external testers \(build 202611161301\)/.test(m)));
  assert.ok(t.beta.asked.every(build => build === "202611161301"));
  assert.ok([...t.github.issues.values()].some(i => i.title === "Ship 3.0.1" && i.state === "open"), "the next build reuses the version");
});

test("a rejected beta gets no launch post and doesn't hold the train", async () => {
  const t = betaSetup();
  t.store.setCursor(`train:${REPO}:launch`.toLowerCase(), JSON.stringify({
    version: "3.0.1", build: "202611150000", jobs: [], notes: { headline: "", items: [], whatsNew: "Bug fixes and improvements." },
  }));
  t.store.setCursor(`train:${REPO}:beta`.toLowerCase(), "202611150000");
  t.beta.state = "BETA_REJECTED";
  t.merged(90, "Another fix");
  await t.run();
  assert.equal(t.launches.length, 0);
  assert.match(t.staff[0], /won't reach testers: TestFlight says BETA_REJECTED/);
  assert.ok([...t.github.issues.values()].some(i => i.title === "Ship 3.0.1"));
});

test("TestFlight config is validated", async () => {
  const { validateConfig } = await import("./config.js");
  const config = testConfig();
  const train = { appId: "123456", project: "a", scheme: "s", everyHours: 24, holdMinutes: 60 };
  config.repos[REPO] = { ownerAutonomy: "merge", checks: ["x"], train: { ...train, testflight: { group: " " } } };
  assert.throws(() => validateConfig(config), /train.testflight.group/);
  config.repos[REPO] = { ownerAutonomy: "merge", checks: ["x"], train: { ...train, testflight: { group: "Beta", joinUrl: "https://example.com/x" } } };
  assert.throws(() => validateConfig(config), /train.testflight.joinUrl/);
});
