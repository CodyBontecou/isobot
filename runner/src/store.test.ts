import assert from "node:assert/strict";
import { test } from "node:test";
import { Store } from "./store.js";

test("enqueue is idempotent while active and re-queues after a finish", () => {
  const store = new Store(":memory:");
  const job = store.enqueue("o", "r", 1, "Add dark mode")!;
  assert.equal(job.id, "o/r#1");
  assert.equal(job.state, "queued");
  assert.equal(store.enqueue("o", "r", 1, "Add dark mode"), null);
  store.update(job.id, { state: "pr_open", prNumber: 7 });
  assert.equal(store.enqueue("o", "r", 1, "Add dark mode"), null, "an open PR blocks a duplicate build");
  store.update(job.id, { state: "failed", lastError: "boom", attempts: 2 });
  const again = store.enqueue("o", "r", 1, "Add dark mode v2")!;
  assert.equal(again.state, "queued");
  assert.equal(again.attempts, 0);
  assert.equal(again.lastError, null);
  assert.equal(again.prNumber, null);
  assert.equal(again.title, "Add dark mode v2");
});

test("cursors, seen items and events persist", () => {
  const store = new Store(":memory:");
  assert.equal(store.cursor("discord:1"), null);
  store.setCursor("discord:1", "100");
  store.setCursor("discord:1", "200");
  assert.equal(store.cursor("discord:1"), "200");
  assert.equal(store.markSeen("triage", "a"), true);
  assert.equal(store.markSeen("triage", "a"), false);
  assert.equal(store.isSeen("triage", "a"), true);
  const job = store.enqueue("o", "r", 2, "x")!;
  store.update(job.id, { state: "building" });
  assert.deepEqual(store.events(job.id).map(e => e.kind), ["state:building", "queued"]);
  assert.deepEqual(store.inState("building").map(j => j.id), ["o/r#2"]);
});
