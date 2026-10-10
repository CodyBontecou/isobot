import { useEffect, useState } from 'react';
import { Check, Copy, KeyRound, Plus, Trash2 } from 'lucide-react';
import type { AccountToken, Api, User } from '../types';
import { ErrorBanner, Loading, Modal, errorText, isAbort, stamp } from './shared';

export function Account({ api, user, onClose, onLogout }: { api: Api; user: User; onClose: () => void; onLogout: () => void }) {
  const [tokens, setTokens] = useState<AccountToken[]>();
  const [error, setError] = useState('');
  const [name, setName] = useState('Vox');
  const [expiry, setExpiry] = useState('90');
  const [write, setWrite] = useState(true);
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState('');
  const [copied, setCopied] = useState(false);
  const expired = (token: AccountToken) => !!token.expiresAt && Date.parse(token.expiresAt) <= Date.now();
  const load = async () => { try { const result = await api<{ tokens: AccountToken[] }>('/api/auth/tokens', undefined, undefined, false); setTokens(result.tokens); } catch (err) { if (!isAbort(err)) setError(errorText(err)); } };
  useEffect(() => { void load(); }, [api]);
  const create = async (event: React.FormEvent) => { event.preventDefault(); setBusy(true); setError(''); try { const result = await api<{ token: string }>('/api/auth/tokens', { method: 'POST', body: JSON.stringify({ name, scopes: write ? ['read', 'write'] : ['read'], expiresInDays: expiry === 'null' ? null : Number(expiry) }) }, undefined, false); setSecret(result.token); setCopied(false); await load(); } catch (err) { if (!isAbort(err)) setError(errorText(err)); } finally { setBusy(false); } };
  const revoke = async (id: string) => { setBusy(true); setError(''); try { await api(`/api/auth/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' }, undefined, false); await load(); } catch (err) { if (!isAbort(err)) setError(errorText(err)); } finally { setBusy(false); } };
  return <Modal title="Your account" onClose={onClose} className="account-modal"><p className="muted">Signed in as <strong>@{user.login}</strong>. Create a token to connect Vox or another client to your agent.</p>{error && <ErrorBanner>{error}</ErrorBanner>}
    {secret && <section className="secret-panel"><div className="section-title"><KeyRound size={16} /><h3>Your new token</h3></div><p>Copy it now. You can only see this value once.</p><code className="token-secret">{secret}</code><button className="button secondary" type="button" onClick={() => { void navigator.clipboard.writeText(secret).then(() => setCopied(true)).catch(() => setError('Copy was unavailable. Select and copy the token above.')); }}>{copied ? <Check size={15} /> : <Copy size={15} />}{copied ? 'Copied' : 'Copy token'}</button></section>}
    <form onSubmit={create} className="token-form"><h3>Create an API token</h3><label>Name<input required maxLength={80} value={name} onChange={event => setName(event.target.value)} placeholder="e.g. Vox on my phone" /></label><label>Expires<select value={expiry} onChange={event => setExpiry(event.target.value)}><option value="30">After 30 days</option><option value="90">After 90 days</option><option value="365">After one year</option><option value="null">Never</option></select></label><label className="checkbox"><input type="checkbox" checked={write} onChange={event => setWrite(event.target.checked)} />Allow prompts and workspace changes</label><button className="button primary" disabled={busy || !name.trim()}><Plus size={15} />Create token</button></form>
    <div className="section-title"><h3>API tokens</h3><span className="muted">{tokens?.filter(token => !token.revokedAt && !expired(token)).length ?? '…'} active</span></div>{!tokens ? <Loading /> : !tokens.length ? <p className="muted">No API tokens yet.</p> : <div className="token-list">{tokens.map(token => <div className={`token-row ${token.revokedAt || expired(token) ? 'revoked' : ''}`} key={token.id}><div><strong>{token.name}</strong><code>{token.prefix}…</code><p className="muted">{token.scopes.join(' + ')} · {token.revokedAt ? 'Revoked' : expired(token) ? 'Expired' : token.expiresAt ? `Expires ${stamp(token.expiresAt)}` : 'No expiry'}</p></div>{!token.revokedAt && <button type="button" className="icon-button danger" disabled={busy} aria-label={`Revoke ${token.name}`} title="Revoke token" onClick={() => void revoke(token.id)}><Trash2 size={16} /></button>}</div>)}</div>}<div className="modal-footer"><button className="button secondary" type="button" onClick={onLogout}>Sign out</button><button className="button primary" type="button" onClick={onClose}>Done</button></div>
  </Modal>;
}
