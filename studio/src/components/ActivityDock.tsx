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
//             – queued row  : stop (per-job cancel), drag handle (reorder priority)
//             – failed row  : retry (regenerate)
//           Run-level controls (pause/continue + stop-all) live on the RUNNING eyebrow
//           so they read honestly as run-scoped, never per-row.
// Empty   → a quiet "No active jobs" line when pinned open and idle.
//
// QUEUED reorder (native HTML5 drag-and-drop; no DnD library installed/needed): only queued rows are
// `draggable` — running/done/failed rows never are, since priority only means anything before a job
// starts. Dropping reorders the local `queued` list immediately (optimistic — the panel never waits
// on the network to reflect the drop), then POSTs the full new queued-id order for this brand/batch to
// /api/queue/reorder, which rewrites each job's `order` so the worker's actual picker (jobstore.mjs
// nextQueued()) honors it. The next SSE `state` push / poll reconciles with the server's truth.
//
// All actions map onto the existing api: pause / resume / cancel({ jobId }) /
// cancel({ all: true }) / regenerate(relPath) / reorderQueue(brand, batch, jobIds).
// useElapsed ticks once a second. Reduced motion is honored via theme.css global rules + a local
// guard on the dot.
import { useEffect, useMemo, useState, type DragEvent } from 'react';
import type { BatchState } from '../types';
import { useStore, type AgentEvent } from '../store';
import { api } from '../api';
import { refreshState } from '../refresh';
import { Icon } from './Icon';
import { WorkingDot } from './WorkingIndicator';
import styles from './ActivityDock.module.css';

// One derived row per slot-with-a-job. Carries the coords + relPath needed to act.
interface DockJob {
  key: string;
  jobId?: string;
  ad: string;
  variation: string;
  prompt: string;
  // Raw ids (as opposed to `ad`/`variation`'s display label/title) — needed to build a
  // GenerateScope for the no-relPath retry fallback below, same shape SlotCard's genHere() uses.
  adId: string;
  variationId: string;
  relPath?: string;
  status: GroupKey;
  error?: string | null;
  startedAt?: number | null;
  spendAt?: number | null;
  order?: number | null;
}

type GroupKey = 'generating' | 'waiting' | 'queued' | 'failed';

// Group ordering + small-caps eyebrow labels (most relevant first).
const GROUPS: { key: GroupKey; label: string }[] = [
  { key: 'waiting', label: 'Starting' },
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
          if (slot.status !== 'generating' && slot.status !== 'waiting' && slot.status !== 'queued' && slot.status !== 'failed') {
            continue;
          }
          jobs.push({
            key: `${ad.id}/${variation.id}/${prompt.id}/${slot.run}/${slot.version ?? 1}`,
            jobId: slot.job.id,
            ad: ad.title || ad.id,
            variation: variation.label || variation.id,
            prompt: prompt.id,
            adId: ad.id,
            variationId: variation.id,
            relPath: slot.relPath,
            status: slot.status,
            error: slot.job.error,
            startedAt: slot.job.startedAt,
            spendAt: slot.job.spendAt,
            order: slot.job.order,
          });
        }
      }
    }
  }
  return jobs;
}

// ── design LOOP (vision reading / refining) ──────────────────────────────────────────────────
// The Design-mode loop streams over the SSE `design` channel (store.ui.designEvents), NOT the
// batch `state` tree. It reads a reference on a FAST PATH — usually ONE ~60s vision pass, with an
// occasional corrective 2nd pass — emitting granular progress ("merged 4 duplicate regions → 6
// unique"). We surface the LATEST granular message as the live line, not an N/M pass counter.
interface DesignLoop {
  runId: string;
  active: boolean;          // false once a terminal `done`/`error` frame lands
  failed: boolean;
  pass: number;             // current/last attempt (1-based) — quiet metadata only
  totalPasses: number;
  layers: number | null;    // layers extracted so far
  summary: string;          // latest granular step summary (shimmer target while active)
}

// Parse the current design run out of the shared event stream. Returns null when idle.
function deriveDesignLoop(events: AgentEvent[], totalPasses = 2): DesignLoop | null {
  if (!events.length) return null;
  const runId = events[0].runId;
  const last = events[events.length - 1];
  const active = !last.done && !last.error;
  const failed = !!last.error;
  let pass = 1;
  let layers: number | null = null;
  let summary = 'Reading reference…';
  for (const e of events) {
    const s = e.step;
    if (!s) continue;
    if (s.summary) summary = s.summary;
    const data = s.data as { pass?: number; attempt?: number; layers?: number } | undefined;
    if (typeof data?.pass === 'number') pass = Math.max(pass, data.pass);
    if (typeof data?.attempt === 'number') pass = Math.max(pass, data.attempt);
    if (typeof data?.layers === 'number') layers = data.layers;
    const pm = /(?:pass|attempt|retry|try)\s*#?\s*(\d+)/i.exec(s.summary || '');
    if (pm) pass = Math.max(pass, Number(pm[1]));
    const lm = /(\d+)\s*layers?/i.exec(s.summary || '');
    if (lm) layers = Number(lm[1]);
  }
  return { runId, active, failed, pass, totalPasses, layers, summary };
}

// A single row for the live design loop: status dot + the latest granular message as a readable,
// truncating single line (shimmers while active). Any metadata is a quiet inline mono suffix
// (layers, or "failed") — never a boxy pass tag.
function DesignLoopRow({ loop }: { loop: DesignLoop }) {
  const tone: GroupKey = loop.failed ? 'failed' : loop.active ? 'generating' : 'queued';
  const suffix = loop.failed
    ? 'failed'
    : loop.layers != null ? `${loop.layers}L` : null;
  return (
    <li className={styles.row}>
      <StatusDot status={tone} />
      <span className={styles.label} title={loop.summary}>
        <span className={styles.labelLine}>
          <span className={styles.seg} data-shimmer={loop.active || undefined}>{loop.summary}</span>
        </span>
      </span>
      {suffix ? (
        <span className={styles.metaSuffix} data-failed={loop.failed || undefined}>{suffix}</span>
      ) : null}
    </li>
  );
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

// Live seconds-until countdown from a future epoch-ms `spendAt` (waiting window). Ticks once a
// second, floors at 0. Null when no target.
function useCountdown(spendAt?: number | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!spendAt) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [spendAt]);
  if (!spendAt) return null;
  return Math.max(0, Math.ceil((spendAt - now) / 1000));
}

function statusTone(status: GroupKey): 'active' | 'waiting' | 'queued' | 'failed' {
  if (status === 'generating') return 'active';
  if (status === 'waiting') return 'waiting';
  if (status === 'failed') return 'failed';
  return 'queued';
}

function StatusDot({ status }: { status: GroupKey }) {
  return <WorkingDot tone={statusTone(status)} />;
}

function JobRow({
  job,
  draggable,
  dragHandlers,
  dragOver,
  dragging,
  brand,
  batch,
}: {
  job: DockJob;
  draggable?: boolean;
  dragHandlers?: {
    onDragStart: (e: DragEvent) => void;
    onDragOver: (e: DragEvent) => void;
    onDrop: (e: DragEvent) => void;
    onDragEnd: (e: DragEvent) => void;
  };
  dragOver?: boolean;
  dragging?: boolean;
  brand?: string | null;
  batch?: string | null;
}) {
  const elapsed = useElapsed(job.status === 'generating' ? job.startedAt : undefined);
  const secsLeft = useCountdown(job.status === 'waiting' ? job.spendAt : undefined);

  // Retry a failed job. Most failures are re-runs of an existing slot (has relPath — regenerate
  // in place). A job that failed on its very first attempt has no relPath yet; fall back to
  // queuing a fresh single-variant generate for that exact prompt, same as SlotCard's genHere(1).
  const retry = () => {
    if (job.relPath) { api.regenerate(job.relPath); return; }
    if (brand && batch) {
      api.generate(brand, batch, { prompt: { ad: job.adId, variation: job.variationId, prompt: job.prompt } }, 1);
    }
  };

  const path = `${job.ad} / ${job.variation} / ${job.prompt}`;
  const title = job.status === 'failed' && job.error ? `${path} — ${job.error}` : path;

  return (
    <li
      className={[
        styles.row,
        draggable ? styles.draggableRow : '',
        dragOver ? styles.dropTarget : '',
        dragging ? styles.dragging : '',
      ].filter(Boolean).join(' ')}
      draggable={draggable}
      onDragStart={dragHandlers?.onDragStart}
      onDragOver={dragHandlers?.onDragOver}
      onDrop={dragHandlers?.onDrop}
      onDragEnd={dragHandlers?.onDragEnd}
    >
      {draggable && (
        <span className={styles.handle} aria-hidden="true" title="Drag to reorder">
          <Icon name="grip" size={12} />
        </span>
      )}

      <StatusDot status={job.status} />

      <span className={styles.label} title={title}>
        <span className={styles.labelLine}>
          <span className={styles.seg} data-shimmer={job.status === 'generating' || undefined}>{job.ad}</span>
          <span className={styles.sep}>/</span>
          <span className={styles.segMute}>{job.variation}</span>
          <span className={styles.sep}>/</span>
          <span className={styles.segFaint}>{job.prompt}</span>
        </span>
        {job.status === 'failed' && job.error ? (
          // the error used to be buried in title= — surface it as a second line
          <span className={styles.errorLine} title={job.error}>{job.error}</span>
        ) : null}
      </span>

      {job.status === 'generating' && elapsed && <span className={styles.elapsed}>{elapsed}</span>}
      {job.status === 'waiting' && (
        <span className={styles.elapsed}>{secsLeft != null ? `${secsLeft}s` : '—'}</span>
      )}

      <span className={styles.actions}>
        {job.status === 'failed'
          ? (
              <button
                className={styles.act}
                aria-label="Retry generation"
                title="Retry"
                onClick={retry}
              >
                <Icon name="refresh" size={13} />
              </button>
            )
          : job.jobId && (
              <button
                className={styles.act}
                aria-label={job.status === 'waiting' ? 'Cancel — no Codex used' : 'Cancel generation'}
                title={job.status === 'waiting' ? 'Cancel — no Codex used' : 'Codex in use — cancel'}
                onClick={() => job.jobId && api.cancel({ jobId: job.jobId })}
              >
                <Icon name="x" size={13} />
              </button>
            )}
      </span>
    </li>
  );
}

// QUEUED rows only: native HTML5 drag-and-drop reorder. Holds its own local order as state so a drop
// reorders the list immediately (optimistic), independent of the next poll/SSE `state` push. Re-syncs
// from `rows` (server truth) whenever the SET of queued job ids changes — e.g. one starts running and
// drops out of this list, or a new one is enqueued — but NOT on every prop update, so a reorder isn't
// clobbered by an in-flight poll that hasn't seen the new order yet.
function QueuedList({ rows, brand, batch }: { rows: DockJob[]; brand: string | null; batch: string | null }) {
  const [order, setOrder] = useState<DockJob[]>(rows);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);

  const idsSignature = useMemo(() => rows.map((r) => r.key).sort().join('|'), [rows]);
  useEffect(() => {
    setOrder(rows);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsSignature]);

  const commit = (next: DockJob[]) => {
    setOrder(next);
    if (!brand || !batch) return;
    const jobIds = next.map((j) => j.jobId).filter((id): id is string => !!id);
    if (jobIds.length > 0) api.reorderQueue(brand, batch, jobIds);
  };

  const onDragStart = (key: string) => (e: DragEvent) => {
    setDragKey(key);
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', key); } catch { /* Firefox requires this set */ }
  };

  const onDragOver = (key: string) => (e: DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (key !== overKey) setOverKey(key);
  };

  const onDrop = (key: string) => (e: DragEvent) => {
    e.preventDefault();
    setOverKey(null);
    const fromKey = dragKey;
    setDragKey(null);
    if (!fromKey || fromKey === key) return;
    const fromIdx = order.findIndex((j) => j.key === fromKey);
    const toIdx = order.findIndex((j) => j.key === key);
    if (fromIdx === -1 || toIdx === -1) return;
    const next = order.slice();
    const [moved] = next.splice(fromIdx, 1);
    next.splice(toIdx, 0, moved);
    commit(next);
  };

  const onDragEnd = () => {
    setDragKey(null);
    setOverKey(null);
  };

  return (
    <ul className={styles.list}>
      {order.map((job) => (
        <JobRow
          key={job.key}
          job={job}
          draggable
          dragOver={overKey === job.key && dragKey !== job.key}
          dragging={dragKey === job.key}
          brand={brand}
          batch={batch}
          dragHandlers={{
            onDragStart: onDragStart(job.key),
            onDragOver: onDragOver(job.key),
            onDrop: onDrop(job.key),
            onDragEnd,
          }}
        />
      ))}
    </ul>
  );
}

export default function ActivityDock() {
  const state = useStore((s) => s.state);
  const activityOpen = useStore((s) => s.ui.activityOpen);
  const setUI = useStore((s) => s.setUI);
  const brand = useStore((s) => s.brand);
  const batch = useStore((s) => s.batch);

  const designEvents = useStore((s) => s.ui.designEvents);
  const designLoop = useMemo(() => deriveDesignLoop(designEvents), [designEvents]);
  // Only an ACTIVE (or just-failed) design loop earns a slot in the dock — a completed read is done.
  const showLoop = !!designLoop && (designLoop.active || designLoop.failed);

  const jobs = deriveJobs(state);
  const run = state?.run;
  const isPaused = run?.state === 'paused' || run?.state === 'cooling' || run?.state === 'ready';

  const running = jobs.filter((j) => j.status === 'generating').length;
  const waiting = jobs.filter((j) => j.status === 'waiting').length;
  const queued = jobs.filter((j) => j.status === 'queued').length;
  const failed = jobs.filter((j) => j.status === 'failed').length;

  // Closed and nothing happening (no image jobs AND no live design loop) → nothing to render.
  if (!activityOpen && jobs.length === 0 && !showLoop) return null;

  // Closed but something's live → a small pill that expands the panel. The design loop takes
  // precedence in the label when it's active (that's the thing the user is watching build).
  if (!activityOpen) {
    const pillLabel =
      showLoop && designLoop!.active ? 'reading reference'
      : running > 0 ? `${running} running`
      : waiting > 0 ? `${waiting} starting`
      : queued > 0 ? `${queued} queued`
      : showLoop && designLoop!.failed ? 'read failed'
      : `${failed} failed`;
    const pillDot: GroupKey =
      showLoop && designLoop!.active ? 'generating'
      : running > 0 ? 'generating' : waiting > 0 ? 'waiting'
      : queued > 0 ? 'queued' : 'failed';
    return (
      <button
        className={styles.pill}
        aria-label={`Open activity — ${pillLabel}`}
        title="Open activity"
        onClick={() => setUI({ activityOpen: true })}
      >
        <StatusDot status={pillDot} />
        <span className={styles.pillText}>{pillLabel}</span>
        <Icon name="chevron-down" size={13} className={styles.pillChev} />
      </button>
    );
  }

  // Expanded panel. Queued rows sort by server-side queue priority (`order`) so the initial render —
  // before any local drag — already reflects what the worker will actually run next.
  const groups = GROUPS.map((g) => ({
    ...g,
    rows: jobs
      .filter((j) => j.status === g.key)
      .sort((a, b) => (g.key === 'queued' ? (a.order ?? 0) - (b.order ?? 0) : 0)),
  })).filter((g) => g.rows.length > 0);

  const badge =
    showLoop && designLoop!.active ? 'reading'
    : running > 0 ? `${running} running`
    : waiting > 0 ? `${waiting} starting`
    : queued > 0 ? `${queued} queued`
    : failed > 0 ? `${failed} failed`
    : '';

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
        {showLoop ? (
          <section className={styles.group}>
            <div className={styles.groupLabel}>
              <span className={styles.groupName}>{designLoop!.failed ? 'Read failed' : 'Reading'}</span>
              {!designLoop!.failed && designLoop!.layers != null ? (
                <span className={styles.groupCount}>{designLoop!.layers} layers</span>
              ) : null}
            </div>
            <ul className={styles.list}>
              <DesignLoopRow loop={designLoop!} />
            </ul>
          </section>
        ) : null}

        {groups.length === 0 && !showLoop ? (
          <p className={styles.empty}>No active jobs</p>
        ) : null}

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
                      onClick={() => (isPaused ? api.resume({ verify: true }).then(refreshState) : api.pause())}
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

              {g.key === 'queued' ? (
                <QueuedList rows={g.rows} brand={brand} batch={batch} />
              ) : (
                <ul className={styles.list}>
                  {g.rows.map((job) => (
                    <JobRow key={job.key} job={job} brand={brand} batch={batch} />
                  ))}
                </ul>
              )}
            </section>
          ))
        ) : null}
      </div>
    </section>
  );
}
