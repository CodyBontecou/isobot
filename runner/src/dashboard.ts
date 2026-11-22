import { describeEvent } from "./events.js";
import { CHAT_MARKER } from "./notes.js";
import type { FollowUp, Job, Store, StoredEvent } from "./store.js";

/**
 * The isobot board (bot.isolated.tech, `board/`): the runner pushes what it knows to the board Worker
 * once a minute, so its state, schedule and GitHub work can be read in one place instead of Discord.
 * The push is one-way and read-only: the board can't change anything here. GitHub credentials and
 * runner.sqlite stay on this Mac; the board only stores what is in these snapshots.
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
}

export type SourceKind = "github" | "discord" | "email" | "vox" | "appstore" | "chat" | "content" | "release";

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
  if (text.includes(CHAT_MARKER)) return { kind: "chat" };
  if (text.includes("Researched by isobot's content train")) return { kind: "content" };
  if (text.startsWith("## isobot release train")) return { kind: "release" };
  return { kind: "github" };
}

/** The issue a PR body closes, the way the pipeline writes it (`Closes #12`). */
export function closesIssue(body: string | null | undefined): number | undefined {
  const match = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?) #(\d+)\b/i.exec(body ?? "");
  return match ? Number(match[1]) : undefined;
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
  pushEveryMs?: number;
  githubEveryMs?: number;
  fetch?: typeof fetch;
  now?: () => Date;
}

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
  private failures = 0;

  constructor(private readonly o: DashboardOptions) {}

  /** Called every cycle; pushes when a push is due and none is running. */
  tick(): void {
    const now = this.now().getTime();
    if (this.pushing || now - this.lastPush < (this.o.pushEveryMs ?? 60_000)) return;
    this.lastPush = now;
    this.pushing = true;
    void this.push().finally(() => { this.pushing = false; });
  }

  async push(): Promise<boolean> {
    try {
      const now = this.now();
      if (now.getTime() - this.lastGithub >= (this.o.githubEveryMs ?? 5 * 60_000)) {
        this.lastGithub = now.getTime();
        this.githubCache = await this.readGitHub(now);
        this.githubUnsent = true;
      }
      // A failed push, or a board that hasn't answered yet, gets the last read again rather than a new one.
      const github = this.githubUnsent || this.boardEventId === null ? this.githubCache : null;
      const last = this.o.store.lastEventId();
      const after = this.boardEventId === null || this.boardEventId > last
        ? Math.max(0, last - EVENT_BACKFILL)
        : this.boardEventId;
      const events = this.o.store.eventsSince(after, { limit: EVENTS_PER_PUSH });
      const snapshot = buildSnapshot({
        now, runnerId: this.o.runnerId, live: this.o.live(), queued: this.o.queued(),
        buildsPausedUntil: this.o.store.pausedUntil(), repos: this.o.repos(), schedule: this.o.schedule(now),
        jobs: this.o.store.all(JOBS_PER_PUSH), followUps: this.o.store.followUps(), events, github,
      });
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
      const answer = await response.json() as { lastEventId?: unknown };
      this.boardEventId = typeof answer.lastEventId === "number" ? answer.lastEventId : null;
      if (github) this.githubUnsent = false;
      if (this.failures) console.log(`[board] pushing again after ${this.failures} failed push(es)`);
      this.failures = 0;
      return true;
    } catch (error) {
      // Log the first failure and then every 30th, so a board outage doesn't flood the runner log.
      if (this.failures++ % 30 === 0) console.warn(`[board] push failed: ${(error as Error).message}`);
      return false;
    }
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
    return { at: now.toISOString(), items: inheritSources(items), errors };
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
