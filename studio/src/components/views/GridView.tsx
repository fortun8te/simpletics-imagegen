// Grid view — ad → variation → prompt → slot cards.
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
import type { AdNode, Slot } from '../../types';
import { variationRelDir } from '../../paths';
import styles from './GridView.module.css';

export default function GridView() {
  const state = useStore((s) => s.state);
  const brand = useStore((s) => s.brand);
  const batch = useStore((s) => s.batch);
  const density = useStore((s) => s.ui.density);
  const showArchived = useStore((s) => s.ui.showArchived);

  const visible = (slot: Slot): boolean =>
    slot.status !== 'archived' || showArchived;

  const ads = useMemo<AdNode[]>(() => {
    if (!state) return [];
    return state.ads
      .map((ad) => {
        const variations = ad.variations
          .map((v) => {
            const prompts = v.prompts
              .map((p) => ({ ...p, slots: p.slots.filter(visible) }))
              .filter((p) => p.slots.length > 0);
            return prompts.length ? { ...v, prompts } : null;
          })
          .filter((v): v is NonNullable<typeof v> => v !== null);
        return variations.length ? { ...ad, variations } : null;
      })
      .filter((ad): ad is NonNullable<typeof ad> => ad !== null);
  }, [state, showArchived]);

  if (!state) return null;

  const minPx = density === 'compact' ? 156 : 208;
  const gridStyle = {
    gridTemplateColumns: `repeat(auto-fill, minmax(${minPx}px, 1fr))`,
  };

  const genMore = (ad: string, variation: string, prompt: string) =>
    brand && batch && api.generate(brand, batch, { prompt: { ad, variation, prompt } }, 1);

  const addTake = (ad: string, variation: string) =>
    brand && batch && api.addPrompt(brand, batch, ad, variation).then(refreshState);

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
                    const slots = prompt.slots.filter(visible);
                    return (
                      <div
                        key={prompt.id}
                        id={`gallery-${ad.id}-${variation.id}-${prompt.id}`}
                        className={styles.promptGroup}
                      >
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
                            ariaLabel={`Add one new variant to ${prompt.id}`}
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
                    title="Add another take"
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
        <EmptyState
          icon="photo"
          title="Nothing to show"
          hint="This batch has no ads yet."
        />
      ) : null}
    </div>
  );
}
