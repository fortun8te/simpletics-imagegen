// TableView (container) — a dense, one-row-per-slot table of the whole batch.
// Columns: Ad · Variation · Prompt · Version · Status · Actions. Hairline row
// borders, hover highlight, no zebra. Respects ui.showArchived + ui.filterStatus.
import { useStore } from '../../store';
import { api } from '../../api';
import type { BatchState, Slot } from '../../types';
import { StatusPill } from '../StatusPill';
import { Icon } from '../Icon';
import styles from './TableView.module.css';

interface FlatSlot {
  slot: Slot;
  ad: string;
  variation: string;
  prompt: string;
  key: string;
}

// Flatten state.ads[].variations[].prompts[].slots[] into a single list,
// each annotated with its { ad, variation, prompt } coords.
function flatten(state: BatchState | null): FlatSlot[] {
  if (!state) return [];
  const out: FlatSlot[] = [];
  for (const ad of state.ads) {
    for (const variation of ad.variations) {
      for (const prompt of variation.prompts) {
        for (const slot of prompt.slots) {
          out.push({
            slot,
            ad: ad.id,
            variation: variation.id,
            prompt: prompt.id,
            key: `${ad.id}/${variation.id}/${prompt.id}/${slot.run}/${slot.version ?? 1}`,
          });
        }
      }
    }
  }
  return out;
}

export default function TableView() {
  const state = useStore((s) => s.state);
  const showArchived = useStore((s) => s.ui.showArchived);
  const filterStatus = useStore((s) => s.ui.filterStatus);
  const setUI = useStore((s) => s.setUI);

  const rows = flatten(state).filter((f) => {
    if (f.slot.status === 'archived' && !showArchived) return false;
    if (filterStatus && f.slot.status !== filterStatus) return false;
    return true;
  });

  return (
    <div className={styles.wrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Ad</th>
            <th>Variation</th>
            <th>Prompt</th>
            <th className={styles.center}>Version</th>
            <th>Status</th>
            <th className={styles.actionsHead}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={6} className={styles.emptyCell}>
                No slots to show
              </td>
            </tr>
          ) : (
            rows.map((f) => <Row key={f.key} item={f} setUI={setUI} />)
          )}
        </tbody>
      </table>
    </div>
  );
}

function Row({
  item,
  setUI,
}: {
  item: FlatSlot;
  setUI: (u: { drawerRel: string }) => void;
}) {
  const { slot, ad, variation, prompt } = item;
  const hasPath = !!slot.relPath;
  const archived = slot.status === 'archived';

  return (
    <tr className={archived ? styles.rowArchived : ''}>
      <td className={styles.ink}>{ad}</td>
      <td>{variation}</td>
      <td>{prompt}</td>
      <td className={styles.center}>{slot.version != null ? `v${slot.version}` : '—'}</td>
      <td>
        <StatusPill status={slot.status} />
      </td>
      <td>
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.iconBtn}
            aria-label="Regenerate"
            title="Regenerate"
            disabled={!hasPath}
            onClick={() => hasPath && api.regenerate(slot.relPath!)}
          >
            <Icon name="refresh" size={15} />
          </button>
          <button
            type="button"
            className={styles.iconBtn}
            aria-label={archived ? 'Restore' : 'Archive'}
            title={archived ? 'Restore' : 'Archive'}
            disabled={!hasPath}
            onClick={() => hasPath && api.archive(slot.relPath!, !archived)}
          >
            <Icon name={archived ? 'restore' : 'archive'} size={15} />
          </button>
          <button
            type="button"
            className={styles.iconBtn}
            aria-label="Expand"
            title="Expand"
            disabled={!hasPath}
            onClick={() => hasPath && setUI({ drawerRel: slot.relPath! })}
          >
            <Icon name="expand" size={15} />
          </button>
        </div>
      </td>
    </tr>
  );
}
