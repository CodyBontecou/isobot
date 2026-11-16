import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import type { Builder, TriageDecision, TriageItem } from "./builder.js";
import { configuredRepos, type AppStoreConfig, type ImapAccount, type RunnerConfig } from "./config.js";
import type { GitHubApi } from "./github.js";
import type { Notifier } from "./notify.js";
import type { Store } from "./store.js";

/** New inbound items since the last pass, plus the cursor moves to apply once triage succeeds. */
export interface Collected {
  items: TriageItem[];
  cursors: Record<string, string>;
}

/** Pulls new inbound items. First contact with a source only records where to start. */
export interface Source {
  name: string;
  collect(store: Store): Promise<Collected>;
}

const TRIAGE_CHUNK = 60;

interface DiscordChannel { id: string; name: string; type: number; parentId: string | null }
interface DiscordMessage { id: string; channelId: string; channelName: string; author: { username?: string; displayName?: string }; content: string; jumpUrl: string; createdAt: string }

const TEXT_TYPES = new Set([0, 5, 10, 11, 12]);
const THREAD_TYPES = new Set([10, 11, 12]);

/** Reads recent Discord messages through Pi's owner-authenticated history API. */
export class DiscordSource implements Source {
  name = "discord";

  constructor(
    private piUrl: string,
    private token: string,
    /** Discord category name (lowercase) → owner/repo. */
    private categories: Record<string, string>,
    private fetcher: typeof fetch = fetch,
  ) {}

  private async get<T>(path: string): Promise<T> {
    const response = await this.fetcher(`${this.piUrl}/api/discord/${path}`, {
      headers: { Authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Discord history ${path.split("?")[0]} returned HTTP ${response.status}`);
    }
    return await response.json() as T;
  }

  repoForChannel(channel: DiscordChannel, byId: Map<string, DiscordChannel>): string | null {
    let current: DiscordChannel | undefined = channel;
    for (let depth = 0; current && depth < 3; depth++) {
      if (current.type === 4) return this.categories[current.name.toLowerCase()] ?? null;
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    return null;
  }

  async collect(store: Store): Promise<Collected> {
    const { channels } = await this.get<{ channels: DiscordChannel[] }>("channels");
    const byId = new Map(channels.map(channel => [channel.id, channel]));
    const items: TriageItem[] = [];
    const cursors: Record<string, string> = {};
    for (const channel of channels) {
      if (!TEXT_TYPES.has(channel.type)) continue;
      const repo = this.repoForChannel(channel, byId);
      if (!repo) continue;
      const key = `discord:${channel.id}`;
      const cursor = store.cursor(key);
      const fresh: DiscordMessage[] = [];
      let before: string | undefined;
      for (let page = 0; page < 3; page++) {
        const query = new URLSearchParams({ channelId: channel.id, limit: "50", ...(before ? { beforeId: before } : {}) });
        let messages: DiscordMessage[];
        try {
          ({ messages } = await this.get<{ messages: DiscordMessage[] }>(`messages?${query}`));
        } catch (error) {
          console.warn(`[triage] discord #${channel.name}: ${(error as Error).message}`);
          break;
        }
        if (!cursor) {
          // First pass: start from now instead of triaging the whole backlog.
          if (messages[0]) cursors[key] = messages[0].id;
          break;
        }
        const newer = messages.filter(message => BigInt(message.id) > BigInt(cursor));
        fresh.push(...newer);
        if (newer.length < messages.length || messages.length < 50) break;
        before = messages[messages.length - 1].id;
      }
      if (!cursor || fresh.length === 0) continue;
      cursors[key] = fresh.reduce((max, m) => BigInt(m.id) > BigInt(max) ? m.id : max, cursor);
      for (const message of fresh.reverse()) {
        if (!message.content.trim() || message.author.username === "isobot") continue;
        if (store.isSeen("triage", `discord:${message.id}`)) continue;
        items.push({
          id: `discord:${message.id}`, source: "discord", repo, url: message.jumpUrl,
          author: message.author.displayName ?? message.author.username ?? "unknown",
          text: `[#${THREAD_TYPES.has(channel.type) ? `thread ${channel.name}` : channel.name}] ${message.content.slice(0, 2000)}`,
        });
      }
    }
    return { items, cursors };
  }
}

/** Open GitHub issues nobody has triaged: no isobot label yet. */
export class GitHubSource implements Source {
  name = "github";

  constructor(private github: GitHubApi, private repos: { owner: string; repo: string }[], private isobotLabels: string[]) {}

  async collect(store: Store): Promise<Collected> {
    const items: TriageItem[] = [];
    const cursors: Record<string, string> = {};
    const known = new Set(this.isobotLabels.map(label => label.toLowerCase()));
    for (const { owner, repo } of this.repos) {
      const key = `github:${owner}/${repo}`.toLowerCase();
      const cursor = store.cursor(key);
      const now = new Date().toISOString();
      if (!cursor) {
        cursors[key] = now;
        continue;
      }
      try {
        // `since` is "updated since", so older issues with new activity come back; `seen` filters repeats.
        const issues = await this.github.openIssues(owner, repo, cursor);
        cursors[key] = now;
        for (const issue of issues) {
          if (issue.labels.some(label => known.has(label.toLowerCase()))) continue;
          const id = `github:${owner}/${repo}#${issue.number}`.toLowerCase();
          if (store.isSeen("triage", id)) continue;
          items.push({
            id, source: "github", repo: `${owner}/${repo}`, url: issue.url, author: issue.author,
            text: `${issue.title}\n\n${issue.body.replace(/<!--[\s\S]*?-->/g, "").slice(0, 3000)}`,
          });
        }
      } catch (error) {
        console.warn(`[triage] github ${owner}/${repo}: ${(error as Error).message}`);
      }
    }
    return { items, cursors };
  }
}

/** New mail in one IMAP mailbox (e.g. Gmail with an app password). Read-only: never marks mail as seen. */
export class EmailSource implements Source {
  name: string;

  constructor(private imap: ImapAccount) {
    this.name = `email ${imap.user}`;
  }

  async collect(store: Store): Promise<Collected> {
    const client = new ImapFlow({
      host: this.imap.host, port: this.imap.port, secure: true, logger: false,
      auth: { user: this.imap.user, pass: this.imap.password },
    });
    await client.connect();
    const items: TriageItem[] = [];
    const cursors: Record<string, string> = {};
    try {
      const mailbox = await client.mailboxOpen(this.imap.mailbox, { readOnly: true });
      const key = `email:${this.imap.user}:${this.imap.mailbox}:${mailbox.uidValidity}`;
      const cursor = store.cursor(key);
      const latest = Math.max(0, Number(mailbox.uidNext) - 1);
      if (!cursor) {
        cursors[key] = String(latest);
        return { items, cursors };
      }
      if (latest <= Number(cursor)) return { items, cursors };
      // At most 100 messages per pass; the cursor stops at the last one read, so the rest come next time.
      const last = Math.min(latest, Number(cursor) + 100);
      const range = `${Number(cursor) + 1}:${last}`;
      // On Gmail, a search narrows the range to what matches the account's query.
      const uids = this.imap.query ? await client.search({ uid: range, gmraw: this.imap.query }, { uid: true }) : null;
      const wanted = uids === null ? range : (uids || []).filter(uid => uid > Number(cursor) && uid <= last).join(",");
      if (wanted) {
        for await (const message of client.fetch(wanted, { uid: true, source: true }, { uid: true })) {
          if (message.uid <= Number(cursor) || message.uid > last) continue;
          const id = `email:${this.imap.user.toLowerCase()}:${mailbox.uidValidity}:${message.uid}`;
          if (!message.source || store.isSeen("triage", id)) continue;
          const parsed = await simpleParser(message.source.subarray(0, 256 * 1024));
          const from = parsed.from?.value?.[0];
          items.push({
            id, source: "email", repo: null, url: null,
            author: from ? `${from.name ?? ""} <${from.address ?? ""}>`.trim() : "unknown",
            text: `Subject: ${parsed.subject ?? "(none)"}\n\n${(parsed.text ?? "").slice(0, 3000)}`,
          });
        }
      }
      cursors[key] = String(last);
    } finally {
      await client.logout().catch(() => undefined);
    }
    return { items, cursors };
  }
}

interface VoxNote { sequence: number; id: string; mode: string; receivedAt?: string }

const VOX_NOTE_CHARS = 8000;

/**
 * The owner's Vox.md captures: a Vox preset with an HTTP destination posts each note to one Pi
 * conversation (`/api/vox?mode=memory&conversation=…`), and this reads that conversation's archive.
 * The conversation exists only for isobot, so unlike the other sources the first pass takes
 * everything already there: notes sent before the runner was set up still count.
 */
export class VoxSource implements Source {
  name = "vox";

  constructor(
    private piUrl: string,
    private token: string,
    private conversation: string,
    private fetcher: typeof fetch = fetch,
  ) {}

  private async get(path: string): Promise<Response> {
    const response = await this.fetcher(`${this.piUrl}${path}`, {
      headers: { Authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Vox notes ${path.split("?")[0]} returned HTTP ${response.status}`);
    }
    return response;
  }

  async collect(store: Store): Promise<Collected> {
    const key = `vox:${this.conversation}`;
    const cursor = Number(store.cursor(key) ?? "0");
    const fresh: VoxNote[] = [];
    let before: number | undefined;
    // Newest first; stop at the cursor. Five pages of 100 is far more than a triage interval holds.
    for (let page = 0; page < 5; page++) {
      const query = new URLSearchParams({ conversation: this.conversation, limit: "100", ...(before ? { before: String(before) } : {}) });
      const { items, nextCursor } = await (await this.get(`/api/notes?${query}`)).json() as { items: VoxNote[]; nextCursor?: number };
      const newer = items.filter(note => note.sequence > cursor);
      fresh.push(...newer);
      if (newer.length < items.length || nextCursor === undefined) break;
      before = nextCursor;
    }
    if (fresh.length === 0) return { items: [], cursors: {} };
    const items: TriageItem[] = [];
    for (const note of fresh.reverse()) {
      const id = `vox:${note.id.toLowerCase()}`;
      if (store.isSeen("triage", id)) continue;
      // A failed read throws, so the cursor stays put and the note comes back next pass.
      const query = new URLSearchParams({ conversation: this.conversation });
      const markdown = await (await this.get(`/api/notes/${encodeURIComponent(note.id)}.md?${query}`)).text();
      if (!markdown.trim()) continue;
      items.push({
        id, source: "vox", repo: null, url: null, author: "owner",
        text: `[Vox.md voice note${note.receivedAt ? `, ${note.receivedAt}` : ""}]\n\n${markdown.slice(0, VOX_NOTE_CHARS)}`,
      });
    }
    return { items, cursors: { [key]: String(Math.max(...fresh.map(note => note.sequence))) } };
  }
}

interface FeedLabel { label?: string }
interface FeedEntry {
  id?: FeedLabel; title?: FeedLabel; content?: FeedLabel; updated?: FeedLabel;
  author?: { name?: FeedLabel }; "im:rating"?: FeedLabel; "im:version"?: FeedLabel;
}

const REVIEW_CHARS = 3000;

/**
 * App Store reviews from Apple's public customer-reviews feed (newest 50 per storefront, no API
 * key). The cursor per app and storefront is the highest review id seen; review ids only grow.
 * First contact only records where to start, like the other sources.
 */
export class AppStoreSource implements Source {
  name = "appstore";

  constructor(private config: AppStoreConfig, private fetcher: typeof fetch = fetch) {}

  async collect(store: Store): Promise<Collected> {
    const items: TriageItem[] = [];
    const cursors: Record<string, string> = {};
    const jobs = Object.entries(this.config.apps).flatMap(([app, repo]) => this.config.countries.map(country => ({ app, repo, country })));
    await Promise.all(jobs.map(async ({ app, repo, country }) => {
      const key = `appstore:${app}:${country}`;
      const cursor = store.cursor(key);
      let entries: FeedEntry[];
      try {
        entries = await this.reviews(app, country);
      } catch (error) {
        console.warn(`[triage] appstore ${app}/${country}: ${(error as Error).message}`);
        return;
      }
      const ids = entries.map(e => e.id?.label ?? "").filter(id => /^\d+$/.test(id));
      const newest = ids.reduce((max, id) => (BigInt(id) > BigInt(max) ? id : max), cursor ?? "0");
      if (newest !== cursor) cursors[key] = newest;
      if (cursor === null) return;
      for (const entry of entries) {
        const reviewId = entry.id?.label ?? "";
        if (!/^\d+$/.test(reviewId) || BigInt(reviewId) <= BigInt(cursor)) continue;
        const id = `appstore:${reviewId}`;
        if (store.isSeen("triage", id)) continue;
        const rating = Number(entry["im:rating"]?.label);
        const meta = [`${rating}/5 stars`, entry["im:version"]?.label && `version ${entry["im:version"].label}`, country.toUpperCase(), entry.updated?.label].filter(Boolean).join(", ");
        items.push({
          id, source: "appstore", repo, rating,
          url: `https://apps.apple.com/${country}/app/id${app}?see-all=reviews`,
          author: entry.author?.name?.label ?? "App Store reviewer",
          text: `[App Store review, ${meta}]\n\n${entry.title?.label ?? ""}\n\n${(entry.content?.label ?? "").slice(0, REVIEW_CHARS)}`,
        });
      }
    }));
    items.sort((a, b) => (BigInt(a.id.split(":")[1]) < BigInt(b.id.split(":")[1]) ? -1 : 1));
    return { items, cursors };
  }

  private async reviews(app: string, country: string): Promise<FeedEntry[]> {
    const response = await this.fetcher(`https://itunes.apple.com/${country}/rss/customerreviews/page=1/id=${app}/sortby=mostrecent/json`, {
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`HTTP ${response.status}`);
    }
    const feed = (await response.json() as { feed?: { entry?: FeedEntry | FeedEntry[] } }).feed;
    const entries = feed?.entry === undefined ? [] : Array.isArray(feed.entry) ? feed.entry : [feed.entry];
    // Older feed versions put the app itself first; it has no rating.
    return entries.filter(entry => entry["im:rating"]);
  }
}

export interface TriageDeps {
  config: RunnerConfig;
  store: Store;
  github: GitHubApi;
  builder: Builder;
  notifier: Notifier;
  sources: Source[];
}

export interface TriageReport {
  items: number;
  proposals: Proposal[];
  digest: string;
}

interface Proposal { title: string; url: string; approved: boolean }

/** One triage pass: collect → decide (model) → propose (GitHub issues awaiting the owner's approval) → digest. */
export async function triage(deps: TriageDeps): Promise<TriageReport> {
  const items: TriageItem[] = [];
  const cursors: Record<string, string> = {};
  for (const source of deps.sources) {
    try {
      const collected = await source.collect(deps.store);
      items.push(...collected.items);
      Object.assign(cursors, collected.cursors);
    } catch (error) {
      console.warn(`[triage] source ${source.name} failed: ${(error as Error).message}`);
    }
  }
  const commitCursors = () => { for (const [key, value] of Object.entries(cursors)) deps.store.setCursor(key, value); };
  if (items.length === 0) {
    commitCursors();
    return { items: 0, proposals: [], digest: "" };
  }

  const repos = configuredRepos(deps.config).map(r => `${r.owner}/${r.repo}`);
  const publicRepos: string[] = [];
  for (const name of repos) {
    const [owner, repo] = name.split("/");
    // Unknown visibility is treated as public: the safer assumption for what a proposal may contain.
    if (await deps.github.isPublic(owner, repo).catch(() => true)) publicRepos.push(name);
  }
  const byId = new Map(items.map(item => [item.id, item]));
  const proposals: TriageReport["proposals"] = [];
  const digests: string[] = [];
  const labels = deps.config.labels;
  let budget = deps.config.maxProposalsPerTriage;

  // If a chunk fails, cursors stay put and the next pass retries; `seen` marks keep finished items from repeating.
  for (let start = 0; start < items.length; start += TRIAGE_CHUNK) {
    const chunk = items.slice(start, start + TRIAGE_CHUNK);
    const result = await deps.builder.triage({ items: chunk, repos, publicRepos, maxProposals: Math.max(budget, 0), hints: deps.config.vox?.hints });
    if (result.digest) digests.push(result.digest);
    const ranked = result.decisions.filter(d => d.action === "propose").sort((a, b) => b.confidence - a.confidence);
    const perItem = new Map<string, number>();
    for (const decision of ranked) {
      if (budget <= 0) break;
      const item = byId.get(decision.id)!;
      // A voice note may hold several changes; anything else becomes at most one issue or comment.
      const allowed = item.source === "vox" ? deps.config.vox?.maxProposalsPerNote ?? 3 : 1;
      if ((perItem.get(item.id) ?? 0) >= allowed) continue;
      perItem.set(item.id, (perItem.get(item.id) ?? 0) + 1);
      // An item from a known repository stays there, whatever the (untrusted) text persuaded the model.
      if (item.repo && item.repo.toLowerCase() !== decision.repo?.toLowerCase()) decision.repo = item.repo;
      try {
        const isPublic = publicRepos.some(r => r.toLowerCase() === decision.repo!.toLowerCase());
        proposals.push(await propose(deps, decision, item, isPublic));
        budget--;
      } catch (error) {
        console.warn(`[triage] proposal for ${decision.id} failed: ${(error as Error).message}`);
      }
    }
    for (const item of chunk) deps.store.markSeen("triage", item.id);
  }
  commitCursors();
  deps.store.event(null, "triage", `${items.length} items, ${proposals.length} proposals`);
  const result = { digest: digests.join("\n\n") };

  const lowReviews = items.filter(item => item.source === "appstore" && (item.rating ?? 5) <= 2);
  const lines = [
    `🗂 **isobot triage**: ${items.length} new item${items.length === 1 ? "" : "s"}, ${proposals.length} proposal${proposals.length === 1 ? "" : "s"}.`,
    ...proposals.map(p => `• ${p.approved ? "🏗 " : ""}${p.title} <${p.url}>`),
    ...(lowReviews.length ? [`⚠️ ${lowReviews.length} App Store review${lowReviews.length === 1 ? "" : "s"} at 2 stars or fewer:`] : []),
    ...lowReviews.map(r => `• ${"★".repeat(r.rating ?? 0)} ${r.repo}: ${r.text.split("\n\n")[1]?.slice(0, 80) || "(no title)"} <${r.url}>`),
    ...(proposals.some(p => p.approved) ? [`🏗 = rated small and queued to build, merge and ship; add \`${labels.stop}\` to cancel one.`] : []),
    ...(proposals.some(p => !p.approved) ? [`The rest are major or less certain: add \`${labels.ready}\`, or react ✅ in the issue's Discord help thread, to have isobot build one.`] : []),
    result.digest,
  ];
  await deps.notifier.discord(lines.filter(Boolean).join("\n"));
  return { items: items.length, proposals, digest: result.digest };
}

/**
 * Whether a proposal skips the approval click. Only work triage rated "small" ever does; the owner's
 * Vox notes follow vox.autoApprove, everything else autoApprove (sources, kinds, confidence).
 */
export function autoApproves(config: Pick<RunnerConfig, "vox" | "autoApprove">, item: TriageItem, decision: TriageDecision): boolean {
  if (decision.scope !== "small") return false;
  if (item.source === "vox") {
    const vox = config.vox;
    return vox?.autoApprove === true && decision.confidence >= (vox.minAutoApproveConfidence ?? 0.7);
  }
  const auto = config.autoApprove;
  return Boolean(auto) && (auto!.sources as string[]).includes(item.source) && auto!.kinds.includes(decision.kind) && decision.confidence >= auto!.minConfidence;
}

async function propose(deps: TriageDeps, decision: TriageDecision, item: TriageItem, isPublic: boolean): Promise<Proposal> {
  const [owner, repo] = decision.repo!.split("/");
  const labels = deps.config.labels;
  const kindLabel = decision.kind === "bug" ? "bug" : decision.kind === "feature" ? "enhancement" : null;
  const approved = autoApproves(deps.config, item, decision);
  const next = approved
    ? `Rated a small ${decision.kind}, so it was approved automatically; add \`${labels.stop}\` to cancel it.`
    : decision.scope === "major"
      ? `Rated a major change, so it waits for you: add \`${labels.ready}\` (or react ✅ in its Discord help thread) to approve a build.`
      : `Add \`${labels.ready}\` (or react ✅ in its Discord help thread) to approve a build.`;
  const footer = `\n\n---\n<sub>Proposed by isobot triage (${decision.scope}, confidence ${decision.confidence.toFixed(2)}): ${decision.reason}. ${next}</sub>\n<!-- isobot:triage:${item.id} -->`;
  if (item.source === "github") {
    const number = Number(item.id.split("#")[1]);
    await deps.github.comment(owner, repo, number, `## isobot proposal\n\n${decision.spec}${footer}`);
    await deps.github.addLabels(owner, repo, number, approved ? [labels.ready, labels.auto] : [labels.proposed]);
    return { title: decision.title, url: item.url!, approved };
  }
  // Public repos never get who said it; email links and senders never leave the runner.
  const who = isPublic ? "" : ` from ${item.author}`;
  const link = item.url && item.source !== "email" ? `: ${item.url}` : "";
  const source = item.source === "vox" ? "\n\n**Source:** the owner's Vox.md voice note"
    : item.source === "appstore" ? `\n\n**Source:** App Store review (${item.rating}/5 stars)${link}`
    : `\n\n**Source:** ${item.source} message${who}${link}`;
  const issue = await deps.github.createIssue(owner, repo, decision.title, `${decision.spec}${source}${footer}`,
    [...(approved ? [labels.ready, labels.auto] : [labels.proposed]), ...(kindLabel ? [kindLabel] : [])]);
  return { title: decision.title, url: issue.url, approved };
}
