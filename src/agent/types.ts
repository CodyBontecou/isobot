/** JSON-only contract shared by the Discord bridge and the Cloudflare Worker. */
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

export interface TicketRequest {
  eventId: string;
  repo: { owner: string; repo: string };
  context: ReplyContext;
  /** Admin smoke test: draft and simulate tools without external writes. */
  dryRun?: boolean;
}

export type TicketStatus = "queued" | "running" | "done" | "unanswered";

export interface TicketSubmission {
  operationId: string;
  status?: TicketStatus;
  /** Durable delivery tombstone: the original result was already sent to Discord. */
  delivered?: boolean;
}

export interface TicketOperation extends TicketSubmission {
  status: TicketStatus;
  text?: string;
  issueUrl?: string;
  replyContent?: string;
  reason?: string;
}
