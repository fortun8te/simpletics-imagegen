// ActivityDock — a quiet Linear/Raycast-style command-palette panel surfacing the
// live run. CONTAINER component. Owns only this file + its CSS module.
//
// States:
//   • ui.activityOpen === true            → full floating glass panel.
//   • ui.activityOpen === false && jobs   → a small collapsed pill (click to expand).
//   • ui.activityOpen === false && !jobs  → nothing.
//
// Header  → "Activity" title + a count badge ("3 running" / "2 queued" / "1 failed")
//           + a close (x) control. Thin divider below.
// Body    → scrollable list of job rows grouped under small-caps RUNNING / QUEUED /
//           FAILED eyebrows with counts + thin dividers. Each row: a status dot
//           (blue=running, muted=queued, red=failed) + an ad/variation/prompt label
//           + elapsed (mono, right) + quiet hover icon actions.
//             – running row : stop (per-job cancel)
//             – queued row  : stop (per-job cancel)
//             – failed row  : retry (regenerate)
//           Run-level controls (pause/continue + stop-all) live on the RUNNING eyebrow
//           so they read honestly as run-scoped, never per-row.
// Empty   → a quiet "No active jobs" line when pinned open and idle.
//
// All actions map onto the existing api: pause / resume / cancel({ jobId }) /
// cancel({ all: true }) / regenerate(relPath). useElapsed ticks once a second.
// Reduced motion is honored via theme.css global rules + a local guard on the dot.
import { useEffect, useState } from 'react';
import type { BatchState } from '../types';
import { useStore } from '../store';
import { api } from '../api';
import { Icon } from './Icon';
import styles from './ActivityDock.module.css';

// One derived row per slot-with-a-job. Carries the coords + relPath needed to act.
interface DockJob {
  key: string;
  jobId?: string;
  ad: string;
  variation: string;
  prompt: string;
  relPath?: string;
  status: GroupKey;
  error?: string | null;
  startedAt?: number | null;
}

type GroupKey = 'generating' | 'queued' | 'failed';

// Group ordering + small-caps eyebrow labels (most relevant first).
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
            prompt: prompt.id,
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

function StatusDot({ status }: { status: GroupKey }) {
  return <span className={`${styles.dot} ${styles[`d_${status}`]}`} aria-hidden="true" />;
}

function JobRow({ job }: { job: DockJob }) {
  const elapsed = useElapsed(job.status === 'generating' ? job.startedAt : undefined);

  const path = `${job.ad} / ${job.variation} / ${job.prompt}`;
  const title = job.status === 'failed' && job.error ? `${path} — ${job.error}` : path;

  return (
    <li className={styles.row}>
      <StatusDot status={job.status} />

      <span className={styles.label} title={title}>
        <span className={styles.seg}>{job.ad}</span>
        <span className={styles.sep}>/</span>
        <span className={styles.segMute}>{job.variation}</span>
        <span className={styles.sep}>/</span>
        <span className={styles.segFaint}>{job.prompt}</span>
      </span>

      {job.status === 'generating' && elapsed && <span className={styles.elapsed}>{elapsed}</span>}

      <span className={styles.actions}>
        {job.status === 'failed'
          ? job.relPath && (
              <button
                className={styles.act}
                aria-label="Retry generation"
                title="Retry"
                onClick={() => job.relPath && api.regenerate(job.relPath)}
              >
                <Icon name="refresh" size={13} />
              </button>
            )
          : job.jobId && (
              <button
                className={styles.act}
                aria-label="Cancel generation"
                title="Stop"
                onClick={() => job.jobId && api.cancel({ jobId: job.jobId })}
              >
                <Icon name="x" size={13} />
              </button>
            )}
      </span>
    </li>
  );
}

export default function ActivityDock() {
  const state = useStore((s) => s.state);
  const activityOpen = useStore((s) => s.ui.activityOpen);
  const setUI = useStore((s) => s.setUI);

  const jobs = deriveJobs(state);
  const run = state?.run;
  const isPaused = run?.state === 'paused' || run?.state === 'cooling';

  const running = jobs.filter((j) => j.status === 'generating').length;
  const queued = jobs.filter((j) => j.status === 'queued').length;
  const failed = jobs.filter((j) => j.status === 'failed').length;

  // Closed and nothing happening → nothing to render.
  if (!activityOpen && jobs.length === 0) return null;

  // Closed but jobs exist → a small pill that expands the panel.
  if (!activityOpen) {
    const pillLabel =
      running > 0 ? `${running} running` : queued > 0 ? `${queued} queued` : `${failed} failed`;
    return (
      <button
        className={styles.pill}
        aria-label={`Open activity — ${pillLabel}`}
        title="Open activity"
        onClick={() => setUI({ activityOpen: true })}
      >
        <StatusDot status={running > 0 ? 'generating' : queued > 0 ? 'queued' : 'failed'} />
        <span className={styles.pillText}>{pillLabel}</span>
        <Icon name="chevron-down" size={13} className={styles.pillChev} />
      </button>
    );
  }

  // Expanded panel.
  const groups = GROUPS.map((g) => ({
    ...g,
    rows: jobs.filter((j) => j.status === g.key),
  })).filter((g) => g.rows.length > 0);

  const badge =
    running > 0 ? `${running} running` : queued > 0 ? `${queued} queued` : failed > 0 ? `${failed} failed` : '';

  return (
    <section className={styles.panel} aria-label="Activity">
      <header className={styles.header}>
        <h2 className={styles.title}>Activity</h2>
        {badge && <span className={styles.badge}>{badge}</span>}
        <button
          className={styles.close}
          aria-label="Collapse activity"
          title="Close"
          onClick={() => setUI({ activityOpen: false })}
        >
          <Icon name="x" size={14} />
        </button>
      </header>

      <div className={styles.body} aria-live="polite">
        {groups.length > 0 ? (
          groups.map((g) => (
            <section key={g.key} className={styles.group}>
              <div className={styles.groupLabel}>
                <span className={styles.groupName}>{g.label}</span>
                <span className={styles.groupCount}>{g.rows.length}</span>

                {g.key === 'generating' && (
                  <span className={styles.groupActs}>
                    <button
                      className={styles.groupAct}
                      aria-label={isPaused ? 'Continue run' : 'Pause run'}
                      title={isPaused ? 'Continue' : 'Pause'}
                      onClick={() => (isPaused ? api.resume() : api.pause())}
                    >
                      <Icon name={isPaused ? 'chevron-right' : 'pause'} size={12} />
                    </button>
                    <button
                      className={styles.groupAct}
                      aria-label="Stop all"
                      title="Stop all"
                      onClick={() => api.cancel({ all: true })}
                    >
                      <Icon name="stop" size={12} />
                    </button>
                  </span>
                )}
              </div>

              <ul className={styles.list}>
                {g.rows.map((job) => (
                  <JobRow key={job.key} job={job} />
                ))}
              </ul>
            </section>
          ))
        ) : (
          <p className={styles.empty}>No active jobs</p>
        )}
      </div>
    </section>
  );
}
