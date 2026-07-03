// Grid view — ad → variation → prompt → slot cards.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../store';
import SlotCard from '../SlotCard';
import AdSection from '../AdSection';
import VariationRow from '../VariationRow';
import { EmptyState } from '../EmptyState';
import { GenerateTile } from '../GenerateTile';
import { api } from '../../api';
import type { AdNode, Slot } from '../../types';
import { variationRelDir } from '../../paths';
import styles from './GridView.module.css';

export default function GridView() {
  const state = useStore((s) => s.state);
  const brand = useStore((s) => s.brand);
  const batch = useStore((s) => s.batch);
  const density = useStore((s) => s.ui.density);
  const showArchived = useStore((s) => s.ui.showArchived);
  // Same search field as Plan (ui.planQuery, shown in the TopBar for both views) — here it
  // filters by ad title/id/type/kind and variation label/id, since the grid doesn't carry
  // full prompt text the way the Plan spec does.
  const query = useStore((s) => s.ui.planQuery);

  const visible = (slot: Slot): boolean =>
    slot.status !== 'archived' || showArchived;

  const ads = useMemo<AdNode[]>(() => {
    if (!state) return [];
    const q = query.trim().toLowerCase();
    return state.ads
      .map((ad) => {
        const adHit = !q || `${ad.title ?? ''} ${ad.id} ${ad.type ?? ''}`.toLowerCase().includes(q);
        const variations = ad.variations
          .map((v) => {
            const vHit = adHit || `${v.label ?? ''} ${v.id}`.toLowerCase().includes(q);
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
  }, [state, showArchived, query]);

  // Scroll-tracked ad cursor for the TopBar — same observer recipe as PlanView, so
  // "which ad am I on" reads identically in Images and Plan.
  const setUI = useStore((s) => s.setUI);
  const [activeAdId, setActiveAdId] = useState<string | null>(null);
  const sectionRefs = useRef(new Map<string, HTMLElement>());

  useEffect(() => {
    const nodes = [...sectionRefs.current.values()];
    if (!nodes.length) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio);
        const top = visible[0]?.target.getAttribute('data-ad-id');
        if (top) setActiveAdId(top);
      },
      { root: null, rootMargin: '-72px 0px -62% 0px', threshold: [0.12, 0.35] },
    );
    for (const node of nodes) observer.observe(node);
    return () => observer.disconnect();
  }, [ads]);

  useEffect(() => {
    const idx = Math.max(0, ads.findIndex((a) => a.id === activeAdId));
    const ad = ads[idx];
    setUI({ adCursor: ad ? { index: idx, total: ads.length, title: ad.title || ad.id } : null });
  }, [activeAdId, ads, setUI]);
  useEffect(() => () => { useStore.getState().setUI({ adCursor: null }); }, []);

  if (!state) return null;

  const minPx = density === 'compact' ? 156 : 208;
  const gridStyle = {
    gridTemplateColumns: `repeat(auto-fill, minmax(${minPx}px, 1fr))`,
  };

  const genMore = (ad: string, variation: string, prompt: string) =>
    brand && batch && api.generate(brand, batch, { prompt: { ad, variation, prompt } }, 1);

  return (
    <div className={styles.grid}>
      <div className={styles.sections}>
        {ads.map((ad) => (
          <div
            key={ad.id}
            data-ad-id={ad.id}
            ref={(el) => {
              if (el) sectionRefs.current.set(ad.id, el);
              else sectionRefs.current.delete(ad.id);
            }}
          >
          <AdSection adId={ad.id} title={ad.title || ad.id} type={ad.type}>
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
                </VariationRow>
              );
            })}
          </AdSection>
          </div>
        ))}
      </div>

      {ads.length === 0 ? (
        query.trim() ? (
          <EmptyState icon="search" title="No matches" hint={`Nothing matches "${query.trim()}".`} />
        ) : (
          <EmptyState
            icon="photo"
            title="Nothing to show"
            hint="This batch has no ads yet."
          />
        )
      ) : null}
    </div>
  );
}
