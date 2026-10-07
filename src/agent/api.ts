import { setTimeout as delay } from "node:timers/promises";
import type { TicketRequest } from "./types.js";

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRY_DELAY_MS = 30_000;

function config(): { baseUrl: URL; token: string } {
  const url = process.env.ISOBOT_AGENT_URL;
  const token = process.env.ISOBOT_API_TOKEN;
  if (!url || !token) throw new Error("ISOBOT_AGENT_URL and ISOBOT_API_TOKEN are required");
  const baseUrl = new URL(url);
  const localhost = baseUrl.hostname === "localhost" || baseUrl.hostname === "127.0.0.1" || baseUrl.hostname === "[::1]";
  if (baseUrl.protocol !== "https:" && !(baseUrl.protocol === "http:" && localhost)) {
    throw new Error("ISOBOT_AGENT_URL must use HTTPS; HTTP is allowed only for localhost development");
  }
  if (baseUrl.username || baseUrl.password || url.includes("?") || url.includes("#")) {
    throw new Error("ISOBOT_AGENT_URL must not contain credentials, a query, or a fragment");
  }
  return { baseUrl, token };
}

export async function requestAgent(path: string, method: "GET" | "POST", body?: TicketRequest): Promise<unknown> {
  const agent = config();
  const endpoint = new URL(path, agent.baseUrl);
  for (let attempt = 0; attempt < 3; attempt++) {
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method,
        headers: {
          Authorization: `Bearer ${agent.token}`,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        redirect: "error",
      });
      // A body read can fail after the Worker has durably accepted the operation.
      if (response.ok) return response.status === 204 ? undefined : await response.json();
    } catch (error) {
      if (attempt === 2) {
        throw new Error("Couldn't reach the Cloudflare Pi agent", { cause: error });
      }
      await delay(500 * 2 ** attempt);
      continue;
    }

    const retryable = response.status === 429 || response.status >= 500;
    await response.body?.cancel();
    if (!retryable || attempt === 2) {
      // Provider error bodies never belong in a Discord reply.
      throw new Error(`Cloudflare Pi agent request failed (HTTP ${response.status})`);
    }
    const retryAfter = Number(response.headers.get("Retry-After"));
    await delay(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, MAX_RETRY_DELAY_MS) : 500 * 2 ** attempt);
  }
  throw new Error("Couldn't reach the Cloudflare Pi agent");
}
