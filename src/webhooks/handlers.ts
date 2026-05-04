import { ChannelType, type AnyThreadChannel, type Client, type ForumChannel } from "discord.js";
import { handleIssueOpened, type IssueOpenedPayload } from "./issueOpened.js";

const THREAD_ID_RE = /<!--\s*isobot:discord-thread:(\d+)\s*-->/;
const FROM_DISCORD_MARKER = "<!-- isobot:from-discord -->";

const LABEL_TO_TAG: Record<string, string> = {
  bug: "Bug",
  enhancement: "Feature Request",
  question: "Question",
};

interface IssueLikePayload {
  action: string;
  issue: {
    number: number;
    html_url: string;
    title: string;
    body: string | null;
  };
  comment?: {
    html_url: string;
    body: string;
    user: { login: string; type: string };
  };
  label?: { name: string };
  sender: { login: string; type: string };
  repository: { full_name: string };
}

export async function handleEvent(client: Client, event: string | undefined, payload: unknown): Promise<void> {
  if (!event || event === "ping") {
    console.log(`[webhook] ${event ?? "(none)"} ignored`);
    return;
  }
  if (event !== "issues" && event !== "issue_comment") {
    console.log(`[webhook] ${event} ignored (not subscribed)`);
    return;
  }
  await routeIssueEvent(client, event, payload as IssueLikePayload);
}

async function routeIssueEvent(client: Client, event: string, payload: IssueLikePayload): Promise<void> {
  const tag = `${payload.repository?.full_name ?? "?"}#${payload.issue?.number ?? "?"} ${event}.${payload.action}`;

  if (event === "issues" && payload.action === "opened") {
    await handleIssueOpened(client, payload as unknown as IssueOpenedPayload);
    return;
  }

  const threadId = extractThreadId(payload.issue?.body ?? null);
  if (!threadId) {
    console.log(`[webhook] ${tag}: no isobot:discord-thread sentinel in issue body, skipping`);
    return;
  }
  console.log(`[webhook] ${tag}: thread=${threadId}`);

  if (event === "issue_comment" && payload.action === "created" && payload.comment) {
    if (payload.comment.user.type === "Bot") {
      console.log(`[webhook] ${tag}: comment from Bot ${payload.comment.user.login}, skipping`);
      return;
    }
    if (payload.comment.body.includes(FROM_DISCORD_MARKER)) {
      console.log(`[webhook] ${tag}: comment has from-discord marker, skipping`);
      return;
    }
    const thread = await fetchThread(client, threadId);
    if (!thread) {
      console.log(`[webhook] ${tag}: thread ${threadId} not fetchable`);
      return;
    }
    await thread.send({
      content: formatGitHubComment(payload.comment.user.login, payload.comment.body, payload.comment.html_url),
      allowedMentions: { parse: [] },
    });
    console.log(`[webhook] ${tag}: posted comment in thread ${threadId}`);
    return;
  }

  if (event === "issues") {
    if (payload.action === "closed" || payload.action === "reopened") {
      const thread = await fetchThread(client, threadId);
      if (!thread) {
        console.log(`[webhook] ${tag}: thread ${threadId} not fetchable`);
        return;
      }
      const verb = payload.action === "closed" ? "closed" : "reopened";
      await thread.send({
        content: `Issue ${verb} on GitHub by **${payload.sender.login}** — ${payload.issue.html_url}`,
        allowedMentions: { parse: [] },
      });
      await syncTagByName(thread, "Solved", payload.action === "closed");
      console.log(`[webhook] ${tag}: posted ${verb} message in thread ${threadId}`);
      return;
    }
    if (payload.action === "labeled" || payload.action === "unlabeled") {
      const labelName = payload.label?.name?.toLowerCase();
      if (!labelName) return;
      const tagName = LABEL_TO_TAG[labelName];
      if (!tagName) {
        console.log(`[webhook] ${tag}: label '${labelName}' not in mapping, skipping`);
        return;
      }
      const thread = await fetchThread(client, threadId);
      if (!thread) return;
      await syncTagByName(thread, tagName, payload.action === "labeled");
      console.log(`[webhook] ${tag}: ${payload.action} '${labelName}' -> tag '${tagName}'`);
      return;
    }
    console.log(`[webhook] ${tag}: action not handled`);
  }
}

function extractThreadId(body: string | null): string | null {
  if (!body) return null;
  const m = body.match(THREAD_ID_RE);
  return m ? m[1] : null;
}

async function fetchThread(client: Client, threadId: string): Promise<AnyThreadChannel | null> {
  try {
    const ch = await client.channels.fetch(threadId);
    if (!ch || !ch.isThread()) return null;
    return ch as AnyThreadChannel;
  } catch (err) {
    console.error(`[isobot] fetchThread(${threadId}) failed:`, err);
    return null;
  }
}

function formatGitHubComment(author: string, rawBody: string, url: string): string {
  const stripped = rawBody.replace(/<!--\s*isobot:[^>]*-->/g, "").trim();
  const truncated = stripped.length > 1500 ? stripped.slice(0, 1500) + "…" : stripped;
  const quoted = truncated.split("\n").map((l) => `> ${l}`).join("\n");
  return `**${author}** commented on GitHub:\n${quoted}\n\n[view on GitHub](${url})`;
}

async function syncTagByName(thread: AnyThreadChannel, tagName: string, add: boolean): Promise<void> {
  const parent = thread.parent;
  if (!parent || parent.type !== ChannelType.GuildForum) return;
  const forum = parent as ForumChannel;
  const tag = forum.availableTags.find((t) => t.name.toLowerCase() === tagName.toLowerCase());
  if (!tag) return;
  const current = new Set(thread.appliedTags ?? []);
  if (add) current.add(tag.id);
  else current.delete(tag.id);
  try {
    await thread.setAppliedTags(Array.from(current));
  } catch (err) {
    console.error(`[isobot] setAppliedTags failed on ${thread.id}:`, err);
  }
}
