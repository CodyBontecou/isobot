import assert from "node:assert/strict";
import { test } from "node:test";
import { claim, mayWrite, release, validRows } from "./coord.js";

const T = Date.UTC(2026, 10, 28, 12);
const TTL = 90_000;

test("the first runner to ask leads; the other waits until the lease runs out", () => {
  const first = claim(null, { runnerId: "laptop", preferred: false }, T, TTL);
  assert.equal(first.leading, true);
  assert.deepEqual(first.lease, { holder: "laptop", epoch: 1, until: T + TTL, preferred: false, yieldTo: null });

  const other = claim(first.lease, { runnerId: "builder", preferred: false }, T + 1000, TTL);
  assert.equal(other.leading, false);
  assert.equal(other.lease, first.lease, "a non-preferred runner changes nothing");

  const renewed = claim(first.lease, { runnerId: "laptop", preferred: false }, T + 20_000, TTL);
  assert.equal(renewed.lease.until, T + 20_000 + TTL);
  assert.equal(renewed.lease.epoch, 1, "renewing keeps the epoch");

  const takeover = claim(renewed.lease, { runnerId: "builder", preferred: false }, T + 20_000 + TTL, TTL);
  assert.equal(takeover.leading, true);
  assert.equal(takeover.lease.holder, "builder");
  assert.equal(takeover.lease.epoch, 2);
});

test("a preferred runner asks the holder to hand over, and gets the lease straight from it", () => {
  const held = claim(null, { runnerId: "laptop", preferred: false }, T, TTL).lease;
  const asked = claim(held, { runnerId: "mini", preferred: true }, T + 1000, TTL);
  assert.equal(asked.leading, false);
  assert.equal(asked.lease.yieldTo, "mini");

  const holderSees = claim(asked.lease, { runnerId: "laptop", preferred: false }, T + 5000, TTL);
  assert.equal(holderSees.lease.yieldTo, "mini", "the holder learns someone is waiting");

  const handed = release(holderSees.lease, "laptop", 1, T + 6000, TTL)!;
  assert.deepEqual(handed, { holder: "mini", epoch: 2, until: T + 6000 + TTL, preferred: true, yieldTo: null });
  assert.equal(claim(handed, { runnerId: "mini", preferred: true }, T + 7000, TTL).leading, true);
  assert.equal(claim(handed, { runnerId: "laptop", preferred: false }, T + 7000, TTL).leading, false, "the old holder can't win it back");
});

test("a preferred runner that stopped asking is forgotten", () => {
  const held = claim(null, { runnerId: "laptop", preferred: false }, T, TTL).lease;
  const asked = claim(held, { runnerId: "mini", preferred: true }, T, TTL).lease;
  const later = claim(asked, { runnerId: "laptop", preferred: false }, T + TTL + 1, TTL).lease;
  assert.equal(later.yieldTo, null);
  const left = release(asked, "laptop", 1, T + TTL + 1, TTL)!;
  assert.equal(left.until, 0, "released to nobody rather than to a runner that went away");
});

test("two preferred runners don't take the lease from each other", () => {
  const held = claim(null, { runnerId: "mini", preferred: true }, T, TTL).lease;
  assert.equal(claim(held, { runnerId: "studio", preferred: true }, T + 1000, TTL).lease.yieldTo, null);
});

test("release by someone else, or under an old epoch, changes nothing; a plain release frees the lease", () => {
  const held = claim(null, { runnerId: "laptop", preferred: false }, T, TTL).lease;
  assert.equal(release(held, "mini", 1, T, TTL), held);
  assert.equal(release(held, "laptop", 0, T, TTL), held);
  const freed = release(held, "laptop", 1, T, TTL)!;
  assert.equal(freed.until, 0);
  const next = claim(freed, { runnerId: "mini", preferred: false }, T + 1, TTL);
  assert.equal(next.leading, true);
  assert.equal(next.lease.epoch, 2);
});

test("only the current holder, under its epoch, before the lease runs out, may write", () => {
  const held = claim(null, { runnerId: "laptop", preferred: false }, T, TTL).lease;
  assert.equal(mayWrite(held, "laptop", 1, T + 1000), true);
  assert.equal(mayWrite(held, "laptop", 1, T + TTL), false, "expired");
  assert.equal(mayWrite(held, "laptop", 0, T + 1000), false, "old epoch");
  assert.equal(mayWrite(held, "mini", 1, T + 1000), false);
  assert.equal(mayWrite(null, "laptop", 1, T), false);
});

test("shared rows are checked before they're stored", () => {
  assert.equal(validRows([{ table: "cursors", key: "chat:state", value: "{}" }, { table: "seen", key: "triage\u001fx", value: null }]), true);
  assert.equal(validRows([{ table: "jobs", key: "x", value: "y" }]), false);
  assert.equal(validRows([{ table: "cursors", key: "", value: "y" }]), false);
  assert.equal(validRows([{ table: "cursors", key: "k", value: 3 }]), false);
  assert.equal(validRows({}), false);
});
