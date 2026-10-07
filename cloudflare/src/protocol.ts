import type { MessageSnapshot, TicketRequest } from "../../src/agent/types.js";
import repos from "../../src/config/repos.json";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function string(value: unknown, limit: number): value is string {
  return typeof value === "string" && value.length <= limit;
}
function snapshot(value: unknown): value is MessageSnapshot {
  if (!record(value)) return false;
  return string(value.authorTag, 200) && string(value.authorId, 30)
    && string(value.content, 16_000) && string(value.createdAt, 100)
    && string(value.jumpUrl, 250) && /^https:\/\/discord\.com\/channels\/\d+\/\d+\/\d+$/.test(value.jumpUrl);
}
export function isEventId(value: unknown): value is string {
  return typeof value === "string" && /^\d{17,20}$/.test(value);
}
export function isTicketRequest(value: unknown): value is TicketRequest {
  if (!record(value) || !isEventId(value.eventId) || !record(value.repo) || !record(value.context)) return false;
  const { repo, context } = value;
  const owner = repo.owner;
  const repository = repo.repo;
  return string(owner, 100) && string(repository, 100)
    && Object.values(repos).some(target => target.owner.toLowerCase() === owner.toLowerCase()
      && target.repo.toLowerCase() === repository.toLowerCase())
    && snapshot(context.parent) && snapshot(context.trigger)
    && context.trigger.jumpUrl.endsWith(`/${value.eventId}`)
    && string(context.channelName, 200) && string(context.guildName, 200)
    && Array.isArray(context.recent) && context.recent.length <= 10 && context.recent.every(snapshot)
    && (value.dryRun === undefined || typeof value.dryRun === "boolean");
}
export function ticketPrompt(input: TicketRequest): string {
  return JSON.stringify({
    server: input.context.guildName,
    channel: input.context.channelName,
    repository: `${input.repo.owner}/${input.repo.repo}`,
    parentComment: input.context.parent,
    userRequest: input.context.trigger,
    recentContext: input.context.recent,
  });
}
