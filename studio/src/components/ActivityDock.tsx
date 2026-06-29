// ActivityPanel (file kept as ActivityDock so AppShell's import is unchanged) —
// a calm, premium bottom-right card surfacing the live run. CONTAINER component.
//
// Opens when `ui.activityOpen` is true OR when any job exists; the close control
// sets `ui.activityOpen:false` (and the card then hides if there are also no jobs).
//
// Header  → the run-state label + a progress bar (run.done/total) + an echo of the
//           run controls (Pause / Continue / Stop via api.pause/resume/cancel).
// Body    → job rows derived from every slot whose `job` is set, GROUPED by status
//           (Running / Queued / Failed). Each row carries an in-progress spinner or a
//           status icon, the `ad / variation` label, elapsed, and a cancel (running/
//           queued) or retry (failed) action.
// When pinned-open and idle, a quiet "No active generations" line shows instead.
import { useEffect, useState } from 'react';
import type { BatchState, RunState, Slot } from '../types';
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
  status: Slot['status']; // narrowed to 'generating' | 'queued' | 'failed' below
  error?: string | null;
  startedAt?: number | null;
}

type GroupKey = 'generating' | 'queued' | 'failed';

// Human label per run state, plus the dot tone class it maps to.
const RUN_LABEL: Record<RunState, string> = {
  idle: 'Idle',
  running: 'Running',
  paused: 'Paused',
  cooling: 'Cooling down',
  done: 'Done',
};

// Group ordering + labels (most relevant first).
const GROUPS: { key: GroupKey; label: string }[] = [
  { key: 'generating', label: 'Running' },
  { key: 'queued', label: 'Queued' },
  { key: 'failed', label: 'Failed' },
];

// Walk the batch tree and collect every slot that has a `job` in an active state.
function deriveJobs(state: BatchState | null): DockJob[] {
  if (!state) return [];
  const jobs: DockJob[] = [];
  for (const ad of state.ads) {
    for (const variation of ad.variations) {
      for (const prompt of variation.prompts) {
        for (const slot of prompt.slots) {
          if (!slot.job) continue;
          if (slot.status !== 'generating' && slot.status !== 'queued' && slot.status !== 'failed') {
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

// "m:ss" countdown until a cooling run auto-resumes; null once elapsed.
function useCountdown(resumeAt?: number | null): string | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!resumeAt) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [resumeAt]);
  if (!resumeAt) return null;
  const total = Math.max(0, Math.floor((resumeAt - now) / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function JobRow({ job }: { job: DockJob }) {
  const elapsed = useElapsed(job.status === 'generating' ? job.startedAt : undefined);

  let media: JSX.Element;
  let meta: string;
  if (job.status === 'generating') {
    media = (
      <span className={`${styles.media} ${styles.mediaActive}`}>
        <Spinner size={15} />
      </span>
    );
    meta = elapsed ? `Generating · ${elapsed}` : 'Generating';
  } else if (job.status === 'queued') {
    media = (
      <span className={styles.media}>
        <Icon name="clock" size={15} className={styles.iconQueued} />
      </span>
    );
    meta = 'Waiting in queue';
  } else {
    media = (
      <span className={`${styles.media} ${styles.mediaFailed}`}>
        <Icon name="alert" size={15} className={styles.iconFailed} />
      </span>
    );
    meta = job.error || 'Generation failed';
  }

  return (
    <li className={styles.row}>
      {media}
      <span className={styles.rowBody}>
        <span className={styles.coords} title={`${job.ad} / ${job.variation}`}>
          {job.ad} <span className={styles.sep}>/</span> {job.variation}
        </span>
        <span
          className={`${styles.meta} ${job.status === 'failed' ? styles.metaFailed : ''}`}
          title={meta}
        >
          {meta}
        </span>
      </span>

      {job.status === 'failed'
        ? job.relPath && (
            <button
              className={`${styles.action} ${styles.retry}`}
              aria-label="Retry generation"
              title="Retry"
              onClick={() => job.relPath && api.regenerate(job.relPath)}
            >
              <Icon name="refresh" size={15} />
            </button>
          )
        : job.jobId && (
            <button
              className={styles.action}
              aria-label="Cancel generation"
              title="Cancel"
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
  const activityOpen = useStore((s) => s.ui.activityOpen);
  const setUI = useStore((s) => s.setUI);

  const jobs = deriveJobs(state);

  const run = state?.run ?? {
    state: 'idle' as RunState,
    running: 0,
    queued: 0,
    done: 0,
    failed: 0,
    total: 0,
    resumeAt: null,
  };
  const countdown = useCountdown(run.state === 'cooling' ? run.resumeAt : undefined);

  // Discoverable: render when there are jobs OR when pinned open via the store.
  // Idle and not pinned → nothing.
  if (jobs.length === 0 && !activityOpen) return null;

  const pct = run.total > 0 ? Math.round((run.done / run.total) * 100) : 0;

  // Run controls echo — only the action(s) that make sense for the current state.
  const showPause = run.state === 'running';
  const showContinue = run.state === 'paused';
  const showStop = run.state === 'running' || run.state === 'paused' || run.state === 'cooling';

  const groups = GROUPS.map((g) => ({
    ...g,
    rows: jobs.filter((j) => j.status === g.key),
  })).filter((g) => g.rows.length > 0);

  return (
    <section className={styles.panel} aria-label="Activity">
      <header className={styles.header}>
        <div className={styles.headTop}>
          <span className={`${styles.statusChip} ${styles[`s_${run.state}`]}`}>
            <span className={styles.dot} aria-hidden="true" />
            <span className={styles.runLabel}>
              {RUN_LABEL[run.state]}
              {run.state === 'cooling' && countdown ? ` · ${countdown}` : ''}
            </span>
          </span>

          {run.total > 0 && (
            <span className={styles.tally}>
              {run.done}/{run.total}
            </span>
          )}

          <div className={styles.controls}>
            {showPause && (
              <button className={styles.ctl} aria-label="Pause run" title="Pause" onClick={() => api.pause()}>
                <Icon name="columns" size={15} />
              </button>
            )}
            {showContinue && (
              <button
                className={`${styles.ctl} ${styles.ctlAccent}`}
                aria-label="Continue run"
                title="Continue"
                onClick={() => api.resume()}
              >
                <Icon name="chevron-right" size={15} />
              </button>
            )}
            {showStop && (
              <button
                className={styles.ctl}
                aria-label="Stop run"
                title="Stop"
                onClick={() => api.cancel({ all: true })}
              >
                <Icon name="stop" size={15} />
              </button>
            )}
            <button
              className={styles.close}
              aria-label="Dismiss activity"
              title="Close"
              onClick={() => setUI({ activityOpen: false })}
            >
              <Icon name="x" size={15} />
            </button>
          </div>
        </div>

        <div className={styles.track} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <span className={styles.fill} style={{ width: `${pct}%` }} />
        </div>
      </header>

      <div className={styles.body} aria-live="polite">
        {groups.length > 0 ? (
          groups.map((g) => (
            <section key={g.key} className={styles.group}>
              <p className={`eyebrow ${styles.groupLabel}`}>
                {g.label}
                <span className={styles.groupCount}>{g.rows.length}</span>
              </p>
              <ul className={styles.list}>
                {g.rows.map((job) => (
                  <JobRow key={job.key} job={job} />
                ))}
              </ul>
            </section>
          ))
        ) : (
          <p className={styles.empty}>No active generations</p>
        )}
      </div>
    </section>
  );
}
