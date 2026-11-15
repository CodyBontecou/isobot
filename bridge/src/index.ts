import { DurableObject } from "cloudflare:workers";
import { timingSafeEqual } from "node:crypto";

const INSTANCE = "production";
const CHECK_INTERVAL_MS = 30_000;

export class DiscordBridge extends DurableObject<Env> {
  private starting?: Promise<void>;

  private async ensureReady(): Promise<void> {
    const container = this.ctx.container;
    if (!container) throw new Error("Discord Container binding is missing");
    const current = await container.inspect();
    // Named-image updates do not replace running instances automatically.
    if (current?.image && current.image !== container.images.base) {
      await container.destroy();
    }
    if (!container.running) {
      container.start({
        image: container.images.base,
        instance: "lite",
        enableInternet: true,
        env: {
          NODE_ENV: "production",
          PORT: "8080",
          DISCORD_HISTORY_GUILD_ID: this.env.DISCORD_HISTORY_GUILD_ID,
          DISCORD_BOT_TOKEN: this.env.DISCORD_BOT_TOKEN,
          GITHUB_TOKEN: this.env.GITHUB_TOKEN,
          GITHUB_WEBHOOK_SECRET: this.env.GITHUB_WEBHOOK_SECRET,
          ISOBOT_API_TOKEN: this.env.ISOBOT_API_TOKEN,
          ISOBOT_AGENT_URL: this.env.ISOBOT_AGENT_URL,
          ISOBOT_ALLOWED_USERS: this.env.ISOBOT_ALLOWED_USERS,
          SUPPORT_BRIDGE_TOKEN: this.env.SUPPORT_BRIDGE_TOKEN,
          SUPPORT_DISCORD_CHANNEL_ID: this.env.SUPPORT_DISCORD_CHANNEL_ID,
          SUPPORT_DISCORD_STAFF_IDS: this.env.SUPPORT_DISCORD_STAFF_IDS,
        },
      });
      console.log(JSON.stringify({ event: "bridge_starting", image: container.images.base }));
    }
    await container.setInactivityTimeout(10 * 60_000);
    const port = container.getTcpPort(8080);
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        const response = await port.fetch("http://container/health", { signal: AbortSignal.timeout(2000) });
        await response.body?.cancel();
        // A 503 means the HTTP server is up but Discord is still connecting.
        return;
      } catch {
        await scheduler.wait(500);
      }
    }
    throw new Error("Discord Container did not open port 8080");
  }

  async fetch(request: Request): Promise<Response> {
    if (await this.ctx.storage.get<boolean>("paused")) {
      return Response.json({ ok: false, paused: true }, { status: 503 });
    }
    // Persist the next check before startup, so a failed start is retried.
    await this.ctx.storage.setAlarm(Date.now() + CHECK_INTERVAL_MS);
    this.starting ??= this.ensureReady().finally(() => { this.starting = undefined; });
    await this.starting;
    const url = new URL(request.url);
    url.protocol = "http:";
    url.host = "container";
    const forwarded = new Request(url, request);
    forwarded.headers.delete("host");
    return this.ctx.container!.getTcpPort(8080).fetch(forwarded);
  }

  async alarm(): Promise<void> {
    const response = await this.fetch(new Request("http://container/health"));
    await response.body?.cancel();
    if (!response.ok) console.warn(JSON.stringify({ event: "bridge_unhealthy", status: response.status }));
  }

  async control(action: "pause" | "resume" | "restart"): Promise<Response> {
    await this.ctx.storage.put("paused", true);
    await this.ctx.storage.deleteAlarm();
    await this.starting?.catch(() => {});
    if (action !== "resume") await this.ctx.container?.destroy();
    if (action === "pause") return Response.json({ ok: true, paused: true });
    await this.ctx.storage.put("paused", false);
    return this.fetch(new Request("http://container/health"));
  }
}

async function authorized(request: Request, env: Env): Promise<boolean> {
  const encoder = new TextEncoder();
  const supplied = await crypto.subtle.digest("SHA-256", encoder.encode(request.headers.get("Authorization") ?? ""));
  const expected = await crypto.subtle.digest("SHA-256", encoder.encode(`Bearer ${env.ISOBOT_API_TOKEN}`));
  return timingSafeEqual(new Uint8Array(supplied), new Uint8Array(expected));
}

export default {
  async fetch(request, env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/api/discord/")) {
      if (!await authorized(request, env)) return new Response("Unauthorized", { status: 401 });
      return env.BRIDGE.getByName(INSTANCE).fetch(request);
    }
    const admin = /^\/admin\/(pause|resume|restart)$/.exec(path);
    if (request.method === "POST" && admin) {
      if (!await authorized(request, env)) return new Response("Unauthorized", { status: 401 });
      const action = admin[1];
      if (action === "pause" || action === "resume" || action === "restart") {
        return env.BRIDGE.getByName(INSTANCE).control(action);
      }
    }
    if (!((request.method === "GET" && path === "/health") ||
          (request.method === "POST" && path === "/gh/webhook"))) {
      return new Response("Not found", { status: 404 });
    }
    return env.BRIDGE.getByName(INSTANCE).fetch(request);
  },

  async scheduled(_controller, env): Promise<void> {
    const response = await env.BRIDGE.getByName(INSTANCE).fetch(new Request("http://container/health"));
    await response.body?.cancel();
    if (!response.ok) console.warn(JSON.stringify({ event: "bridge_unhealthy", status: response.status }));
  },
} satisfies ExportedHandler<Env>;
