import { failure, parseTsv, RateLimited, type AscRun } from "./analytics.js";
import { asoApps, type RunnerConfig } from "./config.js";
import { localDay } from "./content.js";
import { CONTROLS, PROPOSAL_CONTROLS } from "./notify.js";
import type { GitHubApi } from "./github.js";
import type { Store } from "./store.js";

/**
 * The crash audit: what crashes in isobot's apps, read every few hours from the stores, with no SDK in the apps.
 *
 *   - Google Play (Play Developer Reporting API, the ASO train's service account): error issues, Play's own
 *     clusters of crashes and ANRs with a sample stack trace each, and the daily crash and ANR rates (Play only
 *     returns rates above its privacy threshold, so small apps often have none)
 *   - App Store (Analytics Reports, the same ONGOING request analytics.ts reads): the "App Crashes" report,
 *     crash counts by app version. Apple writes it daily, weekly or monthly depending on volume, and has no stacks
 *   - TestFlight (App Store Connect API): crash submissions from testers, each with its crash log
 *
 * Similar clusters are grouped (one bug Play splits by version or obfuscated frame is one group), and each group
 * that reaches `minUsers` becomes one GitHub issue in the app's repository, labelled isobot:proposed and bug, so the
 * owner approves a fix like any other proposal. Groups are remembered so they're filed once; an open issue that
 * already names the crashing method counts as filed. The daily check-in carries a line per app and flags spikes.
 */

const SYNC_EVERY_MS = 6 * 3_600_000;
const RATE_LIMIT_RETRY_MS = 65 * 60_000;
/** Error issues are read over this many days. */
const WINDOW_DAYS = 28;
const KEEP_DAYS = 120;
/** App Crashes instances read per app and pass (a request each), so a first backfill doesn't crowd out releases. */
const INSTANCES_PER_PASS = 8;
export const REPORTING_SCOPE = "https://www.googleapis.com/auth/playdeveloperreporting";
const REPORTING = "https://playdeveloperreporting.googleapis.com/v1beta1";
/** Play's bad-behavior thresholds (user-perceived rates over 28 days), in percent. */
export const PLAY_THRESHOLDS = { crash: 1.09, anr: 0.47 };
/** The marker on issues the audit opens (dashboard.ts reads it). */
export const CRASH_MARKER = "<!-- isobot:crash:";

export interface GoogleJson { json(scope: string, url: string, init?: { method?: string; body?: unknown }): Promise<unknown> }

export interface CrashDeps {
  config: RunnerConfig;
  store: Store;
  /** Read-only asc. */
  asc: AscRun;
  fetchGz(url: string): Promise<string>;
  /** The ONGOING analytics request of an App Store app (AppAnalytics.requestId). */
  requestId(appId: string): Promise<string | null>;
  /** Google's service account; null leaves Play out. */
  google: GoogleJson | null;
  github: Pick<GitHubApi, "createIssue" | "isPublic" | "openIssues">;
  /** Posts to the staff channel; `reactions` become one-click controls (the bridge acts on ✅ and 🧹). */
  notify(text: string, reactions?: readonly string[]): Promise<unknown>;
  now?(): Date;
}

/** One of Play's error issues, as errorIssues:search returns it. */
export interface PlayIssue {
  name: string;
  type?: string;
  cause?: string;
  location?: string;
  errorReportCount?: string;
  distinctUsers?: string;
  lastErrorReportTime?: string;
  issueUri?: string;
  firstAppVersion?: { versionCode?: string };
  lastAppVersion?: { versionCode?: string };
}

/** Several of Play's issues that are one bug. */
export interface CrashGroup {
  key: string;
  kind: "crash" | "anr";
  /** Where it happens (class.method) and what (exception or ANR reason). */
  where: string;
  what: string;
  reports: number;
  /** Summed over the group's issues, so a user hit by two of them counts twice. */
  users: number;
  versions: string[];
  lastAt: string;
  issues: PlayIssue[];
  /** R8 left the frame unreadable: upload the mapping file to Play to make these useful. */
  obfuscated: boolean;
}

/** An App Store version's crashes in one period. */
export interface IosPeriod { src: string; crashes: number; devices: number; versions: Record<string, { crashes: number; devices: number }> }

const int = (s: string | undefined) => { const x = Number(s ?? ""); return Number.isFinite(x) ? x : 0; };
const addDays = (day: string, by: number) => new Date(Date.parse(`${day}T12:00:00Z`) + by * 86_400_000).toISOString().slice(0, 10);
const shortDay = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const plural = (n: number, word: string) => `${n.toLocaleString("en-US")} ${word}${n === 1 ? "" : /(sh|ch|s|x)$/.test(word) ? "es" : "s"}`;

/** `File.kt - com.x.Foo.bar$lambda$1$lambda$2` → `com.x.Foo.bar`. */
export function frame(cause: string | undefined): string {
  return (cause ?? "").replace(/^[^ ]+ - /, "").replace(/(\$lambda\$\d+)+$/, "").replace(/\$\d+(\.invokeSuspend)?$/, "").replace(/\$/g, ".").trim();
}
const isObfuscated = (cause: string | undefined) => /^(SourceFile|unavailable|Unknown Source) - /.test(cause ?? "") || /^[a-zA-Z]\d?(\.[a-zA-Z0-9]{1,3}){1,3}$/.test(frame(cause));
const className = (f: string) => f.includes(".") ? f.slice(0, f.lastIndexOf(".")) : f;
const isOom = (g: Pick<CrashGroup, "what">) => /OutOfMemoryError/.test(g.what);
/** `Foo.bar` for a frame, `Foo` for an out-of-memory group (whose `where` is a class). */
export function shortWhere(g: Pick<CrashGroup, "where" | "what">): string {
  const parts = g.where.split(".");
  return isOom(g) ? parts.at(-1)! : parts.slice(-2).join(".");
}

/**
 * Groups Play's issues into bugs. ANRs group by the frame they block in (Play's reason text varies);
 * out-of-memory crashes by class, since the frame is only where the last allocation failed; obfuscated frames
 * into one group per kind; other crashes by frame and exception.
 */
export function groupIssues(issues: PlayIssue[]): CrashGroup[] {
  const groups = new Map<string, CrashGroup>();
  for (const i of issues) {
    const kind = i.type === "APPLICATION_NOT_RESPONDING" ? "anr" : i.type === "CRASH" ? "crash" : null;
    if (!kind) continue;
    const obfuscated = isObfuscated(i.cause);
    const f = frame(i.cause);
    const oom = /OutOfMemoryError/.test(i.location ?? "");
    const where = obfuscated ? "obfuscated frames" : oom ? className(f) : f;
    const what = kind === "anr" ? "ANR" : (i.location ?? "crash");
    const key = `${kind}|${obfuscated ? "obfuscated" : where}|${kind === "anr" ? "" : what}`.toLowerCase();
    const g = groups.get(key) ?? { key, kind, where, what, reports: 0, users: 0, versions: [], lastAt: "", issues: [], obfuscated };
    g.reports += int(i.errorReportCount);
    g.users += int(i.distinctUsers);
    for (const v of [i.firstAppVersion?.versionCode, i.lastAppVersion?.versionCode]) if (v && !g.versions.includes(v)) g.versions.push(v);
    if ((i.lastErrorReportTime ?? "") > g.lastAt) g.lastAt = i.lastErrorReportTime ?? "";
    g.issues.push(i);
    groups.set(key, g);
  }
  for (const g of groups.values()) {
    g.versions.sort((a, b) => Number(a) - Number(b));
    g.issues.sort((a, b) => int(b.distinctUsers) - int(a.distinctUsers) || int(b.errorReportCount) - int(a.errorReportCount));
  }
  return [...groups.values()].sort((a, b) => b.users - a.users || b.reports - a.reports);
}

/** App Crashes rows → date → totals and per-version counts. */
export function iosPeriods(rows: Record<string, string>[], src: string): Map<string, IosPeriod> {
  const out = new Map<string, IosPeriod>();
  for (const r of rows) {
    const day = r["Date"];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day ?? "")) continue;
    const p = out.get(day) ?? { src, crashes: 0, devices: 0, versions: {} };
    const crashes = int(r["Crashes"]);
    const devices = int(r["Unique Devices"]);
    const v = r["App Version"] || "?";
    p.crashes += crashes;
    p.devices += devices;
    const pv = p.versions[v] ?? { crashes: 0, devices: 0 };
    pv.crashes += crashes;
    pv.devices += devices;
    p.versions[v] = pv;
    out.set(day, p);
  }
  return out;
}

/** A crash log's useful part: the exception and the crashed thread's first frames, without device identifiers. */
export function crashExcerpt(log: string, max = 2500): string {
  const lines = log.split(/\r?\n/);
  const keep: string[] = [];
  for (const l of lines) if (/^(Exception Type|Exception Codes|Exception Reason|Termination Reason|Triggered by Thread|Crashed Thread):/.test(l)) keep.push(l.trim());
  const start = lines.findIndex(l => /^Thread \d+( name:.*)? Crashed:/.test(l) || /^Thread \d+ Crashed:/.test(l));
  if (start >= 0) {
    const end = lines.findIndex((l, i) => i > start && !l.trim());
    keep.push("", ...lines.slice(start, Math.min(start + 25, end < 0 ? lines.length : end)).map(l => l.replace(/\s+0x[0-9a-f]+ /i, " ")));
  }
  const text = (keep.length ? keep : lines.filter(l => !/^(Incident Identifier|CrashReporter Key|Beta Identifier|Hardware Model|Process|Path|Identifier|Date\/Time|Launch Time|Report Version|Sleep\/Wake UUID|UUID):/i.test(l)).slice(0, 40)).join("\n").trim();
  return text.length > max ? `${text.slice(0, max)}\n…` : text;
}

/**
 * A Play stack trace, shortened: the first frames, then the app's own frames (and every "Caused by"), with runs of
 * the same frame (deep recursion) collapsed. `appPrefix` is the start of the app's code's package, e.g. com.healthmd.
 */
export function stackExcerpt(text: string, appPrefix: string, max = 45): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let skipped = 0;
  const flush = () => { if (skipped) out.push(`  … ${skipped} more frame${skipped === 1 ? "" : "s"}`); skipped = 0; };
  for (const [i, l] of lines.entries()) {
    const mine = l.includes(appPrefix) || /^\S/.test(l) || /^Caused by/.test(l.trim());
    if (i < 6 || mine) {
      if (out.at(-1) === l) { skipped++; continue; }
      flush();
      out.push(l);
    } else skipped++;
    if (out.length >= max) { skipped += lines.length - i - 1; break; }
  }
  flush();
  return out.join("\n");
}

export interface CheckInCrashes { lines: string[]; flags: string[] }

interface PlaySnapshot { day: string; crashReports: number; anrReports: number; crashUsers: number; anrUsers: number; top: { where: string; what: string; kind: string; users: number; reports: number }[]; latestVersion: string | null; newInLatest: number; obfuscated: number }
interface PlayRates { crash?: number; perceivedCrash?: number; anr?: number; perceivedAnr?: number; users?: number }

export class CrashAudit {
  constructor(private deps: CrashDeps) {}

  private now(): Date { return this.deps.now?.() ?? new Date(); }
  private get limits() { return { minUsers: 2, issuesPerPass: 3, fileIssues: true, autoApprove: false, ...this.deps.config.crashes }; }

  /** The labels a new crash issue gets: queued to build straight away with autoApprove, else a proposal. */
  private issueLabels(): string[] {
    const l = this.deps.config.labels;
    return this.limits.autoApprove ? [l.ready, l.auto, "bug"] : [l.proposed, "bug"];
  }

  private footer(): string {
    const l = this.deps.config.labels;
    return this.limits.autoApprove
      ? `<sub>Opened by isobot's crash audit and approved automatically (crashes.autoApprove); add \`${l.stop}\` to cancel. A fix should reproduce the crash in a test first.</sub>`
      : `<sub>Opened by isobot's crash audit. Add \`${l.ready}\` to approve a fix; a fix should reproduce the crash in a test first.</sub>`;
  }
  enabled(): boolean { return Boolean(this.deps.config.crashes) && (this.iosApps().length > 0 || this.playApps().length > 0); }

  iosApps(): { appId: string; repo: string }[] {
    if (!this.deps.config.crashes) return [];
    return Object.entries(this.deps.config.appStore?.apps ?? {}).map(([appId, repo]) => ({ appId, repo }));
  }

  playApps(): { pkg: string; repo: string }[] {
    if (!this.deps.config.crashes || !this.deps.google) return [];
    return asoApps(this.deps.config).filter(a => a.store === "play").map(a => ({ pkg: a.aso.appId, repo: `${a.owner}/${a.repo}` }));
  }

  /** Apple's name for the app (from analytics), also for its Play twin; else the repository's. */
  private name(repo: string, appId?: string): string {
    const id = appId ?? Object.entries(this.deps.config.appStore?.apps ?? {}).find(([, r]) => r.toLowerCase() === repo.toLowerCase())?.[0];
    return (id && this.deps.store.cursor(`analytics:${id}:name`)) || repo.split("/")[1];
  }

  /** Why the last pass couldn't read a source, by source. */
  errors(): Record<string, string> {
    return Object.fromEntries(this.deps.store.cursorsWithPrefix("crashes:error:").map(r => [r.key.slice("crashes:error:".length), r.value]));
  }

  async tick(force = false): Promise<{ filed: string[] }> {
    const { store } = this.deps;
    const last = store.cursor("crashes:synced");
    if (!force && last && this.now().getTime() - Date.parse(last) < SYNC_EVERY_MS) return { filed: [] };
    store.setCursor("crashes:synced", this.now().toISOString());
    const filed: string[] = [];
    for (const app of this.playApps()) {
      await this.guard(`play:${app.pkg}`, async () => { filed.push(...await this.syncPlay(app.pkg, app.repo)); });
    }
    for (const app of this.iosApps()) {
      const stop = await this.guard(`ios:${app.appId}`, async () => {
        await this.syncIos(app.appId);
        filed.push(...await this.syncTestFlight(app.appId, app.repo));
      });
      if (stop) break;
    }
    if (filed.length && this.limits.autoApprove) {
      await this.deps.notify(`💥 **Crash audit**: opened ${plural(filed.length, "issue")} for crashes users are hitting, queued to fix, merge and ship 🏗:\n${filed.map(f => `• ${f}`).join("\n")}\nAdd \`${this.deps.config.labels.stop}\` to one to cancel it.`).catch(() => undefined);
    } else if (filed.length) {
      // One message per issue: the bridge acts on ✅ only on a message that links exactly one issue.
      await this.deps.notify(`💥 **Crash audit**: opened ${plural(filed.length, "issue")} for crashes users are hitting. React ${CONTROLS.start} on one to have isobot fix it, or ${CONTROLS.cleanup} to dismiss it (or add \`${this.deps.config.labels.ready}\` on GitHub).`).catch(() => undefined);
      for (const f of filed) await this.deps.notify(`🗳 ${f}`, PROPOSAL_CONTROLS).catch(() => undefined);
    }
    return { filed };
  }

  /** Runs one source; a failure is kept for the check-in. Returns true after App Store Connect's rate limit. */
  private async guard(source: string, work: () => Promise<void>): Promise<boolean> {
    const k = `crashes:error:${source}`;
    try {
      await work();
      this.deps.store.deleteCursor(k);
      return false;
    } catch (error) {
      const message = (error as Error).message.slice(0, 300);
      if (this.deps.store.cursor(k) !== message) {
        console.warn(`[crashes] ${source}: ${message}`);
        this.deps.store.event(null, "crash_audit_error", `${source}: ${message}`);
      }
      this.deps.store.setCursor(k, message);
      if (error instanceof RateLimited) {
        this.deps.store.setCursor("crashes:synced", new Date(this.now().getTime() - SYNC_EVERY_MS + RATE_LIMIT_RETRY_MS).toISOString());
        return true;
      }
      return false;
    }
  }

  // ---- Google Play ----

  private interval(days: number): string {
    // Error issues take UTC days; the newest complete one is yesterday.
    const end = new Date(Date.UTC(this.now().getUTCFullYear(), this.now().getUTCMonth(), this.now().getUTCDate()));
    const start = new Date(end.getTime() - days * 86_400_000);
    const t = (p: string, d: Date) => `${p}.year=${d.getUTCFullYear()}&${p}.month=${d.getUTCMonth() + 1}&${p}.day=${d.getUTCDate()}&${p}.timeZone.id=UTC`;
    return `${t("interval.startTime", start)}&${t("interval.endTime", end)}`;
  }

  private async playIssues(pkg: string, days: number): Promise<PlayIssue[]> {
    const out: PlayIssue[] = [];
    let token = "";
    for (let page = 0; page < 10; page++) {
      const url = `${REPORTING}/apps/${pkg}/errorIssues:search?pageSize=100&${this.interval(days)}${token ? `&pageToken=${encodeURIComponent(token)}` : ""}`;
      const r = await this.deps.google!.json(REPORTING_SCOPE, url) as { errorIssues?: PlayIssue[]; nextPageToken?: string } | null;
      out.push(...r?.errorIssues ?? []);
      if (!r?.nextPageToken) break;
      token = r.nextPageToken;
    }
    return out;
  }

  /** One pass for a Play app: rates, a snapshot of the last 7 days, and issues for the biggest new groups. */
  async syncPlay(pkg: string, repo: string): Promise<string[]> {
    const { store } = this.deps;
    const today = localDay(this.now());
    await this.syncPlayRates(pkg).catch(error => console.warn(`[crashes] ${pkg} rates: ${(error as Error).message.slice(0, 200)}`));
    const week = groupIssues(await this.playIssues(pkg, 7));
    const month = groupIssues(await this.playIssues(pkg, WINDOW_DAYS));
    const latestVersion = month.flatMap(g => g.versions).sort((a, b) => Number(b) - Number(a))[0] ?? null;
    const sum = (gs: CrashGroup[], kind: string, f: "reports" | "users") => gs.filter(g => g.kind === kind).reduce((a, g) => a + g[f], 0);
    const snap: PlaySnapshot = {
      day: today,
      crashReports: sum(week, "crash", "reports"), anrReports: sum(week, "anr", "reports"),
      crashUsers: sum(week, "crash", "users"), anrUsers: sum(week, "anr", "users"),
      top: week.filter(g => !g.obfuscated).slice(0, 3).map(g => ({ where: shortWhere(g), what: g.what, kind: g.kind, users: g.users, reports: g.reports })),
      latestVersion,
      // Groups seen only in the newest version: what the last release brought.
      newInLatest: latestVersion ? month.filter(g => g.versions.length === 1 && g.versions[0] === latestVersion && g.users >= this.limits.minUsers).length : 0,
      obfuscated: month.filter(g => g.obfuscated).reduce((a, g) => a + g.reports, 0),
    };
    store.setCursor(`crashes:play:${pkg}:snap:${today}`, JSON.stringify(snap));
    this.prune(`crashes:play:${pkg}:snap:`);
    return this.fileGroups(pkg, repo, month.filter(g => !g.obfuscated && g.users >= this.limits.minUsers));
  }

  private async syncPlayRates(pkg: string): Promise<void> {
    const end = addDays(localDay(this.now()), -1);
    const start = addDays(end, -WINDOW_DAYS);
    const date = (d: string) => ({ year: Number(d.slice(0, 4)), month: Number(d.slice(5, 7)), day: Number(d.slice(8, 10)), timeZone: { id: "America/Los_Angeles" } });
    const query = async (set: string, metrics: string[]) => {
      const r = await this.deps.google!.json(REPORTING_SCOPE, `${REPORTING}/apps/${pkg}/${set}:query`, {
        method: "POST", body: { timelineSpec: { aggregationPeriod: "DAILY", startTime: date(start), endTime: date(end) }, metrics },
      }) as { rows?: { startTime?: { year: number; month: number; day: number }; metrics?: { metric: string; decimalValue?: { value?: string } }[] }[] } | null;
      return r?.rows ?? [];
    };
    const days = new Map<string, PlayRates>();
    const put = (rows: Awaited<ReturnType<typeof query>>, map: Record<string, keyof PlayRates>) => {
      for (const row of rows) {
        const t = row.startTime;
        if (!t) continue;
        const day = `${t.year}-${String(t.month).padStart(2, "0")}-${String(t.day).padStart(2, "0")}`;
        const d = days.get(day) ?? {};
        for (const m of row.metrics ?? []) {
          const field = map[m.metric];
          const value = Number(m.decimalValue?.value);
          if (field && Number.isFinite(value)) d[field] = field === "users" ? value : Math.round(value * 100_000) / 1000;
        }
        days.set(day, d);
      }
    };
    put(await query("crashRateMetricSet", ["crashRate", "userPerceivedCrashRate", "distinctUsers"]), { crashRate: "crash", userPerceivedCrashRate: "perceivedCrash", distinctUsers: "users" });
    put(await query("anrRateMetricSet", ["anrRate", "userPerceivedAnrRate"]), { anrRate: "anr", userPerceivedAnrRate: "perceivedAnr" });
    for (const [day, rates] of days) this.deps.store.setCursor(`crashes:play:${pkg}:rate:${day}`, JSON.stringify(rates));
    this.prune(`crashes:play:${pkg}:rate:`);
  }

  /** The group's sample stack, from the error report of its biggest issue. */
  private async stack(pkg: string, issue: PlayIssue): Promise<string | null> {
    const id = issue.name.split("/").pop()!;
    const url = `${REPORTING}/apps/${pkg}/errorReports:search?pageSize=1&filter=${encodeURIComponent(`errorIssueId = ${id}`)}&${this.interval(WINDOW_DAYS)}`;
    const r = await this.deps.google!.json(REPORTING_SCOPE, url) as { errorReports?: { reportText?: string; deviceModel?: { marketingName?: string }; osVersion?: { apiLevel?: string } }[] } | null;
    const report = r?.errorReports?.[0];
    if (!report?.reportText) return null;
    const text = stackExcerpt(report.reportText, pkg.split(".").slice(0, 2).join("."));
    const device = [report.deviceModel?.marketingName, report.osVersion?.apiLevel ? `Android API ${report.osVersion.apiLevel}` : ""].filter(Boolean).join(", ");
    return `${text}${device ? `\n\n(sample from ${device})` : ""}`;
  }

  private async fileGroups(pkg: string, repo: string, groups: CrashGroup[]): Promise<string[]> {
    const { store } = this.deps;
    const fresh = groups.filter(g => !store.cursor(`crashes:filed:${pkg}:${g.key}`));
    if (!fresh.length || !this.limits.fileIssues) return [];
    const [owner, name] = repo.split("/");
    const open = await this.deps.github.openIssues(owner, name);
    const filed: string[] = [];
    for (const g of fresh) {
      // An open issue that already names the method (filed by hand, or before this audit) counts.
      const short = shortWhere(g);
      const existing = open.find(i => {
        const text = `${i.title}\n${i.body ?? ""}`;
        return text.includes(short) && (!isOom(g) || /OutOfMemory|\bOOM\b|out of memory/i.test(text));
      });
      if (existing) {
        store.setCursor(`crashes:filed:${pkg}:${g.key}`, existing.url);
        continue;
      }
      if (filed.length >= this.limits.issuesPerPass) break;
      const stack = await this.stack(pkg, g.issues[0]).catch(() => null);
      const label = g.kind === "anr" ? "ANR" : g.what.split(".").pop();
      const title = `Android ${label} in ${shortWhere(g)}`.slice(0, 120);
      const body = [
        `Google Play reports ${g.kind === "anr" ? "an ANR (the app stopped responding)" : `a crash (\`${g.what}\`)`} in \`${g.where}\`: ${plural(g.reports, "report")} from about ${plural(g.users, "user")} in the last ${WINDOW_DAYS} days, last on ${g.lastAt.slice(0, 10)}. Version codes: ${g.versions.join(", ") || "?"}.`,
        "",
        ...(stack ? ["Sample stack trace:", "", "```", stack.replace(/```/g, "'''"), "```", ""] : []),
        `Play's clusters in this group (${g.issues.length}): ${g.issues.slice(0, 6).map(i => i.issueUri ? `[${plural(int(i.distinctUsers), "user")}](${i.issueUri})` : plural(int(i.distinctUsers), "user")).join(", ")}${g.issues.length > 6 ? ", …" : ""}`,
        "",
        "**Source:** Google Play Android vitals, via isobot's crash audit",
        "",
        "---",
        this.footer(),
        `${CRASH_MARKER}play:${pkg}:${g.key.replace(/[^\w.|-]+/g, "_")} -->`,
      ].join("\n");
      const issue = await this.deps.github.createIssue(owner, name, title, body, this.issueLabels());
      store.setCursor(`crashes:filed:${pkg}:${g.key}`, issue.url);
      store.event(null, "crash_issue", `${repo}: ${title} ${issue.url}`);
      filed.push(`${this.name(repo)} (Android): ${title} <${issue.url}>`);
    }
    return filed;
  }

  // ---- App Store ----

  private async ascGet(path: string, query: string[] = [], paginate = true): Promise<{ data: { id: string; attributes?: Record<string, unknown>; relationships?: Record<string, { data?: { id: string } | null }> }[]; included?: { id: string; type: string; attributes?: Record<string, unknown> }[] }> {
    const r = await this.deps.asc(["api", "GET", path, ...query.flatMap(q => ["--query", q]), ...(paginate ? ["--paginate"] : []), "--output", "json"]);
    if (!r.ok) throw failure(`GET ${path}`, r);
    const json = JSON.parse(r.stdout || "{}") as { data?: unknown; included?: unknown };
    return { data: Array.isArray(json.data) ? json.data as never : json.data ? [json.data as never] : [], included: (json.included ?? []) as never };
  }

  /** New App Crashes instances (any granularity), read into per-period, per-version counts. */
  async syncIos(appId: string): Promise<number> {
    const { store } = this.deps;
    const request = await this.deps.requestId(appId);
    if (!request) return 0;
    const rk = `crashes:ios:${appId}:report`;
    let cached = JSON.parse(store.cursor(rk) ?? "null") as { request: string; id: string | null; at: string } | null;
    if (!cached || cached.request !== request || this.now().getTime() - Date.parse(cached.at) > 7 * 86_400_000) {
      const reports = await this.ascGet(`/v1/analyticsReportRequests/${request}/reports`, ["fields[analyticsReports]=name", "filter[category]=APP_USAGE", "limit=200"]);
      cached = { request, id: reports.data.find(r => String(r.attributes?.name ?? "").trim() === "App Crashes")?.id ?? null, at: this.now().toISOString() };
      store.setCursor(rk, JSON.stringify(cached));
    }
    if (!cached.id) return 0;
    const seenKey = `crashes:ios:${appId}:seen`;
    const seen = new Set(JSON.parse(store.cursor(seenKey) ?? "[]") as string[]);
    const oldest = addDays(localDay(this.now()), -KEEP_DAYS);
    const todo = (await this.ascGet(`/v1/analyticsReports/${cached.id}/instances`, ["limit=200"])).data
      .map(i => ({ id: i.id, date: String(i.attributes?.processingDate ?? ""), g: String(i.attributes?.granularity ?? "DAILY") }))
      .filter(i => /^\d{4}-\d{2}-\d{2}$/.test(i.date) && i.date >= oldest && !seen.has(i.id))
      .sort((a, b) => b.date.localeCompare(a.date));
    let read = 0;
    try {
      for (const t of todo.slice(0, INSTANCES_PER_PASS)) {
        const rows: Record<string, string>[] = [];
        for (const s of (await this.ascGet(`/v1/analyticsReportInstances/${t.id}/segments`)).data) {
          const url = String(s.attributes?.url ?? "");
          if (url.startsWith("https://")) rows.push(...parseTsv(await this.deps.fetchGz(url)));
        }
        for (const [day, period] of iosPeriods(rows, t.date)) {
          const k = `crashes:ios:${appId}:${t.g.toLowerCase()}:${day}`;
          const before = JSON.parse(store.cursor(k) ?? "null") as IosPeriod | null;
          // A later processing date restates a period; an older one doesn't overwrite it.
          if (!before || before.src <= t.date) store.setCursor(k, JSON.stringify(period));
        }
        seen.add(t.id);
        read++;
      }
    } finally {
      store.setCursor(seenKey, JSON.stringify([...seen].slice(-1000)));
      for (const g of ["daily", "weekly", "monthly"]) this.prune(`crashes:ios:${appId}:${g}:`);
    }
    return read;
  }

  /** The stored App Crashes periods of one granularity, oldest first. */
  iosDays(appId: string, granularity: "daily" | "weekly" | "monthly"): { day: string; p: IosPeriod }[] {
    const prefix = `crashes:ios:${appId}:${granularity}:`;
    return this.deps.store.cursorsWithPrefix(prefix).map(r => ({ day: r.key.slice(prefix.length), p: JSON.parse(r.value) as IosPeriod }));
  }

  /**
   * TestFlight testers' crash submissions: each new one with its log. Submissions with the same crashed frame are
   * one issue. The first pass files only the last 7 days' and remembers the rest.
   */
  async syncTestFlight(appId: string, repo: string): Promise<string[]> {
    const { store } = this.deps;
    const r = await this.ascGet(`/v1/apps/${appId}/betaFeedbackCrashSubmissions`, [
      "sort=-createdDate", "limit=50", "include=build", "fields[builds]=version",
      // Never the tester's email or name: these may land in a public repository.
      "fields[betaFeedbackCrashSubmissions]=createdDate,comment,deviceModel,osVersion,appPlatform,build",
    ], false);
    const seenKey = `crashes:tf:${appId}:seen`;
    const first = store.cursor(seenKey) === null;
    const seen = new Set(JSON.parse(store.cursor(seenKey) ?? "[]") as string[]);
    const builds = new Map((r.included ?? []).filter(i => i.type === "builds").map(i => [i.id, String(i.attributes?.version ?? "")]));
    const since = new Date(this.now().getTime() - 7 * 86_400_000).toISOString();
    const [owner, name] = repo.split("/");
    const filed: string[] = [];
    let isPublic: boolean | null = null;
    try {
      for (const s of r.data) {
        if (seen.has(s.id)) continue;
        const at = String(s.attributes?.createdDate ?? "");
        if ((first && at < since) || !this.limits.fileIssues || filed.length >= this.limits.issuesPerPass) {
          if (first && at < since) seen.add(s.id);
          continue;
        }
        const log = await this.ascGet(`/v1/betaFeedbackCrashSubmissions/${s.id}/crashLog`, ["fields[betaCrashLogs]=logText"], false).catch(() => null);
        const excerpt = crashExcerpt(String(log?.data[0]?.attributes?.logText ?? ""));
        const crashed = excerpt.split("\n").find(l => /^\d+\s+\S+/.test(l.trim()) && !/libsystem|libdyld|dyld|CoreFoundation|libobjc|UIKitCore|GraphicsServices/.test(l)) ?? "";
        const signature = crashed.trim().replace(/^\d+\s+/, "").replace(/\s+\+\s*\d+$/, "").slice(0, 160) || excerpt.split("\n")[0] || "unknown";
        const sk = `crashes:filed:tf:${appId}:${signature.toLowerCase()}`;
        seen.add(s.id);
        if (store.cursor(sk)) continue;
        const build = builds.get(s.relationships?.build?.data?.id ?? "") ?? "?";
        isPublic ??= await this.deps.github.isPublic(owner, name).catch(() => true);
        const comment = String(s.attributes?.comment ?? "").trim();
        const title = `TestFlight crash in build ${build}: ${signature.split(/\s+/).slice(-1)[0] || "crash"}`.slice(0, 120);
        const body = [
          `A TestFlight tester's ${String(s.attributes?.appPlatform ?? "app").replace("_", " ")} build ${build} crashed on ${at.slice(0, 10)} (${[s.attributes?.deviceModel, s.attributes?.osVersion].filter(Boolean).join(", ")}).`,
          ...(comment && !isPublic ? ["", `Tester's note: ${comment.slice(0, 500)}`] : []),
          "",
          "```", excerpt.replace(/```/g, "'''") || "(no crash log)", "```",
          "",
          "**Source:** TestFlight crash feedback, via isobot's crash audit",
          "",
          "---",
          this.footer(),
          `${CRASH_MARKER}testflight:${appId}:${s.id} -->`,
        ].join("\n");
        const issue = await this.deps.github.createIssue(owner, name, title, body, this.issueLabels());
        store.setCursor(sk, issue.url);
        store.event(null, "crash_issue", `${repo}: ${title} ${issue.url}`);
        filed.push(`${this.name(repo, appId)} (TestFlight): ${title} <${issue.url}>`);
      }
    } finally {
      store.setCursor(seenKey, JSON.stringify([...seen].slice(-500)));
    }
    return filed;
  }

  private prune(prefix: string): void {
    const oldest = addDays(localDay(this.now()), -KEEP_DAYS);
    for (const { key } of this.deps.store.cursorsWithPrefix(prefix)) if (key.slice(prefix.length) < oldest) this.deps.store.deleteCursor(key);
  }

  // ---- Reading ----

  private snapshots(pkg: string): PlaySnapshot[] {
    return this.deps.store.cursorsWithPrefix(`crashes:play:${pkg}:snap:`).map(r => JSON.parse(r.value) as PlaySnapshot);
  }

  private rates(pkg: string, days: number): { day: string; r: PlayRates }[] {
    const prefix = `crashes:play:${pkg}:rate:`;
    return this.deps.store.cursorsWithPrefix(prefix).map(r => ({ day: r.key.slice(prefix.length), r: JSON.parse(r.value) as PlayRates })).slice(-days);
  }

  /** The check-in's crash section: a line per app with crashes, and flags worth a check-in on their own. */
  checkIn(): CheckInCrashes {
    const lines: string[] = [];
    const flags: string[] = [];
    const today = localDay(this.now());
    for (const { pkg, repo } of this.playApps()) {
      const snaps = this.snapshots(pkg);
      const s = snaps.at(-1);
      if (!s) continue;
      const name = `${this.name(repo)} (Android)`;
      if (s.crashReports || s.anrReports) {
        const top = s.top[0];
        lines.push(`**${name}**, last 7 days: ${plural(s.crashReports, "crash report")} (~${plural(s.crashUsers, "user")}), ${plural(s.anrReports, "ANR")}${top ? ` · top: ${top.kind === "anr" ? "ANR" : top.what.split(".").pop()} in ${top.where} (${top.users} users)` : ""}${s.obfuscated ? ` · ${s.obfuscated} reports have obfuscated stacks (upload the R8 mapping to Play)` : ""}`);
      }
      const weekAgo = [...snaps].reverse().find(x => x.day <= addDays(s.day, -7));
      const now = s.crashReports + s.anrReports;
      const then = weekAgo ? weekAgo.crashReports + weekAgo.anrReports : null;
      if (then !== null && now >= 10 && now >= 2 * Math.max(then, 1)) flags.push(`📈 ${name}: ${now} crash and ANR reports in the last 7 days, up from ${then} the week before.`);
      if (s.newInLatest) flags.push(`⚠️ ${name}: ${plural(s.newInLatest, "new crash group")} only in version code ${s.latestVersion}, the newest release.`);
      const r = this.rates(pkg, 28).map(x => x.r);
      const avg = (f: keyof PlayRates) => { const xs = r.map(x => x[f]).filter((x): x is number => typeof x === "number"); return xs.length >= 7 ? xs.reduce((a, b) => a + b, 0) / xs.length : null; };
      const crash = avg("perceivedCrash");
      const anr = avg("perceivedAnr");
      if (crash !== null && crash >= PLAY_THRESHOLDS.crash) flags.push(`🚨 ${name}: user-perceived crash rate ${crash.toFixed(2)}% over 28 days, above Play's ${PLAY_THRESHOLDS.crash}% bad-behavior threshold (Play may show a warning on the listing and rank it lower).`);
      if (anr !== null && anr >= PLAY_THRESHOLDS.anr) flags.push(`🚨 ${name}: user-perceived ANR rate ${anr.toFixed(2)}% over 28 days, above Play's ${PLAY_THRESHOLDS.anr}% bad-behavior threshold.`);
    }
    for (const { appId, repo } of this.iosApps()) {
      const name = `${this.name(repo, appId)} (iOS)`;
      // The finest granularity Apple wrote in the last 40 days.
      for (const g of ["daily", "weekly", "monthly"] as const) {
        const periods = this.iosDays(appId, g).filter(d => d.day >= addDays(today, g === "monthly" ? -70 : -40));
        if (!periods.length) continue;
        const last = periods.at(-1)!;
        if (last.p.crashes) {
          const versions = Object.entries(last.p.versions).sort((a, b) => b[1].crashes - a[1].crashes).slice(0, 3).map(([v, c]) => `${v}: ${c.crashes}`).join(", ");
          const when = g === "monthly" ? new Date(`${last.day}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" }) : g === "weekly" ? `week of ${shortDay(last.day)}` : shortDay(last.day);
          lines.push(`**${name}**, ${when}: ${plural(last.p.crashes, "crash")} on ${plural(last.p.devices, "device")} (${versions}) · stacks in Xcode Organizer`);
        }
        const prev = periods.length >= 2 ? periods.slice(-8, -1) : [];
        if (prev.length) {
          const a = prev.reduce((x, d) => x + d.p.crashes, 0) / prev.length;
          if (last.p.crashes >= 5 && last.p.crashes >= 2 * a + 1) flags.push(`📈 ${name}: ${last.p.crashes} crashes (${g === "daily" ? shortDay(last.day) : `${g} from ${shortDay(last.day)}`}), against an average of ${a.toFixed(1)} before.`);
        }
        break;
      }
    }
    const errors = Object.entries(this.errors());
    if (errors.length) flags.push(`⚠️ Crash audit couldn't read ${errors.map(([s, e]) => `${s} (${e.slice(0, 120)})`).join("; ")}.`);
    return { lines, flags };
  }
}
