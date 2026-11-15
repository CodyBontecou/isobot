import { spawn } from "node:child_process";

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface RunOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs?: number;
  /** Keep only the last N bytes of each stream (long builds produce megabytes of logs). */
  maxBytes?: number;
}

const children = new Set<number>();

/** Kills every running child process group (used on shutdown so builds don't outlive the runner). */
export function killAllChildren(signal: NodeJS.Signals = "SIGTERM"): void {
  for (const pid of children) {
    try { process.kill(-pid, signal); } catch { /* already exited */ }
  }
}

export function runningChildren(): number {
  return children.size;
}

/** Runs a program without a shell. Never rejects on a non-zero exit; callers inspect `code`. */
export function run(command: string, args: string[], options: RunOptions): Promise<RunResult> {
  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    if (child.pid) children.add(child.pid);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const keep = (current: string, chunk: Buffer) => {
      const next = current + chunk.toString("utf8");
      return next.length > maxBytes ? next.slice(next.length - maxBytes) : next;
    };
    child.stdout.on("data", chunk => { stdout = keep(stdout, chunk); });
    child.stderr.on("data", chunk => { stderr = keep(stderr, chunk); });
    const timer = options.timeoutMs ? setTimeout(() => {
      timedOut = true;
      // Kill the whole process group: build tools spawn grandchildren.
      try { process.kill(-child.pid!, "SIGTERM"); } catch { child.kill("SIGTERM"); }
      setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already gone */ } }, 10_000).unref();
    }, options.timeoutMs) : undefined;
    child.on("error", error => { clearTimeout(timer); if (child.pid) children.delete(child.pid); reject(error); });
    child.on("close", code => { clearTimeout(timer); if (child.pid) children.delete(child.pid); resolve({ code, stdout, stderr, timedOut }); });
    child.stdin.on("error", () => { /* the child may exit before reading its input */ });
    child.stdin.end(options.input ?? "");
  });
}

/** Runs a shell command line, e.g. a configured check such as `make test`. */
export function sh(commandLine: string, options: RunOptions): Promise<RunResult> {
  return run("/bin/sh", ["-c", commandLine], options);
}

const PASSTHROUGH = [
  "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TMPDIR", "TERM",
  "DEVELOPER_DIR", "JAVA_HOME", "ANDROID_HOME", "ANDROID_SDK_ROOT",
];

/**
 * Environment for builders and checks: enough to run toolchains, none of the
 * runner's credentials. ANTHROPIC_API_KEY is dropped so Claude Code always uses
 * the subscription login (it outranks the OAuth token in print mode).
 */
export function workerEnv(extra: Record<string, string | undefined> = {}, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of PASSTHROUGH) if (base[key]) env[key] = base[key];
  env.PATH = base.PATH ?? "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin";
  env.CI = "1";
  env.GIT_TERMINAL_PROMPT = "0";
  for (const [key, value] of Object.entries(extra)) if (value !== undefined) env[key] = value;
  return env;
}

export function tail(text: string, bytes = 6000): string {
  return text.length > bytes ? `…${text.slice(text.length - bytes)}` : text;
}
