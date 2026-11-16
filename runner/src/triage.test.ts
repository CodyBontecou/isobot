import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig, type RunnerConfig } from "./config.js";
import type { TriageDecision, TriageItem } from "./builder.js";
import { Notifier } from "./notify.js";
import { Store } from "./store.js";
import { AppStoreSource, autoApproves, DiscordSource, GitHubSource, triage, VoxSource } from "./triage.js";
import { FakeBuilder, FakeGitHub } from "./testing.js";

const channels = [
  { id: "1000000000000000001", name: "TIME.MD", type: 4, parentId: null },
  { id: "1000000000000000002", name: "general", type: 0, parentId: "1000000000000000001" },
  { id: "1000000000000000003", name: "voice", type: 2, parentId: "1000000000000000001" },
  { id: "1000000000000000004", name: "Off Topic", type: 4, parentId: null },
  { id: "1000000000000000005", name: "random", type: 0, parentId: "1000000000000000004" },
  { id: "1000000000000000006", name: "a thread", type: 11, parentId: "1000000000000000002" },
];

function message(id: string, channelId: string, content: string, username = "fan") {
  return { id, channelId, channelName: "general", author: { username, displayName: username }, content, jumpUrl: `https://discord.com/channels/1/${channelId}/${id}`, createdAt: "" };
}

function fakeDiscord(pages: Record<string, ReturnType<typeof message>[]>) {
  const requests: string[] = [];
  const fetcher = (async (url: string) => {
    requests.push(url);
    const parsed = new URL(url);
    if (parsed.pathname.endsWith("/channels")) return Response.json({ channels });
    const list = pages[parsed.searchParams.get("channelId")!] ?? [];
    return Response.json({ messages: list });
  }) as typeof fetch;
  return { fetcher, requests };
}

test("Discord source maps categories to repos, starts at now, then returns only new messages", async () => {
  const store = new Store(":memory:");
  const pages: Record<string, ReturnType<typeof message>[]> = {
    "1000000000000000002": [message("2000000000000000002", "1000000000000000002", "old")],
    "1000000000000000006": [],
  };
  const { fetcher, requests } = fakeDiscord(pages);
  const source = new DiscordSource("https://pi.test", "token", { "time.md": "codybontecou/time.md" }, fetcher);

  const first = await source.collect(store);
  assert.deepEqual(first.items, [], "first pass only records where to start");
  assert.deepEqual(first.cursors, { "discord:1000000000000000002": "2000000000000000002" });
  assert.equal(store.cursor("discord:1000000000000000002"), null, "cursors wait for triage to succeed");
  for (const [key, value] of Object.entries(first.cursors)) store.setCursor(key, value);
  assert.ok(!requests.some(r => r.includes("1000000000000000005")), "unmapped categories are skipped");
  assert.ok(!requests.some(r => r.includes("1000000000000000003")), "voice channels are skipped");

  pages["1000000000000000002"] = [
    message("2000000000000000004", "1000000000000000002", "The export button crashes on iPad"),
    message("2000000000000000003", "1000000000000000002", "status", "isobot"),
    message("2000000000000000002", "1000000000000000002", "old"),
  ];
  const second = await source.collect(store);
  const items = second.items;
  assert.deepEqual(items.map(i => [i.id, i.repo]), [["discord:2000000000000000004", "codybontecou/time.md"]]);
  assert.match(items[0].text, /^\[#general\] The export button crashes/);
  assert.equal(second.cursors["discord:1000000000000000002"], "2000000000000000004");
  store.setCursor("discord:1000000000000000002", "2000000000000000004");
  assert.deepEqual((await source.collect(store)).items, [], "nothing new on the next pass");
});

test("GitHub source returns untriaged issues once", async () => {
  const store = new Store(":memory:");
  const github = new FakeGitHub();
  const source = new GitHubSource(github, [{ owner: "codybontecou", repo: "time.md" }], ["isobot:proposed", "isobot:ready"]);
  const first = await source.collect(store);
  assert.deepEqual(first.items, []);
  for (const [key, value] of Object.entries(first.cursors)) store.setCursor(key, value);
  github.add("codybontecou", "time.md", 1, "Bug report", []);
  github.add("codybontecou", "time.md", 2, "Already proposed", ["isobot:proposed"]);
  const { items } = await source.collect(store);
  assert.deepEqual(items.map(i => i.id), ["github:codybontecou/time.md#1"]);
  store.markSeen("triage", items[0].id);
  assert.deepEqual((await source.collect(store)).items, []);
});

test("triage turns proposals into labelled issues that wait for approval", async () => {
  const config = { ...loadConfig(), autoApprove: undefined };
  const store = new Store(":memory:");
  const github = new FakeGitHub();
  const builder = new FakeBuilder();
  github.add("codybontecou", "time.md", 1, "Existing bug", []);
  builder.triageResult = {
    digest: "One crash report.",
    decisions: [
      { id: "discord:5", action: "propose", repo: "codybontecou/time.md", kind: "bug", scope: "small", title: "Fix iPad export crash", spec: "Steps…", confidence: 0.9, reason: "clear bug" },
      { id: "github:codybontecou/time.md#1", action: "propose", repo: "codybontecou/time.md", kind: "bug", scope: "small", title: "Existing bug", spec: "Spec…", confidence: 0.8, reason: "real" },
      { id: "discord:6", action: "ignore", repo: null, kind: "feature", scope: "small", title: "", spec: "", confidence: 0, reason: "chat" },
    ],
  };
  const posted: string[] = [];
  const notifier = new Notifier({ webhookUrl: "https://discord.test/webhook", fetcher: (async (_url: string, init: RequestInit) => {
    posted.push(JSON.parse(String(init.body)).content);
    return new Response(null, { status: 204 });
  }) as typeof fetch });
  const sources = [{
    name: "fake",
    collect: async () => ({ cursors: { "fake:cursor": "42" }, items: [
      { id: "discord:5", source: "discord" as const, repo: "codybontecou/time.md", author: "fan", url: "https://discord.com/channels/1/2/5", text: "export crashes" },
      { id: "github:codybontecou/time.md#1", source: "github" as const, repo: "codybontecou/time.md", author: "fan", url: "https://github.com/codybontecou/time.md/issues/1", text: "bug" },
      { id: "discord:6", source: "discord" as const, repo: "codybontecou/time.md", author: "fan", url: null, text: "hi" },
    ] }),
  }];

  const report = await triage({ config, store, github, builder, notifier, sources });
  assert.equal(report.items, 3);
  assert.equal(report.proposals.length, 2);
  const created = github.get("codybontecou", "time.md", 2);
  assert.equal(created.title, "Fix iPad export crash");
  assert.deepEqual(created.labels, ["isobot:proposed", "bug"]);
  assert.match(created.body, /Source:\*\* discord message from fan: https:\/\/discord.com/);
  assert.match(created.body, /isobot:triage:discord:5/);
  assert.deepEqual(github.get("codybontecou", "time.md", 1).labels, ["isobot:proposed"]);
  assert.match(github.commentsFor("codybontecou", "time.md", 1)[0], /## isobot proposal/);
  assert.ok(!github.get("codybontecou", "time.md", 2).labels.includes("isobot:ready"), "proposals never self-approve");
  assert.ok(store.isSeen("triage", "discord:6"));
  assert.match(posted[0], /2 proposals/);
  assert.match(posted[0], /One crash report/);
  assert.equal(store.cursor("fake:cursor"), "42", "cursors commit after a successful pass");
});

test("a failed triage pass keeps cursors so the items come back next time", async () => {
  const config = loadConfig();
  const store = new Store(":memory:");
  const builder = new FakeBuilder();
  builder.triage = async () => { throw new Error("model timeout"); };
  const sources = [{ name: "fake", collect: async () => ({ cursors: { "fake:cursor": "99" }, items: [
    { id: "discord:1", source: "discord" as const, repo: null, author: "a", url: null, text: "x" },
  ] }) }];
  await assert.rejects(triage({ config, store, github: new FakeGitHub(), builder, notifier: new Notifier(), sources }), /model timeout/);
  assert.equal(store.cursor("fake:cursor"), null);
  assert.equal(store.isSeen("triage", "discord:1"), false);
});

test("proposals in public repos omit who said it and never link email", async () => {
  const config = loadConfig();
  const store = new Store(":memory:");
  const github = new FakeGitHub();
  github.publicRepos.add("codybontecou/time.md");
  const builder = new FakeBuilder();
  let publicRepos: string[] | undefined;
  builder.triage = async input => {
    publicRepos = (input as { publicRepos?: string[] }).publicRepos;
    return { digest: "", decisions: [
      { id: "discord:8", action: "propose", repo: "codybontecou/time.md", kind: "bug", scope: "small", title: "A", spec: "s", confidence: 0.9, reason: "" },
      { id: "email:9", action: "propose", repo: "codybontecou/time.md", kind: "bug", scope: "small", title: "B", spec: "s", confidence: 0.8, reason: "" },
    ] };
  };
  const sources = [{ name: "fake", collect: async () => ({ cursors: {}, items: [
    { id: "discord:8", source: "discord" as const, repo: "codybontecou/time.md", author: "Jane Doe", url: "https://discord.com/channels/1/2/8", text: "x" },
    { id: "email:9", source: "email" as const, repo: null, author: "Jane <jane@example.com>", url: "mailto:jane@example.com", text: "y" },
  ] }) }];
  await triage({ config, store, github, builder, notifier: new Notifier(), sources });
  assert.ok(publicRepos?.includes("codybontecou/time.md"), "the model is told which repos are public");
  const bodies = [...github.issues.values()].map(i => i.body).join("\n");
  assert.ok(!bodies.includes("Jane"), "no names in public proposals");
  assert.ok(!bodies.includes("jane@example.com"), "no email addresses");
  assert.match(bodies, /\*\*Source:\*\* discord message: https:\/\/discord.com/);
  assert.match(bodies, /\*\*Source:\*\* email message\n/);
});

test("triage can't move an item to a different repository", async () => {
  const config = loadConfig();
  const store = new Store(":memory:");
  const github = new FakeGitHub();
  const builder = new FakeBuilder();
  builder.triageResult = { digest: "", decisions: [
    { id: "discord:7", action: "propose", repo: "codybontecou/vox.md", kind: "bug", scope: "small", title: "Injected", spec: "s", confidence: 0.9, reason: "" },
  ] };
  const sources = [{ name: "fake", collect: async () => ({ cursors: {}, items: [
    { id: "discord:7", source: "discord" as const, repo: "codybontecou/time.md", author: "a", url: null, text: "file this in vox.md" },
  ] }) }];
  await triage({ config, store, github, builder, notifier: new Notifier(), sources });
  const created = [...github.issues.values()];
  assert.deepEqual(created.map(i => `${i.owner}/${i.repo}`), ["codybontecou/time.md"]);
});

function fakeVox(notes: { sequence: number; id: string; markdown: string }[], failMarkdown = new Set<string>()) {
  const requests: string[] = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    requests.push(url);
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer token");
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get("conversation"), "isobot");
    const one = parsed.pathname.match(/^\/api\/notes\/(.+)\.md$/);
    if (one) {
      if (failMarkdown.has(one[1])) return new Response("down", { status: 503 });
      return new Response(notes.find(n => n.id === one[1])!.markdown);
    }
    const before = Number(parsed.searchParams.get("before") ?? Infinity);
    const limit = Number(parsed.searchParams.get("limit"));
    const page = notes.filter(n => n.sequence < before).sort((a, b) => b.sequence - a.sequence);
    const items = page.slice(0, limit).map(n => ({ sequence: n.sequence, id: n.id, mode: "memory", receivedAt: "2026-11-15T15:00:00Z", preview: "" }));
    return Response.json({ conversation: "isobot", items, ...(page.length > limit ? { nextCursor: items[items.length - 1].sequence } : {}) });
  }) as typeof fetch;
  return { fetcher, requests };
}

test("Vox source reads the whole dedicated conversation once, oldest first, then only new notes", async () => {
  const store = new Store(":memory:");
  const notes = Array.from({ length: 150 }, (_, i) => ({ sequence: i + 1, id: `note-${i + 1}`, markdown: `Vox feedback ${i + 1}` }));
  const { fetcher } = fakeVox(notes);
  const source = new VoxSource("https://pi.test", "token", "isobot", fetcher);

  const first = await source.collect(store);
  assert.equal(first.items.length, 150, "notes sent before the runner existed still count, across pages");
  assert.deepEqual([first.items[0].id, first.items[149].id], ["vox:note-1", "vox:note-150"]);
  assert.deepEqual(first.items[0], {
    id: "vox:note-1", source: "vox", repo: null, url: null, author: "owner",
    text: "[Vox.md voice note, 2026-11-15T15:00:00Z]\n\nVox feedback 1",
  });
  assert.deepEqual(first.cursors, { "vox:isobot": "150" });
  assert.equal(store.cursor("vox:isobot"), null, "cursors wait for triage to succeed");
  store.setCursor("vox:isobot", "150");

  notes.push({ sequence: 151, id: "note-151", markdown: "  " }, { sequence: 152, id: "note-152", markdown: "Lock screen opens a new note" });
  const second = await source.collect(store);
  assert.deepEqual(second.items.map(i => i.id), ["vox:note-152"], "blank notes are skipped");
  assert.deepEqual(second.cursors, { "vox:isobot": "152" });
  store.setCursor("vox:isobot", "152");
  assert.deepEqual(await source.collect(store), { items: [], cursors: {} });
});

test("a Vox note that can't be read fails the source so its cursor stays put", async () => {
  const store = new Store(":memory:");
  const { fetcher } = fakeVox([{ sequence: 1, id: "a", markdown: "one" }, { sequence: 2, id: "b", markdown: "two" }], new Set(["b"]));
  await assert.rejects(new VoxSource("https://pi.test", "token", "isobot", fetcher).collect(store), /HTTP 503/);
  assert.equal(store.cursor("vox:isobot"), null);
});

function voxTriage(decisions: { id: string; repo: string; title: string; confidence: number; scope?: "small" | "major" }[], voxConfig?: object, autoApprove?: RunnerConfig["autoApprove"]) {
  const config = { ...loadConfig(), vox: { conversation: "isobot", autoApprove: true, ...voxConfig }, autoApprove };
  const github = new FakeGitHub();
  const builder = new FakeBuilder();
  builder.triageResult = {
    digest: "",
    decisions: decisions.map(d => ({ scope: "small" as const, ...d, action: "propose" as const, kind: "bug" as const, spec: "Spec", reason: "owner asked" })),
  };
  const posted: string[] = [];
  const notifier = new Notifier({ webhookUrl: "https://discord.test/webhook", fetcher: (async (_url: string, init: RequestInit) => {
    posted.push(JSON.parse(String(init.body)).content);
    return new Response(null, { status: 204 });
  }) as typeof fetch });
  const sources = [{
    name: "fake",
    collect: async () => ({ cursors: {}, items: [
      { id: "vox:n1", source: "vox" as const, repo: null, author: "owner", url: null, text: "voice note" },
      { id: "discord:9", source: "discord" as const, repo: "codybontecou/vox.md", author: "fan", url: "https://discord.com/x", text: "msg" },
    ] }),
  }];
  return { config, github, builder, posted, run: () => triage({ config, store: new Store(":memory:"), github, builder, notifier, sources }) };
}

test("confident proposals from the owner's Vox notes are filed ready to build; nothing else is", async () => {
  const { github, run, posted, builder } = voxTriage([
    { id: "vox:n1", repo: "codybontecou/vox.md", title: "One-tap recording", confidence: 0.9 },
    { id: "vox:n1", repo: "codybontecou/vox.md", title: "Unclear tweak", confidence: 0.5 },
    { id: "discord:9", repo: "codybontecou/vox.md", title: "Community ask", confidence: 0.95 },
  ]);
  const report = await run();
  assert.deepEqual(report.proposals.map(p => [p.title, p.approved]), [["Community ask", false], ["One-tap recording", true], ["Unclear tweak", false]]);
  const byTitle = (title: string) => [1, 2, 3].map(n => github.get("codybontecou", "vox.md", n)).find(issue => issue.title === title)!;
  assert.deepEqual(byTitle("One-tap recording").labels, ["isobot:ready", "isobot:auto", "bug"], "the owner's notes are marked for end-to-end work");
  assert.match(byTitle("One-tap recording").body, /\*\*Source:\*\* the owner's Vox.md voice note/);
  assert.match(byTitle("One-tap recording").body, /approved automatically.*isobot:stop/);
  assert.deepEqual(byTitle("Unclear tweak").labels, ["isobot:proposed", "bug"], "low confidence still waits");
  assert.deepEqual(byTitle("Community ask").labels, ["isobot:proposed", "bug"], "only the owner's notes self-approve");
  assert.match(posted[0], /🏗 One-tap recording/);
  assert.match(posted[0], /add `isobot:stop` to cancel/);
});

test("autoApprove off keeps Vox proposals waiting, and one note yields at most maxProposalsPerNote issues", async () => {
  const { github, run } = voxTriage([1, 2, 3].map(n => ({ id: "vox:n1", repo: "codybontecou/vox.md", title: `Change ${n}`, confidence: 0.9 - n / 100 })),
    { autoApprove: false, maxProposalsPerNote: 2 });
  const report = await run();
  assert.deepEqual(report.proposals.map(p => p.title), ["Change 1", "Change 2"]);
  assert.ok(report.proposals.every(p => !p.approved));
  assert.deepEqual(github.get("codybontecou", "vox.md", 1).labels, ["isobot:proposed", "bug"]);
});

function review(id: number, rating: number, title: string) {
  return {
    id: { label: String(id) }, title: { label: title }, content: { label: `${title} body` }, updated: { label: "2026-11-15T10:00:00-07:00" },
    author: { name: { label: "reviewer" } }, "im:rating": { label: String(rating) }, "im:version": { label: "2.5.4" },
  };
}

function fakeFeed(feeds: Record<string, unknown[]>, failing = new Set<string>()) {
  const requests: string[] = [];
  const fetcher = (async (url: string) => {
    requests.push(url);
    const [, country, app] = url.match(/itunes\.apple\.com\/(\w\w)\/rss\/customerreviews\/page=1\/id=(\d+)\/sortby=mostrecent\/json$/)!;
    if (failing.has(`${app}:${country}`)) return new Response("busy", { status: 503 });
    const entries = feeds[`${app}:${country}`] ?? [];
    // Apple returns a single entry as an object rather than an array.
    return Response.json({ feed: entries.length === 0 ? {} : { entry: entries.length === 1 ? entries[0] : entries } });
  }) as typeof fetch;
  return { fetcher, requests };
}

test("App Store source records a starting point, then returns only newer reviews per storefront", async () => {
  const store = new Store(":memory:");
  const feeds: Record<string, unknown[]> = { "123456:us": [review(10, 5, "Great")], "123456:gb": [] };
  const { fetcher } = fakeFeed(feeds);
  const source = new AppStoreSource({ apps: { "123456": "codybontecou/vox.md" }, countries: ["us", "gb"] }, fetcher);

  const first = await source.collect(store);
  assert.deepEqual(first.items, [], "first contact only records where to start");
  assert.deepEqual(first.cursors, { "appstore:123456:us": "10", "appstore:123456:gb": "0" });
  for (const [key, value] of Object.entries(first.cursors)) store.setCursor(key, value);

  feeds["123456:us"] = [{ "im:name": { label: "the app itself" } }, review(12, 1, "Crashes on launch"), review(11, 4, "Nice"), review(10, 5, "Great")];
  feeds["123456:gb"] = [review(9, 2, "Sync lost my notes")];
  const second = await source.collect(store);
  assert.deepEqual(second.items.map(i => [i.id, i.rating, i.repo]), [
    ["appstore:9", 2, "codybontecou/vox.md"], ["appstore:11", 4, "codybontecou/vox.md"], ["appstore:12", 1, "codybontecou/vox.md"],
  ], "a storefront with no reviews yet counts every later review; the app entry is skipped");
  const crash = second.items.find(i => i.id === "appstore:12")!;
  assert.equal(crash.url, "https://apps.apple.com/us/app/id123456?see-all=reviews");
  assert.equal(crash.text, "[App Store review, 1/5 stars, version 2.5.4, US, 2026-11-15T10:00:00-07:00]\n\nCrashes on launch\n\nCrashes on launch body");
  assert.deepEqual(second.cursors, { "appstore:123456:us": "12", "appstore:123456:gb": "9" });
});

test("an App Store storefront that fails keeps its cursor and doesn't stop the others", async () => {
  const store = new Store(":memory:");
  store.setCursor("appstore:123456:us", "5");
  store.setCursor("appstore:123456:de", "5");
  const { fetcher } = fakeFeed({ "123456:de": [review(6, 3, "Missing export")] }, new Set(["123456:us"]));
  const result = await new AppStoreSource({ apps: { "123456": "codybontecou/vox.md" }, countries: ["us", "de"] }, fetcher).collect(store);
  assert.deepEqual(result.items.map(i => i.id), ["appstore:6"]);
  assert.deepEqual(result.cursors, { "appstore:123456:de": "6" });
});

test("small proposals from community sources go through when autoApprove allows; major ones wait", async () => {
  const autoApprove = { sources: ["discord" as const], kinds: ["bug" as const], minConfidence: 0.8 };
  const { github, run, posted } = voxTriage([
    { id: "discord:9", repo: "codybontecou/vox.md", title: "Fix export crash", confidence: 0.9 },
    { id: "vox:n1", repo: "codybontecou/vox.md", title: "Redesign the editor", confidence: 0.95, scope: "major" },
  ], {}, autoApprove);
  const report = await run();
  assert.deepEqual(report.proposals.map(p => [p.title, p.approved]), [["Redesign the editor", false], ["Fix export crash", true]]);
  const byTitle = (title: string) => [1, 2].map(n => github.get("codybontecou", "vox.md", n)).find(issue => issue.title === title)!;
  assert.deepEqual(byTitle("Fix export crash").labels, ["isobot:ready", "isobot:auto", "bug"]);
  assert.match(byTitle("Fix export crash").body, /small, confidence 0.90/);
  assert.deepEqual(byTitle("Redesign the editor").labels, ["isobot:proposed", "bug"], "even the owner's notes wait when the change is major");
  assert.match(byTitle("Redesign the editor").body, /Rated a major change, so it waits for you/);
  assert.match(posted[0], /🏗 Fix export crash/);
});

test("autoApprove respects its sources, kinds and confidence", () => {
  const config = { autoApprove: { sources: ["discord" as const, "appstore" as const], kinds: ["bug" as const], minConfidence: 0.8 } };
  const item = (source: TriageItem["source"]) => ({ id: "x", source, repo: null, author: "a", url: null, text: "t" });
  const decision = (over: Partial<TriageDecision> = {}): TriageDecision => ({ id: "x", action: "propose", repo: "o/r", kind: "bug", scope: "small", title: "t", spec: "s", confidence: 0.9, reason: "", ...over });
  assert.equal(autoApproves(config, item("discord"), decision()), true);
  assert.equal(autoApproves(config, item("appstore"), decision()), true);
  assert.equal(autoApproves(config, item("email"), decision()), false, "source not listed");
  assert.equal(autoApproves(config, item("discord"), decision({ kind: "feature" })), false, "kind not listed");
  assert.equal(autoApproves(config, item("discord"), decision({ confidence: 0.7 })), false, "not confident enough");
  assert.equal(autoApproves(config, item("discord"), decision({ scope: "major" })), false, "major always waits");
  assert.equal(autoApproves({}, item("discord"), decision()), false, "off unless configured");
});
