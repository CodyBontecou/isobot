/**
 * What the board keeps: each runner's latest snapshot, the newest GitHub read, a year of runner events,
 * and every issue, PR and job it has seen (so the Summary view can look back past the snapshot's 14 days). Runners push (runner/src/dashboard.ts); the browser reads,
 * and can queue task actions (approve, stop, retry, dismiss) that the runner picks up and applies with its own token. Written over a minimal SQL
 * interface so it runs on Durable Object SQLite and, in tests, on node:sqlite.
 */

export interface Sql {
  exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
}

export const SNAPSHOT_VERSION = 1;
/** Over a year, so the Summary view can look back a full year (~250 events a day, a few MB). */
const KEEP_EVENTS_DAYS = 400;
/** The Summary view's longest span (a month and the month before it), and the calendar's (six weeks). */
export const SUMMARY_MAX_DAYS = 64;
export const CALENDAR_MAX_DAYS = 43;
/**
 * Events the Summary view lists by name, rather than only counting: work that landed or failed, what the
 * trains, ASO, content and crash audit did. Errors (`*_error`) are matched separately.
 */
export const HIGHLIGHT_KINDS = ["state:merged", "state:shipped", "state:failed", "train", "aso_applied", "aso_live",
  "aso_proposed", "content_proposed", "content_dropped", "crash_issue", "pr_sweep_closed", "dropped", "already_done"];
const HIGHLIGHT_LIMIT = 800;
/** How far back a runner snapshot lists closed issues and PRs (CLOSED_DAYS in runner/src/dashboard.ts). */
const ITEM_WINDOW_DAYS = 14;
const RUNNER_ID = /^[\w.-]{1,64}$/;

export interface BoardEvent { id: number; jobId: string | null; at: string; kind: string; text: string; runner: string }

/** A task action the owner clicked, handed to the runner until it reports back (runner/src/boardActions.ts). */
export interface QueuedAction { id: string; kind: ActionKind; repo: string; number: number; by: string }

export interface BoardActionRow extends QueuedAction {
  at: string;
  state: "pending" | "done" | "failed";
  result: string | null;
  doneAt: string | null;
}

export const ACTION_KINDS = ["approve", "stop", "retry", "dismiss"] as const;
export type ActionKind = typeof ACTION_KINDS[number];
/** A click the runner hasn't answered in this long is given up (it may still be applied if the runner comes back). */
const ACTION_EXPIRE_MS = 15 * 60_000;
/** Finished actions stay this long, so the task shows how its last click went. */
const ACTION_KEEP_MS = 2 * 86_400_000;
const ACTION_RESULT_LIMIT = 300;

export interface IngestResult { ok: true; lastEventId: number; actions: QueuedAction[] }

export class BadAction extends Error {}

export class BoardStore {
  constructor(private readonly sql: Sql) {
    sql.exec(`CREATE TABLE IF NOT EXISTS runners (id TEXT PRIMARY KEY, at TEXT NOT NULL, snapshot TEXT NOT NULL, last_event_id INTEGER NOT NULL DEFAULT 0)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS github (id INTEGER PRIMARY KEY CHECK (id = 1), at TEXT NOT NULL, data TEXT NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS metrics (id INTEGER PRIMARY KEY CHECK (id = 1), at TEXT NOT NULL, data TEXT NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS events (runner TEXT NOT NULL, id INTEGER NOT NULL, job_id TEXT, at TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, PRIMARY KEY (runner, id))`);
    sql.exec(`CREATE INDEX IF NOT EXISTS events_at ON events (at)`);
    sql.exec(`CREATE INDEX IF NOT EXISTS events_job ON events (job_id, at)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS items (repo TEXT NOT NULL, number INTEGER NOT NULL, created_at TEXT NOT NULL, closed_at TEXT, first_seen TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (repo, number))`);
    sql.exec(`CREATE INDEX IF NOT EXISTS items_created ON items (created_at)`);
    sql.exec(`CREATE INDEX IF NOT EXISTS items_closed ON items (closed_at)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS job_history (id TEXT PRIMARY KEY, updated_at TEXT NOT NULL, data TEXT NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS actions (id TEXT PRIMARY KEY, at TEXT NOT NULL, kind TEXT NOT NULL, repo TEXT NOT NULL, number INTEGER NOT NULL,
      by TEXT NOT NULL, state TEXT NOT NULL, result TEXT, done_at TEXT)`);
    sql.exec(`CREATE INDEX IF NOT EXISTS actions_state ON actions (state, at)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS artifacts (id INTEGER PRIMARY KEY CHECK (id = 1), at TEXT NOT NULL, data TEXT NOT NULL)`);
  }

  /** Replaces the Artifacts view's list with a pushed one (scripts/push-artifacts.mjs). Throws `BadArtifacts` on bad input. */
  setArtifacts(raw: unknown, now = new Date()): { ok: true; count: number } {
    const list = checkArtifacts(raw);
    this.sql.exec(`INSERT INTO artifacts (id, at, data) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET at = excluded.at, data = excluded.data`,
      now.toISOString(), JSON.stringify(list));
    return { ok: true, count: list.artifacts.length };
  }

  /** The latest pushed artifact list, with when it was received, or null before the first push. */
  artifacts(): (ArtifactList & { receivedAt: string }) | null {
    const row = this.sql.exec("SELECT at, data FROM artifacts WHERE id = 1").toArray()[0];
    return row ? { ...JSON.parse(String(row.data)) as ArtifactList, receivedAt: String(row.at) } : null;
  }

  /**
   * Queues a click from the board for the runner. Only the runners' configured repositories, and one pending
   * action per task: a second click replaces the first if the runner hasn't taken it yet.
   */
  queueAction(input: { kind: unknown; repo: unknown; number: unknown; by: string }, now = new Date()): BoardActionRow {
    const kind = input.kind as ActionKind;
    if (!ACTION_KINDS.includes(kind)) throw new BadAction("unknown action");
    if (typeof input.repo !== "string" || !Number.isSafeInteger(input.number) || (input.number as number) < 1) throw new BadAction("bad task");
    const repos = this.repoNames();
    const repo = repos.find(name => name.toLowerCase() === (input.repo as string).toLowerCase());
    if (!repo) throw new BadAction("not one of the runner's repositories");
    const number = input.number as number;
    this.expireActions(now);
    this.sql.exec("DELETE FROM actions WHERE repo = ? AND number = ? AND state = 'pending'", repo, number);
    const id = crypto.randomUUID();
    const at = now.toISOString();
    this.sql.exec("INSERT INTO actions (id, at, kind, repo, number, by, state) VALUES (?, ?, ?, ?, ?, ?, 'pending')", id, at, kind, repo, number, input.by);
    return { id, at, kind, repo, number, by: input.by, state: "pending", result: null, doneAt: null };
  }

  /** What the runner should apply now, oldest first. */
  pendingActions(now = new Date()): QueuedAction[] {
    this.expireActions(now);
    return this.sql.exec("SELECT id, kind, repo, number, by FROM actions WHERE state = 'pending' ORDER BY at LIMIT 20").toArray()
      .map(row => ({ id: String(row.id), kind: String(row.kind) as ActionKind, repo: String(row.repo), number: Number(row.number), by: String(row.by) }));
  }

  /** Recent actions for the board: every pending one and those finished in the last two days, newest first. */
  actions(now = new Date()): BoardActionRow[] {
    this.expireActions(now);
    return this.sql.exec("SELECT * FROM actions ORDER BY at DESC LIMIT 200").toArray().map(row => ({
      id: String(row.id), at: String(row.at), kind: String(row.kind) as ActionKind, repo: String(row.repo), number: Number(row.number),
      by: String(row.by), state: String(row.state) as BoardActionRow["state"], result: row.result === null ? null : String(row.result),
      doneAt: row.done_at === null ? null : String(row.done_at),
    }));
  }

  private expireActions(now: Date): void {
    this.sql.exec("UPDATE actions SET state = 'failed', result = 'The runner didn''t pick it up; is it running?', done_at = ? WHERE state = 'pending' AND at < ?",
      now.toISOString(), new Date(now.getTime() - ACTION_EXPIRE_MS).toISOString());
    this.sql.exec("DELETE FROM actions WHERE state != 'pending' AND done_at < ?", new Date(now.getTime() - ACTION_KEEP_MS).toISOString());
  }

  private repoNames(): string[] {
    const names = new Set<string>();
    for (const row of this.sql.exec("SELECT snapshot FROM runners").toArray()) {
      const repos = (JSON.parse(String(row.snapshot)) as { repos?: { name?: unknown }[] }).repos ?? [];
      for (const r of repos) if (typeof r?.name === "string") names.add(r.name);
    }
    return [...names];
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
    const { events: _events, github, metrics, actionResults: _results, ...rest } = snapshot;
    this.sql.exec(`INSERT INTO runners (id, at, snapshot, last_event_id) VALUES (?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET at = excluded.at, snapshot = excluded.snapshot, last_event_id = excluded.last_event_id`,
      runner, now.toISOString(), JSON.stringify(rest), last);
    // Jobs and GitHub items are kept past the snapshot's window, newest copy wins.
    for (const job of snapshot.jobs as Record<string, unknown>[]) {
      if (!job || typeof job.id !== "string" || typeof job.updatedAt !== "string") continue;
      this.sql.exec(`INSERT INTO job_history (id, updated_at, data) VALUES (?, ?, ?)
        ON CONFLICT (id) DO UPDATE SET updated_at = excluded.updated_at, data = excluded.data WHERE excluded.updated_at >= job_history.updated_at`,
        job.id, job.updatedAt, JSON.stringify(job));
    }
    if (github) {
      for (const item of github.items as Record<string, unknown>[]) {
        if (!item || typeof item.repo !== "string" || !Number.isSafeInteger(item.number) || typeof item.createdAt !== "string") continue;
        this.sql.exec(`INSERT INTO items (repo, number, created_at, closed_at, first_seen, data) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT (repo, number) DO UPDATE SET created_at = excluded.created_at, closed_at = excluded.closed_at, data = excluded.data`,
          item.repo, item.number, item.createdAt, typeof item.closedAt === "string" ? item.closedAt : null, now.toISOString(), JSON.stringify(item));
      }
      this.sql.exec(`INSERT INTO github (id, at, data) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET at = excluded.at, data = excluded.data`,
        github.at, JSON.stringify(github));
    }
    if (metrics) {
      this.sql.exec(`INSERT INTO metrics (id, at, data) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET at = excluded.at, data = excluded.data`,
        metrics.at, JSON.stringify(metrics));
    }
    for (const r of snapshot.actionResults ?? []) {
      if (!r || typeof r !== "object" || typeof r.id !== "string" || typeof r.ok !== "boolean") continue;
      this.sql.exec("UPDATE actions SET state = ?, result = ?, done_at = ? WHERE id = ?",
        r.ok ? "done" : "failed", typeof r.text === "string" ? r.text.slice(0, ACTION_RESULT_LIMIT) : null, now.toISOString(), r.id);
    }
    const cutoff = new Date(now.getTime() - KEEP_EVENTS_DAYS * 86_400_000).toISOString();
    this.sql.exec("DELETE FROM events WHERE at < ?", cutoff);
    return { ok: true, lastEventId: last, actions: this.pendingActions(now) };
  }

  /** Every runner's latest state (newest first), the latest GitHub read, and recent task actions. */
  board(now = new Date()): { runners: (Record<string, unknown> & { receivedAt: string })[]; github: unknown; actions: BoardActionRow[] } {
    const runners = this.sql.exec("SELECT at, snapshot FROM runners ORDER BY at DESC").toArray()
      .map(row => ({ ...JSON.parse(String(row.snapshot)) as Record<string, unknown>, receivedAt: String(row.at) }));
    const github = this.sql.exec("SELECT data FROM github WHERE id = 1").toArray()[0];
    return { runners, github: github ? JSON.parse(String(github.data)) : null, actions: this.actions(now) };
  }

  /** The Growth view's series from the newest runner push that carried them (runner/src/metrics.ts), or null. */
  metrics(): unknown {
    const row = this.sql.exec("SELECT data FROM metrics WHERE id = 1").toArray()[0];
    return row ? JSON.parse(String(row.data)) : null;
  }

  /** Events since `since` (ISO), newest first, optionally for one job. */
  events(options: { since: string; jobId?: string; limit?: number }): BoardEvent[] {
    const limit = Math.min(Math.max(options.limit ?? 2000, 1), 5000);
    const rows = options.jobId
      ? this.sql.exec("SELECT * FROM events WHERE job_id = ? AND at >= ? ORDER BY at DESC, id DESC LIMIT ?", options.jobId, options.since, limit).toArray()
      : this.sql.exec("SELECT * FROM events WHERE at >= ? ORDER BY at DESC, id DESC LIMIT ?", options.since, limit).toArray();
    return rows.map(eventRow);
  }

  /**
   * What happened between `from` and `to` (ISO instants), for the Summary view. Counts come back per UTC hour, kind
   * and repo so the browser can cut them into its own local days, and start at `compareFrom` so the period before
   * can be compared. Highlights (named events), the issues and PRs opened or closed, and the jobs those events
   * name are for `from`–`to` only, except items, which also cover the period before for its counts.
   */
  summary(options: { from: string; to: string; compareFrom: string }): Summary {
    const { from, to, compareFrom } = options;
    const hours = this.sql.exec(`SELECT substr(at, 1, 13) AS hour, kind, CASE WHEN job_id IS NULL THEN NULL ELSE substr(job_id, 1, instr(job_id, '#') - 1) END AS repo, count(*) AS n
      FROM events WHERE at >= ? AND at < ? GROUP BY 1, 2, 3`, compareFrom, to).toArray()
      .map(row => ({ hour: String(row.hour), kind: String(row.kind), repo: row.repo === null ? null : String(row.repo), n: Number(row.n) }));
    const marks = HIGHLIGHT_KINDS.map(() => "?").join(", ");
    const highlights = this.sql.exec(`SELECT * FROM events WHERE at >= ? AND at < ? AND (kind IN (${marks}) OR kind GLOB '*_error')
      ORDER BY at DESC, id DESC LIMIT ?`, from, to, ...HIGHLIGHT_KINDS, HIGHLIGHT_LIMIT).toArray().map(eventRow);
    const items = this.sql.exec(`SELECT data FROM items WHERE (created_at >= ? AND created_at < ?) OR (closed_at >= ? AND closed_at < ?)`,
      compareFrom, to, compareFrom, to).toArray().map(row => JSON.parse(String(row.data)) as unknown);
    const ids = [...new Set(highlights.map(e => e.jobId).filter((id): id is string => id !== null))];
    const jobs: unknown[] = [];
    for (let i = 0; i < ids.length; i += 90) {
      const chunk = ids.slice(i, i + 90);
      jobs.push(...this.sql.exec(`SELECT data FROM job_history WHERE id IN (${chunk.map(() => "?").join(", ")})`, ...chunk).toArray()
        .map(row => JSON.parse(String(row.data)) as unknown));
    }
    const first = this.sql.exec("SELECT min(at) AS at FROM events").toArray()[0];
    // A snapshot carries every open item and those closed in its last 14 days, so the first one covers that far back.
    const firstItem = this.sql.exec("SELECT min(first_seen) AS at FROM items").toArray()[0];
    return {
      from, to, compareFrom, hours, highlights, truncated: highlights.length === HIGHLIGHT_LIMIT, items, jobs,
      eventsSince: first?.at ? String(first.at) : null,
      itemsSince: firstItem?.at ? new Date(Date.parse(String(firstItem.at)) - ITEM_WINDOW_DAYS * 86_400_000).toISOString() : null,
    };
  }

  /** Event counts per UTC hour and repo (null for runner-level events), for the calendar's activity shading. */
  calendar(options: { from: string; to: string }): { hours: { hour: string; repo: string | null; n: number }[] } {
    const hours = this.sql.exec(`SELECT substr(at, 1, 13) AS hour, CASE WHEN job_id IS NULL THEN NULL ELSE substr(job_id, 1, instr(job_id, '#') - 1) END AS repo, count(*) AS n
      FROM events WHERE at >= ? AND at < ? GROUP BY 1, 2`, options.from, options.to).toArray()
      .map(row => ({ hour: String(row.hour), repo: row.repo === null ? null : String(row.repo), n: Number(row.n) }));
    return { hours };
  }
}

export interface Summary {
  from: string;
  to: string;
  compareFrom: string;
  hours: { hour: string; kind: string; repo: string | null; n: number }[];
  highlights: BoardEvent[];
  /** The highlight list hit its limit; counts are still complete. */
  truncated: boolean;
  items: unknown[];
  jobs: unknown[];
  /** The oldest event and item the board holds: periods before these are incomplete. */
  eventsSince: string | null;
  itemsSince: string | null;
}

function eventRow(row: Record<string, unknown>): BoardEvent {
  return { id: Number(row.id), jobId: row.job_id === null ? null : String(row.job_id), at: String(row.at),
    kind: String(row.kind), text: String(row.text), runner: String(row.runner) };
}

export class BadSnapshot extends Error {}

interface CheckedSnapshot {
  v: number;
  runnerId: string;
  events: { id: number; jobId: string | null; at: string; kind: string; text: string }[];
  github: { at: string } & Record<string, unknown> | null;
  /** Absent from runners that predate the Growth view, and null when unchanged since their last push. */
  metrics?: { at: string } & Record<string, unknown> | null;
  /** How the actions from the board's last answer went (runners from before task actions don't send it). */
  actionResults?: { id: unknown; ok: unknown; text?: unknown }[];
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
  if (s.actionResults !== undefined && !Array.isArray(s.actionResults)) fail("actionResults must be a list");
  if (s.metrics !== undefined && s.metrics !== null) {
    const m = s.metrics as Record<string, unknown>;
    if (!m || typeof m !== "object" || Array.isArray(m) || typeof m.at !== "string" || Number.isNaN(Date.parse(m.at))
      || !Array.isArray(m.apps) || !Array.isArray(m.sites) || !m.credits || typeof m.credits !== "object") fail("bad metrics");
  }
  return s as unknown as CheckedSnapshot;
}

/** A claude.ai artifact (Claude's published pages and designs), filed under the project it belongs to. */
export interface Artifact {
  title: string;
  url: string;
  /** Group heading, e.g. "Health.md" or "B-Line"; "Other" when it fits none. */
  project: string;
  /** The runner repo it belongs to (owner/name), so the sidebar's repo filter applies; null for projects isobot doesn't run. */
  repo: string | null;
  /** "Design", "Page", "Doc", … as the artifact list names it. */
  kind: string;
  updatedAt: string | null;
  pinned: boolean;
  shared: boolean;
}
export interface ArtifactList { v: 1; at: string; artifacts: Artifact[] }

export class BadArtifacts extends Error {}

const ARTIFACT_URL = /^https:\/\/claude\.ai\/(code\/)?artifact\/[\w-]{8,64}$/;
const ARTIFACT_LIMIT = 2000;

function checkArtifacts(raw: unknown): ArtifactList {
  const fail = (why: string): never => { throw new BadArtifacts(why); };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("body must be an object");
  const body = raw as Record<string, unknown>;
  if (body.v !== 1) fail(`unsupported version ${String(body.v)}`);
  if (typeof body.at !== "string" || Number.isNaN(Date.parse(body.at))) fail("bad at");
  if (!Array.isArray(body.artifacts) || body.artifacts.length > ARTIFACT_LIMIT) fail(`artifacts must be a list of at most ${ARTIFACT_LIMIT}`);
  const text = (value: unknown, max: number, name: string): string =>
    typeof value === "string" && value.trim() && value.length <= max ? value.trim() : fail(`bad ${name}`);
  const artifacts = (body.artifacts as unknown[]).map((item): Artifact => {
    const a = item as Record<string, unknown>;
    if (!a || typeof a !== "object") fail("bad artifact");
    const url = text(a.url, 200, "url");
    if (!ARTIFACT_URL.test(url)) fail(`not a claude.ai artifact link: ${url}`);
    const repo = a.repo === null || a.repo === undefined ? null : text(a.repo, 140, "repo");
    if (repo !== null && !/^[\w.-]+\/[\w.-]+$/.test(repo)) fail(`bad repo ${repo}`);
    const updatedAt = a.updatedAt === null || a.updatedAt === undefined ? null : text(a.updatedAt, 40, "updatedAt");
    if (updatedAt !== null && Number.isNaN(Date.parse(updatedAt))) fail(`bad updatedAt ${updatedAt}`);
    return {
      title: text(a.title, 300, "title"), url, project: text(a.project, 80, "project"), repo,
      kind: a.kind === undefined ? "Page" : text(a.kind, 40, "kind"), updatedAt, pinned: a.pinned === true, shared: a.shared === true,
    };
  });
  return { v: 1, at: new Date(Date.parse(body.at as string)).toISOString(), artifacts };
}
