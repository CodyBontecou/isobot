import assert from "node:assert/strict";
import { test } from "node:test";
import { approvalFor, isApproveEmoji, issueLinks, messageIssue } from "./approval.js";

const url = (n: number) => `https://github.com/CodyBontecou/health-md/issues/${n}`;
const msg = (content: string, over: { author?: string; embed?: string } = {}) => ({
  author: { id: over.author ?? "bot" }, content, embeds: over.embed ? [{ url: over.embed }] : [],
});

test("a bot message that links exactly one issue stands for it", () => {
  assert.deepEqual(messageIssue(msg(`**Tracked from GitHub:** ${url(328)}`), "bot"), { owner: "CodyBontecou", repo: "health-md", number: 328 });
  assert.deepEqual(messageIssue(msg("", { embed: url(329) }), "bot"), { owner: "CodyBontecou", repo: "health-md", number: 329 });
  assert.deepEqual(messageIssue(msg(`${url(5)} and again ${url(5)}`), "bot")?.number, 5);
});

test("someone else's message, a digest of several issues, or a PR link doesn't count", () => {
  assert.equal(messageIssue(msg(url(328), { author: "stranger" }), "bot"), null);
  assert.equal(messageIssue(msg(`• a <${url(328)}>\n• b <${url(329)}>`), "bot"), null);
  assert.equal(messageIssue(msg("https://github.com/CodyBontecou/health-md/pull/12"), "bot"), null);
  assert.equal(messageIssue(msg(url(328)), undefined), null);
  assert.equal(issueLinks("nothing here").length, 0);
});

test("approval adds ready only to open issues that aren't already moving or stopped", () => {
  assert.equal(approvalFor({ state: "open", labels: ["bug", "isobot:proposed"] }), "approve");
  assert.equal(approvalFor({ state: "open", labels: [] }), "approve");
  assert.equal(approvalFor({ state: "open", labels: ["isobot:ready"] }), "in_flight");
  assert.equal(approvalFor({ state: "open", labels: ["isobot:building"] }), "in_flight");
  assert.equal(approvalFor({ state: "open", labels: ["isobot:review"] }), "in_flight");
  assert.equal(approvalFor({ state: "open", labels: ["isobot:failed"] }), "approve");
  assert.equal(approvalFor({ state: "open", labels: ["isobot:stop"] }), "refuse");
  assert.equal(approvalFor({ state: "closed", labels: ["isobot:proposed"] }), "refuse");
});

test("only the approval emoji counts, with or without the variation selector", () => {
  assert.equal(isApproveEmoji({ name: "✅", id: null }), true);
  assert.equal(isApproveEmoji({ name: "✅️", id: null }), true);
  assert.equal(isApproveEmoji({ name: "👍", id: null }), false);
  assert.equal(isApproveEmoji({ name: null, id: "123" }), false);
});
