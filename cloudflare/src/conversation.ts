import type { Message } from "@earendil-works/pi-ai";
import { ROOT_CONVERSATION_ID, type Cursor, type EntryRecord, type Harness, type Page } from "@earendil-works/pi-durable";
import type { PiHarness } from "agents/harness/pi";

const MAX_TEXT = 16_000;
const MAX_SCAN = 400;
const MAX_PAGE_BYTES = 900_000;
const encoder = new TextEncoder();
const rootSession = String(ROOT_CONVERSATION_ID);
type Context = Parameters<Harness["close"]>[0];
const background: Context = Object.freeze({
  abortSignal: undefined,
  value: () => undefined,
  toString: () => "[Context isobot transcript]",
});

export interface ConversationEntry {
  id: string;
  role: "user" | "assistant" | "tool" | "system";
  text: string;
  toolCalls?: { id: string; name: string; arguments: string }[];
  toolResult?: { name: string; id: string; error: boolean };
  createdAt?: string;
}

/** The fields required by the view; everything else in Pi's record stays private. */
export type TranscriptRecord = Pick<EntryRecord, "kind" | "model"> & { id: number };
export type TranscriptScan = (limit: number, cursor?: Cursor) => Promise<Page<TranscriptRecord, Cursor>>;
export interface ConversationOptions { limit: number; before?: string }

function bounded(value: string, limit = MAX_TEXT): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function visibleText(content: Message["content"]): string {
  if (typeof content === "string") return bounded(content);
  let text = "";
  for (const block of content) {
    if (block.type !== "text") continue;
    text += block.text.slice(0, MAX_TEXT + 1 - text.length);
    if (text.length > MAX_TEXT) break;
  }
  return bounded(text);
}

function createdAt(timestamp: number): string | undefined {
  return Number.isFinite(timestamp) && Math.abs(timestamp) <= 8.64e15
    ? new Date(timestamp).toISOString() : undefined;
}

/** Pi's built-in transcript kinds contribute exactly one message per entry. */
export function projectTranscriptEntry(entry: TranscriptRecord): ConversationEntry | undefined {
  if (!Number.isSafeInteger(entry.id) || entry.id < 1) return undefined;
  const id = String(entry.id);
  if (entry.kind === "pi.reset" && !entry.model?.length) {
    return { id, role: "system", text: "Conversation reset." };
  }
  const message = entry.model?.find(value => value.role === "user" || value.role === "assistant" || value.role === "toolResult");
  if (!message) return undefined;
  const text = visibleText(message.content);
  const timestamp = createdAt(message.timestamp);
  const time = timestamp ? { createdAt: timestamp } : {};
  if (message.role === "user") {
    return { id, role: entry.kind === "pi.compaction" || entry.kind === "pi.reset" ? "system" : "user", text, ...time };
  }
  if (message.role === "toolResult") {
    return { id, role: "tool", text, toolResult: {
      name: bounded(message.toolName, 200), id: bounded(message.toolCallId, 200), error: message.isError,
    }, ...time };
  }
  const toolCalls = message.content.filter(block => block.type === "toolCall").slice(0, 20).map(call => ({
    id: bounded(call.id, 200), name: bounded(call.name, 200),
    arguments: bounded(JSON.stringify(call.arguments), 4_000),
  }));
  if (!text && !toolCalls.length) return undefined;
  return { id, role: "assistant", text, ...(toolCalls.length ? { toolCalls } : {}), ...time };
}

function beforeCursor(before?: string): Cursor | undefined {
  if (before === undefined) return undefined;
  const value = Number(before);
  if (!/^[1-9][0-9]*$/.test(before) || !Number.isSafeInteger(value)) throw new RangeError("Invalid conversation cursor");
  return { after: value };
}

/** Newest-first Pi scans use immutable entry IDs, so new appends cannot shift older pages. */
export async function readConversationEntries(scan: TranscriptScan, options: ConversationOptions) {
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100) throw new RangeError("Invalid conversation limit");
  let cursor = beforeCursor(options.before);
  let scanned = 0;
  let bytes = 0;
  let consumed: number | undefined;
  const entries: ConversationEntry[] = [];
  const finish = (more: boolean) => ({
    entries: entries.reverse(),
    ...(more && consumed !== undefined ? { nextCursor: String(consumed) } : {}),
  });
  while (scanned < MAX_SCAN) {
    const page = await scan(Math.min(100, MAX_SCAN - scanned), cursor);
    if (!page.items.length) return finish(false);
    for (let index = 0; index < page.items.length; index++) {
      const record = page.items[index];
      const projected = projectTranscriptEntry(record);
      const size = projected ? encoder.encode(JSON.stringify(projected)).byteLength + 1 : 0;
      // Leave this record for the next page if the response's byte budget is full.
      if (projected && entries.length > 0 && bytes + size > MAX_PAGE_BYTES) return finish(true);
      consumed = record.id;
      scanned++;
      if (projected) { entries.push(projected); bytes += size; }
      const more = index + 1 < page.items.length || page.next !== undefined;
      if (entries.length === options.limit || scanned === MAX_SCAN) return finish(more);
    }
    if (page.next === undefined) return finish(false);
    cursor = page.next;
  }
  return finish(true);
}

/** Inspect stored history without submitting inputs or altering conversation context. */
export async function conversationSnapshot(harness: PiHarness, model: string, options: ConversationOptions): Promise<string> {
  const pi = await harness.pi();
  const conversation = await pi.conversation(ROOT_CONVERSATION_ID, background);
  if (!conversation) return JSON.stringify({ model: bounded(model, 256), busy: false, pending: [], entries: [] });
  const [history, busy, pending] = await Promise.all([
    readConversationEntries((limit, cursor) => conversation.entries({}, limit, cursor, background), options),
    harness.session(rootSession).busy(),
    harness.pending({ session: rootSession }),
  ]);
  return JSON.stringify({
    model: bounded(model, 256), busy,
    pending: pending.slice(0, 100).map(operation => ({ operationId: bounded(operation.operationId, 100), status: operation.status })),
    ...history,
  });
}
