// lib/ad-context.mjs — zero-LLM visual + ad intelligence.
// Knows what's UNDER each text layer, blocks dumb ad patterns (tiny type, full-bleed text on
// photos, wide copy with no chrome), and auto-repairs before the model ever sees the doc.

import { leaves, walkNodes } from './scene-tree.mjs';
import { parseColor, luminance } from './design-lint.mjs';
import {
  isTextual, roleFontSize, formatPreset, estimateTextBoxH, estimateLineCount,
  MAX_WIDTH_PCT, MIN_FONT_PX,
} from './type-scale.mjs';

/** Max estimated characters per line before we narrow the box. */
const MAX_CHARS_PER_LINE = {
  headline: 22,
  subhead: 36,
  caption: 42,
  cta: 18,
  badge: 24,
  default: 40,
};

const samplePoints = (box) => {
  const { x, y, w, h } = box;
  return [
    { x: x + w * 0.5, y: y + h * 0.5, tag: 'ctr' },
    { x: x + w * 0.15, y: y + h * 0.5, tag: 'L' },
    { x: x + w * 0.85, y: y + h * 0.5, tag: 'R' },
  ];
};

/** What sits under point (x,y) in paint order (excluding the target node). */
function hitUnder(doc, targetId, x, y) {
  const hits = [];
  walkNodes(doc.layers || [], (n) => {
    if (!n || n.hidden || !n.box || n.id === targetId) return;
    const b = n.box;
    if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) hits.push(n);
  });
  if (!hits.length) return { kind: 'empty', node: null };
  const top = hits[hits.length - 1];
  // A real photo = an IMAGE layer. A solid/gradient-color base SHAPE has a KNOWN fill — treat
  // it by its luminance so text over it gets a contrast flip, not the wide-on-photo pill path.
  // (Previously a color base was misclassified as 'photo' → dark headlines went invisible on a
  // dark base and neither repair nor lint caught it.)
  if (top.type === 'image' && (top.src || top.role === 'base')) return { kind: 'photo', node: top };
  if (top.type === 'shape' && top.style?.gradient && !top.style?.background) return { kind: 'scrim', node: top };
  if (top.style?.background) {
    const c = parseColor(top.style.background);
    if (c && luminance(c) < 0.35) return { kind: 'dark-scrim', node: top };
    if (c && luminance(c) > 0.65) return { kind: 'light-solid', node: top };
    return { kind: 'solid', node: top };
  }
  if (top.role === 'base') return { kind: 'photo', node: top }; // image base with no parsed fill
  return { kind: 'unknown', node: top };
}

/** Per-layer visual context for observations + repair decisions. */
export function analyzeLayerContext(doc, node) {
  if (!isTextual(node) || !node.box) return null;
  const pts = samplePoints(node.box);
  const hitsAt = pts.map((p) => hitUnder(doc, node.id, p.x, p.y));
  const under = hitsAt.map((h) => h.kind);
  const photoHits = under.filter((k) => k === 'photo').length;
  const overPhoto = photoHits >= 2;
  // Luminance of the KNOWN solid/gradient fill beneath the layer center (null over a photo or
  // empty) — drives the contrast flip in smartAdRepair. Falls back to the canvas bg guess: a
  // solid-color base counts, a real image doesn't.
  const centerHit = hitsAt[0];
  let underLum = null;
  if (centerHit && centerHit.node && centerHit.kind !== 'photo') {
    const cfill = parseColor(centerHit.node.style?.background);
    if (cfill) underLum = luminance(cfill);
  }
  const hasChrome = !!(node.style?.background || node.style?.pill);
  const cw = doc.canvas.w;
  const widthPct = node.box.w / cw;
  const fs = (node.style?.fontSize) || roleFontSize(doc, node.role || 'caption');
  const scale = cw / 1080;
  const minFs = (MIN_FONT_PX[node.role] || MIN_FONT_PX.default) * scale;
  const maxW = MAX_WIDTH_PCT[node.role] || MAX_WIDTH_PCT.default;
  const tooWide = widthPct > maxW + 0.02;
  const tooSmall = fs < minFs - 1;
  const wideOnPhoto = overPhoto && widthPct > 0.65 && !hasChrome;
  const pad = node.style?.padding || 0;
  const lines = estimateLineCount(
    String(node.text || ''),
    Math.max(8, node.box.w - pad * 2),
    fs,
    node.style?.fontWeight || 600,
  );
  const charsPerLine = Math.ceil(String(node.text || '').length / Math.max(1, lines));
  const lineTooLong = charsPerLine > (MAX_CHARS_PER_LINE[node.role] || MAX_CHARS_PER_LINE.default);

  let risk = 'low';
  if (tooSmall || wideOnPhoto) risk = 'high';
  else if (tooWide || (overPhoto && !hasChrome) || lineTooLong) risk = 'med';

  const underTag = overPhoto ? 'photo' : under[0] || 'unknown';
  return {
    role: node.role || node.type,
    under: underTag,
    overPhoto,
    hasChrome,
    widthPct: Math.round(widthPct * 100),
    fs,
    minFs: Math.round(minFs),
    tooWide,
    tooSmall,
    wideOnPhoto,
    lineTooLong,
    underLum,
    risk,
    hint: risk === 'high'
      ? (tooSmall ? 'tiny-type' : 'wide-on-photo')
      : (tooWide ? 'too-wide' : (overPhoto && !hasChrome ? 'needs-chrome' : (lineTooLong ? 'long-lines' : ''))),
  };
}

/** Compact visual-context block for agent observations (~30 chars/layer). */
export function visualContextBlock(doc, { aliases = null, budgetChars = 400 } = {}) {
  const aliasOf = (id) => (aliases ? aliases.alias(id) : id);
  const lines = ['VISUAL CONTEXT:'];
  const texts = leaves(doc.layers || []).filter((n) => isTextual(n) && n.role !== 'base' && !n.hidden);
  for (const n of texts) {
    const ctx = analyzeLayerContext(doc, n);
    if (!ctx) continue;
    // sizeLocked (element-built) layers are sized by design — never flag them to the model
    const hint = n.sizeLocked ? '' : ctx.hint;
    const tag = `${aliasOf(n.id)}:${ctx.under}${ctx.hasChrome ? '+pill' : ''} w${ctx.widthPct}% fs${ctx.fs}${hint ? ` ⚠${hint}` : ''}`;
    if (lines.join('\n').length + tag.length > budgetChars) break;
    lines.push(`  ${tag}`);
  }
  const fmt = formatPreset(doc.canvas);
  lines.push(`  format=${fmt} rule:never full-bleed text on photo without pill/scrim; min caption fs≥${Math.round((MIN_FONT_PX.caption) * doc.canvas.w / 1080)}`);
  return lines.join('\n');
}

/**
 * Smart ad repair — mutates doc in place. Zero tokens.
 * Fixes: min font floors, max width, pill on photo, line-length via narrow box.
 */
export function smartAdRepair(doc, { kit = null, excludeIds = null } = {}) {
  const { w: cw } = doc.canvas;
  const scale = cw / 1080;
  const summaries = [];
  const kitColors = kit && Array.isArray(kit.colors) ? kit.colors : [];
  const darkBg = kitColors.find((c) => { const rgb = parseColor(c); return rgb && luminance(rgb) < 0.4; }) || 'rgba(0,0,0,0.62)';
  const lightFg = '#ffffff';

  // excludeIds = layers the agent deliberately styled this run — never touch (reverts intent).
  // sizeLocked = element-built text (receipts, x-posts, marquees): the geometry/pill repairs
  // would wreck them, BUT the contrast flip still applies — invisible text is never "by design",
  // and legibility trumps an element's default color on a base it wasn't authored for.
  const excluded = (n) => excludeIds && excludeIds.has(n.id);

  for (const node of leaves(doc.layers || []).filter((n) => isTextual(n) && n.role !== 'base' && !n.hidden && !excluded(n))) {
    const ctx = analyzeLayerContext(doc, node);
    if (!ctx) continue;
    const notes = [];
    const role = node.role || 'caption';
    node.style = node.style || {};

    // Contrast flip against a KNOWN solid/gradient base fill — runs even on sizeLocked element
    // text (color only, never geometry). Dark base → light text, light base → dark text.
    // Threshold 0.12 targets ILLEGIBLE (near-identical luminance, same bar as lint's contrast
    // check) — not merely muted: a tweet's gray @handle on black is a deliberate hierarchy.
    if (ctx.underLum != null && !node.style.background && !node.style.pill) {
      const fg = parseColor(node.style.color || '#111111');
      const fgLum = fg ? luminance(fg) : 0;
      if (Math.abs(fgLum - ctx.underLum) < 0.12) {
        const flipped = ctx.underLum < 0.5 ? lightFg : '#111111';
        if (flipped.toLowerCase() !== String(node.style.color || '').toLowerCase()) {
          node.style.color = flipped;
          notes.push(`contrast → ${ctx.underLum < 0.5 ? 'light' : 'dark'} text`);
        }
      }
    }

    // Everything below is geometry/chrome repair — skip element-built (sizeLocked) artifacts.
    if (node.sizeLocked) { if (notes.length) summaries.push(`${role}: ${notes.join(', ')}`); continue; }

    // Hard min font floor
    if (ctx.tooSmall) {
      const floor = Math.round((MIN_FONT_PX[role] || MIN_FONT_PX.default) * scale);
      notes.push(`fs floor ${node.style.fontSize}→${floor}`);
      node.style.fontSize = floor;
    }

    const maxW = Math.round(cw * (MAX_WIDTH_PCT[role] || MAX_WIDTH_PCT.default));
    if (ctx.tooWide || ctx.wideOnPhoto || ctx.lineTooLong) {
      const nw = Math.min(node.box.w, maxW);
      if (nw < node.box.w) {
        notes.push(`w ${node.box.w}→${nw}`);
        node.box.w = nw;
      }
    }

    // Photo overlay without chrome → pill + dark bg (IG-caption pattern)
    if ((ctx.overPhoto || ctx.wideOnPhoto) && !node.style.background && !node.style.pill) {
      node.style.pill = true;
      node.style.background = darkBg;
      if (!node.style.color || parseColor(node.style.color) && luminance(parseColor(node.style.color)) < 0.5) {
        node.style.color = lightFg;
      }
      node.style.padding = node.style.padding || Math.round((node.style.fontSize || 40) * 0.55);
      node.style.lineHeight = node.style.lineHeight || 1.25;
      notes.push('pill on photo');
    }

    // CTA on photo: solid pill not ghost text
    if (role === 'cta' && ctx.overPhoto && !node.style.background) {
      const ctaBg = kitColors[0] || '#2c5cff';
      node.style.background = ctaBg;
      node.style.color = node.style.color || '#ffffff';
      node.style.pill = true;
      notes.push('cta pill');
    }

    // Headline on photo: prefer high contrast, never thin weight on busy bg
    if (role === 'headline' && ctx.overPhoto) {
      if ((node.style.fontWeight || 400) < 700) {
        node.style.fontWeight = 800;
        notes.push('hd weight→800');
      }
      if (!node.style.background && !node.style.shadow) {
        node.style.shadow = true;
        notes.push('hd shadow');
      }
    }

    // Re-grow autoH after width/font changes
    if (node.autoH !== false) {
      node.autoH = true;
      const need = estimateTextBoxH(node);
      if (node.box.h < need - 2) {
        notes.push(`h→${need}`);
        node.box.h = need;
      }
    }

    if (notes.length) summaries.push(`${role}: ${notes.join(', ')}`);
  }

  return {
    summaries,
    summary: summaries.length
      ? `smartAd: ${summaries.slice(0, 3).join(' · ')}${summaries.length > 3 ? ` (+${summaries.length - 3})` : ''}`
      : 'smartAd: ok',
  };
}

/** Score penalty inputs for verify — 0..100 readability score. */
export function readabilityScore(doc) {
  let score = 100;
  const texts = leaves(doc.layers || []).filter((n) => isTextual(n) && n.role !== 'base' && !n.hidden);
  for (const n of texts) {
    const ctx = analyzeLayerContext(doc, n);
    if (!ctx) continue;
    // risk already encodes wideOnPhoto/tooSmall — no double penalty for the same cause
    if (ctx.risk === 'high') score -= 25;
    else if (ctx.risk === 'med') score -= 10;
  }
  return Math.max(0, Math.min(100, score));
}
