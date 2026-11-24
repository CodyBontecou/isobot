import { configuredRepos, policyFor, type ProductionConfig, type RunnerConfig, type TrainConfig } from "./config.js";
import type { GitHubApi } from "./github.js";
import { cleanNotes, fallbackNotes, launchMessage, summaryText, type ReleaseNotes, type ReleaseNotesInput } from "./launch.js";
import type { Notifier } from "./notify.js";
import type { Store } from "./store.js";
import { BETA_LIVE_STATES, compareVersions, isBusy, trainKey, type AppStatus, type BetaBuild } from "./train.js";

/**
 * The weekly production release: the TestFlight train's builds go to the App Store once a week.
 *
 *   1. On `weekday` at `hour` (local), the newest TestFlight build that external testers have had for
 *      `minBetaHours`, and that is ahead of the App Store, is picked. Nothing in App Review may be open.
 *   2. A "Release x.y.z" issue announces it with every change since the last App Store release and the
 *      model-written What's New. `holdHours` later, unless it has the stop label or was closed, the runner
 *      stages the version from that build, turns on a 7-day phased release (and checks it exists), and
 *      submits it for App Review, releasing automatically once approved.
 *   3. With the train's `launch` set (and `announce` not off), the launch post goes out once the version is live.
 *
 * No build is made: the binary is the one testers had. A repo's first production release waits for the
 * owner's ready label, like a first train. A missed week (runner down, a version already in review)
 * catches up as soon as it can; a week with nothing soaked says so once and waits for the next.
 */

const CHECK_EVERY_MS = 5 * 60_000;
const DEFAULTS: Required<ProductionConfig> = { weekday: 2, hour: 10, minBetaHours: 48, holdHours: 4, announce: true };

export interface AscResult {
  ok: boolean;
  stdout: string;
  output: string;
}

export interface ProductionDeps {
  config: RunnerConfig;
  store: Store;
  github: GitHubApi;
  notifier: Notifier;
  appStatus(appId: string, platform: string): Promise<AppStatus>;
  betaState(appId: string, platform: string, buildNumber: string): Promise<string | null>;
  /** Runs `asc` with these arguments (it changes App Store Connect). */
  asc(args: string[]): Promise<AscResult>;
  notes?(input: ReleaseNotesInput): Promise<ReleaseNotes>;
  pullBody?(owner: string, repo: string, number: number): Promise<string>;
  now?: () => Date;
  stopping?: () => boolean;
}

interface PendingRelease {
  issue: number;
  version: string;
  build: string;
  /** The App Store version the release copies its metadata from. */
  from: string | null;
  /** The newest TestFlight build (by upload time) the release covers; it and older ones are dropped on success. */
  through: string;
  jobs: BetaBuild["jobs"];
  notes: ReleaseNotes;
  announcedAt: string;
}

export function productionSettings(train: TrainConfig): Required<ProductionConfig> {
  return { ...DEFAULTS, ...train.production };
}

/** The most recent local `weekday` `hour`:00 at or before `now`. */
export function lastSlot(now: Date, weekday: number, hour: number): Date {
  const slot = new Date(now);
  slot.setHours(hour, 0, 0, 0);
  slot.setDate(slot.getDate() - ((now.getDay() - weekday + 7) % 7));
  if (slot.getTime() > now.getTime()) slot.setDate(slot.getDate() - 7);
  return slot;
}

/** The next local `weekday` `hour`:00 after `now`. */
export function nextSlot(now: Date, weekday: number, hour: number): Date {
  const slot = lastSlot(now, weekday, hour);
  slot.setDate(slot.getDate() + 7);
  return slot;
}

export class ProductionRelease {
  private running = new Set<string>();
  private lastBusyNote = new Map<string, number>();
  private lastCheck = new Map<string, number>();

  constructor(private deps: ProductionDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** Repos with a weekly production release. */
  repos(): { name: string; train: TrainConfig }[] {
    return configuredRepos(this.deps.config)
      .map(({ owner, repo }) => ({ name: `${owner}/${repo}`, train: policyFor(this.deps.config, `${owner}/${repo}`).train }))
      .filter((r): r is { name: string; train: TrainConfig } => Boolean(r.train?.production && r.train.testflight));
  }

  /** One pass over every repo with a production release. Submissions run in the background; the promises are for tests. */
  async tick(): Promise<Promise<void>[]> {
    const started: Promise<void>[] = [];
    for (const { name, train } of this.repos()) {
      if (this.running.has(name)) continue;
      // Weekly work with hour-long holds: a look every few minutes is plenty, and spares App Store Connect.
      const at = this.now().getTime();
      if (at - (this.lastCheck.get(name) ?? -Infinity) < CHECK_EVERY_MS) continue;
      this.lastCheck.set(name, at);
      const [owner, repo] = name.split("/");
      try {
        const submit = await this.step(owner, repo, train);
        if (submit) {
          this.running.add(name);
          started.push(submit().catch(error => console.warn(`[production] ${name}: ${(error as Error).message}`)).finally(() => this.running.delete(name)));
        }
      } catch (error) {
        console.warn(`[production] ${name}: ${(error as Error).message}`);
      }
    }
    return started;
  }

  private async step(owner: string, repo: string, train: TrainConfig): Promise<(() => Promise<void>) | null> {
    const { store, github } = this.deps;
    const labels = this.deps.config.labels;
    const settings = productionSettings(train);
    const name = `${owner}/${repo}`;
    const platform = train.platform ?? "IOS";
    const pendingKey = trainKey(owner, repo, "production-pending");
    const raw = store.cursor(pendingKey);
    const pending = raw ? JSON.parse(raw) as PendingRelease : null;
    const now = this.now();

    if (!pending) {
      const slot = lastSlot(now, settings.weekday, settings.hour);
      const handled = store.cursor(trainKey(owner, repo, "production-slot"));
      if (handled && Date.parse(handled) >= slot.getTime()) return null;
      const status = await this.deps.appStatus(train.appId, platform);
      if (isBusy(status)) {
        this.busyNote(name, status);
        return null;
      }
      const markHandled = () => store.setCursor(trainKey(owner, repo, "production-slot"), slot.toISOString());
      if (store.cursor(trainKey(owner, repo, "betas")) === null) {
        // Builds from before this existed aren't on record (nor their changes): start with the next one.
        markHandled();
        return null;
      }
      const history = this.history(owner, repo, status.version);
      const cutoff = now.getTime() - settings.minBetaHours * 3_600_000;
      let pick: BetaBuild | null = null;
      for (const entry of [...history].reverse()) {
        if (Date.parse(entry.at) > cutoff) continue;
        const state = await this.deps.betaState(train.appId, platform, entry.build);
        if (state && BETA_LIVE_STATES.has(state)) { pick = entry; break; }
      }
      markHandled();
      if (!pick) {
        const next = nextSlot(now, settings.weekday, settings.hour);
        await this.deps.notifier.discord(`📦 **${name}**: no weekly App Store release. ${history.length
          ? `No TestFlight build ahead of ${status.version ?? "the App Store"} has been with external testers for ${settings.minBetaHours} h yet.`
          : `Nothing has gone to TestFlight since ${status.version ?? "the last release"}.`} Next look: ${next.toDateString()}.`);
        return null;
      }
      const covered = history.filter(entry => Date.parse(entry.at) <= Date.parse(pick!.at));
      const jobs = dedupe(covered.flatMap(entry => entry.jobs));
      const notes = await this.notesFor(owner, repo, train, pick.version, jobs);
      const firstRelease = !store.cursor(trainKey(owner, repo, "production-confirmed"));
      const list = jobs.length ? jobs.map(job => `- #${job.number} ${job.title}${job.prNumber ? ` (PR #${job.prNumber})` : ""}`).join("\n") : "- (no tracked changes)";
      const soaked = Math.floor((now.getTime() - Date.parse(pick.at)) / 3_600_000);
      const when = firstRelease
        ? `This is ${repo}'s first weekly App Store release from isobot, so it waits for you: add \`${labels.ready}\` to this issue to submit it. Later ones go on their own.`
        : `Submits ${settings.holdHours} h after this issue was opened. Add \`${labels.stop}\` or close the issue to skip this week.`;
      const issue = await github.createIssue(owner, repo, `Release ${pick.version} to the App Store`,
        `## isobot weekly App Store release\n\n` +
        `TestFlight build **${pick.version} (${pick.build})**, with external testers for ${soaked} h, goes to App Review and is released ` +
        `on its own once approved, with a **7-day phased release**. App Store now: ${status.version ?? "nothing"}.\n\n` +
        `Changes since the last App Store release:\n\n${list}\n\n**What's New**\n\n${quote(notes.whatsNew)}\n\n${when}`, []);
      const next: PendingRelease = {
        issue: issue.number, version: pick.version, build: pick.build, from: status.version, through: pick.build, jobs, notes, announcedAt: now.toISOString(),
      };
      store.setCursor(pendingKey, JSON.stringify(next));
      store.event(null, "production", `${name} ${pick.version} (build ${pick.build}) announced in #${issue.number}`);
      await this.deps.notifier.discord(`📦 **${name} ${pick.version}** (build ${pick.build}) is this week's App Store release: ${jobs.length} change${jobs.length === 1 ? "" : "s"}. ` +
        `${firstRelease ? `First one, so it waits for \`${labels.ready}\` on` : `Goes to App Review in ${settings.holdHours} h unless \`${labels.stop}\` lands on`} <${issue.url}>`);
      return null;
    }

    const issue = await github.issue(owner, repo, pending.issue);
    if (issue.state === "closed" || issue.labels.some(l => l.toLowerCase() === labels.stop.toLowerCase())) {
      store.setCursor(pendingKey, "");
      await github.comment(owner, repo, pending.issue, "🛑 Skipped this week. The changes stay queued for next week's release.").catch(() => undefined);
      await this.deps.notifier.discord(`🛑 ${name} ${pending.version} App Store release skipped; next week's picks up the changes.`);
      return null;
    }
    if (!store.cursor(trainKey(owner, repo, "production-confirmed"))) {
      const by = issue.labels.some(l => l.toLowerCase() === labels.ready.toLowerCase())
        ? await github.labeledBy(owner, repo, pending.issue, labels.ready) : null;
      if (!by || by.toLowerCase() !== (await github.viewer()).toLowerCase()) return null;
    } else if (now.getTime() - Date.parse(pending.announcedAt) < settings.holdHours * 3_600_000) {
      return null;
    }
    const status = await this.deps.appStatus(train.appId, platform);
    if (isBusy(status)) {
      this.busyNote(name, status);
      return null;
    }
    if (status.version && compareVersions(status.version, pending.version) >= 0) {
      store.setCursor(pendingKey, "");
      await github.comment(owner, repo, pending.issue, `ℹ️ The App Store already has ${status.version}, so ${pending.version} isn't submitted.`).catch(() => undefined);
      await github.closeIssue(owner, repo, pending.issue, "not_planned").catch(() => undefined);
      return null;
    }
    return () => this.submit(owner, repo, train, pending);
  }

  /** TestFlight builds not yet on the App Store, oldest first. Builds at or below the App Store version are dropped. */
  private history(owner: string, repo: string, appStoreVersion: string | null): BetaBuild[] {
    const key = trainKey(owner, repo, "betas");
    const all = JSON.parse(this.deps.store.cursor(key) || "[]") as BetaBuild[];
    const ahead = all.filter(entry => !appStoreVersion || compareVersions(entry.version, appStoreVersion) > 0);
    if (ahead.length !== all.length) this.deps.store.setCursor(key, JSON.stringify(ahead));
    return ahead.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  }

  private async notesFor(owner: string, repo: string, train: TrainConfig, version: string, jobs: BetaBuild["jobs"]): Promise<ReleaseNotes> {
    if (!this.deps.notes || jobs.length === 0) return jobs.length ? fallbackNotes(jobs) : { headline: "", items: [], whatsNew: "Bug fixes and improvements." };
    try {
      const changes = await Promise.all(jobs.map(async job => ({
        number: job.number, title: job.title,
        summary: job.prNumber && this.deps.pullBody ? summaryText(await this.deps.pullBody(owner, repo, job.prNumber).catch(() => "")) : "",
      })));
      return cleanNotes(await this.deps.notes({ app: train.launch?.name ?? train.scheme, version, changes }));
    } catch (error) {
      console.warn(`[production] ${owner}/${repo} ${version}: release notes fell back to job titles: ${(error as Error).message}`);
      return fallbackNotes(jobs);
    }
  }

  /** Stage, phased release, submit. Any failed step stops it; the work waits for next week. */
  private async submit(owner: string, repo: string, train: TrainConfig, pending: PendingRelease): Promise<void> {
    const { store, github } = this.deps;
    const name = `${owner}/${repo}`;
    const platform = train.platform ?? "IOS";
    const asc = this.deps.asc;
    const log: string[] = [];
    const call = async (step: string, args: string[]): Promise<string> => {
      const result = await asc(args);
      log.push(`$ asc ${args.filter(a => !a.includes("\n")).join(" ").slice(0, 300)}`);
      if (!result.ok) throw new StepError(step, result.output.trim().slice(-2500));
      return result.stdout;
    };
    await github.comment(owner, repo, pending.issue, `🏗 Staging ${pending.version} from TestFlight build ${pending.build}, with a 7-day phased release, and submitting it for App Review.`);
    store.event(null, "production", `${name} ${pending.version} submitting`);
    try {
      const builds = json(await call("find the build", ["builds", "list", "--app", train.appId, "--build-number", pending.build, "--platform", platform, "--output", "json"]));
      const buildId = builds?.data?.[0]?.id as string | undefined;
      if (!buildId) throw new StepError("find the build", `App Store Connect has no build ${pending.build}`);
      const stage = ["release", "stage", "--app", train.appId, "--version", pending.version, "--build-id", buildId, "--platform", platform, "--confirm", "--output", "json"];
      if (pending.from) stage.push("--copy-metadata-from", pending.from, "--exclude-fields", "whatsNew");
      await call("stage the version", stage);
      const versions = json(await call("find the version", ["versions", "list", "--app", train.appId, "--platform", platform, "--version", pending.version, "--output", "json"]));
      const versionId = versions?.data?.[0]?.id as string | undefined;
      if (!versionId) throw new StepError("find the version", `App Store Connect has no ${platform} version ${pending.version}`);
      const locales = json(await call("read localizations", ["localizations", "list", "--version", versionId, "--output", "json"]));
      for (const loc of (locales?.data ?? []) as { id: string }[]) {
        await call("set What's New", ["localizations", "update", "--id", loc.id, "--whats-new", pending.notes.whatsNew.slice(0, 4000), "--output", "json"]);
      }
      await call("release after approval", ["versions", "update", "--version-id", versionId, "--release-type", "AFTER_APPROVAL", "--output", "json"]);
      const phasedId = async () => json(await call("check phased release", ["versions", "phased-release", "view", "--version-id", versionId, "--output", "json"]).catch(() => "{}"))?.data?.id as string | undefined;
      if (!(await phasedId())) {
        await call("turn on phased release", ["versions", "phased-release", "create", "--version-id", versionId, "--output", "json"]);
        // Never submit without it: once released, a version can't get a phased release.
        if (!(await phasedId())) throw new StepError("check phased release", "the phased release didn't show up after creating it");
      }
      await call("submit for review", ["review", "submit", "--app", train.appId, "--version-id", versionId, "--build-id", buildId, "--platform", platform, "--confirm", "--output", "json"]);
    } catch (error) {
      if (this.deps.stopping?.()) return;
      store.setCursor(trainKey(owner, repo, "production-pending"), "");
      const step = error instanceof StepError ? error.step : "submit";
      const detail = error instanceof StepError ? error.detail : (error as Error).message;
      store.event(null, "production", `${name} ${pending.version} failed at: ${step}`);
      await github.comment(owner, repo, pending.issue,
        `❌ Couldn't ${step}; ${pending.version} isn't in review. A half-staged version may be left in App Store Connect; ` +
        `fix or delete it, and next week's release tries again.\n\n\`\`\`\n${[...log, detail].join("\n").slice(-3500)}\n\`\`\``);
      await this.deps.notifier.discord(`❌ **${name} ${pending.version}** App Store release failed (${step}). Details: <https://github.com/${name}/issues/${pending.issue}>`);
      return;
    }
    store.setCursor(trainKey(owner, repo, "production-pending"), "");
    store.setCursor(trainKey(owner, repo, "production-confirmed"), "1");
    store.setCursor(trainKey(owner, repo, "production-last"), this.now().toISOString());
    const historyKey = trainKey(owner, repo, "betas");
    const history = JSON.parse(store.cursor(historyKey) || "[]") as BetaBuild[];
    const through = history.find(entry => entry.build === pending.through);
    store.setCursor(historyKey, JSON.stringify(through ? history.filter(entry => Date.parse(entry.at) > Date.parse(through.at)) : history));
    if (train.launch && productionSettings(train).announce) {
      store.setCursor(trainKey(owner, repo, "launch-appstore"), JSON.stringify({
        version: pending.version, notes: pending.notes, jobs: pending.jobs.map(job => ({ number: job.number, prNumber: job.prNumber })),
      }));
    }
    for (const job of pending.jobs) {
      await github.comment(owner, repo, job.number, `🚀 In App Review for the App Store in ${pending.version} (#${pending.issue}), with a 7-day phased release.`).catch(() => undefined);
    }
    const preview = train.launch && productionSettings(train).announce ? `\n\nThe launch post goes out when it's live:\n\n${quote(launchMessage(train.launch.name ?? train.scheme, pending.version, pending.notes, train.launch.storeUrl ?? `https://apps.apple.com/app/id${train.appId}`))}` : "";
    await github.comment(owner, repo, pending.issue, `🚀 ${pending.version} (build ${pending.build}) is submitted for App Review with a 7-day phased release; it releases once approved.${preview}`);
    await github.closeIssue(owner, repo, pending.issue);
    store.event(null, "production", `${name} ${pending.version} submitted for App Review (build ${pending.build})`);
    await this.deps.notifier.discord(`🚀 **${name} ${pending.version}** (build ${pending.build}) submitted for App Review with a 7-day phased release; ` +
      `${pending.jobs.length} change${pending.jobs.length === 1 ? "" : "s"}. Check crashes on days 1–2.`);
  }

  private busyNote(name: string, status: AppStatus): void {
    const last = this.lastBusyNote.get(name) ?? 0;
    if (Date.now() - last < 6 * 3_600_000) return;
    this.lastBusyNote.set(name, Date.now());
    console.log(`[production] ${name}: waiting, App Store version ${status.version} is ${status.state}`);
  }
}

class StepError extends Error {
  constructor(readonly step: string, readonly detail: string) {
    super(`${step}: ${detail}`);
  }
}

function json(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function dedupe(jobs: BetaBuild["jobs"]): BetaBuild["jobs"] {
  const seen = new Set<string>();
  return jobs.filter(job => !seen.has(job.id) && Boolean(seen.add(job.id)));
}

function quote(text: string): string {
  return text.split("\n").map(line => `> ${line}`).join("\n");
}
