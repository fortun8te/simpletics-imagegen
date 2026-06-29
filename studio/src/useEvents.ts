// Subscribe to the backend SSE stream (/events) and call onChange when anything updates.
// Coalesces bursts (one refresh per ~250ms) and falls back to 2s polling if SSE drops.
import { useEffect, useRef } from 'react';

export function useEvents(onChange: () => void) {
  const cb = useRef(onChange);
  cb.current = onChange;

  useEffect(() => {
    let es: EventSource | null = null;
    let poll: number | undefined;
    let debounce: number | undefined;
    let disposed = false;

    const fire = () => {
      if (debounce) return;
      debounce = window.setTimeout(() => {
        debounce = undefined;
        cb.current();
      }, 250);
    };

    const startPoll = () => {
      if (poll === undefined) poll = window.setInterval(() => cb.current(), 2000);
    };

    try {
      es = new EventSource('/events');
      for (const ev of ['state', 'queue', 'progress', 'hello']) {
        es.addEventListener(ev, fire);
      }
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
      if (poll) clearInterval(poll);
      if (debounce) clearTimeout(debounce);
    };
  }, []);
}
