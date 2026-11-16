#!/usr/bin/env node
import { ImapFlow } from "imapflow";
import { ReleaseTrain } from "./train.js";
import type { CheckReport } from "./policy.js";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeCodeBuilder } from "./builder.js";
import { configuredRepos, loadConfig, loadEnvironment, policyFor, type Environment, type RunnerConfig } from "./config.js";
import { Repo } from "./git.js";
import { GitHub } from "./github.js";
import { TERMINAL_MARKER } from "./notes.js";
import { Notifier } from "./notify.js";
import { Pipeline } from "./pipeline.js";
import { runChecks } from "./checks.js";
import { Awake, heartbeatAge, pingHeartbeat, readHeartbeat, rotateLog, writeHeartbeat } from "./ops.js";
import { killAllChildren, run, setGitIdentity, sh, workerEnv } from "./proc.js";
import { sandboxProfile } from "./sandbox.js";
import { ensureShims } from "./shims.js";
import { hasDevices, LocalDevices } from "./devices.js";
import { removeDerivedData } from "./cleanup.js";
import { Store } from "./store.js";
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
}

/** Set once the runner starts stopping; a release train interrupted by it resumes next start. */
let shuttingDown = false;

/** The isobot checkout running this code; builders must never modify it. */
const ISOBOT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function globalGit(key: string): string {
  try { return execFileSync("git", ["config", "--global", key], { encoding: "utf8" }).trim(); } catch { return ""; }
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
  const secrets = ["runner.env", "runner.sqlite", "runner.sqlite-wal", "runner.sqlite-shm", "logs", "runner.lock", "paused", "heartbeat.json"]
    .map(entry => path.join(env.home, entry)).concat(path.resolve(process.cwd(), ".env.runner"));
  const shimDir = ensureShims(env.home);
  const extraWrite = ((config.builder.settings?.sandbox as { filesystem?: { allowWrite?: string[] } } | undefined)?.filesystem?.allowWrite) ?? [];
  const mcpDir = path.join(env.home, "mcp");
  const shellTool = {
    configDir: mcpDir,
    profileFor: (cwd: string) => sandboxProfile({ workspace: cwd, secrets, allowWrite: extraWrite }),
    env: (extra: Record<string, string>) => workerEnv(extra) as Record<string, string>,
  };
  const builder = new ClaudeCodeBuilder(config.builder, { secrets, noWrite: [path.join(env.home, "repos"), shimDir, mcpDir, ISOBOT_ROOT] }, env.claudeBin, shimDir, shellTool);
  const devices = new LocalDevices(path.join(env.home, "logs", "devices"));
  const notifier = new Notifier({ webhookUrl: env.discordWebhookUrl, bot: env.discordBot, store, jobUrl: env.jobUrl });
  // Checks execute builder-written code, so they get the same confinement as the builder's shell.
  const checks = (cwd: string, commands: string[], options: { timeoutMs?: number; sandbox: boolean; env?: Record<string, string> }) => runChecks(cwd, commands, {
    timeoutMs: options.timeoutMs, env: options.env,
    sandboxProfile: options.sandbox ? sandboxProfile({ workspace: cwd, secrets, allowWrite: extraWrite }) : undefined,
    shimDir,
  });
  const repoFor = (owner: string, repo: string) => new Repo(env.home, owner, repo, env.githubToken);
  const pipeline = new Pipeline({ config, env, store, github, builder, notifier, repo: repoFor, checks, devices });
  const labels = Object.values(config.labels);
  const sources: Source[] = [new GitHubSource(github, configuredRepos(config), labels)];
  if (env.piUrl && env.piToken) sources.push(new DiscordSource(env.piUrl, env.piToken, lowerKeys(config.discordCategories)));
  if (env.piUrl && env.piToken && config.vox) sources.push(new VoxSource(env.piUrl, env.piToken, config.vox.conversation));
  for (const account of env.imap) sources.push(new EmailSource(account));
  if (config.appStore) sources.push(new AppStoreSource(config.appStore));
  const train = new ReleaseTrain({
    config, store, github, notifier, repo: repoFor,
    stopping: () => shuttingDown,
    run: async (cwd, command, timeoutMs) => {
      const result = await sh(command, { cwd, env: workerEnv(), timeoutMs });
      return { ok: result.code === 0 && !result.timedOut, output: `${result.stdout}\n${result.stderr}` };
    },
    appStatus: async appId => {
      const result = await run("asc", ["status", "--app", appId, "--output", "json"], { cwd: env.home, env: workerEnv(), timeoutMs: 120_000 });
      if (result.code !== 0) throw new Error(`asc status failed: ${(result.stderr || result.stdout).trim().slice(-300)}`);
      const status = JSON.parse(result.stdout) as { appstore?: { version?: string; state?: string } };
      return { version: status.appstore?.version ?? null, state: status.appstore?.state ?? null };
    },
  });
  return { config, env, store, github, pipeline, sources, builder, notifier, checks, devices, repoFor, train };
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

async function loop(rt: Runtime): Promise<void> {
  acquireLock(rt.env);
  rt.pipeline.recover();
  // Nothing is running yet, so any workspace left behind is from a crash.
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
    console.log(`[runner] ${signal}: stopping; interrupted builds restart from scratch next time`);
    rt.pipeline.beginShutdown();
    shuttingDown = true;
    killAllChildren();
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  let lastTriage = 0;
  console.log(`[runner] started: ${configuredRepos(rt.config).map(r => `${r.owner}/${r.repo}`).join(", ")}; sources: ${rt.sources.map(s => s.name).join(", ")}`);
  await rt.notifier.discord("🟢 isobot runner started");
  while (!stopping) {
    const manuallyPaused = existsSync(pausedFile(rt.env));
    if (!manuallyPaused) {
      try {
        await rt.pipeline.discover();
        rt.pipeline.startQueued();
        await rt.pipeline.followUp();
        await rt.train.tick();
        lastCycleError = null;
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
    }
    if (rt.env.heartbeatUrl && !lastCycleError) void pingHeartbeat(rt.env.heartbeatUrl);
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
    await sleep(rt.config.pollSeconds * 1000);
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
  say <repo#n> <text> Send isobot a note about a job, like replying in its Discord thread`;

async function main(): Promise<void> {
  const command = process.argv[2] ?? "help";
  if (command === "help" || command === "--help") return console.log(HELP);
  const rt = runtime();
  switch (command) {
    case "run":
      return loop(rt);
    case "once": {
      acquireLock(rt.env);
      rt.pipeline.recover();
      const claimed = await rt.pipeline.discover();
      console.log(`[once] claimed ${claimed.length} issue(s)`);
      await Promise.all(rt.pipeline.startQueued());
      await rt.pipeline.followUp();
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
    default:
      console.error(`Unknown command: ${command}\n\n${HELP}`);
      process.exitCode = 2;
  }
}

main().catch(error => {
  console.error("[runner] fatal:", error instanceof Error ? error.message : error);
  process.exit(1);
});
