import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { BoardChat, describePage, type BoardUpdate, type Socket } from "./boardChat.js";
import { BOARD_RULES, CHAT_RULES, type ChatModel, type ChatModelInput } from "./chat.js";
import { ChatToolServer } from "./chatMcp.js";
import type { ChatToolDeps } from "./chatTools.js";
import { configuredRepos, loadConfig } from "./config.js";
import { Store } from "./store.js";
import { FakeGitHub } from "./testing.js";

const config = loadConfig();
const [{ owner: OWNER, repo: REPO }] = configuredRepos(config);

class ChatGitHub extends FakeGitHub {
  async pullDetails(): Promise<never> { throw new Error("no pull"); }
  async openPulls() { return []; }
  async note(owner: string, repo: string, number: number, body: string): Promise<string> {
    this.addComment(owner, repo, number, body);
    return `https://github.com/${owner}/${repo}/issues/${number}#comment`;
  }
}

/** The board's end of the WebSocket: records updates, and hands over work. */
class FakeBoard implements Socket {
  readyState = 0;
  sent: string[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  send(data: string): void { this.sent.push(data); }
  close(): void { this.readyState = 3; }
  connect(): void { this.readyState = 1; this.onopen?.({}); }
  work(work: unknown): void { this.onmessage?.({ data: JSON.stringify({ type: "work", work }) }); }
  updates(): BoardUpdate[] {
    return this.sent.filter(s => s.startsWith("{")).map(s => JSON.parse(s) as { type: string; update?: BoardUpdate }).filter(m => m.type === "update").map(m => m.update!);
  }
}

async function setup(script: (input: ChatModelInput, tool: (name: string, args?: Record<string, unknown>) => Promise<string>) => Promise<string>) {
  const github = new ChatGitHub();
  const store = new Store(":memory:");
  const chatDir = mkdtempSync(path.join(tmpdir(), "isobot-boardchat-"));
  const tools: ChatToolDeps = {
    config, store, github, home: chatDir, chatDir, live: () => ({ activeJobs: [], lastCycleError: null, lastTriageAt: null, manuallyPaused: false }),
    repoFor: () => { throw new Error("no git in tests"); }, setPaused: () => undefined, card: () => null,
    asc: async () => ({ ok: true, output: "" }),
  };
  const server = new ChatToolServer();
  await server.start();
  const calls: ChatModelInput[] = [];
  const model: ChatModel = async input => {
    calls.push(input);
    const mcp = JSON.parse(input.mcpConfig).mcpServers.isobot as { url: string; headers: Record<string, string> };
    const tool = async (name: string, args: Record<string, unknown> = {}) => {
      const response = await fetch(mcp.url, {
        method: "POST", headers: { ...mcp.headers, "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      });
      return ((await response.json()) as { result: { content: { text: string }[] } }).result.content[0].text;
    };
    return { text: await script(input, tool), sessionId: input.sessionId ?? `session-${calls.length}` };
  };
  const board = new FakeBoard();
  const chat = new BoardChat({ url: "https://bot.example", token: "t", tools, model, server, config: {}, store, connect: () => board });
  chat.start();
  board.connect();
  return { chat, board, github, store, calls, done: () => { chat.stop(); server.stop(); } };
}

const context = {
  url: "?view=growth&app=whereday", view: "Growth · Whereday",
  refs: [{ kind: "chart", id: "installs 2026-11-08..2026-11-15", label: "New installs · Nov 8–15", focus: "picked" as const, data: "2026-11-08: App Store 24" }],
};

test("a message from the board runs a turn with the page as data and answers in the same conversation", async () => {
  const t = await setup(async () => "Installs fell after the subtitle change.");
  try {
    assert.equal(t.board.sent[0], JSON.stringify({ type: "ready" }));
    t.board.work({ messages: [{ threadId: "th-1", seq: 1, at: "", text: "What happened here?", by: "owner", context }], decisions: [] });
    await t.chat.idle();
    assert.match(t.calls[0].prompt, /Growth · Whereday view/);
    assert.match(t.calls[0].prompt, /<page>\n- picked: chart installs 2026-11-08\.\.2026-11-15 \(New installs · Nov 8–15\)\n {4}2026-11-08: App Store 24\n<\/page>/);
    assert.match(t.calls[0].prompt, /owner: What happened here\?$/);
    const updates = t.board.updates();
    assert.deepEqual(updates[0].threads, [{ id: "th-1", state: "working", status: "thinking" }]);
    const last = updates.at(-1)!;
    assert.deepEqual(last.replies, [{ threadId: "th-1", text: "Installs fell after the subtitle change.", proposals: [] }]);
    assert.deepEqual(last.threads, [{ id: "th-1", state: "idle", status: null }]);

    // The next message resumes the same session.
    t.board.work({ messages: [{ threadId: "th-1", seq: 2, at: "", text: "and Play?", by: "owner", context }], decisions: [] });
    await t.chat.idle();
    assert.equal(t.calls[1].sessionId, "session-1");
  } finally { t.done(); }
});

test("a proposal runs only when the board says it was approved, from the runner's own copy", async () => {
  const t = await setup(async (input, tool) => {
    if (input.prompt.includes("note it")) await tool("propose", { action: "note", repo: REPO, number: 5, text: "Use the system font" });
    return "Proposed a note.";
  });
  try {
    t.github.add(OWNER, REPO, 5, "Fonts", []);
    t.board.work({ messages: [{ threadId: "th-1", seq: 1, at: "", text: "note it", by: "owner", context: null }], decisions: [] });
    await t.chat.idle();
    const reply = t.board.updates().flatMap(u => u.replies ?? [])[0];
    assert.equal(reply.proposals!.length, 1);
    const id = reply.proposals![0].id;
    assert.equal(t.github.commentsFor(OWNER, REPO, 5).length, 0);

    t.board.work({ messages: [], decisions: [{ proposalId: "made-up-id-123", threadId: "th-1", decision: "approve", by: "owner" }] });
    await t.chat.idle();
    assert.equal(t.board.updates().at(-1)!.results![0].ok, false);
    assert.equal(t.github.commentsFor(OWNER, REPO, 5).length, 0);

    t.board.work({ messages: [], decisions: [{ proposalId: id, threadId: "th-1", decision: "approve", by: "owner" }] });
    await t.chat.idle();
    const result = t.board.updates().at(-1)!;
    assert.equal(result.results![0].proposalId, id);
    assert.equal(result.results![0].ok, true);
    assert.equal(t.github.commentsFor(OWNER, REPO, 5).length, 1);

    // Approving twice does nothing the second time.
    t.board.work({ messages: [], decisions: [{ proposalId: id, threadId: "th-1", decision: "approve", by: "owner" }] });
    await t.chat.idle();
    assert.equal(t.github.commentsFor(OWNER, REPO, 5).length, 1);

    // The model hears about it on its next turn.
    t.board.work({ messages: [{ threadId: "th-1", seq: 2, at: "", text: "thanks", by: "owner", context: null }], decisions: [] });
    await t.chat.idle();
    assert.match(t.calls.at(-1)!.prompt, /Since your last reply:\n- .*done \(approved by @owner\)/);
  } finally { t.done(); }
});

test("updates made while disconnected go out when the board is back", async () => {
  const t = await setup(async () => "ok");
  try {
    t.board.readyState = 3;
    t.board.work({ messages: [{ threadId: "th-1", seq: 1, at: "", text: "hi", by: "owner", context: null }], decisions: [] });
    await t.chat.idle();
    assert.equal(t.board.updates().length, 0);
    t.board.connect();
    assert.ok(t.board.updates().some(u => u.replies?.[0]?.text === "ok"));
  } finally { t.done(); }
});

test("describePage puts picked things first and says nothing without context", () => {
  assert.equal(describePage(null), "");
  const page = describePage({ url: "?view=prs", view: "Pull requests", refs: [
    { kind: "page", id: "?view=prs", label: "Pull requests" }, { kind: "pr", id: "o/r#2", label: "Fix", focus: "hover" }, { kind: "pr", id: "o/r#1", label: "o/r#1", focus: "picked" },
  ] });
  assert.deepEqual(page.split("\n").slice(2, 5), ["- picked: pr o/r#1", "- hovering: pr o/r#2 (Fix)", "- on the page: page ?view=prs (Pull requests)"]);
});

test("the board's rules swap Discord for the board", () => {
  assert.notEqual(BOARD_RULES, CHAT_RULES);
  assert.doesNotMatch(BOARD_RULES, /Discord staff channel|confirm with 👍|Discord markdown/);
  assert.match(BOARD_RULES, /Approve button/);
});
