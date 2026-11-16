import { Octokit } from "@octokit/rest";

export interface CreateIssueInput {
  owner: string;
  repo: string;
  title: string;
  body: string;
  labels?: string[];
}

export interface CreatedIssue {
  number: number;
  url: string;
}

/**
 * Issues from community forum posts are proposals: anyone can post in the forum,
 * so the isobot runner builds them only after the owner adds `isobot:ready`.
 */
export const PROPOSED_LABEL = "isobot:proposed";

let octokit: Octokit | null = null;

function client(): Octokit {
  if (octokit) return octokit;
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is not set");
  octokit = new Octokit({ auth: token, userAgent: "isobot/0.1" });
  return octokit;
}

export async function createIssue(input: CreateIssueInput): Promise<CreatedIssue> {
  const { data } = await client().issues.create({
    owner: input.owner,
    repo: input.repo,
    title: input.title,
    body: input.body,
    labels: [...new Set([...(input.labels ?? []), PROPOSED_LABEL])],
  });
  return { number: data.number, url: data.html_url };
}

export async function updateIssueBody(input: {
  owner: string;
  repo: string;
  number: number;
  body: string;
}): Promise<void> {
  await client().issues.update({
    owner: input.owner,
    repo: input.repo,
    issue_number: input.number,
    body: input.body,
  });
}

export async function createIssueComment(input: {
  owner: string;
  repo: string;
  number: number;
  body: string;
}): Promise<void> {
  await client().issues.createComment({
    owner: input.owner,
    repo: input.repo,
    issue_number: input.number,
    body: input.body,
  });
}

export interface IssueState {
  state: string;
  labels: string[];
}

export async function getIssue(input: { owner: string; repo: string; number: number }): Promise<IssueState> {
  const { data } = await client().issues.get({ owner: input.owner, repo: input.repo, issue_number: input.number });
  return {
    state: data.state,
    labels: data.labels.map((l) => (typeof l === "string" ? l : l.name ?? "")).filter(Boolean),
  };
}

export async function addLabels(input: { owner: string; repo: string; number: number; labels: string[] }): Promise<void> {
  await client().issues.addLabels({ owner: input.owner, repo: input.repo, issue_number: input.number, labels: input.labels });
}

export async function removeLabel(input: { owner: string; repo: string; number: number; label: string }): Promise<void> {
  try {
    await client().issues.removeLabel({ owner: input.owner, repo: input.repo, issue_number: input.number, name: input.label });
  } catch (err) {
    if ((err as { status?: number }).status !== 404) throw err;
  }
}
