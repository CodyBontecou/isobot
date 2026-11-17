import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DiscordApi } from "./discordApi.js";

/**
 * The staff chat's Discord server tools: the owner's chat can read the server's layout, and propose
 * new channels, categories, edits and webhooks, which the runner carries out after 👍 like every
 * other chat action. Nothing here deletes anything or touches roles and members.
 *
 * Errors meant for the model are thrown as `fail(message)`, which the caller maps to its ToolError.
 */
export interface DiscordAdmin {
  api: Pick<DiscordApi, "request">;
  guildId: string;
  /** Where created webhook URLs are saved (a runner secret: never posted, never readable by agents). */
  webhookDir: string;
}

export type DiscordAction =
  | { kind: "create_channel"; name: string; type: ChannelKind; parentId: string | null; topic: string; private: boolean }
  | { kind: "create_category"; name: string; private: boolean }
  | { kind: "edit_channel"; channelId: string; was: string; name?: string; topic?: string; parentId?: string | null }
  | { kind: "create_webhook"; channelId: string; channelName: string; name: string };

export const DISCORD_ACTIONS = ["create_channel", "create_category", "edit_channel", "create_webhook"] as const;

type ChannelKind = "text" | "announcement" | "forum";
const TYPE_IDS: Record<ChannelKind, number> = { text: 0, announcement: 5, forum: 15 };
const CATEGORY = 4;
const VIEW_CHANNEL = 1n << 10n;

interface Overwrite { id: string; type: number; allow: string; deny: string }
interface Channel { id: string; type: number; name: string; parent_id?: string | null; topic?: string | null; position?: number; permission_overwrites?: Overwrite[] }

export interface Place { id: string; name: string; kind: string; category: string | null; private: boolean; topic?: string }

export async function layout(admin: DiscordAdmin): Promise<{ channels: Channel[]; places: Place[] }> {
  const channels = await admin.api.request<Channel[]>("GET", `/guilds/${admin.guildId}/channels`);
  const names = new Map(channels.filter(c => c.type === CATEGORY).map(c => [c.id, c.name]));
  const places = [...channels]
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map(c => ({
      id: c.id, name: c.name, kind: kindName(c.type), category: c.parent_id ? names.get(c.parent_id) ?? c.parent_id : null,
      private: hidesEveryone(c, admin.guildId), ...(c.topic ? { topic: c.topic.slice(0, 200) } : {}),
    }));
  return { channels, places };
}

/** Validates a proposal against the server as it is now, and spells out what 👍 will do. */
export async function prepareDiscord(kind: string, args: Record<string, unknown>, admin: DiscordAdmin, fail: (message: string) => Error): Promise<{ action: DiscordAction; summary: string }> {
  const { channels } = await layout(admin);
  const where = (parentId: string | null | undefined) => parentId ? `in **${channels.find(c => c.id === parentId)?.name ?? parentId}**` : "at the top level (no category)";
  switch (kind) {
    case "create_channel": {
      const type = channelKind(args.type, fail);
      const name = channelName(args.name, fail);
      const parent = args.category === undefined || args.category === "" ? null : find(channels, args.category, [CATEGORY], fail);
      if (channels.some(c => c.name === name && (c.parent_id ?? null) === (parent?.id ?? null) && c.type !== CATEGORY)) throw fail(`#${name} already exists ${where(parent?.id)}`);
      const topic = text(args.topic, 1024);
      const isPrivate = args.private === true;
      const access = isPrivate ? "private: hidden from @everyone" : parent ? `same permissions as ${parent.name}${hidesEveryone(parent, admin.guildId) ? " (private)" : ""}` : "visible to everyone";
      return {
        action: { kind, name, type, parentId: parent?.id ?? null, topic, private: isPrivate },
        summary: `🧩 **Create ${type} channel #${name}** ${where(parent?.id)}\nAccess: ${access}${topic ? `\nTopic: ${topic.slice(0, 300)}` : ""}`,
      };
    }
    case "create_category": {
      const name = text(args.name, 100);
      if (!name) throw fail("create_category needs a name");
      if (channels.some(c => c.type === CATEGORY && c.name.toLowerCase() === name.toLowerCase())) throw fail(`a category named ${name} already exists`);
      const isPrivate = args.private === true;
      return { action: { kind, name, private: isPrivate }, summary: `🗂 **Create category ${name}**\nAccess: ${isPrivate ? "private: hidden from @everyone" : "visible to everyone"}` };
    }
    case "edit_channel": {
      const channel = find(channels, args.channel, [0, 5, 15, CATEGORY], fail);
      const action: DiscordAction = { kind, channelId: channel.id, was: channel.name };
      const changes: string[] = [];
      if (args.name !== undefined && args.name !== "") {
        action.name = channel.type === CATEGORY ? text(args.name, 100) : channelName(args.name, fail);
        changes.push(`rename to **${action.name}**`);
      }
      if (args.topic !== undefined) {
        if (channel.type === CATEGORY) throw fail("categories have no topic");
        action.topic = text(args.topic, 1024);
        changes.push(action.topic ? `topic: ${action.topic.slice(0, 300)}` : "clear the topic");
      }
      if (args.category !== undefined) {
        if (channel.type === CATEGORY) throw fail("a category can't go inside another category");
        const parent = args.category === "" || args.category === null ? null : find(channels, args.category, [CATEGORY], fail);
        action.parentId = parent?.id ?? null;
        const access = parent ? `takes ${parent.name}'s permissions${hidesEveryone(parent, admin.guildId) ? " (private)" : " (visible to everyone)"}` : "keeps its own permissions";
        changes.push(`move ${where(parent?.id)}; it ${access}`);
      }
      if (!changes.length) throw fail("edit_channel needs a new name, topic or category");
      return { action, summary: `✏️ **Edit #${channel.name}**\n${changes.map(c => `- ${c}`).join("\n")}` };
    }
    case "create_webhook": {
      const channel = find(channels, args.channel, [0, 5, 15], fail);
      const name = text(args.name, 80) || "isobot";
      if (/clyde|discord/i.test(name)) throw fail("Discord refuses webhook names containing \"clyde\" or \"discord\"");
      return {
        action: { kind, channelId: channel.id, channelName: channel.name, name },
        summary: `🪝 **Create webhook "${name}" on #${channel.name}**\nIts URL is saved on the runner's Mac (in \`webhooks/\` in isobot's home), never posted here.`,
      };
    }
    default:
      throw fail(`unknown action "${kind}"`);
  }
}

/** Carries out a confirmed Discord proposal. Re-checks the server, since it may have changed since. */
export async function executeDiscord(action: DiscordAction, admin: DiscordAdmin): Promise<string> {
  const { channels } = await layout(admin);
  const link = (id: string) => `<#${id}>`;
  switch (action.kind) {
    case "create_channel": {
      const parent = action.parentId ? channels.find(c => c.id === action.parentId) : undefined;
      if (action.parentId && !parent) throw new Error("the category no longer exists");
      if (channels.some(c => c.name === action.name && (c.parent_id ?? null) === action.parentId && c.type !== CATEGORY)) throw new Error(`#${action.name} already exists`);
      const overwrites = parent?.permission_overwrites ?? [];
      const created = await admin.api.request<Channel>("POST", `/guilds/${admin.guildId}/channels`, {
        name: action.name, type: TYPE_IDS[action.type], ...(action.parentId ? { parent_id: action.parentId } : {}),
        ...(action.topic ? { topic: action.topic } : {}),
        permission_overwrites: action.private ? hideFromEveryone(overwrites, admin.guildId) : overwrites,
      });
      return `Created ${link(created.id)}.`;
    }
    case "create_category": {
      const created = await admin.api.request<Channel>("POST", `/guilds/${admin.guildId}/channels`, {
        name: action.name, type: CATEGORY, permission_overwrites: action.private ? hideFromEveryone([], admin.guildId) : [],
      });
      return `Created category ${created.name}.`;
    }
    case "edit_channel": {
      if (!channels.some(c => c.id === action.channelId)) throw new Error(`#${action.was} no longer exists`);
      if (action.parentId && !channels.some(c => c.id === action.parentId)) throw new Error("the category no longer exists");
      await admin.api.request("PATCH", `/channels/${action.channelId}`, {
        ...(action.name !== undefined ? { name: action.name } : {}),
        ...(action.topic !== undefined ? { topic: action.topic || null } : {}),
        ...(action.parentId !== undefined ? { parent_id: action.parentId, ...(action.parentId ? { lock_permissions: true } : {}) } : {}),
      });
      return `Updated ${link(action.channelId)}.`;
    }
    case "create_webhook": {
      if (!channels.some(c => c.id === action.channelId)) throw new Error(`#${action.channelName} no longer exists`);
      const hook = await admin.api.request<{ id: string; token: string }>("POST", `/channels/${action.channelId}/webhooks`, { name: action.name });
      mkdirSync(admin.webhookDir, { recursive: true, mode: 0o700 });
      chmodSync(admin.webhookDir, 0o700);
      const base = `${action.channelName}-${action.name}`.toLowerCase().replace(/[^\w-]+/g, "-").slice(0, 80);
      let file = path.join(admin.webhookDir, `${base}.url`);
      if (existsSync(file)) file = path.join(admin.webhookDir, `${base}-${hook.id}.url`);
      writeFileSync(file, `https://discord.com/api/webhooks/${hook.id}/${hook.token}\n`, { mode: 0o600 });
      return `Created webhook "${action.name}" on ${link(action.channelId)}; its URL is in \`${file}\` on the runner's Mac.`;
    }
  }
}

/** Accepts an id, a name, `#name`, `<#id>` or `category/name`; refuses ambiguity instead of guessing. */
function find(channels: Channel[], value: unknown, types: number[], fail: (message: string) => Error): Channel {
  const raw = String(value ?? "").trim().replace(/^<#(\d+)>$/, "$1").replace(/^#/, "");
  if (!raw) throw fail("name the channel or category");
  const pool = channels.filter(c => types.includes(c.type));
  if (/^\d{17,20}$/.test(raw)) {
    const byId = pool.find(c => c.id === raw);
    if (!byId) throw fail(`no channel or category with id ${raw}`);
    return byId;
  }
  const categories = new Map(channels.filter(c => c.type === CATEGORY).map(c => [c.id, c.name.toLowerCase()]));
  const slash = raw.lastIndexOf("/");
  const [category, name] = slash > 0 ? [raw.slice(0, slash).toLowerCase(), raw.slice(slash + 1).toLowerCase()] : [null, raw.toLowerCase()];
  const found = pool.filter(c => c.name.toLowerCase() === name && (category === null || categories.get(c.parent_id ?? "") === category));
  if (found.length === 1) return found[0];
  if (!found.length) throw fail(`no ${types.length === 1 && types[0] === CATEGORY ? "category" : "channel"} named ${raw}; list_discord_channels shows the server`);
  throw fail(`${found.length} channels are named ${raw}; say which, e.g. "${found.map(c => `${categories.get(c.parent_id ?? "") ?? "?"}/${c.name}`).join("\" or \"")}", or use its id`);
}

/** Discord's rules for text channel names: lower case, no spaces, at most 100 characters. */
function channelName(value: unknown, fail: (message: string) => Error): string {
  const name = String(value ?? "").trim().toLowerCase().replace(/^#/, "").replace(/\s+/g, "-").replace(/[^\p{L}\p{N}_-]+/gu, "").replace(/-{2,}/g, "-").slice(0, 100);
  if (!name) throw fail("the channel needs a name");
  return name;
}

function channelKind(value: unknown, fail: (message: string) => Error): ChannelKind {
  const kind = value === undefined || value === "" ? "text" : String(value);
  if (!(kind in TYPE_IDS)) throw fail(`type must be text, announcement or forum`);
  return kind as ChannelKind;
}

function text(value: unknown, max: number): string {
  return String(value ?? "").trim().slice(0, max);
}

function kindName(type: number): string {
  return ({ 0: "text", 2: "voice", 4: "category", 5: "announcement", 13: "stage", 15: "forum", 16: "media" } as Record<number, string>)[type] ?? `type ${type}`;
}

function hidesEveryone(channel: Channel, guildId: string): boolean {
  const everyone = channel.permission_overwrites?.find(o => o.id === guildId);
  return everyone ? (BigInt(everyone.deny) & VIEW_CHANNEL) !== 0n : false;
}

/** The given overwrites with @everyone denied View Channel (the server owner and admins still see it). */
function hideFromEveryone(overwrites: Overwrite[], guildId: string): Overwrite[] {
  const rest = overwrites.filter(o => o.id !== guildId);
  const everyone = overwrites.find(o => o.id === guildId) ?? { id: guildId, type: 0, allow: "0", deny: "0" };
  return [...rest, { ...everyone, allow: String(BigInt(everyone.allow) & ~VIEW_CHANNEL), deny: String(BigInt(everyone.deny) | VIEW_CHANNEL) }];
}
