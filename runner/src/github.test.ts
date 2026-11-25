import { test } from "node:test";
import assert from "node:assert/strict";
import { LABEL_DESCRIPTIONS } from "./github.js";

test("label descriptions fit GitHub's 100-character limit", () => {
  for (const [key, text] of Object.entries(LABEL_DESCRIPTIONS)) {
    assert.ok(text.length <= 100, `${key} is ${text.length} characters`);
  }
});
