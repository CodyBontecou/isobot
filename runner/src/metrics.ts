import type { DayMetrics } from "./analytics.js";
import type { Applied, DaySnapshot, PlayApplied } from "./aso.js";
import { asoApps, contentRepos, type RunnerConfig } from "./config.js";
import { localDay, type SearchWeek } from "./content.js";
import type { PlayDay } from "./playAnalytics.js";
import { salesDaysRead, salesRead, salesRecords, subsSnapshots, sumRecords, type PlanSnapshot, type Proceeds, type SalesRecord } from "./sales.js";
import type { Store } from "./store.js";

/**
 * The board's Growth view: the numbers isobot's scheduled work already keeps in runner.sqlite (Apple's
 * analytics days, Play Console days, the ASO train's daily rank snapshots and listing changes, the
 * content train's published pages, Search Console weeks and OpenSEO credits), reduced to compact series
 * so the board can chart them over time. Nothing here calls an API; it only reads cursors.
 */

/** How far back the series go. */
export const METRICS_DAYS = 120;
/** Phrases per app in the rank table (across storefronts). */
const PHRASES_PER_APP = 400;

export interface FunnelDay { day: string; v: Record<string, number> }

export interface RankDay {
  day: string;
  /** Phrases measured that day. */
  tracked: number;
  /** In the first 200 results. */
  ranked: number;
  top10: number;
  top3: number;
  /** Median rank of the ranked phrases. */
  median: number | null;
}

export interface PhraseRank {
  text: string;
  storefront: string;
  rank: number | null;
  /** Rank on the comparison days (null: measured, outside 200; absent: not measured then). */
  was7?: number | null;
  was28?: number | null;
  volume: number | null;
}

export interface ListingChange { at: string; fields: string[]; version?: string; liveAt?: string }

export interface MetricsApp {
  repo: string;
  store: "appstore" | "play";
  /** App Store id or Play package. */
  id: string;
  name: string;
  funnel: FunnelDay[];
  /** The storefront the rank series covers: the one the ASO train reports and proposes for. */
  storefront: string;
  /** Rank summary per snapshot day on `storefront`, each phrase at its newest reading (CARRY_DAYS). */
  ranks: RankDay[];
  /** The latest snapshot's phrases, ranked ones first. */
  phrases: PhraseRank[];
  /** The days `was7` and `was28` were read from (the newest snapshot on or before them). */
  compare: { d7: string | null; d28: string | null; latest: string | null };
  changes: ListingChange[];
  /** Apple's Sales and Trends reports (sales.ts); App Store apps only, once any have been read. */
  sales?: AppSales;
}

/** A sales record without its per-currency detail. */
export interface SalesPoint {
  downloads: number;
  lifetime: number;
  subscriptions: number;
  trials: number;
  refunds: number;
  proceeds: Proceeds;
  total: number;
}

export interface AppSales {
  /** The newest day with a daily sales report. */
  through: string | null;
  /** Daily, the last METRICS_DAYS; a day with a report and no sales for the app is all zeros. */
  days: ({ day: string } & SalesPoint)[];
  /** Every month the daily reports cover; `partial` when some of its days have no report (before the window). */
  months: ({ month: string; partial: boolean } & SalesPoint)[];
  /** Apple's yearly reports, and the current year summed from its days (`partial`). */
  years: ({ year: string; partial: boolean } & SalesPoint)[];
  /** Active subscriptions per day: paid, in a free trial, in billing retry or grace, and the paid ones' monthly proceeds. */
  subs: { day: string; paid: number; trials: number; retry: number; monthly: number }[];
  /** The newest snapshot's plans. */
  plans: PlanSnapshot[];
}

export interface PublishedPage { at: string; number: number; title: string; prNumber: number | null }

export interface MetricsSite {
  repo: string;
  site: string;
  published: PublishedPage[];
  /** Weekly Search Console readings by the content train's report day. */
  search: ({ day: string } & SearchWeek)[];
}

export interface BoardMetrics {
  at: string;
  apps: MetricsApp[];
  sites: MetricsSite[];
  credits: { days: { day: string; spent: number }[]; balance: number | null };
}

/** Apple's per-day fields the board charts; subscription events are folded into trials and paid starts. */
function appleDay(m: DayMetrics): Record<string, number> {
  const v: Record<string, number> = {};
  for (const f of ["impressions", "pageViews", "firstDownloads", "redownloads", "installs", "deletions", "sessions", "purchases", "proceeds"] as const) {
    if (typeof m[f] === "number") v[f] = m[f]!;
  }
  if (m.subEvents) {
    v.trials = m.subEvents["Offer start"] ?? 0;
    v.paidStarts = Object.entries(m.subEvents).filter(([e]) => /^paid subscription/i.test(e)).reduce((a, [, c]) => a + c, 0);
  }
  if (v.proceeds !== undefined) v.proceeds = Math.round(v.proceeds * 100) / 100;
  return v;
}

const point = (r: SalesRecord): SalesPoint => ({ downloads: r.downloads, lifetime: r.lifetime, subscriptions: r.subscriptions, trials: r.trials, refunds: r.refunds, proceeds: r.proceeds, total: r.total });
const ZERO: SalesPoint = { downloads: 0, lifetime: 0, subscriptions: 0, trials: 0, refunds: 0, proceeds: { lifetime: 0, subscriptions: 0, paidDownloads: 0, other: 0 }, total: 0 };

/** One app's sales history, from the stored reports; null when there's none. */
export function appSales(store: Store, appId: string, since: string, read = salesDaysRead(store), readYears = salesRead(store, "year")): AppSales | null {
  const days = salesRecords(store, appId, "day");
  const years = salesRecords(store, appId, "year");
  const subs = subsSnapshots(store, appId);
  if (!days.length && !years.length && !subs.length) return null;
  const readDays = [...read].sort();
  const through = readDays.at(-1) ?? null;
  const byDay = new Map(days.map(d => [d.date, d.r]));

  const months = new Map<string, SalesRecord[]>();
  const covered = new Map<string, number>();
  for (const day of readDays) {
    const m = day.slice(0, 7);
    covered.set(m, (covered.get(m) ?? 0) + 1);
    const r = byDay.get(day);
    if (r) months.set(m, [...(months.get(m) ?? []), r]);
    else if (!months.has(m)) months.set(m, []);
  }
  const inMonth = (m: string) => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).getUTCDate();
  const monthList = [...months].sort((a, b) => a[0].localeCompare(b[0])).map(([month, list]) => ({
    month,
    // The newest month is partial too, until it ends.
    partial: (covered.get(month) ?? 0) < inMonth(month),
    ...point(sumRecords(list)),
  }));

  // Leading months before the app's first download or sale aren't history.
  const first = monthList.findIndex(m => m.total || m.downloads);
  monthList.splice(0, first < 0 ? monthList.length : first);

  const yearList = years.map(y => ({ year: y.date, partial: false, ...point(y.r) }));
  // A yearly report without the app: it sold nothing that year (only shown once the app has history).
  for (const year of readYears) if (!yearList.some(y => y.year === year) && monthList.some(m => m.month.startsWith(year))) yearList.push({ year, partial: false, ...ZERO });
  for (const year of new Set(monthList.map(m => m.month.slice(0, 4)))) {
    if (yearList.some(y => y.year === year)) continue;
    yearList.push({ year, partial: true, ...point(sumRecords(days.filter(d => d.date.startsWith(year)).map(d => d.r))) });
  }
  yearList.sort((a, b) => a.year.localeCompare(b.year));

  const last = subs.at(-1);
  return {
    through,
    days: readDays.filter(d => d >= since).map(day => ({ day, ...(byDay.has(day) ? point(byDay.get(day)!) : ZERO) })),
    months: monthList,
    years: yearList,
    subs: subs.filter(s => s.day >= since).map(({ day, s }) => ({ day, paid: s.paid, trials: s.trials, retry: s.retry, monthly: s.monthly })),
    plans: last?.s.plans ?? [],
  };
}

function playDay(m: PlayDay): Record<string, number> {
  const v: Record<string, number> = {};
  for (const f of ["visitors", "acquisitions", "searchVisitors", "searchAcquisitions", "userInstalls", "userUninstalls", "newOrders", "ratingDaily", "ratingTotal"] as const) {
    if (typeof m[f] === "number") v[f] = m[f]!;
  }
  return v;
}

/** `prefix<day>` cursors from `since` on, oldest first, parsed. */
function days<T>(store: Store, prefix: string, since: string): { day: string; value: T }[] {
  return store.cursorsWithPrefix(prefix).flatMap(({ key, value }) => {
    const day = key.slice(prefix.length);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day < since) return [];
    try { return [{ day, value: JSON.parse(value) as T }]; } catch { return []; }
  }).sort((a, b) => a.day.localeCompare(b.day));
}

/** A phrase's newest reading counts for this many days, since the tracker checks phrases over the day, not at once. */
export const CARRY_DAYS = 7;

const dayMinus = (day: string, n: number) => localDay(new Date(Date.parse(`${day}T12:00:00`) - n * 86_400_000));

/** Each phrase's newest reading on or before `day`, within CARRY_DAYS: `key` → [rank, volume]. */
export function stateOn(snaps: { day: string; value: DaySnapshot }[], day: string): DaySnapshot {
  const from = dayMinus(day, CARRY_DAYS - 1);
  const state: DaySnapshot = {};
  for (const s of snaps) if (s.day >= from && s.day <= day) Object.assign(state, s.value);
  return state;
}

export function rankDay(day: string, snap: DaySnapshot, storefront?: string): RankDay {
  const ranks = Object.entries(snap).filter(([key]) => !storefront || key.startsWith(`${storefront}|`)).map(([, [rank]]) => rank);
  const ranked = ranks.filter((r): r is number => r !== null).sort((a, b) => a - b);
  const mid = ranked.length ? (ranked.length % 2 ? ranked[(ranked.length - 1) / 2] : (ranked[ranked.length / 2 - 1] + ranked[ranked.length / 2]) / 2) : null;
  return { day, tracked: ranks.length, ranked: ranked.length, top10: ranked.filter(r => r <= 10).length, top3: ranked.filter(r => r <= 3).length, median: mid };
}

/** The current phrases (newest reading of each) with their ranks 7 and 28 days earlier. */
export function phraseRanks(snaps: { day: string; value: DaySnapshot }[], limit = PHRASES_PER_APP): Pick<MetricsApp, "phrases" | "compare"> {
  const latest = snaps.at(-1)?.day;
  if (!latest) return { phrases: [], compare: { d7: null, d28: null, latest: null } };
  const back = (n: number) => {
    const day = dayMinus(latest, n);
    return snaps.some(s => s.day <= day) ? { day, state: stateOn(snaps, day) } : null;
  };
  const d7 = back(7), d28 = back(28);
  const phrases = Object.entries(stateOn(snaps, latest)).map(([key, [rank, volume]]) => {
    const [storefront, ...rest] = key.split("|");
    const p: PhraseRank = { text: rest.join("|"), storefront, rank, volume };
    if (d7 && key in d7.state) p.was7 = d7.state[key][0];
    if (d28 && key in d28.state) p.was28 = d28.state[key][0];
    return p;
  }).sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999) || (b.volume ?? -1) - (a.volume ?? -1) || a.text.localeCompare(b.text));
  return { phrases: phrases.slice(0, limit), compare: { d7: d7?.day ?? null, d28: d28?.day ?? null, latest } };
}

export function buildMetrics(config: RunnerConfig, store: Store, now = new Date()): BoardMetrics {
  const since = localDay(new Date(now.getTime() - METRICS_DAYS * 86_400_000));
  const apps: MetricsApp[] = [];
  const history = (id: string): ListingChange[] => {
    try {
      const list = JSON.parse(store.cursor(`aso:${id}:history`) ?? "[]") as (Applied | PlayApplied)[];
      return list.map(e => ({ at: e.at, fields: e.fields.map(String), ...("version" in e && e.version ? { version: e.version } : {}), ...(e.liveAt ? { liveAt: e.liveAt } : {}) }));
    } catch { return []; }
  };
  const tracked = asoApps(config);
  const asoOf = (id: string) => {
    // Read a little further back so the first days of the window have readings to carry.
    const snaps = days<DaySnapshot>(store, `aso:${id}:day:`, dayMinus(since, CARRY_DAYS));
    const storefront = tracked.find(a => a.aso.appId === id)?.aso.storefront ?? "us";
    const ranks = snaps.filter(s => s.day >= since).map(s => rankDay(s.day, stateOn(snaps, s.day), storefront));
    return { storefront, ranks, ...phraseRanks(snaps) };
  };

  const read = salesDaysRead(store);
  const readYears = salesRead(store, "year");
  for (const [id, repo] of Object.entries(config.appStore?.apps ?? {})) {
    const sales = appSales(store, id, since, read, readYears);
    apps.push({
      repo, store: "appstore", id,
      name: store.cursor(`analytics:${id}:name`) ?? repo.split("/")[1] ?? id,
      funnel: days<{ m: DayMetrics }>(store, `analytics:${id}:day:`, since).map(d => ({ day: d.day, v: appleDay(d.value.m ?? {}) })),
      ...asoOf(id),
      changes: history(id),
      ...(sales ? { sales } : {}),
    });
  }
  for (const app of tracked.filter(a => a.store === "play")) {
    const id = app.aso.appId;
    apps.push({
      repo: `${app.owner}/${app.repo}`, store: "play", id,
      // Named like its App Store twin when there is one (the Play listing title isn't stored).
      name: apps.find(a => a.store === "appstore" && a.repo.toLowerCase() === `${app.owner}/${app.repo}`.toLowerCase())?.name ?? app.repo,
      funnel: days<PlayDay>(store, `playstats:${id}:day:`, since).map(d => ({ day: d.day, v: playDay(d.value) })),
      ...asoOf(id),
      changes: history(id),
    });
  }

  const jobs = store.all(1000);
  const sites = contentRepos(config).map(site => {
    const repo = `${site.owner}/${site.repo}`;
    const published = jobs.flatMap(job => {
      if (job.kind !== "content" || `${job.owner}/${job.repo}`.toLowerCase() !== repo.toLowerCase()) return [];
      const at = store.cursor(`content:published:${job.id}`);
      // The cursor holds the time it went live, or why it didn't ("not deployed", "no urls", "not live").
      return at && !Number.isNaN(Date.parse(at)) && at.slice(0, 10) >= since ? [{ at, number: job.number, title: job.title, prNumber: job.prNumber }] : [];
    }).sort((a, b) => a.at.localeCompare(b.at));
    const search = days<SearchWeek>(store, `content:${repo.toLowerCase()}:search:`, since).map(d => ({ day: d.day, ...d.value }));
    return { repo, site: site.content.site, published, search };
  });

  const credits = days<number>(store, "content:credits:", since).map(d => ({ day: d.day, spent: Number(d.value) || 0 }));
  const balance = Number(store.cursor("content:credits:balance"));
  return { at: now.toISOString(), apps, sites, credits: { days: credits, balance: Number.isFinite(balance) && store.cursor("content:credits:balance") !== null ? balance : null } };
}
