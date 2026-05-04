import "dotenv/config";
import { Events } from "discord.js";
import { createClient } from "./client.js";
import { registerTicketMention } from "./handlers/ticketMention.js";
import { registerForumPostCreated } from "./handlers/forumPostCreated.js";
import { registerThreadCommentSync } from "./handlers/threadCommentSync.js";
import { startWebhookServer } from "./webhooks/server.js";
import { initAllowlist, describeAllowlist } from "./auth.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env var: ${name}. Copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
  return value;
}

async function main(): Promise<void> {
  const token = requireEnv("DISCORD_BOT_TOKEN");
  requireEnv("OPENAI_API_KEY");
  requireEnv("GITHUB_TOKEN");

  const client = createClient();

  client.once(Events.ClientReady, async (c) => {
    console.log(`[isobot] ready as ${c.user.tag} (id=${c.user.id})`);
    try {
      await initAllowlist(c);
      console.log(`[isobot] allowlist: ${describeAllowlist()}`);
    } catch (err) {
      console.error("[isobot] failed to load allowlist:", err);
    }
  });

  client.on(Events.Error, (err) => {
    console.error("[isobot] discord client error:", err);
  });

  registerTicketMention(client);
  registerForumPostCreated(client);
  registerThreadCommentSync(client);

  const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;
  const port = Number(process.env.PORT ?? 8080);
  if (webhookSecret) {
    startWebhookServer(client, webhookSecret, port);
  } else {
    console.warn("[isobot] GITHUB_WEBHOOK_SECRET unset; webhook server disabled");
  }

  const shutdown = async (signal: string) => {
    console.log(`[isobot] received ${signal}, shutting down`);
    try {
      await client.destroy();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await client.login(token);
}

main().catch((err) => {
  console.error("[isobot] fatal:", err);
  process.exit(1);
});
