// Presentational section wrapper for one ad. Editorial SaaS header (Claritas/Replit-style):
// a left-aligned circular icon badge + two-line text block (bold title over muted metadata).
// Props only — no store access.
import type { ReactNode } from 'react';
import { Icon } from './Icon';
import styles from './AdSection.module.css';

interface AdSectionProps {
  title: string;
  type?: string;
  variationCount?: number;
  imageCount?: number;
  children: ReactNode;
}

export default function AdSection({
  title,
  type,
  variationCount,
  imageCount,
  children,
}: AdSectionProps) {
  const meta = [
    type,
    variationCount != null ? `${variationCount} variation${variationCount === 1 ? '' : 's'}` : null,
    imageCount != null ? `${imageCount} image${imageCount === 1 ? '' : 's'}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

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
      </header>
      <div className={styles.divider} aria-hidden="true" />
      <div className={styles.body}>{children}</div>
    </section>
  );
}
