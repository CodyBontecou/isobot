import type { Job, Store } from "./store.js";

/**
 * Posts runner activity to Discord.
 *
 * With a bot token and channel, each job gets one status card in the channel that is edited as the
 * job moves, plus a thread under it for the detail. Owner replies in that thread reach the runner
 * through the GitHub issue (the bridge relays them), so the thread doubles as a conversation.
 * With only a webhook, job updates fall back to one-line channel messages. With neither, it's silent.
 */
export interface NotifierOptions {
  webhookUrl?: string;
  bot?: { token: string; channelId: string };
  /** Keeps each job's card and thread ids across restarts. Without one, ids live in memory. */
  store?: Pick<Store, "cursor" | "setCursor">;
  /** Optional link to the job in isobot's UI; `{id}` is replaced with the URL-encoded job id. */
  jobUrl?: string;
  fetcher?: typeof fetch;
}

export type Phase =
  | "queued" | "implementing" | "revising" | "checking" | "fixing" | "reviewing" | "addressing"
  | "pushing" | "ci" | "waiting" | "merged" | "releasing" | "released" | "releaseFailed"
  | "ship" | "shipping" | "shipped" | "shipFailed" | "retrying" | "paused" | "failed" | "stopped" | "closed";

type Mark = "active" | "wait" | "done" | "fail" | "stop";
type Step = "Build" | "Checks" | "Review" | "PR" | "Merge" | "Release" | "Ship";

const PHASES: Record<Phase, { label: string; emoji: string; step: Step | "done" | null; mark: Mark }> = {
  queued: { label: "Queued", emoji: "⏳", step: "Build", mark: "wait" },
  implementing: { label: "Implementing", emoji: "🔨", step: "Build", mark: "active" },
  revising: { label: "Revising with your note", emoji: "💬", step: "Build", mark: "active" },
  checking: { label: "Running checks", emoji: "🧪", step: "Checks", mark: "active" },
  fixing: { label: "Fixing failed checks", emoji: "🔧", step: "Checks", mark: "active" },
  reviewing: { label: "Independent review", emoji: "🔍", step: "Review", mark: "active" },
  addressing: { label: "Addressing review", emoji: "✏️", step: "Review", mark: "active" },
  pushing: { label: "Opening the PR", emoji: "📤", step: "PR", mark: "active" },
  ci: { label: "Waiting for GitHub CI", emoji: "⏱", step: "Merge", mark: "active" },
  waiting: { label: "Waiting for you", emoji: "👀", step: "Merge", mark: "wait" },
  merged: { label: "Merged", emoji: "✅", step: "done", mark: "done" },
  releasing: { label: "Releasing", emoji: "📦", step: "Release", mark: "active" },
  released: { label: "Released", emoji: "📦", step: "done", mark: "done" },
  releaseFailed: { label: "Release failed", emoji: "❌", step: "Release", mark: "fail" },
  ship: { label: "Ready to ship: add the ship label", emoji: "🛳", step: "Ship", mark: "wait" },
  shipping: { label: "Shipping", emoji: "🚀", step: "Ship", mark: "active" },
  shipped: { label: "Shipped", emoji: "🚀", step: "done", mark: "done" },
  shipFailed: { label: "Ship step failed", emoji: "❌", step: "Ship", mark: "fail" },
  retrying: { label: "Retrying after a temporary problem", emoji: "⏳", step: null, mark: "wait" },
  paused: { label: "Paused: Claude usage limit", emoji: "⏸", step: null, mark: "wait" },
  failed: { label: "Failed", emoji: "⚠️", step: null, mark: "fail" },
  stopped: { label: "Stopped", emoji: "⏹", step: null, mark: "stop" },
  closed: { label: "PR closed without merging", emoji: "⏹", step: null, mark: "stop" },
};

const COLORS: Record<Mark, number> = { active: 0xfbca04, wait: 0x1d76db, done: 0x2ea043, fail: 0xd1242f, stop: 0x6e7781 };
const ICONS: Record<Mark, string> = { active: "🔄", wait: "👀", done: "✅", fail: "❌", stop: "⏹" };
const FINAL = new Set<Phase>(["merged", "released", "shipped", "failed", "stopped", "closed", "releaseFailed", "shipFailed"]);

/** Everything the card shows; persisted per job so a restarted runner keeps editing the same card. */
export interface Card {
  channelId?: string;
  messageId?: string;
  threadId?: string;
  title: string;
  issueUrl: string;
  prUrl?: string;
  phase: Phase;
  /** The step the job last worked on, kept so a failure is shown where it happened. */
  step: Step | "done";
  detail?: string;
  /** Steps after Merge that this repository has (Release, Ship). */
  extraSteps: Step[];
  startedAt: string;
  finishedAt?: string;
  fixRounds: number;
  reviewRounds: number;
  notes: number;
}

export type CardUpdate = Partial<Pick<Card, "phase" | "detail" | "prUrl" | "extraSteps" | "fixRounds" | "reviewRounds" | "notes" | "title">>;

const API = "https://discord.com/api/v10";

export class Notifier {
  private memory = new Map<string, string>();
  private fetcher: typeof fetch;

  constructor(private options: NotifierOptions = {}) {
    this.fetcher = options.fetcher ?? fetch;
  }

  /** Whether job cards and threads are available (bot mode). */
  get threads(): boolean {
    return Boolean(this.options.bot);
  }

  /** A channel-level message (runner started, triage digest, usage pause). */
  async discord(content: string): Promise<void> {
    if (this.options.bot) {
      await this.bot("POST", `/channels/${this.options.bot.channelId}/messages`, message(content)).catch(warn);
    } else if (this.options.webhookUrl) {
      await this.webhook(content);
    }
  }

  /**
   * Moves a job's card and optionally posts `post` in its thread. `headline` is the one-line channel
   * message used instead when there is only a webhook.
   */
  async job(job: Pick<Job, "id" | "owner" | "repo" | "number" | "title">, update: CardUpdate, post?: string, headline?: string): Promise<void> {
    if (!this.options.bot) {
      if (headline && this.options.webhookUrl) await this.webhook(headline);
      return;
    }
    try {
      const card = this.apply(this.load(job) ?? newCard(job), update);
      await this.publish(job, card);
      if (post && card.threadId) await this.bot("POST", `/channels/${card.threadId}/messages`, message(post));
    } catch (error) {
      warn(error);
    }
  }

  /** Posts in a job's thread without touching the card. Does nothing if the job has no thread yet. */
  async say(job: Pick<Job, "id">, post: string): Promise<void> {
    const card = this.load(job);
    if (!this.options.bot || !card?.threadId) return;
    await this.bot("POST", `/channels/${card.threadId}/messages`, message(post)).catch(warn);
  }

  /** Forgets a job's card, so the next update starts a new card and thread (a fresh approval). */
  reset(job: Pick<Job, "id">): void {
    this.save(job.id, null);
  }

  card(job: Pick<Job, "id">): Card | null {
    return this.load(job);
  }

  private apply(card: Card, update: CardUpdate): Card {
    const next: Card = { ...card, ...Object.fromEntries(Object.entries(update).filter(([, v]) => v !== undefined)) };
    if (update.phase) {
      const step = PHASES[update.phase].step;
      if (step) next.step = step;
      // A new phase replaces the old detail unless the caller gave one.
      if (update.detail === undefined) delete next.detail;
      if (FINAL.has(update.phase)) next.finishedAt ??= new Date().toISOString();
      else delete next.finishedAt;
    }
    return next;
  }

  private async publish(job: Pick<Job, "id" | "number" | "title" | "repo">, card: Card): Promise<void> {
    const { channelId } = this.options.bot!;
    const body = { ...renderCard(card, this.jobLink(job.id)), allowed_mentions: { parse: [] } };
    if (card.messageId && card.channelId) {
      try {
        await this.bot("PATCH", `/channels/${card.channelId}/messages/${card.messageId}`, body);
        this.save(job.id, card);
        return;
      } catch (error) {
        // The card was deleted by hand: start a new one rather than going quiet.
        if ((error as DiscordError).status !== 404) throw error;
      }
    }
    const created = await this.bot("POST", `/channels/${channelId}/messages`, body) as { id: string };
    card.channelId = channelId;
    card.messageId = created.id;
    this.save(job.id, card);
    const thread = await this.bot("POST", `/channels/${channelId}/messages/${created.id}/threads`, {
      name: threadName(job), auto_archive_duration: 10080,
    }) as { id: string };
    card.threadId = thread.id;
    this.save(job.id, card);
    await this.bot("POST", `/channels/${thread.id}/messages`, message(
      `Following ${card.issueUrl}\nReply here to talk to isobot about this job: your replies go to the builder ` +
      `(during a build, or as a revision of an open PR). Comments on the issue and \`npm run runner -- say\` work the same way.`,
    ));
  }

  private jobLink(id: string): string | undefined {
    return this.options.jobUrl?.replaceAll("{id}", encodeURIComponent(id));
  }

  private load(job: Pick<Job, "id">): Card | null {
    const raw = this.options.store ? this.options.store.cursor(`discord:${job.id}`) : this.memory.get(job.id);
    if (!raw) return null;
    try { return JSON.parse(raw) as Card; } catch { return null; }
  }

  private save(id: string, card: Card | null): void {
    const raw = card ? JSON.stringify(card) : "";
    if (this.options.store) this.options.store.setCursor(`discord:${id}`, raw);
    else this.memory.set(id, raw);
  }

  private async bot(method: string, route: string, body: unknown, retried = false): Promise<unknown> {
    const response = await this.fetcher(`${API}${route}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bot ${this.options.bot!.token}`, "User-Agent": "isobot-runner (https://github.com, 0.1)" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 429 && !retried) {
      const wait = Number((await response.json().catch(() => ({})) as { retry_after?: number }).retry_after ?? 1);
      if (wait <= 10) {
        await new Promise(resolve => setTimeout(resolve, wait * 1000));
        return this.bot(method, route, body, true);
      }
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw Object.assign(new Error(`Discord ${method} ${route.replace(/\d{15,}/g, ":id")} returned HTTP ${response.status}: ${text.slice(0, 200)}`), { status: response.status }) as DiscordError;
    }
    return response.status === 204 ? null : response.json();
  }

  private async webhook(content: string): Promise<void> {
    try {
      const response = await this.fetcher(this.options.webhookUrl!, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...message(content), username: "isobot runner" }),
        signal: AbortSignal.timeout(15_000),
      });
      await response.body?.cancel();
      if (!response.ok) console.warn(`[notify] Discord webhook returned HTTP ${response.status}`);
    } catch (error) {
      warn(error);
    }
  }
}

interface DiscordError extends Error { status: number }

function warn(error: unknown): void {
  console.warn("[notify] Discord:", (error as Error).message);
}

/** Never ping anyone from automated output. */
function message(content: string): { content: string; allowed_mentions: { parse: never[] } } {
  return { content: content.length > 1900 ? `${content.slice(0, 1899)}…` : content, allowed_mentions: { parse: [] } };
}

function newCard(job: Pick<Job, "owner" | "repo" | "number" | "title">): Card {
  return {
    title: job.title, issueUrl: `https://github.com/${job.owner}/${job.repo}/issues/${job.number}`,
    phase: "queued", step: "Build", extraSteps: [], startedAt: new Date().toISOString(), fixRounds: 0, reviewRounds: 0, notes: 0,
  };
}

function threadName(job: Pick<Job, "repo" | "number" | "title">): string {
  const name = `${job.repo}#${job.number} · ${job.title}`;
  return name.length > 100 ? `${name.slice(0, 99)}…` : name;
}

const unix = (iso: string) => Math.floor(Date.parse(iso) / 1000);

/** The card as a Discord message body: one embed and link buttons. Pure, for tests. */
export function renderCard(card: Card, jobUrl?: string): { content: string; embeds: unknown[]; components: unknown[] } {
  const phase = PHASES[card.phase];
  const steps: Step[] = ["Build", "Checks", "Review", "PR", "Merge", ...card.extraSteps];
  const at = card.step === "done" ? steps.length : Math.max(0, steps.indexOf(card.step));
  const track = steps.map((step, i) => `${i < at ? "✅" : i === at ? ICONS[phase.mark] : "▫️"} ${step}`).join(" → ");
  const counts = [
    card.fixRounds ? `${card.fixRounds} fix round${card.fixRounds === 1 ? "" : "s"}` : "",
    card.reviewRounds ? `${card.reviewRounds} review round${card.reviewRounds === 1 ? "" : "s"}` : "",
    card.notes ? `${card.notes} note${card.notes === 1 ? "" : "s"} from you` : "",
  ].filter(Boolean);
  const timing = card.finishedAt
    ? `Finished <t:${unix(card.finishedAt)}:R> after ${duration(Date.parse(card.finishedAt) - Date.parse(card.startedAt))}`
    : `Started <t:${unix(card.startedAt)}:R>`;
  const title = `#${card.issueUrl.split("/").pop()} · ${card.title}`;
  const repo = card.issueUrl.split("/").slice(3, 5).join("/");
  const buttons = [
    { type: 2, style: 5, label: "Issue", url: card.issueUrl },
    ...(card.prUrl ? [{ type: 2, style: 5, label: "Pull request", url: card.prUrl }] : []),
    ...(jobUrl ? [{ type: 2, style: 5, label: "Open in isobot", url: jobUrl }] : []),
  ];
  return {
    content: "",
    embeds: [{
      title: title.length > 256 ? `${title.slice(0, 255)}…` : title,
      url: card.issueUrl,
      color: COLORS[phase.mark],
      author: { name: repo },
      description: [
        `**${phase.emoji} ${phase.label}**${card.detail ? `\n${card.detail.slice(0, 600)}` : ""}`,
        track,
        [timing, ...counts].join(" · "),
      ].join("\n\n"),
      footer: { text: card.finishedAt ? "Reply in the thread to follow up" : "Reply in the thread to steer this build" },
    }],
    components: [{ type: 1, components: buttons }],
  };
}

function duration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}
