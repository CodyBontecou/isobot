import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Autonomy ladder for one repository. Policy lives in the isobot repo, never in
 * the target repo, so a builder can't grant itself more autonomy by editing files.
 * - off: never build
 * - pr: build, review and open a PR; a human merges
 * - merge: also merge automatically when every gate passes
 * Release commands are separate: onMerge runs after any merge of an isobot PR
 * when configured, and onShip waits for the owner's ship label.
 */
export type Autonomy = "off" | "pr" | "merge";

export interface RepoPolicy {
  autonomy: Autonomy;
  /** Commands the runner executes itself to verify a change; required for merge/release. */
  checks: string[];
  /** Changes to these globs always need a human. */
  protectedPaths: string[];
  maxChangedLines: number;
  minReviewConfidence: number;
  /** Wait for GitHub CI on the PR before an automatic merge. */
  requireCi: boolean;
  release: {
    /** Run on the merge commit after an isobot PR merges (e.g. deploy a Worker, upload to TestFlight). */
    onMerge: string[];
    /** Run only after the owner adds the ship label (e.g. App Store submission). */
    onShip: string[];
  };
  /** Extra guidance appended to the builder prompt for this repo. */
  notes?: string;
}

export interface RunnerConfig {
  pollSeconds: number;
  triageMinutes: number;
  maxConcurrentJobs: number;
  /** How many inbound items one triage pass may turn into proposals. */
  maxProposalsPerTriage: number;
  builder: {
    kind: "claude";
    model?: string;
    timeoutMinutes: number;
    maxTurns?: number;
    maxFixRounds: number;
    maxReviewRounds: number;
    /** Claude Code settings JSON passed with --settings (sandbox and deny rules). */
    settings: Record<string, unknown>;
  };
  labels: Labels;
  /** GitHub logins (besides the token's owner) whose issues may merge without a human. */
  trustedAuthors?: string[];
  /** Discord category name → owner/repo, for triage of community messages. */
  discordCategories: Record<string, string>;
  /** The owner's Vox.md captures, posted by a Vox HTTP preset to one Pi conversation. */
  vox?: VoxConfig;
  defaults: RepoPolicy;
  repos: Record<string, Partial<RepoPolicy>>;
}

export interface VoxConfig {
  /** Pi conversation the Vox preset posts to (`/api/vox?mode=memory&conversation=<this>`). */
  conversation: string;
  /** File confident proposals from these notes straight as ready, so builds start without a click. */
  autoApprove: boolean;
  /** Below this triage confidence a Vox proposal still waits for approval. Default 0.7. */
  minAutoApproveConfidence?: number;
  /** Most proposals one rambling note may produce. Default 3. */
  maxProposalsPerNote?: number;
  /** How the owner's product names come out of speech-to-text, for the triage model. */
  hints?: string;
}

export interface Labels {
  proposed: string;
  ready: string;
  building: string;
  review: string;
  failed: string;
  ship: string;
  stop: string;
}

export interface Environment {
  home: string;
  githubToken: string;
  piUrl?: string;
  piToken?: string;
  discordWebhookUrl?: string;
  imap?: { host: string; port: number; user: string; password: string; mailbox: string };
  claudeBin: string;
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function loadConfig(file = process.env.ISOBOT_RUNNER_CONFIG ?? path.join(ROOT, "config", "isobot.json")): RunnerConfig {
  const raw = JSON.parse(readFileSync(file, "utf8")) as RunnerConfig;
  validateConfig(raw);
  return raw;
}

export function validateConfig(config: RunnerConfig): void {
  const fail = (message: string): never => { throw new Error(`Invalid runner config: ${message}`); };
  if (!(config.pollSeconds >= 15)) fail("pollSeconds must be at least 15");
  if (!(config.triageMinutes >= 5)) fail("triageMinutes must be at least 5");
  if (!(config.maxConcurrentJobs >= 1 && config.maxConcurrentJobs <= 8)) fail("maxConcurrentJobs must be 1-8");
  if (config.builder?.kind !== "claude") fail("builder.kind must be \"claude\"");
  for (const key of ["proposed", "ready", "building", "review", "failed", "ship", "stop"] as const) {
    if (!config.labels?.[key]) fail(`labels.${key} is required`);
  }
  for (const [category, repo] of Object.entries(config.discordCategories ?? {})) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) fail(`discordCategories.${category} must be owner/repo`);
  }
  if (config.vox) {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(config.vox.conversation ?? "")) fail("vox.conversation must be 1-100 letters, digits, underscores or hyphens");
    if (typeof config.vox.autoApprove !== "boolean") fail("vox.autoApprove must be true or false");
    const min = config.vox.minAutoApproveConfidence;
    if (min !== undefined && !(min > 0 && min <= 1)) fail("vox.minAutoApproveConfidence must be in (0, 1]");
    const most = config.vox.maxProposalsPerNote;
    if (most !== undefined && !(Number.isInteger(most) && most >= 1 && most <= 10)) fail("vox.maxProposalsPerNote must be 1-10");
  }
  for (const [name, partial] of Object.entries(config.repos ?? {})) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(name)) fail(`repo key ${name} must be owner/repo`);
    const policy = policyFor(config, name);
    if (!["off", "pr", "merge"].includes(policy.autonomy)) fail(`${name}: unknown autonomy "${policy.autonomy}"`);
    if (policy.autonomy === "merge" && policy.checks.length === 0) {
      fail(`${name}: autonomy "merge" needs at least one check command; unverified changes are never merged automatically`);
    }
    if (!(policy.minReviewConfidence > 0 && policy.minReviewConfidence <= 1)) fail(`${name}: minReviewConfidence must be in (0, 1]`);
    void partial;
  }
}

export function policyFor(config: RunnerConfig, repo: string): RepoPolicy {
  const key = Object.keys(config.repos).find(k => k.toLowerCase() === repo.toLowerCase());
  const own = key ? config.repos[key] : undefined;
  const base = config.defaults;
  return {
    ...base,
    ...own,
    autonomy: own?.autonomy ?? (key ? base.autonomy : "off"),
    protectedPaths: [...base.protectedPaths, ...(own?.protectedPaths ?? [])],
    release: { onMerge: own?.release?.onMerge ?? base.release.onMerge, onShip: own?.release?.onShip ?? base.release.onShip },
  };
}

export function configuredRepos(config: RunnerConfig): { owner: string; repo: string }[] {
  return Object.keys(config.repos)
    .filter(key => policyFor(config, key).autonomy !== "off")
    .map(key => { const [owner, repo] = key.split("/"); return { owner, repo }; });
}

export function loadEnvironment(env: NodeJS.ProcessEnv = process.env): Environment {
  const githubToken = env.ISOBOT_GITHUB_TOKEN ?? env.GITHUB_TOKEN;
  if (!githubToken) throw new Error("ISOBOT_GITHUB_TOKEN (or GITHUB_TOKEN) is required");
  const piUrl = env.ISOBOT_PI_URL;
  if (piUrl && !/^https:\/\//.test(piUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(`${piUrl}/`)) {
    throw new Error("ISOBOT_PI_URL must use HTTPS");
  }
  const imap = env.ISOBOT_IMAP_HOST && env.ISOBOT_IMAP_USER && env.ISOBOT_IMAP_PASSWORD ? {
    host: env.ISOBOT_IMAP_HOST,
    port: Number(env.ISOBOT_IMAP_PORT ?? 993),
    user: env.ISOBOT_IMAP_USER,
    password: env.ISOBOT_IMAP_PASSWORD,
    mailbox: env.ISOBOT_IMAP_MAILBOX ?? "INBOX",
  } : undefined;
  return {
    home: env.ISOBOT_HOME ?? path.join(homedir(), "Library", "Application Support", "isobot"),
    githubToken,
    piUrl: piUrl?.replace(/\/$/, ""),
    piToken: env.ISOBOT_PI_TOKEN,
    discordWebhookUrl: env.ISOBOT_DISCORD_WEBHOOK_URL,
    imap,
    claudeBin: env.ISOBOT_CLAUDE_BIN ?? "claude",
  };
}
