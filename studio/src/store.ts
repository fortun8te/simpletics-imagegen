// Global UI + data store (Zustand). Components read slices; App owns fetching and calls setState.
// Single dark theme (no toggle), no view switch, no filter — see V3-PLAN.md.
import { create } from 'zustand';
import type { Config, BatchState } from './types';

export type Density = 'comfortable' | 'compact';

export interface UIState {
  density: Density;
  showArchived: boolean;
  drawerRel: string | null;   // relPath of the slot shown in the detail drawer, or null
  genOpen: boolean;           // GenerateDialog open
  settingsOpen: boolean;      // SettingsDialog open
  activityOpen: boolean;      // Activity panel pinned open
}

interface Store {
  config: Config;
  brand: string | null;
  batch: string | null;
  state: BatchState | null;   // current batch state (null until first load)
  loading: boolean;
  ui: UIState;

  setConfig: (c: Config) => void;
  select: (brand: string, batch: string) => void;
  setState: (s: BatchState) => void;
  setLoading: (b: boolean) => void;
  setUI: (u: Partial<UIState>) => void;
}

// Preferred landing target (the arthritis listicle), used by App when present in config.
export const DEFAULT_BRAND = 'nanox';
export const DEFAULT_BATCH = 'b2';

const readPref = <T,>(key: string, fallback: T): T => {
  try { const v = localStorage.getItem(key); return v == null ? fallback : (v as unknown as T); } catch { return fallback; }
};
const writePref = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* ignore */ } };

export const useStore = create<Store>((set) => ({
  config: { brands: [] },
  brand: null,
  batch: null,
  state: null,
  loading: false,
  ui: {
    density: readPref<Density>('neuegen.density', 'compact'),
    showArchived: false,
    drawerRel: null,
    genOpen: false,
    settingsOpen: false,
    activityOpen: false,
  },

  setConfig: (config) => set({ config }),
  select: (brand, batch) =>
    set((s) => ({ brand, batch, state: null, loading: true, ui: { ...s.ui, drawerRel: null } })),
  setState: (state) => set({ state, loading: false }),
  setLoading: (loading) => set({ loading }),
  setUI: (u) =>
    set((s) => {
      if (u.density && u.density !== s.ui.density) writePref('neuegen.density', u.density);
      return { ui: { ...s.ui, ...u } };
    }),
}));
