import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { projectTranscriptEntry, readConversationEntries, type TranscriptRecord, type TranscriptScan } from "./conversation.js";

const timestamp = Date.parse("2026-10-07T12:00:00.000Z");
const assistant = (content: AssistantMessage["content"]): AssistantMessage => ({
  role: "assistant", content, api: "openai-completions", provider: "openai", model: "test",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: "stop", timestamp,
});
const record = (id: number, message: Message, kind = `pi.${message.role}`): TranscriptRecord => ({ id, kind, model: [message] });
const user = (id: number, text = String(id)): TranscriptRecord => record(id, { role: "user", content: text, timestamp });

function fixtureScan(records: TranscriptRecord[], reads: { count: number; calls: number } = { count: 0, calls: 0 }): TranscriptScan {
  const newest = [...records].sort((a, b) => b.id - a.id);
  return async (limit, cursor) => {
    reads.calls++;
    const before = typeof cursor?.after === "number" ? cursor.after : Infinity;
    const eligible = newest.filter(entry => entry.id < before);
    const items = eligible.slice(0, limit);
    reads.count += items.length;
    return { items, ...(eligible.length > limit ? { next: { after: items.at(-1)!.id } } : {}) };
  };
}

test("projects visible user and assistant content while excluding private reasoning and provider fields", () => {
  const hidden = assistant([
    { type: "thinking", thinking: "private reasoning", thinkingSignature: "private signature", redacted: true },
    { type: "text", text: "Visible answer", textSignature: "private text signature" },
  ]);
  const withProviderFields = { ...hidden, responseId: "private response id", errorMessage: "private provider error", providerThinkingLevel: "private effort" };
  const projected = projectTranscriptEntry(record(7, withProviderFields));
  assert.deepEqual(projected, { id: "7", role: "assistant", text: "Visible answer", createdAt: "2026-10-07T12:00:00.000Z" });
  assert.equal(JSON.stringify(projected).includes("private"), false);
  assert.equal(projectTranscriptEntry(record(8, assistant([{ type: "thinking", thinking: "private only" }]))), undefined);
  assert.deepEqual(projectTranscriptEntry(record(9, { role: "user", timestamp, content: [
    { type: "text", text: "My note", textSignature: "private" },
    { type: "image", data: "private image bytes", mimeType: "image/png" },
  ] })), { id: "9", role: "user", text: "My note", createdAt: "2026-10-07T12:00:00.000Z" });
});

test("preserves tool calls and results with explicit safe fields", () => {
  const projected = projectTranscriptEntry(record(10, assistant([
    { type: "toolCall", id: "call-1", name: "read_captured_note", arguments: { id: "note-1" }, thoughtSignature: "private tool signature", namespace: "private namespace" },
  ])));
  assert.deepEqual(projected, { id: "10", role: "assistant", text: "", toolCalls: [
    { id: "call-1", name: "read_captured_note", arguments: '{"id":"note-1"}' },
  ], createdAt: "2026-10-07T12:00:00.000Z" });
  assert.deepEqual(projectTranscriptEntry(record(11, {
    role: "toolResult", toolCallId: "call-1", toolName: "read_captured_note", content: [{ type: "text", text: "Saved Markdown" }],
    isError: false, timestamp, details: { secret: "private details" }, nestedCalls: { calls: [], complete: true },
  }, "pi.tool-result")), {
    id: "11", role: "tool", text: "Saved Markdown", toolResult: { name: "read_captured_note", id: "call-1", error: false },
    createdAt: "2026-10-07T12:00:00.000Z",
  });
});

test("bounds displayed text and arguments, skips provider system instructions, and keeps archive boundaries", () => {
  const result = projectTranscriptEntry(record(20, assistant([
    { type: "text", text: "x".repeat(30_000) },
    { type: "toolCall", id: "call", name: "test", arguments: { text: "y".repeat(10_000) } },
  ])))!;
  assert.equal(result.text.length, 16_000);
  assert.equal(result.text.endsWith("…"), true);
  assert.equal(result.toolCalls?.[0].arguments.length, 4_000);
  assert.equal(projectTranscriptEntry({ id: 21, kind: "pi.system", model: [
    { role: "system", content: "private instructions", timestamp },
  ] }), undefined);
  assert.deepEqual(projectTranscriptEntry({ id: 22, kind: "pi.reset" }), { id: "22", role: "system", text: "Conversation reset." });
  assert.equal(projectTranscriptEntry(user(23, "Ordinary user message"))?.role, "user");
  assert.equal(projectTranscriptEntry({ ...user(24, "Summary"), kind: "pi.compaction" })?.role, "system");
});

test("returns chronological recent pages and stable older pages when newer entries arrive", async () => {
  const archive = [user(1), user(2), { id: 3, kind: "pi.reset" }, user(4), user(5), user(6)];
  const latest = await readConversationEntries(fixtureScan(archive), { limit: 3 });
  assert.deepEqual(latest.entries.map(entry => entry.id), ["4", "5", "6"]);
  assert.equal(latest.nextCursor, "4");
  const older = await readConversationEntries(fixtureScan([...archive, user(7)]), { limit: 3, before: latest.nextCursor });
  assert.deepEqual(older.entries.map(entry => entry.id), ["1", "2", "3"]);
  assert.equal(older.entries[2].role, "system");
  assert.equal(older.nextCursor, undefined);
});

test("limits invisible-entry scanning and returns a cursor to continue past bookkeeping records", async () => {
  const markers: TranscriptRecord[] = Array.from({ length: 500 }, (_, index) => ({ id: index + 2, kind: "bookkeeping" }));
  const reads = { count: 0, calls: 0 };
  const page = await readConversationEntries(fixtureScan([user(1), ...markers], reads), { limit: 10 });
  assert.deepEqual(page.entries, []);
  assert.equal(reads.count, 400);
  assert.equal(reads.calls, 4);
  assert.equal(page.nextCursor, "102");
  const older = await readConversationEntries(fixtureScan([user(1), ...markers]), { limit: 10, before: page.nextCursor });
  assert.deepEqual(older.entries.map(entry => entry.id), ["1"]);
  assert.equal(older.nextCursor, undefined);
});

test("bounds JSON response bytes without losing the first unreturned entry", async () => {
  const archive = Array.from({ length: 100 }, (_, index) => user(index + 1, "😀".repeat(8_000)));
  const recent = await readConversationEntries(fixtureScan(archive), { limit: 100 });
  assert.ok(Buffer.byteLength(JSON.stringify(recent)) < 1_048_576);
  assert.ok(recent.entries.length > 0 && recent.entries.length < 100);
  assert.ok(recent.nextCursor);
  const older = await readConversationEntries(fixtureScan(archive), { limit: 100, before: recent.nextCursor });
  assert.equal(Number(older.entries.at(-1)!.id), Number(recent.entries[0].id) - 1);
});

test("rejects invalid page limits and cursors before reading stored records", async () => {
  const reads = { count: 0, calls: 0 };
  for (const limit of [0, -1, 1.5, 101, NaN]) await assert.rejects(readConversationEntries(fixtureScan([], reads), { limit }), RangeError);
  for (const before of ["", "0", "-1", "01", "1.5", "NaN", "9007199254740992"])
    await assert.rejects(readConversationEntries(fixtureScan([], reads), { limit: 1, before }), RangeError);
  assert.equal(reads.calls, 0);
});
