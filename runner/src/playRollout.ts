import { policyFor, type RunnerConfig } from "./config.js";
import { groupIssues, PLAY_THRESHOLDS, REPORTING_SCOPE, shortWhere, type CrashGroup, type GoogleJson, type PlayIssue } from "./crashes.js";
import { GoogleApiError, PUBLISHER_SCOPE } from "./google.js";
import type { Store } from "./store.js";

/**
 * The Play rollout train: moves a staged production rollout forward on its own, the way the App Store's 7-day
 * phased release does, because Google Play never raises a rollout's percentage by itself.
 *
 * Every few hours, for each Play app of the ASO train, it reads the production track. A release that is live
 * (Play's review is done) and rolling out to part of the users moves to the next stage once it has spent its
 * hold time at the current one: by default 20% for 2 days, then 50% for 5 days, then everyone. Before every step
 * it checks the version's crashes, and halts the rollout instead when:
 *   - Play has a crash or ANR cluster that first appeared in this version and reached `minUsers` users, or
 *   - Play reports a user-perceived crash or ANR rate for this version above its bad-behavior threshold (Play only
 *     returns rates above its privacy threshold, so small apps rarely have them).
 * When it can't read the crashes, it waits rather than step blind. Each step and halt is posted to Discord.
 *
 * Hold time counts from when isobot first saw the release live at that percentage, so a rollout someone changes
 * by hand starts its hold again. A halted rollout stays halted until someone resumes it (Play Console, or
 * `runner play rollout resume <package>`); the crashes it halted for are then accepted and don't halt it again.
 * Releases still in review, approved ones waiting for a manual Publish (managed publishing), drafts and the Wear OS
 * tracks are left alone.
 */

const EVERY_MS = 3 * 3_600_000;
const WINDOW_DAYS = 28;
const REPORTING = "https://playdeveloperreporting.googleapis.com/v1beta1";
const PUBLISHER = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications";
/** Rates from fewer users than this are noise, even when Play returns them. */
const MIN_RATE_USERS = 50;

export const ROLLOUT_DEFAULTS = { stages: [0.2, 0.5, 1], holdDays: [2, 5], minUsers: 2 };

export interface PlayRolloutDeps {
  config: RunnerConfig;
  store: Store;
  google: GoogleJson;
  notify(text: string): Promise<unknown>;
  now?(): Date;
}

/** A release on the production track, as an edit returns it. */
export interface TrackRelease {
  name?: string;
  versionCodes?: string[];
  status?: string;
  userFraction?: number;
  releaseNotes?: unknown[];
  [key: string]: unknown;
}

interface Seen { code: string; fraction: number; since: string }

export type RolloutPlan =
  | { action: "none"; why: string }
  | { action: "wait"; why: string; code: string; name: string; fraction: number; nextAt?: string }
  | { action: "advance"; code: string; name: string; fraction: number; next: number }
  | { action: "halt"; code: string; name: string; fraction: number; why: string[]; keys: string[] };

const pct = (f: number) => `${Math.round(f * 100)}%`;
const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "numeric", timeZone: "America/Puerto_Rico" });

/** Where a fraction sits in the stages: the index of the last stage at or below it (0 below the first). */
export function stageIndex(stages: number[], fraction: number): number {
  let i = 0;
  stages.forEach((s, j) => { if (fraction + 1e-9 >= s) i = j; });
  return i;
}

/** The next fraction after `fraction`, or 1. */
export function nextStage(stages: number[], fraction: number): number {
  return stages.find(s => s > fraction + 1e-9) ?? 1;
}

/** The crash groups that started in this version and are big enough to halt for, minus ones already accepted. */
export function newCrashGroups(issues: PlayIssue[], code: string, minUsers: number, accepted: Set<string>): CrashGroup[] {
  const started = issues.filter(i => i.firstAppVersion?.versionCode === code);
  return groupIssues(started).filter(g => g.users >= minUsers && !accepted.has(g.key));
}

export class PlayRollout {
  constructor(private deps: PlayRolloutDeps) {}

  private now(): Date { return this.deps.now?.() ?? new Date(); }
  private get settings() { return { ...ROLLOUT_DEFAULTS, ...this.deps.config.playRollout }; }

  enabled(): boolean { return Boolean(this.deps.config.playRollout) && this.apps().length > 0; }

  apps(): { pkg: string; repo: string; name: string }[] {
    const { config, store } = this.deps;
    if (!config.playRollout) return [];
    // Every repo with a Play package, whatever its listing autonomy: rollouts aren't listing changes.
    return Object.keys(config.repos).flatMap(repo => {
      const aso = policyFor(config, repo).aso;
      const pkg = aso?.play?.packageName;
      if (!pkg) return [];
      const name = (aso.appId && store.cursor(`analytics:${aso.appId}:name`)) || repo.split("/")[1];
      return [{ pkg, repo, name }];
    });
  }

  async tick(force = false): Promise<RolloutPlan[]> {
    const { store } = this.deps;
    const last = store.cursor("rollout:synced");
    if (!force && last && this.now().getTime() - Date.parse(last) < EVERY_MS) return [];
    store.setCursor("rollout:synced", this.now().toISOString());
    const plans: RolloutPlan[] = [];
    for (const app of this.apps()) {
      try {
        const plan = await this.plan(app.pkg);
        plans.push(plan);
        if (plan.action === "advance") await this.advance(app, plan);
        if (plan.action === "halt") await this.halt(app, plan);
        store.deleteCursor(`rollout:error:${app.pkg}`);
      } catch (error) {
        const message = (error as Error).message.slice(0, 300);
        if (store.cursor(`rollout:error:${app.pkg}`) !== message) {
          console.warn(`[rollout] ${app.pkg}: ${message}`);
          store.event(null, "play_rollout_error", `${app.pkg}: ${message}`);
          await this.deps.notify(`⚠️ **${app.name}** Play rollout: couldn't check the production rollout (${message}). It stays where it is until the next check works.`).catch(() => undefined);
        }
        store.setCursor(`rollout:error:${app.pkg}`, message);
        plans.push({ action: "none", why: `error: ${message}` });
      }
    }
    return plans;
  }

  /** What the next step for this app's production rollout is, without changing anything on Play. */
  async plan(pkg: string): Promise<RolloutPlan> {
    const { store } = this.deps;
    const s = this.settings;
    const releases = (await this.track(pkg)).filter(r => r.status === "inProgress" || r.status === "halted");
    const release = releases[0];
    if (!release) { store.deleteCursor(`rollout:seen:${pkg}`); return { action: "none", why: "no staged rollout in production" }; }
    const code = String(release.versionCodes?.[0] ?? "");
    const name = release.name ?? code;
    const fraction = Number(release.userFraction ?? 0);
    if (release.status === "halted") return { action: "wait", why: "halted; resume it in Play Console or with `runner play rollout resume`", code, name, fraction };
    const state = await this.lifecycle(pkg, code);
    if (state !== "RELEASE_LIFECYCLE_STATE_PUBLISHED") {
      const why = state === "RELEASE_LIFECYCLE_STATE_APPROVED_NOT_PUBLISHED"
        ? "approved by Google but not published: managed publishing is on, so someone has to press Publish in Play Console"
        : "in Google's review";
      return { action: "wait", why, code, name, fraction };
    }

    const now = this.now();
    let seen = parseSeen(store.cursor(`rollout:seen:${pkg}`));
    if (!seen || seen.code !== code || Math.abs(seen.fraction - fraction) > 1e-9) {
      seen = { code, fraction, since: now.toISOString() };
      store.setCursor(`rollout:seen:${pkg}`, JSON.stringify(seen));
    }
    const hold = (s.holdDays[stageIndex(s.stages, fraction)] ?? s.holdDays[s.holdDays.length - 1] ?? 2) * 86_400_000;
    const nextAt = new Date(Date.parse(seen.since) + hold).toISOString();

    // Crashes are checked on every pass, so a bad version halts as soon as Play shows it, not only at the next step.
    const accepted = new Set(JSON.parse(store.cursor(`rollout:accepted:${pkg}:${code}`) ?? "[]") as string[]);
    const groups = newCrashGroups(await this.issues(pkg), code, s.minUsers, accepted);
    const rates = await this.rates(pkg, code);
    const why = [
      ...groups.map(g => `${g.kind === "anr" ? "ANR" : g.what.split(".").pop()} in ${shortWhere(g)}, new in this version (${g.users} users)`),
      ...rates.filter(r => !accepted.has(`rate:${r.kind}`)).map(r => `user-perceived ${r.kind} rate ${r.rate.toFixed(2)}%, over Play's ${PLAY_THRESHOLDS[r.kind]}% threshold (${r.users} users)`),
    ];
    if (why.length) return { action: "halt", code, name, fraction, why, keys: [...groups.map(g => g.key), ...rates.map(r => `rate:${r.kind}`)] };
    if (now.getTime() < Date.parse(nextAt)) return { action: "wait", why: `at ${pct(fraction)} until ${day(nextAt)}`, code, name, fraction, nextAt };
    return { action: "advance", code, name, fraction, next: nextStage(s.stages, fraction) };
  }

  /** Resumes a halted rollout at its percentage and accepts the crashes it halted for. */
  async resume(pkg: string): Promise<string> {
    const release = (await this.track(pkg)).find(r => r.status === "halted");
    if (!release) return `${pkg}: no halted rollout in production`;
    const code = String(release.versionCodes?.[0] ?? "");
    const halted = this.deps.store.cursor(`rollout:halted:${pkg}:${code}`);
    if (halted) this.deps.store.setCursor(`rollout:accepted:${pkg}:${code}`, halted);
    await this.update(pkg, code, r => ({ ...r, status: "inProgress" }));
    this.deps.store.event(null, "play_rollout", `${pkg} ${release.name ?? code}: resumed at ${pct(Number(release.userFraction ?? 0))}`);
    return `${pkg}: resumed ${release.name ?? code} at ${pct(Number(release.userFraction ?? 0))}`;
  }

  private async advance(app: { pkg: string; name: string }, plan: Extract<RolloutPlan, { action: "advance" }>): Promise<void> {
    const done = plan.next >= 1;
    const pending = await this.update(app.pkg, plan.code, r => {
      if (!done) return { ...r, userFraction: plan.next };
      const { userFraction: _, ...rest } = r;
      return { ...rest, status: "completed" };
    });
    const { store, config } = this.deps;
    store.setCursor(`rollout:seen:${app.pkg}`, JSON.stringify({ code: plan.code, fraction: plan.next, since: this.now().toISOString() } satisfies Seen));
    store.event(null, "play_rollout", `${app.pkg} ${plan.name}: ${pct(plan.fraction)} → ${done ? "everyone" : pct(plan.next)}`);
    const s = { ...ROLLOUT_DEFAULTS, ...config.playRollout };
    const hold = s.holdDays[stageIndex(s.stages, plan.next)];
    const then = done ? "Everyone on Google Play now gets it." : `Next step in ${hold} day${hold === 1 ? "" : "s"} if no new crashes show up.`;
    await this.deps.notify(pending
      ? `📈 **${app.name}** ${plan.name} (${plan.code}): the rollout change to ${done ? "everyone" : pct(plan.next)} is saved in Play Console but waits there to be sent (managed publishing is on).`
      : `📈 **${app.name}** ${plan.name} (${plan.code}) on Google Play: ${pct(plan.fraction)} → ${done ? "**everyone**" : `**${pct(plan.next)}**`} of users. No new crashes in this version. ${then}`).catch(() => undefined);
  }

  private async halt(app: { pkg: string; name: string }, plan: Extract<RolloutPlan, { action: "halt" }>): Promise<void> {
    await this.update(app.pkg, plan.code, r => ({ ...r, status: "halted" }));
    this.deps.store.setCursor(`rollout:halted:${app.pkg}:${plan.code}`, JSON.stringify(plan.keys));
    this.deps.store.event(null, "play_rollout", `${app.pkg} ${plan.name}: halted at ${pct(plan.fraction)}: ${plan.why.join("; ")}`);
    await this.deps.notify([
      `🛑 **${app.name}** ${plan.name} (${plan.code}): halted the Google Play rollout at ${pct(plan.fraction)}.`,
      ...plan.why.map(w => `• ${w}`),
      "People who already updated keep this version; nobody else gets it. Once it's fixed, ship a new version, or resume this one in Play Console (Manage rollout → Resume) or with `npm run runner -- play rollout resume " + app.pkg + "` (that accepts these crashes).",
    ].join("\n")).catch(() => undefined);
  }

  // ---- Google Play ----

  /** The production track's releases, read inside a throwaway edit (deleted, never committed). */
  async track(pkg: string): Promise<TrackRelease[]> {
    const g = this.deps.google;
    const edit = await g.json(PUBLISHER_SCOPE, `${PUBLISHER}/${pkg}/edits`, { method: "POST", body: {} }) as { id?: string };
    if (!edit?.id) throw new Error("Play returned no edit id");
    try {
      const t = await g.json(PUBLISHER_SCOPE, `${PUBLISHER}/${pkg}/edits/${edit.id}/tracks/production`) as { releases?: TrackRelease[] } | null;
      return t?.releases ?? [];
    } finally {
      await g.json(PUBLISHER_SCOPE, `${PUBLISHER}/${pkg}/edits/${edit.id}`, { method: "DELETE" }).catch(() => undefined);
    }
  }

  /** This version's production release lifecycle (PUBLISHED once it's past review and live). */
  private async lifecycle(pkg: string, code: string): Promise<string | undefined> {
    const r = await this.deps.google.json(PUBLISHER_SCOPE, `${PUBLISHER}/${pkg}/tracks/production/releases`) as
      { releases?: { activeArtifacts?: { versionCode?: number | string }[]; releaseLifecycleState?: string }[] } | null;
    const release = r?.releases?.find(x => x.activeArtifacts?.some(a => String(a.versionCode) === code));
    return release?.releaseLifecycleState;
  }

  /**
   * Changes one release on the production track and commits. Returns true when Play only saved it (managed
   * publishing), false when it went live.
   */
  private async update(pkg: string, code: string, change: (r: TrackRelease) => TrackRelease): Promise<boolean> {
    const g = this.deps.google;
    const edit = await g.json(PUBLISHER_SCOPE, `${PUBLISHER}/${pkg}/edits`, { method: "POST", body: {} }) as { id?: string };
    if (!edit?.id) throw new Error("Play returned no edit id");
    const url = `${PUBLISHER}/${pkg}/edits/${edit.id}`;
    let committed = false;
    try {
      const t = await g.json(PUBLISHER_SCOPE, `${url}/tracks/production`) as { releases?: TrackRelease[] } | null;
      const releases = t?.releases ?? [];
      if (!releases.some(r => r.versionCodes?.includes(code))) throw new Error(`version ${code} is no longer on the production track`);
      await g.json(PUBLISHER_SCOPE, `${url}/tracks/production`, {
        method: "PUT",
        body: { track: "production", releases: releases.map(r => r.versionCodes?.includes(code) ? change(r) : r) },
      });
      try {
        await g.json(PUBLISHER_SCOPE, `${url}:commit`, { method: "POST" });
        committed = true;
        return false;
      } catch (error) {
        if (!(error instanceof GoogleApiError) || !/changesNotSentForReview/i.test(error.message)) throw error;
        await g.json(PUBLISHER_SCOPE, `${url}:commit?changesNotSentForReview=true`, { method: "POST" });
        committed = true;
        return true;
      }
    } finally {
      if (!committed) await g.json(PUBLISHER_SCOPE, url, { method: "DELETE" }).catch(() => undefined);
    }
  }

  private interval(days: number): string {
    const n = this.now();
    const end = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()));
    const start = new Date(end.getTime() - days * 86_400_000);
    const t = (p: string, d: Date) => `${p}.year=${d.getUTCFullYear()}&${p}.month=${d.getUTCMonth() + 1}&${p}.day=${d.getUTCDate()}&${p}.timeZone.id=UTC`;
    return `${t("interval.startTime", start)}&${t("interval.endTime", end)}`;
  }

  private async issues(pkg: string): Promise<PlayIssue[]> {
    const out: PlayIssue[] = [];
    let token = "";
    for (let page = 0; page < 10; page++) {
      const url = `${REPORTING}/apps/${pkg}/errorIssues:search?pageSize=100&${this.interval(WINDOW_DAYS)}${token ? `&pageToken=${encodeURIComponent(token)}` : ""}`;
      const r = await this.deps.google.json(REPORTING_SCOPE, url) as { errorIssues?: PlayIssue[]; nextPageToken?: string } | null;
      out.push(...r?.errorIssues ?? []);
      if (!r?.nextPageToken) break;
      token = r.nextPageToken;
    }
    return out;
  }

  /** This version's user-perceived crash and ANR rates over the last 7 days, when Play returns them and they're bad. */
  private async rates(pkg: string, code: string): Promise<{ kind: "crash" | "anr"; rate: number; users: number }[]> {
    const end = new Date(this.now().getTime() - 2 * 86_400_000);
    const start = new Date(end.getTime() - 7 * 86_400_000);
    const date = (d: Date) => ({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), timeZone: { id: "America/Los_Angeles" } });
    const out: { kind: "crash" | "anr"; rate: number; users: number }[] = [];
    for (const [kind, set, metric] of [["crash", "crashRateMetricSet", "userPerceivedCrashRate"], ["anr", "anrRateMetricSet", "userPerceivedAnrRate"]] as const) {
      const r = await this.deps.google.json(REPORTING_SCOPE, `${REPORTING}/apps/${pkg}/${set}:query`, {
        method: "POST",
        body: { timelineSpec: { aggregationPeriod: "DAILY", startTime: date(start), endTime: date(end) }, dimensions: ["versionCode"], metrics: [metric, "distinctUsers"] },
      }) as { rows?: { dimensions?: { dimension?: string; stringValue?: string; int64Value?: string }[]; metrics?: { metric: string; decimalValue?: { value?: string } }[] }[] } | null;
      let users = 0, weighted = 0;
      for (const row of r?.rows ?? []) {
        const v = row.dimensions?.find(d => d.dimension === "versionCode");
        if ((v?.stringValue ?? v?.int64Value) !== code) continue;
        const get = (m: string) => Number(row.metrics?.find(x => x.metric === m)?.decimalValue?.value);
        const u = get("distinctUsers"), rate = get(metric);
        if (!Number.isFinite(u) || !Number.isFinite(rate)) continue;
        users += u; weighted += rate * u;
      }
      const rate = users ? weighted / users * 100 : 0;
      if (users >= MIN_RATE_USERS && rate > PLAY_THRESHOLDS[kind]) out.push({ kind, rate, users });
    }
    return out;
  }
}

function parseSeen(raw: string | null | undefined): Seen | null {
  if (!raw) return null;
  try { const s = JSON.parse(raw) as Seen; return s.code && typeof s.fraction === "number" && s.since ? s : null; } catch { return null; }
}

/** One line per plan, for the CLI. */
export function planText(pkg: string, plan: RolloutPlan): string {
  switch (plan.action) {
    case "none": return `${pkg}: ${plan.why}`;
    case "wait": return `${pkg}: ${plan.name} (${plan.code}) at ${pct(plan.fraction)}: waiting (${plan.why})`;
    case "advance": return `${pkg}: ${plan.name} (${plan.code}) ${pct(plan.fraction)} → ${plan.next >= 1 ? "everyone" : pct(plan.next)}`;
    case "halt": return `${pkg}: ${plan.name} (${plan.code}) at ${pct(plan.fraction)}: halt (${plan.why.join("; ")})`;
  }
}
