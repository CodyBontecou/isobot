import type { AgentRun, Builder, Review, TriageItem, TriageResult } from "./builder.js";
import type { Labels } from "./config.js";
import type { DiffStat } from "./git.js";
import type { CiState, GitHubApi, Issue, IssueComment, PullRequest } from "./github.js";
import type { RepoOps } from "./pipeline.js";

/** In-memory GitHub for tests. */
export class FakeGitHub implements GitHubApi {
  issues = new Map<string, Issue>();
  comments: { key: string; body: string; author?: string }[] = [];
  pulls = new Map<number, PullRequest & { owner: string; repo: string; branch: string; body: string }>();
  merged: number[] = [];
  ci: CiState = "success";
  login = "owner";
  private nextPull = 100;

  add(owner: string, repo: string, number: number, title: string, labels: string[], body = "Do the thing", author = "owner"): Issue {
    const issue: Issue = { owner, repo, number, title, body, labels, state: "open", url: `https://github.com/${owner}/${repo}/issues/${number}`, author };
    this.issues.set(`${owner}/${repo}#${number}`, issue);
    return issue;
  }

  get(owner: string, repo: string, number: number): Issue {
    const issue = this.issues.get(`${owner}/${repo}#${number}`);
    if (!issue) throw Object.assign(new Error("Not Found"), { status: 404 });
    return issue;
  }

  commentsFor(owner: string, repo: string, number: number): string[] {
    return this.comments.filter(c => c.key === `${owner}/${repo}#${number}`).map(c => c.body);
  }

  async viewer(): Promise<string> { return this.login; }
  async issueComments(owner: string, repo: string, number: number): Promise<IssueComment[]> {
    return this.comments.filter(c => c.key === `${owner}/${repo}#${number}`).map(c => ({ author: c.author ?? this.login, body: c.body }));
  }
  async defaultBranch(): Promise<string> { return "main"; }
  async issuesWithLabel(owner: string, repo: string, label: string): Promise<Issue[]> {
    return [...this.issues.values()].filter(i => i.owner === owner && i.repo === repo && i.state === "open" && i.labels.includes(label));
  }
  async openIssues(owner: string, repo: string): Promise<Issue[]> {
    return [...this.issues.values()].filter(i => i.owner === owner && i.repo === repo && i.state === "open");
  }
  async issue(owner: string, repo: string, number: number): Promise<Issue> { return structuredClone(this.get(owner, repo, number)); }
  async addLabels(owner: string, repo: string, number: number, labels: string[]): Promise<void> {
    const issue = this.get(owner, repo, number);
    for (const label of labels) if (!issue.labels.includes(label)) issue.labels.push(label);
  }
  async removeLabel(owner: string, repo: string, number: number, label: string): Promise<void> {
    const issue = this.get(owner, repo, number);
    issue.labels = issue.labels.filter(l => l !== label);
  }
  async comment(owner: string, repo: string, number: number, body: string): Promise<void> {
    this.comments.push({ key: `${owner}/${repo}#${number}`, body });
  }
  async createIssue(owner: string, repo: string, title: string, body: string, labels: string[]): Promise<Issue> {
    const number = this.issues.size + 1;
    return this.add(owner, repo, number, title, labels, body);
  }
  async findPull(owner: string, repo: string, branch: string): Promise<PullRequest | null> {
    return [...this.pulls.values()].find(p => p.owner === owner && p.repo === repo && p.branch === branch) ?? null;
  }
  async pull(_owner: string, _repo: string, number: number): Promise<PullRequest> {
    const pull = this.pulls.get(number);
    if (!pull) throw new Error("no pull");
    return pull;
  }
  async createPull(owner: string, repo: string, input: { head: string; base: string; title: string; body: string }): Promise<PullRequest> {
    const number = this.nextPull++;
    const pull = { owner, repo, branch: input.head, body: input.body, number, url: `https://github.com/${owner}/${repo}/pull/${number}`, state: "open" as const, merged: false, headSha: "head", mergeCommitSha: null };
    this.pulls.set(number, pull);
    return pull;
  }
  async updatePull(_owner: string, _repo: string, number: number, body: string): Promise<void> { this.pulls.get(number)!.body = body; }
  async ciState(): Promise<CiState> { return this.ci; }
  async merge(_owner: string, _repo: string, number: number): Promise<string> {
    const pull = this.pulls.get(number)!;
    Object.assign(pull, { state: "closed", merged: true, mergeCommitSha: `merge-${number}` });
    this.merged.push(number);
    return `merge-${number}`;
  }
  async ensureLabels(_owner: string, _repo: string, _labels: Labels): Promise<void> {}
}

/** Git double: records calls; `changes` controls whether the builder produced a diff. */
export class FakeRepo implements RepoOps {
  calls: string[] = [];
  changes = true;
  commits = 0;
  diff_: DiffStat = { files: [{ path: "src/feature.ts", added: 20, removed: 3, binary: false }], changedLines: 23 };

  async sync(): Promise<string> { this.calls.push("sync"); return "base"; }
  async createWorkspace(branch: string): Promise<string> { this.calls.push(`workspace ${branch}`); return `/tmp/wt/${branch}`; }
  async removeWorkspace(name: string): Promise<void> { this.calls.push(`remove ${name}`); }
  async commitPending(): Promise<void> { this.calls.push("commit"); }
  async capture(): Promise<string> { this.commits++; return `sha${this.commits}`; }
  async ahead(): Promise<number> { return this.changes ? 1 : 0; }
  async diffStat(): Promise<DiffStat> { return this.diff_; }
  async diff(): Promise<string> { return "diff --git a/x b/x"; }
  async push(sha: string, branch: string): Promise<void> { this.calls.push(`push ${sha} ${branch}`); }
  async checkoutAt(sha: string, name: string): Promise<string> { this.calls.push(`checkout ${sha} ${name}`); return "/tmp/release"; }
}

export class FakeBuilder implements Builder {
  reviews: Review[] = [];
  implementCalls = 0;
  reviseFeedback: string[] = [];
  triageResult: TriageResult = { decisions: [], digest: "" };
  triageItems: TriageItem[] = [];
  implementResult: AgentRun = { ok: true, sessionId: "session-1", summary: "Added the feature and tests." };

  async implement(_input: { cwd: string; task: string }): Promise<AgentRun> { this.implementCalls++; return this.implementResult; }
  async revise(input: { feedback: string }): Promise<AgentRun> {
    this.reviseFeedback.push(input.feedback);
    return { ok: true, sessionId: "session-1", summary: "Fixed." };
  }
  async review(): Promise<Review> {
    return this.reviews.shift() ?? { verdict: "approve", confidence: 0.95, risk: "low", summary: "Looks right.", concerns: [] };
  }
  async triage(input: { items: TriageItem[] }): Promise<TriageResult> {
    this.triageItems = input.items;
    return this.triageResult;
  }
}
