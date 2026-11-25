import type { PrSweepConfig } from "./config.js";
import type { Job, Store } from "./store.js";

/**
 * The pull request sweep. PRs come from the runner, from the owner's interactive agent sessions, from release
 * scripts and from Dependabot, and only the runner's own were ever followed up. Every few hours this reads every open
 * PR in the configured repos, gives each one status, one reason and at most one thing for the owner to do, closes
 * release PRs a newer release already replaced, and keeps the result for the daily check-in and the board.
 *
 * It never merges and never pushes. Taking a PR over is the owner's call: `isobot:land` on it (Pipeline.discoverLand).
 */

export const SWEEP_KEY = "prsweep:last";
const DAY_MS = 86_400_000;

/** One open PR as GitHub reports it (GitHub.sweepRepo). */
export interface OpenPull {
  number: number;
  title: string;
  url: string;
  branch: string;
  author: string;
  draft: boolean;
  createdAt: string;
  updatedAt: string;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  ci: "success" | "failure" | "pending" | "none";
  labels: string[];
  /** Issues GitHub will close when it merges ("Closes #12"), with their state now. */
  closes: { number: number; state: "open" | "closed" }[];
}

export interface SweepRepoData {
  pulls: OpenPull[];
  tags: string[];
  /** Titles and branches of recently merged PRs, for release PRs that another one already shipped. */
  merged: { number: number; title: string; branch: string }[];
}

export interface SweepGitHub {
  sweepRepo(owner: string, repo: string): Promise<SweepRepoData>;
  comment(owner: string, repo: string, number: number, body: string): Promise<number>;
  closePull(owner: string, repo: string, number: number): Promise<void>;
}

/**
 * - `runner`: an isobot job is building or waiting on CI for it; nothing to do.
 * - `review`: isobot's own PR, left to the owner (already in the check-in's review list).
 * - `ready`: mergeable, CI green or none: merge it.
 * - `failing`, `conflicting`: CI red or conflicts with main: `isobot:land` fixes those.
 * - `superseded`: a release PR whose version (or a newer one) is already out; closed by the sweep.
 * - `duplicate`: another open PR closes the same issue, or every issue it closes is already closed.
 * - `pending`: CI is still running.
 * - `draft`: a draft; only listed once stale.
 */
export type PullStatus = "runner" | "review" | "ready" | "failing" | "conflicting" | "superseded" | "duplicate" | "pending" | "draft";

export interface SweptPull {
  repo: string;
  number: number;
  title: string;
  url: string;
  branch: string;
  author: string;
  status: PullStatus;
  /** Why, in a few words. */
  reason: string;
  /** The one thing the owner can do about it, or null when nothing waits on them. */
  action: string | null;
  /** Days since the PR last changed. */
  idleDays: number;
  stale: boolean;
  /** Superseded by a strictly newer release: the sweep closes it (closeSuperseded). */
  autoClose?: boolean;
}

export interface SweepResult {
  at: string;
  pulls: SweptPull[];
  /** PRs this sweep closed (superseded releases). */
  closed: { repo: string; number: number; title: string; reason: string }[];
  errors: string[];
}

const RUNNER_BUSY = new Set(["queued", "building", "blocked", "awaiting_ci"]);

/** `3.0.4` from "Release Vox.md 3.0.4 build 66" or "release/ios-3.0.1-b2"; null without one. */
export function versionIn(text: string): number[] | null {
  const match = /(?:^|[^\d.])v?(\d+)\.(\d+)(?:\.(\d+))?(?![\d])/.exec(text);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] : null;
}

export function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
  return 0;
}

type Platform = "ios" | "android" | null;

/** Which store a release names: Android (Play, Wear) or iOS (TestFlight, App Store, Mac); null for both or neither. */
export function platformOf(text: string): Platform {
  const android = /android|google play|\bplay\b|wear os|\bwear\b/i.test(text);
  const ios = /\bios\b|testflight|app store|iphone|ipad|\bmac(?:os)?\b|apple/i.test(text);
  return android === ios ? null : android ? "android" : "ios";
}

/** A tag's platform from its prefix: `android/v3.0.4`, `testflight/3.0.4-…`; a plain `v4.0.1` is both. */
function tagPlatform(tag: string): Platform {
  if (/^android\//i.test(tag)) return "android";
  if (/^(?:testflight|ios|appstore)\//i.test(tag)) return "ios";
  return null;
}

/** A release or ship PR: the release scripts' and the release train's, by title or branch. */
export function isReleasePull(pull: Pick<OpenPull, "title" | "branch">): boolean {
  return /^(?:release|ship)\b/i.test(pull.title.trim()) || /^release\//i.test(pull.branch) || /^isobot\/\d+-ship-/i.test(pull.branch);
}

/**
 * What already shipped the release a PR prepares: a tag or a merged release PR with the same version or a newer one,
 * for the same store (an Android tag never replaces an iOS release). Null when nothing did. `newer` is true when a
 * strictly newer version is out: only then is the PR safe to close by itself, since a PR for a version that just
 * shipped may still carry its release notes or receipts.
 */
export function supersededBy(pull: Pick<OpenPull, "number" | "title" | "branch">, data: Pick<SweepRepoData, "tags" | "merged">): { by: string; newer: boolean } | null {
  if (!isReleasePull(pull)) return null;
  const version = versionIn(pull.title) ?? versionIn(pull.branch);
  if (!version) return null;
  const platform = platformOf(`${pull.title} ${pull.branch}`);
  const sameStore = (other: Platform) => platform === null || other === null || other === platform;
  let best: { by: string; newer: boolean } | null = null;
  const consider = (v: number[] | null, by: string) => {
    if (!v) return;
    const cmp = compareVersions(v, version);
    if (cmp < 0 || (best?.newer && cmp === 0)) return;
    if (!best || (cmp > 0 && !best.newer)) best = { by, newer: cmp > 0 };
  };
  for (const tag of data.tags) if (!/failed/i.test(tag) && sameStore(tagPlatform(tag))) consider(versionIn(tag), `tag ${tag}`);
  for (const merged of data.merged) {
    if (merged.number === pull.number || !isReleasePull(merged) || !sameStore(platformOf(`${merged.title} ${merged.branch}`))) continue;
    consider(versionIn(merged.title) ?? versionIn(merged.branch), `#${merged.number} (${merged.title.slice(0, 60)})`);
  }
  return best;
}

/** Sorts one repo's open PRs. Pure: the sweep and its tests share it. */
export function classify(repo: string, data: SweepRepoData, jobs: Job[], now: Date, staleDays: number, landLabel: string): SweptPull[] {
  const byPr = new Map(jobs.filter(job => `${job.owner}/${job.repo}` === repo && job.prNumber !== null).map(job => [job.prNumber!, job]));
  // Open issues each PR closes, to find two PRs racing for one issue.
  const claims = new Map<number, number[]>();
  for (const pull of data.pulls) for (const issue of pull.closes) if (issue.state === "open") claims.set(issue.number, [...(claims.get(issue.number) ?? []), pull.number]);
  return data.pulls.map(pull => {
    const idleDays = Math.max(0, Math.floor((now.getTime() - Date.parse(pull.updatedAt)) / DAY_MS));
    const stale = idleDays >= staleDays;
    const base = { repo, number: pull.number, title: pull.title, url: pull.url, branch: pull.branch, author: pull.author, idleDays, stale };
    const done = (status: PullStatus, reason: string, action: string | null): SweptPull => ({ ...base, status, reason, action });
    const job = byPr.get(pull.number);
    if (job && RUNNER_BUSY.has(job.state)) return done("runner", `isobot is on it (${job.state.replace("_", " ")})`, null);
    if (pull.labels.includes(landLabel)) return done("runner", "isobot will take it over", null);
    const replaced = supersededBy(pull, data);
    if (replaced) return { ...done("superseded", `${replaced.newer ? "a newer release is out" : "this version is out"}: ${replaced.by}`, "close it"), autoClose: replaced.newer };
    const rivals = pull.closes.filter(i => i.state === "open").flatMap(i => (claims.get(i.number) ?? []).filter(n => n !== pull.number).map(n => ({ issue: i.number, other: n })));
    if (rivals.length) return done("duplicate", `#${rivals[0].other} also closes #${rivals[0].issue}`, `keep one of #${Math.min(pull.number, rivals[0].other)} and #${Math.max(pull.number, rivals[0].other)}`);
    if (pull.closes.length && pull.closes.every(i => i.state === "closed")) {
      return done("duplicate", `${pull.closes.map(i => `#${i.number}`).join(", ")} ${pull.closes.length === 1 ? "is" : "are"} already closed`, "close it, or reopen the issue");
    }
    const idle = stale ? `; no activity for ${idleDays} days` : "";
    if (pull.draft) return done("draft", `draft${idle}`, stale ? "finish or close it" : null);
    if (job?.state === "pr_open") return done("review", `isobot left the merge to you${idle}`, "merge it or reply on the issue");
    if (pull.mergeable === "CONFLICTING") return done("conflicting", `conflicts with the default branch${idle}`, `add \`${landLabel}\``);
    if (pull.ci === "failure") return done("failing", `CI is failing${idle}`, `add \`${landLabel}\``);
    if (pull.ci === "pending") return done("pending", `CI is running${idle}`, null);
    return done("ready", `${pull.ci === "success" ? "CI is green" : "no CI"} and it merges cleanly${idle}`, "merge it");
  });
}

export interface PrSweepDeps {
  config: PrSweepConfig | undefined;
  repos: () => string[];
  landLabel: string;
  github: SweepGitHub;
  store: Store;
  now?: () => Date;
}

/** The last sweep's result in the store, or null before the first one. */
export function latestSweep(store: Pick<Store, "cursor">): SweepResult | null {
  const raw = store.cursor(SWEEP_KEY);
  try { return raw ? JSON.parse(raw) as SweepResult : null; } catch { return null; }
}

export class PrSweep {
  constructor(private deps: PrSweepDeps) {}

  enabled(): boolean { return this.deps.config?.enabled !== false; }

  everyMs(): number { return (this.deps.config?.everyHours ?? 6) * 3_600_000; }

  /** The last sweep's result, or null before the first one. */
  latest(): SweepResult | null { return latestSweep(this.deps.store); }

  /** Sweeps when the last sweep is older than `everyHours`, or `force`. */
  async tick(force = false): Promise<SweepResult | null> {
    if (!this.enabled()) return null;
    const now = this.deps.now?.() ?? new Date();
    const last = this.latest();
    if (!force && last && now.getTime() - Date.parse(last.at) < this.everyMs()) return null;
    return this.sweep(now);
  }

  /** `dryRun`: closes nothing and keeps nothing; release PRs it would close stay in `pulls` with `autoClose`. */
  async sweep(now = this.deps.now?.() ?? new Date(), dryRun = false): Promise<SweepResult> {
    const { github, store } = this.deps;
    const result: SweepResult = { at: now.toISOString(), pulls: [], closed: [], errors: [] };
    const jobs = store.all(1000);
    for (const repo of this.deps.repos()) {
      const [owner, name] = repo.split("/");
      let data: SweepRepoData;
      try {
        data = await github.sweepRepo(owner, name);
      } catch (error) {
        result.errors.push(`${repo}: ${(error as Error).message.slice(0, 200)}`);
        continue;
      }
      for (const pull of classify(repo, data, jobs, now, this.deps.config?.staleDays ?? 14, this.deps.landLabel)) {
        if (pull.autoClose && this.deps.config?.closeSuperseded !== false && !dryRun) {
          try {
            await github.comment(owner, name, pull.number,
              `🧹 isobot's PR sweep is closing this release PR: ${pull.reason}. ` +
              `The branch stays; reopen this if it still needs to merge.`);
            await github.closePull(owner, name, pull.number);
            result.closed.push({ repo, number: pull.number, title: pull.title, reason: pull.reason });
            store.event(null, "pr_sweep_closed", `${repo}#${pull.number}: ${pull.reason}`);
            continue;
          } catch (error) {
            result.errors.push(`${repo}#${pull.number}: couldn't close: ${(error as Error).message.slice(0, 200)}`);
          }
        }
        result.pulls.push(pull);
      }
    }
    if (dryRun) return result;
    store.setCursor(SWEEP_KEY, JSON.stringify(result));
    const waiting = result.pulls.filter(p => p.action).length;
    store.event(null, "pr_sweep", `${result.pulls.length} open PRs, ${waiting} need you, ${result.closed.length} closed${result.errors.length ? `, ${result.errors.length} errors` : ""}`);
    return result;
  }
}

/** What the owner should look at, most actionable first: ready to merge, then land, then duplicates and stale drafts. */
export function needsOwner(result: SweepResult | null): SweptPull[] {
  if (!result) return [];
  const order: PullStatus[] = ["ready", "conflicting", "failing", "duplicate", "superseded", "draft", "review"];
  return result.pulls.filter(p => p.action).sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || b.idleDays - a.idleDays);
}

/** Every PR of a sweep, one line each, grouped by repository: the `prs` command. */
export function formatSweep(result: SweepResult): string {
  const lines: string[] = [`PR sweep at ${result.at}: ${result.pulls.length} open, ${result.pulls.filter(p => p.action).length} need you, ${result.closed.length} closed`];
  for (const repo of [...new Set(result.pulls.map(p => p.repo))]) {
    lines.push("", repo);
    for (const p of result.pulls.filter(x => x.repo === repo)) {
      lines.push(`  #${p.number} ${p.status.padEnd(11)} ${p.title.slice(0, 60)}: ${p.reason}${p.action ? ` → ${p.action}` : ""}${p.autoClose ? " (closes it)" : ""}`);
    }
  }
  if (result.closed.length) lines.push("", "Closed:", ...result.closed.map(c => `  ${c.repo}#${c.number} ${c.title.slice(0, 60)} (${c.reason})`));
  if (result.errors.length) lines.push("", "Errors:", ...result.errors.map(e => `  ${e}`));
  return lines.join("\n");
}

/** Lines for the daily check-in. PRs isobot left for review are already listed there, so they're left out. */
export function checkInLines(result: SweepResult | null, max = 10): string[] {
  if (!result) return [];
  const items = needsOwner(result).filter(p => p.status !== "review");
  const lines = items.slice(0, max).map(p => `${p.repo.split("/")[1]}#${p.number} ${p.title.slice(0, 70)}: ${p.reason} → ${p.action}`);
  if (items.length > max) lines.push(`…and ${items.length - max} more on the board`);
  for (const c of result.closed) lines.push(`Closed ${c.repo.split("/")[1]}#${c.number} ${c.title.slice(0, 60)} (${c.reason})`);
  return lines;
}
