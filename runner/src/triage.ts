import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import type { Builder, TriageDecision, TriageItem } from "./builder.js";
import { configuredRepos, type Environment, type RunnerConfig } from "./config.js";
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
  name = "email";

  constructor(private imap: NonNullable<Environment["imap"]>) {}

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
      let highest = Number(cursor);
      // At most 100 messages per pass; the cursor stops at the last one read, so the rest come next time.
      const last = Math.min(latest, Number(cursor) + 100);
      for await (const message of client.fetch(`${Number(cursor) + 1}:${last}`, { uid: true, source: true }, { uid: true })) {
        if (message.uid <= Number(cursor) || message.uid > last) continue;
        highest = Math.max(highest, message.uid);
        if (!message.source || store.isSeen("triage", `email:${message.uid}`)) continue;
        const parsed = await simpleParser(message.source.subarray(0, 256 * 1024));
        const from = parsed.from?.value?.[0];
        items.push({
          id: `email:${message.uid}`, source: "email", repo: null, url: null,
          author: from ? `${from.name ?? ""} <${from.address ?? ""}>`.trim() : "unknown",
          text: `Subject: ${parsed.subject ?? "(none)"}\n\n${(parsed.text ?? "").slice(0, 3000)}`,
        });
      }
      cursors[key] = String(highest);
    } finally {
      await client.logout().catch(() => undefined);
    }
    return { items, cursors };
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
  proposals: { title: string; url: string }[];
  digest: string;
}

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
  const byId = new Map(items.map(item => [item.id, item]));
  const proposals: TriageReport["proposals"] = [];
  const digests: string[] = [];
  const labels = deps.config.labels;
  let budget = deps.config.maxProposalsPerTriage;

  // If a chunk fails, cursors stay put and the next pass retries; `seen` marks keep finished items from repeating.
  for (let start = 0; start < items.length; start += TRIAGE_CHUNK) {
    const chunk = items.slice(start, start + TRIAGE_CHUNK);
    const result = await deps.builder.triage({ items: chunk, repos, maxProposals: Math.max(budget, 0) });
    if (result.digest) digests.push(result.digest);
    const ranked = result.decisions.filter(d => d.action === "propose").sort((a, b) => b.confidence - a.confidence);
    for (const decision of ranked) {
      if (budget <= 0) break;
      const item = byId.get(decision.id)!;
      // An item from a known repository stays there, whatever the (untrusted) text persuaded the model.
      if (item.repo && item.repo.toLowerCase() !== decision.repo?.toLowerCase()) decision.repo = item.repo;
      try {
        proposals.push(await propose(deps, decision, item));
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

  const lines = [
    `🗂 **isobot triage**: ${items.length} new item${items.length === 1 ? "" : "s"}, ${proposals.length} proposal${proposals.length === 1 ? "" : "s"}.`,
    ...proposals.map(p => `• ${p.title} <${p.url}>`),
    ...(proposals.length ? [`Add \`${labels.ready}\` to a proposal to have isobot build it.`] : []),
    result.digest,
  ];
  await deps.notifier.discord(lines.filter(Boolean).join("\n"));
  return { items: items.length, proposals, digest: result.digest };
}

async function propose(deps: TriageDeps, decision: TriageDecision, item: TriageItem): Promise<{ title: string; url: string }> {
  const [owner, repo] = decision.repo!.split("/");
  const labels = deps.config.labels;
  const kindLabel = decision.kind === "bug" ? "bug" : decision.kind === "feature" ? "enhancement" : null;
  const footer = `\n\n---\n<sub>Proposed by isobot triage (confidence ${decision.confidence.toFixed(2)}): ${decision.reason}. Add \`${labels.ready}\` to approve a build.</sub>\n<!-- isobot:triage:${item.id} -->`;
  if (item.source === "github") {
    const number = Number(item.id.split("#")[1]);
    await deps.github.comment(owner, repo, number, `## isobot proposal\n\n${decision.spec}${footer}`);
    await deps.github.addLabels(owner, repo, number, [labels.proposed]);
    return { title: decision.title, url: item.url! };
  }
  const source = item.url ? `\n\n**Source:** ${item.source} message from ${item.author}: ${item.url}` : `\n\n**Source:** ${item.source} from ${item.author}`;
  const issue = await deps.github.createIssue(owner, repo, decision.title, `${decision.spec}${source}${footer}`,
    [labels.proposed, ...(kindLabel ? [kindLabel] : [])]);
  return { title: decision.title, url: issue.url };
}
