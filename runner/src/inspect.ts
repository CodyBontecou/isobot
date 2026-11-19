import { describeEvent } from "./events.js";
import type { FollowUp, Store, StoredEvent } from "./store.js";

/** One timeline line: local time, job, and what happened. */
export function formatEvent(event: StoredEvent): string {
  const at = new Date(event.at);
  const time = `${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")} ${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  return `${time}  ${(event.jobId ?? "runner").padEnd(32)} ${describeEvent(event.kind, event.detail, event.data)}`;
}

/** What the runner will check on next: PRs waiting for CI and jobs waiting on other issues. */
export function followUpLines(followUps: FollowUp[], now = new Date()): string[] {
  return followUps.map(f => {
    const waiting = Math.round((now.getTime() - Date.parse(f.createdAt)) / 60_000);
    const due = Math.max(0, Math.round((Date.parse(f.dueAt) - now.getTime()) / 1000));
    const what = f.kind === "ci" ? "waiting for CI" : f.kind === "blocked" ? `waiting on ${(safeParse(f.payload) as { on?: string[] }).on?.join(", ") ?? "other issues"}` : f.kind;
    return `${f.jobId.padEnd(32)} ${what} for ${waiting} min, next check in ${due}s`;
  });
}

/**
 * `runner inspect [repo#n] [--follow] [--json]`: the event timeline across jobs (or one), from the typed events.
 * With --follow it keeps printing new events as the runner writes them.
 */
export async function inspect(store: Store, options: { jobId?: string; follow?: boolean; json?: boolean; limit?: number; print?: (line: string) => void; pollMs?: number; until?: () => boolean }): Promise<void> {
  const print = options.print ?? console.log;
  const limit = options.limit ?? 40;
  const start = Math.max(0, store.lastEventId() - (options.jobId ? 100_000 : limit));
  let events = store.eventsSince(start, { jobId: options.jobId, limit: 100_000 }).slice(-limit);
  const show = (list: StoredEvent[]) => {
    for (const event of list) print(options.json ? JSON.stringify(event) : formatEvent(event));
  };
  if (!options.json) {
    const pending = followUpLines(store.followUps(options.jobId));
    if (pending.length) print(`Follow-ups:\n${pending.map(line => `  ${line}`).join("\n")}\n`);
  }
  show(events);
  if (!options.follow) return;
  let last = events.at(-1)?.id ?? store.lastEventId();
  while (!options.until?.()) {
    await new Promise(resolve => setTimeout(resolve, options.pollMs ?? 2000));
    events = store.eventsSince(last, { jobId: options.jobId });
    show(events);
    last = events.at(-1)?.id ?? last;
  }
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
