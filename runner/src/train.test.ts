import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig, type RunnerConfig } from "./config.js";
import { Notifier } from "./notify.js";
import { Store } from "./store.js";
import { FakeGitHub } from "./testing.js";
import { isBusy, nextVersion, publishCommand, ReleaseTrain, timestampBuildNumber, whatsNew, type AppStatus } from "./train.js";

const REPO = "codybontecou/vox.md";
const [OWNER, NAME] = REPO.split("/");

function setup(status: AppStatus = { version: "3.0", state: "READY_FOR_DISTRIBUTION" }) {
  const config: RunnerConfig = loadConfig();
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
  const config = loadConfig();
  config.repos[REPO] = { ownerAutonomy: "merge", checks: ["x"], train: { appId: "abc", project: "a", scheme: "s", everyHours: 24, holdMinutes: 60 } };
  assert.throws(() => validateConfig(config), /train.appId/);
  config.repos[REPO] = { ownerAutonomy: "merge", checks: ["x"], train: { appId: "123456", scheme: "s", everyHours: 24, holdMinutes: 60 } };
  assert.throws(() => validateConfig(config), /exactly one of project or workspace/);
  config.repos[REPO] = { train: { appId: "123456", project: "a", scheme: "s", everyHours: 24, holdMinutes: 60 } };
  assert.throws(() => validateConfig(config), /only makes sense where isobot merges/);
});
