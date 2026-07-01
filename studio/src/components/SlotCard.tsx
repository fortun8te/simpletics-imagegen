// SlotCard — the per-image card that renders its own generation state (LEAF; props in).
// Takes coords as props; reads only store actions (setUI) + brand/batch for generate calls,
// and calls `api` directly. Every slot.status has a designed state. Fixed square box.
import { useEffect, useState, type ReactNode } from 'react';
import * as Tooltip from '@radix-ui/react-tooltip';
import type { Slot } from '../types';
import { useStore, type Density } from '../store';
import { api } from '../api';
import { Icon } from './Icon';
import { GenerateTile } from './GenerateTile';
import { Spinner } from './Spinner';
import styles from './SlotCard.module.css';

interface SlotCardProps {
  slot: Slot;
  ad: string;
  variation: string;
  prompt: string;
  density: Density;
}

// "3:07" style mm:ss from a start timestamp (ms epoch), ticking live.
function useElapsed(startedAt?: number | null): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!startedAt) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [startedAt]);
  if (!startedAt) return '0:00';
  const total = Math.max(0, Math.floor((now - startedAt) / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// Live seconds-until countdown from a future epoch-ms timestamp (the waiting-window `spendAt`).
// Ticks once a second, floors at 0. Returns null when there's no target. Reuses the same
// elapsed-timer pattern (setInterval on mount) so the waiting phase counts down honestly.
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

// Wrap a hover icon-button in a themed Radix tooltip. A single Tooltip.Provider is mounted
// app-wide in AppShell, so we use Root/Trigger/Portal/Content only (no nested provider).
function HoverAction({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip.Root delayDuration={500}>
      <Tooltip.Trigger asChild>
        <button className={styles.iconBtn} aria-label={label} onClick={onClick}>
          {children}
        </button>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className={styles.tip} side="top" sideOffset={6}>
          {label}
          <Tooltip.Arrow className={styles.tipArrow} width={9} height={5} />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

export default function SlotCard({ slot, ad, variation, prompt, density }: SlotCardProps) {
  const setUI = useStore((s) => s.setUI);
  const brand = useStore((s) => s.brand);
  const batch = useStore((s) => s.batch);
  const elapsed = useElapsed(slot.status === 'generating' ? slot.job?.startedAt : undefined);
  const secsLeft = useCountdown(slot.status === 'waiting' ? slot.job?.spendAt : undefined);
  const jobId = slot.job?.id;
  const cancelJob = () => jobId && api.cancel({ jobId });

  // Per-prompt-slot generate target (used by empty / make-variations).
  const promptScope = { prompt: { ad, variation, prompt } };

  const open = () => slot.relPath && setUI({ drawerRel: slot.relPath });
  const genHere = (variants: number) =>
    brand && batch && api.generate(brand, batch, promptScope, variants);

  // ── done / archived ───────────────────────────────────────────────
  if ((slot.status === 'done' || slot.status === 'archived') && slot.relPath) {
    const archived = slot.status === 'archived';
    return (
      <div
        className={`${styles.card} ${styles.filled} ${archived ? styles.archived : ''}`}
        data-density={density}
      >
        <img
          className={styles.img}
          src={api.imgUrl(slot.relPath)}
          alt={`${ad} / ${variation} · run ${slot.run}`}
          onClick={open}
        />
        {archived && <span className={styles.archivedTag}>Archived</span>}

        <div className={styles.actions} role="toolbar" aria-label="Image actions">
          <HoverAction
            label="Regenerate"
            onClick={() => slot.relPath && api.regenerate(slot.relPath)}
          >
            <Icon name="refresh" size={15} />
          </HoverAction>
          <HoverAction
            label={archived ? 'Restore' : 'Archive'}
            onClick={() => slot.relPath && api.archive(slot.relPath, !archived)}
          >
            <Icon name={archived ? 'restore' : 'archive'} size={15} />
          </HoverAction>
          <HoverAction label="Open" onClick={open}>
            <Icon name="expand" size={15} />
          </HoverAction>
        </div>
      </div>
    );
  }

  // ── waiting — cancel-free grace window before Codex is spent ─────────
  if (slot.status === 'waiting') {
    return (
      <div className={`${styles.card} ${styles.waiting}`} data-density={density}>
        <div className={styles.center}>
          <Icon name="clock" size={20} className={styles.mutedIcon} />
          <span className={styles.label}>
            {secsLeft != null ? `Starting in ${secsLeft}s` : 'Starting…'}
          </span>
          <button className={`${styles.retry} ${styles.cancelFree}`} onClick={cancelJob}>
            <Icon name="x" size={13} />
            Cancel — no Codex used
          </button>
        </div>
      </div>
    );
  }

  // ── generating ────────────────────────────────────────────────────
  if (slot.status === 'generating') {
    return (
      <div className={`${styles.card} ${styles.generating}`} data-density={density}>
        <div
          className={styles.progress}
          role="progressbar"
          aria-label="Generating image"
          aria-valuetext={`Generating · ${elapsed} elapsed`}
        >
          <span className={styles.progressBar} />
        </div>
        <div className={styles.center}>
          <Spinner size={18} />
          <span className={styles.label}>Generating</span>
          <span className={styles.elapsed}>{elapsed}</span>
          {jobId && (
            <button className={styles.retry} onClick={cancelJob} title="Codex in use">
              <Icon name="x" size={13} />
              Cancel · Codex in use
            </button>
          )}
        </div>
      </div>
    );
  }

  // ── queued ────────────────────────────────────────────────────────
  if (slot.status === 'queued') {
    return (
      <div className={`${styles.card} ${styles.queued}`} data-density={density}>
        <div className={styles.center}>
          <Icon name="clock" size={20} className={styles.mutedIcon} />
          <span className={styles.label}>Queued</span>
        </div>
      </div>
    );
  }

  // ── failed ────────────────────────────────────────────────────────
  if (slot.status === 'failed') {
    const err = slot.job?.error || 'Generation failed';
    const retry = () =>
      slot.relPath ? api.regenerate(slot.relPath) : genHere(1);
    return (
      <div className={`${styles.card} ${styles.failed}`} data-density={density}>
        <div className={styles.center}>
          <Icon name="alert" size={20} className={styles.errIcon} />
          <span className={styles.errText} title={err}>
            {err}
          </span>
          <button className={styles.retry} onClick={retry}>
            <Icon name="refresh" size={13} />
            Retry
          </button>
        </div>
      </div>
    );
  }

  // ── empty (default) ───────────────────────────────────────────────
  return (
    <GenerateTile
      label="Generate"
      ariaLabel="Generate image"
      density={density}
      onClick={() => genHere(1)}
    />
  );
}
