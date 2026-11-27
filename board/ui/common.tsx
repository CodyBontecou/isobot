import type { ReactNode } from 'react';
import { Activity, Bot, Bug, CircleCheck, CircleDot, ExternalLink, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, Inbox, Mail, MessageSquare, Mic, Newspaper, Rocket, Search, Star, X } from 'lucide-react';
import type { BoardItem, SourceKind } from './types';

/** Pieces every view shares: relative times, JSON fetches, rows, chips and sources. */

export function rel(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—';
  const diff = Date.parse(iso) - now;
  const abs = Math.abs(diff);
  const unit = abs < 60_000 ? `${Math.max(1, Math.round(abs / 1000))}s` : abs < 3_600_000 ? `${Math.round(abs / 60_000)}m`
    : abs < 86_400_000 ? `${Math.round(abs / 3_600_000)}h` : `${Math.round(abs / 86_400_000)}d`;
  return diff > 0 ? `in ${unit}` : `${unit} ago`;
}
export const full = (iso: string | null | undefined) => iso ? new Date(iso).toLocaleString() : '';
export const short = (repo: string) => repo.split('/')[1] ?? repo;

export async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', signal, headers: { Accept: 'application/json' } });
  if (response.status === 401) throw new SignedOut();
  if (!response.ok) throw new Error(`${path} answered ${response.status}`);
  return response.json() as Promise<T>;
}
export class SignedOut extends Error {}

/** The data-* attributes that make a row or card something the owner can pick for the agent dock (agent.tsx). */
export function refAttrs(kind: string, id: string, label?: string): Record<string, string> {
  return { 'data-ref-kind': kind, 'data-ref-id': id, ...(label ? { 'data-ref-label': label } : {}) };
}

export const STATE_TONE: Record<string, string> = {
  queued: 'muted', blocked: 'warn', building: 'info', awaiting_ci: 'info', pr_open: 'accent', merged: 'ok', released: 'ok',
  awaiting_ship: 'warn', shipped: 'ok', closed: 'muted', failed: 'bad', stopped: 'muted',
};

// ---------- shared bits ----------

export function Empty({ title, body }: { title: string; body?: string }) {
  return <div className="empty"><Inbox size={20} /><strong>{title}</strong>{body ? <span>{body}</span> : null}</div>;
}

export function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return <section className="section"><div className="section-head"><h2>{title}</h2>{action}</div>{children}</section>;
}

export function Chip({ tone = 'muted', children, title }: { tone?: string; children: ReactNode; title?: string }) {
  return <span className={`chip ${tone}`} title={title}>{children}</span>;
}

export function JobLink({ id, open }: { id: string; open: (id: string) => void }) {
  return <button className="joblink" onClick={() => open(id)}>{short(id.split('#')[0])}#{id.split('#')[1]}</button>;
}

export function SearchBox({ q, setQ, placeholder }: { q: string; setQ: (q: string) => void; placeholder: string }) {
  return <label className="search"><Search size={14} /><input value={q} onChange={e => setQ(e.target.value)} placeholder={placeholder} />{q ? <button className="icon" onClick={() => setQ('')}><X size={12} /></button> : null}</label>;
}

export function Labels({ labels }: { labels: string[] }) {
  return <>{labels.map(l => <Chip key={l} tone={l.startsWith('isobot:') ? labelTone(l) : 'muted'}>{l.replace(/^isobot:/, '')}</Chip>)}</>;
}
export function labelTone(label: string): string {
  return { 'isobot:failed': 'bad', 'isobot:review': 'accent', 'isobot:building': 'info', 'isobot:ready': 'ok', 'isobot:proposed': 'warn', 'isobot:ship': 'warn', 'isobot:stop': 'bad' }[label] ?? 'muted';
}

export const SOURCES: Record<SourceKind, { label: string; icon: typeof Activity; hint: string }> = {
  github: { label: 'GitHub', icon: CircleDot, hint: 'Filed on GitHub' },
  discord: { label: 'Discord', icon: MessageSquare, hint: 'A Discord message, via triage' },
  email: { label: 'Email', icon: Mail, hint: 'An email, via triage' },
  vox: { label: 'Vox note', icon: Mic, hint: 'Your Vox.md voice note' },
  appstore: { label: 'App Store review', icon: Star, hint: 'An App Store review, via triage' },
  chat: { label: 'isobot chat', icon: Bot, hint: 'Asked for in the isobot staff chat' },
  content: { label: 'Content train', icon: Newspaper, hint: 'Researched by the content train' },
  release: { label: 'Release train', icon: Rocket, hint: 'Opened by the release train' },
  crash: { label: 'Crash report', icon: Bug, hint: 'A Play, App Store or TestFlight crash, via the crash audit' },
};
export const sourceOf = (item: BoardItem): SourceKind => item.source && item.source.kind in SOURCES ? item.source.kind : 'github';

/** Where the work came from. With `link`, it opens the original message or review when there is one (not inside another link). */
export function SourceChip({ item, link = false }: { item: BoardItem; link?: boolean }) {
  const kind = sourceOf(item);
  const { label, icon: Icon, hint } = SOURCES[kind];
  const body = <><Icon size={11} />{label}</>;
  const title = item.kind === 'pr' && item.closes ? `${hint} (from #${item.closes})` : hint;
  return link && item.source?.url && /^https:\/\//.test(item.source.url)
    ? <a className={`chip source ${kind}`} href={item.source.url} target="_blank" rel="noreferrer" title={`${title}: open the original`} onClick={e => e.stopPropagation()}>{body}<ExternalLink size={10} /></a>
    : <span className={`chip source ${kind}`} title={title}>{body}</span>;
}

export function ItemIcon({ item }: { item: BoardItem }) {
  if (item.kind === 'pr') {
    if (item.merged) return <GitMerge size={15} className="tone-merged" />;
    if (item.state === 'closed') return <GitPullRequestClosed size={15} className="tone-bad" />;
    if (item.draft) return <GitPullRequestDraft size={15} className="tone-muted" />;
    return <GitPullRequest size={15} className="tone-ok" />;
  }
  return item.state === 'open' ? <CircleDot size={15} className="tone-ok" /> : <CircleCheck size={15} className="tone-merged" />;
}

/** The PR sweep's verdict as a chip: what to do about the PR, its reason on hover. */
export const ATTENTION: Record<string, { label: string; tone: string }> = {
  ready: { label: 'merge', tone: 'ok' },
  review: { label: 'review', tone: 'warn' },
  conflicting: { label: 'land: conflicts', tone: 'warn' },
  failing: { label: 'land: CI red', tone: 'bad' },
  duplicate: { label: 'duplicate', tone: 'warn' },
  superseded: { label: 'superseded', tone: 'muted' },
  draft: { label: 'stale draft', tone: 'muted' },
};

/** Open PRs the last sweep says something waits on the owner for (isobot's own review PRs are listed by their issue). */
export const prNeedsYou = (i: BoardItem) => i.kind === 'pr' && i.state === 'open' && Boolean(i.attention?.action) && i.attention?.status !== 'review';

export function AttentionChip({ item }: { item: BoardItem }) {
  const a = item.attention;
  if (!a?.action) return null;
  const known = ATTENTION[a.status] ?? { label: a.status, tone: 'muted' };
  return <span className="attention"><Chip tone={known.tone} title={`${a.reason} → ${a.action}`}>{known.label}</Chip></span>;
}

export function ItemRow({ item, now }: { item: BoardItem; now: number }) {
  const why = item.state === 'open' && item.attention?.action ? ` · ${item.attention.reason} → ${item.attention.action}` : '';
  return (
    <a className="row" href={item.url} target="_blank" rel="noreferrer" {...refAttrs(item.kind, `${item.repo}#${item.number}`, `${short(item.repo)}#${item.number} ${item.title}`)}>
      <ItemIcon item={item} />
      <span className="row-main">
        <span className="row-title">{item.title}</span>
        <span className="row-sub">{short(item.repo)}#{item.number} · {item.author} · {item.state === 'open' ? `opened ${rel(item.createdAt, now)}` : `${item.merged ? 'merged' : 'closed'} ${rel(item.closedAt, now)}`}{why}</span>
      </span>
      <span className="row-chips"><AttentionChip item={item} /><SourceChip item={item} /><Labels labels={item.labels} /></span>
      <span className="row-time" title={full(item.updatedAt)}>{rel(item.updatedAt, now)}</span>
    </a>
  );
}
