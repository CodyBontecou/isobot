import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentRun, Builder, JobDevices, PreviousReview, Review } from "./builder.js";
import { hasDevices, type DeviceLease, type Devices } from "./devices.js";
import { collectMedia, mediaMarkdown, type MediaFile } from "./media.js";
import { isTransient, UsageLimitError } from "./errors.js";
import { failureFeedback, formatChecks } from "./checks.js";
import { configuredRepos, contentPolicy, policyFor, type Environment, type RepoPolicy, type RunnerConfig } from "./config.js";
import { contentEvidenceKey, CONTENT_BUILD_RULES } from "./content.js";
import type { DiffStat } from "./git.js";
import type { GitHubApi, Issue, IssueComment, PullRequest } from "./github.js";
import { asksToRetry, maxCommentId, noteFeedback, ownerNotes, quoteNote, withNotes, type OwnerNote } from "./notes.js";
import type { CardUpdate, Notifier } from "./notify.js";
import { evaluateGate, matchesGlob, reviewShortfalls, reviewStopReason, strayPaths, type CheckReport, type GateDecision } from "./policy.js";
import type { FollowUp, Job, JobKind, Store } from "./store.js";

/** The git operations the pipeline needs; `Repo` implements it, tests fake it. */
export interface RepoOps {
  sync(defaultBranch: string): Promise<string>;
  createWorkspace(branch: string, baseSha: string): Promise<string>;
  removeWorkspace(name: string): Promise<void>;
  /** Whether a build workspace for this branch is still there (a restart left it behind). */
  hasWorkspace(name: string): boolean | Promise<boolean>;
  /** Stops commands still running in a workspace a restart left behind (cloud builds keep running). */
  interrupt?(name: string): Promise<void>;
  workspacePath(name: string): string;
  commitPending(dir: string, message: string): Promise<void>;
  capture(dir: string, branch: string): Promise<string>;
  ahead(baseSha: string, sha: string): Promise<number>;
  diffStat(baseSha: string, sha: string): Promise<DiffStat>;
  diff(baseSha: string, sha: string): Promise<string>;
  push(sha: string, branch: string): Promise<void>;
  checkoutAt(sha: string, name: string): Promise<string>;
  /** Removes leftover workspaces and refs for one issue (🧹); returns what went. */
  purge(number: number): Promise<string[]>;
  fetchBranch(branch: string): Promise<string>;
  mergeBase(a: string, b: string): Promise<string>;
  /**
   * Merges `sha` (the newest main) into the workspace's branch. A clean merge is committed; on a conflict the
   * merge is left in progress, with markers in the files it returns, for the builder to resolve.
   */
  mergeMain(dir: string, sha: string): Promise<string[]>;
  /** Publishes screenshots/recordings and returns a URL per file name (git.ts). */
  publishMedia(prefix: string, files: { file: string; name: string }[], message: string): Promise<Record<string, string>>;
}

export interface PipelineDeps {
  config: RunnerConfig;
  env: Pick<Environment, "home">;
  store: Store;
  github: GitHubApi;
  builder: Builder;
  notifier: Notifier;
  repo(owner: string, repo: string): RepoOps;
  /**
   * Runs commands in a directory. `sandbox: true` for builder-written code (checks): the
   * implementation must confine it (see sandbox.ts). Release commands run unsandboxed.
   */
  checks(cwd: string, commands: string[], options: { timeoutMs?: number; sandbox: boolean; env?: Record<string, string> }): Promise<CheckReport>;
  /** Parent folder for each build's $ISOBOT_MEDIA (default: the system temp folder). */
  mediaRoot?: string;
  /** Boots per-job simulators/emulators for repos with `devices` configured. */
  devices?: Devices;
  /** The clock follow-ups and claim leases run on (tests move it). */
  now?: () => Date;
  /** This runner's name in claim leases, so two runners (e.g. a laptop and the mini) never build one issue twice. */
  runnerId?: string;
  /** Cloud builds (cloud.ts), for repos and content sites with `executor: "cloudflare"`. */
  cloud?: CloudExecutor;
}

/** Where one job's workspace, builder and checks live. */
export interface CloudExecutor {
  repo(owner: string, repo: string): RepoOps;
  builder: Builder;
  checks(cwd: string, commands: string[], options: { timeoutMs?: number; env?: Record<string, string> }): Promise<CheckReport>;
}

interface Executor {
  /** A cloud build: no simulators, emulators or captures. */
  remote: boolean;
  repo: RepoOps;
  builder: Builder;
  checks: CloudExecutor["checks"];
}

/**
 * Never pushed by isobot: a pushed branch's workflows run in GitHub Actions with the
 * repository's secrets before any review or merge.
 */
export const UNPUSHABLE_PATHS = [".github/workflows/**", ".github/actions/**", ".gitlab-ci.yml", ".circleci/**", "bitrise.yml", "codemagic.yaml", ".buildkite/**"];

/** Backoff for transient failures, by attempt number. */
const RETRY_DELAYS_MS = [5 * 60_000, 15 * 60_000, 45 * 60_000, 2 * 60 * 60_000];

const MAX_ATTEMPTS = 5;
/** Owner notes applied within one build before the rest wait for the PR revision. */
const MAX_NOTE_ROUNDS = 5;
/** Rounds a content builder gets to take back files outside the site's allowed paths before review. */
const MAX_PATH_ROUNDS = 2;
/** How many times a PR left behind by main is sent back to merge it in, before the gate decides as usual. */
const MAX_MAIN_ROUNDS = 2;
const CI_WAIT_MS = 90 * 60_000;
/** How long a new PR may go without any CI reporting before "no CI" is final. */
const CI_GRACE_MS = 5 * 60_000;
/** How often a PR waiting for CI, or a job waiting on another issue, is checked. */
const CI_POLL_MS = 30_000;
const BLOCKED_POLL_MS = 2 * 60_000;
/** A follow-up that keeps erroring is retried this often, and gives up (fails the job) after this many tries. */
const FOLLOW_UP_RETRY_MS = 5 * 60_000;
/** How long after a job finishes a reply on it ("retry", or a note) is still answered. */
const FINISHED_NOTES_HOURS = 48;
const FOLLOW_UP_MAX_ERRORS = 5;
/** A claim lease lasts this long and is renewed when less than LEASE_RENEW_MS is left, while the job is ours. */
const LEASE_MS = 45 * 60_000;
const LEASE_RENEW_MS = 20 * 60_000;
/** Job states in which this runner holds the issue's claim. */
const HELD_STATES = ["queued", "blocked", "building", "awaiting_ci"];
export const PROPOSAL_MARKER = "<!-- isobot:triage:";

/** What the builder is asked to do, where it came from, and a fingerprint to detect edits. */
export interface TaskSource {
  task: string;
  trusted: boolean;
  author: string;
  fingerprint: string;
}

/**
 * Where a running build is, saved as it goes so a restart can pick it up (recover()).
 * `builder`: a builder session is running; `verify`: the runner is checking, reviewing or merging its work.
 */
interface Progress {
  stage: "builder" | "verify";
  /** The latest builder summary (what checks are run against) and the first one (the PR's description). */
  summary: string;
  main: string;
  media: string;
}

/** What recover() kept of an interrupted build: its work as a commit, and where it was. */
interface Checkpoint extends Progress {
  sha: string;
}

/**
 * Everything the merge decision needs once the build itself is over, so a PR can wait for CI as a
 * follow-up in SQLite instead of holding a build slot (and survive a restart while it waits).
 */
interface MergeContext {
  sha: string;
  prNumber: number;
  prUrl: string;
  title: string;
  diff: DiffStat;
  checks: CheckReport;
  review: Review;
  fingerprint: string;
  trusted: boolean;
  author: string;
  /** Follow-up errors so far (see runFollowUps). */
  errors?: number;
}

const leaseKey = (id: string) => `lease:${id}`;
const progressKey = (id: string) => `progress:${id}`;
const checkpointKey = (id: string) => `checkpoint:${id}`;

/**
 * Effect-ledger keys (Store.startEffect). A merge is recorded with its merge commit once it happened, by
 * isobot or by you. A release step is recorded before it runs and after it finishes, per merge commit, so a
 * restart in the middle is noticed and never silently repeated or forgotten.
 */
const mergeKey = (id: string, pr: number) => `merge:${id}:${pr}`;
const releaseKey = (id: string, step: "merge" | "ship", sha: string) => `release:${id}:${step}:${sha}`;
interface ReleaseResult { passed: boolean }

/** Job states a retry may start over from. */
const REBUILDABLE = ["merged", "released", "shipped", "closed", "failed", "stopped"];

export class Pipeline {
  private running = new Set<string>();
  /** Follow-up work running beside the cycle (a merge and release after CI), by job id. */
  private background = new Map<string, Promise<void>>();
  /** Set on SIGTERM/SIGINT: builds dying because their processes were killed are interruptions, not failures. */
  private shuttingDown = false;
  private viewer?: string;

  constructor(private deps: PipelineDeps) {}

  /**
   * Call before killing child processes. Running jobs stay "building" with their workspaces on disk, and
   * recover() saves and re-queues them on the next start. A deliberate stop doesn't use up an attempt.
   */
  beginShutdown(): void {
    this.shuttingDown = true;
    for (const id of this.running) {
      const job = this.deps.store.get(id);
      if (job?.state === "building") this.deps.store.update(id, { attempts: Math.max(0, job.attempts - 1) });
    }
  }

  private get labels() { return this.deps.config.labels; }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private get runnerId(): string {
    return (this.deps.runnerId ?? "runner").replace(/[^\w.-]+/g, "-");
  }

  /** Resolves once follow-up work started in the background (merges and releases after CI) has finished. */
  async settled(): Promise<void> {
    while (this.background.size) await Promise.all(this.background.values());
  }

  /** Moves approved issues (ready label) into the local queue and claims them on GitHub. */
  async discover(): Promise<Job[]> {
    const { github, store } = this.deps;
    const claimed: Job[] = [];
    for (const { owner, repo } of configuredRepos(this.deps.config)) {
      let issues: Issue[];
      try {
        issues = await github.issuesWithLabel(owner, repo, this.labels.ready);
      } catch (error) {
        console.warn(`[discover] ${owner}/${repo}: ${(error as Error).message}`);
        continue;
      }
      for (const issue of issues) {
        try {
          if (hasLabel(issue, this.labels.stop) || hasLabel(issue, this.labels.cleanup)) continue;
          // Approval is the trust boundary: only you (or trustedAuthors) may start a build.
          const approver = await github.labeledBy(owner, repo, issue.number, this.labels.ready);
          if (!approver || !(await this.isTrusted(approver))) {
            await github.removeLabel(owner, repo, issue.number, this.labels.ready);
            await github.comment(owner, repo, issue.number, `isobot only builds issues approved by its owner; \`${this.labels.ready}\` was added by @${approver ?? "unknown"}.`);
            continue;
          }
          // Another runner (say the mini, while this is the laptop) already holds the issue: leave it to that one.
          const before = await github.issueComments(owner, repo, issue.number);
          const viewer = await this.viewerLogin();
          const held = hasLabel(issue, this.labels.building)
            ? liveLeases(before, viewer, this.now()).find(lease => lease.runner !== this.runnerId) : undefined;
          if (held) {
            await github.removeLabel(owner, repo, issue.number, this.labels.ready);
            await github.comment(owner, repo, issue.number,
              `isobot's runner \`${held.runner}\` is already working on this (its claim runs until ${held.until.slice(0, 16).replace("T", " ")} UTC), so this one left it alone. Approve it again once that build is done.`);
            store.event(storeId(owner, repo, issue.number), "claim", `held by ${held.runner}`, { type: "claim", v: 1, runner: this.runnerId, outcome: "held_elsewhere", holder: held.runner });
            continue;
          }
          const baseline = maxCommentId(before);
          const kind = this.kindOf(owner, repo, issue);
          const job = store.enqueue(owner, repo, issue.number, issue.title, kind);
          await github.removeLabel(owner, repo, issue.number, this.labels.ready);
          if (!job) {
            const existing = store.get(storeId(owner, repo, issue.number));
            await github.comment(owner, repo, issue.number, `isobot is already on this (${existing?.state.replace("_", " ") ?? "in progress"}${existing?.prNumber ? `, PR #${existing.prNumber}` : ""}).`);
            continue;
          }
          await github.removeLabel(owner, repo, issue.number, this.labels.failed);
          await github.addLabels(owner, repo, issue.number, [this.labels.building]);
          if (!(await this.claim(job, baseline))) continue;
          await this.listenForNotes(job);
          const { release } = this.policyOf(owner, repo, kind);
          const extraSteps = [...(release.onMerge.length ? ["Release" as const] : []), ...(release.onShip.length ? ["Ship" as const] : [])];
          // "Blocked by #12" in the issue: claimed now, built once #12 is closed.
          const blockers = await this.openBlockers(issue);
          if (blockers.length) {
            store.update(job.id, { state: "blocked" });
            store.schedule(job.id, "blocked", new Date(this.now().getTime() + BLOCKED_POLL_MS), { on: blockers }, this.now());
            store.event(job.id, "blocked", blockers.join(", "), { type: "blocked", v: 1, on: blockers });
            await github.comment(owner, repo, issue.number, `⛓ Waiting on ${blockers.join(", ")}. isobot builds this once ${blockers.length === 1 ? "it's" : "they're all"} closed.`);
            await this.feed(store.get(job.id)!, { phase: "blocked", title: issue.title, extraSteps, detail: `Waiting on ${blockers.join(", ")}` });
            claimed.push(job);
            continue;
          }
          await this.feed(job, { phase: "queued", title: issue.title, extraSteps });
          claimed.push(job);
        } catch (error) {
          console.warn(`[discover] ${owner}/${repo}#${issue.number}: ${(error as Error).message}`);
        }
      }
    }
    return claimed;
  }

  /**
   * Posts the claim comment with this runner's lease, then reads the issue again. Two runners that claimed the
   * same approval at once both see both leases; the earlier comment wins and the other backs off.
   */
  private async claim(job: Job, baseline: number): Promise<boolean> {
    const { github, store } = this.deps;
    const text = `🤖 isobot picked this up and is building it now. Add the \`${this.labels.stop}\` label at any time to stop.`;
    const until = new Date(this.now().getTime() + LEASE_MS);
    const commentId = await github.comment(job.owner, job.repo, job.number, `${text}\n\n${leaseMarker(this.runnerId, until)}`);
    store.setCursor(leaseKey(job.id), JSON.stringify({ commentId, until: until.toISOString(), text }));
    const contenders = liveLeases(await github.issueComments(job.owner, job.repo, job.number), await this.viewerLogin(), this.now())
      .filter(lease => lease.id > baseline).sort((a, b) => a.id - b.id);
    const winner = contenders[0];
    if (winner && winner.runner !== this.runnerId) {
      store.forget(job.id);
      store.setCursor(leaseKey(job.id), "");
      store.event(job.id, "claim", `lost to ${winner.runner}`, { type: "claim", v: 1, runner: this.runnerId, outcome: "lost", holder: winner.runner });
      console.warn(`[discover] ${job.id}: runner ${winner.runner} claimed it first; leaving it to that runner`);
      return false;
    }
    store.event(job.id, "claim", this.runnerId, { type: "claim", v: 1, runner: this.runnerId, outcome: "won" });
    return true;
  }

  /** Keeps this runner's claim leases alive while it holds the jobs; a runner that dies lets them lapse. */
  private async renewLeases(): Promise<void> {
    const { github, store } = this.deps;
    for (const job of store.inState(...HELD_STATES as Job["state"][])) {
      const raw = store.cursor(leaseKey(job.id));
      if (!raw) continue;
      try {
        const lease = JSON.parse(raw) as { commentId: number; until: string; text: string };
        if (Date.parse(lease.until) - this.now().getTime() > LEASE_RENEW_MS) continue;
        const until = new Date(this.now().getTime() + LEASE_MS);
        await github.updateComment(job.owner, job.repo, lease.commentId, `${lease.text}\n\n${leaseMarker(this.runnerId, until)}`);
        store.setCursor(leaseKey(job.id), JSON.stringify({ ...lease, until: until.toISOString() }));
      } catch (error) {
        console.warn(`[lease] ${job.id}: couldn't renew: ${(error as Error).message}`);
      }
    }
  }

  /** The issues named in "Blocked by" / "Depends on" lines of the issue that are still open, as `#12` or `owner/repo#12`. */
  private async openBlockers(issue: Issue): Promise<string[]> {
    const open: string[] = [];
    for (const ref of parseBlockers(issue.body, issue.owner, issue.repo)) {
      if (ref.owner === issue.owner.toLowerCase() && ref.repo === issue.repo.toLowerCase() && ref.number === issue.number) continue;
      const name = ref.owner === issue.owner.toLowerCase() && ref.repo === issue.repo.toLowerCase() ? `#${ref.number}` : `${ref.owner}/${ref.repo}#${ref.number}`;
      try {
        if ((await this.deps.github.issue(ref.owner, ref.repo, ref.number)).state === "open") open.push(name);
      } catch {
        open.push(`${name} (isobot can't read it)`);
      }
    }
    return open;
  }

  /** A content-train issue (content label) in a repo with a site; everything else is ordinary work. */
  kindOf(owner: string, repo: string, issue: Pick<Issue, "labels">): JobKind {
    return hasLabel(issue, this.labels.content) && policyFor(this.deps.config, `${owner}/${repo}`).content ? "content" : "issue";
  }

  /** The repo's policy, or the site's content policy for content-train work. */
  policyOf(owner: string, repo: string, kind: JobKind): RepoPolicy {
    const policy = policyFor(this.deps.config, `${owner}/${repo}`);
    return kind === "content" && policy.content ? contentPolicy(policy) : policy;
  }

  /** Starts queued jobs up to the concurrency limit. Returns the promises for the jobs it started. */
  startQueued(): Promise<void>[] {
    const started: Promise<void>[] = [];
    if (this.deps.store.pausedUntil()) return started;
    const contentLimit = this.deps.config.content?.maxConcurrentJobs ?? 1;
    const kinds = new Map(this.deps.store.inState("building").map(job => [job.id, job.kind]));
    let content = [...this.running].filter(id => kinds.get(id) === "content").length;
    for (const job of this.deps.store.runnable()) {
      if (this.running.size >= this.deps.config.maxConcurrentJobs) break;
      if (this.running.has(job.id)) continue;
      // Content work takes its own few slots, so a day of posts never holds up app builds.
      if (job.kind === "content" && content >= contentLimit) continue;
      if (job.kind === "content") content++;
      this.running.add(job.id);
      started.push(this.build(job).finally(() => this.running.delete(job.id)));
    }
    return started;
  }

  get activeJobs(): string[] {
    return [...this.running];
  }

  /**
   * After a restart (or crash), before workspaces are cleared: each interrupted build's work is committed
   * and kept, and the job queued to pick up where it was: the builder session resumes, or checks and review
   * run again on its work. A build with nothing on disk starts over.
   */
  async recover(): Promise<void> {
    const { store } = this.deps;
    for (const job of store.inState("building")) {
      let checkpoint: Checkpoint | null = null;
      try {
        checkpoint = await this.salvage(job);
      } catch (error) {
        console.warn(`[recover] ${job.id}: couldn't keep its work: ${(error as Error).message}`);
      }
      store.setCursor(checkpointKey(job.id), checkpoint ? JSON.stringify(checkpoint) : "");
      store.setCursor(progressKey(job.id), "");
      store.update(job.id, { state: "queued" });
      store.event(job.id, "interrupted", checkpoint ? `kept ${checkpoint.sha.slice(0, 12)} (${checkpoint.stage})` : "nothing to keep; starts over");
    }
  }

  /** This Mac (deps.repo, builder, sandboxed checks), or a Cloudflare build sandbox when the policy says so. */
  private executor(job: Job, policy = this.policyOf(job.owner, job.repo, job.kind)): Executor {
    if (policy.executor === "cloudflare") {
      const cloud = this.deps.cloud;
      if (!cloud) throw new Error("this repository builds on Cloudflare (`executor: \"cloudflare\"`), but the runner has no build sandbox: set ISOBOT_SANDBOX_URL and ISOBOT_SANDBOX_TOKEN");
      return { remote: true, repo: cloud.repo(job.owner, job.repo), builder: cloud.builder, checks: cloud.checks };
    }
    return {
      remote: false, repo: this.deps.repo(job.owner, job.repo), builder: this.deps.builder,
      // Checks run builder-written code, so always sandboxed.
      checks: (cwd, commands, options) => this.deps.checks(cwd, commands, { ...options, sandbox: true }),
    };
  }

  private async salvage(job: Job): Promise<Checkpoint | null> {
    const raw = this.deps.store.cursor(progressKey(job.id));
    if (!raw || !job.branch) return null;
    const progress = JSON.parse(raw) as Progress;
    const repo = this.executor(job).repo;
    if (!(await repo.hasWorkspace(job.branch))) return null;
    await repo.interrupt?.(job.branch);
    const dir = repo.workspacePath(job.branch);
    await repo.commitPending(dir, "WIP: interrupted by a runner restart");
    return { ...progress, sha: await repo.capture(dir, job.branch) };
  }

  private setProgress(id: string, progress: Progress | null): void {
    this.deps.store.setCursor(progressKey(id), progress ? JSON.stringify(progress) : "");
  }

  /**
   * Work the owner asked for: the auto label, added by the runner's own account. Only that account can
   * apply it meaningfully (the owner by hand, or the runner for the owner's Vox.md notes), so a
   * collaborator or bot adding it changes nothing.
   */
  async ownerOriginated(issue: Issue): Promise<boolean> {
    if (!hasLabel(issue, this.labels.auto)) return false;
    const by = await this.deps.github.labeledBy(issue.owner, issue.repo, issue.number, this.labels.auto);
    return Boolean(by) && by!.toLowerCase() === (await this.viewerLogin()).toLowerCase();
  }

  private async isTrusted(login: string): Promise<boolean> {
    const viewer = await this.viewerLogin();
    return [viewer, ...(this.deps.config.trustedAuthors ?? [])].some(a => a.toLowerCase() === login.toLowerCase());
  }

  /** Builds the task text from the issue, preferring isobot's own vetted proposal over a reporter's raw text. */
  async taskFor(issue: Issue): Promise<TaskSource> {
    const viewer = await this.viewerLogin();
    const comments: IssueComment[] = await this.deps.github.issueComments(issue.owner, issue.repo, issue.number);
    const proposal = comments.filter(c => c.author.toLowerCase() === viewer.toLowerCase() && c.body.includes(PROPOSAL_MARKER)).at(-1);
    const kind = this.kindOf(issue.owner, issue.repo, issue);
    const policy = this.policyOf(issue.owner, issue.repo, kind);
    let task = buildTask(proposal ? { ...issue, body: proposal.body } : issue, policy);
    if (kind === "content") {
      // The research's private evidence (Search Console figures) never goes on the public issue.
      const evidence = this.deps.store.cursor(contentEvidenceKey(issue.owner, issue.repo, issue.number));
      const paths = `## Files this content may change\nAnything else keeps it from publishing:\n${(policy.allowedPaths ?? []).map(glob => `- \`${glob}\``).join("\n")}`;
      task = [task, CONTENT_BUILD_RULES, paths, ...(evidence ? ["## Private research evidence (keep out of the repository, commits and PR)", evidence] : [])].join("\n\n");
    }
    const fingerprint = createHash("sha256").update(`${issue.title}\n${issue.body}\n${proposal?.body ?? ""}`).digest("hex");
    // A stranger's issue that isobot's own proposal replaced, and that isobot itself approved as small,
    // builds from the vetted proposal, so it may go as far as the owner's own work.
    const vetted = Boolean(proposal) && await this.ownerOriginated(issue);
    return { task, trusted: vetted || await this.isTrusted(issue.author), author: issue.author, fingerprint };
  }

  private async viewerLogin(): Promise<string> {
    this.viewer ??= await this.deps.github.viewer();
    return this.viewer;
  }

  async build(job: Job): Promise<void> {
    const { github, store } = this.deps;
    const policy = this.policyOf(job.owner, job.repo, job.kind);
    let ex: Executor;
    try {
      ex = this.executor(job, policy);
    } catch (error) {
      return this.fail(job, error as Error);
    }
    const { repo, builder } = ex;
    const attempts = job.attempts + 1;
    if (attempts > MAX_ATTEMPTS) return this.fail(job, new Error(`gave up after ${MAX_ATTEMPTS} interrupted attempts`));
    // A revision continues the open PR's branch and builder session instead of starting over.
    const revising = job.revising && job.prNumber !== null && job.branch !== null;
    // Work a restart interrupted (recover()): it continues from its saved commit on the same branch.
    const savedCheckpoint = store.cursor(checkpointKey(job.id));
    const resume = savedCheckpoint ? JSON.parse(savedCheckpoint) as Checkpoint : null;
    store.setCursor(checkpointKey(job.id), "");
    this.setProgress(job.id, null);
    const branch = resume && job.branch ? job.branch : revising ? job.branch! : `isobot/${job.number}-${slug(job.title)}`;
    job = store.update(job.id, { state: "building", attempts, branch });
    let workspace: string | null = null;
    let lease: DeviceLease | null = null;
    // Screenshots and recordings of visible changes ($ISOBOT_MEDIA); both of the builder's sandboxes can write temp.
    // An interrupted build keeps the captures it already made.
    const mediaDir = resume?.media && existsSync(resume.media) ? resume.media : mkdtempSync(path.join(this.deps.mediaRoot ?? tmpdir(), "isobot-media-"));
    // A cloud builder can't write to this Mac, so it captures nothing.
    const builderMedia = ex.remote ? undefined : mediaDir;
    try {
      const issue = await github.issue(job.owner, job.repo, job.number);
      if (hasLabel(issue, this.labels.stop)) return this.stop(job, issue);
      // The PR may have merged already: isobot merged it just before a restart, or you merged it while a
      // revision waited. Building again would open a second PR; carry on from the merge instead.
      if (job.prNumber !== null) {
        const pr = await github.pull(job.owner, job.repo, job.prNumber);
        if (pr.merged && pr.mergeCommitSha) return this.adoptMerge(job, pr, policy);
      }
      if (issue.state === "closed") return this.stop(job, issue);
      const source = await this.taskFor(issue);
      const base = await github.defaultBranch(job.owner, job.repo);
      const mainSha = await repo.sync(base);
      // Cloud builds run on Linux: no simulators or emulators (content falls back to tracing the source).
      if (hasDevices(policy.devices) && this.deps.devices && !ex.remote) {
        await this.feed(job, { phase: "devices" });
        lease = await this.deps.devices.lease(job.id, policy.devices);
        store.event(job.id, "devices", lease.describe());
      }
      const devices: JobDevices | undefined = lease ?? undefined;
      const timeoutMinutes = job.kind === "content" ? this.deps.config.builder.contentTimeoutMinutes : undefined;
      const notes = await this.takeNotes(job);
      // Everything the owner said since approving goes into the task, so the reviewer judges against it too.
      let task = withNotes(source.task, notes.all);
      let run: AgentRun;
      let mainSummary = "";
      let baseSha: string;
      let noteRounds = 0;
      const sessionId = () => run?.sessionId ?? store.get(job.id)?.sessionId ?? null;
      /**
       * Every builder run. Its session id is chosen and saved before it starts, and the stage after, so a
       * restart in the middle resumes that session (recover()).
       */
      const builderStep = async (call: (ids: { sessionId: string | null; newSessionId: string }) => Promise<AgentRun>, from = sessionId()) => {
        const newSessionId = randomUUID();
        store.update(job.id, { sessionId: from ?? newSessionId });
        this.setProgress(job.id, { stage: "builder", summary: "", main: mainSummary, media: mediaDir });
        const result = await call({ sessionId: from, newSessionId });
        store.update(job.id, { sessionId: result.sessionId ?? from ?? newSessionId });
        mainSummary ||= result.summary;
        this.setProgress(job.id, { stage: "verify", summary: result.summary, main: mainSummary, media: mediaDir });
        return result;
      };
      if (resume) {
        baseSha = await repo.mergeBase(mainSha, resume.sha);
        workspace = await repo.createWorkspace(branch, resume.sha);
        mainSummary = resume.main;
        if (resume.stage === "builder") {
          await this.feed(job, { phase: "implementing" }, "♻️ The runner restarted mid-build. The builder picks up where it left off.");
          run = await builderStep(ids => builder.revise({ cwd: workspace!, ...ids, task, feedback: "", devices, media: builderMedia, timeoutMinutes, resumed: true }));
        } else {
          await this.deps.notifier.say(job, "♻️ The runner restarted mid-build. Checks and review run again on the builder's work so far.");
          run = { ok: true, sessionId: sessionId(), summary: resume.summary };
          this.setProgress(job.id, { stage: "verify", summary: resume.summary, main: mainSummary, media: mediaDir });
        }
        store.event(job.id, "resumed", run.summary);
      } else if (revising) {
        const head = await repo.fetchBranch(branch);
        workspace = await repo.createWorkspace(branch, head);
        // Other PRs may have merged since this one was built. Bring the newest main in first, so the revision
        // is judged (and merges) against what is live now; GitHub runs no CI on a PR that conflicts.
        const conflicts = await repo.mergeMain(workspace, mainSha);
        baseSha = mainSha;
        if (conflicts.length) store.event(job.id, "main_conflict", conflicts.join(", "));
        await github.removeLabel(job.owner, job.repo, job.number, this.labels.review);
        await github.addLabels(job.owner, job.repo, job.number, [this.labels.building]);
        await github.comment(job.owner, job.repo, job.number, notes.fresh.length
          ? `🔁 isobot is revising PR #${job.prNumber} with your note. Add \`${this.labels.stop}\` to stop.`
          : `🔁 isobot is bringing PR #${job.prNumber} up to date with ${base}. Add \`${this.labels.stop}\` to stop.`);
        await this.feed(job, { phase: "revising", notes: this.noteCount(job, notes.fresh.length) }, notes.fresh.length ? this.ackNotes(notes.fresh) : undefined);
        if (notes.fresh.length) noteRounds++;
        const asked = notes.fresh.length ? noteFeedback(notes.fresh) : "Re-read the task and the owner's follow-up notes, and make sure this branch satisfies all of them.";
        run = await builderStep(ids => builder.revise({
          cwd: workspace!, ...ids, task, devices, media: builderMedia, timeoutMinutes,
          feedback: conflicts.length ? `${conflictFeedback(conflicts, base)}\n\n${asked}` : asked,
        }), job.sessionId);
        store.event(job.id, "revised", run.summary, { type: "builder", v: 1, round: "revise PR", ok: run.ok });
      } else {
        baseSha = mainSha;
        workspace = await repo.createWorkspace(branch, baseSha);
        await this.feed(job, { phase: "implementing" });
        run = await builderStep(ids => builder.implement({ cwd: workspace!, task, devices, media: builderMedia, timeoutMinutes, sessionId: ids.newSessionId }), null);
        store.event(job.id, "implemented", run.summary, { type: "builder", v: 1, round: "implement", ok: run.ok });
      }
      const commit = async (message: string) => {
        await repo.commitPending(workspace!, message);
        return repo.capture(workspace!, branch);
      };
      let sha = await commit(revising ? `Apply owner feedback for #${issue.number}` : `${issue.title} (#${issue.number})\n\nImplemented by isobot for ${issue.url}`);
      if (await repo.ahead(baseSha, sha) === 0) {
        return this.fail(job, new Error(`the builder made no changes.\n\nBuilder said:\n\n${quote(run.summary || run.error || "(nothing)")}`), false);
      }
      const runChecks = async (summary: string) => {
        await this.feed(job, { phase: "checking" }, `🔨 Builder:\n${quote(summary || "(no summary)", 15)}`);
        const report = await ex.checks(workspace!, policy.checks, { env: lease?.env });
        store.event(job.id, "checks", report.passed ? "passed" : "failed",
          { type: "checks", v: 1, passed: report.passed, failed: report.results.filter(r => !r.ok).map(r => r.command) });
        await this.deps.notifier.say(job, checksLine(report));
        return report;
      };

      // The PR describes the change itself; fix, review and note rounds are listed after it.
      const laterRounds: { label: string; summary: string }[] = [];
      let checks = await runChecks(run.summary);
      let review: Review | undefined;
      let fixRounds = 0;
      let reviewRounds = 0;
      let pathRounds = 0;
      // Each review sees the last one and the builder's answer, so rounds converge instead of starting over.
      let previous: PreviousReview | undefined;
      const confidences: number[] = [];
      for (;;) {
        // The owner spoke up (Discord thread, issue comment, `runner say`): their note comes first.
        if (noteRounds < MAX_NOTE_ROUNDS) {
          const late = await this.takeNotes(job);
          if (late.fresh.length) {
            noteRounds++;
            task = withNotes(source.task, late.all);
            await this.feed(job, { phase: "revising", notes: this.noteCount(job, late.fresh.length) }, this.ackNotes(late.fresh));
            run = await builderStep(ids => builder.revise({ cwd: workspace!, ...ids, task, feedback: noteFeedback(late.fresh), devices, media: builderMedia, timeoutMinutes }));
            laterRounds.push({ label: "Owner note", summary: run.summary });
            this.builderEvent(job, laterRounds.at(-1)!.label, run);
            sha = await commit(`Apply owner feedback for #${issue.number}`);
            checks = await runChecks(run.summary);
            continue;
          }
        }
        if (!checks.passed && fixRounds < this.deps.config.builder.maxFixRounds) {
          fixRounds++;
          await this.feed(job, { phase: "fixing", fixRounds });
          run = await builderStep(ids => builder.revise({ cwd: workspace!, ...ids, task, feedback: failureFeedback(checks), devices, media: builderMedia, timeoutMinutes }));
          laterRounds.push({ label: `Check fix ${fixRounds}`, summary: run.summary });
            this.builderEvent(job, laterRounds.at(-1)!.label, run);
          sha = await commit(`Fix checks for #${issue.number}`);
          checks = await runChecks(run.summary);
          continue;
        }
        // Content can't merge with files outside the site's paths, and no one will merge it by hand: the builder takes them back first.
        if (job.kind === "content" && pathRounds < MAX_PATH_ROUNDS) {
          const stray = strayPaths(policy, await repo.diffStat(baseSha, sha));
          if (stray.protected.length || stray.outside.length) {
            pathRounds++;
            await this.feed(job, { phase: "fixing" }, `↩️ Taking back files content can't change: ${[...stray.protected, ...stray.outside].slice(0, 8).join(", ")}`);
            run = await builderStep(ids => builder.revise({ cwd: workspace!, ...ids, task, feedback: pathFeedback(stray, policy.allowedPaths ?? []), devices, media: builderMedia, timeoutMinutes }));
            laterRounds.push({ label: `Path fix ${pathRounds}`, summary: run.summary });
            this.builderEvent(job, laterRounds.at(-1)!.label, run);
            sha = await commit(`Keep #${issue.number} to the site's files`);
            checks = await runChecks(run.summary);
            continue;
          }
        }
        // The reviewer sees exactly the commit the runner captured, diffed in the runner's own clone.
        await this.feed(job, { phase: "reviewing" });
        review = await builder.review({
          cwd: workspace, task, diff: await repo.diff(baseSha, sha), checks: formatChecks(checks),
          media: collectMedia(mediaDir).files.map(f => f.file), previous, content: job.kind === "content",
        });
        confidences.push(review.confidence);
        store.event(job.id, "review", `${review.verdict} ${review.confidence} ${review.risk}: ${review.summary}`, {
          type: "review", v: 1, round: reviewRounds + 1, verdict: review.verdict, confidence: review.confidence, risk: review.risk,
          concerns: review.concerns, blockers: review.blockers ?? [],
        });
        await this.deps.notifier.say(job, reviewLine(review));
        // A change request always goes back. An approval that misses the merge bar (confidence or risk)
        // goes back too when the repo could merge, so the builder works the doubts down instead of stopping short.
        const shortfalls = reviewShortfalls(review, policy);
        const mayMerge = policy.autonomy === "merge" || policy.ownerAutonomy === "merge";
        const retry = review.verdict === "request_changes" || (mayMerge && shortfalls.length > 0);
        // More rounds can't fix what only the owner can settle, and a stalled score won't move with more code.
        const stop = retry ? reviewStopReason(review, confidences) : null;
        if (retry && !stop && reviewRounds < this.deps.config.builder.maxReviewRounds) {
          reviewRounds++;
          await this.feed(job, { phase: "addressing", reviewRounds });
          const feedback = reviewFeedback(review, shortfalls);
          run = await builderStep(ids => builder.revise({ cwd: workspace!, ...ids, task, feedback, devices, media: builderMedia, timeoutMinutes }));
          laterRounds.push({ label: `Review round ${reviewRounds}`, summary: run.summary });
            this.builderEvent(job, laterRounds.at(-1)!.label, run);
          previous = { confidence: review.confidence, concerns: review.concerns, blockers: review.blockers ?? [], response: run.summary };
          sha = await commit(`Address review for #${issue.number}`);
          checks = await runChecks(run.summary);
          continue;
        }
        if (stop) await this.deps.notifier.say(job, `⏸️ No more review rounds: ${stop}.`);
        // A note that arrived during the review goes in before anything is pushed.
        if (noteRounds < MAX_NOTE_ROUNDS && (await this.readNotes(job)).fresh.length) continue;
        break;
      }
      if (!review) throw new Error("review did not run");

      const diff = await repo.diffStat(baseSha, sha);
      const unpushable = diff.files.filter(file => UNPUSHABLE_PATHS.some(glob => matchesGlob(file.path, glob))).map(file => file.path);
      if (unpushable.length) {
        return this.fail(job, new Error(`the change edits CI configuration (${unpushable.join(", ")}). isobot never pushes those, because a pushed branch's workflows run with this repository's secrets. Make that change yourself, or reword the issue so it doesn't need one.`));
      }
      await this.feed(job, { phase: "pushing" });
      await repo.push(sha, branch);
      const media = await this.publishMedia(job, repo, mediaDir, sha);
      const body = prBody({ issue, run: mainSummary, rounds: laterRounds, checks, review, diff, media: media.markdown });
      const existing = await github.findPull(job.owner, job.repo, branch);
      const pr = existing && existing.state === "open"
        ? (await github.updatePull(job.owner, job.repo, existing.number, body), existing)
        : await github.createPull(job.owner, job.repo, { head: branch, base, title: issue.title, body });
      store.update(job.id, { prNumber: pr.number });
      await this.feed(job, { prUrl: pr.url }, `📤 ${pr === existing ? "Updated" : "Opened"} ${pr.url} (${diff.files.length} files, ${diff.changedLines} lines)`);
      if (media.files.length) await this.deps.notifier.media(job, `📸 What the change looks like (also on ${pr.url}):`, media.files);
      if (media.notes.length) await this.deps.notifier.say(job, `📸 Some captures weren't published:\n${media.notes.map(n => `- ${n}`).join("\n")}`);

      store.event(job.id, "pr", pr.url, { type: "pr", v: 1, number: pr.number, files: diff.files.length, lines: diff.changedLines });
      const context: MergeContext = {
        sha, prNumber: pr.number, prUrl: pr.url, title: issue.title, diff, checks, review,
        fingerprint: source.fingerprint, trusted: source.trusted, author: source.author,
      };
      const gate = await this.gate(job, policy, context);
      if (gate.merge && policy.requireCi) {
        // CI is a follow-up, not a wait inside the build: the slot frees for the next job, and a restart keeps it.
        store.update(job.id, { state: "awaiting_ci" });
        store.schedule(job.id, "ci", new Date(this.now().getTime() + CI_POLL_MS), context, this.now());
        await this.feed(job, { phase: "ci" });
        return;
      }
      await this.conclude(job, policy, context, gate);
    } catch (error) {
      if (this.shuttingDown) return;
      if (isTransient(error)) await this.retryLater(job, error as Error);
      else await this.fail(job, error as Error);
    } finally {
      if (lease) await lease.release().catch(error => console.warn(`[devices] ${job.id}: release failed: ${(error as Error).message}`));
      // On shutdown the workspace, captures and progress stay for recover() to pick up.
      if (!this.shuttingDown) {
        this.setProgress(job.id, null);
        rmSync(mediaDir, { recursive: true, force: true });
        if (workspace) await repo.removeWorkspace(branch).catch(() => undefined);
      }
    }
  }

  private builderEvent(job: Job, round: string, run: AgentRun): void {
    this.deps.store.event(job.id, "builder", round, { type: "builder", v: 1, round, ok: run.ok });
  }

  /** The merge decision, from the build's results and the issue as it is now. Re-run right before merging. */
  private async gate(job: Job, policy: RepoPolicy, context: MergeContext): Promise<GateDecision> {
    const current = await this.deps.github.issue(job.owner, job.repo, job.number);
    const owner = await this.ownerOriginated(current);
    const effective = owner ? { ...policy, autonomy: policy.ownerAutonomy ?? policy.autonomy } : policy;
    const decision = evaluateGate({ policy: effective, diff: context.diff, checks: context.checks, review: context.review, issueLabels: current.labels, stopLabel: this.labels.stop });
    if (!owner && policy.autonomy !== "merge" && policy.ownerAutonomy === "merge") {
      decision.reasons.push(`it isn't marked as yours; when you add \`${this.labels.auto}\` yourself, isobot merges once every gate passes`);
    }
    const before = decision.reasons.length;
    if (!context.trusted) decision.reasons.push(`the issue was written by @${context.author}, who isn't trusted to merge without you`);
    if ((await this.taskFor(current)).fingerprint !== context.fingerprint) decision.reasons.push("the issue text changed while isobot was building");
    if (current.state === "closed") decision.reasons.push("the issue was closed");
    if ((await this.readNotes(job)).fresh.length) decision.reasons.push("you sent a note isobot hasn't applied yet; it will revise the PR with it next");
    const ownerHold = decision.reasons.length > before || hasLabel(current, this.labels.stop) || (!owner && policy.autonomy !== "merge");
    return { merge: decision.reasons.length === 0, reasons: decision.reasons, ownerHold };
  }

  /** Merges the reviewed commit when the gate allows, then releases; otherwise leaves the PR to the owner. */
  private async conclude(job: Job, policy: RepoPolicy, context: MergeContext, gate: GateDecision): Promise<void> {
    const { github, store } = this.deps;
    const { prUrl, prNumber, title } = context;
    store.event(job.id, "gate", gate.merge ? "merge" : gate.reasons.join("; "), { type: "gate", v: 1, merge: gate.merge, reasons: gate.reasons });
    await github.removeLabel(job.owner, job.repo, job.number, this.labels.building);

    if (!gate.merge && job.kind === "content" && policy.autonomy === "merge" && !gate.ownerHold) return this.drop(job, context, gate);
    if (!gate.merge) {
      await github.addLabels(job.owner, job.repo, job.number, [this.labels.review]);
      store.update(job.id, { state: "pr_open" });
      const reasons = gate.reasons.map(r => `- ${r}`).join("\n") + needsYou(context.review);
      await github.comment(job.owner, job.repo, job.number, `🔍 isobot opened ${prUrl} and is leaving the merge to you:\n${reasons}`);
      await this.feed(job, { phase: "waiting", detail: reasons },
        `🔍 Leaving the merge to you:\n${reasons}\n\nReply here to ask for changes; isobot will revise the PR.`,
        `🔍 **${job.owner}/${job.repo}#${job.number}** ${title}: PR ready for your review: <${prUrl}>`);
      return;
    }

    // A restart between GitHub merging and the runner recording it leaves the job waiting to merge
    // again (e.g. after CI); carry on from that merge rather than have GitHub refuse a second one.
    const current = await github.pull(job.owner, job.repo, prNumber);
    if (current.merged && current.mergeCommitSha) return this.adoptMerge(job, current, policy);

    let mergeSha: string;
    try {
      // `sha` pins the merge to the reviewed commit; GitHub refuses if the branch moved.
      mergeSha = await github.merge(job.owner, job.repo, prNumber, context.sha, `${title} (#${prNumber})`);
      store.finishEffect(mergeKey(job.id, prNumber), job.id, mergeSha);
    } catch (error) {
      // Stopping: whether GitHub merged is unknown; the next start checks the PR (build() and here).
      if (this.shuttingDown) throw error;
      // Usually a conflict with a newer main: merge main in and build again; past that, hand it to the owner.
      if (await this.conflictsWithMain(job, context).catch(() => false)) return;
      await github.addLabels(job.owner, job.repo, job.number, [this.labels.review]);
      store.update(job.id, { state: "pr_open", lastError: (error as Error).message });
      await github.comment(job.owner, job.repo, job.number, `🔍 Every gate passed but GitHub refused the merge (${(error as Error).message}). ${prUrl} is ready for you.`);
      await this.feed(job, { phase: "waiting", detail: "Every gate passed, but GitHub refused the merge" }, `🔍 GitHub refused the merge: ${(error as Error).message.slice(0, 300)}`);
      return;
    }
    store.update(job.id, { state: "merged" });
    await github.comment(job.owner, job.repo, job.number, `✅ isobot merged ${prUrl} after checks, review (confidence ${context.review.confidence.toFixed(2)}) and policy gates passed.`);
    await this.feed(job, { phase: "merged" }, `✅ Merged ${prUrl}`, `✅ **${job.owner}/${job.repo}#${job.number}** ${title}: merged <${prUrl}>`);
    await this.afterMerge(store.get(job.id)!, mergeSha, policy);
  }

  /**
   * Content the gates refused, after every round the builder had. The content train runs without the owner, so
   * nothing waits on them: the PR and issue close, and the reason goes to the next research run (ContentTrain.research).
   */
  private async drop(job: Job, context: MergeContext, gate: GateDecision): Promise<void> {
    const { github, store } = this.deps;
    const reasons = gate.reasons.map(r => `- ${r}`).join("\n") + needsYou(context.review);
    await github.comment(job.owner, job.repo, job.number,
      `🗑️ isobot dropped this piece: after every round it got, it still didn't pass the content gates, and the content train doesn't wait for a person.\n${reasons}\n\n` +
      `${context.prUrl} is closed and nothing waits on you. The next research run sees why. To build it again, reopen this issue and comment \`retry\`.`);
    await github.closePull(job.owner, job.repo, context.prNumber);
    await github.removeLabel(job.owner, job.repo, job.number, this.labels.ready);
    await github.closeIssue(job.owner, job.repo, job.number, "not_planned");
    store.update(job.id, { state: "closed", lastError: `dropped: ${gate.reasons.join("; ")}`.slice(0, 1000) });
    store.event(job.id, "content_dropped", gate.reasons.join("; "), { type: "dropped", v: 1, reasons: gate.reasons });
    await this.feed(job, { phase: "closed", detail: `Dropped: ${gate.reasons.join("; ")}` }, `🗑️ Dropped (no one has to review it):\n${reasons}`,
      `🗑️ **${job.owner}/${job.repo}#${job.number}** ${context.title}: dropped, ${gate.reasons[0] ?? "gates refused"}`);
  }

  /**
   * Runs the follow-ups that are due: PRs waiting for CI and jobs waiting on another issue. They live in SQLite,
   * so a restart loses none, and a PR waiting for CI holds no build slot.
   */
  private async runFollowUps(): Promise<void> {
    if (this.shuttingDown) return;
    const { store } = this.deps;
    for (const followUp of store.dueFollowUps(this.now())) {
      if (this.running.has(followUp.jobId) || this.background.has(followUp.jobId)) continue;
      const job = store.get(followUp.jobId);
      if (!job) {
        store.clearFollowUp(followUp.jobId, followUp.kind);
        continue;
      }
      try {
        if (followUp.kind === "ci") await this.ciFollowUp(job, followUp);
        else if (followUp.kind === "blocked") await this.blockedFollowUp(job, followUp);
        else store.clearFollowUp(job.id, followUp.kind);
      } catch (error) {
        await this.followUpFailed(job, followUp, error as Error);
      }
    }
  }

  private async followUpFailed(job: Job, followUp: FollowUp, error: Error): Promise<void> {
    const { store } = this.deps;
    const payload = JSON.parse(followUp.payload) as { errors?: number };
    const errors = (payload.errors ?? 0) + 1;
    console.warn(`[follow-up] ${job.id} ${followUp.kind}: ${error.message}`);
    if (isTransient(error) || errors < FOLLOW_UP_MAX_ERRORS) {
      store.schedule(job.id, followUp.kind, new Date(this.now().getTime() + FOLLOW_UP_RETRY_MS), { ...payload, errors });
      return;
    }
    store.clearFollowUp(job.id, followUp.kind);
    await this.fail(job, new Error(`waiting for ${followUp.kind === "ci" ? "CI" : "the issues it depends on"} kept failing: ${error.message}`));
  }

  /** A PR that passed every other gate, waiting for GitHub CI. When CI settles, the gate runs again and decides. */
  private async ciFollowUp(job: Job, followUp: FollowUp): Promise<void> {
    const { store, github } = this.deps;
    if (job.state !== "awaiting_ci") return store.clearFollowUp(job.id, "ci");
    const context = JSON.parse(followUp.payload) as MergeContext;
    const waited = this.now().getTime() - Date.parse(followUp.createdAt);
    const state = await github.ciState(job.owner, job.repo, context.sha);
    let outcome: string | null = null;
    if (state === "success" || state === "failure") outcome = state;
    // Check suites can take minutes to register; "none" is only final after the grace period.
    else if (state === "none" && waited > CI_GRACE_MS) outcome = "none";
    else if (waited > CI_WAIT_MS) outcome = "still pending after 90 minutes";
    if (!outcome) return store.snooze(job.id, "ci", new Date(this.now().getTime() + CI_POLL_MS));
    // GitHub runs no CI on a PR that conflicts with main (something else merged meanwhile): bring main in and
    // build again, rather than count it as missing CI.
    if (outcome === "none" && await this.conflictsWithMain(job, context)) return;
    store.event(job.id, "ci", outcome, { type: "ci", v: 1, state: outcome, waitedMinutes: Math.round(waited / 60_000) });
    const policy = this.policyOf(job.owner, job.repo, job.kind);
    // The merge and release run beside the cycle, like a build, so a long release doesn't hold up claiming.
    const work = (async () => {
      try {
        // Labels and issue text can change during a long CI run; judge again right before merging.
        const gate = outcome === "success" ? await this.gate(job, policy, context)
          : { merge: false, reasons: [outcome === "none" ? "no GitHub CI reported on the PR" : `GitHub CI is ${outcome}`] };
        await this.conclude(job, policy, context, gate);
        store.clearFollowUp(job.id, "ci");
      } catch (error) {
        if (!this.shuttingDown) await this.followUpFailed(job, followUp, error as Error);
      }
    })().finally(() => this.background.delete(job.id));
    this.background.set(job.id, work);
  }

  /**
   * Whether the PR conflicts with main. If it does and it hasn't been brought up to date too often, the job is
   * queued to revise: the next build merges main in (build()) and the builder resolves the conflicts.
   */
  private async conflictsWithMain(job: Job, context: MergeContext): Promise<boolean> {
    const { store, github } = this.deps;
    const pr = await github.pull(job.owner, job.repo, context.prNumber);
    if (pr.mergeable !== false) return false;
    const rounds = store.events(job.id, 500).filter(e => e.kind === "behind_main").length;
    if (rounds >= MAX_MAIN_ROUNDS) return false;
    store.event(job.id, "behind_main", `round ${rounds + 1}`);
    store.clearFollowUp(job.id, "ci");
    store.update(job.id, { state: "queued", revising: true, attempts: 0 });
    await this.feed(job, { phase: "queued", detail: "Bringing the PR up to date with main" },
      `🔀 ${context.prUrl} conflicts with main (something else merged first), so GitHub won't run CI on it. isobot will merge main in and build it again.`);
    return true;
  }

  /** A claimed job waiting on other issues ("Blocked by #12"). It builds once they are all closed. */
  private async blockedFollowUp(job: Job, followUp: FollowUp): Promise<void> {
    const { store, github } = this.deps;
    if (job.state !== "blocked") return store.clearFollowUp(job.id, "blocked");
    const issue = await github.issue(job.owner, job.repo, job.number);
    if (issue.state === "closed" || hasLabel(issue, this.labels.stop)) {
      store.clearFollowUp(job.id, "blocked");
      return this.stop(job, issue);
    }
    // Read from the issue as it is now, so editing a blocker out of it takes effect.
    const open = await this.openBlockers(issue);
    if (open.length) {
      const before = (JSON.parse(followUp.payload) as { on?: string[] }).on ?? [];
      store.schedule(job.id, "blocked", new Date(this.now().getTime() + BLOCKED_POLL_MS), { on: open });
      if (open.join() !== before.join()) {
        store.event(job.id, "blocked", open.join(", "), { type: "blocked", v: 1, on: open });
        await this.feed(job, { phase: "blocked", detail: `Waiting on ${open.join(", ")}` });
      }
      return;
    }
    store.clearFollowUp(job.id, "blocked");
    store.update(job.id, { state: "queued" });
    await this.feed(job, { phase: "queued" }, "⛓ Everything this depends on is done; building it next.");
  }

  private feed(job: Job, update: CardUpdate, post?: string, headline?: string): Promise<void> {
    return this.deps.notifier.job(job, update, post, headline);
  }

  private noteCount(job: Job, more: number): number {
    return (this.deps.notifier.card(job)?.notes ?? 0) + more;
  }

  /** Discord replies are already in the thread; notes from elsewhere are echoed so the thread is the whole story. */
  private ackNotes(notes: OwnerNote[]): string {
    const echoed = notes.filter(n => n.source !== "discord").map(quoteNote);
    return [...echoed, `💬 Passing ${notes.length === 1 ? "your note" : `${notes.length} notes`} to the builder.`].join("\n\n");
  }

  private async trustedLogins(): Promise<string[]> {
    return [await this.viewerLogin(), ...(this.deps.config.trustedAuthors ?? [])];
  }

  /** Starts listening for owner notes on a newly claimed issue. Comments before the first claim are history. */
  private async listenForNotes(job: Job): Promise<void> {
    const latest = String(maxCommentId(await this.deps.github.issueComments(job.owner, job.repo, job.number)));
    if (this.deps.store.cursor(`notes-since:${job.id}`) === null) this.deps.store.setCursor(`notes-since:${job.id}`, latest);
    this.deps.store.setCursor(`notes-read:${job.id}`, latest);
    this.deps.store.setCursor(`notes-warned:${job.id}`, latest);
  }

  /** The owner's notes on a job since it was first approved (`all`) and those not yet acted on (`fresh`). */
  private async readNotes(job: Job): Promise<{ all: OwnerNote[]; fresh: OwnerNote[]; latest: number }> {
    const { store } = this.deps;
    const comments = await this.deps.github.issueComments(job.owner, job.repo, job.number);
    const latest = maxCommentId(comments);
    const cursor = (name: string) => {
      const key = `notes-${name}:${job.id}`;
      // Jobs from before notes existed start listening now.
      if (store.cursor(key) === null) store.setCursor(key, String(latest));
      return Number(store.cursor(key));
    };
    const trusted = await this.trustedLogins();
    const read = cursor("read");
    const all = ownerNotes(comments, trusted, cursor("since")).notes;
    const untrusted = ownerNotes(comments, trusted, cursor("warned")).relayedByUntrusted;
    if (untrusted.length) {
      store.setCursor(`notes-warned:${job.id}`, String(latest));
      await this.deps.notifier.say(job, `⚠️ A Discord reply reached the issue as @${untrusted[0]}, which isobot doesn't trust, so it was ignored. ` +
        "Give the bridge a GitHub token for your account, or add that account to `trustedAuthors`.");
    }
    return { all, fresh: all.filter(n => n.id > read), latest };
  }

  /** Like readNotes, and marks the fresh notes as acted on. */
  private async takeNotes(job: Job): Promise<{ all: OwnerNote[]; fresh: OwnerNote[] }> {
    const notes = await this.readNotes(job);
    const key = `notes-read:${job.id}`;
    if (notes.latest > Number(this.deps.store.cursor(key))) this.deps.store.setCursor(key, String(notes.latest));
    return notes;
  }

  /** Infrastructure trouble (network, GitHub, model limits) is retried, not blamed on the issue. */
  private async retryLater(job: Job, error: Error): Promise<void> {
    const { store, github } = this.deps;
    const current = store.get(job.id)!;
    if (error instanceof UsageLimitError) {
      const until = Date.now() + (error.retryAfterMs ?? 60 * 60_000);
      if (!store.pausedUntil()) {
        await this.deps.notifier.discord(`⏸ Claude usage limit reached; isobot builds pause until ${new Date(until).toISOString().slice(11, 16)} UTC.`);
      }
      store.pauseBuilds(until, error.message);
      store.requeue(job.id, until - Date.now(), error.message, false);
      await this.feed(job, { phase: "paused", detail: `Builds resume <t:${Math.floor(until / 1000)}:R>` });
      console.warn(`[build] ${job.id}: usage limit; builds paused until ${new Date(until).toISOString()}`);
      return;
    }
    if (current.attempts >= MAX_ATTEMPTS) return this.fail(job, new Error(`still failing after ${MAX_ATTEMPTS} attempts: ${error.message}`));
    const delay = error instanceof Error && "retryAfterMs" in error && typeof error.retryAfterMs === "number"
      ? error.retryAfterMs
      : RETRY_DELAYS_MS[Math.min(current.attempts - 1, RETRY_DELAYS_MS.length - 1)];
    store.requeue(job.id, delay, error.message);
    await this.feed(job, { phase: "retrying", detail: `${error.message.slice(0, 200)}\nNext try <t:${Math.floor((Date.now() + delay) / 1000)}:R>` });
    console.warn(`[build] ${job.id}: transient failure, retrying in ${Math.round(delay / 60_000)} min: ${error.message}`);
    if (current.attempts === 1) {
      await github.comment(job.owner, job.repo, job.number,
        `⏳ isobot hit a temporary problem (${error.message.slice(0, 200)}) and will retry automatically.`).catch(() => undefined);
    }
  }

  /** Follows PRs that wait for a human: merged → release; closed → done; stop label → stopped. */
  async followUp(): Promise<void> {
    const { github, store } = this.deps;
    await this.runFollowUps();
    await this.renewLeases();
    await this.resumeReleases();
    for (const job of store.inState("pr_open")) {
      try {
        if (!job.prNumber) continue;
        const pr: PullRequest = await github.pull(job.owner, job.repo, job.prNumber);
        if (pr.merged && pr.mergeCommitSha) {
          await github.removeLabel(job.owner, job.repo, job.number, this.labels.review);
          const issue = await github.issue(job.owner, job.repo, job.number);
          if (hasLabel(issue, this.labels.stop)) {
            store.update(job.id, { state: "stopped" });
            continue;
          }
          store.finishEffect(mergeKey(job.id, pr.number), job.id, pr.mergeCommitSha);
          store.update(job.id, { state: "merged" });
          await this.feed(job, { phase: "merged" }, `✅ ${pr.url} was merged.`);
          await this.afterMerge(store.get(job.id)!, pr.mergeCommitSha, this.policyOf(job.owner, job.repo, job.kind));
        } else if (pr.state === "closed") {
          store.update(job.id, { state: "closed" });
          await github.removeLabel(job.owner, job.repo, job.number, this.labels.review);
          await this.feed(job, { phase: "closed" }, `⏹ ${pr.url} was closed without merging.`);
        } else if ((await this.readNotes(job)).fresh.length) {
          // The owner asked for changes on the open PR: revise it, continuing the builder's session.
          store.update(job.id, { state: "queued", revising: true, attempts: 0 });
          await this.feed(job, { phase: "queued", detail: "Revising the PR with your note" }, `💬 Got your note; isobot will revise ${pr.url}.`);
        }
      } catch (error) {
        console.warn(`[follow-up] ${job.id}: ${(error as Error).message}`);
      }
    }
    for (const job of store.inState("awaiting_ship")) {
      let issue: Issue;
      try {
        issue = await github.issue(job.owner, job.repo, job.number);
      } catch (error) {
        console.warn(`[ship] ${job.id}: ${(error as Error).message}`);
        continue;
      }
      if (!hasLabel(issue, this.labels.ship) || hasLabel(issue, this.labels.stop)) continue;
      try {
        await github.removeLabel(job.owner, job.repo, job.number, this.labels.ship);
        const pr = await github.pull(job.owner, job.repo, job.prNumber!);
        const policy = this.policyOf(job.owner, job.repo, job.kind);
        await this.feed(job, { phase: "shipping" });
        // Your ship label is the go-ahead, also to run a ship step a restart interrupted again.
        const key = releaseKey(job.id, "ship", pr.mergeCommitSha!);
        store.startEffect(key, job.id);
        const report = await this.release(job, pr.mergeCommitSha!, policy.release.onShip, "ship");
        // Killed by a restart: leave it `started` for resumeReleases() to report.
        if (this.shuttingDown) continue;
        store.finishEffect(key, job.id, { passed: report.passed } satisfies ReleaseResult);
        store.update(job.id, { state: report.passed ? "shipped" : "awaiting_ship", lastError: report.passed ? null : "ship step failed" });
        await github.comment(job.owner, job.repo, job.number, report.passed
          ? `🚀 Ship step finished:\n${formatChecks(report)}`
          : `❌ Ship step failed; fix it and add \`${this.labels.ship}\` again to retry:\n${formatChecks(report)}`);
        await this.feed(job, { phase: report.passed ? "shipped" : "shipFailed" }, `${report.passed ? "🚀 Ship step finished" : "❌ Ship step failed"}:\n${checksSummary(report)}`,
          `${report.passed ? "🚀" : "❌"} **${job.id}** ship step ${report.passed ? "finished" : "failed"}`);
      } catch (error) {
        if (this.shuttingDown) continue;
        await github.comment(job.owner, job.repo, job.number,
          `❌ The ship step couldn't start (${(error as Error).message}). Add \`${this.labels.ship}\` again to retry.`).catch(() => undefined);
        await this.feed(job, { phase: "shipFailed", detail: (error as Error).message.slice(0, 300) });
      }
    }
    await this.answerFinished();
  }

  /**
   * Approves an issue to build again for the owner: a "retry" reply in the job's Discord thread or on the issue,
   * or `runner retry`. It adds the ready label with the runner's own (trusted) token, so the usual claim follows
   * on the next pass, with every note since the first approval going to the builder.
   */
  async rebuild(owner: string, repo: string, number: number): Promise<{ ok: boolean; message: string }> {
    const { github, store } = this.deps;
    const job = store.get(storeId(owner, repo, number));
    if (job && !REBUILDABLE.includes(job.state)) {
      return { ok: false, message: `isobot is already on this (${job.state.replace("_", " ")}${job.prNumber ? `, PR #${job.prNumber}` : ""}), so there's nothing to retry.` };
    }
    const issue = await github.issue(owner, repo, number);
    if (issue.state === "closed") return { ok: false, message: `${issue.url} is closed; reopen it to build it again.` };
    if (hasLabel(issue, this.labels.stop)) return { ok: false, message: `${issue.url} has \`${this.labels.stop}\`; remove it to build it again.` };
    await github.addLabels(owner, repo, number, [this.labels.ready]);
    return { ok: true, message: `🔁 Building ${issue.url} again; isobot picks it up on its next pass.` };
  }

  /**
   * 🧹 from Discord (the cleanup label): drops the issue from isobot. Waits for a running build to
   * stop, then removes the job's local workspaces and refs, strips isobot's labels, and closes the
   * issue as not planned. An open PR is left alone; close it on GitHub if it should go too.
   */
  async cleanUp(): Promise<void> {
    const { github, store } = this.deps;
    for (const { owner, repo } of configuredRepos(this.deps.config)) {
      let issues: Issue[];
      try {
        issues = await github.issuesWithLabel(owner, repo, this.labels.cleanup);
      } catch (error) {
        console.warn(`[cleanup] ${owner}/${repo}: ${(error as Error).message}`);
        continue;
      }
      for (const issue of issues) {
        const id = storeId(owner, repo, issue.number);
        if (this.running.has(id)) continue;
        try {
          // Closing an issue is the owner's call, like approving one.
          const by = await github.labeledBy(owner, repo, issue.number, this.labels.cleanup);
          if (!by || !(await this.isTrusted(by))) {
            await github.removeLabel(owner, repo, issue.number, this.labels.cleanup);
            await github.comment(owner, repo, issue.number, `isobot only cleans up for its owner; \`${this.labels.cleanup}\` was added by @${by ?? "unknown"}.`);
            continue;
          }
          const job = store.get(id);
          if (job && ["queued", "blocked", "building", "awaiting_ci"].includes(job.state)) store.update(id, { state: "stopped" });
          store.clearFollowUp(id);
          const removed = await this.deps.repo(owner, repo).purge(issue.number);
          const ours = [this.labels.proposed, this.labels.ready, this.labels.building, this.labels.review, this.labels.failed, this.labels.ship, this.labels.stop, this.labels.auto];
          for (const label of ours) if (hasLabel(issue, label)) await github.removeLabel(owner, repo, issue.number, label);
          const pr = job?.prNumber && job.state === "pr_open" ? ` PR #${job.prNumber} is still open; close it if it should go too.` : "";
          await github.comment(owner, repo, issue.number,
            `🧹 Dismissed from Discord: isobot closed this and removed ${removed.length ? removed.map(r => `\`${r}\``).join(", ") : "its labels (nothing was left on the runner)"}.${pr}`);
          await github.closeIssue(owner, repo, issue.number, "not_planned");
          // Last, so a failure above is retried on the next pass.
          await github.removeLabel(owner, repo, issue.number, this.labels.cleanup);
          if (job) await this.feed(store.get(id)!, { phase: "cleaned" }, `🧹 Dismissed: closed the issue and cleaned up.${pr}`);
          console.log(`[cleanup] ${id}: ${removed.length} local item(s) removed, issue closed`);
        } catch (error) {
          console.warn(`[cleanup] ${id}: ${(error as Error).message}`);
        }
      }
    }
  }

  /**
   * A reply on a finished job can't change it: "retry" builds it again, anything else gets told what would.
   * Every job that finished in the last 48 hours is covered, however many there are (a release train finishes
   * a batch at once): one repository-wide comment listing per poll finds the issues with new comments, and
   * only those have their notes read.
   */
  private async answerFinished(): Promise<void> {
    const byRepo = new Map<string, Job[]>();
    for (const job of this.deps.store.recentlyFinished(FINISHED_NOTES_HOURS, 1000)) {
      const key = `${job.owner}/${job.repo}`.toLowerCase();
      byRepo.set(key, [...(byRepo.get(key) ?? []), job]);
    }
    for (const [key, jobs] of byRepo) {
      const cursorKey = `finished-notes-since:${key}`;
      const checkedAt = this.now().getTime();
      const since = this.deps.store.cursor(cursorKey) ?? new Date(checkedAt - FINISHED_NOTES_HOURS * 3_600_000).toISOString();
      let commented: Set<number>;
      try {
        commented = await this.deps.github.commentedSince(jobs[0].owner, jobs[0].repo, since);
      } catch (error) {
        console.warn(`[notes] ${key}: ${(error as Error).message}`);
        continue;
      }
      const ok = await this.answerFinishedJobs(jobs.filter(job => commented.has(job.number)));
      // A minute of overlap for clock skew: notes already acted on are skipped by each job's own cursor.
      // When a job failed, the window stays put so its comment is looked at again on the next poll.
      if (ok) this.deps.store.setCursor(cursorKey, new Date(checkedAt - 60_000).toISOString());
    }
  }

  /** answerFinished for the jobs with new comments; false when one of them couldn't be handled. */
  private async answerFinishedJobs(jobs: Job[]): Promise<boolean> {
    let ok = true;
    for (const job of jobs) {
      try {
        const { fresh } = await this.takeNotes(job);
        if (!fresh.length) continue;
        if (fresh.some(note => asksToRetry(note.text))) {
          const { message } = await this.rebuild(job.owner, job.repo, job.number);
          await this.deps.notifier.say(job, message);
          continue;
        }
        if (!this.deps.notifier.threads) continue;
        const again = `reply \`retry\` here (or add \`${this.labels.ready}\` to the issue) to build it again with your notes, or open a new issue`;
        await this.deps.notifier.say(job, job.state === "failed"
          ? `💬 Got your note. This job failed, so nothing is running: ${again}.`
          : `💬 Got your note, but this job is already ${job.state.replace("_", " ")}, so there's no open PR to revise. To change more, ${again}.`);
      } catch (error) {
        ok = false;
        console.warn(`[notes] ${job.id}: ${(error as Error).message}`);
      }
    }
    return ok;
  }

  /** A PR that merged before the build got to it (see build()): record the merge and release as usual. */
  private async adoptMerge(job: Job, pr: PullRequest, policy: RepoPolicy): Promise<void> {
    const { github, store } = this.deps;
    store.finishEffect(mergeKey(job.id, pr.number), job.id, pr.mergeCommitSha);
    await github.removeLabel(job.owner, job.repo, job.number, this.labels.building);
    await github.removeLabel(job.owner, job.repo, job.number, this.labels.review);
    store.update(job.id, { state: "merged" });
    store.event(job.id, "adopted_merge", pr.mergeCommitSha);
    await this.feed(job, { phase: "merged" }, `✅ ${pr.url} is already merged; carrying on from the merge.`);
    await this.afterMerge(store.get(job.id)!, pr.mergeCommitSha!, policy);
  }

  /**
   * Release steps a restart left behind, from the effect ledger. One that never started runs now. One
   * that was running when the runner stopped may have partly happened: it runs again only when the repo
   * marks its onMerge commands `replaySafe`, or when you ask (`runner release`, or the ship label for a
   * ship step); otherwise you're told once. Jobs merged before the ledger existed are left alone.
   */
  private async resumeReleases(): Promise<void> {
    const { store } = this.deps;
    for (const job of store.inState("merged", "awaiting_ship")) {
      if (this.running.has(job.id) || job.prNumber === null) continue;
      const merge = store.effect(mergeKey(job.id, job.prNumber));
      if (merge?.status !== "done" || !merge.result) continue;
      const mergeSha = JSON.parse(merge.result) as string;
      try {
        if (job.state === "awaiting_ship") {
          const ship = store.effect(releaseKey(job.id, "ship", mergeSha));
          if (ship?.status === "started") await this.reportInterrupted(job, ship.key, "ship", mergeSha);
          continue;
        }
        const policy = this.policyOf(job.owner, job.repo, job.kind);
        if (job.state !== "merged" || !policy.release.onMerge.length) continue;
        const release = store.effect(releaseKey(job.id, "merge", mergeSha));
        if (!release || release.status === "started" || release.status === "requested") await this.afterMerge(job, mergeSha, policy);
      } catch (error) {
        console.warn(`[release] ${job.id}: couldn't resume: ${(error as Error).message}`);
      }
    }
  }

  /** You asked to run a merged job's release again (`runner release`); the running runner picks it up. */
  async requestRelease(owner: string, repo: string, number: number): Promise<{ ok: boolean; message: string }> {
    const { store } = this.deps;
    const job = store.get(storeId(owner, repo, number));
    const policy = this.policyOf(owner, repo, job?.kind ?? "issue");
    const merge = job?.prNumber != null ? store.effect(mergeKey(job.id, job.prNumber)) : null;
    if (!job || merge?.status !== "done" || !merge.result) return { ok: false, message: `isobot has no merge on record for ${owner}/${repo}#${number}.` };
    if (!policy.release.onMerge.length) return { ok: false, message: `${owner}/${repo} has no release.onMerge commands.` };
    if (job.state !== "merged") return { ok: false, message: `${job.id} is ${job.state.replace("_", " ")}, so there's no release to run again.` };
    store.requestEffect(releaseKey(job.id, "merge", JSON.parse(merge.result) as string), job.id);
    return { ok: true, message: `📦 Release of ${job.id} requested; the runner runs it on its next pass.` };
  }

  private async reportInterrupted(job: Job, key: string, step: "merge" | "ship", sha: string): Promise<void> {
    const { github, store } = this.deps;
    store.setEffectStatus(key, "interrupted");
    store.update(job.id, { lastError: `${step === "ship" ? "ship step" : "release"} interrupted by a runner restart` });
    const ref = `${job.owner}/${job.repo}#${job.number}`;
    const message = step === "ship"
      ? `⚠️ The ship step for ${sha.slice(0, 12)} was interrupted by a runner restart and may have partly run. isobot never reruns a ship step by itself. Check what it did, then add \`${this.labels.ship}\` again to run it again.`
      : `⚠️ The release of ${sha.slice(0, 12)} was interrupted by a runner restart and may have partly run. isobot doesn't rerun it by itself, because this repository's release commands aren't marked safe to repeat (\`release.replaySafe\`). Check what it did, then run \`npm run runner -- release ${ref}\` to run it again.`;
    await github.comment(job.owner, job.repo, job.number, message);
    await this.feed(job, { phase: step === "ship" ? "shipFailed" : "releaseFailed", detail: "Interrupted by a runner restart" }, message,
      `⚠️ **${job.id}** ${step === "ship" ? "ship step" : "release"} interrupted by a restart`);
  }

  private async afterMerge(job: Job, mergeSha: string, policy: RepoPolicy): Promise<void> {
    const { github, store } = this.deps;
    if (policy.release.onMerge.length) {
      const key = releaseKey(job.id, "merge", mergeSha);
      const prior = store.effect(key);
      if (prior?.status === "done") {
        // Released already (a restart came after it): only a passing release goes on to the ship step.
        if (!prior.result || !(JSON.parse(prior.result) as ReleaseResult).passed) return;
      } else if (prior?.status === "interrupted" || (prior?.status === "started" && !policy.release.replaySafe)) {
        if (prior.status === "started") await this.reportInterrupted(job, key, "merge", mergeSha);
        return;
      } else {
        await this.runRelease(job, key, mergeSha, policy);
        if (store.get(job.id)?.state !== "released") return;
      }
    }
    if (policy.release.onShip.length) {
      store.update(job.id, { state: "awaiting_ship" });
      await github.comment(job.owner, job.repo, job.number,
        `🛳 Ready to ship. Add the \`${this.labels.ship}\` label to run: ${policy.release.onShip.map(c => `\`${c}\``).join(", ")}`);
      await this.feed(job, { phase: "ship" }, `🛳 Ready to ship. Add \`${this.labels.ship}\` to the issue to run: ${policy.release.onShip.map(c => `\`${c}\``).join(", ")}`);
    }
  }

  /** Runs onMerge once, recorded in the ledger before and after. Leaves state `released` when it passed. */
  private async runRelease(job: Job, key: string, mergeSha: string, policy: RepoPolicy): Promise<void> {
    const { github, store } = this.deps;
    let report: CheckReport;
    await this.feed(job, { phase: "releasing" });
    store.startEffect(key, job.id);
    try {
      report = await this.release(job, mergeSha, policy.release.onMerge, "merge");
    } catch (error) {
      report = { configured: true, passed: false, results: [{ command: "prepare release checkout", ok: false, output: (error as Error).message }] };
    }
    // Killed by a restart: it stays `started`, and resumeReleases() decides on the next start.
    if (this.shuttingDown) return;
    store.finishEffect(key, job.id, { passed: report.passed } satisfies ReleaseResult);
    store.update(job.id, { state: report.passed ? "released" : "merged", lastError: report.passed ? null : "release failed" });
    await github.comment(job.owner, job.repo, job.number, `${report.passed ? "📦 Released" : "❌ Release failed"}:\n${formatChecks(report)}`);
    await this.feed(job, { phase: report.passed ? "released" : "releaseFailed" }, `${report.passed ? "📦 Released" : "❌ Release failed"}:\n${checksSummary(report)}`,
      `${report.passed ? "📦" : "❌"} **${job.id}** release ${report.passed ? "finished" : "failed"}`);
  }

  private async release(job: Job, sha: string, commands: string[], label: string): Promise<CheckReport> {
    const repo = this.deps.repo(job.owner, job.repo);
    await repo.sync(await this.deps.github.defaultBranch(job.owner, job.repo));
    const name = `release__${job.number}-${label}`;
    const dir = await repo.checkoutAt(sha, name);
    try {
      return await this.deps.checks(dir, commands, { timeoutMs: 90 * 60_000, sandbox: false });
    } finally {
      await repo.removeWorkspace(name).catch(() => undefined);
    }
  }

  /**
   * Publishes the builder's captures to the isobot/media branch for the PR body. Never fails the job:
   * a capture problem only costs the pictures.
   */
  private async publishMedia(job: Job, repo: RepoOps, dir: string, sha: string): Promise<{ files: MediaFile[]; markdown: string; notes: string[] }> {
    const { files, skipped } = collectMedia(dir);
    if (files.length === 0) return { files, markdown: "", notes: skipped };
    try {
      const prefix = `${job.number}/${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}-${sha.slice(0, 8)}`;
      const urls = await repo.publishMedia(prefix, files, `Media for #${job.number} at ${sha.slice(0, 8)}`);
      return { files, markdown: mediaMarkdown(files, urls), notes: skipped };
    } catch (error) {
      console.warn(`[media] ${job.id}: publishing failed: ${(error as Error).message}`);
      return { files, markdown: "", notes: [...skipped, `couldn't publish to GitHub: ${(error as Error).message.slice(0, 200)}`] };
    }
  }

  private async stop(job: Job, issue: Issue): Promise<void> {
    this.deps.store.update(job.id, { state: "stopped" });
    await this.deps.github.removeLabel(job.owner, job.repo, job.number, this.labels.building);
    if (issue.state === "open") await this.deps.github.comment(job.owner, job.repo, job.number, "⏹ isobot stopped working on this issue.");
    await this.feed(job, { phase: "stopped" }, "⏹ Stopped.");
  }

  private async fail(job: Job, error: Error, notify = true): Promise<void> {
    if (this.shuttingDown) return;
    const message = error.message.slice(0, 6000);
    console.error(`[build] ${job.id} failed: ${message}`);
    this.deps.store.update(job.id, { state: "failed", lastError: message });
    try {
      await this.deps.github.removeLabel(job.owner, job.repo, job.number, this.labels.building);
      await this.deps.github.addLabels(job.owner, job.repo, job.number, [this.labels.failed]);
      await this.deps.github.comment(job.owner, job.repo, job.number,
        `⚠️ isobot couldn't finish this: ${message}\n\nEdit the issue or comment to clarify, then comment \`retry\` (or add \`${this.labels.ready}\`) to try again.`);
    } catch (githubError) {
      console.error(`[build] ${job.id}: could not report failure: ${(githubError as Error).message}`);
    }
    await this.feed(job, { phase: "failed", detail: message.split("\n")[0].slice(0, 300) },
      `⚠️ isobot couldn't finish this:\n${message.slice(0, 1500)}\n\nReply \`retry\` here to try again. Anything else you say first (or in the same reply, e.g. \`retry, and use the system font\`) goes to the builder.`,
      notify ? `⚠️ **${job.id}** failed: ${message.slice(0, 300)}` : undefined);
  }
}

export function buildTask(issue: Pick<Issue, "title" | "url" | "body">, policy: RepoPolicy): string {
  const body = issue.body
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/^@codex implement this\s*$/gim, "")
    .replace(/^<sub>Proposed by isobot triage[\s\S]*?<\/sub>\s*$/gim, "")
    .trim();
  return [
    `# ${issue.title}`,
    `GitHub issue: ${issue.url}`,
    body || "(no description)",
    ...(policy.notes ? ["## Repository notes from the owner", policy.notes] : []),
  ].join("\n\n");
}

function prBody(input: { issue: Issue; run: string; rounds?: { label: string; summary: string }[]; checks: CheckReport; review: Review; diff: DiffStat; media?: string }): string {
  const { issue, run, checks, review, diff } = input;
  const rounds = (input.rounds ?? []).filter(r => r.summary.trim());
  return [
    `Closes #${issue.number}`,
    "## Summary",
    run || "(builder gave no summary)",
    ...(rounds.length ? [`<details><summary>Later rounds (${rounds.length})</summary>\n\n${rounds.map(r => `**${r.label}:** ${r.summary}`).join("\n\n")}\n\n</details>`] : []),
    ...(input.media ? ["## Screenshots", input.media] : []),
    "## Runner checks",
    formatChecks(checks),
    "## Independent review",
    `**${review.verdict}** · confidence ${review.confidence.toFixed(2)} · risk ${review.risk}\n\n${review.summary}${review.concerns.length ? `\n\n${review.concerns.map(c => `- ${c}`).join("\n")}` : ""}${needsYou(review)}`,
    `<sub>${diff.files.length} files · ${diff.changedLines} lines changed · built by isobot</sub>`,
  ].join("\n\n");
}

/** The doubts only the owner can settle, as a section for a PR body or hand-off comment ("" when there are none). */
function needsYou(review: Review): string {
  const blockers = review.blockers ?? [];
  return blockers.length ? `\n\n**Needs you** (code can't settle these):\n${blockers.map(b => `- ${b}`).join("\n")}` : "";
}

function conflictFeedback(conflicts: string[], base: string): string {
  return [
    `Other changes merged into ${base} since this branch was built, and merging ${base} in conflicts in:`,
    conflicts.slice(0, 30).map(f => `- ${f}`).join("\n"),
    "The merge is in progress in your workspace. Resolve every conflict keeping both sides: the other pages, links and " +
      `entries from ${base} stay, and this branch's additions go on top. Where a file is generated by the site's build ` +
      "(a sitemap, an index, a rendered page), resolve its source and rebuild it instead of hand-merging the output. " +
      "Leave no conflict markers, rerun the checks, and commit.",
  ].join("\n\n");
}

function pathFeedback(stray: { protected: string[]; outside: string[] }, allowed: string[]): string {
  const list = (files: string[]) => files.slice(0, 20).map(f => `- ${f}`).join("\n");
  return [
    "This content can't publish: it changes files the content train may not touch.",
    ...(stray.protected.length ? [`Protected (CI, headers, workers, manifests, agent config):\n${list(stray.protected)}`] : []),
    ...(stray.outside.length ? [`Outside the site's content paths:\n${list(stray.outside)}`] : []),
    `Content may only change:\n${allowed.map(g => `- ${g}`).join("\n")}`,
    "Put each of these files back as it was before your first commit on this branch (or delete it if you added it), " +
      "then make the content work without them: drop the part that needed them, or do it within the allowed files. " +
      "If a file is regenerated by the site's build, change the source so the build no longer touches it. Rebuild, rerun the checks and commit.",
  ].join("\n\n");
}

function reviewFeedback(review: Review, shortfalls: string[]): string {
  const concerns = review.concerns.map(c => `- ${c}`).join("\n");
  const blockers = (review.blockers ?? []).map(b => `- ${b}`).join("\n");
  const head = review.verdict === "request_changes"
    ? [`An independent reviewer requested changes (confidence ${review.confidence.toFixed(2)}, risk ${review.risk}):`, review.summary]
    : [`An independent reviewer approved, but the change can't merge yet: ${shortfalls.join("; ")}.`, `Reviewer's summary:\n\n${review.summary}`];
  return [
    ...head,
    concerns ? `Concerns to resolve:\n\n${concerns}` : "They listed no specific concerns; re-check correctness and edge cases, and add tests that prove the behaviour.",
    ...(blockers ? [`These go to the owner; don't try to resolve them in code:\n\n${blockers}`] : []),
    "Resolve the concerns with real fixes or tests, in the simplest way that works: a smaller change is easier to trust than more machinery. " +
      "If a concern can't be resolved in code, say so in your summary instead of working around it. " +
      "Stay within the task: don't add unrelated changes, and never weaken or skip tests.",
  ].join("\n\n");
}

/** The marker in a claim comment saying which runner holds the issue, and until when (renewed while it works). */
export function leaseMarker(runner: string, until: Date): string {
  return `<!-- isobot:lease runner=${runner} until=${until.toISOString()} -->`;
}

/** Unexpired leases in the issue's comments. Only the runner's own account can write one that counts. */
export function liveLeases(comments: IssueComment[], viewer: string, now: Date): { id: number; runner: string; until: string }[] {
  const leases: { id: number; runner: string; until: string }[] = [];
  for (const comment of comments) {
    if (comment.author.toLowerCase() !== viewer.toLowerCase()) continue;
    const match = /<!-- isobot:lease runner=([\w.-]+) until=([\dT:.\-Z]+) -->/.exec(comment.body);
    if (match && Date.parse(match[2]) > now.getTime()) leases.push({ id: comment.id, runner: match[1], until: match[2] });
  }
  return leases;
}

/**
 * Issues a body says it waits on: lines starting "Blocked by", "Depends on" or "Waits on", naming `#12`,
 * `owner/repo#12` or an issue URL. Lowercased, deduplicated, in order.
 */
export function parseBlockers(body: string, owner: string, repo: string): { owner: string; repo: string; number: number }[] {
  const found = new Map<string, { owner: string; repo: string; number: number }>();
  const text = body.replace(/<!--[\s\S]*?-->/g, "");
  for (const line of text.split("\n")) {
    const match = /^\s*(?:[-*]\s*)?(?:\*\*)?(?:blocked by|depends on|waits on)(?:\*\*)?\s*:?\s*(.+)$/i.exec(line);
    if (!match) continue;
    const refs = /(?:https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(?:issues|pull)\/(\d+))|(?:([\w.-]+)\/([\w.-]+))?#(\d+)/g;
    for (const ref of match[1].matchAll(refs)) {
      const item = ref[3]
        ? { owner: ref[1].toLowerCase(), repo: ref[2].toLowerCase(), number: Number(ref[3]) }
        : { owner: (ref[4] ?? owner).toLowerCase(), repo: (ref[5] ?? repo).toLowerCase(), number: Number(ref[6]) };
      found.set(`${item.owner}/${item.repo}#${item.number}`, item);
    }
  }
  return [...found.values()];
}

function hasLabel(issue: Pick<Issue, "labels">, label: string): boolean {
  return issue.labels.some(l => l.toLowerCase() === label.toLowerCase());
}

function storeId(owner: string, repo: string, number: number): string {
  return `${owner}/${repo}#${number}`.toLowerCase();
}

export function slug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40).replace(/-$/, "") || "change";
}

function quote(text: string, lines = 40): string {
  return text.split("\n").slice(0, lines).map(line => `> ${line}`).join("\n");
}

function checksSummary(report: CheckReport): string {
  return report.results.map(r => `${r.ok ? "✅" : "❌"} \`${r.command}\``).join("\n") || "(no commands)";
}

function checksLine(report: CheckReport): string {
  if (!report.configured) return "🧪 No runner checks are configured for this repository.";
  return `🧪 Checks ${report.passed ? "passed" : "failed"}:\n${checksSummary(report)}`;
}

function reviewLine(review: Review): string {
  const concerns = review.concerns.slice(0, 5).map(c => `- ${c}`).join("\n");
  const blockers = (review.blockers ?? []).slice(0, 3).map(b => `- 🙋 ${b}`).join("\n");
  return `🔍 Review: **${review.verdict === "approve" ? "approved" : "changes requested"}** · confidence ${review.confidence.toFixed(2)} · risk ${review.risk}\n${quote(review.summary, 10)}${concerns ? `\n${concerns}` : ""}${blockers ? `\n${blockers}` : ""}`;
}
