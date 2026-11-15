import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { test } from "node:test";
import { Client } from "discord.js";
import { startWebhookServer } from "./server.js";

test("health reports Discord readiness and webhooks retain signature validation", async (t) => {
  const oldToken = process.env.ISOBOT_API_TOKEN;
  process.env.ISOBOT_API_TOKEN = "test-api-token";
  t.after(() => { if(oldToken === undefined) delete process.env.ISOBOT_API_TOKEN; else process.env.ISOBOT_API_TOKEN=oldToken; });
  const client = new Client({ intents: [] });
  const server = startWebhookServer(client, "test-secret", 0);
  await once(server, "listening");
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    await client.destroy();
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const disconnected = await fetch(`${origin}/health`);
  assert.equal(disconnected.status, 503);
  assert.match(await disconnected.text(), /"discordReady":false/);
  t.mock.method(client, "isReady", () => true);
  const connected = await fetch(`${origin}/health`);
  assert.equal(connected.status, 200);
  assert.match(await connected.text(), /"discordReady":true/);
  const privateRead = await fetch(`${origin}/api/discord/channels`);
  assert.equal(privateRead.status,401);await privateRead.body?.cancel();
  const forbiddenWrite = await fetch(`${origin}/api/discord/channels`,{method:"POST",headers:{Authorization:"Bearer test-api-token"}});
  assert.equal(forbiddenWrite.status,405);await forbiddenWrite.body?.cancel();
  const body = JSON.stringify({ zen: "migration check" });
  const unsigned = await fetch(`${origin}/gh/webhook`, { method: "POST", body });
  assert.equal(unsigned.status, 401);
  await unsigned.body?.cancel();
  const signed = await fetch(`${origin}/gh/webhook`, {
    method: "POST", body,
    headers: {
      "x-github-event": "ping",
      "x-hub-signature-256": `sha256=${createHmac("sha256", "test-secret").update(body).digest("hex")}`,
    },
  });
  assert.equal(signed.status, 202);
  await signed.body?.cancel();
});
