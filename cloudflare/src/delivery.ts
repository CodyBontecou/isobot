import { DurableObject } from "cloudflare:workers";
import type { TicketRequest } from "../../src/agent/types.js";
import type { Bindings } from "./index.js";

/** Durable handoff to the one Discord Gateway bridge, including delivered tombstones. */
export class DeliveryInbox extends DurableObject<Bindings> {
  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS discord_deliveries (
      event_id TEXT PRIMARY KEY,
      input TEXT NOT NULL,
      delivered INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      last_checked_at INTEGER NOT NULL DEFAULT 0
    )`);
  }

  remember(input: TicketRequest): { ticket: TicketRequest; delivered: boolean } {
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO discord_deliveries (event_id, input, created_at) VALUES (?, ?, ?)",
      input.eventId, JSON.stringify(input), Date.now(),
    );
    const row = this.ctx.storage.sql.exec<{ input: string; delivered: number }>(
      "SELECT input, delivered FROM discord_deliveries WHERE event_id = ?", input.eventId,
    ).one();
    // All rows are validated TicketRequests received from the authenticated Worker.
    return { ticket: JSON.parse(row.input), delivered: row.delivered === 1 };
  }

  pending(): TicketRequest[] {
    const rows = this.ctx.storage.sql.exec<{ event_id: string; input: string }>(
      "SELECT event_id, input FROM discord_deliveries WHERE delivered = 0 ORDER BY last_checked_at, created_at LIMIT 100",
    ).toArray();
    const now = Date.now();
    for (const row of rows) {
      this.ctx.storage.sql.exec("UPDATE discord_deliveries SET last_checked_at = ? WHERE event_id = ?", now, row.event_id);
    }
    return rows.map(row => JSON.parse(row.input));
  }

  wasDelivered(eventId: string): boolean {
    return this.ctx.storage.sql.exec<{ delivered: number }>(
      "SELECT delivered FROM discord_deliveries WHERE event_id = ?", eventId,
    ).toArray()[0]?.delivered === 1;
  }

  delivered(eventId: string): void {
    this.ctx.storage.sql.exec("UPDATE discord_deliveries SET delivered = 1 WHERE event_id = ?", eventId);
  }
}
