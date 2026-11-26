// Mirrors runner/src/dashboard.ts (snapshot v1), as stored and served by board/src/store.ts.

export interface BoardItem {
  repo: string;
  number: number;
  kind: 'issue' | 'pr';
  title: string;
  url: string;
  state: 'open' | 'closed';
  merged: boolean;
  draft: boolean;
  author: string;
  labels: string[];
  comments: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  /** Missing on snapshots from runners before sources were added. */
  source?: ItemSource;
  closes?: number;
  /** Open PRs: the runner's last PR sweep (runner/src/prSweep.ts). Missing before the first sweep. */
  attention?: { status: string; reason: string; action: string | null; at: string };
}

export type SourceKind = 'github' | 'discord' | 'email' | 'vox' | 'appstore' | 'chat' | 'content' | 'release' | 'crash';

export interface ItemSource {
  kind: SourceKind;
  url?: string;
}

export interface ScheduleItem {
  id: string;
  name: string;
  cadence: string;
  lastAt: string | null;
  nextAt: string | null;
  running: boolean;
  detail?: string;
}

export type JobState = 'queued' | 'blocked' | 'building' | 'awaiting_ci' | 'pr_open' | 'merged' | 'released'
  | 'awaiting_ship' | 'shipped' | 'closed' | 'failed' | 'stopped';

export interface Job {
  id: string;
  owner: string;
  repo: string;
  number: number;
  title: string;
  state: JobState;
  branch: string | null;
  prNumber: number | null;
  attempts: number;
  lastError: string | null;
  notBefore: string | null;
  revising: boolean;
  kind: 'issue' | 'content';
  createdAt: string;
  updatedAt: string;
}

export interface RunnerState {
  v: number;
  at: string;
  receivedAt: string;
  runnerId: string;
  runner: {
    startedAt: string;
    activeJobs: string[];
    manuallyPaused: boolean;
    lastTriageAt: string | null;
    lastCycleError: string | null;
    pid: number;
    queued: number;
    buildsPausedUntil: string | null;
  };
  repos: { name: string; autonomy: string; ownerAutonomy: string; train: boolean; content: boolean; aso: boolean }[];
  schedule: ScheduleItem[];
  jobs: Job[];
  followUps: { jobId: string; kind: string; dueAt: string; createdAt: string; text: string }[];
}

export interface Board {
  runners: RunnerState[];
  github: { at: string; items: BoardItem[]; errors: string[] } | null;
  /** Task actions clicked on the board (board/src/store.ts); missing before the board had them. */
  actions?: BoardAction[];
}

export type ActionKind = 'approve' | 'stop' | 'retry' | 'dismiss';

export interface BoardAction {
  id: string;
  at: string;
  kind: ActionKind;
  repo: string;
  number: number;
  by: string;
  state: 'pending' | 'done' | 'failed';
  result: string | null;
  doneAt: string | null;
}

export interface BoardEvent { id: number; jobId: string | null; at: string; kind: string; text: string; runner: string }

export interface Session { authenticated: boolean; oauthConfigured?: boolean; user?: { id: string; login: string; name: string | null }; csrfToken?: string }

export type View = 'overview' | 'summary' | 'growth' | 'tasks' | 'activity' | 'schedule' | 'prs' | 'issues' | 'jobs';

// Mirrors runner/src/metrics.ts: the Growth view's series, served by /api/metrics.

export interface FunnelDay { day: string; v: Record<string, number> }
export interface RankDay { day: string; tracked: number; ranked: number; top10: number; top3: number; median: number | null }
export interface PhraseRank { text: string; storefront: string; rank: number | null; was7?: number | null; was28?: number | null; volume: number | null }
export interface ListingChange { at: string; fields: string[]; version?: string; liveAt?: string }

export interface MetricsApp {
  repo: string;
  store: 'appstore' | 'play';
  id: string;
  name: string;
  funnel: FunnelDay[];
  storefront: string;
  ranks: RankDay[];
  phrases: PhraseRank[];
  compare: { d7: string | null; d28: string | null; latest: string | null };
  changes: ListingChange[];
  /** Apple's Sales and Trends reports (runner/src/sales.ts); App Store apps once any are stored. */
  sales?: AppSales;
}

export interface Proceeds { lifetime: number; subscriptions: number; paidDownloads: number; other: number }
export interface SalesPoint { downloads: number; lifetime: number; subscriptions: number; trials: number; refunds: number; proceeds: Proceeds; total: number }
export interface PlanSnapshot { name: string; period: string; paid: number; trial: number; offer: number; retry: number; grace: number; monthly: number }
export interface AppSales {
  through: string | null;
  days: ({ day: string } & SalesPoint)[];
  months: ({ month: string; partial: boolean } & SalesPoint)[];
  years: ({ year: string; partial: boolean } & SalesPoint)[];
  subs: { day: string; paid: number; trials: number; retry: number; monthly: number }[];
  plans: PlanSnapshot[];
}

export interface SearchTotals { clicks: number; impressions: number; ctr: number; position: number }

export interface MetricsSite {
  repo: string;
  site: string;
  published: { at: string; number: number; title: string; prNumber: number | null }[];
  search: { day: string; last7: SearchTotals; previous7: SearchTotals | null }[];
}

export interface Metrics {
  at: string;
  apps: MetricsApp[];
  sites: MetricsSite[];
  credits: { days: { day: string; spent: number }[]; balance: number | null };
}

// Mirrors BoardStore.summary() (board/src/store.ts), served by /api/summary.

export interface SummaryData {
  from: string;
  to: string;
  compareFrom: string;
  /** Event counts per UTC hour (`2026-11-25T14`), kind and repo (null for runner-level events). */
  hours: { hour: string; kind: string; repo: string | null; n: number }[];
  highlights: BoardEvent[];
  truncated: boolean;
  /** Issues and PRs opened or closed from compareFrom to `to`. */
  items: BoardItem[];
  /** The jobs the highlights name, as last seen. */
  jobs: Job[];
  eventsSince: string | null;
  itemsSince: string | null;
}

export interface CalendarData { hours: { hour: string; repo: string | null; n: number }[] }
