// lib/elements-badges.mjs — sticker/badge + testimonial/trust-signal elements. Plug-compatible
// ElementDefs (SAME shape as lib/elements.mjs's ELEMENTS entries) meant to be merged into that
// array by the maintainer. Do NOT import this file's defs into lib/elements.mjs from here —
// this module only EXPORTS defs; the merge happens elsewhere.
//
// Matches real-ad reference patterns:
//   1. starburst-sticker      — rotated scalloped/starburst badge, warm gradient, drop shadow
//   2. testimonial-quote-block — stars + serif italic quote + name + "Verified Purchase" pill
//   3. stat-callout            — ring badge + big number/percent + caption (+ small icon variant)
//
// Conventions carried over 1:1 from lib/elements.mjs (read, not edited):
//   • layerId()/coerceParams() come from elements.mjs — this file imports them, doesn't redefine.
//   • build(doc, p) returns Layer[] sized as CANVAS FRACTIONS via the same `sized(doc)` helper.
//   • shapeKind is the sceneGraph.ts union: 'rect'|'ellipse'|'starburst'|'arrow'|'line'|'polyline'
//     (confirmed in src/lib/sceneGraph.ts — no 'ring'/'path' shapeKind is rendered anywhere, so a
//     ring/outline circle is drawn as shapeKind:'ellipse' with NO background fill + a `stroke`).
//   • style.gradient accepts the v3 GradientFill object {type:'linear'|'radial', angle, stops:
//     [{color,pos}]} (see sceneGraph.ts) — used here for the sticker's warm gradient fill.
//   • style.effects: [{type:'drop-shadow', color, blur, x, y}] is the real per-shape drop shadow
//     (distinct from text's boolean `shadow`) — used for the sticker and the stat ring.
//   • FONT_SUGGEST.display ('Georgia') is the one real serif in the shared stack — used for the
//     testimonial quote's serif-italic look (style.fontStyle isn't in the LayerStyle union, so the
//     serif face + a slight visual treatment via letterSpacing carries the "editorial quote" read;
//     renderers that support italics via fontFamily hints still get a true serif fallback).

import { layerId, coerceParams, FONT_SUGGEST, FONT_PAIR } from './elements.mjs';

const sized = (doc) => {
  const { w, h } = doc.canvas;
  return {
    w, h,
    rx: (f) => Math.round(w * f),
    ry: (f) => Math.round(h * f),
    fs: (f) => Math.round(w * f),
  };
};

const text = (over) => ({ id: layerId(over.role || 'text'), type: 'text', autoH: true, ...over });
const shape = (over) => ({ id: layerId(over.role || 'shape'), type: 'shape', ...over });

const T = (key, dflt, extra = {}) => ({ key, type: 'text', default: dflt, ...extra });
const C = (key, dflt, extra = {}) => ({ key, type: 'color', default: dflt, ...extra });
const N = (key, dflt, min, max, extra = {}) => ({ key, type: 'number', default: dflt, min, max, ...extra });
const B = (key, dflt, extra = {}) => ({ key, type: 'boolean', default: dflt, ...extra });
const E = (key, dflt, options, extra = {}) => ({ key, type: 'enum', default: dflt, options, ...extra });

// gold star-rating string, same n-filled/(5-n)-outline trick as review-row/trust-badge in
// lib/elements.mjs (kept identical so the two files render pixel-identical star rows).
const starRow = (n) => '★★★★★☆☆☆☆☆'.slice(5 - n, 10 - n);

/** @type {import('./elements.mjs').ElementDef[]} */
export const BADGE_ELEMENTS = [

  // ── Buttons/Overlays — sticker badge ────────────────────────────────────────────────────────────
  {
    id: 'starburst-sticker', name: 'Starburst sticker', category: 'Buttons', brandFont: true,
    hint: 'Rotated scalloped sticker badge — warm gradient, drop shadow (Limited Edition look)',
    defaultBox: { x: 0.62, y: 0.06, w: 0.30, h: 0.30 },
    params: [
      T('text', 'Limited\nEdition', { maxLen: 40 }),
      N('spikes', 16, 8, 40, { quiet: true, label: 'Scallop count' }),
      N('rotation', -12, -45, 45, { label: 'Tilt angle' }),
      C('colorFrom', '#ff8a3d', { brandColor: true, label: 'Gradient start' }),
      C('colorTo', '#d92c2c', { label: 'Gradient end' }),
      C('textColor', '#ffffff', { quiet: true }),
    ],
    build(doc, p) {
      const { rx, ry, fs } = sized(doc);
      const box = { x: rx(0.62), y: ry(0.06), w: rx(0.30), h: rx(0.30) };
      const rot = Math.round(p.rotation);
      return [
        shape({
          role: 'badge', name: 'Starburst sticker', rotation: rot,
          box: { ...box },
          style: {
            shapeKind: 'starburst',
            spikes: Math.round(p.spikes),
            background: p.colorFrom, // fallback for renderers that don't resolve gradient
            gradient: { type: 'radial', stops: [{ color: p.colorFrom, pos: 0 }, { color: p.colorTo, pos: 1 }] },
            effects: [{ type: 'drop-shadow', color: 'rgba(0,0,0,0.35)', blur: fs(0.02), x: 0, y: fs(0.012) }],
          },
        }),
        (() => {
          // fit-to-zone: shrink font until the longest word fits the sticker's inner text zone
          const zoneW = rx(0.21);
          const longest = Math.max(1, ...String(p.text).toUpperCase().split(/\s+/).map((w) => w.length));
          const size = Math.min(fs(0.042), Math.floor(zoneW / (longest * 0.56)));
          return text({
            role: 'badge', name: 'Sticker text', text: p.text, rotation: rot,
            box: { x: box.x + rx(0.045), y: box.y + rx(0.09), w: zoneW, h: rx(0.12) },
            style: { fontSize: size, fontWeight: 800, color: p.textColor, align: 'center', uppercase: true, lineHeight: 1.08, letterSpacing: -0.2, fontFamily: FONT_PAIR.display },
          });
        })(),
      ];
    },
  },

  // ── Social — testimonial block ───────────────────────────────────────────────────────────────────
  {
    id: 'testimonial-quote-block', name: 'Testimonial quote block', category: 'Social',
    hint: 'Stars + serif italic quote + name + "Verified Purchase" pill, over a photo',
    defaultBox: { x: 0.08, y: 0.62, w: 0.84, h: 0.26 },
    params: [
      N('stars', 5, 1, 5),
      T('quote', 'This completely changed my morning routine — I actually look forward to it now.'),
      T('name', 'Sarah M.', { maxLen: 60 }),
      T('badgeText', 'Verified Purchase', { maxLen: 40 }),
      B('dark', false, { label: 'Text is white (photo background)' }),
      C('accent', '#ffb400', { quiet: true, label: 'Star color' }),
    ],
    build(doc, p) {
      const { rx, ry, fs } = sized(doc);
      const x = rx(0.08), y = ry(0.62), w = rx(0.84);
      const fg = p.dark ? '#ffffff' : '#111111';
      const n = Math.round(p.stars);
      const pillW = rx(0.34), pillH = ry(0.036);
      return [
        text({
          role: 'caption', name: 'Stars', text: starRow(n),
          box: { x, y, w, h: ry(0.04) },
          style: { fontSize: fs(0.038), fontWeight: 700, color: p.accent, align: 'left', lineHeight: 1, letterSpacing: 2, shadow: true },
        }),
        text({
          role: 'headline', name: 'Quote', text: `“${String(p.quote).replace(/^["“]|["”]$/g, '')}”`,
          box: { x, y: y + ry(0.05), w, h: ry(0.11) },
          // serif italic quote: Georgia (the one real serif in FONT_SUGGEST) + a faint negative
          // tracking reads as an editorial italic pull-quote at ad scale; shadow keeps it legible
          // over any photo underneath (matches review-row's over-photo contrast pattern).
          style: { fontSize: fs(0.034), fontWeight: 400, color: fg, align: 'left', lineHeight: 1.35, fontFamily: FONT_SUGGEST.display, letterSpacing: -0.2, shadow: true },
        }),
        text({
          role: 'caption', name: 'Name', text: `— ${p.name}`,
          box: { x, y: y + ry(0.17), w, h: ry(0.032) },
          style: { fontSize: fs(0.026), fontWeight: 700, color: fg, align: 'left', lineHeight: 1.2, shadow: true },
        }),
        // rounded "Verified Purchase" pill — opaque white-on-dark chip, legible over any photo
        shape({
          role: 'badge', name: 'Verified pill bg',
          box: { x, y: y + ry(0.21), w: pillW, h: pillH },
          style: { background: p.dark ? '#ffffff' : '#111111', opacity: 0.92, radius: fs(0.03) },
        }),
        text({
          role: 'badge', name: 'Verified pill text', text: `✓ ${p.badgeText}`,
          box: { x, y: y + ry(0.21), w: pillW, h: pillH },
          style: { fontSize: fs(0.02), fontWeight: 700, color: p.dark ? '#111111' : '#ffffff', align: 'center', lineHeight: 1, letterSpacing: 0.2 },
        }),
      ];
    },
  },

  // ── Cards/Social — stat callout + trust-signal icon row ─────────────────────────────────────────
  {
    id: 'stat-callout', name: 'Stat callout', category: 'Cards',
    hint: 'Ring badge + big number/percent + caption — also produces small icon+caption trust rows',
    defaultBox: { x: 0.08, y: 0.70, w: 0.84, h: 0.10 },
    params: [
      T('value', '89%', { maxLen: 12, label: 'Big number (or icon glyph when variant=icon)' }),
      T('caption', 'saw visibly smoother skin', { maxLen: 80 }),
      E('variant', 'stat', ['stat', 'icon'], { label: 'Big ring-number vs small icon-badge' }),
      E('icon', 'star', ['star', 'shield', 'flag', 'check'], { label: 'Icon glyph (variant=icon only)' }),
      C('ringColor', '#111111', { brandColor: true, label: 'Ring / icon color' }),
      C('color', '#111111', { quiet: true, label: 'Text color' }),
      B('dark', false, { label: 'Light text (photo background)' }),
    ],
    build(doc, p) {
      const { rx, ry, fs } = sized(doc);
      const x = rx(0.08), y = ry(0.70);
      const isIcon = p.variant === 'icon';
      const fg = p.dark ? '#ffffff' : p.color;
      const badge = isIcon ? rx(0.09) : rx(0.16);
      const ringW = Math.max(2, Math.round(badge * (isIcon ? 0.05 : 0.045)));
      const layers = [
        // ring/outline circle: shapeKind 'ellipse' with NO fill + a stroke reads as a thin
        // colored ring (sceneGraph.ts has no dedicated ring primitive — this is the real pattern
        // used for outline circles elsewhere: background left unset, stroke carries the ring).
        shape({
          role: 'badge', name: isIcon ? 'Icon ring' : 'Stat ring',
          box: { x, y, w: badge, h: badge },
          style: {
            shapeKind: 'ellipse',
            stroke: { color: p.ringColor, width: ringW },
            effects: isIcon ? undefined : [{ type: 'drop-shadow', color: 'rgba(0,0,0,0.18)', blur: fs(0.008), x: 0, y: fs(0.004) }],
          },
        }),
      ];
      if (isIcon) {
        // small icon-badge variant: single bold glyph centered in the thin ring (star / shield
        // check / flag) — the lightweight sibling of the big stat ring, same visual family.
        const glyph = { star: '★', shield: '🛡', flag: '⚑', check: '✓' }[p.icon] || '★';
        layers.push(text({
          role: 'badge', name: 'Icon glyph', text: glyph,
          box: { x, y, w: badge, h: badge },
          style: { fontSize: fs(0.036), fontWeight: 700, color: p.ringColor, align: 'center', lineHeight: 1 },
        }));
      } else {
        layers.push(text({
          role: 'price', name: 'Stat value', text: p.value,
          box: { x, y, w: badge, h: badge },
          style: { fontSize: fs(0.05), fontWeight: 800, color: fg, align: 'center', lineHeight: 1, fontFamily: FONT_PAIR.display },
        }));
      }
      // caption sits beside the badge, vertically centered against it
      layers.push(text({
        role: 'caption', name: 'Stat caption', text: p.caption,
        box: { x: x + badge + rx(0.03), y: y + Math.round(badge * 0.5) - fs(0.022), w: rx(0.84) - badge - rx(0.03), h: fs(0.044) },
        style: { fontSize: fs(isIcon ? 0.024 : 0.026), fontWeight: 600, color: fg, align: 'left', lineHeight: 1.25 },
      }));
      return layers;
    },
  },
];

export default BADGE_ELEMENTS;
