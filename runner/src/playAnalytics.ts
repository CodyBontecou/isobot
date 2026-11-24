import { inflateRawSync } from "node:zlib";
import { beforeAfterText } from "./analytics.js";
import { localDay } from "./content.js";
import { GoogleApiError, listObjects, objectUrl, STORAGE_SCOPE, type GoogleAuth } from "./google.js";
import type { Store } from "./store.js";

/**
 * Google Play Console's numbers for each Play app, from its bulk reports in Cloud Storage
 * (gs://pubsite_prod_<developer id>/), read with the ASO train's service account:
 *
 *   - stats/installs/installs_<pkg>_<YYYYMM>_overview.csv: daily user installs and uninstalls
 *   - stats/store_performance/store_performance_<pkg>_<YYYYMM>_traffic_source.csv: store listing visitors and
 *     acquisitions by traffic source (Google Play search, explore, third-party referrals)
 *   - stats/ratings/ratings_<pkg>_<YYYYMM>_overview.csv: the average of the day's new ratings (0 when there were
 *     none) and the app's overall average. Play gives no count of ratings, and writes no file before an app's first
 *     rating
 *   - sales/salesreport_<YYYYMM>.zip: orders across the account (charged, refunded), by product
 *
 * The files are monthly and Google rewrites the current month's every day or so; each pass re-reads only files
 * whose generation changed. Most are UTF-16 CSV. Google says not to rely on column order or count, so columns
 * are found by name. A 403 means the account can't read the bucket yet (Play shares it with a new service account
 * up to a day after it's invited): that's recorded and shown, and retried each pass.
 */

export interface PlayDay {
  /** Store listing visitors and acquisitions (installs from the listing), all sources. */
  visitors?: number;
  acquisitions?: number;
  /** The same from Google Play search only. */
  searchVisitors?: number;
  searchAcquisitions?: number;
  userInstalls?: number;
  userUninstalls?: number;
  /** Orders charged that day: all of them, first orders (not subscription renewals), and refunds. */
  orders?: number;
  newOrders?: number;
  refunds?: number;
  /** Charged amounts by the buyer's currency (Play's sales report doesn't convert). */
  charged?: Record<string, number>;
  /** Play's average of the star ratings left that day; 0 means no new ratings that day (Play reports no count). */
  ratingDaily?: number;
  /** Play's overall average rating as of that day. */
  ratingTotal?: number;
}

export interface PlayAnalyticsDeps {
  store: Store;
  auth: GoogleAuth;
  bucket: string;
  /** Play package names to follow. */
  packages(): string[];
  now?(): Date;
}

const SYNC_EVERY_MS = 6 * 3_600_000;
const KEEP_DAYS = 400;
/** Months of the ratings report read (one small file a month), enough for the board's 120 days. */
const RATING_MONTHS = 5;
/** A day whose new ratings average this or lower is flagged in the check-in. */
export const LOW_RATING = 2;
/** Only days this recent are flagged, so a first backfill doesn't flag old ones. */
const LOW_RATING_RECENT_DAYS = 14;

/** Report bytes → text: UTF-16 (with or without BOM, as Play writes it) or UTF-8. */
export function decodeReport(data: Buffer): string {
  if (data[0] === 0xff && data[1] === 0xfe) return data.subarray(2).toString("utf16le");
  if (data[0] === 0xfe && data[1] === 0xff) {
    const swapped = Buffer.from(data.subarray(2));
    swapped.swap16();
    return swapped.toString("utf16le");
  }
  // UTF-16LE without a BOM: every other byte of ASCII text is zero.
  if (data.length >= 4 && data[1] === 0 && data[3] === 0 && data[0] !== 0) return data.toString("utf16le");
  return data.toString("utf8").replace(/^﻿/, "");
}

/** CSV (RFC 4180: quoted fields, doubled quotes, newlines in quotes) → rows keyed by lower-cased header. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some(x => x !== "")) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some(x => x !== "")) rows.push(row);
  const [header, ...body] = rows;
  if (!header) return [];
  const keys = header.map(h => h.trim().toLocaleLowerCase());
  return body.map(r => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? "").trim()])));
}

/** The first column whose name contains every one of these words. */
function col(row: Record<string, string>, ...words: string[]): string | undefined {
  const key = Object.keys(row).find(k => words.every(w => k.includes(w)));
  return key === undefined ? undefined : row[key];
}
const num = (s: string | undefined): number | undefined => {
  if (s === undefined || s.trim() === "") return undefined;
  const n = Number(s.replace(/[,%\s]/g, ""));
  return Number.isFinite(n) ? n : undefined;
};
/** Play's dates: 2026-11-20, or Nov 20, 2026 in the sales report. */
export function reportDay(s: string | undefined): string | null {
  if (!s) return null;
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const t = Date.parse(`${s} 12:00 UTC`);
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
}

/** installs_…_overview.csv → day → user installs and uninstalls. */
export function parseInstalls(rows: Record<string, string>[]): Map<string, PlayDay> {
  const days = new Map<string, PlayDay>();
  for (const r of rows) {
    const day = reportDay(col(r, "date"));
    if (!day) continue;
    days.set(day, { userInstalls: num(col(r, "daily user installs")), userUninstalls: num(col(r, "daily user uninstalls")) });
  }
  return days;
}

/** ratings_…_overview.csv → day → Play's daily average of new ratings (0: none that day) and its overall average. */
export function parseRatings(rows: Record<string, string>[]): Map<string, PlayDay> {
  const days = new Map<string, PlayDay>();
  for (const r of rows) {
    const day = reportDay(col(r, "date"));
    if (!day) continue;
    const d: PlayDay = { ratingDaily: num(col(r, "daily average rating")), ratingTotal: num(col(r, "total average rating")) };
    // An overall average of 0 is "no ratings yet", not a zero-star app.
    if (!d.ratingTotal) delete d.ratingTotal;
    days.set(day, d);
  }
  return days;
}

/** One Play app's ratings, from the ratings report's days. */
export interface PlayRatings {
  /** The newest day in the ratings report. */
  through: string;
  /** Play's overall average on that day. */
  total: number | null;
  /** Days with at least one new rating, in the 7 and 30 days ending at `through` (Play reports no count). */
  ratedDays7: number;
  ratedDays30: number;
  /** The newest day with new ratings, and their average. */
  latest: { day: string; average: number } | null;
}

export function playRatings(days: { day: string; m: PlayDay }[]): PlayRatings | null {
  const rated = days.filter(d => d.m.ratingDaily !== undefined || d.m.ratingTotal !== undefined);
  const through = rated.at(-1)?.day;
  if (!through) return null;
  const since = (n: number) => addDays(through, -(n - 1));
  const withNew = rated.filter(d => (d.m.ratingDaily ?? 0) > 0);
  const last = withNew.at(-1);
  return {
    through,
    total: [...rated].reverse().find(d => d.m.ratingTotal !== undefined)?.m.ratingTotal ?? null,
    ratedDays7: withNew.filter(d => d.day >= since(7)).length,
    ratedDays30: withNew.filter(d => d.day >= since(30)).length,
    latest: last ? { day: last.day, average: last.m.ratingDaily! } : null,
  };
}

const stars = (n: number) => `${(Math.round(n * 100) / 100).toString()}★`;

/** "overall 3.96★ (Play's report to 11-12); new ratings on 2 of the last 30 days, the latest 11-06 averaging 5★". */
export function ratingsText(r: PlayRatings): string {
  const latest = r.latest ? `, the latest ${r.latest.day.slice(5)} averaging ${stars(r.latest.average)}` : "";
  return `overall ${r.total === null ? "—" : stars(r.total)} (Play's report to ${r.through.slice(5)}); new ratings on ${r.ratedDays30} of the last 30 days${latest}`;
}

/**
 * store_performance_…_traffic_source.csv → day → listing visitors and acquisitions, all sources and search only.
 * Rows split by search term are summed into their source; an "all" row, when Play writes one, isn't added twice.
 */
export function parseStorePerformance(rows: Record<string, string>[]): Map<string, PlayDay> {
  const days = new Map<string, PlayDay>();
  for (const r of rows) {
    const day = reportDay(col(r, "date"));
    if (!day) continue;
    const source = (col(r, "traffic source") ?? col(r, "source") ?? "").toLocaleLowerCase();
    if (!source || source === "all" || source.startsWith("all ")) continue;
    const visitors = num(col(r, "visitors"));
    const acquisitions = num(col(r, "acquisitions"));
    const d = days.get(day) ?? {};
    if (visitors !== undefined) d.visitors = (d.visitors ?? 0) + visitors;
    if (acquisitions !== undefined) d.acquisitions = (d.acquisitions ?? 0) + acquisitions;
    if (source.includes("search")) {
      if (visitors !== undefined) d.searchVisitors = (d.searchVisitors ?? 0) + visitors;
      if (acquisitions !== undefined) d.searchAcquisitions = (d.searchAcquisitions ?? 0) + acquisitions;
    }
    days.set(day, d);
  }
  return days;
}

/**
 * salesreport_….csv → package → day → orders. A subscription renewal's order number ends in "..N", so orders
 * without it are first purchases (new subscriptions, trials converting, one-time purchases).
 */
export function parseSales(rows: Record<string, string>[]): Map<string, Map<string, PlayDay>> {
  const out = new Map<string, Map<string, PlayDay>>();
  for (const r of rows) {
    const pkg = col(r, "product id") ?? col(r, "package");
    const day = reportDay(col(r, "order charged date") ?? col(r, "charged date") ?? col(r, "date"));
    if (!pkg || !day) continue;
    const status = (col(r, "financial status") ?? col(r, "status") ?? "").toLocaleLowerCase();
    const days = out.get(pkg) ?? new Map<string, PlayDay>();
    const d = days.get(day) ?? {};
    if (status.includes("refund")) d.refunds = (d.refunds ?? 0) + 1;
    else if (!status || status.includes("charged")) {
      d.orders = (d.orders ?? 0) + 1;
      if (!/\.\.\d+$/.test(col(r, "order number") ?? "")) d.newOrders = (d.newOrders ?? 0) + 1;
      const amount = num(col(r, "charged amount") ?? col(r, "item price"));
      const currency = col(r, "currency of sale") ?? col(r, "currency");
      if (amount !== undefined && currency) {
        d.charged ??= {};
        d.charged[currency] = Math.round(((d.charged[currency] ?? 0) + amount) * 100) / 100;
      }
    }
    days.set(day, d);
    out.set(pkg, days);
  }
  return out;
}

/** The files of a zip archive (stored or deflated), by name. Enough for Play's single-CSV sales reports. */
export function unzip(data: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  // The central directory has reliable sizes (local headers may defer them to a data descriptor).
  const eocd = data.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error("not a zip file");
  const count = data.readUInt16LE(eocd + 10);
  let p = data.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (data.readUInt32LE(p) !== 0x02014b50) throw new Error("bad zip central directory");
    const method = data.readUInt16LE(p + 10);
    const size = data.readUInt32LE(p + 20);
    const nameLen = data.readUInt16LE(p + 28);
    const extraLen = data.readUInt16LE(p + 30);
    const commentLen = data.readUInt16LE(p + 32);
    const local = data.readUInt32LE(p + 42);
    const name = data.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    const start = local + 30 + data.readUInt16LE(local + 26) + data.readUInt16LE(local + 28);
    const raw = data.subarray(start, start + size);
    if (method === 0) files.set(name, Buffer.from(raw));
    else if (method === 8) files.set(name, inflateRawSync(raw));
    else throw new Error(`zip method ${method} isn't supported`);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

export interface PlayWeek { days: number; visitors: number; acquisitions: number; searchVisitors: number; searchAcquisitions: number; userInstalls: number; userUninstalls: number; orders: number; newOrders: number; refunds: number; charged: Record<string, number>; hasStore: boolean; hasSales: boolean }

export function sumPlay(days: { day: string; m: PlayDay }[]): PlayWeek {
  const w: PlayWeek = { days: days.length, visitors: 0, acquisitions: 0, searchVisitors: 0, searchAcquisitions: 0, userInstalls: 0, userUninstalls: 0, orders: 0, newOrders: 0, refunds: 0, charged: {}, hasStore: false, hasSales: false };
  for (const { m } of days) {
    if (m.visitors !== undefined) w.hasStore = true;
    if (m.orders !== undefined || m.refunds !== undefined) w.hasSales = true;
    for (const k of ["visitors", "acquisitions", "searchVisitors", "searchAcquisitions", "userInstalls", "userUninstalls", "orders", "newOrders", "refunds"] as const) w[k] += m[k] ?? 0;
    for (const [c, v] of Object.entries(m.charged ?? {})) w.charged[c] = Math.round(((w.charged[c] ?? 0) + v) * 100) / 100;
  }
  return w;
}

const pct = (a: number, b: number) => b ? Math.round((a / b) * 1000) / 10 : null;
const change = (now: number, before: number) => before === 0 ? (now === 0 ? "±0%" : "new") : `${now >= before ? "+" : ""}${Math.round(((now - before) / before) * 100)}%`;
const money = (charged: Record<string, number>) => Object.entries(charged).sort((a, b) => b[1] - a[1]).map(([c, v]) => `${c} ${v.toFixed(2)}`).join(" + ");
const addDays = (day: string, by: number) => new Date(Date.parse(`${day}T12:00:00Z`) + by * 86_400_000).toISOString().slice(0, 10);

/** The weekly ASO report's Play line: the last 7 days with listing numbers against the 7 before. */
export function playWeekText(thisWeek: { day: string; m: PlayDay }[], lastWeek: { day: string; m: PlayDay }[]): string | null {
  if (thisWeek.length < 7) return null;
  const a = sumPlay(thisWeek);
  if (!a.hasStore && !a.userInstalls) return null;
  const b = lastWeek.length >= 7 ? sumPlay(lastWeek) : null;
  const item = (label: string, now: number, then?: number) => `${label} ${now.toLocaleString("en-US")}${b && then !== undefined ? ` (${change(now, then)})` : ""}`;
  const parts: string[] = [];
  if (a.hasStore) {
    parts.push(item("listing visitors", a.visitors, b?.visitors), item("installs from the listing", a.acquisitions, b?.acquisitions));
    const conv = pct(a.acquisitions, a.visitors);
    const convB = b ? pct(b.acquisitions, b.visitors) : null;
    if (conv !== null) parts.push(`visitor → install ${conv}%${convB !== null ? ` (was ${convB}%)` : ""}`);
    if (a.visitors) parts.push(`from search ${pct(a.searchVisitors, a.visitors)}% of visitors, ${a.searchAcquisitions.toLocaleString("en-US")} installs`);
  }
  if (a.userInstalls) parts.push(item("new users", a.userInstalls, b?.userInstalls));
  if (a.hasSales) {
    parts.push(`${item("first orders", a.newOrders, b?.newOrders)}${a.orders > a.newOrders ? `, ${a.orders - a.newOrders} renewals` : ""}${a.refunds ? `, ${a.refunds} refunds` : ""}`);
    if (Object.keys(a.charged).length) parts.push(`charged ${money(a.charged)}`);
  }
  const ratings = playRatings(thisWeek);
  if (ratings) {
    // The ratings report lags the others, so only the days it covers are counted.
    const covered = thisWeek.filter(d => d.m.ratingDaily !== undefined).length;
    parts.push(`rating ${ratings.total === null ? "—" : stars(ratings.total)} overall, new ratings on ${ratings.ratedDays7} of the ${covered} day${covered === 1 ? "" : "s"} Play's ratings report covers`);
  }
  const span = `${thisWeek[0].day.slice(5)}–${thisWeek.at(-1)!.day.slice(5)}`;
  return `**Google Play analytics** (${span}${b ? ", vs the 7 days before" : ""}): ${parts.join(" · ")}`;
}

export class PlayAnalytics {
  constructor(private deps: PlayAnalyticsDeps) {}

  private now(): Date { return this.deps.now?.() ?? new Date(); }
  private key(pkg: string, what: string) { return `playstats:${pkg}:${what}`; }

  /** Why the reports can't be read (e.g. the bucket's 403), or null when the last pass read them. */
  status(): string | null {
    return this.deps.store.cursor("playstats:error");
  }

  async tick(force = false): Promise<void> {
    const { store } = this.deps;
    const last = store.cursor("playstats:synced");
    if (!force && last && this.now().getTime() - Date.parse(last) < SYNC_EVERY_MS) return;
    store.setCursor("playstats:synced", this.now().toISOString());
    try {
      await this.sync();
      store.deleteCursor("playstats:error");
    } catch (error) {
      const message = error instanceof GoogleApiError && error.status === 403
        ? `${this.deps.auth.email() ?? "the service account"} can't read gs://${this.deps.bucket} yet (403). Play shares the reports bucket with a newly invited account within about a day; it needs "View app information and download bulk reports" for the whole account`
        : (error as Error).message.slice(0, 400);
      if (store.cursor("playstats:error") !== message) {
        console.warn(`[play-analytics] ${message}`);
        store.event(null, "play_analytics_error", message);
      }
      store.setCursor("playstats:error", message);
    }
  }

  /** Reads every changed report file of the current and previous month; returns the files read. */
  async sync(): Promise<number> {
    const { auth, bucket, store } = this.deps;
    const months = [0, 1].map(back => {
      const d = new Date(this.now().getFullYear(), this.now().getMonth() - back, 15);
      return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}`;
    });
    const ratingMonths = Array.from({ length: RATING_MONTHS }, (_, back) => {
      const d = new Date(this.now().getFullYear(), this.now().getMonth() - back, 15);
      return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}`;
    });
    let read = 0;
    const fresh = async (name: string, generation: string): Promise<Buffer | null> => {
      const k = `playstats:gen:${name}`;
      if (store.cursor(k) === generation) return null;
      const data = await auth.bytes(STORAGE_SCOPE, objectUrl(bucket, name));
      store.setCursor(k, generation);
      read++;
      return data;
    };
    for (const pkg of this.deps.packages()) {
      for (const [prefix, suffix, parse, within] of [
        [`stats/installs/installs_${pkg}_`, "_overview.csv", parseInstalls, months],
        [`stats/store_performance/store_performance_${pkg}_`, "_traffic_source.csv", parseStorePerformance, months],
        [`stats/ratings/ratings_${pkg}_`, "_overview.csv", parseRatings, ratingMonths],
      ] as const) {
        for (const o of await listObjects(auth, bucket, prefix)) {
          if (!o.name.endsWith(suffix) || !within.some(m => o.name.includes(`_${m}_`))) continue;
          const data = await fresh(o.name, o.generation);
          if (data) this.merge(pkg, parse(parseCsv(decodeReport(data))));
        }
      }
    }
    const followed = new Set(this.deps.packages());
    for (const o of await listObjects(auth, bucket, "sales/salesreport_")) {
      if (!months.some(m => o.name.includes(`_${m}`))) continue;
      const data = await fresh(o.name, o.generation);
      if (!data) continue;
      const csvs = o.name.endsWith(".zip") ? [...unzip(data).values()] : [data];
      for (const csv of csvs) {
        // A month's file is complete for that month: its days replace the sales fields, so a refund isn't lost.
        for (const [pkg, days] of parseSales(parseCsv(decodeReport(csv)))) if (followed.has(pkg)) this.merge(pkg, days, ["orders", "newOrders", "refunds", "charged"]);
      }
    }
    const oldest = localDay(new Date(this.now().getTime() - KEEP_DAYS * 86_400_000));
    for (const pkg of followed) {
      const prefix = this.key(pkg, "day:");
      for (const { key } of store.cursorsWithPrefix(prefix)) if (key.slice(prefix.length) < oldest) store.deleteCursor(key);
      const flagged = this.key(pkg, "lowrating:");
      for (const { key } of store.cursorsWithPrefix(flagged)) if (key.slice(flagged.length) < oldest) store.deleteCursor(key);
    }
    return read;
  }

  /** Merges a file's days into the stored ones; `replace` fields are cleared first (a sales file restates them). */
  private merge(pkg: string, days: Map<string, PlayDay>, replace: (keyof PlayDay)[] = []): void {
    for (const [day, m] of days) {
      const k = this.key(pkg, `day:${day}`);
      const old = JSON.parse(this.deps.store.cursor(k) ?? "{}") as PlayDay;
      for (const f of replace) delete old[f];
      const defined = Object.fromEntries(Object.entries(m).filter(([, v]) => v !== undefined));
      this.deps.store.setCursor(k, JSON.stringify({ ...old, ...defined }));
    }
  }

  days(pkg: string, from = "0000-00-00", to = "9999-99-99"): { day: string; m: PlayDay }[] {
    const prefix = this.key(pkg, "day:");
    return this.deps.store.cursorsWithPrefix(prefix)
      .map(r => ({ day: r.key.slice(prefix.length), m: JSON.parse(r.value) as PlayDay }))
      .filter(d => d.day >= from && d.day <= to);
  }

  /** The newest day with store listing numbers. */
  latest(pkg: string): string | null {
    return this.days(pkg).reverse().find(d => d.m.visitors !== undefined)?.day ?? null;
  }

  /** The weekly report's Play line, or why there's none (the bucket isn't readable yet). */
  weekLine(pkg: string): string | null {
    const day = this.latest(pkg);
    if (!day) {
      const error = this.status();
      return error ? `**Google Play analytics**: not available yet. ${error}.` : null;
    }
    return playWeekText(this.days(pkg, addDays(day, -6), day), this.days(pkg, addDays(day, -13), addDays(day, -7)));
  }

  /** One app's ratings from Play's ratings report, or null when Play has written none (no ratings yet). */
  ratings(pkg: string): PlayRatings | null {
    return playRatings(this.days(pkg));
  }

  /**
   * The daily check-in's Google Play ratings section: a line per app, and a flag (posted on its own) for each
   * recent day whose new ratings averaged LOW_RATING★ or less, once per day.
   */
  checkIn(): { lines: string[]; flags: string[] } {
    const lines: string[] = [];
    const flags: string[] = [];
    const recent = addDays(localDay(this.now()), -LOW_RATING_RECENT_DAYS);
    for (const pkg of this.deps.packages()) {
      const r = this.ratings(pkg);
      lines.push(`**${pkg}**: ${r ? ratingsText(r) : "no ratings report from Play yet (it writes one after the first rating)"}`);
      for (const { day, m } of this.days(pkg, recent)) {
        if (m.ratingDaily === undefined || m.ratingDaily <= 0 || m.ratingDaily > LOW_RATING) continue;
        const k = this.key(pkg, `lowrating:${day}`);
        if (this.deps.store.cursor(k)) continue;
        this.deps.store.setCursor(k, this.now().toISOString());
        flags.push(`⭐ ${pkg}: new Google Play ratings on ${day.slice(5)} averaged ${stars(m.ratingDaily)}`);
      }
    }
    const error = this.status();
    if (error && !lines.some(l => !l.includes("no ratings report"))) return { lines: [`Google Play's reports can't be read: ${error}`], flags };
    return { lines, flags };
  }

  /** A listing change's before/after, for the research prompt. */
  changeLine(pkg: string, liveDay: string, window = 28): string | null {
    const latest = this.latest(pkg);
    if (!latest) return null;
    const side = (days: { day: string; m: PlayDay }[]) => {
      const s = sumPlay(days.filter(d => d.m.visitors !== undefined));
      return { visits: s.visitors, installs: s.acquisitions, paid: s.newOrders, days: days.filter(d => d.m.visitors !== undefined).length };
    };
    const before = side(this.days(pkg, addDays(liveDay, -Math.min(window, 28)), addDays(liveDay, -1)));
    const after = side(this.days(pkg, addDays(liveDay, 1), addDays(liveDay, window)));
    return beforeAfterText(before, after);
  }
}
