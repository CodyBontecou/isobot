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

test("opening the store waits for another process's lock instead of failing (a restart's old runner or a CLI command)", async () => {
  const { spawn } = await import("node:child_process");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const file = path.join(mkdtempSync(path.join(tmpdir(), "isobot-lock-")), "runner.sqlite");
  // A fresh file (not yet WAL), written to under an exclusive lock held for a second.
  const holder = spawn(process.execPath, ["-e", `
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(${JSON.stringify(file)});
    db.exec("CREATE TABLE x (a); BEGIN EXCLUSIVE");
    console.log("holding");
    setTimeout(() => db.exec("COMMIT"), 1000);
  `], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise<void>(resolve => holder.stdout.once("data", () => resolve()));
  const store = new Store(file);
  assert.equal(store.cursor("anything"), null);
  store.close();
  await new Promise(resolve => holder.once("close", resolve));
});

test("the effect ledger records started, done and requested effects", () => {
  const store = new Store(":memory:");
  assert.equal(store.effect("release:a/b#1:merge:abc"), null);
  store.startEffect("release:a/b#1:merge:abc", "a/b#1");
  assert.equal(store.effect("release:a/b#1:merge:abc")!.status, "started");
  store.finishEffect("release:a/b#1:merge:abc", "a/b#1", { passed: true });
  assert.deepEqual(JSON.parse(store.effect("release:a/b#1:merge:abc")!.result!), { passed: true });
  store.requestEffect("release:a/b#1:merge:abc", "a/b#1");
  assert.equal(store.effect("release:a/b#1:merge:abc")!.status, "requested");
  store.setEffectStatus("release:a/b#1:merge:abc", "interrupted");
  assert.equal(store.effect("release:a/b#1:merge:abc")!.status, "interrupted");
});
