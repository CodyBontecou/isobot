import assert from "node:assert/strict";
import { test } from "node:test";
import { asoApps, validateConfig, type AsoAppConfig } from "./config.js";
import { applyHint, AsoTrain, boardCells, brandOf, brandWarnings, changedFields, editableAppInfo, movers, parseProposal, pickVersions, reportText, snapshotsByDay, splitMessage, type AsoClient, type Listing } from "./aso.js";
import type { AgentJsonInput } from "./builder.js";
import { Store } from "./store.js";
import { FakeGitHub, FakeRepo, testConfig } from "./testing.js";

const REPO = "codybontecou/GitSync.md";
const CURRENT: Listing = { name: "GitSync.md", subtitle: "Git sync for notes", keywords: "github,obsidian,commit,push", promotionalText: "Real Git on your iPhone." };

type Row = { text: string; storefront?: string; rank: number | null; volume?: number; inListing?: boolean; checkedAt: string; error?: string };
const board = (rows: Row[]) => ({
  app: { id: "6758960270" },
  concepts: [{ label: "all", cells: rows.map((r, i) => ({ id: String(i), storefront: "us", volume: 50, difficulty: 40, inListing: false, error: null, ...r })) }],
});

class FakeTracker implements AsoClient {
  calls: { tool: string; args: Record<string, unknown>; wait?: boolean }[] = [];
  board = board([]);
  listings: unknown = [{ locale: "en-US", name: CURRENT.name, subtitle: CURRENT.subtitle, keywords: CURRENT.keywords, promotional_text: CURRENT.promotionalText, fetched_at: "2026-11-20T00:00:00Z" }];
  options: unknown[] = [];
  fail: Record<string, string> = {};
  /** Board rows the tracker has after a keywords_import (it measures what it imports). */
  imported: Row[] = [];
  async call(tool: string, args: Record<string, unknown>, options: { wait?: boolean } = {}) {
    this.calls.push({ tool, args, wait: options.wait });
    if (tool === "keywords_import" && this.imported.length) this.board.concepts[0].cells.push(...board(this.imported).concepts[0].cells);
    if (this.fail[tool]) throw new Error(this.fail[tool]);
    if (tool === "board_get") return this.board;
    if (tool === "listing_get") return this.listings;
    if (tool === "audit_get") return { options: this.options };
    if (tool === "audit.option.add") {
      const draft = args.draft as Listing;
      // The tracker fits the keyword field: words in the name or subtitle are dropped.
      this.options.push({ id: "o1", measured: true, coverage: 0.42, draft: { ...draft, keywords: draft.keywords.replace("git,", "") }, phrases: [{ text: "git notes", storefront: "us", rank: 12, volume: 61, difficulty: 30, verdict: "good" }] });
    }
    return { ok: true };
  }
}

/** App Store Connect as the asc CLI sees it: one live version, and an editable one once `editable` is set. */
class FakeAsc {
  calls: string[][] = [];
  editable = false;
  fail: string | null = null;
  async run(args: string[]) {
    this.calls.push(args);
    if (this.fail && args.join(" ").includes(this.fail)) return { ok: false, stdout: "", stderr: "Forbidden" };
    const attrs = (version: string, state: string, createdDate: string) => ({ versionString: version, appVersionState: state, createdDate });
    if (args[0] === "versions") {
      return { ok: true, stderr: "", stdout: JSON.stringify({ data: [
        { id: "v301", attributes: attrs("3.0.1", "READY_FOR_DISTRIBUTION", "2026-11-16T11:00:00Z") },
        { id: "v300", attributes: attrs("3.0.0", "READY_FOR_DISTRIBUTION", "2026-11-01T11:00:00Z") },
        ...(this.editable ? [{ id: "v310", attributes: attrs("3.1.0", "PREPARE_FOR_SUBMISSION", "2026-11-25T11:00:00Z") }] : []),
      ] }) };
    }
    if (args[0] === "apps") {
      return { ok: true, stderr: "", stdout: JSON.stringify({ data: [
        { id: "info-live", attributes: { state: "READY_FOR_DISTRIBUTION" } }, ...(this.editable ? [{ id: "info-next", attributes: { state: "PREPARE_FOR_SUBMISSION" } }] : []),
      ] }) };
    }
    return { ok: true, stderr: "", stdout: "{}" };
  }
  writes() { return this.calls.filter(c => c[0] === "localizations").map(c => c.slice(0, -2).join(" ")); }
}

function setup(aso: Partial<AsoAppConfig> = {}, at = "2026-11-23T09:00:00") {
  const config = testConfig();
  for (const policy of Object.values(config.repos)) delete policy.aso;
  config.aso = { cli: "/x/aso", reportWeekday: 1, researchEveryDays: 7, hours: [8, 22] };
  config.repos[REPO] = { ...config.repos[REPO], aso: { appId: "6758960270", ...aso } };
  const store = new Store(":memory:");
  const tracker = new FakeTracker();
  const posts: string[] = [];
  const reactions: string[][] = [];
  const agents: AgentJsonInput[] = [];
  const asc = new FakeAsc();
  const reacted: Record<string, string[]> = {};
  const repo = new FakeRepo();
  let now = new Date(at);
  let output: unknown = { action: "skip", reason: "nothing better", name: "", subtitle: "", keywords: "", promotionalText: "", rationale: "", newPhrases: [] };
  const train = new AsoTrain({
    config, store, github: new FakeGitHub() as never, tracker, repo: () => repo,
    notifier: { discord: async (text: string, r: readonly string[] = []) => { posts.push(text); reactions.push([...r]); return { channelId: "staff", messageId: `m${posts.length}` }; } },
    approvals: { reactors: async (_c, messageId, emoji) => reacted[`${messageId}${emoji}`] ?? [], owners: async () => new Set(["owner"]) },
    asc: args => asc.run(args),
    agent: async input => { agents.push(input); return { output }; },
    now: () => now,
  });
  const app = asoApps(config).find(a => `${a.owner}/${a.repo}` === REPO)!;
  const react = (messageId: string, emoji: string, user: string) => { (reacted[`${messageId}${emoji}`] ??= []).push(user); };
  return { config, store, tracker, posts, reactions, react, asc, agents, repo, train, app, setNow: (d: string) => { now = new Date(d); }, setOutput: (o: unknown) => { output = o; } };
}

test("config: aso blocks need the runner-wide cli and a numeric app id", () => {
  const config = testConfig();
  assert.ok(asoApps(config).length >= 4, "the four App Store apps are followed");
  config.repos[REPO] = { ...config.repos[REPO], aso: { appId: "gitsync" } };
  assert.throws(() => validateConfig(config), /aso.appId must be an App Store app id/);
  const noCli = testConfig();
  delete noCli.aso;
  assert.throws(() => validateConfig(noCli), /aso needs the runner-wide aso.cli/);
  const off = testConfig();
  for (const policy of Object.values(off.repos)) if (policy.aso) policy.aso.autonomy = "off";
  assert.equal(asoApps(off).length, 0);
});

test("snapshots group successfully checked phrases by the local day they were checked", () => {
  const cells = boardCells(board([
    { text: "git", rank: 40, checkedAt: "2026-11-20T10:00:00" },
    { text: "Obsidian Git", rank: null, checkedAt: "2026-11-20T11:00:00" },
    { text: "commit", rank: 3, checkedAt: "2026-11-19T10:00:00" },
    { text: "push", rank: 9, checkedAt: "2026-11-20T10:00:00", error: "blocked" },
  ]));
  const days = snapshotsByDay(cells);
  assert.deepEqual([...days.keys()].sort(), ["2026-11-19", "2026-11-20"]);
  assert.deepEqual(days.get("2026-11-20"), { "us|git": [40, 50], "us|obsidian git": [null, 50] });
});

test("movers compare phrases measured in both weeks, unranked counting as 201, weighted by demand", () => {
  const m = movers(
    { "us|git": [40, 80], "us|commit": [3, 10], "us|push": [null, 60], "us|clone": [20, 5] },
    { "us|git": [30, 80], "us|commit": [5, 10], "us|push": [150, 60], "us|new": [1, 99] },
  );
  assert.equal(m.compared, 3);
  assert.deepEqual(m.gained.map(x => x.text), ["push", "git"]);
  assert.deepEqual(m.lost.map(x => [x.text, x.from, x.to]), [["commit", 3, 5]]);
  assert.deepEqual(m.now, { ranked: 3, top10: 1, top50: 2 });
  const text = reportText({ app: "GitSync.md", today: "2026-11-23", baselineDay: "2026-11-16", movers: m, storefront: "us", current: [] });
  assert.match(text, /\*\*Up\*\* \(2\)\n• `push` — → #150/);
  assert.match(text, /\*\*Down\*\* \(1\)\n• `commit` #3 → #5/);
});

test("the weekly report records a baseline first, then compares against the snapshot a week earlier", async () => {
  const { train, tracker, posts, setNow, store } = setup({ autonomy: "report" }, "2026-11-16T09:00:00");
  tracker.board = board([{ text: "git", rank: 40, checkedAt: "2026-11-16T07:00:00" }, { text: "obsidian", rank: null, inListing: true, volume: 90, checkedAt: "2026-11-16T07:00:00" }]);
  await train.tick();
  assert.equal(posts.length, 1);
  assert.match(posts[0], /this one is the baseline/);
  assert.match(posts[0], /In the listing but not in the top 200.*`obsidian`/);
  await train.tick();
  assert.equal(posts.length, 1, "one report per week");

  setNow("2026-11-20T09:00:00");
  tracker.board = board([{ text: "git", rank: 33, checkedAt: "2026-11-20T07:00:00" }]);
  await train.tick();
  assert.equal(posts.length, 1, "not on other weekdays");
  setNow("2026-11-23T09:00:00");
  tracker.board = board([{ text: "git", rank: 25, checkedAt: "2026-11-23T07:00:00" }]);
  await train.tick();
  assert.equal(posts.length, 2);
  assert.match(posts[1], /vs 2026-11-16/);
  assert.match(posts[1], /`git` #40 → #25/);
  assert.equal(store.cursorsWithPrefix("aso:6758960270:day:").length, 3);
});

test("old snapshots are dropped", async () => {
  const { train, store, app } = setup({}, "2026-11-20T09:00:00");
  store.setCursor("aso:6758960270:day:2026-01-01", "{}");
  store.setCursor("aso:6758960270:day:2026-11-01", "{}");
  await train.snapshot(app);
  assert.deepEqual(store.cursorsWithPrefix("aso:6758960270:day:").map(r => r.key), ["aso:6758960270:day:2026-11-01"]);
});

test("parseProposal keeps the brand and Apple's limits, falling back field by field", () => {
  assert.equal(brandOf("Vox.md - Quick Capture Notes"), "Vox.md");
  const p = parseProposal({
    action: "propose", reason: "", rationale: "r",
    name: "Git Notes Sync", subtitle: "x".repeat(31), keywords: "git, notes ,markdown,,", promotionalText: "New promo.",
    newPhrases: [{ text: "Git Notes", concept: "notes" }, { text: "git notes", concept: "dup" }, { text: "", concept: "" }],
  }, CURRENT);
  assert.equal(p.action, "propose");
  assert.equal(p.name, CURRENT.name, "a name without the brand is refused");
  assert.equal(p.subtitle, CURRENT.subtitle, "over 30 characters");
  assert.equal(p.keywords, "git,notes,markdown");
  assert.equal(p.promotionalText, "New promo.");
  assert.deepEqual(p.newPhrases, [{ text: "git notes", concept: "notes" }]);
  const same = parseProposal({ action: "propose", ...CURRENT, rationale: "", reason: "", newPhrases: [] }, CURRENT);
  assert.equal(same.action, "skip");
});

test("research measures the draft and new phrases in the tracker and posts the diff to the staff channel only", async () => {
  const { train, tracker, posts, agents, app, store, setOutput, repo } = setup({ notes: "Keep it about notes." });
  store.setCursor("aso:6758960270:report", "2026-11-23");
  tracker.board = board([{ text: "github", rank: 30, volume: 88, inListing: true, checkedAt: "2026-11-23T07:00:00" }]);
  setOutput({
    action: "propose", reason: "", rationale: "Trade low-demand words for git notes.",
    name: "GitSync.md: Git Notes", subtitle: "Git sync for Obsidian", keywords: "git,github,markdown,vault", promotionalText: CURRENT.promotionalText,
    newPhrases: [{ text: "git notes", concept: "notes" }, { text: "github", concept: "already tracked" }],
  });
  const result = await train.maybeResearch(app);
  assert.ok(result);
  const tools = tracker.calls.map(c => c.tool);
  assert.deepEqual(tools, ["app.fetch", "listing_get", "board_get", "keywords_import", "audit.option.add", "audit_get", "board_get"]);
  assert.ok(!tools.includes("audit.publish"), "never publishes");
  const imported = tracker.calls.find(c => c.tool === "keywords_import")!;
  assert.equal(imported.wait, true);
  assert.deepEqual(imported.args.concepts, [{ label: "notes", tier: "secondary", phrases: [{ storefront: "us", text: "git notes" }] }]);
  assert.equal(agents[0].tools, "Read,Grep,Glob");
  assert.match(agents[0].system, /Keep it about notes/);
  assert.match(agents[0].prompt, /github \| #30 \| 88 \| 40 \| in listing/);
  assert.ok(repo.calls.some(c => c.startsWith("remove aso__research-")), "the checkout is removed");
  assert.equal(result.proposal.keywords, "github,markdown,vault", "the tracker's fitted keyword field");
  const text = posts.join("\n");
  assert.match(text, /\*\*Name\*\* \(21\/30\)\n- `GitSync.md`\n\+ `GitSync.md: Git Notes`/);
  assert.match(text, /`git notes` #12 · demand 61/);
  assert.match(text, /Nothing was changed in App Store Connect/);
  assert.ok(!/Promotional text/.test(text.split("**Why**")[0]), "unchanged fields aren't in the diff");
  assert.equal(train.researchDue(app), false, "a week until the next run");
});

test("research waits for the week's report, respects hours and pauses, and a skip is posted once", async () => {
  const { train, app, store, posts, agents, setNow } = setup();
  assert.equal(train.researchDue(app), false, "report day, report not sent yet");
  store.setCursor("aso:6758960270:report", "2026-11-23");
  assert.equal(train.researchDue(app), true);
  setNow("2026-11-23T23:00:00");
  assert.equal(train.researchDue(app), false, "outside the hours");
  setNow("2026-11-23T09:00:00");
  store.pauseBuilds(Date.now() + 3_600_000, "usage limit");
  assert.equal(await train.maybeResearch(app), null);
  assert.equal(agents.length, 0);
  store.setCursor("builds:paused_until", "");
  await train.maybeResearch(app);
  assert.deepEqual(posts, ["🔎 **GitSync.md** listing research (en-US): no change proposed. nothing better"]);
});

test("a failed App Store Connect refresh or draft measurement is reported, not fatal", async () => {
  const { train, tracker, posts, app, store, setOutput } = setup();
  store.setCursor("aso:6758960270:report", "2026-11-23");
  tracker.fail["app.fetch"] = "403";
  tracker.fail["audit.option.add"] = "Subtitle repeats the name";
  setOutput({ action: "propose", reason: "", rationale: "", ...CURRENT, promotionalText: "Fresh promo text.", newPhrases: [] });
  await train.maybeResearch(app);
  const text = posts.join("\n");
  assert.match(text, /couldn't measure the draft: Subtitle repeats the name/);
  assert.match(text, /React ✅ to apply: the promotional text goes live right away\. 🛑/);
});

test("a failed import job only warns when our new phrases weren't measured", async () => {
  const { train, tracker, posts, app, store, setOutput } = setup();
  store.setCursor("aso:6758960270:report", "2026-11-23");
  tracker.fail["keywords_import"] = "br: client: Apple omitted details";
  tracker.board = board([{ text: "git notes", rank: 12, checkedAt: "2026-11-23T07:00:00" }]);
  setOutput({ action: "propose", reason: "", rationale: "", ...CURRENT, keywords: "notes,vault", newPhrases: [{ text: "git notes", concept: "notes" }, { text: "git vault", concept: "vault" }] });
  // "git notes" is already tracked, so only "git vault" is new, and the board doesn't have it.
  await train.maybeResearch(app);
  assert.match(posts.join("\n"), /1 of 1 new phrases weren't measured: br: client/);
  posts.length = 0;
  tracker.board = board([]);
  tracker.imported = [{ text: "git notes", rank: 12, checkedAt: "2026-11-23T08:00:00" }, { text: "git vault", rank: null, checkedAt: "2026-11-23T08:00:00" }];
  store.deleteCursor("aso:6758960270:research");
  await train.maybeResearch(app);
  const text = posts.join("\n");
  assert.doesNotMatch(text, /weren't measured/);
  assert.match(text, /New phrases now tracked\*\*\n• `git notes` #12 · demand 50 · difficulty 40\n• `git vault` —/);
});

test("splitMessage keeps Discord messages under the limit, splitting between paragraphs", () => {
  const parts = splitMessage(["a".repeat(1000), "b".repeat(1000), "c".repeat(10)].join("\n\n"));
  assert.equal(parts.length, 2);
  assert.ok(parts.every(p => p.length <= 1900));
  assert.ok(parts[1].startsWith("b"));
});

const DRAFT = {
  action: "propose", reason: "", rationale: "More demand.", name: "GitSync.md: Git Notes", subtitle: CURRENT.subtitle,
  keywords: "commit,push,branch", promotionalText: "Git for your notes, now faster.", newPhrases: [],
};

async function proposed() {
  const t = setup();
  t.store.setCursor("aso:6758960270:report", "2026-11-23");
  t.setOutput(DRAFT);
  await t.train.maybeResearch(t.app);
  return t;
}

test("a proposal carries ✅ and 🛑, and an owner's ✅ puts the promotional text live and queues the rest for the next version", async () => {
  const { train, app, posts, reactions, react, asc, setNow } = await proposed();
  assert.deepEqual(reactions.at(-1), ["✅", "🛑"], "the last message carries the controls");
  assert.match(posts.join("\n"), /React ✅ to apply: the promotional text goes live right away, and the name and keywords go onto the next App Store version/);
  const ref = `m${posts.length}`;
  const p = train.pending(app)!;
  assert.equal(p.state, "open");
  assert.deepEqual(changedFields(p), ["name", "keywords", "promotionalText"]);

  react(ref, "✅", "stranger");
  await train.poll();
  assert.equal(train.pending(app)!.state, "open", "only the staff chat's allowlist approves");
  assert.equal(asc.calls.length, 0);

  react(ref, "✅", "owner");
  await train.poll();
  assert.deepEqual(asc.writes(), ["localizations update --version v301 --locale en-US --promotional-text Git for your notes, now faster."]);
  assert.match(posts.at(-1)!, /approved by <@owner>.*Promotional text is live on 3\.0\.1\. The name and keywords wait for the next App Store version/);
  assert.equal(train.pending(app)!.state, "approved");
  assert.equal(train.researchDue(app), false, "no new draft over an approved one");

  const before = posts.length;
  await train.poll();
  assert.equal(posts.length, before, "waiting is said once");
  assert.equal(asc.writes().length, 1);

  asc.editable = true;
  setNow("2026-11-25T12:00:00");
  await train.poll();
  assert.deepEqual(asc.writes().slice(1), [
    "localizations update --version v310 --locale en-US --keywords commit,push,branch",
    "localizations update --type app-info --app 6758960270 --app-info info-next --locale en-US --name GitSync.md: Git Notes",
  ]);
  assert.match(posts.at(-1)!, /The name and keywords are set on 3\.1\.0 \(prepare for submission\)/);
  assert.equal(train.pending(app)!.state, "done");
  await train.poll();
  assert.equal(asc.writes().length, 3, "done is done");
});

test("🛑 dismisses a proposal, and an unanswered one expires", async () => {
  const t = await proposed();
  t.react(`m${t.posts.length}`, "🛑", "owner");
  await t.train.poll();
  assert.equal(t.train.pending(t.app)!.state, "rejected");
  assert.match(t.posts.at(-1)!, /dismissed by <@owner>/);
  assert.equal(t.asc.calls.length, 0);

  const u = await proposed();
  u.setNow("2026-12-08T09:00:00");
  await u.train.poll();
  assert.equal(u.train.pending(u.app)!.state, "expired");
  await assert.rejects(u.train.approve(u.app, "cli"), /expired, not open/);
});

test("a failed write is reported once and retried; a newer proposal supersedes an open one", async () => {
  const { train, app, posts, asc } = await proposed();
  asc.fail = "--promotional-text";
  await assert.rejects(train.approve(app, "cli"), /Forbidden/);
  assert.match(posts.at(-1)!, /❌ \*\*GitSync.md\*\* listing update failed: asc localizations update failed: Forbidden/);
  const count = posts.length;
  await train.poll();
  assert.equal(posts.length, count, "the same error isn't repeated");
  asc.fail = null;
  await train.poll();
  assert.match(posts.at(-1)!, /Promotional text is live/);

  const t = await proposed();
  t.setNow("2026-11-30T09:00:00");
  t.store.setCursor("aso:6758960270:report", "2026-11-30");
  await t.train.maybeResearch(t.app);
  const p = t.train.pending(t.app)!;
  assert.equal(p.state, "open");
  assert.equal(p.at.slice(0, 10), "2026-11-30");
});

test("a proposal from before approvals can be approved by command; every field is written", async () => {
  const { train, app, store, asc } = setup();
  store.setCursor("aso:6758960270:proposal", JSON.stringify({ at: "2026-11-20T13:34:00Z", ...DRAFT }));
  asc.editable = true;
  await train.approve(app, "cli");
  assert.equal(asc.writes().length, 4, "promo on live and editable, keywords, and name + subtitle in one app-info update");
  assert.ok(asc.writes().some(w => w.includes("--name GitSync.md: Git Notes --subtitle Git sync for notes")));
  assert.equal(train.pending(app)!.state, "done");
});

test("version and app info picking, brand warnings and the apply hint", () => {
  assert.deepEqual(pickVersions({ data: [
    { id: "a", attributes: { versionString: "1.0", appVersionState: "READY_FOR_DISTRIBUTION", createdDate: "2026-01-01" } },
    { id: "b", attributes: { versionString: "1.1", appVersionState: "WAITING_FOR_REVIEW", createdDate: "2026-02-01" } },
  ] }), { live: { id: "a", version: "1.0", state: "READY_FOR_DISTRIBUTION", createdDate: "2026-01-01" }, editable: null }, "in review isn't editable");
  assert.equal(editableAppInfo({ data: [{ id: "x", attributes: { state: "READY_FOR_DISTRIBUTION" } }] }), null);
  assert.deepEqual(brandWarnings("data,obsidian,apple,hrv"), ["apple", "obsidian"]);
  assert.match(applyHint(["promotionalText"]), /^React ✅ to apply: the promotional text goes live right away\. 🛑/);
  assert.match(applyHint(["keywords"]), /the keywords go onto/);
  assert.match(applyHint(["subtitle"]), /the subtitle goes onto/);
});
