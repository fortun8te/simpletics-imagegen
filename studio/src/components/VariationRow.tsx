// Presentational row for one variation. Shows the render-directory path for the variation
// (and prompt when there is only one). Props only — no store access.
import type { ReactNode } from 'react';
import styles from './VariationRow.module.css';

interface VariationRowProps {
  path: string;
  children: ReactNode;
}

export default function VariationRow({ path, children }: VariationRowProps) {
  return (
    <div className={styles.row}>
      <div className={styles.label}>
        <span className={styles.path}>{path}</span>
      </div>
      {children}
    </div>
  );
}
