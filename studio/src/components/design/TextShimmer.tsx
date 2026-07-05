// TextShimmer — loading-ui "text-shimmer": a readable base color with a brighter band sweeping
// across the glyphs (background-clip:text). Pure CSS, no Motion dependency. The base stays legible
// so the action text ("analysing image…") is ALWAYS visible — only the highlight moves.
import type { ComponentPropsWithoutRef, ReactNode } from 'react';
import styles from './TextShimmer.module.css';

type Props = { children: ReactNode; className?: string }
  & Omit<ComponentPropsWithoutRef<'span'>, 'children' | 'className'>;

// Forwards any extra span props (title, aria-live, aria-busy, …) so callers can attach a hover
// tooltip or scope live-region announcements to just this shimmering line.
export default function TextShimmer({ children, className, ...rest }: Props) {
  return <span className={className ? `${styles.shimmer} ${className}` : styles.shimmer} {...rest}>{children}</span>;
}
