import http from "node:http";
import type { Client } from "discord.js";
import { verifySignature } from "./verify.js";
import { handleEvent } from "./handlers.js";

export function startWebhookServer(client: Client, secret: string, port: number): http.Server {
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
      return;
    }
    if (req.method !== "POST" || req.url !== "/gh/webhook") {
      res.writeHead(404);
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const sig = req.headers["x-hub-signature-256"];
      const sigStr = Array.isArray(sig) ? sig[0] : sig;
      if (!verifySignature(secret, body, sigStr)) {
        res.writeHead(401);
        res.end("bad signature");
        return;
      }
      const event = req.headers["x-github-event"];
      const eventStr = Array.isArray(event) ? event[0] : event;
      let payload: unknown;
      try {
        payload = JSON.parse(body.toString("utf8"));
      } catch {
        res.writeHead(400);
        res.end("bad json");
        return;
      }
      // Acknowledge fast — GitHub times out at 10s. Process async.
      res.writeHead(202);
      res.end();
      handleEvent(client, eventStr, payload).catch((err) => {
        console.error("[isobot] webhook handler error:", err);
      });
    });
    req.on("error", (err) => {
      console.error("[isobot] webhook req error:", err);
    });
  });
  server.listen(port, "0.0.0.0", () => {
    console.log(`[isobot] webhook server listening on :${port}`);
  });
  return server;
}
