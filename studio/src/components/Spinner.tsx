// Spinning loader glyph. Only mount while something is actually running.
// A single open arc with a rounded cap rotating clockwise — the steady linear
// rotation is the smoothness. Reduced motion is honored in the CSS module.
import { Icon } from './Icon';
import styles from './Spinner.module.css';

export function Spinner({ size = 16 }: { size?: number }) {
  return (
    <span className={styles.spin} role="status" aria-label="Loading">
      <Icon name="loader" size={size} strokeWidth={1.4} />
    </span>
  );
}
