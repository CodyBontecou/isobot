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
}

export interface BoardEvent { id: number; jobId: string | null; at: string; kind: string; text: string; runner: string }

export interface Session { authenticated: boolean; oauthConfigured?: boolean; user?: { id: string; login: string; name: string | null }; csrfToken?: string }

export type View = 'overview' | 'tasks' | 'activity' | 'schedule' | 'prs' | 'issues' | 'jobs';
