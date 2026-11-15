#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ClaudeCodeBuilder } from "./builder.js";
import { configuredRepos, loadConfig, loadEnvironment, type Environment, type RunnerConfig } from "./config.js";
import { Repo } from "./git.js";
import { GitHub } from "./github.js";
import { Notifier } from "./notify.js";
import { Pipeline } from "./pipeline.js";
import { killAllChildren, run } from "./proc.js";
import { Store } from "./store.js";
import { DiscordSource, EmailSource, GitHubSource, triage, type Source } from "./triage.js";

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
}

function runtime(): Runtime {
  loadEnvFiles();
  const config = loadConfig();
  const env = loadEnvironment();
  mkdirSync(env.home, { recursive: true });
  const store = new Store(path.join(env.home, "runner.sqlite"));
  const github = new GitHub(env.githubToken);
  const builder = new ClaudeCodeBuilder(config.builder, env.claudeBin);
  const notifier = new Notifier(env.discordWebhookUrl);
  const pipeline = new Pipeline({
    config, env, store, github, builder, notifier,
    repo: (owner, repo) => new Repo(env.home, owner, repo, env.githubToken),
  });
  const labels = Object.values(config.labels);
  const sources: Source[] = [new GitHubSource(github, configuredRepos(config), labels)];
  if (env.piUrl && env.piToken) sources.push(new DiscordSource(env.piUrl, env.piToken, lowerKeys(config.discordCategories)));
  if (env.imap) sources.push(new EmailSource(env.imap));
  return { config, env, store, github, pipeline, sources, builder, notifier };
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
  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[runner] ${signal}: stopping; interrupted builds restart from scratch next time`);
    killAllChildren();
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  let lastTriage = 0;
  console.log(`[runner] started: ${configuredRepos(rt.config).map(r => `${r.owner}/${r.repo}`).join(", ")}; sources: ${rt.sources.map(s => s.name).join(", ")}`);
  while (!stopping) {
    if (existsSync(pausedFile(rt.env))) {
      await sleep(rt.config.pollSeconds * 1000);
      continue;
    }
    try {
      await rt.pipeline.discover();
      rt.pipeline.startQueued();
      await rt.pipeline.followUp();
      if (Date.now() - lastTriage > rt.config.triageMinutes * 60_000) {
        lastTriage = Date.now();
        // Triage runs in the background so a slow pass never delays builds.
        void triage(rt).then(report => {
          if (report.items) console.log(`[triage] ${report.items} items, ${report.proposals.length} proposals`);
        }).catch(error => console.warn(`[triage] failed: ${(error as Error).message}`));
      }
    } catch (error) {
      console.error("[runner] cycle failed:", (error as Error).message);
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
  console.log(rt.env.imap ? `➖ Email triage enabled for ${rt.env.imap.user}` : "➖ Email triage disabled (set ISOBOT_IMAP_*)");
  console.log(rt.env.discordWebhookUrl ? "➖ Discord notifications enabled" : "➖ Discord notifications disabled (set ISOBOT_DISCORD_WEBHOOK_URL)");
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
  pause | resume      Stop or restart new work (running builds finish)`;

async function main(): Promise<void> {
  const command = process.argv[2] ?? "help";
  if (command === "help" || command === "--help") return console.log(HELP);
  const rt = runtime();
  switch (command) {
    case "run":
      return loop(rt);
    case "once": {
      rt.pipeline.recover();
      const claimed = await rt.pipeline.discover();
      console.log(`[once] claimed ${claimed.length} issue(s)`);
      await Promise.all(rt.pipeline.startQueued());
      await rt.pipeline.followUp();
      return;
    }
    case "triage": {
      const report = await triage(rt);
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    case "status":
      for (const job of rt.store.all(30)) {
        console.log(`${job.updatedAt.slice(0, 16)}  ${job.state.padEnd(13)} ${job.id}  ${job.title}${job.prNumber ? `  PR #${job.prNumber}` : ""}${job.lastError ? `\n      ↳ ${job.lastError.split("\n")[0].slice(0, 160)}` : ""}`);
      }
      return;
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
    default:
      console.error(`Unknown command: ${command}\n\n${HELP}`);
      process.exitCode = 2;
  }
}

main().catch(error => {
  console.error("[runner] fatal:", error instanceof Error ? error.message : error);
  process.exit(1);
});
