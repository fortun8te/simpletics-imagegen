// Global UI + data store (Zustand). Components read slices; App owns fetching and calls setState.
// Single dark theme (no toggle), no view switch, no filter — see V3-PLAN.md.
import { create } from 'zustand';
import type { Config, BatchState } from './types';

export type Density = 'comfortable' | 'compact';
export type Theme = 'dark' | 'light';
export type GridTab = 'all' | 'generating' | 'done' | 'failed' | 'archived';

// Accent preset color, as 0..1 linear-ish sRGB triples for AppAura's shader uniforms — kept as
// plain numbers (not a CSS string) so the live WebGL render loop never has to parse CSS. Set by
// SettingsDialog's accent picker (the single source of truth for the preset → color mapping);
// AppAura subscribes to this the same way it already subscribes to `theme` (a ref synced via
// useEffect, read live in the render loop without re-initializing GL).
export interface AccentRGB { r: number; g: number; b: number; }

export interface UIState {
  density: Density;
  theme: Theme;
  accentRGB: AccentRGB | null; // null = AppAura keeps its built-in default blue palette
  showArchived: boolean;
  drawerRel: string | null;   // relPath of the slot shown in the detail drawer, or null
  genOpen: boolean;           // GenerateDialog open
  settingsOpen: boolean;      // SettingsDialog open
  activityOpen: boolean;      // Activity panel pinned open
  gridTab: GridTab;           // active tab pill in the TopBar (filters GridView by slot status)
  gridQuery: string;          // in-batch search query, owned here so TopBar can host the search input
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

// Apply the theme to the document root so theme.css's [data-theme="light"] overrides take effect.
const applyTheme = (theme: Theme) => {
  try { document.documentElement.dataset.theme = theme; } catch { /* SSR/no-DOM */ }
};

export const useStore = create<Store>((set) => ({
  config: { brands: [] },
  brand: readPref<string | null>('neuegen.lastBrand', null),
  batch: readPref<string | null>('neuegen.lastBatch', null),
  state: null,
  loading: false,
  ui: {
    density: readPref<Density>('neuegen.density', 'compact'),
    theme: readPref<Theme>('neuegen.theme', 'dark'),
    accentRGB: null,
    showArchived: false,
    drawerRel: null,
    genOpen: false,
    settingsOpen: false,
    activityOpen: false,
    gridTab: 'all',
    gridQuery: '',
  },

  setConfig: (config) => set({ config }),
  select: (brand, batch) => {
    writePref('neuegen.lastBrand', brand);
    writePref('neuegen.lastBatch', batch);
    set((s) => ({ brand, batch, state: null, loading: true, ui: { ...s.ui, drawerRel: null } }));
  },
  setState: (state) => set({ state, loading: false }),
  setLoading: (loading) => set({ loading }),
  setUI: (u) =>
    set((s) => {
      if (u.density && u.density !== s.ui.density) writePref('neuegen.density', u.density);
      if (u.theme && u.theme !== s.ui.theme) { writePref('neuegen.theme', u.theme); applyTheme(u.theme); }
      return { ui: { ...s.ui, ...u } };
    }),
}));

// Apply the persisted theme immediately on load (before first paint of themed components).
applyTheme(useStore.getState().ui.theme);
