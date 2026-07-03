// BatchHero — the editorial header rendered at the top of GridView. The one "designed moment":
// a small eyebrow (BRAND · KIND), the batch NAME in the Fraunces display face, a single quiet
// line of meta (variations · images · % generated), a thin blue progress bar, and a calm row of
// flat metric chips. Reads the store directly and derives everything from the live batch state —
// never fabricates. Flat: no card glow, no radial; only theme tokens.
import { useStore } from '../store';
import styles from './BatchHero.module.css';

// Roll up the slot-level counts that the hero summarizes. Archived slots are ignored for the
// "done/total" headline so the number matches what the gallery shows.
function summarize(state: NonNullable<ReturnType<typeof useStore.getState>['state']>) {
  let images = 0; // finished, non-archived images on disk
  let done = 0;
  let total = 0;
  let variations = 0;

  for (const ad of state.ads) {
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
  return { images, done, total, variations, ads: state.ads.length };
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

  const { images, done, total, variations, ads } = summarize(state);
  const kind = kindLabel(ads, variations);
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const inProgress = Math.max(total - done, 0);

  // Eyebrow — BRAND · KIND, both honest and derivable. Uppercased in CSS.
  const eyebrow = [brandName, kind].filter(Boolean).join(' · ');

  // One quiet line of meta — the only summary sentence. Counts fold in here (no chip row).
  const meta = [
    `${variations} ${variations === 1 ? 'variation' : 'variations'}`,
    `${images} ${images === 1 ? 'image' : 'images'}`,
    inProgress > 0 ? `${inProgress} remaining` : null,
    `${pct}% generated`,
  ].filter(Boolean).join(' · ');

  return (
    <header className={styles.hero}>
      <div className={styles.text}>
        {eyebrow ? <p className={styles.eyebrow}>{eyebrow}</p> : null}
        <h1 className={styles.name}>{name}</h1>
        <p className={styles.meta}>{meta}</p>
      </div>
      <div
        className={styles.progressTrack}
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Batch generated"
      >
        <div className={styles.progressFill} style={{ width: `${pct}%` }} />
      </div>
    </header>
  );
}
