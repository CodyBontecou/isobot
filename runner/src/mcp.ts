import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { run, tail } from "./proc.js";
import { sandboxed } from "./sandbox.js";

/**
 * A minimal stdio MCP server Claude Code starts for each builder session (`--mcp-config`).
 * Its one tool runs a command in the job's workspace under the runner's check sandbox: the
 * same confinement the runner's own checks use for builder-written code (no keychain, no
 * credentials, writes only to the workspace and caches), but unlike the builder's Bash
 * sandbox it can reach CoreSimulator, adb and local ports. So it grants nothing the checks
 * don't already, and it lets the builder run device tests while it works instead of after.
 */
export interface ShellToolConfig {
  cwd: string;
  /** Seatbelt profile (sandbox.ts). */
  profile: string;
  env: Record<string, string>;
  maxTimeoutMs: number;
}

export const SHELL_TOOL = "shell";

const TOOL = {
  name: SHELL_TOOL,
  description: [
    "Run a shell command (via /bin/sh -c) in this repository, under isobot's check sandbox: the one the runner's own checks run in.",
    "Use it for anything your Bash tool's sandbox blocks: running tests on the iOS simulator or Android emulator isobot booted for you",
    "(xcodebuild test, ./gradlew connectedCheck, xcrun simctl, adb), and tests that open local network ports.",
    "Credentials and the keychain stay off limits, and only the workspace, temp and build caches are writable.",
    "Output is the exit code plus the last 12,000 characters of stdout and stderr.",
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "The command line, e.g. xcodebuild test -scheme App -destination \"id=$ISOBOT_IOS_SIMULATOR\"" },
      timeoutMinutes: { type: "number", description: "Kill the command after this many minutes (default 20)." },
    },
    required: ["command"],
  },
};

interface Request { jsonrpc: "2.0"; id?: number | string; method: string; params?: Record<string, unknown> }

export async function handle(config: ShellToolConfig, request: Request): Promise<unknown | undefined> {
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id: request.id, result });
  const error = (code: number, message: string) => ({ jsonrpc: "2.0", id: request.id, error: { code, message } });
  if (request.id === undefined) return undefined; // notifications (initialized, cancelled) need no answer
  switch (request.method) {
    case "initialize":
      return reply({
        protocolVersion: String(request.params?.protocolVersion ?? "2025-06-18"),
        capabilities: { tools: {} },
        serverInfo: { name: "isobot", version: "1.0.0" },
      });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: [TOOL] });
    case "tools/call": {
      const params = request.params ?? {};
      if (params.name !== SHELL_TOOL) return error(-32602, `unknown tool ${String(params.name)}`);
      const args = (params.arguments ?? {}) as { command?: unknown; timeoutMinutes?: unknown };
      if (typeof args.command !== "string" || !args.command.trim()) return reply({ content: [{ type: "text", text: "command is required" }], isError: true });
      const minutes = Number(args.timeoutMinutes);
      const timeoutMs = Math.min(config.maxTimeoutMs, Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : 20 * 60_000);
      const result = await run(...sandboxed(args.command, config.profile), { cwd: config.cwd, env: config.env, timeoutMs });
      const output = tail(`${result.stdout}\n${result.stderr}`.trim(), 12_000);
      const status = result.timedOut ? `timed out after ${Math.round(timeoutMs / 60_000)} min` : `exit ${result.code}`;
      return reply({ content: [{ type: "text", text: `${status}\n${output}` }], isError: result.timedOut || result.code !== 0 });
    }
    default:
      return error(-32601, `method not found: ${request.method}`);
  }
}

export function serve(config: ShellToolConfig, input = process.stdin, output = process.stdout): void {
  const lines = createInterface({ input });
  lines.on("line", line => {
    if (!line.trim()) return;
    let request: Request;
    try { request = JSON.parse(line) as Request; } catch { return; }
    void handle(config, request)
      .catch(err => ({ jsonrpc: "2.0", id: request.id, error: { code: -32603, message: (err as Error).message } }))
      .then(response => { if (response) output.write(`${JSON.stringify(response)}\n`); });
  });
}

// `node mcp.js <config.json>`: the runner writes the config per builder session.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  serve(JSON.parse(readFileSync(process.argv[2], "utf8")) as ShellToolConfig);
}
