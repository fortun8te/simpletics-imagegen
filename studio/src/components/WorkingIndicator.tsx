// WorkingIndicator — canonical live-work UI for **image generation** (Codex / queue).
// Pulsing accent dot + label. Do not use in Design mode agents (separate redesign).
// See studio/docs/WORKING-INDICATOR.md
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import styles from './WorkingIndicator.module.css';

export type WorkingTone = 'active' | 'waiting' | 'queued' | 'paused' | 'failed';

const TONE_CLASS: Record<WorkingTone, string> = {
  active: styles.dotActive,
  waiting: styles.dotWaiting,
  queued: styles.dotQueued,
  paused: styles.dotPaused,
  failed: styles.dotFailed,
};

export function WorkingDot({ tone = 'active', className }: { tone?: WorkingTone; className?: string }) {
  return (
    <span
      className={[styles.dot, TONE_CLASS[tone], className].filter(Boolean).join(' ')}
      aria-hidden="true"
    />
  );
}

/** Dot + label (+ optional meta like ETA or elapsed). */
export function WorkingIndicator({
  label,
  meta,
  tone = 'active',
  muted,
  className,
}: {
  label: string;
  meta?: string;
  tone?: WorkingTone;
  muted?: boolean;
  className?: string;
}) {
  return (
    <span
      className={[styles.row, muted ? styles.rowMuted : '', className].filter(Boolean).join(' ')}
      role="status"
    >
      <WorkingDot tone={tone} />
      <span
        className={[styles.label, tone === 'active' ? styles.labelShimmer : ''].filter(Boolean).join(' ')}
        title={label}
      >
        {label}
      </span>
      {meta ? <span className={styles.meta}>{meta}</span> : null}
    </span>
  );
}

/** Glass pill shell — pass children (usually WorkingIndicator contents). */
export function WorkingPill({
  children,
  className,
  ...rest
}: {
  children: ReactNode;
  className?: string;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" className={[styles.pill, className].filter(Boolean).join(' ')} {...rest}>
      {children}
    </button>
  );
}
