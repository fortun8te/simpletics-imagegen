// Presentational section wrapper for one ad. Header (eyebrow + display-font title + a quiet
// `type` tag pill) over its children (the variation rows / slot grids). Props only — no store access.
import type { ReactNode } from 'react';
import styles from './AdSection.module.css';

interface AdSectionProps {
  title: string;
  type?: string;
  children: ReactNode;
}

export default function AdSection({ title, type, children }: AdSectionProps) {
  return (
    <section className={styles.section}>
      <header className={styles.header}>
        <span className={styles.eyebrow}>Ad</span>
        <div className={styles.titleRow}>
          <h2 className={styles.title}>{title}</h2>
          {type ? <span className={styles.tag}>{type}</span> : null}
        </div>
      </header>
      <div className={styles.body}>{children}</div>
    </section>
  );
}
