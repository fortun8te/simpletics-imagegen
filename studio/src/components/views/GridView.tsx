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
import { GenerateTile } from '../GenerateTile';
import { Icon } from '../Icon';
import { api } from '../../api';
import { refreshState } from '../../refresh';
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
  // Adds one more run to a SPECIFIC prompt (p1, p2, ...) — not the whole variation — so every
  // prompt row gets its own working "add variant" control, independent of the others.
  const genMore = (ad: string, variation: string, prompt: string) =>
    brand && batch && api.generate(brand, batch, { prompt: { ad, variation, prompt } }, 1);

  // Append a brand-new prompt entry (p3, p4, ...) to a variation — a genuine new "take" on the
  // concept, distinct from genMore (more runs of an EXISTING prompt). Config write only; refetch
  // state afterward so the new prompt column + its empty slot appear immediately.
  const addTake = (ad: string, variation: string) =>
    brand && batch && api.addPrompt(brand, batch, ad, variation).then(refreshState);

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
          <AdSection key={ad.id} adId={ad.id} title={ad.title || ad.id} type={ad.type}>
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
                  {variation.prompts.map((prompt) => {
                    const slots = prompt.slots;
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
                          <GenerateTile
                            label="Add variant"
                            ariaLabel={`Add one new variant to ${prompt.id} — existing images are kept`}
                            density={density}
                            onClick={() => genMore(ad.id, variation.id, prompt.id)}
                          />
                        </div>
                      </div>
                    );
                  })}
                  <button
                    type="button"
                    className={styles.addTakeBtn}
                    onClick={() => addTake(ad.id, variation.id)}
                    disabled={!brand || !batch}
                    title="Add another take — a brand-new prompt slot for this variation, starting from its last prompt"
                    aria-label="Add another take to this variation"
                  >
                    <Icon name="plus" size={13} strokeWidth={2} />
                    Add another take
                  </button>
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
