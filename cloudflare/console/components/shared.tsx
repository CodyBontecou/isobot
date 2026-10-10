import { useEffect, useId, useRef, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { AlertCircle, LoaderCircle, X } from 'lucide-react';

export const bytes = (n: number) => n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / (1024 * 1024)).toFixed(2)} MB`;
export const stamp = (value?: string | null) => value ? new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
export const number = (value: number) => Number(value || 0).toLocaleString();
export const money = (value: number) => `$${Number(value || 0).toFixed(value > 0 && value < .01 ? 6 : 2)}`;
export const errorText = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong. Please try again.';
export const isAbort = (error: unknown) => error instanceof Error && error.name === 'AbortError';
export const Markdown = ({ children }: { children: string }) => <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ node: _node, children, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer">{children}</a> }}>{children}</ReactMarkdown></div>;
export const GithubIcon = ({ size = 20 }: { size?: number }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .9a11.1 11.1 0 0 0-3.51 21.63c.55.1.76-.24.76-.53v-2.06c-3.1.67-3.75-1.3-3.75-1.3-.51-1.3-1.24-1.64-1.24-1.64-1.01-.69.08-.67.08-.67 1.12.08 1.71 1.15 1.71 1.15.99 1.69 2.59 1.2 3.22.92.1-.72.39-1.2.7-1.48-2.48-.28-5.08-1.24-5.08-5.5 0-1.22.44-2.21 1.15-2.99-.12-.28-.5-1.42.11-2.95 0 0 .94-.3 3.05 1.14A10.6 10.6 0 0 1 12 6.25c.95 0 1.88.13 2.78.37 2.11-1.44 3.04-1.14 3.04-1.14.61 1.53.23 2.67.11 2.95.72.78 1.15 1.77 1.15 2.99 0 4.27-2.61 5.21-5.1 5.49.4.35.75 1.02.75 2.06V22c0 .3.2.64.77.53A11.1 11.1 0 0 0 12 .9Z" /></svg>;
export function Loading({ children = 'Loading…' }: { children?: ReactNode }) { return <div className="loading-state" role="status"><LoaderCircle className="spin" size={18} /><span>{children}</span></div>; }
export function ErrorBanner({ children, onDismiss }: { children: ReactNode; onDismiss?: () => void }) { return <div className="error-banner" role="alert"><AlertCircle size={16} /><span>{children}</span>{onDismiss && <button type="button" className="icon-button" aria-label="Dismiss error" onClick={onDismiss}><X size={15} /></button>}</div>; }
export function Modal({ title, children, onClose, className = '' }: { title: string; children: ReactNode; onClose: () => void; className?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => { ref.current?.showModal(); const dialog = ref.current; return () => dialog?.close(); }, []);
  return <dialog ref={ref} className={`modal ${className}`} onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === event.currentTarget) onClose(); }} aria-labelledby={titleId}><div className="modal-header"><h2 id={titleId}>{title}</h2><button className="icon-button" type="button" onClick={onClose} aria-label="Close dialog"><X size={18} /></button></div>{children}</dialog>;
}
export function downloadText(content: string, filename: string, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
