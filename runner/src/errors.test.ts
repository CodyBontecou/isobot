import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyModelFailure, isTransient, parseReset, TransientError, UsageLimitError } from "./errors.js";

test("model failures are classified by cause", () => {
  assert.ok(classifyModelFailure("Claude AI usage limit reached|1700000000") instanceof UsageLimitError);
  assert.ok(classifyModelFailure("You've hit your limit · resets 3pm") instanceof UsageLimitError);
  assert.ok(classifyModelFailure("API Error: 529 overloaded") instanceof TransientError);
  assert.ok(classifyModelFailure("Invalid API key · Please run /login") instanceof TransientError);
  const plain = classifyModelFailure("The task is ambiguous");
  assert.ok(!(plain instanceof TransientError));
});

test("transient detection covers GitHub statuses and network errors", () => {
  assert.ok(isTransient(Object.assign(new Error("x"), { status: 502 })));
  assert.ok(isTransient(Object.assign(new Error("x"), { status: 429 })));
  assert.ok(!isTransient(Object.assign(new Error("Not Found"), { status: 404 })));
  assert.ok(isTransient(new Error("git fetch failed: fatal: unable to access: Could not resolve host: github.com")));
  // GitHub throttling or failing git over HTTPS (seen on the build sandbox's clones).
  assert.ok(isTransient(new Error("git clone failed in the build sandbox: fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 429")));
  assert.ok(isTransient(new Error("fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 503")));
  assert.ok(!isTransient(new Error("fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 403")));
  assert.ok(!isTransient(new Error("fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 404")));
  assert.ok(isTransient(new Error("fetch failed", { cause: new Error("ECONNRESET") })));
  assert.ok(!isTransient(new Error("the builder made no changes")));
});

test("usage-limit reset times are parsed when present", () => {
  const now = Date.parse("2026-11-15T12:00:00Z");
  const inAnHour = Math.floor(now / 1000) + 3600;
  assert.equal(parseReset(`limit reached|${inAnHour}`, now), 60 * 60_000);
  assert.equal(parseReset("limit reached|1600000000", now), 60_000, "a past reset waits at least a minute");
  assert.equal(parseReset("resets at 2026-11-15T13:00:00Z", now), 60 * 60_000);
  assert.equal(parseReset("resets 3pm", now), undefined);
});
