import { setTimeout as delay } from "node:timers/promises";
import type { MessageReplyOptions } from "discord.js";
import type { RepoTarget } from "../config/repos.js";
import type { ReplyContext, TicketOperation, TicketRequest, TicketStatus, TicketSubmission } from "./types.js";
import { requestAgent } from "./api.js";

const OPERATION_TIMEOUT_MS = 10 * 60_000;
const inFlight = new Map<string, Promise<RunAgentResult>>();

export interface RunAgentInput {
  trigger: {
    id: string;
    reply(options: MessageReplyOptions): Promise<unknown>;
  };
  replyContext: ReplyContext;
  repo: RepoTarget;
}

export interface RunAgentResult {
  issueUrl?: string;
  replied: boolean;
  /** The bridge no longer runs model turns locally. */
  turns: number;
}

type AgentResponse = TicketSubmission & Partial<Omit<TicketOperation, "operationId" | "status">>;

function isStatus(value: unknown): value is TicketStatus {
  return value === "queued" || value === "running" || value === "done" || value === "unanswered";
}

function parseResponse(value: unknown, operationId: string): AgentResponse {
  if (!value || typeof value !== "object") throw new Error("Pi agent returned an invalid response");
  const fields = value as Record<string, unknown>;
  if (fields.operationId !== operationId) throw new Error("Pi agent returned a mismatched operation ID");
  if (fields.status !== undefined && !isStatus(fields.status)) {
    throw new Error("Pi agent returned an invalid operation status");
  }
  if (fields.delivered !== undefined && typeof fields.delivered !== "boolean") {
    throw new Error("Pi agent returned an invalid delivery status");
  }
  const result: AgentResponse = { operationId, status: fields.status, delivered: fields.delivered };
  for (const key of ["text", "issueUrl", "replyContent", "reason"] as const) {
    if (fields[key] !== undefined && typeof fields[key] !== "string") {
      throw new Error(`Pi agent returned an invalid ${key}`);
    }
    result[key] = fields[key];
  }
  return result;
}

function replyContent(result: TicketOperation): string {
  const content = (result.replyContent || result.text || "").trim().slice(0, 1600);
  if (result.issueUrl) {
    if (!content) return `Created issue: ${result.issueUrl}`;
    if (!content.includes(result.issueUrl)) return `${content}\n\n${result.issueUrl}`;
  }
  return content || "I couldn't create an issue from that. Try giving me more detail.";
}

export function runAgent(input: RunAgentInput): Promise<RunAgentResult> {
  const existing = inFlight.get(input.trigger.id);
  if (existing) return existing;
  const operation = runTicket(input).finally(() => { inFlight.delete(input.trigger.id); });
  inFlight.set(input.trigger.id, operation);
  return operation;
}

async function runTicket(input: RunAgentInput): Promise<RunAgentResult> {
  const eventId = input.trigger.id;
  const request: TicketRequest = {
    eventId,
    repo: { owner: input.repo.owner, repo: input.repo.repo },
    context: input.replyContext,
  };
  const submission = parseResponse(await requestAgent("/api/tickets", "POST", request), eventId);
  if (submission.delivered) return { issueUrl: submission.issueUrl, replied: true, turns: 0 };
  const deadline = Date.now() + OPERATION_TIMEOUT_MS;
  let result: TicketOperation;
  let pollDelay = 1000;

  // A completed submission still needs its persisted tool output and reply content.
  while (true) {
    const operation = parseResponse(
      await requestAgent(`/api/tickets/${encodeURIComponent(submission.operationId)}`, "GET"),
      eventId,
    );
    if (!isStatus(operation.status)) throw new Error("Pi agent returned an invalid operation status");
    result = { ...operation, status: operation.status };
    if (result.delivered) return { issueUrl: result.issueUrl, replied: true, turns: 0 };
    if (result.status === "done" || result.status === "unanswered") break;
    if (Date.now() >= deadline) {
      throw new Error(`Pi is still processing this message (operation ${eventId}); its work is saved on Cloudflare`);
    }
    await delay(pollDelay);
    pollDelay = Math.min(pollDelay * 1.5, 5000);
  }

  const content = replyContent(result);
  await input.trigger.reply({
    content,
    nonce: eventId,
    enforceNonce: true,
    allowedMentions: { parse: [], repliedUser: false },
  });
  try {
    await requestAgent(`/api/tickets/${encodeURIComponent(eventId)}/delivered`, "POST");
  } catch {
    // The reply succeeded. Keep the durable inbox entry so recovery can retry the ack.
    console.warn(`[isobot] could not acknowledge Pi delivery ${eventId}; recovery will retry`);
  }
  return { issueUrl: result.issueUrl, replied: true, turns: 0 };
}
