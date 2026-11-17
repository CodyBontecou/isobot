import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { removeDerivedData } from "./cleanup.js";
import { skipMarkers } from "./policy.js";
import { run, workerEnv, type RunResult } from "./proc.js";

export interface DiffStat {
  files: { path: string; added: number; removed: number; binary: boolean }[];
  changedLines: number;
  /** Test-disabling markers the change adds on net (see policy.ts skipMarkers). */
  skipMarkers?: { path: string; marker: string }[];
}

/** Binary changes can't be counted in lines; weigh them heavily so they can't slip under size limits. */
export const BINARY_FILE_WEIGHT = 100;

/** Where isobot keeps screenshots and recordings for PR bodies (see publishMedia). */
export const MEDIA_BRANCH = "isobot/media";

/** Never run repository hooks or fsmonitor commands from runner-side git calls. */
const SAFE = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];

/**
 * Git for one repository, split so the GitHub token never meets builder-controlled files:
 * - a bare clone that only the runner touches: fetches, diffs, gate inputs and pushes happen here;
 * - a throwaway clone per job (objects shared read-only) where the builder works.
 * The runner copies the job's commit into the bare clone, then judges and pushes that exact commit.
 */
export class Repo {
  readonly barePath: string;
  private static locks = new Map<string, Promise<unknown>>();

  constructor(
    private home: string,
    readonly owner: string,
    readonly repo: string,
    private token: string,
    /** Overridable for tests (a local bare repository). */
    readonly remote = `https://github.com/${owner}/${repo}.git`,
    private workRoot = path.join(home, "work"),
  ) {
    this.barePath = path.join(home, "repos", owner, `${repo}.git`);
  }

  private authArgs(): string[] {
    const basic = Buffer.from(`x-access-token:${this.token}`).toString("base64");
    return ["-c", `http.https://github.com/.extraheader=AUTHORIZATION: basic ${basic}`];
  }

  private async git(args: string[], cwd: string, auth = false, input?: string): Promise<RunResult> {
    const result = await run("git", [...SAFE, ...(auth ? this.authArgs() : []), ...args], {
      cwd, env: workerEnv({ GIT_CONFIG_NOSYSTEM: "1" }), timeoutMs: 15 * 60_000, input,
    });
    if (result.code !== 0) {
      const message = (result.stderr || result.stdout).replaceAll(this.token, "***").trim();
      throw new Error(`git ${args[0]} failed: ${message.slice(-1500)}`);
    }
    return result;
  }

  /** Serialises operations on the shared bare clone (fetch, clone-from, push) across concurrent jobs. */
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const key = this.barePath;
    const previous = Repo.locks.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    Repo.locks.set(key, next.catch(() => undefined));
    return next;
  }

  /** Fetches the default branch and returns its commit. */
  sync(defaultBranch: string): Promise<string> {
    return this.exclusive(async () => {
      if (!existsSync(path.join(this.barePath, "HEAD"))) {
        mkdirSync(path.dirname(this.barePath), { recursive: true });
        await this.git(["clone", "--bare", "--quiet", this.remote, this.barePath], path.dirname(this.barePath), true);
      }
      await this.git(["fetch", "--quiet", "--no-tags", "origin", `+refs/heads/${defaultBranch}:refs/heads/${defaultBranch}`], this.barePath, true);
      return (await this.git(["rev-parse", `refs/heads/${defaultBranch}^{commit}`], this.barePath)).stdout.trim();
    });
  }

  /** Fetches a pushed branch (an open PR's head) into the runner's clone and returns its commit. */
  fetchBranch(branch: string): Promise<string> {
    return this.exclusive(async () => {
      const ref = `refs/isobot/${branch}`;
      await this.git(["fetch", "--quiet", "--no-tags", "--force", "origin", `+refs/heads/${branch}:${ref}`], this.barePath, true);
      return (await this.git(["rev-parse", `${ref}^{commit}`], this.barePath)).stdout.trim();
    });
  }

  /** Fetches a pull request's head (any author's, including forks) and returns its commit. */
  fetchPull(number: number): Promise<string> {
    return this.exclusive(async () => {
      const ref = `refs/isobot/pull/${number}`;
      await this.git(["fetch", "--quiet", "--no-tags", "--force", "origin", `+refs/pull/${number}/head:${ref}`], this.barePath, true);
      return (await this.git(["rev-parse", `${ref}^{commit}`], this.barePath)).stdout.trim();
    });
  }

  async mergeBase(a: string, b: string): Promise<string> {
    return (await this.git(["merge-base", a, b], this.barePath)).stdout.trim();
  }

  workspacePath(name: string): string {
    return path.join(this.workRoot, this.owner, this.repo, name.replaceAll("/", "__"));
  }

  /** A fresh clone at `baseSha` on a new local branch. Builders get this directory and nothing else. */
  createWorkspace(branch: string, baseSha: string): Promise<string> {
    return this.exclusive(async () => {
      const dir = this.workspacePath(branch);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(path.dirname(dir), { recursive: true });
      await this.git(["clone", "--quiet", "--shared", "--no-checkout", this.barePath, dir], path.dirname(dir));
      await this.git(["checkout", "--quiet", "-B", branch, baseSha], dir);
      return dir;
    });
  }

  async removeWorkspace(name: string): Promise<void> {
    const dir = this.workspacePath(name);
    rmSync(dir, { recursive: true, force: true });
    // Xcode keyed its DerivedData to this path; nothing will build here again.
    removeDerivedData(dir);
  }

  /**
   * Removes what this repository's clone still holds for one issue: leftover build and release
   * workspaces (with their DerivedData) and the job's branch refs. Returns what went, for the issue comment.
   */
  purge(number: number): Promise<string[]> {
    return this.exclusive(async () => {
      const removed: string[] = [];
      const root = path.join(this.workRoot, this.owner, this.repo);
      for (const entry of existsSync(root) ? readdirSync(root) : []) {
        if (!entry.startsWith(`isobot__${number}-`) && !entry.startsWith(`release__${number}-`)) continue;
        const dir = path.join(root, entry);
        rmSync(dir, { recursive: true, force: true });
        removeDerivedData(dir);
        removed.push(`workspace ${entry.replace(/^isobot__/, "isobot/")}`);
      }
      if (existsSync(path.join(this.barePath, "HEAD"))) {
        const refs = (await this.git(["for-each-ref", "--format=%(refname)", "refs/isobot/isobot/"], this.barePath)).stdout
          .split("\n").filter(ref => ref.startsWith(`refs/isobot/isobot/${number}-`));
        for (const ref of refs) {
          await this.git(["update-ref", "-d", ref], this.barePath);
          removed.push(`ref ${ref.slice("refs/isobot/".length)}`);
        }
      }
      return removed;
    });
  }

  /** Commits anything left uncommitted in a workspace (no hooks run). */
  async commitPending(dir: string, message: string): Promise<void> {
    const status = await this.git(["status", "--porcelain"], dir);
    if (!status.stdout.trim()) return;
    await this.git(["add", "-A"], dir);
    await this.git(["commit", "--quiet", "--no-verify", "-m", message], dir);
  }

  /** Copies the workspace's HEAD into the runner's bare clone and returns that commit. */
  capture(dir: string, branch: string): Promise<string> {
    return this.exclusive(async () => {
      const ref = `refs/isobot/${branch}`;
      await this.git(["fetch", "--quiet", "--no-tags", "--force", dir, `+HEAD:${ref}`], this.barePath);
      return (await this.git(["rev-parse", `${ref}^{commit}`], this.barePath)).stdout.trim();
    });
  }

  /** Diff stats between two commits, computed in the runner's clone. Renames are split so paths are real. */
  async diffStat(baseSha: string, sha: string): Promise<DiffStat> {
    const result = await this.git(["diff", "--numstat", "--no-renames", "-z", baseSha, sha], this.barePath);
    const files = result.stdout.split("\0").filter(Boolean).map(record => {
      const [added, removed, ...rest] = record.split("\t");
      const binary = added === "-";
      return { path: rest.join("\t"), added: binary ? 0 : Number(added), removed: binary ? 0 : Number(removed), binary };
    });
    // Unbounded on purpose: a skip hidden past a truncation point must still block the merge.
    const patch = await run("git", [...SAFE, "diff", "--no-renames", "--unified=0", "--no-color", baseSha, sha], { cwd: this.barePath, env: workerEnv(), maxBytes: 64 * 1024 * 1024 });
    return {
      files,
      changedLines: files.reduce((sum, f) => sum + (f.binary ? BINARY_FILE_WEIGHT : f.added + f.removed), 0),
      skipMarkers: skipMarkers(patch.stdout),
    };
  }

  async diff(baseSha: string, sha: string, maxBytes = 150_000): Promise<string> {
    const result = await run("git", [...SAFE, "diff", "--no-renames", baseSha, sha], { cwd: this.barePath, env: workerEnv(), maxBytes: maxBytes * 2 });
    const text = result.stdout;
    return text.length > maxBytes ? `${text.slice(0, maxBytes)}\n… diff truncated (${text.length} bytes) …` : text;
  }

  /** Commits between base and sha (0 means the builder changed nothing). */
  async ahead(baseSha: string, sha: string): Promise<number> {
    return Number((await this.git(["rev-list", "--count", `${baseSha}..${sha}`], this.barePath)).stdout.trim());
  }

  /** Pushes exactly `sha` to `branch` on GitHub. isobot owns isobot/* branches, so it may overwrite them. */
  push(sha: string, branch: string): Promise<void> {
    return this.exclusive(async () => {
      await this.git(["push", "--quiet", "--force", "origin", `${sha}:refs/heads/${branch}`], this.barePath, true);
    });
  }

  /**
   * Publishes screenshots/recordings on the `isobot/media` branch and returns a URL per name, pinned
   * to the new commit. Each commit holds only its own files under `prefix/` and keeps the previous
   * tip as parent, so older links keep working. The branch has no workflows, so pushing runs nothing.
   */
  publishMedia(prefix: string, files: { file: string; name: string }[], message: string): Promise<Record<string, string>> {
    return this.exclusive(async () => {
      if (files.length === 0) return {};
      const ref = "refs/isobot/media-remote";
      let parent: string | null = null;
      try {
        await this.git(["fetch", "--quiet", "--no-tags", "--force", "origin", `+refs/heads/${MEDIA_BRANCH}:${ref}`], this.barePath, true);
        parent = (await this.git(["rev-parse", `${ref}^{commit}`], this.barePath)).stdout.trim();
      } catch (error) {
        if (!/couldn't find remote ref/i.test((error as Error).message)) throw error;
      }
      const entries: string[] = [];
      for (const f of files) {
        const blob = (await this.git(["hash-object", "-w", "--", f.file], this.barePath)).stdout.trim();
        entries.push(`100644 blob ${blob}\t${f.name}`);
      }
      let tree = (await this.git(["mktree"], this.barePath, false, `${entries.join("\n")}\n`)).stdout.trim();
      for (const segment of prefix.split("/").filter(Boolean).reverse()) {
        tree = (await this.git(["mktree"], this.barePath, false, `040000 tree ${tree}\t${segment}\n`)).stdout.trim();
      }
      const commit = (await this.git(["-c", "user.name=isobot", "-c", "user.email=isobot@users.noreply.github.com",
        "commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", message], this.barePath)).stdout.trim();
      await this.git(["push", "--quiet", "origin", `${commit}:refs/heads/${MEDIA_BRANCH}`], this.barePath, true);
      return Object.fromEntries(files.map(f => [f.name, `https://github.com/${this.owner}/${this.repo}/blob/${commit}/${prefix}/${f.name}?raw=true`]));
    });
  }

  /** Tags a released commit on GitHub (never moves an existing tag). */
  pushTag(sha: string, tag: string): Promise<void> {
    return this.exclusive(async () => {
      await this.git(["push", "--quiet", "origin", `${sha}:refs/tags/${tag}`], this.barePath, true);
    });
  }

  /** A clean checkout of a commit, for release commands. */
  checkoutAt(sha: string, name: string): Promise<string> {
    return this.exclusive(async () => {
      const dir = this.workspacePath(name);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(path.dirname(dir), { recursive: true });
      await this.git(["clone", "--quiet", "--shared", "--no-checkout", this.barePath, dir], path.dirname(dir));
      await this.git(["checkout", "--quiet", "--detach", sha], dir);
      return dir;
    });
  }
}
