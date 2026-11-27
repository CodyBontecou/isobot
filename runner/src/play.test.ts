import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { deflateRawSync } from "node:zlib";
import { asoApps, validateConfig } from "./config.js";
import { AsoTrain, reportText, type AsoClient } from "./aso.js";
import { GoogleAuth, PlayPublisher, type Fetch, type PlayListing } from "./google.js";
import { parsePlayProposal, promoProblems, stuffedWords } from "./play.js";
import { decodeReport, parseCsv, parseInstalls, parseRatings, parseSales, parseStorePerformance, parseSubscriptions, PlayAnalytics, playRatings, playSales, playWeekText, ratingsText, unzip } from "./playAnalytics.js";
import { formatCheckIn, type NeedsMe } from "./chatTools.js";
import { buildMetrics } from "./metrics.js";
import { beforeAfterText } from "./analytics.js";
import { Store } from "./store.js";
import { FakeGitHub, FakeRepo, testConfig } from "./testing.js";

const LIVE: PlayListing = {
  title: "Vox.md - Quick Capture Notes",
  shortDescription: "Capture voice notes and save them as Markdown.",
  fullDescription: "Vox.md turns your voice into Markdown notes.\n\nRecord, transcribe on device, and save to a folder you choose.",
};

test("parsePlayProposal keeps Play's limits, the brand and its metadata policy, field by field", () => {
  const ok = parsePlayProposal({ action: "propose", reason: "", rationale: "r", title: "Vox.md - Voice to Markdown", shortDescription: "Record voice notes and save them as Markdown files.", fullDescription: LIVE.fullDescription, newPhrases: [{ text: " Voice Notes ", concept: "voice" }, { text: "voice notes", concept: "dup" }] }, LIVE);
  assert.equal(ok.action, "propose");
  assert.equal(ok.title, "Vox.md - Voice to Markdown");
  assert.deepEqual(ok.newPhrases, [{ text: "voice notes", concept: "voice" }]);
  assert.deepEqual(ok.dropped, []);

  const bad = parsePlayProposal({
    action: "propose", rationale: "", reason: "",
    title: "Best Voice Notes App Ever!!", // drops the brand, "best"
    shortDescription: "The #1 FREE voice recorder for Obsidian", // ranking claim, price word, new brand
    fullDescription: "x".repeat(4001),
    newPhrases: [],
  }, LIVE);
  assert.equal(bad.action, "skip", "every field fell back, so nothing is left to propose");
  assert.equal(bad.title, LIVE.title);
  assert.equal(bad.shortDescription, LIVE.shortDescription);
  assert.equal(bad.fullDescription, LIVE.fullDescription);
  assert.match(bad.dropped.join("\n"), /Title kept: Play's metadata policy forbids "best"/);
  assert.match(bad.dropped.join("\n"), /Short description kept: it adds other companies' names \(obsidian\)/);
  assert.match(bad.dropped.join("\n"), /Full description kept: 4001 characters, over Play's 4000/);
  assert.match(bad.reason, /every change was dropped/);

  const noBrand = parsePlayProposal({ action: "propose", title: "Voice Notes to Markdown", shortDescription: LIVE.shortDescription, fullDescription: LIVE.fullDescription, newPhrases: [] }, LIVE);
  assert.match(noBrand.dropped[0], /drops the brand "Vox\.md"/);
});

test("promotional words, emoji, shouting and keyword stuffing are caught", () => {
  assert.deepEqual(promoProblems("Vox.md - Voice Notes"), []);
  assert.ok(promoProblems("Top voice app 🎙️").length >= 2);
  assert.match(promoProblems("Vox.md AMAZING notes").join(), /all-caps/);
  const stuffed = `${"voice notes markdown recorder ".repeat(14)}${"one two three four five six seven eight nine ten ".repeat(2)}`;
  assert.deepEqual(stuffedWords(stuffed, "Vox.md").slice(0, 2).sort(), ["notes", "voice"]);
  assert.deepEqual(stuffedWords(LIVE.fullDescription, "Vox.md"), []);
  const draft = parsePlayProposal({ action: "propose", title: LIVE.title, shortDescription: LIVE.shortDescription, fullDescription: stuffed, newPhrases: [] }, LIVE);
  assert.match(draft.dropped.join(), /keyword stuffing/);
});

test("config: a Play app is a second app of the train, named by its package", () => {
  assert.equal(asoApps(testConfig()).filter(a => a.store === "play").length, 4, "the runner config follows the four Play apps");
  const config = testConfig();
  const key = Object.keys(config.repos).find(k => config.repos[k].aso)!;
  const playOf = () => asoApps(config).find(a => a.store === "play" && `${a.owner}/${a.repo}` === key);
  config.repos[key].aso!.play = { packageName: "com.example.notes" };
  validateConfig(config);
  const play = playOf()!;
  assert.equal(play.aso.appId, "com.example.notes");
  assert.equal(play.aso.locale, "en-US");
  assert.equal(play.aso.autonomy, config.repos[key].aso!.autonomy ?? "propose");
  config.repos[key].aso!.play = { packageName: "not a package" };
  assert.throws(() => validateConfig(config), /aso.play.packageName must be a Play package name/);
  config.repos[key].aso!.play = { packageName: "com.example.notes", autonomy: "off" };
  assert.equal(playOf(), undefined, "a Play app can be off on its own");
  assert.ok(asoApps(config).some(a => a.store === "appstore" && `${a.owner}/${a.repo}` === key), "its App Store app stays");
});

/** Google's APIs as fetch sees them: a token endpoint, Android Publisher edits, and a Cloud Storage bucket. */
class FakeGoogle {
  calls: { method: string; url: string; body?: unknown }[] = [];
  live: Record<string, PlayListing> = { "en-US": { ...LIVE } };
  managedPublishing = false;
  commitError: string | null = null;
  bucketStatus = 200;
  objects: Record<string, { generation: string; data: Buffer }> = {};
  private edits = new Map<string, Partial<PlayListing>>();
  fetch: Fetch = async (url, init = {}) => {
    const method = init.method ?? "GET";
    const body = init.body && init.headers?.["content-type"] === "application/json" ? JSON.parse(init.body) : undefined;
    this.calls.push({ method, url, body });
    const reply = (status: number, value: unknown) => ({
      ok: status < 300, status,
      text: async () => typeof value === "string" ? value : JSON.stringify(value),
      arrayBuffer: async () => { const b = value as Buffer; return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer; },
    });
    if (url.includes("oauth2")) return reply(200, { access_token: "tok", expires_in: 3600 });
    if (url.startsWith("https://storage.googleapis.com/")) {
      if (this.bucketStatus !== 200) return reply(this.bucketStatus, { error: { code: 403, message: "isobot-aso does not have storage.objects.list access" } });
      const prefix = new URL(url).searchParams.get("prefix");
      if (prefix !== null) return reply(200, { items: Object.entries(this.objects).filter(([n]) => n.startsWith(prefix)).map(([name, o]) => ({ name, generation: o.generation, updated: "" })) });
      const name = decodeURIComponent(new URL(url).pathname.split("/o/")[1]);
      return reply(200, this.objects[name].data);
    }
    const m = url.match(/applications\/([^/]+)\/edits(?:\/([^/:?]+))?(?:\/listings(?:\/([^/?]+))?)?(:commit)?/);
    if (!m) return reply(404, "no route");
    const [, , editId, language, commit] = m;
    if (!editId && method === "POST") { const id = `e${this.edits.size + 1}`; this.edits.set(id, {}); return reply(200, { id }); }
    if (method === "DELETE") { this.edits.delete(editId); return reply(204, ""); }
    if (commit) {
      if (this.commitError) return reply(400, { error: { message: this.commitError } });
      if (this.managedPublishing && !url.includes("changesNotSentForReview=true")) return reply(400, { error: { message: "Changes cannot be sent for review automatically. Please set the query parameter changesNotSentForReview to true." } });
      const patch = this.edits.get(editId)!;
      this.live["en-US"] = { ...this.live["en-US"], ...patch };
      this.edits.delete(editId);
      return reply(200, { id: editId });
    }
    if (method === "PATCH") { const { language: _l, ...fields } = body as Record<string, string>; this.edits.set(editId, { ...this.edits.get(editId), ...fields }); return reply(200, body); }
    if (!language) return reply(200, { listings: Object.entries(this.live).map(([lang, l]) => ({ language: lang, ...l })) });
    return reply(404, "no route");
  };
  writes() { return this.calls.filter(c => c.method !== "GET" && !c.url.includes("oauth2")).map(c => `${c.method} ${c.url.replace(/^.*\/applications\/[^/]+/, "").replace(/\?.*$/, "")}`); }
}

function keyFile(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const dir = mkdtempSync(path.join(tmpdir(), "isobot-google-"));
  const file = path.join(dir, "key.json");
  writeFileSync(file, JSON.stringify({ type: "service_account", client_email: "isobot-aso@x.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }), token_uri: "https://oauth2.googleapis.com/token" }));
  return file;
}
const KEY = keyFile();

test("Android Publisher: listings are read in a throwaway edit; an update patches only its fields, then commits", async () => {
  const google = new FakeGoogle();
  const play = new PlayPublisher(new GoogleAuth(KEY, google.fetch));
  assert.deepEqual((await play.listings("md.vox.android"))["en-US"], LIVE);
  assert.deepEqual(google.writes(), ["POST /edits", "DELETE /edits/e1"], "the read never commits");
  const token = google.calls.find(c => c.url.includes("oauth2"))!;
  assert.equal(google.calls.filter(c => c.url.includes("oauth2")).length, 1, "the token is cached");
  assert.ok(token);

  google.calls = [];
  assert.deepEqual(await play.update("md.vox.android", "en-US", { title: "Vox.md - Voice Notes" }), { notSentForReview: false });
  assert.deepEqual(google.writes(), ["POST /edits", "PATCH /edits/e1/listings/en-US", "POST /edits/e1:commit"]);
  assert.deepEqual(google.calls.find(c => c.method === "PATCH")!.body, { language: "en-US", title: "Vox.md - Voice Notes" });
  assert.equal(google.live["en-US"].title, "Vox.md - Voice Notes");
  assert.equal(google.live["en-US"].fullDescription, LIVE.fullDescription, "other fields stay");

  google.managedPublishing = true;
  assert.deepEqual(await play.update("md.vox.android", "en-US", { shortDescription: "New" }), { notSentForReview: true });

  google.managedPublishing = false;
  google.commitError = "This app has a release in review.";
  google.calls = [];
  await assert.rejects(play.update("md.vox.android", "en-US", { title: "x" }), /release in review/);
  assert.equal(google.writes().at(-1), "DELETE /edits/e1", "a failed edit is deleted");
});

const PLAY_PACKAGE = "md.vox.android";

class Tracker implements AsoClient {
  calls: { tool: string; args: Record<string, unknown> }[] = [];
  boards: Record<string, { concepts: { cells: Record<string, unknown>[] }[] }> = {
    "6758967337": { concepts: [{ cells: [
      { text: "voice notes", storefront: "us", rank: 8, depth: 200, volume: 70, difficulty: 50, inListing: true, checkedAt: "2026-11-22T07:00:00", error: null },
      { text: "markdown notes", storefront: "us", rank: 3, depth: 200, volume: 40, difficulty: 30, inListing: true, checkedAt: "2026-11-22T07:00:00", error: null },
      { text: "ملاحظات", storefront: "us", rank: 9, depth: 200, volume: 90, difficulty: 30, inListing: false, checkedAt: "2026-11-22T07:00:00", error: null },
    ] }] },
    [PLAY_PACKAGE]: { concepts: [] },
  };
  async call(tool: string, args: Record<string, unknown>) {
    this.calls.push({ tool, args });
    if (tool === "board_get") return this.boards[String(args.appId)];
    if (tool === "keywords_import") {
      const cells = (args.concepts as { phrases: { text: string; storefront: string }[] }[]).flatMap(c => c.phrases)
        .map((p, i) => ({ text: p.text, storefront: p.storefront, rank: i === 0 ? 12 : null, depth: 25, volume: null, difficulty: null, inListing: false, checkedAt: "2026-11-23T09:00:00", error: null }));
      this.boards[String(args.appId)].concepts.push({ cells });
    }
    return { ok: true };
  }
}

function playSetup(autonomy: "apply" | "propose" = "apply") {
  const config = testConfig();
  for (const policy of Object.values(config.repos)) delete policy.aso;
  config.aso = { cli: "/x/aso", reportWeekday: 1, researchEveryDays: 7, hours: [8, 22] };
  config.repos["codybontecou/vox.md"] = { ...config.repos["codybontecou/vox.md"], aso: { appId: "6758967337", autonomy: "report", play: { packageName: PLAY_PACKAGE, autonomy } } };
  const store = new Store(":memory:");
  const google = new FakeGoogle();
  const tracker = new Tracker();
  const posts: string[] = [];
  const prompts: string[] = [];
  let output: unknown = {
    action: "propose", reason: "", rationale: "Title carries the phrase people search.",
    title: "Vox.md - Voice to Markdown", shortDescription: LIVE.shortDescription, fullDescription: LIVE.fullDescription,
    newPhrases: [{ text: "voice to text notes", concept: "transcription" }],
  };
  const train = new AsoTrain({
    config, store, github: new FakeGitHub() as never, tracker, repo: () => new FakeRepo(),
    notifier: { discord: async (text: string) => { posts.push(text); return { channelId: "staff", messageId: `m${posts.length}` }; } },
    play: new PlayPublisher(new GoogleAuth(KEY, google.fetch)),
    agent: async input => { prompts.push(input.prompt); return { output }; },
    now: () => new Date("2026-11-24T09:00:00"),
  });
  const app = asoApps(config).find(a => a.store === "play")!;
  return { train, app, google, tracker, posts, prompts, store, setOutput: (o: unknown) => { output = o; } };
}

test("Play research seeds phrases from the App Store app, drafts the listing, and applies it on its own", async () => {
  const { train, app, google, tracker, posts, prompts, store } = playSetup();
  assert.equal(app.aso.appId, PLAY_PACKAGE);
  const result = await train.maybeResearch(app, true);
  assert.ok(result);
  const imports = tracker.calls.filter(c => c.tool === "keywords_import");
  assert.deepEqual((imports[0].args.concepts as { phrases: { text: string }[] }[])[0].phrases.map(p => p.text), ["voice notes", "markdown notes"], "seeded by App Store demand, non-Latin-script noise left out");
  assert.equal(imports[0].args.appId, PLAY_PACKAGE);
  assert.match(prompts[0], /2 were just seeded from the App Store app's phrases/);
  assert.match(prompts[0], /voice notes \| #12 \| 25 \| 70/, "Play rank, results shown, App Store demand");
  assert.match(posts[0], /Google Play listing proposal \(en-US\)/);
  assert.match(posts[0], /\*\*Title\*\* \(32\/30\)|\*\*Title\*\* \(\d+\/30\)/);
  assert.match(posts[0], /`voice to text notes` #12 of 25/);
  assert.equal(google.live["en-US"].title, "Vox.md - Voice to Markdown", "committed on its own");
  assert.match(posts.at(-1)!, /listing \(on its own\): the new title went to Google's review/);
  const history = JSON.parse(store.cursor(`aso:${PLAY_PACKAGE}:history`)!);
  assert.deepEqual(history[0].fields, ["title"]);
  // The next research reads what it did.
  await train.maybeResearch(app, true);
  assert.match(prompts[1], /Play listing changes isobot made/);
  assert.match(prompts[1], /title/);
  assert.equal(tracker.calls.filter(c => c.tool === "keywords_import" && (c.args.concepts as { label: string }[])[0].label === "From the App Store").length, 1, "seeding happens once");
});

test("a Play apply leaves fields someone changed in Play Console alone, and a failed commit is reported once and retried", async () => {
  const { train, app, google, posts, setOutput } = playSetup("propose");
  setOutput({ action: "propose", title: "Vox.md - Voice to Markdown", shortDescription: "Record voice notes, get Markdown files.", fullDescription: LIVE.fullDescription, newPhrases: [], rationale: "", reason: "" });
  await train.maybeResearch(app, true);
  assert.match(posts.at(-1)!, /React ✅ to send it to Google's review/);
  google.live["en-US"].shortDescription = "Edited by hand in Play Console.";
  google.commitError = "This app has a release in review.";
  await assert.rejects(train.approve(app, "cli"), /release in review/);
  await train.poll();
  assert.equal(posts.filter(p => p.startsWith("❌")).length, 1, "reported once while it keeps failing");
  google.commitError = null;
  await train.poll();
  assert.equal(google.live["en-US"].title, "Vox.md - Voice to Markdown");
  assert.equal(google.live["en-US"].shortDescription, "Edited by hand in Play Console.", "the hand edit stays");
  assert.match(posts.at(-1)!, /Left alone, since they changed in Play Console after the draft: short description/);
  assert.equal(train.pending(app)!.state, "done");
});

test("the Play report says so in its header and handles Play's missing demand and shallow depth", () => {
  const text = reportText({
    app: "vox.md (Google Play)", today: "2026-11-23", baselineDay: null, movers: null, storefront: "us", store: "play",
    current: [{ text: "voice notes", storefront: "us", rank: 12, depth: 25, volume: null, difficulty: null, inListing: true, checkedAt: "2026-11-23T07:00:00", error: null },
      { text: "dictation", storefront: "us", rank: null, depth: 30, volume: null, difficulty: null, inListing: true, checkedAt: "2026-11-23T07:00:00", error: null }],
    analytics: "**Google Play analytics**: not available yet. it can't read the bucket (403).",
  });
  assert.match(text, /^📊 \*\*vox\.md \(Google Play\)\*\* Google Play search, week to 2026-11-23/);
  assert.match(text, /US: ranked for 1 of 2 tracked phrases/);
  assert.match(text, /at most about 30 apps/);
  assert.doesNotMatch(text, /top 200/);
  assert.match(text, /not available yet/);
});

const utf16 = (text: string) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
const INSTALLS = "Date,Package Name,Daily Device Installs,Daily Device Uninstalls,Daily Device Upgrades,Total User Installs,Daily User Installs,Daily User Uninstalls,Active Device Installs\n2026-11-01,md.vox.android,4,1,0,300,3,1,120\n2026-11-02,md.vox.android,6,0,0,306,5,0,124\n";
const STORE = "Date,Package name,Traffic source,Search term,UTM source,UTM campaign,Store listing acquisitions,Store listing visitors,Store listing conversion rate\n"
  + "2026-11-01,md.vox.android,Google Play search,voice notes,,,2,20,10%\n2026-11-01,md.vox.android,Google Play search,markdown,,,1,5,20%\n"
  + "2026-11-01,md.vox.android,Google Play explore,,,,1,15,6.7%\n2026-11-01,md.vox.android,\"Third-party referrals\",,web,\"site, footer\",0,4,0%\n";
const SALES = "Order Number,Order Charged Date,Order Charged Timestamp,Financial Status,Device Model,Product Title,Product ID,Product Type,SKU ID,Currency of Sale,Item Price,Taxes Collected,Charged Amount\n"
  + "GPA.1111-2222-3333-44444,2026-11-01,1,Charged,x,Vox.md Pro,md.vox.android,subscription,pro_yearly,USD,29.99,0,29.99\n"
  + "GPA.1111-2222-3333-44444..0,2026-11-01,1,Charged,x,Vox.md Pro,md.vox.android,subscription,pro_monthly,USD,3.99,0,3.99\n"
  + "GPA.5555-2222-3333-44444,2026-11-02,1,Refund,x,Vox.md Pro,md.vox.android,subscription,pro_yearly,USD,29.99,0,29.99\n"
  + "GPA.6666-2222-3333-44444,2026-11-02,1,Charged,x,Other,com.other.app,inapp,x,EUR,1.00,0,1.00\n";

/** A one-file zip, deflated, as Play writes its sales reports. */
function zipOf(name: string, data: Buffer): Buffer {
  const packed = deflateRawSync(data);
  const n = Buffer.from(name);
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(n.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10); central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(n.length, 28); central.writeUInt32LE(0, 42);
  const cdOffset = 30 + n.length + packed.length;
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(46 + n.length, 12); end.writeUInt32LE(cdOffset, 16);
  return Buffer.concat([local, n, packed, central, n, end]);
}

test("Play Console reports: UTF-16 CSV, columns found by name, sales from a zip", () => {
  assert.equal(decodeReport(utf16("a,b\n1,2")), "a,b\n1,2");
  assert.equal(decodeReport(Buffer.from("﻿a,b", "utf8")), "a,b");
  assert.deepEqual(parseCsv('x,"y, z","q ""w"""\n1,2,3\n'), [{ x: "1", "y, z": "2", 'q "w"': "3" }]);
  assert.deepEqual(parseInstalls(parseCsv(decodeReport(utf16(INSTALLS)))).get("2026-11-02"), { userInstalls: 5, userUninstalls: 0, activeDevices: 124 });
  assert.deepEqual(parseStorePerformance(parseCsv(decodeReport(utf16(STORE)))).get("2026-11-01"), { visitors: 44, acquisitions: 4, searchVisitors: 25, searchAcquisitions: 3 });
  const files = unzip(zipOf("salesreport_202611.csv", Buffer.from(SALES)));
  const sales = parseSales(parseCsv(decodeReport(files.get("salesreport_202611.csv")!)));
  assert.deepEqual(sales.get("md.vox.android")!.get("2026-11-01"), { orders: 2, newOrders: 1, subOrders: 2, charged: { USD: 33.98 }, net: { USD: 28.88 } });
  assert.deepEqual(sales.get("md.vox.android")!.get("2026-11-02"), { refunds: 1, net: { USD: -25.49 } });
  assert.ok(sales.has("com.other.app"));
});

// Play's current sales report: the package is in "Package ID", and a later "Featured Product ID" is usually empty.
const SALES_NOW = "Order Number,Order Charged Date,Order Charged Timestamp,Financial Status,Device Model,Product Title,Package ID,Product Type,SKU ID,Currency of Sale,Item Price,Taxes Collected,Charged Amount,Country of Buyer,Base Plan or Purchase Option ID,Offer ID,Group ID,First USD 1M Eligible,Promotion ID,Coupon Value,Discount Rate,Featured Product ID\n"
  + "GPA.3307-1,2026-11-01,1,Charged,m3q,Premium (Lifetime),com.healthmd.android,One-time product,health_md_premium_lifetime,USD,19.99,1.65,21.64,US,lifetime,,1,Yes,,,,\n"
  + "GPA.3352-2,2026-11-03,1,Charged,q8q,Premium (Lifetime),com.healthmd.android,One-time product,health_md_premium_lifetime,PLN,75.60,17.39,92.99,PL,lifetime,,1,Yes,,,,\n"
  + "GPA.3370-3..0,2026-11-23,1,Charged,,Health.md Yearly,com.healthmd.android,Subscription,health_md_premium_yearly,GBP,20.83,4.16,24.99,GB,yearly,trial-7d,1,Yes,,,,\n";
const SUBS = "Date,Package Name,Product ID,Country,Base Plan ID,Offer ID,New Subscriptions,Cancelled Subscriptions,Active Subscriptions\n"
  + "2026-11-13,com.healthmd.android,health_md_premium_yearly,MX,yearly,trial-7d,1,0,1\n"
  + "2026-11-25,com.healthmd.android,health_md_premium_yearly,US,yearly,trial-7d,1,0,2\n"
  + "2026-11-25,com.healthmd.android,health_md_premium_yearly,IN,yearly,,0,1,1\n";

test("Play sales: today's report names the package in Package ID, not Featured Product ID; proceeds net of tax and fee", () => {
  const sales = parseSales(parseCsv(SALES_NOW)).get("com.healthmd.android")!;
  assert.deepEqual(sales.get("2026-11-01"), { orders: 1, newOrders: 1, lifetimeOrders: 1, charged: { USD: 21.64 }, net: { USD: 16.99 } });
  assert.deepEqual(sales.get("2026-11-23"), { orders: 1, subOrders: 1, charged: { GBP: 24.99 }, net: { GBP: 17.71 } });
  const subs = parseSubscriptions(parseCsv(SUBS));
  assert.equal(subs.product, "health_md_premium_yearly");
  assert.deepEqual(subs.days.get("2026-11-25"), { active: 3, new: 1, cancelled: 1 });

  const days = [...sales].map(([day, m]) => ({ day, m }));
  days.push({ day: "2026-11-25", m: { subs: { health_md_premium_yearly: subs.days.get("2026-11-25")!, health_md_premium_weekly: { active: 2, new: 0, cancelled: 0 } } } });
  const money = playSales(days.sort((a, b) => a.day.localeCompare(b.day)), () => ({ GBP: 0.8, PLN: 4 }), "2026-11-26T23:00:00Z")!;
  assert.deepEqual(money.days.map(d => [d.day, d.proceeds]), [["2026-11-01", 16.99], ["2026-11-03", 16.07], ["2026-11-23", 22.14]]);
  assert.equal(money.through, "2026-11-23");
  assert.equal(money.approx, false);
  assert.deepEqual(money.subs, [{ day: "2026-11-25", active: 5, new: 1, cancelled: 1 }]);
  assert.deepEqual(money.products, [{ id: "health_md_premium_yearly", active: 3 }, { id: "health_md_premium_weekly", active: 2 }]);
});

test("Play analytics: subscription reports per product add up, and the sales and subscriptions reach the board", async () => {
  const google = new FakeGoogle();
  const store = new Store(":memory:");
  const now = new Date("2026-11-26T12:00:00");
  const pa = new PlayAnalytics({ store, auth: new GoogleAuth(KEY, google.fetch), bucket: "pubsite_prod_1", packages: () => ["com.healthmd.android"], now: () => now });
  google.objects["sales/salesreport_202611.zip"] = { generation: "1", data: zipOf("salesreport_202611.csv", Buffer.from(SALES_NOW)) };
  google.objects["financial-stats/subscriptions/subscriptions_com.healthmd.android_health_md_premium_yearly_202611_country.csv"] = { generation: "1", data: Buffer.from(SUBS) };
  google.objects["financial-stats/subscriptions/subscriptions_com.healthmd.android_health_md_premium_weekly_202611_country.csv"] = { generation: "1", data: Buffer.from(SUBS.replaceAll("yearly", "weekly")) };
  store.setCursor("fx:usd:2026-11-21", JSON.stringify({ GBP: 0.8, PLN: 4 }));
  await pa.tick();
  assert.equal(pa.status(), null);
  // A new yearly file restates only the yearly product.
  google.objects["financial-stats/subscriptions/subscriptions_com.healthmd.android_health_md_premium_yearly_202611_country.csv"] = { generation: "2", data: Buffer.from(SUBS.replace(",0,1,1", ",0,1,4")) };
  await pa.sync();
  assert.deepEqual(pa.days("com.healthmd.android", "2026-11-25", "2026-11-25")[0].m.subs, {
    health_md_premium_yearly: { active: 6, new: 1, cancelled: 1 },
    health_md_premium_weekly: { active: 3, new: 1, cancelled: 1 },
  });

  const config = testConfig();
  config.repos["codybontecou/vox.md"] = { ...config.repos["codybontecou/vox.md"], aso: { appId: "6758967337", autonomy: "report", play: { packageName: "com.healthmd.android" } } };
  const metrics = buildMetrics(config, store, now);
  assert.equal(metrics.checks?.play, now.toISOString(), "the board shows when Play was last read");
  const play = metrics.apps.find(a => a.store === "play" && a.id === "com.healthmd.android")!;
  assert.equal(play.playSales?.subs.at(-1)?.active, 9);
  assert.equal(play.playSales?.days.find(d => d.day === "2026-11-23")?.proceeds, 22.14);
});

test("Play analytics: a 403 is kept and shown, not thrown; readable reports make the weekly line", async () => {
  const google = new FakeGoogle();
  const store = new Store(":memory:");
  let now = new Date("2026-11-09T12:00:00");
  const pa = new PlayAnalytics({ store, auth: new GoogleAuth(KEY, google.fetch), bucket: "pubsite_prod_1", packages: () => ["md.vox.android"], now: () => now });
  google.bucketStatus = 403;
  await pa.tick();
  assert.match(pa.status()!, /can't read gs:\/\/pubsite_prod_1 yet \(403\)/);
  assert.match(pa.weekLine("md.vox.android")!, /Google Play analytics\*\*: not available yet/);
  await pa.tick();
  assert.equal(store.cursor("playstats:synced"), now.toISOString(), "waits an hour between passes");

  google.bucketStatus = 200;
  const rows = (from: number) => Array.from({ length: 7 }, (_, i) => `2026-11-${String(from + i).padStart(2, "0")}`);
  const store_ = "Date,Package name,Traffic source,Store listing acquisitions,Store listing visitors\n"
    + [...rows(1).map(d => `${d},md.vox.android,Google Play search,2,20`), ...rows(8).map(d => `${d},md.vox.android,Google Play search,3,20`)].join("\n");
  google.objects["stats/store_performance/store_performance_md.vox.android_202611_traffic_source.csv"] = { generation: "1", data: utf16(store_) };
  google.objects["stats/installs/installs_md.vox.android_202611_overview.csv"] = { generation: "1", data: utf16(INSTALLS) };
  google.objects["sales/salesreport_202611.zip"] = { generation: "1", data: zipOf("salesreport_202611.csv", Buffer.from(SALES)) };
  now = new Date("2026-11-15T12:00:00");
  await pa.tick();
  assert.equal(pa.status(), null);
  const line = pa.weekLine("md.vox.android")!;
  assert.match(line, /^\*\*Google Play analytics\*\* \(11-08–11-14, vs the 7 days before\)/);
  assert.match(line, /installs from the listing 21 \(\+50%\)/);
  assert.match(line, /visitor → install 15% \(was 10%\)/);
  assert.match(line, /from search 100% of visitors/);
  const read = google.calls.filter(c => c.url.includes("alt=media")).length;
  await pa.sync();
  assert.equal(google.calls.filter(c => c.url.includes("alt=media")).length, read, "unchanged files aren't downloaded again");
  assert.match(pa.changeLine("md.vox.android", "2026-11-08")!, /per day 2 → 3 installs.*inconclusive/);
});

test("the weekly Play line needs a whole week, and before/after calls thin samples inconclusive", () => {
  assert.equal(playWeekText([{ day: "2026-11-01", m: { visitors: 1 } }], []), null);
  assert.match(beforeAfterText({ visits: 700, installs: 140, paid: 7, days: 28 }, { visits: 700, installs: 210, paid: 14, days: 28 }), /^per day 5 → 7.5 installs, 25 → 25 page visits, conversion 20% → 30%, paid 0.3 → 0.5 \(28 days before, 28 after\)$/);
  assert.match(beforeAfterText({ visits: 70, installs: 10, paid: 0, days: 28 }, { visits: 70, installs: 12, paid: 0, days: 10 }), /inconclusive/);
});

const RATINGS = "Date,Package Name,Daily Average Rating,Total Average Rating\n"
  + ["2026-11-01,md.vox.android,0.0,3.8095", "2026-11-02,md.vox.android,5.0,3.913", "2026-11-03,md.vox.android,0.0,3.913",
    "2026-11-06,md.vox.android,1.0,3.75", "2026-11-07,md.vox.android,0.0,3.75"].join("\n");

test("Play ratings report: 0.0 is a day without ratings, and no count is made up", () => {
  const days = parseRatings(parseCsv(decodeReport(utf16(RATINGS))));
  assert.deepEqual(days.get("2026-11-02"), { ratingDaily: 5, ratingTotal: 3.913 });
  assert.deepEqual(parseRatings(parseCsv("Date,Daily Average Rating,Total Average Rating\n2026-11-01,0.0,0.0")).get("2026-11-01"), { ratingDaily: 0 }, "an overall 0 is no ratings yet");
  const r = playRatings([...days].map(([day, m]) => ({ day, m })))!;
  assert.deepEqual(r, { through: "2026-11-07", total: 3.75, ratedDays7: 2, ratedDays30: 2, latest: { day: "2026-11-06", average: 1 } });
  assert.equal(ratingsText(r), "overall 3.75★ (Play's report to 11-07); new ratings on 2 of the last 30 days, the latest 11-06 averaging 1★");
  assert.equal(playRatings([{ day: "2026-11-01", m: { visitors: 3 } }]), null);
  const week = Array.from({ length: 7 }, (_, i) => ({ day: `2026-11-0${i + 1}`, m: { visitors: 10, acquisitions: 1, ...(days.get(`2026-11-0${i + 1}`) ?? {}) } }));
  assert.match(playWeekText(week, [])!, /rating 3\.75★ overall, new ratings on 2 of the 5 days Play's ratings report covers$/);
});

test("Play ratings reach the check-in (a low day flags once) and the board's Play funnel", async () => {
  const google = new FakeGoogle();
  const store = new Store(":memory:");
  const now = new Date("2026-11-10T12:00:00");
  const pa = new PlayAnalytics({ store, auth: new GoogleAuth(KEY, google.fetch), bucket: "pubsite_prod_1", packages: () => ["md.vox.android", "com.other.app"], now: () => now });
  google.objects["stats/ratings/ratings_md.vox.android_202611_overview.csv"] = { generation: "1", data: utf16(RATINGS) };
  google.objects["stats/ratings/ratings_md.vox.android_202607_overview.csv"] = { generation: "1", data: utf16("Date,Daily Average Rating,Total Average Rating\n2026-07-01,4.0,4.0") };
  await pa.tick();
  assert.equal(pa.days("md.vox.android", "2026-07-01", "2026-07-31").length, 1, "reads ratings months back for the board");
  const first = pa.checkIn();
  assert.deepEqual(first.flags, ["⭐ md.vox.android: new Google Play ratings on 11-06 averaged 1★"]);
  assert.match(first.lines[0], /^\*\*md\.vox\.android\*\*: overall 3\.75★/);
  assert.match(first.lines[1], /com\.other\.app\*\*: no ratings report from Play yet/);
  assert.deepEqual(pa.checkIn().flags, [], "a low day is flagged once");

  const quiet: NeedsMe = { review: [], ship: [], failed: [], releaseFailed: [], proposals: [], runner: { paused: false, usageLimitPauseUntil: null, lastCycleError: null } };
  assert.equal(formatCheckIn(quiet, [], undefined, undefined, { lines: first.lines, flags: [] }), null, "rating lines alone don't post a check-in");
  const posted = formatCheckIn(quiet, [], undefined, undefined, first)!;
  assert.match(posted, /\*\*Google Play ratings\*\*\n⭐ md\.vox\.android.*\n- \*\*md\.vox\.android\*\*: overall 3\.75★/);

  const play = buildMetrics(testConfig(), store, now).apps.find(a => a.store === "play" && a.id === "md.vox.android")!;
  assert.deepEqual(play.funnel.find(d => d.day === "2026-11-02")?.v, { ratingDaily: 5, ratingTotal: 3.913 });
});
