// Subscribe to the backend SSE stream (/events) and call onChange when anything updates.
// Coalesces bursts; backs off when idle; falls back to slow polling only if SSE drops.
// `plan` / `design` events are the visible agent streams (BRIEF: every step emits a UI
// event) — they bypass the debounce and append straight into the store.
import { useEffect, useRef } from 'react';
import { isAppActive, pollIntervalMs } from './lib/activity';
import { useStore } from './store';

export function useEvents(onChange: () => void) {
  const cb = useRef(onChange);
  cb.current = onChange;

  useEffect(() => {
    let es: EventSource | null = null;
    let poll: number | undefined;
    let debounce: number | undefined;
    let disposed = false;
    let lastIdleRefresh = 0;

    const fire = (force = false) => {
      const active = isAppActive();
      const now = Date.now();
      if (!force && !active) {
        // While idle, still accept SSE-driven refreshes, but at most once per 30s.
        if (now - lastIdleRefresh < 30_000) return;
        lastIdleRefresh = now;
      }
      if (debounce) return;
      const delay = active ? 250 : 600;
      debounce = window.setTimeout(() => {
        debounce = undefined;
        cb.current();
      }, delay);
    };

    const startPoll = () => {
      if (poll !== undefined) return;
      const tick = () => {
        if (disposed) return;
        if (!document.hidden) fire(true);
        poll = window.setTimeout(tick, pollIntervalMs('health'));
      };
      poll = window.setTimeout(tick, pollIntervalMs('health'));
    };

    const stopPoll = () => {
      if (poll !== undefined) {
        window.clearTimeout(poll);
        poll = undefined;
      }
    };

    try {
      es = new EventSource('/events');
      es.addEventListener('hello', () => fire(true));
      es.addEventListener('state', () => fire());
      es.addEventListener('queue', () => fire());
      es.addEventListener('progress', () => { if (isAppActive()) fire(); });
      es.addEventListener('plan', (e) => {
        try { useStore.getState().pushAgentEvent('plan', JSON.parse((e as MessageEvent).data)); } catch { /* bad frame */ }
      });
      es.addEventListener('design', (e) => {
        try { useStore.getState().pushAgentEvent('design', JSON.parse((e as MessageEvent).data)); } catch { /* bad frame */ }
      });
      // Document-change pings ({kind:'design'|'skeleton'|'element'|'brandkit', id, updatedAt?}).
      // Latest-only: the store keeps a single tick; views debounce their own refetch off it.
      es.addEventListener('doc', (e) => {
        try {
          const d = JSON.parse((e as MessageEvent).data) as { kind?: unknown; id?: unknown; updatedAt?: unknown };
          if (d && typeof d.kind === 'string' && typeof d.id === 'string') {
            useStore.getState().setDocTick({
              kind: d.kind,
              id: d.id,
              updatedAt: typeof d.updatedAt === 'number' ? d.updatedAt : undefined,
              at: Date.now(),
            });
          }
        } catch { /* bad frame */ }
      });
      es.onopen = () => stopPoll();
      es.onerror = () => {
        es?.close();
        es = null;
        if (!disposed) startPoll();
      };
    } catch {
      startPoll();
    }

    return () => {
      disposed = true;
      es?.close();
      stopPoll();
      if (debounce) clearTimeout(debounce);
    };
  }, []);
}
