// AgentCursorOverlay.tsx — Atlas/Figma-style fake collaborator cursor that glides around the
// canvas while the design agent runs, "illuminating" a dot grid around it.
//
// TWO MODES:
//   • TARGETED (a `target` prop is present) — the agent is editing a specific element, and its op
//     steps stream that element's box (see Stage's cursorTarget, fed from each op frame's
//     `data.targetBox`). The cursor GLIDES TO that box and hovers over it (a small eased orbit
//     within the box), so you can literally watch it work the layer it's touching. Consecutive
//     targets transition smoothly. Driven by JS: we set the two registered custom properties
//     (--agent-cx / --agent-cy) as inline style on the wrapper with a CSS transition for the ease;
//     the halo mask + cursor transform both read those vars, so the dot-grid light follows for free.
//   • AMBIENT (no target yet — thinking / extraction) — the original decorative CSS @keyframes lap
//     runs, so the cursor never looks frozen before the first target arrives.
//
// Zero per-frame JS in either mode: ambient is a pure CSS keyframe loop; targeted is a CSS
// transition between discrete target positions (+ a tiny orbit keyframe layered on the mover).
// Mounted in the Stage while `locked` with a 280ms exit pattern.
//
// Layers (bottom → top):
//   .gridBase — faint always-on dot grid (near-invisible at rest)
//   .gridLit  — brighter/larger accent dots, revealed through a radial mask that follows the cursor
//   .mover    — full-size div translated by the animated vars; carries the glow + cursor + label
import { useEffect, useRef, useState } from 'react';
import styles from './AgentCursorOverlay.module.css';

/** A normalized (0..1 of canvas) target the agent is currently editing. `key` changes per op step
 *  so we can re-trigger the settle orbit; left/top are the box CENTER, w/h the box size. */
export interface CursorTarget {
  key: string;
  left: number;
  top: number;
  w: number;
  h: number;
}

export default function AgentCursorOverlay({
  exiting = false, target = null,
}: { exiting?: boolean; target?: CursorTarget | null } = {}) {
  // Hold the last real target so the cursor stays parked on the element between op frames (targets
  // arrive discretely; null gaps during a burst of the same edit shouldn't snap it back to ambient).
  const [held, setHeld] = useState<CursorTarget | null>(target);
  useEffect(() => { if (target) setHeld(target); }, [target]);
  const active = held ?? target;
  const targeted = !!active;

  // Small deterministic per-target jitter so the parked cursor sits just inside the box near a
  // corner (like a real pointer resting ON the thing it's editing) rather than dead-center every
  // time — center can hide behind the element's own label. Kept within the box bounds.
  const pos = useRef<{ cx: number; cy: number }>({ cx: 0.22, cy: 0.24 });
  if (active) {
    // clamp the resting point to inside the box but biased up-left toward its top edge, where a
    // pointer naturally lands; fall back to the box center for tiny boxes.
    const offX = Math.min(active.w * 0.32, 0.06);
    const offY = Math.min(active.h * 0.32, 0.06);
    pos.current = {
      cx: Math.max(0, Math.min(1, active.left - offX)),
      cy: Math.max(0, Math.min(1, active.top - offY)),
    };
  }

  // In targeted mode we drive the vars via inline style (JS) with a CSS transition for the glide;
  // the wrapper's ambient @keyframes animation is suppressed by the [data-targeted] rule so the two
  // don't fight. In ambient mode we leave the vars unset and let the CSS keyframes own them.
  const style = targeted
    ? ({ '--agent-cx': `${(pos.current.cx * 100).toFixed(2)}%`, '--agent-cy': `${(pos.current.cy * 100).toFixed(2)}%` } as React.CSSProperties)
    : undefined;

  return (
    <div
      className={styles.wrap}
      data-exiting={exiting || undefined}
      data-targeted={targeted || undefined}
      style={style}
      aria-hidden="true"
    >
      <div className={styles.gridBase} />
      <div className={styles.gridLit} />
      <div className={styles.mover}>
        <div className={styles.glow} />
        <div className={styles.cursor}>
          <svg
            className={styles.arrow}
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            {/* Canonical macOS/Figma multiplayer pointer, tip pointing up-left. The hot-point
                (visible tip) is at (5,3) in the viewBox — the two long edges sweep down-right from
                it at the correct ~35°/70° spread (crisp arrowhead, not a sliver), meeting a clean
                V-notched tail. Accent fill, ~1.5px white outline + a soft drop-shadow (CSS) so it
                stays legible over any artwork. Tip anchoring math lives in the .module.css. */}
            <path
              d="M5 3 L5 18.2 L9.05 14.35 L11.62 20.4 L14.4 19.2 L11.83 13.2 L17.3 13.2 Z"
              fill="var(--accent)"
              stroke="#fff"
              strokeWidth="1.5"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          </svg>
          <span className={styles.label}>Agent</span>
        </div>
      </div>
    </div>
  );
}
