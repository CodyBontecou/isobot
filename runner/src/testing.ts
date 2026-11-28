import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AgentRun, Builder, JobDevices, PreviousReview, Review, TriageItem, TriageResult } from "./builder.js";
import { loadConfig, type Labels, type RunnerConfig } from "./config.js";
import type { DiffStat } from "./git.js";
import type { CiState, GitHubApi, Issue, IssueComment, PullRequest, SecretAlert } from "./github.js";
import { RUNNER_MARKER } from "./notes.js";
import type { RepoOps } from "./pipeline.js";

/**
 * The shipped config with every repo at "pr" autonomy (owner-only merge where a train needs it), so tests
 * opt into merging themselves instead of following whatever the live config allows.
 */
/**
 * Whether sandbox-exec can confine a command here: macOS, and not already inside a sandbox (isobot's own checks
 * run in the check sandbox, which can't apply another profile; GitHub CI's macOS job runs these tests).
 */
export const canSandbox = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec")
  && spawnSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"]).status === 0;

export function testConfig(): RunnerConfig {
  const config = loadConfig();
  config.defaults.autonomy = "pr";
  for (const policy of Object.values(config.repos)) {
    delete policy.autonomy;
    // A release train needs a repo isobot can merge into.
    if (policy.train) policy.ownerAutonomy = "merge";
    else delete policy.ownerAutonomy;
  }
  return config;
}

/** Smallest byte sequences media.ts accepts as a PNG and an MP4. */
export const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
export const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypmp42"), Buffer.alloc(32)]);

/** In-memory GitHub for tests. */
export class FakeGitHub implements GitHubApi {
  issues = new Map<string, Issue>();
  comments: { id: number; key: string; body: string; author?: string; at: string }[] = [];
  /** Calls to issueComments, by `owner/repo#n`. */
  commentReads: string[] = [];
  private nextComment = 1;
  pulls = new Map<number, PullRequest & { owner: string; repo: string; branch: string; body: string }>();
  merged: number[] = [];
  ci: CiState = "success";
  login = "owner";
  /** Who added each label, by `owner/repo#n:label`; unset means the token owner. */
  labelers = new Map<string, string>();
  publicRepos = new Set<string>();
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
    return this.comments.filter(c => c.key === `${owner}/${repo}#${number}`).map(c => c.body.replace(`\n\n${RUNNER_MARKER}`, ""));
  }

  /** A comment by someone other than the runner (the owner by default), as GitHub would list it. */
  addComment(owner: string, repo: string, number: number, body: string, author = this.login): void {
    this.comments.push({ id: this.nextComment++, key: `${owner}/${repo}#${number}`, body, author, at: new Date().toISOString() });
  }

  async viewer(): Promise<string> { return this.login; }
  async labeledBy(owner: string, repo: string, number: number, label: string): Promise<string | null> {
    const issue = this.issues.get(`${owner}/${repo}#${number}`);
    if (!issue?.labels.includes(label)) return null;
    return this.labelers.get(`${owner}/${repo}#${number}:${label}`) ?? this.login;
  }
  async isPublic(owner: string, repo: string): Promise<boolean> { return this.publicRepos.has(`${owner}/${repo}`); }
  secretAlerts = new Map<string, SecretAlert[]>();
  async secretScanningAlerts(owner: string, repo: string): Promise<SecretAlert[] | null> { return this.secretAlerts.get(`${owner}/${repo}`) ?? []; }
  async issueComments(owner: string, repo: string, number: number): Promise<IssueComment[]> {
    this.commentReads.push(`${owner}/${repo}#${number}`);
    return this.comments.filter(c => c.key === `${owner}/${repo}#${number}`).map(c => ({ id: c.id, author: c.author ?? this.login, body: c.body }));
  }
  async commentedSince(owner: string, repo: string, since: string): Promise<Set<number>> {
    const prefix = `${owner}/${repo}#`.toLowerCase();
    return new Set(this.comments.filter(c => c.key.toLowerCase().startsWith(prefix) && c.at >= since).map(c => Number(c.key.split("#")[1])));
  }
  async defaultBranch(): Promise<string> { return "main"; }
  async issuesWithLabel(owner: string, repo: string, label: string): Promise<Issue[]> {
    return [...this.issues.values()].filter(i => i.owner === owner && i.repo === repo && i.state === "open" && i.labels.includes(label) && !this.prIssues.has(`${owner}/${repo}#${i.number}`));
  }
  async pullsWithLabel(owner: string, repo: string, label: string): Promise<Issue[]> {
    return [...this.issues.values()].filter(i => i.owner === owner && i.repo === repo && i.state === "open" && i.labels.includes(label) && this.prIssues.has(`${owner}/${repo}#${i.number}`));
  }
  /** Issues that are pull requests (addPull): GitHub lists PRs as issues too. */
  prIssues = new Set<string>();
  /** Someone else's open PR (an agent session's, Dependabot's), on `branch`: an issue and a pull, as on GitHub. */
  addPull(owner: string, repo: string, number: number, title: string, branch: string, labels: string[] = [], body = "Fix the thing", author = "owner", headRepo = `${owner}/${repo}`): Issue {
    const issue = this.add(owner, repo, number, title, labels, body, author);
    issue.url = `https://github.com/${owner}/${repo}/pull/${number}`;
    this.prIssues.add(`${owner}/${repo}#${number}`);
    this.pulls.set(number, { owner, repo, number, url: issue.url, state: "open", merged: false, headSha: `head-${number}`, mergeCommitSha: null, branch, body, headRef: branch, headRepo });
    return issue;
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
  async comment(owner: string, repo: string, number: number, body: string): Promise<number> {
    const id = this.nextComment++;
    this.comments.push({ id, key: `${owner}/${repo}#${number}`, body: `${body}\n\n${RUNNER_MARKER}`, at: new Date().toISOString() });
    return id;
  }
  async updateComment(_owner: string, _repo: string, commentId: number, body: string): Promise<void> {
    const comment = this.comments.find(c => c.id === commentId);
    if (!comment) throw new Error("no comment");
    comment.body = `${body}\n\n${RUNNER_MARKER}`;
    comment.at = new Date().toISOString();
  }
  closedAs = new Map<string, string>();
  async closeIssue(owner: string, repo: string, number: number, reason = "completed"): Promise<void> {
    this.get(owner, repo, number).state = "closed";
    this.closedAs.set(`${owner}/${repo}#${number}`, reason);
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
  async closePull(_owner: string, _repo: string, number: number): Promise<void> { this.pulls.get(number)!.state = "closed"; }
  async ciState(): Promise<CiState> { return this.ci; }
  async merge(_owner: string, _repo: string, number: number): Promise<string> {
    const pull = this.pulls.get(number)!;
    Object.assign(pull, { state: "closed", merged: true, mergeCommitSha: `merge-${number}` });
    this.merged.push(number);
    return `merge-${number}`;
  }
  async ensureLabels(_owner: string, _repo: string, _labels: Labels): Promise<void> {}
  /** Newest successful deploy per repo, and which commit each deployed commit contains (by default only itself). */
  deploys = new Map<string, string>();
  descendants = new Map<string, string[]>();
  async latestDeploy(owner: string, repo: string): Promise<string | null> { return this.deploys.get(`${owner}/${repo}`) ?? null; }
  async contains(_owner: string, _repo: string, base: string, head: string): Promise<boolean> {
    return base === head || (this.descendants.get(base) ?? []).includes(head);
  }
}

/** Records Discord REST calls the Notifier makes; messages get ids 1000, 1001… */
export class FakeDiscord {
  calls: { method: string; path: string; body: Record<string, unknown> }[] = [];
  /** Multipart uploads: the payload and the uploaded file names. */
  uploads: { path: string; payload: Record<string, unknown>; files: string[] }[] = [];
  private next = 1000;
  fail404 = new Set<string>();

  readonly fetch = (async (url: string | URL, init?: RequestInit) => {
    const path = String(url).replace("https://discord.com/api/v10", "");
    const method = init?.method ?? "GET";
    if (init?.body instanceof FormData) {
      const form = init.body;
      const files = [...form.entries()].filter(([key]) => key.startsWith("files[")).map(([, value]) => (value as File).name);
      this.uploads.push({ path, payload: JSON.parse(String(form.get("payload_json"))), files });
      return Response.json({ id: String(this.next++) });
    }
    this.calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : {} });
    if (this.fail404.has(path)) return new Response("{}", { status: 404 });
    return Response.json({ id: String(this.next++) });
  }) as typeof fetch;

  /** Text posted to a channel or thread, in order. */
  posts(channelId: string): string[] {
    return this.calls.filter(c => c.method === "POST" && c.path === `/channels/${channelId}/messages` && typeof c.body.content === "string" && c.body.content)
      .map(c => c.body.content as string);
  }

  /** Every card body (create or edit), newest last. */
  cards(): { description: string; title: string }[] {
    return this.calls.filter(c => Array.isArray(c.body.embeds)).map(c => (c.body.embeds as { description: string; title: string }[])[0]);
  }
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
  /** Workspaces a "previous run" left on disk, for recover(). */
  leftBehind = new Set<string>();
  hasWorkspace(name: string): boolean { return this.leftBehind.has(name); }
  workspacePath(name: string): string { return `/tmp/wt/${name}`; }
  async commitPending(dir: string, message = ""): Promise<void> { this.calls.push(message.startsWith("WIP") ? `wip ${dir}` : "commit"); }
  async capture(): Promise<string> { this.commits++; return `sha${this.commits}`; }
  async ahead(): Promise<number> { return this.changes ? 1 : 0; }
  async diffStat(): Promise<DiffStat> { return this.diff_; }
  async diff(): Promise<string> { return "diff --git a/x b/x"; }
  async push(sha: string, branch: string): Promise<void> { this.calls.push(`push ${sha} ${branch}`); }
  async fetchBranch(branch: string): Promise<string> { this.calls.push(`fetch ${branch}`); return `pr-head-${branch}`; }
  async mergeBase(a: string, b: string): Promise<string> { this.calls.push(`merge-base ${a} ${b}`); return "base"; }
  /** Files `mergeMain` reports as conflicting (none: a clean merge). */
  mainConflicts: string[] = [];
  async mergeMain(_dir: string, sha: string): Promise<string[]> { this.calls.push(`merge-main ${sha}`); return this.mainConflicts; }
  async purge(number: number): Promise<string[]> { this.calls.push(`purge ${number}`); return []; }
  async checkoutAt(sha: string, name: string): Promise<string> { this.calls.push(`checkout ${sha} ${name}`); return "/tmp/release"; }
  published: { prefix: string; names: string[] }[] = [];
  publishError?: Error;
  async publishMedia(prefix: string, files: { name: string }[]): Promise<Record<string, string>> {
    if (this.publishError) throw this.publishError;
    this.published.push({ prefix, names: files.map(f => f.name) });
    return Object.fromEntries(files.map(f => [f.name, `https://github.com/o/r/blob/media/${prefix}/${f.name}?raw=true`]));
  }
}

export class FakeBuilder implements Builder {
  reviews: Review[] = [];
  implementCalls = 0;
  reviseFeedback: string[] = [];
  reviseSessions: (string | null)[] = [];
  reviewTasks: string[] = [];
  triageResult: TriageResult = { decisions: [], digest: "" };
  triageItems: TriageItem[] = [];
  implementResult: AgentRun = { ok: true, sessionId: "session-1", summary: "Added the feature and tests." };

  /** Device env each implement/revise call saw. */
  deviceEnvs: (Record<string, string> | undefined)[] = [];

  /** Files the builder "captures" into $ISOBOT_MEDIA during implement: name → bytes. */
  captures: Record<string, Buffer> = {};
  /** Media paths each review saw. */
  reviewMedia: (string[] | undefined)[] = [];
  reviewPrevious: (PreviousReview | undefined)[] = [];

  /** The timeoutMinutes override each implement/revise call got (undefined: builder.timeoutMinutes). */
  timeouts: (number | undefined)[] = [];
  async implement(input: { cwd: string; task: string; devices?: JobDevices; media?: string; sessionId?: string; timeoutMinutes?: number }): Promise<AgentRun> {
    this.implementCalls++;
    this.timeouts.push(input.timeoutMinutes);
    this.implementSessions.push(input.sessionId);
    this.during?.();
    this.deviceEnvs.push(input.devices?.env);
    for (const [name, bytes] of Object.entries(this.captures)) writeFileSync(path.join(input.media!, name), bytes);
    return this.implementResult;
  }
  /** Session ids implement was told to use, and the resumed flag of each revise. */
  implementSessions: (string | undefined)[] = [];
  reviseResumed: boolean[] = [];
  /** Runs before implement/revise return, e.g. to simulate a shutdown mid-run. */
  during?: () => void;
  async revise(input: { feedback: string; sessionId: string | null; devices?: JobDevices; resumed?: boolean; timeoutMinutes?: number }): Promise<AgentRun> {
    this.during?.();
    this.timeouts.push(input.timeoutMinutes);
    this.reviseResumed.push(Boolean(input.resumed));
    this.deviceEnvs.push(input.devices?.env);
    this.reviseFeedback.push(input.feedback);
    this.reviseSessions.push(input.sessionId);
    return { ok: true, sessionId: "session-1", summary: "Fixed." };
  }
  /** Whether each review was asked to judge content (ReviewInput.content). */
  reviewContent: boolean[] = [];
  async review(input: { task: string; media?: string[]; previous?: PreviousReview; content?: boolean }): Promise<Review> {
    this.reviewTasks.push(input.task);
    this.reviewContent.push(Boolean(input.content));
    this.reviewPrevious.push(input.previous);
    this.reviewMedia.push(input.media);
    return this.reviews.shift() ?? { verdict: "approve", confidence: 0.95, risk: "low", summary: "Looks right.", concerns: [] };
  }
  async triage(input: { items: TriageItem[] }): Promise<TriageResult> {
    this.triageItems = input.items;
    return this.triageResult;
  }
}
