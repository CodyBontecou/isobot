import type { Labels } from "./config.js";

/**
 * Task controls on the isobot board (bot.isolated.tech): the owner clicks Approve, Stop, Retry or Dismiss on a
 * task, the board queues it, and the runner picks it up with its next push (dashboard.ts) and applies it here
 * with its own GitHub token. The board never holds a token; it only says which issue and what to do.
 *
 * Each action is the label change the matching Discord reaction makes (bridge: src/discord/approval.ts planFor),
 * so the pipeline treats it the same way: ✅ approve, 🛑 stop, 🔁 retry, 🧹 dismiss. Approving also takes the
 * proposed label off, so the task leaves the Proposed column.
 */

export const BOARD_ACTIONS = ["approve", "stop", "retry", "dismiss"] as const;
export type BoardActionKind = typeof BOARD_ACTIONS[number];

/** One queued click, as the board hands it over. */
export interface BoardAction {
  id: string;
  kind: BoardActionKind;
  repo: string;
  number: number;
  /** The GitHub login that clicked it on the board. */
  by: string;
}

export interface BoardActionResult {
  id: string;
  ok: boolean;
  text: string;
}

export type LabelPlan = { add: string[]; remove: string[] } | { noop: string } | { refuse: string };

/** The label changes for an action on an issue in this state. */
export function planBoardAction(kind: BoardActionKind, issue: { state: string; labels: string[] }, labels: Labels): LabelPlan {
  const has = new Set(issue.labels.map(l => l.toLowerCase()));
  const is = (label: string) => has.has(label.toLowerCase());
  if (issue.state !== "open") return { refuse: "it's closed" };
  const inFlight = is(labels.ready) || is(labels.building) || is(labels.review);
  switch (kind) {
    case "approve":
      if (is(labels.stop)) return { refuse: "it's stopped; use Retry" };
      if (inFlight) return { noop: "it's already approved" };
      return { add: [labels.ready], remove: is(labels.proposed) ? [labels.proposed] : [] };
    case "stop":
      // Withdraws a pending approval too, so nothing gets claimed after the stop.
      if (is(labels.stop)) return { noop: "it's already stopped" };
      return { add: [labels.stop], remove: is(labels.ready) ? [labels.ready] : [] };
    case "retry": {
      // Lifts a stop; builds again unless a build or an open PR is already on it (a failed or stopped job starts over).
      const remove = [...(is(labels.stop) ? [labels.stop] : []), ...(is(labels.proposed) ? [labels.proposed] : [])];
      const add = inFlight ? [] : [labels.ready];
      return add.length || remove.length ? { add, remove } : { noop: "it's already building" };
    }
    case "dismiss":
      // The runner's cleanup does the rest (local workspaces, labels, closing the issue); stop first so a running build ends.
      if (is(labels.cleanup)) return { noop: "it's already being dismissed" };
      return {
        add: [...(is(labels.building) && !is(labels.stop) ? [labels.stop] : []), labels.cleanup],
        remove: is(labels.ready) ? [labels.ready] : [],
      };
  }
}

const DONE: Record<BoardActionKind, string> = {
  approve: "Approved; isobot picks it up on its next pass",
  stop: "Stopped",
  retry: "Queued to build again",
  dismiss: "Dismissed; isobot closes it and cleans up",
};

export interface BoardActionDeps {
  labels: Labels;
  /** Only the runner's configured repositories (`owner/repo`, any case) can be changed. */
  repos: () => string[];
  github: {
    issue(owner: string, repo: string, number: number): Promise<{ state: string; labels: string[] }>;
    addLabels(owner: string, repo: string, number: number, labels: string[]): Promise<void>;
    removeLabel(owner: string, repo: string, number: number, label: string): Promise<void>;
  };
  /** Puts the action on the job's timeline (runner.sqlite events); `jobId` is lowercase, like Store.jobId. */
  event(jobId: string, text: string): void;
}

/** Applies one board action. Never throws: a failure comes back as `ok: false` for the board to show. */
export async function runBoardAction(action: BoardAction, deps: BoardActionDeps): Promise<BoardActionResult> {
  const done = (ok: boolean, text: string): BoardActionResult => ({ id: action.id, ok, text: text.slice(0, 300) });
  try {
    if (!(BOARD_ACTIONS as readonly string[]).includes(action.kind)) return done(false, `unknown action ${String(action.kind)}`);
    const repo = deps.repos().find(name => name.toLowerCase() === String(action.repo).toLowerCase());
    if (!repo) return done(false, `${action.repo} isn't one of the runner's repositories`);
    if (!Number.isSafeInteger(action.number) || action.number < 1) return done(false, "bad issue number");
    const [owner, name] = repo.split("/");
    const ref = `${repo}#${action.number}`;
    const plan = planBoardAction(action.kind, await deps.github.issue(owner, name, action.number), deps.labels);
    if ("refuse" in plan) return done(false, `Can't ${action.kind} ${ref}: ${plan.refuse}`);
    if ("noop" in plan) return done(true, `Nothing to do: ${plan.noop}`);
    // Add before removing: a dismiss's stop must land before its ready label goes.
    if (plan.add.length) await deps.github.addLabels(owner, name, action.number, plan.add);
    for (const label of plan.remove) await deps.github.removeLabel(owner, name, action.number, label);
    const changes = [...plan.add.map(l => `+${l}`), ...plan.remove.map(l => `-${l}`)].join(" ");
    deps.event(ref.toLowerCase(), `${action.kind} from the board by @${action.by} (${changes})`);
    console.log(`[board] ${action.kind} ${ref} by @${action.by}: ${changes}`);
    return done(true, DONE[action.kind]);
  } catch (error) {
    return done(false, (error as Error).message.split("\n")[0]);
  }
}
