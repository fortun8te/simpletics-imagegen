// Bootstrap + data wiring. Loads config, lands on the default brand/batch (nanox/b2), refreshes the
// batch state on selection change and on every SSE/poll tick. All UI lives in AppShell + children.
import { useEffect, useCallback } from 'react';
import { useStore, DEFAULT_BRAND, DEFAULT_BATCH } from './store';
import { api } from './api';
import { useEvents } from './useEvents';
import { refreshState } from './refresh';
import AppShell from './components/AppShell';

export default function App() {
  const brand = useStore((s) => s.brand);
  const batch = useStore((s) => s.batch);
  const setConfig = useStore((s) => s.setConfig);
  const select = useStore((s) => s.select);

  useEffect(() => {
    api.getConfig().then((cfg) => {
      setConfig(cfg);
      const brands = cfg.brands || [];
      // Prefer whatever the user last had open (persisted in the store from localStorage) so a
      // reload lands back on the same batch instead of always resetting to the hardcoded default.
      // Falls back to the default/first brand if the persisted one no longer exists.
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

  return <AppShell />;
}
