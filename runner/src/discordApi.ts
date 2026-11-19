/**
 * A small Discord REST client for the staff chat (chat.ts). The runner has no gateway connection:
 * it reads the staff channel, its chat threads and reactions by polling, which needs nothing
 * listening on the Mac and survives restarts by keeping cursors.
 */
export interface DiscordMessage {
  id: string;
  channel_id: string;
  content: string;
  author: { id: string; username: string; global_name?: string | null; bot?: boolean };
  timestamp: string;
  mentions?: { id: string }[];
  attachments?: { id: string; filename: string; url: string; size: number; content_type?: string }[];
  /** Present on replies (type 19) when the referenced message still exists. */
  referenced_message?: DiscordMessage | null;
  message_reference?: { message_id?: string };
  thread?: { id: string };
  embeds?: { title?: string; description?: string; url?: string; author?: { name?: string }; footer?: { text: string } }[];
  /** Reaction totals; `me` is the bot's own. */
  reactions?: { count: number; me: boolean; emoji: { id?: string | null; name: string | null } }[];
  guild_id?: string;
  /** Set by the staff chat (not Discord) on a message from another channel: where it was asked. */
  origin?: string;
  type?: number;
}

export interface Upload {
  name: string;
  data: Buffer;
}

export const DISCORD_API = "https://discord.com/api/v10";

export class DiscordApi {
  constructor(private token: string, private fetcher: typeof fetch = fetch) {}

  async request<T = unknown>(method: string, route: string, body?: unknown, retried = false): Promise<T> {
    const response = await this.fetcher(`${DISCORD_API}${route}`, {
      method,
      headers: {
        Authorization: `Bot ${this.token}`, "User-Agent": "isobot-runner (https://github.com, 0.1)",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    if (response.status === 429 && !retried) {
      const wait = Number((await response.json().catch(() => ({})) as { retry_after?: number }).retry_after ?? 1);
      if (wait <= 15) {
        await new Promise(resolve => setTimeout(resolve, wait * 1000));
        return this.request(method, route, body, true);
      }
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw Object.assign(new Error(`Discord ${method} ${route.replace(/\d{15,}/g, ":id")} returned HTTP ${response.status}: ${text.slice(0, 200)}`), { status: response.status });
    }
    if (response.status === 204) {
      await response.body?.cancel();
      return null as T;
    }
    return response.json() as Promise<T>;
  }

  /** Posts a message with files; Discord shows images inline. */
  async upload(channelId: string, payload: Record<string, unknown>, files: Upload[]): Promise<DiscordMessage> {
    const form = new FormData();
    form.append("payload_json", JSON.stringify({ ...payload, attachments: files.map((f, i) => ({ id: i, filename: f.name })) }));
    files.forEach((f, i) => form.append(`files[${i}]`, new Blob([new Uint8Array(f.data)]), f.name));
    const response = await this.fetcher(`${DISCORD_API}/channels/${channelId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bot ${this.token}`, "User-Agent": "isobot-runner (https://github.com, 0.1)" },
      body: form,
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error(`Discord upload returned HTTP ${response.status}: ${(await response.text().catch(() => "")).slice(0, 200)}`);
    return response.json() as Promise<DiscordMessage>;
  }

  /** Messages after `after`, oldest first. */
  async messagesAfter(channelId: string, after: string, limit = 50): Promise<DiscordMessage[]> {
    const list = await this.request<DiscordMessage[]>("GET", `/channels/${channelId}/messages?after=${after}&limit=${limit}`);
    return [...list].sort((a, b) => compareIds(a.id, b.id));
  }

  async latestMessageId(channelId: string): Promise<string | null> {
    const list = await this.request<DiscordMessage[]>("GET", `/channels/${channelId}/messages?limit=1`);
    return list[0]?.id ?? null;
  }

  /** User ids that reacted with `emoji` (unicode). */
  async reactors(channelId: string, messageId: string, emoji: string): Promise<string[]> {
    const users = await this.request<{ id: string }[]>("GET", `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}?limit=100`);
    return users.map(u => u.id);
  }

  async react(channelId: string, messageId: string, emoji: string): Promise<void> {
    await this.request("PUT", `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`);
  }

  async typing(channelId: string): Promise<void> {
    await this.request("POST", `/channels/${channelId}/typing`);
  }
}

/** Discord ids are snowflakes: compare as integers, not strings. */
export function compareIds(a: string, b: string): number {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}
