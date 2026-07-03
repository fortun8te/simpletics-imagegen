// Small role-colored status pill. Color = meaning (see design language):
// done=neutral, generating/running=accent, queued=muted, failed=err, archived=dim.
import type { SlotStatus, JobStatus } from '../types';
import styles from './StatusPill.module.css';

type Status = SlotStatus | JobStatus;

// Sentence-case labels.
const LABELS: Record<Status, string> = {
  empty: 'Empty',
  queued: 'Queued',
  waiting: 'Starting',
  generating: 'Generating',
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
  archived: 'Archived',
  canceled: 'Canceled',
};

/** In-progress states pulse their dot; terminal states are static (motion = in-progress). */
const LIVE: Set<Status> = new Set(['waiting', 'generating', 'running']);

export function StatusPill({ status }: { status: Status }) {
  const label = LABELS[status] ?? status;
  return (
    <span className={`${styles.pill} ${styles[status] ?? ''}`} title={label}>
      <span className={`${styles.dot} ${LIVE.has(status) ? styles.dotLive : ''}`} aria-hidden="true" />
      <span className={styles.label}>{label}</span>
    </span>
  );
}
