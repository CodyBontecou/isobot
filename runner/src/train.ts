import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { policyFor, configuredRepos, type RunnerConfig, type TrainConfig } from "./config.js";
import type { GitHubApi } from "./github.js";
import { cleanNotes, fallbackNotes, launchMessage, mediaRefs, summaryText, type ReleaseNotes, type ReleaseNotesInput } from "./launch.js";
import { captionFor, DISCORD_MAX_BYTES } from "./media.js";
import type { Notifier, UploadFile } from "./notify.js";
import type { Job, Store } from "./store.js";

/**
 * The release train: once a day (per repo), merged isobot work ships to the App Store.
 *
 *   1. merged isobot jobs are waiting, the last train left `everyHours` ago, and nothing is in App Review
 *   2. a "ship" issue announces the version and its changes; `holdMinutes` later, unless it has the stop
 *      label or was closed, the runner archives, uploads and submits with `asc publish appstore`
 *   3. the commit gets a `v<version>` tag, the jobs become shipped, and their issues hear about it
 *   4. with `launch` set, once the App Store has the version on sale, the app's public Discord channel
 *      gets a launch post: the user-facing notes and a capture from each change (launch.ts)
 *
 * The notes (and What's New) are written by the model at step 2, so the owner sees them during the hold.
 *
 * With `testflight` set, step 2 runs `asc publish testflight` instead: the build goes to that external
 * group and to Beta App Review, never to App Review. The version is still the App Store's with the
 * patch bumped (so builds pile up under it until a real release), the tag is
 * `testflight/<version>-<build>`, a build waiting on Beta App Review holds the next train, and the
 * launch post goes out once external testers can install it.
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
  /** The marketing version of the newest uploaded build, which may be a beta ahead of the App Store. */
  latestBuild?: string | null;
}

export interface TrainRepo {
  sync(defaultBranch: string): Promise<string>;
  checkoutAt(sha: string, name: string): Promise<string>;
  removeWorkspace(name: string): Promise<void>;
  pushTag(sha: string, tag: string): Promise<void>;
}

/** TestFlight external build states in which Apple is still deciding: the next build waits. */
const BETA_BUSY_STATES = new Set(["PROCESSING", "IN_EXPORT_COMPLIANCE_REVIEW", "WAITING_FOR_BETA_REVIEW", "IN_BETA_REVIEW"]);
/** External testers can install the build. */
const BETA_LIVE_STATES = new Set(["BETA_APPROVED", "IN_BETA_TESTING"]);
/** The build will never reach external testers. */
const BETA_DEAD_STATES = new Set(["BETA_REJECTED", "EXPIRED", "PROCESSING_EXCEPTION"]);

export interface TrainDeps {
  config: RunnerConfig;
  store: Store;
  github: GitHubApi;
  notifier: Notifier;
  repo(owner: string, repo: string): TrainRepo;
  /** Runs a shell command unsandboxed (it signs and uploads), returning its outcome. */
  run(cwd: string, command: string, timeoutMs: number): Promise<{ ok: boolean; output: string }>;
  appStatus(appId: string, platform: string): Promise<AppStatus>;
  /** A TestFlight build's external state (WAITING_FOR_BETA_REVIEW, IN_BETA_TESTING, …), or null if it can't be found. */
  betaState?(appId: string, platform: string, buildNumber: string): Promise<string | null>;
  now?: () => Date;
  /** True once the runner is stopping: a ship killed by shutdown stays pending and starts over next time. */
  stopping?: () => boolean;
  /** Writes user-facing release notes; without it (or when it fails) they come from the job titles. */
  notes?(input: ReleaseNotesInput): Promise<ReleaseNotes>;
  /** A merged PR's description: context for the notes, and where its captures are linked. */
  pullBody?(owner: string, repo: string, number: number): Promise<string>;
  /** A file at a commit, for the captures on the isobot/media branch. */
  fileAt?(owner: string, repo: string, ref: string, file: string): Promise<Buffer>;
}

interface Pending {
  issue: number;
  sha: string;
  version: string;
  jobs: string[];
  announcedAt: string;
  /** Absent on a train announced before notes existed. */
  notes?: ReleaseNotes;
}

/** A submitted version waiting to go live, so its launch post can go out. */
interface Launch {
  version: string;
  /** Set for a TestFlight build: the post waits for it to reach external testers. */
  build?: string;
  notes: ReleaseNotes;
  jobs: { number: number; prNumber: number | null }[];
  failures?: number;
}

/** How often a submitted version's App Store state is checked for its launch post. */
const LAUNCH_CHECK_MS = 15 * 60_000;
const LAUNCH_MAX_FAILURES = 5;
/** Discord's limit for a whole message's attachments (non-boosted). */
const LAUNCH_MAX_BYTES = 24 * 1024 * 1024;

const SHIPPABLE = ["merged", "released"] as const;

export function nextVersion(current: string | null): string {
  const parts = (current ?? "1.0").split(".").map(n => Number.parseInt(n, 10) || 0);
  while (parts.length < 3) parts.push(0);
  parts[2] += 1;
  return parts.slice(0, 3).join(".");
}

/** A build number that only grows and fits CFBundleVersion: YYYYMMDDHHMM in UTC. */
/**
 * The version a train ships. The App Store's with the patch bumped; on TestFlight, a beta version
 * already ahead of the App Store (an open 4.0.0 while 3.5.0 is live) is kept, so testers never get an older version.
 */
export function trainVersion(train: Pick<TrainConfig, "testflight">, status: AppStatus): string {
  const next = nextVersion(status.version);
  if (!train.testflight || !status.latestBuild) return next;
  return compareVersions(status.latestBuild, next) > 0 ? status.latestBuild : next;
}

export function timestampBuildNumber(at: Date): string {
  return at.toISOString().replace(/[-:T]/g, "").slice(0, 12);
}

export function isBusy(status: AppStatus): boolean {
  return status.state !== null && BUSY_STATES.has(status.state);
}

export function whatsNew(jobs: Pick<Job, "title">[]): string {
  return fallbackNotes(jobs).whatsNew;
}

/** -1, 0 or 1, comparing dotted version strings numerically. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(n => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map(n => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
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

export function testflightCommand(train: TrainConfig, version: string, buildNumber: string, testNotes: string): string {
  const q = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const target = train.workspace ? `--workspace ${q(train.workspace)}` : `--project ${q(train.project!)}`;
  return [
    "asc publish testflight", `--app ${q(train.appId)}`, target, `--scheme ${q(train.scheme)}`, `--platform ${train.platform ?? "IOS"}`,
    `--version ${q(version)}`, `--group ${q(train.testflight!.group)}`, `--test-notes ${q(testNotes.slice(0, 3900))}`, "--locale en-US",
    `--archive-xcodebuild-flag ${q(`MARKETING_VERSION=${version}`)}`, `--archive-xcodebuild-flag ${q(`CURRENT_PROJECT_VERSION=${buildNumber}`)}`,
    "--wait --timeout 90m --submit --confirm --output json",
  ].join(" ");
}

export class ReleaseTrain {
  private running = new Set<string>();
  private lastBusyNote = new Map<string, number>();
  private lastLaunchCheck = new Map<string, number>();

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
        await this.launchStep(owner, repo, train);
      } catch (error) {
        console.warn(`[train] ${name} launch: ${(error as Error).message}`);
      }
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
    // Content-train work is on the website, which deploys on merge; it never needs an app release.
    return this.deps.store.inState(...SHIPPABLE).filter(job => job.kind !== "content" && `${job.owner}/${job.repo}`.toLowerCase() === name);
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
      if (await this.busy(owner, repo, train, status)) return null;
      const version = trainVersion(train, status);
      const sha = await this.deps.repo(owner, repo).sync(await github.defaultBranch(owner, repo));
      const firstTrain = !store.cursor(this.key(owner, repo, "confirmed"));
      const list = jobs.map(job => `- #${job.number} ${job.title}${job.prNumber ? ` (PR #${job.prNumber})` : ""}`).join("\n");
      const notes = await this.notesFor(owner, repo, train, version, jobs);
      const beta = train.testflight;
      const preview = train.launch
        ? `\n\n**Discord launch post** (in <#${train.launch.channelId}> once ${beta ? "external testers can install it" : "the version is live"})\n\n` +
          quote(launchMessage(appName(train), version, notes, storeUrl(train), beta))
        : "";
      const where = beta ? `TestFlight (external group **${beta.group}**, after Beta App Review)` : "App Review";
      const when = firstTrain
        ? `This is ${repo}'s first release train, so it waits for you: add \`${labels.ready}\` to this issue to ship it. Later trains go on their own.`
        : `Ships ${train.holdMinutes} minutes after this issue was opened. Add \`${labels.stop}\` or close the issue to hold it.`;
      const issue = await github.createIssue(owner, repo, `Ship ${version}`,
        `## isobot release train\n\nVersion **${version}** from \`${sha.slice(0, 12)}\` goes to ${where} with:\n\n${list}\n\n` +
        `**${beta ? "What to Test" : "What's New"}**\n\n${quote(notes.whatsNew)}${preview}\n\n${when}`, []);
      const next: Pending = { issue: issue.number, sha, version, jobs: jobs.map(job => job.id), announcedAt: now.toISOString(), notes };
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
    if (await this.busy(owner, repo, train, status)) return null;
    return () => this.ship(owner, repo, train, pending);
  }

  /** User-facing notes for a version, falling back to the job titles. */
  private async notesFor(owner: string, repo: string, train: TrainConfig, version: string, jobs: Job[]): Promise<ReleaseNotes> {
    if (!this.deps.notes) return fallbackNotes(jobs);
    try {
      const changes = await Promise.all(jobs.map(async job => ({
        number: job.number, title: job.title,
        summary: job.prNumber && this.deps.pullBody ? summaryText(await this.deps.pullBody(owner, repo, job.prNumber).catch(() => "")) : "",
      })));
      return cleanNotes(await this.deps.notes({ app: appName(train), version, changes }));
    } catch (error) {
      console.warn(`[train] ${owner}/${repo} ${version}: release notes fell back to job titles: ${(error as Error).message}`);
      return fallbackNotes(jobs);
    }
  }

  /** Posts a submitted version's launch once the App Store has it on sale. */
  private async launchStep(owner: string, repo: string, train: TrainConfig): Promise<void> {
    const { store, notifier } = this.deps;
    const key = this.key(owner, repo, "launch");
    const raw = store.cursor(key);
    if (!raw) return;
    const name = `${owner}/${repo}`;
    const launch = JSON.parse(raw) as Launch;
    if (!train.launch || !notifier.canPost) {
      store.setCursor(key, "");
      return;
    }
    const now = this.now().getTime();
    if (now - (this.lastLaunchCheck.get(name) ?? -Infinity) < LAUNCH_CHECK_MS) return;
    this.lastLaunchCheck.set(name, now);
    if (launch.build) {
      const state = await this.betaState(train, launch.build);
      if (state && BETA_DEAD_STATES.has(state)) {
        store.setCursor(key, "");
        await notifier.discord(`⚠️ **${appName(train)} ${launch.version}** (build ${launch.build}) won't reach testers: TestFlight says ${state}. No launch post.`);
        return;
      }
      if (!state || !BETA_LIVE_STATES.has(state)) return;
    } else {
      const status = await this.deps.appStatus(train.appId, train.platform ?? "IOS");
      if (status.version && compareVersions(status.version, launch.version) > 0) {
        // A later version took its place (this one was rejected and replaced): its post would be wrong.
        store.setCursor(key, "");
        console.log(`[train] ${name}: ${launch.version} never went live (now ${status.version}); no launch post`);
        return;
      }
      if (status.version !== launch.version || status.state !== "READY_FOR_DISTRIBUTION") return;
    }
    const app = appName(train);
    const beta = launch.build ? train.testflight ?? {} : undefined;
    try {
      const files = await this.launchMedia(owner, repo, launch);
      await notifier.post(train.launch.channelId, launchMessage(app, launch.version, launch.notes, storeUrl(train), beta), files);
    } catch (error) {
      const failures = (launch.failures ?? 0) + 1;
      if (failures < LAUNCH_MAX_FAILURES) {
        store.setCursor(key, JSON.stringify({ ...launch, failures }));
        throw error;
      }
      store.setCursor(key, "");
      await notifier.discord(`⚠️ Couldn't post the **${app} ${launch.version}** launch in <#${train.launch.channelId}>: ${(error as Error).message.slice(0, 300)}`);
      return;
    }
    store.setCursor(key, "");
    store.event(null, "train", `${name} ${launch.version} launch posted`);
    await notifier.discord(`📣 **${app} ${launch.version}** is ${beta ? `on TestFlight for external testers (build ${launch.build})` : "live on the App Store"}; ` +
      `the launch post is in <#${train.launch.channelId}>.`);
  }

  /** One capture per change (a screenshot if it has one), within Discord's limits. A missing capture costs only itself. */
  private async launchMedia(owner: string, repo: string, launch: Launch): Promise<UploadFile[]> {
    const { pullBody, fileAt } = this.deps;
    if (!pullBody || !fileAt) return [];
    const files: UploadFile[] = [];
    let total = 0;
    for (const job of launch.jobs) {
      if (!job.prNumber || files.length >= 10) continue;
      try {
        const refs = mediaRefs(await pullBody(owner, repo, job.prNumber), owner, repo);
        for (const ref of refs) {
          const data = await fileAt(owner, repo, ref.ref, ref.path);
          if (data.length > DISCORD_MAX_BYTES || total + data.length > LAUNCH_MAX_BYTES) continue;
          files.push({ name: `${job.number}-${ref.name}`, data, description: captionFor(ref.name) });
          total += data.length;
          break;
        }
      } catch (error) {
        console.warn(`[train] ${owner}/${repo}#${job.number}: launch capture skipped: ${(error as Error).message}`);
      }
    }
    return files;
  }

  /** Whether Apple is still busy with the last release: App Review for the App Store, Beta App Review for TestFlight. */
  private async busy(owner: string, repo: string, train: TrainConfig, status: AppStatus): Promise<boolean> {
    if (!train.testflight) {
      if (isBusy(status)) await this.busyNote(owner, repo, status);
      return isBusy(status);
    }
    const last = this.deps.store.cursor(this.key(owner, repo, "beta"));
    if (!last) return false;
    const state = await this.betaState(train, last);
    if (!state || !BETA_BUSY_STATES.has(state)) return false;
    await this.busyNote(owner, repo, { version: `build ${last}`, state });
    return true;
  }

  private async betaState(train: TrainConfig, build: string): Promise<string | null> {
    if (!this.deps.betaState) return null;
    return this.deps.betaState(train.appId, train.platform ?? "IOS", build);
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
    const beta = train.testflight;
    const tag = beta ? `testflight/${pending.version}-${buildNumber}` : `v${pending.version}`;
    await github.comment(owner, repo, pending.issue,
      `🏗 Archiving, uploading and submitting ${pending.version} (build ${buildNumber})${beta ? ` to TestFlight (${beta.group})` : ""}.`);
    store.event(null, "train", `${name} ${pending.version} shipping`);
    let result: { ok: boolean; output: string };
    try {
      const metadata = path.join(dir, ".isobot-release");
      rmSync(metadata, { recursive: true, force: true });
      mkdirSync(path.join(metadata, "version", pending.version), { recursive: true });
      writeFileSync(path.join(metadata, "version", pending.version, "en-US.json"), JSON.stringify({ whatsNew: pending.notes?.whatsNew ?? whatsNew(jobs) }, null, 2));
      result = { ok: true, output: "" };
      for (const command of train.prepare ?? []) {
        result = await this.deps.run(dir, command, 60 * 60_000);
        if (!result.ok) break;
      }
      const notes = pending.notes?.whatsNew ?? whatsNew(jobs);
      const command = beta ? testflightCommand(train, pending.version, buildNumber, notes) : publishCommand(train, pending.version, buildNumber, metadata);
      if (result.ok) result = await this.deps.run(dir, command, 3 * 60 * 60_000);
      if (result.ok) await git.pushTag(pending.sha, tag);
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
    if (beta) store.setCursor(this.key(owner, repo, "beta"), buildNumber);
    if (train.launch) {
      const launch: Launch = {
        version: pending.version, ...(beta ? { build: buildNumber } : {}), notes: pending.notes ?? fallbackNotes(jobs),
        jobs: jobs.map(job => ({ number: job.number, prNumber: job.prNumber })),
      };
      store.setCursor(this.key(owner, repo, "launch"), JSON.stringify(launch));
    }
    for (const job of jobs) {
      store.update(job.id, { state: "shipped" });
      const where = beta ? `TestFlight in ${pending.version} (build ${buildNumber}, external testers after Beta App Review)` : `App Review in ${pending.version}`;
      await github.comment(owner, repo, job.number, `🚀 Submitted to ${where} (#${pending.issue}).`).catch(() => undefined);
    }
    const review = beta ? `added to the TestFlight group ${beta.group} and submitted for Beta App Review` : "submitted for App Review";
    await github.comment(owner, repo, pending.issue, `🚀 ${pending.version} (build ${buildNumber}) is uploaded and ${review}, tagged \`${tag}\`.`);
    await github.closeIssue(owner, repo, pending.issue);
    store.event(null, "train", `${name} ${pending.version} submitted${beta ? ` to TestFlight (build ${buildNumber})` : ""}`);
    await this.deps.notifier.discord(`${beta ? "🧪" : "🚀"} **${name} ${pending.version}** ${beta ? `(build ${buildNumber}) submitted to TestFlight for ${beta.group}` : "submitted for App Review"} ` +
      `with ${jobs.length} change${jobs.length === 1 ? "" : "s"}.`);
  }
}

function appName(train: TrainConfig): string {
  return train.launch?.name ?? train.scheme;
}

function storeUrl(train: TrainConfig): string {
  return train.launch?.storeUrl ?? `https://apps.apple.com/app/id${train.appId}`;
}

function quote(text: string): string {
  return text.split("\n").map(line => `> ${line}`).join("\n");
}
