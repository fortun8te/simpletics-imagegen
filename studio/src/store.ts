// Global UI + data store (Zustand). Components read slices; App owns fetching and calls setState.
import { create } from 'zustand';
import type { Config, BatchState } from './types';

export type View = 'grid' | 'board' | 'table';
export type Density = 'comfortable' | 'compact';

export interface UIState {
  view: View;
  density: Density;
  showArchived: boolean;
  drawerRel: string | null;   // relPath of the slot shown in the detail drawer, or null
  genOpen: boolean;           // GenerateDialog open
  filterStatus: string | null;
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

export const useStore = create<Store>((set) => ({
  config: { brands: [] },
  brand: null,
  batch: null,
  state: null,
  loading: false,
  ui: {
    view: 'grid',
    density: 'comfortable',
    showArchived: false,
    drawerRel: null,
    genOpen: false,
    filterStatus: null,
  },

  setConfig: (config) => set({ config }),
  select: (brand, batch) =>
    set((s) => ({ brand, batch, state: null, loading: true, ui: { ...s.ui, drawerRel: null } })),
  setState: (state) => set({ state, loading: false }),
  setLoading: (loading) => set({ loading }),
  setUI: (u) => set((s) => ({ ui: { ...s.ui, ...u } })),
}));
