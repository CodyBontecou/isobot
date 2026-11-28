/**
 * Leader election for runners in the `auto` role (docs/runner.md#leader).
 *
 * One lease, held by one runner at a time. The holder runs every duty that must not run twice (triage, chat,
 * board, trains, store reads); every runner builds. A holder renews every ~20 s; if it stops (the Mac sleeps,
 * goes offline or is switched off), the lease runs out and the next runner to ask takes it.
 *
 * A runner marked preferred (the always-on Mac) gets the lease back: while another runner holds it, the
 * preferred one's claims set `yieldTo`, and the holder hands over when it is between duties.
 *
 * `epoch` goes up with every new holder. Shared-state writes carry it, so a holder that lost the lease without
 * knowing (asleep, offline) can't overwrite what its successor wrote.
 *
 * Kept free of Cloudflare APIs so it can be tested in Node.
 */
export interface Lease {
  holder: string;
  epoch: number;
  /** Epoch ms the lease runs out unless renewed. */
  until: number;
  /** Whether the holder is the preferred runner. */
  preferred: boolean;
  /** A preferred runner waiting for the holder to hand over, and when it last asked. */
  yieldTo: string | null;
  yieldAt?: number;
}

export interface ClaimRequest {
  runnerId: string;
  preferred: boolean;
}

export interface ClaimResult {
  lease: Lease;
  leading: boolean;
}

export const LEASE_MS = 90_000;

export function claim(lease: Lease | null, request: ClaimRequest, now: number, ttlMs = LEASE_MS): ClaimResult {
  if (!lease || lease.until <= now) {
    // Free, or its holder went quiet: whoever asks first. A new epoch even when the same runner takes it back,
    // since it may have written nothing in between but can't know whether someone else did.
    return {
      lease: { holder: request.runnerId, epoch: (lease?.epoch ?? 0) + 1, until: now + ttlMs, preferred: request.preferred, yieldTo: null },
      leading: true,
    };
  }
  if (lease.holder === request.runnerId) {
    // A preferred runner that stopped asking (it went away again) is no longer waiting.
    const waiting = lease.yieldTo && now - (lease.yieldAt ?? 0) < ttlMs ? { yieldTo: lease.yieldTo, yieldAt: lease.yieldAt } : { yieldTo: null, yieldAt: undefined };
    return { lease: { ...lease, ...waiting, until: now + ttlMs, preferred: request.preferred }, leading: true };
  }
  if (request.preferred && !lease.preferred) {
    return { lease: { ...lease, yieldTo: request.runnerId, yieldAt: now }, leading: false };
  }
  return { lease, leading: false };
}

/**
 * The holder gives the lease up (shutting down, or handing over to a preferred runner). With `yieldTo` set the
 * lease goes straight to that runner, so the runner that leaves can't win it back in a race.
 */
export function release(lease: Lease | null, runnerId: string, epoch: number, now: number, ttlMs = LEASE_MS): Lease | null {
  if (!lease || lease.holder !== runnerId || lease.epoch !== epoch) return lease;
  if (lease.yieldTo && now - (lease.yieldAt ?? 0) < ttlMs) return { holder: lease.yieldTo, epoch: lease.epoch + 1, until: now + ttlMs, preferred: true, yieldTo: null };
  return { ...lease, until: 0, yieldTo: null, yieldAt: undefined };
}

/** Whether `runnerId` may write shared state under `epoch` right now. */
export function mayWrite(lease: Lease | null, runnerId: string, epoch: number, now: number): boolean {
  return Boolean(lease && lease.holder === runnerId && lease.epoch === epoch && lease.until > now);
}

/** A shared-state row: a runner cursor or a triage mark (`table`), with `value` null for a deleted one. */
export interface SharedRow {
  table: "cursors" | "seen";
  key: string;
  value: string | null;
}

export function validRows(rows: unknown): rows is SharedRow[] {
  return Array.isArray(rows) && rows.every(row => row && typeof row === "object"
    && (row.table === "cursors" || row.table === "seen") && typeof row.key === "string" && row.key.length > 0
    && (row.value === null || typeof row.value === "string"));
}
