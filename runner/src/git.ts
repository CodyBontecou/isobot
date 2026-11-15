import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { run, workerEnv, type RunResult } from "./proc.js";

export interface DiffStat {
  files: { path: string; added: number; removed: number }[];
  changedLines: number;
}

/**
 * Git operations for one repository. A shared clone per repo holds objects;
 * each job gets its own worktree and branch. The GitHub token is sent per
 * command as an HTTP header and is never written to .git/config or exposed to builders.
 */
export class Repo {
  readonly clonePath: string;

  constructor(
    private home: string,
    readonly owner: string,
    readonly repo: string,
    private token: string,
    /** Overridable for tests (a local bare repository). */
    readonly remote = `https://github.com/${owner}/${repo}.git`,
  ) {
    this.clonePath = path.join(home, "repos", owner, repo);
  }

  private authArgs(): string[] {
    const basic = Buffer.from(`x-access-token:${this.token}`).toString("base64");
    return ["-c", `http.https://github.com/.extraheader=AUTHORIZATION: basic ${basic}`];
  }

  private async git(args: string[], cwd: string, auth = false): Promise<RunResult> {
    const result = await run("git", [...(auth ? this.authArgs() : []), ...args], {
      cwd, env: workerEnv(), timeoutMs: 10 * 60_000,
    });
    if (result.code !== 0) {
      const message = (result.stderr || result.stdout).replaceAll(this.token, "***").trim();
      throw new Error(`git ${args[0]} failed: ${message.slice(-1500)}`);
    }
    return result;
  }

  async sync(defaultBranch: string): Promise<void> {
    if (!existsSync(path.join(this.clonePath, ".git"))) {
      mkdirSync(path.dirname(this.clonePath), { recursive: true });
      await this.git(["clone", "--no-checkout", this.remote, this.clonePath], path.dirname(this.clonePath), true);
    }
    await this.git(["fetch", "--prune", "origin", `+refs/heads/${defaultBranch}:refs/remotes/origin/${defaultBranch}`], this.clonePath, true);
  }

  worktreePath(branch: string): string {
    return path.join(this.home, "worktrees", this.owner, this.repo, branch.replaceAll("/", "__"));
  }

  /** Creates (or recreates) a clean worktree for `branch` from the default branch. */
  async createWorktree(branch: string, defaultBranch: string): Promise<string> {
    const dir = this.worktreePath(branch);
    await this.removeWorktree(branch);
    mkdirSync(path.dirname(dir), { recursive: true });
    await this.git(["worktree", "add", "--force", "-B", branch, dir, `origin/${defaultBranch}`], this.clonePath);
    return dir;
  }

  async removeWorktree(branch: string): Promise<void> {
    const dir = this.worktreePath(branch);
    if (existsSync(dir)) {
      await this.git(["worktree", "remove", "--force", dir], this.clonePath).catch(() => rmSync(dir, { recursive: true, force: true }));
    }
    await this.git(["worktree", "prune"], this.clonePath).catch(() => undefined);
  }

  /** Commits anything the builder left uncommitted. Returns true if the branch differs from base. */
  async commitPending(dir: string, message: string, defaultBranch: string): Promise<boolean> {
    const status = await this.git(["status", "--porcelain"], dir);
    if (status.stdout.trim()) {
      await this.git(["add", "-A"], dir);
      await this.git(["commit", "--no-verify", "-m", message], dir);
    }
    const ahead = await this.git(["rev-list", "--count", `origin/${defaultBranch}..HEAD`], dir);
    return Number(ahead.stdout.trim()) > 0;
  }

  async diffStat(dir: string, defaultBranch: string): Promise<DiffStat> {
    const result = await this.git(["diff", "--numstat", `origin/${defaultBranch}...HEAD`], dir);
    const files = result.stdout.trim().split("\n").filter(Boolean).map(line => {
      const [added, removed, ...rest] = line.split("\t");
      // Binary files report "-"; count them as one changed line each.
      return { path: rest.join("\t"), added: added === "-" ? 1 : Number(added), removed: removed === "-" ? 0 : Number(removed) };
    });
    return { files, changedLines: files.reduce((sum, f) => sum + f.added + f.removed, 0) };
  }

  async diff(dir: string, defaultBranch: string, maxBytes = 150_000): Promise<string> {
    const result = await run("git", ["diff", `origin/${defaultBranch}...HEAD`], { cwd: dir, env: workerEnv(), maxBytes: maxBytes * 2 });
    const text = result.stdout;
    return text.length > maxBytes ? `${text.slice(0, maxBytes)}\n… diff truncated (${text.length} bytes) …` : text;
  }

  async head(dir: string): Promise<string> {
    return (await this.git(["rev-parse", "HEAD"], dir)).stdout.trim();
  }

  async push(dir: string, branch: string): Promise<void> {
    await this.git(["push", "--force-with-lease", "origin", `HEAD:refs/heads/${branch}`], dir, true);
  }

  /** A clean checkout of the default branch at a commit, for release commands. */
  async checkoutAt(sha: string, label: string): Promise<string> {
    const dir = path.join(this.home, "worktrees", this.owner, this.repo, `release__${label}`);
    if (existsSync(dir)) await this.git(["worktree", "remove", "--force", dir], this.clonePath).catch(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(path.dirname(dir), { recursive: true });
    await this.git(["worktree", "add", "--force", "--detach", dir, sha], this.clonePath);
    return dir;
  }
}
