// lib/typo-truth.mjs — TYPO/BACKGROUND TRUTH v2: measured detection for the DETAIL classes the
// owner keeps flagging on copy runs — wrong boldness, undetected italics, missed subtle background
// gradients, wrong stroke widths on line/arrow shapes, star-rating glyph style.
//
// Sits AFTER lib/scene-truth.mjs in the harness (which fixes colors/sizes/alignment). This module
// covers what that pass does not measure:
//
//   1. FONT WEIGHT   — ink-pixel fraction inside the text block's tight ink rows maps to a weight
//                      class; the reader's fontWeight is overridden only on ≥200-weight disagreement
//                      and only UPWARD (thin measurements keep the reader's value — per spec).
//   2. ITALIC        — dominant glyph shear via per-line centroid drift (top-band ink centroid x vs
//                      bottom-band, normalized by their vertical distance ⇒ tan(slant)). |shear| >
//                      threshold ⇒ style.italic = true. NOTE: renderDesignHtml (lib/designstore.mjs)
//                      does NOT emit font-style yet — the field is recorded truth for the
//                      reader/judge and for whenever the renderer learns italics.
//   3. SUBTLE BG GRADIENT — 5×7 grid of background patches (layer boxes excluded), least-squares
//                      luminance plane fit; a monotonic drift > ~6% across the canvas replaces a
//                      solid ext.background with {type:'linear', angle, stops, from, to} (from/to
//                      kept for design-agent's baseFromSkeletonBackground). Kills the "product
//                      treated as if on a separate background" class.
//   4. STROKE/LINE   — for shape layers with shapeKind line/arrow: actual stroke thickness (median
//                      ink-run cross-section) + endpoints measured in the reference; box corrected
//                      (minor dim ±, major endpoints), measured thickness recorded as
//                      style.strokeWidthPx (renderer derives line width from the box, so the box is
//                      the actionable channel; the field is truth for the reader/judge).
//   5. STAR/BADGE    — small repeated glyph rows (star ratings): boundary compactness P²/(4πA) of
//                      the repeated components classifies rounded vs pointed tips ⇒
//                      style.starStyle = 'rounded'|'pointed' (recorded hint; renderer optional).
//
// applyTypoTruth(ext, imagePath) mutates `ext` in place and returns { ext, corrections }.
// Deterministic, zero-dep (local PNG decode + sips transcode fallback, same pattern as
// lib/scene-truth.mjs — those helpers are not exported from there, so small local copies live
// here). NEVER throws — the pass, each stage, and each layer are all best-effort.

import { readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { inflateSync } from 'node:zlib';
import { sampleRegionStats, isPhotoLike } from './layout-extract.mjs';

// ── Thresholds ───────────────────────────────────────────────────────────────────────────────────
// FONT-WEIGHT densities CALIBRATED 2026-07-05 against lib/self-vision.mjs renderCompPng renders of
// Inter (bundled @font-face, true per-weight files) measured with measureInkDensity:
//   UPPERCASE: w400 0.376 · w500 0.434 · w600 0.488 · w700 0.527 · w800 0.587
//   mixedcase: w400 0.319 · w500 0.355 · w600 0.395 · w700 0.430 · w800 0.462
// The two curves are offset (caps have no descenders and fill their rows), so the class floors are
// CASE-CONDITIONAL — each floor sits at the midpoint between adjacent measured weights. Upgrades
// only (thin/ambiguous measurements keep the reader's value) and only on ≥200-weight disagreement.
const DENSITY_FLOORS = {
  caps: { bold: 0.50, heavy: 0.56, ultra: 0.65 },  // ensure ≥700 / 800 / 900
  mixed: { bold: 0.41, heavy: 0.45, ultra: 0.52 },
};
const WEIGHT_OVERRIDE_GAP = 200; // only override when measurement and reader disagree by ≥ this

// ITALIC calibrated 2026-07-05 (headless-Chrome renders, measureShear): upright Helvetica/Georgia
// shear 0.00-0.01 gain 1.00; italics shear −0.19..−0.21 gain 1.06-1.10.
const ITALIC_SHEAR_MIN = 0.12;   // |tan(slant)| — true italics ≈ 0.21 (12°), upright ≈ 0.00
const ITALIC_GAIN_MIN = 1.04;    // sheared-projection energy must beat upright by ≥4% (real stems)

const BG_DRIFT_MIN = 0.06;       // ≥6% luminance drift across the canvas ⇒ real gradient
const BG_DRIFT_CORR = 0.8;       // |Pearson r| of lum vs projection ⇒ monotonic, not blotchy

const INK_CONTRAST = 0.22;       // |lum − regionBgLum| for a pixel to count as ink
const INK_ROW_MIN_FRAC = 0.02;   // ≥2% of tight-width ink pixels ⇒ ink row

const STROKE_MIN_DELTA_PX = 2;   // canvas px — smaller thickness disagreements are not corrected
const LINE_END_MIN_DELTA_PX = 6; // canvas px — smaller endpoint disagreements are not corrected

// STAR tip-mass fraction (ink share in the outer radial band d ≥ 0.8·rmax, calibrated on
// synthetic rasters 2026-07-05): pointed 5-star 0.078 · rounded star 0.139 · disc 0.369.
const STAR_TIP_FRAC_MAX = 0.10;

// ── tiny color/geometry helpers (scene-truth's are not exported — local copies) ──────────────────
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const toHexByte = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
const rgbToHex = (r, g, b) => `#${toHexByte(r)}${toHexByte(g)}${toHexByte(b)}`;
const relLum = (r, g, b) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; // 0..1
const isOpaqueHex = (v) => typeof v === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v.trim());
function hexToRgb(hex) {
  const h = String(hex || '').replace('#', '');
  if (h.length >= 6) return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
  if (h.length >= 3) return { r: parseInt(h[0] + h[0], 16), g: parseInt(h[1] + h[1], 16), b: parseInt(h[2] + h[2], 16) };
  return null;
}
/** Per-channel median of hex colors — robust to an outlier patch. */
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
/** Decode an image to { width, height, channels, data } — PNG natively, webp/jpg via sips.
 *  Exported for the calibration scratch script and tests. Returns null when undecodable. */
export function readImagePixels(imagePath) {
  if (_decodeCache.path === imagePath && _decodeCache.img !== undefined) return _decodeCache.img;
  let img = null;
  try {
    const buf = readFileSync(imagePath);
    if (buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47) img = decodePng(buf);
    if (!img) {
      let tmp = null;
      try {
        tmp = join(tmpdir(), `typotruth-${Date.now().toString(36)}-${process.pid.toString(36)}.png`);
        const r = spawnSync('sips', ['-s', 'format', 'png', imagePath, '--out', tmp], { timeout: 15_000, encoding: 'utf8' });
        if (r.status === 0 && existsSync(tmp)) img = decodePng(readFileSync(tmp));
      } catch { /* sips unavailable → give up gracefully */ }
      finally { if (tmp) { try { rmSync(tmp, { force: true }); } catch { /* best effort */ } } }
    }
  } catch { img = null; }
  _decodeCache = { path: imagePath, img };
  return img;
}

// ── layer-tree helpers (same conventions as scene-truth: px or pct boxes, absolute children) ────
function collectLeaves(layers, out = []) {
  for (const l of (Array.isArray(layers) ? layers : [])) {
    if (!l) continue;
    if (Array.isArray(l.children) && l.children.length) collectLeaves(l.children, out);
    else out.push(l);
  }
  return out;
}
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
function rectsIntersect(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

// ── ink mask over an image region ────────────────────────────────────────────────────────────────
// Background = median luminance of the region's border ring when the ring is uniform (glyphs
// rarely fill their box edge — robust even for tightly-boxed display text where ink covers >60%),
// else the dominant luminance cluster (32-bucket histogram mode ±1, ≥40% of samples). Ink =
// pixels contrasting the background by > INK_CONTRAST. Returns null when neither estimate holds
// (busy photo behind the glyphs) or the region is degenerate. Exported for tests/calibration.
export function inkMask(img, box, exclude = []) {
  if (!img || !box) return null;
  const x0 = clamp(Math.floor(box.x), 0, img.width - 1);
  const y0 = clamp(Math.floor(box.y), 0, img.height - 1);
  const x1 = clamp(Math.ceil(box.x + box.w), 0, img.width);
  const y1 = clamp(Math.ceil(box.y + box.h), 0, img.height);
  const w = x1 - x0, h = y1 - y0;
  if (w < 4 || h < 4) return null;
  const { channels: ch, data, width: iw } = img;
  const lum = new Float32Array(w * h);
  const valid = new Uint8Array(w * h).fill(1); // 0 = occluded by another layer — not ink, not bg
  for (const r of exclude) {
    const ex0 = clamp(Math.floor(r.x) - x0, 0, w), ex1 = clamp(Math.ceil(r.x + r.w) - x0, 0, w);
    const ey0 = clamp(Math.floor(r.y) - y0, 0, h), ey1 = clamp(Math.ceil(r.y + r.h) - y0, 0, h);
    for (let y = ey0; y < ey1; y++) for (let x = ex0; x < ex1; x++) valid[y * w + x] = 0;
  }
  const hist = new Uint32Array(32);
  let n = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!valid[i]) { lum[i] = -1; continue; }
      const p = ((y0 + y) * iw + (x0 + x)) * ch;
      const a = ch === 4 ? data[p + 3] : 255;
      const L = a < 32 ? 1 : relLum(data[p], data[p + 1], data[p + 2]);
      lum[i] = L;
      hist[Math.min(31, Math.floor(L * 32))]++;
      n++;
    }
  }
  if (n < 16) return null;
  // border-ring background estimate (median + IQR uniformity guard)
  const ring = [];
  for (let x = 0; x < w; x++) { if (valid[x]) ring.push(lum[x]); if (valid[(h - 1) * w + x]) ring.push(lum[(h - 1) * w + x]); }
  for (let y = 1; y < h - 1; y++) { if (valid[y * w]) ring.push(lum[y * w]); if (valid[y * w + w - 1]) ring.push(lum[y * w + w - 1]); }
  if (ring.length < 16) return null;
  ring.sort((a, b) => a - b);
  const ringMed = ring[Math.floor(ring.length / 2)];
  const ringIqr = ring[Math.floor(ring.length * 0.75)] - ring[Math.floor(ring.length * 0.25)];
  let bgLum = null;
  if (ringIqr <= 0.10) bgLum = ringMed;
  else {
    // ring not uniform (badge pill edge, adjacent art) → dominant-cluster fallback
    let mode = 0;
    for (let i = 1; i < 32; i++) if (hist[i] > hist[mode]) mode = i;
    const modeCount = hist[mode] + (mode > 0 ? hist[mode - 1] : 0) + (mode < 31 ? hist[mode + 1] : 0);
    if (modeCount < n * 0.4) return null; // no dominant flat background — measurement unreliable
    let bgSum = 0, bgN = 0;
    const lo = Math.max(0, mode - 1) / 32, hi = Math.min(32, mode + 2) / 32;
    for (let i = 0; i < lum.length; i++) { const L = lum[i]; if (L >= lo && L < hi) { bgSum += L; bgN++; } }
    bgLum = bgN ? bgSum / bgN : mode / 32;
  }
  const mask = new Uint8Array(w * h);
  let inkCount = 0;
  for (let i = 0; i < lum.length; i++) {
    if (valid[i] && Math.abs(lum[i] - bgLum) > INK_CONTRAST) { mask[i] = 1; inkCount++; }
  }
  return { x0, y0, w, h, mask, valid, inkCount, bgLum };
}

// ── 1. FONT WEIGHT — ink density inside the tight ink block ─────────────────────────────────────
// density = ink pixels within ink rows / (ink-row count × tight ink width): the "ink-pixel
// fraction per ink-row-height unit". Size-invariant for a given face (stroke width and row height
// both scale with fontSize). Exported for tests/calibration.
export function measureInkDensity(img, box, exclude = []) {
  const m = inkMask(img, box, exclude);
  if (!m || m.inkCount < 40) return null;
  const { w, h, mask, valid } = m;
  const rowInk = new Uint32Array(h);
  let cMin = w, cMax = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x]) { rowInk[y]++; if (x < cMin) cMin = x; if (x > cMax) cMax = x; }
    }
  }
  const tightW = cMax - cMin + 1;
  if (tightW < 8) return null;
  let inkRows = 0, inkInRows = 0, validCells = 0;
  for (let y = 0; y < h; y++) {
    if (rowInk[y] < tightW * INK_ROW_MIN_FRAC) continue;
    inkRows++; inkInRows += rowInk[y];
    for (let x = cMin; x <= cMax; x++) if (valid[y * w + x]) validCells++;
  }
  if (inkRows < 6 || validCells < inkRows * 8) return null;
  return { density: inkInRows / validCells, inkRows, tightW, bgLum: m.bgLum };
}

// ── 2. ITALIC — dominant glyph shear via sheared-projection energy ──────────────────────────────
// Classic OCR slant estimation: shear the ink pixels by candidate slants s (x' = x − s·y), build
// the vertical projection histogram, and keep the s that maximizes projection energy Σcount² —
// vertical stems concentrate into few columns exactly when the shear cancels the glyph slant.
// Robust where naive top-vs-bottom centroid drift is not (ascenders/descenders sample different
// letters and bias the centroid). Returns { shear ≈ tan(slant), gain } where gain = peak energy
// over the upright (s=0) energy — upright text peaks at s≈0 with gain 1. Exported for
// tests/calibration.
export function measureShear(img, box, exclude = []) {
  const m = inkMask(img, box, exclude);
  if (!m || m.inkCount < 60) return null;
  const { w, h, mask } = m;
  const xs = [], ys = [];
  const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 200_000))); // subsample huge boxes
  for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) if (mask[y * w + x]) { xs.push(x); ys.push(y); }
  if (xs.length < 60) return null;
  const nBuckets = w + Math.ceil(h * 0.5) * 2 + 2;
  const off = Math.ceil(h * 0.5);
  const hist = new Uint32Array(nBuckets);
  const energy = (s) => {
    hist.fill(0);
    for (let i = 0; i < xs.length; i++) {
      const b = Math.round(xs[i] - s * ys[i]) + off;
      if (b >= 0 && b < nBuckets) hist[b]++;
    }
    let e = 0;
    for (let i = 0; i < nBuckets; i++) e += hist[i] * hist[i];
    return e;
  };
  const e0 = energy(0);
  if (!e0) return null;
  let bestS = 0, bestE = e0;
  for (let s = -0.45; s <= 0.451; s += 0.03) {
    const e = energy(s);
    if (e > bestE) { bestE = e; bestS = s; }
  }
  for (let s = bestS - 0.025; s <= bestS + 0.0251; s += 0.005) {
    const e = energy(s);
    if (e > bestE) { bestE = e; bestS = s; }
  }
  return { shear: Math.round(bestS * 1000) / 1000, gain: bestE / e0 };
}

// ── 4. STROKE/LINE — ink-run cross-section in an expanded window around the box ─────────────────
// Returns measured { thickness, start, end, center } in IMAGE px (major axis = the long one).
// Exported for tests/calibration.
export function measureLinePx(img, box) {
  if (!img || !box) return null;
  const horizontal = box.w >= box.h;
  const minor = horizontal ? box.h : box.w;
  const major = horizontal ? box.w : box.h;
  const pad = clamp(Math.round(minor * 3), 8, 48);          // minor axis: room to see the real width
  const majorPad = clamp(Math.round(major * 0.12), 8, 60);  // major axis: room for endpoint truth
  const win = horizontal
    ? { x: box.x - majorPad, y: box.y - pad, w: box.w + majorPad * 2, h: box.h + pad * 2 }
    : { x: box.x - pad, y: box.y - majorPad, w: box.w + pad * 2, h: box.h + majorPad * 2 };
  const m = inkMask(img, win);
  if (!m) return null;
  const { w, h, mask, inkCount } = m;
  if (!inkCount || inkCount > w * h * 0.6) return null; // empty, or a solid block — not a line
  const majorLen = horizontal ? w : h;
  const minorLen = horizontal ? h : w;
  const runs = []; // per major index: longest contiguous ink run along minor { len, center }
  for (let i = 0; i < majorLen; i++) {
    let best = 0, bestC = 0, cur = 0;
    for (let j = 0; j <= minorLen; j++) {
      const on = j < minorLen && mask[horizontal ? (j * w + i) : (i * w + j)];
      if (on) cur++;
      else if (cur > 0) { if (cur > best) { best = cur; bestC = j - cur / 2; } cur = 0; }
    }
    runs.push(best > 0 ? { len: best, center: bestC } : null);
  }
  const hits = runs.filter(Boolean);
  if (hits.length < 8) return null;
  const lens = hits.map((r) => r.len).sort((a, b) => a - b);
  let thickness = lens[Math.floor(lens.length / 2)];
  if (thickness >= minorLen * 0.9) return null; // fills the whole window — bg misread, not a line
  // contiguous strong segments (gap tolerance 3px); keep the one overlapping the reader's box —
  // endpoint truth must not jump to a neighboring stroke that slipped into the window
  const strongAt = (i) => runs[i] && runs[i].len >= Math.max(1, thickness * 0.5);
  const segs = [];
  let s0 = -1, lastStrong = -1;
  for (let i = 0; i < majorLen; i++) {
    if (strongAt(i)) { if (s0 < 0) s0 = i; lastStrong = i; }
    else if (s0 >= 0 && i - lastStrong > 3) { segs.push([s0, lastStrong]); s0 = -1; }
  }
  if (s0 >= 0) segs.push([s0, lastStrong]);
  if (!segs.length) return null;
  const bs = (horizontal ? box.x : box.y) - (horizontal ? m.x0 : m.y0);
  const be = bs + major;
  let seg = null, bestScore = -Infinity;
  for (const [a, b] of segs) {
    const ov = Math.min(b + 1, be) - Math.max(a, bs); // negative = distance when disjoint
    if (ov > bestScore) { bestScore = ov; seg = [a, b]; }
  }
  const [first, last] = seg;
  if (last - first < 4 || bestScore <= 0) return null;
  // thickness + center re-measured within the chosen segment only
  const segHits = [];
  for (let i = first; i <= last; i++) if (runs[i]) segHits.push(runs[i]);
  if (segHits.length < (last - first + 1) * 0.6) return null; // gappy — not a solid line
  const segLens = segHits.map((r) => r.len).sort((a, b) => a - b);
  thickness = segLens[Math.floor(segLens.length / 2)];
  // line-like: most cross-sections agree with the median
  const consistent = segHits.filter((r) => Math.abs(r.len - thickness) <= Math.max(2, thickness * 0.5)).length;
  if (consistent < segHits.length * 0.6) return null;
  const centers = segHits.map((r) => r.center).sort((a, b) => a - b);
  const center = centers[Math.floor(centers.length / 2)];
  return horizontal
    ? { thickness, start: m.x0 + first, end: m.x0 + last + 1, center: m.y0 + center, horizontal }
    : { thickness, start: m.y0 + first, end: m.y0 + last + 1, center: m.x0 + center, horizontal };
}

// ── 5. STAR/BADGE roundness — tip-mass fraction of repeated small components ────────────────────
// Needs ≥3 similar-area components roughly in a row (that's what "star rating" looks like in
// pixels). Pointedness is measured where it lives: at the TIPS — the fraction of a component's ink
// that sits in the outer radial band (distance ≥ 0.8·rmax from the centroid). Pointed star tips
// are 1-2px-thin spikes ⇒ tiny fraction; rounded tips are blunt arcs ⇒ several times more; a disc
// keeps a full annulus out there. Calibrated on synthetic rasters (see STAR_TIP_FRAC_MAX).
// Returns { starStyle, components, tipFrac } or null. Exported for tests/calibration.
export function measureStarStyle(img, box) {
  const m = inkMask(img, box);
  if (!m || m.inkCount < 40) return null;
  const { w, h, mask } = m;
  const labels = new Int32Array(w * h).fill(-1);
  const comps = [];
  const qx = new Int32Array(w * h), qy = new Int32Array(w * h);
  for (let sy = 0; sy < h; sy++) {
    for (let sxx = 0; sxx < w; sxx++) {
      const si = sy * w + sxx;
      if (!mask[si] || labels[si] >= 0) continue;
      const id = comps.length;
      let head = 0, tail = 0;
      qx[tail] = sxx; qy[tail] = sy; tail++; labels[si] = id;
      let area = 0, cxSum = 0, cySum = 0;
      while (head < tail) {
        const x = qx[head], y = qy[head]; head++;
        area++; cxSum += x; cySum += y;
        const nb = [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]];
        for (const [nx, ny] of nb) {
          if (nx < 0 || ny < 0 || nx >= w || ny >= h || !mask[ny * w + nx]) continue;
          const ni = ny * w + nx;
          if (labels[ni] < 0) { labels[ni] = id; qx[tail] = nx; qy[tail] = ny; tail++; }
        }
      }
      comps.push({ area, cx: cxSum / area, cy: cySum / area, rmax: 0, tip: 0 });
    }
  }
  const sized = comps.filter((c) => c.area >= 25).sort((a, b) => a.area - b.area);
  if (sized.length < 3) return null;
  const medArea = sized[Math.floor(sized.length / 2)].area;
  const similar = new Set(sized.filter((c) => c.area >= medArea * 0.4 && c.area <= medArea * 2.5));
  if (similar.size < 3) return null;
  // roughly a row: centroid-y spread small vs region height
  const ys = [...similar].map((c) => c.cy);
  const meanY = ys.reduce((s, v) => s + v, 0) / ys.length;
  const spreadY = Math.sqrt(ys.reduce((s, v) => s + (v - meanY) ** 2, 0) / ys.length);
  if (spreadY > h * 0.25) return null;
  // pass 2: rmax per component; pass 3: tip mass (d ≥ 0.8·rmax)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const id = labels[y * w + x];
    if (id < 0) continue;
    const c = comps[id];
    if (!similar.has(c)) continue;
    const d = Math.hypot(x - c.cx, y - c.cy);
    if (d > c.rmax) c.rmax = d;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const id = labels[y * w + x];
    if (id < 0) continue;
    const c = comps[id];
    if (!similar.has(c)) continue;
    if (Math.hypot(x - c.cx, y - c.cy) >= c.rmax * 0.8) c.tip++;
  }
  const fracs = [...similar].map((c) => c.tip / c.area).sort((a, b) => a - b);
  const tipFrac = fracs[Math.floor(fracs.length / 2)];
  return { starStyle: tipFrac <= STAR_TIP_FRAC_MAX ? 'pointed' : 'rounded', components: similar.size, tipFrac };
}

// ── 3. SUBTLE BACKGROUND GRADIENT — luminance plane over a 5×7 patch grid ───────────────────────
function measureBackgroundGradient(ext, imagePath, img, leaves, unit, canvas, sx, sy) {
  if (ext.backgroundIsPhoto || !isOpaqueHex(ext.background)) return null;
  const boxes = leaves.map((l) => readPxBox(l, unit, canvas)).filter(Boolean)
    .map((b) => ({ x: b.x * sx - 2, y: b.y * sy - 2, w: b.w * sx + 4, h: b.h * sy + 4 }));
  const patch = Math.max(8, Math.round(Math.min(img.width, img.height) * 0.05));
  const COLS = 5, ROWS = 7;
  const samples = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const cx = ((c + 0.5) / COLS) * img.width;
      const cy = ((r + 0.5) / ROWS) * img.height;
      const b = { x: cx - patch / 2, y: cy - patch / 2, w: patch, h: patch };
      if (b.x < 0 || b.y < 0 || b.x + b.w > img.width || b.y + b.h > img.height) continue;
      if (boxes.some((lb) => rectsIntersect(b, lb))) continue; // background only — layers excluded
      const pct = { x: (b.x / img.width) * 100, y: (b.y / img.height) * 100, w: (b.w / img.width) * 100, h: (b.h / img.height) * 100 };
      const stats = sampleRegionStats(imagePath, pct, img);
      if (!stats || isPhotoLike(stats)) continue; // textured patch — not flat background
      samples.push({ u: (c + 0.5) / COLS, v: (r + 0.5) / ROWS, lum: stats.lum, hex: stats.hex });
    }
  }
  if (samples.length < 8) return null;
  const distinct = (key) => new Set(samples.map((s) => Math.round(s[key] * 100))).size;
  if (distinct('u') < 2 || distinct('v') < 2) return null;
  // least-squares plane lum = a + gx·u + gy·v  (u,v normalized 0..1 across the canvas)
  const n = samples.length;
  let su = 0, sv = 0, sl = 0, suu = 0, svv = 0, suv = 0, sul = 0, svl = 0;
  for (const s of samples) { su += s.u; sv += s.v; sl += s.lum; suu += s.u * s.u; svv += s.v * s.v; suv += s.u * s.v; sul += s.u * s.lum; svl += s.v * s.lum; }
  const A = [[suu - su * su / n, suv - su * sv / n], [suv - su * sv / n, svv - sv * sv / n]];
  const B = [sul - su * sl / n, svl - sv * sl / n];
  const det = A[0][0] * A[1][1] - A[0][1] * A[1][0];
  if (Math.abs(det) < 1e-9) return null;
  const gx = (B[0] * A[1][1] - B[1] * A[0][1]) / det;
  const gy = (A[0][0] * B[1] - A[1][0] * B[0]) / det;
  const drift = Math.hypot(gx, gy);
  if (drift < BG_DRIFT_MIN) return null;
  // monotonic: luminance must correlate with the projection onto the drift direction
  const ux = gx / drift, uy = gy / drift;
  const ts = samples.map((s) => s.u * ux + s.v * uy);
  const mt = ts.reduce((s, v) => s + v, 0) / n, ml = sl / n;
  let ctl = 0, ctt = 0, cll = 0;
  for (let i = 0; i < n; i++) { const dt = ts[i] - mt, dl = samples[i].lum - ml; ctl += dt * dl; ctt += dt * dt; cll += dl * dl; }
  if (ctt < 1e-9 || cll < 1e-9 || Math.abs(ctl / Math.sqrt(ctt * cll)) < BG_DRIFT_CORR) return null;
  // stops from the extreme patches along the drift axis (median of 3 at each end)
  const order = samples.map((s, i) => ({ t: ts[i], hex: s.hex })).sort((a, b) => a.t - b.t);
  const from = medianHex(order.slice(0, 3).map((o) => o.hex));
  const to = medianHex(order.slice(-3).map((o) => o.hex));
  if (!from || !to) return null;
  // CSS angle: direction of increasing stop position is (sin θ, −cos θ) with y down ⇒ θ = atan2(ux, −uy)
  let angle = Math.round((Math.atan2(ux, -uy) * 180) / Math.PI);
  if (angle < 0) angle += 360;
  return { type: 'linear', angle, stops: [{ color: from, pos: 0 }, { color: to, pos: 1 }], from, to, drift };
}

// ── main entry ───────────────────────────────────────────────────────────────────────────────────
/** Measured typography/background truth pass. Mutates `ext`, returns { ext, corrections }.
 *  Never throws; every stage and every layer is best-effort. */
export function applyTypoTruth(ext, imagePath) {
  const corrections = [];
  try {
    if (!ext || ext.ok === false || !Array.isArray(ext.layers) || !imagePath) return { ext, corrections };
    const img = readImagePixels(imagePath);
    if (!img) return { ext, corrections };
    const canvas = { w: num(ext.canvas?.w) || img.width, h: num(ext.canvas?.h) || img.height };
    if (canvas.w <= 0 || canvas.h <= 0) return { ext, corrections };
    const leaves = collectLeaves(ext.layers);
    const unit = detectUnit(leaves, canvas);
    const sx = img.width / canvas.w, sy = img.height / canvas.h;
    const toImgBox = (b) => ({ x: b.x * sx, y: b.y * sy, w: b.w * sx, h: b.h * sy });
    const label = (l) => JSON.stringify(String(l.text || l.name || l.id || l.role || 'layer').slice(0, 24));

    // 1+2: font weight + italic per text leaf
    for (const l of leaves) {
      if (!l || l.type !== 'text') continue;
      try {
        const pb = readPxBox(l, unit, canvas);
        if (!pb) continue;
        const ib = toImgBox(pb);
        if (ib.h < 14 || ib.w < 24) continue; // too small to measure ink reliably
        l.style = l.style || {};
        // occluders: non-text siblings PARTIALLY overlapping this box contaminate the ink signal
        // (photos, cutouts, dividers). A box CONTAINING the text (pill, panel) IS its background.
        const occl = [];
        for (const o of leaves) {
          if (o === l || !o || o.type === 'text') continue;
          const opb = readPxBox(o, unit, canvas);
          if (!opb) continue;
          const oib = toImgBox(opb);
          if (!rectsIntersect(oib, ib)) continue;
          const contains = oib.x <= ib.x + 4 && oib.y <= ib.y + 4 &&
            oib.x + oib.w >= ib.x + ib.w - 4 && oib.y + oib.h >= ib.y + ib.h - 4;
          if (!contains) occl.push(oib);
        }

        const dens = measureInkDensity(img, ib, occl);
        if (dens) {
          const reader = num(l.style.fontWeight) ?? 600; // renderer default is 600
          const caps = !!l.style.uppercase || !/[a-z]/.test(String(l.text || ''));
          const floors = caps ? DENSITY_FLOORS.caps : DENSITY_FLOORS.mixed;
          let target = null;
          if (dens.density >= floors.ultra) target = 900;
          else if (dens.density >= floors.heavy) target = 800;
          else if (dens.density >= floors.bold) target = 700;
          // thin and the ambiguous middle band keep the reader's value (upgrades only)
          if (target != null && target - reader >= WEIGHT_OVERRIDE_GAP) {
            l.style.fontWeight = target;
            corrections.push(`text ${label(l)}: fontWeight ${reader}→${target} (ink density ${dens.density.toFixed(2)})`);
          }
        }

        const sh = measureShear(img, ib, occl);
        if (sh && Math.abs(sh.shear) >= ITALIC_SHEAR_MIN && sh.gain >= ITALIC_GAIN_MIN && !l.style.italic) {
          l.style.italic = true; // recorded truth — renderDesignHtml has no font-style yet
          corrections.push(`text ${label(l)}: italic detected (shear ${sh.shear.toFixed(2)}, projection gain ${sh.gain.toFixed(2)})`);
        }
      } catch { /* per-layer best effort */ }
    }

    // 3: subtle background gradient the reader flattened to a solid
    try {
      const grad = measureBackgroundGradient(ext, imagePath, img, leaves, unit, canvas, sx, sy);
      if (grad) {
        const old = ext.background;
        const { drift, ...bg } = grad;
        ext.background = bg;
        corrections.push(`background: solid ${old} → linear gradient ${bg.from}→${bg.to} at ${bg.angle}° (${Math.round(drift * 100)}% luminance drift)`);
      }
    } catch { /* stage best effort */ }

    // 4: stroke/line truth for line/arrow shapes
    for (const l of leaves) {
      if (!l || l.type !== 'shape') continue;
      const kind = l.style?.shapeKind;
      if (kind !== 'line' && kind !== 'arrow') continue;
      try {
        const pb = readPxBox(l, unit, canvas);
        if (!pb) continue;
        const meas = measureLinePx(img, toImgBox(pb));
        if (!meas) continue;
        const minorScale = meas.horizontal ? sy : sx;
        const majorScale = meas.horizontal ? sx : sy;
        const t = meas.thickness / minorScale;               // canvas px
        const start = meas.start / majorScale, end = meas.end / majorScale;
        const center = meas.center / minorScale;
        const next = { ...pb };
        const boxMinor = meas.horizontal ? pb.h : pb.w;
        const boxStart = meas.horizontal ? pb.x : pb.y;
        const boxEnd = meas.horizontal ? pb.x + pb.w : pb.y + pb.h;
        const deltas = [];
        if (Math.abs(t - boxMinor) >= STROKE_MIN_DELTA_PX) {
          if (meas.horizontal) { next.y = center - t / 2; next.h = t; } else { next.x = center - t / 2; next.w = t; }
          deltas.push(`stroke ${Math.round(boxMinor)}→${Math.round(t)}px`);
        }
        if (Math.abs(start - boxStart) >= LINE_END_MIN_DELTA_PX || Math.abs(end - boxEnd) >= LINE_END_MIN_DELTA_PX) {
          if (meas.horizontal) { next.x = start; next.w = end - start; } else { next.y = start; next.h = end - start; }
          deltas.push(`length ${Math.round(boxEnd - boxStart)}→${Math.round(end - start)}px`);
        }
        if (deltas.length) {
          writePxBox(l, next, unit, canvas);
          l.style = l.style || {};
          l.style.strokeWidthPx = Math.max(1, Math.round(t)); // measured truth (renderer derives width from box)
          corrections.push(`${kind} ${label(l)}: ${deltas.join(', ')} (measured cross-section)`);
        }
      } catch { /* per-layer best effort */ }
    }

    // 5: star/rating glyph style
    for (const l of leaves) {
      if (!l) continue;
      try {
        const hint = /star|rating|★|⭐|✭|✦/i.test([l.id, l.role, l.name, l.text].filter(Boolean).join(' '));
        if (!hint) continue;
        const pb = readPxBox(l, unit, canvas);
        if (!pb) continue;
        const ib = toImgBox(pb);
        if (ib.h > img.height * 0.12) continue; // rating rows are small
        const star = measureStarStyle(img, ib);
        if (star && l.style?.starStyle !== star.starStyle) {
          l.style = l.style || {};
          l.style.starStyle = star.starStyle; // recorded hint for the reader/judge (renderer optional)
          corrections.push(`stars ${label(l)}: ${star.starStyle} tips (${star.components} glyphs, tip mass ${star.tipFrac.toFixed(3)})`);
        }
      } catch { /* per-layer best effort */ }
    }
  } catch { /* the pass never throws */ }
  return { ext, corrections };
}
