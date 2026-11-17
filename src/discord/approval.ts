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
/** What the bot reacts with once a stop, continue or cleanup landed. */
export const DONE_EMOJI = "👌";

export const LABELS = {
  proposed: "isobot:proposed",
  ready: "isobot:ready",
  building: "isobot:building",
  review: "isobot:review",
  failed: "isobot:failed",
  stop: "isobot:stop",
  cleanup: "isobot:cleanup",
} as const;

/**
 * The owner's one-click controls. The runner adds them as reactions on its triage digests and job
 * cards (keep in sync with runner/src/notify.ts), so clicking one is all it takes.
 */
export type ReactionAction = "start" | "stop" | "continue" | "cleanup";
export const ACTION_EMOJI: Record<ReactionAction, string> = {
  start: APPROVE_EMOJI,
  stop: "🛑",
  continue: "🔁",
  cleanup: "🧹",
};

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

/** The action a reaction stands for (unicode, or a custom emoji of the same name), or null. */
export function reactionAction(emoji: { name: string | null; id: string | null }): ReactionAction | null {
  if (!emoji.name) return null;
  const strip = (s: string) => s.replace(/\uFE0F/g, "");
  const name = strip(emoji.name);
  return (Object.keys(ACTION_EMOJI) as ReactionAction[]).find(action => strip(ACTION_EMOJI[action]) === name) ?? null;
}

/** Whether a reaction is the approval emoji. */
export function isApproveEmoji(emoji: { name: string | null; id: string | null }): boolean {
  return reactionAction(emoji) === "start";
}

/** Label changes for a reaction, "noop" when the issue is already there, or "refuse". */
export type Plan = { add: string[]; remove: string[] } | "noop" | "refuse";

export function planFor(action: ReactionAction, issue: { state: string; labels: string[] }): Plan {
  const labels = new Set(issue.labels.map(l => l.toLowerCase()));
  if (issue.state !== "open") return "refuse";
  const inFlight = labels.has(LABELS.ready) || labels.has(LABELS.building) || labels.has(LABELS.review);
  switch (action) {
    case "start": {
      const decision = approvalFor(issue);
      return decision === "approve" ? { add: [LABELS.ready], remove: [] } : decision === "in_flight" ? "noop" : "refuse";
    }
    case "stop":
      // Withdraws a pending approval too, so nothing gets claimed after the stop.
      return labels.has(LABELS.stop) ? "noop" : { add: [LABELS.stop], remove: labels.has(LABELS.ready) ? [LABELS.ready] : [] };
    case "continue": {
      // Lifts a stop; builds again unless a build or an open PR is already on it (a failed or stopped job starts over).
      const remove = labels.has(LABELS.stop) ? [LABELS.stop] : [];
      const add = inFlight ? [] : [LABELS.ready];
      return add.length || remove.length ? { add, remove } : "noop";
    }
    case "cleanup":
      // The runner does the rest (local workspaces, labels, closing the issue); stop first so a running build ends.
      if (labels.has(LABELS.cleanup)) return "noop";
      return {
        add: [...(labels.has(LABELS.building) && !labels.has(LABELS.stop) ? [LABELS.stop] : []), LABELS.cleanup],
        remove: labels.has(LABELS.ready) ? [LABELS.ready] : [],
      };
  }
}
