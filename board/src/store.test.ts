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

test("events older than 30 days are pruned and job filters apply", () => {
  const store = new BoardStore(sql());
  store.ingest(snapshot({ events: [event(1, "2026-10-01T00:00:00Z"), event(2, "2026-11-20T10:00:00Z", "o/r#2"), event(3)] }), now);
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
