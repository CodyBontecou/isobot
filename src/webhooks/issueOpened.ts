import type { Client } from "discord.js";
import { findHelpForum } from "../lib/discord.js";
import { repoToCategoryKey } from "../config/repos.js";
import { updateIssueBody } from "../github/issues.js";

const SENTINEL_RE = /<!--\s*isobot:discord-thread:(\d+)\s*-->/;

const LABEL_TO_TAG: Record<string, string> = {
  bug: "Bug",
  enhancement: "Feature Request",
  question: "Question",
};

export interface IssueOpenedPayload {
  action: string;
  issue: {
    number: number;
    title: string;
    body: string | null;
    html_url: string;
    user: { login: string; type: string };
    labels: { name: string }[];
  };
  sender: { login: string; type: string };
  repository: { full_name: string; name: string; owner: { login: string } };
}

const recentlyHandled = new Map<string, number>();
const DEDUPE_TTL_MS = 10 * 60 * 1000;

function rememberHandled(key: string): void {
  const now = Date.now();
  for (const [k, exp] of recentlyHandled) if (exp < now) recentlyHandled.delete(k);
  recentlyHandled.set(key, now + DEDUPE_TTL_MS);
}

function wasRecentlyHandled(key: string): boolean {
  const exp = recentlyHandled.get(key);
  if (exp === undefined) return false;
  if (exp < Date.now()) {
    recentlyHandled.delete(key);
    return false;
  }
  return true;
}

export async function handleIssueOpened(client: Client, payload: IssueOpenedPayload): Promise<void> {
  const tag = `${payload.repository.full_name}#${payload.issue.number} issues.opened`;

  if (payload.issue.body && SENTINEL_RE.test(payload.issue.body)) {
    console.log(`[webhook] ${tag}: body already has discord-thread sentinel, skipping`);
    return;
  }

  const dedupeKey = `${payload.repository.full_name}#${payload.issue.number}`;
  if (wasRecentlyHandled(dedupeKey)) {
    console.log(`[webhook] ${tag}: recently handled, skipping`);
    return;
  }
  rememberHandled(dedupeKey);

  const target = {
    owner: payload.repository.owner.login,
    repo: payload.repository.name,
  };
  const categoryName = repoToCategoryKey(target);
  if (!categoryName) {
    console.log(`[webhook] ${tag}: repo not mapped in repos.json`);
    return;
  }

  const forum = findHelpForum(client, categoryName);
  if (!forum) {
    console.log(`[webhook] ${tag}: no #help forum under category '${categoryName}'`);
    return;
  }

  const tagIds: string[] = [];
  for (const label of payload.issue.labels) {
    const tagName = LABEL_TO_TAG[label.name.toLowerCase()];
    if (!tagName) continue;
    const t = forum.availableTags.find((x) => x.name.toLowerCase() === tagName.toLowerCase());
    if (t) tagIds.push(t.id);
  }

  const title = (payload.issue.title || `Issue #${payload.issue.number}`).slice(0, 100);
  const author = payload.issue.user.login;
  const issueUrl = payload.issue.html_url;
  const rawBody = (payload.issue.body ?? "").trim();
  const truncated = rawBody.length > 1500 ? rawBody.slice(0, 1500) + "…" : rawBody;
  const quoted = truncated
    ? truncated.split("\n").map((l) => `> ${l}`).join("\n")
    : "> _(no description)_";

  const starterContent = [
    `**Tracked from GitHub:** ${issueUrl}`,
    `_Opened by **${author}**_`,
    "",
    quoted,
  ].join("\n");

  let thread;
  try {
    thread = await forum.threads.create({
      name: title,
      message: { content: starterContent, allowedMentions: { parse: [] } },
      appliedTags: tagIds,
    });
  } catch (err) {
    console.error(`[webhook] ${tag}: failed to create thread:`, err);
    return;
  }

  console.log(`[webhook] ${tag}: created Discord thread ${thread.id} in #${forum.name}`);

  const sentinel = `<!-- isobot:discord-thread:${thread.id} -->`;
  const newBody = rawBody ? `${rawBody}\n\n${sentinel}` : sentinel;
  try {
    await updateIssueBody({
      owner: target.owner,
      repo: target.repo,
      number: payload.issue.number,
      body: newBody,
    });
    console.log(`[webhook] ${tag}: patched issue body with sentinel`);
  } catch (err) {
    console.error(`[webhook] ${tag}: failed to patch issue body:`, err);
  }
}
