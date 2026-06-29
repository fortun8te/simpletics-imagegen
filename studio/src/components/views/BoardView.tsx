// BoardView (container) — a Kanban of slots across the whole batch.
// Four columns: Queued / Generating / Done / Failed. Each slot is placed in the
// column that matches its status. `empty` slots are omitted; `archived` slots are
// hidden unless `ui.showArchived`. Containers read the store directly.
import { useStore } from '../../store';
import type { BatchState, Slot, SlotStatus } from '../../types';
import { Thumb } from '../Thumb';
import { StatusPill } from '../StatusPill';
import { Icon } from '../Icon';
import styles from './BoardView.module.css';

// A slot annotated with its position in the ad → variation → prompt tree.
interface FlatSlot {
  slot: Slot;
  ad: string;
  variation: string;
  prompt: string;
  key: string;
}

// Flatten state.ads[].variations[].prompts[].slots[] into a single list.
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

// The four board columns, in order. Each maps to a single slot status.
const COLUMNS: { status: Exclude<SlotStatus, 'empty' | 'archived'>; name: string }[] = [
  { status: 'queued', name: 'Queued' },
  { status: 'generating', name: 'Generating' },
  { status: 'done', name: 'Done' },
  { status: 'failed', name: 'Failed' },
];

export default function BoardView() {
  const state = useStore((s) => s.state);
  const showArchived = useStore((s) => s.ui.showArchived);
  const setUI = useStore((s) => s.setUI);

  const slots = flatten(state).filter((f) => {
    if (f.slot.status === 'empty') return false;
    if (f.slot.status === 'archived') return showArchived;
    return true;
  });

  return (
    <div className={styles.board}>
      {COLUMNS.map((col) => {
        // `done` also surfaces archived slots (when shown) so nothing disappears.
        const items =
          col.status === 'done'
            ? slots.filter((f) => f.slot.status === 'done' || f.slot.status === 'archived')
            : slots.filter((f) => f.slot.status === col.status);

        return (
          <section key={col.status} className={styles.column} aria-label={col.name}>
            <header className={styles.header}>
              <span className={styles.colName}>{col.name}</span>
              <span className={styles.count}>{items.length}</span>
            </header>

            <div className={styles.cards}>
              {items.length === 0 ? (
                <p className={styles.empty}>Nothing here</p>
              ) : (
                items.map((f) => <BoardCard key={f.key} item={f} onOpen={setUI} />)
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}

// One compact tile. `done`/`archived` show a thumbnail; others show a status icon.
function BoardCard({
  item,
  onOpen,
}: {
  item: FlatSlot;
  onOpen: (u: { drawerRel: string }) => void;
}) {
  const { slot, ad, variation } = item;
  const isImage = (slot.status === 'done' || slot.status === 'archived') && !!slot.relPath;
  const archived = slot.status === 'archived';

  if (isImage) {
    return (
      <button
        type="button"
        className={`${styles.card} ${styles.cardImage} ${archived ? styles.cardArchived : ''}`}
        onClick={() => onOpen({ drawerRel: slot.relPath! })}
        aria-label={`Open ${ad} / ${variation}`}
      >
        <div className={styles.thumb}>
          <Thumb relPath={slot.relPath!} alt={`${ad} / ${variation}`} />
        </div>
        <div className={styles.meta}>
          <span className={styles.coords}>
            {ad} / {variation}
          </span>
          <StatusPill status={slot.status} />
        </div>
      </button>
    );
  }

  // queued / generating / failed — icon + label + status, no image.
  const icon =
    slot.status === 'generating' ? 'loader' : slot.status === 'failed' ? 'alert' : 'clock';

  return (
    <div className={`${styles.card} ${styles[slot.status] ?? ''}`}>
      <span className={`${styles.icon} ${slot.status === 'generating' ? styles.spin : ''}`}>
        <Icon name={icon} size={16} />
      </span>
      <div className={styles.meta}>
        <span className={styles.coords}>
          {ad} / {variation}
        </span>
        <StatusPill status={slot.status} />
      </div>
    </div>
  );
}
