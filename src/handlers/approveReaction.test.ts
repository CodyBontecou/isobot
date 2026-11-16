import assert from "node:assert/strict";
import { test } from "node:test";
import type { MessageReaction, User } from "discord.js";
import { repoToCategoryKey } from "../config/repos.js";
import { handleApproveReaction, type ApproveDeps } from "./approveReaction.js";

const BOT = "bot-1";
const OWNER = "owner-1";
const ISSUE = "https://github.com/codybontecou/vox.md/issues/5";

interface World {
  calls: string[];
  reactions: string[];
  issue: { state: string; labels: string[] };
  deps: ApproveDeps;
}

function world(issue = { state: "open", labels: ["isobot:proposed"] }, failGet = false): World {
  const w: World = { calls: [], reactions: [], issue, deps: undefined as unknown as ApproveDeps };
  w.deps = {
    isAllowed: id => id === OWNER,
    isConfiguredRepo: ref => repoToCategoryKey(ref) !== null,
    getIssue: async ref => {
      w.calls.push(`get ${ref.repo}#${ref.number}`);
      if (failGet) throw new Error("GitHub is down");
      return w.issue;
    },
    addLabels: async ({ repo, number, labels }) => { w.calls.push(`add ${repo}#${number} ${labels.join(",")}`); },
    removeLabel: async ({ repo, number, label }) => { w.calls.push(`remove ${repo}#${number} ${label}`); },
  };
  return w;
}

function reaction(w: World, opts: { emoji?: string; author?: string; content?: string } = {}): MessageReaction {
  const message = {
    partial: false,
    author: { id: opts.author ?? BOT },
    content: opts.content ?? `Tracked from GitHub: ${ISSUE}`,
    embeds: [],
    channel: { isThread: () => false },
    react: async (emoji: string) => { w.reactions.push(emoji); },
    reactions: { cache: new Map([["🏗️", { users: { remove: async () => { w.reactions.push("-🏗️"); } } }]]) },
  };
  return { partial: false, emoji: { name: opts.emoji ?? "✅", id: null }, message } as unknown as MessageReaction;
}

const client = { user: { id: BOT } } as never;
const owner = { id: OWNER, bot: false } as User;

test("the owner's ✅ on a bot message about an issue marks it ready", async () => {
  const w = world();
  await handleApproveReaction(client, reaction(w), owner, true, w.deps);
  assert.deepEqual(w.calls, ["get vox.md#5", "add vox.md#5 isobot:ready"]);
  assert.deepEqual(w.reactions, ["🏗️"]);
});

test("only the allowlist can approve, and bots and other emoji are ignored", async () => {
  for (const [user, emoji] of [[{ id: "stranger", bot: false }, "✅"], [{ id: OWNER, bot: true }, "✅"], [owner, "👍"]] as const) {
    const w = world();
    await handleApproveReaction(client, reaction(w, { emoji }), user as User, true, w.deps);
    assert.deepEqual(w.calls, [], `${user.id}/${emoji} must not touch GitHub`);
    assert.deepEqual(w.reactions, []);
  }
});

test("a ✅ on someone else's message, or on an unmapped repo, does nothing", async () => {
  const forged = world();
  await handleApproveReaction(client, reaction(forged, { author: "stranger" }), owner, true, forged.deps);
  assert.deepEqual(forged.calls, [], "a user can't post an issue link and have the owner's ✅ approve it");

  const unmapped = world();
  await handleApproveReaction(client, reaction(unmapped, { content: "https://github.com/someone/else/issues/1" }), owner, true, unmapped.deps);
  assert.deepEqual(unmapped.calls, []);
});

test("a stopped or closed issue is refused, an in-flight one is acknowledged without relabelling", async () => {
  for (const issue of [{ state: "open", labels: ["isobot:stop"] }, { state: "closed", labels: [] }]) {
    const w = world(issue);
    await handleApproveReaction(client, reaction(w), owner, true, w.deps);
    assert.deepEqual(w.calls, ["get vox.md#5"]);
    assert.deepEqual(w.reactions, ["🚫"]);
  }
  const building = world({ state: "open", labels: ["isobot:building"] });
  await handleApproveReaction(client, reaction(building), owner, true, building.deps);
  assert.deepEqual(building.calls, ["get vox.md#5"]);
  assert.deepEqual(building.reactions, ["🏗️"]);
});

test("removing the ✅ withdraws approval only before the runner claims it", async () => {
  const ready = world({ state: "open", labels: ["isobot:ready"] });
  await handleApproveReaction(client, reaction(ready), owner, false, ready.deps);
  assert.deepEqual(ready.calls, ["get vox.md#5", "remove vox.md#5 isobot:ready"]);
  assert.deepEqual(ready.reactions, ["-🏗️"]);

  const building = world({ state: "open", labels: ["isobot:building"] });
  await handleApproveReaction(client, reaction(building), owner, false, building.deps);
  assert.deepEqual(building.calls, ["get vox.md#5"], "once building, only the stop label stops it");
});

test("a GitHub failure is reported on the message instead of throwing", async () => {
  const w = world(undefined, true);
  const original = console.error;
  console.error = () => {};
  try {
    await handleApproveReaction(client, reaction(w), owner, true, w.deps);
  } finally {
    console.error = original;
  }
  assert.deepEqual(w.reactions, ["⚠️"]);
});
