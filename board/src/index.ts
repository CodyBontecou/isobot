import { DurableObject } from "cloudflare:workers";
import { checkSessionMutation, handleAccountRequest, resolveAccountSession, type AccountEnvironment } from "../../cloudflare/src/account-routes.js";
import { AgentStore, BadAgentInput } from "./agent.js";
import { BadAction, BadSnapshot, BoardStore, CALENDAR_MAX_DAYS, SUMMARY_MAX_DAYS, type IngestResult } from "./store.js";

/**
 * The isobot board at bot.isolated.tech: a view of the runner (state, schedule, timeline) and its GitHub
 * work, with task actions (approve, stop, retry, dismiss) queued here for the runner to apply. The board has
 * no GitHub token: the runner takes the queue from its ingest answers and does the work itself. Runners push snapshots to /api/ingest with INGEST_TOKEN; people sign in with
 * GitHub through Pi's account service (the AccountAuth object in isobot-pi), so the same allowlist
 * and session code guard both. Agent conversations (agent.ts) go over WebSockets the Durable Object holds with
 * hibernation: the runner keeps one open to take the owner's messages, browsers keep one to hear about changes.
 * See docs/board.md.
 */

interface Env {
  BOARD: DurableObjectNamespace<BoardState>;
  ASSETS: Fetcher;
  INGEST_TOKEN?: string;
  AUTH_ORIGIN?: string;
  AUTH_HOME?: string;
  GITHUB_OAUTH_CLIENT_ID?: string;
  GITHUB_OAUTH_CLIENT_SECRET?: string;
  GITHUB_OAUTH_ALLOWED_IDS?: string;
  AccountAuth: DurableObjectNamespace;
}

/** Runners send at most this much per push (the runner's push is well under 1 MB). */
const INGEST_LIMIT = 4_000_000;
const PRIVATE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };
const PAGE_HEADERS = {
  "Content-Security-Policy": "default-src 'self'; img-src 'self' data: https://avatars.githubusercontent.com; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};
const AGENT_WRITES = new Set(["/api/agent/messages", "/api/agent/decide", "/api/agent/rename", "/api/agent/archive"]);
/** The only account routes the board serves: web sign-in, its session, and sign-out. No API tokens or native app. */
const AUTH_ROUTES = new Set(["/auth/github/login", "/auth/github/callback", "/auth/logout", "/api/auth/session"]);

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: PRIVATE });
}

function accounts(env: Env): AccountEnvironment {
  return {
    AUTH_ORIGIN: env.AUTH_ORIGIN, AUTH_HOME: "/", GITHUB_OAUTH_CLIENT_ID: env.GITHUB_OAUTH_CLIENT_ID,
    GITHUB_OAUTH_CLIENT_SECRET: env.GITHUB_OAUTH_CLIENT_SECRET, GITHUB_OAUTH_ALLOWED_IDS: env.GITHUB_OAUTH_ALLOWED_IDS,
    AccountAuth: env.AccountAuth as unknown as AccountEnvironment["AccountAuth"],
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === "/health") return new Response("ok", { headers: PRIVATE });

    if (path === "/api/ingest" || path === "/api/ingest/actions" || path === "/api/ingest/agent") {
      const match = /^Bearer (.+)$/.exec(request.headers.get("Authorization") ?? "");
      if (!env.INGEST_TOKEN || !match || !await sameSecret(match[1], env.INGEST_TOKEN)) return json({ error: "Unauthorized" }, 401);
      // The runner's poll between pushes: just the queued actions.
      // The runner's agent connection: a WebSocket the Durable Object holds (BoardState.fetch).
      if (path === "/api/ingest/agent") return upgrade(request, env, "runner");
      if (path === "/api/ingest/actions") return request.method === "GET" ? json({ actions: await env.BOARD.getByName("board").pendingActions() }) : json({ error: "Use GET" }, 405);
      if (request.method !== "POST") return json({ error: "Use POST" }, 405);
      const body = await readText(request, INGEST_LIMIT);
      if (body === null) return json({ error: "Snapshot too large" }, 413);
      let snapshot: unknown;
      try { snapshot = JSON.parse(body); } catch { return json({ error: "Invalid JSON" }, 400); }
      const result = await env.BOARD.getByName("board").ingest(snapshot);
      return "error" in result ? json({ error: result.error }, 400) : json(result);
    }

    if (AUTH_ROUTES.has(path)) {
      // Sign-in takes no options here (Pi's `conversation` and native-app parameters don't apply).
      if (path === "/auth/github/login" && url.search) return Response.redirect(`${url.origin}/auth/github/login`, 302);
      return handleAccountRequest(request, accounts(env));
    }

    if (path.startsWith("/api/")) {
      const session = await resolveAccountSession(request, accounts(env));
      if (!session) return json({ error: "Sign in" }, 401);
      const board = env.BOARD.getByName("board");
      if (path === "/api/actions") {
        if (request.method !== "POST") return json({ error: "Use POST" }, 405);
        // Same guard as Pi's console: the board's own origin and this session's CSRF secret.
        if (!await checkSessionMutation(request, accounts(env), session)) return json({ error: "Forbidden" }, 403);
        const body = await readText(request, 4_000);
        let input: Record<string, unknown>;
        try { input = JSON.parse(body ?? "") as Record<string, unknown>; } catch { return json({ error: "Invalid JSON" }, 400); }
        const result = await board.queueAction({ kind: input?.kind, repo: input?.repo, number: input?.number, by: session.account.login });
        return "error" in result ? json({ error: result.error }, 400) : json({ action: result });
      }
      if (path === "/api/agent/live") {
        // A browser's change feed. WebSocket upgrades carry no CSRF header, so the Origin must be the board's own.
        if (request.headers.get("Origin") !== url.origin) return json({ error: "Forbidden" }, 403);
        return upgrade(request, env, "browser");
      }
      if (AGENT_WRITES.has(path)) {
        if (request.method !== "POST") return json({ error: "Use POST" }, 405);
        if (!await checkSessionMutation(request, accounts(env), session)) return json({ error: "Forbidden" }, 403);
        const body = await readText(request, 40_000);
        let input: Record<string, unknown>;
        try { input = JSON.parse(body ?? "") as Record<string, unknown>; } catch { return json({ error: "Invalid JSON" }, 400); }
        if (!input || typeof input !== "object") return json({ error: "Invalid JSON" }, 400);
        const result = await board.agentWrite(path, input, session.account.login) as Record<string, unknown>;
        return typeof result.error === "string" ? json({ error: result.error }, 400) : json(result);
      }
      if (request.method !== "GET") return json({ error: "Read only" }, 405);
      if (path === "/api/agent") {
        const thread = url.searchParams.get("thread");
        return json(await board.agent(thread && /^[\w-]{1,64}$/.test(thread) ? thread : null));
      }
      if (path === "/api/board") return json(await board.board());
      if (path === "/api/metrics") return json({ metrics: await board.metrics() });
      if (path === "/api/events") {
        const days = Math.min(Math.max(Number(url.searchParams.get("days") ?? 7) || 7, 1), 30);
        const job = url.searchParams.get("job");
        if (job !== null && !/^[\w.-]+\/[\w.-]+#\d+$/.test(job)) return json({ error: "Bad job" }, 400);
        const since = new Date(Date.now() - days * 86_400_000).toISOString();
        return json({ events: await board.events({ since, jobId: job ?? undefined, limit: 5000 }) });
      }
      if (path === "/api/summary" || path === "/api/calendar") {
        // The browser picks the period in its own time zone and sends its bounds as instants.
        const span = instants(url, ["from", "to", ...(path === "/api/summary" ? ["compare"] : [])]);
        const max = (path === "/api/summary" ? SUMMARY_MAX_DAYS : CALENDAR_MAX_DAYS) * 86_400_000;
        if (!span) return json({ error: "Bad range" }, 400);
        const start = span.compare ?? span.from;
        if (span.from > span.to || start > span.from || Date.parse(span.to) - Date.parse(start) > max) return json({ error: "Bad range" }, 400);
        return path === "/api/summary"
          ? json(await board.summary({ from: span.from, to: span.to, compareFrom: start }))
          : json(await board.calendar({ from: span.from, to: span.to }));
      }
      return json({ error: "Not found" }, 404);
    }

    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
    // The page shell holds no data; everything it shows comes from the signed-in /api routes.
    const asset = await env.ASSETS.fetch(path.startsWith("/assets/") ? request : new Request(new URL("/", url), request));
    const response = new Response(asset.body, asset);
    for (const [key, value] of Object.entries(PAGE_HEADERS)) response.headers.set(key, value);
    if (!path.startsWith("/assets/")) response.headers.set("Cache-Control", "no-store");
    return response;
  },
} satisfies ExportedHandler<Env>;

/** Hands a WebSocket upgrade to the board's Durable Object, saying who it is (checked by the caller). */
function upgrade(request: Request, env: Env, role: "runner" | "browser"): Promise<Response> | Response {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return json({ error: "Expected a WebSocket" }, 426);
  const headers = new Headers(request.headers);
  headers.set("X-Agent-Role", role);
  return env.BOARD.getByName("board").fetch(new Request(request, { headers }));
}

export class BoardState extends DurableObject<Env> {
  private readonly store: BoardStore;
  private readonly agentStore: AgentStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new BoardStore(ctx.storage.sql);
    this.agentStore = new AgentStore(ctx.storage.sql);
    // Keep-alives answered without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  /** WebSocket upgrades only, from upgrade() above: the worker has already checked who this is. */
  async fetch(request: Request): Promise<Response> {
    const role = request.headers.get("X-Agent-Role");
    if (role !== "runner" && role !== "browser") return new Response("Not found", { status: 404 });
    const { 0: client, 1: server } = new WebSocketPair();
    if (role === "runner") {
      // One runner connection: a reconnect replaces the old one.
      for (const old of this.ctx.getWebSockets("runner")) { try { old.close(4000, "replaced"); } catch { /* already gone */ } }
    } else if (this.ctx.getWebSockets("browser").length >= 20) {
      return new Response("Too many connections", { status: 429 });
    }
    this.ctx.acceptWebSocket(server, [role]);
    if (role === "runner") {
      this.flushWork();
      this.tellBrowsers();
    } else {
      server.send(JSON.stringify({ type: "changed", version: this.agentStore.version(), runner: this.runnerConnected() }));
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (!this.ctx.getTags(ws).includes("runner") || typeof message !== "string") return;
    let parsed: { type?: unknown; update?: unknown };
    try { parsed = JSON.parse(message) as typeof parsed; } catch { return; }
    if (parsed.type === "update") {
      try { this.agentStore.apply(parsed.update); } catch (error) {
        if (!(error instanceof BadAgentInput)) throw error;
        ws.send(JSON.stringify({ type: "error", error: error.message }));
        return;
      }
      this.tellBrowsers();
    }
    // The runner says it's ready for more after every update, and on connect.
    if (parsed.type === "update" || parsed.type === "ready") this.flushWork();
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, "bye"); } catch { /* already closed */ }
    if (this.ctx.getTags(ws).includes("runner")) this.tellBrowsers(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    if (this.ctx.getTags(ws).includes("runner")) this.tellBrowsers(ws);
  }

  private runnerConnected(except?: WebSocket): boolean {
    return this.ctx.getWebSockets("runner").some(ws => ws !== except && ws.readyState === WebSocket.OPEN);
  }

  /** Sends the runner whatever waits for it; if the send fails, it waits for the next connection. */
  private flushWork(): void {
    const runner = this.ctx.getWebSockets("runner").filter(ws => ws.readyState === WebSocket.OPEN).at(-1);
    if (!runner || !this.agentStore.hasWork()) return;
    const work = this.agentStore.takeWork();
    try {
      runner.send(JSON.stringify({ type: "work", work }));
    } catch {
      this.agentStore.untake(work);
    }
    this.tellBrowsers();
  }

  private tellBrowsers(closing?: WebSocket): void {
    const note = JSON.stringify({ type: "changed", version: this.agentStore.version(), runner: this.runnerConnected(closing) });
    for (const ws of this.ctx.getWebSockets("browser")) { try { ws.send(note); } catch { /* closed; the browser reconnects */ } }
  }

  /** The Agents list, and one conversation when asked for. */
  agent(threadId: string | null) {
    return {
      version: this.agentStore.version(), runner: this.runnerConnected(), threads: this.agentStore.threads(),
      conversation: threadId ? this.agentStore.conversation(threadId) : null,
    };
  }

  /** The owner's writes: a message, a decision on a proposal, a rename or an archive. Bad input comes back as `{ error }`. */
  agentWrite(path: string, input: Record<string, unknown>, by: string) {
    try {
      let result: Record<string, unknown>;
      if (path === "/api/agent/messages") result = this.agentStore.send({ threadId: input.threadId, text: input.text, context: input.context, by });
      else if (path === "/api/agent/decide") result = { proposal: this.agentStore.decide({ proposalId: input.proposalId, decision: input.decision, by }) };
      else if (path === "/api/agent/rename") result = { thread: this.agentStore.rename({ threadId: input.threadId, title: input.title }) };
      else result = { thread: this.agentStore.archive({ threadId: input.threadId, archived: input.archived }) };
      this.flushWork();
      this.tellBrowsers();
      return result;
    } catch (error) {
      if (error instanceof BadAgentInput) return { error: error.message };
      throw error;
    }
  }

  /** A malformed snapshot comes back as `{ error }` rather than an exception across RPC. */
  ingest(snapshot: unknown): IngestResult | { error: string } {
    try {
      return this.store.ingest(snapshot);
    } catch (error) {
      if (error instanceof BadSnapshot) return { error: error.message };
      throw error;
    }
  }

  board() { return this.store.board(); }

  pendingActions() { return this.store.pendingActions(); }

  /** A bad click comes back as `{ error }` rather than an exception across RPC. */
  queueAction(input: { kind: unknown; repo: unknown; number: unknown; by: string }) {
    try {
      return this.store.queueAction(input);
    } catch (error) {
      if (error instanceof BadAction) return { error: error.message };
      throw error;
    }
  }

  metrics() { return this.store.metrics(); }

  events(options: { since: string; jobId?: string; limit?: number }) { return this.store.events(options); }

  summary(options: { from: string; to: string; compareFrom: string }) { return this.store.summary(options); }

  calendar(options: { from: string; to: string }) { return this.store.calendar(options); }
}

/** The named query parameters as ISO instants (normalized, so they compare as strings), or null if any is missing or bad. */
function instants(url: URL, names: string[]): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const name of names) {
    const value = url.searchParams.get(name);
    const time = value ? Date.parse(value) : Number.NaN;
    if (Number.isNaN(time)) return null;
    out[name] = new Date(time).toISOString();
  }
  return out;
}

async function readText(request: Request, limit: number): Promise<string | null> {
  const declared = Number(request.headers.get("Content-Length") ?? 0);
  if (declared > limit) return null;
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > limit) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

async function sameSecret(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [x, y] = await Promise.all([a, b].map(value => crypto.subtle.digest("SHA-256", encoder.encode(value))));
  return crypto.subtle.timingSafeEqual(x, y);
}
