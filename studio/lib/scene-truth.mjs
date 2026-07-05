// lib/scene-truth.mjs — PIXEL-TRUTH pass over an extraction / scene graph.
//
// Owner's verdict on copy fidelity: the DETAILS are wrong — background colors, text colors, font
// sizes, alignment — because the pipeline TRUSTS the reader's (vision model or scene-file) ESTIMATES
// for attributes that are MEASURABLE from the reference pixels. This module kills that class of
// error at the seam: for every measurable attribute, measure it from the reference image and
// OVERRIDE the reader's estimate when the pixels disagree.
//
//   1. PAGE BACKGROUND   — median of 8 border patches, excluding patches covered by any layer box
//   2. PANEL/BADGE FILLS — interior dominant color (15% inset), overlapping text/child sub-regions
//                          excluded; gradients / cutouts / alpha tints skipped
//   3. TEXT COLOR        — minority-cluster (glyph = ink) sampling inside the text box; the reader's
//                          color is kept when the box has no legible contrast (ambiguous)
//   4. FONT SIZE + BOX   — tight ink-row scan → real text block height + line count → derived size,
//                          clamped to 0.6–1.6× the reader's estimate; box snapped to the measured
//                          tight bounds plus symmetric padding
//   5. ALIGNMENT         — text within 2.5% of the canvas/card center-x snaps exactly; sibling left
//                          margins within 1.5% of the group mode are equalized (reading order kept)
//
// applySceneTruth(ext, imagePath) mutates `ext` in place ({canvas, layers[px], background, ...})
// and returns { ext, corrections: [human-readable strings] }. Deterministic (fixed sampling grids,
// no randomness). NEVER throws — the pass, each stage, and each layer are all best-effort.
//
// Reuses lib/layout-extract.mjs exported pixel utilities (sampleRegionStats, isPhotoLike) for
// region color/texture stats; the glyph/ink samplers those stats can't express are small local
// reimplementations over a zero-dep PNG decode (sips-transcode fallback for webp/jpg).

import { readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { inflateSync } from 'node:zlib';
import { sampleRegionStats, isPhotoLike } from './layout-extract.mjs';

// ── Thresholds (all normalized 0..1 RGB distance unless noted) ──────────────────────────────────
const BG_DIST = 0.08;          // page background override threshold (spec: ~0.08)
const FILL_DIST = 0.08;        // panel/badge/button fill override threshold
const TEXT_DIST = 0.12;        // text color override needs STRONG disagreement
const GLYPH_CONTRAST_MIN = 0.12; // below this the box has no legible ink → keep reader color
const CENTER_SNAP_FRAC = 0.025;  // 2.5% of canvas width
const MARGIN_SNAP_FRAC = 0.015;  // 1.5% of canvas width
const MIN_FILL_AREA_FRAC = 0.005; // 0.5% of canvas area
const FONT_CLAMP_LO = 0.6, FONT_CLAMP_HI = 1.6; // vs the reader's estimate
const FONT_CHURN_MIN = 0.08;   // <8% relative delta → keep reader's size (don't churn)
const INK_CONTRAST = 0.22;     // |lum − boxBgLum| for a pixel to count as ink
const INK_ROW_DENSITY = 0.02;  // ≥2% ink pixels across the row → ink row

// ── tiny color helpers (local copies — layout-extract's are not exported) ───────────────────────
const toHexByte = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
const rgbToHex = (r, g, b) => `#${toHexByte(r)}${toHexByte(g)}${toHexByte(b)}`;
const relLum = (r, g, b) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; // 0..1
function hexToRgb(hex) {
  const h = String(hex || '').replace('#', '');
  if (h.length >= 6) return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
  if (h.length >= 3) return { r: parseInt(h[0] + h[0], 16), g: parseInt(h[1] + h[1], 16), b: parseInt(h[2] + h[2], 16) };
  return null;
}
function colorDist(a, b) {
  const A = hexToRgb(a), B = hexToRgb(b);
  if (!A || !B || [A.r, A.g, A.b, B.r, B.g, B.b].some((v) => !Number.isFinite(v))) return 1;
  return Math.sqrt((A.r - B.r) ** 2 + (A.g - B.g) ** 2 + (A.b - B.b) ** 2) / 441.67295593;
}
/** Opaque solid hex only (#rgb / #rrggbb). 8-digit tints (alpha) and gradient strings/objects are
 *  NOT measurable flat fills — the caller must skip those layers. */
const isOpaqueHex = (v) => typeof v === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v.trim());
/** Per-channel median of a list of hex colors — robust to a couple of outlier patches. */
function medianHex(hexes) {
  const rgbs = hexes.map(hexToRgb).filter(Boolean);
  if (!rgbs.length) return null;
  const med = (key) => {
    const vals = rgbs.map((c) => c[key]).sort((a, b) => a - b);
    const m = Math.floor(vals.length / 2);
    return vals.length % 2 ? vals[m] : (vals[m - 1] + vals[m]) / 2;
  };
  return rgbToHex(med('r'), med('g'), med('b'));
}

// ── zero-dep PNG decode (+ sips transcode fallback), single-entry cache ─────────────────────────
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}
function decodePng(buf) {
  try {
    if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) return null;
    let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
    const idat = [];
    let off = 8;
    while (off + 8 <= buf.length) {
      const len = buf.readUInt32BE(off);
      const type = buf.toString('ascii', off + 4, off + 8);
      const s = off + 8;
      if (type === 'IHDR') {
        width = buf.readUInt32BE(s); height = buf.readUInt32BE(s + 4);
        bitDepth = buf[s + 8]; colorType = buf[s + 9]; interlace = buf[s + 12];
      } else if (type === 'IDAT') idat.push(buf.subarray(s, s + len));
      else if (type === 'IEND') break;
      off = s + len + 4;
    }
    if (!width || !height || bitDepth !== 8 || interlace !== 0) return null;
    const channels = colorType === 2 ? 3 : colorType === 6 ? 4 : 0;
    if (!channels) return null;
    const raw = inflateSync(Buffer.concat(idat));
    const stride = width * channels;
    if (raw.length < (stride + 1) * height) return null;
    const out = Buffer.alloc(stride * height);
    let prevRow = Buffer.alloc(stride);
    let pos = 0;
    for (let y = 0; y < height; y++) {
      const filter = raw[pos++];
      const row = out.subarray(y * stride, (y + 1) * stride);
      for (let i = 0; i < stride; i++) {
        const x = raw[pos++];
        const a = i >= channels ? row[i - channels] : 0;
        const b = prevRow[i];
        const c = i >= channels ? prevRow[i - channels] : 0;
        let val;
        switch (filter) {
          case 1: val = x + a; break;
          case 2: val = x + b; break;
          case 3: val = x + ((a + b) >> 1); break;
          case 4: val = x + paeth(a, b, c); break;
          default: val = x;
        }
        row[i] = val & 0xff;
      }
      prevRow = row;
    }
    return { width, height, channels, data: out };
  } catch { return null; }
}
let _decodeCache = { path: null, img: undefined };
function decodeImage(imagePath) {
  if (_decodeCache.path === imagePath && _decodeCache.img !== undefined) return _decodeCache.img;
  let img = null;
  try {
    const buf = readFileSync(imagePath);
    if (buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47) img = decodePng(buf);
    if (!img) { // webp/jpg (or an exotic PNG) → transcode with sips, retry
      let tmp = null;
      try {
        tmp = join(tmpdir(), `scenetruth-${Date.now().toString(36)}-${process.pid.toString(36)}.png`);
        const r = spawnSync('sips', ['-s', 'format', 'png', imagePath, '--out', tmp], { timeout: 15_000, encoding: 'utf8' });
        if (r.status === 0 && existsSync(tmp)) img = decodePng(readFileSync(tmp));
      } catch { /* sips unavailable → give up gracefully */ }
      finally { if (tmp) { try { rmSync(tmp, { force: true }); } catch { /* best effort */ } } }
    }
  } catch { img = null; }
  _decodeCache = { path: imagePath, img };
  return img;
}

// ── geometry helpers ─────────────────────────────────────────────────────────────────────────────
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
function rectsIntersect(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}
function rectContains(outer, inner, slack) {
  return inner.x >= outer.x - slack && inner.y >= outer.y - slack &&
    inner.x + inner.w <= outer.x + outer.w + slack && inner.y + inner.h <= outer.y + outer.h + slack;
}
/** Flatten a possibly-nested layer tree to leaves (group children keep absolute boxes). */
function collectLeaves(layers, out = []) {
  for (const l of (Array.isArray(layers) ? layers : [])) {
    if (!l) continue;
    if (Array.isArray(l.children) && l.children.length) collectLeaves(l.children, out);
    else out.push(l);
  }
  return out;
}
/** Scene files/pool extraction both emit PIXEL boxes, but tolerate a pct-space scene (0..100). */
function detectUnit(leaves, canvas) {
  if (canvas.w <= 150 && canvas.h <= 150) return 'px';
  const boxes = leaves.map((l) => l.box).filter((b) => b && num(b.x) != null);
  if (!boxes.length) return 'px';
  return boxes.every((b) => (num(b.x) ?? 0) + (num(b.w) ?? 0) <= 100.5 && (num(b.y) ?? 0) + (num(b.h) ?? 0) <= 100.5)
    ? 'pct' : 'px';
}
function readPxBox(l, unit, canvas) {
  const b = l?.box;
  if (!b) return null;
  const x = num(b.x), y = num(b.y), w = num(b.w), h = num(b.h);
  if (x == null || y == null || w == null || h == null || w <= 0 || h <= 0) return null;
  return unit === 'pct'
    ? { x: (x / 100) * canvas.w, y: (y / 100) * canvas.h, w: (w / 100) * canvas.w, h: (h / 100) * canvas.h }
    : { x, y, w, h };
}
function writePxBox(l, px, unit, canvas) {
  if (unit === 'pct') {
    l.box = {
      x: Math.round((px.x / canvas.w) * 10000) / 100, y: Math.round((px.y / canvas.h) * 10000) / 100,
      w: Math.round((px.w / canvas.w) * 10000) / 100, h: Math.round((px.h / canvas.h) * 10000) / 100,
    };
  } else {
    l.box = { x: Math.round(px.x), y: Math.round(px.y), w: Math.round(px.w), h: Math.round(px.h) };
  }
}
/** px rect → the 0..100 pct region shape sampleRegionStats expects. */
function pxToPct(r, canvas) {
  return {
    x: clamp((r.x / canvas.w) * 100, 0, 100), y: clamp((r.y / canvas.h) * 100, 0, 100),
    w: clamp((r.w / canvas.w) * 100, 0, 100), h: clamp((r.h / canvas.h) * 100, 0, 100),
  };
}
const labelOf = (l) => String(l.id || l.name || l.role || (typeof l.text === 'string' && l.text.trim().slice(0, 24)) || l.type || 'layer');
const isTexty = (l) => (l.type === 'text' || l.type === 'badge' || l.type === 'button') && typeof l.text === 'string' && l.text.trim().length > 0;

// ── local glyph/fill cluster sampler — luminance split inside a text-bearing box ────────────────
// (Reimplementation of layout-extract's unexported sampleGlyphColor, in px space over our decode,
// extended to also report the MAJORITY cluster: a badge/button carries its OWN glyphs, so its fill
// is the majority side of the same split — patch grids can't exclude a layer's own text.)
// `insetX`/`insetY` are fractions of the box; rounded pills need a radius-sized horizontal inset
// so the page background peeking past the round caps can't contaminate either cluster.
function clusterBox(img, box, insetX = 0.06, insetY = 0.06) {
  const { width: W, height: H, channels: ch, data } = img;
  const x0 = clamp(Math.floor(box.x + box.w * insetX), 0, W - 1);
  const y0 = clamp(Math.floor(box.y + box.h * insetY), 0, H - 1);
  const x1 = clamp(Math.ceil(box.x + box.w * (1 - insetX)), x0 + 1, W);
  const y1 = clamp(Math.ceil(box.y + box.h * (1 - insetY)), y0 + 1, H);
  if (x1 - x0 < 2 || y1 - y0 < 2) return null;
  const stepX = Math.max(1, Math.floor((x1 - x0) / 60));
  const stepY = Math.max(1, Math.floor((y1 - y0) / 60));
  const px = [];
  let sumL = 0;
  for (let y = y0; y < y1; y += stepY) {
    for (let x = x0; x < x1; x += stepX) {
      const p = (y * W + x) * ch;
      const a = ch === 4 ? data[p + 3] : 255;
      if (a < 40) continue;
      const r = data[p], g = data[p + 1], b = data[p + 2];
      const l = relLum(r, g, b);
      px.push([r, g, b, l]); sumL += l;
    }
  }
  if (px.length < 8) return null;
  const meanL = sumL / px.length;
  const avg = (arr) => {
    let r = 0, g = 0, b = 0;
    for (const q of arr) { r += q[0]; g += q[1]; b += q[2]; }
    const n = arr.length; return { r: r / n, g: g / n, b: b / n };
  };
  const light = px.filter((q) => q[3] >= meanL);
  const dark = px.filter((q) => q[3] < meanL);
  const toHexC = (c) => rgbToHex(c.r, c.g, c.b);
  if (!light.length || !dark.length) return { inkHex: null, fillHex: toHexC(avg(px)), contrast: 0 };
  const lightAvg = avg(light), darkAvg = avg(dark);
  const lightL = relLum(lightAvg.r, lightAvg.g, lightAvg.b);
  const darkL = relLum(darkAvg.r, darkAvg.g, darkAvg.b);
  const contrast = Math.abs(lightL - darkL);
  // No legible split → the whole box IS the fill; there is no measurable ink.
  if (contrast < GLYPH_CONTRAST_MIN) return { inkHex: null, fillHex: toHexC(avg(px)), contrast };
  // ink = the MINORITY cluster (glyph strokes cover less area than the fill they sit on);
  // fill = the other (majority) cluster.
  const ratio = light.length / px.length;
  let inkArr, fill;
  if (ratio < 0.42) { inkArr = light; fill = darkAvg; }
  else if (ratio > 0.58) { inkArr = dark; fill = lightAvg; }
  else if (Math.abs(lightL - meanL) >= Math.abs(darkL - meanL)) { inkArr = light; fill = darkAvg; }
  else { inkArr = dark; fill = lightAvg; }
  // INK-CORE refinement (proven on 052's pills): a thin glyph's minority cluster is dominated by
  // ANTIALIASED edge pixels (ink↔fill blends), which drags the average toward the fill. The true
  // stroke color lives in the cluster's core — the half of the cluster on the FAR side of its own
  // mean luminance, away from the fill.
  const inkMeanL = inkArr.reduce((s, q) => s + q[3], 0) / inkArr.length;
  const fillL = relLum(fill.r, fill.g, fill.b);
  const core = inkArr.filter((q) => (fillL >= inkMeanL ? q[3] < inkMeanL : q[3] > inkMeanL));
  const ink = avg(core.length >= 4 ? core : inkArr);
  return { inkHex: toHexC(ink), fillHex: toHexC(fill), contrast };
}
/** Radius-aware sampling insets for a layer: rounded badge/button caps let the page background
 *  into the box's corners — inset horizontally past the corner radius before sampling. */
function boxInsets(l, px) {
  if (l.type === 'badge' || l.type === 'button') {
    const r = (l.style && num(l.style.radius)) || px.h * 0.25;
    return { insetX: clamp(r / Math.max(1, px.w), 0.08, 0.35), insetY: 0.15 };
  }
  return { insetX: 0.06, insetY: 0.06 };
}

// ── tight ink-row scan — real text block height + line count from pixels ────────────────────────
function measureInkRows(img, box) {
  const { width: W, height: H, channels: ch, data } = img;
  const x0 = clamp(Math.floor(box.x), 0, W - 1);
  const x1 = clamp(Math.ceil(box.x + box.w), x0 + 1, W);
  const y0 = clamp(Math.floor(box.y), 0, H - 1);
  const y1 = clamp(Math.ceil(box.y + box.h), y0 + 1, H);
  if (x1 - x0 < 8 || y1 - y0 < 8) return null;
  const colStep = Math.max(1, Math.floor((x1 - x0) / 160));
  const rowStep = (y1 - y0) > 400 ? 2 : 1;
  const rows = [];
  const all = [];
  for (let y = y0; y < y1; y += rowStep) {
    const row = [];
    for (let x = x0; x < x1; x += colStep) {
      const p = (y * W + x) * ch;
      const a = ch === 4 ? data[p + 3] : 255;
      if (a < 32) continue;
      const l = relLum(data[p], data[p + 1], data[p + 2]);
      row.push(l); all.push(l);
    }
    rows.push({ y, row });
  }
  if (all.length < 32) return null;
  const sorted = all.sort((a, b) => a - b);
  const bgL = sorted[Math.floor(sorted.length / 2)]; // the fill dominates a text box → median = bg
  const densities = rows.map(({ y, row }) => {
    if (!row.length) return { y, d: 0 };
    let ink = 0;
    for (const l of row) if (Math.abs(l - bgL) > INK_CONTRAST) ink++;
    return { y, d: ink / row.length };
  });
  // ADAPTIVE row threshold (proven on 052's headline): a fixed 2% floor lets sparse descender /
  // ascender rows bridge the inter-line gap and weld two lines into one giant "line" (block 140px
  // → fontSize catastrophically overshoots into the clamp). Glyph BODY rows are an order of
  // magnitude denser than a lone descender stroke — threshold relative to the densest row.
  const maxD = Math.max(...densities.map((r) => r.d));
  const inkThresh = Math.max(INK_ROW_DENSITY, maxD * 0.15);
  const inkRows = densities.filter((r) => r.d >= inkThresh).map((r) => r.y);
  if (!inkRows.length) return null;
  // consecutive ink rows → runs
  let runs = [];
  let start = inkRows[0], prev = inkRows[0];
  for (let i = 1; i < inkRows.length; i++) {
    if (inkRows[i] - prev <= rowStep) { prev = inkRows[i]; continue; }
    runs.push({ top: start, bottom: prev });
    start = prev = inkRows[i];
  }
  runs.push({ top: start, bottom: prev });
  // SPECK DROP (proven on 052's headline): 1-2 row fragments (a lone cap top, a diacritic, noise)
  // are not lines — they split real lines and wreck the baseline pitch. Anything under 25% of the
  // tallest run is a speck.
  const rh = (r) => r.bottom - r.top + rowStep;
  const tallestRun = Math.max(...runs.map(rh));
  const solid = runs.filter((r) => rh(r) >= Math.max(2, tallestRun * 0.25));
  if (solid.length) runs = solid;
  // merge sub-line gaps (diacritics/underlines): gap ≤ 30% of the median run height
  const heights = runs.map(rh).sort((a, b) => a - b);
  const medH = heights[Math.floor(heights.length / 2)];
  const mergeGap = Math.max(2, Math.round(medH * 0.3));
  const merged = [runs[0]];
  for (let i = 1; i < runs.length; i++) {
    const last = merged[merged.length - 1];
    if (runs[i].top - last.bottom <= mergeGap) last.bottom = runs[i].bottom;
    else merged.push(runs[i]);
  }
  runs = merged;
  const top = runs[0].top, bottom = runs[runs.length - 1].bottom + rowStep - 1;
  return { runs, top, bottom, blockH: bottom - top + 1 };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// STAGES — each takes (ctx) = { ext, imagePath, canvas, geom, unit, img, corrections } and is
// wrapped best-effort by the caller. `geom` = [{ l, px }] leaf layers with resolved px boxes.
// ═════════════════════════════════════════════════════════════════════════════════════════════════

// 1. PAGE BACKGROUND — median of border patches not covered by any layer box.
function truthBackground(ctx) {
  const { ext, imagePath, canvas, geom, corrections } = ctx;
  if (ext.backgroundIsPhoto) return; // a photo background has no flat fill to correct
  if (ext.background && typeof ext.background === 'object') return; // gradient — not a flat sample
  const m = Math.max(2, Math.round(Math.min(canvas.w, canvas.h) * 0.01)); // border margin
  const s = Math.max(8, Math.round(Math.min(canvas.w, canvas.h) * 0.05)); // patch size
  const midX = Math.round(canvas.w / 2 - s / 2), midY = Math.round(canvas.h / 2 - s / 2);
  const patches = [ // 8 patches along the canvas border
    { x: m, y: m, w: s, h: s }, { x: midX, y: m, w: s, h: s }, { x: canvas.w - m - s, y: m, w: s, h: s },
    { x: m, y: canvas.h - m - s, w: s, h: s }, { x: midX, y: canvas.h - m - s, w: s, h: s }, { x: canvas.w - m - s, y: canvas.h - m - s, w: s, h: s },
    { x: m, y: midY, w: s, h: s }, { x: canvas.w - m - s, y: midY, w: s, h: s },
  ];
  const free = patches.filter((p) => !geom.some((g) => rectsIntersect(p, g.px)));
  const stats = free
    .map((p) => sampleRegionStats(imagePath, pxToPct(p, canvas)))
    .filter((st) => st && !isPhotoLike(st)); // photo-textured border patches can't vote
  if (stats.length < 2) return; // not enough uncovered flat border to measure — keep the reader
  const measured = medianHex(stats.map((st) => st.hex));
  if (!measured) return;
  // agreement guard: if the surviving patches disagree wildly, the border isn't one flat page bg
  const agreeing = stats.filter((st) => colorDist(st.hex, measured) <= 0.10).length;
  if (agreeing < Math.ceil(stats.length * 0.6)) return;
  const prior = isOpaqueHex(ext.background) ? ext.background.trim() : null;
  const d = prior ? colorDist(prior, measured) : 1;
  if (prior && d <= BG_DIST) return;
  ext.background = measured;
  corrections.push(`background: ${prior || String(ext.background && '(non-hex)') || '(none)'} → ${measured} (median of ${stats.length} uncovered border patches, Δ${d.toFixed(2)})`);
  // keep the implied theme consistent with the measured background
  const rgb = hexToRgb(measured);
  if (rgb && (ext.theme === 'light' || ext.theme === 'dark')) {
    const theme = relLum(rgb.r, rgb.g, rgb.b) < 0.5 ? 'dark' : 'light';
    if (theme !== ext.theme) { ext.theme = theme; corrections.push(`theme: follows measured background → ${theme}`); }
  }
}

// 2. CARD/PANEL/BADGE/BUTTON FILLS — interior dominant color, child/text sub-regions excluded.
function truthFills(ctx) {
  const { imagePath, canvas, geom, img, corrections } = ctx;
  for (const g of geom) {
    try {
      const l = g.l;
      if (!['shape', 'badge', 'button'].includes(l.type)) continue;
      if (l.cutoutCandidate) continue; // photo crop — its fill is a placeholder, not a claim
      const bg = l.style && l.style.background;
      if (!isOpaqueHex(bg)) continue; // gradients (objects / gradient strings) + alpha tints skipped
      if ((g.px.w * g.px.h) / (canvas.w * canvas.h) < MIN_FILL_AREA_FRAC) continue;
      // A badge/button carries its OWN glyphs — no child box exists to exclude them, so a patch
      // grid would tint the fill with ink. Measure the MAJORITY luminance cluster instead
      // (radius-aware inset keeps the page bg outside the rounded caps out of both clusters).
      if (isTexty(l)) {
        if (!img) continue;
        const { insetX, insetY } = boxInsets(l, g.px);
        const sx = img.width / canvas.w, sy = img.height / canvas.h;
        const cl = clusterBox(img, { x: g.px.x * sx, y: g.px.y * sy, w: g.px.w * sx, h: g.px.h * sy }, insetX, insetY);
        if (!cl || !cl.fillHex) continue;
        const d = colorDist(bg.trim(), cl.fillHex);
        if (d <= FILL_DIST) continue;
        l.style.background = cl.fillHex;
        corrections.push(`${labelOf(l)} fill: ${bg} → ${cl.fillHex} (majority cluster, Δ${d.toFixed(2)})`);
        continue;
      }
      const inner = { // 15% inset — skip borders/strokes/rounded corners
        x: g.px.x + g.px.w * 0.15, y: g.px.y + g.px.h * 0.15,
        w: g.px.w * 0.7, h: g.px.h * 0.7,
      };
      // 4×4 sub-patch grid; drop patches covered by overlapping text / smaller child boxes
      const others = geom.filter((o) => o !== g && rectsIntersect(o.px, inner) &&
        (isTexty(o.l) || o.px.w * o.px.h < g.px.w * g.px.h));
      const cells = [];
      for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
        cells.push({ x: inner.x + (inner.w / 4) * c, y: inner.y + (inner.h / 4) * r, w: inner.w / 4, h: inner.h / 4 });
      }
      const free = cells.filter((cell) => !others.some((o) => rectsIntersect(cell, o.px)));
      if (free.length < 3) continue; // interior fully covered — can't measure cleanly
      const stats = free
        .map((cell) => sampleRegionStats(imagePath, pxToPct(cell, canvas)))
        .filter((st) => st && !isPhotoLike(st));
      if (stats.length < 3) continue; // textured interior → this is imagery, not a flat fill
      const measured = medianHex(stats.map((st) => st.hex));
      if (!measured) continue;
      const d = colorDist(bg.trim(), measured);
      if (d <= FILL_DIST) continue;
      l.style.background = measured;
      corrections.push(`${labelOf(l)} fill: ${bg} → ${measured} (interior median of ${stats.length} patches, Δ${d.toFixed(2)})`);
    } catch { /* best-effort per layer */ }
  }
}

// 3. TEXT COLOR — glyph (minority-cluster) sample; keep the reader's color when ambiguous.
function truthTextColor(ctx) {
  const { canvas, geom, img, corrections } = ctx;
  if (!img) return;
  const sx = img.width / canvas.w, sy = img.height / canvas.h; // canvas px → image px
  for (const g of geom) {
    try {
      const l = g.l;
      if (!isTexty(l)) continue;
      const { insetX, insetY } = boxInsets(l, g.px);
      const cl = clusterBox(img, { x: g.px.x * sx, y: g.px.y * sy, w: g.px.w * sx, h: g.px.h * sy }, insetX, insetY);
      if (!cl || !cl.inkHex || cl.contrast < GLYPH_CONTRAST_MIN) continue; // ambiguous → keep reader
      const prior = l.style && isOpaqueHex(l.style.color) ? l.style.color.trim() : null;
      if (prior && colorDist(prior, cl.inkHex) <= TEXT_DIST) continue; // agreement — keep reader
      l.style = l.style || {};
      const was = prior || l.style.color || '(none)';
      l.style.color = cl.inkHex;
      corrections.push(`${labelOf(l)} color: ${was} → ${cl.inkHex} (glyph sample, contrast ${cl.contrast.toFixed(2)})`);
    } catch { /* best-effort per layer */ }
  }
}

// 4. FONT SIZE + tight box from ink rows.
function truthFontSize(ctx) {
  const { canvas, geom, unit, img, corrections } = ctx;
  if (!img) return;
  const sx = img.width / canvas.w, sy = img.height / canvas.h; // canvas px → image px
  for (const g of geom) {
    try {
      const l = g.l;
      if (l.type !== 'text' || !isTexty(l)) continue; // badges/buttons: box ≫ ink, skip
      const reader = l.style ? num(l.style.fontSize) : null;
      if (!reader || reader <= 0) continue; // no estimate to correct against
      const imgBox = { x: g.px.x * sx, y: g.px.y * sy, w: g.px.w * sx, h: g.px.h * sy };
      const ink = measureInkRows(img, imgBox);
      if (!ink || ink.runs.length > 8 || ink.blockH < 6) continue; // noise / nothing legible
      const lines = ink.runs.length;
      // Derived size: for multi-line text the per-line block height is the baseline pitch
      // (blockHeight/lines with the inter-line gap included) → fontSize = pitch / 1.25. A single
      // tight-measured line has NO line box in its ink — the ink spans ~0.72em (cap+descender),
      // so dividing by 1.25 would systematically underestimate ~40%; use the ink-to-em ratio.
      let fsImg;
      if (lines >= 2) fsImg = ((ink.runs[lines - 1].top - ink.runs[0].top) / (lines - 1)) / 1.25;
      else fsImg = ink.blockH / 0.72;
      let fs = fsImg / sy; // back to canvas px
      // MULTI-LINE CONSERVATISM (ad 009): a ≥3-line body sitting near other content easily
      // MERGES neighbours into its ink rows — the measurement then inflates size and box
      // (observed: 38→55 + box +100px → overlaps everything below). For multi-line text the
      // reader's estimate is usually sane; allow SHRINK freely but cap growth at +15%, and
      // never let the measured box EXPAND beyond the reader's bounds (tighten only).
      const growCap = lines >= 3 ? 1.15 : FONT_CLAMP_HI;
      fs = clamp(fs, reader * FONT_CLAMP_LO, reader * growCap);
      fs = Math.round(fs);
      if (Math.abs(fs - reader) / reader > FONT_CHURN_MIN) {
        l.style.fontSize = fs;
        corrections.push(`${labelOf(l)} fontSize: ${reader} → ${fs} (${lines} ink line${lines === 1 ? '' : 's'}, block ${Math.round(ink.blockH / sy)}px)`);
      }
      // box → measured tight bounds + symmetric padding (vertical; rows measure only vertically)
      const topC = ink.top / sy, blockC = ink.blockH / sy;
      const pad = Math.max(4, Math.round(blockC * 0.15));
      let newY = clamp(Math.round(topC - pad), 0, canvas.h - 1);
      let newH = clamp(Math.round(blockC + 2 * pad), 8, canvas.h - newY);
      if (lines >= 3) { // tighten-only for multi-line: stay within the reader's box
        newY = Math.max(newY, Math.round(g.px.y));
        newH = Math.min(newH, Math.round(g.px.h) - (newY - Math.round(g.px.y)));
        if (newH < 8) continue;
      }
      if (Math.abs(newY - g.px.y) >= 2 || Math.abs(newH - g.px.h) >= 2) {
        const before = `y${Math.round(g.px.y)} h${Math.round(g.px.h)}`;
        g.px = { ...g.px, y: newY, h: newH };
        writePxBox(l, g.px, unit, canvas);
        corrections.push(`${labelOf(l)} box: ${before} → y${newY} h${newH} (tight ink rows + ${pad}px pad)`);
      }
    } catch { /* best-effort per layer */ }
  }
}

// 5. ALIGNMENT — snap near-center text exactly; equalize near-identical sibling left margins.
function truthAlignment(ctx) {
  const { canvas, geom, unit, corrections } = ctx;
  const tolCenter = canvas.w * CENTER_SNAP_FRAC;
  const tolMargin = canvas.w * MARGIN_SNAP_FRAC;
  const texts = geom.filter((g) => isTexty(g.l));
  const cards = geom.filter((g) => ['shape', 'badge', 'button'].includes(g.l.type) && !isTexty(g.l));
  const centerSnapped = new Set();
  for (const g of texts) {
    try {
      const cx = g.px.x + g.px.w / 2;
      let target = null, ref = null;
      if (Math.abs(cx - canvas.w / 2) <= tolCenter) { target = canvas.w / 2; ref = 'canvas center'; }
      else {
        // smallest card whose box contains this text → its center is the intended axis
        const container = cards
          .filter((c) => rectContains(c.px, g.px, canvas.w * 0.02))
          .sort((a, b) => a.px.w * a.px.h - b.px.w * b.px.h)[0];
        if (container) {
          const ccx = container.px.x + container.px.w / 2;
          if (Math.abs(cx - ccx) <= tolCenter) { target = ccx; ref = `card '${labelOf(container.l)}' center`; }
        }
      }
      if (target == null) continue;
      const newX = Math.round(target - g.px.w / 2);
      if (Math.abs(newX - g.px.x) < 1) { centerSnapped.add(g); continue; }
      const before = Math.round(g.px.x);
      g.px = { ...g.px, x: newX };
      writePxBox(g.l, g.px, unit, canvas);
      centerSnapped.add(g);
      corrections.push(`${labelOf(g.l)}: center-x snapped x${before} → x${newX} (${ref})`);
    } catch { /* best-effort per layer */ }
  }
  // left-margin equalization over the remaining (left-anchored) text siblings
  try {
    const lefts = texts.filter((g) => !centerSnapped.has(g) &&
      String(g.l.style?.align || 'left').toLowerCase() !== 'center' &&
      String(g.l.style?.align || 'left').toLowerCase() !== 'right');
    const pool = [...lefts];
    while (pool.length >= 2) {
      // anchor = the x with the most siblings within tolerance (ties → leftmost, deterministic)
      let best = null;
      for (const a of pool) {
        const members = pool.filter((b) => Math.abs(b.px.x - a.px.x) < tolMargin);
        if (!best || members.length > best.members.length ||
          (members.length === best.members.length && a.px.x < best.anchor.px.x)) {
          best = { anchor: a, members };
        }
      }
      if (!best || best.members.length < 2) break;
      // mode = most frequent exact x in the cluster (ties → smallest), preserve reading order
      const counts = new Map();
      for (const mem of best.members) {
        const key = Math.round(mem.px.x);
        counts.set(key, (counts.get(key) || 0) + 1);
      }
      const mode = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
      for (const mem of best.members) {
        const cur = Math.round(mem.px.x);
        if (cur !== mode && Math.abs(cur - mode) < tolMargin) {
          mem.px = { ...mem.px, x: mode };
          writePxBox(mem.l, mem.px, unit, canvas);
          corrections.push(`${labelOf(mem.l)}: left margin x${cur} → x${mode} (sibling group mode)`);
        }
      }
      for (const mem of best.members) pool.splice(pool.indexOf(mem), 1);
    }
  } catch { /* best-effort */ }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════
/**
 * PIXEL-TRUTH pass: measure every measurable attribute of `ext` from the reference image and
 * override the reader's estimates on disagreement. Mutates `ext` in place; returns
 * { ext, corrections } where corrections is a human-readable list of every override applied.
 * Deterministic. Never throws.
 */
export function applySceneTruth(ext, imagePath) {
  const corrections = [];
  try {
    if (!ext || typeof ext !== 'object' || !Array.isArray(ext.layers)) return { ext, corrections };
    if (!imagePath || !existsSync(imagePath)) return { ext, corrections };
    const canvas = { w: num(ext.canvas?.w) || 1080, h: num(ext.canvas?.h) || 1080 };
    if (canvas.w < 8 || canvas.h < 8) return { ext, corrections };
    const leaves = collectLeaves(ext.layers);
    const unit = detectUnit(leaves, canvas);
    const geom = leaves
      .map((l) => ({ l, px: readPxBox(l, unit, canvas) }))
      .filter((g) => g.px);
    const img = decodeImage(imagePath); // for the local glyph/ink samplers (null → those stages skip)
    const ctx = { ext, imagePath, canvas, geom, unit, img, corrections };
    for (const stage of [truthBackground, truthFills, truthTextColor, truthFontSize, truthAlignment]) {
      try { stage(ctx); } catch { /* stage is best-effort */ }
    }
  } catch { /* never throw */ }
  return { ext, corrections };
}
