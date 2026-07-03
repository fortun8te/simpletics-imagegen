// Shimmer — ported from ai-sdk-elements "shimmer": a readable base color with a brighter band
// sweeping across the glyphs (background-clip:text). Re-implemented in pure CSS to match our
// existing TextShimmer look/tokens (no Framer Motion). Keeps the elements prop API:
//   children · as · className · duration (s) · spread (gradient width multiplier).
import { createElement, type ElementType, type CSSProperties, type ReactNode } from 'react';
import styles from './Shimmer.module.css';

export interface ShimmerProps {
  children: ReactNode;
  as?: ElementType;
  className?: string;
  /** Animation duration in seconds (default 2). */
  duration?: number;
  /** Gradient spread multiplier — wider = softer, slower-reading band (default 2). */
  spread?: number;
}

export function Shimmer({ children, as = 'span', className, duration = 2, spread = 2 }: ShimmerProps) {
  const style = {
    '--shimmer-dur': `${duration}s`,
    '--shimmer-spread': `${Math.max(1, spread) * 100}%`,
  } as CSSProperties;
  return createElement(
    as,
    { className: className ? `${styles.shimmer} ${className}` : styles.shimmer, style },
    children,
  );
}

export default Shimmer;
