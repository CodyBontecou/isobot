import assert from "node:assert/strict";
import { test } from "node:test";
import { validateConfig, type RunnerConfig } from "./config.js";
import {
  bootstrapWorse, consistency, outcomeOf, parseAppStorePrices, parseDecision, parsePlayPrices, priceOn, PRICING_DEFAULTS,
  PricingTrain, STOP, validate, type DayValue, type PricedProduct,
} from "./pricing.js";
import { Store } from "./store.js";
import { testConfig } from "./testing.js";

const APP = "6757763969";
const PKG = "com.example.app";

/** asc for one app: pricing summaries from `subs` and `iaps`, recording every write. */
class FakeAsc {
  subs = [
    { id: "s-week", name: "Individual Weekly", productId: "app.weekly", subscriptionPeriod: "ONE_WEEK", state: "APPROVED", price: 2.99 },
    { id: "s-year", name: "Individual Yearly", productId: "app.yearly", subscriptionPeriod: "ONE_YEAR", state: "APPROVED", price: 29.99 },
    { id: "s-draft", name: "Assist Monthly", productId: "app.assist", subscriptionPeriod: "ONE_MONTH", state: "READY_TO_SUBMIT", price: 1.99 },
  ];
  iaps = [
    { id: "i-life", name: "Unlock Full Access", productId: "app.unlock", price: 79.99, state: "APPROVED" },
    { id: "i-fam", name: "Family Full Access", productId: "app.unlock.family", price: 129.99, state: "APPROVED" },
    { id: "i-up", name: "Family Upgrade", productId: "app.unlock.family.upgrade", price: 49.99, state: "APPROVED" },
    { id: "i-old", name: "Old Unlock", productId: "app.old", price: 9.99, state: "DEVELOPER_REMOVED_FROM_SALE" },
  ];
  writes: string[][] = [];
  fail: string | null = null;

  run = async (args: string[]) => {
    const ok = (v: unknown) => ({ ok: true, stdout: JSON.stringify(v), stderr: "" });
    const cmd = args.slice(0, 3).join(" ");
    if (cmd === "subscriptions pricing summary") {
      return ok({ subscriptions: this.subs.map(s => ({ ...s, currentPrice: { amount: s.price.toFixed(2), currency: "USD" } })) });
    }
    if (cmd === "iap pricing summary") return ok({ iaps: this.iaps.map(i => ({ ...i, type: "NON_CONSUMABLE", currentPrice: { amount: i.price.toFixed(2), currency: "USD" } })) });
    if (cmd === "iap list --app") return ok({ data: this.iaps.map(i => ({ id: i.id, attributes: { state: i.state } })) });
    if (cmd === "subscriptions pricing equalize") {
      const price = Number(args[args.indexOf("--base-price") + 1]);
      if (this.fail) return { ok: false, stdout: "", stderr: `Error: ${this.fail}` };
      if (!args.includes("--dry-run")) {
        this.writes.push(args);
        // Apple shows the new price once its start date comes; this fake shows it at once.
        this.subs.find(s => s.id === args[args.indexOf("--subscription-id") + 1])!.price = price;
      }
      const start = args.includes("--start-date") ? args[args.indexOf("--start-date") + 1] : "2026-11-29";
      return { ok: true, stdout: `Checking…\n${JSON.stringify({ startDate: start, dryRun: args.includes("--dry-run") })}`, stderr: "" };
    }
    if (cmd === "iap pricing price-points") return ok({ data: [9.99, 49.99, 59.99, 79.99, 99.99, 109.99, 129.99, 149.99, 159.99].map(p => ({ attributes: { customerPrice: String(p) } })) });
    if (cmd === "iap pricing schedules") {
      this.writes.push(args);
      this.iaps.find(i => i.id === args[args.indexOf("--iap-id") + 1])!.price = Number(args[args.indexOf("--price") + 1]);
      return ok({ id: "sched" });
    }
    throw new Error(`unexpected asc ${args.join(" ")}`);
  };
}

function setup(opts: { autonomy?: "apply" | "propose" | "report"; decision?: unknown; config?: Partial<RunnerConfig>; play?: boolean } = {}) {
  const config = { ...testConfig(), pricing: {}, ...opts.config } as RunnerConfig;
  config.repos = { "owner/app": { aso: { appId: APP, ...(opts.play ? { play: { packageName: PKG } } : {}) }, pricing: { autonomy: opts.autonomy ?? "apply", siteIssues: true } } as RunnerConfig["repos"][string] };
  const store = new Store(":memory:");
  const asc = new FakeAsc();
  const posts: { text: string; reactions: readonly string[] }[] = [];
  const issues: { title: string; body: string; labels: string[] }[] = [];
  const prompts: string[] = [];
  const reactions = new Map<string, string[]>();
  let now = new Date("2026-11-28T14:00:00");
  let decision: unknown = opts.decision ?? { action: "hold", reason: "Too little data.", changes: [] };
  let n = 0;
  const train = new PricingTrain({
    config, store, now: () => now,
    github: {
      defaultBranch: async () => "main",
      createIssue: async (_o: string, _r: string, title: string, body: string, labels: string[]) => { issues.push({ title, body, labels }); return { number: 1, url: "u" } as never; },
    },
    notifier: { discord: async (text, r = []) => { posts.push({ text, reactions: r }); return { channelId: "c", messageId: `m${++n}` }; } },
    asc: asc.run,
    approvals: { owners: async () => new Set(["owner"]), reactors: async (_c, m, e) => reactions.get(`${m}${e}`) ?? [] },
    repo: () => ({ sync: async () => "sha", checkoutAt: async () => "/tmp", removeWorkspace: async () => undefined }) as never,
    agent: async input => { prompts.push(input.prompt); return { output: decision }; },
  });
  const app = train.apps().find(a => a.market === "appstore")!;
  return {
    train, app, store, asc, posts, issues, prompts, reactions,
    at: (iso: string) => { now = new Date(iso); },
    decide: (d: unknown) => { decision = d; },
  };
}

const day = (d: string, by: number) => new Date(Date.parse(`${d}T12:00:00Z`) + by * 86_400_000).toISOString().slice(0, 10);

/** Apple's daily numbers for [from, from + days): downloads a day, and lifetime sales and weekly conversions on some days. */
function seed(store: Store, from: string, days: number, perDay: { downloads: number; lifetimeEvery?: number; lifetime?: number; convertEvery?: number }) {
  for (let i = 0; i < days; i++) {
    const d = day(from, i);
    const lifetime = perDay.lifetimeEvery && i % perDay.lifetimeEvery === 0 ? perDay.lifetime ?? 68 : 0;
    store.setCursor(`sales:${APP}:day:${d}`, JSON.stringify({ downloads: perDay.downloads, proceeds: { lifetime, subscriptions: 0, paidDownloads: 0, other: 0 }, total: lifetime }));
    store.setCursor(`sales:got:day:${d}`, JSON.stringify({ s: "ok", at: "x" }));
    const converted = perDay.convertEvery && i % perDay.convertEvery === 0 ? 1 : 0;
    store.setCursor(`subev:${APP}:day:${d}`, JSON.stringify({ trialStarts: 0, converted, plans: [{ name: "Individual Weekly", period: "7 Days", converted, newPaid: 0 }] }));
    store.setCursor(`sales:got:events:${d}`, JSON.stringify({ s: "ok", at: "x" }));
  }
}

test("App Store products: only approved subscriptions and in-app purchases on sale", () => {
  const asc = new FakeAsc();
  const subs = { subscriptions: asc.subs.map(s => ({ ...s, currentPrice: { amount: String(s.price), currency: "USD" } })) };
  const iaps = { iaps: asc.iaps.map(i => ({ ...i, type: "NON_CONSUMABLE", currentPrice: { amount: String(i.price), currency: "USD" } })) };
  const products = parseAppStorePrices(subs, iaps, new Map(asc.iaps.map(i => [i.id, i.state])));
  assert.deepEqual(products.map(p => `${p.id}:${p.kind}:${p.period ?? ""}:${p.price}`), [
    "s-week:subscription:week:2.99", "s-year:subscription:year:29.99", "i-life:lifetime::79.99", "i-fam:lifetime::129.99", "i-up:lifetime::49.99",
  ]);
});

test("Play products: active base plans and buy options at their US price", () => {
  const usd = (u: string, nanos = 990000000) => ({ currencyCode: "USD", units: u, nanos });
  const products = parsePlayPrices(
    { subscriptions: [{ productId: "sub", basePlans: [
      { basePlanId: "weekly", state: "ACTIVE", autoRenewingBasePlanType: { billingPeriodDuration: "P1W" }, regionalConfigs: [{ regionCode: "AE", price: { currencyCode: "AED", units: "11" } }, { regionCode: "US", price: usd("2") }] },
      { basePlanId: "old", state: "INACTIVE", autoRenewingBasePlanType: { billingPeriodDuration: "P1Y" }, regionalConfigs: [{ regionCode: "US", price: usd("9") }] },
    ] }] },
    { oneTimeProducts: [{ productId: "life", purchaseOptions: [{ purchaseOptionId: "lifetime", state: "ACTIVE", buyOption: {}, regionalPricingAndAvailabilityConfigs: [{ regionCode: "US", price: usd("79") }] }] }] },
  );
  assert.deepEqual(products.map(p => `${p.id}:${p.kind}:${p.period ?? ""}:${p.price.toFixed(2)}`), ["sub/weekly:subscription:week:2.99", "life/lifetime:lifetime::79.99"]);
});

const priced = (): PricedProduct[] => [
  { id: "w", productId: "app.weekly", name: "Individual Weekly", kind: "subscription", period: "week", price: 2.99, since: "2026-11-01", anchor: 2.99 },
  { id: "y", productId: "app.yearly", name: "Individual Yearly", kind: "subscription", period: "year", price: 29.99, since: "2026-11-01", anchor: 29.99 },
  { id: "fw", productId: "app.family.weekly", name: "Family Weekly", kind: "subscription", period: "week", price: 4.99, since: "2026-11-01", anchor: 4.99 },
  { id: "l", productId: "app.unlock", name: "Unlock Full Access", kind: "lifetime", price: 79.99, since: "2026-11-01", anchor: 79.99 },
  { id: "fl", productId: "app.unlock.family", name: "Family Full Access", kind: "lifetime", price: 129.99, since: "2026-11-01", anchor: 129.99 },
  { id: "u", productId: "app.unlock.family.upgrade", name: "Family Upgrade", kind: "lifetime", price: 49.99, since: "2026-11-01", anchor: 49.99 },
];
const change = (...changes: [string, number][]) => ({ action: "change" as const, reason: "r", changes: changes.map(([id, price]) => ({ id, price })) });

test("validate: bounds, step size, locks and a paywall that still makes sense", () => {
  const p = priced();
  const v = (d: ReturnType<typeof change>, cfg = {}) => validate(d, p, PRICING_DEFAULTS, cfg);
  assert.deepEqual(v(change(["w", 3.99])), []);
  assert.match(v(change(["w", 4.99])).join(), /more than 35%/);
  assert.match(v(change(["w", 3.999])).join(), /cents/);
  assert.match(v(change(["w", 2.99])).join(), /already costs/);
  assert.match(v(change(["u", 39.99])).join(), /locked/);
  assert.match(v(change(["w", 3.99]), { lock: ["app.weekly"] }).join(), /locked/);
  assert.match(v(change(["w", 3.99]), { bounds: { "app.weekly": { max: 3.49 } } }).join(), /outside \$1\.50–\$3\.49/);
  assert.match(v(change(["nope", 1])).join(), /unknown product/);
  // Family weekly can't drop under individual weekly.
  assert.match(v(change(["fw", 3.49], ["w", 3.99])).join(), /Family Weekly .* at least Individual Weekly/);
  // Yearly has to stay well under 52 weeks: at 0.59 a week, 52 weeks are 30.68 and 90% of that is under 29.99.
  assert.match(consistency(p.map(x => x.id === "w" ? { ...x, price: 0.59 } : x)).join(), /90% of 52/);
  assert.deepEqual(consistency(p.map(x => x.id === "w" ? { ...x, price: 0.69 } : x)), []);
  // Lifetime alone breaks the family upgrade's difference; both lifetimes together keep it.
  assert.match(v(change(["l", 99.99])).join(), /must stay \$49\.99/);
  assert.deepEqual(v(change(["l", 99.99], ["fl", 149.99])), []);
  assert.match(v({ ...change(), changes: [1, 2, 3, 4].map(() => ({ id: "w", price: 3.49 })) }).join(), /at most three/);
});

test("consistency: problems the live prices already have don't block a change", () => {
  const p = priced().map(x => x.id === "u" ? { ...x, price: 59.99 } : x);
  assert.equal(consistency(p).length, 1);
  assert.deepEqual(validate(change(["w", 3.49]), p, PRICING_DEFAULTS, {}), []);
});

test("parseDecision keeps only well-formed changes", () => {
  assert.deepEqual(parseDecision({ action: "change", reason: "x", changes: [{ id: "a", price: 3.991 }, { id: 4 }] }).changes, [{ id: "a", price: 3.99 }]);
  assert.deepEqual(parseDecision({ action: "hold", reason: "x", changes: [{ id: "a", price: 3 }] }).changes, []);
  assert.equal(parseDecision(null).action, "hold");
});

test("priceOn reads a product's price on a day from the changes since", () => {
  const history = [
    { at: "", liveDay: "2026-12-01", by: "isobot" as const, changes: [{ id: "w", name: "", from: 2.99, to: 3.99 }] },
    { at: "", liveDay: "2027-01-01", by: "isobot" as const, changes: [{ id: "w", name: "", from: 3.99, to: 4.99 }] },
  ];
  const p = { id: "w", price: 4.99 };
  assert.equal(priceOn(p, history, "2026-11-30"), 2.99);
  assert.equal(priceOn(p, history, "2026-12-15"), 3.99);
  assert.equal(priceOn(p, history, "2027-01-01"), 4.99);
});

test("outcome: clearly lower value per download is worse, noise is unclear", () => {
  const days = (from: string, n: number, value: (i: number) => number): DayValue[] => Array.from({ length: n }, (_, i) => ({ day: day(from, i), downloads: 10, lifetime: 0, subs: {}, value: value(i) }));
  const before = days("2026-11-01", 28, i => i % 2 ? 20 : 10);
  const worse = days("2026-11-29", 28, i => i % 2 ? 8 : 4);
  const o = outcomeOf([...before, ...worse], ["2026-11-01", "2026-11-28"], ["2026-11-29", "2026-12-26"], PRICING_DEFAULTS, "now");
  assert.equal(o.verdict, "worse");
  assert.equal(o.ratio, 0.4);
  assert.ok((o.pWorse ?? 0) > 0.99);
  const noisy = days("2026-11-29", 28, i => i % 3 ? 20 : 5);
  assert.equal(outcomeOf([...before, ...noisy], ["2026-11-01", "2026-11-28"], ["2026-11-29", "2026-12-26"], PRICING_DEFAULTS, "now").verdict, "unclear");
  assert.equal(bootstrapWorse(before.slice(0, 3), worse), null);
});

test("snapshot: the first sets the anchors; a price changed by hand is recorded and posted", async () => {
  const { train, app, asc, posts, at } = setup();
  const first = await train.snapshot(app);
  assert.deepEqual(first.map(p => p.id), ["s-week", "s-year", "i-life", "i-fam", "i-up"]);
  assert.ok(first.every(p => p.since === "2026-11-28" && p.anchor === p.price));
  asc.iaps[0].price = 99.99;
  at("2026-11-28T16:00:00");
  await train.snapshot(app);
  assert.equal(train.history(app).length, 0, "read at most every 6 hours");
  at("2026-11-29T10:00:00");
  const next = await train.snapshot(app);
  assert.deepEqual(train.history(app).map(h => [h.by, h.changes[0].to]), [["outside", 99.99]]);
  assert.equal(next.find(p => p.id === "i-life")!.anchor, 79.99);
  assert.match(posts.at(-1)!.text, /outside isobot/);
});

test("no decision until the current prices have been live minDays", async () => {
  const { train, app, at } = setup();
  await train.snapshot(app);
  assert.match(train.decisionDue(app) ?? "", /next decision from 2026-12-26/);
  at("2026-12-26T10:00:00");
  assert.equal(train.decisionDue(app), null);
  at("2026-12-26T22:00:00");
  assert.equal(train.decisionDue(app), "outside hours");
  train.setPaused(true);
  assert.equal(train.decisionDue(app), "paused");
});

test("apply: isobot moves prices, keeps existing subscribers on an increase, posts 🛑 and files the site issue", async () => {
  const { train, app, store, asc, posts, issues, prompts, at, decide } = setup();
  await train.snapshot(app);
  seed(store, "2026-11-28", 35, { downloads: 8, lifetimeEvery: 4, convertEvery: 2 });
  at("2026-12-28T10:00:00");
  decide({ action: "change", reason: "Weekly converts well; test a higher price.", changes: [{ id: "s-week", price: 3.49 }, { id: "app.unlock", price: 99.99 }], expect: "value per download up" });
  const r = await train.maybeDecide(app);
  // Lifetime alone breaks the upgrade difference: rejected, nothing written.
  assert.match(r!.problems.join(), /must stay \$49\.99/);
  assert.equal(asc.writes.length, 0);
  assert.match(posts.at(-1)!.text, /broke the guards/);
  assert.match(prompts[0], /Products \(id \| name/);
  assert.match(prompts[0], /Individual Weekly/);

  store.deleteCursor(`pricing:${APP}:decided`);
  decide({ action: "change", reason: "Weekly converts well; test a higher price.", changes: [{ id: "s-week", price: 3.49 }], expect: "value per download up" });
  await train.maybeDecide(app);
  assert.equal(asc.writes.length, 1);
  assert.ok(asc.writes[0].includes("--preserved"));
  assert.equal(asc.writes[0][asc.writes[0].indexOf("--start-date") + 1], "2026-12-29");
  const h = train.history(app);
  assert.deepEqual(h.map(x => [x.by, x.liveDay, x.changes[0].from, x.changes[0].to]), [["isobot", "2026-12-29", 2.99, 3.49]]);
  assert.match(posts.at(-1)!.text, /Individual Weekly: \$2\.99 → \*\*\$3\.49\*\*/);
  assert.deepEqual(posts.at(-1)!.reactions, [STOP]);
  assert.equal(issues.length, 1);
  assert.match(issues[0].body, /Individual Weekly .*\$3\.49/);
  assert.deepEqual(issues[0].labels, ["isobot:ready", "isobot:auto"]);
  assert.equal(train.decisionDue(app), "decided 2026-12-28");
});

test("an App Store subscription change waiting for its start date isn't taken for an outside change", async () => {
  const { train, app, store, asc, at, decide } = setup();
  await train.snapshot(app);
  at("2026-12-28T10:00:00");
  decide(change(["s-week", 3.49]));
  await train.maybeDecide(app, true);
  // Apple still shows the old price until the start date.
  asc.subs[0].price = 2.99;
  await train.snapshot(app);
  assert.equal(train.history(app).length, 1);
  assert.equal(train.products(app).find(p => p.id === "s-week")!.price, 3.49);
  asc.subs[0].price = 3.49;
  at("2026-12-29T10:00:00");
  store.deleteCursor(`pricing:${APP}:snapshot`);
  await train.snapshot(app);
  assert.equal(train.history(app).length, 1);
  assert.equal(train.products(app).find(p => p.id === "s-week")!.since, "2026-12-29");
});

test("an owner's 🛑 undoes a change; a stranger's doesn't", async () => {
  const { train, app, asc, posts, reactions, at, decide } = setup();
  await train.snapshot(app);
  at("2026-12-28T10:00:00");
  decide(change(["i-life", 99.99], ["i-fam", 149.99]));
  await train.maybeDecide(app, true);
  assert.equal(asc.writes.length, 2);
  const ref = train.history(app)[0].ref!;
  reactions.set(`${ref.messageId}${STOP}`, ["stranger"]);
  await train.reactions(app);
  assert.equal(asc.writes.length, 2);
  reactions.set(`${ref.messageId}${STOP}`, ["owner"]);
  await train.reactions(app);
  assert.equal(asc.writes.length, 4);
  assert.deepEqual(asc.iaps.slice(0, 2).map(i => i.price), [79.99, 129.99]);
  const h = train.history(app);
  assert.deepEqual(h.map(x => x.by), ["isobot", "revert"]);
  assert.equal(h[0].reverted?.by, "owner");
  assert.match(posts.at(-1)!.text, /restored/);
  // Nothing left to undo by reaction.
  await train.reactions(app);
  assert.equal(asc.writes.length, 4);
});

test("evaluate: judged after minDays of data; a clear loss is undone on its own", async () => {
  const { train, app, store, asc, posts, at, decide } = setup();
  await train.snapshot(app);
  // Before: a lifetime sale every other day; after the change, one a week.
  seed(store, "2026-11-28", 32, { downloads: 10, lifetimeEvery: 2, lifetime: 68 });
  at("2026-12-28T10:00:00");
  decide(change(["i-life", 99.99], ["i-fam", 149.99]));
  await train.maybeDecide(app, true);
  const live = train.history(app)[0].liveDay;
  assert.equal(live, "2026-12-29");
  seed(store, live, 20, { downloads: 10, lifetimeEvery: 7, lifetime: 85 });
  at("2027-01-20T10:00:00");
  assert.equal(await train.evaluate(app), null, "not 28 days of data yet");
  assert.equal(train.decisionDue(app), "the last change is still being measured");
  seed(store, live, 36, { downloads: 10, lifetimeEvery: 7, lifetime: 85 });
  at("2027-02-01T10:00:00");
  const o = await train.evaluate(app);
  assert.equal(o?.verdict, "worse");
  assert.deepEqual([o!.after.from, o!.after.to], ["2026-12-29", "2027-01-25"]);
  assert.deepEqual([o!.before.from, o!.before.to], ["2026-12-01", "2026-12-28"]);
  assert.match(posts.find(p => p.text.startsWith("📏"))!.text, /Undoing it/);
  assert.deepEqual(asc.iaps.slice(0, 2).map(i => i.price), [79.99, 129.99]);
  assert.deepEqual(train.history(app).map(x => x.by), ["isobot", "revert"]);
  assert.equal(train.history(app)[0].reverted?.by, "runner");
});

test("evaluate waits for minDownloads, up to maxDays", async () => {
  const { train, app, store, at, decide } = setup();
  await train.snapshot(app);
  seed(store, "2026-11-28", 32, { downloads: 2 });
  at("2026-12-28T10:00:00");
  decide(change(["s-week", 3.49]));
  await train.maybeDecide(app, true);
  seed(store, "2026-12-29", 40, { downloads: 2 });
  at("2027-02-10T10:00:00");
  assert.equal(await train.evaluate(app), null, "56 downloads of 150 and maxDays not reached");
  seed(store, "2026-12-29", 70, { downloads: 2 });
  at("2027-03-10T10:00:00");
  const o = await train.evaluate(app);
  assert.equal(o?.after.days, 56);
});

test("propose: ✅ applies a proposal, 🛑 dismisses it", async () => {
  const { train, app, asc, posts, reactions, at, decide } = setup({ autonomy: "propose" });
  await train.snapshot(app);
  at("2026-12-28T10:00:00");
  decide(change(["s-week", 3.49]));
  await train.maybeDecide(app);
  assert.equal(asc.writes.length, 0);
  assert.deepEqual(posts.at(-1)!.reactions, ["✅", STOP]);
  assert.equal(train.decisionDue(app), "a proposal is waiting for ✅");
  const ref = train.pending(app)!.ref!;
  reactions.set(`${ref.messageId}✅`, ["owner"]);
  await train.reactions(app);
  assert.equal(asc.writes.length, 1);
  assert.equal(train.pending(app)!.state, "applied");
});

test("a failed write is reported and nothing is recorded", async () => {
  const { train, app, asc, at, decide } = setup();
  await train.snapshot(app);
  at("2026-12-28T10:00:00");
  asc.fail = "equalize: no price point found for USA 3.47";
  decide(change(["s-week", 3.47]));
  await assert.rejects(train.maybeDecide(app, true), /no price point/);
  assert.equal(train.history(app).length, 0);
});

test("Play: converted regional prices go onto the base plan and are read back", async () => {
  const calls: { method: string; url: string; body?: unknown }[] = [];
  let usPrice = { currencyCode: "USD", units: "2", nanos: 990000000 };
  const sub = () => ({ productId: "sub", basePlans: [{ basePlanId: "weekly", state: "ACTIVE", autoRenewingBasePlanType: { billingPeriodDuration: "P1W" },
    regionalConfigs: [{ regionCode: "US", price: usPrice, newSubscriberAvailability: true }, { regionCode: "DE", price: { currencyCode: "EUR", units: "2", nanos: 990000000 } }],
    otherRegionsConfig: { usdPrice: { currencyCode: "USD", units: "2" }, eurPrice: { currencyCode: "EUR", units: "2" }, newSubscriberAvailability: true } }] });
  const google = {
    json: async (_s: string, url: string, init: { method?: string; body?: unknown } = {}) => {
      const method = init.method ?? "GET";
      calls.push({ method, url, body: init.body });
      if (url.endsWith("/pricing:convertRegionPrices")) return { convertedRegionPrices: { US: { regionCode: "US", price: { currencyCode: "USD", units: "3", nanos: 490000000 } }, DE: { regionCode: "DE", price: { currencyCode: "EUR", units: "3", nanos: 490000000 } } }, convertedOtherRegionsPrice: { usdPrice: { currencyCode: "USD", units: "3" }, eurPrice: { currencyCode: "EUR", units: "3" } } };
      if (url.endsWith("/subscriptions") && method === "GET") return { subscriptions: [sub()] };
      if (url.endsWith("/oneTimeProducts")) return { oneTimeProducts: [] };
      if (url.endsWith("/subscriptions/sub") && method === "GET") return sub();
      if (url.includes("/subscriptions/sub?") && method === "PATCH") { usPrice = (init.body as ReturnType<typeof sub>).basePlans[0].regionalConfigs[0].price as typeof usPrice; return init.body; }
      throw new Error(`unexpected ${method} ${url}`);
    },
  };
  const config = { ...testConfig(), pricing: {} } as RunnerConfig;
  config.repos = { "owner/app": { aso: { appId: APP, play: { packageName: PKG } }, pricing: { autonomy: "apply" } } as RunnerConfig["repos"][string] };
  const train = new PricingTrain({
    config, store: new Store(":memory:"), google, now: () => new Date("2026-12-28T10:00:00"),
    github: { defaultBranch: async () => "main", createIssue: async () => ({}) as never },
    notifier: { discord: async () => null }, repo: () => ({}) as never, agent: async () => ({ output: null }),
  });
  const app = train.apps().find(a => a.market === "play")!;
  await train.snapshot(app);
  await train.apply(app, { changes: [{ id: "sub/weekly", price: 3.49 }] });
  const patch = calls.find(c => c.method === "PATCH")!;
  assert.match(patch.url, /updateMask=basePlans&regionsVersion\.version=2022%2F02/);
  const plan = (patch.body as ReturnType<typeof sub>).basePlans[0];
  assert.deepEqual(plan.regionalConfigs.map(r => `${r.regionCode} ${r.price.units}.${r.price.nanos}`), ["US 3.490000000", "DE 3.490000000"]);
  assert.equal(plan.regionalConfigs[0].newSubscriberAvailability, true);
  assert.equal(plan.otherRegionsConfig.usdPrice.units, "3");
  assert.equal(train.history(app)[0].changes[0].to, 3.49);
});

test("config: pricing needs the runner-wide block and an app", () => {
  const base = () => ({ ...testConfig(), pricing: {} }) as RunnerConfig;
  const c = base();
  c.repos = { "owner/app": { pricing: { autonomy: "apply" } } as RunnerConfig["repos"][string] };
  assert.throws(() => validateConfig(c), /App Store app id or a Play package/);
  const d = base();
  delete (d as { pricing?: unknown }).pricing;
  d.repos = { "owner/app": { aso: undefined, pricing: { appId: "123456" } } as unknown as RunnerConfig["repos"][string] };
  assert.throws(() => validateConfig(d), /runner-wide pricing/);
  const e = base();
  e.pricing = { maxStep: 2 };
  assert.throws(() => validateConfig(e), /maxStep/);
});

test("a change that only partly writes is put back and not recorded", async () => {
  const { train, app, asc, at } = setup();
  await train.snapshot(app);
  at("2026-12-28T10:00:00");
  // 109.99 is a price point, 159.99 + 0.01 isn't.
  await assert.rejects(train.apply(app, { changes: [{ id: "i-life", price: 109.99 }, { id: "i-fam", price: 160 }] }), /not applied: .*isn't an App Store price point; put back Unlock Full Access/);
  assert.deepEqual(asc.iaps.slice(0, 2).map(i => i.price), [79.99, 129.99]);
  assert.equal(train.history(app).length, 0);
});
