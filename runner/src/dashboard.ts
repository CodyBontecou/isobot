import { describeEvent } from "./events.js";
import { latestSweep, type SweepResult } from "./prSweep.js";
import { CRASH_MARKER } from "./crashes.js";
import { CHAT_MARKER } from "./notes.js";
import type { BoardMetrics } from "./metrics.js";
import type { BoardVox } from "./voxNotebook.js";
import type { BoardAction, BoardActionResult } from "./boardActions.js";
import type { FollowUp, Job, Store, StoredEvent } from "./store.js";

/**
 * The isobot board (bot.isolated.tech, `board/`): the runner pushes what it knows to the board Worker
 * once a minute, so its state, schedule and GitHub work can be read in one place instead of Discord.
 * GitHub credentials and runner.sqlite stay on this Mac; the board only stores what is in these snapshots.
 * The one way back is the board's answer: task actions the owner clicked (approve, stop, retry, dismiss,
 * boardActions.ts), which the runner checks and applies itself and reports on in its next push.
 */

export const SNAPSHOT_VERSION = 1;
/** Event texts are for reading on the board; the full detail stays in runner.sqlite. */
const EVENT_TEXT_LIMIT = 600;
/** On a first push (or after the board lost its events), send at most this much history. */
const EVENT_BACKFILL = 3000;
/** Events per push; a backlog drains over the following pushes. */
const EVENTS_PER_PUSH = 1500;
const JOBS_PER_PUSH = 200;
/** Closed issues and PRs from the last this many days are shown. */
const CLOSED_DAYS = 14;

export interface BoardItem {
  repo: string;
  number: number;
  kind: "issue" | "pr";
  title: string;
  url: string;
  state: "open" | "closed";
  merged: boolean;
  draft: boolean;
  author: string;
  labels: string[];
  comments: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  /** Where the work came from; a PR takes the source of the issue it closes. */
  source: ItemSource;
  /** PRs: the issue number its body closes (`Closes #n`), if any. */
  closes?: number;
  /** Open PRs: what the last PR sweep made of it (prSweep.ts); `action` null when nothing waits on the owner. */
  attention?: { status: string; reason: string; action: string | null; at: string };
}

export type SourceKind = "github" | "discord" | "email" | "vox" | "appstore" | "chat" | "content" | "release" | "crash";

export interface ItemSource {
  kind: SourceKind;
  /** A link to the original (Discord message, App Store review); never set for email. */
  url?: string;
}

const TRIAGE_SOURCES: SourceKind[] = ["discord", "email", "vox", "appstore", "github"];

/**
 * Reads an issue's origin from what isobot wrote into its body: the triage marker
 * (`<!-- isobot:triage:<source>:… -->`) and its **Source:** link, the chat marker, or the
 * content and release trains' wording, or the `from-vox` label the Vox inbox pipeline
 * (~/dev/vox-notebook) puts on its issues. Anything else was filed on GitHub.
 */
export function itemSource(body: string | null | undefined, labels: string[] = []): ItemSource {
  const text = body ?? "";
  const triage = /<!-- isobot:triage:([a-z]+):/.exec(text)?.[1] as SourceKind | undefined;
  if (triage && TRIAGE_SOURCES.includes(triage)) {
    const link = triage === "email" ? undefined : /\*\*Source:\*\*[^\n]*?(https:\/\/\S+)/.exec(text)?.[1]?.replace(/[).,>]+$/, "");
    return link ? { kind: triage, url: link } : { kind: triage };
  }
  if (labels.includes("from-vox")) return { kind: "vox" };
  if (text.includes(CRASH_MARKER)) return { kind: "crash" };
  if (text.includes(CHAT_MARKER)) return { kind: "chat" };
  if (text.includes("Researched by isobot's content train")) return { kind: "content" };
  if (isReleaseIssue(text)) return { kind: "release" };
  return { kind: "github" };
}

/** A release train's Ship issue or a weekly App Store release issue: its ready label confirms a release, never a build. */
export function isReleaseIssue(body: string | null | undefined): boolean {
  const text = body ?? "";
  return text.startsWith("## isobot release train") || text.startsWith("## isobot weekly App Store release");
}

/** The issue a PR body closes, the way the pipeline writes it (`Closes #12`). */
export function closesIssue(body: string | null | undefined): number | undefined {
  const match = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?) #(\d+)\b/i.exec(body ?? "");
  return match ? Number(match[1]) : undefined;
}

/** Puts the last PR sweep's verdict on each open PR it saw. */
export function withAttention(items: BoardItem[], sweep: SweepResult | null): BoardItem[] {
  if (!sweep) return items;
  const seen = new Map(sweep.pulls.map(p => [`${p.repo}#${p.number}`.toLowerCase(), p]));
  return items.map(item => {
    const pull = item.kind === "pr" && item.state === "open" ? seen.get(`${item.repo}#${item.number}`.toLowerCase()) : undefined;
    return pull ? { ...item, attention: { status: pull.status, reason: pull.reason, action: pull.action, at: sweep.at } } : item;
  });
}

/** Gives each PR the source of the issue it closes (in the same repo), when that issue is on the board. */
export function inheritSources(items: BoardItem[]): BoardItem[] {
  const issues = new Map(items.filter(i => i.kind === "issue").map(i => [`${i.repo}#${i.number}`.toLowerCase(), i.source]));
  return items.map(item => {
    if (item.kind !== "pr" || item.closes === undefined) return item;
    const source = issues.get(`${item.repo}#${item.closes}`.toLowerCase());
    return source ? { ...item, source } : item;
  });
}

export interface ScheduleItem {
  id: string;
  name: string;
  /** How often it runs, in words ("every 30 min", "daily at 09:00"). */
  cadence: string;
  lastAt: string | null;
  nextAt: string | null;
  running: boolean;
  detail?: string;
}

export interface LiveRunner {
  startedAt: string;
  activeJobs: string[];
  manuallyPaused: boolean;
  lastTriageAt: string | null;
  lastCycleError: string | null;
}

export interface BoardSnapshot {
  v: typeof SNAPSHOT_VERSION;
  at: string;
  runnerId: string;
  runner: LiveRunner & { pid: number; queued: number; buildsPausedUntil: string | null };
  repos: { name: string; autonomy: string; ownerAutonomy: string; train: boolean; content: boolean; aso: boolean }[];
  schedule: ScheduleItem[];
  jobs: (Omit<Job, "sessionId" | "lastError"> & { lastError: string | null })[];
  followUps: { jobId: string; kind: string; dueAt: string; createdAt: string; text: string }[];
  /** Events newer than the board's `lastEventId`, oldest first. */
  events: { id: number; jobId: string | null; at: string; kind: string; text: string }[];
  /** Null when this push carries no GitHub refresh; the board keeps the last one. */
  github: { at: string; items: BoardItem[]; errors: string[] } | null;
  /** The Growth view's series (metrics.ts); null when unchanged since the board last took them. */
  metrics?: BoardMetrics | null;
  /** The Vox view's notebook (voxNotebook.ts); null when unchanged since the board last took it. */
  vox?: BoardVox | null;
  /** How the board actions from the last answer went; the board shows them on the task. */
  actionResults?: BoardActionResult[];
}

export interface BoardGitHub {
  /** Open issues and PRs, plus those closed since `closedSince` (ISO). */
  boardItems(owner: string, repo: string, closedSince: string): Promise<BoardItem[]>;
}

export interface DashboardOptions {
  url: string;
  token: string;
  runnerId: string;
  store: Store;
  github: BoardGitHub;
  repos: () => BoardSnapshot["repos"];
  schedule: (now: Date) => ScheduleItem[];
  live: () => LiveRunner;
  queued: () => number;
  /** The Growth view's series; read from runner.sqlite every `metricsEveryMs`. */
  metrics?: (now: Date) => BoardMetrics;
  /** The Vox notebook; read every `voxEveryMs`. Null when there is no notebook. */
  vox?: (now: Date) => BoardVox | null;
  /** Applies a task action the owner clicked on the board (boardActions.ts runBoardAction). Without it, actions wait. */
  act?: (action: BoardAction) => Promise<BoardActionResult>;
  pushEveryMs?: number;
  /** How often `start()` asks the board for clicked actions between pushes (default 15 s). */
  actionPollMs?: number;
  githubEveryMs?: number;
  metricsEveryMs?: number;
  voxEveryMs?: number;
  fetch?: typeof fetch;
  now?: () => Date;
}

/**
 * Something read every so often (the Growth series, the Vox notebook) that goes to the board only when it
 * changed. A board that asks for a resync gets the last read again.
 */
class Changing<T extends { at: string }> {
  private last = Number.NEGATIVE_INFINITY;
  private cache: T | null = null;
  /** As last sent, without its `at`, to send only what changed. */
  private sent = "";
  private unsent = false;

  constructor(private readonly name: string, private readonly read: ((now: Date) => T | null) | undefined, private readonly everyMs: number) {}

  refresh(now: Date): void {
    if (!this.read || now.getTime() - this.last < this.everyMs) return;
    this.last = now.getTime();
    try {
      const value = this.read(now);
      if (value && key(value) !== this.sent) { this.cache = value; this.unsent = true; }
    } catch (error) {
      console.warn(`[board] ${this.name} failed: ${(error as Error).message}`);
    }
  }

  take(resync: boolean): T | null { return this.unsent || resync ? this.cache : null; }

  delivered(value: T | null): void {
    if (value) { this.unsent = false; this.sent = key(value); }
  }
}
const key = (value: { at: string }) => JSON.stringify({ ...value, at: undefined });

/** Pushes snapshots to the board. Never throws: the board must never slow or stop the runner. */
export class Dashboard {
  private lastPush = 0;
  private lastGithub = 0;
  private pushing = false;
  /** The board's newest event from this runner, from its last answer; null until it has answered. */
  private boardEventId: number | null = null;
  private githubCache: BoardSnapshot["github"] = null;
  /** The last GitHub read hasn't reached the board yet. */
  private githubUnsent = false;
  private readonly metrics: Changing<BoardMetrics>;
  private readonly vox: Changing<BoardVox>;
  private failures = 0;
  private polling = false;
  /** Results not yet acknowledged by the board, sent with every push until one succeeds. */
  private results: BoardActionResult[] = [];
  /** Actions applied (or being applied) in this process, so a repeat hand-out (the board hasn't the result yet) isn't run twice. */
  private applied = new Map<string, Promise<BoardActionResult>>();
  /** Results the board has acknowledged. */
  private reported = new Set<string>();

  constructor(private readonly o: DashboardOptions) {
    this.metrics = new Changing("metrics", o.metrics, o.metricsEveryMs ?? 15 * 60_000);
    this.vox = new Changing("vox notebook", o.vox, o.voxEveryMs ?? 5 * 60_000);
  }

  /** Called every cycle; pushes when a push is due and none is running. */
  tick(): void {
    if (this.now().getTime() - this.lastPush < (this.o.pushEveryMs ?? 60_000)) return;
    this.pushSoon();
  }

  /**
   * Between pushes, asks the board every few seconds whether the owner clicked anything, so an Approve lands
   * in seconds rather than at the next cycle. Returns a stop function.
   */
  start(): () => void {
    if (!this.o.act) return () => {};
    const timer = setInterval(() => { void this.pollActions(); }, this.o.actionPollMs ?? 15_000);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  private pushSoon(): void {
    if (this.pushing) return;
    this.lastPush = this.now().getTime();
    this.pushing = true;
    void this.push().then(ok => {
      this.pushing = false;
      // Results from actions applied after the answer go out right away, not a cycle later.
      if (ok && this.results.length) setTimeout(() => this.pushSoon(), 500).unref?.();
    }, () => { this.pushing = false; });
  }

  /** One look at the board's queue; acting on it pushes the results right away. Never throws. */
  async pollActions(): Promise<void> {
    if (this.pushing || this.polling) return;
    this.polling = true;
    try {
      const response = await (this.o.fetch ?? fetch)(`${this.o.url}/api/ingest/actions`, {
        headers: { Authorization: `Bearer ${this.o.token}` }, signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) { await response.body?.cancel(); return; }
      const answer = await response.json() as { actions?: unknown };
      if (Array.isArray(answer.actions) && answer.actions.length && await this.act(answer.actions)) this.pushSoon();
    } catch {
      // The push loop reports board outages; a missed poll is retried in a few seconds.
    } finally {
      this.polling = false;
    }
  }

  async push(): Promise<boolean> {
    try {
      const now = this.now();
      if (now.getTime() - this.lastGithub >= (this.o.githubEveryMs ?? 5 * 60_000)) {
        this.lastGithub = now.getTime();
        this.githubCache = await this.readGitHub(now);
        this.githubUnsent = true;
      }
      this.metrics.refresh(now);
      this.vox.refresh(now);
      // A failed push, or a board that hasn't answered yet, gets the last read again rather than a new one.
      const github = this.githubUnsent || this.boardEventId === null ? this.githubCache : null;
      const metrics = this.metrics.take(this.boardEventId === null);
      const vox = this.vox.take(this.boardEventId === null);
      const last = this.o.store.lastEventId();
      const after = this.boardEventId === null || this.boardEventId > last
        ? Math.max(0, last - EVENT_BACKFILL)
        : this.boardEventId;
      const events = this.o.store.eventsSince(after, { limit: EVENTS_PER_PUSH });
      const snapshot = buildSnapshot({
        now, runnerId: this.o.runnerId, live: this.o.live(), queued: this.o.queued(),
        buildsPausedUntil: this.o.store.pausedUntil(), repos: this.o.repos(), schedule: this.o.schedule(now),
        jobs: this.o.store.all(JOBS_PER_PUSH), followUps: this.o.store.followUps(), events, github, metrics, vox,
      });
      const results = this.results;
      if (results.length) snapshot.actionResults = results;
      const response = await (this.o.fetch ?? fetch)(`${this.o.url}/api/ingest`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.o.token}`, "Content-Type": "application/json" },
        body: JSON.stringify(snapshot),
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        // A 409 means the board wants a resync of events (it lost them); anything else retries next push.
        if (response.status === 409) this.boardEventId = null;
        throw new Error(`board answered ${response.status}`);
      }
      const answer = await response.json() as { lastEventId?: unknown; actions?: unknown };
      this.boardEventId = typeof answer.lastEventId === "number" ? answer.lastEventId : null;
      if (results.length) {
        this.results = this.results.filter(r => !results.includes(r));
        for (const r of results) this.reported.add(r.id);
      }
      if (github) this.githubUnsent = false;
      this.metrics.delivered(metrics);
      this.vox.delivered(vox);
      if (this.failures) console.log(`[board] pushing again after ${this.failures} failed push(es)`);
      this.failures = 0;
      // Results and a fresh GitHub read go out with the next push, a cycle from now (or sooner, via start()).
      await this.act(answer.actions);
      return true;
    } catch (error) {
      // Log the first failure and then every 30th, so a board outage doesn't flood the runner log.
      if (this.failures++ % 30 === 0) console.warn(`[board] push failed: ${(error as Error).message}`);
      return false;
    }
  }

  /** Applies the actions the board handed over; true when there are results for the board. */
  private async act(raw: unknown): Promise<boolean> {
    if (!this.o.act || !Array.isArray(raw) || !raw.length) return false;
    for (const action of raw.slice(0, 20) as BoardAction[]) {
      if (!action || typeof action.id !== "string") continue;
      let running = this.applied.get(action.id);
      if (!running) {
        running = this.o.act(action);
        this.applied.set(action.id, running);
        if (this.applied.size > 500) {
          const oldest = this.applied.keys().next().value!;
          this.applied.delete(oldest);
          this.reported.delete(oldest);
        }
      }
      const result = await running;
      if (!this.reported.has(result.id) && !this.results.some(r => r.id === result.id)) this.results.push(result);
    }
    // The labels changed: show it on the board with the results rather than at the next 5-minute read.
    this.lastGithub = 0;
    this.lastPush = 0;
    return this.results.length > 0;
  }

  private async readGitHub(now: Date): Promise<NonNullable<BoardSnapshot["github"]>> {
    const closedSince = new Date(now.getTime() - CLOSED_DAYS * 86_400_000).toISOString();
    const items: BoardItem[] = [];
    const errors: string[] = [];
    for (const { name } of this.o.repos()) {
      const [owner, repo] = name.split("/");
      try {
        items.push(...await this.o.github.boardItems(owner, repo, closedSince));
      } catch (error) {
        errors.push(`${name}: ${(error as Error).message.split("\n")[0].slice(0, 200)}`);
      }
    }
    return { at: now.toISOString(), items: withAttention(inheritSources(items), latestSweep(this.o.store)), errors };
  }

  private now(): Date {
    return this.o.now?.() ?? new Date();
  }
}

export interface SnapshotInput {
  now: Date;
  runnerId: string;
  live: LiveRunner;
  queued: number;
  buildsPausedUntil: string | null;
  repos: BoardSnapshot["repos"];
  schedule: ScheduleItem[];
  jobs: Job[];
  followUps: FollowUp[];
  events: StoredEvent[];
  github: BoardSnapshot["github"];
  metrics?: BoardMetrics | null;
  vox?: BoardVox | null;
}

export function buildSnapshot(input: SnapshotInput): BoardSnapshot {
  return {
    v: SNAPSHOT_VERSION,
    at: input.now.toISOString(),
    runnerId: input.runnerId,
    runner: { ...input.live, pid: process.pid, queued: input.queued, buildsPausedUntil: input.buildsPausedUntil },
    repos: input.repos,
    schedule: input.schedule,
    // Builder session ids stay local: they resume Claude Code sessions and mean nothing on the board.
    jobs: input.jobs.map(({ sessionId: _session, lastError, ...job }) => ({ ...job, lastError: lastError ? clip(lastError, EVENT_TEXT_LIMIT) : null })),
    followUps: input.followUps.map(f => ({ jobId: f.jobId, kind: f.kind, dueAt: f.dueAt, createdAt: f.createdAt, text: followUpText(f) })),
    events: input.events.map(e => ({ id: e.id, jobId: e.jobId, at: e.at, kind: e.kind, text: clip(describeEvent(e.kind, e.detail, e.data), EVENT_TEXT_LIMIT) })),
    github: input.github,
    metrics: input.metrics ?? null,
    vox: input.vox ?? null,
  };
}

function followUpText(f: FollowUp): string {
  if (f.kind === "ci") return "waiting for CI";
  if (f.kind === "blocked") {
    try {
      const on = (JSON.parse(f.payload) as { on?: string[] }).on;
      if (on?.length) return `waiting on ${on.join(", ")}`;
    } catch { /* fall through */ }
    return "waiting on other issues";
  }
  return f.kind;
}

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/** The next time the local clock reads `hour`:00, strictly after `now`. */
export function nextDailyAt(now: Date, hour: number): Date {
  const next = new Date(now);
  next.setHours(hour, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next;
}

/** The next `weekday` (0 = Sunday) at `hour`:00 local time, strictly after `now`. */
export function nextWeeklyAt(now: Date, weekday: number, hour: number): Date {
  const next = new Date(now);
  next.setHours(hour, 0, 0, 0);
  next.setDate(next.getDate() + ((weekday - next.getDay() + 7) % 7));
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 7);
  return next;
}

/** A recurring loop task: its last start and the earliest next one. */
export function every(id: string, name: string, everyMs: number, lastMs: number, running: boolean, detail?: string): ScheduleItem {
  const minutes = Math.round(everyMs / 60_000);
  return {
    id, name, running, detail,
    cadence: minutes >= 60 && minutes % 60 === 0 ? `every ${minutes / 60 === 1 ? "hour" : `${minutes / 60} h`}` : `every ${minutes} min`,
    lastAt: lastMs ? new Date(lastMs).toISOString() : null,
    nextAt: running ? null : new Date((lastMs || Date.now()) + (lastMs ? everyMs : 0)).toISOString(),
  };
}

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
