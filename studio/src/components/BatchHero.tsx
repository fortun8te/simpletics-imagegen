// BatchHero — the editorial header rendered at the top of GridView. The one "designed moment":
// an eyebrow (kind · image count · variation count), the batch NAME in the Fraunces display face,
// a one-line descriptor, and compact done/total + variation stats. Reads the store directly
// (state, config, brand, batch) and derives everything from the live batch state — never fabricates.
import { useStore } from '../store';
import styles from './BatchHero.module.css';

// Roll up the slot-level counts that the hero summarizes. Archived slots are ignored for the
// "done/total" headline so the number matches what the gallery shows.
function summarize(state: NonNullable<ReturnType<typeof useStore.getState>['state']>) {
  let images = 0; // finished, non-archived images on disk
  let done = 0;
  let total = 0;
  let variations = 0;
  const adTypes = new Set<string>();

  for (const ad of state.ads) {
    if (ad.type) adTypes.add(ad.type);
    for (const variation of ad.variations) {
      variations++;
      for (const prompt of variation.prompts) {
        for (const slot of prompt.slots) {
          if (slot.status === 'archived') continue;
          total++;
          if (slot.status === 'done') {
            done++;
            images++;
          }
        }
      }
    }
  }
  return { images, done, total, variations, ads: state.ads.length, adTypes: [...adTypes] };
}

// A quiet kind label. We have no explicit `kind` in the store, so infer: a single ad whose
// variations read like list entries → "Listicle"; otherwise an "Ad batch".
function kindLabel(adCount: number, variations: number): string {
  if (adCount <= 1 && variations >= 3) return 'Listicle';
  return 'Ad batch';
}

export default function BatchHero() {
  const state = useStore((s) => s.state);
  const config = useStore((s) => s.config);
  const brand = useStore((s) => s.brand);
  const batch = useStore((s) => s.batch);

  if (!state) return null;

  const brandRef = config.brands.find((b) => b.id === brand);
  const batchRef = brandRef?.batches.find((bt) => bt.code === batch);
  const name = batchRef?.name ?? batch ?? 'Untitled batch';
  const brandName = brandRef?.name ?? brand ?? '';

  const { images, done, total, variations, ads, adTypes } = summarize(state);
  const kind = kindLabel(ads, variations);

  // Eyebrow segments — only honest, derivable facts. No "updated" timestamp is in the store.
  const eyebrow = [
    kind,
    `${images} ${images === 1 ? 'image' : 'images'}`,
    `${variations} ${variations === 1 ? 'variation' : 'variations'}`,
  ];

  // A one-line descriptor of what's in the batch.
  const typeBit = adTypes.length ? ` · ${adTypes.slice(0, 3).join(', ')}` : '';
  const descriptor = `${ads} ${ads === 1 ? 'ad' : 'ads'} across ${variations} ${
    variations === 1 ? 'variation' : 'variations'
  }${typeBit}`;

  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  return (
    <header className={styles.hero}>
      <div className={styles.glow} aria-hidden="true" />
      <div className={styles.rule} aria-hidden="true" />

      <div className={styles.eyebrow}>
        {eyebrow.map((seg, i) => (
          <span key={seg} className={styles.eyebrowSeg}>
            {i > 0 ? <span className={styles.dot} aria-hidden="true" /> : null}
            {seg}
          </span>
        ))}
      </div>

      <h1 className={styles.name}>{name}</h1>

      <p className={styles.descriptor}>
        {brandName ? <span className={styles.brand}>{brandName}</span> : null}
        {brandName ? <span className={styles.descSep} aria-hidden="true">·</span> : null}
        {descriptor}
      </p>

      <div className={styles.stats}>
        <div className={styles.stat}>
          <span className={styles.statValue}>
            {done}
            <span className={styles.statTotal}>/{total}</span>
          </span>
          <span className={styles.statLabel}>generated</span>
        </div>
        <div className={styles.statDivider} aria-hidden="true" />
        <div className={styles.stat}>
          <span className={styles.statValue}>{variations}</span>
          <span className={styles.statLabel}>variations</span>
        </div>
        <div className={styles.statDivider} aria-hidden="true" />
        <div className={styles.progressStat}>
          <div className={styles.progressTrack}>
            <div className={styles.progressFill} style={{ width: `${pct}%` }} />
          </div>
          <span className={styles.statLabel}>{pct}% complete</span>
        </div>
      </div>
    </header>
  );
}
