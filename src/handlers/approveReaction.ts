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
  DONE_EMOJI,
  LABELS,
  REFUSED_EMOJI,
  approvalFor,
  messageIssue,
  planFor,
  reactionAction,
  type IssueRef,
} from "../discord/approval.js";
import { runnerJobIssue } from "../discord/runnerThreads.js";
import { addLabels, getIssue, removeLabel } from "../github/issues.js";

/**
 * The owner's reactions drive isobot, on a bot message that links one issue (a triage digest, a
 * help-forum "Tracked from GitHub" post, a runner job card), or on any message in that issue's
 * help-forum thread or runner job thread:
 *   ✅ start (isobot:ready)  🛑 stop (isobot:stop)  🔁 continue (lift a stop, or build again)
 *   🧹 clean up (isobot:cleanup: the runner closes the issue and removes what it made locally)
 * ✅ and 🛑 toggle: removing the ✅ before the runner claims the issue withdraws it, and removing
 * the 🛑 continues (like 🔁). 🔁 and 🧹 are one-shot; removing them does nothing.
 */
export function registerApproveReactions(client: Client): void {
  client.on(Events.MessageReactionAdd, (reaction, user) => void handleApproveReaction(client, reaction, user, true));
  client.on(Events.MessageReactionRemove, (reaction, user) => void handleApproveReaction(client, reaction, user, false));
}

/** What the handler reaches outside Discord; tests pass doubles. */
export interface ApproveDeps {
  isAllowed(userId: string): boolean;
  getIssue: typeof getIssue;
  addLabels: typeof addLabels;
  removeLabel: typeof removeLabel;
  isConfiguredRepo(ref: IssueRef): boolean;
}

const defaultDeps: ApproveDeps = {
  isAllowed, getIssue, addLabels, removeLabel,
  isConfiguredRepo: ref => repoToCategoryKey(ref) !== null,
};

export async function handleApproveReaction(
  client: Pick<Client, "user">,
  partial: MessageReaction | PartialMessageReaction,
  user: User | PartialUser,
  added: boolean,
  deps: ApproveDeps = defaultDeps,
): Promise<void> {
  const { getIssue, addLabels, removeLabel } = deps;
  const action = reactionAction(partial.emoji);
  if (user.bot || !action || !deps.isAllowed(user.id)) return;
  if (!added && action !== "start" && action !== "stop") return;
  try {
    const reaction = partial.partial ? await partial.fetch() : partial;
    const message = reaction.message.partial ? await reaction.message.fetch() : reaction.message;
    const ref = await issueForMessage(message, client.user?.id, deps);
    if (!ref) return;
    const tag = `${ref.owner}/${ref.repo}#${ref.number}`;
    const issue = await getIssue(ref);

    if (!added && action === "stop") {
      // Only undoes a stop that is still in place; otherwise un-clicking could start a build.
      if (!issue.labels.some(l => l.toLowerCase() === LABELS.stop)) return;
      const plan = planFor("continue", issue);
      if (typeof plan === "string") return;
      if (plan.add.length) await addLabels({ ...ref, labels: plan.add });
      for (const label of plan.remove) await removeLabel({ ...ref, label });
      await message.react(DONE_EMOJI).catch(() => undefined);
      console.log(`[isobot] stop lifted from Discord by ${user.id}: ${tag} (+${plan.add.join(",")} -${plan.remove.join(",")})`);
      return;
    }

    if (!added) {
      // Withdraw only an approval the runner hasn't picked up yet; once it builds, use 🛑.
      if (approvalFor(issue) === "in_flight" && issue.labels.includes(LABELS.ready)) {
        await removeLabel({ ...ref, label: LABELS.ready });
        await message.reactions.cache.get(APPROVED_EMOJI)?.users.remove(client.user!.id).catch(() => undefined);
        console.log(`[isobot] approval withdrawn from Discord: ${tag}`);
      }
      return;
    }

    const plan = planFor(action, issue);
    if (plan === "refuse") {
      await message.react(REFUSED_EMOJI).catch(() => undefined);
      console.log(`[isobot] ${action} refused for ${tag}: ${issue.state}, labels ${issue.labels.join(",")}`);
      return;
    }
    if (plan !== "noop") {
      // Add before removing: a cleanup's stop must land before its ready label goes.
      if (plan.add.length) await addLabels({ ...ref, labels: plan.add });
      for (const label of plan.remove) await removeLabel({ ...ref, label });
      console.log(`[isobot] ${action} from Discord by ${user.id}: ${tag} (+${plan.add.join(",")} -${plan.remove.join(",")})`);
    }
    await message.react(action === "start" ? APPROVED_EMOJI : DONE_EMOJI).catch(() => undefined);
  } catch (err) {
    console.error("[isobot] approveReaction error:", err);
    await partial.message.react("⚠️").catch(() => undefined);
  }
}

/** The configured-repo issue a reacted message stands for, or null. */
async function issueForMessage(message: Message | PartialMessage, botId: string | undefined, deps: ApproveDeps): Promise<IssueRef | null> {
  const ref = messageIssue(message as Message, botId) ?? await threadIssue(message, botId);
  return ref && deps.isConfiguredRepo(ref) ? ref : null;
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
