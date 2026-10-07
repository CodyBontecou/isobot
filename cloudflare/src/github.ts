import repoMappings from "../../src/config/repos.json";

export interface TicketIssueInput {
  token: string;
  repo: { owner: string; repo: string };
  eventId: string;
  parent: { content: string; jumpUrl: string };
  title: string;
  body: string;
  labels?: string[];
}

export interface TicketIssue {
  number: number;
  url: string;
}

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_LIST_PAGES = 10;
const REQUEST_TIMEOUT_MS = 15_000;
const CODEX_INSTRUCTION = "@codex implement this";

class GitHubError extends Error {}

/** Scan the REST listing, rather than search, so retries do not depend on search indexing. */
export async function createTicketIssue(
  input: TicketIssueInput,
  fetcher: typeof fetch = fetch,
): Promise<TicketIssue> {
  const target = Object.values(repoMappings).find(
    (repo) => repo.owner.toLowerCase() === input.repo.owner.toLowerCase()
      && repo.repo.toLowerCase() === input.repo.repo.toLowerCase(),
  );
  if (!target) throw new Error("Repository is not allowed for isobot");
  if (!input.token) throw new Error("GitHub token is not configured");
  if (!/^\d{1,20}$/.test(input.eventId)) throw new Error("Invalid Discord event ID");
  if (!/^https:\/\/(?:discord\.com|discordapp\.com)\/channels\/(?:@me|\d{1,20})\/\d{1,20}\/\d{1,20}$/.test(input.parent.jumpUrl)) {
    throw new Error("Invalid Discord source link");
  }
  const title = input.title.trim();
  if (!title || title.length > 256 || !input.body.trim()) {
    throw new Error("Issue title and body are required; title must be at most 256 characters");
  }
  if (input.labels && (input.labels.length > 10 || input.labels.some((label) => typeof label !== "string" || !label.trim() || label.length > 50))) {
    throw new Error("Invalid GitHub labels");
  }

  const marker = `<!-- isobot:discord-event:${input.eventId} -->`;
  const quote = input.parent.content.split("\n").map((line) => `> ${line}`).join("\n");
  const body = [input.body.trim(), "### Original Discord message", quote,
    `Source: [Discord message](${input.parent.jumpUrl})`, marker,
    ...(input.body.includes(CODEX_INSTRUCTION) ? [] : [CODEX_INSTRUCTION])].join("\n\n");
  if (body.length > 65_000) throw new Error("Issue body is too long");

  const endpoint = `https://api.github.com/repos/${target.owner}/${target.repo}/issues`;
  const since = new Date(Number((BigInt(input.eventId) >> 22n) + 1_420_070_400_000n) - 86_400_000).toISOString();
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${input.token}`,
    "X-GitHub-Api-Version": "2026-03-10",
    "User-Agent": "isobot-pi/0.1",
    "Content-Type": "application/json",
  };

  const result = (issue: Record<string, unknown>): TicketIssue => {
    if (!Number.isSafeInteger(issue.number) || Number(issue.number) <= 0) {
      throw new GitHubError("GitHub returned an invalid issue response");
    }
    const number = Number(issue.number);
    return { number, url: `https://github.com/${target.owner}/${target.repo}/issues/${number}` };
  };

  let fullyScanned = false;
  for (let page = 1; page <= MAX_LIST_PAGES; page++) {
    const query = new URLSearchParams({ state: "all", sort: "created", direction: "desc", since, per_page: "100", page: String(page) });
    const issues = await githubRequest(`${endpoint}?${query}`, { headers }, 200, fetcher);
    if (!Array.isArray(issues) || issues.length > 100) throw new GitHubError("GitHub returned an invalid issue listing");
    for (const issue of issues) {
      if (!isRecord(issue) || (issue.body !== null && typeof issue.body !== "string")) {
        throw new GitHubError("GitHub returned an invalid issue listing");
      }
      if (!issue.pull_request && typeof issue.body === "string" && issue.body.includes(marker)) {
        return result(issue);
      }
    }
    if (issues.length < 100) {
      fullyScanned = true;
      break;
    }
  }
  if (!fullyScanned) throw new GitHubError("GitHub duplicate check exceeded its page limit; no issue was created");

  // No automatic POST retry: an interrupted request may still be committing on GitHub.
  // A later invocation reconciles the marker first, but GitHub provides no atomic idempotency key.
  const created = await githubRequest(endpoint, {
    method: "POST", headers, body: JSON.stringify({ title, body, ...(input.labels ? { labels: input.labels } : {}) }),
  }, 201, fetcher);
  if (!isRecord(created)) throw new GitHubError("GitHub returned an invalid issue response");
  return result(created);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function githubRequest(url: string, init: RequestInit, status: number, fetcher: typeof fetch): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetcher(url, { ...init, signal: controller.signal, redirect: "error" });
    if (response.status !== status) {
      await response.body?.cancel();
      throw new GitHubError(`GitHub request failed (HTTP ${response.status})`);
    }
    if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) {
      await response.body?.cancel();
      throw new GitHubError("GitHub response exceeded its size limit");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new GitHubError("GitHub returned an empty response");
    const decoder = new TextDecoder();
    let text = "";
    let bytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new GitHubError("GitHub response exceeded its size limit");
      }
      text += decoder.decode(value, { stream: true });
    }
    try { return JSON.parse(text + decoder.decode()); }
    catch { throw new GitHubError("GitHub returned an invalid JSON response"); }
  } catch (error) {
    if (error instanceof GitHubError) throw error;
    throw new GitHubError(init.method === "POST"
      ? "GitHub creation failed or timed out; it may have completed. Retry the same Discord event to reconcile."
      : "GitHub duplicate check failed or timed out; no issue was created");
  } finally {
    clearTimeout(timeout);
  }
}
