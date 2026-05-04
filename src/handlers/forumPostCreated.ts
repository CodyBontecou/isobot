import {
  Events,
  ChannelType,
  type Client,
  type AnyThreadChannel,
  type ForumChannel,
  type Message,
} from "discord.js";
import { channelToRepo } from "../config/repos.js";
import { createIssue } from "../github/issues.js";

const TRACKING_PREFIX = "Tracked on GitHub:";
const FORUM_CHANNEL_NAME = "help";

const TRIGGERING_TAGS = new Set(["bug", "feature request"]);

const TAG_TO_LABEL: Record<string, string> = {
  bug: "bug",
  "feature request": "enhancement",
  question: "question",
};

const inFlight = new Set<string>();

export function registerForumPostCreated(client: Client): void {
  client.on(Events.ThreadCreate, async (thread, newlyCreated) => {
    try {
      if (!newlyCreated) return;
      if (thread.parent?.type !== ChannelType.GuildForum) return;
      const forum = thread.parent as ForumChannel;
      if (forum.name.toLowerCase() !== FORUM_CHANNEL_NAME) return;
      if (inFlight.has(thread.id)) return;
      inFlight.add(thread.id);
      try {
        await handle(thread, forum);
      } finally {
        inFlight.delete(thread.id);
      }
    } catch (err) {
      console.error("[isobot] forumPostCreated crashed:", err);
    }
  });
}

async function handle(thread: AnyThreadChannel, forum: ForumChannel): Promise<void> {
  const tagNames = (thread.appliedTags ?? [])
    .map((id) => forum.availableTags.find((t) => t.id === id)?.name.toLowerCase())
    .filter((n): n is string => !!n);

  if (!tagNames.some((n) => TRIGGERING_TAGS.has(n))) {
    console.log(`[isobot] forum-post ${thread.id}: no triggering tag (${tagNames.join(", ") || "none"}), skipping`);
    return;
  }

  const categoryName = forum.parent?.name ?? null;
  const repo = channelToRepo({ category: categoryName, channel: forum.name });
  if (!repo) {
    console.log(`[isobot] forum-post ${thread.id}: no repo mapping for ${categoryName}/${forum.name}`);
    return;
  }

  const starter = await fetchStarterWithRetry(thread);
  if (!starter) {
    console.log(`[isobot] forum-post ${thread.id}: starter message unavailable`);
    return;
  }
  if (starter.author.bot) return;

  if (await alreadyTracked(thread, thread.client.user!.id)) return;

  const labels = tagNames.map((n) => TAG_TO_LABEL[n] ?? n);
  const title = thread.name.slice(0, 200);
  const guildName = thread.guild?.name ?? "Discord";

  const body = [
    `Auto-created from a Discord forum post in **${guildName} → #${forum.name}**.`,
    "",
    `**Author:** ${starter.author.tag} (\`${starter.author.id}\`)`,
    `**Discord thread:** ${thread.url}`,
    "",
    "## Original post",
    "",
    blockquote(starter.content || "_(no text content)_"),
    "",
    "---",
    `<sub>Synced by isobot. Comments and state changes here mirror back to Discord.</sub>`,
    `<!-- isobot:discord-thread:${thread.id} -->`,
  ].join("\n");

  const issue = await createIssue({
    owner: repo.owner,
    repo: repo.repo,
    title,
    body,
    labels,
  });

  await thread.send({
    content: `${TRACKING_PREFIX} ${issue.url}`,
    allowedMentions: { parse: [] },
  });

  console.log(
    `[isobot] auto-created ${repo.owner}/${repo.repo}#${issue.number} from thread ${thread.id} (${tagNames.join(", ")})`,
  );
}

async function fetchStarterWithRetry(thread: AnyThreadChannel): Promise<Message | null> {
  for (let i = 0; i < 5; i++) {
    try {
      const m = await thread.fetchStarterMessage();
      if (m) return m;
    } catch {
      // Discord can return 404 momentarily for forum starter messages.
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return null;
}

async function alreadyTracked(thread: AnyThreadChannel, botUserId: string): Promise<boolean> {
  try {
    const recent = await thread.messages.fetch({ limit: 10 });
    for (const m of recent.values()) {
      if (m.author.id === botUserId && m.content.includes(TRACKING_PREFIX)) return true;
    }
  } catch {
    // If we can't fetch, fall through and risk a duplicate rather than failing silently.
  }
  return false;
}

function blockquote(text: string): string {
  return text.split("\n").map((l) => `> ${l}`).join("\n");
}
