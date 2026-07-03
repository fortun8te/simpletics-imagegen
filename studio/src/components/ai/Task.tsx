// Task — ported from ai-sdk-elements. A collapsible task with a titled trigger and a list of
// items (each optionally citing a file). Composable:
//   <Task> · TaskTrigger{title} · TaskContent > TaskItem > TaskItemFile.
// Built on our local Collapsible + Icon + tokens. Also drives the Layers tree treatment in the
// image editor (indentation + per-type icons come from the caller).
import { type ReactNode, type HTMLAttributes } from 'react';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from './Collapsible';
import { Icon } from '../Icon';
import styles from './Task.module.css';

export interface TaskProps {
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
  children: ReactNode;
}
export function Task({ defaultOpen = true, className, children, ...rest }: TaskProps) {
  return (
    <Collapsible className={className ? `${styles.task} ${className}` : styles.task} defaultOpen={defaultOpen} {...rest}>
      {children}
    </Collapsible>
  );
}

export interface TaskTriggerProps {
  /** The title shown in the trigger. */
  title: ReactNode;
  /** Optional leading icon name (our Icon set). */
  icon?: string;
  className?: string;
}
export function TaskTrigger({ title, icon, className }: TaskTriggerProps) {
  return (
    <CollapsibleTrigger className={className ? `${styles.trigger} ${className}` : styles.trigger}>
      <span className={styles.chev} aria-hidden><Icon name="chevron-right" size={11} /></span>
      {icon ? <span className={styles.triggerIcon}><Icon name={icon} size={12} /></span> : null}
      <span className={styles.title}>{title}</span>
    </CollapsibleTrigger>
  );
}

export function TaskContent({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <CollapsibleContent className={className ? `${styles.content} ${className}` : styles.content}>
      {children}
    </CollapsibleContent>
  );
}

export interface TaskItemProps extends HTMLAttributes<HTMLDivElement> { children: ReactNode }
export function TaskItem({ children, className, ...rest }: TaskItemProps) {
  return <div className={className ? `${styles.item} ${className}` : styles.item} {...rest}>{children}</div>;
}

export interface TaskItemFileProps extends HTMLAttributes<HTMLSpanElement> {
  children: ReactNode;
  /** Optional file-type icon name (our Icon set); defaults to a generic file glyph. */
  icon?: string;
}
export function TaskItemFile({ children, icon = 'file-text', className, ...rest }: TaskItemFileProps) {
  return (
    <span className={className ? `${styles.file} ${className}` : styles.file} {...rest}>
      <Icon name={icon} size={11} />
      <span className={styles.fileName}>{children}</span>
    </span>
  );
}
