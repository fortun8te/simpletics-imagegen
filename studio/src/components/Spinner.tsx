// Spinning loader glyph. Only mount while something is actually running.
// Reduced-motion is honored in the CSS module (no rotation).
import { Icon } from './Icon';
import styles from './Spinner.module.css';

export function Spinner({ size = 16 }: { size?: number }) {
  return (
    <span className={styles.spin} role="status" aria-label="Loading">
      <Icon name="loader" size={size} />
    </span>
  );
}
