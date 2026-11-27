import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { defaultExec, SelfUpdate, type Exec } from "./selfUpdate.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } }).trim();

/** An origin, the live checkout cloned from it, and a second clone to push "merges" from. */
function repos() {
  const dir = mkdtempSync(path.join(tmpdir(), "isobot-self-"));
  const origin = path.join(dir, "origin.git");
  execFileSync("git", ["init", "--bare", "-q", "-b", "main", origin]);
  const dev = path.join(dir, "dev");
  execFileSync("git", ["clone", "-q", origin, dev], { stdio: "pipe" });
  for (const repo of [dev]) {
    git(repo, "config", "user.email", "t@example.com");
    git(repo, "config", "user.name", "t");
  }
  write(dev, "runner/src/a.ts", "1");
  write(dev, "board/ui.ts", "1");
  write(dev, "README.md", "1");
  commit(dev, "start");
  git(dev, "push", "-q", "origin", "main");
  const live = path.join(dir, "live");
  execFileSync("git", ["clone", "-q", origin, live]);
  mkdirSync(path.join(live, "runner", "dist"), { recursive: true });
  return { dev, live };
}

function write(repo: string, file: string, text: string) {
  mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  writeFileSync(path.join(repo, file), text);
}
function commit(repo: string, message: string) {
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", message);
}
function merge(dev: string, file: string, message: string) {
  write(dev, file, String(Math.random()));
  commit(dev, message);
  git(dev, "push", "-q", "origin", "main");
  return git(dev, "rev-parse", "HEAD");
}

function setup(over: { failBuild?: boolean } = {}) {
  const { dev, live } = repos();
  const commands: string[] = [];
  const notes: string[] = [];
  let clock = 0;
  const exec: Exec = async (command, args, options) => {
    if (command === "git") return defaultExec(command, args, options);
    commands.push(args[1]);
    return { ok: !(over.failBuild && args[1].includes("run build")), output: "boom" };
  };
  const update = new SelfUpdate({
    root: live, exec, notify: async text => notes.push(text), now: () => clock,
    config: { deploy: { board: "npm --prefix board run deploy" } },
  });
  return { dev, live, commands, notes, update, later: () => { clock += 10 * 60_000; } };
}

test("a merge under runner/ is pulled, built and waits to restart; a board change is deployed", async () => {
  const s = setup();
  await s.update.tick();
  assert.deepEqual(s.commands, [], "nothing new: nothing runs");

  const sha = merge(s.dev, "runner/src/a.ts", "Chat: let the issues tool read closed issues");
  merge(s.dev, "board/ui.ts", "Board: tidy the dock");
  s.later();
  await s.update.tick();
  assert.equal(git(s.live, "rev-parse", "HEAD"), git(s.dev, "rev-parse", "HEAD"));
  assert.deepEqual(s.commands, ["npm --prefix runner run build", "npm --prefix board run deploy"]);
  assert.equal(readFileSync(path.join(s.live, "runner/dist/.built-sha"), "utf8"), git(s.dev, "rev-parse", "HEAD"));
  assert.ok(s.update.pending);
  assert.notEqual(sha, s.update.pending.sha);
  assert.match(s.notes.at(-1)!, /updated itself.*\n• Board: tidy the dock\n• Chat: let the issues tool/s);

  assert.equal(s.update.readyToRestart(1, 0), false, "a build is running");
  assert.equal(s.update.readyToRestart(0, 2), false, "a chat turn is running");
  assert.equal(s.update.readyToRestart(0, 0), true);
  s.later(); s.later(); s.later(); s.later();
  assert.equal(s.update.readyToRestart(0, 2), true, "children don't hold it up forever");
  assert.equal(s.update.readyToRestart(1, 0), false, "builds always do");
});

test("a docs-only merge is pulled without a build or restart", async () => {
  const s = setup();
  merge(s.dev, "README.md", "Docs");
  s.later();
  await s.update.tick();
  assert.equal(git(s.live, "rev-parse", "HEAD"), git(s.dev, "rev-parse", "HEAD"));
  assert.deepEqual(s.commands, []);
  assert.equal(s.update.pending, null);
});

test("a failed build keeps the old runner and isn't retried until the next merge", async () => {
  const s = setup({ failBuild: true });
  merge(s.dev, "runner/src/a.ts", "Break it");
  s.later();
  await s.update.tick();
  assert.equal(s.update.pending, null);
  assert.match(s.notes.at(-1)!, /couldn't finish updating itself.*❌ runner build/s);
  s.later();
  await s.update.tick();
  assert.equal(s.commands.length, 1, "same commit: not built again");
  merge(s.dev, "runner/src/a.ts", "Fix it");
  s.later();
  await s.update.tick();
  assert.equal(s.commands.length, 2);
});

test("a dirty or off-branch live checkout is left alone and reported once", async () => {
  const s = setup();
  merge(s.dev, "runner/src/a.ts", "Change");
  write(s.live, "README.md", "local edit");
  s.later();
  await s.update.tick();
  s.later();
  await s.update.tick();
  assert.equal(s.notes.length, 1);
  assert.match(s.notes[0], /uncommitted changes/);
  assert.deepEqual(s.commands, []);
  git(s.live, "checkout", "-q", "--", "README.md");
  git(s.live, "checkout", "-q", "-b", "topic");
  s.later();
  await s.update.tick();
  assert.match(s.notes.at(-1)!, /on `topic`, not `main`/);
});
