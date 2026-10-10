import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { ChatGPTAuthError, validateChatGPTCredential } from "./chatgpt-auth-store.js";
import { readJson } from "./http-body.js";
import type { Bindings } from "./index.js";

const paths = new Set(["/api/chatgpt/connection", "/api/chatgpt/models", "/api/chatgpt/model", "/api/chatgpt/workers-ai", "/api/chatgpt/host"]);
const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
export function isChatGPTRoute(path: string): boolean { return paths.has(path); }

async function authorized(request: Request, token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const encoder = new TextEncoder();
  const [actual, expected] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(request.headers.get("Authorization") ?? "")),
    crypto.subtle.digest("SHA-256", encoder.encode(`Bearer ${token}`)),
  ]);
  return crypto.subtle.timingSafeEqual(actual, expected);
}

/** Credential administration has its own token; prompt and Discord tokens cannot access it. */
export async function handleChatGPTRequest(request: Request, env: Bindings): Promise<Response> {
  if (!await authorized(request, env.CHATGPT_ADMIN_TOKEN)) {
    return Response.json({ error: "Unauthorized" }, { status: 401, headers });
  }
  const path = new URL(request.url).pathname;
  const allowed = path === "/api/chatgpt/connection" ? ["GET", "PUT", "DELETE"]
    : path === "/api/chatgpt/models" || path === "/api/chatgpt/host" ? ["GET"] : ["POST"];
  if (!allowed.includes(request.method)) {
    return Response.json({ error: "Method not allowed" }, { status: 405, headers: { ...headers, Allow: allowed.join(", ") } });
  }
  try {
    // Validate incoming data before any credential-owner RPC.
    if (path === "/api/chatgpt/connection" && request.method === "PUT") {
      const body = await readJson(request, 65_536);
      const credential = validateChatGPTCredential(body && typeof body === "object" && "credential" in body ? body.credential : undefined);
      return Response.json(await env.ChatGPTAuth.getByName("primary").importCredential(credential), { headers });
    }
    if (path === "/api/chatgpt/model") {
      const body = await readJson(request, 4096);
      const model = body && typeof body === "object" && "model" in body ? body.model : undefined;
      if (typeof model !== "string" || !openaiProvider().getModels().some(entry => entry.id === model && entry.api === "openai-responses")) {
        return Response.json({ error: "Choose a ChatGPT model supported by this Pi installation." }, { status: 400, headers });
      }
      return Response.json(await env.ChatGPTAuth.getByName("primary").selectModel(model, true), { headers });
    }
    const auth = env.ChatGPTAuth.getByName("primary");
    if (path === "/api/chatgpt/host") return Response.json({ hostId: await auth.getHostId() }, { headers });
    if (path === "/api/chatgpt/connection" && request.method === "DELETE") {
      return Response.json({ connected: false, ...await auth.disconnect() }, { headers });
    }
    if (path === "/api/chatgpt/workers-ai") return Response.json(await auth.useWorkersAI(), { headers });
    if (path === "/api/chatgpt/models") {
      const status = await auth.refreshCatalog();
      const known = new Set(openaiProvider().getModels().filter(entry => entry.api === "openai-responses").map(entry => entry.id));
      return Response.json({ models: status.models.filter(model => known.has(model)), selectedModel: status.selectedModel }, { headers });
    }
    return Response.json(await auth.status(), { headers });
  } catch (error) {
    if (error instanceof ChatGPTAuthError && error.code === "invalid_credential") {
      return Response.json({ error: error.message }, { status: 400, headers });
    }
    if (error instanceof SyntaxError || (error instanceof Error && ["Request body too large", "Missing request body"].includes(error.message))) {
      return Response.json({ error: "Invalid JSON request body" }, { status: 400, headers });
    }
    // RPC/upstream errors may carry provider detail. Never expose or log their messages.
    console.warn(JSON.stringify({ event: "chatgpt_request_failed", path }));
    return Response.json({ error: "ChatGPT could not complete the request. Check the connection status or reconnect." }, { status: 503, headers });
  }
}
