/**
 * What the board keeps: each runner's latest snapshot, the newest GitHub read, and 30 days of runner
 * events. Runners push (runner/src/dashboard.ts); the browser only reads. Written over a minimal SQL
 * interface so it runs on Durable Object SQLite and, in tests, on node:sqlite.
 */

export interface Sql {
  exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
}

export const SNAPSHOT_VERSION = 1;
const KEEP_EVENTS_DAYS = 30;
const RUNNER_ID = /^[\w.-]{1,64}$/;

export interface BoardEvent { id: number; jobId: string | null; at: string; kind: string; text: string; runner: string }

export interface IngestResult { ok: true; lastEventId: number }

export class BoardStore {
  constructor(private readonly sql: Sql) {
    sql.exec(`CREATE TABLE IF NOT EXISTS runners (id TEXT PRIMARY KEY, at TEXT NOT NULL, snapshot TEXT NOT NULL, last_event_id INTEGER NOT NULL DEFAULT 0)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS github (id INTEGER PRIMARY KEY CHECK (id = 1), at TEXT NOT NULL, data TEXT NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS events (runner TEXT NOT NULL, id INTEGER NOT NULL, job_id TEXT, at TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, PRIMARY KEY (runner, id))`);
    sql.exec(`CREATE INDEX IF NOT EXISTS events_at ON events (at)`);
    sql.exec(`CREATE INDEX IF NOT EXISTS events_job ON events (job_id, at)`);
  }

  /** Stores one runner push. Throws a `BadSnapshot` for anything that isn't a well-formed snapshot. */
  ingest(raw: unknown, now = new Date()): IngestResult {
    const snapshot = checkSnapshot(raw);
    const runner = snapshot.runnerId;
    const previous = this.sql.exec("SELECT last_event_id FROM runners WHERE id = ?", runner).toArray()[0];
    let last = previous ? Number(previous.last_event_id) : 0;
    const events = snapshot.events;
    const newest = events.length ? events[events.length - 1].id : null;
    if (newest !== null && newest < last) {
      // The runner's database started over (ids went backwards): its old events would collide.
      this.sql.exec("DELETE FROM events WHERE runner = ?", runner);
      last = 0;
    }
    for (const e of events) {
      this.sql.exec("INSERT OR IGNORE INTO events (runner, id, job_id, at, kind, text) VALUES (?, ?, ?, ?, ?, ?)",
        runner, e.id, e.jobId, e.at, e.kind, e.text);
    }
    if (newest !== null && newest > last) last = newest;
    const { events: _events, github, ...rest } = snapshot;
    this.sql.exec(`INSERT INTO runners (id, at, snapshot, last_event_id) VALUES (?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET at = excluded.at, snapshot = excluded.snapshot, last_event_id = excluded.last_event_id`,
      runner, now.toISOString(), JSON.stringify(rest), last);
    if (github) {
      this.sql.exec(`INSERT INTO github (id, at, data) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET at = excluded.at, data = excluded.data`,
        github.at, JSON.stringify(github));
    }
    const cutoff = new Date(now.getTime() - KEEP_EVENTS_DAYS * 86_400_000).toISOString();
    this.sql.exec("DELETE FROM events WHERE at < ?", cutoff);
    return { ok: true, lastEventId: last };
  }

  /** Every runner's latest state (newest first) and the latest GitHub read. */
  board(): { runners: (Record<string, unknown> & { receivedAt: string })[]; github: unknown } {
    const runners = this.sql.exec("SELECT at, snapshot FROM runners ORDER BY at DESC").toArray()
      .map(row => ({ ...JSON.parse(String(row.snapshot)) as Record<string, unknown>, receivedAt: String(row.at) }));
    const github = this.sql.exec("SELECT data FROM github WHERE id = 1").toArray()[0];
    return { runners, github: github ? JSON.parse(String(github.data)) : null };
  }

  /** Events since `since` (ISO), newest first, optionally for one job. */
  events(options: { since: string; jobId?: string; limit?: number }): BoardEvent[] {
    const limit = Math.min(Math.max(options.limit ?? 2000, 1), 5000);
    const rows = options.jobId
      ? this.sql.exec("SELECT * FROM events WHERE job_id = ? AND at >= ? ORDER BY at DESC, id DESC LIMIT ?", options.jobId, options.since, limit).toArray()
      : this.sql.exec("SELECT * FROM events WHERE at >= ? ORDER BY at DESC, id DESC LIMIT ?", options.since, limit).toArray();
    return rows.map(row => ({ id: Number(row.id), jobId: row.job_id === null ? null : String(row.job_id), at: String(row.at),
      kind: String(row.kind), text: String(row.text), runner: String(row.runner) }));
  }
}

export class BadSnapshot extends Error {}

interface CheckedSnapshot {
  v: number;
  runnerId: string;
  events: { id: number; jobId: string | null; at: string; kind: string; text: string }[];
  github: { at: string } & Record<string, unknown> | null;
  [key: string]: unknown;
}

/** Shape checks on what a runner sent: enough to keep the store consistent and the UI from breaking. */
function checkSnapshot(raw: unknown): CheckedSnapshot {
  const fail = (why: string): never => { throw new BadSnapshot(why); };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("snapshot must be an object");
  const s = raw as Record<string, unknown>;
  if (s.v !== SNAPSHOT_VERSION) fail(`unsupported snapshot version ${String(s.v)}`);
  if (typeof s.runnerId !== "string" || !RUNNER_ID.test(s.runnerId)) fail("bad runnerId");
  if (typeof s.at !== "string" || Number.isNaN(Date.parse(s.at))) fail("bad at");
  for (const key of ["jobs", "schedule", "followUps", "repos", "events"]) if (!Array.isArray(s[key])) fail(`${key} must be a list`);
  if (!s.runner || typeof s.runner !== "object") fail("runner must be an object");
  let previousId = 0;
  for (const e of s.events as unknown[]) {
    const event = e as Record<string, unknown>;
    if (!event || typeof event !== "object" || !Number.isSafeInteger(event.id) || (event.id as number) <= previousId
      || typeof event.at !== "string" || typeof event.kind !== "string" || typeof event.text !== "string"
      || (event.jobId !== null && typeof event.jobId !== "string")) fail("bad event");
    previousId = event.id as number;
  }
  if (s.github !== null) {
    const g = s.github as Record<string, unknown>;
    if (!g || typeof g !== "object" || typeof g.at !== "string" || !Array.isArray(g.items)) fail("bad github");
  }
  return s as unknown as CheckedSnapshot;
}
