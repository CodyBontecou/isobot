import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { run } from "./proc.js";

/**
 * isobot keeping itself current. The runner runs from a checkout of the isobot repository (the live checkout,
 * ~/dev/isobot). When that repository's main branch moves (an isobot PR the owner merged from chat or the board,
 * or anyone else's merge), this fast-forwards the live checkout, rebuilds the runner, deploys the Workers whose
 * code changed, and asks the loop to restart once nothing is running. launchd starts the new build.
 *
 * It never touches a checkout that isn't clean and on the branch, and never rewrites history: anything but a
 * fast-forward is reported and left alone. A failed build leaves the old runner running.
 */
export interface SelfUpdateConfig {
  enabled?: boolean;
  /** Default "main". */
  branch?: string;
  /** How often to fetch. Default 5. */
  everyMinutes?: number;
  /**
   * Folder → command run in the live checkout when files under that folder changed, e.g.
   * {"board": "npm --prefix board run deploy"}. The runner itself (runner/) always rebuilds.
   */
  deploy?: Record<string, string>;
  /** Restart even with children still running (triage, chat turns) after this long. Default 30. Builds are always waited for. */
  maxWaitMinutes?: number;
}

export interface ExecResult { ok: boolean; output: string }
export type Exec = (command: string, args: string[], options: { cwd: string; timeoutMs: number }) => Promise<ExecResult>;

export interface SelfUpdateOptions {
  /** The live checkout's root (the folder holding runner/). */
  root: string;
  config: SelfUpdateConfig;
  notify: (text: string) => Promise<unknown>;
  exec?: Exec;
  now?: () => number;
}

export interface PendingRestart {
  sha: string;
  since: number;
  summary: string;
}

const BUILT_FILE = path.join("runner", "dist", ".built-sha");
const SH_TIMEOUT = 20 * 60_000;
const GIT_TIMEOUT = 2 * 60_000;

export const defaultExec: Exec = async (command, args, { cwd, timeoutMs }) => {
  // The owner's own environment, unlike builders: git needs its credentials and wrangler its login.
  const result = await run(command, args, { cwd, timeoutMs, maxBytes: 64 * 1024 });
  const output = `${result.stdout}\n${result.stderr}`.trim();
  return { ok: result.code === 0 && !result.timedOut, output: result.timedOut ? `timed out\n${output}` : output };
};

export class SelfUpdate {
  pending: PendingRestart | null = null;
  private lastFetch = -Infinity;
  private running = false;
  /** A target that failed, so it isn't retried every few minutes; the next merge tries again. */
  private failedSha: string | null = null;
  private warned: string | null = null;
  private exec: Exec;
  private now: () => number;

  constructor(private o: SelfUpdateOptions) {
    this.exec = o.exec ?? defaultExec;
    this.now = o.now ?? Date.now;
  }

  enabled(): boolean {
    return this.o.config.enabled !== false;
  }

  /** Fetches when due and applies a new main. Never throws; problems go to notify. */
  async tick(): Promise<void> {
    if (!this.enabled() || this.running || this.pending) return;
    if (this.now() - this.lastFetch < (this.o.config.everyMinutes ?? 5) * 60_000) return;
    this.lastFetch = this.now();
    this.running = true;
    try {
      await this.update();
    } catch (error) {
      await this.warn(`⚠️ isobot couldn't update itself: ${(error as Error).message.slice(0, 400)}`);
    } finally {
      this.running = false;
    }
  }

  /**
   * True once the update is built and it's safe to restart: no build running (they'd be interrupted), and no other
   * child process (a chat turn, triage) unless the wait has gone on longer than maxWaitMinutes.
   */
  readyToRestart(activeJobs: number, children: number): boolean {
    if (!this.pending || activeJobs > 0) return false;
    return children === 0 || this.now() - this.pending.since > (this.o.config.maxWaitMinutes ?? 30) * 60_000;
  }

  private async update(): Promise<void> {
    const branch = this.o.config.branch ?? "main";
    const head = await this.git(["rev-parse", "--abbrev-ref", "HEAD"]);
    if (head !== branch) return this.warn(`⚠️ isobot can't update itself: the live checkout is on \`${head}\`, not \`${branch}\`.`);
    if (await this.git(["status", "--porcelain", "--untracked-files=no"])) {
      return this.warn(`⚠️ isobot can't update itself: the live checkout (${this.o.root}) has uncommitted changes.`);
    }
    await this.git(["fetch", "--quiet", "origin", branch]);
    const before = await this.git(["rev-parse", "HEAD"]);
    const target = await this.git(["rev-parse", `origin/${branch}`]);
    const built = this.builtSha() ?? before;
    if (target === before && built === before) return;
    if (target === this.failedSha) return;
    if (target !== before) {
      const ff = await this.exec("git", ["merge-base", "--is-ancestor", "HEAD", `origin/${branch}`], { cwd: this.o.root, timeoutMs: GIT_TIMEOUT });
      if (!ff.ok) return this.warn(`⚠️ isobot can't update itself: the live checkout has commits that aren't on origin/${branch}.`);
      await this.git(["merge", "--ff-only", "--quiet", `origin/${branch}`]);
    }
    this.warned = null;

    const pulled = target === before ? [] : await this.changed(before, target);
    const runnerChanged = built !== target && (await this.changed(built, target).catch(() => ["runner/"])).some(f => f.startsWith("runner/"));
    const titles = target === before ? [] : (await this.git(["log", "--format=%s", "--no-merges", `${before}..${target}`])).split("\n").filter(Boolean);
    const short = target.slice(0, 10);
    const lines: string[] = [];
    let ok = true;

    // Dependencies first: npm ci where a lockfile changed (the root's serves tests, the others their own folder).
    for (const lock of pulled.filter(f => /(^|\/)package-lock\.json$/.test(f))) {
      const dir = path.dirname(lock);
      if (!existsSync(path.join(this.o.root, dir, "package.json"))) continue;
      const step = await this.sh(`npm ci --prefix ${shellQuote(dir)} --no-audit --no-fund`);
      lines.push(`${step.ok ? "✅" : "❌"} npm ci in ${dir}`);
      if (!step.ok) { ok = false; lines.push(clip(step.output)); }
    }
    if (ok && runnerChanged) {
      const step = await this.sh("npm --prefix runner run build");
      lines.push(`${step.ok ? "✅" : "❌"} runner build`);
      if (step.ok) writeFileSync(path.join(this.o.root, BUILT_FILE), target);
      else { ok = false; lines.push(clip(step.output)); }
    }
    if (ok) {
      for (const [folder, command] of Object.entries(this.o.config.deploy ?? {})) {
        if (!pulled.some(f => f.startsWith(`${folder.replace(/\/$/, "")}/`))) continue;
        const step = await this.sh(command);
        lines.push(`${step.ok ? "✅" : "❌"} ${folder}: \`${command}\``);
        if (!step.ok) { ok = false; lines.push(clip(step.output)); }
      }
    }

    const what = titles.length ? `\n${titles.slice(0, 8).map(t => `• ${t}`).join("\n")}${titles.length > 8 ? `\n• … ${titles.length - 8} more` : ""}` : "";
    if (!ok) {
      this.failedSha = target;
      await this.o.notify(`❌ isobot pulled ${short} but couldn't finish updating itself; the runner keeps running its previous build.${what}\n${lines.join("\n")}`);
      return;
    }
    this.failedSha = null;
    if (runnerChanged) {
      const summary = `${short}${what}`;
      this.pending = { sha: target, since: this.now(), summary };
      await this.o.notify(`🔄 isobot updated itself to ${summary}\n${lines.join("\n")}\nIt restarts into the new build once no build is running; new builds wait until then.`);
    } else if (lines.length) {
      await this.o.notify(`🔄 isobot deployed ${short}${what}\n${lines.join("\n")}`);
    }
  }

  private builtSha(): string | null {
    try {
      return readFileSync(path.join(this.o.root, BUILT_FILE), "utf8").trim() || null;
    } catch {
      return null;
    }
  }

  private async changed(from: string, to: string): Promise<string[]> {
    return (await this.git(["diff", "--name-only", from, to])).split("\n").filter(Boolean);
  }

  private async git(args: string[]): Promise<string> {
    const result = await this.exec("git", args, { cwd: this.o.root, timeoutMs: GIT_TIMEOUT });
    if (!result.ok) throw new Error(`git ${args[0]} failed: ${result.output.slice(0, 300)}`);
    return result.output.trim();
  }

  private sh(command: string): Promise<ExecResult> {
    return this.exec("/bin/sh", ["-c", command], { cwd: this.o.root, timeoutMs: SH_TIMEOUT });
  }

  /** The same problem is reported once, not every few minutes. */
  private async warn(text: string): Promise<void> {
    if (this.warned === text) return;
    this.warned = text;
    console.warn(`[self-update] ${text}`);
    await this.o.notify(text);
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function clip(output: string): string {
  const text = output.length > 600 ? `…${output.slice(-600)}` : output;
  return "```\n" + text.replace(/```/g, "ˋˋˋ") + "\n```";
}
