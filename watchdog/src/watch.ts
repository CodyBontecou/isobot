/**
 * The watchdog's decisions, kept free of Cloudflare APIs so they can be tested in Node.
 * State lives in one Durable Object; every ping pushes the alarm out by the grace period,
 * so the alarm only fires when the runner has gone quiet.
 */
export interface WatchState {
  lastPing: number | null;
  /** When the current outage was first reported, or null while healthy. */
  alertedAt: number | null;
}

export interface Step {
  state: WatchState;
  /** When the alarm should next fire. */
  alarmAt: number;
  /** Discord message to post, if any. */
  message?: string;
}

/** While the runner stays quiet, repeat the alert this often. */
export const REMIND_MS = 6 * 60 * 60_000;
/** If Discord rejected an alert, try again this soon. */
export const RETRY_MS = 5 * 60_000;

export function onPing(state: WatchState, now: number, graceMs: number): Step {
  const message = state.alertedAt !== null && state.lastPing !== null
    ? `🟢 isobot runner is back: heartbeats resumed after ${duration(now - state.lastPing)} of silence.`
    : undefined;
  return { state: { lastPing: now, alertedAt: null }, alarmAt: now + graceMs, message };
}

export function onAlarm(state: WatchState, now: number, graceMs: number): Step | null {
  if (state.lastPing === null) return null;
  const quiet = now - state.lastPing;
  // A ping landed after this alarm was scheduled; wait out the rest of its grace period.
  if (quiet < graceMs) return { state, alarmAt: state.lastPing + graceMs };
  const first = state.alertedAt === null;
  return {
    state: { ...state, alertedAt: state.alertedAt ?? now },
    alarmAt: now + REMIND_MS,
    message: `${first ? "🔴" : "⏰"} isobot runner has sent no heartbeat for ${duration(quiet)} `
      + `(last <t:${Math.floor(state.lastPing / 1000)}:R>). The Mac may be asleep, offline or off, or every cycle is failing. `
      + "Check `node runner/dist/main.js status` and the runner log.",
  };
}

export function duration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
}
