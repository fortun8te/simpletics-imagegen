// lib/elements-backgrounds.mjs — reusable BACKGROUND / COLOR-BLOCK creative-background shapes.
// Plain JS, zero-dep, same contract as lib/elements.mjs ElementDef (id/name/hint/category/params/
// defaultBox/build). This file is NOT wired into the ELEMENTS array — it's a standalone module
// ready to be spread into it later (`import { BACKGROUND_ELEMENTS } from './elements-backgrounds.mjs'`).
//
// Conventions matched from lib/elements.mjs + src/components/design/fills.ts (read-only refs):
//   • shapeKind:'path' + style.path — an SVG path string with coords normalized 0..1 WITHIN the
//     layer's box (renderers scale by box.w/box.h). Confirmed rendered in raster.ts, designSvg.ts,
//     Stage.tsx, figmaClipboard.ts — the right primitive for a smooth curved boundary.
//   • gradient stops: { color, pos } with pos 0..1; style.gradient = { type:'linear'|'radial',
//     angle, stops } (fills.ts gradientCss/gradientCanvas/gradientSvgDef consume this shape).
//   • vignette: a first-class LayerType 'vignette' with style.vignette = { strength, size } and
//     style.background as the vignette color (see elements.mjs `vignette` element, id:952).
//   • shape()/text() layer helpers, sized(doc) canvas-fraction→px, layerId() provenance ids.

import { layerId } from './elements.mjs';

// ── local copies of tiny shared helpers (elements.mjs keeps these unexported) ──────────────────────
const sized = (doc) => {
  const { w, h } = doc.canvas;
  return {
    w, h,
    rx: (f) => Math.round(w * f),
    ry: (f) => Math.round(h * f),
    fs: (f) => Math.round(w * f),
  };
};
const shape = (over) => ({ id: layerId(over.role || 'shape'), type: 'shape', ...over });

const T = (key, dflt, extra = {}) => ({ key, type: 'text', default: dflt, ...extra });
const C = (key, dflt, extra = {}) => ({ key, type: 'color', default: dflt, ...extra });
const N = (key, dflt, min, max, extra = {}) => ({ key, type: 'number', default: dflt, min, max, ...extra });
const E = (key, dflt, options, extra = {}) => ({ key, type: 'enum', default: dflt, options, ...extra });

// ── path builders ────────────────────────────────────────────────────────────────────────────────
// All paths are authored in a 0..1 box (top-left origin) — same normalization as the ICONS map in
// elements.mjs — so they scale cleanly to any canvas box via the renderer's box-scale.

/** Smooth organic wave boundary: a full-bleed band from splitY down to the bottom edge, with a
 *  soft S-curve top edge (two cubic béziers so it reads as an organic swoosh, not a single arc).
 *  curveDepth (0..1 fraction of box height) controls how far the curve bulges above/below splitY. */
function waveBandPath(splitY, curveDepth) {
  const d = Math.max(0.02, Math.min(0.35, curveDepth));
  const yTop = Math.max(0, splitY - d * 0.6);   // highest point of the swoosh (left-of-center dip)
  const yDip = Math.min(1, splitY + d);          // lowest point of the swoosh (right-of-center bulge)
  // Left edge starts at splitY, dips down then rises into a crest, settles near the right edge.
  return [
    `M 0 ${splitY.toFixed(4)}`,
    `C 0.22 ${(splitY + d * 0.5).toFixed(4)}, 0.30 ${yTop.toFixed(4)}, 0.52 ${yTop.toFixed(4)}`,
    `C 0.72 ${yTop.toFixed(4)}, 0.80 ${yDip.toFixed(4)}, 1 ${(splitY - d * 0.15).toFixed(4)}`,
    `L 1 1`, `L 0 1`, `Z`,
  ].join(' ');
}

/** Diagonal-corner sweep: a color block that fills a corner with a single soft-curved edge
 *  (quadratic, not a hard straight diagonal) — the "swoosh from the corner" variant, distinct
 *  from the horizontal wave band above. corner picks which corner it hugs. */
function cornerSweepPath(corner, reach, bulge) {
  const r = Math.max(0.2, Math.min(0.95, reach));   // how far the sweep reaches across the box
  const b = Math.max(0, Math.min(0.4, bulge));       // curve bulge amount
  switch (corner) {
    case 'top-right':
      return [
        `M 1 0`, `L ${(1 - r).toFixed(4)} 0`,
        `Q ${(1 - r + b).toFixed(4)} ${(r * 0.5).toFixed(4)}, ${(1 - r * 0.55).toFixed(4)} ${(r * 0.62).toFixed(4)}`,
        `Q ${(1 - r * 0.15).toFixed(4)} ${(r * 0.78).toFixed(4)}, 1 ${r.toFixed(4)}`,
        `Z`,
      ].join(' ');
    case 'bottom-left':
      return [
        `M 0 1`, `L 0 ${(1 - r).toFixed(4)}`,
        `Q ${(r * 0.5).toFixed(4)} ${(1 - r + b).toFixed(4)}, ${(r * 0.62).toFixed(4)} ${(1 - r * 0.55).toFixed(4)}`,
        `Q ${(r * 0.78).toFixed(4)} ${(1 - r * 0.15).toFixed(4)}, ${r.toFixed(4)} 1`,
        `Z`,
      ].join(' ');
    default: // 'bottom-right'
      return [
        `M 1 1`, `L 1 ${(1 - r).toFixed(4)}`,
        `Q ${(1 - r * 0.5).toFixed(4)} ${(1 - r + b).toFixed(4)}, ${(1 - r * 0.62).toFixed(4)} ${(1 - r * 0.55).toFixed(4)}`,
        `Q ${(1 - r * 0.78).toFixed(4)} ${(1 - r * 0.15).toFixed(4)}, ${(1 - r).toFixed(4)} 1`,
        `Z`,
      ].join(' ');
  }
}

/** Soft organic blob — a closed loop of 8 control points around an ellipse, radius jittered by a
 *  fixed seeded pattern (not Math.random — builds must stay deterministic/pure) so it reads as a
 *  hand-drawn blob rather than a perfect circle. */
function blobPath(irregularity) {
  const k = Math.max(0, Math.min(0.4, irregularity));
  // 8-point radius multipliers, hand-picked for a pleasant asymmetric blob (deterministic).
  const rMul = [1, 1 - k * 0.6, 1 + k * 0.9, 1 - k * 0.3, 1 + k * 0.5, 1 - k * 0.8, 1 + k * 0.35, 1 - k * 0.45];
  const n = rMul.length;
  const pts = rMul.map((m, i) => {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    const rx = 0.5 * m, ry = 0.5 * m;
    return [0.5 + Math.cos(a) * rx, 0.5 + Math.sin(a) * ry];
  });
  // Catmull-Rom-ish smoothing via quadratic mid-point curves between each pair of vertices.
  let d = `M ${pts[0][0].toFixed(4)} ${pts[0][1].toFixed(4)} `;
  for (let i = 0; i < n; i++) {
    const cur = pts[i];
    const next = pts[(i + 1) % n];
    const mid = [(cur[0] + next[0]) / 2, (cur[1] + next[1]) / 2];
    d += `Q ${cur[0].toFixed(4)} ${cur[1].toFixed(4)}, ${mid[0].toFixed(4)} ${mid[1].toFixed(4)} `;
  }
  d += 'Z';
  return d;
}

// ── ELEMENTS ─────────────────────────────────────────────────────────────────────────────────────
// Same ElementDef shape as lib/elements.mjs — id/name/hint/category/params/defaultBox/build(doc,p).
// Category 'Backgrounds' is new (not yet in ELEMENT_CATEGORIES — add it when merging into
// elements.mjs's array + category list).

export const BACKGROUND_ELEMENTS = [

  {
    id: 'wave-swoosh-bg', name: 'Wave swoosh background', category: 'Backgrounds',
    hint: 'Full-bleed color block with a smooth curved (not diagonal) top edge — telecom/service-ad layout',
    defaultBox: { x: 0, y: 0, w: 1, h: 1 },
    params: [
      C('topColor', '#ffffff', { label: 'Top band color' }),
      C('bottomColor', '#0a8f4c', { brandColor: true, label: 'Bottom swoosh color' }),
      N('splitY', 0.42, 0.15, 0.85, { label: 'Split line (fraction down canvas)' }),
      N('curveDepth', 0.09, 0.02, 0.3, { label: 'Curve bulge depth' }),
    ],
    build(doc, p) {
      const { w, h } = sized(doc);
      const layers = [
        // base fill — the plain top band shows through wherever the swoosh doesn't cover
        shape({
          role: 'base', name: 'Top band', box: { x: 0, y: 0, w, h },
          style: { background: p.topColor },
        }),
        shape({
          role: 'base', name: 'Wave swoosh', box: { x: 0, y: 0, w, h },
          style: { background: p.bottomColor, shapeKind: 'path', path: waveBandPath(p.splitY, p.curveDepth) },
        }),
      ];
      return layers;
    },
  },

  {
    id: 'photo-scrim-overlay', name: 'Photo scrim overlay', category: 'Backgrounds',
    hint: 'Warm top-fade gradient scrim over a busy lifestyle photo, for legible serif headlines (Chocolate Collection look)',
    defaultBox: { x: 0, y: 0, w: 1, h: 1 },
    params: [
      C('scrimColor', '#2a1710', { label: 'Scrim/shadow color (warm brown for editorial)' }),
      N('topOpacity', 0.62, 0, 1, { label: 'Opacity at very top' }),
      N('fadeTo', 0.42, 0.1, 0.9, { label: 'Fade ends at (fraction down canvas)' }),
      E('warmth', 'warm', ['warm', 'neutral'], { label: 'Color-grade tint', quiet: true }),
    ],
    build(doc, p) {
      const { w, h, ry } = sized(doc);
      const layers = [];
      // Top-fade scrim: solid warm color at the very top, fading to transparent by `fadeTo` —
      // reuses the SAME gradient stop shape fills.ts/Stage/raster all consume (angle 180 = to
      // bottom, matching the CSS convention documented in gradientDirection).
      layers.push(shape({
        role: 'scrim', name: 'Top scrim',
        box: { x: 0, y: 0, w, h: ry(Math.min(1, p.fadeTo + 0.08)) },
        style: {
          background: p.scrimColor,
          gradient: {
            type: 'linear', angle: 180,
            stops: [
              { color: p.scrimColor, pos: 0 },
              { color: p.scrimColor, pos: Math.max(0.05, p.fadeTo * 0.55) },
              { color: 'transparent', pos: 1 },
            ],
          },
          opacity: Math.max(0, Math.min(1, p.topOpacity)),
        },
      }));
      // Optional whole-frame warm color-grade wash — a very low-opacity flat tint (multiply reads
      // as a color-grade over a photo without crushing shadows the way a solid overlay would).
      if (p.warmth === 'warm') {
        layers.push(shape({
          role: 'scrim', name: 'Warm color-grade wash', box: { x: 0, y: 0, w, h },
          style: { background: '#7a3f1d', opacity: 0.10, blend: 'multiply' },
        }));
      }
      // Bottom vignette-style scrim (first-class 'vignette' layer type, matching elements.mjs's
      // `vignette` element) so product/lifestyle photos stay legible at the bottom too if a CTA
      // sits there — subtle by default (small size, low strength) since the top scrim does the
      // heavy lifting for the headline.
      layers.push({
        id: layerId('vignette'), type: 'vignette', role: 'vignette', name: 'Soft edge vignette',
        box: { x: 0, y: 0, w, h },
        style: { background: p.scrimColor, vignette: { strength: 0.35, size: 0.62 } },
      });
      return layers;
    },
  },

  {
    id: 'corner-sweep-bg', name: 'Corner sweep background', category: 'Backgrounds',
    hint: 'Color block sweeping from a corner with a soft curved edge — diagonal-sweep variant, distinct from the horizontal wave',
    defaultBox: { x: 0, y: 0, w: 1, h: 1 },
    params: [
      C('baseColor', '#ffffff', { label: 'Base background color' }),
      C('sweepColor', '#e0562f', { brandColor: true, label: 'Sweep color' }),
      E('corner', 'bottom-right', ['bottom-right', 'bottom-left', 'top-right'], { label: 'Corner it sweeps from' }),
      N('reach', 0.68, 0.3, 0.95, { label: 'How far the sweep reaches' }),
      N('bulge', 0.16, 0, 0.4, { label: 'Curve softness' }),
    ],
    build(doc, p) {
      const { w, h } = sized(doc);
      return [
        shape({ role: 'base', name: 'Base fill', box: { x: 0, y: 0, w, h }, style: { background: p.baseColor } }),
        shape({
          role: 'base', name: 'Corner sweep', box: { x: 0, y: 0, w, h },
          style: { background: p.sweepColor, shapeKind: 'path', path: cornerSweepPath(p.corner, p.reach, p.bulge) },
        }),
      ];
    },
  },

  {
    id: 'blob-bg', name: 'Organic blob background', category: 'Backgrounds',
    hint: 'Soft asymmetric blob shape — a floating color accent behind product/text, or a full-bleed backdrop blob',
    defaultBox: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 },
    params: [
      C('color', '#ffd9c2', { brandColor: true, label: 'Blob color' }),
      N('irregularity', 0.22, 0, 0.4, { label: 'How irregular the blob is' }),
      N('opacity', 1, 0.1, 1, { quiet: true }),
    ],
    build(doc, p) {
      const { rx, ry } = sized(doc);
      const box = { x: rx(0.1), y: ry(0.1), w: rx(0.8), h: ry(0.8) };
      return [shape({
        role: 'base', name: 'Organic blob', box,
        style: { background: p.color, shapeKind: 'path', path: blobPath(p.irregularity), opacity: p.opacity },
      })];
    },
  },

  {
    id: 'radial-vignette-scrim', name: 'Radial vignette scrim', category: 'Backgrounds',
    hint: 'Soft radial darkening helper so headline/CTA text stays legible over a busy photo — reuses the vignette layer type',
    defaultBox: { x: 0, y: 0, w: 1, h: 1 },
    params: [
      C('color', '#000000', { label: 'Vignette color' }),
      N('strength', 0.55, 0, 1, { label: 'Edge darkness' }),
      N('size', 0.4, 0, 0.95, { label: 'Clear inner radius' }),
    ],
    build(doc, p) {
      const { w, h } = sized(doc);
      // Thin wrapper around the SAME first-class vignette layer type elements.mjs's `vignette`
      // element uses — kept here as a semantically-named "creative background" helper so agents
      // building a photo-overlay treatment can reach for it under the Backgrounds category
      // without hunting through Overlays.
      return [{
        id: layerId('vignette'), type: 'vignette', role: 'vignette', name: 'Radial vignette scrim',
        box: { x: 0, y: 0, w, h },
        style: { background: p.color, vignette: { strength: Math.max(0, Math.min(1, p.strength)), size: Math.max(0, Math.min(0.95, p.size)) } },
      }];
    },
  },

];

export default BACKGROUND_ELEMENTS;
