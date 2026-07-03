// TextShimmer — loading-ui "text-shimmer": a readable base color with a brighter band sweeping
// across the glyphs (background-clip:text). Pure CSS, no Motion dependency. The base stays legible
// so the action text ("analysing image…") is ALWAYS visible — only the highlight moves.
import type { ReactNode } from 'react';
import styles from './TextShimmer.module.css';

export default function TextShimmer({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={className ? `${styles.shimmer} ${className}` : styles.shimmer}>{children}</span>;
}
