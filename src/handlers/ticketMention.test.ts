import assert from "node:assert/strict";
import { test } from "node:test";
import { inChatChannel } from "./ticketMention.js";

const STAFF = "500000000000000001";
const message = (channelId: string, parentId: string | null) => ({ channelId, channel: { isThread: () => parentId !== null, parentId } });

test("mentions in the runner's staff chat channel and its threads are left to the runner's chat", () => {
  process.env.ISOBOT_CHAT_CHANNEL_ID = STAFF;
  try {
    assert.equal(inChatChannel(message(STAFF, null)), true);
    assert.equal(inChatChannel(message("600000000000000001", STAFF)), true, "a chat thread under the staff channel");
    assert.equal(inChatChannel(message("600000000000000002", "700000000000000001")), false, "threads elsewhere are still ticketized");
    assert.equal(inChatChannel(message("700000000000000001", null)), false);
  } finally {
    delete process.env.ISOBOT_CHAT_CHANNEL_ID;
  }
  assert.equal(inChatChannel(message(STAFF, null)), false, "without the channel configured, nothing changes");
});
