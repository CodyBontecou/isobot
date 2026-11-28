#!/usr/bin/env node
// Pushes the Artifacts view's list to the board (docs/board.md#artifacts): `node board/scripts/push-artifacts.mjs list.json`.
// The file is { v: 1, at, artifacts: [{ title, url, project, repo, kind, updatedAt, pinned, shared }] }, replaced whole.
// Reads ISOBOT_BOARD_URL and ISOBOT_BOARD_TOKEN from the environment, or else from the runner's runner.env.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const file = process.argv[2];
if (!file) { console.error("usage: push-artifacts.mjs <list.json>"); process.exit(2); }

function fromRunnerEnv(name) {
  try {
    const text = readFileSync(path.join(homedir(), "Library/Application Support/isobot/runner.env"), "utf8");
    const line = text.split("\n").find(l => l.startsWith(`${name}=`));
    return line?.slice(name.length + 1).trim().replace(/^["']|["']$/g, "");
  } catch { return undefined; }
}
const url = process.env.ISOBOT_BOARD_URL ?? fromRunnerEnv("ISOBOT_BOARD_URL") ?? "https://bot.isolated.tech";
const token = process.env.ISOBOT_BOARD_TOKEN ?? fromRunnerEnv("ISOBOT_BOARD_TOKEN");
if (!token) { console.error("ISOBOT_BOARD_TOKEN isn't set (nor in runner.env)"); process.exit(2); }

const response = await fetch(new URL("/api/ingest/artifacts", url), {
  method: "POST",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: readFileSync(file, "utf8"),
});
const body = await response.text();
console.log(response.status, body);
process.exit(response.ok ? 0 : 1);
