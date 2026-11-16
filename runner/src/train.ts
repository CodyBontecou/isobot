import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { policyFor, configuredRepos, type RunnerConfig, type TrainConfig } from "./config.js";
import type { GitHubApi } from "./github.js";
import type { Notifier } from "./notify.js";
import type { Job, Store } from "./store.js";

/**
 * The release train: once a day (per repo), merged isobot work ships to the App Store.
 *
 *   1. merged isobot jobs are waiting, the last train left `everyHours` ago, and nothing is in App Review
 *   2. a "ship" issue announces the version and its changes; `holdMinutes` later, unless it has the stop
 *      label or was closed, the runner archives, uploads and submits with `asc publish appstore`
 *   3. the commit gets a `v<version>` tag, the jobs become shipped, and their issues hear about it
 *
 * A repo's first train waits for the owner to add the ready label to the ship issue; later ones don't.
 */

/** App Store version states in which a new version must not be submitted. */
const BUSY_STATES = new Set([
  "PREPARE_FOR_SUBMISSION", "READY_FOR_REVIEW", "WAITING_FOR_REVIEW", "IN_REVIEW", "PENDING_DEVELOPER_RELEASE",
  "PENDING_APPLE_RELEASE", "PROCESSING_FOR_DISTRIBUTION", "REJECTED", "METADATA_REJECTED", "DEVELOPER_REJECTED", "INVALID_BINARY",
]);

export interface AppStatus {
  /** The latest App Store version string, if any. */
  version: string | null;
  /** Its App Store state (READY_FOR_DISTRIBUTION, IN_REVIEW, …). */
  state: string | null;
}

export interface TrainRepo {
  sync(defaultBranch: string): Promise<string>;
  checkoutAt(sha: string, name: string): Promise<string>;
  removeWorkspace(name: string): Promise<void>;
  pushTag(sha: string, tag: string): Promise<void>;
}

export interface TrainDeps {
  config: RunnerConfig;
  store: Store;
  github: GitHubApi;
  notifier: Notifier;
  repo(owner: string, repo: string): TrainRepo;
  /** Runs a shell command unsandboxed (it signs and uploads), returning its outcome. */
  run(cwd: string, command: string, timeoutMs: number): Promise<{ ok: boolean; output: string }>;
  appStatus(appId: string, platform: string): Promise<AppStatus>;
  now?: () => Date;
  /** True once the runner is stopping: a ship killed by shutdown stays pending and starts over next time. */
  stopping?: () => boolean;
}

interface Pending {
  issue: number;
  sha: string;
  version: string;
  jobs: string[];
  announcedAt: string;
}

const SHIPPABLE = ["merged", "released"] as const;

export function nextVersion(current: string | null): string {
  const parts = (current ?? "1.0").split(".").map(n => Number.parseInt(n, 10) || 0);
  while (parts.length < 3) parts.push(0);
  parts[2] += 1;
  return parts.slice(0, 3).join(".");
}

/** A build number that only grows and fits CFBundleVersion: YYYYMMDDHHMM in UTC. */
export function timestampBuildNumber(at: Date): string {
  return at.toISOString().replace(/[-:T]/g, "").slice(0, 12);
}

export function isBusy(status: AppStatus): boolean {
  return status.state !== null && BUSY_STATES.has(status.state);
}

export function whatsNew(jobs: Pick<Job, "title">[]): string {
  const lines = jobs.map(job => `• ${job.title.replace(/\s+/g, " ").trim()}`);
  return `Fixes and improvements in this update:\n${lines.join("\n")}`.slice(0, 3900);
}

export function publishCommand(train: TrainConfig, version: string, buildNumber: string, metadataDir: string): string {
  const q = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const target = train.workspace ? `--workspace ${q(train.workspace)}` : `--project ${q(train.project!)}`;
  return [
    "asc publish appstore", `--app ${q(train.appId)}`, target, `--scheme ${q(train.scheme)}`, `--platform ${train.platform ?? "IOS"}`,
    `--version ${q(version)}`, `--metadata-dir ${q(metadataDir)}`,
    `--archive-xcodebuild-flag ${q(`MARKETING_VERSION=${version}`)}`, `--archive-xcodebuild-flag ${q(`CURRENT_PROJECT_VERSION=${buildNumber}`)}`,
    "--wait --timeout 90m --submit --confirm --output json",
  ].join(" ");
}

export class ReleaseTrain {
  private running = new Set<string>();
  private lastBusyNote = new Map<string, number>();

  constructor(private deps: TrainDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** One pass over every repo with a train. Ships run in the background; the returned promises are for tests. */
  async tick(): Promise<Promise<void>[]> {
    const started: Promise<void>[] = [];
    for (const { owner, repo } of configuredRepos(this.deps.config)) {
      const name = `${owner}/${repo}`;
      const train = policyFor(this.deps.config, name).train;
      if (!train || this.running.has(name)) continue;
      try {
        const ship = await this.step(owner, repo, train);
        if (ship) {
          this.running.add(name);
          started.push(ship().catch(error => console.warn(`[train] ${name}: ${(error as Error).message}`)).finally(() => this.running.delete(name)));
        }
      } catch (error) {
        console.warn(`[train] ${name}: ${(error as Error).message}`);
      }
    }
    return started;
  }

  private key(owner: string, repo: string, what: string): string {
    return `train:${owner}/${repo}:${what}`.toLowerCase();
  }

  private waiting(owner: string, repo: string): Job[] {
    const name = `${owner}/${repo}`.toLowerCase();
    return this.deps.store.inState(...SHIPPABLE).filter(job => `${job.owner}/${job.repo}`.toLowerCase() === name);
  }

  /** Decides what this repo's train does now; returns the ship itself when it should start. */
  private async step(owner: string, repo: string, train: TrainConfig): Promise<(() => Promise<void>) | null> {
    const { store, github } = this.deps;
    const labels = this.deps.config.labels;
    const pendingKey = this.key(owner, repo, "pending");
    const raw = store.cursor(pendingKey);
    const pending = raw ? JSON.parse(raw) as Pending : null;
    const now = this.now();

    if (!pending) {
      const jobs = this.waiting(owner, repo);
      if (jobs.length === 0) return null;
      const last = store.cursor(this.key(owner, repo, "last"));
      if (last && now.getTime() - Date.parse(last) < train.everyHours * 3_600_000) return null;
      const status = await this.deps.appStatus(train.appId, train.platform ?? "IOS");
      if (isBusy(status)) {
        await this.busyNote(owner, repo, status);
        return null;
      }
      const version = nextVersion(status.version);
      const sha = await this.deps.repo(owner, repo).sync(await github.defaultBranch(owner, repo));
      const firstTrain = !store.cursor(this.key(owner, repo, "confirmed"));
      const list = jobs.map(job => `- #${job.number} ${job.title}${job.prNumber ? ` (PR #${job.prNumber})` : ""}`).join("\n");
      const when = firstTrain
        ? `This is ${repo}'s first release train, so it waits for you: add \`${labels.ready}\` to this issue to ship it. Later trains go on their own.`
        : `Ships ${train.holdMinutes} minutes after this issue was opened. Add \`${labels.stop}\` or close the issue to hold it.`;
      const issue = await github.createIssue(owner, repo, `Ship ${version}`,
        `## isobot release train\n\nVersion **${version}** from \`${sha.slice(0, 12)}\` goes to App Review with:\n\n${list}\n\n` +
        `**What's New**\n\n${whatsNew(jobs).split("\n").map(line => `> ${line}`).join("\n")}\n\n${when}`, []);
      const next: Pending = { issue: issue.number, sha, version, jobs: jobs.map(job => job.id), announcedAt: now.toISOString() };
      store.setCursor(pendingKey, JSON.stringify(next));
      store.event(null, "train", `${owner}/${repo} ${version} announced in #${issue.number}`);
      await this.deps.notifier.discord(`🚂 **${owner}/${repo} ${version}** is next: ${jobs.length} change${jobs.length === 1 ? "" : "s"}. ` +
        `${firstTrain ? `First train, so it waits for \`${labels.ready}\` on` : `Ships in ${train.holdMinutes} min unless \`${labels.stop}\` lands on`} <${issue.url}>`);
      return null;
    }

    const issue = await github.issue(owner, repo, pending.issue);
    if (issue.state === "closed" || issue.labels.some(l => l.toLowerCase() === labels.stop.toLowerCase())) {
      store.setCursor(pendingKey, "");
      store.setCursor(this.key(owner, repo, "last"), now.toISOString());
      await github.comment(owner, repo, pending.issue, `🛑 Held. The changes stay queued for the next train in ${train.everyHours}h.`);
      await this.deps.notifier.discord(`🛑 ${owner}/${repo} ${pending.version} held; the next train tries again in ${train.everyHours}h.`);
      return null;
    }
    if (!store.cursor(this.key(owner, repo, "confirmed"))) {
      const by = issue.labels.some(l => l.toLowerCase() === labels.ready.toLowerCase())
        ? await github.labeledBy(owner, repo, pending.issue, labels.ready) : null;
      if (!by || by.toLowerCase() !== (await github.viewer()).toLowerCase()) return null;
    } else if (now.getTime() - Date.parse(pending.announcedAt) < train.holdMinutes * 60_000) {
      return null;
    }
    const status = await this.deps.appStatus(train.appId, train.platform ?? "IOS");
    if (isBusy(status)) {
      await this.busyNote(owner, repo, status);
      return null;
    }
    return () => this.ship(owner, repo, train, pending);
  }

  private async busyNote(owner: string, repo: string, status: AppStatus): Promise<void> {
    const name = `${owner}/${repo}`;
    const last = this.lastBusyNote.get(name) ?? 0;
    if (Date.now() - last < 6 * 3_600_000) return;
    this.lastBusyNote.set(name, Date.now());
    console.log(`[train] ${name}: waiting, App Store version ${status.version} is ${status.state}`);
  }

  private async ship(owner: string, repo: string, train: TrainConfig, pending: Pending): Promise<void> {
    const { store, github } = this.deps;
    const name = `${owner}/${repo}`;
    const git = this.deps.repo(owner, repo);
    const workspace = `ship__${pending.version}`;
    const dir = await git.checkoutAt(pending.sha, workspace);
    const jobs = pending.jobs.map(id => store.get(id)).filter((job): job is Job => Boolean(job));
    // Chosen at ship time, so a retry after an interrupted upload never reuses a build number.
    const buildNumber = timestampBuildNumber(this.now());
    await github.comment(owner, repo, pending.issue, `🏗 Archiving, uploading and submitting ${pending.version} (build ${buildNumber}).`);
    store.event(null, "train", `${name} ${pending.version} shipping`);
    let result: { ok: boolean; output: string };
    try {
      const metadata = path.join(dir, ".isobot-release");
      rmSync(metadata, { recursive: true, force: true });
      mkdirSync(path.join(metadata, "version", pending.version), { recursive: true });
      writeFileSync(path.join(metadata, "version", pending.version, "en-US.json"), JSON.stringify({ whatsNew: whatsNew(jobs) }, null, 2));
      result = { ok: true, output: "" };
      for (const command of train.prepare ?? []) {
        result = await this.deps.run(dir, command, 60 * 60_000);
        if (!result.ok) break;
      }
      if (result.ok) result = await this.deps.run(dir, publishCommand(train, pending.version, buildNumber, metadata), 3 * 60 * 60_000);
      if (result.ok) await git.pushTag(pending.sha, `v${pending.version}`);
    } finally {
      await git.removeWorkspace(workspace).catch(() => undefined);
    }
    if (this.deps.stopping?.()) return;
    store.setCursor(this.key(owner, repo, "pending"), "");
    store.setCursor(this.key(owner, repo, "last"), this.now().toISOString());
    const tail = result.output.trim().slice(-3500);
    if (!result.ok) {
      store.event(null, "train", `${name} ${pending.version} failed`);
      await github.comment(owner, repo, pending.issue, `❌ Shipping ${pending.version} failed; the changes stay queued for the next train.\n\n\`\`\`\n${tail}\n\`\`\``);
      await this.deps.notifier.discord(`❌ **${name} ${pending.version}** failed to ship. Details: <https://github.com/${name}/issues/${pending.issue}>`);
      return;
    }
    store.setCursor(this.key(owner, repo, "confirmed"), "1");
    for (const job of jobs) {
      store.update(job.id, { state: "shipped" });
      await github.comment(owner, repo, job.number, `🚀 Submitted to App Review in ${pending.version} (#${pending.issue}).`).catch(() => undefined);
    }
    await github.comment(owner, repo, pending.issue, `🚀 ${pending.version} (build ${buildNumber}) is uploaded and submitted for App Review, tagged \`v${pending.version}\`.`);
    await github.closeIssue(owner, repo, pending.issue);
    store.event(null, "train", `${name} ${pending.version} submitted`);
    await this.deps.notifier.discord(`🚀 **${name} ${pending.version}** submitted for App Review with ${jobs.length} change${jobs.length === 1 ? "" : "s"}.`);
  }
}
