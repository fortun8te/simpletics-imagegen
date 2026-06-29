// Small role-colored status pill. Color = meaning (see design language):
// done=neutral, generating/running=accent, queued=muted, failed=err, archived=dim.
import type { SlotStatus, JobStatus } from '../types';
import styles from './StatusPill.module.css';

type Status = SlotStatus | JobStatus;

// Sentence-case labels.
const LABELS: Record<Status, string> = {
  empty: 'Empty',
  queued: 'Queued',
  generating: 'Generating',
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
  archived: 'Archived',
  canceled: 'Canceled',
};

export function StatusPill({ status }: { status: Status }) {
  const label = LABELS[status] ?? status;
  return (
    <span className={`${styles.pill} ${styles[status] ?? ''}`}>
      <span className={styles.dot} aria-hidden="true" />
      {label}
    </span>
  );
}
