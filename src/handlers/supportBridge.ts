import { createHash } from "node:crypto";
import {
  ChannelType,
  Events,
  OverwriteType,
  PermissionFlagsBits,
  type Client,
  type ThreadChannel,
} from "discord.js";

interface Job {
  id: string;
  account: string;
  conversationId: string;
  generation: number;
  payload: string;
}
const interval = 15000;

/** Dedicated deterministic support relay. Public forum handlers never see these jobs. */
export function registerSupportBridge(client: Client): () => void {
  const token = process.env.SUPPORT_BRIDGE_TOKEN,
    origin = process.env.ISOBOT_AGENT_URL,
    channelId = process.env.SUPPORT_DISCORD_CHANNEL_ID;
  const staff = new Set(
    (process.env.SUPPORT_DISCORD_STAFF_IDS ?? "")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean),
  );
  if (!token || !origin || !channelId || staff.size === 0) return () => {};
  const url = new URL(origin);
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error("Invalid support service origin");
  let stopped = false,
    polling = false;
  const known = new Map<string, ThreadChannel>();
  async function call(path: string, body?: unknown) {
    const response = await fetch(`${url.origin}/api/support-bridge/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    if (response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Support bridge failed (${response.status})`);
    }
    return await response.json();
  }
  async function channel() {
    const c = await client.channels.fetch(channelId!);
    if (!c || c.type !== ChannelType.GuildText)
      throw new Error("Support channel must be a private text channel");
    const everyone = c.permissionOverwrites.cache.get(c.guild.id);
    if (
      !everyone?.deny.has(PermissionFlagsBits.ViewChannel) ||
      c.permissionOverwrites.cache.some(
        (v) =>
          v.allow.has(PermissionFlagsBits.ViewChannel) &&
          !(
            v.type === OverwriteType.Member &&
            (v.id === client.user?.id || staff.has(v.id))
          ),
      )
    )
      throw new Error("Support channel privacy needs attention");
    return c;
  }
  async function thread(job: Job, create = true) {
    const name = `support-${job.account.slice(-12)}-${createHash("sha256").update(job.conversationId).digest("hex").slice(0, 36)}`;
    const c = await channel();
    const active = await c.threads.fetchActive();
    let found = active.threads.find((t) => t.name === name);
    if (!found) {
      let before: Date | undefined;
      for (let page = 0; page < 100; page++) {
        const archived = await c.threads.fetchArchived({
          type: "private",
          limit: 100,
          ...(before ? { before } : {}),
          fetchAll: false,
        });
        found = archived.threads.find((t) => t.name === name);
        if (found || !archived.hasMore) break;
        const last = archived.threads.last()?.archiveTimestamp;
        if (!last) throw new Error("Thread reconciliation is incomplete");
        before = new Date(last);
        if (page === 99) throw new Error("Thread reconciliation limit reached");
      }
    }
    if (!found && !create) return null;
    if (!found)
      found = await c.threads.create({
        name,
        type: ChannelType.PrivateThread,
        invitable: false,
        reason: "Account-scoped in-app support",
      });
    if (create && found.archived) await found.setArchived(false);
    if (create) for (const id of staff) await found.members.add(id);
    known.set(found.id, found);
    return found;
  }
  async function ingest(thread: ThreadChannel) {
    // Worker checkpoints staff IDs; repeat bounded scans are safe after reconnect.
    const history: import("discord.js").Message[] = [];
    let before: string | undefined;
    for (let page = 0; page < 10; page++) {
      const messages = await thread.messages.fetch({
        limit: 100,
        ...(before ? { before } : {}),
      });
      history.push(...messages.values());
      if (messages.size < 100) break;
      before = messages.last()?.id;
    }
    history.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
    for (const m of history)
      if (!m.author.bot && staff.has(m.author.id) && m.content.trim())
        await call("event", { threadId: thread.id, id: m.id, text: m.content });
  }
  async function poll() {
    if (polling || stopped || !client.isReady()) return;
    polling = true;
    try {
      const response = (await call("jobs")) as { jobs: Job[] } | null;
      for (const job of response?.jobs ?? []) {
        const content = JSON.parse(job.payload) as {
          id: string;
          text: string;
          author: string;
          action?: string;
        };
        const t = await thread(job, !content.action);
        if (content.action) {
          if (t) {
            if (content.action === "delete-thread") await t.delete();
            else await t.setArchived(true);
          }
          await call("ack", {
            account: job.account,
            conversationId: job.conversationId,
            id: job.id,
            ...(t
              ? { threadId: t.id, deleted: content.action === "delete-thread" }
              : {}),
          });
          continue;
        }
        if (!t) continue;
        const marker = `[support:${job.id}]`;
        const recent = await t.messages.fetch({ limit: 100 });
        if (
          !recent.some(
            (m) =>
              m.author.id === client.user?.id && m.content.includes(marker),
          )
        ) {
          await t.send({
            content: `**${content.author === "user" ? "User" : "Isobot"}**\n${content.text.slice(0, 1700)}\n${marker}`,
            allowedMentions: { parse: [] },
            nonce: createHash("sha256")
              .update(`${job.account}:${job.conversationId}:${job.id}`)
              .digest("hex")
              .slice(0, 25),
            enforceNonce: true,
          });
        }
        await call("ack", {
          account: job.account,
          conversationId: job.conversationId,
          id: job.id,
          threadId: t.id,
        });
        await ingest(t);
      }
      const routes = (await call("threads")) as {
        threads: { id: string }[];
      } | null;
      for (const route of routes?.threads ?? []) {
        const t = await client.channels.fetch(route.id).catch(() => null);
        if (t?.isThread() && !t.archived && t.parentId === channelId) {
          await channel();
          await ingest(t);
        }
      }
    } catch {
      console.warn("[isobot] support relay will retry");
    } finally {
      polling = false;
    }
  }
  const onMessage = async (message: import("discord.js").Message) => {
    if (
      stopped ||
      message.author.bot ||
      !staff.has(message.author.id) ||
      !message.content.trim() ||
      !message.channel.isThread() ||
      message.channel.parentId !== channelId
    )
      return;
    try {
      await channel();
      await call("event", {
        threadId: message.channelId,
        id: message.id,
        text: message.content,
      });
    } catch {
      console.warn("[isobot] support reply will be recovered from history");
    }
  };
  client.on(Events.MessageCreate, onMessage);
  client.on(Events.ClientReady, () => void poll());
  const timer = setInterval(() => void poll(), interval);
  return () => {
    stopped = true;
    clearInterval(timer);
    client.off(Events.MessageCreate, onMessage);
  };
}
