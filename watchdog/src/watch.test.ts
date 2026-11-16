import assert from "node:assert/strict";
import { test } from "node:test";
import { duration, onAlarm, onPing, REMIND_MS, type WatchState } from "./watch.js";

const GRACE = 10 * 60_000;
const T = Date.UTC(2026, 10, 16, 12);
const fresh: WatchState = { lastPing: null, alertedAt: null };

test("each ping pushes the alarm out by the grace period, silently", () => {
  const step = onPing(fresh, T, GRACE);
  assert.deepEqual(step, { state: { lastPing: T, alertedAt: null }, alarmAt: T + GRACE, message: undefined });
});

test("no alert before the first ping, and none while pings keep arriving", () => {
  assert.equal(onAlarm(fresh, T, GRACE), null);
  const late = onAlarm({ lastPing: T, alertedAt: null }, T + 3 * 60_000, GRACE);
  assert.deepEqual(late, { state: { lastPing: T, alertedAt: null }, alarmAt: T + GRACE }, "a stale alarm reschedules instead of alerting");
});

test("silence past the grace period alerts once, then reminds, then reports recovery", () => {
  const alert = onAlarm({ lastPing: T, alertedAt: null }, T + GRACE, GRACE)!;
  assert.match(alert.message!, /^🔴 .*no heartbeat for 10 min/);
  assert.equal(alert.state.alertedAt, T + GRACE);
  assert.equal(alert.alarmAt, T + GRACE + REMIND_MS);

  const remind = onAlarm(alert.state, alert.alarmAt, GRACE)!;
  assert.match(remind.message!, /^⏰ .*no heartbeat for 6 h 10 min/);
  assert.equal(remind.state.alertedAt, T + GRACE, "the outage start is kept");

  const back = onPing(remind.state, T + 7 * 60 * 60_000, GRACE);
  assert.match(back.message!, /^🟢 .*after 7 h of silence/);
  assert.deepEqual(back.state, { lastPing: T + 7 * 60 * 60_000, alertedAt: null });
});

test("durations read naturally", () => {
  assert.equal(duration(90_000), "2 min");
  assert.equal(duration(60 * 60_000), "1 h");
  assert.equal(duration(125 * 60_000), "2 h 5 min");
});
