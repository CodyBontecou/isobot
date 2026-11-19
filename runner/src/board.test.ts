import assert from "node:assert/strict";
import { test } from "node:test";
import { describeEvent } from "./events.js";
import { explainGrants } from "./grants.js";
import { followUpLines, formatEvent, inspect } from "./inspect.js";
import { Store } from "./store.js";
import { testConfig } from "./testing.js";

test("follow-ups are due by time, keep their deadline clock when snoozed, and one per job and kind", () => {
  const store = new Store(":memory:");
  const t0 = new Date("2026-11-19T12:00:00Z");
  store.schedule("a/b#1", "ci", new Date(t0.getTime() + 30_000), { sha: "x" }, t0);
  assert.deepEqual(store.dueFollowUps(t0), []);
  const due = store.dueFollowUps(new Date(t0.getTime() + 30_000));
  assert.equal(due.length, 1);
  assert.equal(due[0].createdAt, t0.toISOString());
  store.snooze("a/b#1", "ci", new Date(t0.getTime() + 90_000));
  assert.deepEqual(store.dueFollowUps(new Date(t0.getTime() + 60_000)), []);
  // Rescheduling replaces the payload but keeps when the wait started.
  store.schedule("a/b#1", "ci", new Date(t0.getTime() + 60_000), { sha: "y" }, new Date(t0.getTime() + 60_000));
  const [only] = store.followUps("a/b#1");
  assert.equal(only.createdAt, t0.toISOString());
  assert.deepEqual(JSON.parse(only.payload), { sha: "y" });
  store.clearFollowUp("a/b#1");
  assert.deepEqual(store.followUps(), []);
});

test("events keep typed data next to their prose, and old prose-only events still read", () => {
  const store = new Store(":memory:");
  store.event("a/b#1", "note", "plain old event");
  store.event("a/b#1", "review", "approve 0.9 low: fine", { type: "review", v: 1, round: 1, verdict: "approve", confidence: 0.9, risk: "low" });
  const [plain, typed] = store.eventsSince(0);
  assert.equal(plain.data, null);
  assert.equal(typed.data?.type, "review");
  assert.equal(describeEvent(plain.kind, plain.detail, plain.data), "note: plain old event");
  assert.equal(describeEvent(typed.kind, typed.detail, typed.data), "review 1: approve · confidence 0.90 · risk low");
  assert.match(formatEvent(typed), /a\/b#1\s+review 1: approve/);
  assert.equal(store.lastEventId(), typed.id);
});

test("inspect prints pending follow-ups and the timeline for one job", async () => {
  const store = new Store(":memory:");
  store.event("a/b#1", "x", null, { type: "ci", v: 1, state: "success", waitedMinutes: 4 });
  store.event("a/b#2", "y", null, { type: "blocked", v: 1, on: ["#1"] });
  store.schedule("a/b#2", "blocked", new Date(Date.now() + 60_000), { on: ["#1"] });
  const lines: string[] = [];
  await inspect(store, { jobId: "a/b#2", print: line => lines.push(line) });
  assert.match(lines[0], /Follow-ups:\n\s+a\/b#2\s+waiting on #1/);
  assert.equal(lines.length, 2);
  assert.match(lines[1], /waiting on #1/);
  assert.match(followUpLines(store.followUps(), new Date())[0], /next check in \d+s/);
});

test("grants lists the trusted accounts, chat users and each repo's merge rules", () => {
  const config = testConfig();
  config.trustedAuthors = ["helper"];
  config.repos["codybontecou/time.md"] = { autonomy: "pr", ownerAutonomy: "merge", checks: ["make test"], protectedPaths: ["**/Billing/**"], release: { onMerge: ["deploy"], onShip: ["submit"] } };
  const text = explainGrants({ config, viewer: "owner", runnerId: "mini", chatUsers: { ids: ["123"], source: "ISOBOT_CHAT_USERS" } });
  assert.match(text, /runner `mini`/);
  assert.match(text, /@owner, @helper: adding `isobot:ready`/);
  assert.match(text, /Discord users 123 \(from ISOBOT_CHAT_USERS\)/);
  assert.match(text, /codybontecou\/time.md\n\s+autonomy pr \(your own work: merge\)/);
  assert.match(text, /after merge runs: deploy/);
  assert.match(text, /also protected: \*\*\/Billing\/\*\*/);
  assert.equal(text.match(/Protected paths/g)?.length, 1, "the shared list is printed once");
  assert.match(text, /after `isobot:ship` runs: submit/);
  assert.match(text, /Never pushed: \.github\/workflows/);
  const one = explainGrants({ config, viewer: "owner", runnerId: "mini", chatUsers: { ids: [], source: "x" }, repo: "someone/else" });
  assert.match(one, /someone\/else isn't configured/);
});
