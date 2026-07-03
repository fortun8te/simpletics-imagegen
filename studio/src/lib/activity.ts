// Lightweight "is anything running?" signal for adaptive polling / idle UI.
import { useStore } from '../store';
import type { RunState } from '../types';

const ACTIVE_RUN: RunState[] = ['running', 'paused', 'cooling', 'ready'];

/** True when a generation run or queue work is in flight. */
export function isAppActive(): boolean {
  const st = useStore.getState();
  const run = st.state?.run?.state;
  if (run && ACTIVE_RUN.includes(run)) return true;
  const q = st.state?.queue;
  if (q && (q.running > 0 || q.queued > 0 || (q.waiting ?? 0) > 0)) return true;
  if (st.codexUsage?.cooling) return true;
  return false;
}

/** Health / sidebar poll interval (ms) from activity + tab visibility. */
export function pollIntervalMs(kind: 'health' | 'batches'): number {
  if (typeof document !== 'undefined' && document.hidden) return 120_000;
  if (isAppActive()) return kind === 'health' ? 5_000 : 15_000;
  return kind === 'health' ? 45_000 : 90_000;
}
