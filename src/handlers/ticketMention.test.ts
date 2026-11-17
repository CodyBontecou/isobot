import assert from "node:assert/strict";
import { test } from "node:test";
import { chatAnswersMentions } from "./ticketMention.js";

test("with the runner's staff chat on, the bridge leaves every mention to it", () => {
  process.env.ISOBOT_CHAT_CHANNEL_ID = "500000000000000001";
  try {
    assert.equal(chatAnswersMentions(), true);
  } finally {
    delete process.env.ISOBOT_CHAT_CHANNEL_ID;
  }
  assert.equal(chatAnswersMentions(), false, "without it, mentions still ticketize as before");
});
