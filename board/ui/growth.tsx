import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Apple, ArrowDown, ArrowUp, ExternalLink, Globe, Inbox, Newspaper, Play, Search, Table2, TrendingUp, X } from 'lucide-react';
import type { Metrics, MetricsApp, MetricsSite, PhraseRank } from './types';

/**
 * Growth: what isobot's scheduled work measures (App Store and Play funnels, search ranks, Search Console)
 * and what it changed (listing changes, published pages), on one time axis so moves can be read against
 * the changes around them. Data comes from /api/metrics (runner/src/metrics.ts).
 */

// ---------- days ----------

const DAY = 86_400_000;
const parseDay = (day: string) => new Date(`${day}T12:00:00`);
const toDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (day: string, n: number) => toDay(new Date(parseDay(day).getTime() + n * DAY));
const dayLabel = (day: string) => parseDay(day).toLocaleDateString([], { month: 'short', day: 'numeric' });
const longDay = (day: string) => parseDay(day).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
function dayRange(end: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => addDays(end, i - count + 1));
}

const compact = (n: number) => Math.abs(n) >= 10_000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1).replace(/\.0$/, '')}K` : n.toLocaleString();
const exact = (n: number) => Number.isInteger(n) ? n.toLocaleString() : n.toLocaleString(undefined, { maximumFractionDigits: 1 });
const money = (n: number) => n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: n >= 100 ? 0 : 2 });
const pct = (n: number) => `${(n * 100).toFixed(n < 0.1 ? 1 : 0)}%`;

type Values = Map<string, number>;

function funnelValues(app: MetricsApp | undefined, key: string): Values {
  const out: Values = new Map();
  for (const d of app?.funnel ?? []) if (typeof d.v[key] === 'number') out.set(d.day, d.v[key]);
  return out;
}

/** Trailing 7-day mean of the days that have a value; needs at least 3 of them. */
function rolling(values: Values, days: string[]): Values {
  const out: Values = new Map();
  for (const day of days) {
    const window = dayRange(day, 7).map(d => values.get(d)).filter((v): v is number => v !== undefined);
    if (window.length >= 3) out.set(day, window.reduce((a, b) => a + b, 0) / window.length);
  }
  return out;
}

/**
 * The newest day with a value, and sums of the 7 days ending there and the 7 before. A week with fewer than 5
 * days of numbers (a report that hasn't arrived, a series that just started) isn't compared.
 */
function lastWeeks(values: Values): { end: string; now: number; before: number | null } | null {
  const end = [...values.keys()].sort().at(-1);
  if (!end) return null;
  const sum = (days: string[]) => { const v = days.map(d => values.get(d)).filter((x): x is number => x !== undefined); return v.length >= 5 ? v.reduce((a, b) => a + b, 0) : null; };
  const now = sum(dayRange(end, 7));
  return { end, now: now ?? [...dayRange(end, 7)].reduce((a, d) => a + (values.get(d) ?? 0), 0), before: now === null ? null : sum(dayRange(addDays(end, -7), 7)) };
}

// ---------- markers: what isobot changed ----------

interface Marker { day: string; kind: 'listing' | 'page'; text: string }

const FIELD_LABELS: Record<string, string> = {
  name: 'name', subtitle: 'subtitle', keywords: 'keywords', promotionalText: 'promotional text',
  title: 'title', shortDescription: 'short description', fullDescription: 'full description',
};

function listingMarkers(apps: MetricsApp[]): Marker[] {
  return apps.flatMap(app => app.changes.map(c => ({
    day: toDay(new Date(c.liveAt ?? c.at)), kind: 'listing' as const,
    text: `${app.store === 'play' ? 'Play' : 'App Store'} listing: ${c.fields.map(f => FIELD_LABELS[f] ?? f).join(', ')}${c.version ? ` (v${c.version})` : ''}`,
  })));
}

function pageMarkers(sites: MetricsSite[]): Marker[] {
  return sites.flatMap(site => site.published.map(p => ({ day: toDay(new Date(p.at)), kind: 'page' as const, text: `Published: ${p.title}` })));
}

// ---------- chart primitives ----------

interface Series { id: string; label: string; color: string; values: Values }

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

/** 0, the middle (when it's a whole number) and the top. */
const yTicks = (max: number) => Number.isInteger(max / 2) ? [0, max / 2, max] : [0, max];

/** Clean axis maximum: 1, 2, 2.5 or 5 times a power of ten, at or above `max`. */
function niceMax(max: number): number {
  if (max <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(max));
  for (const step of [1, 2, 2.5, 5, 10]) if (step * power >= max) return step * power;
  return 10 * power;
}

const PAD = { left: 40, right: 14, top: 12, bottom: 24 };

function ChartCard({ title, caption, legend, table, children, empty }: { title: string; caption?: ReactNode; legend?: Series[]; table: () => ReactNode; children: ReactNode; empty?: string }) {
  const [showTable, setShowTable] = useState(false);
  return (
    <div className="chart-card">
      <div className="chart-head">
        <div>
          <h3>{title}</h3>
          {caption ? <div className="chart-caption">{caption}</div> : null}
        </div>
        {!empty ? <button className={`icon ${showTable ? 'on' : ''}`} onClick={() => setShowTable(v => !v)} title={showTable ? 'Show chart' : 'Show table'} aria-pressed={showTable}><Table2 size={14} /></button> : null}
      </div>
      {legend && legend.length > 1 && !empty ? (
        <div className="legend">{legend.map(s => <span key={s.id}><i style={{ background: s.color }} />{s.label}</span>)}</div>
      ) : null}
      {empty ? <div className="chart-empty"><Inbox size={16} />{empty}</div> : showTable ? <div className="chart-table">{table()}</div> : children}
    </div>
  );
}

function MarkerKey() {
  return (
    <div className="marker-key">
      <span><svg width="10" height="10" viewBox="-5 -5 10 10"><path d="M0 -4 L4 0 L0 4 L-4 0 Z" className="marker-shape" /></svg>Listing change</span>
      <span><svg width="10" height="10" viewBox="-5 -5 10 10"><circle r="3.5" className="marker-shape" /></svg>Page published</span>
    </div>
  );
}

function MarkerShape({ kind, x, y }: { kind: Marker['kind']; x: number; y: number }) {
  return kind === 'listing'
    ? <path d={`M${x} ${y - 4} L${x + 4} ${y} L${x} ${y + 4} L${x - 4} ${y} Z`} className="marker-shape" />
    : <circle cx={x} cy={y} r={3.5} className="marker-shape" />;
}

function LineChart({ days, series, markers, format = exact, height = 170 }: { days: string[]; series: Series[]; markers: Marker[]; format?: (n: number) => string; height?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const max = niceMax(Math.max(0, ...series.flatMap(s => days.map(d => s.values.get(d) ?? 0))));
  const plotW = Math.max(10, width - PAD.left - PAD.right);
  const plotH = height - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (days.length <= 1 ? plotW / 2 : (i / (days.length - 1)) * plotW);
  const y = (v: number) => PAD.top + plotH - (v / max) * plotH;
  const index = new Map(days.map((d, i) => [d, i]));
  const ticks = yTicks(max);
  const xTicks = days.length ? [0, Math.round((days.length - 1) / 3), Math.round((2 * (days.length - 1)) / 3), days.length - 1] : [];
  const shown = markers.filter(m => index.has(m.day));

  const paths = series.map(s => {
    let d = '';
    let open = false;
    days.forEach((day, i) => {
      const v = s.values.get(day);
      if (v === undefined) { open = false; return; }
      d += `${open ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)} `;
      open = true;
    });
    const lastIndex = days.map(day => s.values.has(day)).lastIndexOf(true);
    return { s, d, lastIndex };
  });

  const onMove = (event: React.PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const px = event.clientX - box.left;
    const i = Math.round(((px - PAD.left) / plotW) * (days.length - 1));
    setHover(i >= 0 && i < days.length ? i : null);
  };
  const hoverDay = hover !== null ? days[hover] : null;
  const hoverMarkers = hoverDay ? markers.filter(m => m.day === hoverDay) : [];
  const tipLeft = hover !== null ? Math.min(Math.max(x(hover) + 12, 0), Math.max(0, width - 220)) : 0;

  return (
    <div className="chart" ref={ref} style={{ height }}>
      {width > 0 ? (
        <svg width={width} height={height} onPointerMove={onMove} onPointerLeave={() => setHover(null)} role="img"
          aria-label={`${series.map(s => s.label).join(' and ')} by day`}>
          {ticks.map(t => (
            <g key={t}>
              <line x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} className="grid" />
              <text x={PAD.left - 6} y={y(t)} className="tick" textAnchor="end" dominantBaseline="middle">{compact(t)}</text>
            </g>
          ))}
          {xTicks.map(i => <text key={i} x={x(i)} y={height - 6} className="tick" textAnchor={i === 0 ? 'start' : i === days.length - 1 ? 'end' : 'middle'}>{dayLabel(days[i])}</text>)}
          {shown.map((m, i) => {
            const mx = x(index.get(m.day)!);
            return <g key={`${m.day}-${i}`}><line x1={mx} x2={mx} y1={PAD.top} y2={PAD.top + plotH} className="marker-line" /><MarkerShape kind={m.kind} x={mx} y={PAD.top} /></g>;
          })}
          {paths.map(({ s, d }) => <path key={s.id} d={d} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />)}
          {paths.map(({ s, lastIndex }) => lastIndex >= 0
            ? <circle key={s.id} cx={x(lastIndex)} cy={y(s.values.get(days[lastIndex])!)} r={4} fill={s.color} className="ring" /> : null)}
          {hover !== null ? (
            <g>
              <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={PAD.top + plotH} className="crosshair" />
              {series.map(s => { const v = s.values.get(days[hover]); return v === undefined ? null : <circle key={s.id} cx={x(hover)} cy={y(v)} r={4} fill={s.color} className="ring" />; })}
            </g>
          ) : null}
        </svg>
      ) : null}
      {hoverDay ? (
        <div className="tooltip" style={{ left: tipLeft }}>
          <div className="tooltip-day">{longDay(hoverDay)}</div>
          {series.map(s => {
            const v = s.values.get(hoverDay);
            return <div key={s.id} className="tooltip-row"><i style={{ background: s.color }} /><strong>{v === undefined ? '—' : format(v)}</strong><span>{s.label}</span></div>;
          })}
          {hoverMarkers.map((m, i) => <div key={i} className="tooltip-note">{m.kind === 'listing' ? '◆' : '●'} {m.text}</div>)}
        </div>
      ) : null}
    </div>
  );
}

function ColumnChart({ points, color, format = exact, label, height = 150 }: { points: { key: string; label: string; value: number; note?: string }[]; color: string; format?: (n: number) => string; label: string; height?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const max = niceMax(Math.max(0, ...points.map(p => p.value)));
  const plotW = Math.max(10, width - PAD.left - PAD.right);
  const plotH = height - PAD.top - PAD.bottom;
  const band = points.length ? plotW / points.length : plotW;
  const barW = Math.max(2, Math.min(24, band - 2));
  const y = (v: number) => PAD.top + plotH - (v / max) * plotH;
  const labelEvery = Math.max(1, Math.ceil(points.length / 6));
  const column = (cx: number, top: number) => {
    const h = PAD.top + plotH - top;
    const r = Math.min(4, h, barW / 2);
    const l = cx - barW / 2, rr = cx + barW / 2, base = PAD.top + plotH;
    return `M${l} ${base} L${l} ${top + r} Q${l} ${top} ${l + r} ${top} L${rr - r} ${top} Q${rr} ${top} ${rr} ${top + r} L${rr} ${base} Z`;
  };
  return (
    <div className="chart" ref={ref} style={{ height }}>
      {width > 0 ? (
        <svg width={width} height={height} role="img" aria-label={label} onPointerLeave={() => setHover(null)}>
          {yTicks(max).map(t => (
            <g key={t}>
              <line x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} className="grid" />
              <text x={PAD.left - 6} y={y(t)} className="tick" textAnchor="end" dominantBaseline="middle">{compact(t)}</text>
            </g>
          ))}
          {points.map((p, i) => {
            const cx = PAD.left + band * i + band / 2;
            return (
              <g key={p.key} onPointerEnter={() => setHover(i)} tabIndex={0} onFocus={() => setHover(i)} onBlur={() => setHover(null)}>
                <rect x={PAD.left + band * i} y={PAD.top} width={band} height={plotH} fill="transparent" />
                {p.value > 0 ? <path d={column(cx, y(p.value))} fill={color} opacity={hover === null || hover === i ? 1 : 0.55} /> : null}
                {i % labelEvery === 0 || i === points.length - 1 ? <text x={cx} y={height - 6} className="tick" textAnchor="middle">{p.label}</text> : null}
              </g>
            );
          })}
        </svg>
      ) : null}
      {hover !== null && points[hover] ? (
        <div className="tooltip" style={{ left: Math.min(Math.max(PAD.left + band * hover + band / 2 + 12, 0), Math.max(0, width - 220)) }}>
          <div className="tooltip-day">{points[hover].label}</div>
          <div className="tooltip-row"><i style={{ background: color }} /><strong>{format(points[hover].value)}</strong><span>{label}</span></div>
          {points[hover].note ? <div className="tooltip-note">{points[hover].note}</div> : null}
        </div>
      ) : null}
    </div>
  );
}

function SeriesTable({ days, series, format = exact }: { days: string[]; series: Series[]; format?: (n: number) => string }) {
  const rows = [...days].reverse().filter(d => series.some(s => s.values.has(d)));
  return (
    <table className="table compact">
      <thead><tr><th>Day</th>{series.map(s => <th key={s.id} className="num">{s.label}</th>)}</tr></thead>
      <tbody>{rows.map(d => <tr key={d}><td>{longDay(d)}</td>{series.map(s => <td key={s.id} className="num">{s.values.has(d) ? format(s.values.get(d)!) : '—'}</td>)}</tr>)}</tbody>
    </table>
  );
}

// ---------- tiles ----------

function Delta({ now, before, goodUp = true, format = exact }: { now: number; before: number | null; goodUp?: boolean; format?: (n: number) => string }) {
  if (before === null) return <span className="delta muted">no earlier week</span>;
  const diff = now - before;
  if (diff === 0) return <span className="delta muted">same as the week before</span>;
  const good = diff > 0 === goodUp;
  const share = before > 0 ? ` (${diff > 0 ? '+' : ''}${Math.round((diff / before) * 100)}%)` : '';
  return <span className={`delta ${good ? 'up' : 'down'}`}>{diff > 0 ? <ArrowUp size={11} /> : <ArrowDown size={11} />}{diff > 0 ? '+' : '−'}{format(Math.abs(diff))}{share} vs week before</span>;
}

function Tile({ label, value, sub, delta }: { label: string; value: string; sub?: string; delta?: ReactNode }) {
  return (
    <div className="stat growth-stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      {delta}
      {sub ? <span className="stat-sub">{sub}</span> : null}
    </div>
  );
}

function weekTile(label: string, values: Values[], format = exact): ReactNode {
  const weeks = values.map(lastWeeks).filter((w): w is NonNullable<ReturnType<typeof lastWeeks>> => w !== null);
  if (!weeks.length) return <Tile key={label} label={label} value="—" sub="No data yet" />;
  const now = weeks.reduce((a, w) => a + w.now, 0);
  const before = weeks.every(w => w.before !== null) ? weeks.reduce((a, w) => a + (w.before ?? 0), 0) : null;
  const end = weeks.map(w => w.end).sort()[0];
  return <Tile key={label} label={label} value={format(now)} delta={<Delta now={now} before={before} format={format} />} sub={`7 days to ${dayLabel(end)}`} />;
}

// ---------- the view ----------

export const RANGES = ['30', '90', '120'] as const;
export const COLORS = { appstore: 'var(--series-1)', play: 'var(--series-2)', web: 'var(--series-3)' };

export function Growth({ repo, range, setRange, daily, setDaily, app: appParam, setApp }: {
  repo: string; range: string; setRange: (r: string) => void; daily: boolean; setDaily: (d: boolean) => void; app: string; setApp: (id: string) => void;
}) {
  const [metrics, setMetrics] = useState<Metrics | null | undefined>(undefined);
  const [error, setError] = useState('');
  useEffect(() => {
    let stop = false;
    const load = () => fetch('/api/metrics', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(async r => { if (!r.ok) throw new Error(`/api/metrics answered ${r.status}`); return r.json() as Promise<{ metrics: Metrics | null }>; })
      .then(body => { if (!stop) { setMetrics(body.metrics); setError(''); } })
      .catch(err => { if (!stop) setError((err as Error).message); });
    void load();
    // The runner sends new series at most every 15 minutes.
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 5 * 60_000);
    return () => { stop = true; clearInterval(timer); };
  }, []);

  const count = Number(RANGES.includes(range as typeof RANGES[number]) ? range : '90');
  const today = toDay(new Date());
  const days = useMemo(() => dayRange(today, count), [today, count]);

  if (error && !metrics) return <div className="banner bad">{error}</div>;
  if (metrics === undefined) return <div className="center small"><span className="spinner" /></div>;
  if (metrics === null) return <div className="empty"><TrendingUp size={20} /><strong>No growth data yet</strong><span>The runner sends it with its next push once it runs a version with the Growth view.</span></div>;

  const apps = metrics.apps.filter(a => !repo || a.repo.toLowerCase() === repo.toLowerCase());
  const sites = metrics.sites.filter(s => !repo || s.repo.toLowerCase() === repo.toLowerCase());
  const repos = [...new Set(apps.map(a => a.repo))];
  const smooth = (v: Values) => daily ? v : rolling(v, days);
  const ios = apps.filter(a => a.store === 'appstore');
  const play = apps.filter(a => a.store === 'play');
  const since = days[0];
  const changes30 = apps.flatMap(a => a.changes).filter(c => (c.liveAt ?? c.at).slice(0, 10) >= addDays(today, -30)).length;
  const pages30 = sites.flatMap(s => s.published).filter(p => p.at.slice(0, 10) >= addDays(today, -30)).length;

  return (
    <>
      <div className="toolbar">
        <div className="tabs">{RANGES.map(r => <button key={r} className={String(count) === r ? 'active' : ''} onClick={() => setRange(r)}>{r} days</button>)}</div>
        <div className="tabs">
          <button className={!daily ? 'active' : ''} onClick={() => setDaily(false)} title="Each day shows the mean of the 7 days ending on it">7-day average</button>
          <button className={daily ? 'active' : ''} onClick={() => setDaily(true)}>Daily</button>
        </div>
        <span className="meta" title={new Date(metrics.at).toLocaleString()}>Series from {new Date(metrics.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
      </div>

      <div className="stats growth-stats">
        {weekTile('App Store first downloads', ios.map(a => funnelValues(a, 'firstDownloads')))}
        {weekTile('Play installs', play.map(a => funnelValues(a, 'userInstalls')))}
        {weekTile('App Store page views', ios.map(a => funnelValues(a, 'pageViews')))}
        {weekTile('App Store proceeds', ios.map(a => funnelValues(a, 'proceeds')), money)}
        <Tile label="Listing changes" value={String(changes30)} sub="isobot applied · 30 days" />
        <Tile label="Pages published" value={String(pages30)} sub="content train · 30 days" />
      </div>

      {repos.length ? repos.map(r => (
        <RepoGrowth key={r} apps={apps.filter(a => a.repo === r)} sites={sites.filter(s => s.repo === r)} days={days} smooth={smooth} daily={daily} />
      )) : <div className="empty"><Inbox size={20} /><strong>No store apps in this repository</strong></div>}

      <Phrases apps={apps} selected={appParam} select={setApp} />

      <WebSearch sites={sites} since={since} credits={repo ? null : metrics.credits} today={today} />
    </>
  );
}

function RepoGrowth({ apps, sites, days, smooth, daily }: { apps: MetricsApp[]; sites: MetricsSite[]; days: string[]; smooth: (v: Values) => Values; daily: boolean }) {
  const ios = apps.find(a => a.store === 'appstore');
  const play = apps.find(a => a.store === 'play');
  const markers = [...listingMarkers(apps), ...pageMarkers(sites)];
  const name = ios?.name ?? play?.name ?? apps[0].repo;
  const through = (app?: MetricsApp) => app?.funnel.at(-1)?.day;
  const basis = daily ? 'per day' : '7-day average';

  const installs: Series[] = [
    ...(ios ? [{ id: 'ios', label: 'App Store first downloads', color: COLORS.appstore, values: smooth(funnelValues(ios, 'firstDownloads')) }] : []),
    ...(play ? [{ id: 'play', label: 'Play installs', color: COLORS.play, values: smooth(funnelValues(play, 'userInstalls')) }] : []),
  ];
  const traffic: Series[] = [
    ...(ios ? [{ id: 'ios', label: 'App Store page views', color: COLORS.appstore, values: smooth(funnelValues(ios, 'pageViews')) }] : []),
    ...(play ? [{ id: 'play', label: 'Play listing visitors', color: COLORS.play, values: smooth(funnelValues(play, 'visitors')) }] : []),
  ];
  const rankValues = (app: MetricsApp | undefined) => new Map((app?.ranks ?? []).map(r => [r.day, r.top10]));
  const ranks: Series[] = [
    ...(ios?.ranks.length ? [{ id: 'ios', label: `App Store (${ios.storefront.toUpperCase()})`, color: COLORS.appstore, values: rankValues(ios) }] : []),
    ...(play?.ranks.length ? [{ id: 'play', label: `Google Play (${play.storefront.toUpperCase()})`, color: COLORS.play, values: rankValues(play) }] : []),
  ];
  const rankStart = [ios, play].flatMap(a => a?.ranks[0]?.day ?? []).sort()[0];
  const hasFunnel = (s: Series[]) => s.some(x => x.values.size);

  // Conversion over the newest 7 days each store has.
  const conv = (app: MetricsApp | undefined, num: string, den: string) => {
    const n = lastWeeks(funnelValues(app, num)), d = lastWeeks(funnelValues(app, den));
    return n && d && d.now > 0 ? n.now / d.now : null;
  };
  const iosConv = conv(ios, 'firstDownloads', 'pageViews');
  const playConv = conv(play, 'acquisitions', 'visitors');
  // Play's ratings report: a level (overall average) and the days with new ratings. Play gives no count.
  const playRating = funnelValues(play, 'ratingTotal');
  const ratingSeries: Series[] = play && playRating.size ? [{ id: 'play', label: 'Google Play overall rating', color: COLORS.play, values: playRating }] : [];
  const ratingThrough = [...funnelValues(play, 'ratingDaily').keys(), ...playRating.keys()].sort().at(-1);
  const ratedDays30 = ratingThrough ? [...funnelValues(play, 'ratingDaily')].filter(([d, v]) => v > 0 && d >= addDays(ratingThrough, -29)).length : null;
  const latestRating = ratingThrough ? [...playRating].sort((a, b) => a[0].localeCompare(b[0])).at(-1)?.[1] : undefined;
  const trials = lastWeeks(funnelValues(ios, 'trials'));
  const deletions = lastWeeks(funnelValues(ios, 'deletions'));

  return (
    <section className="section growth-repo">
      <div className="section-head">
        <h2>{name}</h2>
        <span className="row-chips">
          {ios ? <span className="chip muted" title="Apple's analytics reports arrive a day or two late"><Apple size={11} />data to {through(ios) ? dayLabel(through(ios)!) : '—'}</span> : null}
          {play ? <span className="chip muted" title="Play Console's reports arrive a few days late"><Play size={11} />data to {through(play) ? dayLabel(through(play)!) : '—'}</span> : null}
        </span>
      </div>
      <div className="growth-body">
        <MarkerKey />
        <div className="chart-grid">
          <ChartCard title="New installs" caption={basis} legend={installs} empty={hasFunnel(installs) ? undefined : 'No install numbers yet'}
            table={() => <SeriesTable days={days} series={installs} />}>
            <LineChart days={days} series={installs} markers={markers} />
          </ChartCard>
          <ChartCard title="Store listing traffic" caption={basis} legend={traffic} empty={hasFunnel(traffic) ? undefined : 'No listing traffic numbers yet'}
            table={() => <SeriesTable days={days} series={traffic} />}>
            <LineChart days={days} series={traffic} markers={markers} />
          </ChartCard>
          <ChartCard title="Search phrases in the top 10" caption={rankStart ? `Tracked phrases on the main storefront · since ${dayLabel(rankStart)}` : undefined} legend={ranks}
            empty={ranks.length ? undefined : 'No rank snapshots yet'} table={() => <SeriesTable days={days} series={ranks} />}>
            <LineChart days={days} series={ranks} markers={markers} />
          </ChartCard>
          {ratingSeries.length ? (
            <ChartCard title="Google Play rating" caption={`Overall average, Play's ratings report${ratingThrough ? ` to ${dayLabel(ratingThrough)}` : ''}`} legend={ratingSeries}
              table={() => <SeriesTable days={days} series={ratingSeries} format={n => n.toFixed(2)} />}>
              <LineChart days={days} series={ratingSeries} markers={markers} format={n => n.toFixed(1)} />
            </ChartCard>
          ) : null}
          <div className="chart-card mini-tiles">
            <Mini label="App Store conversion" value={iosConv === null ? '—' : pct(iosConv)} hint="first downloads ÷ page views, 7 days" />
            <Mini label="Play conversion" value={playConv === null ? '—' : pct(playConv)} hint="listing acquisitions ÷ visitors, 7 days" />
            <Mini label="Free trials started" value={trials ? exact(trials.now) : '—'} hint="App Store, 7 days" delta={trials ? <Delta now={trials.now} before={trials.before} /> : null} />
            <Mini label="Deletions" value={deletions ? exact(deletions.now) : '—'} hint="App Store, 7 days" delta={deletions ? <Delta now={deletions.now} before={deletions.before} goodUp={false} /> : null} />
            <Mini label="Ranked phrases" value={ios?.ranks.at(-1) ? `${ios.ranks.at(-1)!.ranked} / ${ios.ranks.at(-1)!.tracked}` : '—'} hint={`App Store top 200${ios?.ranks.at(-1)?.median ? ` · median #${exact(ios.ranks.at(-1)!.median!)}` : ''}`} />
            {play ? <Mini label="Play rating" value={latestRating === undefined ? '—' : `${latestRating.toFixed(2)}★`} hint={ratingThrough ? `overall · new ratings on ${ratedDays30} of 30 days to ${dayLabel(ratingThrough)}` : 'no ratings report yet (none rated)'} /> : null}
            <Mini label="Play ranked phrases" value={play?.ranks.at(-1) ? `${play.ranks.at(-1)!.ranked} / ${play.ranks.at(-1)!.tracked}` : '—'} hint={`Play results${play?.ranks.at(-1)?.median ? ` · median #${exact(play.ranks.at(-1)!.median!)}` : ''}`} />
          </div>
        </div>
        <Changes apps={apps} sites={sites} />
      </div>
    </section>
  );
}

function Mini({ label, value, hint, delta }: { label: string; value: string; hint: string; delta?: ReactNode }) {
  return <div className="mini"><span className="stat-label">{label}</span><span className="mini-value">{value}</span>{delta}<span className="stat-sub">{hint}</span></div>;
}

/** The newest things isobot changed for this app, newest first. */
function Changes({ apps, sites }: { apps: MetricsApp[]; sites: MetricsSite[] }) {
  const rows = [
    ...apps.flatMap(app => app.changes.map(c => ({ at: c.liveAt ?? c.at, icon: app.store === 'play' ? <Play size={12} /> : <Apple size={12} />, text: `${app.store === 'play' ? 'Play' : 'App Store'} listing: ${c.fields.map(f => FIELD_LABELS[f] ?? f).join(', ')}`, sub: c.version ? `onto v${c.version}${c.liveAt ? ', live' : ', waiting for release'}` : c.liveAt ? 'committed' : '', href: undefined as string | undefined }))),
    ...sites.flatMap(site => site.published.map(p => ({ at: p.at, icon: <Newspaper size={12} />, text: p.title, sub: site.site, href: p.prNumber ? `https://github.com/${site.repo}/pull/${p.prNumber}` : undefined }))),
  ].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 8);
  if (!rows.length) return null;
  return (
    <div className="changes">
      <div className="changes-title">What isobot changed</div>
      {rows.map((r, i) => {
        const body = <><span className="changes-icon">{r.icon}</span><span className="changes-text">{r.text}{r.sub ? <span className="sub-inline"> · {r.sub}</span> : null}</span><span className="row-time">{dayLabel(toDay(new Date(r.at)))}</span>{r.href ? <ExternalLink size={11} className="tone-muted" /> : null}</>;
        return r.href ? <a key={i} className="changes-row" href={r.href} target="_blank" rel="noreferrer">{body}</a> : <div key={i} className="changes-row">{body}</div>;
      })}
    </div>
  );
}

// ---------- phrases ----------

function RankMove({ now, was }: { now: number | null; was: number | null | undefined }) {
  if (was === undefined) return <span className="tone-muted">—</span>;
  if (now === was) return <span className="tone-muted">·</span>;
  // Lower is better: moving from 20 to 12 is +8; entering the top 200 counts as new.
  if (was === null) return <span className="delta up"><ArrowUp size={11} />new</span>;
  if (now === null) return <span className="delta down"><ArrowDown size={11} />out</span>;
  const gain = was - now;
  return <span className={`delta ${gain > 0 ? 'up' : 'down'}`}>{gain > 0 ? <ArrowUp size={11} /> : <ArrowDown size={11} />}{Math.abs(gain)}</span>;
}

function Phrases({ apps, selected, select }: { apps: MetricsApp[]; selected: string; select: (id: string) => void }) {
  const withPhrases = apps.filter(a => a.phrases.length);
  const app = withPhrases.find(a => a.id === selected) ?? withPhrases[0];
  const storefronts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of app?.phrases ?? []) counts.set(p.storefront, (counts.get(p.storefront) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => (b[0] === app?.storefront ? 1 : 0) - (a[0] === app?.storefront ? 1 : 0) || b[1] - a[1]).map(([s]) => s);
  }, [app]);
  const [storefront, setStorefront] = useState('');
  const [q, setQ] = useState('');
  const [rankedOnly, setRankedOnly] = useState(true);
  useEffect(() => { setStorefront(''); }, [app?.id]);
  if (!app) return null;
  const front = storefront || app.storefront;
  const needle = q.toLowerCase();
  const rows: PhraseRank[] = app.phrases.filter(p => p.storefront === front && (!rankedOnly || p.rank !== null) && (!needle || p.text.toLowerCase().includes(needle)));
  const label = (a: MetricsApp) => `${a.name.split(':')[0]} · ${a.store === 'play' ? 'Play' : 'App Store'}`;
  return (
    <Section title="Search phrases" action={<span className="meta">{app.compare.latest ? `Newest readings to ${dayLabel(app.compare.latest)}` : ''}</span>}>
      <div className="toolbar inset">
        <select value={app.id} onChange={e => select(e.target.value)} aria-label="App">
          {withPhrases.map(a => <option key={`${a.store}:${a.id}`} value={a.id}>{label(a)}</option>)}
        </select>
        <select value={front} onChange={e => setStorefront(e.target.value)} aria-label="Storefront">
          {storefronts.map(s => <option key={s} value={s}>{s.toUpperCase()}{s === app.storefront ? ' (main)' : ''}</option>)}
        </select>
        <div className="tabs">
          <button className={rankedOnly ? 'active' : ''} onClick={() => setRankedOnly(true)}>Ranked</button>
          <button className={!rankedOnly ? 'active' : ''} onClick={() => setRankedOnly(false)}>All tracked</button>
        </div>
        <label className="search"><Search size={14} /><input value={q} onChange={e => setQ(e.target.value)} placeholder="Filter phrases…" />{q ? <button className="icon" onClick={() => setQ('')}><X size={12} /></button> : null}</label>
        <span className="meta">{rows.length} phrases</span>
      </div>
      {rows.length ? (
        <div className="table-scroll">
          <table className="table compact">
            <thead><tr><th>Phrase</th><th className="num">Rank</th><th className="num" title={app.compare.d7 ? `Against ${dayLabel(app.compare.d7)}` : 'No reading a week back yet'}>7 days</th><th className="num" title={app.compare.d28 ? `Against ${dayLabel(app.compare.d28)}` : 'No reading four weeks back yet'}>28 days</th><th className="num" title="ASO Tracker's demand estimate (0–100), not Apple's search volume">Demand</th></tr></thead>
            <tbody>{rows.map(p => (
              <tr key={p.text}>
                <td>{p.text}</td>
                <td className="num">{p.rank === null ? <span className="tone-muted">200+</span> : `#${p.rank}`}</td>
                <td className="num"><RankMove now={p.rank} was={p.was7} /></td>
                <td className="num"><RankMove now={p.rank} was={p.was28} /></td>
                <td className="num">{p.volume ?? '—'}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      ) : <div className="chart-empty"><Inbox size={16} />{rankedOnly ? 'No phrase ranks in the first 200 here' : 'No phrases tracked here'}</div>}
    </Section>
  );
}

// ---------- web search ----------

function WebSearch({ sites, since, credits, today }: { sites: MetricsSite[]; since: string; credits: Metrics['credits'] | null; today: string }) {
  if (!sites.length && !credits) return null;
  const creditDays = credits ? dayRange(today, 30).map(d => ({ key: d, label: dayLabel(d), value: credits.days.find(c => c.day === d)?.spent ?? 0 })) : [];
  return (
    <Section title="Web search" action={credits?.balance != null ? <span className="meta">OpenSEO credits left: {credits.balance.toLocaleString()}</span> : undefined}>
      <div className="growth-body">
        <div className="chart-grid">
          {sites.map(site => {
            const weeks = site.search.filter(w => w.day >= since);
            const points = weeks.map(w => ({ key: w.day, label: dayLabel(w.day), value: w.last7.clicks, note: `${w.last7.impressions.toLocaleString()} impressions · CTR ${pct(w.last7.ctr)} · avg position ${w.last7.position.toFixed(1)}` }));
            const latest = weeks.at(-1);
            return (
              <ChartCard key={site.repo} title={site.site} caption={<><Globe size={11} /> Search Console clicks, 7 days to each weekly report</>}
                empty={points.length ? undefined : 'The first reading comes with Monday’s weekly search report'}
                table={() => (
                  <table className="table compact">
                    <thead><tr><th>Week to</th><th className="num">Clicks</th><th className="num">Impressions</th><th className="num">CTR</th><th className="num">Position</th></tr></thead>
                    <tbody>{[...weeks].reverse().map(w => <tr key={w.day}><td>{longDay(w.day)}</td><td className="num">{exact(w.last7.clicks)}</td><td className="num">{exact(w.last7.impressions)}</td><td className="num">{pct(w.last7.ctr)}</td><td className="num">{w.last7.position.toFixed(1)}</td></tr>)}</tbody>
                  </table>
                )}>
                <ColumnChart points={points} color={COLORS.web} label="Clicks" />
                {latest ? <div className="chart-foot">
                  <span>{exact(latest.last7.impressions)} impressions</span>
                  {latest.previous7 ? <Delta now={latest.last7.clicks} before={latest.previous7.clicks} /> : null}
                  <span>avg position {latest.last7.position.toFixed(1)}</span>
                </div> : null}
                <div className="chart-foot">{site.published.filter(p => p.at.slice(0, 10) >= since).length} pages published in this range</div>
              </ChartCard>
            );
          })}
          {credits ? (
            <ChartCard title="OpenSEO credits spent" caption="content train research, per day · 30 days" empty={credits.days.length ? undefined : 'No research runs yet'}
              table={() => (
                <table className="table compact"><thead><tr><th>Day</th><th className="num">Credits</th></tr></thead>
                  <tbody>{[...credits.days].reverse().map(c => <tr key={c.day}><td>{longDay(c.day)}</td><td className="num">{exact(c.spent)}</td></tr>)}</tbody></table>
              )}>
              <ColumnChart points={creditDays} color={COLORS.web} label="Credits" />
            </ChartCard>
          ) : null}
        </div>
      </div>
    </Section>
  );
}

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return <section className="section"><div className="section-head"><h2>{title}</h2>{action}</div>{children}</section>;
}
