// lib/type-scale.mjs — canvas-relative typography scale + server-side text box estimation.
// The agent should NOT guess font sizes — roles map to % of canvas width (same recipe as
// elements.mjs). repairTextLayer() snaps bad sizes and grows autoH boxes so server exports
// don't clip before the Editor opens.

/** Font size as % of canvas width, per role (parity with elements.mjs fs() fractions). */
export const ROLE_SIZE_PCT = {
  headline: 0.078,
  subhead: 0.042,
  caption: 0.032,
  cta: 0.034,
  badge: 0.026,
  price: 0.055,
  scrim: 0.028,
  default: 0.038,
};

/** Recommended fontWeight per role. */
export const ROLE_WEIGHT = {
  headline: 800,
  subhead: 500,
  caption: 400,
  cta: 700,
  badge: 700,
  price: 800,
  default: 600,
};

/** Max text box width as fraction of canvas — prevents full-bleed copy on photos. */
export const MAX_WIDTH_PCT = {
  headline: 0.82,
  subhead: 0.72,
  caption: 0.68,
  cta: 0.48,
  badge: 0.42,
  price: 0.55,
  default: 0.70,
};

/** Hard minimum fontSize at 1080-wide (scaled per canvas). */
export const MIN_FONT_PX = {
  headline: 56,
  subhead: 38,
  caption: 30,
  cta: 32,
  badge: 26,
  price: 40,
  default: 30,
};

const TEXTY = new Set(['text', 'badge', 'button']);

export function isTextual(node) {
  return node && TEXTY.has(node.type);
}

/** square | portrait | story from canvas aspect. */
export function formatPreset(canvas) {
  const ratio = (canvas.h || 1080) / (canvas.w || 1080);
  if (ratio > 1.6) return 'story';
  if (ratio > 1.15) return 'portrait';
  return 'square';
}

/** Target fontSize in px for a role on this canvas. */
export function roleFontSize(doc, role) {
  const pct = ROLE_SIZE_PCT[role] || ROLE_SIZE_PCT.default;
  return Math.round((doc.canvas?.w || 1080) * pct);
}

/** Compact type-scale line for agent observations (~60 chars). */
export function typeScaleLine(doc) {
  const w = doc.canvas?.w || 1080;
  const f = formatPreset(doc.canvas || { w, h: w });
  return `scale@${w}(${f}): hd=${roleFontSize(doc, 'headline')} sub=${roleFontSize(doc, 'subhead')} cap=${roleFontSize(doc, 'caption')} cta=${roleFontSize(doc, 'cta')}`;
}

/** Rough avg glyph width — good enough for server-side line counting. */
function charWidth(fontSize, fontWeight = 600) {
  const fw = fontWeight >= 800 ? 0.58 : fontWeight >= 700 ? 0.55 : 0.52;
  return fontSize * fw;
}

/** Estimate wrapped line count without a DOM measurer. */
export function estimateLineCount(text, maxW, fontSize, fontWeight = 600) {
  const cw = charWidth(fontSize, fontWeight);
  const words = String(text || '').split(/\s+/).filter(Boolean);
  if (!words.length) return 1;
  let lines = 1;
  let cur = 0;
  for (const word of words) {
    const w = cw * word.length;
    if (cur > 0 && cur + cw + w > maxW) { lines++; cur = w; }
    else cur = cur ? cur + cw + w : w;
  }
  // explicit newlines
  const paras = String(text || '').split('\n');
  if (paras.length > 1) return paras.reduce((sum, p) => sum + estimateLineCount(p, maxW, fontSize, fontWeight), 0);
  return lines;
}

/** Server-side block height for a textual layer (parity-ish with textMetrics.ts). */
export function estimateTextBoxH(node) {
  if (!isTextual(node)) return node.box?.h || 40;
  const s = node.style || {};
  const size = s.fontSize || 40;
  const pill = !!(s.pill && s.background);
  // PARITY with textMetrics.ts textLayout: pills are INLINE spans — vertical padding paints
  // (box-decoration-break) but adds NO layout height; the ×1.25 lineHeight already holds the
  // paint. Non-pill blocks count their padding both sides.
  const padX = pill ? (s.padding || size * 0.55) : (s.padding || 0);
  const padY = pill ? 0 : (s.padding || 0);
  const lineH = pill ? size * (s.lineHeight || 1.2) * 1.25 : size * (s.lineHeight || 1.2);
  const text = s.uppercase ? String(node.text || '').toUpperCase() : String(node.text || '');
  const maxW = Math.max(8, (node.box?.w || 200) - padX * 2);
  const lines = Math.max(1, estimateLineCount(text, maxW, size, s.fontWeight || 600));
  return Math.max(size, Math.ceil(lines * lineH + padY * 2));
}

/**
 * Snap typography + box height for a textual layer. Returns repair note strings.
 * Mutates node in place.
 */
export function repairTextLayer(node, doc) {
  const notes = [];
  if (!isTextual(node)) return notes;
  node.style = node.style || {};
  const role = node.role || node.type;

  // Element-built layers are pre-measured by their builder (receipt rows, x-post body, ig-story
  // questions carry role "headline"/"caption" at deliberate artifact sizes) — never snap their
  // fontSize or cap their width. autoH growth below still applies so text edits don't clip.
  if (!node.sizeLocked) {
    const target = roleFontSize(doc, role);
    const cur = node.style.fontSize || 0;
    const scale = (doc.canvas?.w || 1080) / 1080;
    const floor = Math.round((MIN_FONT_PX[role] || MIN_FONT_PX.default) * scale);
    const effectiveTarget = Math.max(target, floor);

    // Snap when missing, tiny, or wildly off (>35% from target)
    if (!cur || cur < floor || Math.abs(cur - effectiveTarget) / effectiveTarget > 0.35) {
      notes.push(`fs ${cur || '?'}→${effectiveTarget}`);
      node.style.fontSize = effectiveTarget;
    }

    const maxW = Math.round((doc.canvas?.w || 1080) * (MAX_WIDTH_PCT[role] || MAX_WIDTH_PCT.default));
    if (node.box && node.box.w > maxW) {
      notes.push(`w cap ${node.box.w}→${maxW}`);
      node.box.w = maxW;
    }
    if (!node.style.fontWeight) {
      node.style.fontWeight = ROLE_WEIGHT[role] || ROLE_WEIGHT.default;
      notes.push(`w→${node.style.fontWeight}`);
    }
    if (!node.style.lineHeight) node.style.lineHeight = role === 'headline' ? 1.05 : 1.25;
  }

  // autoH: RE-MEASURE box.h to the reflowed text height — grow AND shrink so the stored box
  // stays in sync with what the renderer actually paints after a text edit (parity with the
  // frontend Stage.tsx commitEdit, which measures the true rendered height on blur and writes
  // box.h in both directions). Previously this only grew, so shortening text left a stale, too-tall
  // box and subsequent ops / verifyDesign read dishonest bounds. estimateTextBoxH mirrors
  // textMetrics.ts, so editor and agent agree. A ±2px deadband avoids churn on no-op re-measures.
  if (node.autoH !== false && node.box) {
    node.autoH = true;
    const need = estimateTextBoxH(node);
    if (Math.abs((node.box.h || 0) - need) > 2) {
      notes.push(`h ${node.box.h}→${need}`);
      node.box.h = need;
    }
  }
  return notes;
}
