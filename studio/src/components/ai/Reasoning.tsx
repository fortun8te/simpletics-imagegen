// Reasoning — ported from ai-sdk-elements. A collapsible reasoning-text block that auto-opens
// while streaming and closes when finished. Composable: <Reasoning> · Trigger · Content.
// Re-implemented on our local Collapsible + Icon + tokens (no Streamdown/lucide). Content is
// plain text (whitespace preserved). Exposes useReasoning() for custom trigger labels.
import {
  createContext, useContext, useEffect, useRef, useState,
  type ReactNode,
} from 'react';
import { Collapsible, CollapsibleTrigger, CollapsibleContent, useCollapsible } from './Collapsible';
import { Icon } from '../Icon';
import { Shimmer } from './Shimmer';
import styles from './Reasoning.module.css';

interface ReasoningCtx { isStreaming: boolean; duration?: number }
const Ctx = createContext<ReasoningCtx>({ isStreaming: false });

export interface ReasoningProps {
  isStreaming?: boolean;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Elapsed reasoning duration in seconds (externally controlled). */
  duration?: number;
  className?: string;
  children: ReactNode;
}
export function Reasoning({
  isStreaming = false, open, defaultOpen = true, onOpenChange, duration, className, children,
}: ReasoningProps) {
  return (
    <Ctx.Provider value={{ isStreaming, duration }}>
      <Collapsible
        className={className ? `${styles.root} ${className}` : styles.root}
        open={open}
        defaultOpen={defaultOpen}
        onOpenChange={onOpenChange}
      >
        <AutoStream isStreaming={isStreaming} controlled={open !== undefined}>{children}</AutoStream>
      </Collapsible>
    </Ctx.Provider>
  );
}

// Auto-open on stream start, auto-close on stream end (uncontrolled only), matching the elements
// behavior. Lives inside Collapsible so it can call setOpen via context.
function AutoStream({ isStreaming, controlled, children }: { isStreaming: boolean; controlled: boolean; children: ReactNode }) {
  const { setOpen } = useCollapsible();
  const wasStreaming = useRef(isStreaming);
  useEffect(() => {
    if (controlled) return;
    if (isStreaming && !wasStreaming.current) setOpen(true);
    if (!isStreaming && wasStreaming.current) setOpen(false);
    wasStreaming.current = isStreaming;
  }, [isStreaming, controlled, setOpen]);
  return <>{children}</>;
}

export const useReasoning = () => {
  const { isStreaming, duration } = useContext(Ctx);
  const { open, setOpen } = useCollapsible();
  return { isStreaming, isOpen: open, setIsOpen: setOpen, duration };
};

export interface ReasoningTriggerProps {
  getThinkingMessage?: (isStreaming: boolean, duration?: number) => ReactNode;
  children?: ReactNode;
}
function defaultMessage(isStreaming: boolean, duration?: number): ReactNode {
  if (isStreaming) return 'Thinking…';
  if (duration != null) return `Thought for ${duration}s`;
  return 'Reasoning';
}
export function ReasoningTrigger({ getThinkingMessage = defaultMessage, children }: ReasoningTriggerProps) {
  const { isStreaming, duration } = useContext(Ctx);
  const label = children ?? getThinkingMessage(isStreaming, duration);
  return (
    <CollapsibleTrigger className={styles.trigger}>
      <span className={styles.chev} aria-hidden><Icon name="chevron-right" size={11} /></span>
      {isStreaming
        ? <Shimmer className={styles.label} duration={2.2}>{label as ReactNode}</Shimmer>
        : <span className={styles.label}>{label}</span>}
    </CollapsibleTrigger>
  );
}

export function ReasoningContent({ children }: { children: ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return (
    <CollapsibleContent className={styles.content}>
      <div className={styles.text} data-mounted={mounted || undefined}>{children}</div>
    </CollapsibleContent>
  );
}
