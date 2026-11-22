import assert from "node:assert/strict";
import { test } from "node:test";
import type { DaySnapshot } from "./aso.js";
import { buildMetrics, phraseRanks, rankDay, stateOn } from "./metrics.js";
import { Store } from "./store.js";
import { testConfig } from "./testing.js";

const NOW = new Date(2026, 10, 21, 12);

function setup() {
  const config = testConfig();
  for (const policy of Object.values(config.repos)) { delete policy.content; delete policy.aso; }
  config.appStore = { apps: { "111": "o/app" }, countries: ["us"] };
  config.aso = { cli: "aso" };
  config.repos["o/app"] = {
    autonomy: "pr", checks: [],
    aso: { appId: "111", play: { packageName: "com.o.app" } },
    content: { site: "app.example", openseoProjectId: "p", perDay: 1, allowedPaths: ["site/**"], checks: [], notes: "" },
  };
  return { config, store: new Store(":memory:") };
}

test("rank days carry each phrase's newest reading, on the app's storefront", () => {
  const snaps: { day: string; value: DaySnapshot }[] = [
    { day: "2026-11-10", value: { "us|old": [5, 10] } },
    { day: "2026-11-19", value: { "us|a": [3, 50], "us|b": [null, 20], "de|c": [1, 5] } },
    { day: "2026-11-20", value: { "us|a": [2, 50] } },
  ];
  const state = stateOn(snaps, "2026-11-20");
  assert.deepEqual(Object.keys(state).sort(), ["de|c", "us|a", "us|b"], "a reading older than a week drops out");
  assert.deepEqual(state["us|a"], [2, 50]);
  assert.deepEqual(rankDay("2026-11-20", state, "us"), { day: "2026-11-20", tracked: 2, ranked: 1, top10: 1, top3: 1, median: 2 });
});

test("phrases compare with the readings a week and four weeks back", () => {
  const snaps: { day: string; value: DaySnapshot }[] = [
    { day: "2026-10-20", value: { "us|a": [40, 50] } },
    { day: "2026-11-13", value: { "us|a": [12, 50], "us|b": [null, 9] } },
    { day: "2026-11-20", value: { "us|a": [4, 50], "us|b": [30, 9], "us|new": [null, 1] } },
  ];
  const { phrases, compare } = phraseRanks(snaps);
  assert.deepEqual(compare, { d7: "2026-11-13", d28: "2026-10-23", latest: "2026-11-20" });
  assert.deepEqual(phrases, [
    { text: "a", storefront: "us", rank: 4, volume: 50, was7: 12, was28: 40 },
    { text: "b", storefront: "us", rank: 30, volume: 9, was7: null },
    { text: "new", storefront: "us", rank: null, volume: 1 },
  ]);
});

test("metrics read the analytics, Play, ASO and content cursors into series", () => {
  const { config, store } = setup();
  store.setCursor("analytics:111:name", "App");
  store.setCursor("analytics:111:day:2026-11-19", JSON.stringify({ src: {}, m: { impressions: 100, firstDownloads: 5, proceeds: 1.234, subEvents: { "Offer start": 2, "Paid subscription from offer": 1, "Paid subscription": 1, Renewal: 4 } } }));
  store.setCursor("analytics:111:day:2026-01-01", JSON.stringify({ src: {}, m: { impressions: 1 } }));
  store.setCursor("playstats:com.o.app:day:2026-11-19", JSON.stringify({ visitors: 30, acquisitions: 3, charged: { USD: 5 } }));
  store.setCursor("aso:111:day:2026-11-20", JSON.stringify({ "us|a": [4, 50] }));
  store.setCursor("aso:111:history", JSON.stringify([{ at: "2026-11-20T10:00:00Z", fields: ["subtitle"], draft: {}, version: "3.6" }]));
  const job = store.enqueue("o", "app", 7, "Export guide", "content")!;
  store.update(job.id, { prNumber: 8 });
  store.setCursor(`content:published:${job.id}`, "2026-11-19T10:00:00.000Z");
  const dropped = store.enqueue("o", "app", 9, "Never shipped", "content")!;
  store.setCursor(`content:published:${dropped.id}`, "not live");
  store.setCursor("content:o/app:search:2026-11-16", JSON.stringify({ last7: { clicks: 4, impressions: 90, ctr: 0.04, position: 20 }, previous7: null }));
  store.setCursor("content:credits:2026-11-20", "120");
  store.setCursor("content:credits:balance", "900");

  const m = buildMetrics(config, store, NOW);
  const ios = m.apps.find(a => a.store === "appstore")!;
  assert.equal(ios.name, "App");
  assert.deepEqual(ios.funnel, [{ day: "2026-11-19", v: { impressions: 100, firstDownloads: 5, proceeds: 1.23, trials: 2, paidStarts: 2 } }], "older than the window is left out");
  assert.deepEqual(ios.ranks, [{ day: "2026-11-20", tracked: 1, ranked: 1, top10: 1, top3: 0, median: 4 }]);
  assert.deepEqual(ios.changes, [{ at: "2026-11-20T10:00:00Z", fields: ["subtitle"], version: "3.6" }]);
  const play = m.apps.find(a => a.store === "play")!;
  assert.equal(play.name, "App", "named like its App Store twin");
  assert.deepEqual(play.funnel, [{ day: "2026-11-19", v: { visitors: 30, acquisitions: 3 } }]);
  assert.deepEqual(m.sites, [{
    repo: "o/app", site: "app.example",
    published: [{ at: "2026-11-19T10:00:00.000Z", number: 7, title: "Export guide", prNumber: 8 }],
    search: [{ day: "2026-11-16", last7: { clicks: 4, impressions: 90, ctr: 0.04, position: 20 }, previous7: null }],
  }]);
  assert.deepEqual(m.credits, { days: [{ day: "2026-11-20", spent: 120 }], balance: 900 });
});
