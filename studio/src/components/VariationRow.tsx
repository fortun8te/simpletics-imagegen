// Presentational row for one variation. A small label line (`id — label`) over its children
// (the slot grid). Props only — no store access.
import type { ReactNode } from 'react';
import styles from './VariationRow.module.css';

interface VariationRowProps {
  id: string;
  label?: string;
  children: ReactNode;
}

export default function VariationRow({ id, label, children }: VariationRowProps) {
  return (
    <div className={styles.row}>
      <div className={styles.label}>
        <span className={styles.id}>{id}</span>
        {label ? <span className={styles.sep}>—</span> : null}
        {label ? <span className={styles.text}>{label}</span> : null}
      </div>
      {children}
    </div>
  );
}
