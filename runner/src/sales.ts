import { parseTsv, RateLimited } from "./analytics.js";
import { localDay } from "./content.js";
import type { Store } from "./store.js";

/**
 * Apple's Sales and Trends reports, kept for good. Apple only serves them for a while (daily reports for 365 days,
 * monthly for 12 months, yearly indefinitely), so the runner downloads each one once and stores it in runner.sqlite:
 *
 *   - Sales, daily (SALES SUMMARY): downloads, lifetime unlocks, subscription charges, paid downloads, refunds and
 *     their proceeds, per app (the vendor's every app, not only appStore.apps). Converted to USD at that day's ECB
 *     rate; the proceeds in each currency are kept too.
 *   - Sales, yearly: totals for whole years before the daily window (and a check on the days of later years).
 *   - Subscriptions, daily (SUBSCRIPTION SUMMARY 1_4): the subscriptions active that day by plan (paid, in a free
 *     trial, in billing retry) and what the paid ones bring in a month.
 *   - Subscription events, daily (SUBSCRIPTION_EVENT SUMMARY 1_3): free trials started, converted to paid and
 *     cancelled, paid subscriptions cancelled, renewed, refunded and in billing retry, per app and plan.
 *
 * A first pass reads the newest days and then works back from the oldest one Apple still has, at most `perPass`
 * reports each pass, so the API key the runner shares with releases and the ASO train keeps room. Days Apple has no
 * report for (a day without sales, a day before the first subscription) are remembered and not asked again, except
 * the last few days, whose reports may still be on their way.
 */

/** A sales report: its rows, or null when Apple has none for that date. */
export type ReportFetch = (kind: "sales-daily" | "sales-yearly" | "subscriptions" | "events", date: string) => Promise<string | null>;
/** Rates as units of each currency per USD, for business days in [from, to]. */
export type RatesFetch = (from: string, to: string) => Promise<Record<string, Record<string, number>>>;

export interface SalesDeps {
  store: Store;
  report: ReportFetch;
  rates: RatesFetch;
  /** App Store Connect's app list (id and SKU); a sales row names its app by SKU. */
  apps(): Promise<{ id: string; sku: string; name: string }[]>;
  perPass?: number;
  now?(): Date;
}

/** Revenue by kind, USD after Apple's commission. */
export interface Proceeds { lifetime: number; subscriptions: number; paidDownloads: number; other: number }

/** One app's sales over a day or a year. */
export interface SalesRecord {
  /** First-time downloads, free or paid (Apple's units for product types 1, 1F, 1T, F1). */
  downloads: number;
  redownloads: number;
  /** Lifetime (non-consumable) and other one-time in-app purchases. */
  lifetime: number;
  /** Subscription charges: new paid periods and renewals. */
  subscriptions: number;
  renewals: number;
  /** Subscriptions started at a price of 0: free trials. */
  trials: number;
  /** Refunded units (Apple reports them as negative units; their proceeds are already netted out). */
  refunds: number;
  proceeds: Proceeds;
  total: number;
  /** Proceeds before conversion, by currency. */
  local: Record<string, number>;
  /** The part of `total` converted at a fallback rate (a currency the ECB doesn't publish). */
  approx?: number;
}

export interface PlanSnapshot {
  name: string;
  /** Apple's standard duration: "7 Days", "1 Month", "1 Year", … */
  period: string;
  paid: number;
  trial: number;
  /** Paid introductory, promotional, offer-code and win-back offers. */
  offer: number;
  retry: number;
  grace: number;
  /** What the paid subscriptions bring in a month, USD after commission. */
  monthly: number;
}

export interface SubsSnapshot {
  paid: number;
  trials: number;
  offer: number;
  retry: number;
  monthly: number;
  plans: PlanSnapshot[];
}

/** Counts of a day's subscription events. */
export interface EventCounts {
  /** Free trials started. */
  trialStarts: number;
  /** Free trials that turned into a paid subscription. */
  converted: number;
  /** Auto-renew turned off during a free trial: the trial ends unpaid. */
  trialCancels: number;
  /** Auto-renew turned off after at least one paid period. */
  paidCancels: number;
  renewals: number;
  /** Paid subscriptions started without a trial. */
  newPaid: number;
  /** Auto-renew turned back on. */
  reactivated: number;
  /** Payments that failed and went into billing retry. */
  retry: number;
  /** Payments recovered from billing retry. */
  recovered: number;
  refunds: number;
  /** Moves to another plan (crossgrade, upgrade, downgrade). */
  changes: number;
}

export interface PlanEvents extends EventCounts {
  name: string;
  period: string;
  /** Subscribers kept on an older, lower price (Apple's preserved pricing). */
  oldPrice: boolean;
  /** Renewals by the number of paid periods so far (2 = the first renewal). */
  renewByPeriod: Record<string, number>;
}

export interface SubEvents extends EventCounts {
  /** Every event by Apple's name. */
  events: Record<string, number>;
  /** Cancellations by Apple's reason. */
  cancelReasons: Record<string, number>;
  plans: PlanEvents[];
}

export const EVENT_COUNTS: (keyof EventCounts)[] = ["trialStarts", "converted", "trialCancels", "paidCancels", "renewals", "newPaid", "reactivated", "retry", "recovered", "refunds", "changes"];
export const blankCounts = (): EventCounts => Object.fromEntries(EVENT_COUNTS.map(k => [k, 0])) as unknown as EventCounts;

/** Which count an Apple subscription event adds to, if any. */
export function eventCount(event: string, offerType: string, paidPeriods: number): keyof EventCounts | null {
  const e = event.trim().toLowerCase();
  if (/from billing retry/.test(e)) return "recovered";
  if (/^billing retry/.test(e)) return "retry";
  if (/^start introductory offer/.test(e)) return /free trial/i.test(offerType) ? "trialStarts" : null;
  if (/^paid subscription from introductory offer/.test(e)) return "converted";
  if (e === "cancel") return paidPeriods > 0 ? "paidCancels" : "trialCancels";
  if (/^renew/.test(e)) return "renewals";
  if (e === "subscribe") return "newPaid";
  if (/^reactivate/.test(e)) return "reactivated";
  if (/^refund/.test(e)) return "refunds";
  if (/^(crossgrade|upgrade|downgrade)/.test(e)) return "changes";
  return null;
}

/** A SUBSCRIPTION_EVENT report's rows summed per app and plan. */
export function aggregateEvents(rows: Record<string, string>[]): Map<string, SubEvents> {
  const apps = new Map<string, { total: SubEvents; plans: Map<string, PlanEvents> }>();
  for (const row of rows) {
    const appId = row["App Apple ID"]?.trim();
    const event = row["Event"]?.trim();
    if (!appId || !event) continue;
    const app = apps.get(appId) ?? { total: { ...blankCounts(), events: {} as Record<string, number>, cancelReasons: {} as Record<string, number>, plans: [] as PlanEvents[] }, plans: new Map<string, PlanEvents>() };
    apps.set(appId, app);
    const qty = num(row["Quantity"]) || 1;
    const paidPeriods = num(row["Consecutive Paid Periods"]);
    const name = row["Subscription Name"]?.trim() || "?";
    const period = row["Standard Subscription Duration"]?.trim() || "";
    const oldPrice = /^yes$/i.test(row["Preserved Pricing"]?.trim() ?? "");
    const key = `${name}|${period}|${oldPrice}`;
    const plan = app.plans.get(key) ?? { name, period, oldPrice, ...blankCounts(), renewByPeriod: {} };
    app.plans.set(key, plan);
    app.total.events[event] = (app.total.events[event] ?? 0) + qty;
    const count = eventCount(event, row["Subscription Offer Type"] ?? "", paidPeriods);
    if (count) { app.total[count] += qty; plan[count] += qty; }
    if (count === "renewals" && paidPeriods) plan.renewByPeriod[paidPeriods] = (plan.renewByPeriod[paidPeriods] ?? 0) + qty;
    if (event.toLowerCase() === "cancel") {
      const reason = row["Cancellation Reason"]?.trim() || "Unknown";
      app.total.cancelReasons[reason] = (app.total.cancelReasons[reason] ?? 0) + qty;
    }
  }
  const out = new Map<string, SubEvents>();
  for (const [appId, { total, plans }] of apps) {
    total.plans = [...plans.values()].sort((a, b) => a.name.localeCompare(b.name) || a.period.localeCompare(b.period) || Number(a.oldPrice) - Number(b.oldPrice));
    out.set(appId, total);
  }
  return out;
}

/** Hourly: yesterday's reports appear once a day, and a pass that finds them already read asks Apple nothing. */
const SYNC_EVERY_MS = 3_600_000;
const RATE_LIMIT_RETRY_MS = 65 * 60_000;
/** A recent report Apple didn't have yet is asked again after this long (a little under a pass, so each pass asks). */
const RECHECK_MS = 50 * 60_000;
/** Apple's daily reports last 365 days; the oldest is skipped when it's about to go. */
const DAILY_WINDOW = 364;
/** Days whose missing report is asked for again: Apple publishes a day's report the next morning, sometimes later. */
const RECENT_DAYS = 5;
/** After this many days in a row without a subscription report, older days aren't asked for (no subscriptions then). */
const SUBS_GAP = 14;
const DEFAULT_PER_PASS = 40;

/** Apple's product types: first downloads, redownloads and updates of an app (iOS, universal, iPad, Mac). */
const DOWNLOAD = new Set(["1", "1F", "1T", "F1", "1E", "1EP", "1EU"]);
const REDOWNLOAD = new Set(["3", "3F", "3T", "F3"]);
const UPDATE = new Set(["7", "7F", "7T", "F7"]);

/** ECB rates don't cover every currency Apple pays in; these are rough units per USD (2026-11) for the rest. */
export const FALLBACK_RATES: Record<string, number> = {
  AED: 3.67, SAR: 3.75, QAR: 3.64, EGP: 49, NGN: 1540, KZT: 500, PKR: 280, VND: 25_400, COP: 4_000, CLP: 950,
  PEN: 3.75, TWD: 32, RUB: 92, TZS: 2_600, ISK: 125,
};

const round = (x: number) => Math.round(x * 100) / 100;
const addDays = (day: string, by: number) => new Date(Date.parse(`${day}T12:00:00Z`) + by * 86_400_000).toISOString().slice(0, 10);
const num = (v: string | undefined) => { const x = Number(v ?? ""); return Number.isFinite(x) ? x : 0; };

export function blankRecord(): SalesRecord {
  return { downloads: 0, redownloads: 0, lifetime: 0, subscriptions: 0, renewals: 0, trials: 0, refunds: 0, proceeds: { lifetime: 0, subscriptions: 0, paidDownloads: 0, other: 0 }, total: 0, local: {} };
}

/** Converts `amount` of `currency` to USD with a day's rates (units per USD); `approx` when it used a fallback rate. */
export function toUsd(amount: number, currency: string, rates: Record<string, number> | null): { usd: number; approx: boolean } {
  const cur = currency.trim().toUpperCase();
  if (!amount || cur === "USD" || !cur) return { usd: amount, approx: false };
  const rate = rates?.[cur];
  if (rate) return { usd: amount / rate, approx: false };
  const fallback = FALLBACK_RATES[cur];
  return fallback ? { usd: amount / fallback, approx: true } : { usd: 0, approx: true };
}

/**
 * A SALES SUMMARY report's rows summed per app. Apps are named by Apple id on their own rows and by SKU (Parent
 * Identifier) on their in-app purchases, so `skus` maps SKU → app id. Rows of apps it can't place are left out.
 */
export function aggregateSales(rows: Record<string, string>[], skus: Map<string, string>, rates: Record<string, number> | null): { apps: Map<string, SalesRecord>; names: Map<string, string> } {
  const apps = new Map<string, SalesRecord>();
  const names = new Map<string, string>();
  // An app's own rows also teach its SKU, for apps the list doesn't have yet.
  for (const row of rows) {
    if ((DOWNLOAD.has(row["Product Type Identifier"]) || REDOWNLOAD.has(row["Product Type Identifier"]) || UPDATE.has(row["Product Type Identifier"])) && row["Apple Identifier"]) {
      if (row["SKU"] && !skus.has(row["SKU"])) skus.set(row["SKU"], row["Apple Identifier"]);
      names.set(row["Apple Identifier"], row["Title"]);
    }
  }
  for (const row of rows) {
    const type = row["Product Type Identifier"] ?? "";
    const isApp = DOWNLOAD.has(type) || REDOWNLOAD.has(type) || UPDATE.has(type);
    const appId = isApp ? row["Apple Identifier"] : skus.get(row["Parent Identifier"] ?? "");
    if (!appId) continue;
    const r = apps.get(appId) ?? blankRecord();
    apps.set(appId, r);
    const units = num(row["Units"]);
    const proceeds = num(row["Developer Proceeds"]) * units;
    const currency = (row["Currency of Proceeds"] ?? "").trim();
    const { usd, approx } = toUsd(proceeds, currency, rates);
    if (proceeds && currency) r.local[currency] = round((r.local[currency] ?? 0) + proceeds);
    if (approx && usd) r.approx = round((r.approx ?? 0) + usd);
    if (units < 0) r.refunds += -units;
    const price = num(row["Customer Price"]);
    if (DOWNLOAD.has(type)) {
      if (units > 0) r.downloads += units;
      r.proceeds.paidDownloads += usd;
    } else if (REDOWNLOAD.has(type)) {
      if (units > 0) r.redownloads += units;
    } else if (UPDATE.has(type)) {
      // Updates carry no money.
    } else if (/^IAY/.test(type)) {
      if (price === 0 && proceeds === 0) {
        if (units > 0) r.trials += units;
      } else if (units > 0) {
        r.subscriptions += units;
        if (/renewal/i.test(row["Subscription"] ?? "")) r.renewals += units;
      }
      r.proceeds.subscriptions += usd;
    } else if (/^(IA1|FI1)/.test(type)) {
      if (units > 0) r.lifetime += units;
      r.proceeds.lifetime += usd;
    } else {
      r.proceeds.other += usd;
    }
  }
  for (const r of apps.values()) {
    for (const k of Object.keys(r.proceeds) as (keyof Proceeds)[]) r.proceeds[k] = round(r.proceeds[k]);
    r.total = round(r.proceeds.lifetime + r.proceeds.subscriptions + r.proceeds.paidDownloads + r.proceeds.other);
  }
  return { apps, names };
}

/** Periods per month of an Apple subscription duration ("7 Days" → 4.35, "1 Year" → 1/12). */
export function perMonth(period: string): number {
  const m = /^(\d+)\s*(day|week|month|year)/i.exec(period.trim());
  if (!m) return 0;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  const months = unit === "day" ? n / (365.25 / 12) : unit === "week" ? (n * 7) / (365.25 / 12) : unit === "month" ? n : n * 12;
  return months ? 1 / months : 0;
}

const OFFER_COLUMNS = [
  "Active Pay Up Front Introductory Offer Subscriptions", "Active Pay As You Go Introductory Offer Subscriptions",
  "Free Trial Promotional Offer Subscriptions", "Pay Up Front Promotional Offer Subscriptions", "Pay As You Go Promotional Offer Subscriptions",
  "Free Trial Offer Code Subscriptions", "Pay Up Front Offer Code Subscriptions", "Pay As You Go Offer Code Subscriptions",
  "Free Trial Win-back Offers", "Pay Up Front Win-back Offers", "Pay As You Go Win-back Offers",
];

/** A SUBSCRIPTION SUMMARY report's rows: each app's active subscriptions by plan, and their monthly proceeds. */
export function aggregateSubscriptions(rows: Record<string, string>[], rates: Record<string, number> | null): Map<string, SubsSnapshot> {
  const apps = new Map<string, Map<string, PlanSnapshot>>();
  for (const row of rows) {
    const appId = row["App Apple ID"];
    if (!appId) continue;
    const plans = apps.get(appId) ?? new Map<string, PlanSnapshot>();
    apps.set(appId, plans);
    const name = row["Subscription Name"] || "?";
    const period = row["Standard Subscription Duration"] || "";
    const key = `${name}|${period}`;
    const p = plans.get(key) ?? { name, period, paid: 0, trial: 0, offer: 0, retry: 0, grace: 0, monthly: 0 };
    plans.set(key, p);
    const paid = num(row["Active Standard Price Subscriptions"]);
    p.paid += paid;
    p.trial += num(row["Active Free Trial Introductory Offer Subscriptions"]);
    p.offer += OFFER_COLUMNS.reduce((a, c) => a + num(row[c]), 0);
    p.retry += num(row["Billing Retry"]);
    p.grace += num(row["Grace Period"]);
    if (paid) p.monthly += toUsd(num(row["Developer Proceeds"]) * paid, row["Proceeds Currency"] ?? "", rates).usd * perMonth(period);
  }
  const out = new Map<string, SubsSnapshot>();
  for (const [appId, plans] of apps) {
    const list = [...plans.values()].map(p => ({ ...p, monthly: round(p.monthly) })).sort((a, b) => b.paid + b.trial - (a.paid + a.trial) || a.name.localeCompare(b.name));
    out.set(appId, {
      paid: list.reduce((a, p) => a + p.paid, 0),
      trials: list.reduce((a, p) => a + p.trial, 0),
      offer: list.reduce((a, p) => a + p.offer, 0),
      retry: list.reduce((a, p) => a + p.retry + p.grace, 0),
      monthly: round(list.reduce((a, p) => a + p.monthly, 0)),
      plans: list,
    });
  }
  return out;
}

/** Sums records (a month of days, say). */
export function sumRecords(records: SalesRecord[]): SalesRecord {
  const t = blankRecord();
  for (const r of records) {
    for (const k of ["downloads", "redownloads", "lifetime", "subscriptions", "renewals", "trials", "refunds", "total"] as const) t[k] += r[k];
    for (const k of Object.keys(t.proceeds) as (keyof Proceeds)[]) t.proceeds[k] += r.proceeds[k];
    for (const [c, v] of Object.entries(r.local)) t.local[c] = (t.local[c] ?? 0) + v;
    if (r.approx) t.approx = (t.approx ?? 0) + r.approx;
  }
  for (const k of Object.keys(t.proceeds) as (keyof Proceeds)[]) t.proceeds[k] = round(t.proceeds[k]);
  for (const c of Object.keys(t.local)) t.local[c] = round(t.local[c]);
  t.total = round(t.total);
  if (t.approx) t.approx = round(t.approx);
  return t;
}

type Kind = "day" | "subs" | "events" | "year";
/** Daily reports that start with the first subscription and are walked back newest first. */
type SubsKind = "subs" | "events";
/** A report read ("ok"), or found missing ("none" and when), for a date. */
interface Got { s: "ok" | "none"; at: string }

export class AppleSales {
  constructor(private deps: SalesDeps) {}

  private now(): Date { return this.deps.now?.() ?? new Date(); }
  private get store() { return this.deps.store; }

  private got(kind: Kind, date: string): Got | null {
    const v = this.store.cursor(`sales:got:${kind}:${date}`);
    if (!v) return null;
    try { return JSON.parse(v) as Got; } catch { return null; }
  }
  private mark(kind: Kind, date: string, s: Got["s"]): void {
    this.store.setCursor(`sales:got:${kind}:${date}`, JSON.stringify({ s, at: this.now().toISOString() }));
  }

  /** The newest date a daily report can exist for (yesterday, in Apple's Pacific day). */
  private yesterday(): string { return addDays(localDay(this.now()), -1); }

  /** Dates of a daily report still to read: recent missing ones first, then the oldest Apple still has. */
  todo(kind: "day" | SubsKind): string[] {
    const newest = this.yesterday();
    const recent: string[] = [];
    const older: string[] = [];
    let gap = 0;
    let seenOk = false;
    for (let i = 0; i < DAILY_WINDOW; i++) {
      const day = addDays(newest, -i);
      const got = this.got(kind, day);
      if (got?.s === "ok") { seenOk = true; gap = 0; continue; }
      if (got?.s === "none") {
        // A missing report is asked again only while it's recent, at most about hourly (it's published once a day).
        if (i < RECENT_DAYS && Date.parse(got.at) < this.now().getTime() - RECHECK_MS) recent.push(day);
        else if (i >= RECENT_DAYS) gap++;
        if (kind !== "day" && seenOk && gap >= SUBS_GAP) break;
        continue;
      }
      gap = 0;
      (i < RECENT_DAYS ? recent : older).push(day);
    }
    // Sales days go oldest first, since the oldest is the next to drop off Apple's side; subscription snapshots go
    // newest first, so the walk back stops at the first subscription.
    return [...recent, ...(kind === "day" ? older.reverse() : older)];
  }

  /** Whole years to read: the last finished one and those before it, back to the first without a report. */
  yearsTodo(): string[] {
    const year = Number(localDay(this.now()).slice(0, 4));
    const out: string[] = [];
    for (let y = year - 1; y >= year - 15; y--) {
      const got = this.got("year", String(y));
      if (got?.s === "ok") continue;
      if (got?.s === "none") {
        // Last year's report appears in January; until it does, ask again daily.
        if (y === year - 1 && Date.parse(got.at) < this.now().getTime() - 20 * 3_600_000) out.push(String(y));
        if (y < year - 1) break;
        continue;
      }
      out.push(String(y));
    }
    return out;
  }

  private async skus(): Promise<Map<string, string>> {
    const cached = JSON.parse(this.store.cursor("sales:skus") ?? "null") as { at: string; map: Record<string, string> } | null;
    if (cached && this.now().getTime() - Date.parse(cached.at) < 7 * 86_400_000) return new Map(Object.entries(cached.map));
    const map = new Map(Object.entries(cached?.map ?? {}));
    for (const app of await this.deps.apps()) {
      if (app.sku) map.set(app.sku, app.id);
      if (app.name && !this.store.cursor(`sales:${app.id}:name`)) this.store.setCursor(`sales:${app.id}:name`, app.name.slice(0, 80));
    }
    this.saveSkus(map);
    return map;
  }
  private saveSkus(map: Map<string, string>): void {
    this.store.setCursor("sales:skus", JSON.stringify({ at: this.now().toISOString(), map: Object.fromEntries(map) }));
  }

  /** Rates (units per USD) for each date, the newest business day on or before it; fetched once and kept. */
  async ratesFor(dates: string[]): Promise<Map<string, Record<string, number> | null>> {
    const out = new Map<string, Record<string, number> | null>();
    const lookup = (date: string) => {
      for (let i = 0; i < 7; i++) {
        const v = this.store.cursor(`fx:usd:${addDays(date, -i)}`);
        if (v) return JSON.parse(v) as Record<string, number>;
      }
      return null;
    };
    const through = this.store.cursor("fx:through") ?? "";
    const missing = dates.filter(d => d > through || !lookup(d));
    if (missing.length) {
      const sorted = [...missing].sort();
      try {
        const got = await this.deps.rates(addDays(sorted[0], -6), sorted.at(-1)!);
        for (const [day, rates] of Object.entries(got)) this.store.setCursor(`fx:usd:${day}`, JSON.stringify(rates));
        // Rates for the newest day come out the next afternoon (CET), so `through` only covers days the ECB has done.
        const newest = Object.keys(got).sort().at(-1);
        if (newest && newest > through) this.store.setCursor("fx:through", newest);
      } catch (error) {
        console.warn(`[sales] exchange rates: ${(error as Error).message}`);
      }
    }
    const known = this.store.cursor("fx:through") ?? "";
    // A weekend or holiday after the newest published rates takes those rates once a later business day exists, or
    // after 3 days (a long weekend); before that it waits, so a day isn't stored at a stale rate.
    for (const d of dates) out.set(d, d <= known || d < addDays(localDay(this.now()), -3) ? lookup(d) : null);
    return out;
  }

  /** One pass, at most hourly unless forced; `all` keeps going until nothing is left (a first backfill by hand). */
  async tick(force = false, all = false): Promise<{ days: number; subs: number; events: number; years: number }> {
    const last = this.store.cursor("sales:synced");
    const done = { days: 0, subs: 0, events: 0, years: 0 };
    if (!force && last && this.now().getTime() - Date.parse(last) < SYNC_EVERY_MS) return done;
    this.store.setCursor("sales:synced", this.now().toISOString());
    try {
      do {
        const pass = await this.pass();
        done.days += pass.days; done.subs += pass.subs; done.events += pass.events; done.years += pass.years;
        if (!pass.days && !pass.subs && !pass.events && !pass.years) break;
      } while (all);
    } catch (error) {
      this.store.event(null, "analytics_error", `sales reports: ${(error as Error).message.slice(0, 300)}`);
      if (error instanceof RateLimited) this.store.setCursor("sales:synced", new Date(this.now().getTime() - SYNC_EVERY_MS + RATE_LIMIT_RETRY_MS).toISOString());
      throw error;
    } finally {
      if (done.days || done.subs || done.events || done.years) console.log(`[sales] read ${done.days} sales days, ${done.subs} subscription days, ${done.events} event days, ${done.years} years`);
    }
    return done;
  }

  private async pass(): Promise<{ days: number; subs: number; events: number; years: number }> {
    const budget = this.deps.perPass ?? DEFAULT_PER_PASS;
    const years = this.yearsTodo().slice(0, 2);
    const days = this.todo("day").slice(0, budget);
    const subs = this.todo("subs").slice(0, budget);
    const events = this.todo("events").slice(0, budget);
    if (!years.length && !days.length && !subs.length && !events.length) return { days: 0, subs: 0, events: 0, years: 0 };
    const skus = await this.skus();
    const rates = await this.ratesFor([...days, ...subs, ...years.map(y => `${y}-07-01`)]);
    const n = { days: 0, subs: 0, events: 0, years: 0 };
    try {
      for (const day of days) {
        // Without rates a day's proceeds can't be converted; it waits for the next pass.
        if (!rates.get(day)) continue;
        const text = await this.deps.report("sales-daily", day);
        if (text === null) { this.mark("day", day, "none"); continue; }
        this.saveSales("day", day, text, skus, rates.get(day) ?? null);
        n.days++;
      }
      n.subs = await this.walkBack("subs", subs, async (day, text) => {
        // Subscription prices are converted at the day's rate, so a day without rates waits.
        if (!rates.get(day)) return false;
        for (const [appId, snap] of aggregateSubscriptions(parseTsv(text), rates.get(day) ?? null)) this.store.setCursor(`subs:${appId}:day:${day}`, JSON.stringify(snap));
        return true;
      }, day => !!rates.get(day));
      n.events = await this.walkBack("events", events, async (day, text) => {
        for (const [appId, ev] of aggregateEvents(parseTsv(text))) this.store.setCursor(`subev:${appId}:day:${day}`, JSON.stringify(ev));
        return true;
      });
      for (const year of years) {
        if (!rates.get(`${year}-07-01`)) continue;
        const text = await this.deps.report("sales-yearly", year);
        if (text === null) { this.mark("year", year, "none"); continue; }
        // A year's sales are converted at its mid-year rate.
        this.saveSales("year", year, text, skus, rates.get(`${year}-07-01`) ?? null);
        n.years++;
      }
    } finally {
      this.saveSkus(skus);
    }
    return n;
  }

  /**
   * Reads daily reports that begin with the first subscription, newest first. Walking back, a run of days without a
   * report after some with one is the time before the first subscription, so the walk stops there.
   */
  private async walkBack(kind: SubsKind, days: string[], save: (day: string, text: string) => Promise<boolean>, ready: (day: string) => boolean = () => true): Promise<number> {
    let hadOk = this.store.cursorsWithPrefix(`sales:got:${kind}:`).some(r => r.value.includes('"ok"'));
    let gap = 0;
    let n = 0;
    const recentFrom = addDays(this.yesterday(), -(RECENT_DAYS - 1));
    for (const day of days) {
      if (hadOk && gap >= SUBS_GAP) break;
      if (!ready(day)) continue;
      const text = await this.deps.report(kind === "subs" ? "subscriptions" : "events", day);
      if (text === null) {
        this.mark(kind, day, "none");
        if (day < recentFrom) gap++;
        continue;
      }
      hadOk = true;
      gap = 0;
      if (!(await save(day, text))) continue;
      this.mark(kind, day, "ok");
      n++;
    }
    return n;
  }

  private saveSales(kind: "day" | "year", date: string, text: string, skus: Map<string, string>, rates: Record<string, number> | null): void {
    const { apps, names } = aggregateSales(parseTsv(text), skus, rates);
    for (const [appId, name] of names) if (name) this.store.setCursor(`sales:${appId}:name`, name.slice(0, 80));
    for (const [appId, record] of apps) this.store.setCursor(`sales:${appId}:${kind}:${date}`, JSON.stringify(record));
    this.mark(kind, date, "ok");
  }

  /** What's stored, for the CLI. */
  status(): { days: { ok: number; none: number; todo: number; oldest: string | null }; subs: { ok: number; todo: number; oldest: string | null }; events: { ok: number; todo: number; oldest: string | null }; years: string[] } {
    const count = (kind: Kind) => {
      const rows = this.store.cursorsWithPrefix(`sales:got:${kind}:`).map(r => ({ date: r.key.split(":").at(-1)!, got: JSON.parse(r.value) as Got }));
      const ok = rows.filter(r => r.got.s === "ok").map(r => r.date).sort();
      return { ok: ok.length, none: rows.length - ok.length, oldest: ok[0] ?? null };
    };
    const d = count("day"), s = count("subs"), e = count("events");
    return {
      days: { ...d, todo: this.todo("day").length },
      subs: { ok: s.ok, oldest: s.oldest, todo: this.todo("subs").length },
      events: { ok: e.ok, oldest: e.oldest, todo: this.todo("events").length },
      years: this.store.cursorsWithPrefix("sales:got:year:").filter(r => (JSON.parse(r.value) as Got).s === "ok").map(r => r.key.split(":").at(-1)!).sort(),
    };
  }
}

/** Stored sales of one app (`day` or `year` records), oldest first, within [from, to]. */
export function salesRecords(store: Store, appId: string, kind: "day" | "year", from = "0000", to = "9999"): { date: string; r: SalesRecord }[] {
  const prefix = `sales:${appId}:${kind}:`;
  return store.cursorsWithPrefix(prefix).flatMap(({ key, value }) => {
    const date = key.slice(prefix.length);
    if (date < from || date > to) return [];
    try { return [{ date, r: JSON.parse(value) as SalesRecord }]; } catch { return []; }
  }).sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Dates Apple has answered for (`day` or `year`): a report, or none at all, which means nothing sold (a missing report
 * counts once it was asked for 3 days after the date, when a late report would have arrived). An app without a record
 * on such a date sold nothing then.
 */
export function salesRead(store: Store, kind: "day" | "year" = "day"): Set<string> {
  const out = new Set<string>();
  for (const r of store.cursorsWithPrefix(`sales:got:${kind}:`)) {
    const date = r.key.split(":").at(-1)!;
    try {
      const got = JSON.parse(r.value) as Got;
      const end = kind === "day" ? `${date}T12:00:00Z` : `${date}-12-31T12:00:00Z`;
      if (got.s === "ok" || Date.parse(got.at) - Date.parse(end) > 3 * 86_400_000) out.add(date);
    } catch { /* skip */ }
  }
  return out;
}
export const salesDaysRead = (store: Store) => salesRead(store, "day");

export function subsSnapshots(store: Store, appId: string, from = "0000"): { day: string; s: SubsSnapshot }[] {
  const prefix = `subs:${appId}:day:`;
  return store.cursorsWithPrefix(prefix).flatMap(({ key, value }) => {
    const day = key.slice(prefix.length);
    if (day < from) return [];
    try { return [{ day, s: JSON.parse(value) as SubsSnapshot }]; } catch { return []; }
  }).sort((a, b) => a.day.localeCompare(b.day));
}

export function eventDays(store: Store, appId: string, from = "0000"): { day: string; e: SubEvents }[] {
  const prefix = `subev:${appId}:day:`;
  return store.cursorsWithPrefix(prefix).flatMap(({ key, value }) => {
    const day = key.slice(prefix.length);
    if (day < from) return [];
    try { return [{ day, e: JSON.parse(value) as SubEvents }]; } catch { return []; }
  }).sort((a, b) => a.day.localeCompare(b.day));
}
