// Bootstrap + data wiring. Loads config, lands on the default brand/batch (nanox/b2), refreshes the
// batch state on selection change and on every SSE/poll tick. All UI lives in AppShell + children.
import { useEffect, useCallback } from 'react';
import { useStore, DEFAULT_BRAND, DEFAULT_BATCH } from './store';
import { api } from './api';
import { useEvents } from './useEvents';
import { refreshState } from './refresh';
import { isAppActive, pollIntervalMs } from './lib/activity';
import AppShell from './components/AppShell';

function syncIdleFlags() {
  try {
    const hidden = document.hidden;
    const active = isAppActive();
    document.documentElement.dataset.tabHidden = hidden ? 'true' : 'false';
    document.documentElement.dataset.appIdle = !hidden && !active ? 'true' : 'false';
  } catch { /* SSR */ }
}

export default function App() {
  const brand = useStore((s) => s.brand);
  const batch = useStore((s) => s.batch);
  const setConfig = useStore((s) => s.setConfig);
  const select = useStore((s) => s.select);
  const setUsage = useStore((s) => s.setUsage);
  const setBlockers = useStore((s) => s.setBlockers);
  const setSettings = useStore((s) => s.setSettings);

  useEffect(() => {
    api.getConfig().then((cfg) => {
      setConfig(cfg);
      const brands = cfg.brands || [];
      const wantBrand = brands.find((b) => b.id === brand) || brands.find((b) => b.id === DEFAULT_BRAND) || brands[0];
      if (!wantBrand) return;
      const batches = wantBrand.batches || [];
      const wantBatch =
        (wantBrand.id === brand && batches.find((bt) => bt.code === batch)) ||
        batches.find((bt) => bt.code === DEFAULT_BATCH) ||
        batches[0];
      select(wantBrand.id, wantBatch ? wantBatch.code : '');
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setConfig, select]);

  const refresh = useCallback(() => refreshState(), []);

  useEffect(() => {
    refresh();
  }, [brand, batch, refresh]);

  useEvents(refresh);

  // Idle / tab flags — pause decorative CSS animations when nothing is running.
  useEffect(() => {
    syncIdleFlags();
    const onVis = () => syncIdleFlags();
    document.addEventListener('visibilitychange', onVis);
    const unsub = useStore.subscribe(syncIdleFlags);
    const tick = window.setInterval(syncIdleFlags, 3000);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      unsub();
      window.clearInterval(tick);
    };
  }, []);

  // Health poll — adaptive: 5s while active, 45s idle, 2m when tab hidden.
  useEffect(() => {
    let alive = true;
    let timer: number | undefined;
    const probe = () => {
      if (!alive) return;
      if (document.hidden) { schedule(); return; }
      api.getHealth().then((h) => {
        if (!alive) return;
        if (h.codexUsage) setUsage(h.codexUsage);
        if (h.blockers) setBlockers(h.blockers);
      }).finally(() => schedule());
    };
    const schedule = () => {
      if (!alive) return;
      timer = window.setTimeout(probe, pollIntervalMs('health'));
    };
    probe();
    return () => { alive = false; if (timer) window.clearTimeout(timer); };
  }, [setUsage, setBlockers]);

  useEffect(() => {
    let alive = true;
    api.getSettings().then((r) => { if (alive && r.ok) setSettings(r.settings); });
    return () => { alive = false; };
  }, [setSettings]);

  useEffect(() => {
    let alive = true;
    let timer: number | undefined;
    const maybeRefresh = () => {
      if (!alive || document.hidden || isAppActive()) { schedule(); return; }
      const asOf = useStore.getState().codexUsage?.codex?.asOf;
      if (!asOf || Date.now() - asOf < 45 * 60 * 1000) { schedule(); return; }
      api.refreshUsage().then((r) => {
        if (!alive) return;
        if (r.codexUsage) setUsage(r.codexUsage);
        if (r.blockers) setBlockers(r.blockers);
        schedule();
      });
    };
    const schedule = () => {
      if (!alive) return;
      timer = window.setTimeout(maybeRefresh, 15 * 60 * 1000);
    };
    maybeRefresh();
    return () => { alive = false; if (timer) window.clearTimeout(timer); };
  }, [setUsage, setBlockers]);

  return <AppShell />;
}
