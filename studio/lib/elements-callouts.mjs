// lib/elements-callouts.mjs — CALLOUT + Q&A STICKER pattern library. Plain JS, zero-dep, same
// ElementDef contract as lib/elements.mjs (id/name/hint/category/params/defaultBox/build). This
// file is standalone: it re-derives the tiny shared helpers it needs (sized/text/shape/layerId)
// rather than importing lib/elements.mjs, so it stays a drop-in the caller can splice into the
// ELEMENTS array later without creating a cross-file coupling.
//
// Reference artifacts these mimic:
//   • leader-line-callout — the thin diagonal/vertical line + side label used in fashion/product
//     ads to annotate a specific garment/feature ("Silk PJ Sets" pointing at a photo detail).
//   • qa-sticker — the Instagram Story native Q&A sticker: black "Ask me anything" header bar
//     atop a white rounded question box, bold centered text.
//   • reply-bubble-stack — stacked white iMessage/IG-reply-style speech bubbles (with a tail),
//     auto-sized to their own text, used over a photo/video background for influencer reply ads.
//   • before-after-pill-label — a lighter, reusable version of the pill baked into the
//     `before-after` template (lib/templates.mjs, read-only) — a white pill with bold colored
//     text meant to sit on a panel's top edge.
//
// FONT_SUGGEST usage mirrors lib/elements.mjs exactly (single space-free token per family — see
// that file's big comment for why). We inline the same tiny map here to stay import-free.
export const FONT_SUGGEST = {
  display: 'Georgia',
  sans: '',
  mono: 'Menlo',
  hand: 'Bradley Hand',
  twitter: '',
  instagram: '-apple-system',
  notes: '-apple-system',
  sf: '-apple-system',
};

// ── tiny local id helper (mirrors lib/elements.mjs layerId — same shape, independent counter) ────
let seq = 0;
export function layerId(prefix = 'layer') {
  return `${prefix}-${Date.now().toString(36)}-${(seq++).toString(36)}`;
}

// ── shared build helpers (same shape as lib/elements.mjs) ───────────────────────────────────────
const sized = (doc) => {
  const { w, h } = doc.canvas;
  return {
    w, h,
    rx: (f) => Math.round(w * f),
    ry: (f) => Math.round(h * f),
    fs: (f) => Math.round(w * f), // font sizes scale with width
  };
};

const text = (over) => ({ id: layerId(over.role || 'text'), type: 'text', autoH: true, ...over });
const shape = (over) => ({ id: layerId(over.role || 'shape'), type: 'shape', ...over });

// ── param spec helpers (same tiny factories as lib/elements.mjs) ────────────────────────────────
const T = (key, dflt, extra = {}) => ({ key, type: 'text', default: dflt, ...extra });
const C = (key, dflt, extra = {}) => ({ key, type: 'color', default: dflt, ...extra });
const N = (key, dflt, min, max, extra = {}) => ({ key, type: 'number', default: dflt, min, max, ...extra });
const E = (key, dflt, options, extra = {}) => ({ key, type: 'enum', default: dflt, options, ...extra });
const SL = (key, dflt, extra = {}) => ({ key, type: 'stringList', default: dflt, ...extra });

// Rough per-character width estimate for auto-hugging bubble/box widths & heights, same spirit as
// lib/type-scale.mjs's charWidth (kept local + tiny — no import needed for this file's needs).
const charWidth = (fontSize, fontWeight = 600) => fontSize * (fontWeight >= 700 ? 0.58 : 0.52);

function estimateLines(str, maxW, fontSize, fontWeight = 600) {
  const cw = charWidth(fontSize, fontWeight);
  const paras = String(str || '').split('\n');
  if (paras.length > 1) return paras.reduce((sum, p) => sum + estimateLines(p, maxW, fontSize, fontWeight), 0);
  const words = String(str || '').split(/\s+/).filter(Boolean);
  if (!words.length) return 1;
  let lines = 1, cur = 0;
  for (const word of words) {
    const w = cw * word.length;
    if (cur > 0 && cur + cw + w > maxW) { lines++; cur = w; } else cur = cur ? cur + cw + w : w;
  }
  return lines;
}

function widestLine(str, fontSize, fontWeight = 600) {
  const cw = charWidth(fontSize, fontWeight);
  const lines = String(str || '').split('\n');
  return Math.max(1, ...lines.map((l) => l.length)) * cw;
}

/** @type {ElementDef[]} */
export const CALLOUT_ELEMENTS = [

  // ── Callouts ─────────────────────────────────────────────────────────────────────────────────
  {
    id: 'leader-line-callout', name: 'Leader-line callout', category: 'Callouts',
    hint: 'Thin line from a product detail out to a side label — fashion/product annotation style',
    defaultBox: { x: 0.60, y: 0.20, w: 0.32, h: 0.18 },
    params: [
      T('text', 'Silk PJ Sets', { maxLen: 60 }),
      N('angle', 45, 0, 180, { label: 'Line angle (deg, 0=horizontal)' }),
      N('length', 0.16, 0.04, 0.5, { label: 'Line length (fraction of canvas width)' }),
      E('labelSide', 'end', ['start', 'end'], { quiet: true, label: 'Label at line start or end' }),
      C('color', '#111111', { label: 'Line + text color' }),
      N('originX', 0.62, 0, 1, { quiet: true, label: 'Origin X (fraction of canvas)' }),
      N('originY', 0.30, 0, 1, { quiet: true, label: 'Origin Y (fraction of canvas)' }),
    ],
    build(doc, p) {
      const { rx, ry, fs, w, h } = sized(doc);
      const ox = rx(p.originX), oy = ry(p.originY);
      const lenPx = rx(p.length);
      const rad = (p.angle * Math.PI) / 180;
      // angle convention: 0 = straight up, 90 = horizontal right (matches the "vertical/diagonal
      // line running up to a product detail" reference — a small angle reads as near-vertical).
      const dx = Math.sin(rad) * lenPx;
      const dy = -Math.cos(rad) * lenPx;
      const ex = ox + dx, ey = oy + dy;
      // line layer: box spans origin→end diagonally; shapeKind 'line' draws along the box diagonal.
      const lx = Math.min(ox, ex), ly = Math.min(oy, ey);
      const lw = Math.max(2, Math.abs(ex - ox)), lh = Math.max(2, Math.abs(ey - oy));
      const flip = (ex < ox) !== (ey < oy); // mirror when the diagonal runs the other way
      const dotR = Math.max(3, fs(0.008));
      const layers = [
        shape({
          role: 'caption', name: 'Callout dot',
          box: { x: ox - dotR, y: oy - dotR, w: dotR * 2, h: dotR * 2 },
          style: { shapeKind: 'ellipse', background: p.color },
        }),
        shape({
          role: 'caption', name: 'Callout line',
          box: { x: lx, y: ly, w: lw, h: lh },
          style: { shapeKind: 'line', background: p.color, stroke: { color: p.color, width: 2 }, flipDiag: flip },
        }),
      ];
      const fsPx = fs(0.026);
      const labelW = rx(0.26);
      const anchor = p.labelSide === 'start' ? { x: ox, y: oy } : { x: ex, y: ey };
      // label sits just past the line end (or start), nudged so it doesn't overlap the leader —
      // offset direction follows the same up/right convention as the line itself.
      const labelX = Math.max(0, Math.min(w - labelW, anchor.x - labelW / 2 + Math.round(fsPx * 0.6)));
      const labelY = Math.max(0, Math.min(h - fs(0.05), anchor.y - fs(0.05) - Math.round(fsPx * 0.5)));
      layers.push(text({
        role: 'caption', name: 'Callout label', text: p.text,
        box: { x: labelX, y: labelY, w: labelW, h: fs(0.05) },
        style: { fontSize: fsPx, fontWeight: 600, color: p.color, align: 'center', lineHeight: 1.2, fontFamily: FONT_SUGGEST.display },
      }));
      return layers;
    },
  },

  // ── Social (IG Q&A + reply bubbles) ─────────────────────────────────────────────────────────────
  {
    id: 'qa-sticker', name: 'Q&A sticker', category: 'Social',
    hint: 'Instagram Story Q&A sticker — black prompt bar + white question box',
    defaultBox: { x: 0.10, y: 0.36, w: 0.80, h: 0.16 },
    params: [
      T('prompt', 'Ask me anything', { maxLen: 40 }),
      T('question', 'Does this actually work?', { maxLen: 140 }),
      C('accent', '#111111', { quiet: true, label: 'Header bar color' }),
    ],
    build(doc, p) {
      const { rx, ry, fs, w } = sized(doc);
      const x = rx(0.10), boxW = rx(0.80);
      const headerH = ry(0.045);
      const radius = fs(0.03);
      const promptFs = fs(0.026);
      const questionFs = fs(0.032);
      const qLines = estimateLines(p.question, boxW - fs(0.08), questionFs, 700);
      const qBoxH = Math.max(ry(0.07), Math.round(qLines * questionFs * 1.3 + fs(0.05)));
      const y = ry(0.36);
      return [
        // white question box drawn first (full height incl. the header's rounded top), then the
        // black header bar overlays its top edge — matches the native sticker's single rounded
        // silhouette with a flat seam between the two fills.
        shape({
          role: 'card', name: 'Q&A box', box: { x, y: y + headerH - Math.round(radius * 0.6), w: boxW, h: qBoxH },
          style: { background: '#ffffff', radius },
        }),
        shape({
          role: 'card', name: 'Q&A header bar', box: { x, y, w: boxW, h: headerH },
          style: { background: p.accent, radius, radiusCorners: [radius, radius, Math.round(radius * 0.2), Math.round(radius * 0.2)] },
        }),
        text({
          role: 'caption', name: 'Q&A prompt', text: p.prompt,
          box: { x, y: y + Math.round(headerH * 0.14), w: boxW, h: Math.round(headerH * 0.72) },
          style: { fontSize: promptFs, fontWeight: 600, color: '#ffffff', align: 'center', lineHeight: 1.1, fontFamily: FONT_SUGGEST.instagram },
        }),
        text({
          role: 'headline', name: 'Q&A question', text: p.question,
          box: { x: x + fs(0.04), y: y + headerH + Math.round(radius * 0.4), w: boxW - fs(0.08), h: qBoxH - Math.round(radius * 0.4) },
          style: { fontSize: questionFs, fontWeight: 700, color: '#111111', align: 'center', lineHeight: 1.3, fontFamily: FONT_SUGGEST.instagram },
        }),
      ];
    },
  },
  {
    id: 'reply-bubble-stack', name: 'Reply bubble stack', category: 'Social',
    hint: 'Stacked white speech bubbles with tails — influencer reply-style ad over a photo/video',
    defaultBox: { x: 0.08, y: 0.55, w: 0.84, h: 0.34 },
    params: [
      SL('replies', ['wait this actually works??', 'okay I need to try this', 'sending to my group chat rn'], { maxItems: 6, maxLen: 140 }),
      E('align', 'left', ['left', 'right'], { label: 'Bubbles stack on which side' }),
      C('color', '#111111', { quiet: true, label: 'Text color' }),
    ],
    build(doc, p) {
      const { rx, ry, fs, w } = sized(doc);
      const x = rx(0.08), boxW = rx(0.84);
      const fsPx = fs(0.032);
      const padX = Math.round(fsPx * 0.75);
      const padY = Math.round(fsPx * 0.55);
      const lineH = fsPx * 1.3;
      const tail = Math.round(fsPx * 0.5);
      const gap = Math.round(fsPx * 0.7);
      const maxBubbleW = Math.round(boxW * 0.78);
      const maxTextW = maxBubbleW - padX * 2;
      const left = p.align === 'left';
      let y = ry(0.55);
      const layers = [];
      for (const reply of p.replies) {
        const lines = estimateLines(reply, maxTextW, fsPx, 600);
        const textW = Math.min(maxTextW, widestLine(reply, fsPx, 600));
        const bubbleW = Math.round(textW + padX * 2);
        const bubbleH = Math.round(lines * lineH + padY * 2);
        const bx = left ? x : x + boxW - bubbleW;
        layers.push(
          shape({
            role: 'card', name: 'Reply bubble', box: { x: bx, y, w: bubbleW, h: bubbleH },
            style: { background: '#ffffff', radius: Math.round(fsPx * 0.85), shadow: true },
          }),
          // tail: a small triangle-ish notch via a rotated square clipped by the bubble's own
          // corner — rendered here as a tiny rounded square peeking from the bottom edge, the
          // simplest cross-renderer-safe approximation of a speech-bubble point.
          shape({
            role: 'card', name: 'Reply bubble tail',
            box: { x: left ? bx + Math.round(fsPx * 0.6) : bx + bubbleW - Math.round(fsPx * 0.6) - tail, y: y + bubbleH - Math.round(tail * 0.4), w: tail, h: tail },
            rotation: 45,
            style: { background: '#ffffff', radius: Math.round(tail * 0.15) },
          }),
          text({
            role: 'caption', name: 'Reply text', text: reply, autoH: false,
            box: { x: bx + padX, y: y + padY, w: bubbleW - padX * 2, h: bubbleH - padY * 2 },
            style: { fontSize: fsPx, fontWeight: 600, color: p.color, align: 'left', lineHeight: 1.3 },
          }),
        );
        y += bubbleH + gap;
      }
      return layers;
    },
  },

  // ── Companion to before-after (lib/templates.mjs, read-only) ────────────────────────────────────
  {
    id: 'before-after-pill-label', name: 'Before/After pill label', category: 'Callouts',
    hint: 'Reusable pill label (Before/After/custom) that sits centered on a panel\'s top edge',
    defaultBox: { x: 0.30, y: 0.28, w: 0.22, h: 0.05 },
    params: [
      T('text', 'Before', { maxLen: 24 }),
      C('color', '#111111', { brandColor: true, label: 'Text color' }),
      N('centerX', 0.41, 0, 1, { label: 'Center X (fraction of canvas — sits on panel top edge)' }),
      N('top', 0.28, 0, 1, { label: 'Top Y (fraction of canvas)' }),
    ],
    build(doc, p) {
      const { rx, ry, fs, w } = sized(doc);
      const pillFs = fs(0.026);
      const pillW = Math.max(rx(0.14), Math.round(widestLine(p.text, pillFs, 700) + fs(0.05)));
      const pillH = fs(0.05);
      const cx = rx(p.centerX);
      const x = Math.max(0, Math.min(w - pillW, cx - pillW / 2));
      const y = ry(p.top) - Math.round(pillH / 2); // straddles the panel's top edge, IG-pill style
      return [text({
        role: 'badge', name: 'Before/After pill', text: p.text,
        box: { x, y, w: pillW, h: pillH },
        style: { fontSize: pillFs, fontWeight: 800, color: p.color, background: '#ffffff', radius: Math.round(pillH / 2), align: 'center', uppercase: false, letterSpacing: 0.2, shadow: true },
      })];
    },
  },
];

export default CALLOUT_ELEMENTS;
