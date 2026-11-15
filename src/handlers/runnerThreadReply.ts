import { Events, type Client, type Message } from "discord.js";
import { isAllowed } from "../auth.js";
import { messageRelayBody, runnerJobIssue } from "../discord/runnerThreads.js";
import { createIssueComment } from "../github/issues.js";

/**
 * Relays allowlisted replies in runner job threads to the job's GitHub issue. The runner reads them
 * there as owner notes: during a build they go to the builder, on an open PR they start a revision.
 * Others' messages in these threads are ignored (the runner would ignore them anyway).
 */
export function registerRunnerThreadReplies(client: Client): void {
  client.on(Events.MessageCreate, async (message: Message) => {
    if (message.author.bot || !message.channel.isThread()) return;
    try {
      const ref = await runnerJobIssue(message.channel, client.user?.id);
      if (!ref || !isAllowed(message.author.id)) return;
      const body = messageRelayBody(message, client.user?.id);
      if (!body) return;
      await createIssueComment({ ...ref, body });
      await message.react("📨").catch(() => undefined);
      console.log(`[isobot] relayed runner thread reply ${message.id} -> ${ref.owner}/${ref.repo}#${ref.number}`);
    } catch (err) {
      console.error("[isobot] runnerThreadReply error:", err);
      await message.react("⚠️").catch(() => undefined);
    }
  });
}
