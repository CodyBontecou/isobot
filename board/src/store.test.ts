import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { BadAction, BadArtifacts, BadSnapshot, BoardStore, type Sql } from "./store.js";

/** Durable Object SQLite's exec(), over node:sqlite. */
function sql(): Sql {
  const db = new DatabaseSync(":memory:");
  return {
    exec(query: string, ...bindings: unknown[]) {
      const statement = db.prepare(query);
      const rows = statement.columns().length ? statement.all(...(bindings as never[])) : (statement.run(...(bindings as never[])), []);
      return { toArray: () => rows as Record<string, unknown>[] };
    },
  };
}

const now = new Date("2026-11-20T12:00:00Z");
const event = (id: number, at = "2026-11-20T11:00:00Z", jobId: string | null = "o/r#1") => ({ id, jobId, at, kind: "state", text: `event ${id}` });
const snapshot = (overrides: Record<string, unknown> = {}) => ({
  v: 1, at: now.toISOString(), runnerId: "laptop",
  runner: { startedAt: "", activeJobs: [], manuallyPaused: false, lastTriageAt: null, lastCycleError: null, pid: 1, queued: 0, buildsPausedUntil: null },
  repos: [], schedule: [], jobs: [], followUps: [], events: [], github: null, ...overrides,
});

test("ingest keeps the latest snapshot and accumulates events", () => {
  const store = new BoardStore(sql());
  assert.deepEqual(store.ingest(snapshot({ events: [event(1), event(2)] }), now), { ok: true, lastEventId: 2, actions: [] });
  // A runner restart resends overlapping history; duplicates are ignored.
  assert.equal(store.ingest(snapshot({ events: [event(2), event(3)], jobs: [{ id: "o/r#1" }] }), now).lastEventId, 3);
  assert.equal(store.events({ since: "2026-11-01T00:00:00Z" }).length, 3);
  const board = store.board();
  assert.equal(board.runners.length, 1);
  assert.deepEqual(board.runners[0].jobs, [{ id: "o/r#1" }]);
  assert.equal("events" in board.runners[0], false, "events are served separately");
});

test("GitHub data survives pushes that carry none", () => {
  const store = new BoardStore(sql());
  store.ingest(snapshot({ github: { at: now.toISOString(), items: [{ number: 1 }], errors: [] } }), now);
  store.ingest(snapshot(), now);
  assert.deepEqual((store.board().github as { items: unknown[] }).items, [{ number: 1 }]);
});

test("a runner whose event ids went backwards starts its history over", () => {
  const store = new BoardStore(sql());
  store.ingest(snapshot({ events: [event(10), event(11)] }), now);
  assert.equal(store.ingest(snapshot({ events: [event(1)] }), now).lastEventId, 1);
  assert.deepEqual(store.events({ since: "2026-11-01T00:00:00Z" }).map(e => e.id), [1]);
});

test("events older than 400 days are pruned and job filters apply", () => {
  const store = new BoardStore(sql());
  store.ingest(snapshot({ events: [event(1, "2025-10-01T00:00:00Z"), event(2, "2026-11-20T10:00:00Z", "o/r#2"), event(3)] }), now);
  assert.deepEqual(store.events({ since: "2026-01-01T00:00:00Z" }).map(e => e.id), [3, 2]);
  assert.deepEqual(store.events({ since: "2026-01-01T00:00:00Z", jobId: "o/r#2" }).map(e => e.id), [2]);
});

test("malformed snapshots are refused", () => {
  const store = new BoardStore(sql());
  for (const bad of [null, [], snapshot({ v: 2 }), snapshot({ runnerId: "../x" }), snapshot({ jobs: "x" }),
    snapshot({ events: [event(2), event(1)] }), snapshot({ events: [{ id: 1 }] }), snapshot({ github: { items: [] } })]) {
    assert.throws(() => store.ingest(bad, now), BadSnapshot);
  }
});

test("metrics are kept apart from the runner snapshot and survive pushes without them", () => {
  const store = new BoardStore(sql());
  assert.equal(store.metrics(), null);
  const metrics = { at: now.toISOString(), apps: [{ id: "1" }], sites: [], credits: { days: [], balance: null } };
  store.ingest(snapshot({ metrics }), now);
  assert.deepEqual(store.metrics(), metrics);
  assert.equal("metrics" in store.board().runners[0], false, "metrics are served on their own");
  store.ingest(snapshot({ metrics: null }), now);
  store.ingest(snapshot(), now);
  assert.deepEqual(store.metrics(), metrics);
  assert.throws(() => store.ingest(snapshot({ metrics: { at: "soon", apps: [], sites: [], credits: {} } }), now), BadSnapshot);
  assert.throws(() => store.ingest(snapshot({ metrics: { at: now.toISOString(), apps: {}, sites: [], credits: {} } }), now), BadSnapshot);
});

test("the summary counts by hour from the comparison start and names highlights in the period", () => {
  const store = new BoardStore(sql());
  const kind = (id: number, k: string, at: string, jobId: string | null = "o/r#1") => ({ ...event(id, at, jobId), kind: k });
  store.ingest(snapshot({
    events: [
      kind(1, "state:merged", "2026-11-18T09:10:00Z"),
      kind(2, "checks", "2026-11-19T09:20:00Z"),
      kind(3, "state:merged", "2026-11-19T09:30:00Z", "o/s#4"),
      kind(4, "aso_error", "2026-11-19T10:00:00Z", null),
      kind(5, "content_proposed", "2026-11-20T23:59:00Z", null),
    ],
    jobs: [{ id: "o/s#4", title: "Fix it", updatedAt: "2026-11-19T09:30:00Z" }, { id: "o/r#1", title: "Other", updatedAt: "2026-11-18T09:10:00Z" }],
    github: { at: now.toISOString(), errors: [], items: [
      { repo: "o/r", number: 7, kind: "pr", createdAt: "2026-11-10T00:00:00Z", closedAt: "2026-11-19T12:00:00Z", merged: true },
      { repo: "o/r", number: 8, kind: "issue", createdAt: "2026-11-01T00:00:00Z", closedAt: null },
    ] },
  }), now);
  // An item that later drops out of the snapshot is still kept.
  store.ingest(snapshot({ github: { at: now.toISOString(), errors: [], items: [] } }), now);
  const s = store.summary({ from: "2026-11-19T00:00:00.000Z", to: "2026-11-20T00:00:00.000Z", compareFrom: "2026-11-18T00:00:00.000Z" });
  assert.deepEqual(s.hours.map(h => `${h.hour} ${h.kind} ${h.repo} ${h.n}`).sort(), [
    "2026-11-18T09 state:merged o/r 1", "2026-11-19T09 checks o/r 1", "2026-11-19T09 state:merged o/s 1", "2026-11-19T10 aso_error null 1",
  ]);
  assert.deepEqual(s.highlights.map(e => e.id), [4, 3], "merges and errors are named; checks and the next day aren't");
  assert.deepEqual(s.jobs, [{ id: "o/s#4", title: "Fix it", updatedAt: "2026-11-19T09:30:00Z" }]);
  assert.deepEqual((s.items as { number: number }[]).map(i => i.number), [7]);
  assert.equal(s.eventsSince, "2026-11-18T09:10:00Z");
  assert.equal(s.itemsSince, "2026-11-06T12:00:00.000Z", "first seen, less the snapshot's 14 days of closed items");
  assert.deepEqual(store.calendar({ from: "2026-11-19T00:00:00Z", to: "2026-11-21T00:00:00Z" }).hours.map(h => h.n).reduce((a, b) => a + b), 4);
});

test("task actions queue for the runner until it reports back", () => {
  const store = new BoardStore(sql());
  const repos = [{ name: "Owner/App" }];
  assert.throws(() => store.queueAction({ kind: "approve", repo: "owner/app", number: 3, by: "me" }, now), BadAction, "no runner, no repositories");
  store.ingest(snapshot({ repos }), now);
  assert.throws(() => store.queueAction({ kind: "merge", repo: "owner/app", number: 3, by: "me" }, now), BadAction);
  assert.throws(() => store.queueAction({ kind: "approve", repo: "other/app", number: 3, by: "me" }, now), BadAction);
  assert.throws(() => store.queueAction({ kind: "approve", repo: "owner/app", number: 0, by: "me" }, now), BadAction);

  const first = store.queueAction({ kind: "approve", repo: "owner/app", number: 3, by: "me" }, now);
  assert.equal(first.repo, "Owner/App", "the runner's spelling");
  // A second click on the same task replaces the first while it waits.
  const second = store.queueAction({ kind: "dismiss", repo: "owner/app", number: 3, by: "me" }, now);
  const other = store.queueAction({ kind: "stop", repo: "owner/app", number: 4, by: "me" }, now);
  const handed = store.ingest(snapshot({ repos }), now).actions;
  assert.deepEqual(handed.map(a => a.id).sort(), [second.id, other.id].sort());
  assert.deepEqual(store.pendingActions(now).map(a => a.id).sort(), [second.id, other.id].sort(), "handed out until answered");

  store.ingest(snapshot({ repos, actionResults: [{ id: second.id, ok: true, text: "Dismissed" }, { id: other.id, ok: false, text: "it's closed" }] }), now);
  assert.deepEqual(store.pendingActions(now), []);
  const rows = store.board(now).actions;
  assert.equal(rows.find(a => a.id === second.id)?.state, "done");
  assert.equal(rows.find(a => a.id === other.id)?.result, "it's closed");
  assert.equal("actionResults" in store.board(now).runners[0], false);

  // Unanswered clicks are given up after a while; finished ones are dropped after two days.
  const late = store.queueAction({ kind: "retry", repo: "owner/app", number: 5, by: "me" }, now);
  const later = new Date(now.getTime() + 20 * 60_000);
  assert.deepEqual(store.pendingActions(later), []);
  assert.equal(store.board(later).actions.find(a => a.id === late.id)?.state, "failed");
  assert.deepEqual(store.board(new Date(now.getTime() + 3 * 86_400_000)).actions, []);
});

test("a snapshot with malformed action results is refused", () => {
  const store = new BoardStore(sql());
  assert.throws(() => store.ingest(snapshot({ actionResults: "nope" }), now), BadSnapshot);
  assert.doesNotThrow(() => store.ingest(snapshot({ actionResults: [null, { id: 1 }] }), now), "bad entries are skipped");
});

test("the artifact list is replaced whole and checked", () => {
  const store = new BoardStore(sql());
  assert.equal(store.artifacts(), null);
  const artifact = { title: "Health.md — iOS", url: "https://claude.ai/artifact/ReJHGf1T1VmasyhyVDdBke", project: "Health.md", repo: "codybontecou/health-md", kind: "Design", updatedAt: "2026-11-10" };
  assert.deepEqual(store.setArtifacts({ v: 1, at: now.toISOString(), artifacts: [artifact, { ...artifact, url: "https://claude.ai/code/artifact/abcdefgh-1234", repo: null }] }, now), { ok: true, count: 2 });
  const list = store.artifacts();
  assert.equal(list?.artifacts.length, 2);
  assert.deepEqual(list?.artifacts[0], { ...artifact, pinned: false, shared: false });
  assert.equal(list?.receivedAt, now.toISOString());
  store.setArtifacts({ v: 1, at: now.toISOString(), artifacts: [artifact] }, now);
  assert.equal(store.artifacts()?.artifacts.length, 1);
  assert.throws(() => store.setArtifacts({ v: 1, at: now.toISOString(), artifacts: [{ ...artifact, url: "https://evil.example/artifact/x" }] }), BadArtifacts);
  assert.throws(() => store.setArtifacts({ v: 1, at: now.toISOString(), artifacts: [{ ...artifact, repo: "not a repo" }] }), BadArtifacts);
  assert.throws(() => store.setArtifacts({ v: 2, at: now.toISOString(), artifacts: [] }), BadArtifacts);
  assert.equal(store.artifacts()?.artifacts.length, 1, "a bad push leaves the old list");
});
