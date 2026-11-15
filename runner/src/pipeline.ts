import { createHash } from "node:crypto";
import type { Builder, Review } from "./builder.js";
import { failureFeedback, formatChecks, runChecks } from "./checks.js";
import { configuredRepos, policyFor, type Environment, type RepoPolicy, type RunnerConfig } from "./config.js";
import type { DiffStat } from "./git.js";
import type { CiState, GitHubApi, Issue, IssueComment, PullRequest } from "./github.js";
import type { Notifier } from "./notify.js";
import { evaluateGate, type CheckReport, type GateDecision } from "./policy.js";
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
}

export interface PipelineDeps {
  config: RunnerConfig;
  env: Pick<Environment, "home">;
  store: Store;
  github: GitHubApi;
  builder: Builder;
  notifier: Notifier;
  repo(owner: string, repo: string): RepoOps;
  /** Overridable for tests. */
  checks?: (cwd: string, commands: string[], timeoutMs?: number) => Promise<CheckReport>;
  sleep?: (ms: number) => Promise<void>;
}

const MAX_ATTEMPTS = 3;
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
  private viewer?: string;

  constructor(private deps: PipelineDeps) {}

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
    for (const job of this.deps.store.inState("queued")) {
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

  /** Builds the task text from the issue, preferring isobot's own vetted proposal over a reporter's raw text. */
  async taskFor(issue: Issue): Promise<TaskSource> {
    const viewer = await this.viewerLogin();
    const trustedAuthors = new Set([viewer, ...(this.deps.config.trustedAuthors ?? [])].map(a => a.toLowerCase()));
    const comments: IssueComment[] = await this.deps.github.issueComments(issue.owner, issue.repo, issue.number);
    const proposal = comments.filter(c => c.author.toLowerCase() === viewer.toLowerCase() && c.body.includes(PROPOSAL_MARKER)).at(-1);
    const policy = policyFor(this.deps.config, `${issue.owner}/${issue.repo}`);
    const task = buildTask(proposal ? { ...issue, body: proposal.body } : issue, policy);
    const fingerprint = createHash("sha256").update(`${issue.title}\n${issue.body}\n${proposal?.body ?? ""}`).digest("hex");
    return { task, trusted: trustedAuthors.has(issue.author.toLowerCase()), author: issue.author, fingerprint };
  }

  private async viewerLogin(): Promise<string> {
    this.viewer ??= await this.deps.github.viewer();
    return this.viewer;
  }

  async build(job: Job): Promise<void> {
    const { github, store } = this.deps;
    const policy = policyFor(this.deps.config, `${job.owner}/${job.repo}`);
    const repo = this.deps.repo(job.owner, job.repo);
    const attempts = job.attempts + 1;
    if (attempts > MAX_ATTEMPTS) return this.fail(job, new Error(`gave up after ${MAX_ATTEMPTS} interrupted attempts`));
    const branch = `isobot/${job.number}-${slug(job.title)}`;
    job = store.update(job.id, { state: "building", attempts, branch });
    let workspace: string | null = null;
    try {
      const issue = await github.issue(job.owner, job.repo, job.number);
      if (issue.state === "closed" || hasLabel(issue, this.labels.stop)) return this.stop(job, issue);
      const source = await this.taskFor(issue);
      const base = await github.defaultBranch(job.owner, job.repo);
      const baseSha = await repo.sync(base);
      workspace = await repo.createWorkspace(branch, baseSha);
      const { task } = source;

      let run = await this.deps.builder.implement({ cwd: workspace, task });
      store.update(job.id, { sessionId: run.sessionId });
      store.event(job.id, "implemented", run.summary);
      const commit = async (message: string) => {
        await repo.commitPending(workspace!, message);
        return repo.capture(workspace!, branch);
      };
      let sha = await commit(`${issue.title} (#${issue.number})\n\nImplemented by isobot for ${issue.url}`);
      if (await repo.ahead(baseSha, sha) === 0) {
        return this.fail(job, new Error(`the builder made no changes.\n\nBuilder said:\n\n${quote(run.summary || run.error || "(nothing)")}`), false);
      }

      let checks = await this.checks(workspace, policy.checks);
      let review: Review | undefined;
      let fixRounds = 0;
      let reviewRounds = 0;
      for (;;) {
        if (!checks.passed && fixRounds < this.deps.config.builder.maxFixRounds) {
          fixRounds++;
          run = await this.deps.builder.revise({ cwd: workspace, sessionId: run.sessionId ?? store.get(job.id)?.sessionId ?? null, task, feedback: failureFeedback(checks) });
          sha = await commit(`Fix checks for #${issue.number}`);
          checks = await this.checks(workspace, policy.checks);
          continue;
        }
        // The reviewer sees exactly the commit the runner captured, diffed in the runner's own clone.
        review = await this.deps.builder.review({ cwd: workspace, task, diff: await repo.diff(baseSha, sha), checks: formatChecks(checks) });
        store.event(job.id, "review", `${review.verdict} ${review.confidence} ${review.risk}: ${review.summary}`);
        if (review.verdict === "request_changes" && reviewRounds < this.deps.config.builder.maxReviewRounds) {
          reviewRounds++;
          run = await this.deps.builder.revise({ cwd: workspace, sessionId: run.sessionId, task, feedback: reviewFeedback(review) });
          sha = await commit(`Address review for #${issue.number}`);
          checks = await this.checks(workspace, policy.checks);
          continue;
        }
        break;
      }
      if (!review) throw new Error("review did not run");

      const diff = await repo.diffStat(baseSha, sha);
      await repo.push(sha, branch);
      const body = prBody({ issue, run: run.summary, checks, review, diff });
      const existing = await github.findPull(job.owner, job.repo, branch);
      const pr = existing && existing.state === "open"
        ? (await github.updatePull(job.owner, job.repo, existing.number, body), existing)
        : await github.createPull(job.owner, job.repo, { head: branch, base, title: issue.title, body });
      store.update(job.id, { prNumber: pr.number });

      const gateNow = async (): Promise<GateDecision> => {
        const current = await github.issue(job.owner, job.repo, job.number);
        const decision = evaluateGate({ policy, diff, checks, review: review!, issueLabels: current.labels, stopLabel: this.labels.stop });
        if (!source.trusted) decision.reasons.push(`the issue was written by @${source.author}, who isn't trusted to merge without you`);
        if ((await this.taskFor(current)).fingerprint !== source.fingerprint) decision.reasons.push("the issue text changed while isobot was building");
        if (current.state === "closed") decision.reasons.push("the issue was closed");
        return { merge: decision.reasons.length === 0, reasons: decision.reasons };
      };
      let gate = await gateNow();
      if (gate.merge && policy.requireCi) {
        const ci = await this.waitForCi(job, sha);
        // Labels and issue text can change during a long CI run; judge again right before merging.
        gate = ci === "success" ? await gateNow() : { merge: false, reasons: [ci === "none" ? "no GitHub CI reported on the PR" : `GitHub CI is ${ci}`] };
      }
      await github.removeLabel(job.owner, job.repo, job.number, this.labels.building);

      if (!gate.merge) {
        await github.addLabels(job.owner, job.repo, job.number, [this.labels.review]);
        store.update(job.id, { state: "pr_open" });
        await github.comment(job.owner, job.repo, job.number,
          `🔍 isobot opened ${pr.url} and is leaving the merge to you:\n${gate.reasons.map(r => `- ${r}`).join("\n")}`);
        await this.deps.notifier.discord(`🔍 **${job.owner}/${job.repo}#${job.number}** ${issue.title}: PR ready for your review: <${pr.url}>`);
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
        return;
      }
      store.update(job.id, { state: "merged" });
      await github.comment(job.owner, job.repo, job.number, `✅ isobot merged ${pr.url} after checks, review (confidence ${review.confidence.toFixed(2)}) and policy gates passed.`);
      await this.deps.notifier.discord(`✅ **${job.owner}/${job.repo}#${job.number}** ${issue.title}: merged <${pr.url}>`);
      await this.afterMerge(store.get(job.id)!, mergeSha, policy);
    } catch (error) {
      await this.fail(job, error as Error);
    } finally {
      if (workspace) await repo.removeWorkspace(branch).catch(() => undefined);
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
          await this.afterMerge(store.get(job.id)!, pr.mergeCommitSha, policyFor(this.deps.config, `${job.owner}/${job.repo}`));
        } else if (pr.state === "closed") {
          store.update(job.id, { state: "closed" });
          await github.removeLabel(job.owner, job.repo, job.number, this.labels.review);
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
        const report = await this.release(job, pr.mergeCommitSha!, policy.release.onShip, "ship");
        store.update(job.id, { state: report.passed ? "shipped" : "awaiting_ship", lastError: report.passed ? null : "ship step failed" });
        await github.comment(job.owner, job.repo, job.number, report.passed
          ? `🚀 Ship step finished:\n${formatChecks(report)}`
          : `❌ Ship step failed; fix it and add \`${this.labels.ship}\` again to retry:\n${formatChecks(report)}`);
        await this.deps.notifier.discord(`${report.passed ? "🚀" : "❌"} **${job.id}** ship step ${report.passed ? "finished" : "failed"}`);
      } catch (error) {
        await github.comment(job.owner, job.repo, job.number,
          `❌ The ship step couldn't start (${(error as Error).message}). Add \`${this.labels.ship}\` again to retry.`).catch(() => undefined);
      }
    }
  }

  private async afterMerge(job: Job, mergeSha: string, policy: RepoPolicy): Promise<void> {
    const { github, store } = this.deps;
    if (policy.release.onMerge.length) {
      let report: CheckReport;
      try {
        report = await this.release(job, mergeSha, policy.release.onMerge, "merge");
      } catch (error) {
        report = { configured: true, passed: false, results: [{ command: "prepare release checkout", ok: false, output: (error as Error).message }] };
      }
      store.update(job.id, { state: report.passed ? "released" : "merged", lastError: report.passed ? null : "release failed" });
      await github.comment(job.owner, job.repo, job.number, `${report.passed ? "📦 Released" : "❌ Release failed"}:\n${formatChecks(report)}`);
      await this.deps.notifier.discord(`${report.passed ? "📦" : "❌"} **${job.id}** release ${report.passed ? "finished" : "failed"}`);
      if (!report.passed) return;
    }
    if (policy.release.onShip.length) {
      store.update(job.id, { state: "awaiting_ship" });
      await github.comment(job.owner, job.repo, job.number,
        `🛳 Ready to ship. Add the \`${this.labels.ship}\` label to run: ${policy.release.onShip.map(c => `\`${c}\``).join(", ")}`);
    }
  }

  private async release(job: Job, sha: string, commands: string[], label: string): Promise<CheckReport> {
    const repo = this.deps.repo(job.owner, job.repo);
    await repo.sync(await this.deps.github.defaultBranch(job.owner, job.repo));
    const name = `release__${job.number}-${label}`;
    const dir = await repo.checkoutAt(sha, name);
    try {
      return await this.checks(dir, commands, 90 * 60_000);
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

  private checks(cwd: string, commands: string[], timeoutMs?: number): Promise<CheckReport> {
    return (this.deps.checks ?? runChecks)(cwd, commands, timeoutMs);
  }

  private async stop(job: Job, issue: Issue): Promise<void> {
    this.deps.store.update(job.id, { state: "stopped" });
    await this.deps.github.removeLabel(job.owner, job.repo, job.number, this.labels.building);
    if (issue.state === "open") await this.deps.github.comment(job.owner, job.repo, job.number, "⏹ isobot stopped working on this issue.");
  }

  private async fail(job: Job, error: Error, notify = true): Promise<void> {
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
    if (notify) await this.deps.notifier.discord(`⚠️ **${job.id}** failed: ${message.slice(0, 300)}`);
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

function quote(text: string): string {
  return text.split("\n").slice(0, 40).map(line => `> ${line}`).join("\n");
}
