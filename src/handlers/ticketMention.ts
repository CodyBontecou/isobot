import { Events, type AnyThreadChannel, type Client, type Message } from "discord.js";
import { fetchReplyContext, fetchThreadStarterContext, type ReplyContext } from "../lib/context.js";
import { channelToRepo, listMappedKeys } from "../config/repos.js";
import { runAgent } from "../agent/runAgent.js";
import { isAllowed } from "../auth.js";

const WORKING = "⏳";
const OK = "✅";
const FAIL = "❌";

// Anti-spam cooldown for denial replies: 10s × 2^(count-1), capped at 24h.
// Allowed users never reach this code path.
const DENY_BASE_MS = 10_000;
const DENY_MAX_MS = 24 * 60 * 60 * 1000;
const denyState = new Map<string, { count: number; nextAt: number }>();

function shouldReplyDenial(userId: string): boolean {
  const now = Date.now();
  const cur = denyState.get(userId);
  if (cur && now < cur.nextAt) return false;
  const count = (cur?.count ?? 0) + 1;
  const wait = Math.min(DENY_BASE_MS * 2 ** Math.min(count - 1, 20), DENY_MAX_MS);
  denyState.set(userId, { count, nextAt: now + wait });
  return true;
}

export function registerTicketMention(client: Client): void {
  client.on(Events.MessageCreate, async (message: Message) => {
    try {
      if (message.author.bot) return;
      if (!client.user) return;

      const explicitMention = new RegExp(`<@!?${client.user.id}>`).test(message.content);
      if (!explicitMention) return;

      if (!isAllowed(message.author.id)) {
        if (shouldReplyDenial(message.author.id)) {
          console.log(`[isobot] denying mention from non-allowed user ${message.author.tag} (${message.author.id})`);
          await message.reply({
            content: "Sorry, you don't have permission to trigger isobot.",
            allowedMentions: { repliedUser: false },
          }).catch(() => {});
        }
        return;
      }

      const inThread = message.channel.isThread();
      const thread = inThread ? (message.channel as AnyThreadChannel) : null;

      if (!inThread && !message.reference?.messageId) {
        await message.reply({
          content:
            "Reply to the comment you want to turn into a ticket, then mention me in your reply. Or open a thread on the comment and mention me there.",
          allowedMentions: { repliedUser: false },
        });
        return;
      }

      const channelName = thread
        ? thread.parent && "name" in thread.parent && typeof thread.parent.name === "string"
          ? thread.parent.name
          : null
        : "name" in message.channel && typeof message.channel.name === "string"
          ? message.channel.name
          : null;
      if (!channelName) {
        await message.reply({
          content: "I can only ticketize messages in named text channels.",
          allowedMentions: { repliedUser: false },
        });
        return;
      }

      const categoryName = thread
        ? thread.parent && "parent" in thread.parent && thread.parent.parent?.name
          ? thread.parent.parent.name
          : null
        : "parent" in message.channel && message.channel.parent?.name
          ? message.channel.parent.name
          : null;

      const repo = channelToRepo({ category: categoryName, channel: channelName });
      if (!repo) {
        const mapped = listMappedKeys().map((k) => `\`${k}\``).join(", ");
        const where = categoryName ? `${categoryName}/${channelName}` : channelName;
        await message.reply({
          content: `I don't have a repo mapped to \`${where}\`. Add it to \`src/config/repos.json\`. Currently mapped: ${mapped || "(none)"}.`,
          allowedMentions: { repliedUser: false },
        });
        return;
      }

      let replyContext: ReplyContext | null;
      if (thread && !message.reference?.messageId) {
        replyContext = await fetchThreadStarterContext(message, thread);
        if (!replyContext) {
          await message.reply({
            content:
              "I couldn't find a message to ticketize in this thread. Reply to a specific message and mention me, or open the thread directly on the comment you want to capture.",
            allowedMentions: { repliedUser: false },
          });
          return;
        }
      } else {
        replyContext = await fetchReplyContext(message);
        if (!replyContext) {
          await message.reply({
            content: "I couldn't fetch the parent message. Try again, or check my permissions.",
            allowedMentions: { repliedUser: false },
          });
          return;
        }
      }

      await message.react(WORKING).catch(() => {});

      try {
        const result = await runAgent({ trigger: message, replyContext, repo });
        await message.reactions.cache.get(WORKING)?.users.remove(client.user.id).catch(() => {});

        if (result.issueUrl) {
          await message.react(OK).catch(() => {});
          if (!result.replied) {
            await message.reply({
              content: `Created issue: ${result.issueUrl}`,
              allowedMentions: { repliedUser: false },
            });
          }
        } else {
          await message.react(FAIL).catch(() => {});
          if (!result.replied) {
            await message.reply({
              content: "I couldn't create an issue from that. Try giving me more detail.",
              allowedMentions: { repliedUser: false },
            });
          }
        }
      } catch (err) {
        await message.reactions.cache.get(WORKING)?.users.remove(client.user.id).catch(() => {});
        await message.react(FAIL).catch(() => {});
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[isobot] agent run failed:", err);
        await message.reply({
          content: `Something went wrong: ${msg}`,
          allowedMentions: { repliedUser: false },
        }).catch(() => {});
      }
    } catch (outer) {
      console.error("[isobot] handler crashed:", outer);
    }
  });
}
