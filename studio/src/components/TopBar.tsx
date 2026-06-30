// TopBar (container) — breadcrumb + the run state-machine control center + density.
// Reads brand/batch/run/ui/config via store selectors; calls setUI + api.
// The primary action's label + handler are derived from `state.run.state`:
//   idle → Generate · running → Pause+Stop · paused → Continue+Stop · cooling → countdown+Stop.
// Filter dropdown and theme toggle were removed (single dark theme, no filter).
import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { useStore } from '../store';
import { api } from '../api';
import type { RunInfo, RunState } from '../types';
import s from './TopBar.module.css';

// Small inline pause glyph (no entry in the shared Icon set).
function PauseGlyph({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false">
      <rect x="7" y="6" width="3.2" height="12" rx="1" />
      <rect x="13.8" y="6" width="3.2" height="12" rx="1" />
    </svg>
  );
}

// Format a millisecond gap as m:ss for the cooling countdown.
function fmtCountdown(ms: number): string {
  const t = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(t / 60);
  const ss = String(t % 60).padStart(2, '0');
  return `${m}:${ss}`;
}

// Format a seconds ETA as a terse "~Nm" / "~Ns".
function fmtEta(seconds: number): string {
  if (!isFinite(seconds) || seconds <= 0) return '';
  if (seconds < 60) return `~${Math.round(seconds)}s`;
  return `~${Math.round(seconds / 60)}m`;
}

export default function TopBar() {
  const brand = useStore((s) => s.brand);
  const batch = useStore((s) => s.batch);
  const config = useStore((s) => s.config);
  const run = useStore((s) => s.state?.run) as RunInfo | undefined;
  const ads = useStore((s) => s.state?.ads);
  const setUI = useStore((s) => s.setUI);

  // Resolve display names from config by current brand/batch ids.
  const brandRef = config.brands.find((b) => b.id === brand);
  const batchRef = brandRef?.batches.find((bt) => bt.code === batch);
  const brandName = brandRef?.name ?? brand ?? '—';
  const batchName = batchRef?.name ?? batch ?? '—';

  // Count empty (never-generated) slots so the primary action is unambiguous: "Generate N" fills the
  // gaps; if the batch is already full, the same button enqueues one more variant per variation.
  let emptyCount = 0;
  for (const ad of ads ?? [])
    for (const v of ad.variations)
      for (const p of v.prompts)
        for (const slot of p.slots) if (slot.status === 'empty') emptyCount++;

  // Direct generate — no popup. Whole-batch scope: the backend fills empty slots first; with none
  // left it enqueues one more variant per variation. The label tells the user which case they're in.
  const doGenerate = () => {
    if (brand && batch) api.generate(brand, batch, {}, 1);
  };


  // Run state machine.
  const state: RunState = run?.state ?? 'idle';
  const done = run?.done ?? 0;
  const total = run?.total ?? 0;
  const queued = run?.queued ?? 0;
  const resumeAt = run?.resumeAt ?? null;

  // Ticking clock — drives the cooling countdown and the rate-based ETA.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (state !== 'cooling' && state !== 'running') return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [state]);

  // Track when the current run started running, to derive a rough done-rate ETA.
  const [runStart, setRunStart] = useState<number | null>(null);
  useEffect(() => {
    if (state === 'running') setRunStart((p) => p ?? Date.now());
    else setRunStart(null);
  }, [state]);

  // Rough ETA: extrapolate remaining work from the rate of completed jobs so far.
  let eta = '';
  if (state === 'running' && runStart && done > 0 && total > done) {
    const elapsed = (now - runStart) / 1000;
    const rate = done / elapsed; // jobs/sec
    if (rate > 0) eta = fmtEta((total - done) / rate);
  }

  // Inline reset confirm (two-step, no native dialog by default).
  const [confirmReset, setConfirmReset] = useState(false);
  useEffect(() => {
    if (!confirmReset) return;
    const id = setTimeout(() => setConfirmReset(false), 4000);
    return () => clearTimeout(id);
  }, [confirmReset]);

  const showReset = queued > 0 || state === 'cooling';

  const doReset = () => {
    if (!confirmReset) { setConfirmReset(true); return; }
    setConfirmReset(false);
    api.reset();
  };

  return (
    <header className={s.bar}>
      <nav className={s.crumb} aria-label="Location">
        <span className={s.brand}>{brandName}</span>
        <span className={s.slash} aria-hidden>/</span>
        <span className={s.batch}>{batchName}</span>
      </nav>

      <div className={s.right}>
        {/* Inline progress + ETA while a run is live */}
        {(state === 'running' || state === 'paused') && total > 0 ? (
          <button
            type="button"
            className={s.progress}
            onClick={() => setUI({ activityOpen: true })}
            title="Show activity"
          >
            <span className={`${s.runDot} ${state === 'paused' ? s.runDotPaused : ''}`} aria-hidden />
            <span className={s.progressNums}>{done}/{total}</span>
            {eta ? <span className={s.eta}>{eta}</span> : null}
          </button>
        ) : null}

        {/* Cooling countdown — auto-resumes, so no Continue button */}
        {state === 'cooling' ? (
          <span className={s.cooling} role="status">
            <Icon name="clock" size={14} />
            <span>
              Resuming in {resumeAt ? fmtCountdown(resumeAt - now) : '—'}
            </span>
          </span>
        ) : null}

        {/* Reset — clears the queue / cooldown; inline two-step confirm */}
        {showReset ? (
          <button
            type="button"
            className={`${s.ghost} ${confirmReset ? s.ghostWarn : ''}`}
            onClick={doReset}
            title="Clear the queue and reset the run"
          >
            <Icon name="refresh" size={15} />
            <span>{confirmReset ? 'Confirm reset?' : 'Reset'}</span>
          </button>
        ) : null}

        {/* Stop — present in any active state */}
        {(state === 'running' || state === 'paused' || state === 'cooling') ? (
          <button
            type="button"
            className={s.ghost}
            onClick={() => api.cancel({ all: true })}
            title="Stop all generation"
          >
            <Icon name="stop" size={15} />
            <span>Stop</span>
          </button>
        ) : null}

        {/* Primary — label + action change with run state */}
        {state === 'running' ? (
          <button
            type="button"
            className={s.primary}
            onClick={() => api.pause()}
            title="Pause — finish in-flight jobs, stop pulling new ones"
          >
            <PauseGlyph size={15} />
            <span>Pause</span>
          </button>
        ) : state === 'paused' ? (
          <button
            type="button"
            className={s.primary}
            onClick={() => api.resume()}
            title="Continue the run"
          >
            <Icon name="chevron-right" size={15} />
            <span>Continue</span>
          </button>
        ) : state === 'cooling' ? null : (
          <button
            type="button"
            className={s.primary}
            onClick={doGenerate}
            title={emptyCount > 0
              ? `Generate the ${emptyCount} missing image${emptyCount === 1 ? '' : 's'} in this batch`
              : 'Add one more variant to every variation in this batch'}
          >
            <Icon name="sparkles" size={15} />
            <span>{emptyCount > 0 ? `Generate ${emptyCount}` : 'Generate more'}</span>
          </button>
        )}
      </div>
    </header>
  );
}
