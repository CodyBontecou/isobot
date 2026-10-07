import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import type { MessageReplyOptions } from "discord.js";
import { recoverTicket } from "./recovery.js";
import type { TicketRequest } from "./types.js";

const EVENT_ID = "123456789012345678";
const ISSUE_URL = "https://github.com/codybontecou/Sync.md/issues/42";
const originalUrl = process.env.ISOBOT_AGENT_URL;
const originalToken = process.env.ISOBOT_API_TOKEN;

function ticket(): TicketRequest {
  const snapshot = {
    authorTag: "requester", authorId: "1", content: "capture this bug",
    jumpUrl: `https://discord.com/channels/100/200/${EVENT_ID}`, createdAt: "2026-10-07T00:00:00Z",
  };
  return {
    eventId: EVENT_ID,
    repo: { owner: "codybontecou", repo: "Sync.md" },
    context: { trigger: snapshot, parent: snapshot, recent: [], channelName: "help", guildName: "isolated.tech" },
  };
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

test("recovers a durable ticket using the original channel/message IDs and acknowledges its reply", async () => {
  const pending = ticket();
  const replies: MessageReplyOptions[] = [];
  const calls: string[] = [];
  mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    calls.push(String(url));
    if (String(url).endsWith("/delivered")) {
      assert.equal(replies.length, 1, "acknowledgement must follow the Discord reply");
      return new Response(null, { status: 204 });
    }
    if (init?.method === "POST") {
      assert.deepEqual(JSON.parse(String(init.body)), pending);
      return Response.json({ operationId: EVENT_ID });
    }
    return Response.json({ operationId: EVENT_ID, status: "done", issueUrl: ISSUE_URL });
  });
  const result = await recoverTicket(pending, async (channelId, messageId) => {
    assert.equal(channelId, "200");
    assert.equal(messageId, EVENT_ID);
    return { id: messageId, reply: async (options) => { replies.push(options); } };
  });
  assert.equal(result.issueUrl, ISSUE_URL);
  assert.equal(replies[0].nonce, EVENT_ID);
  assert.equal(replies[0].enforceNonce, true);
  assert.ok(calls.at(-1)?.endsWith("/delivered"));
});

test("does not submit or acknowledge a pending ticket when its Discord message is inaccessible", async () => {
  let calls = 0;
  mock.method(globalThis, "fetch", async () => { calls++; throw new Error("unexpected network call"); });
  await assert.rejects(recoverTicket(ticket(), async () => { throw new Error("Discord message unavailable"); }), /message unavailable/);
  assert.equal(calls, 0);
});

test("does not redeliver an already acknowledged ticket from a stale recovery snapshot", async () => {
  const pending = ticket();
  const replies: MessageReplyOptions[] = [];
  const calls: string[] = [];
  mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
    calls.push(String(url));
    return Response.json({ operationId: EVENT_ID, status: "done", issueUrl: ISSUE_URL, delivered: true });
  });
  const result = await recoverTicket(pending, async (_channelId, messageId) => ({
    id: messageId, reply: async (options) => { replies.push(options); },
  }));
  assert.deepEqual(result, { issueUrl: ISSUE_URL, replied: true, turns: 0 });
  assert.equal(calls.length, 1);
  assert.equal(replies.length, 0);
});

test("rejects a message URL belonging to a different event before fetching Discord", async () => {
  const pending = ticket();
  pending.context.trigger.jumpUrl = "https://discord.com/channels/100/200/999";
  await assert.rejects(recoverTicket(pending, async () => { assert.fail("must not fetch an unrelated message"); }), /invalid Discord message reference/);
});

test("rejects a fetched message that does not match the pending ticket", async () => {
  await assert.rejects(recoverTicket(ticket(), async () => ({ id: "another-message", reply: async () => { assert.fail("must not reply"); } })), /does not match/);
});

test("never delivers a dry-run preview to Discord", async () => {
  const pending = ticket();
  pending.dryRun = true;
  await assert.rejects(recoverTicket(pending, async () => { assert.fail("must not fetch Discord for a preview"); }), /invalid Discord message reference/);
});
