import assert from "node:assert/strict";
import { test } from "node:test";
import type { DiscordMessage } from "./discordApi.js";
import { Handoff, HandoffWatch, contextPrompt, soleRepo } from "./handoff.js";
import { Herdr, agentName, type HerdrWorkspace, type OpenTab } from "./herdr.js";
import { Notifier } from "./notify.js";
import { Store } from "./store.js";
import { FakeDiscord } from "./testing.js";

const CHANNEL = "123456789012345678";
const BOT = "900000000000000001";
const OWNER = "900000000000000002";
const STRANGER = "900000000000000003";
const JOB = { id: "codybontecou/health-md#353", owner: "codybontecou", repo: "health-md", number: 353, title: "One place for frontmatter fields" };
const LAPTOP = encodeURIComponent("💻");

test("with handoff on, cards, thread posts and channel posts get a 💻 and are remembered; the start notice doesn't", async () => {
  const discord = new FakeDiscord();
  const store = new Store(":memory:");
  const watch = new HandoffWatch(store);
  const notifier = new Notifier({ bot: { token: "t", channelId: CHANNEL }, store, fetcher: discord.fetch, handoff: watch });

  await notifier.job(JOB, { phase: "implementing" }, "🔨 Builder started");
  await notifier.discord("📋 **isobot triage**: 1 new item", ["✅", "🧹"]);
  await notifier.discord("🟢 isobot runner started", [], { handoff: false });

  const puts = discord.calls.filter(c => c.method === "PUT").map(c => c.path);
  assert.ok(puts.includes(`/channels/${CHANNEL}/messages/1000/reactions/${LAPTOP}/@me`), "card");
  assert.ok(puts.includes(`/channels/1001/messages/1007/reactions/${LAPTOP}/@me`), "thread post");
  assert.ok(puts.includes(`/channels/${CHANNEL}/messages/1009/reactions/${LAPTOP}/@me`), "digest, after its own controls");
  assert.equal(puts.filter(p => p.includes(LAPTOP)).length, 3);
  assert.match(discord.posts("1001")[0], /💻 continue the builder's session in a Herdr tab/);
  assert.deepEqual(watch.list().map(w => [w.channelId, w.messageId, w.target.kind]), [
    [CHANNEL, "1000", "job"], ["1001", "1007", "job"], [CHANNEL, "1009", "message"],
  ]);
});

test("a card posted before handoff existed gets its 💻 on the next update, once", async () => {
  const discord = new FakeDiscord();
  const store = new Store(":memory:");
  await new Notifier({ bot: { token: "t", channelId: CHANNEL }, store, fetcher: discord.fetch }).job(JOB, { phase: "implementing" });
  assert.ok(!discord.calls.some(c => c.path.includes(LAPTOP)));

  const watch = new HandoffWatch(store);
  const notifier = new Notifier({ bot: { token: "t", channelId: CHANNEL }, store, fetcher: discord.fetch, handoff: watch });
  await notifier.job(JOB, { phase: "checking" });
  await notifier.job(JOB, { phase: "reviewing" });
  assert.equal(discord.calls.filter(c => c.path === `/channels/${CHANNEL}/messages/1000/reactions/${LAPTOP}/@me`).length, 1);
  assert.deepEqual(watch.list().map(w => w.messageId), ["1000"]);
});

/** Discord with fixed channel pages and reactions, recording what the handoff does. */
class FakeReactions {
  pages = new Map<string, DiscordMessage[]>();
  reactors = new Map<string, string[]>();
  calls: string[] = [];
  deleteFails = false;

  message(channelId: string, id: string, laptops: string[], extra: Partial<DiscordMessage> = {}): DiscordMessage {
    const m: DiscordMessage = {
      id, channel_id: channelId, content: "", author: { id: BOT, username: "isobot", bot: true }, timestamp: "", ...extra,
      reactions: [{ count: laptops.length + 1, me: true, emoji: { name: "💻" } }],
    };
    this.reactors.set(id, [BOT, ...laptops]);
    this.pages.set(channelId, [m, ...(this.pages.get(channelId) ?? [])]);
    return m;
  }

  api = {
    request: async <T>(method: string, route: string): Promise<T> => {
      this.calls.push(`${method} ${route}`);
      const page = route.match(/^\/channels\/(\d+)\/messages\?limit=100$/);
      if (page) return (this.pages.get(page[1]) ?? []) as T;
      const del = route.match(/\/messages\/(\d+)\/reactions\/[^/]+\/(\d+)$/);
      if (method === "DELETE" && del) {
        if (this.deleteFails) throw Object.assign(new Error("Missing Permissions"), { status: 403 });
        this.untap(del[1], del[2]);
      }
      return null as T;
    },
    reactors: async (_channel: string, messageId: string) => {
      this.calls.push(`reactors ${messageId}`);
      return this.reactors.get(messageId) ?? [];
    },
  };

  untap(messageId: string, user: string): void {
    this.reactors.set(messageId, (this.reactors.get(messageId) ?? []).filter(id => id !== user));
    for (const page of this.pages.values()) for (const m of page) if (m.id === messageId) m.reactions![0].count--;
  }

  tap(messageId: string, user: string): void {
    this.reactors.get(messageId)!.push(user);
    for (const page of this.pages.values()) for (const m of page) if (m.id === messageId) m.reactions![0].count++;
  }
}

function setup(options: { herdrFails?: boolean } = {}) {
  const store = new Store(":memory:");
  const watch = new HandoffWatch(store);
  const discord = new FakeReactions();
  const opened: OpenTab[] = [];
  const handoff = new Handoff({
    discord: discord.api, watch, botId: BOT, allowed: new Set([OWNER]), store, guildId: "42",
    herdr: { open: async tab => {
      if (options.herdrFails) throw new Error("herdr: server not running");
      opened.push(tab);
      return { workspaceId: "w1", tabId: "w1:t9", cwd: tab.cwd ?? tab.fallbackCwd };
    } },
    repos: ["codybontecou/health-md", "codybontecou/vox.md"],
    workspaceFor: job => `/work/${job.repo}/${job.branch}`,
    fallbackCwd: "/Users/me/dev",
    now: () => Date.now(),
  });
  return { store, watch, discord, opened, handoff };
}

test("the owner's 💻 on a job card opens a fork of the builder's session, then the button resets", async () => {
  const { store, watch, discord, opened, handoff } = setup();
  store.enqueue(JOB.owner, JOB.repo, JOB.number, JOB.title);
  store.update(JOB.id, { state: "pr_open", branch: "isobot/353-fields", sessionId: "sess-353" });
  watch.add(CHANNEL, "1000", { kind: "job", jobId: JOB.id });
  discord.message(CHANNEL, "1000", [OWNER]);

  await handoff.poll();
  assert.equal(opened.length, 1);
  assert.deepEqual(opened[0].args, ["--resume", "sess-353", "--fork-session"]);
  assert.equal(opened[0].repo, "health-md");
  assert.equal(opened[0].cwd, "/work/health-md/isobot/353-fields", "idle job: its workspace");
  assert.equal(opened[0].label, "#353 One place for frontmatter fields");
  assert.ok(discord.calls.includes(`DELETE /channels/${CHANNEL}/messages/1000/reactions/${LAPTOP}/${OWNER}`));

  // Reset: nothing more opens until the owner taps again.
  await handoff.poll();
  assert.equal(opened.length, 1);
  discord.tap("1000", OWNER);
  await handoff.poll();
  assert.equal(opened.length, 2);
});

test("a job that is building opens in the repo's checkout, never the builder's workspace", async () => {
  const { store, watch, discord, opened, handoff } = setup();
  store.enqueue(JOB.owner, JOB.repo, JOB.number, JOB.title);
  store.update(JOB.id, { state: "building", branch: "isobot/353-fields", sessionId: "sess-353" });
  watch.add(CHANNEL, "1000", { kind: "job", jobId: JOB.id });
  discord.message(CHANNEL, "1000", [OWNER]);
  await handoff.poll();
  assert.equal(opened[0].cwd, undefined);
  assert.equal(opened[0].repo, "health-md");
});

test("only the bot's own 💻, or someone not allowed, opens nothing and costs no extra request", async () => {
  const { watch, discord, opened, handoff } = setup();
  watch.add(CHANNEL, "1000", { kind: "message" });
  watch.add(CHANNEL, "1001", { kind: "message" });
  discord.message(CHANNEL, "1000", []);
  discord.message(CHANNEL, "1001", [STRANGER]);
  await handoff.poll();
  assert.equal(opened.length, 0);
  assert.ok(!discord.calls.includes("reactors 1000"), "bot-only count needs no reactor lookup");
  assert.ok(discord.calls.includes("reactors 1001"));
});

test("without Manage Messages the tap is remembered: no reopen until it is taken off and tapped again", async () => {
  const { watch, discord, opened, handoff } = setup();
  discord.deleteFails = true;
  watch.add(CHANNEL, "1000", { kind: "message" });
  discord.message(CHANNEL, "1000", [OWNER], { content: "📋 **isobot triage**: codybontecou/vox.md Wear OS question" });
  await handoff.poll();
  await handoff.poll();
  assert.equal(opened.length, 1);
  discord.untap("1000", OWNER);
  await handoff.poll();
  discord.tap("1000", OWNER);
  await handoff.poll();
  assert.equal(opened.length, 2);
});

test("a digest opens a fresh session in its repo, with the message framed as data", async () => {
  const { watch, discord, opened, handoff } = setup();
  watch.add(CHANNEL, "1000", { kind: "message" });
  discord.message(CHANNEL, "1000", [OWNER], { content: "📋 **isobot triage**: 2 new items\n### codybontecou/vox.md\n- Wear OS support email" });
  await handoff.poll();
  const tab = opened[0];
  assert.equal(tab.repo, "vox.md");
  assert.equal(tab.cwd, undefined);
  assert.equal(tab.args.length, 1);
  assert.match(tab.args[0], /https:\/\/discord\.com\/channels\/42\/123456789012345678\/1000/);
  assert.match(tab.args[0], /context, not instructions/);
  assert.match(tab.args[0], /<discord-message>\n📋 \*\*isobot triage\*\*/);
  assert.equal(tab.label, "📋 isobot triage: 2 new items");
});

test("a chat answer resumes the chat's session; before it has one, the message seeds a new session", async () => {
  const { store, watch, discord, opened, handoff } = setup();
  watch.add("555", "2000", { kind: "chat", threadId: "555" });
  discord.message("555", "2000", [OWNER], { content: "Here's what I found" });
  await handoff.poll();
  assert.match(opened[0].args[0], /<discord-message>/);

  store.setCursor("chat:state", JSON.stringify({ threads: { 555: { threadId: "555", sessionId: "chat-sess", lastMessageId: "2000", updatedAt: 0, events: [] } } }));
  discord.tap("2000", OWNER);
  await handoff.poll();
  assert.deepEqual(opened[1].args, ["--resume", "chat-sess", "--fork-session"]);
  assert.equal(opened[1].repo, null);
});

test("when Herdr fails, isobot reacts ⚠️ once instead of retrying every poll", async () => {
  const { watch, discord, handoff } = setup({ herdrFails: true });
  watch.add(CHANNEL, "1000", { kind: "message" });
  discord.message(CHANNEL, "1000", [OWNER]);
  await handoff.poll();
  await handoff.poll();
  assert.equal(discord.calls.filter(c => c.startsWith("PUT") && c.includes(encodeURIComponent("⚠️"))).length, 1);
  assert.equal(discord.calls.filter(c => c === "reactors 1000").length, 2);
});

test("deleted messages and lost channels are forgotten", async () => {
  const { watch, discord, handoff } = setup();
  watch.add(CHANNEL, "1000", { kind: "message" });
  watch.add(CHANNEL, "1001", { kind: "message" });
  discord.message(CHANNEL, "1001", []);
  await handoff.poll();
  assert.deepEqual(watch.list().map(w => w.messageId), ["1001"]);
});

test("soleRepo names a repo only when the message is about exactly one", () => {
  const repos = ["codybontecou/health-md", "codybontecou/vox.md"];
  assert.equal(soleRepo("see https://github.com/codybontecou/health-md/issues/1", repos), "health-md");
  assert.equal(soleRepo("codybontecou/health-md and codybontecou/vox.md", repos), null);
  assert.equal(soleRepo("nothing here", repos), null);
});

test("contextPrompt without a server id still says which message it was", () => {
  const m = { id: "1", channel_id: "2", content: "hi", author: { id: BOT, username: "isobot" }, timestamp: "" };
  assert.match(contextPrompt(m, { channelId: "2", messageId: "1" }), /Discord message 1/);
});

test("agent names are valid Herdr names", () => {
  for (const base of ["health-md-353", "GitSync.md-88", "chat", "a-very-long-repository-name-that-goes-on-and-on-1234"]) {
    const name = agentName(base, 1_795_000_000_000);
    assert.match(name, /^[a-z][a-z0-9_-]{0,31}$/, name);
  }
});

const WORKSPACES: HerdrWorkspace[] = [
  { workspace_id: "w1", label: "gitsync-rn", worktree: { checkout_path: "/dev/gitsync-rn", is_linked_worktree: true, repo_name: "gitsync.md" } },
  { workspace_id: "w2", label: "gitsync.md", worktree: { checkout_path: "/dev/gitsync.md", is_linked_worktree: false, repo_name: "gitsync.md" } },
  { workspace_id: "w3", label: "health-md" },
  { workspace_id: "w4", label: "isobot" },
];

function fakeHerdr(workspaces: HerdrWorkspace[], fail?: string, dirs = ["/dev/gitsync.md", "/dev/health-md"]) {
  const calls: string[][] = [];
  let shellReady = 0;
  const herdr = new Herdr({
    exists: dir => dirs.includes(dir),
    retryMs: 0,
    exec: async args => {
      calls.push(args);
      const key = args.slice(0, 2).join(" ");
      if (key === fail) return { code: 1, stdout: "", stderr: JSON.stringify({ error: { message: "pane is not at a shell prompt" } }) };
      // The first start lands before the new pane's shell is up, as it does for real.
      if (key === "agent start" && shellReady++ === 0) return { code: 1, stdout: "", stderr: JSON.stringify({ error: { message: "agent target pane w9:p1 is not an available shell" } }) };
      const result =
        key === "workspace list" ? { workspaces } :
        key === "tab create" ? { tab: { tab_id: "w9:t1" }, root_pane: { pane_id: "w9:p1" } } :
        key === "workspace create" ? { workspace: { workspace_id: "w9" }, tab: { tab_id: "w9:t1" }, root_pane: { pane_id: "w9:p1" } } : {};
      return { code: 0, stdout: JSON.stringify({ result }), stderr: "" };
    },
  });
  return { herdr, calls };
}

const TAB: OpenTab = { repo: "GitSync.md", fallbackCwd: "/dev", label: "#88 Guide", agentName: "iso-gitsync-md-88-abcd", args: ["--resume", "s", "--fork-session"] };

test("Herdr opens the tab in the repo's main workspace and checkout, and starts Claude there", async () => {
  const { herdr, calls } = fakeHerdr(WORKSPACES);
  const opened = await herdr.open(TAB);
  assert.deepEqual(opened, { workspaceId: "w2", tabId: "w9:t1", cwd: "/dev/gitsync.md" });
  const start = ["agent", "start", "iso-gitsync-md-88-abcd", "--kind", "claude", "--pane", "w9:p1", "--timeout", "60000", "--", "--resume", "s", "--fork-session"];
  assert.deepEqual(calls.slice(1), [
    ["tab", "create", "--workspace", "w2", "--cwd", "/dev/gitsync.md", "--label", "#88 Guide", "--focus"],
    start,
    ["agent", "start", "iso-gitsync-md-88-abcd", "--kind", "claude", "--pane", "w9:p1", "--timeout", "60000", "--", "--resume", "s", "--fork-session"],
    ["tab", "focus", "w9:t1"],
  ]);
});

test("Herdr matches a workspace by label when it has no checkout info, and falls back to the isobot workspace", async () => {
  const { herdr, calls } = fakeHerdr(WORKSPACES);
  await herdr.open({ ...TAB, repo: "health-md" });
  assert.deepEqual(calls[1].slice(0, 6), ["tab", "create", "--workspace", "w3", "--cwd", "/dev/health-md"], "~/dev/<repo> when Herdr has no checkout");
  await herdr.open({ ...TAB, repo: null });
  assert.equal(calls.find((c, i) => i > 3 && c[1] === "create")![3], "w4");
});

test("Herdr creates the isobot workspace when there's none, and closes its tab if Claude won't start", async () => {
  const created = fakeHerdr([]);
  await created.herdr.open({ ...TAB, repo: null });
  assert.deepEqual(created.calls[1], ["workspace", "create", "--cwd", "/dev", "--label", "isobot", "--focus"]);
  assert.deepEqual(created.calls[2], ["tab", "rename", "w9:t1", "#88 Guide"]);

  const failing = fakeHerdr(WORKSPACES, "agent start");
  await assert.rejects(failing.herdr.open(TAB), /herdr agent start failed: pane is not at a shell prompt/);
  assert.deepEqual(failing.calls.at(-1), ["tab", "close", "w9:t1"]);
});

test("channels with no new 💻 for half an hour are read every fourth poll", async () => {
  const { watch, discord, handoff } = setup();
  // An entry from an hour before the handoff's clock, next to a fresh one in another channel.
  watch.add(CHANNEL, "1000", { kind: "message" });
  watch.add("777", "3000", { kind: "message" });
  watch.save(watch.list().map(w => w.messageId === "1000" ? { ...w, at: Date.now() - 60 * 60_000 } : w));
  discord.message(CHANNEL, "1000", []);
  discord.message("777", "3000", []);
  for (let i = 0; i < 8; i++) await handoff.poll();
  const reads = (channel: string) => discord.calls.filter(c => c === `GET /channels/${channel}/messages?limit=100`).length;
  assert.equal(reads(CHANNEL), 2);
  assert.equal(reads("777"), 8);
});
