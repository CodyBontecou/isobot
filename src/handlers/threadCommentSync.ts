import {
  Events,
  ChannelType,
  type AnyThreadChannel,
  type Client,
  type Message,
} from "discord.js";
import { createIssueComment } from "../github/issues.js";

const ISSUE_URL_RE = /https:\/\/github\.com\/([^\/\s]+)\/([^\/\s]+)\/issues\/(\d+)/;
const FROM_DISCORD_MARKER = "<!-- isobot:from-discord -->";

interface IssueRef {
  owner: string;
  repo: string;
  number: number;
}

const threadIssueCache = new Map<string, IssueRef>();

export function registerThreadCommentSync(client: Client): void {
  client.on(Events.MessageCreate, async (message: Message) => {
    try {
      if (message.author.bot) return;
      if (!message.channel.isThread()) return;

      const thread = message.channel as AnyThreadChannel;
      const parent = thread.parent;
      if (!parent || parent.type !== ChannelType.GuildForum) return;
      if (parent.name.toLowerCase() !== "help") return;

      const botId = client.user?.id;
      if (botId && new RegExp(`<@!?${botId}>`).test(message.content)) return;

      const ref = await findIssueRef(thread, botId);
      if (!ref) return;

      const body = formatBody(message);
      if (!body) return;

      await createIssueComment({ owner: ref.owner, repo: ref.repo, number: ref.number, body });
      console.log(
        `[isobot] mirrored Discord msg ${message.id} -> ${ref.owner}/${ref.repo}#${ref.number}`,
      );
    } catch (err) {
      console.error("[isobot] threadCommentSync error:", err);
    }
  });
}

async function findIssueRef(thread: AnyThreadChannel, botId: string | undefined): Promise<IssueRef | null> {
  const cached = threadIssueCache.get(thread.id);
  if (cached) return cached;
  try {
    const msgs = await thread.messages.fetch({ limit: 30 });
    for (const m of msgs.values()) {
      if (botId && m.author.id !== botId) continue;
      const match = m.content.match(ISSUE_URL_RE);
      if (match) {
        const ref = { owner: match[1], repo: match[2], number: Number(match[3]) };
        threadIssueCache.set(thread.id, ref);
        return ref;
      }
    }
  } catch (err) {
    console.error(`[isobot] findIssueRef(${thread.id}) failed:`, err);
  }
  return null;
}

function formatBody(m: Message): string | null {
  const text = (m.content ?? "").trim();
  const attachments = m.attachments.size > 0
    ? Array.from(m.attachments.values()).map((a) => `[attachment] ${a.url}`).join("\n")
    : "";

  if (!text && !attachments) return null;

  const truncated = text.length > 5000 ? text.slice(0, 5000) + "…" : text;
  const parts = [`_Posted by **${m.author.tag}** on Discord_ ([view message](${m.url}))`, ""];
  if (truncated) parts.push(truncated);
  if (attachments) {
    if (truncated) parts.push("");
    parts.push(attachments);
  }
  parts.push("", FROM_DISCORD_MARKER);
  return parts.join("\n");
}
