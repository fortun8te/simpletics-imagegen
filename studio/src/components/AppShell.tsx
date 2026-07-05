// App shell (container). Pure layout: a CSS grid with the sidebar as a fixed-width column (its own
// overflow) in column 1, the top bar in row 1 / col 2, and an INDEPENDENT scroll container <main> in
// row 2 / col 2 (overflow:auto; min-width:0) holding a max-width content rail. Because <main> owns its
// own scroll + min-width:0, the batch grid wraps inside it and can never underflow the sidebar, and
// titles never clip.
// The overlays (activity dock, detail drawer, settings) mount once at the end.
// A single Tooltip.Provider wraps the whole tree so card/icon tooltips work app-wide.
import * as Tooltip from '@radix-ui/react-tooltip';
import AppAura from './AppAura';
import Sidebar from './Sidebar';
import TopBar from './TopBar';
import BatchView from './BatchView';
import ActivityDock from './ActivityDock';
import StatusBanner from './StatusBanner';
import DetailDrawer from './DetailDrawer';
import SettingsDialog from './SettingsDialog';
import GenerateDialog from './GenerateDialog';
import styles from './AppShell.module.css';
import { useState, useCallback } from 'react';
import { useStore } from '../store';
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';

const SIDEBAR_KEY = 'neuegen.sidebarCollapsed';

export default function AppShell() {
  useKeyboardShortcuts();
  // Sidebar fold state — kept local (not in the shared store, which another surface owns) and
  // persisted so a collapsed rail survives reloads. The grid column width reflows off this.
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem(SIDEBAR_KEY) === '1'; } catch { return false; }
  });
  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((c) => {
      const next = !c;
      try { localStorage.setItem(SIDEBAR_KEY, next ? '1' : '0'); } catch { /* private mode */ }
      return next;
    });
  }, []);
  // Design mode is a full-height editor (its own internal scroll regions) — the outer <main>
  // must NOT page-scroll in that mode or the editor's bottom chrome clips. Every other pane is a
  // normal scrolling document. This flag flips <main> between "fill + no page scroll" and "scroll".
  const designMode = useStore((s) => s.ui.batchViewMode === 'design');
  return (
    <Tooltip.Provider delayDuration={500} skipDelayDuration={200}>
      {/* Live WebGL background behind the whole app — theme-aware (AppAura reads the theme and swaps
          to a light palette in light mode). Panels are glass overlays on top in both themes. */}
      <AppAura />
      <div className={styles.shell} data-sidebar={sidebarCollapsed ? 'rail' : 'full'}>
        <Sidebar collapsed={sidebarCollapsed} onToggle={toggleSidebar} />
        <TopBar />
        <main className={styles.main} data-fill={designMode || undefined}>
          <div className={styles.rail} data-fill={designMode || undefined}>
            <BatchView />
          </div>
        </main>
      </div>

      {/* Portaled overlays live outside the grid so they never share a stacking context with TopBar. */}
      <StatusBanner />
      <ActivityDock />
      <DetailDrawer />
      <SettingsDialog />
      <GenerateDialog />
    </Tooltip.Provider>
  );
}
