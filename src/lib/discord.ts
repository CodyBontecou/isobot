import { ChannelType, type Client, type ForumChannel } from "discord.js";

export function findHelpForum(client: Client, categoryName: string): ForumChannel | null {
  const wanted = categoryName.toLowerCase();
  for (const guild of client.guilds.cache.values()) {
    const category = guild.channels.cache.find(
      (c) => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === wanted,
    );
    if (!category) continue;
    const forum = guild.channels.cache.find(
      (c) =>
        c.type === ChannelType.GuildForum &&
        c.parentId === category.id &&
        c.name.toLowerCase() === "help",
    );
    if (forum) return forum as ForumChannel;
  }
  return null;
}
