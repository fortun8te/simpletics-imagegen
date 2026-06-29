// ActivityDock — floating bottom-right panel showing live job activity (CONTAINER).
// Reads `state` from the store, derives in-flight / queued / failed jobs from every
// slot whose `job` is set, and offers cancel (queued/running) + retry (failed).
// Hidden entirely when there is nothing active, queued, or failed. Collapsible.
import { useEffect, useState } from 'react';
import type { BatchState, Slot } from '../types';
import { useStore } from '../store';
import { api } from '../api';
import { Icon } from './Icon';
import { Spinner } from './Spinner';
import styles from './ActivityDock.module.css';

// One derived row per slot-with-a-job. Carries the coords + relPath needed to act.
interface DockJob {
  key: string;
  jobId?: string;
  ad: string;
  variation: string;
  relPath?: string;
  status: Slot['status'];          // 'generating' | 'queued' | 'failed' (and 'done' for recent)
  error?: string | null;
  startedAt?: number | null;
}

// Most-relevant-first ordering: generating, then queued, then failed, then recent done.
const ORDER: Record<string, number> = { generating: 0, queued: 1, failed: 2, done: 3 };

// Walk the batch tree and collect every slot that has a `job` in an interesting state.
function deriveJobs(state: BatchState | null): DockJob[] {
  if (!state) return [];
  const jobs: DockJob[] = [];
  for (const ad of state.ads) {
    for (const variation of ad.variations) {
      for (const prompt of variation.prompts) {
        for (const slot of prompt.slots) {
          if (!slot.job) continue;
          if (
            slot.status !== 'generating' &&
            slot.status !== 'queued' &&
            slot.status !== 'failed'
          ) {
            continue;
          }
          jobs.push({
            key: `${ad.id}/${variation.id}/${prompt.id}/${slot.run}/${slot.version ?? 1}`,
            jobId: slot.job.id,
            ad: ad.title || ad.id,
            variation: variation.label || variation.id,
            relPath: slot.relPath,
            status: slot.status,
            error: slot.job.error,
            startedAt: slot.job.startedAt,
          });
        }
      }
    }
  }
  jobs.sort((a, b) => (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9));
  return jobs;
}

// "3:07" mm:ss elapsed from a start timestamp, ticking once a second while mounted.
function useElapsed(startedAt?: number | null): string | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!startedAt) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [startedAt]);
  if (!startedAt) return null;
  const total = Math.max(0, Math.floor((now - startedAt) / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function JobRow({ job }: { job: DockJob }) {
  const elapsed = useElapsed(job.status === 'generating' ? job.startedAt : undefined);

  let icon: JSX.Element;
  let statusText: string;
  if (job.status === 'generating') {
    icon = <Spinner size={15} />;
    statusText = elapsed ? `Generating · ${elapsed}` : 'Generating';
  } else if (job.status === 'queued') {
    icon = <Icon name="clock" size={15} className={styles.iconQueued} />;
    statusText = 'Queued';
  } else {
    icon = <Icon name="alert" size={15} className={styles.iconFailed} />;
    statusText = job.error || 'Failed';
  }

  return (
    <li className={styles.row}>
      <span className={styles.rowIcon}>{icon}</span>
      <span className={styles.rowBody}>
        <span className={styles.coords} title={`${job.ad} / ${job.variation}`}>
          {job.ad} / {job.variation}
        </span>
        <span
          className={`${styles.status} ${job.status === 'failed' ? styles.statusFailed : ''}`}
          title={statusText}
        >
          {statusText}
        </span>
      </span>

      {job.status === 'failed'
        ? job.relPath && (
            <button
              className={`${styles.action} ${styles.retry}`}
              aria-label="Retry"
              onClick={() => job.relPath && api.regenerate(job.relPath)}
            >
              <Icon name="refresh" size={15} />
            </button>
          )
        : job.jobId && (
            <button
              className={styles.action}
              aria-label="Cancel"
              onClick={() => job.jobId && api.cancel({ jobId: job.jobId })}
            >
              <Icon name="x" size={15} />
            </button>
          )}
    </li>
  );
}

export default function ActivityDock() {
  const state = useStore((s) => s.state);
  const [collapsed, setCollapsed] = useState(false);

  const jobs = deriveJobs(state);

  // Idle → render nothing at all.
  if (jobs.length === 0) return null;

  const queue = state?.queue ?? { running: 0, queued: 0, done: 0, failed: 0 };

  return (
    <section className={`${styles.dock} ${collapsed ? styles.collapsed : ''}`} aria-label="Activity">
      <button
        className={styles.header}
        aria-expanded={!collapsed}
        onClick={() => setCollapsed((c) => !c)}
      >
        <Icon name="activity" size={16} className={styles.headIcon} />
        <span className={styles.titleWrap}>
          <span className={styles.title}>Activity</span>
          <span className={styles.counts}>
            {queue.running} running · {queue.queued} queued
          </span>
        </span>
        <Icon
          name={collapsed ? 'chevron-right' : 'chevron-down'}
          size={16}
          className={styles.chevron}
        />
      </button>

      {!collapsed && (
        <ul className={styles.list} aria-live="polite">
          {jobs.map((job) => (
            <JobRow key={job.key} job={job} />
          ))}
        </ul>
      )}
    </section>
  );
}
