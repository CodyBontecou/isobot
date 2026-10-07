import { Events, type Client } from "discord.js";
import { requestAgent } from "./api.js";
import { runAgent, type RunAgentInput, type RunAgentResult } from "./runAgent.js";
import type { MessageSnapshot, TicketRequest } from "./types.js";

const RECOVERY_INTERVAL_MS = 30_000;
const RECOVERY_CONCURRENCY = 4;

type FetchTrigger = (channelId: string, messageId: string) => Promise<RunAgentInput["trigger"]>;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid pending ticket");
  return value as Record<string, unknown>;
}

function string(fields: Record<string, unknown>, key: string): string {
  const value = fields[key];
  if (typeof value !== "string") throw new Error("Invalid pending ticket");
  return value;
}

function snapshot(value: unknown): MessageSnapshot {
  const fields = record(value);
  return {
    authorTag: string(fields, "authorTag"), authorId: string(fields, "authorId"),
    content: string(fields, "content"), jumpUrl: string(fields, "jumpUrl"),
    createdAt: string(fields, "createdAt"),
  };
}

function pendingTicket(value: unknown): TicketRequest {
  const fields = record(value);
  const repo = record(fields.repo);
  const context = record(fields.context);
  if (fields.dryRun === true || !Array.isArray(context.recent)) throw new Error("Invalid pending ticket");
  return {
    eventId: string(fields, "eventId"),
    repo: { owner: string(repo, "owner"), repo: string(repo, "repo") },
    context: {
      trigger: snapshot(context.trigger), parent: snapshot(context.parent),
      recent: context.recent.map(snapshot), channelName: string(context, "channelName"),
      guildName: string(context, "guildName"),
    },
  };
}

export async function recoverTicket(ticket: TicketRequest, fetchTrigger: FetchTrigger): Promise<RunAgentResult> {
  const url = new URL(ticket.context.trigger.jumpUrl);
  const ids = /^\/channels\/(\d+)\/(\d+)\/(\d+)\/?$/.exec(url.pathname);
  if (ticket.dryRun || url.protocol !== "https:" || url.hostname !== "discord.com" || !ids || ids[3] !== ticket.eventId) {
    throw new Error("Pending ticket has an invalid Discord message reference");
  }
  const trigger = await fetchTrigger(ids[2], ids[3]);
  if (trigger.id !== ticket.eventId) throw new Error("Recovered Discord message ID does not match the pending ticket");
  return runAgent({ trigger, replyContext: ticket.context, repo: ticket.repo });
}

export function registerAgentRecovery(client: Client): () => void {
  let polling = false;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let inboxFailureLogged = false;
  const failedTickets = new Set<string>();

  const fetchTrigger: FetchTrigger = async (channelId, messageId) => {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased() || !("messages" in channel)) {
      throw new Error("Pending ticket's Discord channel is inaccessible");
    }
    return channel.messages.fetch(messageId);
  };

  async function poll(): Promise<void> {
    if (polling || stopped || !client.isReady()) return;
    polling = true;
    try {
      const response = record(await requestAgent("/api/pending", "GET"));
      if (!Array.isArray(response.tickets)) throw new Error("Invalid pending ticket inbox");
      const tickets: unknown[] = response.tickets;
      inboxFailureLogged = false;
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(RECOVERY_CONCURRENCY, tickets.length) }, async () => {
        while (!stopped && next < tickets.length) {
          const value = tickets[next++];
          let eventId = "invalid-reference";
          try {
            const ticket = pendingTicket(value);
            if (!/^\d+$/.test(ticket.eventId)) throw new Error("Invalid pending ticket ID");
            eventId = ticket.eventId;
            await recoverTicket(ticket, fetchTrigger);
            failedTickets.delete(eventId);
          } catch {
            if (!failedTickets.has(eventId)) {
              console.warn(`[isobot] could not recover Pi ticket ${eventId}; leaving it pending for retry`);
              failedTickets.add(eventId);
            }
          }
        }
      }));
    } catch {
      if (!inboxFailureLogged) console.warn("[isobot] could not read the Pi delivery inbox; recovery will retry");
      inboxFailureLogged = true;
    } finally {
      polling = false;
    }
  }

  function start(): void {
    if (timer || stopped) return;
    void poll();
    timer = setInterval(() => { void poll(); }, RECOVERY_INTERVAL_MS);
    timer.unref();
  }
  client.once(Events.ClientReady, start);
  if (client.isReady()) start();
  return () => {
    stopped = true;
    client.off(Events.ClientReady, start);
    if (timer) clearInterval(timer);
  };
}
