import type { Density } from '../store';
import { Icon } from './Icon';
import styles from './GenerateTile.module.css';

interface GenerateTileProps {
  label: string;
  ariaLabel: string;
  density: Density;
  onClick: () => void;
}

/** Dashed square affordance — empty slot (“Generate”) or add-variant tray (“Add variant”). */
export function GenerateTile({ label, ariaLabel, density, onClick }: GenerateTileProps) {
  return (
    <div className={styles.tile} data-density={density}>
      <button type="button" className={styles.btn} onClick={onClick} aria-label={ariaLabel}>
        <span className={styles.plusBadge}>
          <Icon name="plus" size={18} />
        </span>
        <span className={styles.label}>{label}</span>
      </button>
    </div>
  );
}
