// Bootstrap + data wiring. Loads config, lands on the default brand/batch (nanox/b2), refreshes the
// batch state on selection change and on every SSE/poll tick. All UI lives in AppShell + children.
import { useEffect, useCallback } from 'react';
import { useStore, DEFAULT_BRAND, DEFAULT_BATCH } from './store';
import { api } from './api';
import { useEvents } from './useEvents';
import AppShell from './components/AppShell';

export default function App() {
  const brand = useStore((s) => s.brand);
  const batch = useStore((s) => s.batch);
  const theme = useStore((s) => s.ui.theme);
  const setConfig = useStore((s) => s.setConfig);
  const select = useStore((s) => s.select);
  const setState = useStore((s) => s.setState);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    api.getConfig().then((cfg) => {
      setConfig(cfg);
      const brands = cfg.brands || [];
      const wantBrand = brands.find((b) => b.id === DEFAULT_BRAND) || brands[0];
      if (!wantBrand) return;
      const batches = wantBrand.batches || [];
      const wantBatch = batches.find((bt) => bt.code === DEFAULT_BATCH) || batches[0];
      select(wantBrand.id, wantBatch ? wantBatch.code : '');
    });
  }, [setConfig, select]);

  const refresh = useCallback(() => {
    const s = useStore.getState();
    if (s.brand && s.batch) api.getState(s.brand, s.batch).then(s.setState);
  }, []);

  useEffect(() => {
    refresh();
  }, [brand, batch, refresh]);

  useEvents(refresh);

  return <AppShell />;
}
