// Bootstrap + data wiring. Loads config, lands on the default brand/batch (nanox/b2), refreshes the
// batch state on selection change and on every SSE/poll tick. All UI lives in AppShell + children.
import { useEffect, useCallback } from 'react';
import { useStore, DEFAULT_BRAND, DEFAULT_BATCH } from './store';
import { api } from './api';
import { useEvents } from './useEvents';
import { refreshState } from './refresh';
import { isAppActive, pollIntervalMs } from './lib/activity';
import AppShell from './components/AppShell';
import ErrorBoundary from './components/ErrorBoundary';

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
    // Bootstrap the workspace list. api.getConfig() swallows any network/500 error into an empty
    // { brands: [] } (e.g. a transient parse error while config.json is being written, or a
    // slow cold-start), which would otherwise leave the sidebar permanently workspace-less for
    // the whole session — the reported "workspaces are not loaded in". Retry with backoff until
    // brands actually arrive so the app self-heals instead of getting stuck empty.
    let alive = true;
    let attempt = 0;
    const load = () => {
      api.getConfig().then((cfg) => {
        if (!alive) return;
        setConfig(cfg);
        const brands = cfg.brands || [];
        if (brands.length === 0) {
          // Nothing came back — retry (capped backoff) rather than sitting empty forever.
          if (attempt < 8) {
            attempt += 1;
            window.setTimeout(() => { if (alive) load(); }, Math.min(500 * attempt, 4000));
          }
          return;
        }
        const wantBrand = brands.find((b) => b.id === brand) || brands.find((b) => b.id === DEFAULT_BRAND) || brands[0];
        if (!wantBrand) return;
        const batches = wantBrand.batches || [];
        const wantBatch =
          (wantBrand.id === brand && batches.find((bt) => bt.code === batch)) ||
          batches.find((bt) => bt.code === DEFAULT_BATCH) ||
          batches[0];
        select(wantBrand.id, wantBatch ? wantBatch.code : '');
      });
    };
    load();
    return () => { alive = false; };
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

  // Second, inner boundary: if AppShell's own subtree throws (e.g. a Design-mode canvas render
  // crash deep inside BatchView/DesignView/Editor), this catches it independently of the outer
  // main.tsx boundary — a render error here still shows the compact panel instead of a blank
  // screen, without necessarily masking issues caught earlier in App's own hooks.
  return (
    <ErrorBoundary label="app shell">
      <AppShell />
    </ErrorBoundary>
  );
}
