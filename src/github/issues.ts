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
    labels: input.labels,
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
