import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Repo } from "./git.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
}

test("worktree lifecycle against a real repository", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "isobot-git-"));
  const origin = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  execFileSync("git", ["init", "--bare", "-b", "main", origin]);
  execFileSync("git", ["clone", origin, seed]);
  writeFileSync(path.join(seed, "README.md"), "hello\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-m", "init");
  git(seed, "push", "origin", "HEAD:main");

  process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = "isobot test";
  process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = "test@example.com";
  const repo = new Repo(path.join(root, "home"), "o", "r", "secret-token", origin);
  await repo.sync("main");
  const dir = await repo.createWorktree("isobot/1-test", "main");
  assert.ok(existsSync(path.join(dir, "README.md")));
  assert.equal(await repo.commitPending(dir, "nothing", "main"), false);

  writeFileSync(path.join(dir, "feature.txt"), "a\nb\n");
  assert.equal(await repo.commitPending(dir, "add feature", "main"), true);
  const stat = await repo.diffStat(dir, "main");
  assert.deepEqual(stat, { files: [{ path: "feature.txt", added: 2, removed: 0 }], changedLines: 2 });
  assert.match(await repo.diff(dir, "main"), /\+a\n\+b/);

  await repo.push(dir, "isobot/1-test");
  assert.equal(git(origin, "rev-parse", "isobot/1-test"), await repo.head(dir));
  assert.ok(!git(repo.clonePath, "config", "--list").includes("secret-token"), "token never lands in git config");

  // Re-creating the worktree for a retry starts clean from the default branch.
  const again = await repo.createWorktree("isobot/1-test", "main");
  assert.ok(!existsSync(path.join(again, "feature.txt")));
  await repo.removeWorktree("isobot/1-test");
  assert.ok(!existsSync(again));

  const release = await repo.checkoutAt(git(origin, "rev-parse", "main"), "1-merge");
  assert.ok(existsSync(path.join(release, "README.md")));
  await repo.removeWorktree("release__1-merge");
  assert.ok(!existsSync(release));
});
