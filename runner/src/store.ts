import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type JobState =
  | "queued" | "building" | "pr_open" | "merged" | "released"
  | "awaiting_ship" | "shipped" | "closed" | "failed" | "stopped";

/** States a crash can interrupt; they are resumed from a clean worktree. */
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
  createdAt: string;
  updatedAt: string;
}

interface Row {
  id: string; owner: string; repo: string; number: number; title: string; state: JobState;
  branch: string | null; pr_number: number | null; session_id: string | null; attempts: number;
  last_error: string | null; created_at: string; updated_at: string;
}

/** Local durable state. GitHub labels are the visible queue; this records progress and cursors. */
export class Store {
  private db: DatabaseSync;

  constructor(file: string) {
    if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
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
  }

  static jobId(owner: string, repo: string, number: number): string {
    return `${owner}/${repo}#${number}`.toLowerCase();
  }

  get(id: string): Job | null {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Row | undefined;
    return row ? toJob(row) : null;
  }

  /** Inserts a queued job, or re-queues a finished one that was approved again. Returns null if already active. */
  enqueue(owner: string, repo: string, number: number, title: string): Job | null {
    const id = Store.jobId(owner, repo, number);
    const existing = this.get(id);
    const now = new Date().toISOString();
    if (existing && (ACTIVE_STATES.includes(existing.state) || existing.state === "pr_open" || existing.state === "awaiting_ship")) return null;
    this.db.prepare(`INSERT INTO jobs (id, owner, repo, number, title, state, attempts, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'queued', 0, ?, ?)
      ON CONFLICT(id) DO UPDATE SET state = 'queued', title = excluded.title, attempts = 0, last_error = NULL,
        session_id = NULL, pr_number = NULL, branch = NULL, updated_at = excluded.updated_at`)
      .run(id, owner, repo, number, title, now, now);
    this.event(id, "queued", title);
    return this.get(id);
  }

  update(id: string, fields: Partial<Pick<Job, "state" | "branch" | "prNumber" | "sessionId" | "attempts" | "lastError" | "title">>): Job {
    const columns: Record<string, string> = {
      state: "state", branch: "branch", prNumber: "pr_number", sessionId: "session_id",
      attempts: "attempts", lastError: "last_error", title: "title",
    };
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    for (const [key, value] of Object.entries(fields)) {
      sets.push(`${columns[key]} = ?`);
      values.push(value as string | number | null);
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
    lastError: row.last_error, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}
