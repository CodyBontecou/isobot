import { readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ChatConfig } from "./chat.js";
import type { DeviceSpec } from "./devices.js";
import type { DeploySignal } from "./github.js";

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
  minReviewConfidence: number;
  /** Wait for GitHub CI on the PR before an automatic merge. */
  requireCi: boolean;
  release: {
    /** Run on the merge commit after an isobot PR merges (e.g. deploy a Worker, upload to TestFlight). */
    onMerge: string[];
    /** Run only after the owner adds the ship label (e.g. App Store submission). */
    onShip: string[];
    /**
     * onMerge is safe to run twice on the same merge commit (a Worker or site deploy). Then a release a
     * restart interrupted runs again by itself; otherwise the runner tells you and waits for
     * `runner release <repo#n>`. Ship steps never rerun by themselves.
     */
    replaySafe?: boolean;
  };
  /** Extra guidance appended to the builder prompt for this repo. */
  notes?: string;
  /**
   * Autonomy for work that came from the owner: issues carrying the auto label,
   * added by the owner's own account (by hand, or by the runner for the owner's
   * Vox.md notes). Defaults to `autonomy`. Every merge gate still applies.
   */
  ownerAutonomy?: Autonomy;
  /** Ship merged isobot work to the App Store, or to TestFlight, on a schedule (see train.ts). */
  train?: TrainConfig;
  /**
   * Devices the runner boots for each job (devices.ts). Checks and the builder's isobot shell
   * see them as $ISOBOT_IOS_SIMULATOR and $ANDROID_SERIAL; the builder can also drive them with argent.
   */
  devices?: DeviceSpec;
  /** The app's marketing site: daily SEO research turns into content issues that build and merge (content.ts). */
  content?: ContentConfig;
  /** App Store search tracking and listing proposals for the app, from the local ASO Tracker (aso.ts). */
  aso?: AsoAppConfig;
  /**
   * Only files matching these globs may change for an automatic merge. Set by the content train for its
   * own jobs (the site's directory); unset means anywhere.
   */
  allowedPaths?: string[];
  /**
   * Where builds run: "local" (this Mac, the default) or "cloudflare" (a build sandbox on Cloudflare,
   * see docs/cloud-builds.md). Cloud builds have no simulators or emulators: `devices` are skipped, and
   * checks must run on Linux.
   */
  executor?: Executor;
}

export type Executor = "local" | "cloudflare";

/**
 * One marketing site fed by the content train. Content jobs replace the repo's checks, protected paths and
 * release steps with these (they keep its devices, for verified walkthroughs and screenshots), never ship through the release train, and merge on `autonomy`.
 */
export interface ContentConfig {
  /** The site's host, e.g. healthmd.app. Published URLs must be on it. */
  site: string;
  /** The OpenSEO project for the site (list_projects). */
  openseoProjectId: string;
  /** Content issues (and so research runs) per day. */
  perDay: number;
  /** Files a content change may touch; anything else leaves the merge to a human. */
  allowedPaths: string[];
  /** Commands that build and validate the site; required to merge. */
  checks: string[];
  /** Wait for GitHub CI on content PRs (only where site PRs actually run CI). Default false. */
  requireCi?: boolean;
  /** Protected paths for content jobs, besides the always-protected ones (CI, secrets, agent config). */
  protectedPaths?: string[];
  /**
   * The review confidence content needs to merge, in place of the repo's minReviewConfidence. Defaults to
   * CONTENT_MIN_REVIEW_CONFIDENCE: content is reviewed as an editor would (builder.ts CONTENT_REVIEW_RULES),
   * a page is cheap to fix after it's live, and the checks and path gates still hold.
   */
  minReviewConfidence?: number;
  /** Command run in a checkout of main after the site is live, with the new URLs as arguments (IndexNow). */
  indexNow?: string;
  /**
   * How production deploys show up on GitHub, so publishing waits until a deploy contains the merge:
   * `{ "workflow": "website-publish.yml" }` (its successful push runs on the default branch) or
   * `{ "environment": "Production" }` (GitHub deployments, as Vercel makes). Without it, a page answering
   * 200 counts as live, which a refreshed page always does.
   */
  deploy?: DeploySignal;
  /** House rules for writing on this site: where posts go, frontmatter, CTAs, translations. */
  notes: string;
  /** off: research nothing; pr: build and leave the merge to you; merge: merge when every gate passes. Default merge. */
  autonomy?: Autonomy;
  /** Where content jobs build (RepoPolicy.executor); defaults to "local". */
  executor?: Executor;
}

/**
 * One app followed by the ASO train. ASO Tracker measures its phrases every day; the runner keeps a daily
 * snapshot, posts a weekly rank report, and proposes measured listing changes. It never writes to App Store Connect.
 */
export interface AsoAppConfig {
  /** App Store app id (the digits in apps.apple.com/app/id…); the app must already be in ASO Tracker. */
  appId: string;
  /** The App Store Connect locale proposals are written for. Default en-US. */
  locale?: string;
  /** The storefront whose ranks the report and proposals use. Default us. */
  storefront?: string;
  /** What to protect or aim for in this app's listing (brand, tone, phrases to keep). */
  notes?: string;
  /**
   * off: follow nothing; report: snapshot and weekly report only; propose: also research listing proposals,
   * applied on an owner's ✅; apply: research and apply them without asking. Default propose.
   */
  autonomy?: "off" | "report" | "propose" | "apply";
  /** The App Store platform an approved proposal is written to. Default IOS. */
  platform?: "IOS" | "MAC_OS";
  /** The same app on Google Play: its ranks, weekly report and listing proposals run alongside the App Store's. */
  play?: AsoPlayConfig;
}

export interface AsoPlayConfig {
  /** The Play package name (applicationId); the app must already be in ASO Tracker as a Play app. */
  packageName: string;
  /** The Play listing language proposals are written for. Default en-US. */
  language?: string;
  /** Play-specific notes for the listing; the App Store notes apply when absent. */
  notes?: string;
  /** As for the App Store; default the App Store's autonomy. */
  autonomy?: "off" | "report" | "propose" | "apply";
}

/** Runner-wide settings for the ASO train (aso.ts). */
export interface AnalyticsLimits {
  /** Processing dates read back from today; older ones are never fetched. Default 35. */
  backfillDays?: number;
  /** App Store app ids to follow; default every app in appStore.apps. */
  apps?: string[];
}

export interface CrashLimits {
  /** A crash group is filed as a GitHub issue once it reaches this many affected users (Play) or reports. Default 2. */
  minUsers?: number;
  /** New GitHub issues per app and pass, biggest groups first; the rest wait for the next pass. Default 3. */
  issuesPerPass?: number;
  /** False: report in the check-in and Discord only, never open issues. Default true. */
  fileIssues?: boolean;
  /** True: crash issues are approved as they're opened (isobot:ready + isobot:auto), so isobot builds, merges and
   * ships the fix under the repo's ownerAutonomy without waiting. Default false (isobot:proposed). */
  autoApprove?: boolean;
}

export interface PlayRolloutLimits {
  /** Rollout fractions in order, ending at 1 (everyone). Default [0.2, 0.5, 1]. */
  stages?: number[];
  /** Days a release stays at each stage before the next, one per stage but the last. Default [2, 5]. */
  holdDays?: number[];
  /** A crash or ANR cluster new in the version halts the rollout once it reaches this many users. Default 2. */
  minUsers?: number;
}

export interface AsoLimits {
  /** The ASO Tracker CLI: an installed app's `Contents/Resources/aso`, or a checkout's `bin/aso.mjs`. */
  cli: string;
  /** For a checkout's CLI: the Electron executable to start the tracker with (ASO_APP_BINARY). */
  appBinary?: string;
  /** For a checkout's CLI: the app bundle's app.asar (ASO_APP_PATH). */
  appPath?: string;
  /** Weekday (0 = Sunday) of the weekly rank report, or null for none. Default 1. */
  reportWeekday?: number | null;
  /** Days between listing research runs per app. Default 7. */
  researchEveryDays?: number;
  /** Local hours [from, to) research and reports run in. Default [8, 22]. */
  hours?: [number, number];
  /** Google service account key (JSON) for Play listings and Play Console reports. Default ~/.config/isobot/play-isobot-aso.json. */
  googleKey?: string;
  /** Play Console's bulk report bucket (pubsite_prod_<developer id>), for Play analytics; off without it. */
  playReportsBucket?: string;
}

/** Runner-wide limits for the content train. */
export interface ContentLimits {
  /** Content builds at once, so app work isn't starved. Default 1. */
  maxConcurrentJobs?: number;
  /** OpenSEO credits one research run may spend. Default 100. */
  maxCreditsPerRun?: number;
  /** OpenSEO credits all research may spend in a day. Default 1500. */
  maxCreditsPerDay?: number;
  /** Below this balance research stops and the owner hears about it once. Default 300. */
  minCreditsRemaining?: number;
  /** Local weekday (0 = Sunday) for each site's weekly search report; null for none. Default 1 (Monday). */
  reportWeekday?: number | null;
  /** Local hours research may start, [from, to). Default [6, 22]. */
  hours?: [number, number];
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
  /** Announce each version to users in Discord once it's live on the App Store (launch.ts). */
  launch?: LaunchConfig;
  /**
   * Ship to TestFlight instead of the App Store: each train uploads a build, adds it to this external
   * group and submits it for Beta App Review. Nothing goes to App Review, and the launch post
   * goes out when external testers can install the build.
   */
  testflight?: TestFlightConfig;
}

export interface TestFlightConfig {
  /** The external beta group's name or id in App Store Connect. */
  group: string;
  /** The group's public TestFlight link, for the launch post. Without it the post tells existing testers to update. */
  joinUrl?: string;
}

export interface LaunchConfig {
  /** The app's public Discord channel for release posts. Needs the bot (not just a webhook). */
  channelId: string;
  /** The app's name as users know it; defaults to the scheme. */
  name?: string;
  /** App Store link in the post; defaults to apps.apple.com/app/id<appId>. */
  storeUrl?: string;
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
    /** Limit for content-train jobs, which translate the new page into every site locale; defaults to timeoutMinutes. */
    contentTimeoutMinutes?: number;
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
  /** The staff chat in the job-card channel (chat.ts). On by default when the bot is configured. */
  chat?: ChatConfig;
  /** Limits for the content train (content.ts); per-site settings live in each repo's `content`. */
  content?: ContentLimits;
  /** The ASO train (aso.ts); per-app settings live in each repo's `aso`. */
  aso?: AsoLimits;
  /** App Store Connect analytics (analytics.ts) for the apps in appStore.apps. Off without this block. */
  analytics?: AnalyticsLimits;
  /** The crash audit (crashes.ts): App Store, TestFlight and Google Play crashes. Off without this block. */
  crashes?: CrashLimits;
  /** The Play rollout train (playRollout.ts): staged production rollouts move forward on their own. Off without this block. */
  playRollout?: PlayRolloutLimits;
  /** 💻 on isobot's Discord messages opens the conversation in the owner's local Herdr (handoff.ts). */
  handoff?: HandoffConfig;
  defaults: RepoPolicy;
  repos: Record<string, Partial<RepoPolicy>>;
}

export interface HandoffConfig {
  /** Default: on when the Discord bot is configured and the Herdr CLI is installed. */
  enabled?: boolean;
  /** The Herdr CLI. Default "herdr" on PATH. */
  herdrBin?: string;
  /** Herdr workspace (by label) for tabs that belong to no repo. Default "isobot". */
  workspace?: string;
  /** Working directory for those tabs, and for a repo with no local checkout. Default ~/dev. "~/" is expanded. */
  cwd?: string;
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
  /** Dismiss: the runner removes what it made locally, strips its labels and closes the issue. Default isobot:cleanup. */
  cleanup: string;
  /** Marks content-train issues: they build with the site's content policy. Default isobot:content. */
  content: string;
}

export interface Environment {
  home: string;
  githubToken: string;
  piUrl?: string;
  piToken?: string;
  discordWebhookUrl?: string;
  /** Bot token and channel for job status cards and threads (takes precedence over the webhook). */
  discordBot?: { token: string; channelId: string };
  /** Where the staff chat listens: ISOBOT_CHAT_CHANNEL_ID, else the job-card channel. */
  chatChannelId?: string;
  /** Optional link to a job in isobot's UI, with `{id}` for the job id. */
  jobUrl?: string;
  /** Mailboxes to triage, from ISOBOT_IMAP_* and ISOBOT_IMAP_*_2 … _9. */
  imap: ImapAccount[];
  claudeBin: string;
  /** Dead-man's-switch URL pinged after each healthy cycle, so an outside service notices a dead runner. */
  heartbeatUrl?: string;
  /** This runner's name in claim leases (ISOBOT_RUNNER_ID, else the host name), so two runners never build one issue. */
  runnerId: string;
  /** The isobot-sandbox Worker for cloud builds (`executor: "cloudflare"`), from ISOBOT_SANDBOX_URL and ISOBOT_SANDBOX_TOKEN. */
  sandbox?: { url: string; token: string };
  /** The isobot board Worker (bot.isolated.tech), from ISOBOT_BOARD_URL and ISOBOT_BOARD_TOKEN. */
  board?: { url: string; token: string };
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
  const contentTimeout = config.builder.contentTimeoutMinutes;
  if (contentTimeout !== undefined && !(contentTimeout >= 1 && contentTimeout <= 240)) fail("builder.contentTimeoutMinutes must be 1-240");
  // Added after the others; older configs get the default.
  if (config.labels && !config.labels.cleanup) config.labels.cleanup = "isobot:cleanup";
  if (config.labels && !config.labels.content) config.labels.content = "isobot:content";
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
  if (config.analytics) {
    const a = config.analytics;
    if (!config.appStore) fail("analytics needs appStore.apps (the apps it reads)");
    if (a.backfillDays !== undefined && !(Number.isInteger(a.backfillDays) && a.backfillDays >= 1 && a.backfillDays <= 180)) fail("analytics.backfillDays must be 1-180");
    for (const id of a.apps ?? []) if (!config.appStore?.apps?.[id]) fail(`analytics.apps: ${id} isn't in appStore.apps`);
  }
  if (config.crashes) {
    const c = config.crashes;
    if (c.minUsers !== undefined && !(Number.isInteger(c.minUsers) && c.minUsers >= 1)) fail("crashes.minUsers must be a whole number of at least 1");
    if (c.issuesPerPass !== undefined && !(Number.isInteger(c.issuesPerPass) && c.issuesPerPass >= 0 && c.issuesPerPass <= 20)) fail("crashes.issuesPerPass must be 0-20");
    if (c.fileIssues !== undefined && typeof c.fileIssues !== "boolean") fail("crashes.fileIssues must be true or false");
    if (c.autoApprove !== undefined && typeof c.autoApprove !== "boolean") fail("crashes.autoApprove must be true or false");
  }
  if (config.playRollout) {
    const r = config.playRollout;
    if (r.stages !== undefined && !(Array.isArray(r.stages) && r.stages.length >= 1 && r.stages.every((x, i) => typeof x === "number" && x > 0 && x <= 1 && (i === 0 || x > r.stages![i - 1])) && r.stages[r.stages.length - 1] === 1)) fail("playRollout.stages must be rising fractions above 0 that end at 1");
    const stages = r.stages ?? [0.2, 0.5, 1];
    if (r.holdDays !== undefined && !(Array.isArray(r.holdDays) && r.holdDays.length === stages.length - 1 && r.holdDays.every(d => typeof d === "number" && d >= 0 && d <= 30))) fail("playRollout.holdDays needs one number of days (0-30) per stage but the last");
    if (r.minUsers !== undefined && !(Number.isInteger(r.minUsers) && r.minUsers >= 1)) fail("playRollout.minUsers must be a whole number of at least 1");
  }
  if (config.handoff) {
    const h = config.handoff;
    if (h.enabled !== undefined && typeof h.enabled !== "boolean") fail("handoff.enabled must be true or false");
    for (const key of ["herdrBin", "workspace", "cwd"] as const) {
      if (h[key] !== undefined && (typeof h[key] !== "string" || !h[key])) fail(`handoff.${key} must be a non-empty string`);
    }
  }
  if (config.chat) {
    const c = config.chat;
    if (c.enabled !== undefined && typeof c.enabled !== "boolean") fail("chat.enabled must be true or false");
    if (c.checkInHour !== undefined && c.checkInHour !== null && !(Number.isInteger(c.checkInHour) && c.checkInHour >= 0 && c.checkInHour <= 23)) fail("chat.checkInHour must be 0-23 or null");
    if (c.maxConcurrent !== undefined && !(Number.isInteger(c.maxConcurrent) && c.maxConcurrent >= 1 && c.maxConcurrent <= 4)) fail("chat.maxConcurrent must be 1-4");
    if (c.timeoutMinutes !== undefined && !(c.timeoutMinutes >= 1 && c.timeoutMinutes <= 60)) fail("chat.timeoutMinutes must be 1-60");
    if (c.maxTurns !== undefined && !(Number.isInteger(c.maxTurns) && c.maxTurns >= 1)) fail("chat.maxTurns must be a positive integer");
  }
  if (config.content) {
    const c = config.content;
    const positive = (v: number | undefined, key: string) => { if (v !== undefined && !(Number.isInteger(v) && v >= 1)) fail(`content.${key} must be a positive integer`); };
    positive(c.maxConcurrentJobs, "maxConcurrentJobs");
    positive(c.maxCreditsPerRun, "maxCreditsPerRun");
    positive(c.maxCreditsPerDay, "maxCreditsPerDay");
    if (c.minCreditsRemaining !== undefined && !(Number.isInteger(c.minCreditsRemaining) && c.minCreditsRemaining >= 0)) fail("content.minCreditsRemaining must be 0 or more");
    if (c.reportWeekday !== undefined && c.reportWeekday !== null && !(Number.isInteger(c.reportWeekday) && c.reportWeekday >= 0 && c.reportWeekday <= 6)) fail("content.reportWeekday must be 0-6 or null");
    if (c.hours !== undefined && !(Array.isArray(c.hours) && c.hours.length === 2 && c.hours.every(h => Number.isInteger(h) && h >= 0 && h <= 24) && c.hours[0] < c.hours[1])) {
      fail("content.hours must be [from, to) local hours with from < to");
    }
  }
  if (config.aso) {
    const a = config.aso;
    if (!a.cli?.trim()) fail("aso.cli must be the ASO Tracker CLI's path");
    if (a.reportWeekday !== undefined && a.reportWeekday !== null && !(Number.isInteger(a.reportWeekday) && a.reportWeekday >= 0 && a.reportWeekday <= 6)) fail("aso.reportWeekday must be 0-6 or null");
    if (a.researchEveryDays !== undefined && !(Number.isInteger(a.researchEveryDays) && a.researchEveryDays >= 1 && a.researchEveryDays <= 90)) fail("aso.researchEveryDays must be 1-90");
    if (a.hours !== undefined && !(Array.isArray(a.hours) && a.hours.length === 2 && a.hours.every(h => Number.isInteger(h) && h >= 0 && h <= 24) && a.hours[0] < a.hours[1])) {
      fail("aso.hours must be [from, to) local hours with from < to");
    }
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
      if (t.launch) {
        if (!/^\d{17,20}$/.test(t.launch.channelId ?? "")) fail(`${name}: train.launch.channelId must be a Discord channel id`);
        if (t.launch.storeUrl !== undefined && !/^https:\/\/\S+$/.test(t.launch.storeUrl)) fail(`${name}: train.launch.storeUrl must be an https URL`);
      }
      if (t.testflight) {
        if (!t.testflight.group?.trim()) fail(`${name}: train.testflight.group must name an external beta group`);
        if (t.testflight.joinUrl !== undefined && !/^https:\/\/testflight\.apple\.com\/join\/\w+$/.test(t.testflight.joinUrl)) {
          fail(`${name}: train.testflight.joinUrl must be a https://testflight.apple.com/join/… link`);
        }
      }
    }
    for (const [where, executor] of [[name, policy.executor], [`${name}: content`, policy.content?.executor]] as const) {
      if (executor !== undefined && executor !== "local" && executor !== "cloudflare") fail(`${where}: executor must be "local" or "cloudflare"`);
    }
    if (policy.devices) {
      const d = policy.devices;
      if (d.ios && !d.ios.deviceType?.trim()) fail(`${name}: devices.ios.deviceType is required (e.g. "iPhone 17")`);
      if (d.android && !/^[\w.-]+$/.test(d.android.avd ?? "")) fail(`${name}: devices.android.avd must be an AVD name`);
    }
    if (policy.content) {
      const c = policy.content;
      if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(c.site ?? "")) fail(`${name}: content.site must be a host name like example.com`);
      if (!/^[\w-]{8,}$/.test(c.openseoProjectId ?? "")) fail(`${name}: content.openseoProjectId must be an OpenSEO project id`);
      if (!(Number.isInteger(c.perDay) && c.perDay >= 1 && c.perDay <= 12)) fail(`${name}: content.perDay must be 1-12`);
      if (!Array.isArray(c.allowedPaths) || c.allowedPaths.length === 0) fail(`${name}: content.allowedPaths must list the site's files`);
      if (c.minReviewConfidence !== undefined && !(c.minReviewConfidence > 0 && c.minReviewConfidence <= 1)) fail(`${name}: content.minReviewConfidence must be in (0, 1]`);
      if (c.autonomy !== undefined && !["off", "pr", "merge"].includes(c.autonomy)) fail(`${name}: unknown content.autonomy "${c.autonomy}"`);
      if ((c.autonomy ?? "merge") === "merge" && !(c.checks?.length)) fail(`${name}: content.checks must build the site before content merges automatically`);
      if (!c.notes?.trim()) fail(`${name}: content.notes must tell the builder how this site's content works`);
      if (c.deploy !== undefined) {
        const d = c.deploy as { workflow?: unknown; environment?: unknown };
        const named = (v: unknown) => typeof v === "string" && /^[\w./ -]{1,100}$/.test(v);
        if (named(d.workflow) === named(d.environment) || Object.keys(d).length !== 1) fail(`${name}: content.deploy must be { "workflow": "<file>.yml" } or { "environment": "<name>" }`);
      }
    }
    if (policy.aso) {
      const a = policy.aso;
      if (!/^\d{6,12}$/.test(a.appId ?? "")) fail(`${name}: aso.appId must be an App Store app id`);
      if (a.locale !== undefined && !/^[a-z]{2,3}(-[A-Za-z0-9]{2,4})*$/.test(a.locale)) fail(`${name}: aso.locale must be an App Store Connect locale like en-US`);
      if (a.storefront !== undefined && !/^[a-z]{2}$/.test(a.storefront)) fail(`${name}: aso.storefront must be a two-letter storefront like us`);
      if (a.autonomy !== undefined && !["off", "report", "propose", "apply"].includes(a.autonomy)) fail(`${name}: unknown aso.autonomy "${a.autonomy}"`);
      if (a.platform !== undefined && !["IOS", "MAC_OS"].includes(a.platform)) fail(`${name}: aso.platform must be IOS or MAC_OS`);
      if (!config.aso) fail(`${name}: aso needs the runner-wide aso.cli`);
      if (a.play) {
        if (!/^[a-zA-Z][\w]*(\.[a-zA-Z][\w]*)+$/.test(a.play.packageName ?? "")) fail(`${name}: aso.play.packageName must be a Play package name like com.example.app`);
        if (a.play.language !== undefined && !/^[a-z]{2,3}(-[A-Za-z0-9]{2,4})?$/.test(a.play.language)) fail(`${name}: aso.play.language must be a Play language like en-US`);
        if (a.play.autonomy !== undefined && !["off", "report", "propose", "apply"].includes(a.play.autonomy)) fail(`${name}: unknown aso.play.autonomy "${a.play.autonomy}"`);
      }
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
    release: {
      onMerge: own?.release?.onMerge ?? base.release.onMerge,
      onShip: own?.release?.onShip ?? base.release.onShip,
      replaySafe: own?.release?.replaySafe ?? base.release.replaySafe ?? false,
    },
  };
}

/**
 * Protected for content jobs whatever the site says: CI, deploy and secret configuration, agent
 * instructions and hooks. Content globs replace the app's (`**\/*premium*` and the like), which match
 * ordinary post slugs.
 */
export const CONTENT_PROTECTED_PATHS = [
  ".github/**", "**/.env*", "**/wrangler.json*", "**/wrangler.toml", "**/vercel.json", "**/netlify.toml", "**/_headers",
  "**/migrations/**", ".claude/**", "**/CLAUDE.md", "**/AGENTS.md", ".mcp.json", ".codex/**", ".agents/**", ".pi/**",
  ".gitmodules", "**/.githooks/**", "**/.husky/**", "**/package.json", "**/package-lock.json",
];

/** The review confidence content merges at unless the site sets its own (ContentConfig.minReviewConfidence). */
export const CONTENT_MIN_REVIEW_CONFIDENCE = 0.75;

/** The policy a content-train job builds and merges under (see ContentConfig). */
export function contentPolicy(policy: RepoPolicy): RepoPolicy {
  const content = policy.content;
  if (!content) throw new Error("this repository has no content configuration");
  const autonomy = content.autonomy ?? "merge";
  return {
    ...policy,
    autonomy,
    ownerAutonomy: autonomy,
    checks: content.checks,
    protectedPaths: [...CONTENT_PROTECTED_PATHS, ...(content.protectedPaths ?? [])],
    allowedPaths: content.allowedPaths,
    minReviewConfidence: content.minReviewConfidence ?? CONTENT_MIN_REVIEW_CONFIDENCE,
    requireCi: content.requireCi ?? false,
    release: { onMerge: [], onShip: [] },
    notes: content.notes,
    executor: content.executor ?? "local",
    // Walkthroughs are verified, and screenshotted, on the app's own simulator or emulator.
    train: undefined,
  };
}

/** Repositories whose site the content train writes for. */
export function contentRepos(config: RunnerConfig): { owner: string; repo: string; content: ContentConfig }[] {
  return Object.keys(config.repos).flatMap(key => {
    const content = policyFor(config, key).content;
    if (!content || (content.autonomy ?? "merge") === "off") return [];
    const [owner, repo] = key.split("/");
    return [{ owner, repo, content }];
  });
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

function sandboxEnv(env: NodeJS.ProcessEnv): Environment["sandbox"] {
  const url = env.ISOBOT_SANDBOX_URL?.trim();
  const token = env.ISOBOT_SANDBOX_TOKEN?.trim();
  if (!url && !token) return undefined;
  if (!url || !token) throw new Error("set both ISOBOT_SANDBOX_URL and ISOBOT_SANDBOX_TOKEN, or neither");
  if (!/^https:\/\//.test(url)) throw new Error("ISOBOT_SANDBOX_URL must use HTTPS");
  return { url: url.replace(/\/$/, ""), token };
}

/**
 * Apps the ASO train follows: each repo's App Store app, then its Play app. A Play app's `aso` is its own:
 * the package name as `appId` and the listing language as `locale`.
 */
export function asoApps(config: RunnerConfig): { owner: string; repo: string; aso: AsoAppConfig; store: "appstore" | "play" }[] {
  if (!config.aso) return [];
  return Object.keys(config.repos).flatMap(key => {
    const aso = policyFor(config, key).aso;
    if (!aso) return [];
    const [owner, repo] = key.split("/");
    const out: { owner: string; repo: string; aso: AsoAppConfig; store: "appstore" | "play" }[] = [];
    if ((aso.autonomy ?? "propose") !== "off") out.push({ owner, repo, aso, store: "appstore" });
    const play = aso.play;
    const autonomy = play?.autonomy ?? aso.autonomy ?? "propose";
    if (play && autonomy !== "off") {
      out.push({ owner, repo, store: "play", aso: { appId: play.packageName, locale: play.language ?? "en-US", storefront: "us", notes: play.notes ?? aso.notes, autonomy } });
    }
    return out;
  });
}

/** Repos with app or content builds on Cloudflare (`executor: "cloudflare"`). */
export function cloudRepos(config: RunnerConfig): string[] {
  return Object.keys(config.repos).filter(repo => {
    const policy = policyFor(config, repo);
    return policy.executor === "cloudflare" || policy.content?.executor === "cloudflare";
  });
}

export function loadEnvironment(env: NodeJS.ProcessEnv = process.env): Environment {
  const githubToken = env.ISOBOT_GITHUB_TOKEN ?? env.GITHUB_TOKEN;
  if (!githubToken) throw new Error("ISOBOT_GITHUB_TOKEN (or GITHUB_TOKEN) is required");
  const piUrl = env.ISOBOT_PI_URL;
  if (piUrl && !/^https:\/\//.test(piUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(`${piUrl}/`)) {
    throw new Error("ISOBOT_PI_URL must use HTTPS");
  }
  const heartbeatUrl = env.ISOBOT_HEARTBEAT_URL?.trim() || undefined;
  if (heartbeatUrl && !/^https:\/\//.test(heartbeatUrl)) throw new Error("ISOBOT_HEARTBEAT_URL must use HTTPS");
  const imap = imapAccounts(env);
  return {
    home: env.ISOBOT_HOME ?? path.join(homedir(), "Library", "Application Support", "isobot"),
    githubToken,
    piUrl: piUrl?.replace(/\/$/, ""),
    piToken: env.ISOBOT_PI_TOKEN,
    discordWebhookUrl: env.ISOBOT_DISCORD_WEBHOOK_URL,
    discordBot: discordBot(env),
    chatChannelId: env.ISOBOT_CHAT_CHANNEL_ID?.trim() || discordBot(env)?.channelId,
    jobUrl: env.ISOBOT_JOB_URL,
    imap,
    claudeBin: env.ISOBOT_CLAUDE_BIN ?? "claude",
    heartbeatUrl,
    runnerId: (env.ISOBOT_RUNNER_ID?.trim() || hostname().split(".")[0] || "runner").replace(/[^\w.-]+/g, "-"),
    sandbox: sandboxEnv(env),
    board: boardEnv(env),
  };
}

function boardEnv(env: NodeJS.ProcessEnv): Environment["board"] {
  const url = env.ISOBOT_BOARD_URL?.trim().replace(/\/$/, "");
  const token = env.ISOBOT_BOARD_TOKEN?.trim();
  if (!url && !token) return undefined;
  if (!url || !token) throw new Error("ISOBOT_BOARD_URL and ISOBOT_BOARD_TOKEN go together");
  if (!/^https:\/\//.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(url)) throw new Error("ISOBOT_BOARD_URL must use HTTPS");
  return { url, token };
}
