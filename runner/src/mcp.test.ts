import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { handle, type ShellToolConfig } from "./mcp.js";
import { workerEnv } from "./proc.js";
import { sandboxProfile } from "./sandbox.js";

// The shell tool runs commands under sandbox-exec, which only macOS has (CI runs these in its macOS job).
const mac = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");

const workspace = mkdtempSync(path.join(tmpdir(), "isobot-mcp-test-"));
// Before the profile: it resolves /var → /private/var for paths that exist.
writeFileSync(path.join(workspace, "secret.env"), "TOKEN=hunter2");
const config: ShellToolConfig = {
  cwd: workspace, profile: sandboxProfile({ workspace, secrets: [path.join(workspace, "secret.env")] }),
  env: workerEnv({ ISOBOT_IOS_SIMULATOR: "SIM-1" }) as Record<string, string>, maxTimeoutMs: 60_000,
};

const call = (command: string) => handle(config, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "shell", arguments: { command } } }) as Promise<{ result: { content: { text: string }[]; isError: boolean } }>;

test("speaks enough MCP for Claude Code: initialize, tools/list, silent notifications", async () => {
  const init = await handle(config, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }) as { result: { protocolVersion: string; capabilities: object } };
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.ok("tools" in init.result.capabilities);
  assert.equal(await handle(config, { jsonrpc: "2.0", method: "notifications/initialized" }), undefined);
  const list = await handle(config, { jsonrpc: "2.0", id: 2, method: "tools/list" }) as { result: { tools: { name: string }[] } };
  assert.deepEqual(list.result.tools.map(t => t.name), ["shell"]);
});

test("runs commands in the workspace with the job's device env", { skip: !mac }, async () => {
  const response = await call("pwd -P; echo $ISOBOT_IOS_SIMULATOR; touch made-here");
  assert.equal(response.result.isError, false);
  assert.match(response.result.content[0].text, /^exit 0\n/);
  assert.match(response.result.content[0].text, /SIM-1/);
});

test("keeps the check sandbox: secrets unreadable, writes outside the workspace blocked", { skip: !mac }, async () => {
  const read = await call(`cat ${path.join(workspace, "secret.env")}`);
  assert.equal(read.result.isError, true);
  assert.doesNotMatch(read.result.content[0].text, /hunter2/);
  const write = await call(`echo x > ${path.join(process.env.HOME!, "isobot-mcp-escape-test")}`);
  assert.equal(write.result.isError, true);
});
