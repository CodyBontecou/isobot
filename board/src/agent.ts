import type { Sql } from "./store.js";

/**
 * Agent conversations on the board (docs/board.md, "Agent"): the owner talks to isobot from any view, and the
 * conversation lives here, not in the page, so moving between views, reloading or switching devices never ends it.
 * The runner does the thinking: it takes the owner's messages over its WebSocket (index.ts), runs a turn with the
 * staff chat's model and read-only tools (runner/src/boardChat.ts) and sends back the answer and any proposals.
 * A proposal runs only after the owner approves it here; the runner keeps its own copy of what each one does,
 * so the board only says which proposal and whether to do it.
 */

export type ThreadState = "idle" | "queued" | "working";
export type ProposalState = "open" | "approved" | "running" | "done" | "failed" | "dismissed" | "expired";

export interface AgentThread {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  state: ThreadState;
  /** What the runner is doing in a turn ("reading CI logs"), while it works. */
  status: string | null;
  archived: boolean;
  /** Proposals waiting for the owner. */
  open: number;
  /** The newest message's first line, for lists. */
  last: string | null;
}

/** What the owner was looking at when they wrote: the URL, the view, and what they picked or hovered. */
export interface AgentContext {
  url: string;
  view: string;
  refs: { kind: string; id: string; label: string; focus?: "picked" | "hover"; data?: string }[];
}

export interface AgentMessage {
  seq: number;
  threadId: string;
  at: string;
  role: "you" | "isobot" | "note";
  text: string;
  by: string | null;
  context: AgentContext | null;
}

export interface AgentProposal {
  id: string;
  threadId: string;
  at: string;
  summary: string;
  state: ProposalState;
  result: string | null;
  decidedBy: string | null;
}

/** A batch for the runner: the owner's new messages per thread, and approve/dismiss decisions. */
export interface AgentWork {
  messages: { threadId: string; seq: number; at: string; text: string; by: string; context: AgentContext | null }[];
  decisions: { proposalId: string; threadId: string; decision: "approve" | "dismiss"; by: string }[];
}

/** What the runner sends back. Everything is optional; unknown threads and proposals are ignored. */
export interface RunnerUpdate {
  threads?: { id: string; state: ThreadState; status?: string | null }[];
  replies?: { threadId: string; text: string; proposals?: { id: string; summary: string }[] }[];
  notes?: { threadId: string; text: string }[];
  results?: { proposalId: string; ok: boolean; text: string }[];
}

export class BadAgentInput extends Error {}

const MAX_TEXT = 8_000;
const MAX_REPLY = 60_000;
const MAX_CONTEXT = 12_000;
const MAX_REFS = 30;
const MAX_LIVE_THREADS = 50;
/** A turn the runner took but never answered (it restarted, or lost the connection) is given up after this long. */
const TURN_EXPIRE_MS = 30 * 60_000;
/** Proposals the owner hasn't decided on in this long expire (the staff chat's 👍 window). */
const PROPOSAL_TTL_MS = 24 * 60 * 60_000;
/** Archived conversations are deleted after this long. */
const ARCHIVE_KEEP_MS = 90 * 86_400_000;

export class AgentStore {
  constructor(private readonly sql: Sql) {
    sql.exec(`CREATE TABLE IF NOT EXISTS agent_threads (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      state TEXT NOT NULL, status TEXT, archived INTEGER NOT NULL DEFAULT 0, by TEXT NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS agent_messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL, at TEXT NOT NULL, role TEXT NOT NULL,
      text TEXT NOT NULL, by TEXT, context TEXT, delivered INTEGER NOT NULL DEFAULT 1)`);
    sql.exec(`CREATE INDEX IF NOT EXISTS agent_messages_thread ON agent_messages (thread_id, seq)`);
    sql.exec(`CREATE INDEX IF NOT EXISTS agent_messages_undelivered ON agent_messages (delivered, seq)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS agent_proposals (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, at TEXT NOT NULL, summary TEXT NOT NULL,
      state TEXT NOT NULL, result TEXT, decided_by TEXT, delivered INTEGER NOT NULL DEFAULT 1)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS agent_meta (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)`);
    sql.exec(`INSERT OR IGNORE INTO agent_meta (id, version) VALUES (1, 0)`);
  }

  /** Goes up on every change, so a browser can tell whether to read again. */
  version(): number {
    return Number(this.sql.exec("SELECT version FROM agent_meta WHERE id = 1").toArray()[0]?.version ?? 0);
  }

  private bump(): void {
    this.sql.exec("UPDATE agent_meta SET version = version + 1 WHERE id = 1");
  }

  /** The owner writes: to an existing conversation, or (no threadId) a new one titled from the message. */
  send(input: { threadId?: unknown; text: unknown; context?: unknown; by: string }, now = new Date()): { thread: AgentThread; message: AgentMessage } {
    const text = typeof input.text === "string" ? input.text.trim() : "";
    if (!text) throw new BadAgentInput("empty message");
    if (text.length > MAX_TEXT) throw new BadAgentInput("message too long");
    const context = checkContext(input.context);
    const at = now.toISOString();
    let threadId: string;
    if (input.threadId === undefined || input.threadId === null || input.threadId === "") {
      const live = Number(this.sql.exec("SELECT count(*) AS n FROM agent_threads WHERE archived = 0").toArray()[0].n);
      if (live >= MAX_LIVE_THREADS) throw new BadAgentInput(`archive a conversation first (${MAX_LIVE_THREADS} open)`);
      threadId = crypto.randomUUID();
      this.sql.exec("INSERT INTO agent_threads (id, title, created_at, updated_at, state, by) VALUES (?, ?, ?, ?, 'queued', ?)",
        threadId, title(text), at, at, input.by);
    } else {
      if (typeof input.threadId !== "string" || !this.thread(input.threadId)) throw new BadAgentInput("no such conversation");
      threadId = input.threadId;
      // Writing in an archived conversation brings it back.
      this.sql.exec("UPDATE agent_threads SET updated_at = ?, archived = 0, state = CASE WHEN state = 'idle' THEN 'queued' ELSE state END WHERE id = ?", at, threadId);
    }
    this.sql.exec("INSERT INTO agent_messages (thread_id, at, role, text, by, context, delivered) VALUES (?, ?, 'you', ?, ?, ?, 0)",
      threadId, at, text, input.by, context ? JSON.stringify(context) : null);
    const seq = Number(this.sql.exec("SELECT last_insert_rowid() AS seq").toArray()[0].seq);
    this.bump();
    return { thread: this.thread(threadId)!, message: { seq, threadId, at, role: "you", text, by: input.by, context } };
  }

  /** Approve or dismiss an open proposal. Only open ones can be decided; a second click is refused. */
  decide(input: { proposalId: unknown; decision: unknown; by: string }, now = new Date()): AgentProposal {
    this.expire(now);
    if (input.decision !== "approve" && input.decision !== "dismiss") throw new BadAgentInput("approve or dismiss");
    const p = typeof input.proposalId === "string" ? this.proposal(input.proposalId) : null;
    if (!p) throw new BadAgentInput("no such proposal");
    if (p.state !== "open") throw new BadAgentInput(`it's already ${p.state}`);
    const state = input.decision === "approve" ? "approved" : "dismissed";
    this.sql.exec("UPDATE agent_proposals SET state = ?, decided_by = ?, delivered = 0 WHERE id = ?", state, input.by, p.id);
    this.sql.exec("UPDATE agent_threads SET updated_at = ? WHERE id = ?", now.toISOString(), p.threadId);
    this.bump();
    return this.proposal(p.id)!;
  }

  rename(input: { threadId: unknown; title: unknown }): AgentThread {
    const t = typeof input.threadId === "string" ? this.thread(input.threadId) : null;
    if (!t) throw new BadAgentInput("no such conversation");
    const name = typeof input.title === "string" ? input.title.trim().slice(0, 120) : "";
    if (!name) throw new BadAgentInput("empty title");
    this.sql.exec("UPDATE agent_threads SET title = ? WHERE id = ?", name, t.id);
    this.bump();
    return this.thread(t.id)!;
  }

  archive(input: { threadId: unknown; archived: unknown }, now = new Date()): AgentThread {
    const t = typeof input.threadId === "string" ? this.thread(input.threadId) : null;
    if (!t) throw new BadAgentInput("no such conversation");
    this.sql.exec("UPDATE agent_threads SET archived = ?, updated_at = ? WHERE id = ?", input.archived === false ? 0 : 1, now.toISOString(), t.id);
    this.bump();
    return this.thread(t.id)!;
  }

  /** Every live conversation and the 30 newest archived ones, newest first. */
  threads(now = new Date()): AgentThread[] {
    this.expire(now);
    return this.sql.exec(`SELECT * FROM (SELECT * FROM agent_threads WHERE archived = 0 UNION ALL
      SELECT * FROM (SELECT * FROM agent_threads WHERE archived = 1 ORDER BY updated_at DESC LIMIT 30)) ORDER BY updated_at DESC`).toArray().map(row => this.threadRow(row));
  }

  thread(id: string): AgentThread | null {
    const row = this.sql.exec("SELECT * FROM agent_threads WHERE id = ?", id).toArray()[0];
    return row ? this.threadRow(row) : null;
  }

  /** One conversation's messages (the newest 400) and its proposals. */
  conversation(id: string, now = new Date()): { thread: AgentThread; messages: AgentMessage[]; proposals: AgentProposal[] } | null {
    this.expire(now);
    const thread = this.thread(id);
    if (!thread) return null;
    const messages = this.sql.exec("SELECT * FROM (SELECT * FROM agent_messages WHERE thread_id = ? ORDER BY seq DESC LIMIT 400) ORDER BY seq", id).toArray().map(messageRow);
    const proposals = this.sql.exec("SELECT * FROM agent_proposals WHERE thread_id = ? ORDER BY at", id).toArray().map(proposalRow);
    return { thread, messages, proposals };
  }

  /** Hands the runner everything it hasn't had yet, and marks it handed over. */
  takeWork(now = new Date()): AgentWork {
    this.expire(now);
    const messages = this.sql.exec("SELECT * FROM agent_messages WHERE delivered = 0 ORDER BY seq LIMIT 200").toArray().map(row => {
      const m = messageRow(row);
      return { threadId: m.threadId, seq: m.seq, at: m.at, text: m.text, by: m.by ?? "", context: m.context };
    });
    const decisions = this.sql.exec("SELECT * FROM agent_proposals WHERE delivered = 0 AND state IN ('approved', 'dismissed') ORDER BY at").toArray().map(row => ({
      proposalId: String(row.id), threadId: String(row.thread_id), decision: (String(row.state) === "approved" ? "approve" : "dismiss") as "approve" | "dismiss", by: String(row.decided_by ?? ""),
    }));
    if (!messages.length && !decisions.length) return { messages, decisions };
    const at = now.toISOString();
    for (const m of messages) {
      this.sql.exec("UPDATE agent_messages SET delivered = 1 WHERE seq = ?", m.seq);
      // Taken: the runner owns the turn now, and the expiry clock starts.
      this.sql.exec("UPDATE agent_threads SET state = 'working', status = NULL, updated_at = ? WHERE id = ? AND state != 'working'", at, m.threadId);
    }
    for (const d of decisions) {
      this.sql.exec("UPDATE agent_proposals SET delivered = 1, state = CASE WHEN state = 'approved' THEN 'running' ELSE state END WHERE id = ?", d.proposalId);
    }
    this.bump();
    return { messages, decisions };
  }

  /** Puts back work that couldn't be sent (the runner's socket closed), so the next connection gets it. */
  untake(work: AgentWork): void {
    for (const m of work.messages) this.sql.exec("UPDATE agent_messages SET delivered = 0 WHERE seq = ?", m.seq);
    for (const d of work.decisions) {
      this.sql.exec("UPDATE agent_proposals SET delivered = 0, state = CASE WHEN state = 'running' THEN 'approved' ELSE state END WHERE id = ?", d.proposalId);
    }
    this.bump();
  }

  /** Whether anything waits for the runner. */
  hasWork(): boolean {
    return this.sql.exec(`SELECT 1 FROM agent_messages WHERE delivered = 0 UNION ALL
      SELECT 1 FROM agent_proposals WHERE delivered = 0 AND state IN ('approved', 'dismissed') LIMIT 1`).toArray().length > 0;
  }

  /** Applies a runner update. Throws BadAgentInput only for a malformed update; unknown ids are skipped. */
  apply(raw: unknown, now = new Date()): void {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new BadAgentInput("update must be an object");
    const u = raw as Record<string, unknown>;
    const at = now.toISOString();
    for (const t of list(u.threads)) {
      if (typeof t.id !== "string" || !["idle", "queued", "working"].includes(t.state as string)) continue;
      const status = typeof t.status === "string" ? t.status.slice(0, 200) : null;
      this.sql.exec("UPDATE agent_threads SET state = ?, status = ?, updated_at = ? WHERE id = ?", t.state, status, at, t.id);
    }
    for (const r of list(u.replies)) {
      if (typeof r.threadId !== "string" || typeof r.text !== "string" || !this.thread(r.threadId)) continue;
      if (r.text.trim()) {
        this.sql.exec("INSERT INTO agent_messages (thread_id, at, role, text) VALUES (?, ?, 'isobot', ?)", r.threadId, at, r.text.slice(0, MAX_REPLY));
      }
      for (const p of list(r.proposals)) {
        if (typeof p.id !== "string" || !/^[\w-]{8,64}$/.test(p.id) || typeof p.summary !== "string") continue;
        this.sql.exec("INSERT OR IGNORE INTO agent_proposals (id, thread_id, at, summary, state) VALUES (?, ?, ?, ?, 'open')", p.id, r.threadId, at, p.summary.slice(0, 4000));
      }
      this.sql.exec("UPDATE agent_threads SET updated_at = ? WHERE id = ?", at, r.threadId);
    }
    for (const n of list(u.notes)) {
      if (typeof n.threadId !== "string" || typeof n.text !== "string" || !this.thread(n.threadId)) continue;
      this.sql.exec("INSERT INTO agent_messages (thread_id, at, role, text) VALUES (?, ?, 'note', ?)", n.threadId, at, n.text.slice(0, 2000));
      this.sql.exec("UPDATE agent_threads SET updated_at = ? WHERE id = ?", at, n.threadId);
    }
    for (const r of list(u.results)) {
      if (typeof r.proposalId !== "string" || typeof r.ok !== "boolean") continue;
      const text = typeof r.text === "string" ? r.text.slice(0, 1000) : null;
      this.sql.exec("UPDATE agent_proposals SET state = ?, result = ? WHERE id = ? AND state IN ('running', 'approved', 'dismissed')",
        r.ok ? "done" : "failed", text, r.proposalId);
    }
    this.bump();
  }

  private proposal(id: string): AgentProposal | null {
    const row = this.sql.exec("SELECT * FROM agent_proposals WHERE id = ?", id).toArray()[0];
    return row ? proposalRow(row) : null;
  }

  private threadRow(row: Record<string, unknown>): AgentThread {
    const id = String(row.id);
    const open = Number(this.sql.exec("SELECT count(*) AS n FROM agent_proposals WHERE thread_id = ? AND state = 'open'", id).toArray()[0].n);
    const last = this.sql.exec("SELECT text FROM agent_messages WHERE thread_id = ? AND role != 'note' ORDER BY seq DESC LIMIT 1", id).toArray()[0];
    return {
      id, title: String(row.title), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
      state: String(row.state) as ThreadState, status: row.status === null ? null : String(row.status), archived: Number(row.archived) === 1,
      open, last: last ? String(last.text).split("\n")[0].slice(0, 160) : null,
    };
  }

  /** Gives up turns and proposals that have waited too long, and drops long-archived conversations. */
  private expire(now: Date): void {
    const turnCutoff = new Date(now.getTime() - TURN_EXPIRE_MS).toISOString();
    const stuck = this.sql.exec("SELECT id FROM agent_threads WHERE state = 'working' AND updated_at < ?", turnCutoff).toArray();
    let changed = stuck.length > 0;
    for (const row of stuck) {
      this.sql.exec("UPDATE agent_threads SET state = 'idle', status = NULL WHERE id = ?", row.id);
      this.sql.exec("INSERT INTO agent_messages (thread_id, at, role, text) VALUES (?, ?, 'note', ?)", row.id, now.toISOString(),
        "The runner didn't finish this turn (it may have restarted). Ask again to continue.");
    }
    const expired = this.sql.exec("UPDATE agent_proposals SET state = 'expired' WHERE state = 'open' AND at < ? RETURNING id",
      new Date(now.getTime() - PROPOSAL_TTL_MS).toISOString()).toArray();
    // An approved proposal the runner never answered is reported as unknown, not done.
    const lost = this.sql.exec("UPDATE agent_proposals SET state = 'failed', result = 'The runner never reported back; check before asking again.' WHERE state = 'running' AND at < ? RETURNING id",
      new Date(now.getTime() - PROPOSAL_TTL_MS - TURN_EXPIRE_MS).toISOString()).toArray();
    const old = this.sql.exec("SELECT id FROM agent_threads WHERE archived = 1 AND updated_at < ?", new Date(now.getTime() - ARCHIVE_KEEP_MS).toISOString()).toArray();
    for (const row of old) {
      this.sql.exec("DELETE FROM agent_messages WHERE thread_id = ?", row.id);
      this.sql.exec("DELETE FROM agent_proposals WHERE thread_id = ?", row.id);
      this.sql.exec("DELETE FROM agent_threads WHERE id = ?", row.id);
    }
    changed ||= expired.length > 0 || lost.length > 0 || old.length > 0;
    if (changed) this.bump();
  }
}

function list(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((v): v is Record<string, unknown> => Boolean(v) && typeof v === "object") : [];
}

function title(text: string): string {
  const line = text.split("\n")[0].trim();
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}

/** The page context a browser sends; anything malformed is dropped rather than refused. */
export function checkContext(raw: unknown): AgentContext | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const c = raw as Record<string, unknown>;
  if (typeof c.url !== "string" || typeof c.view !== "string") return null;
  const refs = list(c.refs).slice(0, MAX_REFS).flatMap(r => {
    if (typeof r.kind !== "string" || typeof r.id !== "string" || typeof r.label !== "string") return [];
    return [{
      kind: r.kind.slice(0, 32), id: r.id.slice(0, 200), label: r.label.slice(0, 200),
      ...(r.focus === "picked" || r.focus === "hover" ? { focus: r.focus as "picked" | "hover" } : {}),
      ...(typeof r.data === "string" ? { data: r.data.slice(0, 3000) } : {}),
    }];
  });
  const context: AgentContext = { url: c.url.slice(0, 500), view: c.view.slice(0, 120), refs };
  while (JSON.stringify(context).length > MAX_CONTEXT && context.refs.length) context.refs.pop();
  return context;
}

function messageRow(row: Record<string, unknown>): AgentMessage {
  let context: AgentContext | null = null;
  if (typeof row.context === "string") { try { context = JSON.parse(row.context) as AgentContext; } catch { context = null; } }
  return {
    seq: Number(row.seq), threadId: String(row.thread_id), at: String(row.at), role: String(row.role) as AgentMessage["role"],
    text: String(row.text), by: row.by === null || row.by === undefined ? null : String(row.by), context,
  };
}

function proposalRow(row: Record<string, unknown>): AgentProposal {
  return {
    id: String(row.id), threadId: String(row.thread_id), at: String(row.at), summary: String(row.summary), state: String(row.state) as ProposalState,
    result: row.result === null ? null : String(row.result), decidedBy: row.decided_by === null ? null : String(row.decided_by),
  };
}
