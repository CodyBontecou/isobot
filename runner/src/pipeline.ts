import type { Builder, Review } from "./builder.js";
import { failureFeedback, formatChecks, runChecks } from "./checks.js";
import { configuredRepos, policyFor, type Environment, type RepoPolicy, type RunnerConfig } from "./config.js";
import type { DiffStat } from "./git.js";
import type { GitHubApi, Issue, PullRequest } from "./github.js";
import type { Notifier } from "./notify.js";
import { evaluateGate, type CheckReport } from "./policy.js";
import type { Job, Store } from "./store.js";

/** The git operations the pipeline needs; `Repo` implements it, tests fake it. */
export interface RepoOps {
  sync(defaultBranch: string): Promise<void>;
  createWorktree(branch: string, defaultBranch: string): Promise<string>;
  removeWorktree(branch: string): Promise<void>;
  commitPending(dir: string, message: string, defaultBranch: string): Promise<boolean>;
  diffStat(dir: string, defaultBranch: string): Promise<DiffStat>;
  diff(dir: string, defaultBranch: string): Promise<string>;
  head(dir: string): Promise<string>;
  push(dir: string, branch: string): Promise<void>;
  checkoutAt(sha: string, label: string): Promise<string>;
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

export class Pipeline {
  private running = new Set<string>();

  constructor(private deps: PipelineDeps) {}

  private get labels() { return this.deps.config.labels; }

  /** Moves approved issues (ready label) into the local queue and claims them on GitHub. */
  async discover(): Promise<Job[]> {
    const claimed: Job[] = [];
    for (const { owner, repo } of configuredRepos(this.deps.config)) {
      let issues: Issue[];
      try {
        issues = await this.deps.github.issuesWithLabel(owner, repo, this.labels.ready);
      } catch (error) {
        console.warn(`[discover] ${owner}/${repo}: ${(error as Error).message}`);
        continue;
      }
      for (const issue of issues) {
        if (hasLabel(issue, this.labels.stop)) continue;
        const job = this.deps.store.enqueue(owner, repo, issue.number, issue.title);
        if (!job) continue;
        await this.deps.github.removeLabel(owner, repo, issue.number, this.labels.ready);
        await this.deps.github.removeLabel(owner, repo, issue.number, this.labels.failed);
        await this.deps.github.addLabels(owner, repo, issue.number, [this.labels.building]);
        await this.deps.github.comment(owner, repo, issue.number,
          "🤖 isobot picked this up and is building it now. Add the `" + this.labels.stop + "` label at any time to stop.");
        claimed.push(job);
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

  /** After a restart, interrupted builds start again from a clean worktree. */
  recover(): void {
    for (const job of this.deps.store.inState("building")) this.deps.store.update(job.id, { state: "queued" });
  }

  async build(job: Job): Promise<void> {
    const { github, store } = this.deps;
    const policy = policyFor(this.deps.config, `${job.owner}/${job.repo}`);
    const repo = this.deps.repo(job.owner, job.repo);
    const attempts = job.attempts + 1;
    if (attempts > MAX_ATTEMPTS) return this.fail(job, new Error(`gave up after ${MAX_ATTEMPTS} interrupted attempts`));
    const branch = `isobot/${job.number}-${slug(job.title)}`;
    job = store.update(job.id, { state: "building", attempts, branch });
    let worktree: string | null = null;
    try {
      const issue = await github.issue(job.owner, job.repo, job.number);
      if (issue.state === "closed" || hasLabel(issue, this.labels.stop)) return this.stop(job, issue);
      const base = await github.defaultBranch(job.owner, job.repo);
      await repo.sync(base);
      worktree = await repo.createWorktree(branch, base);
      const task = buildTask(issue, policy);

      let run = await this.deps.builder.implement({ cwd: worktree, task });
      store.update(job.id, { sessionId: run.sessionId });
      store.event(job.id, "implemented", run.summary);
      const commitMessage = `${issue.title} (#${issue.number})\n\nImplemented by isobot for ${issue.url}`;
      if (!await repo.commitPending(worktree, commitMessage, base)) {
        return this.fail(job, new Error(`the builder made no changes.\n\nBuilder said:\n\n${quote(run.summary || run.error || "(nothing)")}`), false);
      }

      let checks = await this.checks(worktree, policy.checks);
      let review: Review | undefined;
      let fixRounds = 0;
      let reviewRounds = 0;
      for (;;) {
        if (!checks.passed && fixRounds < this.deps.config.builder.maxFixRounds) {
          fixRounds++;
          run = await this.deps.builder.revise({ cwd: worktree, sessionId: run.sessionId ?? store.get(job.id)?.sessionId ?? null, task, feedback: failureFeedback(checks) });
          await repo.commitPending(worktree, `Fix checks for #${issue.number}`, base);
          checks = await this.checks(worktree, policy.checks);
          continue;
        }
        review = await this.deps.builder.review({
          cwd: worktree, task, diff: await repo.diff(worktree, base), checks: formatChecks(checks),
        });
        store.event(job.id, "review", `${review.verdict} ${review.confidence} ${review.risk}: ${review.summary}`);
        if (review.verdict === "request_changes" && reviewRounds < this.deps.config.builder.maxReviewRounds) {
          reviewRounds++;
          run = await this.deps.builder.revise({ cwd: worktree, sessionId: run.sessionId, task, feedback: reviewFeedback(review) });
          await repo.commitPending(worktree, `Address review for #${issue.number}`, base);
          checks = await this.checks(worktree, policy.checks);
          continue;
        }
        break;
      }

      if (!review) throw new Error("review did not run");
      const diff = await repo.diffStat(worktree, base);
      await repo.push(worktree, branch);
      const head = await repo.head(worktree);
      const body = prBody({ issue, run: run.summary, checks, review, diff, policy });
      const existing = await github.findPull(job.owner, job.repo, branch);
      const pr = existing && existing.state === "open"
        ? (await github.updatePull(job.owner, job.repo, existing.number, body), existing)
        : await github.createPull(job.owner, job.repo, { head: branch, base, title: issue.title, body });
      store.update(job.id, { prNumber: pr.number });

      const current = await github.issue(job.owner, job.repo, job.number);
      let gate = evaluateGate({ policy, diff, checks, review, issueLabels: current.labels, stopLabel: this.labels.stop });
      if (gate.merge && policy.requireCi) {
        const ci = await this.waitForCi(job, head);
        if (ci !== "success" && ci !== "none") gate = { merge: false, reasons: [`GitHub CI is ${ci}`] };
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
        mergeSha = await github.merge(job.owner, job.repo, pr.number, head, `${issue.title} (#${pr.number})`);
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
      if (worktree) await repo.removeWorktree(branch).catch(() => undefined);
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
          store.update(job.id, { state: "merged" });
          await github.removeLabel(job.owner, job.repo, job.number, this.labels.review);
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
      try {
        const issue = await github.issue(job.owner, job.repo, job.number);
        if (!hasLabel(issue, this.labels.ship)) continue;
        const pr = await github.pull(job.owner, job.repo, job.prNumber!);
        await github.removeLabel(job.owner, job.repo, job.number, this.labels.ship);
        const policy = policyFor(this.deps.config, `${job.owner}/${job.repo}`);
        const report = await this.release(job, pr.mergeCommitSha!, policy.release.onShip, "ship");
        store.update(job.id, { state: report.passed ? "shipped" : "awaiting_ship", lastError: report.passed ? null : "ship step failed" });
        await github.comment(job.owner, job.repo, job.number, report.passed
          ? `🚀 Ship step finished:\n${formatChecks(report)}`
          : `❌ Ship step failed; fix it and add \`${this.labels.ship}\` again to retry:\n${formatChecks(report)}`);
        await this.deps.notifier.discord(`${report.passed ? "🚀" : "❌"} **${job.id}** ship step ${report.passed ? "finished" : "failed"}`);
      } catch (error) {
        console.warn(`[ship] ${job.id}: ${(error as Error).message}`);
      }
    }
  }

  private async afterMerge(job: Job, mergeSha: string, policy: RepoPolicy): Promise<void> {
    const { github, store } = this.deps;
    if (policy.release.onMerge.length) {
      const report = await this.release(job, mergeSha, policy.release.onMerge, "merge");
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
    const dir = await repo.checkoutAt(sha, `${job.number}-${label}`);
    try {
      return await this.checks(dir, commands, 90 * 60_000);
    } finally {
      await repo.removeWorktree(`release__${job.number}-${label}`).catch(() => undefined);
    }
  }

  private async waitForCi(job: Job, sha: string): Promise<string> {
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise(resolve => setTimeout(resolve, ms)));
    const deadline = Date.now() + CI_WAIT_MS;
    // Give GitHub a moment to register check suites for the new head.
    await sleep(20_000);
    for (;;) {
      const state = await this.deps.github.ciState(job.owner, job.repo, sha);
      if (state !== "pending") return state;
      if (Date.now() > deadline) return "still pending after 45 minutes";
      await sleep(30_000);
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

export function buildTask(issue: Issue, policy: RepoPolicy): string {
  const body = issue.body
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/^@codex implement this\s*$/gim, "")
    .trim();
  return [
    `# ${issue.title}`,
    `GitHub issue: ${issue.url}`,
    body || "(no description)",
    ...(policy.notes ? ["## Repository notes from the owner", policy.notes] : []),
  ].join("\n\n");
}

function prBody(input: { issue: Issue; run: string; checks: CheckReport; review: Review; diff: DiffStat; policy: RepoPolicy }): string {
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

export function slug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40).replace(/-$/, "") || "change";
}

function quote(text: string): string {
  return text.split("\n").slice(0, 40).map(line => `> ${line}`).join("\n");
}
