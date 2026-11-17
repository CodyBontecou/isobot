import { randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { CHAT_TOOLS, ToolError } from "./chatTools.js";

/**
 * The staff chat's tools, served to Claude Code as an MCP server over HTTP on 127.0.0.1 from inside
 * the runner process. The runner keeps its GitHub token and state to itself; the chat model only
 * sees tool results. Each model turn gets its own bearer token, which maps calls back to that turn
 * (its attachments and proposals) and stops working when the turn ends.
 */
export type ToolCall = (name: string, args: Record<string, unknown>) => Promise<string>;

interface RpcRequest { jsonrpc: "2.0"; id?: number | string; method: string; params?: Record<string, unknown> }

export class ChatToolServer {
  private server: http.Server | null = null;
  private turns = new Map<string, ToolCall>();
  private port = 0;

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(0, "127.0.0.1", () => resolve());
    });
    this.port = (this.server.address() as AddressInfo).port;
  }

  stop(): void {
    this.server?.close();
    this.server = null;
  }

  /** Registers a turn; returns the `--mcp-config` JSON for it and a function that ends it. */
  open(call: ToolCall): { mcpConfig: string; close: () => void } {
    const token = randomBytes(24).toString("hex");
    this.turns.set(token, call);
    const mcpConfig = JSON.stringify({ mcpServers: { isobot: { type: "http", url: `http://127.0.0.1:${this.port}/mcp`, headers: { Authorization: `Bearer ${token}` } } } });
    return { mcpConfig, close: () => this.turns.delete(token) };
  }

  private lookup(header: string | undefined): ToolCall | null {
    const given = Buffer.from(/^Bearer (\w+)$/.exec(header ?? "")?.[1] ?? "");
    for (const [token, call] of this.turns) {
      const expected = Buffer.from(token);
      if (given.length === expected.length && timingSafeEqual(given, expected)) return call;
    }
    return null;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const call = this.lookup(req.headers.authorization);
    // Anything else on this Mac that finds the port gets nothing without a live turn's token.
    if (!call || req.url !== "/mcp") return void res.writeHead(404).end();
    if (req.method !== "POST") return void res.writeHead(405).end();
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 1_000_000) return void res.writeHead(413).end();
    }
    let request: RpcRequest;
    try { request = JSON.parse(body) as RpcRequest; } catch { return void res.writeHead(400).end(); }
    const response = await respond(request, call);
    if (response === undefined) return void res.writeHead(202).end();
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(response));
  }
}

export async function respond(request: RpcRequest, call: ToolCall): Promise<unknown | undefined> {
  if (request.id === undefined) return undefined;
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id: request.id, result });
  switch (request.method) {
    case "initialize":
      return reply({ protocolVersion: String(request.params?.protocolVersion ?? "2025-06-18"), capabilities: { tools: {} }, serverInfo: { name: "isobot", version: "1.0.0" } });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: CHAT_TOOLS });
    case "tools/call": {
      const name = String(request.params?.name ?? "");
      const args = (request.params?.arguments ?? {}) as Record<string, unknown>;
      try {
        return reply({ content: [{ type: "text", text: await call(name, args) }] });
      } catch (error) {
        const message = error instanceof ToolError ? error.message : `failed: ${(error as Error).message}`;
        return reply({ content: [{ type: "text", text: message }], isError: true });
      }
    }
    default:
      return { jsonrpc: "2.0", id: request.id, error: { code: -32601, message: `method not found: ${request.method}` } };
  }
}
