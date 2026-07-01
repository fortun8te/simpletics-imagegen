// Global UI + data store (Zustand). Components read slices; App owns fetching and calls setState.
// Single dark theme (no toggle), no view switch, no filter — see V3-PLAN.md.
import { create } from 'zustand';
import type { Config, BatchState, CodexUsage, Blockers, GenSettings, BatchViewMode } from './types';
import { refreshAccentDerivatives } from './lib/accent';

export type { BatchViewMode } from './types';
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
  settingsSection: 'appearance' | 'library' | 'system' | null; // deep-link a Settings section on open
  activityOpen: boolean;      // Activity panel pinned open
  batchViewMode: BatchViewMode; // gallery = image grid, plan = creative spec from config
}

interface Store {
  config: Config;
  brand: string | null;
  batch: string | null;
  state: BatchState | null;   // current batch state (null until first load)
  loading: boolean;
  ui: UIState;
  // Global generation-system signals, sourced from /api/health (and mirrored in /api/state). Kept at
  // the top level — not just inside `state` — so the StatusBanner + UsageChip stay live even when no
  // batch is selected, and update on the health poll independent of the per-batch state fetch.
  codexUsage: CodexUsage | null;
  blockers: Blockers | null;
  settings: GenSettings | null; // gen settings (graceSeconds + budget), fetched from /api/settings

  setConfig: (c: Config) => void;
  select: (brand: string, batch: string) => void;
  setState: (s: BatchState) => void;
  setLoading: (b: boolean) => void;
  setUI: (u: Partial<UIState>) => void;
  setUsage: (u: CodexUsage | null) => void;
  setBlockers: (b: Blockers | null) => void;
  setSettings: (s: GenSettings | null) => void;
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
  codexUsage: null,
  blockers: null,
  settings: null,
  ui: {
    density: readPref<Density>('neuegen.density', 'compact'),
    theme: readPref<Theme>('neuegen.theme', 'dark'),
    accentRGB: null,
    showArchived: false,
    drawerRel: null,
    genOpen: false,
    settingsOpen: false,
    settingsSection: null,
    activityOpen: false,
    batchViewMode: readPref<BatchViewMode>('neuegen.batchViewMode', 'gallery'),
  },

  setConfig: (config) => set({ config }),
  select: (brand, batch) => {
    writePref('neuegen.lastBrand', brand);
    writePref('neuegen.lastBatch', batch);
    set((s) => ({ brand, batch, state: null, loading: true, ui: { ...s.ui, drawerRel: null } }));
  },
  setState: (state) =>
    set((s) => ({
      state,
      loading: false,
      // /api/state also carries the live usage/blockers; mirror them so the banner/chip stay fresh
      // between health polls. Fall back to the existing top-level values if this payload omits them.
      codexUsage: state.codexUsage ?? s.codexUsage,
      blockers: state.blockers ?? s.blockers,
    })),
  setLoading: (loading) => set({ loading }),
  setUI: (u) =>
    set((s) => {
      if (u.density && u.density !== s.ui.density) writePref('neuegen.density', u.density);
      if (u.batchViewMode && u.batchViewMode !== s.ui.batchViewMode) {
        writePref('neuegen.batchViewMode', u.batchViewMode);
      }
      if (u.theme && u.theme !== s.ui.theme) {
        writePref('neuegen.theme', u.theme);
        applyTheme(u.theme);
        if (s.ui.accentRGB) refreshAccentDerivatives(s.ui.accentRGB);
      }
      return { ui: { ...s.ui, ...u } };
    }),
  setUsage: (codexUsage) => set({ codexUsage }),
  setBlockers: (blockers) => set({ blockers }),
  setSettings: (settings) => set({ settings }),
}));

// Apply the persisted theme immediately on load (before first paint of themed components).
applyTheme(useStore.getState().ui.theme);
