/** Adapted from Vercel AI Elements, Apache-2.0. See README.md and LICENSE. */
import { ArrowDownIcon } from 'lucide-react';
import type { ComponentProps } from 'react';
import { useCallback, useEffect } from 'react';
import { StickToBottom, useStickToBottomContext } from 'use-stick-to-bottom';

export type ConversationProps = ComponentProps<typeof StickToBottom>;
export const Conversation = ({ className = '', ...props }: ConversationProps) => (
  <StickToBottom className={`conversation ${className}`} initial="instant" resize="smooth" role="log" {...props} />
);
export type ConversationContentProps = ComponentProps<typeof StickToBottom.Content>;
export const ConversationContent = ({ className = '', scrollClassName = '', ...props }: ConversationContentProps) => {
  const { scrollRef, scrollToBottom, state } = useStickToBottomContext();
  useEffect(() => {
    const viewport = scrollRef.current;
    if (!viewport) return;
    let previousHeight = viewport.clientHeight;
    let resetFrame = 0;
    let resetTimer = 0;
    // Treat viewport resizing like content resizing so browser scroll clamping
    // isn't mistaken for the user scrolling upward to read earlier messages.
    const observer = new ResizeObserver(() => {
      const height = viewport.clientHeight;
      const difference = height - previousHeight;
      previousHeight = height;
      if (!difference) return;
      state.resizeDifference = difference;
      void scrollToBottom({ wait: true, preserveScrollPosition: true });
      cancelAnimationFrame(resetFrame);
      clearTimeout(resetTimer);
      resetFrame = requestAnimationFrame(() => {
        resetTimer = window.setTimeout(() => {
          if (state.resizeDifference === difference) state.resizeDifference = 0;
        }, 1);
      });
    });
    observer.observe(viewport);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(resetFrame);
      clearTimeout(resetTimer);
    };
  }, [scrollRef, scrollToBottom, state]);
  return <StickToBottom.Content className={`conversation-content ${className}`} scrollClassName={`conversation-scroll ${scrollClassName}`} {...props} />;
};
export const ConversationScrollButton = ({ className = '', ...props }: ComponentProps<'button'>) => {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();
  const handleScrollToBottom = useCallback(() => { void scrollToBottom(); }, [scrollToBottom]);
  return !isAtBottom && <button className={`scroll-bottom icon-button ${className}`} onClick={handleScrollToBottom} type="button" aria-label="Scroll to latest message" {...props}><ArrowDownIcon size={17} /></button>;
};
