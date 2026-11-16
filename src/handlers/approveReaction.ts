import {
  ChannelType,
  Events,
  type Client,
  type Message,
  type MessageReaction,
  type PartialMessage,
  type PartialMessageReaction,
  type PartialUser,
  type User,
} from "discord.js";
import { isAllowed } from "../auth.js";
import { repoToCategoryKey } from "../config/repos.js";
import {
  APPROVED_EMOJI,
  LABELS,
  REFUSED_EMOJI,
  approvalFor,
  isApproveEmoji,
  messageIssue,
  type IssueRef,
} from "../discord/approval.js";
import { runnerJobIssue } from "../discord/runnerThreads.js";
import { addLabels, getIssue, removeLabel } from "../github/issues.js";

/**
 * ✅ from the owner approves a build: on a bot message that links one issue (a help-forum
 * "Tracked from GitHub" post, a runner job card), or on any message in that issue's help-forum
 * thread or runner job thread. Removing the ✅ before the runner claims the issue withdraws it.
 */
export function registerApproveReactions(client: Client): void {
  client.on(Events.MessageReactionAdd, (reaction, user) => void handle(client, reaction, user, true));
  client.on(Events.MessageReactionRemove, (reaction, user) => void handle(client, reaction, user, false));
}

async function handle(
  client: Client,
  partial: MessageReaction | PartialMessageReaction,
  user: User | PartialUser,
  added: boolean,
): Promise<void> {
  if (user.bot || !isApproveEmoji(partial.emoji) || !isAllowed(user.id)) return;
  try {
    const reaction = partial.partial ? await partial.fetch() : partial;
    const message = reaction.message.partial ? await reaction.message.fetch() : reaction.message;
    const ref = await issueForMessage(message, client.user?.id);
    if (!ref) return;
    const tag = `${ref.owner}/${ref.repo}#${ref.number}`;
    const issue = await getIssue(ref);

    if (!added) {
      // Withdraw only an approval the runner hasn't picked up yet; once it builds, use the stop label.
      if (approvalFor(issue) === "in_flight" && issue.labels.includes(LABELS.ready)) {
        await removeLabel({ ...ref, label: LABELS.ready });
        await message.reactions.cache.get(APPROVED_EMOJI)?.users.remove(client.user!.id).catch(() => undefined);
        console.log(`[isobot] approval withdrawn from Discord: ${tag}`);
      }
      return;
    }

    const decision = approvalFor(issue);
    if (decision === "refuse") {
      await message.react(REFUSED_EMOJI).catch(() => undefined);
      console.log(`[isobot] approval refused for ${tag}: ${issue.state}, labels ${issue.labels.join(",")}`);
      return;
    }
    if (decision === "approve") {
      await addLabels({ ...ref, labels: [LABELS.ready] });
      console.log(`[isobot] approved from Discord by ${user.id}: ${tag}`);
    }
    await message.react(APPROVED_EMOJI).catch(() => undefined);
  } catch (err) {
    console.error("[isobot] approveReaction error:", err);
    await partial.message.react("⚠️").catch(() => undefined);
  }
}

/** The configured-repo issue a reacted message stands for, or null. */
async function issueForMessage(message: Message | PartialMessage, botId: string | undefined): Promise<IssueRef | null> {
  const ref = messageIssue(message as Message, botId) ?? await threadIssue(message, botId);
  return ref && repoToCategoryKey(ref) ? ref : null;
}

async function threadIssue(message: Message | PartialMessage, botId: string | undefined): Promise<IssueRef | null> {
  const thread = message.channel;
  if (!thread.isThread()) return null;
  const job = await runnerJobIssue(thread, botId);
  if (job) return job;
  if (thread.parent?.type !== ChannelType.GuildForum || thread.parent.name.toLowerCase() !== "help") return null;
  // The bot's tracking post is the starter (issue opened on GitHub) or an early reply (forum post first).
  try {
    const earliest = await thread.messages.fetch({ after: thread.id, limit: 10 });
    const starter = await thread.fetchStarterMessage().catch(() => null);
    for (const m of [starter, ...[...earliest.values()].reverse()]) {
      const ref = m && messageIssue(m, botId);
      if (ref) return ref;
    }
  } catch (err) {
    console.error(`[isobot] approveReaction: reading thread ${thread.id} failed:`, err);
  }
  return null;
}
