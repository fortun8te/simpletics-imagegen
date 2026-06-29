// TopBar (container) — breadcrumb + view switch + filter + density + stop + generate.
// Reads brand/batch/ui/config via store selectors; calls store actions + api.
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Icon } from './Icon';
import { useStore } from '../store';
import type { View } from '../store';
import { api } from '../api';
import s from './TopBar.module.css';

const VIEWS: { id: View; label: string; icon: string }[] = [
  { id: 'grid', label: 'Grid', icon: 'layout-grid' },
  { id: 'board', label: 'Board', icon: 'columns' },
  { id: 'table', label: 'Table', icon: 'table' },
];

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

  return (
    <header className={s.bar}>
      <nav className={s.crumb} aria-label="Location">
        <span className={s.brand}>{brandName}</span>
        <span className={s.slash} aria-hidden>/</span>
        <span className={s.batch}>{batchName}</span>
      </nav>

      <div className={s.right}>
        {/* View switch — segmented control */}
        <div className={s.segment} role="tablist" aria-label="View">
          {VIEWS.map((v) => {
            const active = ui.view === v.id;
            return (
              <button
                key={v.id}
                type="button"
                role="tab"
                aria-selected={active}
                className={`${s.seg} ${active ? s.segActive : ''}`}
                onClick={() => setUI({ view: v.id })}
                title={v.label}
              >
                <Icon name={v.icon} size={15} />
                <span>{v.label}</span>
              </button>
            );
          })}
        </div>

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
          className={s.ghost}
          onClick={() => setUI({ density: densityNext })}
          title={`Switch to ${densityNext}`}
          aria-label={`Density: ${ui.density}. Switch to ${densityNext}.`}
        >
          <Icon name="sliders" size={15} />
          <span>{ui.density === 'comfortable' ? 'Comfortable' : 'Compact'}</span>
        </button>

        {/* Stop — cancel everything */}
        <button
          type="button"
          className={s.ghost}
          onClick={() => api.cancel({ all: true })}
          title="Stop all generation"
        >
          <Icon name="stop" size={15} />
          <span>Stop</span>
        </button>

        {/* Generate — primary */}
        <button
          type="button"
          className={s.generate}
          onClick={() => setUI({ genOpen: true })}
        >
          <Icon name="sparkles" size={15} />
          <span>Generate</span>
          <Icon name="chevron-down" size={14} className={s.caret} />
        </button>
      </div>
    </header>
  );
}
