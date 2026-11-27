import { useEffect, useMemo, useState } from 'react';
import { Bug, ExternalLink, FlaskConical, History, Inbox, Lightbulb, ListChecks, Mic, NotebookPen, Sparkles, Square, SquareCheck, StickyNote, Target, X } from 'lucide-react';
import { Chip, Empty, full, refAttrs, rel, SearchBox, Section } from './common';
import { Inline, Markdown, type LocalLink } from './agent';
import type { BoardItem, Vox as VoxData, VoxAction, VoxNote } from './types';

/**
 * Vox: the owner's voice notes as the vox-inbox task files them in ~/dev/vox-notebook (ideas, bugs, goals,
 * theories…), with the action checklist, recurring themes and what needs the owner. Data comes from /api/vox
 * (runner/src/voxNotebook.ts); journal entries and places never leave the runner's machine.
 */

const KINDS: { id: string; label: string; one: string; icon: typeof Mic }[] = [
  { id: 'idea', label: 'Ideas', one: 'Idea', icon: Lightbulb },
  { id: 'bug', label: 'Bugs', one: 'Bug', icon: Bug },
  { id: 'goal', label: 'Goals', one: 'Goal', icon: Target },
  { id: 'theory', label: 'Theories', one: 'Theory', icon: FlaskConical },
  { id: 'history', label: 'History', one: 'History', icon: History },
  { id: 'misc', label: 'Misc', one: 'Misc', icon: StickyNote },
];
const kindOf = (id: string) => KINDS.find(k => k.id === id) ?? { id, label: id, one: id, icon: NotebookPen };

const STATUSES = [
  { id: '', label: 'Active', test: (n: VoxNote) => n.status !== 'done' && n.status !== 'parked' },
  { id: 'in-progress', label: 'In progress', test: (n: VoxNote) => n.status === 'in-progress' },
  { id: 'parked', label: 'Parked', test: (n: VoxNote) => n.status === 'parked' },
  { id: 'done', label: 'Done', test: (n: VoxNote) => n.status === 'done' },
  { id: 'all', label: 'All', test: () => true },
];
const STATUS_TONE: Record<string, string> = { open: 'info', 'in-progress': 'accent', done: 'ok', parked: 'muted' };

const TABS = [
  { id: '', label: 'Notes' },
  { id: 'actions', label: 'Actions' },
  { id: 'themes', label: 'Themes' },
  { id: 'review', label: 'Needs you' },
] as const;

export interface VoxParams { tab: string; kind: string; project: string; status: string; q: string; note: string }

/** `owner/repo` → the notebook's project name for it (`vox.md`, `health-md`). */
const projectOfRepo = (repo: string) => (repo.split('/')[1] ?? repo).toLowerCase();

export function Vox({ repo, items, now, params, set }: {
  repo: string; items: BoardItem[]; now: number; params: VoxParams; set: (next: Partial<VoxParams>, push?: boolean) => void;
}) {
  const [vox, setVox] = useState<VoxData | null | undefined>(undefined);
  const [error, setError] = useState('');
  useEffect(() => {
    let stop = false;
    const load = () => fetch('/api/vox', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(async r => { if (!r.ok) throw new Error(`/api/vox answered ${r.status}`); return r.json() as Promise<{ vox: VoxData | null }>; })
      .then(body => { if (!stop) { setVox(body.vox); setError(''); } })
      .catch(err => { if (!stop) setError((err as Error).message); });
    void load();
    // The runner reads the notebook every 5 minutes and sends it when it changed.
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 2 * 60_000);
    return () => { stop = true; clearInterval(timer); };
  }, []);

  const byPath = useMemo(() => new Map((vox?.notes ?? []).map(n => [n.path, n])), [vox]);
  const local = (base: string): LocalLink => target => {
    const p = resolvePath(base, target);
    return byPath.has(p) ? { href: `?view=vox&note=${encodeURIComponent(p)}`, onClick: () => set({ note: p }) } : null;
  };

  if (error && !vox) return <div className="banner bad">{error}</div>;
  if (vox === undefined) return <div className="center small"><span className="spinner" /></div>;
  if (vox === null) return <div className="empty"><Mic size={20} /><strong>No Vox notebook yet</strong><span>The runner sends ~/dev/vox-notebook (vox.notebook in its config) with its next push once it runs a version with the Vox view.</span></div>;

  // The sidebar's repository narrows to notes about that project ("all apps" notes stay).
  const repoProject = repo ? projectOfRepo(repo) : '';
  const inRepo = (projects: string[]) => !repoProject || projects.some(p => p.toLowerCase() === repoProject || p.toLowerCase() === 'all apps');
  const notes = vox.notes.filter(n => inRepo(n.projects));
  const actions = vox.actions.filter(a => !repoProject || a.project.toLowerCase() === repoProject
    || a.notes.some(p => inRepo(byPath.get(p)?.projects ?? [])));
  const openActions = actions.filter(a => !a.done);
  const active = notes.filter(STATUSES[0].test);
  const newest = vox.notes.reduce<string | null>((max, n) => n.captured && (!max || n.captured > max) ? n.captured : max, null);
  const tab = TABS.find(t => t.id === params.tab) ?? TABS[0];
  const counts: Record<string, number> = { '': active.length, actions: openActions.length, themes: vox.themes.length, review: vox.review.length };
  const note = params.note ? byPath.get(params.note) : undefined;

  return (
    <>
      <div className="stats vox-stats">
        <button className="stat" onClick={() => set({ tab: '', kind: '', status: '' })}><span className="stat-label"><NotebookPen size={13} /> Active notes</span><span className="stat-value">{active.length}</span></button>
        <button className="stat" onClick={() => set({ tab: '', kind: 'idea', status: '' })}><span className="stat-label"><Lightbulb size={13} /> Ideas</span><span className="stat-value">{active.filter(n => n.kind === 'idea').length}</span></button>
        <button className="stat" onClick={() => set({ tab: '', kind: 'bug', status: '' })}><span className="stat-label"><Bug size={13} /> Bugs</span><span className="stat-value">{active.filter(n => n.kind === 'bug').length}</span></button>
        <button className="stat" onClick={() => set({ tab: 'actions' })}><span className="stat-label"><ListChecks size={13} /> Open actions</span><span className="stat-value">{openActions.length}</span></button>
        <button className={`stat ${vox.review.length ? 'warn' : ''}`} onClick={() => set({ tab: 'review' })}><span className="stat-label"><Inbox size={13} /> Needs you</span><span className="stat-value">{vox.review.length}</span></button>
        <div className="stat" title={full(newest)}><span className="stat-label"><Mic size={13} /> Last capture</span><span className="stat-value small">{newest ? rel(newest, now) : '—'}</span></div>
      </div>

      <div className="toolbar">
        <div className="tabs">{TABS.map(t => <button key={t.id} className={t.id === tab.id ? 'active' : ''} onClick={() => set({ tab: t.id })}>{t.label} <em>{counts[t.id]}</em></button>)}</div>
        <span className="meta" title={full(vox.at)}>notebook read {rel(vox.at, now)}{vox.privateCount ? ` · ${vox.privateCount} journal ${vox.privateCount === 1 ? 'entry' : 'entries'} kept on the Mac` : ''}</span>
      </div>

      {tab.id === '' && <Notes notes={notes} items={items} now={now} params={params} set={set} />}
      {tab.id === 'actions' && <Actions actions={actions} byPath={byPath} items={items} open={path => set({ note: path })} local={local('ACTIONS.md')} />}
      {tab.id === 'themes' && (vox.themes.length
        ? <div className="vox-themes">{vox.themes.map(t => <Section key={t.title} title={t.title}><div className="vox-prose"><Markdown text={unwrap(t.body)} local={local('THEMES.md')} /></div></Section>)}</div>
        : <Empty title="No themes yet" body="THEMES.md fills in as captures repeat the same goals." />)}
      {tab.id === 'review' && <Review vox={vox} now={now} local={local('INBOX-REVIEW.md')} />}

      {note ? <NotePane note={note} actions={vox.actions.filter(a => a.notes.includes(note.path))} items={items} now={now} local={local(note.path)} close={() => set({ note: '' })} /> : null}
    </>
  );
}

// ---------- notes ----------

function Notes({ notes, items, now, params, set }: { notes: VoxNote[]; items: BoardItem[]; now: number; params: VoxParams; set: (next: Partial<VoxParams>, push?: boolean) => void }) {
  const status = STATUSES.find(s => s.id === params.status) ?? STATUSES[0];
  const inStatus = notes.filter(status.test);
  const projects = [...new Set(notes.flatMap(n => n.projects))].sort((a, b) => a.localeCompare(b));
  const inProject = inStatus.filter(n => !params.project || n.projects.includes(params.project));
  const kinds = KINDS.filter(k => notes.some(n => n.kind === k.id) || k.id === params.kind);
  const needle = params.q.toLowerCase();
  const shown = inProject.filter(n => !params.kind || n.kind === params.kind)
    .filter(n => !needle || `${n.title} ${n.projects.join(' ')} ${n.body} ${n.source ?? ''}`.toLowerCase().includes(needle));
  const days = groupByDay(shown);
  return (
    <>
      <div className="toolbar">
        <div className="tabs">
          <button className={!params.kind ? 'active' : ''} onClick={() => set({ kind: '' })}>All <em>{inProject.length}</em></button>
          {kinds.map(({ id, label, icon: Icon }) => (
            <button key={id} className={params.kind === id ? 'active' : ''} onClick={() => set({ kind: id })}><Icon size={13} />{label} <em>{inProject.filter(n => n.kind === id).length}</em></button>
          ))}
        </div>
        <label className="select"><select value={status.id} onChange={e => set({ status: e.target.value })} aria-label="Status">
          {STATUSES.map(s => <option key={s.id} value={s.id}>{s.label} ({notes.filter(s.test).length})</option>)}
        </select></label>
        <label className="select"><select value={params.project} onChange={e => set({ project: e.target.value })} aria-label="Project">
          <option value="">All projects</option>
          {projects.map(p => <option key={p} value={p}>{p} ({inStatus.filter(n => n.projects.includes(p)).length})</option>)}
        </select></label>
        <SearchBox q={params.q} setQ={q => set({ q }, false)} placeholder="Search notes…" />
      </div>
      {shown.length ? (
        <div className="list boxed">
          {days.map(([day, list]) => (
            <div key={day} className="vox-day">
              <div className="vox-day-head">{dayHeading(day, now)}<em>{list.length}</em></div>
              {list.map(n => <NoteRow key={n.path} note={n} items={items} now={now} open={() => set({ note: n.path })} />)}
            </div>
          ))}
        </div>
      ) : <Empty title="No notes match" body={params.q || params.kind || params.project ? 'Clear a filter to see more.' : 'New captures show up here once the vox-inbox task files them.'} />}
    </>
  );
}

function NoteRow({ note, items, now, open }: { note: VoxNote; items: BoardItem[]; now: number; open: () => void }) {
  const { icon: Icon, label } = kindOf(note.kind);
  const issues = note.links.map(l => issueRef(l, items)).filter(x => x !== null);
  return (
    <a className="row" href={`?view=vox&note=${encodeURIComponent(note.path)}`} onClick={e => { if (e.metaKey || e.ctrlKey || e.altKey) return; e.preventDefault(); open(); }}
      {...refAttrs('vox-note', note.path, note.title)}>
      <span className={`vox-kind k-${note.kind}`} title={label}><Icon size={14} /></span>
      <span className="row-main">
        <span className="row-title">{note.title}</span>
        <span className="row-sub">{[note.projects.join(', '), excerpt(note.body)].filter(Boolean).join(' · ')}</span>
      </span>
      <span className="row-chips">
        {issues.map(i => <IssueChip key={i.url} issue={i} />)}
        {note.status !== 'open' ? <Chip tone={STATUS_TONE[note.status] ?? 'muted'}>{note.status}</Chip> : null}
      </span>
      <span className="row-time" title={full(note.captured)}>{note.captured ? rel(note.captured, now) : ''}</span>
    </a>
  );
}

function NotePane({ note, actions, items, now, local, close }: { note: VoxNote; actions: VoxAction[]; items: BoardItem[]; now: number; local: LocalLink; close: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [close]);
  const { icon: Icon, one } = kindOf(note.kind);
  const issues = note.links.map(l => issueRef(l, items)).filter(x => x !== null);
  const related = note.links.filter(l => !issueRef(l, items) && !/^https?:/.test(l));
  const web = note.links.filter(l => /^https?:/.test(l) && !issueRef(l, items));
  return (
    <>
      <div className="scrim" onClick={close} />
      <aside className="pane" aria-label={note.title} {...refAttrs('vox-note', note.path, note.title)}>
        <div className="pane-head">
          <div>
            <div className="meta"><Icon size={12} /> {one} · {note.path.split('/').pop()}</div>
            <h2>{note.title}</h2>
          </div>
          <button className="icon" onClick={close} title="Close"><X size={16} /></button>
        </div>
        <div className="pane-facts">
          <Chip tone={STATUS_TONE[note.status] ?? 'muted'}>{note.status}</Chip>
          {note.projects.map(p => <Chip key={p}>{p}</Chip>)}
          <span className="meta" title={full(note.captured)}>captured {note.captured ? rel(note.captured, now) : '—'}{note.updated && note.captured && Date.parse(note.updated) - Date.parse(note.captured) > 3_600_000 ? ` · updated ${rel(note.updated, now)}` : ''}</span>
        </div>
        {issues.length || web.length ? (
          <div className="pane-labels">
            {issues.map(i => <a key={i.url} className="button" href={i.url} target="_blank" rel="noreferrer">{i.label}{i.state ? <Chip tone={i.tone}>{i.state}</Chip> : null}<ExternalLink size={12} /></a>)}
            {web.map(l => <a key={l} className="button" href={l} target="_blank" rel="noreferrer">{new URL(l).hostname}<ExternalLink size={12} /></a>)}
          </div>
        ) : null}
        <div className="vox-prose"><Markdown text={unwrap(note.body)} local={local} /></div>
        {actions.length ? <>
          <h3>Actions</h3>
          <div className="list boxed">{actions.map((a, n) => <ActionRow key={n} action={a} items={items} local={local} />)}</div>
        </> : null}
        {related.length ? <>
          <h3>Related</h3>
          <div className="vox-prose"><Markdown text={related.map(r => `- [${r.split('/').pop()?.replace(/\.md$/, '')}](${r})`).join('\n')} local={local} /></div>
        </> : null}
        {note.source ? <div className="meta">From the Vox capture {note.source}</div> : null}
      </aside>
    </>
  );
}

// ---------- actions ----------

function Actions({ actions, byPath, items, open, local }: { actions: VoxAction[]; byPath: Map<string, VoxNote>; items: BoardItem[]; open: (path: string) => void; local: LocalLink }) {
  const [showDone, setShowDone] = useState(false);
  const shown = actions.filter(a => showDone || !a.done);
  const groups = [...new Set(shown.map(a => a.project))].map(p => [p, shown.filter(a => a.project === p)] as const);
  const done = actions.filter(a => a.done).length;
  return (
    <>
      {done ? <div className="toolbar"><label className="check"><input type="checkbox" checked={showDone} onChange={e => setShowDone(e.target.checked)} /> Show done ({done})</label></div> : null}
      {groups.length ? groups.map(([project, list]) => (
        <Section key={project} title={project} action={<span className="meta">{list.filter(a => !a.done).length} open</span>}>
          <div className="list">{list.map((a, n) => <ActionRow key={n} action={a} items={items} local={local}
            note={a.notes[0] ? byPath.get(a.notes[0]) : undefined} open={open} />)}</div>
        </Section>
      )) : <Empty title="Nothing to do" body="ACTIONS.md has no open steps." />}
    </>
  );
}

function ActionRow({ action, items, local, note, open }: { action: VoxAction; items: BoardItem[]; local: LocalLink; note?: VoxNote; open?: (path: string) => void }) {
  const issues = [...action.text.matchAll(/https:\/\/github\.com\/[^\s)]+\/(?:issues|pull)\/\d+/g)].map(m => issueRef(m[0], items)).filter(x => x !== null);
  // The row shows the note's title and the issues' chips, so their links come out of the text.
  const text = note ? tidy(action.text.replace(/\[note\]\(notes\/[^)]+\)/g, '').replace(/\[(?:PR )?#\d+\]\(https:\/\/github\.com\/[^)]+\)/g, '')) : action.text;
  return (
    <div className={`row static vox-action ${action.done ? 'done' : ''}`} {...refAttrs('vox-action', `${action.project}: ${action.text.slice(0, 80)}`, action.text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').slice(0, 120))}>
      {action.done ? <SquareCheck size={15} className="tone-ok" /> : <Square size={15} />}
      <span className="row-main">
        <span className="vox-action-text"><Inline text={text} local={local} /></span>
        {note && open ? <a className="row-sub vox-note-link" href={`?view=vox&note=${encodeURIComponent(note.path)}`} onClick={e => { if (e.metaKey || e.ctrlKey) return; e.preventDefault(); open(note.path); }}>
          {(() => { const { icon: Icon } = kindOf(note.kind); return <Icon size={11} />; })()} {note.title}</a> : null}
      </span>
      <span className="row-chips">{issues.map(i => <IssueChip key={i.url} issue={i} />)}</span>
    </div>
  );
}

// ---------- needs you ----------

function Review({ vox, now, local }: { vox: VoxData; now: number; local: LocalLink }) {
  return (
    <>
      {vox.review.length
        ? <Section title="Waiting on you" action={<span className="meta">from INBOX-REVIEW.md</span>}>
            <div className="list">{vox.review.map((r, n) => <div key={n} className="row static vox-review" {...refAttrs('vox-review', `review-${n + 1}`, r.replace(/\*\*/g, '').slice(0, 120))}><Sparkles size={14} className="tone-warn" /><div className="vox-prose"><Markdown text={unwrap(r)} local={local} /></div></div>)}</div>
          </Section>
        : <Empty title="Nothing needs you" body="Unclear captures, decisions and proposed issues show up here." />}
      {vox.lastRun ? <Section title="Latest run" action={<span className="meta" title={full(vox.lastRun.at)}>{rel(vox.lastRun.at, now)}</span>}>
        <div className="vox-prose padded"><Markdown text={unwrap(vox.lastRun.text)} local={local} /></div>
      </Section> : null}
    </>
  );
}

// ---------- bits ----------

interface IssueRef { url: string; label: string; state: string; tone: string }

/** A GitHub issue or PR link, with its state when the board's GitHub read has it. */
function issueRef(url: string, items: BoardItem[]): IssueRef | null {
  const m = /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/(issues|pull)\/(\d+)/.exec(url);
  if (!m) return null;
  const [, repo, kind, num] = m;
  const item = items.find(i => i.repo.toLowerCase() === repo.toLowerCase() && i.number === Number(num));
  const state = !item ? '' : item.merged ? 'merged' : item.state;
  return { url, label: `${kind === 'pull' ? 'PR ' : ''}#${num}`, state, tone: state === 'open' ? 'info' : state === 'merged' || state === 'closed' ? 'ok' : 'muted' };
}

function IssueChip({ issue }: { issue: IssueRef }) {
  return <Chip tone={issue.state ? issue.tone : 'muted'} title={issue.state ? `${issue.label} is ${issue.state}` : issue.url}>{issue.label}{issue.state && issue.state !== 'open' ? ` ✓` : ''}</Chip>;
}

/**
 * Joins hard-wrapped lines (the notebook wraps at ~100 columns) so paragraphs, list items and quotes flow;
 * blank lines, list markers, headings, quotes and code fences still start a new line.
 */
export function unwrap(md: string): string {
  const out: string[] = [];
  let fence = false;
  const starts = /^\s*([-*•]|\d+[.)])\s+|^#{1,6}\s|^```|^\s*$|^\|/;
  for (const line of md.replace(/\r\n/g, '\n').split('\n')) {
    if (/^```/.test(line)) { fence = !fence; out.push(line); continue; }
    const prev = out[out.length - 1];
    if (fence || prev === undefined || /^\s*$/.test(prev) || /^```|^#{1,6}\s/.test(prev) || starts.test(line)) { out.push(line); continue; }
    if (/^>/.test(line)) {
      if (/^>/.test(prev) && line.replace(/^>\s?/, '').trim() && prev.replace(/^>\s?/, '').trim()) out[out.length - 1] = `${prev} ${line.replace(/^>\s?/, '').trim()}`;
      else out.push(line);
      continue;
    }
    if (/^>/.test(prev)) { out.push(line); continue; }
    out[out.length - 1] = `${prev} ${line.trim()}`;
  }
  return out.join('\n');
}

/** What's left of "(…, [note](…))" once links are taken out: no empty brackets or dangling separators. */
function tidy(text: string): string {
  let out = text;
  for (let i = 0; i < 3; i++) out = out.replace(/\(\s*[,;]\s*/g, '(').replace(/\s*[,;]\s*\)/g, ')').replace(/\(\s*\)/g, '').replace(/\s*[,;]\s*[,;]/g, ';');
  return out.replace(/\s{2,}/g, ' ').trim();
}

/** Resolves a link inside a notebook file (`../bugs/x.md`, `notes/ideas/y.md`) to its notebook path. */
export function resolvePath(base: string, target: string): string {
  if (/^[a-z]+:/i.test(target) || target.startsWith('#')) return target;
  if (target.startsWith('notes/')) return target;
  const parts = base.split('/').slice(0, -1);
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg && seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

function excerpt(body: string): string {
  const line = body.split('\n').map(l => l.trim()).find(l => l && !l.startsWith('>') && !l.startsWith('#') && !l.startsWith('```')) ?? '';
  return line.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[*`_]/g, '').slice(0, 160);
}

const localDay = (iso: string) => { const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

function groupByDay(notes: VoxNote[]): [string, VoxNote[]][] {
  const out = new Map<string, VoxNote[]>();
  for (const n of [...notes].sort((a, b) => (b.captured ?? '').localeCompare(a.captured ?? ''))) {
    const day = n.captured ? localDay(n.captured) : 'undated';
    out.set(day, [...(out.get(day) ?? []), n]);
  }
  return [...out];
}

function dayHeading(day: string, now: number): string {
  if (day === 'undated') return 'Undated';
  const today = localDay(new Date(now).toISOString());
  const yesterday = localDay(new Date(now - 86_400_000).toISOString());
  const label = new Date(`${day}T12:00:00`).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
  return day === today ? `Today · ${label}` : day === yesterday ? `Yesterday · ${label}` : label;
}
