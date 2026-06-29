// TopBar (container) — breadcrumb + activity pill + filter + density + theme + stop + generate.
// Reads brand/batch/state/ui/config via store selectors; calls store actions + api.
// View switch removed (Grid is the only gallery); Stop is contextual on live queue.
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Icon } from './Icon';
import { useStore } from '../store';
import { api } from '../api';
import s from './TopBar.module.css';

// Filter options. `value` null == "All".
const FILTERS: { value: string | null; label: string }[] = [
  { value: null, label: 'All' },
  { value: 'done', label: 'Done' },
  { value: 'generating', label: 'Generating' },
  { value: 'queued', label: 'Queued' },
  { value: 'failed', label: 'Failed' },
];

export default function TopBar() {
  const brand = useStore((s) => s.brand);
  const batch = useStore((s) => s.batch);
  const config = useStore((s) => s.config);
  const queue = useStore((s) => s.state?.queue);
  const ui = useStore((s) => s.ui);
  const setUI = useStore((s) => s.setUI);

  // Resolve display names from config by current brand/batch ids.
  const brandRef = config.brands.find((b) => b.id === brand);
  const batchRef = brandRef?.batches.find((bt) => bt.code === batch);
  const brandName = brandRef?.name ?? brand ?? '—';
  const batchName = batchRef?.name ?? batch ?? '—';

  const activeFilter = FILTERS.find((f) => f.value === ui.filterStatus) ?? FILTERS[0];
  const filterActive = ui.filterStatus != null;

  const densityNext = ui.density === 'comfortable' ? 'compact' : 'comfortable';

  // Live work — drives the activity pill (when busy) and the contextual Stop button.
  const running = queue?.running ?? 0;
  const queued = queue?.queued ?? 0;
  const busy = running > 0 || queued > 0;

  const theme = ui.theme;
  const themeNext = theme === 'dark' ? 'light' : 'dark';

  return (
    <header className={s.bar}>
      <nav className={s.crumb} aria-label="Location">
        <span className={s.brand}>{brandName}</span>
        <span className={s.slash} aria-hidden>/</span>
        <span className={s.batch}>{batchName}</span>
      </nav>

      <div className={s.right}>
        {/* Activity pill — only while there is live work */}
        {busy ? (
          <button
            type="button"
            className={s.pill}
            onClick={() => setUI({ activityOpen: true })}
            title="Show activity"
          >
            <span className={s.pillDot} aria-hidden />
            <span>
              {running} running · {queued} queued
            </span>
          </button>
        ) : null}

        {/* Filter dropdown */}
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              className={`${s.ghost} ${filterActive ? s.ghostOn : ''}`}
              aria-label="Filter by status"
            >
              <Icon name="filter" size={15} />
              <span>{activeFilter.label}</span>
              <Icon name="chevron-down" size={14} className={s.caret} />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content className={s.menu} align="end" sideOffset={6}>
              {FILTERS.map((f) => {
                const selected = f.value === ui.filterStatus;
                return (
                  <DropdownMenu.Item
                    key={f.label}
                    className={s.menuItem}
                    onSelect={() => setUI({ filterStatus: f.value })}
                  >
                    <span className={s.menuCheck}>
                      {selected ? <Icon name="check" size={14} /> : null}
                    </span>
                    {f.label}
                  </DropdownMenu.Item>
                );
              })}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>

        {/* Density toggle */}
        <button
          type="button"
          className={s.iconBtn}
          onClick={() => setUI({ density: densityNext })}
          title={`Density: ${ui.density}. Switch to ${densityNext}.`}
          aria-label={`Density: ${ui.density}. Switch to ${densityNext}.`}
        >
          <Icon name="sliders" size={16} />
        </button>

        {/* Theme toggle */}
        <button
          type="button"
          className={s.iconBtn}
          onClick={() => setUI({ theme: themeNext })}
          title="Switch theme"
          aria-label={`Theme: ${theme}. Switch to ${themeNext}.`}
        >
          <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={16} />
        </button>

        {/* Stop — contextual; cancels everything, only while busy */}
        {busy ? (
          <button
            type="button"
            className={s.ghost}
            onClick={() => api.cancel({ all: true })}
            title="Stop all generation"
          >
            <Icon name="stop" size={15} />
            <span>Stop</span>
          </button>
        ) : null}

        {/* Generate — primary */}
        <button
          type="button"
          className={s.generate}
          onClick={() => setUI({ genOpen: true })}
        >
          <Icon name="sparkles" size={15} />
          <span>Generate</span>
        </button>
      </div>
    </header>
  );
}
