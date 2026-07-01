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
import DetailDrawer from './DetailDrawer';
import SettingsDialog from './SettingsDialog';
import GenerateDialog from './GenerateDialog';
import styles from './AppShell.module.css';

export default function AppShell() {
  return (
    <Tooltip.Provider delayDuration={500} skipDelayDuration={200}>
      {/* Live WebGL background behind the whole app — theme-aware (AppAura reads the theme and swaps
          to a light palette in light mode). Panels are glass overlays on top in both themes. */}
      <AppAura />
      <div className={styles.shell}>
        <Sidebar />
        <TopBar />
        <main className={styles.main}>
          <div className={styles.rail}>
            <BatchView />
          </div>
        </main>
      </div>

      {/* Portaled overlays live outside the grid so they never share a stacking context with TopBar. */}
      <ActivityDock />
      <DetailDrawer />
      <SettingsDialog />
      <GenerateDialog />
    </Tooltip.Provider>
  );
}
