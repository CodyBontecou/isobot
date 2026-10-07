import assert from "node:assert/strict";
import test from "node:test";
import { isVoxId, parseVoxCapture, recordedAt, voxPrompt } from "./vox.js";

const id = "e02660fa-59a4-4e16-885f-c963a5c1d2bc";
const capture = { id, text: "# Notes\n\n- Remember this.\n", source: "vox", recorded_at: "2026-10-07T11:12:13Z" };

test("preserves capture Markdown and unknown metadata without mutating uppercase payload IDs", () => {
  const payload = { ...capture, id: id.toUpperCase(), text: "  # Notes\r\n\r\n- café\n\n", custom: { preset: "Journal", tags: ["private"] } };
  const parsed = parseVoxCapture(payload, id, "memory");
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error("Expected a valid capture");
  assert.equal(parsed.input.id, id);
  assert.equal(parsed.input.mode, "memory");
  assert.equal(parsed.input.markdown, payload.text);
  assert.equal(parsed.input.payload, payload);
  assert.equal(parsed.input.payload.id, id.toUpperCase());
  assert.deepEqual(parsed.input.payload.custom, { preset: "Journal", tags: ["private"] });
  assert.equal(parsed.test, false);
  assert.equal(parseVoxCapture(capture, id.toUpperCase(), "prompt").ok, true);
});

test("accepts full legacy Transcript metadata and selects exact preset-produced cleanedText", () => {
  const payload = {
    id: id.toUpperCase(), text: "um remember my plan", date: 813_064_333, duration: 7.5,
    modelUsed: "whisper-large", language: "en", cleanedText: "  Follow these instructions:\n\nRemember my plan.\n",
    title: "A plan", tags: ["work"], category: "note",
    speakerTurns: [{ speaker: 0, text: "my plan", startTime: 0, endTime: 7.5 }],
  };
  const parsed = parseVoxCapture(payload, id, "prompt");
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error("Expected a valid transcript");
  assert.equal(parsed.input.markdown, payload.text);
  assert.equal(voxPrompt(parsed.input), payload.cleanedText);
  assert.equal(parsed.input.payload.date, payload.date);
  assert.deepEqual(parsed.input.payload.speakerTurns, payload.speakerTurns);
  assert.equal(voxPrompt({ markdown: "# Original\n", payload: { cleanedText: " \n\t " } }), "# Original\n");
});

test("accepts Vox's synthetic delivery test without capture metadata", () => {
  const parsed = parseVoxCapture({ id, text: "Vox.md delivery test", test: true }, id, "prompt");
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error("Expected a valid delivery test");
  assert.equal(parsed.test, true);
  assert.equal(parseVoxCapture({ id, text: "Store this", test: false }, id, "memory").ok, true);
});

test("rejects missing, malformed, or mismatched UUIDs and nonobject JSON", () => {
  for (const value of [null, [], "Markdown", 42]) assert.equal(parseVoxCapture(value, id, "memory").ok, false);
  for (const key of [null, "", ` ${id}`, "../note", "e02660fa-59a4-4e16-885f-c963a5c1d2bd"])
    assert.equal(parseVoxCapture(capture, key, "memory").ok, false);
  for (const invalidId of [undefined, 1, "", "no-uuid", `${id}extra`])
    assert.equal(parseVoxCapture({ ...capture, id: invalidId }, id, "memory").ok, false);
  assert.equal(isVoxId(id.toUpperCase()), true);
  assert.equal(isVoxId(id.replaceAll("-", "")), false);
});

test("rejects malformed required text and optional typed fields", () => {
  for (const text of [undefined, null, 5, "", " \n\t"])
    assert.equal(parseVoxCapture({ ...capture, text }, id, "memory").ok, false);
  for (const [field, values] of Object.entries({
    cleanedText: [null, 1], test: ["true", 1, null], recorded_at: [null, 5, "2026-10-07", "2026-02-31T01:00:00Z", "2026-10-07T24:00:00Z"],
    date: [null, "813064333", NaN, Infinity], duration: [null, "7", -1, NaN, Infinity],
    source: [null, 1], modelUsed: [null, 1], language: [null, 1], title: [null, 1],
  })) {
    for (const value of values) {
      assert.equal(parseVoxCapture({ ...capture, [field]: value }, id, "memory").ok, false, `${field}: ${String(value)}`);
    }
  }
});

test("enforces UTF-8 storage bounds and a separate selected-prompt character limit", () => {
  const limit = 1_048_576;
  assert.equal(parseVoxCapture({ id, text: "x".repeat(limit) }, id, "memory").ok, true);
  assert.equal(parseVoxCapture({ id, text: "x".repeat(limit + 1) }, id, "memory").ok, false);
  assert.equal(parseVoxCapture({ id, text: "é".repeat(limit / 2) }, id, "memory").ok, true);
  assert.equal(parseVoxCapture({ id, text: "é".repeat(limit / 2 + 1) }, id, "memory").ok, false);
  assert.equal(parseVoxCapture({ id, text: "Small", cleanedText: "é".repeat(limit / 2 + 1) }, id, "memory").ok, false);
  assert.equal(parseVoxCapture({ id, text: "x".repeat(64_000) }, id, "prompt").ok, true);
  assert.equal(parseVoxCapture({ id, text: "x".repeat(64_001) }, id, "prompt").ok, false);
  assert.equal(parseVoxCapture({ id, text: "x".repeat(64_001), cleanedText: "Summarize the stored capture." }, id, "prompt").ok, true);
  assert.equal(parseVoxCapture({ id, text: "Small", cleanedText: "x".repeat(64_001) }, id, "prompt").ok, false);
});

test("derives recording dates from Swift's epoch without changing original metadata", () => {
  assert.equal(recordedAt({ date: 0 }), "2001-01-01T00:00:00.000Z");
  assert.equal(recordedAt({ date: -978_307_200 }), "1970-01-01T00:00:00.000Z");
  assert.equal(recordedAt({ date: 0.125 }), "2001-01-01T00:00:00.125Z");
  assert.equal(recordedAt(capture), capture.recorded_at);
  assert.equal(recordedAt({ date: 0, recorded_at: "2026-10-07T11:12:13.125+02:00" }), "2026-10-07T11:12:13.125+02:00");
  assert.equal(parseVoxCapture({ ...capture, recorded_at: "2024-02-29T11:12:13Z" }, id, "memory").ok, true);
  assert.equal(parseVoxCapture({ ...capture, recorded_at: "2025-02-29T11:12:13Z" }, id, "memory").ok, false);
  for (const payload of [{}, { date: NaN }, { date: "0" }, { date: Number.MAX_VALUE }]) assert.equal(recordedAt(payload), undefined);
});
