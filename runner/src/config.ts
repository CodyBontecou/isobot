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
  /**
   * Autonomy for work that came from the owner: issues carrying the auto label,
   * added by the owner's own account (by hand, or by the runner for the owner's
   * Vox.md notes). Defaults to `autonomy`. Every merge gate still applies.
   */
  ownerAutonomy?: Autonomy;
  /** Ship merged isobot work to the App Store on a schedule (see train.ts). */
  train?: TrainConfig;
}

export interface TrainConfig {
  /** App Store Connect app id. */
  appId: string;
  /** Xcode project or workspace (relative to the repo root) and the scheme to archive. */
  project?: string;
  workspace?: string;
  scheme: string;
  platform?: "IOS" | "MAC_OS";
  /** At most one train per this many hours. */
  everyHours: number;
  /** Warning time between announcing a train and shipping it. */
  holdMinutes: number;
  /** Commands run in the checkout before archiving (e.g. building a Rust core). */
  prepare?: string[];
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
  /** Small proposals (as rated by triage) from any source skip the approval click; major ones never do. */
  autoApprove?: AutoApproveConfig;
  /** App Store reviews to triage, read from Apple's public customer-reviews feed (no API key). */
  appStore?: AppStoreConfig;
  defaults: RepoPolicy;
  repos: Record<string, Partial<RepoPolicy>>;
}

export interface AutoApproveConfig {
  /** Sources whose small proposals are approved automatically. The owner's Vox notes follow vox.autoApprove. */
  sources: ("discord" | "github" | "email" | "appstore")[];
  /** Kinds of change that may be approved automatically. */
  kinds: ("bug" | "feature" | "chore")[];
  /** Below this triage confidence a proposal still waits. */
  minConfidence: number;
}

export interface AppStoreConfig {
  /** App Store app id (the digits in apps.apple.com/app/id…) → owner/repo. */
  apps: Record<string, string>;
  /** Storefronts to read, as lowercase two-letter country codes. The feed is per storefront. */
  countries: string[];
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
  /** Owner-originated work: lets the repo's ownerAutonomy apply. Only counts when the owner added it. */
  auto: string;
}

export interface Environment {
  home: string;
  githubToken: string;
  piUrl?: string;
  piToken?: string;
  discordWebhookUrl?: string;
  /** Bot token and channel for job status cards and threads (takes precedence over the webhook). */
  discordBot?: { token: string; channelId: string };
  /** Optional link to a job in isobot's UI, with `{id}` for the job id. */
  jobUrl?: string;
  /** Mailboxes to triage, from ISOBOT_IMAP_* and ISOBOT_IMAP_*_2 … _9. */
  imap: ImapAccount[];
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
  for (const key of ["proposed", "ready", "building", "review", "failed", "ship", "stop", "auto"] as const) {
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
  if (config.autoApprove) {
    const a = config.autoApprove;
    if (!Array.isArray(a.sources) || a.sources.some(x => !["discord", "github", "email", "appstore"].includes(x))) fail("autoApprove.sources must list discord, github, email or appstore");
    if (!Array.isArray(a.kinds) || a.kinds.some(x => !["bug", "feature", "chore"].includes(x))) fail("autoApprove.kinds must list bug, feature or chore");
    if (!(a.minConfidence > 0 && a.minConfidence <= 1)) fail("autoApprove.minConfidence must be in (0, 1]");
  }
  if (config.appStore) {
    const apps = Object.entries(config.appStore.apps ?? {});
    if (apps.length === 0) fail("appStore.apps must list at least one app");
    for (const [id, repo] of apps) {
      if (!/^\d{6,12}$/.test(id)) fail(`appStore.apps key ${id} must be a numeric App Store id`);
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) fail(`appStore.apps.${id} must be owner/repo`);
    }
    const countries = config.appStore.countries ?? [];
    if (countries.length === 0 || countries.some(c => !/^[a-z]{2}$/.test(c))) fail("appStore.countries must be lowercase two-letter country codes");
  }
  for (const [name, partial] of Object.entries(config.repos ?? {})) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(name)) fail(`repo key ${name} must be owner/repo`);
    const policy = policyFor(config, name);
    if (!["off", "pr", "merge"].includes(policy.autonomy)) fail(`${name}: unknown autonomy "${policy.autonomy}"`);
    if (policy.autonomy === "merge" && policy.checks.length === 0) {
      fail(`${name}: autonomy "merge" needs at least one check command; unverified changes are never merged automatically`);
    }
    if (policy.ownerAutonomy !== undefined && !["off", "pr", "merge"].includes(policy.ownerAutonomy)) fail(`${name}: unknown ownerAutonomy "${policy.ownerAutonomy}"`);
    if (policy.ownerAutonomy === "merge" && policy.checks.length === 0) {
      fail(`${name}: ownerAutonomy "merge" needs at least one check command; unverified changes are never merged automatically`);
    }
    if (policy.train) {
      const t = policy.train;
      if (!/^\d{6,12}$/.test(t.appId ?? "")) fail(`${name}: train.appId must be a numeric App Store id`);
      if (!t.scheme || Boolean(t.project) === Boolean(t.workspace)) fail(`${name}: train needs a scheme and exactly one of project or workspace`);
      if (!(t.everyHours >= 1)) fail(`${name}: train.everyHours must be at least 1`);
      if (!(t.holdMinutes >= 0)) fail(`${name}: train.holdMinutes must be 0 or more`);
      if ((policy.ownerAutonomy ?? policy.autonomy) !== "merge" && policy.autonomy !== "merge") fail(`${name}: a train only makes sense where isobot merges`);
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

export interface ImapAccount {
  host: string;
  port: number;
  user: string;
  password: string;
  mailbox: string;
  /** Gmail search (X-GM-RAW) a message must match to reach triage; empty reads everything. */
  query: string;
}

/** Personal Gmail is mostly not product feedback: read the Primary tab and mail to the product domain. */
export const DEFAULT_GMAIL_QUERY = "-from:me (category:primary OR to:isolated.tech)";

function imapAccounts(env: NodeJS.ProcessEnv): ImapAccount[] {
  const accounts: ImapAccount[] = [];
  for (const suffix of ["", "_2", "_3", "_4", "_5", "_6", "_7", "_8", "_9"]) {
    const get = (name: string) => env[`ISOBOT_IMAP_${name}${suffix}`]?.trim() || undefined;
    const user = get("USER");
    const password = get("PASSWORD")?.replace(/\s+/g, "");
    if (!user || !password) continue;
    const host = get("HOST") ?? (/@(gmail|googlemail)\.com$/i.test(user) ? "imap.gmail.com" : undefined);
    if (!host) throw new Error(`ISOBOT_IMAP_HOST${suffix} is required for ${user}`);
    accounts.push({
      host, user, password,
      port: Number(get("PORT") ?? 993),
      mailbox: get("MAILBOX") ?? "INBOX",
      query: env[`ISOBOT_IMAP_QUERY${suffix}`] ?? (host === "imap.gmail.com" ? DEFAULT_GMAIL_QUERY : ""),
    });
  }
  return accounts;
}

function discordBot(env: NodeJS.ProcessEnv): Environment["discordBot"] {
  const token = env.ISOBOT_DISCORD_BOT_TOKEN;
  const channelId = env.ISOBOT_DISCORD_CHANNEL_ID;
  if (!token && !channelId) return undefined;
  if (!token || !channelId) throw new Error("set both ISOBOT_DISCORD_BOT_TOKEN and ISOBOT_DISCORD_CHANNEL_ID, or neither");
  if (!/^\d{15,25}$/.test(channelId)) throw new Error("ISOBOT_DISCORD_CHANNEL_ID must be a Discord channel id (digits)");
  return { token, channelId };
}

export function loadEnvironment(env: NodeJS.ProcessEnv = process.env): Environment {
  const githubToken = env.ISOBOT_GITHUB_TOKEN ?? env.GITHUB_TOKEN;
  if (!githubToken) throw new Error("ISOBOT_GITHUB_TOKEN (or GITHUB_TOKEN) is required");
  const piUrl = env.ISOBOT_PI_URL;
  if (piUrl && !/^https:\/\//.test(piUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(`${piUrl}/`)) {
    throw new Error("ISOBOT_PI_URL must use HTTPS");
  }
  const imap = imapAccounts(env);
  return {
    home: env.ISOBOT_HOME ?? path.join(homedir(), "Library", "Application Support", "isobot"),
    githubToken,
    piUrl: piUrl?.replace(/\/$/, ""),
    piToken: env.ISOBOT_PI_TOKEN,
    discordWebhookUrl: env.ISOBOT_DISCORD_WEBHOOK_URL,
    discordBot: discordBot(env),
    jobUrl: env.ISOBOT_JOB_URL,
    imap,
    claudeBin: env.ISOBOT_CLAUDE_BIN ?? "claude",
  };
}
