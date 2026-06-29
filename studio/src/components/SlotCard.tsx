// SlotCard — the per-image card that renders its own generation state (LEAF; props in).
// Takes coords as props; reads only store actions (setUI) + brand/batch for generate calls,
// and calls `api` directly. Every slot.status has a designed state. Fixed square box.
import { useEffect, useState, type ReactNode } from 'react';
import * as Tooltip from '@radix-ui/react-tooltip';
import type { Slot } from '../types';
import { useStore, type Density } from '../store';
import { api } from '../api';
import { Icon } from './Icon';
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

  // Per-prompt-slot generate target (used by empty / make-variations).
  const promptScope = { prompt: { ad, variation, prompt } };

  const open = () => slot.relPath && setUI({ drawerRel: slot.relPath });
  const genHere = (variants: number) =>
    brand && batch && api.generate(brand, batch, promptScope, variants);

  // ── done / archived ───────────────────────────────────────────────
  if ((slot.status === 'done' || slot.status === 'archived') && slot.relPath) {
    const archived = slot.status === 'archived';
    return (
      <div className={styles.card} data-density={density}>
        <img
          className={styles.img}
          style={archived ? { opacity: 0.4 } : undefined}
          src={api.imgUrl(slot.relPath)}
          alt={`${ad} / ${variation} · run ${slot.run}`}
          onClick={open}
        />
        {slot.version != null && <span className={styles.badge}>v{slot.version}</span>}

        <div className={styles.actions} role="toolbar" aria-label="Image actions">
          <HoverAction
            label="Regenerate"
            onClick={() => slot.relPath && api.regenerate(slot.relPath)}
          >
            <Icon name="refresh" size={15} />
          </HoverAction>
          <HoverAction
            label="Make variations"
            onClick={() => brand && batch && api.generate(brand, batch, promptScope, 2)}
          >
            <Icon name="sparkles" size={15} />
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

  // ── generating ────────────────────────────────────────────────────
  if (slot.status === 'generating') {
    return (
      <div className={`${styles.card} ${styles.generating}`} data-density={density}>
        <div className={styles.center}>
          <Spinner size={20} />
          <span className={styles.label}>Generating</span>
          <span className={styles.elapsed}>{elapsed}</span>
        </div>
        <div
          className={styles.progress}
          role="progressbar"
          aria-label="Generating image"
        >
          <span className={styles.progressBar} />
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
    <div className={`${styles.card} ${styles.empty}`} data-density={density}>
      <button className={styles.emptyBtn} onClick={() => genHere(1)} aria-label="Generate image">
        <Icon name="plus" size={20} />
        <span className={styles.label}>Generate</span>
      </button>
    </div>
  );
}
