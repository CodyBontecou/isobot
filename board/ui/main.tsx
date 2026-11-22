import { createRoot } from 'react-dom/client';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Activity, AlertTriangle, Bug, CalendarClock, CircleDot, CircleCheck, CircleX, ExternalLink, GitMerge, GitPullRequest,
  GitPullRequestClosed, GitPullRequestDraft, Hammer, Inbox, KanbanSquare, LayoutDashboard, ListChecks, LogOut, Mail,
  MessageSquare, Bot, Mic, Newspaper, Pause, RefreshCw, Rocket, Search, Star, TrendingUp, X,
} from 'lucide-react';
import { Growth } from './growth';
import type { Board, BoardEvent, BoardItem, Job, RunnerState, Session, SourceKind, View } from './types';
import './styles.css';

// ---------- URL state (like vercel/board: every filter is a link) ----------

const VIEWS: { id: View; label: string; icon: typeof Activity }[] = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'growth', label: 'Growth', icon: TrendingUp },
  { id: 'tasks', label: 'Tasks', icon: KanbanSquare },
  { id: 'activity', label: 'Activity', icon: Activity },
  { id: 'schedule', label: 'Schedule', icon: CalendarClock },
  { id: 'prs', label: 'Pull requests', icon: GitPullRequest },
  { id: 'issues', label: 'Issues', icon: CircleDot },
  { id: 'jobs', label: 'Jobs', icon: ListChecks },
];

type Params = { view: View; repo: string; q: string; state: string; job: string; source: string; range: string; daily: string; app: string };

function readParams(): Params {
  const p = new URLSearchParams(location.search);
  const view = (p.get('view') ?? 'overview') as View;
  return { view: VIEWS.some(v => v.id === view) ? view : 'overview', repo: p.get('repo') ?? '', q: p.get('q') ?? '', state: p.get('state') ?? '', job: p.get('job') ?? '', source: p.get('source') ?? '', range: p.get('range') ?? '', daily: p.get('daily') ?? '', app: p.get('app') ?? '' };
}

function useParams(): [Params, (next: Partial<Params>, push?: boolean) => void] {
  const [params, setParams] = useState(readParams);
  useEffect(() => {
    const onPop = () => setParams(readParams());
    addEventListener('popstate', onPop);
    return () => removeEventListener('popstate', onPop);
  }, []);
  const update = useCallback((next: Partial<Params>, push = true) => {
    setParams(current => {
      const merged = { ...current, ...next };
      const search = new URLSearchParams();
      for (const [key, value] of Object.entries(merged)) if (value && !(key === 'view' && value === 'overview')) search.set(key, value);
      const url = `${location.pathname}${search.size ? `?${search}` : ''}`;
      if (push) history.pushState(null, '', url); else history.replaceState(null, '', url);
      return merged;
    });
  }, []);
  return [params, update];
}

// ---------- time ----------

function rel(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—';
  const diff = Date.parse(iso) - now;
  const abs = Math.abs(diff);
  const unit = abs < 60_000 ? `${Math.max(1, Math.round(abs / 1000))}s` : abs < 3_600_000 ? `${Math.round(abs / 60_000)}m`
    : abs < 86_400_000 ? `${Math.round(abs / 3_600_000)}h` : `${Math.round(abs / 86_400_000)}d`;
  return diff > 0 ? `in ${unit}` : `${unit} ago`;
}
const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const dayKey = (iso: string) => new Date(iso).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
const full = (iso: string | null | undefined) => iso ? new Date(iso).toLocaleString() : '';
const short = (repo: string) => repo.split('/')[1] ?? repo;

// ---------- data ----------

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', signal, headers: { Accept: 'application/json' } });
  if (response.status === 401) throw new SignedOut();
  if (!response.ok) throw new Error(`${path} answered ${response.status}`);
  return response.json() as Promise<T>;
}
class SignedOut extends Error {}

/** Runner liveness from its newest push: the runner pushes every minute. */
function liveness(runner: RunnerState | undefined, now: number): { label: string; tone: 'ok' | 'warn' | 'bad' } {
  if (!runner) return { label: 'No runner yet', tone: 'bad' };
  const age = now - Date.parse(runner.receivedAt);
  if (age > 10 * 60_000) return { label: `Offline · ${rel(runner.receivedAt, now)}`, tone: 'bad' };
  if (runner.runner.manuallyPaused) return { label: 'Paused', tone: 'warn' };
  if (runner.runner.lastCycleError) return { label: 'Cycle failing', tone: 'bad' };
  if (runner.runner.buildsPausedUntil && Date.parse(runner.runner.buildsPausedUntil) > now) return { label: 'Usage-limit pause', tone: 'warn' };
  if (age > 3 * 60_000) return { label: `Stale · ${rel(runner.receivedAt, now)}`, tone: 'warn' };
  return { label: 'Running', tone: 'ok' };
}

const COLUMNS = [
  { label: 'isobot:proposed', title: 'Proposed', hint: 'Waiting for your ✅' },
  { label: 'isobot:ready', title: 'Ready', hint: 'Approved, queued to build' },
  { label: 'isobot:building', title: 'Building', hint: 'Claimed by the runner' },
  { label: 'isobot:review', title: 'Review', hint: 'PR open, needs your merge' },
  { label: 'isobot:failed', title: 'Failed', hint: 'Needs a look' },
];

const STATE_TONE: Record<string, string> = {
  queued: 'muted', blocked: 'warn', building: 'info', awaiting_ci: 'info', pr_open: 'accent', merged: 'ok', released: 'ok',
  awaiting_ship: 'warn', shipped: 'ok', closed: 'muted', failed: 'bad', stopped: 'muted',
};

// ---------- app ----------

function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [board, setBoard] = useState<Board | null>(null);
  const [events, setEvents] = useState<BoardEvent[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [params, setParams] = useParams();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [b, e] = await Promise.all([getJson<Board>('/api/board'), getJson<{ events: BoardEvent[] }>('/api/events?days=7')]);
      setBoard(b);
      setEvents(e.events);
      setError('');
    } catch (err) {
      if (err instanceof SignedOut) setSession({ authenticated: false, oauthConfigured: true });
      else setError((err as Error).message);
    } finally {
      setLoading(false);
      setNow(Date.now());
    }
  }, []);

  useEffect(() => {
    getJson<Session>('/api/auth/session').then(setSession).catch(() => setSession({ authenticated: false }));
  }, []);
  useEffect(() => {
    if (!session?.authenticated) return;
    void load();
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 30_000);
    const tick = setInterval(() => setNow(Date.now()), 15_000);
    const onVisible = () => { if (document.visibilityState === 'visible') void load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(timer); clearInterval(tick); document.removeEventListener('visibilitychange', onVisible); };
  }, [session?.authenticated, load]);

  if (!session) return <div className="center"><span className="spinner" /></div>;
  if (!session.authenticated) return <SignIn configured={session.oauthConfigured !== false} />;

  const runner = board?.runners[0];
  const items = (board?.github?.items ?? []).filter(i => !params.repo || i.repo === params.repo);
  const jobs = (runner?.jobs ?? []).filter(j => !params.repo || `${j.owner}/${j.repo}` === params.repo);
  const repoEvents = events.filter(e => !params.repo || (e.jobId ?? '').startsWith(`${params.repo}#`));
  const repos = runner?.repos.map(r => r.name) ?? [];
  const live = liveness(runner, now);
  const counts: Partial<Record<View, number>> = {
    tasks: items.filter(i => i.state === 'open' && i.labels.some(l => COLUMNS.some(c => c.label === l))).length,
    prs: items.filter(i => i.kind === 'pr' && i.state === 'open').length,
    issues: items.filter(i => i.kind === 'issue' && i.state === 'open').length,
  };

  const logout = async () => {
    await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin', headers: { 'X-CSRF-Token': session.csrfToken ?? '' } });
    setSession({ authenticated: false, oauthConfigured: true });
  };

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand"><span className={`dot ${live.tone}`} /> isobot</div>
        <nav>
          {VIEWS.map(({ id, label, icon: Icon }) => (
            <a key={id} href={`?view=${id}`} className={params.view === id ? 'active' : ''}
              onClick={e => { e.preventDefault(); setParams({ view: id, state: '', q: '', source: '', app: '' }); }}>
              <Icon size={15} /> <span>{label}</span>{counts[id] ? <em>{counts[id]}</em> : null}
            </a>
          ))}
        </nav>
        <div className="sidebar-section">Repositories</div>
        <div className="repo-list">
          <button className={!params.repo ? 'active' : ''} onClick={() => setParams({ repo: '' })}>All repositories</button>
          {repos.map(name => (
            <button key={name} className={params.repo === name ? 'active' : ''} onClick={() => setParams({ repo: name })}>{short(name)}</button>
          ))}
        </div>
        <div className="sidebar-foot">
          <span title={session.user?.name ?? ''}>{session.user?.login}</span>
          <button className="icon" onClick={logout} title="Sign out"><LogOut size={14} /></button>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <h1>{VIEWS.find(v => v.id === params.view)?.label}{params.repo ? <span className="crumb"> · {short(params.repo)}</span> : null}</h1>
          <div className="topbar-right">
            <span className={`pill ${live.tone}`}><span className={`dot ${live.tone}`} />{live.label}</span>
            {runner ? <span className="meta" title={full(runner.receivedAt)}>{runner.runnerId} · updated {rel(runner.receivedAt, now)}</span> : null}
            <button className="icon" onClick={() => void load()} title="Refresh" disabled={loading}><RefreshCw size={14} className={loading ? 'spin' : ''} /></button>
          </div>
        </header>
        {error ? <div className="banner bad"><AlertTriangle size={14} /> {error}</div> : null}
        {board?.github?.errors.length ? <div className="banner warn"><AlertTriangle size={14} /> GitHub: {board.github.errors.join('; ')}</div> : null}
        {!board ? <div className="center"><span className="spinner" /></div>
          : !runner ? <Empty title="No runner has reported yet" body="Set ISOBOT_BOARD_URL and ISOBOT_BOARD_TOKEN in runner.env and restart the runner." />
          : <div className="content">
              {params.view === 'overview' && <Overview runner={runner} items={items} jobs={jobs} events={repoEvents} now={now} open={job => setParams({ job })} go={view => setParams({ view })} goSource={source => setParams({ view: 'issues', state: 'open', source, q: '' })} />}
              {params.view === 'growth' && <Growth repo={params.repo} range={params.range} setRange={range => setParams({ range: range === '90' ? '' : range })}
                daily={params.daily === '1'} setDaily={daily => setParams({ daily: daily ? '1' : '' })} app={params.app} setApp={app => setParams({ app }, false)} />}
              {params.view === 'tasks' && <Tasks items={items} jobs={jobs} now={now} open={job => setParams({ job })} />}
              {params.view === 'activity' && <ActivityView events={repoEvents} source={params.state} setSource={state => setParams({ state })} q={params.q} setQ={q => setParams({ q }, false)} open={job => setParams({ job })} />}
              {params.view === 'schedule' && <Schedule runner={runner} now={now} open={job => setParams({ job })} />}
              {params.view === 'prs' && <Items kind="pr" items={items} source={params.source} setSource={source => setParams({ source })} state={params.state || 'open'} setState={state => setParams({ state })} q={params.q} setQ={q => setParams({ q }, false)} now={now} githubAt={board.github?.at} />}
              {params.view === 'issues' && <Items kind="issue" items={items} source={params.source} setSource={source => setParams({ source })} state={params.state || 'open'} setState={state => setParams({ state })} q={params.q} setQ={q => setParams({ q }, false)} now={now} githubAt={board.github?.at} />}
              {params.view === 'jobs' && <Jobs jobs={jobs} q={params.q} setQ={q => setParams({ q }, false)} now={now} open={job => setParams({ job })} />}
            </div>}
      </main>

      {params.job && runner ? <JobPane id={params.job} runner={runner} items={board?.github?.items ?? []} now={now} close={() => setParams({ job: '' })} /> : null}
    </div>
  );
}

// ---------- sign in ----------

function SignIn({ configured }: { configured: boolean }) {
  const code = new URLSearchParams(location.search).get('authError');
  const messages: Record<string, string> = {
    not_configured: 'GitHub sign-in is not configured for the board yet.',
    invalid_state: 'That sign-in link expired. Try again.',
    denied: 'GitHub sign-in was cancelled.',
    not_allowed: 'This GitHub account can’t open the board.',
    login_failed: 'GitHub sign-in could not finish. Try again.',
  };
  return (
    <div className="center">
      <div className="signin">
        <div className="brand big"><span className="dot ok" /> isobot</div>
        <p>The runner’s queue, schedule and work across your repositories.</p>
        {code ? <div className="banner bad">{messages[code] ?? 'Sign-in failed.'}</div> : null}
        {configured ? <a className="button primary" href="/auth/github/login">Continue with GitHub</a>
          : <div className="banner warn">{messages.not_configured}</div>}
      </div>
    </div>
  );
}

// ---------- shared bits ----------

function Empty({ title, body }: { title: string; body?: string }) {
  return <div className="empty"><Inbox size={20} /><strong>{title}</strong>{body ? <span>{body}</span> : null}</div>;
}

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return <section className="section"><div className="section-head"><h2>{title}</h2>{action}</div>{children}</section>;
}

function Chip({ tone = 'muted', children, title }: { tone?: string; children: ReactNode; title?: string }) {
  return <span className={`chip ${tone}`} title={title}>{children}</span>;
}

function JobLink({ id, open }: { id: string; open: (id: string) => void }) {
  return <button className="joblink" onClick={() => open(id)}>{short(id.split('#')[0])}#{id.split('#')[1]}</button>;
}

function SearchBox({ q, setQ, placeholder }: { q: string; setQ: (q: string) => void; placeholder: string }) {
  return <label className="search"><Search size={14} /><input value={q} onChange={e => setQ(e.target.value)} placeholder={placeholder} />{q ? <button className="icon" onClick={() => setQ('')}><X size={12} /></button> : null}</label>;
}

function Labels({ labels }: { labels: string[] }) {
  return <>{labels.map(l => <Chip key={l} tone={l.startsWith('isobot:') ? labelTone(l) : 'muted'}>{l.replace(/^isobot:/, '')}</Chip>)}</>;
}
function labelTone(label: string): string {
  return { 'isobot:failed': 'bad', 'isobot:review': 'accent', 'isobot:building': 'info', 'isobot:ready': 'ok', 'isobot:proposed': 'warn', 'isobot:ship': 'warn', 'isobot:stop': 'bad' }[label] ?? 'muted';
}

const SOURCES: Record<SourceKind, { label: string; icon: typeof Activity; hint: string }> = {
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
const sourceOf = (item: BoardItem): SourceKind => item.source && item.source.kind in SOURCES ? item.source.kind : 'github';

/** Where the work came from. With `link`, it opens the original message or review when there is one (not inside another link). */
function SourceChip({ item, link = false }: { item: BoardItem; link?: boolean }) {
  const kind = sourceOf(item);
  const { label, icon: Icon, hint } = SOURCES[kind];
  const body = <><Icon size={11} />{label}</>;
  const title = item.kind === 'pr' && item.closes ? `${hint} (from #${item.closes})` : hint;
  return link && item.source?.url && /^https:\/\//.test(item.source.url)
    ? <a className={`chip source ${kind}`} href={item.source.url} target="_blank" rel="noreferrer" title={`${title}: open the original`} onClick={e => e.stopPropagation()}>{body}<ExternalLink size={10} /></a>
    : <span className={`chip source ${kind}`} title={title}>{body}</span>;
}

function ItemIcon({ item }: { item: BoardItem }) {
  if (item.kind === 'pr') {
    if (item.merged) return <GitMerge size={15} className="tone-merged" />;
    if (item.state === 'closed') return <GitPullRequestClosed size={15} className="tone-bad" />;
    if (item.draft) return <GitPullRequestDraft size={15} className="tone-muted" />;
    return <GitPullRequest size={15} className="tone-ok" />;
  }
  return item.state === 'open' ? <CircleDot size={15} className="tone-ok" /> : <CircleCheck size={15} className="tone-merged" />;
}

function ItemRow({ item, now }: { item: BoardItem; now: number }) {
  return (
    <a className="row" href={item.url} target="_blank" rel="noreferrer">
      <ItemIcon item={item} />
      <span className="row-main">
        <span className="row-title">{item.title}</span>
        <span className="row-sub">{short(item.repo)}#{item.number} · {item.author} · {item.state === 'open' ? `opened ${rel(item.createdAt, now)}` : `${item.merged ? 'merged' : 'closed'} ${rel(item.closedAt, now)}`}</span>
      </span>
      <span className="row-chips"><SourceChip item={item} /><Labels labels={item.labels} /></span>
      <span className="row-time" title={full(item.updatedAt)}>{rel(item.updatedAt, now)}</span>
    </a>
  );
}

// ---------- overview ----------

function Overview({ runner, items, jobs, events, now, open, go, goSource }: { runner: RunnerState; items: BoardItem[]; jobs: Job[]; events: BoardEvent[]; now: number; open: (id: string) => void; go: (v: View) => void; goSource: (kind: SourceKind) => void }) {
  const needs = items.filter(i => i.state === 'open' && i.labels.some(l => ['isobot:review', 'isobot:failed', 'isobot:proposed'].includes(l)));
  const shipping = jobs.filter(j => j.state === 'awaiting_ship');
  const active = runner.runner.activeJobs.map(id => jobs.find(j => j.id === id) ?? runner.jobs.find(j => j.id === id)).filter(Boolean) as Job[];
  const today = new Date().toDateString();
  const todays = events.filter(e => new Date(e.at).toDateString() === today);
  const mergedToday = jobs.filter(j => ['merged', 'released', 'shipped'].includes(j.state) && new Date(j.updatedAt).toDateString() === today).length;
  const openIssues = items.filter(i => i.kind === 'issue' && i.state === 'open');
  const bySource = (Object.keys(SOURCES) as SourceKind[]).map(kind => ({ kind, count: openIssues.filter(i => sourceOf(i) === kind).length })).filter(s => s.count)
    .sort((a, b) => b.count - a.count);
  const upcoming = [...runner.schedule].filter(s => s.nextAt || s.running)
    .sort((a, b) => (a.running ? 0 : Date.parse(a.nextAt!)) - (b.running ? 0 : Date.parse(b.nextAt!))).slice(0, 6);

  return (
    <>
      <div className="stats">
        <Stat label="Building" value={runner.runner.activeJobs.length} icon={<Hammer size={14} />} onClick={() => go('jobs')} />
        <Stat label="Queued" value={runner.runner.queued} icon={<ListChecks size={14} />} onClick={() => go('jobs')} />
        <Stat label="Needs you" value={needs.length + shipping.length} tone={needs.length + shipping.length ? 'warn' : undefined} icon={<Inbox size={14} />} onClick={() => go('tasks')} />
        <Stat label="Open PRs" value={items.filter(i => i.kind === 'pr' && i.state === 'open').length} icon={<GitPullRequest size={14} />} onClick={() => go('prs')} />
        <Stat label="Merged today" value={mergedToday} icon={<GitMerge size={14} />} onClick={() => go('jobs')} />
        <Stat label="Events today" value={todays.length} icon={<Activity size={14} />} onClick={() => go('activity')} />
      </div>
      {runner.runner.lastCycleError ? <div className="banner bad"><AlertTriangle size={14} /> Cycle failing: {runner.runner.lastCycleError}</div> : null}
      {runner.runner.manuallyPaused ? <div className="banner warn"><Pause size={14} /> The runner is paused (<code>runner resume</code> to continue).</div> : null}

      <div className="grid">
        <Section title="Needs you">
          {needs.length + shipping.length === 0 ? <Empty title="Nothing waiting on you" /> : <div className="list">
            {shipping.map(j => <button key={j.id} className="row" onClick={() => open(j.id)}><CircleDot size={15} className="tone-warn" /><span className="row-main"><span className="row-title">{j.title}</span><span className="row-sub">{short(j.repo)}#{j.number} · waiting for isobot:ship</span></span><Chip tone="warn">ship</Chip></button>)}
            {needs.map(i => <ItemRow key={`${i.repo}#${i.number}`} item={i} now={now} />)}
          </div>}
        </Section>

        <Section title="Building now">
          {active.length === 0 ? <Empty title="Idle" body={runner.runner.queued ? `${runner.runner.queued} queued` : 'Nothing queued'} /> : <div className="list">
            {active.map(j => {
              const latest = events.find(e => e.jobId === j.id);
              return <button key={j.id} className="row" onClick={() => open(j.id)}><span className="spinner small" /><span className="row-main"><span className="row-title">{j.title}</span><span className="row-sub">{short(j.repo)}#{j.number}{latest ? ` · ${latest.text}` : ''}</span></span><span className="row-time">{rel(latest?.at ?? j.updatedAt, now)}</span></button>;
            })}
          </div>}
        </Section>

        <Section title="Coming up" action={<button className="link" onClick={() => go('schedule')}>Schedule →</button>}>
          <div className="list">
            {upcoming.map(s => <div key={s.id} className="row static"><CalendarClock size={15} className="tone-muted" /><span className="row-main"><span className="row-title">{s.name}</span><span className="row-sub">{s.cadence}{s.detail ? ` · ${s.detail}` : ''}</span></span>{s.running ? <Chip tone="info">running</Chip> : <span className="row-time" title={full(s.nextAt)}>{rel(s.nextAt, now)}</span>}</div>)}
          </div>
        </Section>

        <Section title="Open issues by source" action={<button className="link" onClick={() => go('issues')}>Issues →</button>}>
          {bySource.length === 0 ? <Empty title="No open issues" /> : <div className="list">
            {bySource.map(({ kind, count }) => {
              const { label, icon: Icon, hint } = SOURCES[kind];
              return <button key={kind} className="row" onClick={() => goSource(kind)}><Icon size={15} className="tone-muted" /><span className="row-main"><span className="row-title">{label}</span><span className="row-sub">{hint}</span></span><span className="source-bar" style={{ width: `${Math.max(4, Math.round(count / openIssues.length * 80))}px` }} /><span className="row-time">{count}</span></button>;
            })}
          </div>}
        </Section>

        <Section title="Today" action={<button className="link" onClick={() => go('activity')}>Activity →</button>}>
          {todays.length === 0 ? <Empty title="No activity yet today" /> : <Timeline events={todays.slice(0, 14)} open={open} compact />}
        </Section>
      </div>
    </>
  );
}

function Stat({ label, value, icon, tone, onClick }: { label: string; value: number; icon: ReactNode; tone?: string; onClick?: () => void }) {
  return <button className={`stat ${tone ?? ''}`} onClick={onClick}><span className="stat-label">{icon}{label}</span><span className="stat-value">{value}</span></button>;
}

// ---------- tasks (the label queue as a board) ----------

function Tasks({ items, jobs, now, open }: { items: BoardItem[]; jobs: Job[]; now: number; open: (id: string) => void }) {
  const weekAgo = now - 7 * 86_400_000;
  const done = jobs.filter(j => ['merged', 'released', 'shipped'].includes(j.state) && Date.parse(j.updatedAt) > weekAgo);
  return (
    <div className="kanban">
      {COLUMNS.map(column => {
        const cards = items.filter(i => i.state === 'open' && i.labels.includes(column.label));
        return (
          <div key={column.label} className="column">
            <div className="column-head"><Chip tone={labelTone(column.label)}>{column.title}</Chip><em>{cards.length}</em></div>
            <div className="column-hint">{column.hint}</div>
            {cards.map(i => {
              const jobId = `${i.repo}#${i.number}`;
              const job = jobs.find(j => `${j.owner}/${j.repo}#${j.number}`.toLowerCase() === jobId.toLowerCase());
              return (
                <div key={jobId} className="card">
                  <a href={i.url} target="_blank" rel="noreferrer" className="card-title">{i.title}</a>
                  <div className="card-meta">
                    <span>{short(i.repo)}#{i.number}</span>
                    <span title={full(i.updatedAt)}>{rel(i.updatedAt, now)}</span>
                  </div>
                  <div className="card-source"><SourceChip item={i} link /></div>
                  {job ? <button className="card-job" onClick={() => open(job.id)}><Chip tone={STATE_TONE[job.state]}>{job.state.replace('_', ' ')}</Chip> timeline →</button> : null}
                </div>
              );
            })}
          </div>
        );
      })}
      <div className="column">
        <div className="column-head"><Chip tone="ok">Done</Chip><em>{done.length}</em></div>
        <div className="column-hint">Merged in the last 7 days</div>
        {done.map(j => (
          <button key={j.id} className="card" onClick={() => open(j.id)}>
            <span className="card-title">{j.title}</span>
            <div className="card-meta"><span>{short(j.repo)}#{j.number}</span><span>{rel(j.updatedAt, now)}</span></div>
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------- activity ----------

function Timeline({ events, open, compact = false }: { events: BoardEvent[]; open: (id: string) => void; compact?: boolean }) {
  const groups = useMemo(() => {
    const map = new Map<string, BoardEvent[]>();
    for (const e of events) {
      const key = dayKey(e.at);
      map.set(key, [...(map.get(key) ?? []), e]);
    }
    return [...map];
  }, [events]);
  return (
    <div className="timeline">
      {groups.map(([day, list]) => (
        <div key={day}>
          {compact ? null : <div className="day">{day} <em>{list.length}</em></div>}
          {list.map(e => (
            <div key={`${e.runner}:${e.id}`} className="event">
              <span className="event-time" title={full(e.at)}>{clock(e.at)}</span>
              <span className="event-job">{e.jobId ? <JobLink id={e.jobId} open={open} /> : <span className="tone-muted">runner</span>}</span>
              <span className={`event-text ${/fail|error|refused/i.test(e.text) ? 'tone-bad' : /merged|released|shipped|passed/i.test(e.text) ? 'tone-ok' : ''}`}>{e.text}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function ActivityView({ events, source, setSource, q, setQ, open }: { events: BoardEvent[]; source: string; setSource: (s: string) => void; q: string; setQ: (q: string) => void; open: (id: string) => void }) {
  const needle = q.toLowerCase();
  // Runner-level events (ASO, analytics, triage) can drown out job work, so they can be split off.
  const sources = [{ id: '', label: 'All', test: () => true }, { id: 'jobs', label: 'Jobs', test: (e: BoardEvent) => e.jobId !== null }, { id: 'runner', label: 'Runner', test: (e: BoardEvent) => e.jobId === null }];
  const tab = sources.find(s => s.id === source) ?? sources[0];
  const shown = events.filter(tab.test).filter(e => !needle || `${e.jobId ?? 'runner'} ${e.kind} ${e.text}`.toLowerCase().includes(needle));
  return (
    <>
      <div className="toolbar"><div className="tabs">{sources.map(s => <button key={s.id} className={s.id === tab.id ? 'active' : ''} onClick={() => setSource(s.id)}>{s.label} <em>{events.filter(s.test).length}</em></button>)}</div><SearchBox q={q} setQ={setQ} placeholder="Filter events…" /><span className="meta">{shown.length} events · last 7 days</span></div>
      {shown.length ? <Section title=""><Timeline events={shown} open={open} /></Section> : <Empty title="No events" />}
    </>
  );
}

// ---------- schedule ----------

function Schedule({ runner, now, open }: { runner: RunnerState; now: number; open: (id: string) => void }) {
  return (
    <>
      <Section title="Scheduled work">
        <table className="table">
          <thead><tr><th>Task</th><th>Cadence</th><th>Last run</th><th>Next</th><th /></tr></thead>
          <tbody>
            {runner.schedule.map(s => (
              <tr key={s.id}>
                <td><strong>{s.name}</strong>{s.detail ? <div className="sub">{s.detail}</div> : null}</td>
                <td>{s.cadence}</td>
                <td title={full(s.lastAt)}>{s.lastAt ? rel(s.lastAt, now) : <span className="tone-muted">since start</span>}</td>
                <td title={full(s.nextAt)}>{s.running ? '—' : rel(s.nextAt, now)}</td>
                <td>{s.running ? <Chip tone="info">running</Chip> : <Chip>scheduled</Chip>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="footnote">Loop tasks count from the runner’s start ({rel(runner.runner.startedAt, now)}); trains, content and ASO also apply their own hours, weekday and credit limits.</p>
      </Section>
      <Section title="Follow-ups">
        {runner.followUps.length === 0 ? <Empty title="No follow-ups pending" /> : (
          <table className="table">
            <thead><tr><th>Job</th><th>Waiting for</th><th>Since</th><th>Next check</th></tr></thead>
            <tbody>{runner.followUps.map(f => (
              <tr key={`${f.jobId}:${f.kind}`}><td><JobLink id={f.jobId} open={open} /></td><td>{f.text}</td><td>{rel(f.createdAt, now)}</td><td>{rel(f.dueAt, now)}</td></tr>
            ))}</tbody>
          </table>
        )}
      </Section>
    </>
  );
}

// ---------- PRs and issues ----------

function Items({ kind, items, source, setSource, state, setState, q, setQ, now, githubAt }: { kind: 'pr' | 'issue'; items: BoardItem[]; source: string; setSource: (s: string) => void; state: string; setState: (s: string) => void; q: string; setQ: (q: string) => void; now: number; githubAt?: string }) {
  const own = items.filter(i => i.kind === kind);
  const tabs = kind === 'pr'
    ? [{ id: 'open', label: 'Open', test: (i: BoardItem) => i.state === 'open' }, { id: 'merged', label: 'Merged', test: (i: BoardItem) => i.merged }, { id: 'closed', label: 'Closed', test: (i: BoardItem) => i.state === 'closed' && !i.merged }]
    : [{ id: 'open', label: 'Open', test: (i: BoardItem) => i.state === 'open' }, { id: 'closed', label: 'Closed', test: (i: BoardItem) => i.state === 'closed' }];
  const tab = tabs.find(t => t.id === state) ?? tabs[0];
  const needle = q.toLowerCase();
  const inTab = own.filter(tab.test);
  const kinds = (Object.keys(SOURCES) as SourceKind[]).map(k => ({ kind: k, count: inTab.filter(i => sourceOf(i) === k).length })).filter(k => k.count || k.kind === source);
  const shown = inTab.filter(i => !source || sourceOf(i) === source).filter(i => !needle || `${i.repo}#${i.number} ${i.title} ${i.author} ${i.labels.join(' ')} ${SOURCES[sourceOf(i)].label}`.toLowerCase().includes(needle))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return (
    <>
      <div className="toolbar">
        <div className="tabs">{tabs.map(t => <button key={t.id} className={t.id === tab.id ? 'active' : ''} onClick={() => setState(t.id)}>{t.label} <em>{own.filter(t.test).length}</em></button>)}</div>
        <label className="select" title="Where the work came from">
          <select value={source} onChange={e => setSource(e.target.value)} aria-label="Source">
            <option value="">All sources ({inTab.length})</option>
            {kinds.map(k => <option key={k.kind} value={k.kind}>{SOURCES[k.kind].label} ({k.count})</option>)}
          </select>
        </label>
        <SearchBox q={q} setQ={setQ} placeholder="Filter by title, label, author, source…" />
        <span className="meta" title={full(githubAt)}>GitHub {rel(githubAt, now)}{tab.id !== 'open' ? ' · last 14 days' : ''}</span>
      </div>
      {shown.length ? <div className="list boxed">{shown.map(i => <ItemRow key={`${i.repo}#${i.number}`} item={i} now={now} />)}</div> : <Empty title={`No ${tab.label.toLowerCase()} ${kind === 'pr' ? 'pull requests' : 'issues'}`} />}
    </>
  );
}

// ---------- jobs ----------

function Jobs({ jobs, q, setQ, now, open }: { jobs: Job[]; q: string; setQ: (q: string) => void; now: number; open: (id: string) => void }) {
  const needle = q.toLowerCase();
  const shown = jobs.filter(j => !needle || `${j.id} ${j.title} ${j.state} ${j.kind}`.toLowerCase().includes(needle));
  return (
    <>
      <div className="toolbar"><SearchBox q={q} setQ={setQ} placeholder="Filter jobs…" /><span className="meta">{shown.length} of the runner’s latest {jobs.length} jobs</span></div>
      <table className="table clickable">
        <thead><tr><th>State</th><th>Job</th><th>Kind</th><th>Attempts</th><th>PR</th><th>Updated</th></tr></thead>
        <tbody>{shown.map(j => (
          <tr key={j.id} onClick={() => open(j.id)}>
            <td><Chip tone={STATE_TONE[j.state]}>{j.state.replace('_', ' ')}</Chip></td>
            <td><strong>{j.title}</strong><div className="sub">{j.id}{j.lastError ? <span className="tone-bad"> · {j.lastError.split('\n')[0]}</span> : null}</div></td>
            <td>{j.kind}</td>
            <td>{j.attempts}</td>
            <td>{j.prNumber ? <a href={`https://github.com/${j.owner}/${j.repo}/pull/${j.prNumber}`} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()}>#{j.prNumber}</a> : '—'}</td>
            <td title={full(j.updatedAt)}>{rel(j.updatedAt, now)}</td>
          </tr>
        ))}</tbody>
      </table>
    </>
  );
}

// ---------- job pane ----------

function JobPane({ id, runner, items, now, close }: { id: string; runner: RunnerState; items: BoardItem[]; now: number; close: () => void }) {
  const [events, setEvents] = useState<BoardEvent[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setEvents(null);
    getJson<{ events: BoardEvent[] }>(`/api/events?days=30&job=${encodeURIComponent(id)}`, controller.signal)
      .then(r => setEvents(r.events)).catch(err => { if (!controller.signal.aborted) setError((err as Error).message); });
    return () => controller.abort();
  }, [id, runner.receivedAt]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [close]);
  const job = runner.jobs.find(j => j.id === id);
  const [repo, number] = id.split('#');
  const issue = items.find(i => i.repo.toLowerCase() === repo.toLowerCase() && i.number === Number(number));
  const followUps = runner.followUps.filter(f => f.jobId === id);
  return (
    <>
      <div className="scrim" onClick={close} />
      <aside className="pane" aria-label={`Job ${id}`}>
        <div className="pane-head">
          <div>
            <div className="meta">{id}</div>
            <h2>{job?.title ?? issue?.title ?? id}</h2>
          </div>
          <button className="icon" onClick={close} title="Close"><X size={16} /></button>
        </div>
        <div className="pane-facts">
          {job ? <Chip tone={STATE_TONE[job.state]}>{job.state.replace('_', ' ')}</Chip> : null}
          {job ? <span className="meta">{job.kind} · attempt {job.attempts} · updated {rel(job.updatedAt, now)}</span> : null}
          <a className="button" href={`https://github.com/${repo}/issues/${number}`} target="_blank" rel="noreferrer">Issue <ExternalLink size={12} /></a>
          {job?.prNumber ? <a className="button" href={`https://github.com/${repo}/pull/${job.prNumber}`} target="_blank" rel="noreferrer">PR #{job.prNumber} <ExternalLink size={12} /></a> : null}
        </div>
        {issue ? <div className="pane-labels"><SourceChip item={issue} link /><Labels labels={issue.labels} /></div> : null}
        {job?.lastError ? <div className="banner bad"><CircleX size={14} /> {job.lastError}</div> : null}
        {followUps.map(f => <div key={f.kind} className="banner info"><CalendarClock size={14} /> {f.text} · next check {rel(f.dueAt, now)}</div>)}
        <h3>Timeline</h3>
        {error ? <div className="banner bad">{error}</div> : events === null ? <span className="spinner" /> : events.length === 0 ? <Empty title="No events in the last 30 days" />
          : <div className="timeline">{events.map(e => (
              <div key={`${e.runner}:${e.id}`} className="event pane-event">
                <span className="event-time" title={full(e.at)}>{new Date(e.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                <span className={`event-text ${/fail|error|refused/i.test(e.text) ? 'tone-bad' : /merged|released|shipped|passed/i.test(e.text) ? 'tone-ok' : ''}`}>{e.text}</span>
              </div>
            ))}</div>}
      </aside>
    </>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
