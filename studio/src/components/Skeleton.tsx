// Shimmer placeholder grid for loading states (use instead of spinners-everywhere).
// Subtle sweep; reduced-motion safe (sweep removed, surface stays).
import styles from './Skeleton.module.css';

export function Skeleton({ count = 6 }: { count?: number }) {
  return (
    <div className={styles.grid} aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className={styles.block} />
      ))}
    </div>
  );
}
