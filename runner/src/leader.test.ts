import assert from "node:assert/strict";
import { test } from "node:test";
import { type ClaimReply, type Coordinator, type CoordinatorStatus, httpCoordinator, LEASE_MS, Leadership } from "./leader.js";
import { type SharedRow, sharedCursor, Store } from "./store.js";

/** The watchdog's coordinator (watchdog/src/coord.ts + the Durable Object), in memory, on a fake clock. */
class FakeCoordinator implements Coordinator {
  lease: { holder: string; epoch: number; until: number; preferred: boolean; yieldTo: string | null; yieldAt: number } | null = null;
  rows = new Map<string, SharedRow & { version: number }>();
  version = 0;
  offline = false;
  constructor(public clock: { now: number }) {}

  async claim(runnerId: string, preferred: boolean): Promise<ClaimReply> {
    if (this.offline) throw new Error("offline");
    const now = this.clock.now;
    const l = this.lease;
    let leading: boolean;
    if (!l || l.until <= now) {
      this.lease = { holder: runnerId, epoch: (l?.epoch ?? 0) + 1, until: now + LEASE_MS, preferred, yieldTo: null, yieldAt: 0 };
      leading = true;
    } else if (l.holder === runnerId) {
      if (l.yieldTo && now - l.yieldAt >= LEASE_MS) l.yieldTo = null;
      l.until = now + LEASE_MS;
      leading = true;
    } else {
      if (preferred && !l.preferred) Object.assign(l, { yieldTo: runnerId, yieldAt: now });
      leading = false;
    }
    const lease = this.lease!;
    return { leading, holder: lease.holder, epoch: lease.epoch, until: lease.until, yieldTo: lease.yieldTo, version: this.version };
  }

  async release(runnerId: string, epoch: number): Promise<void> {
    const l = this.lease;
    if (!l || l.holder !== runnerId || l.epoch !== epoch) return;
    this.lease = l.yieldTo
      ? { holder: l.yieldTo, epoch: l.epoch + 1, until: this.clock.now + LEASE_MS, preferred: true, yieldTo: null, yieldAt: 0 }
      : { ...l, until: 0 };
  }

  async push(runnerId: string, epoch: number, rows: SharedRow[], seed = false) {
    if (this.offline) throw new Error("offline");
    const l = this.lease;
    const allowed = seed ? this.version === 0 : Boolean(l && l.holder === runnerId && l.epoch === epoch && l.until > this.clock.now);
    if (!allowed) return { ok: false, version: this.version, reason: seed ? "already seeded" : "not the leader" };
    for (const row of rows) this.rows.set(`${row.table}:${row.key}`, { ...row, version: ++this.version });
    return { ok: true, version: this.version };
  }

  async pull(since: number) {
    const rows = [...this.rows.values()].filter(r => r.version > since).sort((a, b) => a.version - b.version).slice(0, 2);
    const through = rows.at(-1)?.version ?? Math.max(since, this.version);
    return { rows: rows.map(({ table, key, value }) => ({ table, key, value })), version: through, more: through < this.version };
  }

  async status(): Promise<CoordinatorStatus> {
    return { lease: this.lease, runners: {}, version: this.version };
  }
}

function runner(coordinator: Coordinator, clock: { now: number }, runnerId: string, preferred = false) {
  const store = new Store(":memory:");
  const lines: string[] = [];
  const leadership = new Leadership({ coordinator, store, runnerId, preferred, now: () => clock.now, log: line => lines.push(line) });
  return { store, leadership, lines };
}

test("only shared cursors and triage marks are queued to send, and a newer write outlives an older acknowledgement", () => {
  const store = new Store(":memory:");
  store.setCursor("triage:last", "a");
  store.setCursor("discord:codybontecou/vox.md#199", "card");
  store.setCursor("lease:codybontecou/vox.md#199", "x");
  store.setCursor("builds:paused_until", "2026-11-28");
  store.setCursor("shared:version", "3");
  store.markSeen("triage", "github:o/r#5");
  const first = store.sharedChanges();
  assert.deepEqual(first.rows, [
    { table: "cursors", key: "triage:last", value: "a" },
    { table: "seen", key: "triage\u001fgithub:o/r#5", value: first.rows[1].value },
  ]);
  store.setCursor("triage:last", "b");
  store.sharedSent(first.rows, first.seq);
  assert.deepEqual(store.sharedChanges().rows, [{ table: "cursors", key: "triage:last", value: "b" }], "written again after it was read: still to send");

  store.deleteCursor("triage:last");
  const deleted = store.sharedChanges();
  assert.deepEqual(deleted.rows, [{ table: "cursors", key: "triage:last", value: null }], "a deletion goes as null");
  store.sharedSent(deleted.rows, deleted.seq);
  assert.deepEqual(store.sharedChanges().rows, []);

  assert.equal(sharedCursor("train:codybontecou/vox.md:last"), true);
  assert.equal(sharedCursor("content:published:codybontecou/vox.md#3"), false);
});

test("applying the shared copy replaces this Mac's rows and doesn't queue them to send back", () => {
  const store = new Store(":memory:");
  store.setCursor("chat:state", "old");
  store.setCursor("aso:1:report", "mine");
  store.applyShared([
    { table: "cursors", key: "chat:state", value: "new" },
    { table: "cursors", key: "gone", value: null },
    { table: "seen", key: "triage\u001fvox:abc", value: "2026-11-28T00:00:00Z" },
  ]);
  assert.equal(store.cursor("chat:state"), "new");
  assert.equal(store.isSeen("triage", "vox:abc"), true);
  assert.deepEqual(store.sharedChanges().rows.map(r => r.key), ["aso:1:report"], "only the change made here is left to send");
});

test("nobody leads an empty shared copy until the old primary seeds it", async () => {
  const clock = { now: Date.UTC(2026, 10, 28) };
  const coordinator = new FakeCoordinator(clock);
  const laptop = runner(coordinator, clock, "laptop");
  laptop.store.setCursor("triage:github", "42");
  laptop.store.markSeen("triage", "vox:1");

  assert.equal(await laptop.leadership.tick(), null);
  assert.equal(laptop.leadership.leading, false);
  assert.match(laptop.lines[0], /shared seed/);
  assert.equal(coordinator.lease!.until, 0, "the lease was given back");

  assert.equal(await Leadership.seed(coordinator, laptop.store, "laptop"), 2);
  await assert.rejects(Leadership.seed(coordinator, laptop.store, "laptop"), /already seeded/);
  const gained = await laptop.leadership.tick();
  assert.deepEqual(gained, { kind: "gained", epoch: 2, from: null });
});

test("the preferred Mac takes the lead when the holder is between duties, and starts where it stopped", async () => {
  const clock = { now: Date.UTC(2026, 10, 28) };
  const coordinator = new FakeCoordinator(clock);
  const laptop = runner(coordinator, clock, "laptop");
  laptop.store.setCursor("chat:state", "v1");
  await Leadership.seed(coordinator, laptop.store, "laptop");
  await laptop.leadership.tick();
  laptop.store.setCursor("chat:state", "v2");
  laptop.store.setCursor("train:o/r:last", "t");

  const mini = runner(coordinator, clock, "mini", true);
  mini.store.setCursor("chat:state", "stale, from when the mini was a builder");
  assert.equal(await mini.leadership.tick(), null);
  assert.equal(mini.leadership.leading, false);

  let busy = true;
  laptop.leadership.idle = () => !busy;
  clock.now += 20_000;
  assert.equal(await laptop.leadership.tick(), null, "mid-duty: it keeps the lead");
  assert.equal(laptop.leadership.leading, true);
  busy = false;
  clock.now += 20_000;
  assert.deepEqual(await laptop.leadership.tick(), { kind: "yielded", to: "mini" });
  assert.equal(laptop.leadership.leading, false);

  const gained = await mini.leadership.tick();
  assert.deepEqual(gained, { kind: "gained", epoch: 2, from: "laptop" });
  assert.equal(mini.store.cursor("chat:state"), "v2", "the laptop's last writes arrived");
  assert.equal(mini.store.cursor("train:o/r:last"), "t");

  assert.equal(await laptop.leadership.tick(), null, "the laptop stays a builder while the mini is up");
  assert.equal(laptop.leadership.leading, false);
});

test("when the leader's Mac goes quiet the other takes over after the lease, with what it last sent", async () => {
  const clock = { now: Date.UTC(2026, 10, 28) };
  const coordinator = new FakeCoordinator(clock);
  const mini = runner(coordinator, clock, "mini", true);
  mini.store.setCursor("content:o/site:last", "a");
  await Leadership.seed(coordinator, mini.store, "mini");
  await mini.leadership.tick();
  mini.store.setCursor("content:o/site:last", "b");
  await mini.leadership.pushChanges();

  const laptop = runner(coordinator, clock, "laptop");
  assert.equal(await laptop.leadership.tick(), null);
  // The mini is switched off: no more renewals.
  clock.now += LEASE_MS + 1;
  const gained = await laptop.leadership.tick();
  assert.equal(gained?.kind, "gained");
  assert.equal(laptop.store.cursor("content:o/site:last"), "b");

  // The mini comes back: it asks for the lead and gets it once the laptop is idle.
  assert.equal((await mini.leadership.tick())?.kind, "lost", "it learns it lost the lead");
  laptop.store.setCursor("content:o/site:last", "c");
  assert.equal((await laptop.leadership.tick())?.kind, "yielded");
  assert.equal((await mini.leadership.tick())?.kind, "gained");
  assert.equal(mini.store.cursor("content:o/site:last"), "c");
});

test("a leader that can't reach the watchdog stops before anyone else could take over, and its stale writes are refused", async () => {
  const clock = { now: Date.UTC(2026, 10, 28) };
  const coordinator = new FakeCoordinator(clock);
  const laptop = runner(coordinator, clock, "laptop");
  laptop.store.setCursor("x", "1");
  await Leadership.seed(coordinator, laptop.store, "laptop");
  await laptop.leadership.tick();

  coordinator.offline = true;
  clock.now += 40_000;
  assert.equal(await laptop.leadership.tick(), null, "still well inside its lease");
  clock.now += 30_000;
  const lost = await laptop.leadership.tick();
  assert.equal(lost?.kind, "lost");
  assert.ok(clock.now < coordinator.lease!.until, "stopped while its lease still held, so nobody overlapped it");

  coordinator.offline = false;
  clock.now += LEASE_MS;
  const mini = runner(coordinator, clock, "mini", true);
  assert.equal((await mini.leadership.tick())?.kind, "gained");
  laptop.store.setCursor("x", "late");
  assert.equal(await laptop.leadership.pushChanges(), false, "not leading: nothing sent");
  assert.equal(coordinator.rows.get("cursors:x")?.value, "1");
});

test("stepping down hands the lead on at once", async () => {
  const clock = { now: Date.UTC(2026, 10, 28) };
  const coordinator = new FakeCoordinator(clock);
  const laptop = runner(coordinator, clock, "laptop");
  laptop.store.setCursor("x", "1");
  await Leadership.seed(coordinator, laptop.store, "laptop");
  await laptop.leadership.tick();
  laptop.store.setCursor("x", "2");
  await laptop.leadership.stepDown();
  assert.equal(laptop.leadership.leading, false);
  const builder = runner(coordinator, clock, "builder");
  assert.equal((await builder.leadership.tick())?.kind, "gained");
  assert.equal(builder.store.cursor("x"), "2");
});

test("the coordinator lives at the heartbeat's address", async () => {
  const calls: string[] = [];
  const fake = (async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method} ${url} ${init?.body ?? ""}`);
    return new Response(JSON.stringify({ ok: false, version: 4, reason: "not the leader" }), { status: 409 });
  }) as typeof fetch;
  const coordinator = httpCoordinator("https://isobot-watchdog.example.workers.dev/ping/s3cret", fake);
  assert.deepEqual(await coordinator.push("mini", 2, []), { ok: false, version: 4, reason: "not the leader" });
  await coordinator.pull(7);
  assert.deepEqual(calls, [
    'POST https://isobot-watchdog.example.workers.dev/shared/s3cret {"runnerId":"mini","epoch":2,"rows":[],"seed":false}',
    "GET https://isobot-watchdog.example.workers.dev/shared/s3cret?since=7 ",
  ]);
  assert.throws(() => httpCoordinator("https://example.com/hook"), /ping/);
});

test("a paused leader hands the lead on once idle, and doesn't ask for it while paused", async () => {
  const clock = { now: Date.UTC(2026, 10, 28) };
  const coordinator = new FakeCoordinator(clock);
  const laptop = runner(coordinator, clock, "laptop");
  laptop.store.setCursor("x", "1");
  await Leadership.seed(coordinator, laptop.store, "laptop");
  await laptop.leadership.tick();

  let paused = true;
  let busy = true;
  laptop.leadership.standby = () => paused;
  laptop.leadership.idle = () => !busy;
  laptop.store.setCursor("x", "2");
  assert.equal(await laptop.leadership.tick(), null, "a triage pass is running: it keeps the lead for now");
  assert.equal(laptop.leadership.leading, true);
  busy = false;
  assert.deepEqual(await laptop.leadership.tick(), { kind: "yielded", to: null });
  assert.equal(coordinator.rows.get("cursors:x")?.value, "2", "everything sent before letting go");

  const mini = runner(coordinator, clock, "mini");
  assert.equal((await mini.leadership.tick())?.kind, "gained");
  clock.now += LEASE_MS * 2;
  assert.equal(await laptop.leadership.tick(), null);
  assert.equal(laptop.leadership.leading, false, "still paused: it never took the expired lease");
  paused = false;
  assert.equal((await laptop.leadership.tick())?.kind, "gained", "resumed: it leads again when nobody else does");
});
