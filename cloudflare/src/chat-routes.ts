import type { PiHarness } from "agents/harness/pi";
import { readJson } from "./http-body.js";
import { initializePromptRequests, isPromptRequest, reservePrompt } from "./prompt.js";

const PRIVATE = { "Cache-Control": "no-store" };
const IDENTIFIER = /^[A-Za-z0-9_-]{1,100}$/;
type ChatHarness = Pick<PiHarness, "submit" | "pending" | "wait" | "abort">;
type SyncModel = () => Promise<unknown>;

export interface ChatReceipt {
  conflict: false;
  operationId: string;
  accepted: boolean;
  status: "queued";
}

export interface ChatOperation {
  operationId: string;
  status: "queued" | "running" | "done" | "unanswered";
  text?: string;
  reason?: string;
}

export type ChatCancellation = ChatOperation & { cancelled: boolean };

interface ChatAgent {
  submitChat(prompt: string, requestId: string): Promise<ChatReceipt | { conflict: true }>;
  chatStatus(requestId: string): Promise<ChatOperation | null>;
  cancelChat(requestId: string): Promise<ChatCancellation | null>;
}

/** Routes use the same authenticated HTTP conversation objects as Vox and /api/prompt. */
export interface ChatBindings {
  Assistant: { getByName(name: string): ChatAgent };
}

export function initializeChatRequests(sql: SqlStorage): void {
  initializePromptRequests(sql);
  sql.exec(`CREATE TABLE IF NOT EXISTS api_chat_requests (
    request_id TEXT PRIMARY KEY,
    prompt TEXT NOT NULL
  )`);
}

/** Save the prompt before Pi admission, so a later status request can repair an interrupted handoff. */
export async function submitChatOperation(
  sql: SqlStorage, harness: ChatHarness, syncModel: SyncModel, prompt: string, requestId: string,
): Promise<ChatReceipt | { conflict: true }> {
  initializeChatRequests(sql);
  if (!await reservePrompt(sql, requestId, prompt)) return { conflict: true };
  sql.exec("INSERT OR IGNORE INTO api_chat_requests (request_id, prompt) VALUES (?, ?)", requestId, prompt);
  await syncModel();
  const receipt = await harness.submit(prompt, { operationId: requestId });
  return { conflict: false, operationId: receipt.operationId, accepted: receipt.accepted, status: "queued" };
}

/** Never wait on an unknown operation or on live inference; Pi owns retries and crash recovery. */
export async function chatOperationStatus(
  sql: SqlStorage, harness: ChatHarness, syncModel: SyncModel, requestId: string,
): Promise<ChatOperation | null> {
  initializeChatRequests(sql);
  const saved = sql.exec<{ prompt: string }>(
    `SELECT c.prompt FROM api_chat_requests c
      JOIN api_prompt_requests p ON p.request_id = c.request_id
      WHERE c.request_id = ?`, requestId,
  ).toArray()[0];
  if (!saved) return null;
  // Same-id submit is idempotent, including after a settled operation or a runtime restart.
  await syncModel();
  await harness.submit(saved.prompt, { operationId: requestId });
  const pending = (await harness.pending()).find(operation => operation.operationId === requestId);
  if (pending) return { operationId: requestId, status: pending.status };
  const result = await harness.wait(requestId);
  return {
    operationId: requestId, status: result.status, text: result.text ?? "",
    ...(result.reason ? { reason: result.reason } : {}),
  };
}

/** Withdraw queued input, or abort the active run this operation joined. Settling may be asynchronous. */
export async function abortChatOperation(
  sql: SqlStorage, harness: ChatHarness, syncModel: SyncModel, requestId: string,
): Promise<ChatCancellation | null> {
  const current = await chatOperationStatus(sql, harness, syncModel, requestId);
  if (!current) return null;
  if (current.status === "done" || current.status === "unanswered") return { ...current, cancelled: false };
  const cancelled = await harness.abort({ operationId: requestId });
  const latest = await chatOperationStatus(sql, harness, syncModel, requestId);
  return { ...latest!, cancelled };
}

export function isChatRoute(path: string): boolean {
  return path === "/api/chat" || path.startsWith("/api/chat/");
}

/** Called after bearer authentication; submitting resolves as soon as Pi has durably admitted work. */
export async function handleChatRequest(request: Request, env: ChatBindings): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/api/chat") {
    if (request.method !== "POST") {
      return Response.json({ error: "Use POST with a JSON chat message" }, { status: 405, headers: { ...PRIVATE, Allow: "POST" } });
    }
    let input: unknown;
    try { input = await readJson(request); }
    catch (error) {
      if (error instanceof SyntaxError || (error instanceof Error && ["Request body too large", "Missing request body"].includes(error.message))) {
        return Response.json({ error: "Invalid JSON request body" }, { status: 400, headers: PRIVATE });
      }
      throw error;
    }
    if (!isPromptRequest(input)) {
      return Response.json({ error: "Provide a nonblank prompt up to 16000 characters; conversation and requestId must be 1–100 letters, digits, underscores or hyphens" }, { status: 400, headers: PRIVATE });
    }
    const conversation = input.conversation ?? "vox";
    const requestId = input.requestId ?? crypto.randomUUID();
    const result = await env.Assistant.getByName(`http:${conversation}`).submitChat(input.prompt, requestId);
    if (result.conflict) {
      return Response.json({ error: "requestId was already used with a different prompt", conversation, requestId }, { status: 409, headers: PRIVATE });
    }
    const statusUrl = new URL(`/api/chat/${requestId}`, url.origin);
    statusUrl.searchParams.set("conversation", conversation);
    const { conflict: _conflict, ...receipt } = result;
    return Response.json({ conversation, requestId, ...receipt, statusUrl: statusUrl.href }, { status: 202, headers: PRIVATE });
  }
  const match = url.pathname.match(/^\/api\/chat\/([^/]+)$/);
  if (!match || !IDENTIFIER.test(match[1])) return Response.json({ error: "Not found" }, { status: 404, headers: PRIVATE });
  if (request.method !== "GET" && request.method !== "DELETE") {
    return Response.json({ error: "Use GET to check or DELETE to stop a chat message" }, { status: 405, headers: { ...PRIVATE, Allow: "GET, DELETE" } });
  }
  const conversation = url.searchParams.get("conversation") ?? "vox";
  if (!IDENTIFIER.test(conversation) || url.searchParams.getAll("conversation").length > 1) {
    return Response.json({ error: "Invalid conversation" }, { status: 400, headers: PRIVATE });
  }
  const requestId = match[1];
  const agent = env.Assistant.getByName(`http:${conversation}`);
  const operation = request.method === "DELETE" ? await agent.cancelChat(requestId) : await agent.chatStatus(requestId);
  return operation
    ? Response.json({ conversation, requestId, ...operation }, { headers: PRIVATE })
    : Response.json({ error: "Chat message not found" }, { status: 404, headers: PRIVATE });
}
