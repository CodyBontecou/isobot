import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { BadSnapshot, BoardStore, type Sql } from "./store.js";

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
  assert.deepEqual(store.ingest(snapshot({ events: [event(1), event(2)] }), now), { ok: true, lastEventId: 2 });
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
