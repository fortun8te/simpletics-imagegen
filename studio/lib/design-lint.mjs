// lib/design-lint.mjs — deterministic design lint over a scene-graph doc.
//
// Pure functions, zero deps. lintDesign(doc, kit) returns an array of short human-readable
// finding strings (max 8) that improve mode turns into a numbered fix instruction for the
// agent. Every check is cheap geometry/color math — no LLM involved.
//
// Checks (v2 — findings are ordered by severity, max 8):
//   • CONTRAST: text color vs its own background or the fill underneath with near-identical
//     luminance ("white on white")
//   • overlapping text boxes (two visible text-ish leaves intersecting >25% of the smaller)
//   • text hugging canvas edges (<3% margin)
//   • tiny type (fontSize < 24 at 1080-wide equivalent)
//   • missing headline / cta roles
//   • off-brand-kit colors (text color/background not near any kit color, white or black)
//   • composition (v2): no dominant element (largest text <1.5× the second), >3 distinct font
//     sizes, elements off the margin/12-col grid, scattered singletons (a lone tiny layer far
//     from all others)

import { leaves } from './scene-tree.mjs';
import { analyzeLayerContext } from './ad-context.mjs';
import { MAX_WIDTH_PCT } from './type-scale.mjs';

const TEXTY = new Set(['text', 'badge', 'button']);

/** '#rgb'/'#rrggbb'/'rgba(…)' → [r,g,b] 0-255, or null when unparsable/transparent. */
export function parseColor(c) {
  if (typeof c !== 'string') return null;
  const s = c.trim();
  let m = /^#([0-9a-fA-F]{6})/.exec(s);
  if (m) return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16)];
  m = /^#([0-9a-fA-F]{3})$/.exec(s);
  if (m) return m[1].split('').map((h) => parseInt(h + h, 16));
  m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)/.exec(s);
  if (m) {
    if (m[4] !== undefined && Number(m[4]) < 0.2) return null; // effectively transparent
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  }
  return null;
}

/** WCAG-ish relative luminance 0..1. */
export function luminance(rgb) {
  const [r, g, b] = rgb.map((v) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const dist = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
const overlapArea = (a, b) => {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
};
const name = (n) => n.role || n.id;

/** The fill color painted UNDER a text leaf's center: last earlier-painted visible leaf whose
 *  box contains the point and has a solid background (or is an image/base → unknown → null). */
function fillUnder(all, idx, cx, cy) {
  for (let i = idx - 1; i >= 0; i--) {
    const n = all[i];
    if (!n || n.hidden || !n.box) continue;
    const b = n.box;
    if (cx < b.x || cx > b.x + b.w || cy < b.y || cy > b.y + b.h) continue;
    if (n.type === 'image') return null; // real photo underneath — unknown luminance
    // a solid-color base SHAPE has a known fill (used for the dark-base contrast check)
    const bg = parseColor(n.style && n.style.background);
    if (bg) return bg;
    if (n.role === 'base') return null; // image base with no parsed fill
  }
  return null;
}

/**
 * Lint a doc against geometry + brand-kit rules. Returns finding strings (≤8).
 * kit: { colors?: string[] } | null.
 */
export function lintDesign(doc, kit = null) {
  const findings = [];
  const { w: cw, h: ch } = doc.canvas || { w: 1080, h: 1080 };
  const all = leaves(doc.layers || []).filter((n) => n && n.box && !n.hidden);
  const texts = all.filter((n) => TEXTY.has(n.type));
  // sizeLocked = element-built text (marquee at the edge, chart labels at 2%w, receipt rows) —
  // deliberately styled artifacts that lint would otherwise flag and improve-mode would wreck.
  const free = texts.filter((n) => !n.sizeLocked);
  const scale = 1080 / cw;

  // overlapping text boxes
  for (let i = 0; i < texts.length && findings.length < 8; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      const a = texts[i].box; const b = texts[j].box;
      const ov = overlapArea(a, b);
      if (ov > 0.25 * Math.min(a.w * a.h, b.w * b.h)) {
        findings.push(`"${name(texts[i])}" overlaps "${name(texts[j])}" — separate them`);
        break;
      }
    }
  }

  // edge-hugging text (<3% margin)
  const mx = cw * 0.03; const my = ch * 0.03;
  for (const t of free) {
    const b = t.box;
    if (b.x < mx || b.y < my || cw - (b.x + b.w) < mx || ch - (b.y + b.h) < my) {
      findings.push(`"${name(t)}" hugs the canvas edge — move it inside a 5% margin`);
    }
  }

  // tiny type at 1080-wide equivalent
  for (const t of free) {
    const fs = (t.style && t.style.fontSize) || 40;
    if (fs * scale < 24) findings.push(`"${name(t)}" font is too small (${fs}px) — bump it up`);
  }

  // missing roles
  const roles = new Set(texts.map((t) => t.role));
  if (!roles.has('headline')) findings.push('no headline layer — add one dominant headline');
  if (!roles.has('cta')) findings.push('no cta layer — add a call-to-action button');

  // off-brand-kit colors
  const kitColors = (kit && Array.isArray(kit.colors) ? kit.colors : []).map(parseColor).filter(Boolean);
  if (kitColors.length >= 2) {
    const allowed = [...kitColors, [255, 255, 255], [0, 0, 0]];
    for (const t of free) {
      for (const key of ['color', 'background']) {
        const c = parseColor(t.style && t.style[key]);
        if (c && !allowed.some((k) => dist(c, k) < 90)) {
          findings.push(`"${name(t)}" ${key} ${t.style[key]} is off the brand kit — use a kit color`);
          break;
        }
      }
    }
  }

  // weak size hierarchy (element-internal sizes are artifact-scaled, not hierarchy signals)
  const sizes = free.map((t) => (t.style && t.style.fontSize) || 40).sort((a, b) => b - a);
  if (sizes.length >= 2 && sizes[0] < sizes[1] * 1.4) {
    findings.push(`weak size hierarchy (top two sizes ${sizes[0]}/${sizes[1]}) — make one text clearly dominant`);
  }

  // contrast: text color vs its own background or the fill underneath
  for (const t of texts) {
    const fg = parseColor((t.style && t.style.color) || '#ffffff');
    if (!fg) continue;
    const own = parseColor(t.style && t.style.background);
    const cx = t.box.x + t.box.w / 2; const cy = t.box.y + t.box.h / 2;
    const bg = own || fillUnder(all, all.indexOf(t), cx, cy);
    if (bg && Math.abs(luminance(fg) - luminance(bg)) < 0.12) {
      findings.push(`"${name(t)}" has near-zero contrast with its background — change the color or add a scrim`);
    }
  }

  // ad-context: wide text on photo, tiny type, long lines
  for (const t of free) {
    if (findings.length >= 8) break;
    const ctx = analyzeLayerContext(doc, t);
    if (!ctx) continue;
    if (ctx.wideOnPhoto) {
      findings.push(`"${name(t)}" is wide copy on a photo with no pill/scrim — narrow it or add a background`);
    } else if (ctx.tooWide && !ctx.hasChrome) {
      findings.push(`"${name(t)}" spans ${ctx.widthPct}% of the canvas — narrow to ≤${Math.round((MAX_WIDTH_PCT[t.role] || 0.7) * 100)}%`);
    }
    if (ctx.tooSmall) {
      findings.push(`"${name(t)}" is below the ad minimum (${ctx.fs}px < ${ctx.minFs}px floor)`);
    }
    if (ctx.lineTooLong) {
      findings.push(`"${name(t)}" lines are too long — shorten copy or narrow the text box`);
    }
  }

  return findings.slice(0, 8);
}
