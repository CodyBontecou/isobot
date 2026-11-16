import type { AnyThreadChannel, Message } from "discord.js";

/**
 * The isobot runner posts one status card per build job and opens a thread under it. Replies there
 * from allowlisted users are relayed to the GitHub issue, where the runner reads them as owner notes.
 * Keep these markers in sync with runner/src/notes.ts.
 */
export const DISCORD_REPLY_MARKER = "<!-- isobot:discord-reply -->";
/** The runner's card footer always starts with this. */
const CARD_FOOTER = "Reply in the thread";
const ISSUE_URL_RE = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/issues\/(\d+)$/;

export interface IssueRef {
  owner: string;
  repo: string;
  number: number;
}

interface StarterLike {
  author: { id: string };
  embeds: { url: string | null; footer: { text: string } | null }[];
}

/** The issue a runner card is about, or null if the message isn't a runner card from this bot. */
export function cardIssue(starter: StarterLike, botId: string | undefined): IssueRef | null {
  if (!botId || starter.author.id !== botId) return null;
  const embed = starter.embeds[0];
  if (!embed?.url || !embed.footer?.text.startsWith(CARD_FOOTER)) return null;
  const match = ISSUE_URL_RE.exec(embed.url);
  return match ? { owner: match[1], repo: match[2], number: Number(match[3]) } : null;
}

const cache = new Map<string, IssueRef | null>();

/** Whether a thread hangs off a runner job card (optionally only in ISOBOT_RUNNER_CHANNEL_ID). */
export async function runnerJobIssue(thread: AnyThreadChannel, botId: string | undefined): Promise<IssueRef | null> {
  if (cache.has(thread.id)) return cache.get(thread.id)!;
  const channel = process.env.ISOBOT_RUNNER_CHANNEL_ID;
  let ref: IssueRef | null = null;
  if (!channel || thread.parentId === channel) {
    try {
      ref = cardIssue(await thread.fetchStarterMessage() as unknown as StarterLike, botId);
    } catch {
      // Not started from a message, or the card was deleted: not a job thread.
    }
  }
  if (cache.size > 2000) cache.clear();
  cache.set(thread.id, ref);
  return ref;
}

/** The issue comment for a reply. Markers in the text are defused so only the bridge can write them. */
export function relayBody(input: { authorTag: string; url: string; content: string; attachments: string[]; botId?: string }): string | null {
  let text = input.content;
  if (input.botId) text = text.replace(new RegExp(`<@!?${input.botId}>`, "g"), "");
  text = text.replaceAll("<!--", "&lt;!--").trim();
  if (text.length > 6000) text = `${text.slice(0, 6000)}…`;
  const files = input.attachments.map(url => `[attachment] ${url}`).join("\n");
  if (!text && !files) return null;
  return [`_Sent from Discord by **${input.authorTag.replaceAll("*", "")}** ([message](${input.url}))_`, "", text, files, "", DISCORD_REPLY_MARKER]
    .filter((part, i, all) => part !== "" || all[i - 1] !== "")
    .join("\n");
}

export function messageRelayBody(message: Message, botId: string | undefined): string | null {
  return relayBody({
    authorTag: message.author.tag, url: message.url, content: message.content ?? "",
    attachments: [...message.attachments.values()].map(a => a.url), botId,
  });
}
