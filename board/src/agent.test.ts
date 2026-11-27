import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { AgentStore, BadAgentInput, checkContext } from "./agent.js";
import type { Sql } from "./store.js";

function sql(): Sql {
  const db = new DatabaseSync(":memory:");
  return {
    exec(query: string, ...bindings: unknown[]) {
      const statement = db.prepare(query);
      const rows = statement.columns().length ? statement.all(...(bindings as never[])) : (statement.run(...(bindings as never[])), []);
      return { toArray: () => rows as Record<string, unknown>[] };
    },
  };
}

const t0 = new Date("2026-11-27T12:00:00Z");
const later = (ms: number) => new Date(t0.getTime() + ms);
const context = { url: "?view=growth&app=whereday", view: "Growth · Whereday", refs: [{ kind: "chart", id: "installs:2026-11-08..2026-11-15", label: "installs · Nov 8–15", focus: "picked", data: "Nov 8: 24" }] };

test("a new conversation is titled from its first message and handed to the runner once", () => {
  const store = new AgentStore(sql());
  const { thread, message } = store.send({ text: "What happened to installs here?\nmore", context, by: "owner" }, t0);
  assert.equal(thread.title, "What happened to installs here?");
  assert.equal(thread.state, "queued");
  assert.deepEqual(message.context, context);
  assert.equal(store.hasWork(), true);
  const work = store.takeWork(t0);
  assert.equal(work.messages.length, 1);
  assert.equal(work.messages[0].threadId, thread.id);
  assert.equal(store.thread(thread.id)!.state, "working");
  assert.deepEqual(store.takeWork(t0), { messages: [], decisions: [] });
});

test("work that couldn't be sent waits for the next connection", () => {
  const store = new AgentStore(sql());
  store.send({ text: "hi", by: "owner" }, t0);
  const work = store.takeWork(t0);
  store.untake(work);
  assert.equal(store.takeWork(t0).messages.length, 1);
});

test("the runner's reply, proposals and approval round trip", () => {
  const store = new AgentStore(sql());
  const { thread } = store.send({ text: "merge it", by: "owner" }, t0);
  store.takeWork(t0);
  store.apply({
    threads: [{ id: thread.id, state: "idle" }],
    replies: [{ threadId: thread.id, text: "It's green.", proposals: [{ id: "prop-12345678", summary: "Merge o/r#1" }] }],
  }, t0);
  const c = store.conversation(thread.id, t0)!;
  assert.deepEqual(c.messages.map(m => m.role), ["you", "isobot"]);
  assert.equal(c.thread.open, 1);
  assert.equal(c.proposals[0].state, "open");

  store.decide({ proposalId: "prop-12345678", decision: "approve", by: "owner" }, t0);
  assert.throws(() => store.decide({ proposalId: "prop-12345678", decision: "approve", by: "owner" }, t0), BadAgentInput);
  const work = store.takeWork(t0);
  assert.deepEqual(work.decisions, [{ proposalId: "prop-12345678", threadId: thread.id, decision: "approve", by: "owner" }]);
  assert.equal(store.conversation(thread.id, t0)!.proposals[0].state, "running");
  store.apply({ results: [{ proposalId: "prop-12345678", ok: true, text: "Merged" }] }, t0);
  assert.deepEqual(store.conversation(thread.id, t0)!.proposals[0], { ...c.proposals[0], state: "done", result: "Merged", decidedBy: "owner" });
});

test("a turn the runner never answers is given up with a note", () => {
  const store = new AgentStore(sql());
  const { thread } = store.send({ text: "hi", by: "owner" }, t0);
  store.takeWork(t0);
  const c = store.conversation(thread.id, later(31 * 60_000))!;
  assert.equal(c.thread.state, "idle");
  assert.equal(c.messages.at(-1)!.role, "note");
});

test("open proposals expire after a day", () => {
  const store = new AgentStore(sql());
  const { thread } = store.send({ text: "hi", by: "owner" }, t0);
  store.apply({ replies: [{ threadId: thread.id, text: "", proposals: [{ id: "prop-12345678", summary: "x" }] }] }, t0);
  assert.equal(store.conversation(thread.id, later(25 * 3_600_000))!.proposals[0].state, "expired");
  assert.throws(() => store.decide({ proposalId: "prop-12345678", decision: "approve", by: "owner" }, later(25 * 3_600_000)), /expired/);
});

test("archived conversations stay listed, and writing in one brings it back", () => {
  const store = new AgentStore(sql());
  const { thread } = store.send({ text: "hi", by: "owner" }, t0);
  store.archive({ threadId: thread.id, archived: true }, t0);
  assert.equal(store.threads(t0)[0].archived, true);
  store.send({ threadId: thread.id, text: "again", by: "owner" }, t0);
  assert.equal(store.thread(thread.id)!.archived, false);
});

test("bad input is refused, bad context is dropped", () => {
  const store = new AgentStore(sql());
  assert.throws(() => store.send({ text: "  ", by: "owner" }), BadAgentInput);
  assert.throws(() => store.send({ threadId: "nope", text: "hi", by: "owner" }), BadAgentInput);
  assert.throws(() => store.apply([]), BadAgentInput);
  assert.equal(checkContext("x"), null);
  assert.deepEqual(checkContext({ url: "?", view: "Overview", refs: [{ kind: "pr" }, { kind: "pr", id: "o/r#1", label: "o/r#1", focus: "weird" }] }),
    { url: "?", view: "Overview", refs: [{ kind: "pr", id: "o/r#1", label: "o/r#1" }] });
});

test("the version goes up on every change", () => {
  const store = new AgentStore(sql());
  const v = store.version();
  store.send({ text: "hi", by: "owner" }, t0);
  assert.ok(store.version() > v);
});
