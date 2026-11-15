import { PermissionFlagsBits, type Client } from "discord.js";

export interface HistoryChannel { id: string; name: string; type: number; parentId: string | null }
export interface HistoryAccess {
  channels(): Promise<HistoryChannel[]>;
  channel(id: string): Promise<HistoryChannel>;
  get(path: string, query: URLSearchParams): Promise<unknown>;
}
export class HistoryError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
const snowflake = /^\d{17,20}$/;
function id(value: string | null, name: string): string {
  if (!value || !snowflake.test(value)) throw new HistoryError(400, `Invalid ${name}`);
  return value;
}
function integer(value: string | null, fallback: number, max: number): number {
  const n = value === null ? fallback : Number(value);
  if (!Number.isInteger(n) || n < 0 || n > max) throw new HistoryError(400, "Invalid pagination bounds");
  return n;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HistoryError(502, "Unexpected Discord response");
  return value as Record<string, unknown>;
}
export class DiscordHistory {
  constructor(private access: HistoryAccess, readonly guildId: string) { id(guildId, "configured guild"); }

  private async message(value: unknown) {
    const m = record(value);
    const channelId = id(String(m.channel_id ?? ""), "message channel");
    const channel = await this.access.channel(channelId);
    const author = record(m.author);
    const messageId = id(String(m.id ?? ""), "message");
    return {
      id: messageId, channelId, channelName: channel.name,
      author: { id: author.id, username: author.username, displayName: author.global_name ?? author.username },
      createdAt: m.timestamp, content: String(m.content ?? "").slice(0, 4000),
      jumpUrl: `https://discord.com/channels/${this.guildId}/${channelId}/${messageId}`,
      replyTo: m.message_reference && record(m.message_reference).message_id,
      attachments: Array.isArray(m.attachments) ? m.attachments.slice(0, 10).map(a => {
        const item = record(a); return { filename: item.filename, url: item.url, contentType: item.content_type };
      }) : [],
      embeds: Array.isArray(m.embeds) ? m.embeds.slice(0, 4).map(e => {
        const item = record(e); return { title: String(item.title ?? "").slice(0, 256), description: String(item.description ?? "").slice(0, 2000), url: item.url };
      }) : [],
    };
  }

  async query(path: string, params: URLSearchParams): Promise<unknown> {
    const allowed: Record<string, string[]> = {
      channels: [], threads: ["channelId", "before", "limit"],
      search: ["query", "channelId", "authorId", "beforeId", "afterId", "offset", "limit"],
      messages: ["channelId", "beforeId", "aroundId", "limit"],
    };
    if (!allowed[path]) throw new HistoryError(404, "Unknown history operation");
    for (const key of params.keys()) if (!allowed[path].includes(key) || params.getAll(key).length !== 1) throw new HistoryError(400, "Unknown or duplicate query parameter");
    if (path === "channels") return { guildId: this.guildId, channels: await this.access.channels(), scope: "Visible guild channels and active threads. Use threads to page public archived threads." };
    if (path === "threads") {
      const parent = await this.access.channel(id(params.get("channelId"), "channelId"));
      const query = new URLSearchParams({ limit: String(Math.max(1, integer(params.get("limit"), 25, 50))) });
      if (params.has("before")) {
        const before = params.get("before")!;
        if (!/^\d{4}-\d\d-\d\dT/.test(before) || !Number.isFinite(Date.parse(before))) throw new HistoryError(400, "Invalid archive timestamp cursor");
        query.set("before", before);
      }
      const data = record(await this.access.get(`/channels/${parent.id}/threads/archived/public`, query));
      const threads = Array.isArray(data.threads) ? data.threads.map(t => {
        const thread = record(t);return { id: thread.id, name: thread.name, parentId: thread.parent_id, archivedAt: thread.thread_metadata && record(thread.thread_metadata).archive_timestamp };
      }) : [];
      return { threads, hasMore: data.has_more === true, nextBefore: data.has_more && threads.length ? threads[threads.length - 1].archivedAt : undefined, scope: "Public archived threads in this channel; active threads are listed by channels." };
    }
    if (path === "messages") {
      const channel = await this.access.channel(id(params.get("channelId"), "channelId"));
      if ([4,15,16].includes(channel.type)) throw new HistoryError(400, "Select a text channel or thread; use threads for a forum");
      if (params.has("beforeId") && params.has("aroundId")) throw new HistoryError(400, "beforeId and aroundId are mutually exclusive");
      const limit = Math.max(1, integer(params.get("limit"), 20, 50));
      const query = new URLSearchParams({ limit: String(limit) });
      for (const [source, target] of [["beforeId", "before"], ["aroundId", "around"]]) if (params.has(source)) query.set(target, id(params.get(source), source));
      const data = await this.access.get(`/channels/${channel.id}/messages`, query);
      if (!Array.isArray(data)) throw new HistoryError(502, "Unexpected Discord message list");
      const messages = await Promise.all(data.map(m => this.message(m)));
      return { messages, nextBefore: !params.has("aroundId") && messages.length === limit ? messages[messages.length - 1].id : undefined, scope: "One bounded page, newest first; nextBefore continues older history." };
    }
    const text = params.get("query")?.trim();
    if (!text || text.length > 1024) throw new HistoryError(400, "Search query must contain 1–1024 characters");
    const offset = integer(params.get("offset"), 0, 9975);
    const limit = Math.max(1, integer(params.get("limit"), 10, 25));
    const query = new URLSearchParams({ content: text, limit: String(limit), offset: String(offset), sort_by: "timestamp", sort_order: "desc" });
    if (params.has("channelId")) {
      const channel = await this.access.channel(id(params.get("channelId"), "channelId"));query.set("channel_id", channel.id);
    }
    for (const [source,target] of [["authorId","author_id"],["beforeId","max_id"],["afterId","min_id"]]) if (params.has(source)) query.set(target,id(params.get(source),source));
    const data = record(await this.access.get(`/guilds/${this.guildId}/messages/search`, query));
    if (data.code === 110000) return { indexing: true, retryAfterSeconds: data.retry_after, messages: [], scope: "Discord is building its index; retry later. This is not an empty search result." };
    if (!Array.isArray(data.messages) || typeof data.total_results !== "number") throw new HistoryError(502, "Unexpected Discord search response");
    const batches = data.messages.flat().map(record);
    const hits = batches.some(m => m.hit === true) ? batches.filter(m => m.hit === true) : batches;
    const messages = [];
    let inaccessible = 0;
    for (const m of hits.slice(0,limit)) {
      try { messages.push(await this.message(m)); }
      catch (err) { if (err instanceof HistoryError && [403,404].includes(err.status)) inaccessible++; else throw err; }
    }
    return { messages, totalResults: data.total_results, offset, nextOffset: offset + limit < data.total_results && offset + limit <= 9975 ? offset + limit : undefined, inaccessible, scope: "Discord indexed guild history, limited by bot permissions. Counts may change; this is one page. No matches does not prove no discussion exists." };
  }
}

export function createDiscordHistory(client: Client, guildId: string): DiscordHistory {
  async function channel(channelId: string) {
    const c = await client.channels.fetch(channelId);
    if (!c || c.isDMBased() || c.guildId !== guildId || !client.user) throw new HistoryError(403, "Channel is outside the configured server or inaccessible");
    const permissions = c.permissionsFor(client.user);
    if (!permissions?.has(PermissionFlagsBits.ViewChannel) || (c.type !== 4 && !permissions.has(PermissionFlagsBits.ReadMessageHistory))) throw new HistoryError(403, "Bot cannot view this channel's history");
    return { id: c.id, name: c.name, type: c.type, parentId: c.parentId };
  }
  return new DiscordHistory({
    channel,
    async channels() {
      const guild = await client.guilds.fetch(guildId);
      const all = [...(await guild.channels.fetch()).values(), ...(await guild.channels.fetchActiveThreads()).threads.values()];
      const result = [];
      for (const c of all) if (c) { try { result.push(await channel(c.id)); } catch (err) { if (!(err instanceof HistoryError)) throw err; } }
      return result;
    },
    get: (path, query) => client.rest.get(path as `/${string}`, { query }),
  }, guildId);
}
