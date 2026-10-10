const API_RESOURCE = "https://api.openai.com/v1";
const TOKEN_URL = "https://auth.openai.com/api/accounts/oauth/token";
const DISCOVERY_URL = "https://auth.openai.com/.well-known/openid-configuration";
const REQUIRED_SCOPES = ["chatgpt.tokens.use.direct", "resource.invoke", "offline_access"];
const REFRESH_MARGIN_MS = 60_000;
const MAX_JSON_BYTES = 512_000;
const VERIFICATION_ERROR_CODES = new Set([
  "model_not_found", "model_not_available", "model_not_supported", "unsupported_model",
  "permission_denied", "access_denied", "insufficient_quota", "rate_limit_exceeded",
  "usage_limit_reached", "server_error", "internal_error", "invalid_request_error",
  "invalid_request", "unsupported_parameter", "missing_required_parameter", "authentication_error",
  "invalid_token", "invalid_api_key", "context_length_exceeded", "max_output_tokens", "content_filter",
  "subscription_sharing_usage_limit_exceeded", "subscription_sharing_usage_unavailable",
  "subscription_sharing_user_not_eligible", "subscription_sharing_unsupported_capability",
  "subscription_sharing_route_not_supported", "subscription_sharing_invalid_user",
  "chatpass_v2_scope_not_authorized", "chatpass_v2_invalid_authorization_context",
  "subscription_sharing_user_unavailable",
]);

type VerificationDiagnostic = {
  phase: "request" | "response" | "stream";
  result: "started" | "received" | "http_error" | "transport_error" | "missing_body" | "unexpected_content_type"
    | "invalid_event" | "failed" | "incomplete" | "error" | "completed" | "byte_limit" | "truncated";
  status?: number;
  upstreamCode?: string;
  timedOut?: boolean;
  contentType?: "application/json" | "text/plain" | "text/event-stream" | "missing" | "other";
  payloadType?: "error" | "response" | "object" | "array" | "primitive" | "unreadable";
  responseStatus?: "completed" | "in_progress" | "failed" | "incomplete" | "cancelled" | "queued";
};
function verificationDiagnostic(details: VerificationDiagnostic): void {
  console.warn(JSON.stringify({ event: "chatgpt_model_verification", ...details }));
}
function verificationErrorCode(payload: unknown): string | undefined {
  if (!record(payload)) return undefined;
  const error = record(payload.error) ? payload.error
    : record(payload.response) && record(payload.response.error) ? payload.response.error : payload;
  const candidate = error.code;
  return typeof candidate === "string" && VERIFICATION_ERROR_CODES.has(candidate) ? candidate : undefined;
}
function verificationContentType(response: Response): VerificationDiagnostic["contentType"] {
  const value = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (!value) return "missing";
  return value === "application/json" || value === "text/plain" || value === "text/event-stream" ? value : "other";
}
function verificationPayloadDetails(payload: unknown): Pick<VerificationDiagnostic, "payloadType" | "responseStatus"> {
  if (!record(payload)) return { payloadType: Array.isArray(payload) ? "array" : "primitive" };
  const response = record(payload.response) ? payload.response : payload;
  const status = response.status;
  const responseStatus = status === "completed" || status === "in_progress" || status === "failed"
    || status === "incomplete" || status === "cancelled" || status === "queued" ? status : undefined;
  return {
    payloadType: "error" in payload ? "error" : payload.object === "response" || record(payload.response) ? "response" : "object",
    ...(responseStatus ? { responseStatus } : {}),
  };
}

export interface ChatGPTCredential {
  type: "oauth";
  access: string;
  refresh: string;
  expires: number;
  clientId: string;
  scopes: string[];
  /** Absolute milliseconds, when the token endpoint supplies a refresh restriction. */
  earliestRefreshAt?: number;
}

export interface ChatGPTSelection { model: string | null; revision: number }
export interface ChatGPTStatus {
  connected: boolean;
  reconnectRequired: boolean;
  expiresAt: string | null;
  models: string[];
  selectedModel: string | null;
  revision: number;
}

export type ChatGPTAuthErrorCode = "invalid_credential" | "not_connected" | "reconnect_required"
  | "upstream_error" | "model_unavailable" | "storage_error" | "refresh_deferred";

/** Only fixed, non-secret messages cross RPC or HTTP boundaries. */
export class ChatGPTAuthError extends Error {
  constructor(readonly code: ChatGPTAuthErrorCode, message: string) {
    super(message);
    this.name = "ChatGPTAuthError";
  }
}

export interface ChatGPTAuthState {
  /** Remote installation metadata survives credential import and sign-out. */
  hostId?: string;
  credential: ChatGPTCredential | null;
  models: string[];
  selectedModel: string | null;
  revision: number;
  reconnectReason: "refresh_pending" | "refresh_failed" | "token_rejected" | "disconnect_pending" | null;
}

/** One record makes credential replacement and the uncertainty marker atomic. */
export interface ChatGPTAuthStorage {
  read(): Promise<ChatGPTAuthState | undefined>;
  write(state: ChatGPTAuthState): Promise<void>;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function token(value: unknown): value is string {
  return typeof value === "string" && value.length >= 20 && value.length <= 16_384 && !/\s/.test(value);
}
function modelId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value);
}
function timestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value < 8_640_000_000_000_000;
}
function validScopes(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 32
    && value.every(scope => typeof scope === "string" && /^[A-Za-z0-9._:-]{1,100}$/.test(scope))
    && REQUIRED_SCOPES.every(scope => value.includes(scope));
}
function invalidCredential(): never {
  throw new ChatGPTAuthError("invalid_credential", "Import a current Sign in with ChatGPT credential with direct-token permission.");
}

/** Claim checks prevent mixing registrations; GET /models validates the bearer with OpenAI. */
export function validateChatGPTCredential(value: unknown, now = Date.now()): ChatGPTCredential {
  if (!record(value) || value.type !== "oauth" || !token(value.access) || value.access.startsWith("sk-")
    || !token(value.refresh) || !timestamp(value.expires) || value.expires <= now
    || typeof value.clientId !== "string" || !/^[A-Za-z0-9._:-]{1,200}$/.test(value.clientId)
    || value.clientId === "dynamic_agent_client" || !validScopes(value.scopes)
    || (value.earliestRefreshAt !== undefined && !timestamp(value.earliestRefreshAt))) invalidCredential();
  let accessExpires = value.expires;
  try {
    const parts = value.access.split(".");
    if (parts.length !== 3 || parts[1].length > 12_000) invalidCredential();
    const encoded = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Uint8Array.from(atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "=")), character => character.charCodeAt(0));
    const claims: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!record(claims) || claims.iss !== "https://auth.openai.com" || claims.aud !== API_RESOURCE
      || claims.client_id !== value.clientId || typeof claims.scope !== "string"
      || !timestamp(claims.exp) || claims.exp * 1000 + 5_000 < value.expires || claims.exp * 1000 <= now) invalidCredential();
    const claimScopes = claims.scope.split(/\s+/);
    if (!value.scopes.every(scope => claimScopes.includes(scope))) invalidCredential();
    accessExpires = Math.min(value.expires, claims.exp * 1000);
  } catch { invalidCredential(); }
  // Copy only canonical fields; browser payloads and retained ID tokens are not needed for inference.
  return {
    type: "oauth", access: value.access, refresh: value.refresh, expires: accessExpires,
    clientId: value.clientId, scopes: [...new Set(value.scopes)],
    ...(value.earliestRefreshAt === undefined ? {} : { earliestRefreshAt: value.earliestRefreshAt }),
  };
}

function emptyState(revision = 0, hostId?: string): ChatGPTAuthState {
  return { credential: null, models: [], selectedModel: null, revision, reconnectReason: null, ...(hostId ? { hostId } : {}) };
}
function safeStatus(state: ChatGPTAuthState): ChatGPTStatus {
  return {
    connected: state.credential !== null,
    reconnectRequired: state.reconnectReason !== null,
    expiresAt: state.credential ? new Date(state.credential.expires).toISOString() : null,
    models: [...state.models], selectedModel: state.selectedModel, revision: state.revision,
  };
}
function upstreamFailure(): ChatGPTAuthError {
  return new ChatGPTAuthError("upstream_error", "ChatGPT could not complete the connection request. Try again later.");
}
function reconnectFailure(): ChatGPTAuthError {
  return new ChatGPTAuthError("reconnect_required", "Reconnect ChatGPT before making further requests.");
}

async function readJson(response: Response, limit = MAX_JSON_BYTES): Promise<unknown> {
  if (!response.body) throw upstreamFailure();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw upstreamFailure();
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } catch { throw upstreamFailure(); }
  finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

/** Require a completed Responses event, rather than treating HTTP 200 or a partial answer as success. */
async function verifyCompletedResponse(response: Response): Promise<void> {
  const failure = (result: VerificationDiagnostic["result"], upstreamCode?: string): ChatGPTAuthError => {
    verificationDiagnostic({ phase: "stream", result, ...(upstreamCode ? { upstreamCode } : {}) });
    return new ChatGPTAuthError("model_unavailable", "ChatGPT could not complete this model's verification prompt.");
  };
  if (!response.body) throw failure("missing_body");
  const contentType = verificationContentType(response);
  // Some direct-token responses omit Content-Type. Validate their actual SSE terminal event.
  if (contentType !== "text/event-stream" && contentType !== "missing") {
    let payloadType: VerificationDiagnostic["payloadType"] = "unreadable";
    let responseStatus: VerificationDiagnostic["responseStatus"];
    let upstreamCode: string | undefined;
    try {
      const payload = await readJson(response, 65_536);
      ({ payloadType, responseStatus } = verificationPayloadDetails(payload));
      upstreamCode = verificationErrorCode(payload);
    } catch { /* Diagnostic payloads are optional and remain private. */ }
    verificationDiagnostic({
      phase: "stream", result: "unexpected_content_type", contentType, payloadType,
      ...(responseStatus ? { responseStatus } : {}), ...(upstreamCode ? { upstreamCode } : {}),
    });
    throw new ChatGPTAuthError("model_unavailable", "ChatGPT could not complete this model's verification prompt.");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let size = 0;
  const consume = (event: string): boolean => {
    const data = event.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
    if (!data || data === "[DONE]") return false;
    let payload: unknown;
    try { payload = JSON.parse(data); } catch { throw failure("invalid_event"); }
    if (!record(payload)) throw failure("invalid_event");
    if (payload.type === "error") throw failure("error", verificationErrorCode(payload));
    if (payload.type === "response.failed") throw failure("failed", verificationErrorCode(payload));
    if (payload.type === "response.incomplete") throw failure("incomplete", verificationErrorCode(payload));
    if (payload.type === "response.completed" && record(payload.response) && payload.response.status === "completed") {
      verificationDiagnostic({ phase: "stream", result: "completed" });
      return true;
    }
    return false;
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        if (buffer.trim() && consume(buffer)) return;
        throw failure("truncated");
      }
      size += value.byteLength;
      if (size > MAX_JSON_BYTES) throw failure("byte_limit");
      buffer += decoder.decode(value, { stream: true });
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const event = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        if (consume(event)) return;
      }
    }
  } catch (error) {
    if (error instanceof ChatGPTAuthError) throw error;
    throw failure("transport_error");
  }
  finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

/** The instance queue covers network awaits as well as writes, without blocking the DO runtime. */
export class ChatGPTAuthController {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly storage: ChatGPTAuthStorage,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
  private async read(): Promise<ChatGPTAuthState> {
    try { return await this.storage.read() ?? emptyState(); }
    catch { throw new ChatGPTAuthError("storage_error", "ChatGPT credential storage is unavailable."); }
  }
  private async write(state: ChatGPTAuthState): Promise<void> {
    try { await this.storage.write(state); }
    catch { throw new ChatGPTAuthError("storage_error", "ChatGPT credential storage is unavailable."); }
  }
  private async request(url: string, init: RequestInit, timeoutMs = 15_000, verification = false): Promise<Response> {
    // Native workerd fetch rejects being called with the controller as its receiver.
    const fetcher = this.fetcher;
    // Workerd supports manual/follow; every caller rejects non-2xx without following redirects.
    const signal = AbortSignal.timeout(timeoutMs);
    try { return await fetcher(url, { ...init, redirect: "manual", signal }); }
    catch {
      if (verification) verificationDiagnostic({ phase: "request", result: "transport_error", timedOut: signal.aborted });
      throw upstreamFailure();
    }
  }
  private async ensureHostId(): Promise<ChatGPTAuthState & { hostId: string }> {
    const state = await this.read();
    const hostId = state.hostId ?? `urn:uuid:${crypto.randomUUID()}`;
    const updated = { ...state, hostId };
    if (!state.hostId) await this.write(updated);
    return updated;
  }
  getHostId(): Promise<string> { return this.serialized(async () => (await this.ensureHostId()).hostId); }

  private async fetchCatalog(access: string, importing = false): Promise<string[]> {
    const response = await this.request(`${API_RESOURCE}/models`, { headers: { Authorization: `Bearer ${access}`, Accept: "application/json" } });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      if (importing && (response.status === 401 || response.status === 403)) invalidCredential();
      throw upstreamFailure();
    }
    const payload = await readJson(response);
    if (!record(payload) || !Array.isArray(payload.models) || payload.models.length > 2_000) throw upstreamFailure();
    const models = [...new Set(payload.models.flatMap(item => record(item) && item.visibility === "list" && modelId(item.slug) ? [item.slug] : []))];
    if (models.length === 0) throw new ChatGPTAuthError("model_unavailable", "No ChatGPT models are available for this connection.");
    return models;
  }

  connect(input: ChatGPTCredential): Promise<ChatGPTStatus> {
    return this.serialized(async () => {
      const credential = validateChatGPTCredential(input, this.now());
      // The remote host owns its ID; importing a laptop credential must never replace it.
      const prior = await this.ensureHostId();
      const models = await this.fetchCatalog(credential.access, true);
      const state: ChatGPTAuthState = { credential, models, selectedModel: null, revision: prior.revision + 1, reconnectReason: null, hostId: prior.hostId };
      await this.write(state);
      return safeStatus(state);
    });
  }

  status(): Promise<ChatGPTStatus> { return this.serialized(async () => safeStatus(await this.read())); }
  refreshCatalog(): Promise<ChatGPTStatus> { return this.serialized(() => this.refreshCatalogState()); }
  private async refreshCatalogState(): Promise<ChatGPTStatus> {
    const models = await this.fetchCatalog(await this.accessToken());
    // Token renewal may have replaced the credential; retain it and the current selection revision.
    const state = { ...await this.read(), models };
    await this.write(state);
    return safeStatus(state);
  }
  getSelection(): Promise<ChatGPTSelection> {
    return this.serialized(async () => {
      const state = await this.read();
      return { model: state.selectedModel, revision: state.revision };
    });
  }
  getAccessToken(): Promise<string> { return this.serialized(() => this.accessToken()); }

  private async accessToken(): Promise<string> {
    const state = await this.read();
    const credential = state.credential;
    if (!credential) throw new ChatGPTAuthError("not_connected", "Connect ChatGPT before using its models.");
    if (state.reconnectReason) throw reconnectFailure();
    const now = this.now();
    if (credential.expires > now + REFRESH_MARGIN_MS) return credential.access;
    if (credential.earliestRefreshAt !== undefined && credential.earliestRefreshAt > now) {
      if (credential.expires > now + 5_000) return credential.access;
      throw new ChatGPTAuthError("refresh_deferred", "ChatGPT access cannot be renewed yet. Try again after its refresh window opens.");
    }
    // An eviction or failed save after redemption must never cause replay of a rotating refresh token.
    await this.write({ ...state, reconnectReason: "refresh_pending" });
    try {
      const response = await this.request(TOKEN_URL, {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams({ grant_type: "refresh_token", client_id: credential.clientId, refresh_token: credential.refresh, resource: API_RESOURCE }),
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw reconnectFailure();
      }
      const payload = await readJson(response, 65_536);
      if (!record(payload) || !token(payload.access_token) || !token(payload.refresh_token)
        || typeof payload.expires_in !== "number" || !Number.isInteger(payload.expires_in)
        || payload.expires_in <= 60 || payload.expires_in > 86_400 || typeof payload.scope !== "string"
        || (payload.token_type !== undefined && payload.token_type !== "Bearer" && payload.token_type !== "bearer")) throw reconnectFailure();
      let earliestRefreshAt: number | undefined;
      if (payload.earliest_refresh_at !== undefined) {
        if (typeof payload.earliest_refresh_at === "number") earliestRefreshAt = payload.earliest_refresh_at < 1_000_000_000_000 ? payload.earliest_refresh_at * 1000 : payload.earliest_refresh_at;
        else if (typeof payload.earliest_refresh_at === "string") earliestRefreshAt = Date.parse(payload.earliest_refresh_at);
        if (!timestamp(earliestRefreshAt)) throw reconnectFailure();
      }
      const replacement = validateChatGPTCredential({
        type: "oauth", access: payload.access_token, refresh: payload.refresh_token,
        expires: this.now() + payload.expires_in * 1000, clientId: credential.clientId,
        scopes: payload.scope.split(/\s+/), ...(earliestRefreshAt === undefined ? {} : { earliestRefreshAt }),
      }, this.now());
      await this.write({ ...state, credential: replacement, reconnectReason: null });
      return replacement.access;
    } catch {
      // Preserve the old record for explicit reconnection/revocation, never for a second redemption.
      throw reconnectFailure();
    }
  }

  selectModel(model: string, verifyUnlisted = false): Promise<ChatGPTStatus> {
    return this.serialized(async () => {
      if (!modelId(model)) throw new ChatGPTAuthError("model_unavailable", "Choose a model listed for this ChatGPT connection.");
      let state = await this.read();
      if (!state.models.includes(model)) {
        await this.refreshCatalogState();
        state = await this.read();
      }
      // A caller that checks Pi's installed models can explicitly verify a slug omitted by picker metadata.
      if (!state.models.includes(model) && !verifyUnlisted) throw new ChatGPTAuthError("model_unavailable", "Choose a model listed for this ChatGPT connection.");
      const access = await this.accessToken();
      verificationDiagnostic({ phase: "request", result: "started" });
      const response = await this.request(`${API_RESOURCE}/responses`, {
        method: "POST", headers: { Authorization: `Bearer ${access}`, "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({ model, store: false, stream: true, input: [{ role: "user", content: "Reply exactly OK." }],
          ...(model === "gpt-6.1-sol" ? { reasoning: { effort: "medium" } } : {}) }),
      }, 30_000, true);
      if (!response.ok) {
        let upstreamCode: string | undefined;
        try { upstreamCode = verificationErrorCode(await readJson(response, 65_536)); } catch { /* Diagnostic bodies are optional and never reported. */ }
        verificationDiagnostic({ phase: "response", result: "http_error", status: response.status, ...(upstreamCode ? { upstreamCode } : {}) });
        if (response.status === 401) {
          await this.write({ ...await this.read(), reconnectReason: "token_rejected" });
          throw reconnectFailure();
        }
        throw new ChatGPTAuthError("model_unavailable", "ChatGPT could not complete this model's verification prompt.");
      }
      verificationDiagnostic({ phase: "response", result: "received", status: response.status });
      await verifyCompletedResponse(response);
      const current = await this.read();
      const selected = { ...current, selectedModel: model, revision: current.revision + 1 };
      await this.write(selected);
      return safeStatus(selected);
    });
  }

  useWorkersAI(): Promise<ChatGPTStatus> {
    return this.serialized(async () => {
      const state = await this.read();
      const updated = { ...state, selectedModel: null, revision: state.revision + 1 };
      await this.write(updated);
      return safeStatus(updated);
    });
  }

  disconnect(): Promise<{ revoked: boolean }> {
    return this.serialized(async () => {
      const state = await this.read();
      // Persist the stop before revocation so an interrupted sign-out cannot resume model requests.
      await this.write({ ...state, selectedModel: null, revision: state.revision + 1, reconnectReason: "disconnect_pending" });
      let revoked = state.credential === null;
      if (state.credential) {
        try {
          const discovery = await this.request(DISCOVERY_URL, { headers: { Accept: "application/json" } });
          if (!discovery.ok) { await discovery.body?.cancel().catch(() => undefined); throw upstreamFailure(); }
          const configuration = await readJson(discovery, 65_536);
          if (!record(configuration) || typeof configuration.revocation_endpoint !== "string") throw upstreamFailure();
          const endpoint = new URL(configuration.revocation_endpoint);
          if (endpoint.origin !== "https://auth.openai.com" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw upstreamFailure();
          const result = await this.request(endpoint.toString(), {
            method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ token: state.credential.refresh, token_type_hint: "refresh_token", client_id: state.credential.clientId }),
          });
          revoked = result.status === 200;
          await result.body?.cancel().catch(() => undefined);
        } catch { revoked = false; }
      }
      await this.write(emptyState(state.revision + 1, state.hostId));
      return { revoked };
    });
  }
}
