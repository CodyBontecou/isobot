import assert from "node:assert/strict";
import { test } from "node:test";
import { RateLimited } from "./analytics.js";
import { appSales } from "./metrics.js";
import { aggregateSales, aggregateSubscriptions, AppleSales, perMonth, toUsd, type ReportFetch } from "./sales.js";
import { Store } from "./store.js";

// Column layouts as Apple sends them (2026-11); the numbers are made up.
const SALES = ["Provider", "Provider Country", "SKU", "Developer", "Title", "Version", "Product Type Identifier", "Units", "Developer Proceeds", "Begin Date", "End Date", "Customer Currency", "Country Code", "Currency of Proceeds", "Apple Identifier", "Customer Price", "Promo Code", "Parent Identifier", "Subscription", "Period", "Category", "CMB", "Device", "Supported Platforms", "Proceeds Reason", "Preserved Pricing", "Client", "Order Type"];
const SUBS = ["App Name", "App Apple ID", "Subscription Name", "Subscription Apple ID", "Subscription Group ID", "Standard Subscription Duration", "Subscription Offer Name", "Promotional Offer ID", "Customer Price", "Customer Currency", "Developer Proceeds", "Proceeds Currency", "Preserved Pricing", "Proceeds Reason", "Client", "Device", "State", "Country", "Active Standard Price Subscriptions", "Active Free Trial Introductory Offer Subscriptions", "Active Pay Up Front Introductory Offer Subscriptions", "Active Pay As You Go Introductory Offer Subscriptions", "Free Trial Promotional Offer Subscriptions", "Pay Up Front Promotional Offer Subscriptions", "Pay As You Go Promotional Offer Subscriptions", "Free Trial Offer Code Subscriptions", "Pay Up Front Offer Code Subscriptions", "Pay As You Go Offer Code Subscriptions", "Free Trial Win-back Offers", "Pay Up Front Win-back Offers", "Pay As You Go Win-back Offers", "Billing Retry", "Grace Period", "Subscribers"];

const tsv = (header: string[], rows: Record<string, string | number>[]) => [header.join("\t"), ...rows.map(r => header.map(h => r[h] ?? "").join("\t"))].join("\n");
const sale = (r: Record<string, string | number>) => ({ "Currency of Proceeds": "USD", "Customer Currency": "USD", Units: 1, ...r });
const rows = (header: string[], list: Record<string, string | number>[]) => tsv(header, list).split("\n").slice(1).map(line => Object.fromEntries(header.map((h, i) => [h, line.split("\t")[i] ?? ""])));

const DAY_ROWS = [
  sale({ SKU: "obsidianhealth001", Title: "Health.md", "Product Type Identifier": "1F", Units: 12, "Apple Identifier": "6757763969", "Developer Proceeds": 0 }),
  sale({ SKU: "obsidianhealth001", Title: "Health.md", "Product Type Identifier": "3F", Units: 4, "Apple Identifier": "6757763969" }),
  sale({ SKU: "obsidianhealth001", Title: "Health.md", "Product Type Identifier": "7F", Units: 30, "Apple Identifier": "6757763969" }),
  // A lifetime unlock in the US and one in Germany, and a refunded one.
  sale({ SKU: "unlock", Title: "Unlock Full Access", "Product Type Identifier": "IA1", Units: 1, "Developer Proceeds": 42.49, "Customer Price": 49.99, "Parent Identifier": "obsidianhealth001" }),
  sale({ SKU: "unlock", Title: "Unlock Full Access", "Product Type Identifier": "IA1", Units: 1, "Developer Proceeds": 36, "Currency of Proceeds": "EUR", "Customer Currency": "EUR", "Customer Price": 49.99, "Parent Identifier": "obsidianhealth001" }),
  sale({ SKU: "unlock", Title: "Unlock Full Access", "Product Type Identifier": "IA1", Units: -1, "Developer Proceeds": 16.99, "Customer Price": -19.99, "Parent Identifier": "obsidianhealth001" }),
  // Two free trials, a new weekly subscription and three renewals.
  sale({ SKU: "weekly", Title: "Individual Weekly", "Product Type Identifier": "IAY", Units: 2, "Developer Proceeds": 0, "Customer Price": 0, "Parent Identifier": "obsidianhealth001", Subscription: "New", Period: "7 Days" }),
  sale({ SKU: "weekly", Title: "Individual Weekly", "Product Type Identifier": "IAY", Units: 1, "Developer Proceeds": 2.54, "Customer Price": 2.99, "Parent Identifier": "obsidianhealth001", Subscription: "New", Period: "7 Days" }),
  sale({ SKU: "weekly", Title: "Individual Weekly", "Product Type Identifier": "IAY", Units: 3, "Developer Proceeds": 0.84, "Customer Price": 0.99, "Parent Identifier": "obsidianhealth001", Subscription: "Renewal", Period: "7 Days" }),
  // A paid app, and a purchase of an app the SKU list doesn't know.
  sale({ SKU: "bontecou.Sync-md", Title: "GitSync.md", "Product Type Identifier": "1F", Units: 2, "Developer Proceeds": 8.49, "Customer Price": 9.99, "Apple Identifier": "6758960270" }),
  sale({ SKU: "x", Title: "Mystery", "Product Type Identifier": "IA1", Units: 1, "Developer Proceeds": 5, "Parent Identifier": "UNKNOWN" }),
  // A Japanese purchase (yen) and one in a currency the ECB doesn't publish.
  sale({ SKU: "unlock", Title: "Unlock Full Access", "Product Type Identifier": "IA1", Units: 1, "Developer Proceeds": 6300, "Currency of Proceeds": "JPY", "Parent Identifier": "obsidianhealth001" }),
  sale({ SKU: "unlock", Title: "Unlock Full Access", "Product Type Identifier": "IA1", Units: 1, "Developer Proceeds": 147, "Currency of Proceeds": "AED", "Parent Identifier": "obsidianhealth001" }),
];
const RATES = { EUR: 0.9, JPY: 150 };

test("toUsd converts with the day's rate, falls back for currencies the ECB lacks, and says so", () => {
  assert.deepEqual(toUsd(10, "USD", null), { usd: 10, approx: false });
  assert.deepEqual(toUsd(9, "EUR", RATES), { usd: 10, approx: false });
  assert.equal(toUsd(147, "AED", RATES).approx, true);
  assert.ok(Math.abs(toUsd(147, "AED", RATES).usd - 40.05) < 0.01);
  assert.deepEqual(toUsd(5, "XYZ", RATES), { usd: 0, approx: true });
});

test("aggregateSales sums an app's downloads, lifetime unlocks, subscriptions and refunds in USD", () => {
  const skus = new Map([["obsidianhealth001", "6757763969"]]);
  const { apps, names } = aggregateSales(rows(SALES, DAY_ROWS), skus, RATES);
  const h = apps.get("6757763969")!;
  assert.equal(h.downloads, 12);
  assert.equal(h.redownloads, 4);
  assert.equal(h.lifetime, 4);
  assert.equal(h.refunds, 1);
  assert.equal(h.trials, 2);
  assert.equal(h.subscriptions, 4);
  assert.equal(h.renewals, 3);
  // 42.49 + 36/0.9 − 16.99 + 6300/150 + 147/3.67
  assert.equal(h.proceeds.lifetime, Math.round((42.49 + 40 - 16.99 + 42 + 147 / 3.67) * 100) / 100);
  assert.equal(h.proceeds.subscriptions, Math.round((2.54 + 3 * 0.84) * 100) / 100);
  assert.equal(h.total, Math.round((h.proceeds.lifetime + h.proceeds.subscriptions) * 100) / 100);
  assert.deepEqual(h.local, { USD: Math.round((42.49 - 16.99 + 2.54 + 2.52) * 100) / 100, EUR: 36, JPY: 6300, AED: 147 });
  assert.ok(h.approx! > 40 && h.approx! < 40.1);
  // The paid app's own row teaches its SKU; the unknown one is left out.
  const g = apps.get("6758960270")!;
  assert.equal(g.downloads, 2);
  assert.equal(g.proceeds.paidDownloads, 16.98);
  assert.equal(skus.get("bontecou.Sync-md"), "6758960270");
  assert.equal(apps.size, 2);
  assert.equal(names.get("6757763969"), "Health.md");
});

test("perMonth turns Apple's durations into periods a month", () => {
  assert.ok(Math.abs(perMonth("7 Days") - 4.348) < 0.01);
  assert.equal(perMonth("1 Month"), 1);
  assert.equal(perMonth("3 Months"), 1 / 3);
  assert.equal(perMonth("1 Year"), 1 / 12);
  assert.equal(perMonth("odd"), 0);
});

test("aggregateSubscriptions counts each plan's paid, trial and retry subscriptions and their monthly proceeds", () => {
  const sub = (r: Record<string, string | number>) => ({ "App Name": "Health.md", "App Apple ID": "6757763969", "Proceeds Currency": "USD", ...r });
  const snap = aggregateSubscriptions(rows(SUBS, [
    sub({ "Subscription Name": "Individual Weekly", "Standard Subscription Duration": "7 Days", "Developer Proceeds": 0.84, "Active Standard Price Subscriptions": 10 }),
    sub({ "Subscription Name": "Individual Weekly", "Standard Subscription Duration": "7 Days", "Developer Proceeds": 0, "Active Free Trial Introductory Offer Subscriptions": 3, "Billing Retry": 1 }),
    sub({ "Subscription Name": "Individual Yearly", "Standard Subscription Duration": "1 Year", "Developer Proceeds": 22.95, "Proceeds Currency": "EUR", "Active Standard Price Subscriptions": 2, "Free Trial Offer Code Subscriptions": 1 }),
  ]), RATES).get("6757763969")!;
  assert.equal(snap.paid, 12);
  assert.equal(snap.trials, 3);
  assert.equal(snap.retry, 1);
  assert.equal(snap.offer, 1);
  const weekly = snap.plans.find(p => p.period === "7 Days")!;
  assert.equal(weekly.monthly, Math.round(8.4 * 52.18 / 12 * 100) / 100);
  const yearly = snap.plans.find(p => p.period === "1 Year")!;
  assert.equal(yearly.monthly, Math.round(((22.95 / 0.9) * 2 / 12) * 100) / 100);
  assert.equal(snap.monthly, Math.round((weekly.monthly + yearly.monthly) * 100) / 100);
});

const NOW = new Date("2026-11-26T18:00:00Z");
const salesText = tsv(SALES, DAY_ROWS.slice(0, 5));

function harness(options: { subsFrom?: string; noSalesOn?: string[]; perPass?: number; report?: ReportFetch } = {}) {
  const store = new Store(":memory:");
  const asked: string[] = [];
  let now = NOW;
  const sales = new AppleSales({
    store,
    perPass: options.perPass ?? 400,
    now: () => now,
    apps: async () => [{ id: "6757763969", sku: "obsidianhealth001", name: "Health.md" }],
    rates: async (from, to) => {
      const out: Record<string, Record<string, number>> = {};
      for (let t = Date.parse(`${from}T12:00:00Z`); t <= Date.parse(`${to}T12:00:00Z`); t += 86_400_000) {
        const d = new Date(t);
        // Business days the ECB has published: up to the day before NOW.
        if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6 && d.toISOString().slice(0, 10) <= "2026-11-25") out[d.toISOString().slice(0, 10)] = RATES;
      }
      return out;
    },
    report: options.report ?? (async (kind, date) => {
      asked.push(`${kind}:${date}`);
      if (kind === "sales-yearly") return date === "2025" ? salesText : null;
      if (kind === "subscriptions") return date >= (options.subsFrom ?? "2026-10-31") ? tsv(SUBS, [{ "App Name": "Health.md", "App Apple ID": "6757763969", "Subscription Name": "Weekly", "Standard Subscription Duration": "7 Days", "Developer Proceeds": 2.54, "Proceeds Currency": "USD", "Active Standard Price Subscriptions": 5 }]) : null;
      return options.noSalesOn?.includes(date) ? null : salesText;
    }),
  });
  return { store, sales, asked, setNow: (d: Date) => { now = d; } };
}

test("a first backfill reads every daily report Apple still has, the years before it, and subscriptions back to the first", async () => {
  const { store, sales, asked } = harness({ noSalesOn: ["2026-06-01"] });
  const done = await sales.tick(true, true);
  // Yesterday (Nov 25) back 364 days; the last-day rates are published, so every day was read.
  assert.equal(done.days, 363);
  assert.equal(store.cursor("sales:6757763969:day:2025-11-27") !== null, true);
  assert.equal(store.cursor("sales:6757763969:day:2025-11-26"), null);
  assert.equal(JSON.parse(store.cursor("sales:got:day:2026-06-01")!).s, "none");
  assert.equal(done.years, 1);
  assert.ok(store.cursor("sales:6757763969:year:2025"));
  assert.ok(asked.includes("sales-yearly:2024"));
  assert.ok(!asked.includes("sales-yearly:2023"));
  // Subscriptions: Oct 31 – Nov 25 read, then 14 empty days, then it stopped.
  assert.equal(done.subs, 26);
  const subsAsked = asked.filter(a => a.startsWith("subscriptions:")).length;
  assert.equal(subsAsked, 26 + 14);
  assert.equal(JSON.parse(store.cursor("subs:6757763969:day:2026-11-25")!).paid, 5);
  // Nothing left to read; a second pass asks nothing.
  asked.length = 0;
  await sales.tick(true, true);
  assert.deepEqual(asked, []);
});

test("each pass reads the newest days first and then the oldest Apple still has, within its budget", async () => {
  const { sales, asked } = harness({ perPass: 6 });
  await sales.tick(true);
  const days = asked.filter(a => a.startsWith("sales-daily:")).map(a => a.slice(12));
  assert.deepEqual(days, ["2026-11-25", "2026-11-24", "2026-11-23", "2026-11-22", "2026-11-21", "2025-11-27"]);
  // The same pass isn't repeated inside 6 hours unless forced.
  asked.length = 0;
  await sales.tick();
  assert.deepEqual(asked, []);
});

test("a recent day without a report is asked again later; an old one isn't", async () => {
  const { sales, asked, setNow } = harness({ noSalesOn: ["2026-11-25", "2026-03-03"] });
  await sales.tick(true, true);
  asked.length = 0;
  setNow(new Date(NOW.getTime() + 6 * 3_600_000));
  await sales.tick(true, true);
  assert.ok(asked.includes("sales-daily:2026-11-25"));
  assert.ok(!asked.includes("sales-daily:2026-03-03"));
});

test("a day isn't stored until its exchange rates are out", async () => {
  // NOW + 1 day: yesterday is Nov 26, whose ECB rates the stub doesn't have yet.
  const { store, sales, setNow } = harness();
  setNow(new Date(NOW.getTime() + 86_400_000));
  await sales.tick(true, true);
  assert.equal(store.cursor("sales:got:day:2026-11-26"), null);
  assert.ok(store.cursor("sales:got:day:2026-11-25"));
});

test("App Store Connect's rate limit ends the pass, keeps what was read, and retries in about an hour", async () => {
  let calls = 0;
  const { store, sales } = harness({
    report: async () => { if (++calls > 3) throw new RateLimited("429"); return salesText; },
  });
  await assert.rejects(sales.tick(true), RateLimited);
  assert.equal(sales.status().days.ok, 3);
  const synced = Date.parse(store.cursor("sales:synced")!);
  assert.ok(synced < NOW.getTime() - 4 * 3_600_000);
});

test("appSales sums months and years from the days, marks partial ones, and carries the subscription snapshots", async () => {
  const { store, sales } = harness();
  await sales.tick(true, true);
  const s = appSales(store, "6757763969", "2026-10-28")!;
  assert.equal(s.through, "2026-11-25");
  assert.equal(s.days[0].day, "2026-10-28");
  assert.equal(s.days.at(-1)!.lifetime, 2);
  const nov25 = s.months.find(m => m.month === "2025-11")!;
  assert.equal(nov25.partial, true);
  assert.equal(nov25.lifetime, 4 * 2);
  const oct = s.months.find(m => m.month === "2026-10")!;
  assert.equal(oct.partial, false);
  assert.equal(oct.downloads, 31 * 12);
  assert.equal(s.months.at(-1)!.partial, true);
  // 2025 comes from its yearly report (one day's rows here); 2026 from its days.
  assert.deepEqual(s.years.map(y => [y.year, y.partial, y.downloads]), [["2025", false, 12], ["2026", true, 329 * 12]]);
  assert.equal(s.subs.length, 26);
  assert.equal(s.subs.at(-1)!.monthly, Math.round(5 * 2.54 * perMonth("7 Days") * 100) / 100);
  assert.equal(s.plans[0].paid, 5);
  assert.equal(appSales(store, "123", "2026-10-28"), null);
});

test("a day Apple has no report for counts as a day without sales, so its month isn't partial", async () => {
  const { store, sales } = harness({ noSalesOn: ["2026-06-01", "2026-11-25"] });
  await sales.tick(true, true);
  const s = appSales(store, "6757763969", "2026-05-01")!;
  const june = s.months.find(m => m.month === "2026-06")!;
  assert.equal(june.partial, false);
  assert.equal(june.downloads, 29 * 12);
  // Yesterday's missing report may still come: not counted yet.
  assert.equal(s.through, "2026-11-24");
});
