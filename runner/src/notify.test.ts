import assert from "node:assert/strict";
import { test } from "node:test";
import { Notifier, renderCard, type Card } from "./notify.js";
import { Store } from "./store.js";
import { FakeDiscord } from "./testing.js";

const JOB = { id: "codybontecou/time.md#7", owner: "codybontecou", repo: "time.md", number: 7, title: "Add CSV export" };
const CHANNEL = "123456789012345678";

test("one card per job, edited in place, with the detail in a thread under it", async () => {
  const discord = new FakeDiscord();
  const store = new Store(":memory:");
  const notifier = new Notifier({ bot: { token: "t", channelId: CHANNEL }, store, fetcher: discord.fetch });

  await notifier.job(JOB, { phase: "queued", extraSteps: ["Release"] });
  await notifier.job(JOB, { phase: "checking" }, "🔨 Builder: done");
  await notifier.job(JOB, { phase: "waiting", prUrl: "https://github.com/codybontecou/time.md/pull/100", detail: "- autonomy is pr" });

  const card = notifier.card(JOB)!;
  assert.equal(card.messageId, "1000");
  assert.equal(card.threadId, "1001");
  assert.deepEqual(discord.calls.map(c => `${c.method} ${c.path}`), [
    `POST /channels/${CHANNEL}/messages`,
    `POST /channels/${CHANNEL}/messages/1000/threads`,
    "POST /channels/1001/messages",
    `PATCH /channels/${CHANNEL}/messages/1000`,
    "POST /channels/1001/messages",
    `PATCH /channels/${CHANNEL}/messages/1000`,
  ]);
  assert.equal(discord.calls[1].body.name, "time.md#7 · Add CSV export");
  assert.match(discord.posts("1001")[0], /Reply here to talk to isobot/);
  assert.equal(discord.posts("1001")[1], "🔨 Builder: done");
  const last = discord.cards().at(-1)!;
  assert.equal(last.title, "#7 · Add CSV export");
  assert.match(last.description, /\*\*👀 Waiting for you\*\*\n- autonomy is pr/);
  assert.match(last.description, /✅ Build → ✅ Checks → ✅ Review → ✅ PR → 👀 Merge → ▫️ Release/);
  assert.ok(discord.calls.filter(c => !c.path.endsWith("/threads")).every(c => (c.body.allowed_mentions as { parse: unknown[] }).parse.length === 0), "never pings");

  // A restarted runner keeps editing the same card.
  const again = new Notifier({ bot: { token: "t", channelId: CHANNEL }, store, fetcher: discord.fetch });
  await again.job(JOB, { phase: "merged" });
  assert.equal(discord.calls.at(-1)!.path, `/channels/${CHANNEL}/messages/1000`);
});

test("a deleted card is recreated, and a fresh approval starts a new card", async () => {
  const discord = new FakeDiscord();
  const store = new Store(":memory:");
  const notifier = new Notifier({ bot: { token: "t", channelId: CHANNEL }, store, fetcher: discord.fetch });
  await notifier.job(JOB, { phase: "queued" });
  discord.fail404.add(`/channels/${CHANNEL}/messages/1000`);
  await notifier.job(JOB, { phase: "implementing" });
  assert.equal(notifier.card(JOB)!.messageId, "1003");

  store.enqueue(JOB.owner, JOB.repo, JOB.number, JOB.title);
  assert.equal(notifier.card(JOB), null);
});

test("with only a webhook, job updates become the old one-line channel messages", async () => {
  const posted: string[] = [];
  const notifier = new Notifier({
    webhookUrl: "https://discord.test/webhook",
    fetcher: (async (_url: string, init: RequestInit) => { posted.push(JSON.parse(String(init.body)).content); return new Response(null, { status: 204 }); }) as typeof fetch,
  });
  await notifier.job(JOB, { phase: "checking" }, "thread-only detail");
  await notifier.job(JOB, { phase: "merged" }, "✅ Merged", "✅ merged headline");
  await notifier.say(JOB, "nobody hears this");
  assert.deepEqual(posted, ["✅ merged headline"]);
  assert.equal(notifier.threads, false);
});

test("the card shows where a job failed and how long it took", () => {
  const card: Card = {
    title: "Add CSV export", issueUrl: "https://github.com/codybontecou/time.md/issues/7", phase: "failed", step: "Checks",
    detail: "checks kept failing", extraSteps: [], startedAt: "2026-11-15T10:00:00Z", finishedAt: "2026-11-15T10:14:00Z",
    fixRounds: 3, reviewRounds: 0, notes: 1,
  };
  const body = renderCard(card, "https://pi.example/jobs/x");
  const embed = body.embeds[0] as { description: string; color: number };
  assert.match(embed.description, /✅ Build → ❌ Checks → ▫️ Review/);
  assert.match(embed.description, /Finished <t:\d+:R> after 14 min · 3 fix rounds · 1 note from you/);
  assert.equal(embed.color, 0xd1242f);
  const buttons = (body.components[0] as { components: { label: string }[] }).components.map(b => b.label);
  assert.deepEqual(buttons, ["Issue", "Open in isobot"]);
});
