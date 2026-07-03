// ChainOfThought — ported from ai-sdk-elements. A collapsible reasoning-step list:
//   <ChainOfThought> · Header (trigger) · Content > Step{icon,label,description,status}.
// Re-implemented on our local Collapsible + our Icon component + theme tokens (no lucide).
// A vertical rail threads the steps; status drives the node marker (complete/active/pending).
import { type ReactNode } from 'react';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from './Collapsible';
import { Icon } from '../Icon';
import styles from './ChainOfThought.module.css';

export interface ChainOfThoughtProps {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
  children: ReactNode;
}
export function ChainOfThought({ className, children, ...rest }: ChainOfThoughtProps) {
  return (
    <Collapsible className={className ? `${styles.root} ${className}` : styles.root} {...rest}>
      {children}
    </Collapsible>
  );
}

export function ChainOfThoughtHeader({ children = 'Chain of Thought' }: { children?: ReactNode }) {
  return (
    <CollapsibleTrigger className={styles.header}>
      <span className={styles.chev} aria-hidden><Icon name="chevron-right" size={11} /></span>
      <span className={styles.headerText}>{children}</span>
    </CollapsibleTrigger>
  );
}

export type ChainStepStatus = 'complete' | 'active' | 'pending';
export interface ChainOfThoughtStepProps {
  /** Icon name from our Icon set (elements passes a LucideIcon; we take a string name). */
  icon?: string;
  label: ReactNode;
  description?: ReactNode;
  status?: ChainStepStatus;
}
export function ChainOfThoughtStep({ icon, label, description, status = 'complete' }: ChainOfThoughtStepProps) {
  return (
    <div className={styles.step} data-status={status}>
      <span className={styles.rail} aria-hidden>
        <span className={styles.node}>
          {status === 'complete'
            ? <Icon name="check" size={9} />
            : icon
              ? <Icon name={icon} size={10} />
              : <span className={styles.dot} />}
        </span>
      </span>
      <span className={styles.stepBody}>
        <span className={styles.stepLabel}>{label}</span>
        {description ? <span className={styles.stepDesc}>{description}</span> : null}
      </span>
    </div>
  );
}

export function ChainOfThoughtContent({ children }: { children: ReactNode }) {
  return <CollapsibleContent className={styles.content}>{children}</CollapsibleContent>;
}
