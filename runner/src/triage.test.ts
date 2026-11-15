import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "./config.js";
import { Notifier } from "./notify.js";
import { Store } from "./store.js";
import { DiscordSource, GitHubSource, triage } from "./triage.js";
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

  assert.deepEqual(await source.collect(store), [], "first pass only records cursors");
  assert.ok(!requests.some(r => r.includes("1000000000000000005")), "unmapped categories are skipped");
  assert.ok(!requests.some(r => r.includes("1000000000000000003")), "voice channels are skipped");

  pages["1000000000000000002"] = [
    message("2000000000000000004", "1000000000000000002", "The export button crashes on iPad"),
    message("2000000000000000003", "1000000000000000002", "status", "isobot"),
    message("2000000000000000002", "1000000000000000002", "old"),
  ];
  const items = await source.collect(store);
  assert.deepEqual(items.map(i => [i.id, i.repo]), [["discord:2000000000000000004", "codybontecou/time.md"]]);
  assert.match(items[0].text, /^\[#general\] The export button crashes/);
  assert.equal(store.cursor("discord:1000000000000000002"), "2000000000000000004");
  assert.deepEqual(await source.collect(store), [], "nothing new on the next pass");
});

test("GitHub source returns untriaged issues once", async () => {
  const store = new Store(":memory:");
  const github = new FakeGitHub();
  const source = new GitHubSource(github, [{ owner: "codybontecou", repo: "time.md" }], ["isobot:proposed", "isobot:ready"]);
  assert.deepEqual(await source.collect(store), []);
  github.add("codybontecou", "time.md", 1, "Bug report", []);
  github.add("codybontecou", "time.md", 2, "Already proposed", ["isobot:proposed"]);
  const items = await source.collect(store);
  assert.deepEqual(items.map(i => i.id), ["github:codybontecou/time.md#1"]);
  store.markSeen("triage", items[0].id);
  assert.deepEqual(await source.collect(store), []);
});

test("triage turns proposals into labelled issues that wait for approval", async () => {
  const config = loadConfig();
  const store = new Store(":memory:");
  const github = new FakeGitHub();
  const builder = new FakeBuilder();
  github.add("codybontecou", "time.md", 1, "Existing bug", []);
  builder.triageResult = {
    digest: "One crash report.",
    decisions: [
      { id: "discord:5", action: "propose", repo: "codybontecou/time.md", kind: "bug", title: "Fix iPad export crash", spec: "Steps…", confidence: 0.9, reason: "clear bug" },
      { id: "github:codybontecou/time.md#1", action: "propose", repo: "codybontecou/time.md", kind: "bug", title: "Existing bug", spec: "Spec…", confidence: 0.8, reason: "real" },
      { id: "discord:6", action: "ignore", repo: null, kind: "feature", title: "", spec: "", confidence: 0, reason: "chat" },
    ],
  };
  const posted: string[] = [];
  const notifier = new Notifier("https://discord.test/webhook", (async (_url: string, init: RequestInit) => {
    posted.push(JSON.parse(String(init.body)).content);
    return new Response(null, { status: 204 });
  }) as typeof fetch);
  const sources = [{
    name: "fake",
    collect: async () => [
      { id: "discord:5", source: "discord" as const, repo: "codybontecou/time.md", author: "fan", url: "https://discord.com/channels/1/2/5", text: "export crashes" },
      { id: "github:codybontecou/time.md#1", source: "github" as const, repo: "codybontecou/time.md", author: "fan", url: "https://github.com/codybontecou/time.md/issues/1", text: "bug" },
      { id: "discord:6", source: "discord" as const, repo: "codybontecou/time.md", author: "fan", url: null, text: "hi" },
    ],
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
});
