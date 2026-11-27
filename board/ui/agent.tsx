import { createContext, Fragment, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Archive, ArchiveRestore, Bot, Check, Eye, Plus, SendHorizontal, X } from 'lucide-react';
import { Chip, Empty, getJson, rel, SignedOut } from './common';
export { refAttrs } from './common';
import type { AgentData, AgentMessage, AgentProposal, AgentRef, AgentThread, Session } from './types';

/**
 * The agent dock (board/src/agent.ts, runner/src/boardChat.ts): talk to isobot from any view. It lives in the
 * shell, not in a view, so moving around the board keeps the conversation, the draft and the scroll; the
 * conversation itself is kept by the board, so a reload or another device picks it up too.
 *
 * What isobot sees with each message: the URL and view, plus what the owner picked (⌥-click a row or card,
 * long-press on a phone, drag across a chart) and the last thing they hovered.
 */

// ---------- focus: what the owner picked or hovered ----------

/** A ref with what the browser needs to draw it (a chart's brushed range); the board keeps only kind, id, label, data. */
export type FocusRef = AgentRef & { chart?: string; range?: [string, string] };

interface Focus {
  picked: FocusRef[];
  hover: FocusRef | null;
  toggle: (ref: FocusRef) => void;
  setHover: (ref: FocusRef | null) => void;
  remove: (id: string) => void;
  clear: () => void;
}

const FocusContext = createContext<Focus>({ picked: [], hover: null, toggle: () => undefined, setHover: () => undefined, remove: () => undefined, clear: () => undefined });
export const useFocus = () => useContext(FocusContext);

function refOf(el: HTMLElement): FocusRef {
  const id = el.dataset.refId!;
  return { kind: el.dataset.refKind ?? 'item', id, label: el.dataset.refLabel ?? id };
}

const LONG_PRESS_MS = 550;

export function FocusProvider({ children, resetKey }: { children: ReactNode; resetKey: string }) {
  const [picked, setPicked] = useState<FocusRef[]>([]);
  const [hover, setHoverState] = useState<FocusRef | null>(null);
  const hoverId = useRef<string | null>(null);

  const setHover = useCallback((ref: FocusRef | null) => {
    if ((ref?.id ?? null) === hoverId.current) return;
    hoverId.current = ref?.id ?? null;
    setHoverState(ref);
  }, []);
  const toggle = useCallback((ref: FocusRef) => {
    setPicked(list => list.some(r => r.id === ref.id) ? list.filter(r => r.id !== ref.id)
      // One brushed range per chart: a new one replaces the old.
      : [...list.filter(r => !(ref.chart && r.chart === ref.chart)), ref].slice(-20));
  }, []);
  const remove = useCallback((id: string) => {
    setPicked(list => list.filter(r => r.id !== id));
    if (hoverId.current === id) setHover(null);
  }, [setHover]);
  const clear = useCallback(() => setPicked([]), []);

  // A new view: what was hovered on the old one no longer means anything. Picks stay, to compare across views.
  useEffect(() => { setHover(null); }, [resetKey, setHover]);

  useEffect(() => {
    const target = (e: Event) => {
      const el = (e.target as HTMLElement | null)?.closest?.('[data-ref-id]') as HTMLElement | null;
      return el && !el.closest('.agent') ? el : null;
    };
    const over = (e: MouseEvent) => { const el = target(e); if (el) setHover(refOf(el)); };
    let suppressClick = false;
    const click = (e: MouseEvent) => {
      if (suppressClick) { suppressClick = false; e.preventDefault(); e.stopPropagation(); return; }
      const el = target(e);
      if (!el || !e.altKey) return;
      e.preventDefault();
      e.stopPropagation();
      toggle(refOf(el));
    };
    let timer: ReturnType<typeof setTimeout> | null = null;
    let start: { x: number; y: number } | null = null;
    const touchStart = (e: TouchEvent) => {
      const el = target(e);
      if (!el || e.touches.length !== 1) return;
      start = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      timer = setTimeout(() => {
        timer = null;
        suppressClick = true;
        navigator.vibrate?.(10);
        toggle(refOf(el));
      }, LONG_PRESS_MS);
    };
    const touchMove = (e: TouchEvent) => {
      if (timer && start && Math.hypot(e.touches[0].clientX - start.x, e.touches[0].clientY - start.y) > 10) { clearTimeout(timer); timer = null; }
    };
    const touchEnd = () => { if (timer) { clearTimeout(timer); timer = null; } };
    document.addEventListener('mouseover', over);
    document.addEventListener('click', click, true);
    document.addEventListener('touchstart', touchStart, { passive: true });
    document.addEventListener('touchmove', touchMove, { passive: true });
    document.addEventListener('touchend', touchEnd);
    document.addEventListener('touchcancel', touchEnd);
    return () => {
      document.removeEventListener('mouseover', over);
      document.removeEventListener('click', click, true);
      document.removeEventListener('touchstart', touchStart);
      document.removeEventListener('touchmove', touchMove);
      document.removeEventListener('touchend', touchEnd);
      document.removeEventListener('touchcancel', touchEnd);
      if (timer) clearTimeout(timer);
    };
  }, [toggle, setHover]);

  // Picked and hovered rows are marked with a constructed stylesheet (the CSP allows no inline <style>),
  // so rows anywhere on the board show it without each view knowing about the dock.
  useEffect(() => {
    if (!('adoptedStyleSheets' in document)) return;
    const sheet = new CSSStyleSheet();
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    const selector = (id: string) => `[data-ref-id="${CSS.escape(id)}"]`;
    const rules = [
      ...picked.filter(r => !r.chart).map(r => `${selector(r.id)} { background: var(--accent-bg) !important; box-shadow: inset 2px 0 0 var(--accent); }`),
      ...(hover && !hover.chart ? [`${selector(hover.id)} { outline: 1px dashed color-mix(in srgb, var(--accent) 55%, transparent); outline-offset: -1px; }`] : []),
    ];
    try { sheet.replaceSync(rules.join('\n')); } catch { /* an odd id; nothing marked */ }
    return () => { document.adoptedStyleSheets = document.adoptedStyleSheets.filter(s => s !== sheet); };
  }, [picked, hover]);

  const value = useMemo(() => ({ picked, hover, toggle, setHover, remove, clear }), [picked, hover, toggle, setHover, remove, clear]);
  return <FocusContext.Provider value={value}>{children}</FocusContext.Provider>;
}

// ---------- the board's conversations ----------

async function post<T>(path: string, body: unknown, session: Session): Promise<T> {
  const response = await fetch(path, {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-CSRF-Token': session.csrfToken ?? '' },
    body: JSON.stringify(body),
  });
  if (response.status === 401) throw new SignedOut();
  const json = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(json.error ?? `the board answered ${response.status}`);
  return json;
}

const stored = {
  get(key: string): string | null { try { return localStorage.getItem(key); } catch { return null; } },
  set(key: string, value: string | null) { try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* private mode */ } },
};

/** The conversations, kept fresh by the board's change feed (a WebSocket), with a slow poll as a fallback. */
export function useAgent(session: Session | null, onSignedOut: () => void) {
  const [data, setData] = useState<AgentData | null>(null);
  const [active, setActiveState] = useState<string | null>(() => stored.get('agent:thread'));
  const [error, setError] = useState('');
  const activeRef = useRef(active);
  activeRef.current = active;
  const versionRef = useRef(-1);

  const load = useCallback(async () => {
    const thread = activeRef.current;
    try {
      const next = await getJson<AgentData>(`/api/agent${thread ? `?thread=${encodeURIComponent(thread)}` : ''}`);
      // A conversation that's gone (deleted after archiving) leaves the dock on a new one.
      if (thread && !next.conversation) { setActiveState(null); stored.set('agent:thread', null); }
      if (activeRef.current !== thread) return;
      versionRef.current = next.version;
      setData(next);
      setError('');
    } catch (err) {
      if (err instanceof SignedOut) onSignedOut();
      else setError((err as Error).message);
    }
  }, [onSignedOut]);

  const setActive = useCallback((id: string | null) => {
    activeRef.current = id;
    setActiveState(id);
    stored.set('agent:thread', id);
    void load();
  }, [load]);

  useEffect(() => {
    if (!session?.authenticated) return;
    void load();
    let socket: WebSocket | null = null;
    let closed = false;
    let wait = 1000;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let ping: ReturnType<typeof setInterval> | null = null;
    const connect = () => {
      if (closed) return;
      socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/agent/live`);
      socket.onopen = () => { wait = 1000; };
      socket.onmessage = event => {
        if (event.data === 'pong') return;
        try {
          const note = JSON.parse(String(event.data)) as { type?: string; version?: number; runner?: boolean };
          if (note.type !== 'changed') return;
          if (note.version !== versionRef.current) void load();
          else setData(d => d && typeof note.runner === 'boolean' && d.runner !== note.runner ? { ...d, runner: note.runner } : d);
        } catch { /* not ours */ }
      };
      socket.onclose = () => {
        socket = null;
        if (closed) return;
        retry = setTimeout(connect, wait);
        wait = Math.min(wait * 2, 30_000);
      };
    };
    connect();
    ping = setInterval(() => { if (socket?.readyState === WebSocket.OPEN) socket.send('ping'); }, 30_000);
    // The feed can miss a change while the tab sleeps; look again when it's visible, and now and then.
    const poll = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 60_000);
    const onVisible = () => { if (document.visibilityState === 'visible') void load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      closed = true;
      socket?.close();
      if (retry) clearTimeout(retry);
      if (ping) clearInterval(ping);
      clearInterval(poll);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [session?.authenticated, load]);

  return { data, active, setActive, error, reload: load };
}

export type Agent = ReturnType<typeof useAgent>;

export function threadTone(t: AgentThread): 'warn' | 'accent' | 'muted' {
  return t.open ? 'warn' : t.state !== 'idle' ? 'accent' : 'muted';
}

// ---------- the phone sheet ----------

/**
 * On phones the dock is a bottom sheet: drag its handle or header to resize it between three stops (just the
 * composer, half the screen, nearly all of it), or flick it down past the lowest stop to close it. The page
 * behind keeps room for whatever height it ends at (--agent-sheet-h).
 */
type Snap = 'peek' | 'half' | 'full';
const SNAPS: Snap[] = ['peek', 'half', 'full'];
const PHONE = '(max-width: 760px)';

function useSheet(open: boolean, close: () => void) {
  const ref = useRef<HTMLElement>(null);
  const [snap, setSnapState] = useState<Snap>(() => {
    const s = stored.get('agent:sheet') as Snap | null;
    return s && SNAPS.includes(s) ? s : 'half';
  });
  const [dragH, setDragH] = useState<number | null>(null);
  const drag = useRef<{ id: number; y0: number; h0: number; y: number; t: number; v: number; moved: boolean } | null>(null);
  const setSnap = (s: Snap) => { setSnapState(s); stored.set('agent:sheet', s); };

  // Keep the page's bottom padding the sheet's real height, so the end of a view can scroll above it.
  useEffect(() => {
    const el = ref.current;
    if (!open || !el) return;
    const root = document.documentElement;
    const ro = new ResizeObserver(() => root.style.setProperty('--agent-sheet-h', `${Math.round(el.getBoundingClientRect().height)}px`));
    ro.observe(el);
    return () => { ro.disconnect(); root.style.removeProperty('--agent-sheet-h'); };
  }, [open]);

  const heights = (): Record<Snap, number> => {
    const el = ref.current!;
    const head = el.querySelector<HTMLElement>('.agent-head');
    const composer = el.querySelector<HTMLElement>('.composer');
    const vh = window.visualViewport?.height ?? window.innerHeight;
    const peek = (head ? head.offsetTop + head.offsetHeight : 56) + (composer?.offsetHeight ?? 90);
    return { peek, half: Math.max(peek, vh * 0.62), full: Math.max(peek, vh - 48) };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLElement>) => {
    if (!window.matchMedia(PHONE).matches || !ref.current || e.button !== 0) return;
    if ((e.target as Element).closest('button, a, input, textarea')) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const h0 = ref.current.getBoundingClientRect().height;
    drag.current = { id: e.pointerId, y0: e.clientY, h0, y: e.clientY, t: e.timeStamp, v: 0, moved: false };
  };
  const onPointerMove = (e: React.PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    if (!d.moved && Math.abs(e.clientY - d.y0) < 4) return;
    d.moved = true;
    const dt = Math.max(1, e.timeStamp - d.t);
    d.v = 0.7 * ((d.y - e.clientY) / dt) + 0.3 * d.v; // px/ms, up is positive
    d.y = e.clientY; d.t = e.timeStamp;
    setDragH(Math.max(0, Math.min(heights().full, d.h0 + d.y0 - e.clientY)));
  };
  const onPointerUp = (e: React.PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    setDragH(null);
    if (!d.moved) {
      // A tap on the handle steps between the lowest stop and half.
      if ((e.target as Element).closest('.sheet-grab')) setSnap(snap === 'peek' ? 'half' : 'peek');
      return;
    }
    const hs = heights();
    const h = d.h0 + d.y0 - e.clientY;
    const aim = h + d.v * 180; // where a flick would carry it
    // Close only when pulled well below the lowest stop, or flicked down from it; a fast pull from higher up stops there.
    if (h < hs.peek * 0.6 || (d.h0 <= hs.peek + 8 && aim < hs.peek * 0.6)) { close(); return; }
    setSnap(SNAPS.reduce((best, s) => Math.abs(hs[s] - aim) < Math.abs(hs[best] - aim) ? s : best, 'half'));
  };
  const handlers = { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp };
  const className = `sheet-${dragH !== null ? 'dragging' : snap}`;
  return { ref, handlers, className, style: dragH !== null ? { height: `${dragH}px` } : undefined };
}

// ---------- the dock ----------

export function AgentDock({ session, agent, open, close, page, goAgents }: {
  session: Session; agent: Agent; open: boolean; close: () => void;
  /** What's on screen: the view's name and its URL. */
  page: { label: string; url: string };
  goAgents: () => void;
}) {
  const focus = useFocus();
  const { data, active, setActive } = agent;
  const conversation = data?.conversation && data.conversation.thread.id === active ? data.conversation : null;
  const thread = conversation?.thread ?? null;
  const [drafts, setDrafts] = useState<Record<string, string>>(() => {
    try { return JSON.parse(stored.get('agent:drafts') ?? '{}') as Record<string, string>; } catch { return {}; }
  });
  const draftKey = active ?? 'new';
  const draft = drafts[draftKey] ?? '';
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLTextAreaElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const live = (data?.threads ?? []).filter(t => !t.archived);
  const sheet = useSheet(open, close);

  const setDraft = (text: string) => setDrafts(d => {
    const next = { ...d, [draftKey]: text };
    if (!text) delete next[draftKey];
    stored.set('agent:drafts', JSON.stringify(next));
    return next;
  });

  useEffect(() => { if (open) input.current?.focus(); }, [open, active]);
  // Follow new messages to the bottom.
  const count = (conversation?.messages.length ?? 0) + (conversation?.proposals.length ?? 0);
  useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight }); }, [count, active, open]);

  const refs = (): AgentRef[] => {
    const pageRef: AgentRef = { kind: 'page', id: page.url, label: page.label };
    const picks = focus.picked.map(({ chart: _c, range: _r, ...r }) => ({ ...r, focus: 'picked' as const }));
    const hover = focus.hover && !focus.picked.some(p => p.id === focus.hover!.id)
      ? (({ chart: _c, range: _r, ...r }) => ({ ...r, focus: 'hover' as const }))(focus.hover) : null;
    return [pageRef, ...picks, ...(hover ? [hover] : [])];
  };

  const send = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setError('');
    try {
      const result = await post<{ thread: AgentThread }>('/api/agent/messages', {
        threadId: active ?? undefined, text, context: { url: page.url, view: page.label, refs: refs() },
      }, session);
      setDraft('');
      focus.clear();
      if (result.thread.id !== active) {
        setDrafts(d => { const next = { ...d }; delete next.new; stored.set('agent:drafts', JSON.stringify(next)); return next; });
        setActive(result.thread.id);
      } else {
        void agent.reload();
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  };

  const decide = async (p: AgentProposal, decision: 'approve' | 'dismiss') => {
    try { await post('/api/agent/decide', { proposalId: p.id, decision }, session); void agent.reload(); } catch (err) { setError((err as Error).message); }
  };
  const archive = async (archived: boolean) => {
    if (!thread) return;
    try {
      await post('/api/agent/archive', { threadId: thread.id, archived }, session);
      if (archived) setActive(null); else void agent.reload();
    } catch (err) { setError((err as Error).message); }
  };

  if (!open) return null;
  const tabs = [...live].slice(0, 4);
  if (thread && !tabs.some(t => t.id === thread.id)) tabs.unshift(thread);

  return (
    <aside className={`agent ${sheet.className}`} aria-label="isobot agent" ref={sheet.ref} style={sheet.style}>
      <div className="sheet-grab" aria-hidden="true" {...sheet.handlers} />
      <div className="agent-head" {...sheet.handlers}>
        <span className={`dot ${thread ? threadTone(thread) : 'accent'}`} />
        <h2 title={thread?.title}>{thread?.title ?? 'New conversation'}</h2>
        <div className="agent-head-actions">
          <button className="icon" onClick={() => setActive(null)} title="New conversation"><Plus size={15} /></button>
          {thread ? <button className="icon" onClick={() => void archive(!thread.archived)} title={thread.archived ? 'Restore' : 'Archive'}>
            {thread.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}</button> : null}
          <button className="icon" onClick={close} title="Close (the conversation stays)"><X size={16} /></button>
        </div>
      </div>
      {tabs.length ? (
        <div className="agent-switch">
          <div className="tabs">
            {tabs.map(t => (
              <button key={t.id} className={t.id === active ? 'active' : ''} onClick={() => setActive(t.id)} title={t.title}>
                <span className={`dot sm ${threadTone(t)}`} /><span className="agent-tab-title">{t.title}</span>
              </button>
            ))}
          </div>
          <button className="link" onClick={goAgents}>All {live.length} →</button>
        </div>
      ) : null}

      <div className="agent-context">
        <div className="agent-context-label"><Eye size={12} /> isobot sees <code title={page.url}>{page.url}</code></div>
        <div className="agent-refs">
          <span className="chip ref page">{page.label}</span>
          {focus.picked.map(r => (
            <span key={r.id} className="chip ref" title={r.label}>{r.label}<button onClick={() => focus.remove(r.id)} aria-label={`Remove ${r.label}`}><X size={10} /></button></span>
          ))}
          {focus.hover && !focus.picked.some(p => p.id === focus.hover!.id) ? (
            <span className="chip ref hovering" title="The last thing you hovered; ⌥-click (or long-press) to pick it">{focus.hover.label} · hover
              <button onClick={() => focus.setHover(null)} aria-label="Forget the hover"><X size={10} /></button></span>
          ) : null}
        </div>
        {!focus.picked.length && !focus.hover ? <span className="agent-hint">⌥-click rows or cards, or drag across a chart, to point at something</span> : null}
      </div>

      <div className="agent-log" ref={log}>
        {data && !data.runner ? <div className="banner warn">The runner isn't connected: messages wait until it's back.</div> : null}
        {!conversation ? (
          <Empty title="Ask about what's on screen" body="“Why do these need me?” · “What happened to installs here?” · “How could this train do better?”" />
        ) : <Conversation c={conversation} decide={decide} />}
        {thread && thread.state !== 'idle' ? (
          <div className="msg"><div className="msg-meta"><span className="spinner small" />{thread.status ?? (thread.state === 'queued' ? 'waiting for the runner' : 'working')}</div></div>
        ) : null}
      </div>

      <div className="composer">
        {error || agent.error ? <div className="banner bad">{error || agent.error}</div> : null}
        <div className="composer-box">
          <label htmlFor="agent-input" className="visually-hidden">Message isobot</label>
          <textarea id="agent-input" ref={input} rows={2} value={draft} placeholder="Ask about this page…"
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }} />
          <div className="composer-tools">
            <span className="meta">↵ send · ⇧↵ new line</span>
            <button className="button" onClick={() => void send()} disabled={!draft.trim() || sending}>
              {sending ? <span className="spinner small" /> : <SendHorizontal size={13} />}Send
            </button>
          </div>
        </div>
      </div>
    </aside>
  );
}

function Conversation({ c, decide }: { c: NonNullable<AgentData['conversation']>; decide: (p: AgentProposal, d: 'approve' | 'dismiss') => void }) {
  // Messages and proposals in time order; a proposal comes right after the reply that made it.
  const items: ({ kind: 'm'; m: AgentMessage } | { kind: 'p'; p: AgentProposal })[] = [
    ...c.messages.map(m => ({ kind: 'm' as const, m })), ...c.proposals.map(p => ({ kind: 'p' as const, p })),
  ].sort((a, b) => {
    const at = (x: typeof a) => x.kind === 'm' ? x.m.at : x.p.at;
    return at(a) < at(b) ? -1 : at(a) > at(b) ? 1 : (a.kind === 'm' ? 0 : 1) - (b.kind === 'm' ? 0 : 1);
  });
  let lastView: string | null = null;
  return (
    <>
      {items.map(item => {
        if (item.kind === 'p') return <ProposalCard key={item.p.id} p={item.p} decide={decide} />;
        const m = item.m;
        if (m.role === 'note') return <div key={m.seq} className="agent-note"><Markdown text={m.text} /></div>;
        if (m.role === 'isobot') return (
          <div key={m.seq} className="msg">
            <div className="msg-meta"><Bot size={12} />isobot · {rel(m.at)}</div>
            <div className="msg-body"><Markdown text={m.text} /></div>
          </div>
        );
        const view = m.context?.view ?? null;
        const divider = view && view !== lastView ? <div className="agent-divider">{lastView ? 'you opened' : 'from'} {view}</div> : null;
        lastView = view ?? lastView;
        const picks = (m.context?.refs ?? []).filter(r => r.focus);
        return (
          <Fragment key={m.seq}>
            {divider}
            <div className="msg you">
              <div className="msg-body">{m.text}</div>
              {picks.length ? <div className="agent-refs">{picks.map(r => <span key={r.id} className={`chip ref ${r.focus === 'hover' ? 'hovering' : ''}`}>{r.label}</span>)}</div> : null}
            </div>
          </Fragment>
        );
      })}
    </>
  );
}

const PROPOSAL_TONE: Record<AgentProposal['state'], string> = {
  open: 'warn', approved: 'info', running: 'info', done: 'ok', failed: 'bad', dismissed: 'muted', expired: 'muted',
};

function ProposalCard({ p, decide }: { p: AgentProposal; decide: (p: AgentProposal, d: 'approve' | 'dismiss') => void }) {
  const [busy, setBusy] = useState(false);
  const act = async (d: 'approve' | 'dismiss') => { setBusy(true); try { await decide(p, d); } finally { setBusy(false); } };
  return (
    <section className="section proposal">
      <div className="section-head"><h2>Proposed</h2><Chip tone={PROPOSAL_TONE[p.state]}>{p.state === 'open' ? 'needs you' : p.state}</Chip></div>
      <div className="proposal-body"><Markdown text={p.summary} /></div>
      {p.result ? <div className={`task-status ${p.state === 'failed' ? 'bad' : 'muted'} proposal-result`}>{p.result}</div> : null}
      {p.state === 'open' ? (
        <div className="task-actions">
          <button className="task-action go" disabled={busy} onClick={() => void act('approve')}><Check size={12} /> Approve</button>
          <button className="task-action danger" disabled={busy} onClick={() => void act('dismiss')}>Dismiss</button>
          <span className="meta">nothing runs until you approve</span>
        </div>
      ) : p.state === 'running' || p.state === 'approved' ? <div className="task-status muted proposal-result"><span className="spinner small" /> running…</div> : null}
    </section>
  );
}

// ---------- the Agents view ----------

export function AgentsView({ agent, openThread, newThread, session }: { agent: Agent; openThread: (id: string) => void; newThread: () => void; session: Session }) {
  const threads = agent.data?.threads ?? [];
  const live = threads.filter(t => !t.archived);
  const columns: { title: string; tone: string; hint: string; list: AgentThread[] }[] = [
    { title: 'Needs you', tone: 'warn', hint: 'A proposal waits for your approval', list: live.filter(t => t.open > 0) },
    { title: 'Working', tone: 'info', hint: 'Running a turn on the runner', list: live.filter(t => !t.open && t.state !== 'idle') },
    { title: 'Idle', tone: 'muted', hint: 'Answered; pick up where you left off', list: live.filter(t => !t.open && t.state === 'idle') },
    { title: 'Archived', tone: 'muted', hint: 'Kept 90 days; write in one to bring it back', list: threads.filter(t => t.archived) },
  ];
  const restore = async (t: AgentThread) => {
    await post('/api/agent/archive', { threadId: t.id, archived: !t.archived }, session).catch(() => undefined);
    void agent.reload();
  };
  return (
    <>
      <div className="stats agent-stats">
        {columns.map(c => <div key={c.title} className={`stat ${c.tone === 'warn' && c.list.length ? 'warn' : ''}`}><span className="stat-label">{c.title}</span><span className="stat-value">{c.list.length}</span></div>)}
      </div>
      {agent.data && !agent.data.runner ? <div className="banner warn">The runner isn't connected: new messages wait until it's back.</div> : null}
      <div className="toolbar"><button className="button" onClick={newThread}><Plus size={13} />New conversation <em className="tone-muted kbd">⌘J</em></button></div>
      {!threads.length ? <Empty title="No conversations yet" body="Open the dock from any view (⌘J) and ask about what's on screen." /> : (
        <div className="kanban agent-kanban">
          {columns.map(c => (
            <div key={c.title} className="column">
              <div className="column-head"><Chip tone={c.tone}>{c.title}</Chip><em>{c.list.length}</em></div>
              <div className="column-hint">{c.hint}</div>
              {c.list.map(t => (
                <div key={t.id} className="card">
                  <button className="card-title link-plain" onClick={() => openThread(t.id)}>{t.title}</button>
                  {t.state !== 'idle' ? <span className="task-status muted"><span className="spinner small" /> {t.status ?? 'working'}</span>
                    : t.last ? <span className="row-sub">{t.last.replace(/[*`#]/g, "")}</span> : null}
                  <div className="task-actions">
                    <button className={`task-action ${t.open ? 'go' : ''}`} onClick={() => openThread(t.id)}>{t.open ? `Review ${t.open}` : 'Open'}</button>
                    <button className="task-action" onClick={() => void restore(t)}>{t.archived ? 'Restore' : 'Archive'}</button>
                  </div>
                  <div className="card-meta"><span>{rel(t.updatedAt)}</span></div>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// ---------- a small, safe Markdown ----------

/** Paragraphs, lists, fenced code, `code`, **bold**, *italic* and links; everything else is text. Never HTML. */
export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) body.push(lines[i++]);
      i++;
      blocks.push(<pre key={blocks.length}><code>{body.join('\n')}</code></pre>);
      continue;
    }
    if (/^\s*([-*•]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) {
        let item = lines[i++].replace(/^\s*([-*•]|\d+[.)])\s+/, '');
        // Continuation lines of the same item.
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) item += ` ${lines[i++].trim()}`;
        items.push(item);
      }
      const List = ordered ? 'ol' : 'ul';
      blocks.push(<List key={blocks.length}>{items.map((t, n) => <li key={n}><Inline text={t} /></li>)}</List>);
      continue;
    }
    if (/^#{1,6}\s/.test(line)) { blocks.push(<p key={blocks.length}><strong><Inline text={line.replace(/^#+\s/, '')} /></strong></p>); i++; continue; }
    if (!line.trim()) { i++; continue; }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^```/.test(lines[i]) && !/^\s*([-*•]|\d+[.)])\s+/.test(lines[i]) && !/^#{1,6}\s/.test(lines[i])) para.push(lines[i++]);
    blocks.push(<p key={blocks.length}>{para.map((l, n) => <Fragment key={n}>{n ? <br /> : null}<Inline text={l} /></Fragment>)}</p>);
  }
  return <div className="md">{blocks}</div>;
}

function Inline({ text }: { text: string }) {
  const out: ReactNode[] = [];
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\(https?:\/\/[^\s)]+\))|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])|(\*[^*\s][^*]*\*)/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const at = match.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const [token] = match;
    const key = out.length;
    if (match[1]) out.push(<code key={key}>{token.slice(1, -1)}</code>);
    else if (match[2]) out.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    else if (match[3]) {
      const [, label, href] = /^\[([^\]]+)\]\((.+)\)$/.exec(token)!;
      out.push(<a key={key} href={href} target="_blank" rel="noreferrer">{label}</a>);
    } else if (match[4]) out.push(<a key={key} href={token} target="_blank" rel="noreferrer">{token}</a>);
    else out.push(<em key={key}>{token.slice(1, -1)}</em>);
    last = at + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}
