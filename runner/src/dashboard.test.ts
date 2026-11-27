import assert from "node:assert/strict";
import { test } from "node:test";
import { Dashboard, buildSnapshot, closesIssue, every, inheritSources, itemSource, nextDailyAt, nextWeeklyAt, type BoardItem, type BoardSnapshot } from "./dashboard.js";
import { Store } from "./store.js";

const item = (number: number): BoardItem => ({
  repo: "o/r", number, kind: "issue", title: `Issue ${number}`, url: `https://github.com/o/r/issues/${number}`, state: "open",
  merged: false, draft: false, author: "o", labels: ["isobot:ready"], comments: 0,
  createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z", closedAt: null, source: { kind: "github" },
});

function harness(answers: (number | { lastEventId: number })[]) {
  const store = new Store(":memory:");
  const sent: BoardSnapshot[] = [];
  let githubReads = 0;
  let clock = Date.parse("2026-11-20T12:00:00Z");
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)));
    const answer = answers.shift() ?? 500;
    return typeof answer === "number" ? new Response("no", { status: answer }) : Response.json(answer);
  }) as typeof fetch;
  const dashboard = new Dashboard({
    url: "https://bot.example", token: "t", runnerId: "laptop", store,
    github: { boardItems: async () => { githubReads++; return [item(githubReads)]; } },
    repos: () => [{ name: "o/r", autonomy: "pr", ownerAutonomy: "merge", train: false, content: false, aso: false }],
    schedule: () => [], live: () => ({ startedAt: "", activeJobs: [], manuallyPaused: false, lastTriageAt: null, lastCycleError: null }),
    queued: () => 0, fetch: fetchImpl, now: () => new Date(clock), githubEveryMs: 300_000,
  });
  return { store, sent, dashboard, reads: () => githubReads, advance: (ms: number) => { clock += ms; } };
}

test("snapshots leave builder sessions out and clip long texts", () => {
  const store = new Store(":memory:");
  const job = store.enqueue("o", "r", 1, "Add dark mode")!;
  store.update(job.id, { sessionId: "secret-session", lastError: "x".repeat(2000) });
  store.event(job.id, "note", "y".repeat(5000));
  const snapshot = buildSnapshot({
    now: new Date("2026-11-20T12:00:00Z"), runnerId: "laptop",
    live: { startedAt: "", activeJobs: [], manuallyPaused: false, lastTriageAt: null, lastCycleError: null },
    queued: 1, buildsPausedUntil: null, repos: [], schedule: [], jobs: store.all(), followUps: [],
    events: store.eventsSince(0), github: null,
  });
  assert.equal("sessionId" in snapshot.jobs[0], false);
  assert.ok(!JSON.stringify(snapshot).includes("secret-session"));
  assert.equal(snapshot.jobs[0].lastError!.length, 600);
  assert.ok(snapshot.events[0].text.length <= 600);
});

test("pushes send only events the board doesn't have yet", async () => {
  const h = harness([{ lastEventId: 2 }, { lastEventId: 3 }]);
  h.store.event(null, "a", null);
  h.store.event(null, "b", null);
  assert.equal(await h.dashboard.push(), true);
  assert.deepEqual(h.sent[0].events.map(e => e.kind), ["a", "b"]);
  h.store.event(null, "c", null);
  await h.dashboard.push();
  assert.deepEqual(h.sent[1].events.map(e => e.kind), ["c"]);
});

test("a failed push resends the GitHub read instead of reading GitHub again", async () => {
  const h = harness([500, { lastEventId: 0 }, { lastEventId: 0 }]);
  assert.equal(await h.dashboard.push(), false);
  assert.equal(h.reads(), 1);
  h.advance(60_000);
  assert.equal(await h.dashboard.push(), true);
  assert.equal(h.reads(), 1, "no second GitHub read inside the interval");
  assert.equal(h.sent[1].github?.items[0].number, 1, "the unsent read goes with the retry");
  h.advance(60_000);
  await h.dashboard.push();
  assert.equal(h.sent[2].github, null, "once delivered, quiet pushes carry no GitHub data");
});

test("a 409 from the board resends recent history", async () => {
  const h = harness([{ lastEventId: 1 }, 409, { lastEventId: 2 }]);
  h.store.event(null, "a", null);
  await h.dashboard.push();
  h.store.event(null, "b", null);
  assert.equal(await h.dashboard.push(), false);
  await h.dashboard.push();
  assert.deepEqual(h.sent[2].events.map(e => e.kind), ["a", "b"]);
});

test("schedule helpers find the next local run", () => {
  const now = new Date(2026, 10, 20, 10, 30); // Friday 10:30 local
  assert.equal(nextDailyAt(now, 9).getDate(), 21);
  assert.equal(nextDailyAt(now, 11).getDate(), 20);
  const monday = nextWeeklyAt(now, 1, 8);
  assert.equal(monday.getDay(), 1);
  assert.equal(monday.getDate(), 23);
  assert.equal(nextWeeklyAt(new Date(2026, 10, 23, 7), 1, 8).getDate(), 23, "later the same day");
  const item = every("t", "Triage", 30 * 60_000, Date.parse("2026-11-20T10:00:00Z"), false);
  assert.equal(item.cadence, "every 30 min");
  assert.equal(item.nextAt, "2026-11-20T10:30:00.000Z");
  assert.equal(every("a", "ASO", 3_600_000, 0, true).cadence, "every hour");
});

test("item sources come from what isobot wrote into the issue", () => {
  const footer = (id: string) => `\n\n---\n<sub>Proposed by isobot triage (small, confidence 0.90): x. y</sub>\n<!-- isobot:triage:${id} -->`;
  assert.deepEqual(itemSource(`Spec\n\n**Source:** discord message from sam: https://discord.com/channels/1/2/3${footer("discord:3")}`),
    { kind: "discord", url: "https://discord.com/channels/1/2/3" });
  assert.deepEqual(itemSource(`Spec\n\n**Source:** App Store review (2/5 stars): https://apps.apple.com/app/id1?see-all=reviews${footer("appstore:9")}`),
    { kind: "appstore", url: "https://apps.apple.com/app/id1?see-all=reviews" });
  // Email links never leave the runner, even if one slipped into the body.
  assert.deepEqual(itemSource(`Spec\n\n**Source:** email message from a@b.c: https://mail.example/x${footer("email:a@b.c:1:2")}`), { kind: "email" });
  assert.deepEqual(itemSource(`Spec\n\n**Source:** the owner's Vox.md voice note${footer("vox:abc")}`), { kind: "vox" });
  assert.deepEqual(itemSource("Do the thing\n\n<!-- isobot:chat -->"), { kind: "chat" });
  assert.deepEqual(itemSource("From a voice note", ["from-vox", "bug"]), { kind: "vox" });
  assert.deepEqual(itemSource("Brief\n\n---\n<sub>Researched by isobot's content train for x.com. It builds…</sub>"), { kind: "content" });
  assert.deepEqual(itemSource("## isobot release train\n\nVersion **1.2**"), { kind: "release" });
  assert.deepEqual(itemSource("Crash on launch"), { kind: "github" });
  assert.deepEqual(itemSource(null), { kind: "github" });
});

test("PRs take the source of the issue they close", () => {
  assert.equal(closesIssue("Builds it.\n\nCloses #12"), 12);
  assert.equal(closesIssue("fixes #7 too"), 7);
  assert.equal(closesIssue("See #4"), undefined);
  const issue = { ...item(12), source: { kind: "vox" as const } };
  const pr = { ...item(13), kind: "pr" as const, closes: 12 };
  const orphan = { ...item(14), kind: "pr" as const, closes: 99 };
  assert.deepEqual(inheritSources([issue, pr, orphan]).map(i => i.source.kind), ["vox", "vox", "github"]);
});

test("metrics go with a push only when they changed, and again after the board asks for a resync", async () => {
  const store = new Store(":memory:");
  const sent: BoardSnapshot[] = [];
  const answers: (number | { lastEventId: number })[] = [{ lastEventId: 0 }, { lastEventId: 0 }, { lastEventId: 0 }, 409, { lastEventId: 0 }];
  let clock = Date.parse("2026-11-20T12:00:00Z");
  let impressions = 1;
  const metrics = (now: Date) => ({ at: now.toISOString(), apps: [], sites: [], credits: { days: [{ day: "2026-11-20", spent: impressions }], balance: null } });
  const dashboard = new Dashboard({
    url: "https://bot.example", token: "t", runnerId: "laptop", store, github: { boardItems: async () => [] },
    repos: () => [], schedule: () => [], live: () => ({ startedAt: "", activeJobs: [], manuallyPaused: false, lastTriageAt: null, lastCycleError: null }),
    queued: () => 0, metrics, metricsEveryMs: 60_000, now: () => new Date(clock),
    fetch: (async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      const answer = answers.shift() ?? 500;
      return typeof answer === "number" ? new Response("no", { status: answer }) : Response.json(answer);
    }) as typeof fetch,
  });
  await dashboard.push();
  assert.ok(sent[0].metrics);
  clock += 60_000;
  await dashboard.push();
  assert.equal(sent[1].metrics, null, "same series, only a newer time: not sent");
  impressions = 2;
  clock += 60_000;
  await dashboard.push();
  assert.equal(sent[2].metrics?.credits.days[0].spent, 2);
  await dashboard.push();
  assert.equal(sent[3].metrics, null);
  // The 409 made the board ask for everything again.
  await dashboard.push();
  assert.equal(sent[4].metrics?.credits.days[0].spent, 2);
});

test("the Vox notebook goes with a push when it changed, and not at all when there is none", async () => {
  const store = new Store(":memory:");
  const sent: BoardSnapshot[] = [];
  let clock = Date.parse("2026-11-20T12:00:00Z");
  let notes = 1;
  let present = true;
  const vox = (now: Date) => present
    ? { at: now.toISOString(), notes: Array.from({ length: notes }, (_, i) => ({ path: `notes/ideas/${i}.md`, kind: "idea", title: `${i}`, captured: null, updated: "2026-11-20T00:00:00Z", status: "open", projects: [], links: [], source: null, body: "" })), actions: [], themes: [], review: [], lastRun: null, privateCount: 0 }
    : null;
  const dashboard = new Dashboard({
    url: "https://bot.example", token: "t", runnerId: "laptop", store, github: { boardItems: async () => [] },
    repos: () => [], schedule: () => [], live: () => ({ startedAt: "", activeJobs: [], manuallyPaused: false, lastTriageAt: null, lastCycleError: null }),
    queued: () => 0, vox, voxEveryMs: 60_000, now: () => new Date(clock),
    fetch: (async (_url: string, init: RequestInit) => { sent.push(JSON.parse(String(init.body))); return Response.json({ lastEventId: 0 }); }) as typeof fetch,
  });
  await dashboard.push();
  assert.equal(sent[0].vox?.notes.length, 1);
  assert.equal(sent[0].metrics, null, "no metrics source, no metrics");
  clock += 60_000;
  await dashboard.push();
  assert.equal(sent[1].vox, null, "unchanged");
  notes = 2;
  await dashboard.push();
  assert.equal(sent[2].vox, null, "not due yet");
  clock += 60_000;
  await dashboard.push();
  assert.equal(sent[3].vox?.notes.length, 2);
  present = false;
  clock += 60_000;
  await dashboard.push();
  assert.equal(sent[4].vox, null, "a notebook that went away leaves the board's copy alone");
});

test("actions in the board's answer are applied once and reported in the next push", async () => {
  const store = new Store(":memory:");
  const sent: BoardSnapshot[] = [];
  const action = { id: "x1", kind: "approve", repo: "o/r", number: 2, by: "me" };
  const answers = [{ lastEventId: 0, actions: [action] }, { lastEventId: 0, actions: [action] }, { lastEventId: 0, actions: [] }];
  const applied: string[] = [];
  const dashboard = new Dashboard({
    url: "https://bot.example", token: "t", runnerId: "laptop", store, github: { boardItems: async () => [] },
    repos: () => [], schedule: () => [], live: () => ({ startedAt: "", activeJobs: [], manuallyPaused: false, lastTriageAt: null, lastCycleError: null }),
    queued: () => 0,
    act: async a => { applied.push(a.id); return { id: a.id, ok: true, text: "Approved" }; },
    fetch: (async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      return Response.json(answers.shift());
    }) as typeof fetch,
  });
  await dashboard.push();
  assert.equal(sent[0].actionResults, undefined);
  // The board hands the same action out again before it has the result: it isn't applied twice.
  await dashboard.push();
  assert.deepEqual(sent[1].actionResults, [{ id: "x1", ok: true, text: "Approved" }]);
  await dashboard.push();
  assert.equal(sent[2].actionResults, undefined, "acknowledged results aren't sent again");
  assert.deepEqual(applied, ["x1"]);
});
