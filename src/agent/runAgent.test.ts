import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import type { MessageReplyOptions } from "discord.js";
import { runAgent, type RunAgentInput } from "./runAgent.js";
import type { ReplyContext, TicketOperation } from "./types.js";

const EVENT_ID = "123456789012345678";
const ISSUE_URL = "https://github.com/codybontecou/Sync.md/issues/42";
const originalUrl = process.env.ISOBOT_AGENT_URL;
const originalToken = process.env.ISOBOT_API_TOKEN;

const context: ReplyContext = {
  trigger: {
    authorTag: "requester", authorId: "1", content: "<@bot> capture this",
    jumpUrl: `https://discord.com/channels/1/2/${EVENT_ID}`, createdAt: "2026-10-07T00:00:00Z",
  },
  parent: {
    authorTag: "author", authorId: "2", content: "A reproducible bug",
    jumpUrl: "https://discord.com/channels/1/2/4", createdAt: "2026-10-07T00:00:00Z",
  },
  recent: [], channelName: "help", guildName: "isolated.tech",
};

function input(replies: MessageReplyOptions[] = []): RunAgentInput {
  return {
    trigger: { id: EVENT_ID, reply: async (options) => { replies.push(options); } },
    replyContext: context,
    repo: { owner: "codybontecou", repo: "Sync.md" },
  };
}

function operation(fields: Partial<TicketOperation> = {}): Response {
  return Response.json({ operationId: EVENT_ID, status: "done", ...fields });
}

interface AgentCall {
  url: string;
  init: RequestInit;
}

function respond(...responses: Response[]): AgentCall[] {
  const calls: AgentCall[] = [];
  mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    assert.ok(init);
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/delivered") && responses.length === 0) return new Response(null, { status: 204 });
    const response = responses.shift();
    assert.ok(response, "unexpected request");
    return response;
  });
  return calls;
}

beforeEach(() => {
  process.env.ISOBOT_AGENT_URL = "https://agent.example.workers.dev";
  process.env.ISOBOT_API_TOKEN = "test-api-token";
});

afterEach(() => {
  mock.restoreAll();
  if (originalUrl === undefined) delete process.env.ISOBOT_AGENT_URL;
  else process.env.ISOBOT_AGENT_URL = originalUrl;
  if (originalToken === undefined) delete process.env.ISOBOT_API_TOKEN;
  else process.env.ISOBOT_API_TOKEN = originalToken;
});

test("submits a JSON-only ticket and retries a deployment failure with the same event ID", async () => {
  const replies: MessageReplyOptions[] = [];
  const calls = respond(
    new Response("provider details must stay private", { status: 503 }),
    Response.json({ operationId: EVENT_ID }),
    operation({ issueUrl: ISSUE_URL, replyContent: "Captured the bug." }),
  );
  const result = await runAgent(input(replies));

  assert.equal(calls.length, 4);
  for (const call of calls.slice(0, 2)) {
    assert.equal(call.url, "https://agent.example.workers.dev/api/tickets");
    assert.equal(call.init.method, "POST");
    assert.equal(new Headers(call.init.headers).get("Authorization"), "Bearer test-api-token");
    assert.equal(call.init.redirect, "error");
    assert.equal(typeof call.init.body, "string");
    assert.deepEqual(JSON.parse(String(call.init.body)), {
      eventId: EVENT_ID, repo: { owner: "codybontecou", repo: "Sync.md" }, context,
    });
  }
  assert.equal(calls[2].url, `https://agent.example.workers.dev/api/tickets/${EVENT_ID}`);
  assert.equal(calls[3].url, `https://agent.example.workers.dev/api/tickets/${EVENT_ID}/delivered`);
  assert.equal(calls[3].init.method, "POST");
  assert.deepEqual(result, { issueUrl: ISSUE_URL, replied: true, turns: 0 });
  assert.equal(replies.length, 1);
  assert.equal(replies[0].content, `Captured the bug.\n\n${ISSUE_URL}`);
  assert.equal(replies[0].nonce, EVENT_ID);
  assert.equal(replies[0].enforceNonce, true);
  assert.deepEqual(replies[0].allowedMentions, { parse: [], repliedUser: false });
});

test("polls a running operation before replying with its persisted result", async () => {
  const replies: MessageReplyOptions[] = [];
  const calls = respond(
    Response.json({ operationId: EVENT_ID, status: "queued" }),
    operation({ status: "running" }),
    operation({ issueUrl: ISSUE_URL }),
  );
  const result = await runAgent(input(replies));
  assert.equal(calls.length, 4);
  assert.equal(calls[1].init.method, "GET");
  assert.equal(calls[2].init.method, "GET");
  assert.equal(result.issueUrl, ISSUE_URL);
  assert.equal(replies[0].content, `Created issue: ${ISSUE_URL}`);
});

test("retries an interrupted response body with the same event ID", async () => {
  const interrupted = Response.json({ operationId: EVENT_ID });
  mock.method(interrupted, "json", async () => { throw new TypeError("body stream interrupted"); });
  const calls = respond(interrupted, Response.json({ operationId: EVENT_ID }), operation({ issueUrl: ISSUE_URL }));
  const result = await runAgent(input());
  assert.equal(result.issueUrl, ISSUE_URL);
  assert.equal(calls.length, 4);
  assert.equal(calls[0].init.body, calls[1].init.body);
  assert.equal(JSON.parse(String(calls[1].init.body)).eventId, EVENT_ID);
});

test("delivers a clarification when the Pi agent does not create an issue", async () => {
  const replies: MessageReplyOptions[] = [];
  respond(Response.json({ operationId: EVENT_ID }), operation({ replyContent: "What steps reproduce it?" }));
  const result = await runAgent(input(replies));
  assert.equal(result.issueUrl, undefined);
  assert.equal(result.replied, true);
  assert.equal(replies[0].content, "What steps reproduce it?");
});

test("sends a fallback clarification before acknowledging an unanswered operation", async () => {
  const replies: MessageReplyOptions[] = [];
  const calls = respond(Response.json({ operationId: EVENT_ID }), operation({ status: "unanswered" }));
  const result = await runAgent(input(replies));
  assert.equal(result.replied, true);
  assert.equal(replies[0].content, "I couldn't create an issue from that. Try giving me more detail.");
  assert.ok(calls[2].url.endsWith("/delivered"));
});

test("does not report a successful Discord reply as failed when delivery acknowledgement fails", async () => {
  const replies: MessageReplyOptions[] = [];
  const warnings: unknown[][] = [];
  mock.method(console, "warn", (...args: unknown[]) => { warnings.push(args); });
  respond(Response.json({ operationId: EVENT_ID }), operation({ issueUrl: ISSUE_URL }), new Response("private ack details", { status: 401 }));
  const result = await runAgent(input(replies));
  assert.equal(result.issueUrl, ISSUE_URL);
  assert.equal(result.replied, true);
  assert.equal(replies.length, 1);
  assert.equal(warnings.length, 1);
  assert.ok(!String(warnings[0][0]).includes("private ack details"));
});

test("coalesces concurrent primary and recovery calls for one Discord event", async () => {
  const replies: MessageReplyOptions[] = [];
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    calls++;
    if (String(url).endsWith("/delivered")) return new Response(null, { status: 204 });
    if (init?.method === "POST") {
      await gate;
      return Response.json({ operationId: EVENT_ID });
    }
    return operation({ issueUrl: ISSUE_URL });
  });
  const first = runAgent(input(replies));
  const second = runAgent(input(replies));
  assert.equal(first, second);
  release();
  await Promise.all([first, second]);
  assert.equal(calls, 3);
  assert.equal(replies.length, 1);
});

test("does not resend a durably acknowledged result returned by submission", async () => {
  const replies: MessageReplyOptions[] = [];
  const calls = respond(operation({ issueUrl: ISSUE_URL, delivered: true }));
  const result = await runAgent(input(replies));
  assert.deepEqual(result, { issueUrl: ISSUE_URL, replied: true, turns: 0 });
  assert.equal(calls.length, 1);
  assert.equal(replies.length, 0);
});

test("does not send or acknowledge a result marked delivered during polling", async () => {
  const replies: MessageReplyOptions[] = [];
  const calls = respond(Response.json({ operationId: EVENT_ID }), operation({ issueUrl: ISSUE_URL, delivered: true }));
  const result = await runAgent(input(replies));
  assert.deepEqual(result, { issueUrl: ISSUE_URL, replied: true, turns: 0 });
  assert.equal(calls.length, 2);
  assert.equal(replies.length, 0);
});

test("rejects malformed durable delivery status", async () => {
  const replies: MessageReplyOptions[] = [];
  respond(Response.json({ operationId: EVENT_ID, delivered: "true" }));
  await assert.rejects(runAgent(input(replies)), /invalid delivery status/);
  assert.equal(replies.length, 0);
});

test("keeps the issue URL in a reply when model text exceeds Discord's message limit", async () => {
  const replies: MessageReplyOptions[] = [];
  respond(Response.json({ operationId: EVENT_ID }), operation({ issueUrl: ISSUE_URL, text: "x".repeat(3000) + ISSUE_URL }));
  await runAgent(input(replies));
  assert.ok(replies[0].content);
  assert.ok(replies[0].content.length <= 2000);
  assert.ok(replies[0].content.includes(ISSUE_URL));
});

test("rejects a mismatched submission operation ID without replying", async () => {
  const replies: MessageReplyOptions[] = [];
  const calls = respond(Response.json({ operationId: "another-event" }));
  await assert.rejects(runAgent(input(replies)), /mismatched operation ID/);
  assert.equal(calls.length, 1);
  assert.equal(replies.length, 0);
});

test("rejects a mismatched polling operation ID without replying", async () => {
  const replies: MessageReplyOptions[] = [];
  respond(Response.json({ operationId: EVENT_ID }), Response.json({ operationId: "another-event", status: "done" }));
  await assert.rejects(runAgent(input(replies)), /mismatched operation ID/);
  assert.equal(replies.length, 0);
});

test("does not retry authentication failures or expose response bodies", async () => {
  const calls = respond(new Response("secret provider configuration", { status: 401 }));
  await assert.rejects(runAgent(input()), { message: "Cloudflare Pi agent request failed (HTTP 401)" });
  assert.equal(calls.length, 1);
});

test("rejects malformed operation statuses", async () => {
  respond(Response.json({ operationId: EVENT_ID }), Response.json({ operationId: EVENT_ID, status: "unexpected" }));
  await assert.rejects(runAgent(input()), /invalid operation status/);
});

test("requires HTTPS for remote agent URLs and rejects URL credentials, queries and fragments", async () => {
  const calls = respond();
  for (const url of [
    "http://agent.example.workers.dev", "ftp://localhost",
    "https://user:password@agent.example.workers.dev", "https://agent.example.workers.dev?token=private",
    "https://agent.example.workers.dev#private", "https://agent.example.workers.dev?", "https://agent.example.workers.dev#",
  ]) {
    process.env.ISOBOT_AGENT_URL = url;
    await assert.rejects(runAgent(input()), /ISOBOT_AGENT_URL/);
  }
  assert.equal(calls.length, 0);
});

test("permits HTTP on loopback URLs for local development", async () => {
  for (const url of ["http://localhost:8787", "http://127.0.0.1:8787", "http://[::1]:8787"]) {
    process.env.ISOBOT_AGENT_URL = url;
    respond(Response.json({ operationId: EVENT_ID }), operation());
    const result = await runAgent(input());
    assert.equal(result.replied, true);
    mock.restoreAll();
  }
});
