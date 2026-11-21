import assert from "node:assert/strict";
import { test } from "node:test";
import { aggregate, AppAnalytics, conversion, dayLine, flags, mergeDay, paidSubscriptions, parseTsv, weekText, type AppDay } from "./analytics.js";
import { formatCheckIn, type NeedsMe } from "./chatTools.js";
import { reportText } from "./aso.js";
import { validateConfig } from "./config.js";
import { Store } from "./store.js";
import { testConfig } from "./testing.js";

// Column layouts as Apple sends them (2026-11); the numbers are made up.
const tsv = (header: string[], rows: (string | number)[][]) => [header.join("\t"), ...rows.map(r => r.join("\t"))].join("\n");
const DISCOVERY = ["Date", "App Name", "App Apple Identifier", "Event", "Page Type", "Source Type", "Engagement Type", "Device", "Platform Version", "Territory", "Counts", "Unique Counts"];
const DOWNLOADS = ["Date", "App Name", "App Apple Identifier", "Download Type", "App Version", "Device", "Platform Version", "Source Type", "Page Type", "Pre-Order", "Territory", "Counts"];
const SUB_EVENTS = ["Event Date", "App Name", "App Apple Identifier", "Event Group", "Event Name", "Subscription Name", "Territory", "Counts"];
const SUB_STATES = ["Date", "App Name", "App Apple Identifier", "State Metric", "Subscription Name", "Territory", "Counts"];
const PURCHASES = ["Date", "App Name", "App Apple Identifier", "Purchase Type", "Content Name", "Territory", "Purchases", "Proceeds in USD", "Sales in USD", "Paying Users"];

const discovery = (day: string, impressions: number, views: number) => tsv(DISCOVERY, [
  [day, "Health.md", "6757763969", "Impression", "No page", "App Store search", "", "iPhone", "iOS 27.2", "US", impressions - 10, impressions - 12],
  [day, "Health.md", "6757763969", "Impression", "No page", "App Store browse", "", "iPhone", "iOS 27.2", "DE", 10, 9],
  [day, "Health.md", "6757763969", "Page view", "Product page", "App Store search", "", "iPhone", "iOS 27.2", "US", views, views],
  // Not a product page view.
  [day, "Health.md", "6757763969", "Page view", "Developer page", "App Store browse", "", "iPhone", "iOS 27.2", "US", 4, 4],
  [day, "Health.md", "6757763969", "Tap", "Product page", "App Store browse", "Get", "iPhone", "iOS 27.2", "US", 3, 3],
]);
const downloads = (rows: [string, number][]) => tsv(DOWNLOADS, rows.flatMap(([day, first]) => [
  [day, "Health.md", "6757763969", "First-time download", "3.5.0", "iPhone", "iOS 27.2", "App Store search", "Product page", "", "US", first],
  [day, "Health.md", "6757763969", "Redownload", "3.5.0", "iPhone", "iOS 27.2", "App Store search", "Product page", "", "US", 2],
  [day, "Health.md", "6757763969", "Auto-update", "3.5.0", "iPhone", "iOS 27.2", "", "", "", "US", 40],
]));

test("parseTsv reads Apple's tab-separated reports by column name", () => {
  const rows = parseTsv(`﻿${tsv(["Date", "Counts"], [["2026-11-17", 3]])}\n\n`);
  assert.deepEqual(rows, [{ Date: "2026-11-17", Counts: "3" }]);
  assert.deepEqual(parseTsv(""), []);
});

test("aggregate sums each report per day, counting only what the metric means", () => {
  const d = aggregate("discovery", parseTsv(discovery("2026-11-17", 100, 8))).get("2026-11-17");
  assert.deepEqual(d, { impressions: 100, pageViews: 8 });
  const dl = aggregate("downloads", parseTsv(downloads([["2026-11-17", 5], ["2026-11-18", 7]])));
  assert.deepEqual(dl.get("2026-11-17"), { firstDownloads: 5, redownloads: 2 });
  assert.deepEqual(dl.get("2026-11-18"), { firstDownloads: 7, redownloads: 2 });
  const ev = aggregate("subEvents", parseTsv(tsv(SUB_EVENTS, [
    ["2026-11-17", "Health.md", "1", "Offer start", "Free trial start activation", "Weekly", "KR", 2],
    ["2026-11-17", "Health.md", "1", "Offer start", "Free trial start activation", "Weekly", "US", 3],
    ["2026-11-17", "Health.md", "1", "Voluntary churn", "Voluntary churn from free trial", "Weekly", "US", 1],
  ]))).get("2026-11-17");
  assert.deepEqual(ev, { subEvents: { "Offer start": 5, "Voluntary churn": 1 } });
  const p = aggregate("purchases", parseTsv(tsv(PURCHASES, [
    ["2026-11-17", "Health.md", "1", "In-app purchase", "Yearly", "CL", 1, "14.58", "20.41", 1],
    ["2026-11-17", "Health.md", "1", "In-app purchase", "Weekly", "US", 1, "0.00", "0.00", 0],
    ["2026-11-17", "Health.md", "1", "In-app purchase", "Weekly", "US", 2, "5.10", "7.00", 2],
  ]))).get("2026-11-17");
  assert.deepEqual(p, { purchases: 4, proceeds: 19.68 });
});

test("mergeDay keeps the newest processing date's numbers for each report", () => {
  let r = mergeDay(null, "downloads", "2026-11-18", { firstDownloads: 30, redownloads: 1 });
  r = mergeDay(r, "discovery", "2026-11-18", { impressions: 500, pageViews: 40 });
  // Apple restates the day in the next instance: it replaces the earlier numbers.
  r = mergeDay(r, "downloads", "2026-11-19", { firstDownloads: 34, redownloads: 2 });
  // An older instance read late changes nothing.
  r = mergeDay(r, "downloads", "2026-11-17", { firstDownloads: 1, redownloads: 0 });
  assert.deepEqual(r.m, { impressions: 500, pageViews: 40, firstDownloads: 34, redownloads: 2 });
  assert.deepEqual(r.src, { downloads: "2026-11-19", discovery: "2026-11-18" });
});

test("paid subscriptions leave out trials, churn and billing retry", () => {
  assert.equal(paidSubscriptions({ subStates: { "Full price": 21, "Free trial": 22, "Voluntary churn": 19, "Billing retry": 3, "Pay up front": 2 } }), 23);
  assert.equal(paidSubscriptions({}), null);
  assert.equal(conversion({ pageViews: 40, firstDownloads: 10 }), 25);
  assert.equal(conversion({ firstDownloads: 10 }), null);
});

const days = (start: string, values: Partial<AppDay["m"]>[]): AppDay[] => values.map((m, i) => ({
  day: new Date(Date.parse(`${start}T12:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10), m,
}));

test("the check-in line gives the day's numbers against the week before", () => {
  const before = days("2026-11-10", Array(7).fill({ firstDownloads: 10 }));
  const line = dayLine("Health.md", { day: "2026-11-17", m: {
    firstDownloads: 15, impressions: 800, pageViews: 60, purchases: 6, proceeds: 65.38,
    subStates: { "Full price": 21, "Free trial": 22, "Voluntary churn": 19 }, subEvents: { "Offer start": 9, "Paid subscription from offer": 4, "Voluntary churn": 5, Renewal: 4 },
  } }, before);
  assert.equal(line, "**Health.md** (Nov 17): 15 new downloads (7-day avg 10) · 800 impressions → 60 page views (25% downloaded) · 6 purchases, $65.38 · subs: 21 paid, 22 in trial; 9 offer starts, 4 converted, 5 churned");
  // An app without purchases or subscriptions says only what it has.
  assert.equal(dayLine("GitSync.md", { day: "2026-11-17", m: { firstDownloads: 3, impressions: 90, pageViews: 0 } }, []), "**GitSync.md** (Nov 17): 3 new downloads · 90 impressions → 0 page views");
});

test("flags: download jumps and drops, churn spikes, and data that stopped arriving", () => {
  const week = days("2026-11-10", Array(7).fill({ firstDownloads: 10, subEvents: { "Voluntary churn": 1 } }));
  const at = (m: AppDay["m"]) => ({ day: "2026-11-17", m });
  assert.deepEqual(flags("Vox.md", at({ firstDownloads: 11, subEvents: { "Voluntary churn": 1 } }), week, "2026-11-19"), []);
  assert.match(flags("Vox.md", at({ firstDownloads: 25 }), week, "2026-11-19")[0], /📈 Vox.md: 25 new downloads on Nov 17, 2.5× the 7-day average \(10\)/);
  assert.match(flags("Vox.md", at({ firstDownloads: 3 }), week, "2026-11-19")[0], /📉 Vox.md: 3 new downloads/);
  assert.match(flags("Vox.md", at({ subEvents: { "Voluntary churn": 4, "Involuntary churn": 1 } }), week, "2026-11-19")[0], /5 subscriptions churned/);
  assert.match(flags("Vox.md", at({ firstDownloads: 10 }), week, "2026-11-23")[0], /no App Store analytics since Nov 17 \(6 days\)/);
  // A quiet app (under 5 a day) doesn't flag on noise.
  assert.deepEqual(flags("Tiny", at({ firstDownloads: 9 }), days("2026-11-10", Array(7).fill({ firstDownloads: 2 })), "2026-11-19"), []);
});

test("the weekly line compares the last 7 days with the 7 before", () => {
  const a = days("2026-11-11", Array(7).fill({ impressions: 100, pageViews: 10, firstDownloads: 3, purchases: 1, proceeds: 5, subStates: { "Full price": 20 } }));
  const b = days("2026-11-04", Array(7).fill({ impressions: 80, pageViews: 10, firstDownloads: 2, purchases: 1, proceeds: 5, subStates: { "Full price": 18 } }));
  assert.equal(weekText(a, b), "**App Store analytics** (Nov 11–Nov 17, vs the 7 days before): impressions 700 (+25%) · page views 70 (+0%) · page → download 30% (was 20%) · new downloads 21 (+50%) · proceeds $35.00 (+0%) · paid subscriptions 20 (was 18)");
  assert.equal(weekText([], b), null);
  assert.match(weekText(a, [])!, /^\*\*App Store analytics\*\* \(Nov 11–Nov 17\): impressions 700 · /);
  // A week still filling in isn't reported, and isn't compared against.
  assert.equal(weekText(a.slice(1), b), null);
  assert.equal(weekText(a, b.slice(2)), weekText(a, []));
  assert.equal(weekText([...a.slice(0, 6), { day: "2026-11-17", m: { impressions: 5 } }], b), null);
});

test("the check-in posts on an analytics flag alone, and carries app numbers on any check-in", () => {
  const quiet: NeedsMe = { review: [], ship: [], failed: [], releaseFailed: [], proposals: [], runner: { paused: false, usageLimitPauseUntil: null, lastCycleError: null } };
  assert.equal(formatCheckIn(quiet, [], { lines: ["**Vox.md** (Nov 17): 3 new downloads"], flags: [] }), null);
  const flagged = formatCheckIn(quiet, [], { lines: ["**Vox.md** (Nov 17): 25 new downloads"], flags: ["📈 Vox.md: 25 new downloads"] })!;
  assert.match(flagged, /Nothing needs you right now\.\n\*\*App Store\*\*\n📈 Vox.md: 25 new downloads\n- \*\*Vox.md\*\* \(Nov 17\): 25 new downloads/);
  const busy = formatCheckIn({ ...quiet, ship: [{ id: "a/b#1", title: "Fix" }] }, [], { lines: ["**Vox.md** (Nov 17): 3 new downloads"], flags: [] })!;
  assert.match(busy, /\*\*Ready to ship\*\*\n- a\/b#1: Fix\n\*\*App Store\*\*\n- \*\*Vox.md\*\*/);
  assert.doesNotMatch(formatCheckIn({ ...quiet, ship: [{ id: "a/b#1", title: "Fix" }] }, [])!, /App Store/);
});

test("the weekly ASO report carries the analytics line under its summary", () => {
  const text = reportText({ app: "vox.md", today: "2026-11-23", baselineDay: null, movers: null, current: [], storefront: "us", analytics: "**App Store analytics** (…): impressions 700" });
  assert.match(text, /top 50: 0\n\*\*App Store analytics\*\* \(…\): impressions 700\nNo snapshot/);
});

test("config: analytics needs appStore and only follows apps listed there", () => {
  const config = testConfig();
  config.analytics = { apps: ["6757763969"] };
  validateConfig(config);
  config.analytics = { apps: ["123456789"] };
  assert.throws(() => validateConfig(config), /isn't in appStore.apps/);
  config.analytics = { backfillDays: 0 };
  assert.throws(() => validateConfig(config), /backfillDays/);
});

/** App Store Connect for one app: an ongoing request whose daily instances restate the days before. */
class FakeAsc {
  calls: string[][] = [];
  files = new Map<string, string>();
  /** report name → instances. */
  reports = new Map<string, { id: string; date: string; urls: string[] }[]>();
  fail: { path: string; error: string } | null = null;
  add(date: string, report: string, id: string, ...segments: string[]) {
    const urls = segments.map((text, i) => { const url = `https://s3.example/${id}/${i}.csv.gz`; this.files.set(url, text); return url; });
    this.reports.set(report, [...(this.reports.get(report) ?? []), { id, date, urls }]);
  }
  private reportId(name: string) { return `r-${[...this.reports.keys(), "Home Screen Widgets"].indexOf(name)}`; }
  async run(args: string[]) {
    this.calls.push(args);
    const ok = (data: unknown[]) => ({ ok: true, stderr: "", stdout: JSON.stringify({ data }) });
    if (args[1] === "requests") return ok([
      { id: "snap", attributes: { accessType: "ONE_TIME_SNAPSHOT", stoppedDueToInactivity: false } },
      { id: "req1", attributes: { accessType: "ONGOING", stoppedDueToInactivity: false } },
    ]);
    if (args[0] !== "api" || args[1] !== "GET") return { ok: false, stdout: "", stderr: `unexpected ${args.join(" ")}` };
    const path = args[2];
    if (this.fail && path.includes(this.fail.path)) return { ok: false, stdout: "", stderr: this.fail.error };
    if (path === "/v1/analyticsReportRequests/req1/reports") {
      // Reports the runner doesn't read come along too.
      return ok([...this.reports.keys(), "Home Screen Widgets"].map(name => ({ id: this.reportId(name), attributes: { name } })));
    }
    const report = /^\/v1\/analyticsReports\/(.+)\/instances$/.exec(path);
    if (report) {
      const name = [...this.reports.keys()].find(n => this.reportId(n) === report[1]);
      return ok((name ? this.reports.get(name)! : []).map(x => ({ id: x.id, attributes: { granularity: "DAILY", processingDate: x.date } })));
    }
    const instance = /^\/v1\/analyticsReportInstances\/(.+)\/segments$/.exec(path);
    if (instance) {
      const found = [...this.reports.values()].flat().find(x => x.id === instance[1]);
      return ok((found?.urls ?? []).map((url, i) => ({ id: `${instance[1]}-${i}`, attributes: { url } })));
    }
    return { ok: false, stdout: "", stderr: `unknown path ${path}` };
  }
}

function setup(now = "2026-11-20T09:00:00") {
  const config = testConfig();
  config.analytics = { apps: ["6757763969"], backfillDays: 6 };
  const store = new Store(":memory:");
  const asc = new FakeAsc();
  const fetched: string[] = [];
  const analytics = new AppAnalytics({
    config, store, asc: args => asc.run(args), now: () => new Date(now),
    fetchGz: async url => { fetched.push(url); const text = asc.files.get(url); if (text === undefined) throw new Error("404"); return text; },
  });
  return { config, store, asc, analytics, fetched };
}

test("sync reads each instance once, newest first, sums its segments, and lets newer instances restate days", async () => {
  const { store, asc, analytics, fetched } = setup();
  asc.add("2026-11-18", "App Downloads Standard", "d18", downloads([["2026-11-16", 4], ["2026-11-17", 30]]));
  // The next day's instance restates Nov 17, in two segments.
  asc.add("2026-11-19", "App Downloads Standard", "d19", downloads([["2026-11-17", 20]]), downloads([["2026-11-17", 14], ["2026-11-18", 9]]));
  asc.add("2026-11-19", "App Store Discovery and Engagement Standard", "e19", discovery("2026-11-18", 400, 30));
  // Older than backfillDays: never read.
  asc.add("2026-11-10", "App Downloads Standard", "d10", downloads([["2026-11-09", 99]]));
  assert.equal(await analytics.sync("6757763969"), 3);
  assert.deepEqual(analytics.days("6757763969").map(d => [d.day, d.m.firstDownloads]), [["2026-11-16", 4], ["2026-11-17", 34], ["2026-11-18", 9]]);
  assert.equal(analytics.name("6757763969"), "Health.md");
  assert.deepEqual(analytics.latest("6757763969"), { day: "2026-11-18", m: { firstDownloads: 9, redownloads: 2, impressions: 400, pageViews: 30 } });
  const segments = asc.calls.filter(c => c[2]?.endsWith("/segments")).map(c => c[2].split("/")[3]);
  assert.equal(segments.at(-1), "d18", "the newest processing dates go first");
  // The next pass lists instances again but downloads nothing it has read.
  const before = fetched.length;
  assert.equal(await analytics.sync("6757763969"), 0);
  assert.equal(fetched.length, before);
  assert.equal(asc.calls.filter(c => c[1] === "requests").length, 1, "the request id is remembered");
  assert.equal(asc.calls.filter(c => c[2]?.endsWith("/reports")).length, 1, "report ids are remembered");
  assert.equal(store.cursor("analytics:6757763969:request"), "req1");
  // Every App Store Connect call is a GET or a read command.
  assert.ok(asc.calls.every(c => c[1] === "requests" || c[1] === "GET"));
});

test("a failed pass keeps what it read, and a rate limit stops the pass for every app", async () => {
  const { store, asc, analytics } = setup();
  asc.add("2026-11-19", "App Downloads Standard", "d19", downloads([["2026-11-18", 9]]));
  asc.add("2026-11-18", "App Downloads Standard", "d18", downloads([["2026-11-17", 5]]));
  asc.fail = { path: "d18", error: "Error: 500 Internal Server Error" };
  await assert.rejects(analytics.sync("6757763969"), /GET \/v1\/analyticsReportInstances\/d18\/segments: Error: 500/);
  assert.deepEqual(analytics.days("6757763969").map(d => d.day), ["2026-11-18"]);
  asc.fail = null;
  assert.equal(await analytics.sync("6757763969"), 1);
  assert.deepEqual(analytics.days("6757763969").map(d => d.day), ["2026-11-17", "2026-11-18"]);

  const config = analytics["deps"].config;
  config.analytics = {};
  asc.fail = { path: "/instances", error: "rate limited by App Store Connect (status 429): The request rate limit has been reached." };
  const calls = asc.calls.length;
  await analytics.tick(true);
  const errors = store.eventsSince(0).filter(e => e.kind === "analytics_error");
  assert.equal(errors.length, 1, "the first app's rate limit ends the pass");
  assert.match(errors[0].detail ?? "", /rate limit/);
  assert.ok(asc.calls.length - calls <= 3);
});

test("tick runs every few hours, and describe answers the chat tool", async () => {
  const { asc, analytics } = setup();
  asc.add("2026-11-19", "App Downloads Standard", "d19", downloads([["2026-11-18", 9]]));
  asc.add("2026-11-19", "App Store Discovery and Engagement Standard", "e19", discovery("2026-11-18", 400, 30));
  await analytics.tick();
  const calls = asc.calls.length;
  await analytics.tick();
  assert.equal(asc.calls.length, calls, "not again within 6 hours");
  const one = analytics.describe("health-md", 14) as { name: string; days: { day: string; conversionPct: number | null }[] };
  assert.equal(one.name, "Health.md");
  assert.deepEqual(one.days.map(d => [d.day, d.conversionPct]), [["2026-11-18", 30]]);
  const all = analytics.describe(null, 14) as { apps: { latestDay: string; last7Days: { firstDownloads: number } }[] };
  assert.equal(all.apps[0].latestDay, "2026-11-18");
  assert.equal(all.apps[0].last7Days.firstDownloads, 9);
  assert.match(String((analytics.describe("nope", 14) as { error: string }).error), /no followed app "nope"; use one of: Health.md \(6757763969\)/);
  assert.match(analytics.checkIn().lines[0], /^\*\*Health.md\*\* \(Nov 18\): 9 new downloads · 400 impressions → 30 page views \(30% downloaded\)$/);
});

test("analytics is off without its config block", () => {
  const { config, analytics } = setup();
  delete config.analytics;
  assert.deepEqual(analytics.apps(), []);
});
