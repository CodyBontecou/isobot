import assert from "node:assert/strict";
import { test } from "node:test";
import { checkInLines, classify, compareVersions, isReleasePull, needsOwner, platformOf, PrSweep, supersededBy, versionIn, type OpenPull, type SweepGitHub, type SweepRepoData } from "./prSweep.js";
import { Store } from "./store.js";
import { formatCheckIn } from "./chatTools.js";
import { withAttention, type BoardItem } from "./dashboard.js";

const NOW = new Date("2026-11-25T20:00:00Z");
const LAND = "isobot:land";

function pull(number: number, over: Partial<OpenPull> = {}): OpenPull {
  return {
    number, title: `PR ${number}`, url: `https://github.com/o/r/pull/${number}`, branch: `fix/${number}`, author: "owner", draft: false,
    createdAt: "2026-11-20T00:00:00Z", updatedAt: "2026-11-24T00:00:00Z", mergeable: "MERGEABLE", ci: "success", labels: [], closes: [], ...over,
  };
}

const data = (pulls: OpenPull[], tags: string[] = [], merged: SweepRepoData["merged"] = []): SweepRepoData => ({ pulls, tags, merged });

test("versions and stores are read from release titles, branches and tags", () => {
  assert.deepEqual(versionIn("Release Vox.md 3.0.4 build 66 (iOS TestFlight)"), [3, 0, 4]);
  assert.deepEqual(versionIn("release/ios-3.0.1-b2"), [3, 0, 1]);
  assert.deepEqual(versionIn("testflight/4.0.2-202611232139"), [4, 0, 2]);
  assert.deepEqual(versionIn("v2.0"), [2, 0, 0]);
  assert.equal(versionIn("Fix the export crash"), null);
  assert.ok(compareVersions([3, 0, 4], [3, 0, 2]) > 0);
  assert.equal(platformOf("Release 3.0.2 (Android) with the Wear OS app"), "android");
  assert.equal(platformOf("Release Vox.md 3.0.2 build 64 (iOS)"), "ios");
  assert.equal(platformOf("Release iOS 3.0.2 and Android 1.1.4"), null);
  assert.ok(isReleasePull({ title: "Ship 4.0.0", branch: "isobot/350-ship-4-0-0" }));
  assert.ok(isReleasePull({ title: "iOS 3.0.1 (202611162034): new build", branch: "release/ios-3.0.1-b2" }));
  assert.ok(!isReleasePull({ title: "Add Health.md 4.0.0 release notes", branch: "docs/notes" }));
});

test("a release PR is superseded only by a release for the same store; strictly newer ones close it", () => {
  // Health.md #351: Ship 4.0.0 after v4.0.1 shipped.
  assert.deepEqual(supersededBy({ number: 351, title: "Ship 4.0.0", branch: "isobot/350-ship-4-0-0" }, { tags: ["v4.0.1", "v4.0.0"], merged: [] }), { by: "tag v4.0.1", newer: true });
  // Vox #108: iOS 3.0.4 when TestFlight already has 3.0.4: listed, not closed (it may still hold the release's notes).
  assert.deepEqual(supersededBy({ number: 108, title: "Release Vox.md 3.0.4 build 66 (iOS TestFlight)", branch: "release/3.0.4-build-66" },
    { tags: ["android/v3.0.4", "testflight/3.0.4-202611200102"], merged: [] }), { by: "tag testflight/3.0.4-202611200102", newer: false });
  // An Android tag never replaces an iOS release.
  assert.equal(supersededBy({ number: 1, title: "Release 3.0.5 (iOS)", branch: "release/3.0.5-ios" }, { tags: ["android/v3.1.0"], merged: [] }), null);
  // A merged release PR counts like a tag; failed-build tags don't.
  assert.deepEqual(supersededBy({ number: 2, title: "Release 2.0.2 (Android)", branch: "release/2.0.2" },
    { tags: ["v2.0.4-failed-build-1"], merged: [{ number: 146, title: "Release iOS 2.0.3 and Android 2.0.5", branch: "release/2.0.5" }] }), { by: "#146 (Release iOS 2.0.3 and Android 2.0.5)", newer: true });
  assert.equal(supersededBy({ number: 3, title: "Fix 3.0.2 regression", branch: "fix/x" }, { tags: ["v9.0.0"], merged: [] }), null, "not a release PR");
});

test("classify gives each open PR one status, one reason and at most one action", () => {
  const jobs = [
    { id: "o/r#10", owner: "o", repo: "r", number: 10, prNumber: 110, state: "awaiting_ci" },
    { id: "o/r#11", owner: "o", repo: "r", number: 11, prNumber: 111, state: "pr_open" },
  ] as never;
  const out = classify("o/r", data([
    pull(110),
    pull(111),
    pull(112),
    pull(113, { mergeable: "CONFLICTING" }),
    pull(114, { ci: "failure", updatedAt: "2026-10-01T00:00:00Z" }),
    pull(115, { ci: "pending" }),
    pull(116, { closes: [{ number: 5, state: "open" }] }),
    pull(117, { closes: [{ number: 5, state: "open" }] }),
    pull(118, { closes: [{ number: 6, state: "closed" }] }),
    pull(119, { draft: true }),
    pull(120, { draft: true, updatedAt: "2026-10-01T00:00:00Z" }),
    pull(121, { labels: [LAND], ci: "failure" }),
    pull(122, { title: "Ship 3.0.2", branch: "isobot/87-ship-3-0-2", mergeable: "CONFLICTING" }),
    pull(123, { ci: "none" }),
  ], ["testflight/3.0.3-1"]), jobs, NOW, 14, LAND);
  const by = new Map(out.map(p => [p.number, p]));
  const row = (n: number) => [by.get(n)!.status, by.get(n)!.action];
  assert.deepEqual(row(110), ["runner", null]);
  assert.deepEqual(row(111), ["review", "merge it or reply on the issue"]);
  assert.deepEqual(row(112), ["ready", "merge it"]);
  assert.deepEqual(row(113), ["conflicting", "add `isobot:land`"]);
  assert.deepEqual(row(114), ["failing", "add `isobot:land`"]);
  assert.match(by.get(114)!.reason, /no activity for 55 days/);
  assert.ok(by.get(114)!.stale);
  assert.deepEqual(row(115), ["pending", null]);
  assert.deepEqual(row(116), ["duplicate", "keep one of #116 and #117"]);
  assert.deepEqual(row(117), ["duplicate", "keep one of #116 and #117"]);
  assert.deepEqual(row(118), ["duplicate", "close it, or reopen the issue"]);
  assert.deepEqual(row(119), ["draft", null]);
  assert.deepEqual(row(120), ["draft", "finish or close it"]);
  assert.deepEqual(row(121), ["runner", null], "isobot:land: the runner picks it up next");
  assert.deepEqual(row(122), ["superseded", "close it"]);
  assert.equal(by.get(122)!.autoClose, true);
  assert.match(by.get(123)!.reason, /^no CI and it merges cleanly/);
});

class FakeSweepGitHub implements SweepGitHub {
  comments: string[] = [];
  closed: number[] = [];
  failRepo = "";
  constructor(private repos: Record<string, SweepRepoData>) {}
  async sweepRepo(owner: string, repo: string) {
    if (`${owner}/${repo}` === this.failRepo) throw new Error("GraphQL: rate limited");
    return this.repos[`${owner}/${repo}`];
  }
  async comment(_o: string, _r: string, n: number, body: string) { this.comments.push(`${n}: ${body}`); return 1; }
  async closePull(_o: string, _r: string, n: number) { this.closed.push(n); }
}

test("a sweep closes release PRs a newer release replaced, keeps the rest for the check-in, and waits for its interval", async () => {
  const store = new Store(":memory:");
  const github = new FakeSweepGitHub({
    "o/a": data([pull(351, { title: "Ship 4.0.0", branch: "isobot/350-ship-4-0-0" }), pull(352), pull(353, { mergeable: "CONFLICTING" })], ["v4.0.1"]),
    "o/b": data([pull(1)]),
  });
  github.failRepo = "o/b";
  let now = NOW;
  const sweep = new PrSweep({ config: undefined, repos: () => ["o/a", "o/b"], landLabel: LAND, github, store, now: () => now });
  const result = (await sweep.tick())!;

  assert.deepEqual(github.closed, [351]);
  assert.match(github.comments[0], /^351: 🧹 isobot's PR sweep is closing this release PR: a newer release is out: tag v4\.0\.1\. The branch stays/);
  assert.deepEqual(result.closed.map(c => c.number), [351]);
  assert.deepEqual(result.pulls.map(p => p.number), [352, 353]);
  assert.deepEqual(result.errors, ["o/b: GraphQL: rate limited"], "one repo failing doesn't stop the others");
  assert.deepEqual(sweep.latest(), result, "kept for the check-in and the board");

  assert.equal(await sweep.tick(), null, "not again within six hours");
  now = new Date(NOW.getTime() + 6 * 3_600_000 + 1);
  assert.ok(await sweep.tick());
});

test("closeSuperseded: false lists replaced release PRs instead of closing them", async () => {
  const store = new Store(":memory:");
  const github = new FakeSweepGitHub({ "o/a": data([pull(351, { title: "Ship 4.0.0", branch: "isobot/350-ship-4-0-0" })], ["v4.0.1"]) });
  const result = await new PrSweep({ config: { closeSuperseded: false }, repos: () => ["o/a"], landLabel: LAND, github, store, now: () => NOW }).sweep();
  assert.deepEqual(github.closed, []);
  assert.equal(result.pulls[0].status, "superseded");
});

test("check-in lines put what you can merge first, leave out isobot's own review PRs, and name what the sweep closed", () => {
  const result = {
    at: NOW.toISOString(), errors: [],
    closed: [{ repo: "o/vox.md", number: 100, title: "Release Vox.md 3.0.2", reason: "a newer release is out: tag testflight/3.0.4-1" }],
    pulls: classify("o/vox.md", data([pull(166, { ci: "failure", title: "Per-route switch" }), pull(151, { title: "Spatial Audio" }), pull(167)]),
      [{ id: "o/vox.md#164", owner: "o", repo: "vox.md", number: 164, prNumber: 167, state: "pr_open" }] as never, NOW, 14, LAND),
  };
  assert.deepEqual(needsOwner(result).map(p => p.number), [151, 166, 167]);
  assert.deepEqual(checkInLines(result), [
    "vox.md#151 Spatial Audio: CI is green and it merges cleanly → merge it",
    "vox.md#166 Per-route switch: CI is failing → add `isobot:land`",
    "Closed vox.md#100 Release Vox.md 3.0.2 (a newer release is out: tag testflight/3.0.4-1)",
  ]);
  assert.deepEqual(checkInLines(null), []);
});

test("the check-in gets a Pull requests section from the sweep", () => {
  const quiet = { review: [], ship: [], failed: [], releaseFailed: [], proposals: [], runner: { paused: false, usageLimitPauseUntil: null, lastCycleError: null } };
  assert.equal(formatCheckIn({ ...quiet, pulls: [] }, []), null, "nothing to say");
  const text = formatCheckIn({ ...quiet, pulls: ["vox.md#151 Spatial Audio: CI is green and it merges cleanly → merge it"] }, [])!;
  assert.match(text, /\*\*Pull requests\*\*\n- vox\.md#151 Spatial Audio: CI is green and it merges cleanly → merge it/);
});

test("the board's open PRs carry the sweep's verdict; issues and closed PRs don't", () => {
  const item = (number: number, kind: "pr" | "issue", state: "open" | "closed" = "open"): BoardItem => ({
    repo: "o/r", number, kind, title: "t", url: "u", state, merged: false, draft: false, author: "a", labels: [], comments: 0,
    createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), closedAt: null, source: { kind: "github" },
  });
  const sweep = { at: NOW.toISOString(), closed: [], errors: [], pulls: classify("o/r", data([pull(1, { ci: "failure" }), pull(2)]), [], NOW, 14, LAND) };
  const out = withAttention([item(1, "pr"), item(2, "pr", "closed"), item(1, "issue")], sweep);
  assert.deepEqual(out[0].attention, { status: "failing", reason: "CI is failing", action: "add `isobot:land`", at: NOW.toISOString() });
  assert.equal(out[1].attention, undefined);
  assert.equal(out[2].attention, undefined);
  assert.deepEqual(withAttention([item(1, "pr")], null)[0].attention, undefined);
});
