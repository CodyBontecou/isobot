import { DurableObject } from "cloudflare:workers";
import { claim, LEASE_MS, type Lease, mayWrite, release, type SharedRow, validRows } from "./coord.js";
import { onAlarm, onPing, RETRY_MS, type Step, type WatchState } from "./watch.js";

interface Env {
  WATCHDOG: DurableObjectNamespace<Watchdog>;
  PING_TOKEN: string;
  DISCORD_WEBHOOK_URL: string;
  GRACE_MINUTES?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return new Response("ok");
    const match = /^\/(ping|status|lease|release|shared)\/([^/]+)$/.exec(url.pathname);
    if (!match || !env.PING_TOKEN || !sameSecret(match[2], env.PING_TOKEN)) return new Response("not found", { status: 404 });
    const watchdog = env.WATCHDOG.getByName("runner");
    const route = `${request.method} ${match[1]}`;
    if (route === "POST ping") {
      await watchdog.ping();
      return new Response("ok");
    }
    if (route === "GET status") return Response.json(await watchdog.status());
    if (route === "GET shared") {
      const since = Number(url.searchParams.get("since") ?? 0);
      return Response.json(await watchdog.pull(Number.isFinite(since) ? since : 0));
    }
    if (route === "POST lease" || route === "POST release" || route === "POST shared") {
      const body = await request.json().catch(() => null) as Record<string, unknown> | null;
      const runnerId = typeof body?.runnerId === "string" && /^[\w.-]{1,64}$/.test(body.runnerId) ? body.runnerId : null;
      if (!body || !runnerId) return new Response("bad request", { status: 400 });
      if (route === "POST lease") return Response.json(await watchdog.claim(runnerId, body.preferred === true));
      const epoch = Number(body.epoch);
      if (route === "POST release") return Response.json(await watchdog.release(runnerId, epoch));
      if (!validRows(body.rows)) return new Response("bad rows", { status: 400 });
      const result = await watchdog.push(runnerId, epoch, body.rows, body.seed === true);
      return Response.json(result, { status: result.ok ? 200 : 409 });
    }
    return new Response("method not allowed", { status: 405 });
  },
} satisfies ExportedHandler<Env>;

/** What a runner's claim gets back: whether it leads, who does, and how far the shared state has got. */
export interface ClaimReply {
  leading: boolean;
  holder: string;
  epoch: number;
  until: number;
  yieldTo: string | null;
  version: number;
}

/** Runners seen claiming, for `runner status` and the board. */
export type RunnersSeen = Record<string, { at: number; preferred: boolean; leading: boolean }>;

const PULL_LIMIT = 2000;

export class Watchdog extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // The leader's shared state (coord.ts): every row stamped with the version that last wrote it.
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS shared (
      tbl TEXT NOT NULL, key TEXT NOT NULL, value TEXT, version INTEGER NOT NULL, PRIMARY KEY (tbl, key)
    )`);
    ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS shared_version ON shared (version)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL)");
  }

  private get graceMs(): number {
    const minutes = Number(this.env.GRACE_MINUTES ?? 10);
    return (Number.isFinite(minutes) && minutes >= 2 ? minutes : 10) * 60_000;
  }

  private async load(): Promise<WatchState> {
    return (await this.ctx.storage.get<WatchState>("state")) ?? { lastPing: null, alertedAt: null };
  }

  async ping(): Promise<void> {
    await this.apply(onPing(await this.load(), Date.now(), this.graceMs));
  }

  async status(): Promise<WatchState & { graceMinutes: number; lease: Lease | null; runners: RunnersSeen; version: number }> {
    return {
      ...(await this.load()), graceMinutes: this.graceMs / 60_000,
      lease: await this.lease(), runners: await this.runners(), version: this.version(),
    };
  }

  async claim(runnerId: string, preferred: boolean): Promise<ClaimReply> {
    const now = Date.now();
    const { lease, leading } = claim(await this.lease(), { runnerId, preferred }, now, LEASE_MS);
    const runners = await this.runners();
    runners[runnerId] = { at: now, preferred, leading };
    // Runners gone for a week drop off the list.
    for (const [id, seen] of Object.entries(runners)) if (now - seen.at > 7 * 86_400_000) delete runners[id];
    await this.ctx.storage.put({ lease, runners });
    return { leading, holder: lease.holder, epoch: lease.epoch, until: lease.until, yieldTo: lease.yieldTo, version: this.version() };
  }

  async release(runnerId: string, epoch: number): Promise<{ holder: string | null }> {
    const lease = release(await this.lease(), runnerId, epoch, Date.now(), LEASE_MS);
    if (lease) await this.ctx.storage.put("lease", lease);
    return { holder: lease && lease.until > Date.now() ? lease.holder : null };
  }

  /**
   * Writes shared rows, only from the runner that holds the lease under that epoch. `seed` loads the first copy
   * (from the Mac that was the primary) and is taken only while nothing has been written yet.
   */
  async push(runnerId: string, epoch: number, rows: SharedRow[], seed: boolean): Promise<{ ok: boolean; version: number; reason?: string }> {
    const current = this.version();
    if (seed ? current !== 0 : !mayWrite(await this.lease(), runnerId, epoch, Date.now())) {
      return { ok: false, version: current, reason: seed ? "already seeded" : "not the leader" };
    }
    // Each row gets its own version, so a reader can page through them in order and resume anywhere.
    let version = current;
    this.ctx.storage.transactionSync(() => {
      for (const row of rows) {
        this.ctx.storage.sql.exec(`INSERT INTO shared (tbl, key, value, version) VALUES (?, ?, ?, ?)
          ON CONFLICT (tbl, key) DO UPDATE SET value = excluded.value, version = excluded.version`, row.table, row.key, row.value, ++version);
      }
      this.ctx.storage.sql.exec("INSERT INTO meta (k, v) VALUES ('version', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v", version);
    });
    return { ok: true, version };
  }

  /** Rows written after `since`, oldest first, a page at a time; `version` is where the next page starts. */
  async pull(since: number): Promise<{ rows: SharedRow[]; version: number; more: boolean }> {
    const rows = this.ctx.storage.sql.exec<{ tbl: string; key: string; value: string | null; version: number }>(
      "SELECT tbl, key, value, version FROM shared WHERE version > ? ORDER BY version LIMIT ?", since, PULL_LIMIT).toArray();
    const through = rows.length ? rows[rows.length - 1].version : Math.max(since, this.version());
    return {
      rows: rows.map(row => ({ table: row.tbl as SharedRow["table"], key: row.key, value: row.value })),
      version: through, more: through < this.version(),
    };
  }

  private async lease(): Promise<Lease | null> {
    return (await this.ctx.storage.get<Lease>("lease")) ?? null;
  }

  private async runners(): Promise<RunnersSeen> {
    return (await this.ctx.storage.get<RunnersSeen>("runners")) ?? {};
  }

  private version(): number {
    const row = this.ctx.storage.sql.exec<{ v: number }>("SELECT v FROM meta WHERE k = 'version'").toArray()[0];
    return row?.v ?? 0;
  }

  async alarm(): Promise<void> {
    const step = onAlarm(await this.load(), Date.now(), this.graceMs);
    if (step) await this.apply(step);
  }

  private async apply(step: Step): Promise<void> {
    const posted = !step.message || await this.post(step.message);
    if (!posted && step.state.alertedAt !== null) {
      // An alert Discord didn't take: keep the old state so the next alarm sends it again.
      await this.ctx.storage.setAlarm(Date.now() + RETRY_MS);
      return;
    }
    // A lost "back" message isn't worth retrying; the runner is healthy either way.
    await this.ctx.storage.put("state", step.state);
    await this.ctx.storage.setAlarm(step.alarmAt);
  }

  private async post(content: string): Promise<boolean> {
    try {
      const response = await fetch(this.env.DISCORD_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}

function sameSecret(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  return left.byteLength === right.byteLength && crypto.subtle.timingSafeEqual(left, right);
}
