// fills.ts — one gradient/vignette definition, serialized for every renderer.
// PARITY: studio/lib/designstore.mjs duplicates the CSS serializers (server can't import TS) —
// change both together.

import { resolveGradient, type GradientFill, type LayerBox, type LayerStyle } from '../../lib/sceneGraph';

/** Angle (CSS deg, 0 = to top) → unit direction vector in y-DOWN screen space. */
export function gradientDirection(angle: number): { dx: number; dy: number } {
  const rad = ((angle ?? 0) * Math.PI) / 180;
  return { dx: Math.sin(rad), dy: -Math.cos(rad) };
}

/** CSS background for Stage + server HTML. */
export function gradientCss(g: GradientFill): string {
  const stops = g.stops.map((s) => `${s.color} ${Math.round(s.pos * 100)}%`).join(', ');
  return g.type === 'radial'
    ? `radial-gradient(circle, ${stops})`
    : `linear-gradient(${g.angle ?? 0}deg, ${stops})`;
}

/** Resolved fill CSS for a style: gradient wins over solid background. */
export function fillCss(s: LayerStyle | undefined): string | undefined {
  const g = resolveGradient(s);
  if (g) return gradientCss(g);
  return s?.background || undefined;
}

/** Canvas-2D gradient for a box — endpoints per the CSS spec formula so pixels match. */
export function gradientCanvas(
  ctx: CanvasRenderingContext2D,
  g: GradientFill,
  box: LayerBox,
): CanvasGradient {
  const { x, y, w, h } = box;
  const cx = x + w / 2;
  const cy = y + h / 2;
  let grad: CanvasGradient;
  if (g.type === 'radial') {
    grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(w, h) / 2);
  } else {
    const { dx, dy } = gradientDirection(g.angle ?? 0);
    const L = (Math.abs(w * dx) + Math.abs(h * dy)) / 2;
    grad = ctx.createLinearGradient(cx - L * dx, cy - L * dy, cx + L * dx, cy + L * dy);
  }
  for (const s of g.stops) {
    grad.addColorStop(Math.max(0, Math.min(1, s.pos)), s.color === 'transparent' ? 'rgba(0,0,0,0)' : s.color);
  }
  return grad;
}

/** SVG gradient def markup + the fill url. `id` must be unique per document. */
export function gradientSvgDef(g: GradientFill, id: string): string {
  const stops = g.stops
    .map((s) => `<stop offset="${Math.round(s.pos * 100)}%" stop-color="${s.color === 'transparent' ? '#000' : s.color}"${s.color === 'transparent' ? ' stop-opacity="0"' : ''}/>`)
    .join('');
  if (g.type === 'radial') {
    return `<radialGradient id="${id}" cx="0.5" cy="0.5" r="0.5">${stops}</radialGradient>`;
  }
  const { dx, dy } = gradientDirection(g.angle ?? 0);
  const x1 = 0.5 - dx / 2, y1 = 0.5 - dy / 2, x2 = 0.5 + dx / 2, y2 = 0.5 + dy / 2;
  return `<linearGradient id="${id}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">${stops}</linearGradient>`;
}

// ── shape geometry (starburst / arrow) — ONE math, every renderer ────────────────────────────────

/** Starburst polygon points (badge look). Inner radius fixed at 0.78 of outer — matches the
 *  chunky discount-badge proportions in real ads, not a thin star. */
export function starburstPoints(box: LayerBox, spikes = 12): [number, number][] {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const rx = box.w / 2;
  const ry = box.h / 2;
  const inner = 0.78;
  const pts: [number, number][] = [];
  const n = Math.max(6, Math.min(40, Math.round(spikes)));
  for (let i = 0; i < n * 2; i++) {
    const a = (i * Math.PI) / n - Math.PI / 2;
    const k = i % 2 === 0 ? 1 : inner;
    pts.push([cx + Math.cos(a) * rx * k, cy + Math.sin(a) * ry * k]);
  }
  return pts;
}

/** Arrow/line endpoints along the box diagonal (flipDiag mirrors: ↘ vs ↗).
 *  Returns start, end, and the two arrowhead wing points (for kind 'arrow'). */
export function arrowGeometry(box: LayerBox, flipDiag = false): {
  x1: number; y1: number; x2: number; y2: number;
  head: [number, number][];
  width: number;
} {
  const x1 = box.x;
  const y1 = flipDiag ? box.y + box.h : box.y;
  const x2 = box.x + box.w;
  const y2 = flipDiag ? box.y : box.y + box.h;
  const ang = Math.atan2(y2 - y1, x2 - x1);
  const len = Math.hypot(x2 - x1, y2 - y1);
  const headLen = Math.max(10, Math.min(len * 0.25, 42));
  const spread = Math.PI / 7;
  const head: [number, number][] = [
    [x2 - headLen * Math.cos(ang - spread), y2 - headLen * Math.sin(ang - spread)],
    [x2 - headLen * Math.cos(ang + spread), y2 - headLen * Math.sin(ang + spread)],
  ];
  return { x1, y1, x2, y2, head, width: Math.max(2, Math.min(box.w, box.h) * 0.06) };
}

// ── vignette ─────────────────────────────────────────────────────────────────────────────────────

export interface VignetteSpec { color: string; strength: number; size: number }

export function vignetteSpec(s: LayerStyle | undefined): VignetteSpec {
  return {
    color: s?.background || '#000000',
    strength: Math.max(0, Math.min(1, s?.vignette?.strength ?? 0.7)),
    size: Math.max(0, Math.min(0.95, s?.vignette?.size ?? 0.45)),
  };
}

function withAlpha(color: string, a: number): string {
  const m = /^#([0-9a-fA-F]{6})$/.exec(color);
  if (m) {
    const n = parseInt(m[1], 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a.toFixed(3)})`;
  }
  return color; // non-hex colors: use as-is at full stop (approximation)
}

export function vignetteCss(v: VignetteSpec): string {
  return `radial-gradient(ellipse at center, rgba(0,0,0,0) ${Math.round(v.size * 100)}%, ${withAlpha(v.color, v.strength)} 100%)`;
}

export function vignetteCanvas(ctx: CanvasRenderingContext2D, v: VignetteSpec, box: LayerBox): CanvasGradient {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const R = Math.hypot(box.w, box.h) / 2;
  const grad = ctx.createRadialGradient(cx, cy, R * v.size, cx, cy, R);
  grad.addColorStop(0, 'rgba(0,0,0,0)');
  grad.addColorStop(1, withAlpha(v.color, v.strength));
  return grad;
}

export function vignetteSvgDef(v: VignetteSpec, id: string): string {
  return `<radialGradient id="${id}" cx="0.5" cy="0.5" r="0.72">` +
    `<stop offset="${Math.round(v.size * 100)}%" stop-color="${v.color}" stop-opacity="0"/>` +
    `<stop offset="100%" stop-color="${v.color}" stop-opacity="${v.strength.toFixed(3)}"/>` +
    `</radialGradient>`;
  // r=0.72 ≈ half-diagonal of a unit square — matches the canvas hypot radius closely.
}
