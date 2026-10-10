import { createRoot } from 'react-dom/client';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowUp, ArrowUpRight, BookOpen, Check, ChevronDown, ChevronRight, Copy, Database, FileText, KeyRound, Layers3, LogOut, Menu, MessageSquare, PanelRightClose, PanelRightOpen, Plus, RefreshCw, Settings2, Sparkles, Square, Terminal, X } from 'lucide-react';
import type { Api, Auth, Entry, Job, Snapshot, User } from './types';
import { Conversation, ConversationContent, ConversationScrollButton } from './components/ai-elements/conversation';
import { Message, MessageContent } from './components/ai-elements/message';
import { Account } from './components/account';
import { AuthGate } from './components/auth-gate';
import { FilesPanel, CapturesPanel, ResourcesPanel } from './components/workspace';
import { ErrorBanner, Loading, Markdown, Modal, errorText, isAbort, stamp } from './components/shared';
import './styles.css';

const validConversation = (value: string) => /^[A-Za-z0-9_-]{1,100}$/.test(value);
const startingConversation = () => { const value = new URL(location.href).searchParams.get('conversation') ?? 'vox'; return validConversation(value) ? value : 'vox'; };
const emptySnapshot: Snapshot = { model: '', busy: false, pending: [], entries: [] };
type ChatResult = { requestId: string; operationId: string; status: 'queued' | 'running' | 'done' | 'unanswered'; text?: string; reason?: string };
type UIJob = Job & { terminal?: boolean; cancelled?: boolean };
const oauthErrorMessage = () => {
  const url = new URL(location.href);
  const code = url.searchParams.get('authError');
  if (!code) return '';
  url.searchParams.delete('authError');
  history.replaceState(null, '', url);
  const messages: Record<string, string> = {
    not_configured: 'GitHub sign-in is not configured for this agent. You can connect with a bearer token.',
    invalid_state: 'That sign-in link expired. Start GitHub sign-in again.',
    denied: 'GitHub sign-in was cancelled or denied. You can try again.',
    not_allowed: 'This GitHub account cannot access this agent. Sign in with an allowed account.',
    login_failed: 'GitHub sign-in could not finish. Please try again.',
  };
  return messages[code] ?? '';
};
const settledJob = (job: UIJob, result: ChatResult): UIJob => {
  const cancelled = result.status === 'unanswered' && /abort|withdraw|cancel|stopped/i.test(result.reason ?? '');
  return { ...job, status: result.status === 'done' ? 'done' : 'failed', terminal: true, cancelled,
    text: result.text, error: cancelled ? 'Request stopped.' : result.reason || (result.status === 'unanswered' ? 'Pi did not complete this request.' : undefined) };
};

function Logo({ small = false }: { small?: boolean }) { return <span className={`pi-mark ${small ? 'small' : ''}`} aria-hidden="true">π</span>; }
function App() {
  const [auth, setAuth] = useState<Auth | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [oauthConfigured, setOauthConfigured] = useState(false);
  const [authBootstrapFailed, setAuthBootstrapFailed] = useState(false);
  const [bearer, setBearer] = useState('');
  const [bearerOpen, setBearerOpen] = useState(false);
  const [conversation, setConversation] = useState(startingConversation);
  const [conversations, setConversations] = useState(() => Array.from(new Set([startingConversation(), 'vox', 'default'])));
  const [snapshot, setSnapshot] = useState<Snapshot>(emptySnapshot);
  const [loading, setLoading] = useState(false);
  const [olderLoading, setOlderLoading] = useState(false);
  const [jobs, setJobs] = useState<UIJob[]>([]);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState(oauthErrorMessage);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [workspaceOpen, setWorkspaceOpen] = useState(() => window.matchMedia('(min-width:1101px)').matches);
  const [tab, setTab] = useState<'files' | 'captures' | 'resources'>('files');
  const [refreshKey, setRefreshKey] = useState(0);
  const [fileDirty, setFileDirty] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState<(() => void) | null>(null);
  const [newConversation, setNewConversation] = useState(false);
  const [conversationName, setConversationName] = useState('');
  const [accountOpen, setAccountOpen] = useState(false);
  const [copyId, setCopyId] = useState('');
  const [stopping, setStopping] = useState(false);
  const controllers = useRef(new Set<AbortController>());
  const generation = useRef(0);
  const refreshSequence = useRef(0);
  const historyCursor = useRef<string | undefined>(undefined);
  const historyInitialized = useRef(false);
  const drafts = useRef<Record<string, string>>({});
  const composer = useRef<HTMLTextAreaElement>(null);
  const invalidate = useCallback(() => { ++generation.current; for (const controller of controllers.current) controller.abort(); controllers.current.clear(); }, []);
  const reset = useCallback(() => {
    invalidate(); drafts.current = {}; historyCursor.current = undefined; historyInitialized.current = false;
    setAuth(null); setBearer(''); setSnapshot(emptySnapshot); setJobs([]); setAccountOpen(false); setDraft(''); setFileDirty(false);
    setConfirmDiscard(null); setNewConversation(false); setConversationName(''); setCopyId(''); setStopping(false); setOlderLoading(false); setLoading(false); setSidebarOpen(false);
    setConversations(Array.from(new Set([startingConversation(), 'vox', 'default'])));
  }, [invalidate]);
  const guard = useCallback((action: () => void) => { if (fileDirty) setConfirmDiscard(() => action); else action(); }, [fileDirty]);
  const onDirty = useCallback((dirty: boolean) => setFileDirty(dirty), []);

  const api: Api = useCallback(async <T,>(path: string, options: RequestInit = {}, query: Record<string, string | number | undefined> = {}, scoped = true): Promise<T> => {
    if (!auth) throw new Error('Connect to your agent first.');
    const epoch = generation.current;
    const controller = new AbortController(); controllers.current.add(controller);
    const url = new URL(path, location.origin);
    if (url.origin !== location.origin) throw new Error('Requests must stay on this origin.');
    if (scoped) url.searchParams.set('conversation', conversation);
    for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, String(value));
    const headers = new Headers(options.headers);
    if (auth.mode === 'bearer') headers.set('Authorization', `Bearer ${auth.token}`);
    if (options.body) headers.set('Content-Type', 'application/json');
    if (auth.mode === 'session' && options.method && !['GET', 'HEAD'].includes(options.method)) headers.set('X-CSRF-Token', auth.csrfToken);
    try {
      const response = await fetch(url, { ...options, headers, signal: controller.signal, credentials: auth.mode === 'session' ? 'same-origin' : 'omit', cache: 'no-store', redirect: 'error' });
      if (epoch !== generation.current) throw new DOMException('Conversation changed', 'AbortError');
      if (response.status === 401) { reset(); setError('Your connection expired or the token was not accepted. Connect again to continue.'); throw new DOMException('Disconnected', 'AbortError'); }
      const body = await response.json().catch(() => ({}));
      if (epoch !== generation.current) throw new DOMException('Conversation changed', 'AbortError');
      if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : `The request failed (${response.status}). Please try again.`);
      return body as T;
    } finally { controllers.current.delete(controller); }
  }, [auth, conversation, reset]);

  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/auth/session', { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal }).then(response => {
      if (!response.ok) throw new Error('Account session is unavailable');
      return response.json();
    }).then((session: { authenticated: boolean; oauthConfigured?: boolean; csrfToken?: string; user?: User }) => {
      if (controller.signal.aborted) return;
      setAuthBootstrapFailed(false); setOauthConfigured(session.oauthConfigured ?? session.authenticated);
      if (session.authenticated && session.user && session.csrfToken) { invalidate(); setAuth({ mode: 'session', csrfToken: session.csrfToken, user: session.user }); }
    }).catch(err => {
      if (!isAbort(err)) { setAuthBootstrapFailed(true); setError(current => current || 'Account sign-in is temporarily unavailable. You can still connect with a bearer token.'); }
    }).finally(() => { if (!controller.signal.aborted) setAuthLoading(false); });
    return () => { controller.abort(); invalidate(); };
  }, [invalidate]);

  const refresh = useCallback(async (initial = false) => {
    if (!auth) return;
    const epoch = generation.current;
    const sequence = ++refreshSequence.current;
    if (initial) setLoading(true);
    try {
      const data = await api<Snapshot>('/api/conversation', undefined, { limit: 100 });
      if (sequence !== refreshSequence.current) return;
      if (initial || !historyInitialized.current) { historyCursor.current = data.nextCursor; historyInitialized.current = true; setSnapshot(data); }
      else setSnapshot(current => { const entries = new Map(current.entries.map(entry => [entry.id, entry])); for (const entry of data.entries) entries.set(entry.id, entry); return { ...data, nextCursor: historyCursor.current, entries: [...entries.values()].sort((a, b) => Number(a.id) - Number(b.id)) }; });
    } catch (err) { if (!isAbort(err)) setError(errorText(err)); }
    finally { if (sequence === refreshSequence.current && epoch === generation.current) setLoading(false); }
  }, [api, auth]);

  useEffect(() => { setSnapshot(emptySnapshot); setJobs([]); historyCursor.current = undefined; historyInitialized.current = false; if (auth) { setError(''); void refresh(true); } }, [auth, conversation, refresh]);
  const busyJobs = jobs.filter(job => job.status === 'pending');
  const stopIds = Array.from(new Set([...busyJobs.map(job => job.id), ...snapshot.pending.map(operation => operation.operationId).filter(validConversation)]));
  const agentBusy = snapshot.busy || snapshot.pending.length > 0 || busyJobs.length > 0;
  useEffect(() => {
    if (!auth || !agentBusy) return;
    const timer = window.setInterval(() => { void refresh(); }, 2500);
    return () => window.clearInterval(timer);
  }, [auth, agentBusy, refresh]);

  useEffect(() => {
    if (!auth || !busyJobs.length) return;
    let cancelled = false;
    const ids = busyJobs.map(job => job.id);
    const poll = async () => {
      const results = await Promise.allSettled(ids.map(id => api<ChatResult>(`/api/chat/${encodeURIComponent(id)}`)));
      if (cancelled) return;
      results.forEach((result, index) => {
        if (result.status === 'fulfilled' && ['done', 'unanswered'].includes(result.value.status)) {
          const value = result.value;
          setJobs(current => current.map(job => job.id === ids[index] ? settledJob(job, value) : job));
          void refresh(); setRefreshKey(key => key + 1);
        }
      });
    };
    const timer = window.setInterval(() => { void poll(); }, 2000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [api, auth, busyJobs.map(job => job.id).join(','), refresh]);

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => { if (fileDirty) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', onBeforeUnload); return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [fileDirty]);

  const connect = (event: FormEvent) => { event.preventDefault(); const token = bearer.trim().replace(/^Bearer\s+/i, ''); if (!token) return; invalidate(); setAuth({ mode: 'bearer', token }); setBearer(''); setError(''); };
  const selectConversation = (value: string) => guard(() => { if (value === conversation) { setSidebarOpen(false); return; } drafts.current[conversation] = draft; invalidate(); setConversation(value); setDraft(drafts.current[value] ?? ''); setConversations(current => Array.from(new Set([...current, value]))); const url = new URL(location.href); url.searchParams.set('conversation', value); history.replaceState(null, '', url); setSidebarOpen(false); setFileDirty(false); });
  const createConversation = (event: FormEvent) => { event.preventDefault(); const value = conversationName.trim(); if (!validConversation(value)) { setError('Use 1–100 letters, digits, underscores, or hyphens.'); return; } setNewConversation(false); selectConversation(value); };
  const submit = async (job: UIJob) => {
    const epoch = generation.current;
    setError(''); setJobs(current => current.some(item => item.id === job.id) ? current.map(item => item.id === job.id ? { ...item, status: 'pending', terminal: false, cancelled: false, error: undefined } : item) : [...current, job]);
    try {
      const result = await api<ChatResult>('/api/chat', { method: 'POST', body: JSON.stringify({ prompt: job.prompt, conversation, requestId: job.id }) }, undefined, false);
      if (epoch !== generation.current) return;
      if (result.status === 'done' || result.status === 'unanswered') setJobs(current => current.map(item => item.id === job.id ? settledJob(item, result) : item));
      void refresh();
    } catch (err) { if (!isAbort(err) && epoch === generation.current) setJobs(current => current.map(item => item.id === job.id ? { ...item, status: 'failed', error: errorText(err) } : item)); }
  };
  const retry = (job: UIJob) => {
    if (!job.terminal) { void submit(job); return; }
    setJobs(current => current.filter(item => item.id !== job.id));
    void submit({ id: crypto.randomUUID(), prompt: job.prompt, status: 'pending', baseline: snapshot.entries.map(entry => entry.id) });
  };
  const send = (event?: FormEvent) => { event?.preventDefault(); const text = draft.trim(); if (!text || text.length > 16000 || agentBusy) return; setDraft(''); drafts.current[conversation] = ''; void submit({ id: crypto.randomUUID(), prompt: text, status: 'pending', baseline: snapshot.entries.map(entry => entry.id) }); composer.current?.focus(); };
  const stop = async () => {
    if (!stopIds.length) return;
    const epoch = generation.current; setStopping(true);
    try {
      const results = await Promise.allSettled(stopIds.map(id => api<ChatResult>(`/api/chat/${encodeURIComponent(id)}`, { method: 'DELETE' })));
      if (epoch !== generation.current) return;
      for (const result of results) {
        if (result.status === 'fulfilled' && ['done', 'unanswered'].includes(result.value.status)) {
          setJobs(current => current.map(job => job.id === result.value.operationId ? settledJob(job, result.value) : job));
        } else if (result.status === 'rejected' && !isAbort(result.reason)) setError(errorText(result.reason));
      }
      void refresh(); setRefreshKey(key => key + 1);
    } finally { if (epoch === generation.current) setStopping(false); }
  };
  const loadOlder = async () => { const epoch = generation.current; setOlderLoading(true); try { const data = await api<Snapshot>('/api/conversation', undefined, { limit: 100, before: historyCursor.current }); historyCursor.current = data.nextCursor; setSnapshot(current => ({ ...current, nextCursor: data.nextCursor, entries: [...data.entries.filter(entry => !current.entries.some(item => item.id === entry.id)), ...current.entries] })); } catch (err) { if (!isAbort(err)) setError(errorText(err)); } finally { if (epoch === generation.current) setOlderLoading(false); } };
  const disconnect = () => guard(() => { reset(); setError(''); });
  const logout = () => guard(() => { void api('/auth/logout', { method: 'POST' }, undefined, false).then(() => { reset(); setError(''); }).catch(err => { if (!isAbort(err)) setError(errorText(err)); }); });
  const copy = (entry: Entry) => { void navigator.clipboard.writeText(entry.text).then(() => { setCopyId(entry.id); setTimeout(() => setCopyId(''), 1800); }).catch(() => setError('Copy was unavailable. Select the message text to copy it.')); };
  const optimistic = jobs.filter(job => !snapshot.entries.some(entry => entry.role === 'user' && entry.text === job.prompt && !job.baseline.includes(entry.id)));
  const unrecordedReplies = jobs.filter(job => job.status === 'done' && job.text && !snapshot.entries.some(entry => entry.role === 'assistant' && entry.text === job.text && !job.baseline.includes(entry.id)));

  if (!auth) return <AuthGate conversation={conversation} loading={authLoading} oauthConfigured={oauthConfigured} serviceUnavailable={authBootstrapFailed} error={error} onDismissError={() => setError('')} bearer={bearer} onBearerChange={setBearer} bearerOpen={bearerOpen} onToggleBearer={() => setBearerOpen(value => !value)} onConnect={connect} />;

  return <div className={`app-shell ${workspaceOpen ? 'workspace-visible' : ''} ${sidebarOpen ? 'sidebar-visible' : ''}`}>
    {sidebarOpen && <button className="sidebar-scrim" type="button" aria-label="Close navigation" onClick={() => setSidebarOpen(false)} />}
    <aside className="sidebar" aria-label="Conversation navigation"><a className="brand" href={`/console?conversation=${encodeURIComponent(conversation)}`} onClick={event => event.preventDefault()}><Logo /><strong>Pi</strong><span className="brand-tag">WORKSPACE</span></a><button className="new-chat-button" type="button" onClick={() => { setConversationName(''); setNewConversation(true); }}><Plus size={17} />New conversation</button><div className="nav-section-title"><span>YOUR CONVERSATIONS</span><MessageSquare size={13} /></div><nav className="conversation-nav">{conversations.map(name => <button type="button" key={name} className={conversation === name ? 'active' : ''} onClick={() => selectConversation(name)}><MessageSquare size={16} /><span>{name === 'vox' ? 'Vox' : name === 'default' ? 'General' : name}</span>{name === conversation && <span className="nav-active-dot" />}</button>)}</nav><div className="sidebar-notebook"><Sparkles size={19} /><p>One conversation.<br />A growing workspace.</p><span>Pi remembers your context and works with the files you keep here.</span><button type="button" onClick={() => { setWorkspaceOpen(true); setTab('files'); setSidebarOpen(false); }}>Explore your files<ChevronRight size={14} /></button></div><div className="sidebar-bottom"><div className="infrastructure"><span className="status-dot" /><span>Durable agent online</span><Layers3 size={14} /></div><button className="account-button" type="button" onClick={() => auth.mode === 'session' ? setAccountOpen(true) : disconnect()}><span className="avatar">{auth.mode === 'session' ? auth.user.login.slice(0, 1).toUpperCase() : <KeyRound size={15} />}</span><span><strong>{auth.mode === 'session' ? auth.user.name || auth.user.login : 'Token connection'}</strong><small>{auth.mode === 'session' ? `@${auth.user.login}` : 'Stored in this tab'}</small></span>{auth.mode === 'session' ? <Settings2 size={16} /> : <LogOut size={16} />}</button></div></aside>
    <main className="chat-main"><header className="chat-header"><button type="button" className="icon-button mobile-menu" aria-label="Open navigation" onClick={() => setSidebarOpen(true)}><Menu size={20} /></button><div className="chat-title"><div><h1>{conversation === 'vox' ? 'Vox' : conversation === 'default' ? 'General' : conversation}</h1><span className="badge subtle">conversation</span></div><p><span className={`status-dot ${agentBusy ? 'busy' : ''}`} />{agentBusy ? 'Pi is working' : 'Ready when you are'}{snapshot.model && <><span className="separator-dot">·</span><span className="model-name" title={snapshot.model}>{snapshot.model.split('/').pop()}</span></>}</p></div><div className="header-actions"><button type="button" className="icon-button" title="Refresh conversation and workspace" aria-label="Refresh conversation and workspace" disabled={loading} onClick={() => { void refresh(); setRefreshKey(value => value + 1); }}><RefreshCw size={16} className={loading ? 'spin' : ''} /></button><button className={`workspace-toggle ${workspaceOpen ? 'active' : ''}`} type="button" aria-label={workspaceOpen ? 'Close workspace panel' : 'Open workspace panel'} aria-expanded={workspaceOpen} aria-controls="workspace-panel" onClick={() => setWorkspaceOpen(value => !value)}>{workspaceOpen ? <PanelRightClose size={17} /> : <PanelRightOpen size={17} />}<span>Workspace</span></button></div></header>
      {error && <div className="main-error"><ErrorBanner onDismiss={() => setError('')}>{error}</ErrorBanner></div>}
      <Conversation key={conversation} aria-label="Conversation with Pi"><ConversationContent>{loading ? <div className="history-loading"><Loading>Loading your conversation…</Loading><div className="skeleton-lines"><span /><span /><span /></div></div> : !snapshot.entries.length && !jobs.length ? <section className="chat-empty"><div className="empty-logo"><Logo /></div><p className="eyebrow">YOUR IDEAS HAVE A HOME</p><h2>What’s on your mind?</h2><p>Think out loud, explore a question, or put Pi to work.<br />Your context and files stay with this conversation.</p><div className="starter-grid">{[{ icon: BookOpen, title: 'Find the thread', text: 'Summarize my saved captures and identify the most important ideas.' }, { icon: FileText, title: 'Start with your files', text: 'Look through my workspace files and tell me what you can help with.' }, { icon: Sparkles, title: 'Make a little progress', text: 'Help me choose one useful next step from my notes and ideas.' }].map(item => <button key={item.title} type="button" onClick={() => { setDraft(item.text); composer.current?.focus(); }}><item.icon size={18} /><strong>{item.title}</strong><span>{item.text}</span><ArrowUpRight size={14} /></button>)}</div></section> : <>{snapshot.nextCursor && <button className="load-earlier" type="button" disabled={olderLoading} onClick={() => void loadOlder()}>{olderLoading ? 'Loading earlier messages…' : 'Load earlier messages'}</button>}{snapshot.entries.map(entry => entry.role === 'tool' ? <details className={`tool-activity ${entry.toolResult?.error ? 'tool-error' : ''}`} key={entry.id}><summary><Terminal size={14} /><span>{entry.toolResult?.name ?? 'Tool result'}</span><span className="tool-status">{entry.toolResult?.error ? 'Error' : 'Complete'}</span><ChevronDown size={13} /></summary><pre>{entry.text || 'No text output.'}</pre></details> : entry.role === 'system' ? <p key={entry.id} className="system-message">{entry.text}</p> : <Message key={entry.id} from={entry.role}><div className="message-heading">{entry.role === 'assistant' ? <><Logo small /><strong>Pi</strong></> : <strong>You</strong>}{entry.createdAt && <time>{stamp(entry.createdAt)}</time>}</div><MessageContent>{entry.text && (entry.role === 'assistant' ? <Markdown>{entry.text}</Markdown> : <p className="user-text">{entry.text}</p>)}{entry.toolCalls?.map(call => <details key={call.id} className="tool-detail"><summary><Terminal size={13} />{call.name}<ChevronDown size={13} /></summary><pre>{call.arguments}</pre></details>)}</MessageContent>{entry.text && <button className="message-copy" title="Copy message" aria-label="Copy message" type="button" onClick={() => copy(entry)}>{copyId === entry.id ? <Check size={13} /> : <Copy size={13} />}{copyId === entry.id ? 'Copied' : 'Copy'}</button>}</Message>)}{optimistic.map(job => <Message key={job.id} from="user" className="optimistic"><div className="message-heading"><strong>You</strong><time>{job.status === 'pending' ? 'Sending…' : job.cancelled ? 'Stopped' : job.status === 'failed' ? 'Needs attention' : 'Sent'}</time></div><MessageContent><p className="user-text">{job.prompt}</p></MessageContent></Message>)}{unrecordedReplies.map(job => <Message from="assistant" key={`reply-${job.id}`}><div className="message-heading"><Logo small /><strong>Pi</strong></div><MessageContent><Markdown>{job.text ?? ''}</Markdown></MessageContent></Message>)}{jobs.filter(job => job.status === 'failed').map(job => <div key={`error-${job.id}`} className="prompt-error" role="alert"><span>{job.error || 'Pi could not complete that request.'}</span><button className="button secondary" type="button" disabled={agentBusy} onClick={() => retry(job)}><RefreshCw size={13} />{job.terminal ? "Send again" : "Retry request"}</button><p>{job.terminal ? "This request has ended. Sending again starts a new request." : "Retries reuse the original request ID to avoid duplicate work."}</p></div>)}{agentBusy && <div className="thinking" role="status"><Logo small /><span>Pi is thinking<span className="thinking-dots"><i /><i /><i /></span></span>{snapshot.pending.length > 1 && <small>{snapshot.pending.length} operations pending</small>}</div>}</>}</ConversationContent><ConversationScrollButton /></Conversation>
      <div className="composer-region"><form className={`composer ${draft.length > 16000 ? 'invalid' : ''}`} onSubmit={send}><label htmlFor="message" className="sr-only">Message Pi</label><textarea ref={composer} id="message" value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send(); } }} placeholder="Message Pi…" rows={2} /><div className="composer-toolbar"><span><Logo small /><span>Your durable thinking partner</span></span>{agentBusy && stopIds.length > 0 ? <button className="send-button stop-button" type="button" onClick={() => void stop()} disabled={stopping} title="Stop this request" aria-label="Stop this request"><Square size={15} fill="currentColor" /></button> : <button className="send-button" type="submit" disabled={!draft.trim() || draft.length > 16000 || agentBusy} title="Send message" aria-label="Send message"><ArrowUp size={20} /></button>}</div></form><div className="composer-caption"><span>{draft.length > 16000 ? 'Messages can contain up to 16,000 characters.' : 'Enter to send · Shift + Enter for a new line'}</span><span>Context stays with Pi<span className="status-dot" /></span></div></div>
    </main>
    <aside id="workspace-panel" className="workspace-panel" aria-label="Agent workspace" hidden={!workspaceOpen}><header className="workspace-header"><div><Layers3 size={18} /><h2>Workspace</h2></div><button className="icon-button" type="button" title="Close workspace" aria-label="Close workspace" onClick={() => setWorkspaceOpen(false)}><X size={17} /></button></header><div className="workspace-tabs" role="tablist" aria-label="Workspace sections">{([{ key: 'files', name: 'Files', icon: FileText }, { key: 'captures', name: 'Captures', icon: BookOpen }, { key: 'resources', name: 'Resources', icon: Database }] as const).map(item => <button id={`tab-${item.key}`} role="tab" aria-selected={tab === item.key} tabIndex={tab === item.key ? 0 : -1} aria-controls={`panel-${item.key}`} key={item.key} className={tab === item.key ? 'active' : ''} type="button" onClick={() => setTab(item.key)} onKeyDown={event => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); const keys = ['files', 'captures', 'resources'] as const; const index = keys.indexOf(item.key); const next = event.key === 'Home' ? 0 : event.key === 'End' ? keys.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + keys.length) % keys.length; setTab(keys[next]); document.getElementById(`tab-${keys[next]}`)?.focus(); }}><item.icon size={15} />{item.name}</button>)}</div><div className="workspace-scroll" key={conversation}><section id="panel-files" role="tabpanel" aria-labelledby="tab-files" hidden={tab !== 'files'}><FilesPanel api={api} refreshKey={refreshKey} guard={guard} onDirty={onDirty} /></section>{tab === 'captures' && <section id="panel-captures" role="tabpanel" aria-labelledby="tab-captures"><CapturesPanel api={api} refreshKey={refreshKey} /></section>}{tab === 'resources' && <section id="panel-resources" role="tabpanel" aria-labelledby="tab-resources"><ResourcesPanel api={api} refreshKey={refreshKey} /></section>}</div><footer className="workspace-footer"><span className="status-dot" />Scoped to <strong>{conversation}</strong></footer></aside>
    {newConversation && <Modal title="A fresh conversation" onClose={() => setNewConversation(false)}><form onSubmit={createConversation}><p className="muted">Each conversation keeps its own history, captures, and files.</p><label className="form-field">Conversation name<input autoFocus required value={conversationName} onChange={event => setConversationName(event.target.value)} pattern="[A-Za-z0-9_-]{1,100}" maxLength={100} placeholder="e.g. product-ideas" /></label><p className="input-hint">Letters, digits, underscores, and hyphens.</p><div className="modal-footer"><button className="button secondary" type="button" onClick={() => setNewConversation(false)}>Cancel</button><button className="button primary" type="submit">Create conversation</button></div></form></Modal>}
    {confirmDiscard && <Modal title="You have unsaved changes" onClose={() => setConfirmDiscard(null)}><p>Your file has changes that haven’t been saved. Save your work first, or discard those changes to continue.</p><div className="modal-footer"><button className="button secondary" type="button" onClick={() => setConfirmDiscard(null)}>Keep editing</button><button className="button destructive" type="button" onClick={() => { const action = confirmDiscard; setConfirmDiscard(null); setFileDirty(false); action(); }}>Discard changes</button></div></Modal>}
    {accountOpen && auth.mode === 'session' && <Account api={api} user={auth.user} onClose={() => setAccountOpen(false)} onLogout={logout} />}
  </div>;
}

const root = document.getElementById('root');
if (root) createRoot(root).render(<App />);
