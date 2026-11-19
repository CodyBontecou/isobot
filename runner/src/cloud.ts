import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExecFn } from "./builder.js";
import { TransientError } from "./errors.js";
import type { DiffStat } from "./git.js";
import type { RepoOps } from "./pipeline.js";
import type { CheckReport } from "./policy.js";
import { tail, type RunOptions, type RunResult } from "./proc.js";

/**
 * Cloud builds: the heavy part of a job (clone, Claude Code, npm, site builds) runs in an isobot-sandbox
 * Container on Cloudflare (sandbox/ in this repository) instead of on this Mac. The runner keeps everything
 * that decides: it reads the builder's commits back as git bundles into its own bare clone, then diffs,
 * gates and pushes exactly as for a local build. The Container never holds the runner's credentials.
 */

export type TaskStatus =
  | { state: "running" }
  | { state: "exited"; exitCode: number; stdout: string; stderr: string }
  | { state: "lost"; stdout: string; stderr: string };

export interface TaskRequest { argv: string[]; cwd?: string; env?: Record<string, string>; stdin?: string }

/** The sandbox Worker's API (sandbox/src/index.ts). */
export interface SandboxApi {
  start(name: string, repo: string): Promise<{ running: boolean }>;
  status(name: string): Promise<{ running: boolean; repo: string | null }>;
  destroy(name: string): Promise<void>;
  startTask(name: string, task: TaskRequest): Promise<{ id: string }>;
  readTask(name: string, id: string, tailBytes?: number): Promise<TaskStatus>;
  killTask(name: string, id: string): Promise<void>;
  runningTasks(name: string): Promise<string[]>;
  readFile(name: string, file: string): Promise<Buffer | null>;
  writeFile(name: string, file: string, data: Buffer | string): Promise<void>;
}

export class HttpSandboxApi implements SandboxApi {
  constructor(private baseUrl: string, private token: string, private fetcher: typeof fetch = fetch) {
    if (!/^https:\/\//.test(baseUrl)) throw new Error("ISOBOT_SANDBOX_URL must use HTTPS");
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  private async call(method: string, route: string, body?: unknown, raw?: Buffer | string): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}${route}`, {
        method,
        headers: { authorization: `Bearer ${this.token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        body: raw !== undefined ? new Uint8Array(typeof raw === "string" ? Buffer.from(raw) : raw) : body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(5 * 60_000),
      });
    } catch (error) {
      throw new TransientError(`build sandbox unreachable: ${(error as Error).message}`);
    }
    if (response.status === 404 && method === "GET" && route.includes("/files?")) return response;
    if (!response.ok) {
      const text = (await response.text()).trim().slice(0, 500);
      // Cloudflare-side trouble (5xx, rate limits) is temporary; a 4xx is a bug or bad config.
      const error = `build sandbox ${method} ${route.split("?")[0]} failed (${response.status}): ${text}`;
      throw response.status >= 500 || response.status === 429 ? new TransientError(error) : new Error(error);
    }
    return response;
  }

  private sandbox(name: string): string { return `/sandboxes/${encodeURIComponent(name)}`; }

  async start(name: string, repo: string) { return (await this.call("POST", `${this.sandbox(name)}/start`, { repo })).json() as Promise<{ running: boolean }>; }
  async status(name: string) { return (await this.call("GET", this.sandbox(name))).json() as Promise<{ running: boolean; repo: string | null }>; }
  async destroy(name: string) { await this.call("DELETE", this.sandbox(name)); }
  async startTask(name: string, task: TaskRequest) { return (await this.call("POST", `${this.sandbox(name)}/tasks`, task)).json() as Promise<{ id: string }>; }
  async readTask(name: string, id: string, tailBytes?: number) {
    return (await this.call("GET", `${this.sandbox(name)}/tasks/${id}${tailBytes !== undefined ? `?tail=${tailBytes}` : ""}`)).json() as Promise<TaskStatus>;
  }
  async killTask(name: string, id: string) { await this.call("DELETE", `${this.sandbox(name)}/tasks/${id}`); }
  async runningTasks(name: string) { return ((await (await this.call("GET", `${this.sandbox(name)}/tasks`)).json()) as { running: string[] }).running; }
  async readFile(name: string, file: string) {
    const response = await this.call("GET", `${this.sandbox(name)}/files?path=${encodeURIComponent(file)}`);
    return response.status === 404 ? null : Buffer.from(await response.arrayBuffer());
  }
  async writeFile(name: string, file: string, data: Buffer | string) { await this.call("PUT", `${this.sandbox(name)}/files?path=${encodeURIComponent(file)}`, undefined, data); }
}

export interface RemoteRunOptions {
  cwd: string;
  env?: Record<string, string>;
  input?: string;
  timeoutMs?: number;
  /** How much of each stream to keep (RunOptions.maxBytes). */
  maxBytes?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
/** Polls that may fail in a row (network blips) before a run counts as unreachable. */
const MAX_POLL_FAILURES = 12;

/** Runs one command in a sandbox and waits for it, like proc.run. A timeout kills it (and its children). */
export async function runRemote(api: SandboxApi, name: string, argv: string[], options: RemoteRunOptions): Promise<RunResult> {
  const sleep = options.sleep ?? wait;
  const { id } = await api.startTask(name, { argv, cwd: options.cwd, env: options.env ?? {}, stdin: options.input ?? "" });
  const deadline = options.timeoutMs ? Date.now() + options.timeoutMs : Infinity;
  let failures = 0;
  for (;;) {
    await sleep(options.pollMs ?? 5_000);
    if (Date.now() > deadline) {
      await api.killTask(name, id).catch(() => undefined);
      const last = await api.readTask(name, id, options.maxBytes).catch(() => null);
      const output = last && last.state !== "running" ? last : { stdout: "", stderr: "" };
      return { code: null, stdout: output.stdout, stderr: output.stderr, timedOut: true };
    }
    let status: TaskStatus;
    try {
      status = await api.readTask(name, id, options.maxBytes);
      failures = 0;
    } catch (error) {
      if (!(error instanceof TransientError) || ++failures >= MAX_POLL_FAILURES) throw error;
      continue;
    }
    if (status.state === "running") continue;
    if (status.state === "exited") return { code: status.exitCode, stdout: status.stdout, stderr: status.stderr, timedOut: false };
    // The Container stopped under the command (a Cloudflare restart or eviction): worth another try later.
    throw new TransientError(`the build sandbox lost the command \`${argv[0]}\`: ${tail(status.stderr || status.stdout, 500) || "no output"}`);
  }
}

/** Sandbox workspaces sit at /workspace/<name>; the name in the path routes builder and check commands. */
export const WORKSPACE_ROOT = "/workspace/";

export function sandboxFor(cwd: string): string {
  if (!cwd.startsWith(WORKSPACE_ROOT)) throw new Error(`${cwd} isn't a cloud build workspace`);
  return cwd.slice(WORKSPACE_ROOT.length).split("/")[0];
}

/** A sandbox name per job branch: readable, unique per repository and branch, within Cloudflare's 63 characters. */
export function sandboxName(owner: string, repo: string, branch: string): string {
  const hash = createHash("sha256").update(`${owner}/${repo}:${branch}`.toLowerCase()).digest("hex").slice(0, 10);
  const readable = `${repo}-${branch}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50).replace(/-+$/, "");
  return `${readable || "job"}-${hash}`;
}

/**
 * Claude Code in a sandbox, for ClaudeCodeBuilder. Only `cwd`, the prompt (stdin) and the timeout cross over:
 * `options.env` is the runner's own environment, Claude token included, and the Container has its own.
 */
export function remoteExec(api: SandboxApi, sleep?: (ms: number) => Promise<void>): ExecFn {
  return (command: string, args: string[], options: RunOptions) =>
    runRemote(api, sandboxFor(options.cwd), [command, ...args], { cwd: options.cwd, input: options.input, timeoutMs: options.timeoutMs, maxBytes: options.maxBytes, sleep });
}

/** The repository's checks, run in the job's sandbox. Same report as checks.ts runChecks. */
export async function remoteChecks(api: SandboxApi, cwd: string, commands: string[], options: { timeoutMs?: number; env?: Record<string, string>; sleep?: (ms: number) => Promise<void> } = {}): Promise<CheckReport> {
  const results: CheckReport["results"] = [];
  for (const command of commands) {
    const result = await runRemote(api, sandboxFor(cwd), ["/bin/sh", "-c", command], { cwd, env: options.env, timeoutMs: options.timeoutMs ?? 45 * 60_000, sleep: options.sleep });
    const ok = result.code === 0 && !result.timedOut;
    const output = tail(`${result.stdout}\n${result.stderr}`.trim(), 6000);
    results.push({ command, ok, output: result.timedOut ? `Timed out.\n${output}` : output });
    if (!ok) break;
  }
  return { configured: commands.length > 0, passed: results.every(r => r.ok), results };
}

/** What CloudRepo needs of the runner's local clone (git.ts Repo). */
export interface LocalClone {
  readonly owner: string;
  readonly repo: string;
  /** Where the sandbox clones from: GitHub (tests use a local bare repository). */
  readonly remote: string;
  sync(defaultBranch: string): Promise<string>;
  bundle(sha: string, ref: string, defaultBranch: string): Promise<Buffer | null>;
  fetchBundle(file: string, ref: string, branch: string): Promise<string>;
  ahead(baseSha: string, sha: string): Promise<number>;
  diffStat(baseSha: string, sha: string): Promise<DiffStat>;
  diff(baseSha: string, sha: string): Promise<string>;
  push(sha: string, branch: string): Promise<void>;
  checkoutAt(sha: string, name: string): Promise<string>;
  removeWorkspace(name: string): Promise<void>;
  purge(number: number): Promise<string[]>;
  fetchBranch(branch: string): Promise<string>;
  mergeBase(a: string, b: string): Promise<string>;
  publishMedia(prefix: string, files: { file: string; name: string }[], message: string): Promise<Record<string, string>>;
}

/** Where a sandbox keeps the commit its workspace started from: what its bundles may assume the runner has. */
const baseFile = (name: string) => `/isobot/base/${name}`;
const CAPTURE_REF = "refs/isobot/capture";
const UPLOAD_REF = "refs/isobot/upload";
const BUNDLE_IN = "/isobot/in.bundle";
const BUNDLE_OUT = "/isobot/out.bundle";
/** Never run repository hooks or fsmonitor commands. */
const SAFE = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];

/**
 * A build workspace in a cloud sandbox, behind the pipeline's RepoOps. The workspace (and Claude Code's
 * session) live in the Container; commits come back to the runner's bare clone as bundles. Everything
 * the gates read (ahead, diffs) and every push happens locally, on exactly the commit that came back.
 */
export class CloudRepo implements RepoOps {
  private defaultBranch = "main";

  constructor(private local: LocalClone, private api: SandboxApi, private sleep?: (ms: number) => Promise<void>) {}

  private name(branch: string): string { return sandboxName(this.local.owner, this.local.repo, branch); }

  private async git(name: string, args: string[], cwd: string, allowFailure = false): Promise<RunResult> {
    const result = await runRemote(this.api, name, ["git", ...SAFE, ...args], { cwd, timeoutMs: 20 * 60_000, sleep: this.sleep });
    if (!allowFailure && (result.code !== 0 || result.timedOut)) {
      throw new Error(`git ${args[0]} failed in the build sandbox: ${tail((result.stderr || result.stdout).trim(), 1500)}`);
    }
    return result;
  }

  async sync(defaultBranch: string): Promise<string> {
    this.defaultBranch = defaultBranch;
    return this.local.sync(defaultBranch);
  }

  workspacePath(branch: string): string {
    return `${WORKSPACE_ROOT}${this.name(branch)}`;
  }

  /**
   * A clone at `baseSha` on `branch` in the job's sandbox. A sandbox that is still up with its workspace
   * already at that commit (a runner restart mid-build) is kept as it is, with its installed dependencies.
   */
  async createWorkspace(branch: string, baseSha: string): Promise<string> {
    const name = this.name(branch);
    const dir = this.workspacePath(branch);
    const { running } = await this.api.start(name, `${this.local.owner}/${this.local.repo}`);
    if (running) {
      const head = await this.git(name, ["rev-parse", "HEAD"], dir, true);
      if (head.code === 0 && head.stdout.trim() === baseSha) return dir;
    }
    await runRemote(this.api, name, ["rm", "-rf", dir], { cwd: "/", sleep: this.sleep });
    await this.git(name, ["clone", "--quiet", "--filter=blob:none", "--no-checkout", this.local.remote, dir], "/");
    if ((await this.git(name, ["cat-file", "-e", `${baseSha}^{commit}`], dir, true)).code !== 0) {
      // Not on GitHub (a commit the runner kept after a restart): send it over.
      await this.git(name, ["fetch", "--quiet", "origin", baseSha], dir, true);
      if ((await this.git(name, ["cat-file", "-e", `${baseSha}^{commit}`], dir, true)).code !== 0) {
        const bundle = await this.local.bundle(baseSha, UPLOAD_REF, this.defaultBranch);
        if (!bundle) throw new Error(`the build sandbox can't get ${baseSha.slice(0, 12)}`);
        await this.api.writeFile(name, BUNDLE_IN, bundle);
        await this.git(name, ["fetch", "--quiet", BUNDLE_IN, `+${UPLOAD_REF}:${UPLOAD_REF}`], dir);
      }
    }
    await this.git(name, ["checkout", "--quiet", "-B", branch, baseSha], dir);
    await this.api.writeFile(name, baseFile(name), baseSha);
    return dir;
  }

  async hasWorkspace(branch: string): Promise<boolean> {
    const name = this.name(branch);
    if (!(await this.api.status(name)).running) return false;
    return (await this.git(name, ["rev-parse", "--git-dir"], this.workspacePath(branch), true)).code === 0;
  }

  /** A runner restart leaves the sandbox's commands running; stop them before taking the work over. */
  async interrupt(branch: string): Promise<void> {
    const name = this.name(branch);
    if (!(await this.api.status(name)).running) return;
    for (const id of await this.api.runningTasks(name)) await this.api.killTask(name, id);
  }

  async removeWorkspace(name: string): Promise<void> {
    // Release checkouts stay local (release commands run on the runner).
    if (name.startsWith("release__")) return this.local.removeWorkspace(name);
    await this.api.destroy(this.name(name));
  }

  async commitPending(dir: string, message: string): Promise<void> {
    const name = sandboxFor(dir);
    const status = await this.git(name, ["status", "--porcelain"], dir);
    if (!status.stdout.trim()) return;
    await this.git(name, ["add", "-A"], dir);
    await this.git(name, ["commit", "--quiet", "--no-verify", "-m", message], dir);
  }

  /** Brings the workspace's HEAD into the runner's bare clone, as a bundle on top of the commit it started from. */
  async capture(dir: string, branch: string): Promise<string> {
    const name = sandboxFor(dir);
    const base = (await this.api.readFile(name, baseFile(name)))?.toString("utf8").trim();
    if (!base) throw new Error("the build sandbox lost track of where its workspace started");
    const head = (await this.git(name, ["rev-parse", "HEAD"], dir)).stdout.trim();
    // Nothing new (or history rewound to an ancestor): the runner already has that commit.
    if ((await this.git(name, ["merge-base", "--is-ancestor", head, base], dir, true)).code === 0) return head;
    await this.git(name, ["update-ref", CAPTURE_REF, head], dir);
    await this.git(name, ["bundle", "create", "--quiet", BUNDLE_OUT, CAPTURE_REF, "--not", base], dir);
    const bundle = await this.api.readFile(name, BUNDLE_OUT);
    if (!bundle) throw new Error("the build sandbox's bundle went missing");
    const folder = mkdtempSync(path.join(tmpdir(), "isobot-capture-"));
    try {
      const file = path.join(folder, "capture.bundle");
      writeFileSync(file, bundle);
      return await this.local.fetchBundle(file, CAPTURE_REF, branch);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  }

  ahead(baseSha: string, sha: string) { return this.local.ahead(baseSha, sha); }
  diffStat(baseSha: string, sha: string) { return this.local.diffStat(baseSha, sha); }
  diff(baseSha: string, sha: string) { return this.local.diff(baseSha, sha); }
  push(sha: string, branch: string) { return this.local.push(sha, branch); }
  checkoutAt(sha: string, name: string) { return this.local.checkoutAt(sha, name); }
  purge(number: number) { return this.local.purge(number); }
  fetchBranch(branch: string) { return this.local.fetchBranch(branch); }
  mergeBase(a: string, b: string) { return this.local.mergeBase(a, b); }
  publishMedia(prefix: string, files: { file: string; name: string }[], message: string) { return this.local.publishMedia(prefix, files, message); }
}
