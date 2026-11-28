/**
 * Leader election for runners in the `auto` role (docs/runner.md#leader).
 *
 * Every auto runner builds. One of them, the leader, also runs the duties that must not run twice: triage,
 * the staff chat, the board, 💻 handoff, the release trains and the store reads. Who leads is a lease in the
 * watchdog (watchdog/src/coord.ts), renewed every RENEW_MS; when the leader's Mac sleeps or goes off, the lease
 * runs out and another runner takes over.
 *
 * Those duties keep their place in cursors and triage marks (store.ts). The leader sends every change to the
 * watchdog as it goes; a runner taking over first fetches what changed since it last led, so it carries on
 * where the last leader stopped instead of posting, triaging or releasing again.
 */
import type { SharedRow, Store } from "./store.js";

export const RENEW_MS = 20_000;
/** The watchdog's lease length (coord.ts LEASE_MS). */
export const LEASE_MS = 90_000;
/**
 * A leader that can't renew stops leading this long before its lease could run out, so it has stopped before
 * anyone else can take over. Measured on this Mac's clock from the last renewal it got, never the watchdog's.
 */
const STOP_MARGIN_MS = 25_000;
const VERSION_KEY = "shared:version";
const PUSH_BATCH = 500;

export interface ClaimReply {
  leading: boolean;
  holder: string;
  epoch: number;
  until: number;
  yieldTo: string | null;
  version: number;
}

export interface Coordinator {
  claim(runnerId: string, preferred: boolean): Promise<ClaimReply>;
  release(runnerId: string, epoch: number): Promise<void>;
  push(runnerId: string, epoch: number, rows: SharedRow[], seed?: boolean): Promise<{ ok: boolean; version: number; reason?: string }>;
  pull(since: number): Promise<{ rows: SharedRow[]; version: number; more: boolean }>;
  status(): Promise<CoordinatorStatus>;
}

export interface CoordinatorStatus {
  lease: { holder: string; epoch: number; until: number; yieldTo: string | null } | null;
  runners: Record<string, { at: number; preferred: boolean; leading: boolean }>;
  version: number;
}

/** The watchdog's coordinator, at the same address and token as the heartbeat (`…/ping/<token>`). */
export function httpCoordinator(heartbeatUrl: string, fetchImpl: typeof fetch = fetch): Coordinator {
  const match = /^(.*)\/ping\/([^/?#]+)\/?$/.exec(heartbeatUrl.trim());
  if (!match) throw new Error("ISOBOT_HEARTBEAT_URL must end in /ping/<token> for the auto role");
  const [, base, token] = match;
  const call = async <T>(method: "GET" | "POST", route: string, body?: unknown, query = ""): Promise<T> => {
    const response = await fetchImpl(`${base}/${route}/${token}${query}`, {
      method, signal: AbortSignal.timeout(15_000),
      ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    });
    // A refused push (409) still answers with JSON saying why.
    if (!response.ok && response.status !== 409) throw new Error(`coordinator ${route}: HTTP ${response.status}`);
    return await response.json() as T;
  };
  return {
    claim: (runnerId, preferred) => call("POST", "lease", { runnerId, preferred }),
    release: async (runnerId, epoch) => { await call("POST", "release", { runnerId, epoch }); },
    push: (runnerId, epoch, rows, seed = false) => call("POST", "shared", { runnerId, epoch, rows, seed }),
    pull: since => call("GET", "shared", undefined, `?since=${since}`),
    status: () => call("GET", "status"),
  };
}

export type LeaderChange =
  /** Took the lease, fetched the shared state: start the leader's duties. */
  | { kind: "gained"; epoch: number; from: string | null }
  /** Lost it (another runner holds it, or this one couldn't renew in time): stop them. */
  | { kind: "lost"; reason: string }
  /** Handed it on: to the preferred runner, or to whoever asks next (`to` null: this one is paused). */
  | { kind: "yielded"; to: string | null };

export interface LeadershipOptions {
  coordinator: Coordinator;
  store: Store;
  runnerId: string;
  /** The always-on Mac: it takes the lease back whenever it's up. */
  preferred: boolean;
  /** Whether this runner is between leader duties, so it can hand over without cutting one short. Settable later. */
  idle?: () => boolean;
  now?: () => number;
  log?: (line: string) => void;
}

export class Leadership {
  private leadingNow = false;
  private epoch = 0;
  /** When the last renewal came back, on this Mac's clock. */
  private renewedAt = 0;
  private holder: string | null = null;
  private waitingForSeed = false;
  /** Whether this runner is between leader duties (see LeadershipOptions.idle). */
  idle: () => boolean;
  /** True while this runner shouldn't lead (`runner pause`): it hands the lead on when idle and doesn't ask for it. */
  standby: () => boolean = () => false;
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  constructor(private readonly o: LeadershipOptions) {
    this.now = o.now ?? Date.now;
    this.idle = o.idle ?? (() => true);
    this.log = o.log ?? (line => console.log(`[leader] ${line}`));
  }

  get leading(): boolean {
    return this.leadingNow;
  }

  /** Who leads, as far as this runner last heard. */
  get leader(): string | null {
    return this.holder;
  }

  /** One renewal; call every RENEW_MS. Returns what changed, if anything. Never throws. */
  async tick(): Promise<LeaderChange | null> {
    if (this.standby()) {
      if (!this.leadingNow) return null;
      if (this.idle() && await this.pushChanges()) {
        await this.o.coordinator.release(this.o.runnerId, this.epoch).catch(() => undefined);
        this.leadingNow = false;
        this.holder = null;
        return { kind: "yielded", to: null };
      }
      // Busy (or the push failed): keep the lease until it can hand over cleanly.
    }
    const before = this.holder;
    let reply: ClaimReply;
    try {
      reply = await this.o.coordinator.claim(this.o.runnerId, this.o.preferred);
    } catch (error) {
      // The watchdog is unreachable (or this Mac is offline): keep leading only while no one else can have taken over.
      if (this.leadingNow && this.now() - this.renewedAt > LEASE_MS - STOP_MARGIN_MS) {
        return this.drop(`couldn't renew the lease: ${(error as Error).message}`);
      }
      return null;
    }
    this.holder = reply.holder;
    if (!reply.leading) {
      return this.leadingNow ? this.drop(`${reply.holder} holds the lease now`) : null;
    }
    this.renewedAt = this.now();
    if (!this.leadingNow || reply.epoch !== this.epoch) {
      if (reply.version === 0) {
        // Nothing shared yet. Leading now would start triage and the trains with this Mac's cursors, which on a
        // fresh Mac means doing everything again. Wait for `runner shared seed` from the Mac that was primary.
        if (!this.waitingForSeed) this.log("the shared state is empty: run `runner shared seed` on the Mac that has been primary");
        this.waitingForSeed = true;
        await this.o.coordinator.release(this.o.runnerId, reply.epoch).catch(() => undefined);
        this.holder = null;
        return null;
      }
      this.waitingForSeed = false;
      try {
        // The epoch first: a push made while pulling must carry it.
        this.epoch = reply.epoch;
        await this.pullAll();
      } catch (error) {
        // Without the latest state it must not lead. Give the lease back so nobody waits on it.
        this.log(`couldn't fetch the shared state: ${(error as Error).message}`);
        await this.o.coordinator.release(this.o.runnerId, reply.epoch).catch(() => undefined);
        this.leadingNow = false;
        return null;
      }
      this.leadingNow = true;
      await this.pushChanges();
      return { kind: "gained", epoch: reply.epoch, from: before && before !== this.o.runnerId ? before : null };
    }
    await this.pushChanges();
    if (reply.yieldTo && reply.yieldTo !== this.o.runnerId && this.idle()) {
      // Everything sent first, so the preferred runner starts where this one stopped.
      if (!await this.pushChanges()) return null;
      await this.o.coordinator.release(this.o.runnerId, this.epoch).catch(() => undefined);
      this.leadingNow = false;
      this.holder = reply.yieldTo;
      return { kind: "yielded", to: reply.yieldTo };
    }
    return null;
  }

  /** On shutdown: send what's left and give the lease up, so another runner takes over at once. */
  async stepDown(): Promise<void> {
    if (!this.leadingNow) return;
    await this.pushChanges();
    this.leadingNow = false;
    await this.o.coordinator.release(this.o.runnerId, this.epoch).catch(() => undefined);
  }

  /** Sends shared changes made since the last push. False if they couldn't all go (they stay queued). */
  async pushChanges(): Promise<boolean> {
    if (!this.leadingNow) return false;
    for (;;) {
      const { rows, seq } = this.o.store.sharedChanges(PUSH_BATCH);
      if (!rows.length) return true;
      let result: { ok: boolean; version: number; reason?: string };
      try {
        result = await this.o.coordinator.push(this.o.runnerId, this.epoch, rows);
      } catch (error) {
        this.log(`push failed, kept for the next one: ${(error as Error).message}`);
        return false;
      }
      if (!result.ok) {
        // Someone else leads: what this runner wrote since losing the lease is not theirs to take.
        this.log(`push refused (${result.reason ?? "not the leader"})`);
        return false;
      }
      this.o.store.sharedSent(rows, seq);
      this.o.store.setCursor(VERSION_KEY, String(result.version));
    }
  }

  /** Seeds an empty shared copy with every shared row on this Mac (`runner shared seed`). */
  static async seed(coordinator: Coordinator, store: Store, runnerId: string): Promise<number> {
    const rows = store.allShared();
    if (!rows.length) throw new Error("this Mac has no shared state to seed from");
    // One request: the watchdog takes a seed only while its copy is empty, so it can't arrive in parts.
    const result = await coordinator.push(runnerId, 0, rows, true);
    if (!result.ok) throw new Error(`not seeded: ${result.reason ?? "refused"}`);
    store.clearSharedChanges();
    store.setCursor(VERSION_KEY, String(result.version));
    return rows.length;
  }

  private async pullAll(): Promise<void> {
    let since = Number(this.o.store.cursor(VERSION_KEY) ?? 0) || 0;
    let fetched = 0;
    for (;;) {
      const page = await this.o.coordinator.pull(since);
      this.o.store.applyShared(page.rows);
      fetched += page.rows.length;
      since = page.version;
      this.o.store.setCursor(VERSION_KEY, String(since));
      if (!page.more) break;
    }
    this.log(`fetched ${fetched} shared row(s), now at version ${since}`);
  }

  private drop(reason: string): LeaderChange {
    this.leadingNow = false;
    this.log(`stepped down: ${reason}`);
    return { kind: "lost", reason };
  }
}
