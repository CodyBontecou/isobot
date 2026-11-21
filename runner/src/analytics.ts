import type { RunnerConfig } from "./config.js";
import { localDay } from "./content.js";
import type { Store } from "./store.js";

/**
 * App Store Connect analytics: Apple's own numbers for each App Store app (appStore.apps), from the Analytics
 * Reports API through the asc CLI. Every app needs an ONGOING report request in App Store Connect, which keeps
 * producing daily reports on its own; the runner only reads.
 *
 *   1. sync: every few hours, each app's daily report instances for the last `backfillDays` processing dates
 *      are downloaded once (instance ids are remembered) and summed into one record per app and day
 *   2. read: the daily check-in, the weekly ASO report and the staff chat's app_analytics tool use those records
 *
 * Apple restates recent days: the instance processed on day P has rows for P-1 back to P-3 (sessions: P-6), and
 * a later instance's numbers for a day replace an earlier one's. So each day keeps, per report, the numbers from
 * the newest processing date that covered it. Numbers are Apple's, and Apple drops rows under its privacy
 * thresholds, so small counts are approximate.
 */

/** The asc CLI with these arguments (no shell); JSON commands print JSON on stdout. */
export type AscRun = (args: string[]) => Promise<{ ok: boolean; stdout: string; stderr: string }>;

export interface AnalyticsDeps {
  config: RunnerConfig;
  store: Store;
  asc: AscRun;
  /** Downloads a report segment (gzip) and returns its text. */
  fetchGz(url: string): Promise<string>;
  now?(): Date;
}

/** One app's totals for one day, across territories and devices. A report that hasn't arrived leaves its fields out. */
export interface DayMetrics {
  /** App Store impressions (search, browse, referrers). */
  impressions?: number;
  /** Product page views. */
  pageViews?: number;
  firstDownloads?: number;
  redownloads?: number;
  installs?: number;
  deletions?: number;
  sessions?: number;
  /** In-app and app purchases, and their proceeds in USD. */
  purchases?: number;
  proceeds?: number;
  /** Subscription events by Apple's event group (Offer start, Renewal, Voluntary churn, …). */
  subEvents?: Record<string, number>;
  /** Subscriptions by state on that day (Full price, Free trial, Billing retry, …). */
  subStates?: Record<string, number>;
}

/** The reports the runner reads, by Apple's report name, and what each contributes to a day. */
const REPORTS = {
  discovery: "App Store Discovery and Engagement Standard",
  downloads: "App Downloads Standard",
  installs: "App Store Installation and Deletion Standard",
  sessions: "App Sessions Standard",
  purchases: "App Store Purchases Standard",
  subEvents: "App Store Subscription Event Report Standard",
  subStates: "App Store Subscription State Report Standard",
} as const;
export type ReportKey = keyof typeof REPORTS;
const REPORT_BY_NAME = new Map<string, ReportKey>(Object.entries(REPORTS).map(([k, v]) => [v, k as ReportKey]));

/** What each report sets on a day; replacing a report's numbers clears exactly these. */
const FIELDS: Record<ReportKey, (keyof DayMetrics)[]> = {
  discovery: ["impressions", "pageViews"],
  downloads: ["firstDownloads", "redownloads"],
  installs: ["installs", "deletions"],
  sessions: ["sessions"],
  purchases: ["purchases", "proceeds"],
  subEvents: ["subEvents"],
  subStates: ["subStates"],
};

interface DayRecord { src: Partial<Record<ReportKey, string>>; m: DayMetrics }

const SYNC_EVERY_MS = 6 * 3_600_000;
/** Instances read per app and pass (a request each), so a first backfill spreads over a few passes. */
const INSTANCES_PER_PASS = 60;

/** App Store Connect refused for its hourly rate limit. */
export class RateLimited extends Error {}

function failure(what: string, r: { stdout: string; stderr: string }): Error {
  const text = (r.stderr || r.stdout).trim().slice(-300);
  return /\b429\b|rate limit/i.test(text) ? new RateLimited(`${what}: App Store Connect rate limit (${text.slice(-120)})`) : new Error(`${what}: ${text}`);
}
const KEEP_DAYS = 400;

/** Parses Apple's tab-separated report text into rows keyed by column name. */
export function parseTsv(text: string): Record<string, string>[] {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return [];
  const header = lines[0].split("\t").map(h => h.trim());
  return lines.slice(1).map(line => {
    const cells = line.split("\t");
    return Object.fromEntries(header.map((h, i) => [h, (cells[i] ?? "").trim()]));
  });
}

const n = (value: string | undefined) => {
  const x = Number(value ?? "");
  return Number.isFinite(x) ? x : 0;
};
const add = (map: Record<string, number>, key: string, by: number) => { if (key) map[key] = (map[key] ?? 0) + by; };

/** One report's rows summed per day. */
export function aggregate(report: ReportKey, rows: Record<string, string>[]): Map<string, DayMetrics> {
  const days = new Map<string, DayMetrics>();
  for (const row of rows) {
    const day = row["Date"] || row["Event Date"];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day ?? "")) continue;
    const m = days.get(day) ?? blank(report);
    days.set(day, m);
    switch (report) {
      case "discovery":
        if (row["Event"] === "Impression") m.impressions! += n(row["Counts"]);
        else if (row["Event"] === "Page view" && row["Page Type"] === "Product page") m.pageViews! += n(row["Counts"]);
        break;
      case "downloads":
        if (row["Download Type"] === "First-time download") m.firstDownloads! += n(row["Counts"]);
        else if (row["Download Type"] === "Redownload") m.redownloads! += n(row["Counts"]);
        break;
      case "installs":
        if (row["Event"] === "Install") m.installs! += n(row["Counts"]);
        else if (row["Event"] === "Delete") m.deletions! += n(row["Counts"]);
        break;
      case "sessions":
        m.sessions! += n(row["Sessions"]);
        break;
      case "purchases":
        m.purchases! += n(row["Purchases"]);
        m.proceeds! += n(row["Proceeds in USD"]);
        break;
      case "subEvents":
        add(m.subEvents!, row["Event Group"], n(row["Counts"]));
        break;
      case "subStates":
        add(m.subStates!, row["State Metric"], n(row["Counts"]));
        break;
    }
  }
  for (const m of days.values()) if (m.proceeds !== undefined) m.proceeds = Math.round(m.proceeds * 100) / 100;
  return days;
}

function blank(report: ReportKey): DayMetrics {
  const m: DayMetrics = {};
  for (const f of FIELDS[report]) (m as Record<string, unknown>)[f] = f === "subEvents" || f === "subStates" ? {} : 0;
  return m;
}

/**
 * Folds one report's numbers for a day into the stored record: they replace that report's earlier numbers when
 * they come from the same or a newer processing date, and are ignored when an older one.
 */
export function mergeDay(record: DayRecord | null, report: ReportKey, processingDate: string, metrics: DayMetrics): DayRecord {
  const r: DayRecord = record ? { src: { ...record.src }, m: { ...record.m } } : { src: {}, m: {} };
  const had = r.src[report];
  if (had && had > processingDate) return r;
  for (const f of FIELDS[report]) delete r.m[f];
  Object.assign(r.m, metrics);
  r.src[report] = processingDate;
  return r;
}

/** Paid subscriptions on a day: every state except trials, churn and billing retry. */
export function paidSubscriptions(m: DayMetrics): number | null {
  if (!m.subStates) return null;
  return Object.entries(m.subStates).filter(([s]) => !/trial|churn|billing retry/i.test(s)).reduce((a, [, c]) => a + c, 0);
}
const trials = (m: DayMetrics) => m.subStates ? Object.entries(m.subStates).filter(([s]) => /free trial/i.test(s)).reduce((a, [, c]) => a + c, 0) : null;
const churned = (m: DayMetrics) => m.subEvents ? Object.entries(m.subEvents).filter(([e]) => /churn/i.test(e)).reduce((a, [, c]) => a + c, 0) : null;
const event = (m: DayMetrics, group: string) => m.subEvents?.[group] ?? 0;

export interface AppDay { day: string; m: DayMetrics }

/** Sums a run of days (subscription states are a level, so they come from the last day instead). */
export function sumDays(days: AppDay[]): DayMetrics & { days: number } {
  const total: DayMetrics & { days: number } = { days: days.length };
  const numeric = ["impressions", "pageViews", "firstDownloads", "redownloads", "installs", "deletions", "sessions", "purchases", "proceeds"] as const;
  for (const { m } of days) {
    for (const f of numeric) if (m[f] !== undefined) total[f] = (total[f] ?? 0) + m[f]!;
    if (m.subEvents) { total.subEvents ??= {}; for (const [k, v] of Object.entries(m.subEvents)) add(total.subEvents, k, v); }
  }
  const last = [...days].reverse().find(d => d.m.subStates);
  if (last) total.subStates = last.m.subStates;
  if (total.proceeds !== undefined) total.proceeds = Math.round(total.proceeds * 100) / 100;
  return total;
}

/**
 * The first-run paywall's funnel over a run of days, from Apple's numbers. Every app shows its paywall on first
 * launch, so first-time downloads stand in for paywall views (Apple can't see the paywall; a download never
 * opened counts too, so the rates are a floor). Subscription apps: offer starts (free trials) and paid
 * subscriptions, from an offer or straight, per download. Apps without subscription events: purchases per download.
 * Cohorts don't line up day by day (a trial converts a week later), so read it over a week or more.
 */
export interface Paywall {
  kind: "subscription" | "purchase";
  /** First-time downloads: the paywall's first-run audience. */
  shown: number;
  trials: number | null;
  paid: number;
  trialPct: number | null;
  paidPct: number;
}

export function paywall(m: DayMetrics): Paywall | null {
  if (!m.firstDownloads) return null;
  const rate = (x: number) => Math.round((x / m.firstDownloads!) * 1000) / 10;
  const events = m.subEvents && Object.keys(m.subEvents).length ? m.subEvents : null;
  if (events) {
    const trials = events["Offer start"] ?? 0;
    const paid = (events["Paid subscription from offer"] ?? 0) + (events["Subscribe"] ?? 0);
    return { kind: "subscription", shown: m.firstDownloads, trials, paid, trialPct: rate(trials), paidPct: rate(paid) };
  }
  if (m.purchases === undefined) return null;
  return { kind: "purchase", shown: m.firstDownloads, trials: null, paid: m.purchases, trialPct: null, paidPct: rate(m.purchases) };
}

/** "paywall: 39% start a trial, 20% subscribe" for a check-in or report line. */
export function paywallText(p: Paywall | null, before?: Paywall | null): string | null {
  if (!p) return null;
  const was = (now: number | null, then: number | null | undefined) => now !== null && then !== null && then !== undefined && before?.kind === p.kind ? ` (was ${then}%)` : "";
  return p.kind === "subscription"
    ? `paywall → trial ${p.trialPct}%${was(p.trialPct, before?.trialPct)}, → paid ${p.paidPct}%${was(p.paidPct, before?.paidPct)}`
    : `paywall → purchase ${p.paidPct}%${was(p.paidPct, before?.paidPct)}`;
}

/** Product page view → first-time download, as a percentage. */
export function conversion(m: DayMetrics): number | null {
  if (!m.pageViews || m.firstDownloads === undefined) return null;
  return Math.round((m.firstDownloads / m.pageViews) * 1000) / 10;
}

const fmt = (x: number) => x >= 10_000 ? `${Math.round(x / 1000)}k` : x.toLocaleString("en-US");
const usd = (x: number) => `$${x.toLocaleString("en-US", { minimumFractionDigits: x < 100 ? 2 : 0, maximumFractionDigits: x < 100 ? 2 : 0 })}`;
const pct = (now: number, before: number) => before === 0 ? (now === 0 ? "±0%" : "new") : `${now >= before ? "+" : ""}${Math.round(((now - before) / before) * 100)}%`;
const shortDay = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const addDays = (day: string, by: number) => new Date(Date.parse(`${day}T12:00:00Z`) + by * 86_400_000).toISOString().slice(0, 10);

/** One app's line in the daily check-in: its latest complete day, against the 7 days before. */
export function dayLine(name: string, day: AppDay, before: AppDay[], week?: AppDay[]): string {
  const m = day.m;
  const avg = (f: (x: DayMetrics) => number | null | undefined) => {
    const xs = before.map(d => f(d.m)).filter((x): x is number => typeof x === "number");
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  };
  const parts: string[] = [];
  if (m.firstDownloads !== undefined) {
    const a = avg(x => x.firstDownloads);
    parts.push(`${fmt(m.firstDownloads)} new downloads${a !== null ? ` (7-day avg ${Math.round(a)})` : ""}`);
  }
  if (m.impressions !== undefined) {
    const c = conversion(m);
    parts.push(`${fmt(m.impressions)} impressions → ${fmt(m.pageViews ?? 0)} page views${c !== null ? ` (${c}% downloaded)` : ""}`);
  }
  if (m.purchases) parts.push(`${fmt(m.purchases)} purchases, ${usd(m.proceeds ?? 0)}`);
  const paid = paidSubscriptions(m);
  if (paid !== null || m.subEvents) {
    const subs: string[] = [];
    if (paid !== null) subs.push(`${paid} paid, ${trials(m)} in trial`);
    if (m.subEvents) {
      const moves = [[event(m, "Offer start"), "offer starts"], [event(m, "Paid subscription from offer"), "converted"], [churned(m) ?? 0, "churned"]] as const;
      const said = moves.filter(([c]) => c > 0).map(([c, label]) => `${c} ${label}`);
      if (said.length) subs.push(said.join(", "));
    }
    if (subs.length) parts.push(`subs: ${subs.join("; ")}`);
  }
  const funnel = week?.length === 7 ? paywallText(paywall(sumDays(week))) : null;
  if (funnel) parts.push(`${funnel} (7 days)`);
  return `**${name}** (${shortDay(day.day)}): ${parts.join(" · ") || "no activity"}`;
}

/** Things worth a check-in on their own: a jump or drop in downloads, a churn spike, data that stopped arriving. */
export function flags(name: string, day: AppDay | null, before: AppDay[], today: string): string[] {
  if (!day) return [];
  const out: string[] = [];
  const stale = Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${day.day}T12:00:00Z`)) / 86_400_000);
  if (stale >= 5) out.push(`⚠️ ${name}: no App Store analytics since ${shortDay(day.day)} (${stale} days). Check its report request in App Store Connect.`);
  const series = (f: (m: DayMetrics) => number | null | undefined) => before.map(d => f(d.m)).filter((x): x is number => typeof x === "number");
  const dl = series(m => m.firstDownloads);
  if (day.m.firstDownloads !== undefined && dl.length >= 5) {
    const a = dl.reduce((x, y) => x + y, 0) / dl.length;
    if (a >= 5 && day.m.firstDownloads >= 2 * a) out.push(`📈 ${name}: ${day.m.firstDownloads} new downloads on ${shortDay(day.day)}, ${(day.m.firstDownloads / a).toFixed(1)}× the 7-day average (${Math.round(a)}).`);
    else if (a >= 5 && day.m.firstDownloads <= 0.4 * a) out.push(`📉 ${name}: ${day.m.firstDownloads} new downloads on ${shortDay(day.day)}, against a 7-day average of ${Math.round(a)}.`);
  }
  const ch = series(churned);
  const now = churned(day.m);
  if (now !== null && ch.length >= 5) {
    const a = ch.reduce((x, y) => x + y, 0) / ch.length;
    if (now >= 3 && now >= 2 * a + 1) out.push(`⚠️ ${name}: ${now} subscriptions churned on ${shortDay(day.day)} (7-day average ${a.toFixed(1)}).`);
  }
  return out;
}

/** Seven days whose App Store numbers (discovery and downloads) have all arrived. */
const complete = (week: AppDay[]) => week.length === 7 && week.every(d => d.m.impressions !== undefined && d.m.firstDownloads !== undefined);

/** The weekly ASO report's App Store line: the last 7 complete days against the 7 before. */
export function weekText(thisWeek: AppDay[], lastWeek: AppDay[]): string | null {
  // A partial week (a first backfill still filling in) would read as a big change, so only whole weeks count.
  if (!complete(thisWeek)) return null;
  const a = sumDays(thisWeek);
  const b = complete(lastWeek) ? sumDays(lastWeek) : null;
  const span = `${shortDay(thisWeek[0].day)}–${shortDay(thisWeek.at(-1)!.day)}`;
  const item = (label: string, now: number | undefined, then: number | undefined, show = fmt) =>
    now === undefined ? null : `${label} ${show(now)}${b && then !== undefined ? ` (${pct(now, then)})` : ""}`;
  const ca = conversion(a);
  const cb = b ? conversion(b) : null;
  const parts = [
    item("impressions", a.impressions, b?.impressions),
    item("page views", a.pageViews, b?.pageViews),
    ca !== null ? `page → download ${ca}%${cb !== null ? ` (was ${cb}%)` : ""}` : null,
    item("new downloads", a.firstDownloads, b?.firstDownloads),
    a.purchases ? item("proceeds", a.proceeds, b?.proceeds, usd) : null,
  ].filter(Boolean);
  const funnel = paywallText(paywall(a), b ? paywall(b) : null);
  if (funnel) parts.push(funnel);
  const paid = paidSubscriptions(a);
  const paidBefore = b ? paidSubscriptions(b) : null;
  if (paid !== null) parts.push(`paid subscriptions ${paid}${paidBefore !== null ? ` (was ${paidBefore})` : ""}`);
  if (!parts.length) return null;
  return `**App Store analytics** (${span}${b ? ", vs the 7 days before" : ""}): ${parts.join(" · ")}`;
}

export interface CheckInAnalytics {
  /** One line per app with data. */
  lines: string[];
  /** Notable changes: each is reason enough to post a check-in. */
  flags: string[];
}

/** What other parts of the runner read. */
export interface AnalyticsView {
  checkIn(): CheckInAnalytics;
  weekLine(appId: string): string | null;
  /** The app_analytics chat tool: one app's days, or every app's latest week when `app` is omitted. */
  describe(app: string | null, days: number): unknown;
}

export class AppAnalytics implements AnalyticsView {
  constructor(private deps: AnalyticsDeps) {}

  private now(): Date { return this.deps.now?.() ?? new Date(); }
  private key(appId: string, what: string) { return `analytics:${appId}:${what}`; }
  private get limits() { return { backfillDays: 35, ...this.deps.config.analytics }; }

  /** The apps followed: appStore.apps, or the `analytics.apps` subset of it. */
  apps(): { appId: string; repo: string }[] {
    if (!this.deps.config.analytics) return [];
    const all = Object.entries(this.deps.config.appStore?.apps ?? {}).map(([appId, repo]) => ({ appId, repo }));
    const only = this.deps.config.analytics.apps;
    return only ? all.filter(a => only.includes(a.appId)) : all;
  }

  /** Apple's name for the app (from its reports), else the repository's. */
  name(appId: string): string {
    return this.deps.store.cursor(this.key(appId, "name")) ?? this.apps().find(a => a.appId === appId)?.repo.split("/")[1] ?? appId;
  }

  /** One pass: every app's new report instances, at most every few hours unless forced. */
  async tick(force = false): Promise<void> {
    const { store } = this.deps;
    const last = store.cursor("analytics:synced");
    if (!force && last && this.now().getTime() - Date.parse(last) < SYNC_EVERY_MS) return;
    store.setCursor("analytics:synced", this.now().toISOString());
    for (const app of this.apps()) {
      try {
        const read = await this.sync(app.appId);
        if (read) console.log(`[analytics] ${this.name(app.appId)}: ${read} report instance${read === 1 ? "" : "s"} read`);
      } catch (error) {
        console.warn(`[analytics] ${app.repo}: ${(error as Error).message}`);
        store.event(null, "analytics_error", `${app.repo}: ${(error as Error).message.slice(0, 300)}`);
        // The rate limit is the API key's, shared with releases and ASO: stop here and leave them room.
        if (error instanceof RateLimited) break;
      }
    }
  }

  /** The app's ONGOING report request, found once and remembered. */
  async requestId(appId: string): Promise<string | null> {
    const cached = this.deps.store.cursor(this.key(appId, "request"));
    if (cached) return cached;
    const r = await this.deps.asc(["analytics", "requests", "--app", appId, "--output", "json"]);
    if (!r.ok) throw failure("asc analytics requests", r);
    const list = (JSON.parse(r.stdout) as { data?: { id: string; attributes?: { accessType?: string; stoppedDueToInactivity?: boolean } }[] }).data ?? [];
    const ongoing = list.find(x => x.attributes?.accessType === "ONGOING" && !x.attributes.stoppedDueToInactivity);
    if (!ongoing) return null;
    this.deps.store.setCursor(this.key(appId, "request"), ongoing.id);
    return ongoing.id;
  }

  /** One App Store Connect GET through `asc api`, every page. */
  private async get(path: string, query: string[] = []): Promise<{ id: string; attributes?: Record<string, unknown> }[]> {
    const r = await this.deps.asc(["api", "GET", path, ...query.flatMap(q => ["--query", q]), "--paginate", "--output", "json"]);
    if (!r.ok) throw failure(`GET ${path}`, r);
    return (JSON.parse(r.stdout || "{}") as { data?: { id: string; attributes?: Record<string, unknown> }[] }).data ?? [];
  }

  /** The ids of the reports the runner reads in a request; they don't change, so they're looked up weekly. */
  private async reportIds(appId: string, request: string): Promise<Partial<Record<ReportKey, string>>> {
    const k = this.key(appId, "reports");
    const cached = JSON.parse(this.deps.store.cursor(k) ?? "null") as { request: string; at: string; ids: Partial<Record<ReportKey, string>> } | null;
    if (cached && cached.request === request && this.now().getTime() - Date.parse(cached.at) < 7 * 86_400_000) return cached.ids;
    const ids: Partial<Record<ReportKey, string>> = {};
    for (const report of await this.get(`/v1/analyticsReportRequests/${request}/reports`, ["fields[analyticsReports]=name", "limit=200"])) {
      const key = REPORT_BY_NAME.get(String(report.attributes?.name ?? "").trim());
      if (key) ids[key] = report.id;
    }
    this.deps.store.setCursor(k, JSON.stringify({ request, at: this.now().toISOString(), ids }));
    return ids;
  }

  /**
   * Reads an app's daily instances it hasn't read yet, newest first; returns how many. A call per report lists its
   * instances and a call per new instance gets its files, so a normal day costs about 14 requests per app.
   */
  async sync(appId: string): Promise<number> {
    const { store } = this.deps;
    const request = await this.requestId(appId);
    if (!request) throw new Error("no ongoing analytics report request in App Store Connect (asc analytics request --app <id> --access-type ONGOING)");
    let reports: Partial<Record<ReportKey, string>>;
    try {
      reports = await this.reportIds(appId, request);
    } catch (error) {
      // A request Apple deleted is looked up again next time.
      if (/\b404\b|not found/i.test((error as Error).message)) store.deleteCursor(this.key(appId, "request"));
      throw error;
    }
    const oldest = addDays(localDay(this.now()), -this.limits.backfillDays);
    const seen = new Set(JSON.parse(store.cursor(this.key(appId, "seen")) ?? "[]") as string[]);
    const todo: { report: ReportKey; id: string; date: string }[] = [];
    for (const [report, id] of Object.entries(reports) as [ReportKey, string][]) {
      for (const instance of await this.get(`/v1/analyticsReports/${id}/instances`, ["filter[granularity]=DAILY", "limit=200"])) {
        const date = String(instance.attributes?.processingDate ?? "");
        if (/^\d{4}-\d{2}-\d{2}$/.test(date) && date >= oldest && !seen.has(instance.id)) todo.push({ report, id: instance.id, date });
      }
    }
    todo.sort((a, b) => b.date.localeCompare(a.date));
    let read = 0;
    try {
      for (const t of todo.slice(0, INSTANCES_PER_PASS)) {
        const urls = (await this.get(`/v1/analyticsReportInstances/${t.id}/segments`)).map(s => String(s.attributes?.url ?? ""));
        await this.ingest(appId, t.report, t.date, urls);
        seen.add(t.id);
        read++;
      }
    } finally {
      store.setCursor(this.key(appId, "seen"), JSON.stringify([...seen].slice(-2000)));
      this.prune(appId);
    }
    return read;
  }

  /** One instance: every segment's rows summed, then folded into the days they cover. */
  private async ingest(appId: string, report: ReportKey, processingDate: string, urls: string[]): Promise<void> {
    const rows: Record<string, string>[] = [];
    for (const url of urls) {
      if (!url.startsWith("https://")) continue;
      rows.push(...parseTsv(await this.deps.fetchGz(url)));
    }
    const appName = rows.find(r => r["App Name"])?.["App Name"];
    if (appName) this.deps.store.setCursor(this.key(appId, "name"), appName.slice(0, 80));
    for (const [day, metrics] of aggregate(report, rows)) {
      const k = this.key(appId, `day:${day}`);
      const before = this.deps.store.cursor(k);
      this.deps.store.setCursor(k, JSON.stringify(mergeDay(before ? JSON.parse(before) as DayRecord : null, report, processingDate, metrics)));
    }
  }

  private prune(appId: string): void {
    const prefix = this.key(appId, "day:");
    const oldest = addDays(localDay(this.now()), -KEEP_DAYS);
    for (const { key } of this.deps.store.cursorsWithPrefix(prefix)) if (key.slice(prefix.length) < oldest) this.deps.store.deleteCursor(key);
  }

  /** Stored days for an app, oldest first, within [from, to]. */
  days(appId: string, from = "0000-00-00", to = "9999-99-99"): AppDay[] {
    const prefix = this.key(appId, "day:");
    return this.deps.store.cursorsWithPrefix(prefix)
      .map(r => ({ day: r.key.slice(prefix.length), m: (JSON.parse(r.value) as DayRecord).m }))
      .filter(d => d.day >= from && d.day <= to);
  }

  /** The newest day whose App Store numbers (discovery and downloads) have arrived. */
  latest(appId: string): AppDay | null {
    return this.days(appId).reverse().find(d => d.m.impressions !== undefined && d.m.firstDownloads !== undefined) ?? null;
  }

  checkIn(): CheckInAnalytics {
    const today = localDay(this.now());
    const lines: string[] = [];
    const found: string[] = [];
    for (const { appId } of this.apps()) {
      const day = this.latest(appId);
      if (!day) continue;
      const before = this.days(appId, addDays(day.day, -7), addDays(day.day, -1));
      lines.push(dayLine(this.name(appId), day, before, this.days(appId, addDays(day.day, -6), day.day)));
      found.push(...flags(this.name(appId), day, before, today));
    }
    return { lines, flags: found };
  }

  weekLine(appId: string): string | null {
    const day = this.latest(appId);
    if (!day) return null;
    return weekText(this.days(appId, addDays(day.day, -6), day.day), this.days(appId, addDays(day.day, -13), addDays(day.day, -7)));
  }

  describe(app: string | null, days: number): unknown {
    const apps = this.apps();
    if (!apps.length) return { error: "App Store analytics isn't configured on this runner (analytics in the runner config)" };
    const note = "Apple's App Store Connect analytics, summed over territories and devices. pageViews are product page views; conversionPct is first-time downloads per product page view; paywall is the first-run paywall funnel: every app shows its paywall on first launch, so shown is first-time downloads (Apple can't see the paywall itself; a download never opened counts too, so rates are a floor), trials are offer starts, paid is subscriptions from an offer or direct (or purchases, for apps without subscriptions); read it over a week, since trials convert days later; proceeds are USD after Apple's commission; subStates are subscriptions by state on that day (a level, not a sum); subEvents count Apple's subscription event groups. Apple drops rows under its privacy thresholds, so small numbers are approximate, and the newest day is usually 2 days ago.";
    if (!app) {
      return {
        note,
        apps: apps.map(a => {
          const day = this.latest(a.appId);
          const week = day ? sumDays(this.days(a.appId, addDays(day.day, -6), day.day)) : null;
          return { appId: a.appId, repo: a.repo, name: this.name(a.appId), latestDay: day?.day ?? null, last7Days: week && { ...week, conversionPct: conversion(week), paidSubscriptions: paidSubscriptions(week), paywall: paywall(week) } };
        }),
      };
    }
    const target = app.trim().toLowerCase();
    const found = apps.find(a => [a.appId, a.repo, a.repo.split("/")[1], this.name(a.appId)].some(x => x.toLowerCase() === target));
    if (!found) return { error: `no followed app "${app}"; use one of: ${apps.map(a => `${this.name(a.appId)} (${a.appId})`).join(", ")}` };
    const list = this.days(found.appId).slice(-Math.min(120, Math.max(1, Math.floor(days) || 14)));
    return {
      note, appId: found.appId, repo: found.repo, name: this.name(found.appId), weekly: this.weekLine(found.appId),
      days: list.map(d => ({ day: d.day, ...d.m, conversionPct: conversion(d.m), paidSubscriptions: paidSubscriptions(d.m) })),
    };
  }
}
