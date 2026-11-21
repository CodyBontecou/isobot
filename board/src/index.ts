import { DurableObject } from "cloudflare:workers";
import { handleAccountRequest, resolveAccountSession, type AccountEnvironment } from "../../cloudflare/src/account-routes.js";
import { BadSnapshot, BoardStore, type IngestResult } from "./store.js";

/**
 * The isobot board at bot.isolated.tech: a read-only view of the runner (state, schedule, timeline)
 * and its GitHub work. Runners push snapshots to /api/ingest with INGEST_TOKEN; people sign in with
 * GitHub through Pi's account service (the AccountAuth object in isobot-pi), so the same allowlist
 * and session code guard both. See docs/board.md.
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

    if (path === "/api/ingest") {
      if (request.method !== "POST") return json({ error: "Use POST" }, 405);
      const match = /^Bearer (.+)$/.exec(request.headers.get("Authorization") ?? "");
      if (!env.INGEST_TOKEN || !match || !await sameSecret(match[1], env.INGEST_TOKEN)) return json({ error: "Unauthorized" }, 401);
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
      if (request.method !== "GET") return json({ error: "Read only" }, 405);
      const session = await resolveAccountSession(request, accounts(env));
      if (!session) return json({ error: "Sign in" }, 401);
      const board = env.BOARD.getByName("board");
      if (path === "/api/board") return json(await board.board());
      if (path === "/api/events") {
        const days = Math.min(Math.max(Number(url.searchParams.get("days") ?? 7) || 7, 1), 30);
        const job = url.searchParams.get("job");
        if (job !== null && !/^[\w.-]+\/[\w.-]+#\d+$/.test(job)) return json({ error: "Bad job" }, 400);
        const since = new Date(Date.now() - days * 86_400_000).toISOString();
        return json({ events: await board.events({ since, jobId: job ?? undefined, limit: 5000 }) });
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

export class BoardState extends DurableObject<Env> {
  private readonly store: BoardStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new BoardStore(ctx.storage.sql);
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

  events(options: { since: string; jobId?: string; limit?: number }) { return this.store.events(options); }
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
