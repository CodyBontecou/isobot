import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, ArrowDown, ArrowUp, Apple, CalendarDays, ChevronLeft, ChevronRight, CircleX, Globe, Newspaper, Play,
} from 'lucide-react';
import { Chip, Empty, getJson, ItemRow, Section, short, SOURCES, sourceOf } from './common';
import { ColumnChart } from './growth';
import type { BoardEvent, BoardItem, CalendarData, Job, Metrics, RunnerState, SourceKind, SummaryData } from './types';

/**
 * Summary: one day, week (Monday to Sunday) or month at a time, in the viewer's time zone, with a calendar to move
 * between them. Each period reads against the one before it; a period still under way is compared with the same
 * stretch of the one before. Counts come from /api/summary (a year of runner events, and the issues and PRs the
 * board has seen); growth numbers from /api/metrics.
 */

export type Period = 'day' | 'week' | 'month';
const PERIODS: { id: Period; label: string }[] = [{ id: 'day', label: 'Day' }, { id: 'week', label: 'Week' }, { id: 'month', label: 'Month' }];
const NOUN: Record<Period, string> = { day: 'day', week: 'week', month: 'month' };

// ---------- local calendar math (Date's own arithmetic handles DST) ----------

const pad = (n: number) => String(n).padStart(2, '0');
export const toDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function parseDay(day: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return toDay(d) === day ? d : null;
}
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

export function startOf(period: Period, d: Date): Date {
  if (period === 'day') return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  if (period === 'week') return addDays(new Date(d.getFullYear(), d.getMonth(), d.getDate()), -((d.getDay() + 6) % 7));
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

export function shift(period: Period, start: Date, n: number): Date {
  if (period === 'day') return addDays(start, n);
  if (period === 'week') return addDays(start, 7 * n);
  return new Date(start.getFullYear(), start.getMonth() + n, 1);
}

export interface Span {
  period: Period;
  start: Date;
  /** Exclusive. */
  end: Date;
  prevStart: Date;
  /** Exclusive end of the comparison: the previous period's end, or as far into it as `now` is into this one. */
  compareEnd: Date;
  current: boolean;
  future: boolean;
}

export function spanOf(period: Period, anchor: Date, now: Date): Span {
  const start = startOf(period, anchor);
  const end = shift(period, start, 1);
  const prevStart = shift(period, start, -1);
  const current = start <= now && now < end;
  const compareEnd = current ? new Date(Math.min(start.getTime(), prevStart.getTime() + (now.getTime() - start.getTime()))) : start;
  return { period, start, end, prevStart, compareEnd, current, future: start > now };
}

function spanTitle(span: Span): string {
  const { period, start } = span;
  if (period === 'day') return start.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  if (period === 'month') return start.toLocaleDateString([], { month: 'long', year: 'numeric' });
  const last = addDays(span.end, -1);
  const sameMonth = last.getMonth() === start.getMonth();
  const a = start.toLocaleDateString([], { month: 'short', day: 'numeric' });
  const b = last.toLocaleDateString([], sameMonth ? { day: 'numeric' } : { month: 'short', day: 'numeric' });
  return `${a} – ${b}, ${last.getFullYear()}`;
}

/** What the comparison covers, in words. */
function compareLabel(span: Span): string {
  const noun = NOUN[span.period];
  if (!span.current) return span.period === 'day' ? 'vs the day before' : `vs the ${noun} before`;
  return span.period === 'day' ? 'vs yesterday at this time' : `vs the same point last ${noun}`;
}

// ---------- counting ----------

interface HourRow { t: number; kind: string; repo: string | null; n: number }

const isError = (kind: string) => kind.endsWith('_error');
/** GitHub names a repo as written (GitSync.md); job ids may not (gitsync.md). */
const sameRepo = (a: string | null, b: string) => a !== null && a.toLowerCase() === b.toLowerCase();
const within = (t: number, a: Date, b: Date) => t >= a.getTime() && t < b.getTime();
const at = (iso: string | null | undefined) => iso ? Date.parse(iso) : Number.NaN;

function countHours(rows: HourRow[], test: (kind: string) => boolean, a: Date, b: Date): number {
  let n = 0;
  for (const r of rows) if (within(r.t, a, b) && test(r.kind)) n += r.n;
  return n;
}

interface Bucket { key: string; label: string; start: Date; end: Date }

/** Hours for a day, days for a week or month. */
function buckets(span: Span): Bucket[] {
  const out: Bucket[] = [];
  if (span.period === 'day') {
    for (let h = 0; h < 24; h++) {
      const start = new Date(span.start.getFullYear(), span.start.getMonth(), span.start.getDate(), h);
      out.push({ key: String(h), label: pad(h), start, end: new Date(start.getTime() + 3_600_000) });
    }
    return out;
  }
  for (let d = span.start; d < span.end; d = addDays(d, 1)) {
    out.push({
      key: toDay(d), start: d, end: addDays(d, 1),
      label: span.period === 'week' ? d.toLocaleDateString([], { weekday: 'short', day: 'numeric' }) : String(d.getDate()),
    });
  }
  return out;
}

// ---------- the view ----------

export function Summary({ runner, repo, setRepo, period, date, go, open }: {
  runner: RunnerState; repo: string; setRepo: (repo: string) => void; period: Period; date: string;
  go: (period: Period, date: string) => void; open: (job: string) => void;
}) {
  const now = new Date();
  const anchor = parseDay(date) ?? now;
  const span = spanOf(period, anchor > now ? now : anchor, now);
  const key = `${period}:${toDay(span.start)}`;
  const [data, setData] = useState<{ key: string; summary: SummaryData } | null>(null);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [error, setError] = useState('');

  // A period under way is fetched again on each runner push; a finished one once.
  const refresh = span.current ? runner.receivedAt : '';
  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ from: span.start.toISOString(), to: span.end.toISOString(), compare: span.prevStart.toISOString() });
    getJson<SummaryData>(`/api/summary?${query}`, controller.signal)
      .then(summary => { setData({ key, summary }); setError(''); })
      .catch(err => { if (!controller.signal.aborted) setError((err as Error).message); });
    return () => controller.abort();
  }, [key, refresh]);
  useEffect(() => {
    getJson<{ metrics: Metrics | null }>('/api/metrics').then(r => setMetrics(r.metrics)).catch(() => setMetrics(null));
  }, []);

  // Arrow keys step through periods, T jumps to today (not while typing).
  const step = (n: number) => {
    const next = shift(period, span.start, n);
    if (next <= now) go(period, toDay(next));
  };
  const stepRef = useRef(step);
  stepRef.current = step;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (e.metaKey || e.ctrlKey || e.altKey || target?.closest('input, textarea, select, [contenteditable]') || document.querySelector('.pane')) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); stepRef.current(-1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); stepRef.current(1); }
      else if (e.key === 't' || e.key === 'T') go(period, '');
      else if (e.key === 'd' || e.key === 'w' || e.key === 'm') go(({ d: 'day', w: 'week', m: 'month' } as const)[e.key], date);
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [go, period, date]);

  const summary = data?.key === key ? data.summary : null;

  return (
    <>
      <div className="toolbar period-bar">
        <div className="tabs" role="tablist" aria-label="Period">
          {PERIODS.map(p => <button key={p.id} role="tab" aria-selected={p.id === period} className={p.id === period ? 'active' : ''}
            onClick={() => go(p.id, span.current ? '' : toDay(span.start))} title={`${p.label} (${p.id[0]})`}>{p.label}</button>)}
        </div>
        <div className="period-nav">
          <button className="icon bordered" onClick={() => step(-1)} title={`Previous ${NOUN[period]} (←)`} aria-label={`Previous ${NOUN[period]}`}><ChevronLeft size={15} /></button>
          <CalendarPicker span={span} repo={repo} pick={day => go(period, day === toDay(startOf(period, now)) ? '' : day)} />
          <button className="icon bordered" onClick={() => step(1)} disabled={shift(period, span.start, 1) > now} title={`Next ${NOUN[period]} (→)`} aria-label={`Next ${NOUN[period]}`}><ChevronRight size={15} /></button>
        </div>
        <button className="button" onClick={() => go(period, '')} disabled={span.current} title="Today (t)">Today</button>
        <span className="meta">{span.current ? `so far · ${compareLabel(span)}` : compareLabel(span)}</span>
      </div>
      {error ? <div className="banner bad"><AlertTriangle size={14} /> {error}</div> : null}
      {!summary ? <div className="center small"><span className="spinner" /></div>
        : <SummaryBody summary={summary} metrics={metrics} span={span} runner={runner} repo={repo} setRepo={setRepo} open={open}
            drill={day => go('day', day)} />}
    </>
  );
}

// ---------- the calendar control ----------

function CalendarPicker({ span, repo, pick }: { span: Span; repo: string; pick: (day: string) => void }) {
  const [openAt, setOpenAt] = useState<Date | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!openAt) return;
    const onDown = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpenAt(null); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpenAt(null); } };
    addEventListener('pointerdown', onDown);
    addEventListener('keydown', onKey, true);
    return () => { removeEventListener('pointerdown', onDown); removeEventListener('keydown', onKey, true); };
  }, [openAt]);
  const choose = (day: string) => { setOpenAt(null); pick(day); };
  return (
    <div className="picker" ref={ref}>
      <button className="button picker-button" aria-haspopup="dialog" aria-expanded={Boolean(openAt)}
        onClick={() => setOpenAt(openAt ? null : new Date(span.start.getFullYear(), span.start.getMonth(), 1))}>
        <CalendarDays size={14} /> {spanTitle(span)}
      </button>
      {openAt ? (
        <div className="picker-pop" role="dialog" aria-label="Pick a period">
          {span.period === 'month'
            ? <MonthGrid year={openAt.getFullYear()} setYear={y => setOpenAt(new Date(y, 0, 1))} span={span} choose={choose} />
            : <DayGrid month={openAt} setMonth={setOpenAt} span={span} repo={repo} choose={choose} />}
        </div>
      ) : null}
    </div>
  );
}

const WEEKDAYS = Array.from({ length: 7 }, (_, i) => addDays(new Date(2024, 0, 1), i).toLocaleDateString([], { weekday: 'narrow' }));

function DayGrid({ month, setMonth, span, repo, choose }: { month: Date; setMonth: (d: Date) => void; span: Span; repo: string; choose: (day: string) => void }) {
  const now = new Date();
  const gridStart = startOf('week', month);
  const weeks = Array.from({ length: 6 }, (_, w) => Array.from({ length: 7 }, (_, d) => addDays(gridStart, w * 7 + d)))
    .filter((week, i) => i < 5 || week[0].getMonth() === month.getMonth());
  const gridEnd = addDays(weeks.at(-1)![6], 1);
  const [counts, setCounts] = useState<Map<string, number> | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setCounts(null);
    const query = new URLSearchParams({ from: gridStart.toISOString(), to: gridEnd.toISOString() });
    getJson<CalendarData>(`/api/calendar?${query}`, controller.signal).then(r => {
      const map = new Map<string, number>();
      for (const h of r.hours) {
        if (repo && !sameRepo(h.repo, repo)) continue;
        const day = toDay(new Date(`${h.hour}:00:00Z`));
        map.set(day, (map.get(day) ?? 0) + h.n);
      }
      setCounts(map);
    }).catch(() => { if (!controller.signal.aborted) setCounts(new Map()); });
    return () => controller.abort();
  }, [toDay(gridStart), repo]);
  const max = Math.max(1, ...(counts?.values() ?? []));
  const selected = (d: Date) => d >= span.start && d < span.end;
  const canNext = new Date(month.getFullYear(), month.getMonth() + 1, 1) <= now;
  return (
    <>
      <div className="picker-head">
        <button className="icon" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))} aria-label="Previous month"><ChevronLeft size={14} /></button>
        <strong>{month.toLocaleDateString([], { month: 'long', year: 'numeric' })}</strong>
        <button className="icon" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))} disabled={!canNext} aria-label="Next month"><ChevronRight size={14} /></button>
      </div>
      <div className={`cal ${span.period === 'week' ? 'by-week' : ''}`} role="grid">
        <div className="cal-row cal-weekdays" role="row">{WEEKDAYS.map((w, i) => <span key={i} role="columnheader">{w}</span>)}</div>
        {weeks.map(week => (
          <div key={toDay(week[0])} className={`cal-row ${span.period === 'week' && selected(week[0]) ? 'selected' : ''}`} role="row">
            {week.map(d => {
              const day = toDay(d);
              const n = counts?.get(day) ?? 0;
              const future = d > now;
              const level = n ? Math.min(4, Math.ceil((n / max) * 4)) : 0;
              return (
                <button key={day} role="gridcell" disabled={future}
                  className={`cal-day ${d.getMonth() !== month.getMonth() ? 'outside' : ''} ${span.period === 'day' && selected(d) ? 'selected' : ''} ${day === toDay(now) ? 'today' : ''}`}
                  onClick={() => choose(span.period === 'week' ? toDay(startOf('week', d)) : day)}
                  title={`${d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })}${counts ? ` · ${n} events` : ''}`}>
                  <span>{d.getDate()}</span>
                  <i className={`heat l${level}`} />
                </button>
              );
            })}
          </div>
        ))}
      </div>
      <div className="picker-foot">Shading: runner events that day{repo ? ` in ${short(repo)}` : ''}</div>
    </>
  );
}

function MonthGrid({ year, setYear, span, choose }: { year: number; setYear: (y: number) => void; span: Span; choose: (day: string) => void }) {
  const now = new Date();
  return (
    <>
      <div className="picker-head">
        <button className="icon" onClick={() => setYear(year - 1)} aria-label="Previous year"><ChevronLeft size={14} /></button>
        <strong>{year}</strong>
        <button className="icon" onClick={() => setYear(year + 1)} disabled={year >= now.getFullYear()} aria-label="Next year"><ChevronRight size={14} /></button>
      </div>
      <div className="months">
        {Array.from({ length: 12 }, (_, m) => new Date(year, m, 1)).map(d => (
          <button key={d.getMonth()} disabled={d > now} className={`cal-month ${d.getTime() === span.start.getTime() ? 'selected' : ''}`} onClick={() => choose(toDay(d))}>
            {d.toLocaleDateString([], { month: 'short' })}
          </button>
        ))}
      </div>
    </>
  );
}

// ---------- the summary ----------

function SummaryBody({ summary, metrics, span, runner, repo, setRepo, open, drill }: {
  summary: SummaryData; metrics: Metrics | null; span: Span; runner: RunnerState; repo: string; setRepo: (r: string) => void;
  open: (job: string) => void; drill: (day: string) => void;
}) {
  const rows = useMemo<HourRow[]>(() => summary.hours
    .filter(h => !repo || sameRepo(h.repo, repo))
    .map(h => ({ t: Date.parse(`${h.hour}:00:00Z`), kind: h.kind, repo: h.repo, n: h.n })), [summary, repo]);
  const items = useMemo(() => summary.items.filter(i => !repo || sameRepo(i.repo, repo)), [summary, repo]);
  const highlights = useMemo(() => summary.highlights.filter(e => !repo || sameRepo((e.jobId ?? '').split('#')[0], repo)), [summary, repo]);
  const jobs = useMemo(() => new Map([...summary.jobs, ...runner.jobs].map(j => [j.id, j] as [string, Job])), [summary, runner]);

  const { start, end, prevStart, compareEnd } = span;
  const count = (test: (k: string) => boolean) => ({ now: countHours(rows, test, start, end), before: countHours(rows, test, prevStart, compareEnd) });
  const itemCount = (test: (i: BoardItem) => boolean, field: 'createdAt' | 'closedAt') => ({
    now: items.filter(i => test(i) && within(at(i[field]), start, end)).length,
    before: items.filter(i => test(i) && within(at(i[field]), prevStart, compareEnd)).length,
  });
  const merged = itemCount(i => i.kind === 'pr' && i.merged, 'closedAt');
  const isobotMerged = count(k => k === 'state:merged');
  const opened = itemCount(i => i.kind === 'issue', 'createdAt');
  const closed = itemCount(i => i.kind === 'issue' && i.state === 'closed', 'closedAt');
  const failed = count(k => k === 'state:failed');
  const errors = count(isError);
  const events = count(() => true);

  const eventsFrom = summary.eventsSince ? Date.parse(summary.eventsSince) : Number.POSITIVE_INFINITY;
  const itemsFrom = summary.itemsSince ? Date.parse(summary.itemsSince) : Number.POSITIVE_INFINITY;
  const eventsPartial = eventsFrom > start.getTime();
  const itemsPartial = itemsFrom > start.getTime();
  const priorPartial = eventsFrom > prevStart.getTime();
  const itemsPriorPartial = itemsFrom > prevStart.getTime();

  const chart = buckets(span).map(b => {
    const n = countHours(rows, () => true, b.start, b.end);
    const m = countHours(rows, k => k === 'state:merged', b.start, b.end);
    const f = countHours(rows, k => k === 'state:failed', b.start, b.end);
    const note = [m ? `${m} merged` : '', f ? `${f} failed` : ''].filter(Boolean).join(' · ');
    return { key: b.key, label: b.label, value: n, note: note || undefined };
  });

  if (eventsFrom > end.getTime() && !items.some(i => within(at(i.createdAt), start, end) || within(at(i.closedAt), start, end))) {
    return <Empty title="The board has nothing from this period" body={summary.eventsSince ? `Its history starts ${new Date(summary.eventsSince).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}.` : 'No runner events yet.'} />;
  }

  const shipped = items.filter(i => i.kind === 'pr' && i.merged && within(at(i.closedAt), start, end)).sort((a, b) => at(b.closedAt) - at(a.closedAt));
  const newIssues = items.filter(i => i.kind === 'issue' && within(at(i.createdAt), start, end)).sort((a, b) => at(b.createdAt) - at(a.createdAt));
  const bySource = (Object.keys(SOURCES) as SourceKind[]).map(kind => ({ kind, n: newIssues.filter(i => sourceOf(i) === kind).length })).filter(s => s.n).sort((a, b) => b.n - a.n);
  // Before the board kept items, merges are only known from the runner's own events.
  const mergeEvents = highlights.filter(e => e.kind === 'state:merged');

  return (
    <>
      {eventsPartial || itemsPartial ? (
        <div className="banner info"><AlertTriangle size={14} />
          The board’s history starts {new Date(Math.max(...[eventsFrom, itemsFrom].filter(t => t > start.getTime()))).toLocaleDateString([], { month: 'short', day: 'numeric' })}, so this {NOUN[span.period]} is incomplete.
        </div>
      ) : null}
      <div className="stats summary-stats">
        <Tile label="PRs merged" value={merged.now} before={itemsPriorPartial ? null : merged.before} span={span}
          sub={`${isobotMerged.now} by isobot`} />
        <Tile label="Issues opened" value={opened.now} before={itemsPriorPartial ? null : opened.before} span={span} neutral />
        <Tile label="Issues closed" value={closed.now} before={itemsPriorPartial ? null : closed.before} span={span} />
        <Tile label="Builds failed" value={failed.now} before={priorPartial ? null : failed.before} span={span} goodUp={false} />
        <Tile label="Runner errors" value={errors.now} before={priorPartial ? null : errors.before} span={span} goodUp={false} />
        <Tile label="Events" value={events.now} before={priorPartial ? null : events.before} span={span} neutral />
      </div>

      <Section title={span.period === 'day' ? 'Activity by hour' : 'Activity by day'}
        action={span.period !== 'day' ? <span className="meta">Click a day to open it</span> : undefined}>
        <div className="summary-chart">
          <ColumnChart points={chart} color="var(--series-1)" label="events" height={160}
            onSelect={span.period === 'day' ? undefined : day => { if ((parseDay(day) ?? new Date()) <= new Date()) drill(day); }} />
        </div>
      </Section>

      <div className="grid">
        <Section title={`Shipped · ${shipped.length || mergeEvents.length}`}>
          {shipped.length ? <div className="list scroll">{shipped.map(i => <ItemRow key={`${i.repo}#${i.number}`} item={i} now={Date.now()} />)}</div>
            : mergeEvents.length ? <div className="list scroll">{mergeEvents.map(e => <JobEventRow key={`${e.runner}:${e.id}`} event={e} job={jobs.get(e.jobId ?? '')} open={open} />)}</div>
            : <Empty title="Nothing merged" />}
        </Section>

        <Section title={`New issues · ${newIssues.length}`}>
          {newIssues.length === 0 ? <Empty title="No issues opened" /> : <>
            <div className="source-strip">{bySource.map(({ kind, n }) => { const { label, icon: Icon } = SOURCES[kind]; return <span key={kind} className={`chip source ${kind}`}><Icon size={11} />{label} {n}</span>; })}</div>
            <div className="list scroll">{newIssues.map(i => <ItemRow key={`${i.repo}#${i.number}`} item={i} now={Date.now()} />)}</div>
          </>}
        </Section>

        <ScheduledWork highlights={highlights} rows={rows} span={span} />

        <Problems highlights={highlights} jobs={jobs} open={open} />

        {!repo ? <ByRepo rows={rows} items={items} span={span} setRepo={setRepo} /> : null}

        <GrowthPeriod metrics={metrics} span={span} repo={repo} />
      </div>
      {summary.truncated ? <p className="footnote plain">Lists show the newest {summary.highlights.length} named events; the counts cover everything.</p> : null}
    </>
  );
}

function Tile({ label, value, before, span, goodUp = true, neutral = false, sub }: { label: string; value: number; before: number | null; span: Span; goodUp?: boolean; neutral?: boolean; sub?: string }) {
  return (
    <div className="stat growth-stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value.toLocaleString()}</span>
      <Delta now={value} before={before} span={span} goodUp={goodUp} neutral={neutral} />
      {sub ? <span className="stat-sub">{sub}</span> : null}
    </div>
  );
}

function Delta({ now, before, span, goodUp = true, neutral = false }: { now: number; before: number | null; span: Span; goodUp?: boolean; neutral?: boolean }) {
  const noun = NOUN[span.period];
  if (before === null) return <span className="delta muted">no earlier {noun} to compare</span>;
  const diff = now - before;
  if (diff === 0) return <span className="delta muted">same as {span.current ? 'last' : 'the'} {noun}{span.current ? ' so far' : ' before'}</span>;
  const tone = neutral ? 'muted' : diff > 0 === goodUp ? 'up' : 'down';
  return <span className={`delta ${tone}`} title={compareLabel(span)}>{diff > 0 ? <ArrowUp size={11} /> : <ArrowDown size={11} />}{Math.abs(diff).toLocaleString()} {diff > 0 ? 'more' : 'fewer'} (was {before.toLocaleString()})</span>;
}

function JobEventRow({ event, job, open }: { event: BoardEvent; job?: Job; open: (id: string) => void }) {
  const id = event.jobId ?? '';
  return (
    <button className="row" onClick={() => id && open(id)}>
      <span className="row-main">
        <span className="row-title">{job?.title ?? id}</span>
        <span className="row-sub">{id ? `${short(id.split('#')[0])}#${id.split('#')[1]} · ` : ''}{event.text}</span>
      </span>
      <span className="row-time" title={new Date(event.at).toLocaleString()}>{whenShort(event.at)}</span>
    </button>
  );
}

const whenShort = (iso: string) => new Date(iso).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

// ---------- what the scheduled work did ----------

const WORK: { id: string; label: string; kinds: string[] }[] = [
  { id: 'content', label: 'Content pages proposed', kinds: ['content_proposed'] },
  { id: 'dropped', label: 'Content dropped by the gates', kinds: ['content_dropped'] },
  { id: 'aso', label: 'Listing changes proposed', kinds: ['aso_proposed'] },
  { id: 'aso-applied', label: 'Listing changes applied', kinds: ['aso_applied', 'aso_live'] },
  { id: 'train', label: 'Release trains', kinds: ['train'] },
  { id: 'crash', label: 'Crash issues filed', kinds: ['crash_issue'] },
  { id: 'sweep', label: 'PRs closed by the sweep', kinds: ['pr_sweep_closed'] },
  { id: 'shipped', label: 'Releases shipped', kinds: ['state:shipped'] },
];

function ScheduledWork({ highlights, rows, span }: { highlights: BoardEvent[]; rows: HourRow[]; span: Span }) {
  const triage = countHours(rows, k => k === 'triage', span.start, span.end);
  const groups = WORK.map(w => ({ ...w, events: highlights.filter(e => w.kinds.includes(e.kind)) })).filter(g => g.events.length);
  return (
    <Section title="What the scheduled work did" action={triage ? <span className="meta">{triage} triage runs</span> : undefined}>
      {groups.length === 0 ? <Empty title="No trains, content or listing work" /> : <div className="list">
        {groups.map(g => (
          <details key={g.id} className="work">
            <summary className="row"><span className="row-main"><span className="row-title">{g.label}</span></span><span className="row-time">{g.events.length}</span></summary>
            <div className="work-events">{g.events.map(e => (
              <div key={`${e.runner}:${e.id}`} className="work-event"><span className="event-time">{whenShort(e.at)}</span><span>{e.text.replace(/^[a-z_]+: /, '')}</span></div>
            ))}</div>
          </details>
        ))}
      </div>}
    </Section>
  );
}

// ---------- problems ----------

function Problems({ highlights, jobs, open }: { highlights: BoardEvent[]; jobs: Map<string, Job>; open: (id: string) => void }) {
  const failed = highlights.filter(e => e.kind === 'state:failed');
  const errors = new Map<string, BoardEvent[]>();
  for (const e of highlights) if (isError(e.kind)) errors.set(e.kind, [...(errors.get(e.kind) ?? []), e]);
  const total = failed.length + [...errors.values()].reduce((a, l) => a + l.length, 0);
  return (
    <Section title={`Problems · ${total}`}>
      {total === 0 ? <Empty title="No failed builds or runner errors" /> : <div className="list scroll">
        {failed.map(e => <JobEventRow key={`${e.runner}:${e.id}`} event={e} job={jobs.get(e.jobId ?? '')} open={open} />)}
        {[...errors].sort((a, b) => b[1].length - a[1].length).map(([kind, list]) => (
          <details key={kind} className="work">
            <summary className="row"><CircleX size={15} className="tone-bad" /><span className="row-main"><span className="row-title">{kind.replace(/_error$/, '').replace(/_/g, ' ')} errors</span><span className="row-sub">{list[0].text}</span></span><span className="row-time">{list.length}</span></summary>
            <div className="work-events">{list.map(e => <div key={`${e.runner}:${e.id}`} className="work-event"><span className="event-time">{whenShort(e.at)}</span><span>{e.text}</span></div>)}</div>
          </details>
        ))}
      </div>}
    </Section>
  );
}

// ---------- by repository ----------

function ByRepo({ rows, items, span, setRepo }: { rows: HourRow[]; items: BoardItem[]; span: Span; setRepo: (r: string) => void }) {
  const repos = new Map<string, { name: string; events: number; merged: number; failed: number; prs: number }>();
  // Keyed case-insensitively; GitHub's spelling of the name wins.
  const get = (r: string) => {
    const k = r.toLowerCase();
    const s = repos.get(k) ?? (repos.set(k, { name: r, events: 0, merged: 0, failed: 0, prs: 0 }), repos.get(k)!);
    return s;
  };
  for (const r of rows) {
    if (!r.repo || !within(r.t, span.start, span.end)) continue;
    const s = get(r.repo);
    s.events += r.n;
    if (r.kind === 'state:failed') s.failed += r.n;
  }
  for (const i of items) {
    if (i.kind !== 'pr') continue;
    const s = get(i.repo);
    s.name = i.repo;
    if (i.merged && within(at(i.closedAt), span.start, span.end)) s.merged++;
    if (within(at(i.createdAt), span.start, span.end)) s.prs++;
  }
  const list = [...repos].sort((a, b) => b[1].merged - a[1].merged || b[1].events - a[1].events);
  const max = Math.max(1, ...list.map(([, s]) => s.events));
  return (
    <Section title="By repository">
      {list.length === 0 ? <Empty title="No repository work" /> : <div className="list">
        {list.map(([, { name, ...s }]) => (
          <button key={name} className="row" onClick={() => setRepo(name)} title={`Show only ${short(name)}`}>
            <span className="row-main"><span className="row-title mono">{short(name)}</span>
              <span className="row-sub">{s.merged} merged · {s.prs} PRs opened{s.failed ? ` · ${s.failed} failed` : ''}</span></span>
            <span className="source-bar" style={{ width: `${Math.max(4, Math.round((s.events / max) * 80))}px` }} />
            <span className="row-time">{s.events}</span>
          </button>
        ))}
      </div>}
    </Section>
  );
}

// ---------- growth in the period ----------

/** The day keys of a span (store report days are dates, read as local days). */
function spanDays(a: Date, b: Date): string[] {
  const out: string[] = [];
  for (let d = startOf('day', a); d < b; d = addDays(d, 1)) out.push(toDay(d));
  return out;
}

const FIELDS: Record<'appstore' | 'play', { key: string[]; label: string; money?: boolean }[]> = {
  appstore: [{ key: ['installs', 'firstDownloads'], label: 'Installs' }, { key: ['pageViews'], label: 'Page views' }, { key: ['proceeds'], label: 'Proceeds', money: true }],
  play: [{ key: ['userInstalls', 'acquisitions'], label: 'Installs' }, { key: ['visitors'], label: 'Listing visitors' }],
};

function GrowthPeriod({ metrics, span, repo }: { metrics: Metrics | null; span: Span; repo: string }) {
  if (!metrics) return null;
  const days = spanDays(span.start, span.end);
  const prevDays = spanDays(span.prevStart, span.start);
  const apps = metrics.apps.filter(a => !repo || sameRepo(a.repo, repo));
  const inSpan = (iso: string) => within(Date.parse(iso), span.start, span.end);
  const pages = metrics.sites.filter(s => !repo || sameRepo(s.repo, repo)).flatMap(s => s.published.filter(p => inSpan(p.at)).map(p => ({ ...p, site: s.site })));
  const listings = apps.flatMap(a => a.changes.filter(c => inSpan(c.liveAt ?? c.at)).map(c => ({ ...c, app: a })));
  let rowsOut = apps.map(app => {
    const byDay = new Map(app.funnel.map(f => [f.day, f.v]));
    // Compare each reported day with the same day of the period before, so a report that hasn't arrived yet isn't a drop.
    const reported = days.map((d, i) => ({ d, i })).filter(({ d }) => byDay.has(d));
    const values = FIELDS[app.store].map(f => {
      const pick = (v: Record<string, number> | undefined) => { for (const k of f.key) if (typeof v?.[k] === 'number') return v[k]; return undefined; };
      let now = 0, before = 0, comparable = true;
      for (const { d, i } of reported) {
        now += pick(byDay.get(d)) ?? 0;
        const p = prevDays[i] ? byDay.get(prevDays[i]) : undefined;
        if (p === undefined) comparable = false; else before += pick(p) ?? 0;
      }
      return { ...f, now, before: comparable && reported.length ? before : null };
    });
    return { app, reported: reported.length, values };
  });
  const waiting = rowsOut.filter(r => !r.reported && r.app.funnel.length).map(r => `${r.app.name} (${r.app.store === 'play' ? 'Play' : 'App Store'})`);
  rowsOut = rowsOut.filter(r => r.reported);
  if (!rowsOut.length && !waiting.length && !pages.length && !listings.length) return null;
  const money = (n: number) => n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: n >= 100 ? 0 : 2 });
  return (
    <Section title="Growth">
      {rowsOut.length ? (
        <table className="table compact">
          <thead><tr><th>App</th>{['Installs', 'Visits', 'Proceeds'].map(h => <th key={h} className="num">{h}</th>)}<th className="num">Days in</th></tr></thead>
          <tbody>{rowsOut.map(({ app, reported, values }) => (
            <tr key={`${app.store}:${app.id}`}>
              <td>{app.store === 'play' ? <Play size={12} className="tone-muted" /> : <Apple size={12} className="tone-muted" />} {app.name}</td>
              {[0, 1, 2].map(i => {
                const v = values[i];
                if (!v) return <td key={i} className="num tone-muted">—</td>;
                const f = v.money ? money : (n: number) => n.toLocaleString();
                const diff = v.before === null ? null : v.now - v.before;
                return <td key={i} className="num" title={v.before === null ? 'No matching days before' : `was ${f(v.before)}`}>
                  {reported ? f(v.now) : '—'}{diff ? <span className={`delta ${diff > 0 ? 'up' : 'down'}`}> {diff > 0 ? '+' : '−'}{f(Math.abs(diff))}</span> : null}
                </td>;
              })}
              <td className="num tone-muted" title="Store reports arrive a day or more late">{reported}/{days.length}</td>
            </tr>
          ))}</tbody>
        </table>
      ) : null}
      {pages.length || listings.length ? (
        <div className="list">
          {listings.map((c, i) => <div key={`l${i}`} className="row static"><Globe size={14} className="tone-muted" /><span className="row-main"><span className="row-title">{c.app.name}: {c.fields.join(', ')}{c.version ? ` (v${c.version})` : ''}</span><span className="row-sub">{c.app.store === 'play' ? 'Play' : 'App Store'} listing change</span></span><span className="row-time">{whenShort(c.liveAt ?? c.at)}</span></div>)}
          {pages.map(p => <div key={`${p.site}#${p.number}`} className="row static"><Newspaper size={14} className="tone-muted" /><span className="row-main"><span className="row-title">{p.title}</span><span className="row-sub">{p.site} · published</span></span><span className="row-time">{whenShort(p.at)}</span></div>)}
        </div>
      ) : null}
      <p className="footnote">Store numbers are summed over the days reported so far, each compared with the same day of the {NOUN[span.period]} before.{waiting.length ? ` No reports yet for ${waiting.join(', ')}.` : ''}</p>
    </Section>
  );
}

