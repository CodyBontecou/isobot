import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { executeDiscord, layout, prepareDiscord, type DiscordAdmin } from "./discordAdmin.js";

const GUILD = "400000000000000001";
const STAFF = "410000000000000001";
const VOX = "410000000000000002";
const MODLOG = "420000000000000001";
const UPDATES_VOX = "420000000000000002";
const UPDATES_TIME = "420000000000000003";
const TIME = "410000000000000003";
const hidden = [{ id: GUILD, type: 0, allow: "0", deny: "1024" }, { id: "430000000000000001", type: 0, allow: "1024", deny: "0" }];

/** A guild's channel list; records every write. */
class FakeGuild {
  channels: Record<string, unknown>[] = [
    { id: STAFF, type: 4, name: "STAFF", position: 9, permission_overwrites: hidden },
    { id: VOX, type: 4, name: "Vox.md", position: 1, permission_overwrites: [] },
    { id: TIME, type: 4, name: "TIME.MD", position: 2, permission_overwrites: [] },
    { id: MODLOG, type: 0, name: "modlog", parent_id: STAFF, position: 0, permission_overwrites: hidden },
    { id: UPDATES_VOX, type: 5, name: "updates", parent_id: VOX, position: 0, topic: "Release notes", permission_overwrites: [] },
    { id: UPDATES_TIME, type: 0, name: "updates", parent_id: TIME, position: 0, permission_overwrites: [] },
  ];
  writes: { method: string; route: string; body: Record<string, unknown> }[] = [];
  private next = 440000000000000000n;

  async request<T>(method: string, route: string, body?: Record<string, unknown>): Promise<T> {
    if (method === "GET" && route === `/guilds/${GUILD}/channels`) return structuredClone(this.channels) as T;
    this.writes.push({ method, route, body: body ?? {} });
    if (method === "POST" && route === `/guilds/${GUILD}/channels`) {
      const created = { id: String(this.next++), ...body };
      this.channels.push(created);
      return created as T;
    }
    if (method === "POST" && /^\/channels\/\d+\/webhooks$/.test(route)) return { id: "450000000000000001", token: "secret-webhook-token" } as T;
    if (method === "PATCH") return {} as T;
    throw new Error(`unexpected ${method} ${route}`);
  }
}

function setup() {
  const guild = new FakeGuild();
  const admin: DiscordAdmin = { api: guild, guildId: GUILD, webhookDir: path.join(mkdtempSync(path.join(tmpdir(), "isobot-hooks-")), "webhooks") };
  const fail = (message: string) => new Error(message);
  return { guild, admin, prepare: (kind: string, args: Record<string, unknown>) => prepareDiscord(kind, args, admin, fail) };
}

test("the layout lists channels with their category and which are private", async () => {
  const { admin } = setup();
  const { places } = await layout(admin);
  assert.deepEqual(places.find(p => p.id === MODLOG), { id: MODLOG, name: "modlog", kind: "text", category: "STAFF", private: true });
  assert.deepEqual(places.find(p => p.id === UPDATES_VOX), { id: UPDATES_VOX, name: "updates", kind: "announcement", category: "Vox.md", private: false, topic: "Release notes" });
});

test("a new channel in a private category copies its permissions; private hides it from @everyone anywhere", async () => {
  const { guild, admin, prepare } = setup();
  const staff = await prepare("create_channel", { name: "Vox Inbox", category: "staff", topic: "Voice capture summaries" });
  assert.match(staff.summary, /Create text channel #vox-inbox\*\* in \*\*STAFF\*\*[\s\S]*same permissions as STAFF \(private\)[\s\S]*Topic: Voice capture summaries/);
  assert.match(await executeDiscord(staff.action, admin), /^Created <#\d+>\.$/);
  assert.deepEqual(guild.writes[0].body, { name: "vox-inbox", type: 0, parent_id: STAFF, topic: "Voice capture summaries", permission_overwrites: hidden });

  const open = await prepare("create_channel", { name: "roadmap", category: "Vox.md", type: "forum", private: true });
  assert.match(open.summary, /forum channel #roadmap[\s\S]*private: hidden from @everyone/);
  await executeDiscord(open.action, admin);
  assert.deepEqual(guild.writes[1].body.permission_overwrites, [{ id: GUILD, type: 0, allow: "0", deny: "1024" }]);
});

test("proposals are checked against the server: duplicates, unknown and ambiguous names are refused", async () => {
  const { prepare } = setup();
  await assert.rejects(prepare("create_channel", { name: "modlog", category: "STAFF" }), /already exists/);
  await assert.rejects(prepare("create_channel", { name: "x", category: "nope" }), /no category named nope/);
  await assert.rejects(prepare("create_channel", { name: "x", type: "voice" }), /type must be/);
  await assert.rejects(prepare("create_webhook", { channel: "updates" }), /2 channels are named updates; say which, e\.g\. "vox\.md\/updates" or "time\.md\/updates"/);
  await assert.rejects(prepare("create_category", { name: "staff" }), /already exists/);
  await assert.rejects(prepare("edit_channel", { channel: "modlog" }), /needs a new name, topic or category/);
  await assert.rejects(prepare("delete_channel", { channel: "modlog" }), /unknown action/);
  const byPath = await prepare("create_webhook", { channel: "Vox.md/updates", name: "Releases" });
  assert.match(byPath.summary, /webhook "Releases" on #updates/);
});

test("moving a channel says whose permissions it takes, and the edit syncs them", async () => {
  const { guild, admin, prepare } = setup();
  const move = await prepare("edit_channel", { channel: `<#${UPDATES_TIME}>`, name: "Release Notes", category: "STAFF", topic: "" });
  assert.match(move.summary, /Edit #updates\*\*\n- rename to \*\*release-notes\*\*\n- clear the topic\n- move in \*\*STAFF\*\*; it takes STAFF's permissions \(private\)/);
  assert.equal(await executeDiscord(move.action, admin), `Updated <#${UPDATES_TIME}>.`);
  assert.deepEqual(guild.writes[0], { method: "PATCH", route: `/channels/${UPDATES_TIME}`, body: { name: "release-notes", topic: null, parent_id: STAFF, lock_permissions: true } });
});

test("a webhook's URL goes to a private file on the runner, never into the reply", async () => {
  const { admin, prepare } = setup();
  const hook = await prepare("create_webhook", { channel: "modlog", name: "Vox inbox" });
  const outcome = await executeDiscord(hook.action, admin);
  assert.doesNotMatch(outcome, /secret-webhook-token/);
  const [file] = readdirSync(admin.webhookDir);
  assert.equal(file, "modlog-vox-inbox.url");
  assert.equal(readFileSync(path.join(admin.webhookDir, file), "utf8"), "https://discord.com/api/webhooks/450000000000000001/secret-webhook-token\n");
  assert.equal(statSync(path.join(admin.webhookDir, file)).mode & 0o777, 0o600);
  assert.equal(statSync(admin.webhookDir).mode & 0o777, 0o700);
  await executeDiscord(hook.action, admin);
  assert.equal(readdirSync(admin.webhookDir).length, 2, "a second webhook never overwrites the first one's file");
  await assert.rejects(prepare("create_webhook", { channel: "modlog", name: "Discord bot" }), /refuses webhook names/);
});

test("a confirmed action re-checks the server first", async () => {
  const { guild, admin, prepare } = setup();
  const create = await prepare("create_channel", { name: "vox-inbox", category: "STAFF" });
  await executeDiscord(create.action, admin);
  await assert.rejects(executeDiscord(create.action, admin), /already exists/, "a second 👍 on a stale proposal doesn't make a duplicate");
  const edit = await prepare("edit_channel", { channel: "modlog", topic: "audit" });
  guild.channels = guild.channels.filter(c => c.id !== MODLOG);
  await assert.rejects(executeDiscord(edit.action, admin), /no longer exists/);
});
