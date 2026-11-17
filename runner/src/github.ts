import { Octokit } from "@octokit/rest";
import type { PullDetails } from "./chatTools.js";
import type { Labels } from "./config.js";
import { RUNNER_MARKER } from "./notes.js";

export interface Issue {
  owner: string;
  repo: string;
  number: number;
  title: string;
  body: string;
  labels: string[];
  state: "open" | "closed";
  url: string;
  author: string;
}

export interface PullRequest {
  number: number;
  url: string;
  state: "open" | "closed";
  merged: boolean;
  headSha: string;
  mergeCommitSha: string | null;
}

export type CiState = "success" | "pending" | "failure" | "none";

export interface IssueComment {
  id: number;
  author: string;
  body: string;
}

const LABEL_COLORS: Record<keyof Labels, string> = {
  proposed: "c5def5", ready: "0e8a16", building: "fbca04", review: "1d76db",
  failed: "b60205", ship: "5319e7", stop: "000000", auto: "0b7285",
};

const LABEL_DESCRIPTIONS: Record<keyof Labels, string> = {
  proposed: "isobot proposal: add the ready label to approve a build",
  ready: "Approved for isobot to build",
  building: "isobot is working on this",
  review: "isobot opened a PR that needs a human decision",
  failed: "isobot could not finish; see the latest comment",
  ship: "Approve isobot to run the ship (App Store) step",
  stop: "Stop isobot from touching this issue",
  auto: "From the owner: isobot may take it end to end (only counts when the owner adds it)",
};

/** The subset of GitHub the runner needs; an interface so tests can fake it. */
export interface GitHubApi {
  /** Login of the token's owner: the identity isobot acts as, and a trusted author. */
  viewer(): Promise<string>;
  defaultBranch(owner: string, repo: string): Promise<string>;
  issueComments(owner: string, repo: string, number: number): Promise<IssueComment[]>;
  /** Who most recently added `label` to the issue, or null if no such event exists. */
  labeledBy(owner: string, repo: string, number: number, label: string): Promise<string | null>;
  isPublic(owner: string, repo: string): Promise<boolean>;
  issuesWithLabel(owner: string, repo: string, label: string): Promise<Issue[]>;
  openIssues(owner: string, repo: string, since?: string): Promise<Issue[]>;
  issue(owner: string, repo: string, number: number): Promise<Issue>;
  addLabels(owner: string, repo: string, number: number, labels: string[]): Promise<void>;
  removeLabel(owner: string, repo: string, number: number, label: string): Promise<void>;
  comment(owner: string, repo: string, number: number, body: string): Promise<void>;
  createIssue(owner: string, repo: string, title: string, body: string, labels: string[]): Promise<Issue>;
  closeIssue(owner: string, repo: string, number: number): Promise<void>;
  findPull(owner: string, repo: string, branch: string): Promise<PullRequest | null>;
  pull(owner: string, repo: string, number: number): Promise<PullRequest>;
  createPull(owner: string, repo: string, input: { head: string; base: string; title: string; body: string }): Promise<PullRequest>;
  updatePull(owner: string, repo: string, number: number, body: string): Promise<void>;
  ciState(owner: string, repo: string, sha: string): Promise<CiState>;
  merge(owner: string, repo: string, number: number, sha: string, title: string): Promise<string>;
  ensureLabels(owner: string, repo: string, labels: Labels): Promise<void>;
}

export class GitHub implements GitHubApi {
  private octokit: Octokit;
  private branches = new Map<string, string>();
  private visibility = new Map<string, boolean>();

  constructor(token: string, sleep: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms))) {
    this.octokit = new Octokit({ auth: token, userAgent: "isobot-runner/0.1", request: { timeout: 30_000 } });
    // Retry transient failures. Writes (create issue/PR/comment, merge) may have happened before a 5xx
    // or a dropped connection, so they retry only when GitHub explicitly rate-limited the request.
    this.octokit.hook.wrap("request", async (request, options) => {
      const idempotent = !["POST", "PATCH", "PUT", "DELETE"].includes(String(options.method).toUpperCase());
      for (let attempt = 0; ; attempt++) {
        try {
          return await request(options);
        } catch (error) {
          const status = (error as { status?: number }).status;
          const headers = ((error as { response?: { headers?: Record<string, string> } }).response?.headers) ?? {};
          const rateLimited = status === 429 || (status === 403 && (headers["x-ratelimit-remaining"] === "0" || Boolean(headers["retry-after"])));
          const retryable = rateLimited || (idempotent && (status === undefined || status >= 500));
          if (!retryable || attempt >= 3) throw error;
          const reset = Number(headers["x-ratelimit-reset"]) * 1000 - Date.now();
          const wait = Number(headers["retry-after"]) * 1000 || (Number.isFinite(reset) && reset > 0 ? reset : 2000 * 3 ** attempt);
          if (wait > 120_000) throw error;
          await sleep(wait);
        }
      }
    });
  }

  async labeledBy(owner: string, repo: string, number: number, label: string): Promise<string | null> {
    const events = await this.octokit.paginate(this.octokit.issues.listEvents, { owner, repo, issue_number: number, per_page: 100 });
    const match = events.filter(e => e.event === "labeled" && (e as { label?: { name?: string } }).label?.name?.toLowerCase() === label.toLowerCase()).at(-1);
    return match?.actor?.login ?? null;
  }

  async isPublic(owner: string, repo: string): Promise<boolean> {
    const key = `${owner}/${repo}`.toLowerCase();
    if (!this.visibility.has(key)) {
      const { data } = await this.octokit.repos.get({ owner, repo });
      this.visibility.set(key, !data.private);
    }
    return this.visibility.get(key)!;
  }

  async viewer(): Promise<string> {
    const { data } = await this.octokit.users.getAuthenticated();
    return data.login;
  }

  async issueComments(owner: string, repo: string, number: number): Promise<IssueComment[]> {
    const data = await this.octokit.paginate(this.octokit.issues.listComments, { owner, repo, issue_number: number, per_page: 100 });
    return data.map(comment => ({ id: comment.id, author: comment.user?.login ?? "unknown", body: comment.body ?? "" }));
  }

  async defaultBranch(owner: string, repo: string): Promise<string> {
    const key = `${owner}/${repo}`;
    if (!this.branches.has(key)) {
      const { data } = await this.octokit.repos.get({ owner, repo });
      this.branches.set(key, data.default_branch);
    }
    return this.branches.get(key)!;
  }

  async issuesWithLabel(owner: string, repo: string, label: string): Promise<Issue[]> {
    const data = await this.octokit.paginate(this.octokit.issues.listForRepo, { owner, repo, labels: label, state: "open", per_page: 100 });
    return data.filter(item => !item.pull_request).map(item => toIssue(owner, repo, item));
  }

  async openIssues(owner: string, repo: string, since?: string): Promise<Issue[]> {
    const data = await this.octokit.paginate(this.octokit.issues.listForRepo, {
      owner, repo, state: "open", per_page: 100, sort: "created", direction: "desc", ...(since ? { since } : {}),
    });
    return data.filter(item => !item.pull_request).map(item => toIssue(owner, repo, item));
  }

  async issue(owner: string, repo: string, number: number): Promise<Issue> {
    const { data } = await this.octokit.issues.get({ owner, repo, issue_number: number });
    return toIssue(owner, repo, data);
  }

  async addLabels(owner: string, repo: string, number: number, labels: string[]): Promise<void> {
    await this.octokit.issues.addLabels({ owner, repo, issue_number: number, labels });
  }

  async removeLabel(owner: string, repo: string, number: number, label: string): Promise<void> {
    try {
      await this.octokit.issues.removeLabel({ owner, repo, issue_number: number, name: label });
    } catch (error) {
      if ((error as { status?: number }).status !== 404) throw error;
    }
  }

  /** Every runner comment carries RUNNER_MARKER so it is never mistaken for a note from the owner. */
  async comment(owner: string, repo: string, number: number, body: string): Promise<void> {
    await this.octokit.issues.createComment({ owner, repo, issue_number: number, body: `${body.slice(0, 64_000)}\n\n${RUNNER_MARKER}` });
  }

  /** A comment written on the owner's behalf (`runner say`): no runner marker, so it counts as a note. */
  async note(owner: string, repo: string, number: number, body: string): Promise<string> {
    const { data } = await this.octokit.issues.createComment({ owner, repo, issue_number: number, body: body.slice(0, 65_000) });
    return data.html_url;
  }

  async closeIssue(owner: string, repo: string, number: number): Promise<void> {
    await this.octokit.issues.update({ owner, repo, issue_number: number, state: "closed", state_reason: "completed" });
  }

  async createIssue(owner: string, repo: string, title: string, body: string, labels: string[]): Promise<Issue> {
    const { data } = await this.octokit.issues.create({ owner, repo, title: title.slice(0, 250), body: body.slice(0, 65_000), labels });
    return toIssue(owner, repo, data);
  }

  async findPull(owner: string, repo: string, branch: string): Promise<PullRequest | null> {
    const { data } = await this.octokit.pulls.list({ owner, repo, head: `${owner}:${branch}`, state: "all", per_page: 5 });
    const latest = data.sort((a, b) => b.number - a.number)[0];
    return latest ? this.pull(owner, repo, latest.number) : null;
  }

  async pull(owner: string, repo: string, number: number): Promise<PullRequest> {
    const { data } = await this.octokit.pulls.get({ owner, repo, pull_number: number });
    return {
      number: data.number, url: data.html_url, state: data.state as "open" | "closed", merged: data.merged,
      headSha: data.head.sha, mergeCommitSha: data.merged ? data.merge_commit_sha : null,
    };
  }

  /** A PR with the detail the staff chat shows (title, body, branches, draft). */
  async pullDetails(owner: string, repo: string, number: number): Promise<PullDetails> {
    const { data } = await this.octokit.pulls.get({ owner, repo, pull_number: number });
    return {
      number: data.number, url: data.html_url, title: data.title, body: data.body ?? "", state: data.state as "open" | "closed",
      merged: data.merged, draft: Boolean(data.draft), headSha: data.head.sha, headRef: data.head.ref, baseRef: data.base.ref,
      author: data.user?.login ?? "unknown",
    };
  }

  async openPulls(owner: string, repo: string): Promise<{ number: number; title: string; headRef: string; author: string; draft: boolean }[]> {
    const { data } = await this.octokit.pulls.list({ owner, repo, state: "open", per_page: 50 });
    return data.map(pr => ({ number: pr.number, title: pr.title, headRef: pr.head.ref, author: pr.user?.login ?? "unknown", draft: Boolean(pr.draft) }));
  }

  async createPull(owner: string, repo: string, input: { head: string; base: string; title: string; body: string }): Promise<PullRequest> {
    const { data } = await this.octokit.pulls.create({ owner, repo, ...input, body: input.body.slice(0, 65_000) });
    return this.pull(owner, repo, data.number);
  }

  async updatePull(owner: string, repo: string, number: number, body: string): Promise<void> {
    await this.octokit.pulls.update({ owner, repo, pull_number: number, body: body.slice(0, 65_000) });
  }

  async ciState(owner: string, repo: string, sha: string): Promise<CiState> {
    const [runs, statuses] = await Promise.all([
      this.octokit.paginate(this.octokit.checks.listForRef, { owner, repo, ref: sha, per_page: 100 }),
      this.octokit.repos.getCombinedStatusForRef({ owner, repo, ref: sha }),
    ]);
    return combineCi(
      runs.map(run => ({ status: run.status, conclusion: run.conclusion })),
      statuses.data.statuses.map(status => status.state),
    );
  }

  async merge(owner: string, repo: string, number: number, sha: string, title: string): Promise<string> {
    // `sha` guards against merging commits that were pushed after review.
    const { data } = await this.octokit.pulls.merge({ owner, repo, pull_number: number, sha, merge_method: "squash", commit_title: title });
    return data.sha;
  }

  async ensureLabels(owner: string, repo: string, labels: Labels): Promise<void> {
    const existing = new Set((await this.octokit.paginate(this.octokit.issues.listLabelsForRepo, { owner, repo, per_page: 100 }))
      .map(label => label.name.toLowerCase()));
    for (const key of Object.keys(labels) as (keyof Labels)[]) {
      if (existing.has(labels[key].toLowerCase())) continue;
      await this.octokit.issues.createLabel({ owner, repo, name: labels[key], color: LABEL_COLORS[key], description: LABEL_DESCRIPTIONS[key] });
    }
  }
}

export function combineCi(runs: { status: string; conclusion: string | null }[], statuses: string[]): CiState {
  if (runs.length === 0 && statuses.length === 0) return "none";
  const okConclusions = new Set(["success", "neutral", "skipped"]);
  if (runs.some(run => run.status === "completed" && !okConclusions.has(run.conclusion ?? ""))) return "failure";
  if (statuses.some(state => state === "failure" || state === "error")) return "failure";
  if (runs.some(run => run.status !== "completed") || statuses.some(state => state === "pending")) return "pending";
  return "success";
}

function toIssue(owner: string, repo: string, item: {
  number: number; title: string; body?: string | null; html_url: string; state: string;
  labels: (string | { name?: string })[]; user: { login: string } | null;
}): Issue {
  return {
    owner, repo, number: item.number, title: item.title, body: item.body ?? "", url: item.html_url,
    state: item.state as "open" | "closed",
    labels: item.labels.map(label => typeof label === "string" ? label : label.name ?? "").filter(Boolean),
    author: item.user?.login ?? "unknown",
  };
}
