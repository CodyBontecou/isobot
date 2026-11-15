import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Client } from "discord.js";
import { createDiscordHistory, HistoryError } from "./history.js";

export async function handleDiscordHistory(req: IncomingMessage, res: ServerResponse, client: Client): Promise<void> {
  res.setHeader("Content-Type", "application/json");res.setHeader("Cache-Control", "no-store");
  const token = process.env.ISOBOT_API_TOKEN;
  const hash = (value: string) => createHash("sha256").update(value).digest();
  if (!token || !timingSafeEqual(hash(req.headers.authorization ?? ""),hash(`Bearer ${token}`))) {
    res.writeHead(401);res.end(JSON.stringify({ error: "Unauthorized" }));return;
  }
  if (req.method !== "GET") {res.writeHead(405);res.end(JSON.stringify({ error: "Use GET" }));return;}
  if (!client.isReady()) {res.writeHead(503);res.end(JSON.stringify({ error: "Discord is reconnecting" }));return;}
  try {
    const guildId = process.env.DISCORD_HISTORY_GUILD_ID;
    if (!guildId) throw new HistoryError(503, "Discord history server is not configured");
    const url = new URL(req.url!, "http://container");
    const result = await createDiscordHistory(client,guildId).query(url.pathname.slice("/api/discord/".length),url.searchParams);
    res.writeHead(200);res.end(JSON.stringify(result));
  } catch (err) {
    const status = err instanceof HistoryError ? err.status : 502;
    res.writeHead(status);res.end(JSON.stringify({ error: err instanceof HistoryError ? err.message : "Discord read failed; check permissions or retry later" }));
  }
}
