export interface PromptRequest {
  prompt: string;
  conversation?: string;
  requestId?: string;
}

const IDENTIFIER = /^[A-Za-z0-9_-]{1,100}$/;

export function isPromptRequest(value: unknown): value is PromptRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (!("prompt" in value) || typeof value.prompt !== "string"
    || !value.prompt.trim() || value.prompt.length > 16_000) return false;
  if ("conversation" in value && (typeof value.conversation !== "string" || !IDENTIFIER.test(value.conversation))) return false;
  if ("requestId" in value && (typeof value.requestId !== "string" || !IDENTIFIER.test(value.requestId))) return false;
  return true;
}

export function initializePromptRequests(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS api_prompt_requests (
    request_id TEXT PRIMARY KEY,
    prompt_digest TEXT NOT NULL
  )`);
}

/** Reserve an operation id without allowing a later retry to change its prompt. */
export async function reservePrompt(sql: SqlStorage, requestId: string, prompt: string): Promise<boolean> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(prompt));
  const hex = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  // No awaits between insertion and comparison: concurrent requests cannot overwrite the reservation.
  sql.exec("INSERT OR IGNORE INTO api_prompt_requests (request_id, prompt_digest) VALUES (?, ?)", requestId, hex);
  const row = sql.exec<{ prompt_digest: string }>(
    "SELECT prompt_digest FROM api_prompt_requests WHERE request_id = ?", requestId,
  ).one();
  return row.prompt_digest === hex;
}
