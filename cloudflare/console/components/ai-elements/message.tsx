/** Adapted from Vercel AI Elements, Apache-2.0. See README.md and LICENSE. */
import type { HTMLAttributes } from 'react';
export type MessageProps = HTMLAttributes<HTMLDivElement> & { from: 'user' | 'assistant' | 'system' | 'tool' };
export const Message = ({ className = '', from, ...props }: MessageProps) => (
  <div className={`message ${from === 'user' ? 'is-user' : 'is-assistant'} ${className}`} {...props} />
);
export type MessageContentProps = HTMLAttributes<HTMLDivElement>;
export const MessageContent = ({ children, className = '', ...props }: MessageContentProps) => (
  <div className={`message-content ${className}`} {...props}>{children}</div>
);
