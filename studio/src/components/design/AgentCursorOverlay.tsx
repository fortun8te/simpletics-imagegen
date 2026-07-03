// AgentCursorOverlay.tsx — Atlas/Figma-style fake collaborator cursor that glides around the
// canvas while the design agent runs, "illuminating" a dot grid around it. Purely illustrative
// (does NOT track real op targets). Zero per-frame JS: a single CSS @keyframes loop animates two
// registered custom properties (--agent-cx / --agent-cy, see the .module.css); the cursor mover's
// transform AND the dot-grid halo's radial-gradient mask both read those vars, so cursor + halo
// stay perfectly in sync for free. Mounted in two places with the SAME 280ms exit pattern:
// the Stage while `locked` (agent editing, see Stage.tsx) and NewCompFlow's building-comp pane
// while extraction runs — "the system is working on your canvas" reads identically in both.
//
// Layers (bottom → top):
//   .gridBase — faint always-on dot grid (near-invisible at rest)
//   .gridLit  — brighter/larger accent dots, revealed through a radial mask that follows the cursor
//   .mover    — full-size div translated by the animated vars; carries the glow + cursor + label
import styles from './AgentCursorOverlay.module.css';

export default function AgentCursorOverlay({ exiting = false }: { exiting?: boolean } = {}) {
  return (
    <div className={styles.wrap} data-exiting={exiting || undefined} aria-hidden="true">
      <div className={styles.gridBase} />
      <div className={styles.gridLit} />
      <div className={styles.mover}>
        <div className={styles.glow} />
        <div className={styles.cursor}>
          <svg
            className={styles.arrow}
            width="15"
            height="17"
            viewBox="0 0 15 17"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            {/* Sleek angular multiplayer pointer: a long swept triangular arrow rotated ~40°
                clockwise from vertical — tip up-right, small notched tail at the bottom-left.
                Accent fill + white outline so it reads on any art. */}
            <path
              d="M13.2 1.6 L7.4 15.3 L6.3 11 L1.1 11.3 Z"
              fill="var(--accent)"
              stroke="#fff"
              strokeWidth="1.3"
              strokeLinejoin="round"
            />
          </svg>
          <span className={styles.label}>Agent</span>
        </div>
      </div>
    </div>
  );
}
