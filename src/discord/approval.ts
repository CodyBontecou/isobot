/**
 * Owner approval by Discord reaction. A ✅ from an allowlisted user on a message about a GitHub issue
 * adds the runner's ready label, which the bridge's GitHub token (the owner's account) sets, so the
 * runner's "who added it" check passes. Keep the label names in sync with runner/config/isobot.json.
 */
export const APPROVE_EMOJI = process.env.ISOBOT_APPROVE_EMOJI || "✅";
/** What the bot reacts with once approval landed (or the issue is already being built). */
export const APPROVED_EMOJI = "🏗️";
/** What the bot reacts with when the issue can't be approved (closed, or stopped). */
export const REFUSED_EMOJI = "🚫";

export const LABELS = {
  ready: "isobot:ready",
  building: "isobot:building",
  review: "isobot:review",
  stop: "isobot:stop",
} as const;

export interface IssueRef {
  owner: string;
  repo: string;
  number: number;
}

const ISSUE_URL_RE = /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/issues\/(\d+)/g;

/** Every distinct issue a piece of text links to. */
export function issueLinks(text: string): IssueRef[] {
  const seen = new Map<string, IssueRef>();
  for (const match of text.matchAll(ISSUE_URL_RE)) {
    const ref = { owner: match[1], repo: match[2], number: Number(match[3]) };
    seen.set(`${ref.owner}/${ref.repo}#${ref.number}`.toLowerCase(), ref);
  }
  return [...seen.values()];
}

interface MessageLike {
  author: { id: string };
  content: string;
  embeds: { url: string | null }[];
}

/**
 * The issue a bot message is about: it must come from this bot and link exactly one issue, in its
 * text or an embed (runner job cards). Digests that list several issues are ambiguous, so they don't count.
 */
export function messageIssue(message: MessageLike, botId: string | undefined): IssueRef | null {
  if (!botId || message.author.id !== botId) return null;
  const links = issueLinks([message.content, ...message.embeds.map(e => e.url ?? "")].join("\n"));
  return links.length === 1 ? links[0] : null;
}

export type Approval = "approve" | "in_flight" | "refuse";

/** What a ✅ on an issue should do, given its state and labels. */
export function approvalFor(issue: { state: string; labels: string[] }): Approval {
  const labels = new Set(issue.labels.map(l => l.toLowerCase()));
  if (issue.state !== "open" || labels.has(LABELS.stop)) return "refuse";
  if (labels.has(LABELS.ready) || labels.has(LABELS.building) || labels.has(LABELS.review)) return "in_flight";
  return "approve";
}

/** Whether a reaction is the approval emoji (unicode, or a custom emoji of the same name). */
export function isApproveEmoji(emoji: { name: string | null; id: string | null }): boolean {
  if (!emoji.name) return false;
  const strip = (s: string) => s.replace(/️/g, "");
  return strip(emoji.name) === strip(APPROVE_EMOJI);
}
