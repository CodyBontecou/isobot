import { DurableObject } from "cloudflare:workers";
import { onAlarm, onPing, RETRY_MS, type Step, type WatchState } from "./watch.js";

interface Env {
  WATCHDOG: DurableObjectNamespace<Watchdog>;
  PING_TOKEN: string;
  DISCORD_WEBHOOK_URL: string;
  GRACE_MINUTES?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return new Response("ok");
    const match = /^\/(ping|status)\/([^/]+)$/.exec(url.pathname);
    if (!match || !env.PING_TOKEN || !sameSecret(match[2], env.PING_TOKEN)) return new Response("not found", { status: 404 });
    const watchdog = env.WATCHDOG.getByName("runner");
    if (match[1] === "ping" && request.method === "POST") {
      await watchdog.ping();
      return new Response("ok");
    }
    if (match[1] === "status" && request.method === "GET") return Response.json(await watchdog.status());
    return new Response("method not allowed", { status: 405 });
  },
} satisfies ExportedHandler<Env>;

export class Watchdog extends DurableObject<Env> {
  private get graceMs(): number {
    const minutes = Number(this.env.GRACE_MINUTES ?? 10);
    return (Number.isFinite(minutes) && minutes >= 2 ? minutes : 10) * 60_000;
  }

  private async load(): Promise<WatchState> {
    return (await this.ctx.storage.get<WatchState>("state")) ?? { lastPing: null, alertedAt: null };
  }

  async ping(): Promise<void> {
    await this.apply(onPing(await this.load(), Date.now(), this.graceMs));
  }

  async status(): Promise<WatchState & { graceMinutes: number }> {
    return { ...(await this.load()), graceMinutes: this.graceMs / 60_000 };
  }

  async alarm(): Promise<void> {
    const step = onAlarm(await this.load(), Date.now(), this.graceMs);
    if (step) await this.apply(step);
  }

  private async apply(step: Step): Promise<void> {
    const posted = !step.message || await this.post(step.message);
    if (!posted && step.state.alertedAt !== null) {
      // An alert Discord didn't take: keep the old state so the next alarm sends it again.
      await this.ctx.storage.setAlarm(Date.now() + RETRY_MS);
      return;
    }
    // A lost "back" message isn't worth retrying; the runner is healthy either way.
    await this.ctx.storage.put("state", step.state);
    await this.ctx.storage.setAlarm(step.alarmAt);
  }

  private async post(content: string): Promise<boolean> {
    try {
      const response = await fetch(this.env.DISCORD_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}

function sameSecret(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  return left.byteLength === right.byteLength && crypto.subtle.timingSafeEqual(left, right);
}
