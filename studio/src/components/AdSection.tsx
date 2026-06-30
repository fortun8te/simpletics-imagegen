// Section wrapper for one ad. Editorial SaaS header (Claritas/Replit-style):
// a left-aligned circular icon badge + two-line text block (bold title over muted metadata),
// plus a per-ad "Add variant" action on the right that enqueues one variant across every variation.
import type { ReactNode } from 'react';
import { Icon } from './Icon';
import { useStore } from '../store';
import { api } from '../api';
import styles from './AdSection.module.css';

interface AdSectionProps {
  title: string;
  // Optional so AdSection stays buildable without a wired parent; the action is disabled
  // until a parent passes the ad id (GridView renders <AdSection title=... type=...> today).
  adId?: string;
  type?: string;
  variationCount?: number;
  imageCount?: number;
  children: ReactNode;
}

export default function AdSection({
  title,
  adId,
  type,
  variationCount,
  imageCount,
  children,
}: AdSectionProps) {
  const brand = useStore((s) => s.brand);
  const batch = useStore((s) => s.batch);

  const meta = [
    type,
    variationCount != null ? `${variationCount} variation${variationCount === 1 ? '' : 's'}` : null,
    imageCount != null ? `${imageCount} image${imageCount === 1 ? '' : 's'}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  // Scope { ads: [adId] } targets every variation in this ad; backend fills empties first, then appends.
  const addVariant = () => {
    if (brand && batch && adId) void api.generate(brand, batch, { ads: [adId] }, 1);
  };

  return (
    <section className={styles.section}>
      <header className={styles.header}>
        <span className={styles.badge} aria-hidden="true">
          <Icon name="layout-grid" size={17} strokeWidth={1.5} />
        </span>
        <div className={styles.text}>
          <h2 className={styles.title}>{title}</h2>
          {meta ? <p className={styles.sub}>{meta}</p> : null}
        </div>
        <button
          type="button"
          className={styles.addBtn}
          onClick={addVariant}
          disabled={!brand || !batch || !adId}
          title="Add one new variant to every variation in this ad — existing images are kept"
          aria-label="Add one new variant to every variation in this ad — existing images are kept"
        >
          <Icon name="plus" size={15} strokeWidth={2} />
          <span className={styles.addBtnLabel}>Add variant</span>
        </button>
      </header>
      <div className={styles.divider} aria-hidden="true" />
      <div className={styles.body}>{children}</div>
    </section>
  );
}
