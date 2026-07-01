// TopBar — breadcrumb + Gallery/Plan mode + run controls (single slim row).
import { useEffect, useMemo, useState } from 'react';
import { Icon } from './Icon';
import { useStore, type BatchViewMode } from '../store';
import { api } from '../api';
import { refreshState } from '../refresh';
import type { RunInfo, RunState } from '../types';
import s from './TopBar.module.css';

function PauseGlyph({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false">
      <rect x="7" y="6" width="3.2" height="12" rx="1" />
      <rect x="13.8" y="6" width="3.2" height="12" rx="1" />
    </svg>
  );
}

function fmtCountdown(ms: number): string {
  const t = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(t / 60);
  const ss = String(t % 60).padStart(2, '0');
  return `${m}:${ss}`;
}

function fmtEta(seconds: number): string {
  if (!isFinite(seconds) || seconds <= 0) return '';
  if (seconds < 60) return `~${Math.round(seconds)}s`;
  return `~${Math.round(seconds / 60)}m`;
}

const MODES: { key: BatchViewMode; label: string; icon: string }[] = [
  { key: 'gallery', label: 'Gallery', icon: 'layout-grid' },
  { key: 'plan', label: 'Plan', icon: 'layout-list' },
];

export default function TopBar() {
  const brand = useStore((st) => st.brand);
  const batch = useStore((st) => st.batch);
  const config = useStore((st) => st.config);
  const run = useStore((st) => st.state?.run) as RunInfo | undefined;
  const ads = useStore((st) => st.state?.ads);
  const setUI = useStore((st) => st.setUI);
  const batchViewMode = useStore((st) => st.ui.batchViewMode);

  const brandRef = config.brands.find((b) => b.id === brand);
  const batchRef = brandRef?.batches.find((bt) => bt.code === batch);
  const brandName = brandRef?.name ?? brand ?? '—';
  const batchName = batchRef?.name ?? batch ?? '—';

  const emptyCount = useMemo(() => {
    let empty = 0;
    for (const ad of ads ?? [])
      for (const v of ad.variations)
        for (const p of v.prompts)
          for (const slot of p.slots)
            if (slot.status === 'empty') empty++;
    return empty;
  }, [ads]);

  const doGenerate = () => {
    if (brand && batch) api.generate(brand, batch, {}, 1);
  };

  const state: RunState = run?.state ?? 'idle';
  const done = run?.done ?? 0;
  const total = run?.total ?? 0;
  const queued = run?.queued ?? 0;
  const resumeAt = run?.resumeAt ?? null;

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (state !== 'cooling' && state !== 'running' && state !== 'ready') return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [state]);

  const [runStart, setRunStart] = useState<number | null>(null);
  useEffect(() => {
    if (state === 'running') setRunStart((p) => p ?? Date.now());
    else setRunStart(null);
  }, [state]);

  let eta = '';
  if (state === 'running' && runStart && done > 0 && total > done) {
    const elapsed = (now - runStart) / 1000;
    const rate = done / elapsed;
    if (rate > 0) eta = fmtEta((total - done) / rate);
  }

  const [confirmCancel, setConfirmCancel] = useState(false);
  useEffect(() => {
    if (!confirmCancel) return;
    const id = setTimeout(() => setConfirmCancel(false), 4000);
    return () => clearInterval(id);
  }, [confirmCancel]);

  const showCancelAll =
    state === 'running' || state === 'paused' || state === 'cooling' || state === 'ready' || state === 'done' || queued > 0;

  const verifyAndResume = () => api.resume({ verify: true }).then(refreshState);

  const doCancelAll = () => {
    if (!confirmCancel) { setConfirmCancel(true); return; }
    setConfirmCancel(false);
    api.cancel({ all: true }).then(() => api.reset()).then(refreshState);
  };

  return (
    <header className={s.bar}>
      <div className={s.row}>
        <nav className={s.crumb} aria-label="Location">
          <span className={s.brand}>{brandName}</span>
          <span className={s.slash} aria-hidden>/</span>
          <span className={s.batch}>{batchName}</span>
        </nav>

        <div className={s.modeSwitch} role="tablist" aria-label="Batch view">
          {MODES.map((m) => {
            const active = batchViewMode === m.key;
            return (
              <button
                key={m.key}
                type="button"
                role="tab"
                aria-selected={active}
                className={`${s.modeBtn} ${active ? s.modeBtnActive : ''}`}
                onClick={() => setUI({ batchViewMode: m.key })}
              >
                <Icon name={m.icon} size={14} />
                <span>{m.label}</span>
              </button>
            );
          })}
        </div>

        <div className={s.right}>
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

          {state === 'cooling' ? (
            <span className={s.cooling} role="status">
              <Icon name="clock" size={14} />
              <span>Rate-limited · can continue in {resumeAt ? fmtCountdown(resumeAt - now) : '—'}</span>
            </span>
          ) : null}

          {state === 'ready' ? (
            <span className={s.cooling} role="status">
              <Icon name="sparkles" size={14} />
              <span>Ready when you are</span>
            </span>
          ) : null}

          {showCancelAll ? (
            <button
              type="button"
              className={`${s.ghost} ${confirmCancel ? s.ghostWarn : ''}`}
              onClick={doCancelAll}
              title="Cancel everything — abort the run and clear the queue"
            >
              <Icon name="stop" size={15} />
              <span>{confirmCancel ? 'Confirm cancel?' : 'Cancel all'}</span>
            </button>
          ) : null}

          {state === 'running' ? (
            <button type="button" className={s.primary} onClick={() => api.pause()} title="Pause">
              <PauseGlyph size={15} />
              <span>Pause</span>
            </button>
          ) : state === 'paused' ? (
            <button type="button" className={s.primary} onClick={verifyAndResume} title="Check Codex quota and continue">
              <Icon name="chevron-right" size={15} />
              <span>Continue</span>
            </button>
          ) : state === 'ready' ? (
            <button type="button" className={s.primary} onClick={verifyAndResume} title="Check Codex quota, then resume">
              <Icon name="chevron-right" size={15} />
              <span>Check & continue</span>
            </button>
          ) : state === 'cooling' ? null : (
            <>
              <button
                type="button"
                className={s.primary}
                onClick={doGenerate}
                title={emptyCount > 0
                  ? `Generate the ${emptyCount} image${emptyCount === 1 ? '' : 's'} that haven't been created yet`
                  : 'Add one new variant to every variation'}
              >
                <Icon name="sparkles" size={15} />
                <span>{emptyCount > 0 ? `Generate ${emptyCount} missing` : 'Add 1 variant'}</span>
              </button>
              <button
                type="button"
                className={s.secondary}
                onClick={() => setUI({ genOpen: true })}
                title="Generate with options"
                aria-label="Generate with options"
              >
                <Icon name="sliders" size={14} />
              </button>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
