import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/** issue: an ordinary approved issue; content: a content-train issue, built under the site's content policy. */
export type JobKind = "issue" | "content";

export type JobState =
  | "queued" | "building" | "pr_open" | "merged" | "released"
  | "awaiting_ship" | "shipped" | "closed" | "failed" | "stopped";

/** States a crash can interrupt; Pipeline.recover() picks them up from what the workspace kept. */
export const ACTIVE_STATES: JobState[] = ["queued", "building"];

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
    `);
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
    if (existing && (ACTIVE_STATES.includes(existing.state) || existing.state === "pr_open" || existing.state === "awaiting_ship")) return null;
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
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    for (const [key, value] of Object.entries(fields)) {
      sets.push(`${columns[key]} = ?`);
      values.push(typeof value === "boolean" ? Number(value) : value as string | number | null);
    }
    sets.push("updated_at = ?");
    values.push(new Date().toISOString(), id);
    this.db.prepare(`UPDATE jobs SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    if (fields.state) this.event(id, `state:${fields.state}`, fields.lastError ?? null);
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

  event(jobId: string | null, kind: string, detail: string | null): void {
    this.db.prepare("INSERT INTO events (job_id, at, kind, detail) VALUES (?, ?, ?, ?)")
      .run(jobId, new Date().toISOString(), kind, detail === null ? null : detail.slice(0, 4000));
  }

  events(jobId: string, limit = 20): { at: string; kind: string; detail: string | null }[] {
    return this.db.prepare("SELECT at, kind, detail FROM events WHERE job_id = ? ORDER BY id DESC LIMIT ?").all(jobId, limit) as never;
  }

  cursor(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM cursors WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setCursor(key: string, value: string): void {
    this.db.prepare("INSERT INTO cursors (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
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

function toJob(row: Row): Job {
  return {
    id: row.id, owner: row.owner, repo: row.repo, number: row.number, title: row.title, state: row.state,
    branch: row.branch, prNumber: row.pr_number, sessionId: row.session_id, attempts: row.attempts,
    lastError: row.last_error, notBefore: row.not_before ?? null, revising: Boolean(row.revising), kind: row.kind === "content" ? "content" : "issue", createdAt: row.created_at, updatedAt: row.updated_at,
  };
}
