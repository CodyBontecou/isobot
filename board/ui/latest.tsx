import { Apple, Play, TriangleAlert } from 'lucide-react';
import { Delta, Section, Tile } from './growth';
import type { MetricsApp, StoreChecks } from './types';

/**
 * Latest from the stores: the newest installs, proceeds and subscriptions each store has published, for every app,
 * with when the runner last looked (hourly). Apple and Google publish these reports about once a day, a day or a few
 * late, so "latest" is each report's newest day, not today.
 */

const DAY = 86_400_000;
const parseDay = (day: string) => new Date(`${day}T12:00:00`);
const toDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (day: string, n: number) => toDay(new Date(parseDay(day).getTime() + n * DAY));
const dayLabel = (day: string) => parseDay(day).toLocaleDateString([], { month: 'short', day: 'numeric' });
const money = (n: number) => n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: Math.abs(n) >= 100 ? 0 : 2 });
const whole = (n: number) => n.toLocaleString();
const ago = (iso: string | null | undefined) => {
  if (!iso) return 'not yet';
  const min = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
};
const newest = (...iso: (string | null | undefined)[]) => iso.filter((v): v is string => !!v).sort().at(-1) ?? null;

/** A day series ending at `through`: the sum over [through-6, through] and the 7 days before. */
interface Week { now: number; before: number | null; through: string }

/** One app on one store, reduced to what the panel shows. */
interface Row {
  app: MetricsApp;
  /** Newest day of the installs numbers and of the money numbers (they come from different reports on Play). */
  installsThrough: string | null;
  moneyThrough: string | null;
  installsDay: number | null;
  proceedsDay: number | null;
  installs: Week | null;
  proceeds: Week | null;
  monthToDate: number | null;
  subs: { active: number; paid: number | null; trials: number | null; day: string } | null;
  newSubs: Week | null;
  devices: number | null;
  estimate: boolean;
}

function week(values: Map<string, number>, through: string | null, dense: boolean): Week | null {
  if (!through) return null;
  const sum = (from: string, to: string) => {
    let t = 0;
    let seen = false;
    for (const [d, v] of values) if (d >= from && d <= to) { t += v; seen = true; }
    return { t, seen };
  };
  const now = sum(addDays(through, -6), through);
  const before = sum(addDays(through, -13), addDays(through, -7));
  // A sparse series (Play's reports list only days with an order or a subscription) counts a missing day as 0.
  return { now: now.t, before: dense && !before.seen ? null : before.t, through };
}

function monthToDate(values: Map<string, number>, through: string | null): number | null {
  if (!through) return null;
  let t = 0;
  for (const [d, v] of values) if (d.slice(0, 7) === through.slice(0, 7) && d <= through) t += v;
  return t;
}

function appleRow(app: MetricsApp): Row {
  const s = app.sales;
  const through = s?.through ?? null;
  const installs = new Map((s?.days ?? []).map(d => [d.day, d.downloads]));
  const proceeds = new Map((s?.days ?? []).map(d => [d.day, d.total]));
  const trials = new Map((s?.days ?? []).map(d => [d.day, d.trials]));
  const sub = s?.subs.at(-1);
  return {
    app, installsThrough: through, moneyThrough: through,
    installsDay: through ? installs.get(through) ?? null : null,
    proceedsDay: through ? proceeds.get(through) ?? null : null,
    installs: week(installs, through, true),
    proceeds: week(proceeds, through, true),
    monthToDate: monthToDate(proceeds, through),
    subs: sub ? { active: sub.paid + sub.trials, paid: sub.paid, trials: sub.trials, day: sub.day } : null,
    newSubs: sub ? week(trials, through, true) : null,
    devices: null,
    estimate: false,
  };
}

function playRow(app: MetricsApp): Row {
  const installs = new Map(app.funnel.filter(d => d.v.userInstalls !== undefined).map(d => [d.day, d.v.userInstalls]));
  const installsThrough = [...installs.keys()].sort().at(-1) ?? null;
  const devices = [...app.funnel].reverse().find(d => d.v.activeDevices !== undefined)?.v.activeDevices ?? null;
  const p = app.playSales;
  // The sales report lists orders only; the day before Google last rewrote it is covered even without any.
  const updated = p?.salesUpdatedAt ? addDays(toDay(new Date(p.salesUpdatedAt)), -1) : null;
  const moneyThrough = newest(p?.through, updated);
  const proceeds = new Map((p?.days ?? []).map(d => [d.day, d.proceeds]));
  const newSubs = new Map((p?.subs ?? []).map(d => [d.day, d.new]));
  const sub = p?.subs.at(-1);
  return {
    app, installsThrough, moneyThrough,
    installsDay: installsThrough ? installs.get(installsThrough) ?? null : null,
    proceedsDay: moneyThrough && p ? proceeds.get(moneyThrough) ?? 0 : null,
    installs: week(installs, installsThrough, true),
    proceeds: p ? week(proceeds, moneyThrough, false) : null,
    monthToDate: p ? monthToDate(proceeds, moneyThrough) : null,
    subs: sub ? { active: sub.active, paid: null, trials: null, day: sub.day } : null,
    newSubs: p?.subsThrough ? week(newSubs, p.subsThrough, false) : null,
    devices,
    estimate: true,
  };
}

/** Rows' weeks added up; "before" only when every row has one. */
function total(weeks: (Week | null)[]): Week | null {
  const w = weeks.filter((x): x is Week => x !== null);
  if (!w.length) return null;
  return { now: w.reduce((a, x) => a + x.now, 0), before: w.every(x => x.before !== null) ? w.reduce((a, x) => a + (x.before ?? 0), 0) : null, through: w.map(x => x.through).sort()[0] };
}

const throughText = (rows: Row[], pick: (r: Row) => string | null) => {
  const by = (store: MetricsApp['store']) => rows.filter(r => r.app.store === store).map(pick).filter((d): d is string => !!d).sort()[0];
  const ios = by('appstore'), play = by('play');
  return [ios ? `App Store to ${dayLabel(ios)}` : '', play ? `Play to ${dayLabel(play)}` : ''].filter(Boolean).join(' · ') || 'No reports yet';
};

function WeekTile({ label, w, format, sub }: { label: string; w: Week | null; format: (n: number) => string; sub: string }) {
  if (!w) return <Tile label={label} value="—" sub="No reports yet" />;
  return <Tile label={label} value={format(w.now)} delta={<Delta now={w.now} before={w.before} format={format} />} sub={sub} />;
}

export function Latest({ apps, checks }: { apps: MetricsApp[]; checks?: StoreChecks }) {
  const rows = [
    ...apps.filter(a => a.store === 'appstore' && a.sales).map(appleRow),
    ...apps.filter(a => a.store === 'play').map(playRow),
  ].filter(r => r.installs || r.proceeds || r.subs);
  if (!rows.length) return null;
  rows.sort((a, b) => a.app.name.localeCompare(b.app.name) || a.app.store.localeCompare(b.app.store));

  const installs = total(rows.map(r => r.installs));
  const proceeds = total(rows.map(r => r.proceeds));
  const mtd = rows.reduce((a, r) => a + (r.monthToDate ?? 0), 0);
  const subRows = rows.filter(r => r.subs);
  const active = subRows.reduce((a, r) => a + r.subs!.active, 0);
  const applePaid = subRows.reduce((a, r) => a + (r.subs!.paid ?? 0), 0);
  const appleTrials = subRows.reduce((a, r) => a + (r.subs!.trials ?? 0), 0);
  const playActive = subRows.filter(r => r.app.store === 'play').reduce((a, r) => a + r.subs!.active, 0);
  const newSubs = total(rows.map(r => r.newSubs));
  const devices = rows.reduce((a, r) => a + (r.devices ?? 0), 0);
  const hasDevices = rows.some(r => r.devices !== null);
  const apple = newest(checks?.appleSales, checks?.appleAnalytics);
  const months = new Set(rows.map(r => r.moneyThrough?.slice(0, 7)).filter(Boolean));
  const monthName = months.size === 1 ? parseDay(`${[...months][0]}-15`).toLocaleDateString([], { month: 'long' }) : 'This month';

  return (
    <Section title="Latest from the stores" action={
      <span className="latest-checks">
        {checks ? <>
          <span className="chip muted" title={`Sales and subscription reports: ${checks.appleSales ? new Date(checks.appleSales).toLocaleString() : 'not yet'}; analytics reports: ${checks.appleAnalytics ? new Date(checks.appleAnalytics).toLocaleString() : 'not yet'}`}><Apple size={11} />checked {ago(apple)}</span>
          {checks.playError
            ? <span className="chip warn" title={checks.playError}><TriangleAlert size={11} />Play reports unreadable</span>
            : <span className="chip muted" title={checks.play ? new Date(checks.play).toLocaleString() : 'not yet'}><Play size={11} />checked {ago(checks.play)}</span>}
        </> : null}
        <span className="meta" title="The runner reads both stores every hour. Apple and Google publish these reports about once a day, a day or a few late.">hourly</span>
      </span>
    }>
      <div className="growth-body">
        <div className="stats growth-stats revenue-stats">
          <WeekTile label="Installs, 7 days" w={installs} format={whole} sub={throughText(rows, r => r.installsThrough)} />
          <WeekTile label="Proceeds, 7 days" w={proceeds} format={money} sub={throughText(rows, r => r.moneyThrough)} />
          <Tile label={`${monthName} so far`} value={money(mtd)} sub="App Store + Play (est.)" />
          <Tile label="Active subscriptions" value={subRows.length ? whole(active) : '—'}
            sub={subRows.length ? [applePaid || appleTrials ? `App Store ${whole(applePaid)} paid · ${whole(appleTrials)} trial` : '', playActive ? `Play ${whole(playActive)}` : ''].filter(Boolean).join(' · ') : 'No subscription reports yet'} />
          <WeekTile label="New trials & subscriptions, 7 days" w={newSubs} format={whole} sub="App Store free trials + Play new subscriptions" />
          <Tile label="Play devices with the app" value={hasDevices ? whole(devices) : '—'} sub="Play's active device installs" />
        </div>
        <div className="chart-card">
          <div className="chart-head"><div><h3>By app</h3><div className="chart-caption">Each store's newest day, and the 7 days to it · Play's installs and sales reports end on different days (installs / sales) · USD after the store's fee; Play's (~) is an estimate: price before tax, less Google's 15%</div></div></div>
          <div className="table-scroll">
            <table className="table compact stack latest-table">
              <thead><tr>
                <th>App</th><th>Newest day</th><th className="num">Installs</th><th className="num">Proceeds</th>
                <th className="num">Installs, 7 d</th><th className="num">Proceeds, 7 d</th><th className="num">Month so far</th><th className="num">Subscriptions</th>
              </tr></thead>
              <tbody>{rows.map(r => (
                <tr key={`${r.app.store}:${r.app.id}`}>
                  <td className="lead">{r.app.store === 'appstore' ? <Apple size={12} /> : <Play size={12} />} {r.app.name.split(':')[0]}</td>
                  <td data-label="Newest day" title={r.installsThrough !== r.moneyThrough ? `installs to ${r.installsThrough ? dayLabel(r.installsThrough) : '—'}, sales to ${r.moneyThrough ? dayLabel(r.moneyThrough) : '—'}` : undefined}>
                    {r.installsThrough === r.moneyThrough || !r.moneyThrough ? (r.installsThrough ? dayLabel(r.installsThrough) : '—') : `${r.installsThrough ? dayLabel(r.installsThrough) : '—'} / ${dayLabel(r.moneyThrough)}`}
                  </td>
                  <td className="num" data-label="Installs">{r.installsDay === null ? '—' : whole(r.installsDay)}</td>
                  <td className="num" data-label="Proceeds">{r.proceedsDay === null ? '—' : `${r.estimate ? '~' : ''}${money(r.proceedsDay)}`}</td>
                  <td className="num" data-label="7 d installs">{r.installs ? whole(r.installs.now) : '—'}</td>
                  <td className="num" data-label="7 d proceeds">{r.proceeds ? `${r.estimate ? '~' : ''}${money(r.proceeds.now)}` : '—'}</td>
                  <td className="num" data-label="Month">{r.monthToDate === null ? '—' : `${r.estimate ? '~' : ''}${money(r.monthToDate)}`}</td>
                  <td className="num" data-label="Subs" title={r.subs ? `on ${dayLabel(r.subs.day)}` : undefined}>
                    {r.subs ? (r.subs.paid !== null ? `${whole(r.subs.paid)} paid · ${whole(r.subs.trials ?? 0)} trial` : `${whole(r.subs.active)} active`) : '—'}
                  </td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </div>
      </div>
    </Section>
  );
}
