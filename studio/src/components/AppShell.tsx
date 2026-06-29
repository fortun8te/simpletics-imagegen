// App shell (container). Pure layout: a CSS grid with the sidebar spanning both rows in column 1,
// the top bar in row 1 / col 2, and a scrollable <main> in row 2 / col 2 that renders the batch view.
// The overlays (activity dock, detail drawer, generate dialog, settings) mount once at the end.
// A single Tooltip.Provider wraps the whole tree so card/icon tooltips work app-wide.
import * as Tooltip from '@radix-ui/react-tooltip';
import Sidebar from './Sidebar';
import TopBar from './TopBar';
import BatchView from './BatchView';
import ActivityDock from './ActivityDock';
import DetailDrawer from './DetailDrawer';
import GenerateDialog from './GenerateDialog';
import SettingsDialog from './SettingsDialog';
import styles from './AppShell.module.css';

export default function AppShell() {
  return (
    <Tooltip.Provider delayDuration={500} skipDelayDuration={200}>
      <div className={styles.shell}>
        <Sidebar />
        <TopBar />
        <main className={styles.main}>
          <BatchView />
        </main>

        <ActivityDock />
        <DetailDrawer />
        <GenerateDialog />
        <SettingsDialog />
      </div>
    </Tooltip.Provider>
  );
}
