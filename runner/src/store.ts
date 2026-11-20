import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { EventData } from "./events.js";

/** issue: an ordinary approved issue; content: a content-train issue, built under the site's content policy. */
export type JobKind = "issue" | "content";

export type JobState =
  | "queued" | "blocked" | "building" | "awaiting_ci" | "pr_open" | "merged" | "released"
  | "awaiting_ship" | "shipped" | "closed" | "failed" | "stopped";

/** States a crash can interrupt; Pipeline.recover() picks them up from what the workspace kept. */
export const ACTIVE_STATES: JobState[] = ["queued", "building"];

/**
 * Something the runner will check on later, kept in SQLite so it outlives a restart and holds no build slot.
 * One per (job, kind); scheduling again replaces it.
 */
export interface FollowUp {
  jobId: string;
  kind: string;
  /** ISO time it is next due. */
  dueAt: string;
  /** ISO time it was first scheduled (for deadlines such as "give up after 90 minutes"). */
  createdAt: string;
  payload: string;
}

/**
 * A side effect in the effect ledger (Store.startEffect): `started` before it runs, `done` once its result is
 * saved. A `started` effect after a restart is one that may or may not have happened; whoever owns it decides
 * whether it's safe to run again. `interrupted` means the owner was told and it waits for them;
 * `requested` means they asked for it to run again.
 */
export type EffectStatus = "started" | "done" | "interrupted" | "requested";

export interface Effect {
  key: string;
  jobId: string | null;
  status: EffectStatus;
  /** What the effect returned (JSON), once done. */
  result: string | null;
  updatedAt: string;
}

export interface Job {
  id: string;
  owner: string;
  repo: string;
  number: number;
  title: string;
  state: JobState;
  branch: string | null;
  prNumber: number | null;
  sessionId: string | null;
  attempts: number;
  lastError: string | null;
  /** Earliest time a queued job may start (retry backoff), ISO or null. */
  notBefore: string | null;
  /** Queued to revise its open PR with the owner's notes, rather than build from scratch. */
  revising: boolean;
  kind: JobKind;
  createdAt: string;
  updatedAt: string;
}

interface Row {
  id: string; owner: string; repo: string; number: number; title: string; state: JobState;
  branch: string | null; pr_number: number | null; session_id: string | null; attempts: number;
  last_error: string | null; created_at: string; updated_at: string; not_before: string | null; revising: number | null; kind: string | null;
}

/** Local durable state. GitHub labels are the visible queue; this records progress and cursors. */
export class Store {
  private db: DatabaseSync;

  constructor(file: string) {
    if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    // The wait comes first: everything after it, journal_mode included, may meet a lock held by another
    // process (the previous runner exiting, or a CLI command) and must wait for it rather than fail.
    this.db.exec("PRAGMA busy_timeout = 15000");
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, repo TEXT NOT NULL, number INTEGER NOT NULL,
        title TEXT NOT NULL, state TEXT NOT NULL, branch TEXT, pr_number INTEGER, session_id TEXT,
        attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cursors (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT, at TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT
      );
      CREATE TABLE IF NOT EXISTS seen (source TEXT NOT NULL, item TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (source, item));
      CREATE TABLE IF NOT EXISTS followups (
        job_id TEXT NOT NULL, kind TEXT NOT NULL, due_at TEXT NOT NULL, created_at TEXT NOT NULL, payload TEXT NOT NULL,
        PRIMARY KEY (job_id, kind)
      );
      CREATE TABLE IF NOT EXISTS effects (
        key TEXT PRIMARY KEY, job_id TEXT, status TEXT NOT NULL, result TEXT, updated_at TEXT NOT NULL
      );
    `);
    const eventColumns = (this.db.prepare("PRAGMA table_info(events)").all() as { name: string }[]).map(c => c.name);
    if (!eventColumns.includes("data")) this.db.exec("ALTER TABLE events ADD COLUMN data TEXT");
    const columns = (this.db.prepare("PRAGMA table_info(jobs)").all() as { name: string }[]).map(c => c.name);
    if (!columns.includes("not_before")) this.db.exec("ALTER TABLE jobs ADD COLUMN not_before TEXT");
    if (!columns.includes("revising")) this.db.exec("ALTER TABLE jobs ADD COLUMN revising INTEGER NOT NULL DEFAULT 0");
    if (!columns.includes("kind")) this.db.exec("ALTER TABLE jobs ADD COLUMN kind TEXT NOT NULL DEFAULT 'issue'");
  }

  /** Puts a job back in the queue to retry after `delayMs` (transient failure). */
  requeue(id: string, delayMs: number, reason: string, countAttempt = true): Job {
    const job = this.get(id);
    if (!job) throw new Error(`Job ${id} disappeared`);
    this.db.prepare("UPDATE jobs SET state = 'queued', not_before = ?, last_error = ?, attempts = ?, updated_at = ? WHERE id = ?")
      .run(new Date(Date.now() + delayMs).toISOString(), reason.slice(0, 4000), countAttempt ? job.attempts : Math.max(0, job.attempts - 1), new Date().toISOString(), id);
    this.event(id, "retry", reason);
    return this.get(id)!;
  }

  /** Queued jobs whose backoff has passed. */
  runnable(now = new Date()): Job[] {
    return this.inState("queued").filter(job => !job.notBefore || job.notBefore <= now.toISOString());
  }

  /** Global build pause (e.g. Claude usage limit) until an ISO time. */
  pausedUntil(): string | null {
    const value = this.cursor("builds:paused_until");
    return value && value > new Date().toISOString() ? value : null;
  }

  pauseBuilds(untilMs: number, reason: string): void {
    this.setCursor("builds:paused_until", new Date(untilMs).toISOString());
    this.event(null, "builds_paused", reason);
  }

  static jobId(owner: string, repo: string, number: number): string {
    return `${owner}/${repo}#${number}`.toLowerCase();
  }

  get(id: string): Job | null {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Row | undefined;
    return row ? toJob(row) : null;
  }

  /** Inserts a queued job, or re-queues a finished one that was approved again. Returns null if already active. */
  enqueue(owner: string, repo: string, number: number, title: string, kind: JobKind = "issue"): Job | null {
    const id = Store.jobId(owner, repo, number);
    const existing = this.get(id);
    const now = new Date().toISOString();
    if (existing && (ACTIVE_STATES.includes(existing.state) || ["blocked", "awaiting_ci", "pr_open", "awaiting_ship"].includes(existing.state))) return null;
    this.db.prepare(`INSERT INTO jobs (id, owner, repo, number, title, state, attempts, kind, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET state = 'queued', title = excluded.title, attempts = 0, last_error = NULL,
        session_id = NULL, pr_number = NULL, branch = NULL, not_before = NULL, revising = 0, kind = excluded.kind, updated_at = excluded.updated_at`)
      .run(id, owner, repo, number, title, kind, now, now);
    // A fresh approval gets a fresh Discord card and thread.
    this.db.prepare("DELETE FROM cursors WHERE key = ?").run(`discord:${id}`);
    this.event(id, "queued", title);
    return this.get(id);
  }

  update(id: string, fields: Partial<Pick<Job, "state" | "branch" | "prNumber" | "sessionId" | "attempts" | "lastError" | "title" | "revising">>): Job {
    const columns: Record<string, string> = {
      state: "state", branch: "branch", prNumber: "pr_number", sessionId: "session_id",
      attempts: "attempts", lastError: "last_error", title: "title", revising: "revising",
    };
    // A revision lasts until the job leaves the build (PR updated, merged, failed, stopped).
    if (fields.state && !ACTIVE_STATES.includes(fields.state) && fields.revising === undefined) fields = { ...fields, revising: false };
    const before = fields.state ? this.get(id)?.state ?? null : null;
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    for (const [key, value] of Object.entries(fields)) {
      sets.push(`${columns[key]} = ?`);
      values.push(typeof value === "boolean" ? Number(value) : value as string | number | null);
    }
    sets.push("updated_at = ?");
    values.push(new Date().toISOString(), id);
    this.db.prepare(`UPDATE jobs SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    if (fields.state) this.event(id, `state:${fields.state}`, fields.lastError ?? null, { type: "state", v: 1, from: before, to: fields.state });
    const job = this.get(id);
    if (!job) throw new Error(`Job ${id} disappeared`);
    return job;
  }

  inState(...states: JobState[]): Job[] {
    const marks = states.map(() => "?").join(", ");
    return (this.db.prepare(`SELECT * FROM jobs WHERE state IN (${marks}) ORDER BY created_at`).all(...states) as unknown as Row[]).map(toJob);
  }

  /** Jobs that finished (or wait on a human after merging) within the last `hours`, newest first. */
  recentlyFinished(hours: number, limit = 10): Job[] {
    const since = new Date(Date.now() - hours * 3_600_000).toISOString();
    return (this.db.prepare(`SELECT * FROM jobs WHERE state IN ('merged', 'released', 'awaiting_ship', 'shipped', 'closed', 'failed', 'stopped')
      AND updated_at >= ? ORDER BY updated_at DESC LIMIT ?`).all(since, limit) as unknown as Row[]).map(toJob);
  }

  all(limit = 50): Job[] {
    return (this.db.prepare("SELECT * FROM jobs ORDER BY updated_at DESC LIMIT ?").all(limit) as unknown as Row[]).map(toJob);
  }

  /** Records an event: `detail` for people reading the log, `data` (events.ts) for tools such as `runner inspect`. */
  event(jobId: string | null, kind: string, detail: string | null, data?: EventData): void {
    this.db.prepare("INSERT INTO events (job_id, at, kind, detail, data) VALUES (?, ?, ?, ?, ?)")
      .run(jobId, new Date().toISOString(), kind, detail === null ? null : detail.slice(0, 4000), data ? JSON.stringify(data) : null);
  }

  events(jobId: string, limit = 20): { at: string; kind: string; detail: string | null }[] {
    return this.db.prepare("SELECT at, kind, detail FROM events WHERE job_id = ? ORDER BY id DESC LIMIT ?").all(jobId, limit) as never;
  }

  /** Events after `afterId` (all jobs, or one), oldest first, with their typed data where they have it. */
  eventsSince(afterId: number, options: { jobId?: string; limit?: number } = {}): StoredEvent[] {
    const rows = (options.jobId
      ? this.db.prepare("SELECT * FROM events WHERE id > ? AND job_id = ? ORDER BY id LIMIT ?").all(afterId, options.jobId, options.limit ?? 500)
      : this.db.prepare("SELECT * FROM events WHERE id > ? ORDER BY id LIMIT ?").all(afterId, options.limit ?? 500)) as unknown as EventRow[];
    return rows.map(row => ({ id: row.id, jobId: row.job_id, at: row.at, kind: row.kind, detail: row.detail, data: parseData(row.data) }));
  }

  /** The id of the newest event, to start following from. */
  lastEventId(): number {
    return Number((this.db.prepare("SELECT MAX(id) AS id FROM events").get() as { id: number | null }).id ?? 0);
  }

  /** Schedules (or reschedules) a follow-up; a fresh one starts its deadline clock now. */
  schedule(jobId: string, kind: string, dueAt: Date, payload: unknown, now = new Date()): void {
    this.db.prepare(`INSERT INTO followups (job_id, kind, due_at, created_at, payload) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(job_id, kind) DO UPDATE SET due_at = excluded.due_at, payload = excluded.payload`)
      .run(jobId, kind, dueAt.toISOString(), now.toISOString(), JSON.stringify(payload));
  }

  /** Moves a follow-up's next check, keeping its payload and deadline clock. */
  snooze(jobId: string, kind: string, dueAt: Date): void {
    this.db.prepare("UPDATE followups SET due_at = ? WHERE job_id = ? AND kind = ?").run(dueAt.toISOString(), jobId, kind);
  }

  /** Follow-ups due by `now`, earliest first. */
  dueFollowUps(now = new Date()): FollowUp[] {
    return (this.db.prepare("SELECT * FROM followups WHERE due_at <= ? ORDER BY due_at").all(now.toISOString()) as unknown as FollowUpRow[]).map(toFollowUp);
  }

  followUps(jobId?: string): FollowUp[] {
    const rows = jobId
      ? this.db.prepare("SELECT * FROM followups WHERE job_id = ? ORDER BY due_at").all(jobId)
      : this.db.prepare("SELECT * FROM followups ORDER BY due_at").all();
    return (rows as unknown as FollowUpRow[]).map(toFollowUp);
  }

  clearFollowUp(jobId: string, kind?: string): void {
    if (kind) this.db.prepare("DELETE FROM followups WHERE job_id = ? AND kind = ?").run(jobId, kind);
    else this.db.prepare("DELETE FROM followups WHERE job_id = ?").run(jobId);
  }

  /** Forgets a job that was never really ours (another runner won the claim). */
  forget(id: string): void {
    this.db.prepare("DELETE FROM jobs WHERE id = ?").run(id);
    this.clearFollowUp(id);
  }

  cursor(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM cursors WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  /** Cursors whose key starts with `prefix`, oldest key first. */
  cursorsWithPrefix(prefix: string): { key: string; value: string }[] {
    return this.db.prepare("SELECT key, value FROM cursors WHERE substr(key, 1, ?) = ? ORDER BY key").all(prefix.length, prefix) as { key: string; value: string }[];
  }

  deleteCursor(key: string): void {
    this.db.prepare("DELETE FROM cursors WHERE key = ?").run(key);
  }

  setCursor(key: string, value: string): void {
    this.db.prepare("INSERT INTO cursors (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  /** One side effect's ledger entry (see EffectStatus), or null if it never started. */
  effect(key: string): Effect | null {
    const row = this.db.prepare("SELECT key, job_id, status, result, updated_at FROM effects WHERE key = ?").get(key) as
      { key: string; job_id: string | null; status: EffectStatus; result: string | null; updated_at: string } | undefined;
    return row ? { key: row.key, jobId: row.job_id, status: row.status, result: row.result, updatedAt: row.updated_at } : null;
  }

  /** Records that a side effect is about to run. Call it before the effect, so a crash mid-way leaves it `started`. */
  startEffect(key: string, jobId: string | null): void {
    this.setEffect(key, jobId, "started", null);
  }

  /** Records a side effect's result. Call it right after the effect returns. */
  finishEffect(key: string, jobId: string | null, result: unknown = null): void {
    this.setEffect(key, jobId, "done", result === null ? null : JSON.stringify(result));
  }

  /** Asks for an effect to run (again): the owner said so, e.g. `runner release`. */
  requestEffect(key: string, jobId: string | null): void {
    this.setEffect(key, jobId, "requested", null);
  }

  setEffectStatus(key: string, status: EffectStatus): void {
    this.db.prepare("UPDATE effects SET status = ?, updated_at = ? WHERE key = ?").run(status, new Date().toISOString(), key);
  }

  private setEffect(key: string, jobId: string | null, status: EffectStatus, result: string | null): void {
    this.db.prepare(`INSERT INTO effects (key, job_id, status, result, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET job_id = excluded.job_id, status = excluded.status, result = excluded.result, updated_at = excluded.updated_at`)
      .run(key, jobId, status, result, new Date().toISOString());
  }

  /** Records that a triage item was handled; returns false if it was already seen. */
  markSeen(source: string, item: string): boolean {
    const result = this.db.prepare("INSERT OR IGNORE INTO seen (source, item, at) VALUES (?, ?, ?)").run(source, item, new Date().toISOString());
    return Number(result.changes) > 0;
  }

  isSeen(source: string, item: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM seen WHERE source = ? AND item = ?").get(source, item));
  }

  close(): void {
    this.db.close();
  }
}

export interface StoredEvent {
  id: number;
  jobId: string | null;
  at: string;
  kind: string;
  detail: string | null;
  data: EventData | null;
}

interface EventRow { id: number; job_id: string | null; at: string; kind: string; detail: string | null; data: string | null }
interface FollowUpRow { job_id: string; kind: string; due_at: string; created_at: string; payload: string }

function toFollowUp(row: FollowUpRow): FollowUp {
  return { jobId: row.job_id, kind: row.kind, dueAt: row.due_at, createdAt: row.created_at, payload: row.payload };
}

function parseData(raw: string | null): EventData | null {
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as EventData;
    return data && typeof data === "object" && typeof data.type === "string" ? data : null;
  } catch {
    return null;
  }
}

function toJob(row: Row): Job {
  return {
    id: row.id, owner: row.owner, repo: row.repo, number: row.number, title: row.title, state: row.state,
    branch: row.branch, prNumber: row.pr_number, sessionId: row.session_id, attempts: row.attempts,
    lastError: row.last_error, notBefore: row.not_before ?? null, revising: Boolean(row.revising), kind: row.kind === "content" ? "content" : "issue", createdAt: row.created_at, updatedAt: row.updated_at,
  };
}
