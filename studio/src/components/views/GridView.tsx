// Grid view (container). Reads the batch state + relevant UI flags from the store and lays the batch
// out as: a slim search header → ad section → variation row → a responsive grid of slot cards (one
// per slot of every prompt). Honors `density` (card min width) and `showArchived`. No editorial hero.
// Leaves take props; this container does the reading.
import { useMemo, useState } from 'react';
import { useStore } from '../../store';
import SlotCard from '../SlotCard';
import AdSection from '../AdSection';
import VariationRow from '../VariationRow';
import { EmptyState } from '../EmptyState';
import { Icon } from '../Icon';
import { api } from '../../api';
import type { Slot } from '../../types';
import { variationRelDir } from '../../paths';
import styles from './GridView.module.css';

export default function GridView() {
  const state = useStore((s) => s.state);
  const brand = useStore((s) => s.brand);
  const batch = useStore((s) => s.batch);
  const density = useStore((s) => s.ui.density);
  const showArchived = useStore((s) => s.ui.showArchived);
  const [query, setQuery] = useState('');

  // Filter ads by the in-batch search: match ad title/id, or any variation label/id, or prompt id.
  const q = query.trim().toLowerCase();
  const ads = useMemo(() => {
    if (!state) return [];
    if (!q) return state.ads;
    return state.ads
      .map((ad) => {
        const adHit = `${ad.title ?? ''} ${ad.id} ${ad.type ?? ''}`.toLowerCase().includes(q);
        if (adHit) return ad;
        const variations = ad.variations.filter((v) => {
          const path = brand && batch
            ? variationRelDir(
                brand,
                batch,
                ad.id,
                v.id,
                v.prompts.length === 1 ? v.prompts[0].id : undefined,
              )
            : `${ad.id}/${v.id}`;
          return `${path} ${v.label ?? ''} ${v.id} ${v.prompts.map((p) => p.id).join(' ')}`
            .toLowerCase()
            .includes(q);
        });
        return variations.length ? { ...ad, variations } : null;
      })
      .filter((ad): ad is NonNullable<typeof ad> => ad !== null);
  }, [state, q, brand, batch]);

  if (!state) return null;

  // Decide whether a single slot should render given the active archive setting (filter is gone).
  const visible = (slot: Slot): boolean => {
    if (slot.status === 'archived' && !showArchived) return false;
    return true;
  };

  // Compact (default) packs tiles tighter; comfortable gives them room.
  const minPx = density === 'compact' ? 156 : 208;
  const gridStyle = {
    gridTemplateColumns: `repeat(auto-fill, minmax(${minPx}px, 1fr))`,
  };

  // Enqueue one more variant for a whole variation (the obvious "generate more" affordance).
  const genMore = (ad: string, variation: string) =>
    brand && batch && api.generate(brand, batch, { variation: { ad, variation } }, 1);

  return (
    <div className={styles.grid}>
      <div className={styles.search}>
        <Icon name="search" size={15} />
        <input
          type="search"
          className={styles.searchInput}
          placeholder="Search ads, variations…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search within this batch"
        />
        {q ? <span className={styles.searchCount}>{ads.length} match{ads.length === 1 ? '' : 'es'}</span> : null}
      </div>

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
                    const slots = prompt.slots.filter(visible);
                    // Append the "Generate more" tile to the last prompt group so it lands at the
                    // very end of the variation's row of images.
                    const isLastPrompt = i === variation.prompts.length - 1;
                    if (!slots.length && !isLastPrompt) return null;
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
                              aria-label="Generate more images for this variation"
                            >
                              <span className={styles.genMoreInner}>
                                <Icon name="plus" size={density === 'compact' ? 18 : 22} />
                                <span className={styles.genMoreLabel}>Generate more</span>
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
        <EmptyState
          icon="photo"
          title={q ? 'No matches' : 'Nothing to show'}
          hint={q ? `Nothing in this batch matches “${query.trim()}”.` : 'This batch has no ads yet.'}
        />
      ) : null}
    </div>
  );
}
