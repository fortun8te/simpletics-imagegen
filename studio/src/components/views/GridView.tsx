// Grid view (container). Reads the batch state + relevant UI flags from the store and lays the batch
// out as: ad section → variation row → a responsive grid of slot cards (one per slot of every prompt).
// Honors `density`, `showArchived`, the active `gridTab` (status filter) and `gridQuery` (search) —
// both now live in the store so the TopBar can host the tab pills + search input above the grid.
// Leaves take props; this container does the reading + filtering.
import { useMemo } from 'react';
import { useStore } from '../../store';
import SlotCard from '../SlotCard';
import AdSection from '../AdSection';
import VariationRow from '../VariationRow';
import { EmptyState } from '../EmptyState';
import { Icon } from '../Icon';
import { api } from '../../api';
import type { AdNode, Slot, SlotStatus } from '../../types';
import { variationRelDir } from '../../paths';
import styles from './GridView.module.css';

// Mirror of TopBar's status mapping (kept identical here to avoid a cross-file import cycle).
const TAB_STATUSES: Record<string, SlotStatus[] | null> = {
  all: null,
  generating: ['generating', 'queued'],
  done: ['done'],
  failed: ['failed'],
  archived: ['archived'],
};

export default function GridView() {
  const state = useStore((s) => s.state);
  const brand = useStore((s) => s.brand);
  const batch = useStore((s) => s.batch);
  const density = useStore((s) => s.ui.density);
  const showArchived = useStore((s) => s.ui.showArchived);
  const gridTab = useStore((s) => s.ui.gridTab);
  const gridQuery = useStore((s) => s.ui.gridQuery);

  // Per-slot visibility: a status tab forces a status match; otherwise the archive toggle applies.
  const allowed = TAB_STATUSES[gridTab];
  const visible = (slot: Slot): boolean => {
    if (allowed) return allowed.includes(slot.status);
    if (slot.status === 'archived' && !showArchived) return false;
    return true;
  };

  // Filter ads by the in-batch search (ad title/id/type, variation label/id/path, prompt id) AND the
  // active tab. Empty ads/variations/prompts collapse out so a tab never shows ghost sections.
  const q = gridQuery.trim().toLowerCase();
  const ads = useMemo<AdNode[]>(() => {
    if (!state) return [];
    return state.ads
      .map((ad) => {
        const adHit = !q || `${ad.title ?? ''} ${ad.id} ${ad.type ?? ''}`.toLowerCase().includes(q);
        const variations = ad.variations
          .map((v) => {
            const path = brand && batch
              ? variationRelDir(
                  brand,
                  batch,
                  ad.id,
                  v.id,
                  v.prompts.length === 1 ? v.prompts[0].id : undefined,
                )
              : `${ad.id}/${v.id}`;
            const vHit = adHit || !q ||
              `${path} ${v.label ?? ''} ${v.id} ${v.prompts.map((p) => p.id).join(' ')}`
                .toLowerCase()
                .includes(q);
            if (!vHit) return null;
            const prompts = v.prompts
              .map((p) => ({ ...p, slots: p.slots.filter(visible) }))
              .filter((p) => p.slots.length > 0);
            return prompts.length ? { ...v, prompts } : null;
          })
          .filter((v): v is NonNullable<typeof v> => v !== null);
        return variations.length ? { ...ad, variations } : null;
      })
      .filter((ad): ad is NonNullable<typeof ad> => ad !== null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, q, gridTab, showArchived, brand, batch]);

  if (!state) return null;

  // Compact (default) packs tiles tighter; comfortable gives them room.
  const minPx = density === 'compact' ? 156 : 208;
  const gridStyle = {
    gridTemplateColumns: `repeat(auto-fill, minmax(${minPx}px, 1fr))`,
  };

  // Enqueue one more variant for a whole variation (append — does not overwrite existing slots).
  const genMore = (ad: string, variation: string) =>
    brand && batch && api.generate(brand, batch, { variation: { ad, variation } }, 1);

  const emptyTitle = q
    ? 'No matches'
    : gridTab !== 'all'
      ? `No ${gridTab} slots`
      : 'Nothing to show';
  const emptyHint = q
    ? `Nothing in this batch matches “${gridQuery.trim()}”.`
    : gridTab !== 'all'
      ? `No slots with status “${gridTab}” in this batch.`
      : 'This batch has no ads yet.';

  return (
    <div className={styles.grid}>
      <div className={styles.sections}>
        {ads.map((ad) => (
          <AdSection key={ad.id} title={ad.title || ad.id} type={ad.type}>
            {ad.variations.map((variation) => {
              const multiPrompt = variation.prompts.length > 1;
              return (
                <VariationRow
                  key={variation.id}
                  path={
                    brand && batch
                      ? variationRelDir(
                          brand,
                          batch,
                          ad.id,
                          variation.id,
                          variation.prompts.length === 1 ? variation.prompts[0].id : undefined,
                        )
                      : `${ad.id}/${variation.id}`
                  }
                >
                  {variation.prompts.map((prompt, i) => {
                    const slots = prompt.slots;
                    const isLastPrompt = i === variation.prompts.length - 1;
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
                          {isLastPrompt ? (
                            <button
                              type="button"
                              className={styles.genMore}
                              data-density={density}
                              onClick={() => genMore(ad.id, variation.id)}
                              title="Add one new variant to this variation — existing images are kept"
                              aria-label="Add one new variant to this variation — existing images are kept"
                            >
                              <span className={styles.genMoreInner}>
                                <Icon name="plus" size={density === 'compact' ? 18 : 22} />
                                <span className={styles.genMoreLabel}>Add variant</span>
                              </span>
                            </button>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                </VariationRow>
              );
            })}
          </AdSection>
        ))}
      </div>

      {ads.length === 0 ? (
        <EmptyState icon="photo" title={emptyTitle} hint={emptyHint} />
      ) : null}
    </div>
  );
}
