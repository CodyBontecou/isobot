import type { FormEvent } from 'react';
import { ArrowUpRight, BookOpen, ChevronDown, FileText, KeyRound, LockKeyhole, MessageSquare, ShieldCheck } from 'lucide-react';
import { ErrorBanner, GithubIcon, Loading } from './shared';
import './auth-gate.css';

interface AuthGateProps {
  conversation: string;
  loading: boolean;
  oauthConfigured: boolean;
  serviceUnavailable: boolean;
  error: string;
  onDismissError: () => void;
  bearer: string;
  onBearerChange: (value: string) => void;
  bearerOpen: boolean;
  onToggleBearer: () => void;
  onConnect: (event: FormEvent) => void;
}

/** Presentation only; session checks and credentials remain in the parent app. */
export function AuthGate({ conversation, loading, oauthConfigured, serviceUnavailable, error, onDismissError,
  bearer, onBearerChange, bearerOpen, onToggleBearer, onConnect }: AuthGateProps) {
  const showBearer = bearerOpen;
  return <main className="auth-gate">
    <header className="auth-gate-header"><div className="auth-gate-brand"><span className="pi-mark" aria-hidden="true">π</span><strong>Pi</strong></div><span className="auth-gate-private"><LockKeyhole size={13} />Private workspace</span></header>
    <div className="auth-gate-layout">
      <section className="auth-gate-intro" aria-labelledby="auth-gate-heading">
        <p className="auth-gate-eyebrow">YOUR DURABLE AGENT</p>
        <h1 id="auth-gate-heading">Your workspace,<br />ready when you are.</h1>
        <p className="auth-gate-description">Your conversations, Vox captures, and files live here. Sign in to continue with Pi.</p>
        <div className="auth-gate-context">
          <div><span className="auth-gate-context-icon"><MessageSquare size={18} /></span><span><strong>Conversations</strong><small>Pick up with your context intact.</small></span></div>
          <div><span className="auth-gate-context-icon"><BookOpen size={18} /></span><span><strong>Vox captures</strong><small>Your original Markdown, saved for later.</small></span></div>
          <div><span className="auth-gate-context-icon"><FileText size={18} /></span><span><strong>Workspace</strong><small>Keep the files Pi works with close at hand.</small></span></div>
        </div>
      </section>
      <section className="auth-gate-card" aria-labelledby="auth-gate-signin-heading">
        <div className="auth-gate-identity"><GithubIcon size={27} /></div>
        <p className="auth-gate-card-eyebrow">WELCOME BACK</p>
        <h2 id="auth-gate-signin-heading">Sign in to Pi</h2>
        <p className="auth-gate-card-description">Open your workspace with your authorized GitHub account.</p>
        {error && <ErrorBanner onDismiss={onDismissError}>{error}</ErrorBanner>}
        {loading ? <div className="auth-gate-checking"><Loading>Checking your connection…</Loading></div> : <>
          {oauthConfigured ? <><a className="auth-gate-github" href={`/auth/github/login?conversation=${encodeURIComponent(conversation)}`}><GithubIcon size={19} /><span>Continue with GitHub</span><ArrowUpRight size={17} /></a><p className="auth-gate-verification"><ShieldCheck size={13} />GitHub verifies your identity.</p></> : <div className="auth-gate-configuration" role="status"><span className="auth-gate-configuration-dot" /><div><strong>{serviceUnavailable ? 'Sign-in is temporarily unavailable' : 'GitHub sign-in is being configured'}</strong><p>{serviceUnavailable ? 'Please try again shortly. Your existing bearer token can still connect you.' : 'You can use your existing Vox bearer token while setup is completed.'}</p></div></div>}
          <div className="auth-gate-alternative"><button type="button" className="auth-gate-token-toggle" aria-expanded={showBearer} aria-controls="auth-gate-bearer" onClick={onToggleBearer}><KeyRound size={14} /><span>Use a bearer token</span><ChevronDown size={14} className={showBearer ? 'expanded' : ''} /></button>
            {showBearer && <form className="auth-gate-bearer" id="auth-gate-bearer" onSubmit={onConnect}><label htmlFor="bearer">Bearer token</label><div><input id="bearer" type="password" required value={bearer} onChange={event => onBearerChange(event.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="Paste your Vox token" /><button type="submit">Connect<ArrowUpRight size={15} /></button></div><p>The token stays in this tab’s memory until you disconnect.</p></form>}
          </div>
        </>}
        <div className="auth-gate-card-footer"><LockKeyhole size={13} /><span>Only approved accounts can access this workspace.</span></div>
      </section>
    </div>
    <footer className="auth-gate-footer"><span className="auth-gate-footer-line" /><span>A conversation you can come back to.</span><span className="auth-gate-footer-line" /></footer>
  </main>;
}
