/**
 * Failures that say nothing about the issue itself: the network, GitHub, or the
 * model being unavailable. These are retried later instead of marking the issue failed.
 */
export class TransientError extends Error {
  constructor(message: string, readonly retryAfterMs?: number, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/** Claude subscription usage limit: every build pauses until it resets. */
export class UsageLimitError extends TransientError {}

const NETWORK = /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|socket hang up|fetch failed|network|Could not resolve host|Connection (reset|timed out|refused)|early EOF|unexpected disconnect|RPC failed|The remote end hung up|Operation timed out|TLS/i;
const USAGE = /usage limit|hit your limit|limit reached|rate.?limit|too many requests/i;
const OVERLOADED = /overloaded|529|API Error: 5\d\d|internal server error|service unavailable|bad gateway/i;
/** git over HTTPS when GitHub throttles or fails (`The requested URL returned error: 429`). */
const GIT_HTTP = /The requested URL returned error: (429|5\d\d)\b/;
const AUTH = /not logged in|please run \/login|invalid api key|authentication|OAuth token (has )?expired|credential/i;

/** Classifies a model (Claude Code) failure message. */
export function classifyModelFailure(message: string): Error {
  if (USAGE.test(message)) return new UsageLimitError(`Claude usage limit: ${message.slice(0, 300)}`, parseReset(message));
  if (OVERLOADED.test(message) || NETWORK.test(message)) return new TransientError(`Claude unavailable: ${message.slice(0, 300)}`);
  if (AUTH.test(message)) return new TransientError(`Claude Code is not signed in (run \`claude\` to sign in, or set CLAUDE_CODE_OAUTH_TOKEN): ${message.slice(0, 200)}`, 30 * 60_000);
  return new Error(message);
}

/** Whether an arbitrary error (GitHub, git, model) is worth retrying later. */
export function isTransient(error: unknown): boolean {
  if (error instanceof TransientError) return true;
  const status = (error as { status?: number })?.status;
  if (typeof status === "number" && (status >= 500 || status === 429)) return true;
  const message = error instanceof Error ? `${error.message} ${String((error as { cause?: unknown }).cause ?? "")}` : String(error);
  return NETWORK.test(message) || OVERLOADED.test(message) || GIT_HTTP.test(message);
}

/** Best effort: "resets 3pm", "resets at 2026-11-16T15:00Z", or a unix timestamp after a pipe. */
export function parseReset(message: string, now = Date.now()): number | undefined {
  const epoch = /\|(\d{10})\b/.exec(message);
  if (epoch) return Math.max(60_000, Number(epoch[1]) * 1000 - now);
  const iso = /resets?\s+(?:at\s+)?(\d{4}-\d\d-\d\dT[\d:.]+Z?)/i.exec(message);
  if (iso && Number.isFinite(Date.parse(iso[1]))) return Math.max(60_000, Date.parse(iso[1]) - now);
  return undefined;
}
