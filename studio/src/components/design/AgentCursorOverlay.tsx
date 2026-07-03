// AgentCursorOverlay.tsx — Figma-multiplayer-style fake cursor that glides around the canvas
// while the design agent is running. Purely illustrative (does NOT track real op targets):
// a deterministic scatter of ~9 waypoints normalized 0..1 within the canvas box, animated with
// a single CSS @keyframes loop so the whole path is one smooth, deliberate glide with no JS
// per-frame work. Rendered by Stage ONLY while `locked` (see Stage.tsx) — alongside, not instead
// of, the shell's dimmed-scrim + shimmer-label overlay (Editor.module.css .agentOverlay).
import styles from './AgentCursorOverlay.module.css';

/** Waypoints normalized 0..1 in canvas space — a pleasant scattered pattern roughly following
 *  where layers tend to live (headline area, product area, CTA, corners) rather than a literal
 *  trace of agent ops. 9 points + implicit loop back to the first (handled by the keyframes). */
const WAYPOINTS: { x: number; y: number }[] = [
  { x: 0.18, y: 0.22 }, // near a headline, upper-left
  { x: 0.62, y: 0.14 }, // top-right accent
  { x: 0.78, y: 0.46 }, // right-mid, product area
  { x: 0.5, y: 0.52 },  // dead center, main subject
  { x: 0.24, y: 0.68 }, // lower-left
  { x: 0.42, y: 0.84 }, // toward a CTA
  { x: 0.7, y: 0.78 },  // lower-right
  { x: 0.86, y: 0.6 },  // right edge sweep
  { x: 0.34, y: 0.4 },  // back toward the middle before looping
];

export default function AgentCursorOverlay() {
  return (
    <div className={styles.wrap} aria-hidden="true">
      <div className={styles.cursor}>
        <svg width="20" height="24" viewBox="0 0 20 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path
            d="M1.5 1.2 L1.5 19.4 L6.3 15.3 L9.3 22.1 L12.1 20.8 L9.2 14.1 L15.4 13.6 Z"
            fill="var(--accent)"
            stroke="rgba(0,0,0,0.35)"
            strokeWidth="1"
            strokeLinejoin="round"
          />
        </svg>
        <span className={styles.label}>Agent</span>
      </div>
    </div>
  );
}

export { WAYPOINTS };
