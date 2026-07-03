// SkeletonLoader — the loading UI for the design LOOP (vision extraction + agent build/refine).
//
// Clean & agentic: the loading-ui "diamond" spinner beside a text-shimmer line stating the one
// thing happening right now (e.g. "reading the reference… pass 1/2"). The diamond animates via an
// inline SVG <style> (can't silently fail), the text stays legible (shimmer over a readable base),
// and both are always present so the user can see it IS working.
import { useMemo } from 'react';
import type { AgentEvent } from '../../store';
import Diamond from './DiamondLoader';
import TextShimmer from './TextShimmer';
import styles from './SkeletonLoader.module.css';

type Step = NonNullable<AgentEvent['step']>;

interface SkeletonLoaderProps {
  /** Live steps for THIS run (already filtered to the current runId by the caller). */
  steps: Step[];
  /** Seconds since the run started (caller ticks this). */
  elapsed: number;
  /** @deprecated kept for API compatibility — no longer used. */
  aspect?: number;
  /** @deprecated kept for API compatibility — no longer used. */
  totalPasses?: number;
  /** Fallback line shown before the first step arrives (e.g. "Reading the reference…"). */
  title?: string;
}

export default function SkeletonLoader({ steps, elapsed, title }: SkeletonLoaderProps) {
  // The single most-recent non-empty message — the one thing happening right now.
  const current = useMemo(() => {
    for (let i = steps.length - 1; i >= 0; i--) {
      const t = (steps[i].summary || '').trim();
      if (t) return t;
    }
    return title || 'Reading the reference…';
  }, [steps, title]);

  const mm = Math.floor(elapsed / 60);
  const ss = elapsed % 60;
  const clock = mm > 0 ? `${mm}:${String(ss).padStart(2, '0')}` : `${ss}s`;

  return (
    <div className={styles.loader} aria-live="polite" aria-busy="true">
      <Diamond size={22} />
      <TextShimmer className={styles.step} key={current}>{current}</TextShimmer>
      <span className={styles.clock}>{clock}</span>
    </div>
  );
}
