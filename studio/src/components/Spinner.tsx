// Spinning loader glyph. Only mount while something is actually running.
// Reduced-motion is honored in the CSS module (no rotation). Per-spoke
// opacities are refined here (the Icon's defaults are not a smooth fade).
import { Icon } from './Icon';
import styles from './Spinner.module.css';

export function Spinner({ size = 16 }: { size?: number }) {
  return (
    <span className={styles.spin} role="status" aria-label="Loading">
      <Icon name="loader" size={size} strokeWidth={1.4} className={styles.glyph} />
    </span>
  );
}
