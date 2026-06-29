// Grid view (container). Reads the batch state + relevant UI flags from the store and lays the batch
// out as: ad section → variation row → a responsive grid of slot cards (one per slot of every prompt).
// Honors `density` (card min width), `showArchived` (hide archived slots), and `filterStatus`
// (show only slots whose status matches). Leaves take props; this container does the reading.
import { useStore } from '../../store';
import SlotCard from '../SlotCard';
import AdSection from '../AdSection';
import VariationRow from '../VariationRow';
import { EmptyState } from '../EmptyState';
import type { Slot } from '../../types';
import styles from './GridView.module.css';

export default function GridView() {
  const state = useStore((s) => s.state);
  const density = useStore((s) => s.ui.density);
  const showArchived = useStore((s) => s.ui.showArchived);
  const filterStatus = useStore((s) => s.ui.filterStatus);

  if (!state) return null;

  // Decide whether a single slot should render given the active archive + status filters.
  const visible = (slot: Slot): boolean => {
    if (slot.status === 'archived' && !showArchived) return false;
    if (filterStatus && slot.status !== filterStatus) return false;
    return true;
  };

  const minPx = density === 'compact' ? 132 : 188;
  const gridStyle = {
    gridTemplateColumns: `repeat(auto-fill, minmax(${minPx}px, 1fr))`,
  };

  return (
    <div className={styles.grid}>
      {state.ads.map((ad) => (
        <AdSection key={ad.id} title={ad.title || ad.id} type={ad.type}>
          {ad.variations.map((variation) => {
            const multiPrompt = variation.prompts.length > 1;
            return (
              <VariationRow key={variation.id} id={variation.id} label={variation.label}>
                {variation.prompts.map((prompt) => {
                  const slots = prompt.slots.filter(visible);
                  if (!slots.length) return null;
                  return (
                    <div key={prompt.id} className={styles.promptGroup}>
                      {multiPrompt ? <div className={styles.promptLabel}>{prompt.id}</div> : null}
                      <div className={styles.slots} style={gridStyle}>
                        {slots.map((slot) => (
                          <SlotCard
                            key={`${slot.run}-${slot.version ?? 1}`}
                            slot={slot}
                            ad={ad.id}
                            variation={variation.id}
                            prompt={prompt.id}
                            density={density}
                          />
                        ))}
                      </div>
                    </div>
                  );
                })}
              </VariationRow>
            );
          })}
        </AdSection>
      ))}

      {state.ads.length === 0 ? (
        <EmptyState
          icon="photo"
          title="Nothing to show"
          hint="This batch has no ads yet."
        />
      ) : null}
    </div>
  );
}
