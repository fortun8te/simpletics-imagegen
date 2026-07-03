// lib/layout-engine.mjs — deterministic ad layout: role zones, column grid, vertical stack.
// Runs in ZERO tokens — fixes the dumb font/position mistakes before or instead of the LLM.

import { leaves, translateNode, normalizeGroups } from './scene-tree.mjs';
import { repairTextLayer, roleFontSize, formatPreset, isTextual } from './type-scale.mjs';
import { smartAdRepair } from './ad-context.mjs';

const MARGIN = 0.05; // 5% canvas margin
const COLS = 12;

/** IG-safe vertical zones per format (fractions of canvas height). */
export const ROLE_ZONES = {
  square: {
    badge: { y0: 0.05, y1: 0.14 },
    headline: { y0: 0.58, y1: 0.72 },
    subhead: { y0: 0.72, y1: 0.80 },
    caption: { y0: 0.78, y1: 0.86 },
    cta: { y0: 0.86, y1: 0.95 },
    price: { y0: 0.50, y1: 0.58 },
  },
  portrait: {
    badge: { y0: 0.04, y1: 0.12 },
    headline: { y0: 0.62, y1: 0.76 },
    subhead: { y0: 0.74, y1: 0.82 },
    caption: { y0: 0.80, y1: 0.88 },
    cta: { y0: 0.88, y1: 0.96 },
    price: { y0: 0.54, y1: 0.62 },
  },
  story: {
    badge: { y0: 0.06, y1: 0.14 },
    headline: { y0: 0.68, y1: 0.80 },
    subhead: { y0: 0.78, y1: 0.85 },
    caption: { y0: 0.82, y1: 0.90 },
    cta: { y0: 0.90, y1: 0.96 },
    price: { y0: 0.58, y1: 0.66 },
  },
};

const snapCol = (v, colW) => Math.round(v / colW) * colW;

function overlapArea(a, b) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

function zoneFor(doc, role) {
  const fmt = formatPreset(doc.canvas);
  const zones = ROLE_ZONES[fmt] || ROLE_ZONES.square;
  return zones[role] || zones.caption;
}

/** Default horizontal span in columns per role. */
const ROLE_COLS = {
  headline: 10,
  subhead: 9,
  caption: 8,
  cta: 5,
  badge: 4,
  price: 5,
  default: 8,
};

/**
 * Auto-layout every overlay text layer: typography repair + zone placement + column snap.
 * Mutates doc in place. Returns human summary lines.
 */
export function autoLayoutDoc(doc, { kit = null } = {}) {
  const { w: cw, h: ch } = doc.canvas;
  const mx = Math.round(cw * MARGIN);
  const colW = cw / COLS;
  const fmt = formatPreset(doc.canvas);
  const summaries = [];

  const overlay = leaves(doc.layers || []).filter((n) => n.role !== 'base' && !n.locked && !n.hidden);

  // Role priority for vertical stacking when multiple layers share a zone
  const priority = { badge: 0, price: 1, headline: 2, subhead: 3, caption: 4, cta: 5 };
  const texts = overlay.filter(isTextual).sort((a, b) => (priority[a.role] ?? 9) - (priority[b.role] ?? 9));

  let stackY = {}; // role → next y slot within zone

  for (const node of texts) {
    const role = node.role || 'caption';
    const notes = repairTextLayer(node, doc);
    const cols = ROLE_COLS[role] || ROLE_COLS.default;
    const targetW = Math.round(colW * cols);
    const targetX = snapCol(mx, colW);

    if (node.box.w < targetW * 0.7 || node.box.w > cw - mx * 2) {
      notes.push(`w ${node.box.w}→${targetW}`);
      node.box.w = Math.min(targetW, cw - mx * 2);
    }
    if (node.box.x < mx - 2) { notes.push(`x→margin`); node.box.x = mx; }

    const zone = zoneFor(doc, role);
    const zTop = Math.round(ch * zone.y0);
    const zBot = Math.round(ch * zone.y1);

    // CTA: pin to bottom-right within margin (before generic x/y)
    if (role === 'cta') {
      const nx = cw - mx - node.box.w;
      const ny = Math.max(zTop, zBot - node.box.h);
      if (node.box.x !== nx) { notes.push(`cta→right`); node.box.x = nx; }
      if (Math.abs(node.box.y - ny) > 8) { notes.push(`cta→bottom`); node.box.y = ny; }
    } else {
      if (Math.abs(node.box.x - targetX) > colW * 0.5) {
        notes.push(`x ${node.box.x}→${targetX}`);
        node.box.x = targetX;
      }
      let ty = stackY[role] ?? zTop;
      ty = Math.max(zTop, Math.min(ty, zBot - node.box.h));
      if (node.box.y < zTop - 2 || node.box.y + node.box.h > zBot + 2 || Math.abs(node.box.y - ty) > ch * 0.02) {
        notes.push(`y ${node.box.y}→${ty}`);
        node.box.y = ty;
      }
      stackY[role] = ty + node.box.h + Math.round(ch * 0.02);
    }

    if (notes.length) summaries.push(`${role}: ${notes.join(', ')}`);
  }

  // Resolve vertical overlaps between text layers (cheap push-apart)
  const placed = texts.slice().sort((a, b) => a.box.y - b.box.y);
  for (let i = 1; i < placed.length; i++) {
    const prev = placed[i - 1];
    const cur = placed[i];
    const gap = Math.round(ch * 0.02);
    const minY = prev.box.y + prev.box.h + gap;
    if (cur.box.y < minY && overlapArea(prev.box, cur.box) > 0) {
      summaries.push(`${cur.role}: push y ${cur.box.y}→${minY}`);
      cur.box.y = minY;
    }
  }

  normalizeGroups(doc);
  const ad = smartAdRepair(doc, { kit });
  if (ad.summaries.length) summaries.push(...ad.summaries.slice(0, 2));
  return {
    summaries,
    summary: summaries.length
      ? `autolayout(${fmt}): ${summaries.slice(0, 4).join(' · ')}${summaries.length > 4 ? ` (+${summaries.length - 4})` : ''}`
      : `autolayout(${fmt}): already aligned`,
    format: fmt,
  };
}

/** Score 0..100 for how layout-ready a doc is (higher = better). */
export function layoutScore(doc, kit = null) {
  let score = 100;
  const { w: cw, h: ch } = doc.canvas;
  const texts = leaves(doc.layers || []).filter((n) => isTextual(n) && n.role !== 'base' && !n.hidden);
  const mx = cw * MARGIN;

  for (const t of texts) {
    const target = roleFontSize(doc, t.role || 'caption');
    const fs = (t.style && t.style.fontSize) || 0;
    if (fs && Math.abs(fs - target) / target > 0.35) score -= 12;
    const b = t.box;
    if (b.x < mx * 0.5 || cw - (b.x + b.w) < mx * 0.5) score -= 8;
    if (b.y < ch * 0.02 || ch - (b.y + b.h) > ch * 0.98) score -= 5;
    if (t.autoH && b.h < estimateMinH(t)) score -= 10;
  }
  const sizes = texts.map((t) => (t.style && t.style.fontSize) || 40).sort((a, b) => b - a);
  if (sizes.length >= 2 && sizes[0] < sizes[1] * 1.35) score -= 15;
  return Math.max(0, Math.min(100, score));
}

function estimateMinH(node) {
  return Math.max((node.style?.fontSize || 40), Math.round((node.style?.fontSize || 40) * 1.3));
}
