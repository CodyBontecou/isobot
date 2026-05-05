import type { AnyThreadChannel, Message, TextBasedChannel } from "discord.js";

export interface MessageSnapshot {
  authorTag: string;
  authorId: string;
  content: string;
  jumpUrl: string;
  createdAt: string;
}

export interface ReplyContext {
  trigger: MessageSnapshot;
  parent: MessageSnapshot;
  recent: MessageSnapshot[];
  channelName: string;
  guildName: string;
}

function snapshot(message: Message): MessageSnapshot {
  return {
    authorTag: message.author.tag,
    authorId: message.author.id,
    content: message.content,
    jumpUrl: message.url,
    createdAt: message.createdAt.toISOString(),
  };
}

export async function fetchReplyContext(message: Message): Promise<ReplyContext | null> {
  const parentId = message.reference?.messageId;
  if (!parentId) return null;
  if (!message.guild) return null;

  const channel = message.channel as TextBasedChannel;
  if (!("messages" in channel)) return null;

  const parent = await channel.messages.fetch(parentId);

  const recentCollection = await channel.messages.fetch({ limit: 10, before: message.id });
  const recent = [...recentCollection.values()]
    .filter((m) => m.id !== parent.id)
    .reverse()
    .map(snapshot);

  const channelName = "name" in channel && typeof channel.name === "string" ? channel.name : "unknown";

  return {
    trigger: snapshot(message),
    parent: snapshot(parent),
    recent,
    channelName,
    guildName: message.guild.name,
  };
}

export async function fetchThreadStarterContext(
  message: Message,
  thread: AnyThreadChannel,
): Promise<ReplyContext | null> {
  if (!message.guild) return null;

  let parent: Message | null = null;
  try {
    parent = await thread.fetchStarterMessage();
  } catch {
    parent = null;
  }

  if (!parent) {
    const earliest = await thread.messages.fetch({ limit: 100, after: "0" }).catch(() => null);
    if (earliest) {
      const candidate = [...earliest.values()]
        .reverse()
        .find((m) => m.id !== message.id && !m.author.bot);
      if (candidate) parent = candidate;
    }
  }

  if (!parent) return null;

  const recentCollection = await thread.messages
    .fetch({ limit: 10, before: message.id })
    .catch(() => null);
  const recent = recentCollection
    ? [...recentCollection.values()]
        .filter((m) => m.id !== parent!.id)
        .reverse()
        .map(snapshot)
    : [];

  const parentChannelName =
    thread.parent && "name" in thread.parent && typeof thread.parent.name === "string"
      ? thread.parent.name
      : thread.name;

  return {
    trigger: snapshot(message),
    parent: snapshot(parent),
    recent,
    channelName: parentChannelName,
    guildName: message.guild.name,
  };
}
