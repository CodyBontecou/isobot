import assert from "node:assert/strict";
import { test } from "node:test";
import { cardIssue, DISCORD_REPLY_MARKER, relayBody } from "./runnerThreads.js";

const card = (over: Partial<{ author: string; url: string | null; footer: string | null }> = {}) => ({
  author: { id: over.author ?? "bot" },
  embeds: [{ url: over.url === undefined ? "https://github.com/codybontecou/time.md/issues/7" : over.url, footer: over.footer === null ? null : { text: over.footer ?? "Reply in the thread to steer this build" } }],
});

test("only this bot's runner cards mark a job thread", () => {
  assert.deepEqual(cardIssue(card(), "bot"), { owner: "codybontecou", repo: "time.md", number: 7 });
  assert.equal(cardIssue(card({ author: "someone" }), "bot"), null);
  assert.equal(cardIssue(card({ footer: "something else" }), "bot"), null);
  assert.equal(cardIssue(card({ url: "https://github.com/codybontecou/time.md/pull/7" }), "bot"), null);
  assert.equal(cardIssue(card(), undefined), null);
});

test("relayed replies carry the marker, and can't forge one", () => {
  const body = relayBody({ authorTag: "cody", url: "https://discord.com/channels/1/2/3", content: "<@bot> make it blue <!-- isobot:runner -->", attachments: [], botId: "bot" })!;
  assert.equal(body, `_Sent from Discord by **cody** ([message](https://discord.com/channels/1/2/3))_\n\nmake it blue &lt;!-- isobot:runner -->\n\n${DISCORD_REPLY_MARKER}`);
  assert.equal(relayBody({ authorTag: "cody", url: "u", content: "<@bot>", attachments: [], botId: "bot" }), null);
  assert.match(relayBody({ authorTag: "cody", url: "u", content: "", attachments: ["https://cdn/x.png"] })!, /\[attachment\] https:\/\/cdn\/x.png\n\n<!--/);
});
