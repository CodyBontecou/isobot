import type { IssueComment } from "./github.js";

/** Appended to every comment the runner writes, so its own words never read as owner notes. */
export const RUNNER_MARKER = "<!-- isobot:runner -->";
/** The bridge's relay of an allowlisted user's reply in a runner job thread. */
export const DISCORD_REPLY_MARKER = "<!-- isobot:discord-reply -->";
/** The bridge's relay of anyone's message in a community #help thread: data, never a note. */
export const COMMUNITY_MARKER = "<!-- isobot:from-discord -->";
/** `runner say` from the terminal. */
export const TERMINAL_MARKER = "<!-- isobot:terminal-note -->";
const PROPOSAL_MARKER = "<!-- isobot:triage:";
/** On issues the staff chat opens for the owner, so the board can show where they came from. */
export const CHAT_MARKER = "<!-- isobot:chat -->";

export type NoteSource = "discord" | "terminal" | "github";

export interface OwnerNote {
  id: number;
  source: NoteSource;
  /** The note without relay headers or markers. */
  text: string;
}

/**
 * Comments after `afterId` that are the owner talking to isobot. A note must be written by a trusted
 * account and must not be isobot's own output or a relay of someone else's words. `relayedByUntrusted`
 * lists Discord replies that arrived through an account the runner doesn't trust (a bridge
 * misconfiguration worth reporting).
 */
export function ownerNotes(comments: IssueComment[], trusted: string[], afterId: number): { notes: OwnerNote[]; relayedByUntrusted: string[] } {
  const trust = new Set(trusted.map(login => login.toLowerCase()));
  const notes: OwnerNote[] = [];
  const relayedByUntrusted: string[] = [];
  for (const comment of comments) {
    if (comment.id <= afterId) continue;
    const body = comment.body;
    if (body.includes(RUNNER_MARKER) || body.includes(PROPOSAL_MARKER) || body.includes(COMMUNITY_MARKER)) continue;
    if (!trust.has(comment.author.toLowerCase())) {
      if (body.includes(DISCORD_REPLY_MARKER)) relayedByUntrusted.push(comment.author);
      continue;
    }
    const source: NoteSource = body.includes(DISCORD_REPLY_MARKER) ? "discord" : body.includes(TERMINAL_MARKER) ? "terminal" : "github";
    const text = cleanNote(body);
    if (text) notes.push({ id: comment.id, source, text });
  }
  return { notes, relayedByUntrusted };
}

/** Strips the bridge's "_Sent from Discord…_" header line and every HTML comment. */
export function cleanNote(body: string): string {
  return body
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/^_Sent from Discord by [^\n]*_[^\n]*\n?/m, "")
    .trim()
    .slice(0, 8000);
}

export function maxCommentId(comments: IssueComment[]): number {
  return comments.reduce((max, c) => Math.max(max, c.id), 0);
}

/** What the builder is told when the owner speaks up mid-build or on an open PR. */
export function noteFeedback(notes: OwnerNote[]): string {
  return [
    `The owner sent ${notes.length === 1 ? "a note" : `${notes.length} notes`} about this change. Apply ${notes.length === 1 ? "it" : "them"} to the work on this branch:`,
    ...notes.map(n => n.text),
  ].join("\n\n---\n\n");
}

const RETRY = /^(?:ok(?:ay)?[,\s]+)?(?:please[,\s]+)?(?:try(?:\s+it)?\s+again|retry|re-?build(?:\s+it)?|build(?:\s+it)?\s+again|re-?run(?:\s+it)?|run(?:\s+it)?\s+again|go\s+again)\b/i;

/** A note asking a finished or failed job to build again ("try again", "retry", "rebuild it, and use…"). */
export function asksToRetry(text: string): boolean {
  return RETRY.test(text.trim());
}

/** A note that is only a retry request, with nothing for the builder to act on. */
export function isBareRetry(text: string): boolean {
  const rest = text.trim().replace(RETRY, "");
  return rest !== text.trim() && /^[\s.!,]*(?:please)?[\s.!]*$/i.test(rest);
}

/** The task plus everything the owner has said since approving it, so reviewers judge against both. */
export function withNotes(task: string, all: OwnerNote[]): string {
  const notes = all.filter(n => !isBareRetry(n.text));
  if (!notes.length) return task;
  return `${task}\n\n## Follow-up notes from the owner (newest last; these take precedence)\n\n${notes.map(n => n.text).join("\n\n---\n\n")}`;
}

export function quoteNote(note: OwnerNote): string {
  const where = note.source === "terminal" ? "the terminal" : "GitHub";
  const lines = note.text.split("\n").slice(0, 12).map(line => `> ${line}`).join("\n");
  return `💬 Note from ${where}:\n${lines.slice(0, 1500)}`;
}
