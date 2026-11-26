#!/usr/bin/env node
import { ImapFlow } from "imapflow";
import { ProductionRelease, nextSlot, productionSettings } from "./production.js";
import { ReleaseTrain } from "./train.js";
import { ContentTrain } from "./content.js";
import { AsoTrain, type AsoClient } from "./aso.js";
import { AppAnalytics } from "./analytics.js";
import { GoogleAuth, PlayPublisher } from "./google.js";
import { PlayAnalytics, ratingsText } from "./playAnalytics.js";
import { CrashAudit } from "./crashes.js";
import { PlayRollout, planText } from "./playRollout.js";
import type { CheckReport } from "./policy.js";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { gunzipSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { builderSettings, ClaudeCodeBuilder } from "./builder.js";
import { chatAllowlist, claudeChatModel, StaffChat } from "./chat.js";
import { ChatToolServer } from "./chatMcp.js";
import { DiscordApi } from "./discordApi.js";
import { CloudRepo, HttpSandboxApi, remoteChecks, remoteExec } from "./cloud.js";
import { asoApps, cloudRepos, configuredRepos, contentRepos, loadConfig, loadEnvironment, policyFor, type Environment, type RunnerConfig } from "./config.js";
import { Repo } from "./git.js";
import { GitHub } from "./github.js";
import { TERMINAL_MARKER } from "./notes.js";
import { Handoff, HandoffWatch } from "./handoff.js";
import { Herdr } from "./herdr.js";
import { HANDOFF, Notifier } from "./notify.js";
import { Pipeline } from "./pipeline.js";
import { runChecks } from "./checks.js";
import { buildMetrics } from "./metrics.js";
import { formatSweep, PrSweep } from "./prSweep.js";
import { runBoardAction } from "./boardActions.js";
import { Dashboard, WEEKDAYS, every, nextDailyAt, nextWeeklyAt, type ScheduleItem } from "./dashboard.js";
import { Awake, heartbeatAge, pingHeartbeat, readHeartbeat, rotateLog, writeHeartbeat } from "./ops.js";
import { killAllChildren, run, setGitIdentity, sh, workerEnv } from "./proc.js";
import { sandboxProfile } from "./sandbox.js";
import { ensureShims } from "./shims.js";
import { hasDevices, LocalDevices } from "./devices.js";
import { removeDerivedData } from "./cleanup.js";
import { Store } from "./store.js";
import { explainGrants } from "./grants.js";
import { followUpLines, inspect } from "./inspect.js";
import type { LiveStatus } from "./chatTools.js";
import { AppStoreSource, DiscordSource, EmailSource, GitHubSource, VoxSource, triage, type Source } from "./triage.js";

function loadEnvFiles(): void {
  const home = process.env.ISOBOT_HOME ?? path.join(process.env.HOME ?? "", "Library", "Application Support", "isobot");
  for (const file of [path.join(home, "runner.env"), path.resolve(process.cwd(), ".env.runner")]) {
    if (existsSync(file)) process.loadEnvFile(file);
  }
}

interface Runtime {
  config: RunnerConfig;
  env: Environment;
  store: Store;
  github: GitHub;
  pipeline: Pipeline;
  sources: Source[];
  builder: ClaudeCodeBuilder;
  notifier: Notifier;
  checks: (cwd: string, commands: string[], options: { timeoutMs?: number; sandbox: boolean; env?: Record<string, string> }) => Promise<CheckReport>;
  devices: LocalDevices;
  repoFor: (owner: string, repo: string) => Repo;
  train: ReleaseTrain;
  /** Weekly App Store releases of soaked TestFlight builds (production.ts). */
  production: ProductionRelease;
  content: ContentTrain;
  aso: AsoTrain;
  analytics: AppAnalytics;
  /** Play Console's bulk reports for the Play apps of the ASO train; null without aso.playReportsBucket. */
  playAnalytics: PlayAnalytics | null;
  /** Crashes from Google Play, the App Store and TestFlight (crashes.ts); off without config.crashes. */
  crashes: CrashAudit;
  /** Staged Play production rollouts moved forward on their own (playRollout.ts); null without config.playRollout. */
  playRollout: PlayRollout | null;
  /** Every open PR in the configured repos, sorted into what needs the owner (prSweep.ts); on unless prSweep.enabled is false. */
  prSweep: PrSweep;
  /** Runner secrets and state, for settings that keep agents out of them. */
  secrets: string[];
  /** Messages carrying a 💻 (Herdr handoff), when it's on. */
  handoff?: HandoffWatch;
}

/** Set once the runner starts stopping; a release train interrupted by it resumes next start. */
let shuttingDown = false;

/** The isobot checkout running this code; builders must never modify it. */
const ISOBOT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function globalGit(key: string): string {
  try { return execFileSync("git", ["config", "--global", key], { encoding: "utf8" }).trim(); } catch { return ""; }
}

/**
 * Cloud builds (docs/cloud-builds.md): the same Claude Code builder and checks, run in an isobot-sandbox
 * Container. The Container is the sandbox, so Claude Code's own (macOS) sandbox settings don't apply;
 * the builder's tool denials still do.
 */
function cloudExecutor(config: RunnerConfig, env: Environment, repoFor: (owner: string, repo: string) => Repo) {
  if (!env.sandbox) return undefined;
  const api = new HttpSandboxApi(env.sandbox.url, env.sandbox.token);
  const deny = ((config.builder.settings?.permissions as { deny?: string[] } | undefined)?.deny) ?? [];
  const builder = new ClaudeCodeBuilder(config.builder, { secrets: [], noWrite: [] }, "claude", undefined, undefined, {
    exec: remoteExec(api), settings: { permissions: { deny } },
  });
  return {
    repo: (owner: string, repo: string) => new CloudRepo(repoFor(owner, repo), api),
    builder,
    checks: (cwd: string, commands: string[], options: { timeoutMs?: number; env?: Record<string, string> }) => remoteChecks(api, cwd, commands, options),
  };
}

function runtime(): Runtime {
  loadEnvFiles();
  const config = loadConfig();
  const env = loadEnvironment();
  mkdirSync(env.home, { recursive: true });
  // Builders don't see the global git config (credential helpers); give them its identity only.
  setGitIdentity(process.env.ISOBOT_GIT_NAME ?? globalGit("user.name"), process.env.ISOBOT_GIT_EMAIL ?? globalGit("user.email"));
  const store = new Store(path.join(env.home, "runner.sqlite"));
  const github = new GitHub(env.githubToken);
  // Builders and checks may read the shared clones (workspaces borrow their objects) but not secrets or state.
  const secrets = ["runner.env", "runner.sqlite", "runner.sqlite-wal", "runner.sqlite-shm", "logs", "runner.lock", "paused", "heartbeat.json", "webhooks"]
    .map(entry => path.join(env.home, entry)).concat(path.resolve(process.cwd(), ".env.runner"));
  // Builders and checks also stay out of the staff chat's files (the owner's uploads and checkouts).
  const builderSecrets = [...secrets, path.join(env.home, "chat")];
  const shimDir = ensureShims(env.home);
  const extraWrite = ((config.builder.settings?.sandbox as { filesystem?: { allowWrite?: string[] } } | undefined)?.filesystem?.allowWrite) ?? [];
  const mcpDir = path.join(env.home, "mcp");
  const shellTool = {
    configDir: mcpDir,
    profileFor: (cwd: string) => sandboxProfile({ workspace: cwd, secrets: builderSecrets, allowWrite: extraWrite }),
    env: (extra: Record<string, string>) => workerEnv(extra) as Record<string, string>,
  };
  const builder = new ClaudeCodeBuilder(config.builder, { secrets: builderSecrets, noWrite: [path.join(env.home, "repos"), shimDir, mcpDir, ISOBOT_ROOT] }, env.claudeBin, shimDir, shellTool);
  const devices = new LocalDevices(path.join(env.home, "logs", "devices"));
  const handoff = handoffEnabled(config, env) ? new HandoffWatch(store) : undefined;
  const notifier = new Notifier({ webhookUrl: env.discordWebhookUrl, bot: env.discordBot, store, jobUrl: env.jobUrl, handoff });
  // Checks execute builder-written code, so they get the same confinement as the builder's shell.
  const checks = (cwd: string, commands: string[], options: { timeoutMs?: number; sandbox: boolean; env?: Record<string, string> }) => runChecks(cwd, commands, {
    timeoutMs: options.timeoutMs, env: options.env,
    sandboxProfile: options.sandbox ? sandboxProfile({ workspace: cwd, secrets: builderSecrets, allowWrite: extraWrite }) : undefined,
    shimDir,
  });
  const repoFor = (owner: string, repo: string) => new Repo(env.home, owner, repo, env.githubToken);
  const pipeline = new Pipeline({ config, env, store, github, builder, notifier, repo: repoFor, checks, devices, runnerId: env.runnerId, cloud: cloudExecutor(config, env, repoFor) });
  const labels = Object.values(config.labels);
  const sources: Source[] = [new GitHubSource(github, configuredRepos(config), labels)];
  if (env.piUrl && env.piToken) sources.push(new DiscordSource(env.piUrl, env.piToken, lowerKeys(config.discordCategories)));
  if (env.piUrl && env.piToken && config.vox) sources.push(new VoxSource(env.piUrl, env.piToken, config.vox.conversation));
  for (const account of env.imap) sources.push(new EmailSource(account));
  if (config.appStore) sources.push(new AppStoreSource(config.appStore));
  const ascStatus = async (appId: string, platform: string) => {
    // Without --platform, asc reports whichever platform's version is newest (a Mac app's, say).
    const result = await run("asc", ["status", "--app", appId, "--platform", platform, "--output", "json"], { cwd: env.home, env: workerEnv(), timeoutMs: 120_000 });
    if (result.code !== 0) throw new Error(`asc status failed: ${(result.stderr || result.stdout).trim().slice(-300)}`);
    const status = JSON.parse(result.stdout) as { appstore?: { version?: string; state?: string }; builds?: { latest?: { version?: string } } };
    return { version: status.appstore?.version ?? null, state: status.appstore?.state ?? null, latestBuild: status.builds?.latest?.version ?? null };
  };
  const ascBetaState = async (appId: string, platform: string, buildNumber: string) => {
    const result = await run("asc", ["builds", "build-beta-detail", "view", "--app", appId, "--build-number", buildNumber, "--platform", platform, "--output", "json"],
      { cwd: env.home, env: workerEnv(), timeoutMs: 120_000 });
    // Right after upload, before processing, the build doesn't exist yet.
    if (result.code !== 0) return null;
    const detail = JSON.parse(result.stdout) as { data?: { attributes?: { externalBuildState?: string } } };
    return detail.data?.attributes?.externalBuildState ?? null;
  };
  const train = new ReleaseTrain({
    config, store, github, notifier, repo: repoFor,
    stopping: () => shuttingDown,
    notes: input => builder.releaseNotes(input),
    pullBody: async (owner, repo, number) => (await github.pullDetails(owner, repo, number)).body,
    fileAt: (owner, repo, ref, file) => github.fileAt(owner, repo, ref, file),
    run: async (cwd, command, timeoutMs) => {
      const result = await sh(command, { cwd, env: workerEnv(), timeoutMs });
      return { ok: result.code === 0 && !result.timedOut, output: `${result.stdout}\n${result.stderr}` };
    },
    appStatus: ascStatus,
    betaState: ascBetaState,
  });
  const production = new ProductionRelease({
    config, store, github, notifier,
    stopping: () => shuttingDown,
    notes: input => builder.releaseNotes(input),
    pullBody: async (owner, repo, number) => (await github.pullDetails(owner, repo, number)).body,
    appStatus: ascStatus,
    betaState: ascBetaState,
    asc: async args => {
      const result = await run("asc", args, { cwd: env.home, env: workerEnv(), timeoutMs: 30 * 60_000 });
      return { ok: result.code === 0 && !result.timedOut, stdout: result.stdout, output: `${result.stdout}\n${result.stderr}` };
    },
  });
  const content = new ContentTrain({
    config, store, github, notifier, repo: repoFor,
    agent: input => builder.agentJson(input),
    pullBody: async (owner, repo, number) => (await github.pullDetails(owner, repo, number)).body,
    run: async (cwd, command, timeoutMs) => {
      const result = await sh(command, { cwd, env: workerEnv(), timeoutMs });
      return { ok: result.code === 0 && !result.timedOut, output: `${result.stdout}\n${result.stderr}` };
    },
  });
  // Read-only: asc refuses anything that would change App Store Connect.
  const analyticsAsc = async (args: string[]) => {
    const result = await run("asc", args, { cwd: env.home, env: workerEnv({ ASC_READ_ONLY: "1" }), timeoutMs: 180_000, maxBytes: 8 * 1024 * 1024 });
    return { ok: result.code === 0 && !result.timedOut, stdout: result.stdout, stderr: result.stderr };
  };
  const analyticsFetch = async (url: string) => {
    const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`report download failed: HTTP ${response.status}`);
    const data = Buffer.from(await response.arrayBuffer());
    // Segments are gzip; a plain file is read as is.
    return (data[0] === 0x1f && data[1] === 0x8b ? gunzipSync(data) : data).toString("utf8");
  };
  const analytics = new AppAnalytics({ config, store, asc: analyticsAsc, fetchGz: analyticsFetch });
  // One Google service account for Play listings and Play Console's reports; its key file stays where it is.
  const googleAuth = config.aso ? new GoogleAuth((config.aso.googleKey ?? "~/.config/isobot/play-isobot-aso.json").replace(/^~(?=\/)/, homedir())) : null;
  const playPackages = () => asoApps(config).filter(a => a.store === "play").map(a => a.aso.appId);
  const playAnalytics = googleAuth && config.aso?.playReportsBucket
    ? new PlayAnalytics({ store, auth: googleAuth, bucket: config.aso.playReportsBucket, packages: playPackages })
    : null;
  const crashes = new CrashAudit({
    config, store, github,
    asc: analyticsAsc,
    fetchGz: analyticsFetch,
    requestId: appId => analytics.requestId(appId),
    google: googleAuth,
    notify: (text, reactions) => notifier.discord(text, reactions),
  });
  const playRollout = googleAuth && config.playRollout
    ? new PlayRollout({ config, store, google: googleAuth, notify: text => notifier.discord(text) })
    : null;
  const asoDiscord = env.discordBot ? new DiscordApi(env.discordBot.token) : null;
  let asoOwners: Promise<Set<string>> | null = null;
  const aso = new AsoTrain({
    config, store, github, notifier, repo: repoFor, tracker: asoClient(config, env.home),
    agent: input => builder.agentJson(input), analytics,
    play: googleAuth && playPackages().length ? new PlayPublisher(googleAuth) : undefined,
    playAnalytics: playAnalytics ?? undefined,
    // Only the staff chat's allowlist may approve; a failed lookup is retried on the next poll.
    approvals: asoDiscord ? {
      reactors: (channelId, messageId, emoji) => asoDiscord.reactors(channelId, messageId, emoji),
      owners: () => (asoOwners ??= chatAllowlist(asoDiscord).catch(error => { asoOwners = null; throw error; })),
    } : undefined,
    asc: async args => {
      const result = await run("asc", args, { cwd: env.home, env: workerEnv(), timeoutMs: 120_000 });
      return { ok: result.code === 0 && !result.timedOut, stdout: result.stdout, stderr: result.stderr };
    },
  });
  const prSweep = new PrSweep({
    config: config.prSweep, landLabel: config.labels.land, github, store,
    repos: () => configuredRepos(config).filter(r => policyFor(config, `${r.owner}/${r.repo}`).autonomy !== "off").map(r => `${r.owner}/${r.repo}`),
  });
  return { config, env, store, github, pipeline, sources, builder, notifier, checks, devices, repoFor, train, production, content, aso, analytics, playAnalytics, crashes, playRollout, prSweep, secrets, handoff };
}

/** ASO Tracker's CLI: one JSON call per tool; it starts the tracker's daemon itself when it isn't running. */
function asoClient(config: RunnerConfig, home: string): AsoClient {
  return {
    async call(tool, args, options = {}) {
      const config_ = config.aso;
      if (!config_) throw new Error("aso.cli isn't configured");
      const home_ = homedir();
      const expand = (v?: string) => v?.replace(/^~(?=\/)/, home_);
      const a = { ...config_, cli: expand(config_.cli)!, appBinary: expand(config_.appBinary), appPath: expand(config_.appPath) };
      const script = a.cli.endsWith(".mjs") || a.cli.endsWith(".js");
      const argv = [...(script ? [a.cli] : []), tool, JSON.stringify(args), ...(options.wait ? ["--wait"] : [])];
      const extra: Record<string, string> = {};
      if (a.appBinary) extra.ASO_APP_BINARY = a.appBinary;
      if (a.appPath) extra.ASO_APP_PATH = a.appPath;
      const result = await run(script ? process.execPath : a.cli, argv, { cwd: home, env: workerEnv(extra), timeoutMs: options.timeoutMs ?? 120_000, maxBytes: 4_000_000 });
      if (result.timedOut) throw new Error(`ASO Tracker ${tool} timed out`);
      const text = result.stdout.trim();
      let value: unknown = null;
      try { value = text ? JSON.parse(text) : null; } catch { /* reported below */ }
      const failed = (value as { ok?: unknown } | null)?.ok === false;
      if (result.code !== 0 || failed) {
        const reason = (value as { error?: unknown } | null)?.error ?? (result.stderr.trim() || text);
        throw new Error(`ASO Tracker ${tool}: ${String(reason).slice(0, 400)}`);
      }
      if (value === null && text) throw new Error(`ASO Tracker ${tool} printed something that isn't JSON`);
      return value;
    },
  };
}

/** `owner/repo#12`, or `repo#12` for a configured repository. */
function resolveIssue(config: RunnerConfig, target: string): { owner: string; repo: string; number: number } | null {
  const match = /^(?:([\w.-]+)\/)?([\w.-]+)#(\d+)$/.exec(target);
  if (!match) return null;
  const [, owner, repo, number] = match;
  if (owner) return { owner, repo, number: Number(number) };
  const found = configuredRepos(config).filter(r => r.repo.toLowerCase() === repo.toLowerCase());
  return found.length === 1 ? { ...found[0], number: Number(number) } : null;
}

function lowerKeys(map: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(map).map(([key, value]) => [key.toLowerCase(), value]));
}

const pausedFile = (env: Environment) => path.join(env.home, "paused");

function acquireLock(env: Environment): void {
  const file = path.join(env.home, "runner.lock");
  if (existsSync(file)) {
    const pid = Number(readFileSync(file, "utf8"));
    try {
      process.kill(pid, 0);
      throw new Error(`another runner is already running (pid ${pid})`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  writeFileSync(file, String(process.pid));
  process.on("exit", () => { try { if (readFileSync(file, "utf8") === String(process.pid)) rmSync(file); } catch { /* gone */ } });
}

/** How often the content train looks for research, publishing and reports to do. */
const CONTENT_EVERY_MS = 5 * 60_000;
const ASO_EVERY_MS = 60 * 60_000;
const ASO_POLL_MS = 5 * 60_000;
/** How often analytics looks for new reports; it reads App Store Connect at most every 6 hours itself. */
const ANALYTICS_EVERY_MS = 30 * 60_000;
/** How often the crash audit looks; it reads the stores at most every 6 hours itself. */
const CRASHES_EVERY_MS = 30 * 60_000;
/** How often the PR sweep looks; it sweeps every prSweep.everyHours itself. */
const PR_SWEEP_POLL_MS = 10 * 60_000;

/** A cycle running longer than this (release steps included) counts as hung for the external heartbeat. */
const HUNG_CYCLE_MS = 2 * 60 * 60_000;

async function loop(rt: Runtime): Promise<void> {
  acquireLock(rt.env);
  // Nothing is running yet: workspaces left behind are interrupted builds. Keep their work, then clear them.
  await rt.pipeline.recover();
  rmSync(path.join(rt.env.home, "work"), { recursive: true, force: true });
  removeDerivedData(path.join(rt.env.home, "work"));
  rmSync(path.join(rt.env.home, "mcp"), { recursive: true, force: true });
  await rt.devices.cleanupStale().catch(error => console.warn(`[devices] cleanup failed: ${(error as Error).message}`));
  const awake = new Awake();
  const logFile = path.join(rt.env.home, "logs", "runner.log");
  let lastTriageAt: string | null = null;
  let triageRunning = false;
  let lastCycleError: string | null = null;
  let lastAlert = 0;
  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[runner] ${signal}: stopping; interrupted builds pick up where they were on the next start`);
    rt.pipeline.beginShutdown();
    shuttingDown = true;
    killAllChildren();
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  let lastTriage = 0;
  let lastContent = 0;
  let contentRunning = false;
  let lastAso = 0;
  let asoRunning = false;
  let lastAsoPoll = 0;
  let asoPolling = false;
  let lastAnalytics = 0;
  let analyticsRunning = false;
  let lastCrashes = 0;
  let crashesRunning = false;
  let lastRollout = 0;
  let rolloutRunning = false;
  let lastPrPoll = 0;
  let prSweepRunning = false;
  let cycleStartedAt: number | null = null;
  if (rt.env.heartbeatUrl) {
    const url = rt.env.heartbeatUrl;
    // Its own timer, so a long release step inside a cycle doesn't silence it; a hung cycle still does.
    setInterval(() => {
      const hung = cycleStartedAt !== null && Date.now() - cycleStartedAt > HUNG_CYCLE_MS;
      if (!stopping && !lastCycleError && !hung) void pingHeartbeat(url);
    }, 60_000);
    void pingHeartbeat(url);
  }
  const chat = await startChat(rt, () => ({ activeJobs: rt.pipeline.activeJobs, lastCycleError, lastTriageAt, manuallyPaused: existsSync(pausedFile(rt.env)) }))
    .catch(error => { console.warn(`[chat] not started: ${(error as Error).message}`); return null; });
  process.once("exit", () => chat?.stop());
  const handoff = await startHandoff(rt).catch(error => { console.warn(`[handoff] not started: ${(error as Error).message}`); return null; });
  process.once("exit", () => handoff?.stop());
  const startedAt = new Date().toISOString();
  const schedule = (now: Date): ScheduleItem[] => {
    const items: ScheduleItem[] = [
      every("triage", "Triage", rt.config.triageMinutes * 60_000, lastTriage, triageRunning, `sources: ${rt.sources.map(s => s.name).join(", ")}`),
    ];
    const sites = contentRepos(rt.config);
    if (sites.length) {
      const limits = rt.config.content;
      const [from, to] = limits?.hours ?? [6, 22];
      const weekday = limits?.reportWeekday === undefined ? 1 : limits.reportWeekday;
      items.push(every("content", "Content train", CONTENT_EVERY_MS, lastContent, contentRunning,
        `${sites.map(s => s.repo).join(", ")}; research ${from}:00–${to}:00`));
      if (weekday !== null) items.push({ id: "content-report", name: "Search report", cadence: `weekly, ${WEEKDAYS[weekday]}`,
        lastAt: null, nextAt: nextWeeklyAt(now, weekday, from).toISOString(), running: false, detail: "Search Console report per site" });
    }
    const apps = asoApps(rt.config);
    if (apps.length) {
      const limits = rt.config.aso;
      const weekday = limits?.reportWeekday === undefined ? 1 : limits.reportWeekday;
      items.push(every("aso", "ASO train", ASO_EVERY_MS, lastAso, asoRunning, `${apps.map(a => a.repo).join(", ")}; daily ranks, weekly proposals`));
      items.push(every("aso-poll", "ASO approvals", ASO_POLL_MS, lastAsoPoll, asoPolling, "✅ on proposals, listings waiting for a version"));
      if (weekday !== null) items.push({ id: "aso-report", name: "ASO rank report", cadence: `weekly, ${WEEKDAYS[weekday]}`,
        lastAt: null, nextAt: nextWeeklyAt(now, weekday, (limits?.hours ?? [8, 22])[0]).toISOString(), running: false });
    }
    if (rt.analytics.apps().length) items.push(every("analytics", "App Store analytics", ANALYTICS_EVERY_MS, lastAnalytics, analyticsRunning));
    if (rt.crashes.enabled()) items.push(every("crashes", "Crash audit", CRASHES_EVERY_MS, lastCrashes, crashesRunning,
      `${rt.crashes.playApps().length} Play, ${rt.crashes.iosApps().length} App Store apps; stores read every 6 h`));
    if (rt.playRollout?.enabled()) items.push(every("play-rollout", "Play rollouts", CRASHES_EVERY_MS, lastRollout, rolloutRunning,
      `${rt.playRollout.apps().length} Play apps; production checked every 3 h`));
    if (rt.prSweep.enabled()) {
      const last = rt.prSweep.latest()?.at ?? null;
      items.push({ id: "pr-sweep", name: "PR sweep", cadence: `every ${rt.prSweep.everyMs() / 3_600_000} h`, lastAt: last,
        nextAt: last ? new Date(Date.parse(last) + rt.prSweep.everyMs()).toISOString() : null, running: prSweepRunning,
        detail: "every open PR: what to merge, what to land, release PRs a newer release replaced" });
    }
    const checkInHour = rt.config.chat?.checkInHour;
    if (chat && typeof checkInHour === "number") items.push({ id: "check-in", name: "Daily check-in", cadence: `daily at ${String(checkInHour).padStart(2, "0")}:00`,
      lastAt: null, nextAt: nextDailyAt(now, checkInHour).toISOString(), running: false, detail: "staff channel" });
    for (const key of Object.keys(rt.config.repos)) {
      const train = policyFor(rt.config, key).train;
      if (!train || policyFor(rt.config, key).autonomy === "off") continue;
      const last = rt.store.cursor(`train:${key}:last`.toLowerCase());
      const pending = rt.store.cursor(`train:${key}:pending`.toLowerCase());
      items.push({ id: `train:${key}`, name: `Release train · ${key.split("/")[1]}`, cadence: `at most every ${train.everyHours} h`,
        lastAt: last, nextAt: last ? new Date(Date.parse(last) + train.everyHours * 3_600_000).toISOString() : null,
        running: Boolean(pending), detail: `${train.testflight ? "TestFlight" : "App Store"}${pending ? "; a train is under way" : "; leaves when merged work is waiting"}` });
      if (train.production && train.testflight) {
        const p = productionSettings(train);
        const releasing = rt.store.cursor(`train:${key}:production-pending`.toLowerCase());
        items.push({ id: `production:${key}`, name: `App Store release · ${key.split("/")[1]}`,
          cadence: `weekly, ${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][p.weekday]} ${String(p.hour).padStart(2, "0")}:00`,
          lastAt: rt.store.cursor(`train:${key}:production-last`.toLowerCase()), nextAt: nextSlot(now, p.weekday, p.hour).toISOString(),
          running: Boolean(releasing), detail: `newest TestFlight build with testers ${p.minBetaHours} h+; 7-day phased release${releasing ? "; a release is under way" : ""}` });
      }
    }
    return items;
  };
  const board = rt.env.board ? new Dashboard({
    url: rt.env.board.url, token: rt.env.board.token, runnerId: rt.env.runnerId, store: rt.store, github: rt.github,
    repos: () => Object.keys(rt.config.repos).map(name => {
      const policy = policyFor(rt.config, name);
      return { name, autonomy: policy.autonomy, ownerAutonomy: policy.ownerAutonomy ?? policy.autonomy,
        train: Boolean(policy.train), content: Boolean(policy.content), aso: Boolean(policy.aso) };
    }).filter(repo => repo.autonomy !== "off"),
    schedule,
    live: () => ({ startedAt, activeJobs: rt.pipeline.activeJobs, manuallyPaused: existsSync(pausedFile(rt.env)), lastTriageAt, lastCycleError }),
    queued: () => rt.store.inState("queued").length,
    metrics: now => buildMetrics(rt.config, rt.store, now),
    act: action => runBoardAction(action, {
      labels: rt.config.labels, repos: () => configuredRepos(rt.config).map(r => `${r.owner}/${r.repo}`), github: rt.github,
      event: (jobId, text) => rt.store.event(jobId, "board_action", text),
    }),
  }) : null;
  board?.start();
  console.log(`[runner] started: ${configuredRepos(rt.config).map(r => `${r.owner}/${r.repo}`).join(", ")}; sources: ${rt.sources.map(s => s.name).join(", ")}`);
  await rt.notifier.discord("🟢 isobot runner started", [], { handoff: false });
  while (!stopping) {
    const manuallyPaused = existsSync(pausedFile(rt.env));
    if (!manuallyPaused) {
      cycleStartedAt = Date.now();
      try {
        await rt.pipeline.discover();
        rt.pipeline.startQueued();
        await rt.pipeline.followUp();
        await rt.pipeline.cleanUp();
        await rt.train.tick();
        await rt.production.tick();
        lastCycleError = null;
        if (!contentRunning && Date.now() - lastContent > CONTENT_EVERY_MS && contentRepos(rt.config).length) {
          lastContent = Date.now();
          contentRunning = true;
          // Research takes minutes: like triage it runs beside the cycle, one pass at a time.
          void rt.content.tick().catch(error => console.warn(`[content] failed: ${(error as Error).message}`))
            .finally(() => { contentRunning = false; });
        }
        if (!asoRunning && Date.now() - lastAso > ASO_EVERY_MS && asoApps(rt.config).length) {
          lastAso = Date.now();
          asoRunning = true;
          // Reading boards and research take minutes: beside the cycle, one pass at a time.
          void rt.aso.tick().catch(error => console.warn(`[aso] failed: ${(error as Error).message}`))
            .finally(() => { asoRunning = false; });
        }
        if (!asoPolling && Date.now() - lastAsoPoll > ASO_POLL_MS && asoApps(rt.config).length) {
          lastAsoPoll = Date.now();
          asoPolling = true;
          // Owners' ✅ on proposals, and approved listings waiting for an editable version.
          void rt.aso.poll().catch(error => console.warn(`[aso] poll failed: ${(error as Error).message}`))
            .finally(() => { asoPolling = false; });
        }
        if (!analyticsRunning && Date.now() - lastAnalytics > ANALYTICS_EVERY_MS && (rt.analytics.apps().length || rt.playAnalytics)) {
          lastAnalytics = Date.now();
          analyticsRunning = true;
          // Downloads take a while on a first backfill: beside the cycle, one pass at a time.
          // Each reads its store at most every 6 hours itself; Play's failures (a 403) are kept, not thrown.
          void (async () => {
            if (rt.analytics.apps().length) await rt.analytics.tick().catch(error => console.warn(`[analytics] failed: ${(error as Error).message}`));
            if (rt.playAnalytics) await rt.playAnalytics.tick().catch(error => console.warn(`[play-analytics] failed: ${(error as Error).message}`));
          })().finally(() => { analyticsRunning = false; });
        }
        if (!crashesRunning && Date.now() - lastCrashes > CRASHES_EVERY_MS && rt.crashes.enabled()) {
          lastCrashes = Date.now();
          crashesRunning = true;
          // Beside the cycle, one pass at a time; a source's failure is kept for the check-in, not thrown.
          void rt.crashes.tick().then(({ filed }) => { if (filed.length) console.log(`[crashes] opened ${filed.length} issue(s)`); })
            .catch(error => console.warn(`[crashes] failed: ${(error as Error).message}`))
            .finally(() => { crashesRunning = false; });
        }
        if (!rolloutRunning && Date.now() - lastRollout > CRASHES_EVERY_MS && rt.playRollout?.enabled()) {
          lastRollout = Date.now();
          rolloutRunning = true;
          // Reads Play at most every 3 hours itself; a failure is posted once and retried, never thrown.
          void rt.playRollout.tick().catch(error => console.warn(`[rollout] failed: ${(error as Error).message}`))
            .finally(() => { rolloutRunning = false; });
        }
        if (!prSweepRunning && Date.now() - lastPrPoll > PR_SWEEP_POLL_MS && rt.prSweep.enabled()) {
          lastPrPoll = Date.now();
          prSweepRunning = true;
          // A few GraphQL reads per repo; beside the cycle, one pass at a time. It never merges or pushes.
          void rt.prSweep.tick().then(result => {
            if (result) console.log(`[pr-sweep] ${result.pulls.length} open PRs, ${result.pulls.filter(p => p.action).length} need you, ${result.closed.length} closed`);
          }).catch(error => console.warn(`[pr-sweep] failed: ${(error as Error).message}`))
            .finally(() => { prSweepRunning = false; });
        }
        if (!triageRunning && Date.now() - lastTriage > rt.config.triageMinutes * 60_000) {
          lastTriage = Date.now();
          triageRunning = true;
          // Triage runs in the background so a slow pass never delays builds; one pass at a time.
          void triage(rt).then(report => {
            lastTriageAt = new Date().toISOString();
            if (report.items) console.log(`[triage] ${report.items} items, ${report.proposals.length} proposals`);
          }).catch(error => console.warn(`[triage] failed: ${(error as Error).message}`))
            .finally(() => { triageRunning = false; });
        }
      } catch (error) {
        lastCycleError = (error as Error).message;
        console.error("[runner] cycle failed:", lastCycleError);
        // At most one alert an hour for a repeating cycle failure.
        if (Date.now() - lastAlert > 60 * 60_000) {
          lastAlert = Date.now();
          await rt.notifier.discord(`⚠️ isobot runner cycle failing: ${lastCycleError.slice(0, 300)}`);
        }
      }
      cycleStartedAt = null;
    }
    awake.update(rt.pipeline.activeJobs.length > 0);
    try { rotateLog(logFile); } catch { /* logging must never stop the runner */ }
    try {
      writeHeartbeat(rt.env.home, {
        at: new Date().toISOString(), pid: process.pid, activeJobs: rt.pipeline.activeJobs,
        queued: rt.store.inState("queued").length, buildsPausedUntil: rt.store.pausedUntil(),
        manuallyPaused, lastTriageAt, lastCycleError,
      });
    } catch (error) {
      console.warn("[runner] heartbeat failed:", (error as Error).message);
    }
    board?.tick();
    await sleep(rt.config.pollSeconds * 1000);
  }
}

/** Herdr handoff: needs the bot (to add and read 💻) and the Herdr CLI; config can switch it off. */
function handoffEnabled(config: RunnerConfig, env: Environment): boolean {
  if (!env.discordBot || config.handoff?.enabled === false) return false;
  return Boolean(onPath(config.handoff?.herdrBin ?? "herdr"));
}

function onPath(bin: string): string | null {
  if (bin.includes("/")) return existsSync(bin) ? bin : null;
  for (const dir of (process.env.PATH ?? "").split(":")) if (dir && existsSync(path.join(dir, bin))) return path.join(dir, bin);
  return null;
}

/** Polls for 💻 on isobot's messages and opens the conversation in the owner's Herdr. */
async function startHandoff(rt: Runtime): Promise<Handoff | null> {
  if (!rt.handoff || !rt.env.discordBot) return null;
  const discord = new DiscordApi(rt.env.discordBot.token);
  const [me, allowed, channel] = await Promise.all([
    discord.request<{ id: string }>("GET", "/users/@me"), chatAllowlist(discord),
    discord.request<{ guild_id?: string }>("GET", `/channels/${rt.env.discordBot.channelId}`),
  ]);
  if (allowed.size === 0) throw new Error("nobody is allowed (set ISOBOT_CHAT_USERS)");
  const h = rt.config.handoff ?? {};
  const cwd = (h.cwd ?? "~/dev").replace(/^~(?=$|\/)/, homedir());
  const handoff = new Handoff({
    discord, watch: rt.handoff, botId: me.id, allowed, store: rt.store, guildId: channel.guild_id,
    herdr: new Herdr({ bin: h.herdrBin, workspace: h.workspace, exists: existsSync }),
    repos: configuredRepos(rt.config).map(r => `${r.owner}/${r.repo}`),
    workspaceFor: job => {
      if (!job.branch) return null;
      const dir = rt.repoFor(job.owner, job.repo).workspacePath(job.branch);
      return existsSync(path.join(dir, ".git")) ? dir : null;
    },
    fallbackCwd: existsSync(cwd) ? cwd : homedir(),
  });
  void handoff.run();
  console.log(`[handoff] ${HANDOFF} opens conversations in Herdr for ${allowed.size} user(s)`);
  return handoff;
}

/** Starts the staff chat when the bot is configured and chat isn't switched off. */
async function startChat(rt: Runtime, live: () => LiveStatus): Promise<StaffChat | null> {
  if (!rt.env.discordBot || rt.config.chat?.enabled === false) return null;
  const discord = new DiscordApi(rt.env.discordBot.token);
  const channelId = rt.env.chatChannelId ?? rt.env.discordBot.channelId;
  const [me, allowed, channel] = await Promise.all([
    discord.request<{ id: string }>("GET", "/users/@me"), chatAllowlist(discord),
    discord.request<{ guild_id?: string }>("GET", `/channels/${channelId}`),
  ]);
  if (allowed.size === 0) throw new Error("nobody is allowed to chat (set ISOBOT_CHAT_USERS)");
  const chatDir = path.join(rt.env.home, "chat");
  mkdirSync(chatDir, { recursive: true });
  const server = new ChatToolServer();
  await server.start();
  const config = rt.config.chat ?? {};
  const chat = new StaffChat({
    discord, channelId, guildId: channel.guild_id, botId: me.id, allowed, store: rt.store, server, config, handoff: rt.handoff,
    model: claudeChatModel({ bin: rt.env.claudeBin, config, chatDir, settingsJson: JSON.stringify(builderSettings({}, { secrets: rt.secrets, noWrite: [] })) }),
    tools: {
      config: rt.config, store: rt.store, github: rt.github, home: rt.env.home, chatDir, live,
      // Checkouts go under the chat's directory, the only place its Read tool can reach.
      repoFor: (owner, repo) => new Repo(rt.env.home, owner, repo, rt.env.githubToken, undefined, path.join(chatDir, "checkouts")),
      setPaused: paused => paused ? writeFileSync(pausedFile(rt.env), new Date().toISOString()) : rmSync(pausedFile(rt.env), { force: true }),
      card: id => rt.notifier.card({ id }),
      analytics: rt.analytics,
      crashes: rt.crashes.enabled() ? rt.crashes : undefined,
      playRatings: rt.playAnalytics ?? undefined,
      ...(channel.guild_id ? { discord: { api: discord, guildId: channel.guild_id, webhookDir: path.join(rt.env.home, "webhooks") } } : {}),
      asc: async (args, { readOnly }) => {
        const result = await run("asc", args, {
          cwd: chatDir, env: workerEnv(readOnly ? { ASC_READ_ONLY: "1" } : {}), timeoutMs: (readOnly ? 3 : 15) * 60_000, maxBytes: 400_000,
        });
        return { ok: result.code === 0 && !result.timedOut, output: `${result.stdout}\n${result.stderr}`.trim() };
      },
    },
  });
  void chat.run();
  console.log(`[chat] listening for ${allowed.size} user(s): answers in channel ${channelId}, mentions from anywhere in the server`);
  return chat;
}

/** `cloud-smoke`: every cloud-build step for real, against a throwaway clone and branch. Nothing is pushed. */
async function cloudSmoke(rt: Runtime, owner: string, name: string, withChecks: boolean): Promise<boolean> {
  const home = mkdtempSync(path.join(tmpdir(), "isobot-cloud-smoke-"));
  const cloud = cloudExecutor(rt.config, rt.env, (o, r) => new Repo(home, o, r, rt.env.githubToken))!;
  const repo = cloud.repo(owner, name);
  const branch = `isobot/smoke-${Date.now()}`;
  const step = (label: string) => console.log(`[cloud-smoke] ${new Date().toISOString().slice(11, 19)} ${label}`);
  try {
    step(`syncing ${owner}/${name}`);
    const main = await repo.sync(await rt.github.defaultBranch(owner, name));
    step(`creating the sandbox workspace for ${branch}`);
    const dir = await repo.createWorkspace(branch, main);
    step("running Claude Code in the sandbox");
    const run = await cloud.builder.implement({
      cwd: dir, sessionId: randomUUID(),
      task: "This is a smoke test of isobot's cloud builds. Create a file named ISOBOT_SMOKE.md at the repository root containing exactly the line `cloud build smoke test`, commit it, and reply with a one-sentence summary. Change nothing else.",
    });
    step(`builder ${run.ok ? "finished" : "failed"}: ${(run.summary || run.error || "").slice(0, 300)}`);
    // Like a build: the commit is taken before checks run, so their output never lands in it.
    await repo.commitPending(dir, "WIP: smoke test");
    const sha = await repo.capture(dir, branch);
    if (withChecks) {
      const policy = policyFor(rt.config, `${owner}/${name}`);
      const commands = policy.content?.checks ?? policy.checks;
      step(`running ${commands.length} check(s) in the sandbox`);
      const report = await cloud.checks(dir, commands, {});
      for (const result of report.results) step(`${result.ok ? "✅" : "❌"} ${result.command}${result.ok ? "" : `\n${result.output.slice(-1500)}`}`);
      if (!report.passed) return false;
    }
    const diff = await repo.diffStat(main, sha);
    step(`captured ${sha.slice(0, 12)}: ${await repo.ahead(main, sha)} commit(s), files ${diff.files.map(f => f.path).join(", ") || "(none)"}`);
    return run.ok && diff.files.some(f => f.path === "ISOBOT_SMOKE.md");
  } catch (error) {
    step(`failed: ${(error as Error).message}`);
    return false;
  } finally {
    await repo.removeWorkspace(branch).catch(error => step(`couldn't remove the sandbox: ${(error as Error).message}`));
    rmSync(home, { recursive: true, force: true });
  }
}

async function doctor(rt: Runtime): Promise<boolean> {
  let ok = true;
  const report = (good: boolean, label: string, detail = "") => {
    if (!good) ok = false;
    console.log(`${good ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  };
  const auth = await run(rt.env.claudeBin, ["auth", "status"], { cwd: rt.env.home, timeoutMs: 30_000 }).catch(error => ({ code: 1, stdout: String(error), stderr: "", timedOut: false }));
  const method = /"authMethod":\s*"([^"]+)"/.exec(auth.stdout)?.[1];
  report(auth.code === 0 && /"loggedIn":\s*true/.test(auth.stdout), "Claude Code signed in", method ? `auth method ${method}` : auth.stdout.slice(0, 200));
  const cloud = cloudRepos(rt.config);
  if (cloud.length && !rt.env.sandbox) report(false, `Cloud builds for ${cloud.join(", ")}`, "set ISOBOT_SANDBOX_URL and ISOBOT_SANDBOX_TOKEN");
  else if (rt.env.sandbox) {
    const health = await fetch(`${rt.env.sandbox.url}/health`, { signal: AbortSignal.timeout(20_000) }).catch(() => null);
    const authed = await new HttpSandboxApi(rt.env.sandbox.url, rt.env.sandbox.token).status("doctor").then(() => true, (error: Error) => error);
    report(Boolean(health?.ok) && authed === true, "Cloud build sandbox", authed === true
      ? `${rt.env.sandbox.url}; builds there: ${cloud.join(", ") || "none yet (set executor: \"cloudflare\")"}`
      : health?.ok ? (authed as Error).message : `${rt.env.sandbox.url} unreachable`);
    await health?.body?.cancel();
  }
  if (process.env.ANTHROPIC_API_KEY) console.log("ℹ️  ANTHROPIC_API_KEY is set in the runner's environment; builders never receive it, so they use the subscription login.");
  for (const { owner, repo } of configuredRepos(rt.config)) {
    try {
      const branch = await rt.github.defaultBranch(owner, repo);
      report(true, `GitHub ${owner}/${repo}`, `default branch ${branch}`);
    } catch (error) {
      report(false, `GitHub ${owner}/${repo}`, (error as Error).message);
    }
  }
  if (rt.env.piUrl && rt.env.piToken) {
    const response = await fetch(`${rt.env.piUrl}/api/discord/channels`, { headers: { Authorization: `Bearer ${rt.env.piToken}` }, signal: AbortSignal.timeout(30_000) }).catch(() => null);
    report(Boolean(response?.ok), "Discord history through Pi", response ? `HTTP ${response.status}` : "unreachable");
    await response?.body?.cancel();
  } else console.log("➖ Discord triage disabled (set ISOBOT_PI_URL and ISOBOT_PI_TOKEN)");
  if (rt.env.piUrl && rt.env.piToken && rt.config.vox) {
    const query = new URLSearchParams({ conversation: rt.config.vox.conversation, limit: "1" });
    const response = await fetch(`${rt.env.piUrl}/api/notes?${query}`, { headers: { Authorization: `Bearer ${rt.env.piToken}` }, signal: AbortSignal.timeout(30_000) }).catch(() => null);
    report(Boolean(response?.ok), `Vox.md notes through Pi (conversation "${rt.config.vox.conversation}")`,
      `${response ? `HTTP ${response.status}` : "unreachable"}; ${rt.config.vox.autoApprove ? "auto-approves confident proposals" : "proposals wait for approval"}`);
    await response?.body?.cancel();
  } else console.log("➖ Vox.md triage disabled (set vox in the runner config, plus ISOBOT_PI_URL and ISOBOT_PI_TOKEN)");
  if (rt.config.appStore) {
    const [app] = Object.keys(rt.config.appStore.apps);
    const response = await fetch(`https://itunes.apple.com/us/rss/customerreviews/page=1/id=${app}/sortby=mostrecent/json`, { signal: AbortSignal.timeout(20_000) }).catch(() => null);
    await response?.body?.cancel();
    report(Boolean(response?.ok), `App Store reviews for ${Object.keys(rt.config.appStore.apps).length} apps in ${rt.config.appStore.countries.length} storefronts`, response ? `HTTP ${response.status}` : "unreachable");
  } else console.log("➖ App Store review triage disabled (set appStore in the runner config)");
  if (rt.env.imap.length === 0) console.log("➖ Email triage disabled (runner/scripts/add-mail-account.sh <address>)");
  for (const account of rt.env.imap) {
    const client = new ImapFlow({ host: account.host, port: account.port, secure: true, logger: false, auth: { user: account.user, pass: account.password } });
    const ok = await client.connect().then(() => client.mailboxOpen(account.mailbox, { readOnly: true })).then(() => true, (error: Error) => error);
    await client.logout().catch(() => undefined);
    report(ok === true, `Email ${account.user} (${account.mailbox}${account.query ? `, matching ${account.query}` : ""})`, ok === true ? "signed in" : (ok as Error).message);
  }
  if (rt.env.discordBot) {
    const response = await fetch(`https://discord.com/api/v10/channels/${rt.env.discordBot.channelId}`, {
      headers: { Authorization: `Bot ${rt.env.discordBot.token}` }, signal: AbortSignal.timeout(15_000),
    }).catch(() => null);
    const channel = response?.ok ? await response.json() as { name?: string } : null;
    report(Boolean(channel), "Discord job cards and threads", channel ? `#${channel.name}` : response ? `HTTP ${response.status}: the bot needs View Channel, Send Messages, Create Public Threads and Send Messages in Threads` : "unreachable");
  } else console.log(rt.env.discordWebhookUrl ? "➖ Discord notifications through a webhook (set ISOBOT_DISCORD_BOT_TOKEN and ISOBOT_DISCORD_CHANNEL_ID for job threads)" : "➖ Discord notifications disabled");
  if (rt.env.discordBot && rt.config.chat?.enabled !== false) {
    const allowed = await chatAllowlist(new DiscordApi(rt.env.discordBot.token)).catch((error: Error) => error);
    report(allowed instanceof Set && allowed.size > 0, "Staff chat",
      allowed instanceof Set ? `${allowed.size} user(s) may talk to isobot in channel ${rt.env.chatChannelId} (the bridge needs ISOBOT_CHAT_CHANNEL_ID set to it)` : allowed.message);
  } else console.log("➖ Staff chat off (needs ISOBOT_DISCORD_BOT_TOKEN and ISOBOT_DISCORD_CHANNEL_ID; chat.enabled false switches it off)");
  if (rt.handoff) {
    const herdr = await new Herdr({ bin: rt.config.handoff?.herdrBin }).workspaces().catch((error: Error) => error);
    report(Array.isArray(herdr), `Herdr handoff (${HANDOFF} on isobot's messages)`,
      Array.isArray(herdr) ? `${herdr.length} workspace(s); give the bot Manage Messages so a tap resets itself` : `${herdr.message} (is Herdr running?)`);
  } else console.log(`➖ Herdr handoff off (needs the Discord bot and the herdr CLI; handoff.enabled false switches it off)`);
  report(existsSync("/usr/bin/sandbox-exec"), "Check sandbox (sandbox-exec) available");
  if (rt.env.heartbeatUrl) {
    const pinged = await pingHeartbeat(rt.env.heartbeatUrl);
    report(pinged, "External heartbeat (ISOBOT_HEARTBEAT_URL)", pinged ? "pinged" : "the ping failed; check the URL");
  } else console.log("➖ External heartbeat disabled: nobody is told if this Mac goes down (set ISOBOT_HEARTBEAT_URL)");
  const beat = readHeartbeat(rt.env.home);
  const age = heartbeatAge(beat);
  if (age === null) console.log("➖ Runner heartbeat: none yet (service not started?)");
  else report(age < rt.config.pollSeconds * 3000, "Runner heartbeat", `${Math.round(age / 1000)}s ago${beat?.lastCycleError ? `, last error: ${beat.lastCycleError.slice(0, 120)}` : ""}`);
  const pausedUntil = rt.store.pausedUntil();
  if (pausedUntil) console.log(`⏸  Builds paused until ${pausedUntil} (Claude usage limit)`);
  console.log(`➖ State: ${rt.env.home}${existsSync(pausedFile(rt.env)) ? " (PAUSED)" : ""}`);
  return ok;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const HELP = `isobot runner

  run                 Loop forever: claim approved issues, build, review, merge, release, triage
  once                Claim and build whatever is approved right now, then exit
  triage              Run one triage pass over Discord, GitHub and email, then exit
  status              Show recent jobs
  setup               Create the isobot labels in every configured repository
  doctor              Check Claude Code, GitHub, Pi and optional sources
  pause | resume      Stop or restart new work (running builds finish)
  checks <repo>       Run a repo's configured checks on its default branch, sandboxed like a build
  say <repo#n> <text> Send isobot a note about a job, like replying in its Discord thread
  retry <repo#n> [note] Build an issue again (a failed or finished job, or a new one); the note goes to the builder
  inspect [repo#n] [--follow] [--json]
                      Timeline of what isobot did, across jobs or for one, and what it will check next
  grants [repo]       Who may approve, stop, merge, chat and hand off, and each repo's merge rules
  release <repo#n>    Run a merged job's release.onMerge again (one a restart interrupted, or that failed)
  cloud-smoke <repo> [--checks]
                      One real build in a Cloudflare build sandbox: clone, Claude Code, optionally the
                      site's content checks, and the commit back into a throwaway clone. Never pushes
  content <repo> research [--dry-run] | report
                      Run a site's content research now (files an issue; --dry-run prints the brief instead)
                      or its weekly search report
  aso <repo | package> snapshot | report | research [--dry-run]
                      Read an app's ASO Tracker board into today's snapshot, post its weekly rank report,
                      or research a listing proposal now (--dry-run measures it but posts and records nothing)
  aso <repo> pending | approve | reject | apply
                      Show the latest proposal's apply state, approve or dismiss it (like ✅ / 🛑 in Discord),
                      or write an approved one to App Store Connect now (e.g. right after creating a version).
                      A repo's Google Play app is named by its package (e.g. aso md.vox.android research)
  analytics play [sync | ratings]
                      Read Play Console's bulk reports now (sync), print each Play app's ratings (ratings),
                      or print each Play app's week and the reports' status
  analytics [sync | checkin | <app> [days]]
                      Download new App Store analytics reports now, print the check-in's App Store section,
                      or print an app's daily numbers (default: every app's last 7 days)
  play rollout [run | resume <package>]
                      Print what the Play rollout train would do with each staged production rollout (default),
                      do it now (run), or resume a rollout it halted, accepting the crashes it halted for (resume)
  crashes [sync | checkin]
                      Read Google Play, App Store and TestFlight crashes now and open issues for new ones (sync),
                      or print the check-in's crash section (checkin, the default)`;

async function main(): Promise<void> {
  const command = process.argv[2] ?? "help";
  if (command === "help" || command === "--help") return console.log(HELP);
  const rt = runtime();
  switch (command) {
    case "run":
      return loop(rt);
    case "once": {
      acquireLock(rt.env);
      await rt.pipeline.recover();
      const claimed = await rt.pipeline.discover();
      console.log(`[once] claimed ${claimed.length} issue(s)`);
      await Promise.all(rt.pipeline.startQueued());
      await rt.pipeline.followUp();
      await rt.pipeline.settled();
      await rt.pipeline.cleanUp();
      return;
    }
    case "triage": {
      acquireLock(rt.env);
      const report = await triage(rt);
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    case "status": {
      const beat = readHeartbeat(rt.env.home);
      const age = heartbeatAge(beat);
      console.log(age === null ? "runner: no heartbeat (not running?)"
        : `runner: ${age < rt.config.pollSeconds * 3000 ? "alive" : "STALE"} (heartbeat ${Math.round(age / 1000)}s ago)` +
          `${beat!.activeJobs.length ? `, building ${beat!.activeJobs.join(", ")}` : ""}${beat!.queued ? `, ${beat!.queued} queued` : ""}` +
          `${beat!.manuallyPaused ? ", PAUSED" : ""}${rt.store.pausedUntil() ? `, usage-limit pause until ${rt.store.pausedUntil()}` : ""}`);
      for (const job of rt.store.all(30)) {
        console.log(`${job.updatedAt.slice(0, 16)}  ${job.state.padEnd(13)} ${job.id}  ${job.title}${job.prNumber ? `  PR #${job.prNumber}` : ""}${job.notBefore && job.state === "queued" ? `  (retry after ${job.notBefore.slice(11, 16)})` : ""}${job.lastError ? `\n      ↳ ${job.lastError.split("\n")[0].slice(0, 160)}` : ""}`);
      }
      const pending = followUpLines(rt.store.followUps());
      if (pending.length) console.log(`\nFollow-ups:\n${pending.map(line => `  ${line}`).join("\n")}`);
      return;
    }
    case "setup":
      for (const { owner, repo } of configuredRepos(rt.config)) {
        await rt.github.ensureLabels(owner, repo, rt.config.labels);
        console.log(`labels ready in ${owner}/${repo}`);
      }
      return;
    case "doctor":
      if (!await doctor(rt)) process.exitCode = 1;
      return;
    case "pause":
      writeFileSync(pausedFile(rt.env), new Date().toISOString());
      return console.log("paused: no new work will start");
    case "resume":
      rmSync(pausedFile(rt.env), { force: true });
      return console.log("resumed");
    case "checks": {
      // Runs a repo's configured checks on its default branch, in the same sandbox builds use.
      const ref = process.argv[3] && resolveIssue(rt.config, `${process.argv[3]}#1`);
      if (!ref) {
        console.error("Usage: checks <owner/repo | repo>");
        process.exitCode = 2;
        return;
      }
      const policy = policyFor(rt.config, `${ref.owner}/${ref.repo}`);
      if (policy.checks.length === 0) return console.log(`${ref.owner}/${ref.repo} has no checks configured`);
      const repo = rt.repoFor(ref.owner, ref.repo);
      const sha = await repo.sync(await rt.github.defaultBranch(ref.owner, ref.repo));
      const dir = await repo.checkoutAt(sha, `checks__${Date.now()}`);
      const started = Date.now();
      let lease: Awaited<ReturnType<LocalDevices["lease"]>> | null = null;
      try {
        if (hasDevices(policy.devices)) {
          console.log("Booting test devices…");
          lease = await rt.devices.lease(`checks-${Date.now()}`, policy.devices);
          console.log(lease.describe());
        }
        const report = await rt.checks(dir, policy.checks, { sandbox: true, env: lease?.env });
        for (const r of report.results) console.log(`${r.ok ? "✅" : "❌"} ${r.command}${r.ok ? "" : `\n${r.output}`}`);
        console.log(`${report.passed ? "PASS" : "FAIL"} in ${Math.round((Date.now() - started) / 1000)}s at ${sha.slice(0, 8)}`);
        if (!report.passed) process.exitCode = 1;
      } finally {
        await lease?.release();
        await repo.removeWorkspace(path.basename(dir)).catch(() => undefined);
      }
      return;
    }
    case "say": {
      const [target, ...words] = process.argv.slice(3);
      const ref = target && resolveIssue(rt.config, target);
      const text = words.join(" ").trim();
      if (!ref || !text) {
        console.error("Usage: say <owner/repo#n | repo#n> <text>");
        process.exitCode = 2;
        return;
      }
      const url = await rt.github.note(ref.owner, ref.repo, ref.number, `${text}\n\n${TERMINAL_MARKER}`);
      const job = rt.store.get(Store.jobId(ref.owner, ref.repo, ref.number));
      console.log(`noted on ${url}${job ? ` (job is ${job.state.replace("_", " ")}; the runner picks it up on its next pass)` : " (no isobot job for this issue yet)"}`);
      return;
    }
    case "retry": {
      const [target, ...words] = process.argv.slice(3);
      const ref = target && resolveIssue(rt.config, target);
      if (!ref) {
        console.error("Usage: retry <owner/repo#n | repo#n> [note for the builder]");
        process.exitCode = 2;
        return;
      }
      const result = await rt.pipeline.rebuild(ref.owner, ref.repo, ref.number);
      if (result.ok && words.join(" ").trim()) {
        await rt.github.note(ref.owner, ref.repo, ref.number, `${words.join(" ").trim()}\n\n${TERMINAL_MARKER}`);
      }
      console.log(result.message);
      if (!result.ok) process.exitCode = 1;
      return;
    }
    case "inspect": {
      const args = process.argv.slice(3);
      const target = args.find(a => !a.startsWith("--"));
      const ref = target ? resolveIssue(rt.config, target) : null;
      if (target && !ref) {
        console.error("Usage: inspect [owner/repo#n | repo#n] [--follow] [--json]");
        process.exitCode = 2;
        return;
      }
      await inspect(rt.store, {
        jobId: ref ? Store.jobId(ref.owner, ref.repo, ref.number) : undefined,
        follow: args.includes("--follow") || args.includes("-f"), json: args.includes("--json"),
      });
      return;
    }
    case "grants": {
      const target = process.argv[3];
      const ref = target ? resolveIssue(rt.config, `${target}#1`) : null;
      const chatEnv = process.env.ISOBOT_CHAT_USERS ? "ISOBOT_CHAT_USERS" : process.env.ISOBOT_ALLOWED_USERS ? "ISOBOT_ALLOWED_USERS" : null;
      const ids = (process.env.ISOBOT_CHAT_USERS || process.env.ISOBOT_ALLOWED_USERS || "").split(",").map(s => s.trim()).filter(Boolean);
      console.log(explainGrants({
        config: rt.config, viewer: await rt.github.viewer(), runnerId: rt.env.runnerId,
        chatUsers: { ids, source: chatEnv ?? "The Discord bot's owner (ISOBOT_CHAT_USERS and ISOBOT_ALLOWED_USERS are unset)" },
        repo: ref ? `${ref.owner}/${ref.repo}` : target,
      }));
      return;
    }
    case "release": {
      const ref = process.argv[3] && resolveIssue(rt.config, process.argv[3]);
      if (!ref) {
        console.error("Usage: release <owner/repo#n | repo#n>");
        process.exitCode = 2;
        return;
      }
      // Only recorded here: the running runner does the release, so it never runs twice at once.
      const result = await rt.pipeline.requestRelease(ref.owner, ref.repo, ref.number);
      console.log(result.message);
      if (!result.ok) process.exitCode = 1;
      return;
    }
    case "cloud-smoke": {
      const [target, flag] = process.argv.slice(3);
      const ref = target && resolveIssue(rt.config, `${target}#1`);
      if (!ref || !rt.env.sandbox) {
        console.error(ref ? "Set ISOBOT_SANDBOX_URL and ISOBOT_SANDBOX_TOKEN first" : "Usage: cloud-smoke <owner/repo | repo> [--checks]");
        process.exitCode = 2;
        return;
      }
      process.exitCode = await cloudSmoke(rt, ref.owner, ref.repo, flag === "--checks") ? 0 : 1;
      return;
    }
    case "content": {
      const [target, what, flag] = process.argv.slice(3);
      const site = contentRepos(rt.config).find(s => target && [s.repo, `${s.owner}/${s.repo}`, s.content.site].some(n => n.toLowerCase() === target.toLowerCase()));
      if (!site || !["research", "report"].includes(what)) {
        console.error(`Usage: content <${contentRepos(rt.config).map(s => s.repo).join(" | ") || "repo"}> research [--dry-run] | report`);
        process.exitCode = 2;
        return;
      }
      if (what === "report") console.log(await rt.content.report(site, true) ?? "(no report)");
      else console.log(JSON.stringify(await rt.content.maybeResearch(site, true, flag === "--dry-run"), null, 2));
      return;
    }
    case "prs": {
      // `prs`: the last sweep. `prs preview`: sweep now and change nothing. `prs sweep`: sweep now (closes replaced releases).
      const what = process.argv[3] ?? "last";
      if (what === "preview" || what === "sweep") {
        console.log(formatSweep(await rt.prSweep.sweep(new Date(), what === "preview")));
        return;
      }
      const last = rt.prSweep.latest();
      console.log(last ? formatSweep(last) : "No sweep yet: run `prs preview` to see one without changing anything, or `prs sweep`.");
      return;
    }
    case "crashes": {
      const what = process.argv[3] ?? "checkin";
      if (!rt.crashes.enabled()) {
        console.error("The crash audit is off: add \"crashes\": {} (and appStore.apps or a Play app's aso.play) to the runner config.");
        process.exitCode = 2;
        return;
      }
      if (what === "sync") {
        const { filed } = await rt.crashes.tick(true);
        console.log(filed.length ? `Opened:\n${filed.join("\n")}` : "No new issues opened.");
      }
      const { lines, flags } = rt.crashes.checkIn();
      console.log([...flags, ...lines].join("\n") || "(no crashes recorded: run `crashes sync`)");
      return;
    }
    case "play": {
      const [what, action, pkg] = process.argv.slice(3);
      if (what !== "rollout") { console.error("usage: play rollout [run | resume <package>]"); process.exitCode = 2; return; }
      if (!rt.playRollout?.enabled()) {
        console.error("Play rollouts are off: add \"playRollout\": {} (and a Play app's aso.play, with aso.googleKey) to the runner config.");
        process.exitCode = 2;
        return;
      }
      if (action === "resume") {
        if (!pkg) { console.error("usage: play rollout resume <package>"); process.exitCode = 2; return; }
        console.log(await rt.playRollout.resume(pkg));
        return;
      }
      if (action === "run") {
        for (const [i, plan] of (await rt.playRollout.tick(true)).entries()) console.log(planText(rt.playRollout.apps()[i].pkg, plan));
        return;
      }
      // Read-only: what the next pass would do.
      for (const app of rt.playRollout.apps()) console.log(planText(app.pkg, await rt.playRollout.plan(app.pkg).catch(error => ({ action: "none" as const, why: `error: ${(error as Error).message}` }))));
      return;
    }
    case "analytics": {
      const [what, days] = process.argv.slice(3);
      if (what === "play") {
        if (!rt.playAnalytics) {
          console.error("Play analytics is off: set aso.playReportsBucket (and a Play app's aso.play) in the runner config.");
          process.exitCode = 2;
          return;
        }
        if (days === "sync") await rt.playAnalytics.tick(true);
        const status = rt.playAnalytics.status();
        if (status) console.log(`Not readable: ${status}`);
        if (days === "ratings") {
          // Read-only preview: low-rating flags are printed without being marked as posted.
          for (const pkg of asoApps(rt.config).filter(a => a.store === "play").map(a => a.aso.appId)) {
            const r = rt.playAnalytics.ratings(pkg);
            console.log(`${pkg}: ${r ? ratingsText(r) : "no ratings report from Play yet"}`);
          }
          return;
        }
        for (const pkg of asoApps(rt.config).filter(a => a.store === "play").map(a => a.aso.appId)) {
          console.log(`${pkg}: ${rt.playAnalytics.weekLine(pkg) ?? `(no week yet; latest day ${rt.playAnalytics.latest(pkg) ?? "none"})`}`);
        }
        return;
      }
      if (!rt.analytics.apps().length) {
        console.error("App Store analytics is off: add \"analytics\": {} (and appStore.apps) to the runner config.");
        process.exitCode = 2;
        return;
      }
      if (what === "sync") {
        for (const { appId, repo } of rt.analytics.apps()) console.log(`${repo}: ${await rt.analytics.sync(appId)} report instances read`);
      } else if (what === "checkin") {
        const { lines, flags } = rt.analytics.checkIn();
        console.log([...flags, ...lines].join("\n") || "(no analytics yet: run `analytics sync`)");
      } else {
        console.log(JSON.stringify(rt.analytics.describe(what ?? null, Number(days) || 14), null, 2));
      }
      return;
    }
    case "aso": {
      const [target, what, flag] = process.argv.slice(3);
      const app = asoApps(rt.config).find(a => target && [a.repo, `${a.owner}/${a.repo}`, a.aso.appId].some(n => n.toLowerCase() === target.toLowerCase()));
      if (!app || !["snapshot", "report", "research", "pending", "approve", "reject", "apply"].includes(what)) {
        console.error(`Usage: aso <${asoApps(rt.config).map(a => a.repo).join(" | ") || "repo"}> snapshot | report | research [--dry-run] | pending | approve | reject | apply`);
        process.exitCode = 2;
        return;
      }
      if (what === "snapshot") console.log(`${(await rt.aso.snapshot(app)).length} phrases read`);
      else if (what === "report") console.log(await rt.aso.report(app, true) ?? "(no report)");
      else if (what === "pending") console.log(JSON.stringify(rt.aso.pending(app), null, 2));
      else if (what === "approve") console.log(await rt.aso.approve(app, "cli"));
      else if (what === "reject") await rt.aso.reject(app, "cli");
      else if (what === "apply") console.log(await rt.aso.apply(app, "cli"));
      else {
        const result = await rt.aso.maybeResearch(app, true, flag === "--dry-run");
        console.log(result ? `${JSON.stringify(result.proposal, null, 2)}\n\n${result.message}` : "(nothing)");
      }
      return;
    }
    default:
      console.error(`Unknown command: ${command}\n\n${HELP}`);
      process.exitCode = 2;
  }
}

main().catch(error => {
  console.error("[runner] fatal:", error instanceof Error ? error.message : error);
  process.exit(1);
});
