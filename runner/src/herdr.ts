import { homedir } from "node:os";
import path from "node:path";
import { run } from "./proc.js";

/**
 * A thin client for the owner's local Herdr (the terminal workspace manager) through its CLI. The
 * runner runs as the owner on the same Mac, so `herdr` reaches the running Herdr server over its
 * socket like any terminal would. Every call returns JSON; errors come back as JSON on stderr.
 */
export interface HerdrWorkspace {
  workspace_id: string;
  label: string;
  focused?: boolean;
  worktree?: { checkout_path: string; is_linked_worktree: boolean; repo_name: string };
}

export interface OpenTab {
  /** The repository the tab is about, used to pick its Herdr workspace and checkout; null for none. */
  repo: string | null;
  /** Working directory when the repo has no local checkout (or there is no repo). */
  fallbackCwd: string;
  /** Use this directory instead of the repo's checkout (e.g. a job workspace still on disk). */
  cwd?: string;
  label: string;
  /** Herdr agent name: [a-z][a-z0-9_-]{0,31}, unique among live agents. */
  agentName: string;
  /** Arguments for `claude` (after `--`). */
  args: string[];
}

export interface OpenedTab {
  workspaceId: string;
  tabId: string;
  cwd: string;
}

export type HerdrExec = (args: string[]) => Promise<{ code: number | null; stdout: string; stderr: string }>;

export interface HerdrOptions {
  bin?: string;
  /** Label of the workspace for tabs that belong to no repo (or whose repo has no workspace). Default "isobot". */
  workspace?: string;
  exec?: HerdrExec;
  exists?: (dir: string) => boolean;
  /** Wait between checks for a new pane's shell. Default 500 ms (tests use 0). */
  retryMs?: number;
}

export class Herdr {
  private exec: HerdrExec;

  constructor(private o: HerdrOptions = {}) {
    const bin = o.bin ?? "herdr";
    this.exec = o.exec ?? (args => run(bin, args, { cwd: homedir(), timeoutMs: 90_000 }));
  }

  async workspaces(): Promise<HerdrWorkspace[]> {
    return (await this.call<{ workspaces: HerdrWorkspace[] }>(["workspace", "list"])).workspaces;
  }

  /** Opens a focused tab in the repo's workspace (or the fallback one) and starts Claude Code in it. */
  async open(tab: OpenTab): Promise<OpenedTab> {
    const workspaces = await this.workspaces();
    const home = tab.repo ? repoWorkspace(workspaces, tab.repo) : null;
    const exists = this.o.exists ?? (() => true);
    // The checkout Herdr knows, else <fallback>/<repo> (~/dev/health-md), else the fallback itself.
    const nearby = tab.repo ? [tab.repo, tab.repo.toLowerCase()].map(r => path.join(tab.fallbackCwd, r)).find(exists) : undefined;
    const cwd = tab.cwd ?? (tab.repo && checkoutFor(workspaces, tab.repo, exists)) ?? nearby ?? tab.fallbackCwd;
    const target = home ?? workspaces.find(w => same(w.label, this.o.workspace ?? "isobot"));
    let workspaceId: string;
    let tabId: string;
    let paneId: string;
    if (target) {
      const created = await this.call<{ tab: { tab_id: string }; root_pane: { pane_id: string } }>(
        ["tab", "create", "--workspace", target.workspace_id, "--cwd", cwd, "--label", tab.label, "--focus"]);
      workspaceId = target.workspace_id;
      tabId = created.tab.tab_id;
      paneId = created.root_pane.pane_id;
    } else {
      const created = await this.call<{ workspace: { workspace_id: string }; tab: { tab_id: string }; root_pane: { pane_id: string } }>(
        ["workspace", "create", "--cwd", cwd, "--label", this.o.workspace ?? "isobot", "--focus"]);
      workspaceId = created.workspace.workspace_id;
      tabId = created.tab.tab_id;
      paneId = created.root_pane.pane_id;
      await this.call(["tab", "rename", tabId, tab.label]).catch(() => undefined);
    }
    try {
      // A new pane's shell needs a moment (profile, prompt) before Herdr counts it as available.
      for (let attempt = 1; ; attempt++) {
        try {
          await this.call(["agent", "start", tab.agentName, "--kind", "claude", "--pane", paneId, "--timeout", "60000", "--", ...tab.args]);
          break;
        } catch (error) {
          if (attempt >= 30 || !/not an available shell/i.test((error as Error).message)) throw error;
          await new Promise(resolve => setTimeout(resolve, this.o.retryMs ?? 500));
        }
      }
    } catch (error) {
      // Leave no empty tab behind; the caller reports the failure.
      await this.call(["tab", "close", tabId]).catch(() => undefined);
      throw error;
    }
    // Creating the tab focuses it inside its workspace; this brings the workspace forward too.
    await this.call(["tab", "focus", tabId]).catch(() => undefined);
    return { workspaceId, tabId, cwd };
  }

  private async call<T = unknown>(args: string[]): Promise<T> {
    const result = await this.exec(args);
    if (result.code !== 0) {
      let detail = (result.stderr || result.stdout).trim();
      try { detail = (JSON.parse(detail) as { error?: { message?: string } }).error?.message ?? detail; } catch { /* plain text */ }
      throw new Error(`herdr ${args.slice(0, 2).join(" ")} failed: ${detail.slice(0, 300) || `exit ${result.code}`}`);
    }
    return (JSON.parse(result.stdout) as { result: T }).result;
  }
}

/** Compares names loosely: "GitSync.md", "gitsync-md" and "gitsyncmd" are the same. */
function same(a: string | undefined, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  return Boolean(a) && norm(a!) === norm(b);
}

/** The workspace for a repo: its main checkout's workspace first, then one with the repo's name. */
export function repoWorkspace(workspaces: HerdrWorkspace[], repo: string): HerdrWorkspace | null {
  return workspaces.find(w => w.worktree && !w.worktree.is_linked_worktree && same(w.worktree.repo_name, repo))
    ?? workspaces.find(w => same(w.label, repo))
    ?? null;
}

/** The repo's main local checkout, as Herdr knows it. */
export function checkoutFor(workspaces: HerdrWorkspace[], repo: string, exists: (dir: string) => boolean = () => true): string | null {
  const w = workspaces.find(w => w.worktree && !w.worktree.is_linked_worktree && same(w.worktree.repo_name, repo));
  return w && exists(w.worktree!.checkout_path) ? w.worktree!.checkout_path : null;
}

/** A Herdr agent name from free text: lowercase, [a-z0-9-], at most 32 characters, unique by a time suffix. */
export function agentName(base: string, now = Date.now()): string {
  const suffix = now.toString(36).slice(-4);
  const slug = `iso-${base}`.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/-$/, "");
  return `${slug.slice(0, 31 - suffix.length - 1).replace(/-$/, "")}-${suffix}`;
}
