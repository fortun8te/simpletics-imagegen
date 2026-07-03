// Global keyboard shortcuts — lightweight, no deps.
import { useEffect } from 'react';
import { useStore } from '../store';
import { api } from '../api';

export function useKeyboardShortcuts() {
  const brand = useStore((s) => s.brand);
  const batch = useStore((s) => s.batch);
  const batchViewMode = useStore((s) => s.ui.batchViewMode);
  const setUI = useStore((s) => s.setUI);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const tag = (e.target as HTMLElement)?.tagName;
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable;

      if (mod && e.key === ',') {
        e.preventDefault();
        setUI({ settingsOpen: true });
        return;
      }

      if (mod && e.key === 'e' && brand && batch) {
        e.preventDefault();
        window.location.assign(api.exportBatchUrl(brand, batch));
        return;
      }

      if (typing) return;

      if (e.key === '1') {
        setUI({ batchViewMode: 'plan' });
        return;
      }
      if (e.key === '2') {
        setUI({ batchViewMode: 'gallery' });
        return;
      }
      if (e.key === '3') {
        setUI({ batchViewMode: 'design' });
        return;
      }
      if (e.key === '/' && (batchViewMode === 'plan' || batchViewMode === 'gallery')) {
        e.preventDefault();
        document.getElementById('plan-search-input')?.focus();
        return;
      }
      if (mod && e.key === 'k') {
        e.preventDefault();
        if (batchViewMode === 'plan') document.getElementById('plan-search-input')?.focus();
        else setUI({ genOpen: true });
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [brand, batch, batchViewMode, setUI]);
}
