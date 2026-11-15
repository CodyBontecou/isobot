import { createHash } from "node:crypto";
import type { AgentRun, Builder, Review } from "./builder.js";
import { isTransient, UsageLimitError } from "./errors.js";
import { failureFeedback, formatChecks } from "./checks.js";
import { configuredRepos, policyFor, type Environment, type RepoPolicy, type RunnerConfig } from "./config.js";
import type { DiffStat } from "./git.js";
import type { CiState, GitHubApi, Issue, IssueComment, PullRequest } from "./github.js";
import { maxCommentId, noteFeedback, ownerNotes, quoteNote, withNotes, type OwnerNote } from "./notes.js";
import type { CardUpdate, Notifier } from "./notify.js";
import { evaluateGate, matchesGlob, type CheckReport, type GateDecision } from "./policy.js";
import type { Job, Store } from "./store.js";

/** The git operations the pipeline needs; `Repo` implements it, tests fake it. */
export interface RepoOps {
  sync(defaultBranch: string): Promise<string>;
  createWorkspace(branch: string, baseSha: string): Promise<string>;
  removeWorkspace(name: string): Promise<void>;
  commitPending(dir: string, message: string): Promise<void>;
  capture(dir: string, branch: string): Promise<string>;
  ahead(baseSha: string, sha: string): Promise<number>;
  diffStat(baseSha: string, sha: string): Promise<DiffStat>;
  diff(baseSha: string, sha: string): Promise<string>;
  push(sha: string, branch: string): Promise<void>;
  checkoutAt(sha: string, name: string): Promise<string>;
  fetchBranch(branch: string): Promise<string>;
  mergeBase(a: string, b: string): Promise<string>;
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
  checks(cwd: string, commands: string[], options: { timeoutMs?: number; sandbox: boolean }): Promise<CheckReport>;
  sleep?: (ms: number) => Promise<void>;
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
const CI_WAIT_MS = 45 * 60_000;
/** How long a new PR may go without any CI reporting before "no CI" is final. */
const CI_GRACE_MS = 5 * 60_000;
export const PROPOSAL_MARKER = "<!-- isobot:triage:";

/** What the builder is asked to do, where it came from, and a fingerprint to detect edits. */
export interface TaskSource {
  task: string;
  trusted: boolean;
  author: string;
  fingerprint: string;
}

export class Pipeline {
  private running = new Set<string>();
  /** Set on SIGTERM/SIGINT: builds dying because their processes were killed are interruptions, not failures. */
  private shuttingDown = false;
  private viewer?: string;

  constructor(private deps: PipelineDeps) {}

  /** Call before killing child processes. Running jobs stay "building", and recover() re-queues them on the next start. */
  beginShutdown(): void {
    this.shuttingDown = true;
  }

  private get labels() { return this.deps.config.labels; }

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
          if (hasLabel(issue, this.labels.stop)) continue;
          // Approval is the trust boundary: only you (or trustedAuthors) may start a build.
          const approver = await github.labeledBy(owner, repo, issue.number, this.labels.ready);
          if (!approver || !(await this.isTrusted(approver))) {
            await github.removeLabel(owner, repo, issue.number, this.labels.ready);
            await github.comment(owner, repo, issue.number, `isobot only builds issues approved by its owner; \`${this.labels.ready}\` was added by @${approver ?? "unknown"}.`);
            continue;
          }
          const job = store.enqueue(owner, repo, issue.number, issue.title);
          await github.removeLabel(owner, repo, issue.number, this.labels.ready);
          if (!job) {
            const existing = store.get(storeId(owner, repo, issue.number));
            await github.comment(owner, repo, issue.number, `isobot is already on this (${existing?.state.replace("_", " ") ?? "in progress"}${existing?.prNumber ? `, PR #${existing.prNumber}` : ""}).`);
            continue;
          }
          await github.removeLabel(owner, repo, issue.number, this.labels.failed);
          await github.addLabels(owner, repo, issue.number, [this.labels.building]);
          await github.comment(owner, repo, issue.number,
            `🤖 isobot picked this up and is building it now. Add the \`${this.labels.stop}\` label at any time to stop.`);
          await this.listenForNotes(job);
          const { release } = policyFor(this.deps.config, `${owner}/${repo}`);
          await this.feed(job, {
            phase: "queued", title: issue.title,
            extraSteps: [...(release.onMerge.length ? ["Release" as const] : []), ...(release.onShip.length ? ["Ship" as const] : [])],
          });
          claimed.push(job);
        } catch (error) {
          console.warn(`[discover] ${owner}/${repo}#${issue.number}: ${(error as Error).message}`);
        }
      }
    }
    return claimed;
  }

  /** Starts queued jobs up to the concurrency limit. Returns the promises for the jobs it started. */
  startQueued(): Promise<void>[] {
    const started: Promise<void>[] = [];
    if (this.deps.store.pausedUntil()) return started;
    for (const job of this.deps.store.runnable()) {
      if (this.running.size >= this.deps.config.maxConcurrentJobs) break;
      if (this.running.has(job.id)) continue;
      this.running.add(job.id);
      started.push(this.build(job).finally(() => this.running.delete(job.id)));
    }
    return started;
  }

  get activeJobs(): string[] {
    return [...this.running];
  }

  /** After a restart, interrupted builds start again from a clean workspace. */
  recover(): void {
    for (const job of this.deps.store.inState("building")) this.deps.store.update(job.id, { state: "queued" });
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
    const policy = policyFor(this.deps.config, `${issue.owner}/${issue.repo}`);
    const task = buildTask(proposal ? { ...issue, body: proposal.body } : issue, policy);
    const fingerprint = createHash("sha256").update(`${issue.title}\n${issue.body}\n${proposal?.body ?? ""}`).digest("hex");
    return { task, trusted: await this.isTrusted(issue.author), author: issue.author, fingerprint };
  }

  private async viewerLogin(): Promise<string> {
    this.viewer ??= await this.deps.github.viewer();
    return this.viewer;
  }

  async build(job: Job): Promise<void> {
    const { github, store, builder } = this.deps;
    const policy = policyFor(this.deps.config, `${job.owner}/${job.repo}`);
    const repo = this.deps.repo(job.owner, job.repo);
    const attempts = job.attempts + 1;
    if (attempts > MAX_ATTEMPTS) return this.fail(job, new Error(`gave up after ${MAX_ATTEMPTS} interrupted attempts`));
    // A revision continues the open PR's branch and builder session instead of starting over.
    const revising = job.revising && job.prNumber !== null && job.branch !== null;
    const branch = revising ? job.branch! : `isobot/${job.number}-${slug(job.title)}`;
    job = store.update(job.id, { state: "building", attempts, branch });
    let workspace: string | null = null;
    try {
      const issue = await github.issue(job.owner, job.repo, job.number);
      if (issue.state === "closed" || hasLabel(issue, this.labels.stop)) return this.stop(job, issue);
      const source = await this.taskFor(issue);
      const base = await github.defaultBranch(job.owner, job.repo);
      const mainSha = await repo.sync(base);
      const notes = await this.takeNotes(job);
      // Everything the owner said since approving goes into the task, so the reviewer judges against it too.
      let task = withNotes(source.task, notes.all);
      let run: AgentRun;
      let baseSha: string;
      let noteRounds = 0;
      const sessionId = () => run?.sessionId ?? store.get(job.id)?.sessionId ?? null;
      if (revising) {
        const head = await repo.fetchBranch(branch);
        baseSha = await repo.mergeBase(mainSha, head);
        workspace = await repo.createWorkspace(branch, head);
        await github.removeLabel(job.owner, job.repo, job.number, this.labels.review);
        await github.addLabels(job.owner, job.repo, job.number, [this.labels.building]);
        await github.comment(job.owner, job.repo, job.number, `🔁 isobot is revising PR #${job.prNumber} with your note. Add \`${this.labels.stop}\` to stop.`);
        await this.feed(job, { phase: "revising", notes: this.noteCount(job, notes.fresh.length) }, this.ackNotes(notes.fresh));
        noteRounds++;
        run = await builder.revise({
          cwd: workspace, sessionId: job.sessionId, task,
          feedback: notes.fresh.length ? noteFeedback(notes.fresh) : "Re-read the task and the owner's follow-up notes, and make sure this branch satisfies all of them.",
        });
        store.update(job.id, { sessionId: run.sessionId ?? job.sessionId });
        store.event(job.id, "revised", run.summary);
      } else {
        baseSha = mainSha;
        workspace = await repo.createWorkspace(branch, baseSha);
        await this.feed(job, { phase: "implementing" });
        run = await builder.implement({ cwd: workspace, task });
        store.update(job.id, { sessionId: run.sessionId });
        store.event(job.id, "implemented", run.summary);
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
        const report = await this.checks(workspace!, policy.checks);
        await this.deps.notifier.say(job, checksLine(report));
        return report;
      };

      let checks = await runChecks(run.summary);
      let review: Review | undefined;
      let fixRounds = 0;
      let reviewRounds = 0;
      for (;;) {
        // The owner spoke up (Discord thread, issue comment, `runner say`): their note comes first.
        if (noteRounds < MAX_NOTE_ROUNDS) {
          const late = await this.takeNotes(job);
          if (late.fresh.length) {
            noteRounds++;
            task = withNotes(source.task, late.all);
            await this.feed(job, { phase: "revising", notes: this.noteCount(job, late.fresh.length) }, this.ackNotes(late.fresh));
            run = await builder.revise({ cwd: workspace, sessionId: sessionId(), task, feedback: noteFeedback(late.fresh) });
            sha = await commit(`Apply owner feedback for #${issue.number}`);
            checks = await runChecks(run.summary);
            continue;
          }
        }
        if (!checks.passed && fixRounds < this.deps.config.builder.maxFixRounds) {
          fixRounds++;
          await this.feed(job, { phase: "fixing", fixRounds });
          run = await builder.revise({ cwd: workspace, sessionId: sessionId(), task, feedback: failureFeedback(checks) });
          sha = await commit(`Fix checks for #${issue.number}`);
          checks = await runChecks(run.summary);
          continue;
        }
        // The reviewer sees exactly the commit the runner captured, diffed in the runner's own clone.
        await this.feed(job, { phase: "reviewing" });
        review = await builder.review({ cwd: workspace, task, diff: await repo.diff(baseSha, sha), checks: formatChecks(checks) });
        store.event(job.id, "review", `${review.verdict} ${review.confidence} ${review.risk}: ${review.summary}`);
        await this.deps.notifier.say(job, reviewLine(review));
        if (review.verdict === "request_changes" && reviewRounds < this.deps.config.builder.maxReviewRounds) {
          reviewRounds++;
          await this.feed(job, { phase: "addressing", reviewRounds });
          run = await builder.revise({ cwd: workspace, sessionId: run.sessionId, task, feedback: reviewFeedback(review) });
          sha = await commit(`Address review for #${issue.number}`);
          checks = await runChecks(run.summary);
          continue;
        }
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
      const body = prBody({ issue, run: run.summary, checks, review, diff });
      const existing = await github.findPull(job.owner, job.repo, branch);
      const pr = existing && existing.state === "open"
        ? (await github.updatePull(job.owner, job.repo, existing.number, body), existing)
        : await github.createPull(job.owner, job.repo, { head: branch, base, title: issue.title, body });
      store.update(job.id, { prNumber: pr.number });
      await this.feed(job, { prUrl: pr.url }, `📤 ${pr === existing ? "Updated" : "Opened"} ${pr.url} (${diff.files.length} files, ${diff.changedLines} lines)`);

      const gateNow = async (): Promise<GateDecision> => {
        const current = await github.issue(job.owner, job.repo, job.number);
        const owner = await this.ownerOriginated(current);
        const effective = owner ? { ...policy, autonomy: policy.ownerAutonomy ?? policy.autonomy } : policy;
        const decision = evaluateGate({ policy: effective, diff, checks, review: review!, issueLabels: current.labels, stopLabel: this.labels.stop });
        if (!owner && policy.autonomy !== "merge" && policy.ownerAutonomy === "merge") {
          decision.reasons.push(`it isn't marked as yours; when you add \`${this.labels.auto}\` yourself, isobot merges once every gate passes`);
        }
        if (!source.trusted) decision.reasons.push(`the issue was written by @${source.author}, who isn't trusted to merge without you`);
        if ((await this.taskFor(current)).fingerprint !== source.fingerprint) decision.reasons.push("the issue text changed while isobot was building");
        if (current.state === "closed") decision.reasons.push("the issue was closed");
        if ((await this.readNotes(job)).fresh.length) decision.reasons.push("you sent a note isobot hasn't applied yet; it will revise the PR with it next");
        return { merge: decision.reasons.length === 0, reasons: decision.reasons };
      };
      let gate = await gateNow();
      if (gate.merge && policy.requireCi) {
        await this.feed(job, { phase: "ci" });
        const ci = await this.waitForCi(job, sha);
        // Labels and issue text can change during a long CI run; judge again right before merging.
        gate = ci === "success" ? await gateNow() : { merge: false, reasons: [ci === "none" ? "no GitHub CI reported on the PR" : `GitHub CI is ${ci}`] };
      }
      await github.removeLabel(job.owner, job.repo, job.number, this.labels.building);

      if (!gate.merge) {
        await github.addLabels(job.owner, job.repo, job.number, [this.labels.review]);
        store.update(job.id, { state: "pr_open" });
        const reasons = gate.reasons.map(r => `- ${r}`).join("\n");
        await github.comment(job.owner, job.repo, job.number, `🔍 isobot opened ${pr.url} and is leaving the merge to you:\n${reasons}`);
        await this.feed(job, { phase: "waiting", detail: reasons },
          `🔍 Leaving the merge to you:\n${reasons}\n\nReply here to ask for changes; isobot will revise the PR.`,
          `🔍 **${job.owner}/${job.repo}#${job.number}** ${issue.title}: PR ready for your review: <${pr.url}>`);
        return;
      }

      let mergeSha: string;
      try {
        // `sha` pins the merge to the reviewed commit; GitHub refuses if the branch moved.
        mergeSha = await github.merge(job.owner, job.repo, pr.number, sha, `${issue.title} (#${pr.number})`);
      } catch (error) {
        // Usually a conflict with a newer main: the PR is still good, so hand it to the owner.
        await github.addLabels(job.owner, job.repo, job.number, [this.labels.review]);
        store.update(job.id, { state: "pr_open", lastError: (error as Error).message });
        await github.comment(job.owner, job.repo, job.number, `🔍 Every gate passed but GitHub refused the merge (${(error as Error).message}). ${pr.url} is ready for you.`);
        await this.feed(job, { phase: "waiting", detail: "Every gate passed, but GitHub refused the merge" }, `🔍 GitHub refused the merge: ${(error as Error).message.slice(0, 300)}`);
        return;
      }
      store.update(job.id, { state: "merged" });
      await github.comment(job.owner, job.repo, job.number, `✅ isobot merged ${pr.url} after checks, review (confidence ${review.confidence.toFixed(2)}) and policy gates passed.`);
      await this.feed(job, { phase: "merged" }, `✅ Merged ${pr.url}`, `✅ **${job.owner}/${job.repo}#${job.number}** ${issue.title}: merged <${pr.url}>`);
      await this.afterMerge(store.get(job.id)!, mergeSha, policy);
    } catch (error) {
      if (this.shuttingDown) return;
      if (isTransient(error)) await this.retryLater(job, error as Error);
      else await this.fail(job, error as Error);
    } finally {
      if (workspace) await repo.removeWorkspace(branch).catch(() => undefined);
    }
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
          store.update(job.id, { state: "merged" });
          await this.feed(job, { phase: "merged" }, `✅ ${pr.url} was merged.`);
          await this.afterMerge(store.get(job.id)!, pr.mergeCommitSha, policyFor(this.deps.config, `${job.owner}/${job.repo}`));
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
        const policy = policyFor(this.deps.config, `${job.owner}/${job.repo}`);
        await this.feed(job, { phase: "shipping" });
        const report = await this.release(job, pr.mergeCommitSha!, policy.release.onShip, "ship");
        store.update(job.id, { state: report.passed ? "shipped" : "awaiting_ship", lastError: report.passed ? null : "ship step failed" });
        await github.comment(job.owner, job.repo, job.number, report.passed
          ? `🚀 Ship step finished:\n${formatChecks(report)}`
          : `❌ Ship step failed; fix it and add \`${this.labels.ship}\` again to retry:\n${formatChecks(report)}`);
        await this.feed(job, { phase: report.passed ? "shipped" : "shipFailed" }, `${report.passed ? "🚀 Ship step finished" : "❌ Ship step failed"}:\n${checksSummary(report)}`,
          `${report.passed ? "🚀" : "❌"} **${job.id}** ship step ${report.passed ? "finished" : "failed"}`);
      } catch (error) {
        await github.comment(job.owner, job.repo, job.number,
          `❌ The ship step couldn't start (${(error as Error).message}). Add \`${this.labels.ship}\` again to retry.`).catch(() => undefined);
        await this.feed(job, { phase: "shipFailed", detail: (error as Error).message.slice(0, 300) });
      }
    }
    if (this.deps.notifier.threads) await this.answerFinished();
  }

  /** A reply in the thread of a finished job can't change it; say what would. */
  private async answerFinished(): Promise<void> {
    for (const job of this.deps.store.recentlyFinished(48)) {
      try {
        if (!(await this.takeNotes(job)).fresh.length) continue;
        const again = `add \`${this.labels.ready}\` to the issue to build it again (your notes go to the builder), or open a new issue`;
        await this.deps.notifier.say(job, job.state === "failed"
          ? `💬 Got your note. This job failed, so nothing is running: ${again}.`
          : `💬 Got your note, but this job is already ${job.state.replace("_", " ")}, so there's no open PR to revise. To change more, ${again}.`);
      } catch (error) {
        console.warn(`[notes] ${job.id}: ${(error as Error).message}`);
      }
    }
  }

  private async afterMerge(job: Job, mergeSha: string, policy: RepoPolicy): Promise<void> {
    const { github, store } = this.deps;
    if (policy.release.onMerge.length) {
      let report: CheckReport;
      await this.feed(job, { phase: "releasing" });
      try {
        report = await this.release(job, mergeSha, policy.release.onMerge, "merge");
      } catch (error) {
        report = { configured: true, passed: false, results: [{ command: "prepare release checkout", ok: false, output: (error as Error).message }] };
      }
      store.update(job.id, { state: report.passed ? "released" : "merged", lastError: report.passed ? null : "release failed" });
      await github.comment(job.owner, job.repo, job.number, `${report.passed ? "📦 Released" : "❌ Release failed"}:\n${formatChecks(report)}`);
      await this.feed(job, { phase: report.passed ? "released" : "releaseFailed" }, `${report.passed ? "📦 Released" : "❌ Release failed"}:\n${checksSummary(report)}`,
        `${report.passed ? "📦" : "❌"} **${job.id}** release ${report.passed ? "finished" : "failed"}`);
      if (!report.passed) return;
    }
    if (policy.release.onShip.length) {
      store.update(job.id, { state: "awaiting_ship" });
      await github.comment(job.owner, job.repo, job.number,
        `🛳 Ready to ship. Add the \`${this.labels.ship}\` label to run: ${policy.release.onShip.map(c => `\`${c}\``).join(", ")}`);
      await this.feed(job, { phase: "ship" }, `🛳 Ready to ship. Add \`${this.labels.ship}\` to the issue to run: ${policy.release.onShip.map(c => `\`${c}\``).join(", ")}`);
    }
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

  private async waitForCi(job: Job, sha: string): Promise<CiState | "still pending after 45 minutes"> {
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise(resolve => setTimeout(resolve, ms)));
    const started = Date.now();
    for (;;) {
      await sleep(30_000);
      const state = await this.deps.github.ciState(job.owner, job.repo, sha);
      if (state === "success" || state === "failure") return state;
      // Check suites can take minutes to register; "none" is only final after the grace period.
      if (state === "none" && Date.now() - started > CI_GRACE_MS) return "none";
      if (Date.now() - started > CI_WAIT_MS) return "still pending after 45 minutes";
    }
  }

  /** Checks run builder-written code, so always sandboxed. */
  private checks(cwd: string, commands: string[]): Promise<CheckReport> {
    return this.deps.checks(cwd, commands, { sandbox: true });
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
        `⚠️ isobot couldn't finish this: ${message}\n\nEdit the issue to clarify, then add \`${this.labels.ready}\` to try again.`);
    } catch (githubError) {
      console.error(`[build] ${job.id}: could not report failure: ${(githubError as Error).message}`);
    }
    await this.feed(job, { phase: "failed", detail: message.split("\n")[0].slice(0, 300) },
      `⚠️ isobot couldn't finish this:\n${message.slice(0, 1500)}\n\nEdit the issue to clarify (or reply here), then add \`${this.labels.ready}\` to try again.`,
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

function prBody(input: { issue: Issue; run: string; checks: CheckReport; review: Review; diff: DiffStat }): string {
  const { issue, run, checks, review, diff } = input;
  return [
    `Closes #${issue.number}`,
    "## Summary",
    run || "(builder gave no summary)",
    "## Runner checks",
    formatChecks(checks),
    "## Independent review",
    `**${review.verdict}** · confidence ${review.confidence.toFixed(2)} · risk ${review.risk}\n\n${review.summary}${review.concerns.length ? `\n\n${review.concerns.map(c => `- ${c}`).join("\n")}` : ""}`,
    `<sub>${diff.files.length} files · ${diff.changedLines} lines changed · built by isobot</sub>`,
  ].join("\n\n");
}

function reviewFeedback(review: Review): string {
  return `An independent reviewer requested changes (confidence ${review.confidence.toFixed(2)}, risk ${review.risk}):\n\n${review.summary}\n\n${review.concerns.map(c => `- ${c}`).join("\n")}`;
}

function hasLabel(issue: Issue, label: string): boolean {
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
  return `🔍 Review: **${review.verdict === "approve" ? "approved" : "changes requested"}** · confidence ${review.confidence.toFixed(2)} · risk ${review.risk}\n${quote(review.summary, 10)}${concerns ? `\n${concerns}` : ""}`;
}
