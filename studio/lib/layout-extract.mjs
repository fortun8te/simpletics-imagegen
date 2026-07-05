// lib/layout-extract.mjs — "copy this ad's design": reference image → layout skeleton.
//
// The core of reference-first Design mode. Sends the ad image to codex vision
// (`codex exec -i <file>` — verified available) and asks for the OVERLAY design only —
// text blocks, badges, buttons, scrims — as constrained JSON with percentage coords.
// The reply is parsed tolerantly, validated, clamped, and converted to canonical
// 1080-wide canvas px (see src/lib/sceneGraph.ts Skeleton).
//
// Won't be pixel-perfect and doesn't need to be: the editor shows the reference as a
// tracing-paper underlay so the user nudges what vision got wrong. Extraction runs ONCE
// per reference — the resulting skeleton is persisted (lib/skeletons.mjs) and stamped on
// the TrendTrack ad record, so re-using a reference costs nothing.
//
// A failed/unparsable extraction returns { ok:false } with a retryable error. Never throws
// for model reasons. Vision is ONLY the configured endpoint (llmVision/LM Studio) — the codex
// CLI vision fallback has been removed.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { llmVision, llmInfo, activePreferredModel } from './llm.mjs';
import { spawnSync } from 'node:child_process';
import { buildTemplate, templateFamily } from './templates.mjs';
import { groupBounds } from './scene-tree.mjs';
import { runFanOut } from './agent-harness.mjs';

/** Real image aspect ratio (h/w) via sips — deterministic, so the comp copies the reference's
 *  EXACT proportions instead of trusting the vision model's guessed canvasRatio. */
function imageRatio(imagePath) {
  try {
    const r = spawnSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', imagePath], { encoding: 'utf8', timeout: 5000 });
    const w = Number((r.stdout.match(/pixelWidth:\s*(\d+)/) || [])[1]);
    const h = Number((r.stdout.match(/pixelHeight:\s*(\d+)/) || [])[1]);
    if (w > 0 && h > 0) return h / w;
  } catch { /* sips unavailable → fall back to the model ratio */ }
  return null;
}

// ── Deterministic background sampler ─────────────────────────────────────────────────────────
// FIX 1: the model routinely omits `background` (→ caller defaults to white) or reports a color
// with the wrong luminance ("picked white when the bg was clearly black"). Fix at the source:
// decode the PNG ourselves (node:zlib is built in — no npm dep) and AVERAGE the border/frame
// pixels, which are almost always the ad's background. Non-PNG inputs (JPG/WEBP, or a PNG-named
// WEBP) are transcoded to PNG via `sips -s format png` first.

const toHex = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
const rgbToHex = (r, g, b) => `#${toHex(r)}${toHex(g)}${toHex(b)}`;
const relLum = (r, g, b) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; // 0..1
function hexToRgb(hex) {
  const h = String(hex || '').replace('#', '');
  if (h.length >= 6) return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
  if (h.length >= 3) return { r: parseInt(h[0] + h[0], 16), g: parseInt(h[1] + h[1], 16), b: parseInt(h[2] + h[2], 16) };
  return null;
}

/** Relative luminance (0..1) of a hex color, sRGB-weighted. null on unparsable. */
function hexLuminance(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  return (0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) / 255;
}

/**
 * The LIGHT / DARK theme a resolved extraction background implies, so downstream base + text pick
 * matching tokens instead of a single hardcoded color. A gradient uses its darker stop; a solid
 * uses its own luminance; a PHOTO reference (background null) has no flat fill to read — fall back
 * to the sampled border luminance when available (`sampleLum`), else 'light'. bgLum < 0.5 → 'dark'
 * (mirrors the design-agent contrast rule). Returns 'light' | 'dark'.
 */
function themeFromBackground(background, sampleLum) {
  let lum = null;
  if (background && typeof background === 'object' && background.from && background.to) {
    const a = hexLuminance(background.from);
    const b = hexLuminance(background.to);
    lum = (a != null && b != null) ? Math.min(a, b) : (a ?? b);
  } else if (typeof background === 'string') {
    lum = hexLuminance(background);
  }
  if (lum == null && typeof sampleLum === 'number') lum = sampleLum; // photo / null bg → border tone
  return typeof lum === 'number' && lum < 0.5 ? 'dark' : 'light';
}

/** Paeth predictor (PNG filter type 4). */
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * Minimal zero-dep PNG decoder → { width, height, channels, data } (raw bytes, 8-bit).
 * Handles 8-bit RGB (colorType 2) and RGBA (colorType 6), non-interlaced, with all five
 * standard line filters (0 None, 1 Sub, 2 Up, 3 Average, 4 Paeth). Returns null for anything
 * else (grayscale/palette/16-bit/interlaced) so the caller can transcode + retry. Never throws.
 */
function decodePng(buf) {
  try {
    if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) return null; // PNG signature
    let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
    const idat = [];
    let off = 8;
    while (off + 8 <= buf.length) {
      const len = buf.readUInt32BE(off);
      const type = buf.toString('ascii', off + 4, off + 8);
      const dataStart = off + 8;
      if (type === 'IHDR') {
        width = buf.readUInt32BE(dataStart);
        height = buf.readUInt32BE(dataStart + 4);
        bitDepth = buf[dataStart + 8];
        colorType = buf[dataStart + 9];
        interlace = buf[dataStart + 12];
      } else if (type === 'IDAT') {
        idat.push(buf.subarray(dataStart, dataStart + len));
      } else if (type === 'IEND') {
        break;
      }
      off = dataStart + len + 4; // skip data + CRC
    }
    if (!width || !height || bitDepth !== 8 || interlace !== 0) return null;
    const channels = colorType === 2 ? 3 : colorType === 6 ? 4 : 0;
    if (!channels) return null; // only RGB / RGBA
    const raw = inflateSync(Buffer.concat(idat));
    const stride = width * channels;
    if (raw.length < (stride + 1) * height) return null;
    const out = Buffer.alloc(stride * height);
    let prevRow = Buffer.alloc(stride); // all-zero scanline above row 0
    let pos = 0;
    for (let y = 0; y < height; y++) {
      const filter = raw[pos++];
      const row = out.subarray(y * stride, y * stride + stride);
      for (let i = 0; i < stride; i++) {
        const x = raw[pos++];
        const a = i >= channels ? row[i - channels] : 0;       // left
        const b = prevRow[i];                                   // up
        const c = i >= channels ? prevRow[i - channels] : 0;    // up-left
        let val;
        switch (filter) {
          case 1: val = x + a; break;                           // Sub
          case 2: val = x + b; break;                           // Up
          case 3: val = x + ((a + b) >> 1); break;              // Average
          case 4: val = x + paeth(a, b, c); break;              // Paeth
          default: val = x;                                     // None (0) or unknown
        }
        row[i] = val & 0xff;
      }
      prevRow = row;
    }
    return { width, height, channels, data: out };
  } catch { return null; }
}

/** Decode via our PNG reader, transcoding JPG/WEBP (or PNG-named non-PNG) to PNG with sips
 *  first when needed. Returns { width, height, channels, data } or null. Never throws. */
function decodeImage(imagePath) {
  let buf;
  try { buf = readFileSync(imagePath); } catch { return null; }
  const isPng = buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47;
  if (isPng) {
    const d = decodePng(buf);
    if (d) return d;
  }
  // Not a PNG we can decode (JPG/WEBP, or a mis-named/exotic PNG) → transcode with sips, retry.
  let tmp = null;
  try {
    tmp = join(tmpdir(), `bgsample-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.png`);
    const r = spawnSync('sips', ['-s', 'format', 'png', imagePath, '--out', tmp], { timeout: 15_000, encoding: 'utf8' });
    if (r.status === 0 && existsSync(tmp)) {
      const d = decodePng(readFileSync(tmp));
      if (d) return d;
    }
  } catch { /* sips unavailable / failed → give up gracefully */ }
  finally { if (tmp) { try { rmSync(tmp, { force: true }); } catch { /* best effort */ } } }
  return null;
}

/**
 * Deterministic background color from the image's BORDER frame (top+bottom rows, left+right
 * columns) — this frame is almost always the ad's background. Averages border pixels, ignoring
 * near-transparent ones (alpha < 32). Also reports how FLAT the frame is (mean absolute deviation
 * of luminance across the sampled border) so the caller can decide how strongly to trust it: a
 * low `flatness` means a solid-color frame (a real background we should honor over the model);
 * a high one means the border straddles a photo/edge and the model may know better.
 * Returns { hex, lum, flatness, from:'pixels' } or null if undecodable.
 */
function sampleBorderBackground(imagePath) {
  const img = decodeImage(imagePath);
  if (!img) return null;
  const { width: w, height: h, channels: ch, data } = img;
  if (w < 2 || h < 2) return null;
  const at = (x, y) => {
    const p = (y * w + x) * ch;
    const a = ch === 4 ? data[p + 3] : 255;
    return { r: data[p], g: data[p + 1], b: data[p + 2], a };
  };
  let r = 0, g = 0, b = 0, n = 0;
  const lums = [];
  const add = (px) => { if (px.a >= 32) { r += px.r; g += px.g; b += px.b; n++; lums.push(relLum(px.r, px.g, px.b)); } };
  // Sample every few pixels along the frame — enough for a stable average, cheap on big images.
  const stepX = Math.max(1, Math.floor(w / 200));
  const stepY = Math.max(1, Math.floor(h / 200));
  for (let x = 0; x < w; x += stepX) { add(at(x, 0)); add(at(x, h - 1)); }
  for (let y = 0; y < h; y += stepY) { add(at(0, y)); add(at(w - 1, y)); }
  if (!n) return null;
  // FIX: Use MEDIAN per channel instead of mean for border sampling — the mean is pulled
  // by outlier pixels when the ad border straddles a photo edge or the image has gradient borders.
  // Median is robust to up to 50% outlier pixels.
  const rVals = lums.map((_, i) => { const px = at(i * stepX < w ? i * stepX : w - 1, 0); return px.a >= 32 ? px.r : -1; }).filter(v => v >= 0).sort((a, b) => a - b);
  const gVals = lums.map((_, i) => { const px = at(i * stepX < w ? i * stepX : w - 1, 0); return px.a >= 32 ? px.g : -1; }).filter(v => v >= 0).sort((a, b) => a - b);
  const bVals = lums.map((_, i) => { const px = at(i * stepX < w ? i * stepX : w - 1, 0); return px.a >= 32 ? px.b : -1; }).filter(v => v >= 0).sort((a, b) => a - b);
  const mid = Math.floor(n / 2);
  const med = (arr) => arr.length % 2 === 0 ? (arr[mid - 1] + arr[mid]) / 2 : arr[mid];
  const avg = { r: med(rVals), g: med(gVals), b: med(bVals) };
  const lum = relLum(avg.r, avg.g, avg.b);
  // Flatness: mean |luminance − meanLuminance| over the frame (0 = perfectly uniform).
  const meanL = lums.reduce((s, v) => s + v, 0) / lums.length;
  const flatness = lums.reduce((s, v) => s + Math.abs(v - meanL), 0) / lums.length;
  return { hex: rgbToHex(avg.r, avg.g, avg.b), lum, flatness, from: 'pixels' };
}

// ── Dominant color palette (median-cut quantization, zero-dep) ──────────────────────────────────
// Border-only sampling (above) misses the ad's actual accent/product/brand colors, which live in
// the INTERIOR. This extracts a small palette over the FULL decoded image by median-cut: recursive
// splitting of the sampled pixel set along its widest color-channel range, until we have the
// requested number of buckets, then averaging each bucket to one swatch. Pure JS, no npm deps —
// reuses decodeImage's raw pixel buffer. Runs on a DOWNSAMPLED grid (every Nth pixel per axis) so
// it stays cheap even on large images; the grid step is capped so a huge image never blows up
// runtime (worst case ~40k sampled pixels).
const PALETTE_MAX_SAMPLES = 40_000; // hard cap on sampled pixel count regardless of image size

/** Sample a grid of pixels (every `stepX`/`stepY`th one), skipping near-transparent pixels.
 *  Returns an array of [r,g,b] triples (plain arrays — fast to sort/slice in median-cut). */
function sampleGridPixels(img) {
  const { width: w, height: h, channels: ch, data } = img;
  if (w < 1 || h < 1) return [];
  // Start from "every 4th pixel in each dimension" per the task, then widen the step further if
  // that still exceeds the sample cap (guards huge images without a second decode pass).
  let stepX = 4, stepY = 4;
  let estimated = Math.ceil(w / stepX) * Math.ceil(h / stepY);
  while (estimated > PALETTE_MAX_SAMPLES) {
    stepX += 2; stepY += 2;
    estimated = Math.ceil(w / stepX) * Math.ceil(h / stepY);
  }
  const pixels = [];
  for (let y = 0; y < h; y += stepY) {
    for (let x = 0; x < w; x += stepX) {
      const p = (y * w + x) * ch;
      const a = ch === 4 ? data[p + 3] : 255;
      if (a < 32) continue; // skip near-transparent
      pixels.push([data[p], data[p + 1], data[p + 2]]);
    }
  }
  return pixels;
}

/** Median-cut: recursively split `bucket` along its widest channel range until `depth` splits
 *  have been performed (2^depth buckets), then return the leaf buckets. */
function medianCutSplit(buckets, targetCount) {
  while (buckets.length < targetCount) {
    // Pick the bucket with the largest color-volume (widest single-channel range) to split.
    let bestIdx = -1, bestRange = -1, bestChannel = 0;
    for (let i = 0; i < buckets.length; i++) {
      const b = buckets[i];
      if (b.length < 2) continue;
      for (let c = 0; c < 3; c++) {
        let lo = 255, hi = 0;
        for (const px of b) { const v = px[c]; if (v < lo) lo = v; if (v > hi) hi = v; }
        const range = hi - lo;
        if (range > bestRange) { bestRange = range; bestIdx = i; bestChannel = c; }
      }
    }
    if (bestIdx < 0 || bestRange <= 0) break; // nothing left worth splitting
    const bucket = buckets[bestIdx];
    bucket.sort((a, b) => a[bestChannel] - b[bestChannel]);
    const mid = Math.floor(bucket.length / 2);
    const left = bucket.slice(0, mid), right = bucket.slice(mid);
    buckets.splice(bestIdx, 1, left, right);
  }
  return buckets;
}

/**
 * Extract the TOP `count` dominant colors from an image via median-cut quantization over a
 * downsampled pixel grid. Returns [{ hex, share, r, g, b }] sorted by descending share (share =
 * fraction of SAMPLED pixels in that bucket, 0..1). Returns [] if the image can't be decoded or
 * has no non-transparent pixels. Never throws.
 */
export function extractDominantPalette(imagePath, count = 5) {
  try {
    const img = decodeImage(imagePath);
    if (!img) return [];
    const pixels = sampleGridPixels(img);
    if (!pixels.length) return [];
    const buckets = medianCutSplit([pixels], Math.max(1, count));
    const total = pixels.length;
    const swatches = buckets
      .filter((b) => b.length)
      .map((b) => {
        let r = 0, g = 0, bl = 0;
        for (const px of b) { r += px[0]; g += px[1]; bl += px[2]; }
        const n = b.length;
        r /= n; g /= n; bl /= n;
        return { hex: rgbToHex(r, g, bl), share: n / total, r, g, b: bl };
      })
      .sort((a, b) => b.share - a.share)
      .slice(0, count);
    return swatches;
  } catch { return []; }
}

/** Euclidean RGB distance between two hex colors, normalized to 0..1 (0 = identical, 1 = max
 *  possible distance i.e. black vs white). Returns 1 (max distance) if either hex is invalid. */
function colorDistance(hexA, hexB) {
  const a = hexToRgb(hexA), b = hexToRgb(hexB);
  if (!a || !b) return 1;
  const d = Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);
  return d / 441.67295593; // sqrt(255^2 * 3)
}

// ── Deterministic per-region GLYPH color sampler (FIX 2c) ────────────────────────────────────────
// The model routinely defaults text `color` to #ffffff/#000000 even when the glyphs are a brand hue.
// We recover the real color from PIXELS: crop the layer's box out of the decoded image, split the
// crop's pixels into a lighter half and a darker half by luminance (the glyphs are whichever side
// is the MINORITY over a text region — text is a thin stroke against a larger fill), and average the
// minority (ink) cluster. Falls back to the higher-contrast side vs the box's dominant fill. Returns
// a hex string or null (undecodable / degenerate). Deterministic, zero-dep — reuses decodeImage.
//
// `boxPct` is the region in percentage space {x,y,w,h} (0..100), matching the model's raw layer box.
// A tiny inset avoids sampling the box's border/padding. `_img` lets callers pass a pre-decoded image
// so a whole extraction decodes once instead of per-layer.
let _regionDecodeCache = { path: null, img: undefined };
function decodeImageCached(imagePath) {
  if (_regionDecodeCache.path === imagePath && _regionDecodeCache.img !== undefined) return _regionDecodeCache.img;
  const img = decodeImage(imagePath);
  _regionDecodeCache = { path: imagePath, img };
  return img;
}

function sampleGlyphColor(imagePath, boxPct, _img = null) {
  const img = _img || decodeImageCached(imagePath);
  if (!img) return null;
  const { width: w, height: h, channels: ch, data } = img;
  if (w < 4 || h < 4) return null;
  const inset = 0.06; // pull in 6% on each edge to skip the box's own border/padding
  const x0 = Math.max(0, Math.floor(((clampPct(boxPct?.x) / 100) + (clampPct(boxPct?.w) / 100) * inset) * w));
  const y0 = Math.max(0, Math.floor(((clampPct(boxPct?.y) / 100) + (clampPct(boxPct?.h) / 100) * inset) * h));
  const x1 = Math.min(w, Math.ceil(((clampPct(boxPct?.x) / 100) + (clampPct(boxPct?.w) / 100) * (1 - inset)) * w));
  const y1 = Math.min(h, Math.ceil(((clampPct(boxPct?.y) / 100) + (clampPct(boxPct?.h) / 100) * (1 - inset)) * h));
  const cw = x1 - x0, chh = y1 - y0;
  if (cw < 2 || chh < 2) return null;
  const stepX = Math.max(1, Math.floor(cw / 60));
  const stepY = Math.max(1, Math.floor(chh / 60));
  const px = [];
  let sumL = 0;
  for (let y = y0; y < y1; y += stepY) {
    for (let x = x0; x < x1; x += stepX) {
      const p = (y * w + x) * ch;
      const a = ch === 4 ? data[p + 3] : 255;
      if (a < 40) continue;
      const r = data[p], g = data[p + 1], b = data[p + 2];
      const l = relLum(r, g, b);
      px.push([r, g, b, l]);
      sumL += l;
    }
  }
  if (px.length < 8) return null;
  const meanL = sumL / px.length;
  const light = px.filter((q) => q[3] >= meanL);
  const dark = px.filter((q) => q[3] < meanL);
  if (!light.length || !dark.length) return null;
  // The GLYPH (ink) is the minority cluster over a text region — text strokes cover less area than
  // the fill they sit on. Pick the smaller cluster; if they're near-equal, pick the one FARTHER from
  // the overall mean tone (the more saturated/contrasting side reads as the deliberate ink color).
  const avg = (arr) => {
    let r = 0, g = 0, b = 0; for (const q of arr) { r += q[0]; g += q[1]; b += q[2]; }
    const n = arr.length; return { r: r / n, g: g / n, b: b / n };
  };
  const lightAvg = avg(light), darkAvg = avg(dark);
  const lightL = relLum(lightAvg.r, lightAvg.g, lightAvg.b);
  const darkL = relLum(darkAvg.r, darkAvg.g, darkAvg.b);
  // Not enough contrast between the two clusters ⇒ this box is a flat fill, no legible glyph color.
  if (Math.abs(lightL - darkL) < 0.12) return null;
  let ink;
  const ratio = light.length / px.length;
  if (ratio < 0.42) ink = lightAvg;        // light ink on a darker fill (minority = light)
  else if (ratio > 0.58) ink = darkAvg;    // dark ink on a lighter fill (minority = dark)
  else ink = Math.abs(lightL - meanL) >= Math.abs(darkL - meanL) ? lightAvg : darkAvg;
  return rgbToHex(ink.r, ink.g, ink.b);
}

// ── Deterministic per-region PHOTO-NESS + DOMINANT-COLOR sampler (FABLE FIX 026-1/026-2) ─────────
// The model routinely mislabels a large photo region as `type:'shape'` (never even reaches the
// avatar/logo/photo cutout classifier above, which only runs for `type:'image'`), so a giant
// lifestyle photo becomes a flat tinted rect ("grey slab"). It also frequently HALLUCINATES that
// slab's fill color (a teal guess where the source is light grey). Both are fixed the same way:
// sample the SOURCE pixels under the region and look at what's actually there.
//
// `sampleRegionStats(imagePath, boxPct)` decodes the region (border-inset like the glyph sampler)
// and returns { hex, lum, variance, entropy } — `variance` is the normalized luminance variance
// across sampled pixels (flat fills ≈ 0, busy photos are high), `entropy` is a coarse Shannon
// entropy over a quantized luminance histogram (flat fills ≈ 0 bits, textured photos ≈ 3-5 bits).
// `hex` is the region's own dominant color via median-cut (NOT the whole image) — ground truth for
// verifying/overriding a hallucinated fill. Returns null if undecodable. Deterministic, zero-dep.
export function sampleRegionStats(imagePath, boxPct, _img = null) {
  const img = _img || decodeImageCached(imagePath);
  if (!img) return null;
  const { width: w, height: h, channels: ch, data } = img;
  if (w < 4 || h < 4) return null;
  const inset = 0.04; // small inset to skip the region's own border/stroke
  const x0 = Math.max(0, Math.floor(((clampPct(boxPct?.x) / 100) + (clampPct(boxPct?.w) / 100) * inset) * w));
  const y0 = Math.max(0, Math.floor(((clampPct(boxPct?.y) / 100) + (clampPct(boxPct?.h) / 100) * inset) * h));
  const x1 = Math.min(w, Math.ceil(((clampPct(boxPct?.x) / 100) + (clampPct(boxPct?.w) / 100) * (1 - inset)) * w));
  const y1 = Math.min(h, Math.ceil(((clampPct(boxPct?.y) / 100) + (clampPct(boxPct?.h) / 100) * (1 - inset)) * h));
  const cw = x1 - x0, chh = y1 - y0;
  if (cw < 4 || chh < 4) return null;
  const stepX = Math.max(1, Math.floor(cw / 80));
  const stepY = Math.max(1, Math.floor(chh / 80));
  const pixels = [];
  const lums = [];
  for (let y = y0; y < y1; y += stepY) {
    for (let x = x0; x < x1; x += stepX) {
      const p = (y * w + x) * ch;
      const a = ch === 4 ? data[p + 3] : 255;
      if (a < 32) continue;
      const r = data[p], g = data[p + 1], b = data[p + 2];
      pixels.push([r, g, b]);
      lums.push(relLum(r, g, b));
    }
  }
  if (pixels.length < 16) return null;
  const meanL = lums.reduce((s, v) => s + v, 0) / lums.length;
  const variance = lums.reduce((s, v) => s + (v - meanL) ** 2, 0) / lums.length;
  // Coarse 16-bucket luminance histogram → Shannon entropy (bits). Flat fill ≈ 1 bucket ⇒ ~0 bits;
  // a busy photo spreads across many buckets ⇒ 3-5 bits.
  const buckets = new Array(16).fill(0);
  for (const l of lums) buckets[Math.min(15, Math.floor(l * 16))]++;
  let entropy = 0;
  for (const c of buckets) { if (!c) continue; const p = c / lums.length; entropy -= p * Math.log2(p); }
  const buckets2 = medianCutSplit([pixels], 1);
  const dom = buckets2[0] || pixels;
  let r = 0, g = 0, b = 0; for (const px of dom) { r += px[0]; g += px[1]; b += px[2]; }
  const n = dom.length || 1;
  return { hex: rgbToHex(r / n, g / n, b / n), lum: meanL, variance, entropy };
}

/** Photo-ness test: high texture/entropy over a region's real pixels ⇒ it's a photo, not a flat
 *  fill/card. Thresholds tuned so a synthetic flat swatch (variance≈0, entropy≈0) never triggers
 *  and a noisy/textured crop (variance well above 0, entropy several bits) reliably does. */
export function isPhotoLike(stats) {
  if (!stats) return false;
  return stats.entropy >= 1.8 && stats.variance >= 0.0025;
}

// ── PIXEL-BASED VECTOR SHAPE DETECTION ─────────────────────────────────────────────────────
// When the vision model labels a region as generic "shape" without detecting arrows, lines, or
// polylines, we analyze the real pixels to recover the actual vector geometry. Uses simplified
// edge-direction analysis (not a full Hough transform) — robust enough to catch the common
// shapes in social-media ads (annotation arrows, divider lines, connecting polylines).

/**
 * Detect if a region contains a simple vector shape (arrow, line, polyline) by analyzing
 * pixel edge directions and connectivity. Returns { shapeKind, color, confidence } or null
 * when the region is too complex or doesn't match any vector pattern.
 *
 * @param {string} imagePath — source image
 * @param {{ x:number, y:number, w:number, h:number }} boxPct — region in pct coords (0..100)
 * @param {object} [_img] — optional pre-decoded image cache
 * @returns {{ shapeKind:'arrow'|'line'|'polyline', color:string, confidence:number }|null}
 */
export function detectPixelVector(imagePath, boxPct, _img = null) {
  const img = _img || decodeImageCached(imagePath);
  if (!img) return null;
  const { width: iw, height: ih, channels: ch, data } = img;
  if (iw < 8 || ih < 8) return null;

  const inset = 0.08;
  const x0 = Math.max(0, Math.floor(((clampPct(boxPct?.x) / 100) + (clampPct(boxPct?.w) / 100) * inset) * iw));
  const y0 = Math.max(0, Math.floor(((clampPct(boxPct?.y) / 100) + (clampPct(boxPct?.h) / 100) * inset) * ih));
  const x1 = Math.min(iw, Math.ceil(((clampPct(boxPct?.x) / 100) + (clampPct(boxPct?.w) / 100) * (1 - inset)) * iw));
  const y1 = Math.min(ih, Math.ceil(((clampPct(boxPct?.y) / 100) + (clampPct(boxPct?.h) / 100) * (1 - inset)) * ih));
  const rw = x1 - x0, rh = y1 - y0;
  if (rw < 6 || rh < 6) return null;

  const at = (x, y) => {
    const p = (y * iw + x) * ch;
    return { r: data[p], g: data[p + 1], b: data[p + 2], a: ch === 4 ? data[p + 3] : 255 };
  };

  // Step 1: sample border pixels to determine the background color
  const borderLums = [];
  const stepX = Math.max(1, Math.floor(rw / 30));
  const stepY = Math.max(1, Math.floor(rh / 30));
  for (let x = x0; x < x1; x += stepX) {
    const t = at(x, y0), b2 = at(x, y1 - 1);
    if (t.a >= 32) borderLums.push(relLum(t.r, t.g, t.b));
    if (b2.a >= 32) borderLums.push(relLum(b2.r, b2.g, b2.b));
  }
  for (let y = y0; y < y1; y += stepY) {
    const l = at(x0, y), r2 = at(x1 - 1, y);
    if (l.a >= 32) borderLums.push(relLum(l.r, l.g, l.b));
    if (r2.a >= 32) borderLums.push(relLum(r2.r, r2.g, r2.b));
  }
  if (borderLums.length < 4) return null;
  const bgLum = borderLums.reduce((s, v) => s + v, 0) / borderLums.length;

  // Step 2: build a simplified edge map (foreground vs background)
  const scanStep = Math.max(1, Math.floor(Math.min(rw, rh) / 50));
  const gridW = Math.ceil(rw / scanStep);
  const gridH = Math.ceil(rh / scanStep);
  const fg = new Uint8Array(gridW * gridH); // 1 = foreground, 0 = background
  const fgPixels = []; // [x, y, r, g, b] of foreground pixels

  for (let gy = 0; gy < gridH; gy++) {
    for (let gx = 0; gx < gridW; gx++) {
      const sx = x0 + gx * scanStep;
      const sy = y0 + gy * scanStep;
      if (sx >= x1 || sy >= y1) continue;
      const px = at(sx, sy);
      const lum = relLum(px.r, px.g, px.b);
      if (px.a >= 32 && Math.abs(lum - bgLum) > 0.06) {
        fg[gy * gridW + gx] = 1;
        fgPixels.push({ x: gx, y: gy, r: px.r, g: px.g, b: px.b });
      }
    }
  }
  if (fgPixels.length < 6) return null;

  // Step 3: analyze foreground shape characteristics
  const fgRatio = fgPixels.length / (gridW * gridH);

  // Very little foreground — not a shape
  if (fgRatio < 0.02) return null;

  // Very dense foreground — solid fill (rect/ellipse), not a vector line shape
  if (fgRatio > 0.6) return null;

  // Compute the foreground's bounding box and aspect ratio
  let minX = gridW, minY = gridH, maxX = 0, maxY = 0;
  let sumX = 0, sumY = 0;
  for (const p of fgPixels) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
    sumX += p.x; sumY += p.y;
  }
  const fW = maxX - minX + 1;
  const fH = maxY - minY + 1;
  if (fW < 2 || fH < 2) return null;
  const aspect = fW / fH;

  // Dominant ink color (average of foreground pixels)
  let rSum = 0, gSum = 0, bSum = 0;
  for (const p of fgPixels) { rSum += p.r; gSum += p.g; bSum += p.b; }
  const n = fgPixels.length;
  const inkHex = rgbToHex(rSum / n, gSum / n, bSum / n);

  // Step 4: classify the shape by geometric properties

  // LINE: very elongated shape (aspect > 4 or < 0.25) with low fill ratio
  if ((aspect > 4.0 || aspect < 0.25) && fgRatio < 0.15) {
    return { shapeKind: 'line', color: inkHex, confidence: 0.7 };
  }

  // ARROW: elongated shape with a triangular expansion at one end
  // Detect by checking if the foreground width varies significantly along the primary axis
  if (aspect > 1.8 || aspect < 0.56) {
    const isHoriz = aspect > 1;
    const primaryLen = isHoriz ? fW : fH;
    const crossLen = isHoriz ? fH : fW;
    // Sample cross-section widths along the primary axis
    const sections = Math.min(8, primaryLen);
    const secSize = primaryLen / sections;
    const widths = new Array(sections).fill(0);
    for (const p of fgPixels) {
      const coord = isHoriz ? (p.x - minX) : (p.y - minY);
      const cross = isHoriz ? (p.y - minY) : (p.x - minX);
      const si = Math.min(sections - 1, Math.floor(coord / secSize));
      widths[si] = Math.max(widths[si], cross + 1);
    }
    // Arrow pattern: one end is significantly wider (the head) than the other (the shaft)
    const maxW = Math.max(...widths);
    const minW = Math.min(...widths.filter((w) => w > 0));
    if (minW > 0 && maxW / minW > 1.8 && fgRatio < 0.2) {
      return { shapeKind: 'arrow', color: inkHex, confidence: 0.65 };
    }
    // Even without the width variation, a very elongated thin shape is a line
    if (fgRatio < 0.1 && maxW <= crossLen * 0.4) {
      return { shapeKind: 'line', color: inkHex, confidence: 0.6 };
    }
    // DIAGONAL detection: check if the foreground is elongated along a diagonal axis
    if (aspect > 1.2 && aspect < 4.0 && fgRatio < 0.15) {
      // Check if pixels form a diagonal line pattern
      const meanX = fgPixels.reduce((s, p) => s + p.x, 0) / n;
      const meanY = fgPixels.reduce((s, p) => s + p.y, 0) / n;
      const covariance = fgPixels.reduce((s, p) => s + (p.x - meanX) * (p.y - meanY), 0) / n;
      const varianceX = fgPixels.reduce((s, p) => s + (p.x - meanX) ** 2, 0) / n;
      const varianceY = fgPixels.reduce((s, p) => s + (p.y - meanY) ** 2, 0) / n;
      // High covariance relative to variance = diagonal alignment
      if (varianceX > 0 && varianceY > 0) {
        const correlation = Math.abs(covariance) / Math.sqrt(varianceX * varianceY);
        if (correlation > 0.7 && fgRatio < 0.1) {
          return { shapeKind: 'line', color: inkHex, confidence: 0.55 };
        }
      }
    }
  }

  // POLYLINE: a connected foreground that's not a solid fill, not a line, and has
  // turning points (detected as a non-convex bounding box occupancy pattern)
  if (fgRatio > 0.04 && fgRatio < 0.25) {
    // Check for multiple direction changes: compute how many "turns" the foreground makes
    // by looking at whether it occupies both halves of the box in non-trivial ways
    const leftCount = fgPixels.filter((p) => p.x < minX + fW * 0.5).length;
    const rightCount = fgPixels.filter((p) => p.x >= minX + fW * 0.5).length;
    const topCount = fgPixels.filter((p) => p.y < minY + fH * 0.5).length;
    const botCount = fgPixels.filter((p) => p.y >= minY + fH * 0.5).length;
    // A polyline typically occupies multiple quadrants with reasonable density
    const quadPresence = [leftCount > n * 0.1, rightCount > n * 0.1, topCount > n * 0.1, botCount > n * 0.1].filter(Boolean).length;
    if (quadPresence >= 3 && fgRatio < 0.18) {
      return { shapeKind: 'polyline', color: inkHex, confidence: 0.55 };
    }
  }

  return null;
}

const STUDIO_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const CODEX_CLI = process.env.CODEX_CLI
  || (existsSync('/Applications/Codex.app/Contents/Resources/codex')
    ? '/Applications/Codex.app/Contents/Resources/codex'
    : 'codex');

const MAX_LAYERS = 18;
const CANON_W = 1080;

// v2 (2026-07): digitize the FULL design, not just "overlays on a photo". The old prompt
// excluded the photo/panels/cards, so fully-designed ads (comparison tables, X-post ads,
// before/afters on solid backgrounds) correctly returned zero layers → "extraction found no
// overlay layers". Now every design element is captured — photo/product regions come back as
// type "image" placeholders — and the ad's ARCHETYPE is classified for template seeding.
// FIX 3: crisp, unambiguous prompt for Gemma-4-e4b (a SMALL reasoning VL model). Kept short —
// reasoning models waste tokens on long prompts — but demands the four things it gets wrong:
// EXACT text, EXACT hex sampled at named points, back-to-front paint order, the archetype.
const PROMPT = `You digitize a social-media ad into JSON. Be exact and literal — no invention.

Capture EVERY element back-to-front (paint order: backgrounds/panels first, text last):
text blocks, badges/chips, buttons, cards/panels, background regions, gradient scrims, and each
photo/product region as type "image" with a 2-4 word label. Skip only platform chrome (app nav,
like/comment bars outside the ad).

Rules — get these RIGHT:
1. TEXT: copy the EXACT visible characters. Keep numbers in offers ("45% OFF" → "45% OFF") and
   struck-through prices verbatim. Do not paraphrase or translate.
2. COLORS: give real #hex sampled AT that element — text color = a glyph pixel; background =
   the fill behind it. Do NOT default to #ffffff/#000000 unless the pixel truly is white/black.
3. BACKGROUND: first decide the KIND, then report it.
   - "solid": the page is filled edge-to-edge with ONE flat color (or a simple 2-color gradient).
     Sample a corner pixel and report that real hex. If the whole frame is dark, say so (e.g.
     "#0a0a0a"), not white. Match the luminance you actually see — a black/near-black ad must
     report a dark hex, a white ad a light hex. A genuinely solid black background IS correct and
     should be reported as such — don't avoid black.
   - "photo": a lifestyle/product PHOTO fills the canvas edge-to-edge (no letterboxing, no solid
     color bars) — the photo itself IS the background, there is no separate flat fill behind it.
   - "gradient": a smooth multi-color gradient fill (not a photo).
   Report both "backgroundKind" ("solid"|"photo"|"gradient") AND "background" (the hex/gradient for
   solid/gradient, or null for photo — never invent a flat hex to stand in for a photo background).
4. FONT (read the type, don't guess): for EVERY text layer report the real letterforms.
   - "serif": true only if the glyphs have obvious serifs / bracketed feet or an editorial book
     face (Times, Georgia, Playfair); false for clean sans (Helvetica/Inter/SF/Chirp/Roboto).
   - "mono": true for fixed-width / code / receipt type; else omit.
   - "fontWeight": match the stroke — 800-900 for heavy display headlines, 700 bold, 400-500 body,
     300 thin. Don't call everything 600.
   - "platform": if the type is a recognizable UI font, name it: "ios" (SF Pro — Apple Notes,
     Messages), "twitter" (Chirp — X posts), "instagram" (IG UI), else omit. This maps to the
     right font stack downstream.
5. IMAGES: add "color":"#hex" = the region's dominant color, and "shape" = the product FORM when it
   is a product: one of bottle, tube, jar, tub, can, box, pouch, bag (use the real packaging shape).
   For a ROUND element (a circular avatar/logo, a sphere) use "ellipse" or "sphere". For a plain
   photo/scene use "rect". Also set "role" precisely: "avatar" for a person's profile picture,
   "logo" for a brand mark, "product" for packaging, "photo" for a lifestyle/scene image.
6. EFFECTS: if a region is a BLURRED or PIXELATED avatar/username (common privacy blur on social
   posts) add "effect":"blur". If a panel/card is FROSTED GLASS (translucent, blurs what's behind)
   add "effect":"glass". Otherwise omit "effect".

BOXES — place regions where they truly are. x,y = the element's TOP-LEFT as a % of the full image;
w,h = its width/height as a %. A centered headline still has a real left edge (x>0) — never snap
everything to x:0. Group tight lines of the same paragraph into ONE text box (don't split every
line). Keep boxes inside 0-100 and non-overlapping unless the design overlaps them.

ARCHETYPE — pick the ONE that matches; look for these exact tells, in this priority:
- "apple-notes": iOS Notes screenshot — a YELLOW "‹ Notes" back link top-left and/or a yellow
  "Done" top-right, a bold near-black title, a • bullet list. Yellow nav = apple-notes.
- "x-post": an X / Twitter post — a top bar reading "Post" with a ← back arrow and ⋯; an avatar +
  bold display name + BLUE VERIFIED CHECK + "@handle"; a "Follow"/"Volgend" pill; a timestamp +
  view count ("121K views/weergaven"); a bottom action row of reply/repost/like/bookmark counts
  (💬 257 · 🔁 66 · ♥ 21K · 🔖 89). Any of: Post-nav + verified badge + action-count row ⇒ x-post.
- "ig-dm": an Instagram DM / chat thread — rounded chat BUBBLES in a card, gray received vs
  colored sent, avatars, a "New Messages" divider or "Replied to you" quote.
- "stat-chart": a GIANT %/number stat (e.g. "58%") paired with a line/area CHART that has axis or
  WEEK labels. Big stat + chart ⇒ stat-chart.
- "before-after": two side-by-side panels explicitly labeled Before / After.
- "comparison": two columns pitched against each other (Ours vs Theirs) with ✓ check rows vs ✗
  cross rows.
- "offer-hero": a price/offer headline ("Save £48", "45% OFF", was/now price) with benefit chips
  over a hero photo.
- "story-native": a vertical full-photo story with stacked caption pills over it.
- "generic": none of the above clearly fits.

Reply with ONLY this JSON, no prose:
{"canvasRatio": <height/width, e.g. 1.78>,
 "archetype": "story-native|x-post|before-after|comparison|offer-hero|ig-dm|apple-notes|stat-chart|generic",
 "backgroundKind": "solid|photo|gradient",
 "background": "#hex OR {\"from\":\"#hex\",\"to\":\"#hex\",\"angle\":<0-360>} for a gradient, or null if backgroundKind is photo",
 "layers": [
  {"type":"text|badge|button|shape|image",
   "role":"headline|subhead|caption|badge|cta|price|scrim|card|product|avatar|logo",
   "text":"exact text (image: 2-4 word label)",
   "box":{"x":<left %>,"y":<top %>,"w":<width %>,"h":<height %>},
   "style":{"color":"#hex","background":"#hex|rgba()|null",
            "fontSizePct":<cap height as % of image WIDTH, e.g. 4.5>,
            "fontWeight":<300-900>,"align":"left|center|right",
            "radiusPct":<corner radius % of width, 0 if square>,
            "uppercase":<true|false>,"serif":<true|false>,"mono":<true|false>,
            "platform":"ios|twitter|instagram (optional)",
            "gradient":"to-top|to-bottom|null",
            "shapeKind":"rect|ellipse|arrow|line|polyline (REQUIRED for type=shape)"},
   "effect":"blur|glass (optional — blurred username / frosted panel)"}
 ]}
All boxes in % of the full image (0-100). Max ${MAX_LAYERS} layers. Approximate boxes are fine;
TEXT, COLORS, FONT and ARCHETYPE must be exact.
PACKAGING/LABEL FINE PRINT: do NOT extract small print that is physically PRINTED ON a product
(ingredient lists, nutrition-facts tables, barcodes, tiny legal text on a bottle/pouch/box label)
as separate text layers. That text is part of the product PHOTO — it renders correctly as part of
the image region itself. Only extract text that is the AD'S OWN overlay (headline, price, CTA,
benefit copy) — text that exists independent of any product packaging. Extracting packaging fine
print as design layers has caused severe pileups (dozens of tiny mis-positioned lines dumped in
one corner) — when in doubt about whether text is "on the product" vs "the ad's own copy", skip it.
CHECK/CROSS ICONS: if a line of text has a ✓/✔/tick or ✗/✘/cross icon next to it (very common in
comparison "ours vs theirs" lists and checklists), you MUST include that glyph — PREFIX the
caption's "text" field with the literal ✓ or ✗ character (e.g. "text":"✓ Premium silk", not just
"text":"Premium silk"). Do not silently drop these icons; a comparison list without its
checks/crosses is missing its entire visual argument.
SYMMETRY CHECK (do this before you reply): a "vs"/comparison list column almost always has ONE
icon per line — count how many lines you gave a ✓/✗ to in the LEFT column vs how many text lines
that column actually has (same for the right column). If a column is missing an icon on any
line — INCLUDING the very first line under its section header, which is easy to skip because it
sits close to a similarly-worded headline above it — go back and add it before you finalize the
JSON. A section subhead ("Premium Silk") and its list's first bullet ("✓ Premium silk") are TWO
SEPARATE layers even when the words are nearly identical — never merge them into one.
PACKAGING TEXT IS NOT A LAYER: text printed ON a product in a photo (brand name on a bottle,
ingredient lists, nutrition tables, label small-print) is part of the PHOTO — do NOT transcribe
it as text layers. Only extract text the DESIGNER placed on the canvas (headlines, prices,
captions, buttons). A product photo region is ONE image layer, never a pile of label lines.
SHAPE GEOMETRY: For EVERY shape layer, you MUST set style.shapeKind to the actual geometry:
- "arrow" — annotation arrows, pointers, leader lines
- "line" — horizontal/vertical divider lines, separator rules
- "polyline" — connecting lines, zigzag paths
- "rect" — rectangles, cards, panels, rounded rects
- "ellipse" — circles, ovals, rings
Do NOT leave shapeKind empty on shape layers. If a shape is an arrow, label it "arrow" even if
the model's role says "decor" or "separator".

COMPLETE MINIMAL EXAMPLE (imitate this exact SHAPE — the values are placeholders, read the real
ones from the image):
{"canvasRatio":1.25,"archetype":"offer-hero","backgroundKind":"solid","background":"#0e0f12",
 "layers":[
  {"type":"image","role":"product","text":"protein bottle","box":{"x":30,"y":8,"w":40,"h":38},"style":{"shape":"bottle","color":"#7a5c3e"}},
  {"type":"text","role":"headline","text":"SAVE 45% TODAY","box":{"x":10,"y":52,"w":80,"h":10},"style":{"color":"#ffffff","fontSizePct":6.2,"fontWeight":800,"align":"center","uppercase":true,"serif":false}},
  {"type":"button","role":"cta","text":"Shop Now","box":{"x":30,"y":82,"w":40,"h":7},"style":{"color":"#111111","background":"#ffd44d","fontSizePct":3.4,"fontWeight":700,"align":"center"}}
 ]}
Reply with ONLY the JSON object — no prose before or after it.`;

// FIX 2: refine prompt — pass 1's JSON goes back IN so the model corrects itself instead of
// re-guessing from scratch. Terse: point it at the four failure classes and demand complete JSON.
const REFINE_PROMPT = (priorJson) => `You digitized this ad once. Here is that first-pass JSON:

${priorJson}

Look at the image again and CORRECT it. Specifically:
- ADD any layer that is present in the image but missing from the JSON.
- REMOVE any layer that is not actually in the image (hallucinations).
- FIX wrong text (must be EXACT characters), wrong #hex colors (sample the real pixel), and
  wrong box position/size (x,y is the element's real top-left %).
- FIX the "backgroundKind" ("solid"|"photo"|"gradient") and "background": a full-bleed lifestyle/
  product photo with no flat fill behind it is backgroundKind "photo" with background null — do NOT
  invent a flat hex for it. A genuine flat color/gradient page IS backgroundKind "solid"/"gradient"
  with a real hex — fix wrong luminance (dark bg must be a dark hex), don't null out a real solid.
- FIX the font read per text layer: serif vs sans, real fontWeight (heavy display = 800-900),
  and a "platform" hint (ios / twitter / instagram) when it's a recognizable UI font.
- FIX the archetype using the tells: yellow ‹ Notes nav ⇒ apple-notes; a "Post" nav + blue
  verified check + reply/repost/like count row ⇒ x-post; chat bubbles ⇒ ig-dm; giant % + chart ⇒
  stat-chart. Don't leave it "generic" if one of these clearly matches.

Reply with ONLY the corrected COMPLETE JSON in the same schema (canvasRatio, archetype ∈
{story-native,x-post,before-after,comparison,offer-hero,ig-dm,apple-notes,stat-chart,generic},
backgroundKind, background, layers[] with per-layer style incl. serif/mono/platform). Include ALL
layers, not just changed ones. No prose.`;

// ── TWO-STEP SCOPED READ (FIX 2a) ────────────────────────────────────────────────────────────────
// A dense/dark reference makes the single all-in-one PROMPT run long (observed: 450 s of timeouts on
// a dark X-post) and emit unparsable JSON. We SHRINK per-request scope: STEP A reads only the frame
// (canvasRatio + archetype + backgroundKind/background) and the ≤6 biggest NON-TEXT regions
// (photos/products/panels/avatars). STEP B is then given step A's structural read and asked for ONLY
// the text layers. Two small responses parse far more reliably than one big one, and each finishes
// well inside the per-pass timeout. The two layer sets are concatenated back into the normal schema.
const STRUCT_PROMPT = `You digitize a social-media ad into JSON — but ONLY the STRUCTURE, not the text.
Report:
1. "canvasRatio": height/width of the image.
2. "archetype": one of story-native, x-post, before-after, comparison, offer-hero, ig-dm,
   apple-notes, stat-chart, generic — pick by the chrome tells (yellow ‹Notes nav ⇒ apple-notes;
   a "Post" nav + blue verified check + reply/repost/like count row ⇒ x-post; chat bubbles ⇒ ig-dm;
   giant % + chart ⇒ stat-chart; Before/After panels ⇒ before-after; ✓/✗ columns ⇒ comparison;
   price/offer over a hero photo ⇒ offer-hero).
3. "backgroundKind": "solid" | "photo" | "gradient", and "background": the real #hex (corner pixel)
   for solid/gradient, or null for a full-bleed photo. A dark ad must report a DARK hex — never white.
4. "layers": the biggest NON-TEXT regions only (max 6), back-to-front: cards/panels, then each
   photo/product region as type "image". For each image add "role" ("product"|"avatar"|"logo"|
   "photo"), "shape" (bottle|tube|jar|tub|can|box|pouch|bag for products; ellipse for round
   avatars/logos; rect for plain photos), and "color":"#hex" = its dominant color. NO text layers.
Boxes: x,y = top-left as % of the image; w,h = size as %. Reply with ONLY this JSON, no prose:
{"canvasRatio":<h/w>,"archetype":"...","backgroundKind":"solid|photo|gradient","background":"#hex or {from,to,angle} or null",
 "layers":[{"type":"image|shape","role":"product|avatar|logo|photo|card","text":"2-4 word label","box":{"x":,"y":,"w":,"h":},"style":{"shape":"...","color":"#hex"}}]}`;

const TEXT_PROMPT = (structJson) => `You digitize a social-media ad into JSON. The STRUCTURE was already read:

${structJson}

Now report ONLY the TEXT layers (headlines, subheads, captions, badges, buttons, prices, @handles,
counts) — do NOT repeat the image/panel regions above. For each text layer copy the EXACT visible
characters (keep "45% OFF" / struck prices verbatim; do not translate or paraphrase). Give a real
#hex glyph color sampled AT the text (not #ffffff/#000000 unless the pixels truly are white/black).
Group tight lines of one paragraph into ONE box. x,y = the text's real top-left %, w,h = its size %.
Per layer set style: color, fontSizePct (cap height as % of image WIDTH), fontWeight (heavy display
= 800-900), align, uppercase, serif (true only for real serif faces), and "platform" (ios/twitter/
instagram) when it's a recognizable UI font. Max ${MAX_LAYERS - 6} text layers. Reply with ONLY:
{"layers":[{"type":"text|badge|button","role":"headline|subhead|caption|badge|cta|price","text":"exact","box":{"x":,"y":,"w":,"h":},"style":{"color":"#hex","fontSizePct":,"fontWeight":,"align":"left|center|right","uppercase":,"serif":,"platform":"..."}}]}
No prose.`;

function extractJson(out) {
  // codex --json emits JSONL events; the agent message may also be plain in the tail.
  // Find the LAST {...} blob that parses and has a `layers` array.
  const candidates = [];
  for (const line of String(out).split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const obj = JSON.parse(t);
      const text = obj?.item?.text ?? obj?.msg?.message ?? (typeof obj?.text === 'string' ? obj.text : null);
      if (typeof text === 'string') candidates.push(text);
    } catch { /* not an event line */ }
  }
  candidates.push(String(out)); // raw tail fallback
  for (let i = candidates.length - 1; i >= 0; i--) {
    const m = String(candidates[i]).match(/\{[\s\S]*"layers"[\s\S]*\}/);
    if (!m) continue;
    try {
      const obj = JSON.parse(m[0]);
      if (Array.isArray(obj.layers)) return obj;
    } catch { /* keep scanning */ }
  }
  return null;
}

const clampPct = (v) => Math.max(0, Math.min(100, Number(v) || 0));
const HEX_RE = /^#[0-9a-fA-F]{3,8}$|^rgba?\(/;

// Font stacks — mirror lib/elements.mjs FONT_SUGGEST (inlined to keep this module import-light).
// The model reports serif/mono/platform per text layer; map to the real family so an X post reads
// in Chirp, an Apple Notes screenshot in SF Pro, a receipt in mono, an editorial serif in Georgia.
// CRITICAL (font-fidelity fix): these MUST be SINGLE tokens, not comma-lists. The export renderer
// (qlmanage/Chrome, see lib/elements.mjs FONT_SUGGEST note) consumes style.fontFamily as ONE family
// name — a comma list like 'Chirp, "Segoe UI", …' becomes one invalid family and renders as the
// default (or tofu), which is exactly the "font comes out completely different" complaint. So we
// MIRROR the canonical single-token values from elements.mjs FONT_SUGGEST:
//   • twitter → '' (the base grotesk; a locally-installed Chirp is invisible to the sandboxed export
//     renderer, so naming it breaks PNG export — the base stack is visually ~identical and reliable).
//   • ios / apple / notes / instagram → '-apple-system' (SF Pro on Apple, system font elsewhere —
//     what these UIs actually render).
//   • mono → 'Menlo' · serif → 'Georgia' (both ship on effectively every OS, render as intended).
// An empty string means "leave fontFamily unset → the doc's default clean sans" (the right call for
// twitter/plain-sans). undefined has the same effect; we return undefined so the field is omitted.
const FONT_TOKENS = {
  twitter: '',            // base grotesk — see note
  ios: '-apple-system',   // SF Pro
  instagram: '-apple-system',
  mono: 'Menlo',
  serif: 'Georgia',
};
/** Resolve a text layer's font family from the model's style read to a SINGLE canonical token the
 *  export renderer can actually load. Named platform UI font wins, then mono, then serif; a plain
 *  sans (or the twitter base grotesk) returns undefined so the doc's default clean sans is used. */
function fontStack(s) {
  const p = String(s?.platform || '').toLowerCase();
  if (p === 'twitter' || p === 'x') return FONT_TOKENS.twitter || undefined;
  if (p === 'ios' || p === 'apple' || p === 'sf' || p === 'notes' || p === 'imessage') return FONT_TOKENS.ios;
  if (p === 'instagram' || p === 'ig') return FONT_TOKENS.instagram;
  if (s?.mono === true) return FONT_TOKENS.mono;
  if (s?.serif === true) return FONT_TOKENS.serif;
  return undefined;
}

// ── Organic product-silhouette synthesis ─────────────────────────────────────────────────────────
// Raw vision extraction only gives a bounding box for a product region. A plain rect/ellipse reads
// as a placeholder slab; a soft organic silhouette reads as "a real product is roughly here". We
// synthesize an 8-point outline BIASED by the model's shape hint (bottle/tube/jar/etc., reported
// as l.shape) — tall-narrow for bottle-like, squat-round for jar-like — then smooth the 8 corner
// points with a Catmull-Rom-derived cubic-bezier pass into an SVG path. Fully deterministic: every
// offset is a fixed fraction of the box, no Math.random, so the same extraction always yields the
// same shape.

/** Per-shape-hint bias applied to the 8 octagon corner points (as fractions of half-width/
 *  half-height from box center), going clockwise from top-center: [top, top-right, right,
 *  bottom-right, bottom, bottom-left, left, top-left]. 1.0 = the point sits exactly on the
 *  rect edge/corner; <1 pulls it inward (rounds that corner off). */
const SHAPE_BIAS = {
  // Bottle/tube: tall & narrow — round the shoulders (top corners) in hard, keep the body
  // (sides) nearly straight, taper the base slightly.
  bottle: { top: 0.62, topCorner: 0.55, side: 0.94, botCorner: 0.7, bot: 0.85 },
  tube: { top: 0.6, topCorner: 0.5, side: 0.92, botCorner: 0.68, bot: 0.82 },
  // Jar: squat & round — soften every corner evenly, fuller sides.
  jar: { top: 0.82, topCorner: 0.75, side: 1.0, botCorner: 0.78, bot: 0.85 },
  can: { top: 0.85, topCorner: 0.8, side: 0.98, botCorner: 0.82, bot: 0.85 },
  // Tub/pot: short & very round-shouldered — a wide lid over a slightly narrower body.
  tub: { top: 0.86, topCorner: 0.8, side: 0.99, botCorner: 0.74, bot: 0.8 },
  // Box/pack/carton: mostly rectangular — just take the hard edge off each corner.
  box: { top: 0.94, topCorner: 0.85, side: 0.96, botCorner: 0.85, bot: 0.94 },
  pack: { top: 0.94, topCorner: 0.85, side: 0.96, botCorner: 0.85, bot: 0.94 },
  // Pouch/bag/sachet: a stand-up pouch — crimped/gathered top (pull the shoulders in hard and the
  // very top narrower), fuller flexible body, wide flat base. This is the single most common
  // supplement/snack format in the inspo set (grüns bag, protein pouch), so it gets a real profile
  // instead of falling through to the generic taper.
  pouch: { top: 0.72, topCorner: 0.6, side: 0.9, botCorner: 0.9, bot: 0.98 },
  bag: { top: 0.72, topCorner: 0.6, side: 0.9, botCorner: 0.9, bot: 0.98 },
  // Default / unknown product shape: a gentle all-round organic taper.
  default: { top: 0.8, topCorner: 0.7, side: 0.96, botCorner: 0.72, bot: 0.82 },
};

/** Resolve a shape-hint string (as reported by vision, e.g. "bottle"/"tube"/"jar"/"can"/"box"/
 *  "pouch"/"bag"/"tub") to its bias profile, defaulting to a gentle all-round taper for
 *  unknown/absent hints. Matches whole words so a label like "protein pouch" or "greens bag"
 *  resolves correctly (biasForShapeHint is fed the inferred hint from inferShapeHint below). */
function biasForShapeHint(hint) {
  const h = String(hint || '').toLowerCase();
  if (SHAPE_BIAS[h]) return SHAPE_BIAS[h];
  if (/bottle|flask/.test(h)) return SHAPE_BIAS.bottle;
  if (/tube/.test(h)) return SHAPE_BIAS.tube;
  if (/pouch|sachet|packet|stick\s?pack/.test(h)) return SHAPE_BIAS.pouch;
  if (/\bbag\b/.test(h)) return SHAPE_BIAS.bag;
  if (/jar|pot/.test(h)) return SHAPE_BIAS.jar;
  if (/\btub\b|tubs\b/.test(h)) return SHAPE_BIAS.tub;
  if (/can|cylinder|tin\b/.test(h)) return SHAPE_BIAS.can;
  if (/box|pack|carton|case\b/.test(h)) return SHAPE_BIAS.box;
  return SHAPE_BIAS.default;
}

// Vision reliably emits only rect|ellipse|sphere for image regions (that's what the prompt's schema
// asks for), so the RICH taxonomy above almost never gets a direct hit from `l.shape`. We recover
// the real product format from TWO deterministic signals the extraction already has: (1) the model's
// short 2-4 word product LABEL ("choco eiwitreep", "greens bag", "curl crème tube"), and (2) the
// box ASPECT ratio (a tall-narrow box is bottle-like; a wide-short box is tub/box-like). This turns
// the previously-dead SHAPE_BIAS variants into ones the pipeline actually reaches.
const SHAPE_WORD_HINTS = [
  [/pouch|sachet|packet|stick\s?pack|zak\b|zakje/, 'pouch'],
  [/\bbag\b|\bbags\b|beutel|sac\b/, 'bag'],
  [/tube|tub e|crème|creme|cream|gel\b|paste|lotion|reep\b|bar\b/, 'tube'],
  [/bottle|fles|flacon|flask|serum|dropper|shampoo|conditioner|spray/, 'bottle'],
  [/\btub\b|tubs\b|balm|butter|scoop/, 'tub'],
  [/jar|pot\b|potje/, 'jar'],
  [/\bcan\b|cans\b|blik\b|tin\b|soda|drink\b/, 'can'],
  [/box|carton|karton|doos|case\b|kit\b/, 'box'],
];

/**
 * Infer a rich product-shape hint (bottle/tube/pouch/bag/jar/tub/can/box) from whatever the model
 * gave us. Priority: an explicit rich `hint` the model somehow emitted → the product LABEL's words
 * → the box ASPECT ratio → 'default'. `round` (ellipse/sphere) short-circuits before this is called.
 * Deterministic. `label` is the region's 2-4 word text; `aspect` = box.h / box.w.
 */
function inferShapeHint(hint, label, aspect) {
  const h = String(hint || '').toLowerCase();
  // An explicit rich hint (model or upstream) that isn't just rect/ellipse/sphere wins.
  if (h && !/^(rect|ellipse|sphere|square|round|image|photo|product)$/.test(h) && biasForShapeHint(h) !== SHAPE_BIAS.default) return h;
  const text = String(label || '').toLowerCase();
  for (const [re, kind] of SHAPE_WORD_HINTS) if (re.test(text)) return kind;
  // No lexical signal → fall back to geometry. Tall-narrow ⇒ bottle/tube; wide-short ⇒ box/tub.
  const a = Number(aspect);
  if (Number.isFinite(a) && a > 0) {
    if (a >= 2.1) return 'bottle';     // very tall column
    if (a >= 1.35) return 'tube';      // tall-ish
    if (a <= 0.6) return 'box';        // wide banner-ish
    if (a <= 0.95) return 'tub';       // squat/wide
  }
  return 'default';
}

/**
 * Build 8 outline points (normalized 0..1, box-local, 0,0 = top-left) approximating a product's
 * rough silhouette from just its bounding box + an optional shape hint. Points run clockwise from
 * top-center: top, top-right corner, right-mid, bottom-right corner, bottom-center, bottom-left
 * corner, left-mid, top-left corner. Deterministic — pure function of (aspect, hint).
 */
function octagonPoints(hint) {
  const b = biasForShapeHint(hint);
  // Center-relative half-extents pulled in by the bias factor (1 = full extent = box edge).
  const cx = 0.5, cy = 0.5;
  const pt = (fx, fy) => [cx + fx * 0.5, cy + fy * 0.5];
  return [
    pt(0, -b.top),               // top-center
    pt(b.topCorner, -b.topCorner), // top-right corner
    pt(b.side, 0),                // right-mid
    pt(b.botCorner, b.botCorner), // bottom-right corner
    pt(0, b.bot),                 // bottom-center
    pt(-b.botCorner, b.botCorner),// bottom-left corner
    pt(-b.side, 0),               // left-mid
    pt(-b.topCorner, -b.topCorner),// top-left corner
  ];
}

/**
 * Smooth a closed loop of points with a Catmull-Rom → cubic-bezier conversion (the standard
 * uniform Catmull-Rom-to-Bezier tangent formula, tension 1/6) and emit an SVG path `d` string.
 * Deterministic, zero-dep. Coordinates are passed through as-is (caller supplies normalized
 * 0..1 box-local points to match the shapeKind:'path' convention).
 */
function smoothClosedPath(points) {
  const n = points.length;
  if (n < 3) return '';
  const fmt = (v) => Number(v.toFixed(4));
  const P = (i) => points[((i % n) + n) % n];
  let d = `M ${fmt(P(0)[0])} ${fmt(P(0)[1])} `;
  for (let i = 0; i < n; i++) {
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
    // Uniform Catmull-Rom control points (tension 1/6) between p1 and p2.
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += `C ${fmt(c1x)} ${fmt(c1y)} ${fmt(c2x)} ${fmt(c2y)} ${fmt(p2[0])} ${fmt(p2[1])} `;
  }
  return `${d.trim()} Z`;
}

/** Synthesize a smoothed organic product-silhouette SVG path (normalized 0..1, box-local) from a
 *  shape hint. Returns the path `d` string, or '' if it couldn't be built (caller falls back to a
 *  plain rect/ellipse). Deterministic — same hint always yields the same path. */
function productSilhouettePath(shapeHint) {
  try {
    const pts = octagonPoints(shapeHint);
    return smoothClosedPath(pts);
  } catch { return ''; }
}

// ── CUT-OUT AUTO-SUGGESTION (FIX 3) ──────────────────────────────────────────────────────────────
// Some reference regions should NOT be rebuilt from scratch — a real person's avatar, an intricate
// brand logo, or a busy lifestyle photo where a synthesized silhouette would look worse than lifting
// the pixels. For those we mark the skeleton layer `cutoutCandidate: {region, shape}` (ADDITIVE) so
// the agent/coordinator can auto-apply the existing {op:'cutout'} on it: `region` is the sub-rect of
// the SOURCE image in fractions 0..1 (exactly the shape design-agent's cutout op wants), `shape` is
// its mask hint (avatar→circle, logo→rect). The layer's own `box` is the canvas destination. Blurred
// avatars are handled separately (redaction), so they're NOT cutout candidates.
//
// Decision: a region is a cut-out candidate when its role/label reads as an avatar / logo / a
// complex photo (person/scene) — i.e. something a rebuilt tint+silhouette can't fake convincingly.
// A plain product (bottle/tube/pouch) is NOT a candidate: its silhouette previs is the intended
// treatment. `roundHint` (ellipse/sphere) nudges a photo-ish region toward the avatar (circle) mask.
const CUTOUT_AVATAR_RE = /avatar|profile|headshot|face|person|selfie|portrait|user\s?pic|pfp/;
const CUTOUT_LOGO_RE = /logo|brand\s?mark|emblem|wordmark|badge\s?logo|icon\b/;
const CUTOUT_PHOTO_RE = /photo|lifestyle|scene|model|hero\s?shot|hands?\b|background\s?photo|ugc/;
/** Classify an image layer for cut-out. Returns { shape } or null (rebuild it instead). */
function cutoutClassify(role, label, roundHint) {
  const hay = `${String(role || '')} ${String(label || '')}`.toLowerCase();
  if (CUTOUT_AVATAR_RE.test(hay)) return { shape: 'avatar' };
  if (CUTOUT_LOGO_RE.test(hay)) return { shape: 'logo' };
  if (CUTOUT_PHOTO_RE.test(hay)) return { shape: roundHint ? 'avatar' : 'rect' };
  return null;
}

/**
 * Convert the model's percentage layers to a canonical-px Skeleton layer list.
 *
 * CONTRACT (unchanged): (raw, canvas, repairLog?) — same signature + return shape the coordinator's
 * template work depends on. `opts` is a NEW optional 4th arg that only ENRICHES output when supplied
 * (imagePath enables deterministic glyph-color sampling; `onCutout(count)` receives the number of
 * regions marked `cutoutCandidate`). With 2-3 args the behavior is byte-identical to before.
 */
export function toSkeletonLayers(raw, canvas, repairLog = null, opts = {}) {
  const imagePath = opts && typeof opts.imagePath === 'string' ? opts.imagePath : null;
  let cutoutCount = 0;
  const layers = [];
  let seq = 0;
  for (const l of (raw.layers || []).slice(0, MAX_LAYERS)) {
    const type = ['text', 'badge', 'button', 'shape', 'image'].includes(l?.type) ? l.type : 'text';
    const b = l?.box || {};
    // REPAIR LOG (AI-8): a layer whose box fields are missing/NaN used to be silently coerced to
    // the top-left minimum — the caller could never tell "well-placed" from "auto-repaired
    // garbage". Record which fields were broken so extraction can surface "N layers auto-repaired"
    // instead of shipping invisible stacked slabs with no trace.
    if (Array.isArray(repairLog)) {
      const bad = ['x', 'y', 'w', 'h'].filter((k) => !Number.isFinite(Number(b[k])));
      if (bad.length) repairLog.push({ layer: String(l?.role || l?.text || type).slice(0, 30), fields: bad });
    }
    const x = Math.round((clampPct(b.x) / 100) * canvas.w);
    const y = Math.round((clampPct(b.y) / 100) * canvas.h);
    const w = Math.max(40, Math.round((clampPct(b.w) / 100) * canvas.w));
    const h = Math.max(30, Math.round((clampPct(b.h) / 100) * canvas.h));
    const s = l?.style || {};
    const id = `ext-${Date.now().toString(36)}-${(seq++).toString(36)}`;
    const bx = Math.min(x, canvas.w - 40);
    const by = Math.min(y, canvas.h - 30);
    const box = {
      x: bx,
      y: by,
      // clamp the FAR edge too — x+w used to spill past the canvas (010: body text ran off the
      // right edge because x≈15% + w≈95% > 100%)
      w: Math.min(w, canvas.w - bx),
      h: Math.min(h, canvas.h - by),
    };
    // product/photo regions → a FAITHFUL placeholder: a shape sized to the analyzed region and
    // TINTED with the product's dominant color (a sphere/ellipse for round products, a rounded
    // frame otherwise), plus a label. So extracted comps read as real designs we can replicate,
    // not gray slabs — and the product's size + color + position are captured for swap-in.
    const effect = String(l?.effect || '').toLowerCase();
    if (type === 'image') {
      const label = String(l?.text || 'photo').slice(0, 30);
      // FIX: the model puts shape/color under `style` (per the prompt's example) as often as at the
      // top level — read BOTH so the silhouette hint and product tint aren't silently lost (this was
      // why silhouettes never synthesized and tints defaulted to gray).
      const rawShape = String(l?.shape || s?.shape || '').toLowerCase();
      const round = rawShape === 'ellipse' || rawShape === 'sphere' || rawShape === 'circle';
      const rawColor = HEX_RE.test(String(l?.color)) ? String(l.color)
        : HEX_RE.test(String(s?.color)) ? String(s.color) : null;
      const tint = rawColor || '#9aa0a6';
      const role = String(l?.role || '').toLowerCase();
      const fs = Math.max(16, Math.round(box.w * 0.11));
      const radius = round ? undefined : (Math.round((clampPct(s.radiusPct) / 100) * canvas.w) || Math.round(canvas.w * 0.02));
      // EFFECT: a blurred/pixelated avatar (privacy blur on social posts) → a blurred tinted disc
      // with no label; the harness reproduces the redaction rather than a clean product slot.
      const blurred = effect === 'blur';
      // CUT-OUT AUTO-SUGGESTION: an avatar / logo / complex-photo region that shouldn't be rebuilt is
      // flagged for the {op:'cutout'} on the SOURCE image (region = its own box as fractions 0..1).
      // Blurred avatars stay a redaction, not a cut-out.
      // A LARGE region can't be an avatar no matter what shape hint the model gave — big media
      // photos with a round hint were getting ellipse-masked (ad 050). >30% of either canvas
      // dimension → force the rect mask.
      const big = box.w > canvas.w * 0.3 || box.h > canvas.h * 0.3;
      let cutout = !blurred ? cutoutClassify(role, label, round && !big) : null;
      if (cutout && cutout.shape === 'avatar' && big) cutout.shape = 'rect';
      // SIZE DEFAULT (ad 052 "grey slabs"): a LARGE image region that didn't match any keyword
      // and isn't clearly a packshot (bottle/tube/jar/… get the silhouette treatment) is almost
      // always a photo — people, rooms, lifestyle panels ("before panel"). Rebuilding those from
      // primitives can't work; default them to a rect cut-out of the reference. The bare word
      // "product" is DELIBERATELY excluded from the packshot-keyword list: the vision model
      // stamps role="product" on ANY product-related photo, small bottle or full lifestyle scene
      // alike, so it was a false-positive magnet that silhouette'd large real photos as flat grey
      // slabs (proven on ad 026's two pillow photos — literally labeled "product", nothing else
      // disqualifying, both ≥17% of canvas, both silhouette'd instead of cut out).
      const productish = /bottle|tube|jar|pouch|bag|can\b|box\b|tub\b|packshot|sachet|stick|dropper/i.test(`${role} ${label}`);
      const bigArea = (box.w * box.h) >= canvas.w * canvas.h * 0.08;
      if (!cutout && !blurred && !productish && bigArea) {
        cutout = { shape: 'rect' };
      } else if (!cutout && !blurred && bigArea && imagePath) {
        // A big region THAT DID match a packshot keyword (e.g. "product tube") still gets a real
        // pixel check before committing to a silhouette — actual photo texture overrides the
        // label guess, since a keyword match only means "product-related", not "small enough to
        // synthesize".
        const boxPct = { x: clampPct(b.x), y: clampPct(b.y), w: clampPct(b.w), h: clampPct(b.h) };
        const stats = sampleRegionStats(imagePath, boxPct);
        if (isPhotoLike(stats)) cutout = { shape: 'rect' };
      }
      // ORGANIC SILHOUETTE: a plain rect/ellipse reads as a placeholder slab. For a non-round,
      // non-blurred product region that is NOT a cut-out candidate, synthesize a smoothed 8-point
      // outline. The hint is INFERRED (model rarely emits a rich one) from the product label's words
      // and the box aspect, so bottle/tube/pouch/bag/jar/tub/can/box all get their real profile.
      const aspect = box.h / Math.max(1, box.w);
      const shapeHint = inferShapeHint(rawShape, label, aspect);
      const silhouette = (!round && !blurred && !cutout) ? productSilhouettePath(shapeHint) : '';
      const imgLayer = {
        id, type: 'shape', role: blurred ? 'avatar' : (cutout ? cutout.shape : 'product'),
        name: `${blurred ? 'Blurred' : cutout ? (cutout.shape === 'logo' ? 'Logo' : cutout.shape === 'avatar' ? 'Avatar' : 'Cut-out') : 'Product'} · ${label}`, box,
        style: {
          background: `${tint}${blurred ? 'bf' : '59'}`, radius,
          ...(round || cutout?.shape === 'avatar' ? { shapeKind: 'ellipse' } : {}),
          ...(silhouette ? { shapeKind: 'path', path: silhouette } : {}),
          ...(blurred ? { blur: Math.max(6, Math.round(box.w * 0.06)) } : { stroke: { color: tint, width: Math.max(2, Math.round(box.w * 0.008)) } }),
        },
      };
      if (cutout) {
        // ADDITIVE field: sub-rect of the SOURCE image in fractions 0..1 (design-agent's cutout op
        // shape) + the mask hint. The layer's own `box` remains the canvas destination.
        imgLayer.cutoutCandidate = {
          region: {
            x: Math.round(clampPct(b.x)) / 100,
            y: Math.round(clampPct(b.y)) / 100,
            w: Math.round(clampPct(b.w)) / 100,
            h: Math.round(clampPct(b.h)) / 100,
          },
          shape: cutout.shape,
        };
        cutoutCount++;
      }
      layers.push(imgLayer);
      if (blurred || cutout) continue; // no synthesized label on a redaction or a lifted cut-out
      layers.push({
        id: `${id}-lb`, type: 'text', role: 'caption', name: 'Product label', autoH: false, sizeLocked: true,
        text: label.toUpperCase(),
        box: { x: box.x, y: box.y + Math.round(box.h / 2) - fs, w: box.w, h: fs * 2 },
        style: { fontSize: Math.min(fs, Math.round(canvas.w * 0.03)), fontWeight: 700, color: '#ffffff', align: 'center', uppercase: true, lineHeight: 1, shadow: true },
      });
      continue;
    }
    // COLOR: prefer the model's real hex, but when it defaulted to pure #fff/#000 (its most common
    // laziness) AND we have pixel access, sample the actual glyph color from the box — recovers brand
    // hues the model flattens to black/white. A sampled color only replaces a pure-white/black default
    // when it's meaningfully different, so a genuinely white headline stays white.
    let textColor = HEX_RE.test(String(s.color)) ? String(s.color) : '#ffffff';
    if (imagePath && (type === 'text' || type === 'badge' || type === 'button') && l?.text) {
      const isPureDefault = /^#(fff|ffffff|000|000000)$/i.test(textColor);
      // EMOJI GUARD: colorful emoji glyphs poison the sample (010: "WAT. EEN. JAAR. 🥹🤝" came
      // back BROWN from the emoji pixels). Skip sampling when the text carries emoji — the
      // model's own read (or the pure default) is safer than a sampled emoji hue.
      const hasEmoji = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u.test(String(l.text));
      if ((isPureDefault || !HEX_RE.test(String(s.color))) && !hasEmoji) {
        const sampled = sampleGlyphColor(imagePath, b);
        if (sampled && colorDistance(sampled, textColor) > 0.12) textColor = sampled;
      }
    }
    const style = {
      color: textColor,
      background: s.background && HEX_RE.test(String(s.background)) ? s.background : undefined,
      fontSize: Math.max(18, Math.round((clampPct(s.fontSizePct || 4) / 100) * canvas.w)),
      fontWeight: Math.min(900, Math.max(300, Math.round(Number(s.fontWeight) || 600))),
      align: ['left', 'center', 'right'].includes(s.align) ? s.align : 'left',
      radius: Math.round((clampPct(s.radiusPct) / 100) * canvas.w) || undefined,
      uppercase: !!s.uppercase,
      // FONT: map the model's type read to a real SINGLE-TOKEN family (SF/Chirp/IG/Georgia/Menlo);
      // plain sans falls through to the doc default (undefined). Also carry the serif/mono BOOLEANS
      // so a renderer that keys on them (not just fontFamily) still honors the read — this is the
      // font-fidelity signal, kept from being dropped on the floor.
      fontFamily: fontStack(s),
      ...(s?.serif === true ? { serif: true } : {}),
      ...(s?.mono === true ? { mono: true } : {}),
      lineHeight: 1.2,
      gradient: type === 'shape' && ['to-top', 'to-bottom'].includes(s.gradient) ? s.gradient : undefined,
      opacity: type === 'shape' ? 0.8 : undefined,
      padding: s.background ? Math.round(canvas.w * 0.015) : undefined,
      // EFFECTS: frosted glass panel → backdropBlur; a blurred text/shape → layer blur.
      ...(effect === 'glass' ? { backdropBlur: Math.round(canvas.w * 0.02), opacity: 1 } : {}),
      ...(effect === 'blur' ? { blur: Math.max(4, Math.round(canvas.w * 0.01)) } : {}),
    };
    const textual = type !== 'shape';
    let shapeCutout = null;
    // SHAPE FIXES (ad 078 "black slabs"): the HTML renderer fills a shape with #000 when it has
    // no background. (a) arrow/line-ish shapes become REAL arrows (shapeKind) colored like ink,
    // (b) any other fill-less shape gets a translucent neutral instead of solid black.
    if (type === 'shape') {
      // First: use shapeKind from the PROMPT if the model provided one
      const modelShapeKind = String(s.shapeKind || '').toLowerCase();
      if (modelShapeKind && ['arrow', 'line', 'polyline', 'rect', 'ellipse'].includes(modelShapeKind)) {
        style.shapeKind = modelShapeKind;
        style.background = HEX_RE.test(String(s.color)) ? String(s.color) : '#111111';
        style.opacity = 1;
        // Line stroke: use `style.stroke = { color, width }` not `style.strokeWidth`
        if (modelShapeKind === 'line') {
          const inkColor = HEX_RE.test(String(s.color)) ? String(s.color) : '#111111';
          style.stroke = { color: inkColor, width: Math.max(2, Math.round(box.h * 0.08)) };
        }
      } else {
        // Keyword fallback
        const hay = `${String(l?.role || '')} ${String(l?.text || '')}`.toLowerCase();
        if (/arrow|pointer|leader\s?line/.test(hay)) {
          style.shapeKind = 'arrow';
          style.background = HEX_RE.test(String(s.color)) ? String(s.color) : '#111111';
          style.opacity = 1;
          const w = box.w, h = box.h;
          const shaftH = Math.max(2, h * 0.04);
          const headH = Math.min(h * 0.35, 20);
          style.path = `M 0,${h/2 - shaftH/2} L ${w - headH},${h/2 - shaftH/2} L ${w - headH},${h/2 - headH/2} L ${w},${h/2} L ${w - headH},${h/2 + headH/2} L ${w - headH},${h/2 + shaftH/2} L 0,${h/2 + shaftH/2} Z`;
        } else if (/\bline\b|divider|rule\b/.test(hay)) {
          style.shapeKind = 'line';
          const inkColor2 = HEX_RE.test(String(s.color)) ? String(s.color) : '#111111';
          style.stroke = { color: inkColor2, width: Math.max(2, Math.round(box.h * 0.08)) };
        } else if (!style.background && !style.gradient) {
          // PIXEL-BASED VECTOR DETECTION: analyze the region's real pixels to detect arrows,
          // lines, and polylines that the model didn't label. This catches reference shapes
          // the vision model reported as generic "shape" layers.
          const pixelVec = detectPixelVector(imagePath, { x: clampPct(b.x), y: clampPct(b.y), w: clampPct(b.w), h: clampPct(b.h) });
          if (pixelVec) {
            style.shapeKind = pixelVec.shapeKind;
            style.background = pixelVec.color || '#111111';
            style.opacity = 1;
            // Generate SVG path for pixel-detected arrows
            if (pixelVec.shapeKind === 'arrow') {
              const w = box.w, h = box.h;
              const shaftH = Math.max(2, h * 0.04);
              const headH = Math.min(h * 0.35, 20);
              style.path = `M 0,${h/2 - shaftH/2} L ${w - headH},${h/2 - shaftH/2} L ${w - headH},${h/2 - headH/2} L ${w},${h/2} L ${w - headH},${h/2 + headH/2} L ${w - headH},${h/2 + shaftH/2} L 0,${h/2 + shaftH/2} Z`;
            } else if (pixelVec.shapeKind === 'line') {
              style.strokeWidth = Math.max(2, Math.round(box.h * 0.08));
            }
          } else {
            style.background = '#9aa0a622'; // translucent neutral, never solid black
          }
        }
      }
      // FABLE FIX 026-1 (photo regions extracted as shape → grey slab): a large shape/card region
      // (≥8% canvas area) with a product/photo-ish role never hits the type:'image' cutout
      // classifier above. Sample the SOURCE pixels under it — if they read as a real photo
      // (high texture/entropy, not a flat fill), mark it a cutout candidate so it becomes a real
      // crop of the reference instead of a synthesized/tinted slab.
      // FABLE FIX 026-3: the ORIGINAL gate matched ANY 'shape' region (`type === 'shape'` alone
      // qualified) — that swept up plain BACKDROP panels (role 'card'/'base'/'background'/'decor'),
      // and compression noise in a lightly-textured card background can misread as "photo-like",
      // producing a full-height bogus cutout that visually overlaps every text layer sitting on
      // top of it (proven on ad 026: a 50%-of-canvas backdrop card became a cutout crop bleeding
      // into the headline and caption text above/below it). A backdrop role can NEVER become a
      // cutout — but it can still have its FLAT FILL color-verified against real pixels (026-2);
      // those are separate decisions, so isBackdrop only gates the cutout branch, not sampling.
      const bigArea = (box.w * box.h) >= canvas.w * canvas.h * 0.08;
      const role0 = String(l?.role || '').toLowerCase();
      const label0 = String(l?.text || '').toLowerCase();
      const isBackdrop = ['card', 'base', 'background', 'decor', 'panel'].includes(role0);
      const photoish = /photo|product|image|picture|panel|scene|item/.test(`${role0} ${label0}`) || role0 === '' || type === 'shape';
      if (imagePath && bigArea && photoish) {
        const boxPct = { x: clampPct(b.x), y: clampPct(b.y), w: clampPct(b.w), h: clampPct(b.h) };
        const stats = sampleRegionStats(imagePath, boxPct);
        if (!isBackdrop && isPhotoLike(stats)) {
          shapeCutout = {
            region: { x: boxPct.x / 100, y: boxPct.y / 100, w: boxPct.w / 100, h: boxPct.h / 100 },
            shape: 'rect',
          };
        } else if (stats && stats.hex) {
          // FABLE FIX 026-2 (hallucinated region color, e.g. teal guess vs real light grey):
          // for a large card/shape region, verify the model's fill against the region's REAL
          // dominant pixel color and override when they disagree strongly.
          const modelHex = HEX_RE.test(String(s.background)) ? String(s.background) : null;
          if (!modelHex || colorDistance(modelHex, stats.hex) > 0.18) {
            style.background = stats.hex;
          }
        }
      }
    }
    // DEGENERATE-BOX WIDTH REPAIR (ad 002 "text pile in the corner"): on some reads the model
    // returns a garbage/near-zero width percent for MANY layers at once, which after
    // `Math.max(40, ...)` all converge on the SAME 40px floor regardless of role — a 15-char
    // headline and a 3-word caption both end up 40px wide, stacked at similar x/y, reading as one
    // illegible pile. Detect it directly: if the box is too narrow to hold even ONE word of the
    // text at its OWN declared font size, the box is degenerate (not a real narrow-column
    // design), so widen it to fit ~2 wrapped lines instead of trusting the tiny floor value.
    if (textual && l?.text) {
      const glyph0 = style.fontWeight >= 700 ? 0.55 : 0.52;
      const text0 = String(l.text);
      const words0 = text0.split(/\s+/).filter(Boolean);
      const longestWord = words0.reduce((a, w) => Math.max(a, w.length), 0);
      const minWordW = longestWord * style.fontSize * glyph0;
      if (box.w < minWordW * 0.6) {
        const totalChars = text0.replace(/\s+/g, '').length;
        const est2Line = Math.ceil(totalChars / 2) * style.fontSize * glyph0;
        const widened = Math.min(canvas.w - box.x, Math.max(minWordW * 1.1, est2Line), canvas.w * 0.92);
        if (widened > box.w) {
          if (Array.isArray(repairLog)) repairLog.push({ layer: String(l?.role || type).slice(0, 30), fields: [`box.w ${box.w}→${Math.round(widened)} (degenerate width)`] });
          box.w = Math.round(widened);
        }
      }
      // Same disease, height axis: if box.h can't fit even ONE line at the declared font size,
      // the height is degenerate too (a dense multi-line header often has every sibling collapse
      // to the SAME height floor, so they stack "overlapping" per rendered text even though their
      // declared boxes barely touch — sanitizeGeometry's overlap check can't see this because it
      // only compares DECLARED boxes, not rendered text extent). Widen to one line's real height;
      // the wrap-and-shrink pass right below still handles any actual multi-line overflow.
      const oneLineH = Math.round(style.fontSize * 1.25) + (style.padding || 0) * 2;
      if (box.h < oneLineH * 0.85) {
        if (Array.isArray(repairLog)) repairLog.push({ layer: String(l?.role || type).slice(0, 30), fields: [`box.h ${box.h}→${oneLineH} (degenerate height)`] });
        box.h = oneLineH;
      }
    }
    // TEXT-FIT clamp: vision's fontSizePct is often optimistic — when the estimated wrapped
    // block exceeds the reported box, shrink the font to fit rather than letting text spill
    // out of its box ("text ends up inside boxes"). Same glyph model as type-scale.mjs.
    if (textual && l?.text) {
      const glyph = style.fontWeight >= 700 ? 0.55 : 0.52;
      const usableW = Math.max(20, box.w - (style.padding || 0) * 2);
      const text = style.uppercase ? String(l.text).toUpperCase() : String(l.text);
      const wrap = (fs) => {
        const cw = fs * glyph;
        let lines = 1; let cur = 0;
        for (const w of text.split(/\s+/).filter(Boolean)) {
          const ww = w.length * cw;
          if (cur > 0 && cur + cw + ww > usableW) { lines++; cur = ww; } else cur = cur ? cur + cw + ww : ww;
        }
        return lines * fs * 1.25 + (style.padding || 0) * 2;
      };
      let guard = 0;
      while (style.fontSize > 18 && wrap(style.fontSize) > box.h * 1.15 && guard++ < 24) {
        style.fontSize = Math.round(style.fontSize * 0.92);
      }
      // BOX-FIT clamp (ad 053, the inverse defect): the model sometimes boxes a whole text
      // CLUSTER for one line — a single-line header arrives with a 3-line-tall box that then
      // physically overlaps the layers laid out beneath it. Pixels look fine (glyphs render at
      // the top) but the layer geometry is dirty: Figma import gets overlapping boxes and the
      // pile metric rightly flags it. When the rendered-height estimate says the box is >1.8×
      // taller than the text needs, shrink the box to the estimate (+15% breathing room).
      {
        const estH = wrap(style.fontSize);
        if (estH > 0 && box.h > estH * 1.8) box.h = Math.round(estH * 1.15);
      }
    }
    const shapeLayer = {
      id,
      type,
      role: String(l?.role || type).slice(0, 24),
      name: String(l?.role || type).slice(0, 24),
      text: type === 'shape' ? undefined : String(l?.text || '').slice(0, 240),
      ...(textual ? { autoH: true } : {}),
      box,
      style,
    };
    if (shapeCutout) { shapeLayer.cutoutCandidate = shapeCutout; cutoutCount++; }
    layers.push(shapeLayer);
  }

  // ── PAINT ORDER: enforce a sane z-stack so text is never buried behind a product or panel
  // ("text appears behind other elements"). Bands, back→front:
  //   0 full-bleed background · 1 cards/panels · 2 products/avatars · 3 glass/scrim · 4 all text.
  const canvasArea = canvas.w * canvas.h;
  const band = (l) => {
    if (l.role === 'base') return 0;
    const textual = l.type === 'text' || l.type === 'badge' || l.type === 'button' ||
      (typeof l.text === 'string' && l.text.trim().length > 0);
    if (textual) return 4;
    if (l.style && (l.style.backdropBlur || l.style.gradient)) return 3; // glass / scrim: over product, under text
    if (l.role === 'product' || l.role === 'avatar' || l.role === 'logo' || l.cutoutCandidate || l.type === 'image') return 2;
    const area = (l.box?.w || 0) * (l.box?.h || 0);
    return area > canvasArea * 0.6 ? 0 : 1; // big flat shape = background, small = card
  };
  if (typeof opts?.onCutout === 'function' && cutoutCount) { try { opts.onCutout(cutoutCount); } catch { /* observer only */ } }
  return layers
    .map((l, i) => ({ l, i, z: band(l) }))
    .sort((a, b) => a.z - b.z || a.i - b.i) // stable within each band
    .map((e) => e.l);
}

// Cancel registry: runId → abort() for an in-flight multi-pass extraction.
const activeRuns = new Map();

/** Cancel an in-flight extraction by runId. Aborts the remaining vision passes. */
export function cancelExtraction(runId) {
  const run = runId && activeRuns.get(runId);
  if (!run) return false;
  run.cancel();
  return true;
}

/** Score a parsed extraction for "hardness" pass selection: more real layers + a present
 *  archetype + a background + text content = a more complete read. */
function scoreRaw(raw) {
  if (!raw || !Array.isArray(raw.layers)) return -1;
  let s = raw.layers.length;
  for (const l of raw.layers) {
    if (l && typeof l.text === 'string' && l.text.trim()) s += 0.5;
    if (l && l.box && Number(l.box.w) > 0 && Number(l.box.h) > 0) s += 0.25;
  }
  if (raw.archetype && raw.archetype !== 'generic') s += 2;
  if (raw.background) s += 1;
  return s;
}

// ── Deterministic archetype detection (FIX 4) ────────────────────────────────────────────────
// A small VL model often returns "generic" (or the wrong archetype) even when the ad is an obvious
// preset. We re-derive the archetype from the extracted LAYERS + their text using the exact chrome
// tells for each preset. When a signal is STRONG we override the model so downstream can drop the
// pixel-tight template. Loose reads (no strong signal) keep the model's own guess.
const ARCH_ENUM = ['story-native', 'x-post', 'before-after', 'comparison', 'offer-hero', 'ig-dm', 'apple-notes', 'stat-chart', 'generic'];

/** All layer text joined + lowercased, for cheap signal scanning. */
function allText(raw) {
  return (Array.isArray(raw?.layers) ? raw.layers : [])
    .map((l) => String(l?.text || '')).join(' ␟ ').toLowerCase();
}

/**
 * Infer the archetype from the read. Returns { archetype, strong } where `strong` means the tells
 * are unambiguous enough to OVERRIDE the model. Signals (priority order = the prompt's):
 *  - apple-notes: a yellow "‹ Notes" back / "Done" nav.
 *  - x-post: a "Post" nav + verified badge + reply/repost/like action-count row / views.
 *  - ig-dm: several chat bubbles / DM chrome.
 *  - stat-chart: a giant %-stat + chart/week labels.
 *  - before-after / comparison / offer-hero: their labeled panels / columns / offer copy.
 */
function detectArchetypeFromLayers(raw) {
  const layers = Array.isArray(raw?.layers) ? raw.layers : [];
  const t = allText(raw);
  const has = (re) => re.test(t);
  const roleText = (re) => layers.some((l) => re.test(String(l?.role || '')));
  const effects = layers.map((l) => String(l?.effect || '').toLowerCase());

  // apple-notes: yellow Notes nav is the giveaway.
  if (has(/(^|\s|‹|<)\s*notes\b/) && (has(/\bdone\b/) || has(/‹|back/))) {
    return { archetype: 'apple-notes', strong: true };
  }

  // x-post: X/Twitter chrome. Count strong tells; 2+ ⇒ definitely a tweet.
  let xTells = 0;
  if (has(/\bpost\b/) && (has(/⋯|…|back|←/) || roleText(/nav|header/))) xTells++;      // "Post" nav bar
  if (layers.some((l) => /badge|verified|check/i.test(String(l?.role || '')) && /✓|✔|verified/i.test(String(l?.text || '')))
    || has(/verified/)) xTells++;                                                       // blue verified check
  if (has(/\b(views|weergaven|impressions)\b/) || has(/\b\d[\d.,]*\s*[km]\b.*\b(views|weergaven)\b/)) xTells++; // view count
  if (has(/\b(follow|volg|volgend|following)\b/)) xTells++;                              // Follow pill
  if (has(/\b(repost|retweet|reply|replies|bookmark)\b/) || has(/🔁|💬|♥|🔖/)) xTells++;  // action row
  if (has(/@[a-z0-9_]{2,}/)) xTells++;                                                   // @handle
  if (xTells >= 2) return { archetype: 'x-post', strong: true };

  // ig-dm: chat bubbles / DM chrome. Multiple caption bubbles + DM markers.
  const bubbleish = layers.filter((l) => /caption|bubble|message/i.test(String(l?.role || '')) && String(l?.text || '').trim()).length;
  if (has(/\b(new messages|replied to you|active now|send message)\b/) || (bubbleish >= 4 && effects.some((e) => e === 'blur'))) {
    return { archetype: 'ig-dm', strong: has(/\b(new messages|replied to you)\b/) };
  }

  // stat-chart: a giant %-stat + chart/week cue.
  const bigStat = layers.some((l) => /^\s*\d{1,3}\s*%\s*$/.test(String(l?.text || '')) || /^\s*[\d.,]+x\s*$/i.test(String(l?.text || '')));
  if (bigStat && (has(/\bweek\b/) || roleText(/chart/) || has(/\b(n=\d|self-reported|study|panel)\b/))) {
    return { archetype: 'stat-chart', strong: true };
  }

  // before-after: explicit Before / After panel labels.
  if (has(/\bbefore\b/) && has(/\bafter\b/)) return { archetype: 'before-after', strong: true };

  // comparison: check vs cross rows / us-vs-them columns.
  const checks = (t.match(/✓|✔/g) || []).length, crosses = (t.match(/✗|✘|❌|×/g) || []).length;
  if ((checks >= 2 && crosses >= 1) || has(/\b(ours|theirs|us vs|vs them|others)\b/)) {
    return { archetype: 'comparison', strong: checks >= 2 && crosses >= 1 };
  }

  // offer-hero: price / discount / bundle offer copy.
  if (has(/\d+%\s*off/) || has(/save\s*[£$€]/) || has(/[£$€]\s?\d/) || has(/\b(bundle|first order|shop now)\b/)) {
    return { archetype: 'offer-hero', strong: false };
  }

  return { archetype: 'generic', strong: false };
}

/**
 * Reconcile the model's archetype with the deterministic detector. A STRONG deterministic signal
 * wins (the model said generic on an obvious tweet); otherwise the model's non-generic guess is
 * kept, and the detector only fills in when the model punted to generic. Returns a valid enum value.
 */
function resolveArchetype(modelArch, raw, progress) {
  const model = ARCH_ENUM.includes(modelArch) ? modelArch : 'generic';
  const det = detectArchetypeFromLayers(raw);
  if (det.strong && det.archetype !== model && det.archetype !== 'generic') {
    if (progress) progress(`archetype: signals say ${det.archetype} (model said ${model}) — using ${det.archetype}`);
    return det.archetype;
  }
  if (model === 'generic' && det.archetype !== 'generic') {
    if (progress) progress(`archetype: model said generic — signals suggest ${det.archetype}`);
    return det.archetype;
  }
  return model;
}

// ── DETECTION → PRESET FILL ───────────────────────────────────────────────────────────────────
// When the extraction recognizes a KNOWN preset archetype, we don't emit loose boxes — we map the
// DETECTED text/regions onto that template's param SLOTS and BUILD the 1:1 preset (grouped,
// composed). Unmapped params fall back to the template's own defaults (Michael: "detect what you
// can, map it onto the preset, let the preset supply the rest"). archetypes that have no matching
// template (generic) are handled by the loose-layer path instead.
const ARCHETYPE_TO_TEMPLATE = {
  'x-post': 'x-post-ad',
  'apple-notes': 'apple-notes',
  'ig-dm': 'ig-dm',
  comparison: 'comparison',
  'stat-chart': 'stat-chart',
  'offer-hero': 'offer-hero',
  'story-native': 'story-native',
  'before-after': 'before-after',
};

const rawText = (l) => String(l?.text || '').trim();
const roleOf = (l) => String(l?.role || '').toLowerCase();
/** Text of the first layer whose role matches `re`, else null. */
const textByRole = (layers, re) => {
  const hit = layers.find((l) => re.test(roleOf(l)) && rawText(l));
  return hit ? rawText(hit) : null;
};
/** Every non-empty text, top-to-bottom (the read is already z-ordered but we sort by y to be safe). */
const textsByY = (layers) => layers
  .filter((l) => rawText(l))
  .slice()
  .sort((a, b) => (Number(a?.box?.y) || 0) - (Number(b?.box?.y) || 0));

/** First @handle token anywhere in the read. */
function findHandle(layers) {
  for (const l of layers) {
    const m = rawText(l).match(/@[A-Za-z0-9_]{2,}/);
    if (m) return m[0];
  }
  return null;
}
/** A "12.3K" / "1,024" / "58%" style count token near a keyword, else null. */
function findCount(text, re) {
  const t = String(text || '');
  const m = t.match(re);
  return m ? m[1] : null;
}

/**
 * Map an x-post extraction → the x-post-ad template params. Pulls the display NAME (the top,
 * non-@ bold caption), the @handle, the BODY (the longest / stacked text block), the viewcount,
 * reply/repost/like/bookmark counts, the verified flag (a verified/check badge in the read), and
 * a blurred-avatar flag (an avatar layer that came back with effect:"blur").
 */
function mapXPost(layers) {
  const params = {};
  const handle = findHandle(layers);
  if (handle) params.handle = handle;
  // display name: a header/name-role caption that is NOT the @handle and NOT the "Post" nav word.
  // Image layers and label-ish reads ("upfront logo") are excluded — the fallback used to grab the
  // avatar's LABEL as the display name (copy-fidelity bug, ad 009).
  const isImageish = (l) => String(l?.type || '').toLowerCase() === 'image'
    || /logo|avatar|icon|photo/.test(roleOf(l))
    || /\b(logo|avatar|icon)\b/i.test(rawText(l));
  // follow-pill labels and buttons must never become the display name (ad 009 post-fix run
  // picked "Volgend"): exclude button/badge/cta roles and known follow words in any language.
  const isFollowish = (l) => /button|cta|badge|pill|follow/.test(roleOf(l))
    || /^(follow(ing)?|volgend|volgen|abonneren|subscribe|suivre|folgen)$/i.test(rawText(l));
  const named = layers.find((l) => /name|display|author|header/.test(roleOf(l)) && rawText(l) && !isImageish(l) && !isFollowish(l) && !/^@/.test(rawText(l)) && !/^post$/i.test(rawText(l)));
  // fallback order: (1) the text layer vertically CLOSEST to the @handle (X stacks name directly
  // on the handle — stops the headline from being mistaken for the name, ad 010), (2) first
  // plausible short text top-to-bottom.
  const handleLayer = layers.find((l) => /@[A-Za-z0-9_]{2,}/.test(rawText(l)));
  const nameOk = (l) => rawText(l) && !isImageish(l) && !isFollowish(l) && !/^@/.test(rawText(l)) && !/^post$/i.test(rawText(l)) && rawText(l).length <= 30 && !/\bviews?\b|weergaven/i.test(rawText(l));
  const nearHandle = handleLayer ? textsByY(layers).find((l) => {
    if (!nameOk(l) || l === handleLayer) return false;
    const dy = (Number(handleLayer.box?.y) || 0) - ((Number(l.box?.y) || 0) + (Number(l.box?.h) || 0));
    return dy >= -2 && dy <= 6; // sits directly above (percent units)
  }) : null;
  const name = named ? rawText(named)
    : nearHandle ? rawText(nearHandle)
    : (() => {
      // never look BELOW the handle — everything under it is body/meta, not the display name
      const maxY = handleLayer ? (Number(handleLayer.box?.y) || 0) + 1 : Infinity;
      const cand = textsByY(layers).find((l) => nameOk(l) && (Number(l.box?.y) || 0) <= maxY);
      return cand ? rawText(cand) : null;
    })();
  // REDACTION (ad 103): the reference scribbles/blurs the poster's identity and the model
  // narrates it ("blurred username text"). Render a redaction bar, not the narration — and
  // never let the TEMPLATE DEFAULTS ('UPFRONT' / '@UpfrontFood') leak another brand's identity.
  const redacted = /blur|redact|censor|obscur|pixelat|scribbl/i.test(String(name || ''))
    || layers.some((l) => /avatar|name|handle|user/.test(roleOf(l)) && String(l?.effect || '').toLowerCase() === 'blur');
  if (redacted) {
    params.name = '▓▓▓▓▓▓▓';
    if (!handle) params.handle = '▓▓▓▓▓';
    params.blurAvatar = true;
  } else if (name) params.name = name;
  // body: ALL long text blocks top-to-bottom joined with blank lines — X posts are
  // multi-paragraph and the template splits on \n\n. The old single-longest-block pick silently
  // dropped every other paragraph (copy-fidelity bug, ad 009 lost 3 of 4 paragraphs).
  const metaRe = /\bviews?\b|weergaven|impressions/i;
  const bodies = textsByY(layers).filter((l) => {
    const t = rawText(l);
    if (t.length < 24 || isImageish(l)) return false;
    if (name && t === name) return false;
    if (/^@/.test(t)) return false;
    if (metaRe.test(t) && t.length < 60) return false; // meta line, not a paragraph
    return true;
  });
  if (bodies.length) params.body = bodies.map(rawText).join('\n\n');
  // embedded media: a large non-avatar/logo image region below the header → the template's
  // photo card (its box is stamped as a cutout candidate in fillPresetFromExtraction).
  const mediaLayer = layers.find((l) => String(l?.type || '').toLowerCase() === 'image'
    && !/avatar|logo|icon/.test(`${roleOf(l)} ${rawText(l)}`.toLowerCase())
    && Number(l?.box?.h) >= 15);
  if (mediaLayer) { params.media = 'photo'; params.photo = rawText(mediaLayer) || 'attached photo'; }
  // counts: scan the whole read text for view/reply/repost/like/bookmark tokens
  const all = layers.map(rawText).join(' ␟ ');
  const views = findCount(all, /([\d][\d.,]*\s*[km]?)\s*(?:views|weergaven|impressions)/i);
  if (views) params.views = views.trim();
  // timestamp: read the real one ("14:07 - 26/09/2025", "05:00 PM · 12-05-2026") — otherwise
  // BLANK it so the template's demo default never stamps a fake date onto a copied ad.
  const ts = all.match(/\b\d{1,2}:\d{2}(?:\s*[AP]M)?\b(?:\s*[·\-–—,]\s*[\d/.\-]{6,12})?/i);
  params.timestamp = ts ? ts[0].trim() : ' ';
  // counts: real reads win; UNFOUND counts render BLANK (' ') — the template demo defaults
  // (257/66/21K/89) must never stamp fake engagement onto a copied ad (leak class, ad 103).
  const rep = findCount(all, /(?:reply|replies|💬)[^\d]*([\d][\d.,]*\s*[km]?)/i)
    || findCount(all, /([\d][\d.,]*\s*[km]?)[^\d]*(?:replies|reply)/i);
  params.replies = rep ? rep.trim() : ' ';
  const rt = findCount(all, /(?:repost|retweet|🔁|⇄)[^\d]*([\d][\d.,]*\s*[km]?)/i);
  params.reposts = rt ? rt.trim() : ' ';
  const lk = findCount(all, /(?:like|likes|♥|❤)[^\d]*([\d][\d.,]*\s*[km]?)/i);
  params.likes = lk ? lk.trim() : ' ';
  const bm = findCount(all, /(?:bookmark|🔖)[^\d]*([\d][\d.,]*\s*[km]?)/i);
  params.bookmarks = bm ? bm.trim() : ' ';
  if (!views) params.views = ' ';
  // SHOW-ACTIONS (010-class, ranked-queue item 3): a minimal screenshot reference has NO
  // meta line or action-row chrome at all — if we found NONE of the timestamp/views/reply/
  // repost/like/bookmark signals, don't render the template's demo action row over empty
  // space; hide it so the body gets the full canvas height instead.
  if (!ts && !views && !rep && !rt && !lk && !bm) params.showActions = false;
  // verified flag: a verified/check badge OR "verified"/✔ in the read
  params.verified = layers.some((l) => /verified|check|badge/.test(roleOf(l)) && /✓|✔|verified/i.test(rawText(l)))
    || /\bverified\b/i.test(all) || layers.some((l) => /^\s*[✓✔]\s*$/.test(rawText(l)));
  // blurred-avatar flag: an avatar layer flagged with a blur effect (privacy blur)
  params.blurAvatar = layers.some((l) => /avatar/.test(roleOf(l)) && (String(l?.effect || '').toLowerCase() === 'blur' || l?.style?.blur));
  return params;
}

/** Map an apple-notes extraction → the apple-notes template. Title = the headline; items = the
 *  bullet/caption lines under it; footnote = a trailing small disclaimer line. */
function mapAppleNotes(layers) {
  const params = {};
  const title = textByRole(layers, /headline|title/) || (textsByY(layers)[0] && rawText(textsByY(layers)[0]));
  if (title) params.title = title;
  const bullets = layers
    .filter((l) => /caption|item|bullet|list/.test(roleOf(l)) && rawText(l) && rawText(l) !== title)
    .map((l) => rawText(l).replace(/^[•\-•]\s*/, ''));
  if (bullets.length) params.items = bullets.slice(0, 10);
  // footnote: a "not sponsored" / disclaimer-ish trailing line
  const foot = layers.find((l) => /footnote|disclaimer|legal/.test(roleOf(l)) && rawText(l))
    || layers.find((l) => /not sponsored|just what|disclaimer/i.test(rawText(l)));
  if (foot) params.footnote = rawText(foot);
  return params;
}

/** Map an offer-hero extraction → the offer-hero template. */
function mapOfferHero(layers) {
  const params = {};
  const logo = textByRole(layers, /logo|brand/);
  if (logo) params.logo = logo;
  const headline = textByRole(layers, /headline/) || (() => {
    const h = layers.find((l) => /off|save|£|\$|€/i.test(rawText(l)) && rawText(l).length <= 60);
    return h ? rawText(h) : null;
  })();
  if (headline) params.headline = headline;
  const price = layers.find((l) => /price/.test(roleOf(l)) && rawText(l))
    || layers.find((l) => /now\s|was\s|normally|£|\$|€/i.test(rawText(l)) && /\d/.test(rawText(l)));
  if (price) params.priceLine = rawText(price);
  const chips = layers.filter((l) => /badge|chip/.test(roleOf(l)) && rawText(l) && rawText(l) !== headline).map(rawText);
  if (chips.length) params.chips = chips.slice(0, 4);
  return params;
}

/** Map a stat-chart extraction → the stat-chart template. */
function mapStatChart(layers) {
  const params = {};
  const stat = layers.find((l) => /^\s*[\d.,]{1,4}\s*%\s*$/.test(rawText(l)) || /^\s*[\d.,]+x\s*$/i.test(rawText(l)));
  if (stat) params.stat = rawText(stat);
  const sub = layers.find((l) => /subhead/.test(roleOf(l)) && rawText(l))
    || textsByY(layers).find((l) => stat && rawText(l) !== rawText(stat) && rawText(l).length > 12);
  if (sub) params.subhead = rawText(sub);
  const cite = layers.find((l) => /citation|caption/.test(roleOf(l)) && /n=|self-reported|study|panel|based on/i.test(rawText(l)));
  if (cite) params.citation = rawText(cite);
  const weeks = layers.filter((l) => /^\s*week\s*\d/i.test(rawText(l))).map(rawText);
  if (weeks.length) params.weeks = weeks.slice(0, 8);
  return params;
}

/** Map a before/after extraction → the before-after template. */
function mapBeforeAfter(layers) {
  const params = {};
  const head = textByRole(layers, /headline/) || (textsByY(layers).find((l) => rawText(l).length > 12) && rawText(textsByY(layers).find((l) => rawText(l).length > 12)));
  if (head) params.headline = head;
  const before = layers.find((l) => /^before\b/i.test(rawText(l)));
  const after = layers.find((l) => /^after\b/i.test(rawText(l)));
  if (before) params.leftLabel = rawText(before);
  if (after) params.rightLabel = rawText(after);
  const closing = layers.find((l) => /subhead|closing/.test(roleOf(l)) && rawText(l) && rawText(l) !== head);
  if (closing) params.closing = rawText(closing);
  return params;
}

/** Map a comparison extraction → the comparison template. */
function mapComparison(layers) {
  const params = {};
  const head = textByRole(layers, /headline/) || (textsByY(layers)[0] && rawText(textsByY(layers)[0]));
  if (head) params.headline = head;
  // items may arrive MERGED into one string ("Premium silk ✓ Antibacterial ✓ Protects skin") —
  // split on the marks, then collect. Leading-mark layers also count.
  const splitMarks = (t, re) => String(t).split(re).map((s) => s.trim()).filter((s) => s.length >= 3);
  const checks = [];
  const crosses = [];
  for (const l of layers) {
    const t = rawText(l);
    if (!t) continue;
    if (/[✓✔]/.test(t) && !/[✗✘❌×]/.test(t)) checks.push(...splitMarks(t, /[✓✔]/));
    else if (/[✗✘❌×]/.test(t) && !/[✓✔]/.test(t)) crosses.push(...splitMarks(t, /[✗✘❌×]/));
  }
  if (checks.length) params.leftItems = checks.slice(0, 5);
  if (crosses.length) params.rightItems = crosses.slice(0, 5);
  // LEAK-PROOF: demo badge/colors must never stamp a copied ad — blank the badge unless the
  // reference actually has one, and neutralize the demo teal unless a colored column was read.
  const badge = layers.find((l) => /badge|sticker|offer/.test(roleOf(l)) && rawText(l));
  params.badge = badge ? rawText(badge) : ' ';
  return params;
}

/** Map a story-native extraction → the story-native template (two stacked hook pills). */
function mapStoryNative(layers) {
  const params = {};
  const pills = textsByY(layers).filter((l) => rawText(l).length >= 4 && rawText(l).length <= 60);
  if (pills[0]) params.hook = rawText(pills[0]);
  if (pills[1]) params.hook2 = rawText(pills[1]);
  return params;
}

const PARAM_MAPPERS = {
  'x-post': mapXPost,
  'apple-notes': mapAppleNotes,
  'offer-hero': mapOfferHero,
  'stat-chart': mapStatChart,
  'before-after': mapBeforeAfter,
  comparison: mapComparison,
  'story-native': mapStoryNative,
  // ig-dm has no reliable per-message extraction from loose boxes → build with template defaults.
  'ig-dm': () => ({}),
};

/**
 * DETECTION → PRESET FILL. When `archetype` maps to a known preset, map the extracted text/regions
 * onto that template's param slots and BUILD the composed 1:1 preset (grouped layers) at `canvas`.
 * Unmapped params fall back to template defaults. Returns { layers, templateId, params } or null
 * when the archetype has no matching preset (→ caller keeps the loose-layer path). Never throws.
 */
export function fillPresetFromExtraction(archetype, raw, canvas, kit) {
  const templateId = ARCHETYPE_TO_TEMPLATE[archetype];
  if (!templateId) return null;
  const layers = Array.isArray(raw?.layers) ? raw.layers : [];
  const mapper = PARAM_MAPPERS[archetype];
  let params = {};
  try { params = (mapper ? mapper(layers) : {}) || {}; } catch { params = {}; }
  // THEME follows the reference (copy-fidelity ad 010: a WHITE X-post was forced onto the dark
  // template). Only templates that declare a theme param use it; others ignore the extra key
  // (buildTemplate drops unknown params).
  if (typeof raw?.background === 'string') {
    const lum = hexLuminance(raw.background);
    if (lum != null) params.theme = lum >= 0.5 ? 'light' : 'dark';
  }
  // drop empty/undefined so buildTemplate keeps its defaults for unmapped slots
  for (const k of Object.keys(params)) {
    const v = params[k];
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)) delete params[k];
  }
  try {
    const { def, layers: built } = buildTemplate(templateId, { canvas }, params, kit);
    if (!def || !built || !built.length) return null;
    // COPY-FIDELITY: the template builds a gradient avatar and a gray media slab. When the
    // extraction actually SAW an avatar/photo region in the reference, stamp the matching built
    // node with cutoutCandidate (region = the raw box as source fractions) so runCopyReference
    // converts it into a real crop of the reference — same shape the loose path produces.
    const frac = (b) => ({
      x: Math.max(0, Math.min(100, Number(b?.x) || 0)) / 100,
      y: Math.max(0, Math.min(100, Number(b?.y) || 0)) / 100,
      w: Math.max(0, Math.min(100, Number(b?.w) || 0)) / 100,
      h: Math.max(0, Math.min(100, Number(b?.h) || 0)) / 100,
    });
    const flatBuilt = flattenLeaves(built);
    const notBlurred = (l) => String(l?.effect || '').toLowerCase() !== 'blur';
    const rawAvatar = layers.find((l) => String(l?.type || '').toLowerCase() === 'image'
      && /avatar|logo|profile|pfp|face|headshot/.test(`${roleOf(l)} ${rawText(l)}`.toLowerCase())
      && notBlurred(l) && l?.box);
    if (rawAvatar) {
      const builtAvatar = flatBuilt.find((n) => n?.role === 'avatar');
      if (builtAvatar) builtAvatar.cutoutCandidate = { region: frac(rawAvatar.box), shape: 'avatar' };
    }
    const rawMedia = layers.find((l) => String(l?.type || '').toLowerCase() === 'image'
      && !/avatar|logo|icon/.test(`${roleOf(l)} ${rawText(l)}`.toLowerCase())
      && Number(l?.box?.h) >= 15 && notBlurred(l));
    if (rawMedia) {
      const builtMedia = flatBuilt.find((n) => n?.role === 'product' && /^Image ·/.test(String(n?.name || '')));
      if (builtMedia) {
        // FIX (103 next-step, ranked-queue item 4): the model's media box sometimes swallows a
        // baked-in meta line (timestamp/views text) sitting just below the actual photo. Cutting
        // out the full box then bakes that meta text into the crop TWICE (once from the reference
        // pixels, once from the rebuilt meta row on top). Shrink the cutout region's bottom edge
        // to sit just above any timestamp/meta text layer whose box falls inside the media box.
        const mb = rawMedia.box || {};
        const mTop = clampPct(mb.y), mBottom = mTop + clampPct(mb.h);
        const mLeft = clampPct(mb.x), mRight = mLeft + clampPct(mb.w);
        const metaInside = layers.find((l) => {
          if (l === rawMedia || String(l?.type || '').toLowerCase() !== 'text') return false;
          const t = rawText(l);
          if (!/\b\d{1,2}:\d{2}\b|\bviews?\b|weergaven|impressions|\d{1,2}[/.\-]\d{1,2}/i.test(t)) return false;
          const lb = l.box || {};
          const lTop = clampPct(lb.y), lBottom = lTop + clampPct(lb.h);
          const lLeft = clampPct(lb.x), lRight = lLeft + clampPct(lb.w);
          // must sit inside the media box's horizontal span and in its lower portion
          return lTop >= mTop && lBottom <= mBottom + 1 && lLeft >= mLeft - 2 && lRight <= mRight + 2 && lTop > mTop + clampPct(mb.h) * 0.6;
        });
        let region = frac(rawMedia.box);
        if (metaInside) {
          const metaTopFrac = clampPct(metaInside.box?.y) / 100;
          if (metaTopFrac > region.y + 0.02) region = { ...region, h: Math.max(0.02, metaTopFrac - region.y) };
        }
        builtMedia.cutoutCandidate = { region, shape: 'rect' };
      }
    }
    return { layers: built, templateId: def.id, params };
  } catch {
    return null;
  }
}

// ── PRESET vs REFERENCE geometry match (coordinator FIX 1) ───────────────────────────────────────
// Native ads are ELEMENTS REARRANGED, not a memorized preset. The preset-fill path snaps the
// reference onto the template's CANONICAL layout — great when the reference IS that canonical layout
// (a standard X-post, a standard Apple-Note), wrong when the reference just shares the archetype but
// arranges things differently. So before committing to the preset we MEASURE agreement: for each
// text layer the extraction placed, find the nearest text slot the built template produced and take
// the centroid distance (normalized by the canvas diagonal). A low mean distance = the reference's
// arrangement really does match the template's slots → snapping is faithful. A high one = the preset
// would relocate the reference's content → prefer the loose path (the reference's true geometry).
// Deterministic, geometry-only; never throws. Returns { match:boolean, meanDist, pairs }.

/** Flatten a (possibly grouped) skeleton to leaf layers. */
function flattenLeaves(layers) {
  const out = [];
  for (const l of (Array.isArray(layers) ? layers : [])) {
    if (l?.type === 'group' && Array.isArray(l.children)) out.push(...flattenLeaves(l.children));
    else if (l) out.push(l);
  }
  return out;
}
/** Centroid {cx,cy} of a px box, or null. */
function centroid(box) {
  if (!box) return null;
  return { cx: (Number(box.x) || 0) + (Number(box.w) || 0) / 2, cy: (Number(box.y) || 0) + (Number(box.h) || 0) / 2 };
}

/**
 * Does the extracted layout's geometry match the built preset's canonical slots closely enough to
 * justify snapping to the preset? `raw` is the vision extraction (percentage boxes), `presetLayers`
 * is the built template (canonical-px), `canvas` gives the px scale. We compare TEXT centroids only
 * (text is where "rearranged" is most visible and where a mismatch most hurts). Threshold: a mean
 * normalized centroid distance ≤ 0.14 of the canvas diagonal counts as a match (empirically, a
 * standard-arrangement reference lands its headline/handle/body within ~one line-height of the
 * template slots; a rearranged one drifts well past that).
 */
export function presetGeometryMatch(raw, presetLayers, canvas) {
  const cw = Number(canvas?.w) || CANON_W, ch = Number(canvas?.h) || CANON_W;
  const diag = Math.hypot(cw, ch) || 1;
  // extracted text centroids in px
  const exTexts = (Array.isArray(raw?.layers) ? raw.layers : [])
    .filter((l) => (l?.type === 'text' || l?.type === 'badge' || l?.type === 'button') && String(l?.text || '').trim())
    .map((l) => centroid({ x: (clampPct(l.box?.x) / 100) * cw, y: (clampPct(l.box?.y) / 100) * ch, w: (clampPct(l.box?.w) / 100) * cw, h: (clampPct(l.box?.h) / 100) * ch }))
    .filter(Boolean);
  const slotTexts = flattenLeaves(presetLayers)
    .filter((l) => (l?.type === 'text' || l?.type === 'badge' || l?.type === 'button') && String(l?.text || '').trim())
    .map((l) => centroid(l.box)).filter(Boolean);
  if (exTexts.length < 2 || slotTexts.length < 2) {
    // too little text to judge geometry — fall back to trusting the preset UNLESS a big photo
    // region has no matching slot (FABLE FIX 026-1/3): sparse text must not skip Signal C, or a
    // reference dominated by an unmapped hero photo silently snaps onto the preset regardless.
    const pm = bigPhotoMismatch(raw, presetLayers, canvas);
    return { match: !pm, meanDist: pm ? 1 : null, pairs: 0, photoMismatch: pm };
  }
  // SIGNAL A — nearest-slot fit: for each extracted text, distance to the nearest template slot.
  // Catches individual displacement, but a slot-dense template (X-post fills the whole column with
  // default meta/action rows) always finds *some* nearby slot, so this alone is too lenient.
  let sum = 0, pairs = 0;
  for (const e of exTexts) {
    let best = Infinity;
    for (const s of slotTexts) {
      const d = Math.hypot(e.cx - s.cx, e.cy - s.cy);
      if (d < best) best = d;
    }
    if (best < Infinity) { sum += best / diag; pairs++; }
  }
  const nearest = pairs ? sum / pairs : 1;
  // SIGNAL B — vertical READING-ORDER alignment: sort both extracted texts and template slots by y,
  // pair them by RANK (1st↔1st, 2nd↔2nd, …), and measure the mean vertical offset as a fraction of
  // canvas height. A standard arrangement keeps its content at the same relative heights as the
  // template (small rank offset); a rearranged native ad (content shoved into one quadrant, or a
  // different vertical rhythm) shifts the ranks and drifts here even when SIGNAL A found a nearby
  // slot for every element. This is robust to the template having EXTRA default filler slots — we
  // only pair the first min(N,M) ranks against each other. To avoid the extra-slot skew we compare
  // the NORMALIZED rank position (rank/(count-1)) mapped to each side's own text-y range.
  const exYs = exTexts.map((p) => p.cy).sort((a, b) => a - b);
  const slotYs = slotTexts.map((p) => p.cy).sort((a, b) => a - b);
  const exRange = [exYs[0], exYs[exYs.length - 1]];
  const slotRange = [slotYs[0], slotYs[slotYs.length - 1]];
  // Position of each extracted text within the CANVAS vs where the equivalently-ranked slot sits in
  // the canvas — using normalized rank so different counts still align.
  let orderSum = 0;
  const k = exYs.length;
  for (let i = 0; i < k; i++) {
    const frac = k > 1 ? i / (k - 1) : 0;
    const slotY = slotRange[0] + frac * (slotRange[1] - slotRange[0]);
    orderSum += Math.abs(exYs[i] - slotY) / ch;
  }
  const orderDrift = orderSum / k;
  // Also flag a grossly COMPRESSED block: extracted text spanning far less (or far more) of the
  // canvas than the template's text span is a different layout even if ranks interpolate.
  const exSpanFrac = (exRange[1] - exRange[0]) / ch;
  const slotSpanFrac = (slotRange[1] - slotRange[0]) / ch;
  const spanDrift = Math.abs(exSpanFrac - slotSpanFrac);
  // Combine: faithful only when elements fit slots (A) AND the vertical reading order + span match
  // (B). Tuned so a standard arrangement passes and a quadrant-shoved rearrangement fails.
  const photoMismatch = bigPhotoMismatch(raw, presetLayers, canvas);
  const match = nearest <= 0.14 && orderDrift <= 0.2 && spanDrift <= 0.35 && !photoMismatch;
  const meanDist = Math.max(nearest, orderDrift, photoMismatch ? 1 : 0);
  return { match, meanDist, nearest, orderDrift, spanDrift, photoMismatch, pairs };
}

// SIGNAL C — PHOTO-SLOT parity (ad 026): a reference dominated by a big PHOTO region must not
// snap onto a template with no comparable image slot near that spot — the preset would erase
// the ad's hero imagery and fill its own default furniture. Big = ≥10% of canvas area.
// FABLE FIX 026-1 (extended here): the model routinely reads a giant photo as `type:'shape'`
// (e.g. 026's pillow read as two `shape/card` "Left half"/"Right half" regions) — restricting
// this signal to `type==='image'` let it slip straight past the gate every time. Any large
// region is now considered, whether it read as image OR shape/card. Factored out of
// presetGeometryMatch so the SPARSE-TEXT early-return (too few text layers to score Signals A/B)
// still runs this check instead of unconditionally trusting the preset (026 had only 1 text
// layer read — "Silk" — so the old early return skipped Signal C entirely).
export function bigPhotoMismatch(raw, presetLayers, canvas) {
  const cw = Number(canvas?.w) || CANON_W, ch = Number(canvas?.h) || CANON_W;
  const diag = Math.hypot(cw, ch) || 1;
  const canvasArea = cw * ch;
  const bigImgs = (Array.isArray(raw?.layers) ? raw.layers : [])
    .filter((l) => {
      const type = String(l?.type || '').toLowerCase();
      const bigArea = ((clampPct(l?.box?.w) / 100) * (clampPct(l?.box?.h) / 100)) >= 0.10;
      if (!bigArea) return false;
      if (type === 'image') return true;
      // shape/card region with no keyword hint at all reads as "just a colored panel" to the
      // model, but at this size it is exactly the class of region that turns out to be a
      // mis-typed photo (026). Treat any large, otherwise-unlabeled shape/card the same way.
      if (type === 'shape' && /card|panel|shape|photo|image|picture/.test(`${String(l?.role || '')} ${String(l?.text || '')}`.toLowerCase())) return true;
      return false;
    })
    .map((l) => ({
      ...centroid({ x: (clampPct(l.box?.x) / 100) * cw, y: (clampPct(l.box?.y) / 100) * ch, w: (clampPct(l.box?.w) / 100) * cw, h: (clampPct(l.box?.h) / 100) * ch }),
      area: (clampPct(l.box?.w) / 100) * cw * (clampPct(l.box?.h) / 100) * ch,
    }))
    .filter((c) => c.cx != null);
  if (!bigImgs.length) return false;
  const slotImgs = flattenLeaves(presetLayers)
    .filter((n) => (n?.type === 'image' || n?.role === 'product' || n?.role === 'avatar' || n?.role === 'photo')
      && n?.box && (n.box.w * n.box.h) >= canvasArea * 0.08)
    .map((n) => ({ ...centroid(n.box), area: (n.box.w || 0) * (n.box.h || 0) }))
    .filter((c) => c.cx != null);
  // A slot only "covers" a big extracted region when it's BOTH nearby AND comparably sized —
  // 026's giant half-canvas photo (≈50% of the canvas) sat near a small 324×576 packshot slot
  // (≈16% of the canvas) purely by column alignment; proximity alone let that count as a match.
  // Require the slot to be at least half the extracted region's area, not just nearby.
  return bigImgs.some((e) => !slotImgs.some((s) =>
    Math.hypot(e.cx - s.cx, e.cy - s.cy) / diag <= 0.22 && s.area >= e.area * 0.5));
}

// ── LOOSE-LAYER GROUPING ───────────────────────────────────────────────────────────────────────
// When we DON'T fill a preset (generic / low-confidence), the loose skeleton layers get grouped
// into named REGION groups (header / body / product / cta) by vertical band + role, so the layer
// tree has hierarchy instead of a flat 50-layer pile. Groups are Figma-clean GroupNodes (box =
// bounds of absolute-coord children); ungrouped stragglers stay at the top level.
let groupSeq = 0;
const groupId = () => `grp-${Date.now().toString(36)}-${(groupSeq++).toString(36)}`;

/** Classify a loose skeleton layer into a region bucket by role + vertical position. */
function regionOf(layer, canvasH) {
  const role = String(layer?.role || '').toLowerCase();
  const y = Number(layer?.box?.y) || 0;
  const cy = y / Math.max(1, canvasH);
  if (/cta|button/.test(role) || layer?.type === 'button') return 'cta';
  if (/product|avatar|image|photo|logo/.test(role) || layer?.type === 'image') return 'product';
  if (/headline|title|nav|header|badge/.test(role) && cy < 0.28) return 'header';
  if (cy < 0.2) return 'header';
  if (cy > 0.82) return 'cta';
  return 'body';
}

const REGION_NAMES = { header: 'Header', body: 'Body', product: 'Product', cta: 'CTA' };
const REGION_ORDER = ['header', 'body', 'product', 'cta'];

// ── GEOMETRY SANITY POST-PASS (FIX 2b) ──────────────────────────────────────────────────────────
// Vision boxes are frequently off: two text layers reported at overlapping positions (so they render
// stacked/illegible), or boxes bleeding off-canvas. This deterministic pass, run on the canonical-px
// skeleton BEFORE grouping, enforces real geometry: (1) every layer's box is clamped fully on-canvas;
// (2) any two TEXT layers overlapping by >30% of the smaller box's area are separated — the one lower
// on the page is nudged straight down until the vertical overlap clears (text reads top-to-bottom, so
// pushing the lower one down preserves reading order without inventing a horizontal position). Runs a
// couple of settle passes; never grows the layer set. Returns { layers, fixed } (fixed = # of nudges).

/** Area-overlap fraction of the SMALLER of two px boxes (0 = disjoint, 1 = one fully inside other). */
function overlapFrac(a, b) {
  if (!a || !b) return 0;
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = ix * iy;
  if (inter <= 0) return 0;
  const minArea = Math.min(a.w * a.h, b.w * b.h);
  return minArea > 0 ? inter / minArea : 0;
}

const isTextLayer = (l) => l && (l.type === 'text' || l.type === 'badge' || l.type === 'button') &&
  typeof l.text === 'string' && l.text.trim().length > 0;

/**
 * Enforce geometry sanity on a canonical-px skeleton layer list. Clamps on-canvas and de-overlaps
 * text. Mutates layer boxes in place (they're freshly built by toSkeletonLayers). Exported for tests.
 */
export function sanitizeGeometry(layers, canvas) {
  const list = Array.isArray(layers) ? layers : [];
  const cw = Number(canvas?.w) || CANON_W;
  const ch = Number(canvas?.h) || CANON_W;
  let fixed = 0;
  // 1. Clamp every box fully on-canvas.
  for (const l of list) {
    if (!l?.box) continue;
    const b = l.box;
    b.w = Math.max(20, Math.min(b.w, cw));
    b.h = Math.max(16, Math.min(b.h, ch));
    b.x = Math.max(0, Math.min(b.x, cw - b.w));
    b.y = Math.max(0, Math.min(b.y, ch - b.h));
  }
  // 2. De-overlap text (>30% of the smaller box). Settle over a few passes so a chain of stacked
  //    lines all separate. Order by y so the "lower" layer is always the one pushed down.
  const texts = list.filter(isTextLayer);
  for (let pass = 0; pass < 4; pass++) {
    let moved = false;
    texts.sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
    for (let i = 0; i < texts.length; i++) {
      for (let j = i + 1; j < texts.length; j++) {
        const A = texts[i].box, B = texts[j].box;
        if (overlapFrac(A, B) <= 0.3) continue;
        // horizontally disjoint pairs never visually collide even if their y-bands touch
        const hx = Math.min(A.x + A.w, B.x + B.w) - Math.max(A.x, B.x);
        if (hx <= 0) continue;
        // push B (the lower/later one) down so its top clears A's bottom, clamped on-canvas
        const targetY = Math.min(A.y + A.h + 8, ch - B.h);
        if (targetY > B.y) { B.y = targetY; moved = true; fixed++; }
      }
    }
    if (!moved) break;
  }
  return { layers: list, fixed };
}

/**
 * Group loose skeleton layers into named region groups so the layer tree reads with hierarchy.
 * A region with 2+ members becomes a group; a lone member stays a top-level leaf. Base/background
 * layers stay ungrouped at the very back. Returns a new top-level layer list. Never throws.
 */
export function groupLooseLayers(layers, canvasH) {
  if (!Array.isArray(layers) || layers.length < 2) return layers || [];
  const buckets = { header: [], body: [], product: [], cta: [] };
  const loose = [];
  for (const l of layers) {
    if (!l || l.role === 'base' || l.role === 'background') { loose.push(l); continue; }
    try { buckets[regionOf(l, canvasH)].push(l); } catch { loose.push(l); }
  }
  const out = [...loose];
  for (const key of REGION_ORDER) {
    const kids = buckets[key];
    if (kids.length >= 2) {
      out.push({ id: groupId(), type: 'group', name: REGION_NAMES[key], box: groupBounds(kids) || { x: 0, y: 0, w: 0, h: 0 }, children: kids });
    } else if (kids.length === 1) {
      out.push(kids[0]);
    }
  }
  return out;
}

/** Parse a vision reply string → raw extraction object (tolerant). */
function parseRaw(text) {
  return extractJson(String(text || '')) || (() => {
    try { const j = JSON.parse(text); return Array.isArray(j.layers) ? j : null; } catch { return null; }
  })();
}

// ── Refine-loop merge/diff (FIX 2) ─────────────────────────────────────────────────────────────

/** A layer is "high confidence" (worth keeping if a refine pass drops it) when it carries real
 *  text or is a real region with a sane box. */
function isHighConfidenceLayer(l) {
  if (!l || !l.box) return false;
  const hasText = typeof l.text === 'string' && l.text.trim().length >= 2;
  const hasBox = Number(l.box.w) > 3 && Number(l.box.h) > 1;
  return hasBox && (hasText || l.type === 'image');
}

/** Loose identity for a layer so we can tell "same layer, adjusted" from "new/dropped". Text
 *  layers key on normalized text; region layers key on type+role+rough position. */
function layerKey(l) {
  const t = (l?.text || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (t) return `t:${t.slice(0, 40)}`;
  const b = l?.box || {};
  const gx = Math.round((Number(b.x) || 0) / 12), gy = Math.round((Number(b.y) || 0) / 12);
  return `r:${l?.type || '?'}:${l?.role || '?'}:${gx},${gy}`;
}

/** Did this layer's box move/resize meaningfully vs its prior twin? (>3% on any edge.) */
function boxAdjusted(a, b) {
  if (!a?.box || !b?.box) return false;
  const d = (k) => Math.abs((Number(a.box[k]) || 0) - (Number(b.box[k]) || 0));
  return d('x') > 3 || d('y') > 3 || d('w') > 3 || d('h') > 3;
}

// ── Spatial de-duplication ("same product 40 times" fix) ─────────────────────────────────────
/** Intersection-over-union of two percent-space boxes (0 when disjoint). */
function iou(a, b) {
  if (!a || !b) return 0;
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = ix * iy;
  if (inter <= 0) return 0;
  const uni = a.w * a.h + b.w * b.h - inter;
  return uni > 0 ? inter / uni : 0;
}
/** Fraction of `inner`'s area that falls inside `outer` (containment, 0..1). */
function coverage(inner, outer) {
  if (!inner || !outer) return 0;
  const ix = Math.max(0, Math.min(inner.x + inner.w, outer.x + outer.w) - Math.max(inner.x, outer.x));
  const iy = Math.max(0, Math.min(inner.y + inner.h, outer.y + outer.h) - Math.max(inner.y, outer.y));
  const area = inner.w * inner.h;
  return area > 0 ? (ix * iy) / area : 0;
}
const normText = (t) => String(t || '').toLowerCase().replace(/\s+/g, ' ').trim();
const isProductLike = (l) => l?.type === 'image' || /product|photo|bottle|pack|jar|tube|can|device|phone|hero/i.test(String(l?.role || ''));
/** Rough "how real is this layer" score — real copy + bigger area + a color = more trustworthy. */
function layerConfidence(l) {
  let c = 0;
  if (normText(l?.text).length >= 2) c += 3;
  const b = l?.box || {};
  c += Math.min(3, ((Number(b.w) || 0) * (Number(b.h) || 0)) / 400);
  if (l?.color || l?.style?.background || l?.style?.color) c += 0.5;
  return c;
}

/**
 * Collapse near-duplicate layers vision emits when it re-reports the same region — the "same
 * product 40 times" bug. Two PRODUCT/IMAGE regions that overlap (IoU>0.4 or one mostly inside the
 * other) are the SAME product: we merge them into the UNION box, which tracks the product's true
 * OUTER EDGES across every read (the "beyond four corners" ask — the union of all overlapping reads
 * is the real silhouette bound) and keep the higher-confidence layer's label/color. Duplicate text
 * (same copy, overlapping) collapses to the stronger copy. Returns {layers, removed}.
 */
export function dedupeRawLayers(layers) {
  const src = (Array.isArray(layers) ? layers : []).filter((l) => l && l.box);
  const out = [];
  let removed = 0;
  for (const l of src) {
    let hit = null;
    for (const k of out) {
      const ov = iou(l.box, k.box);
      const contained = coverage(l.box, k.box) > 0.7 || coverage(k.box, l.box) > 0.7;
      const t1 = normText(l.text), t2 = normText(k.text);
      if (isProductLike(l) && isProductLike(k) && (ov > 0.4 || contained)) {
        const keep = layerConfidence(k) >= layerConfidence(l) ? k : l;
        const drop = keep === k ? l : k;
        const nx = Math.min(l.box.x, k.box.x), ny = Math.min(l.box.y, k.box.y);
        keep.box = { x: nx, y: ny,
          w: Math.max(l.box.x + l.box.w, k.box.x + k.box.w) - nx,
          h: Math.max(l.box.y + l.box.h, k.box.y + k.box.h) - ny };
        if (!normText(keep.text) && normText(drop.text)) keep.text = drop.text;
        if (!keep.color && drop.color) keep.color = drop.color;
        if (keep === l) { const i = out.indexOf(k); if (i >= 0) out[i] = l; }
        hit = keep; break;
      }
      if (t1 && t1 === t2 && (ov > 0.15 || contained)) {
        const keep = layerConfidence(k) >= layerConfidence(l) ? k : l;
        if (keep === l) { const i = out.indexOf(k); if (i >= 0) out[i] = l; }
        hit = keep; break;
      }
      if (l.type === k.type && contained && ov > 0.6) {
        const keep = layerConfidence(k) >= layerConfidence(l) ? k : l;
        if (keep === l) { const i = out.indexOf(k); if (i >= 0) out[i] = l; }
        hit = keep; break;
      }
    }
    if (hit) removed++;
    else out.push(l);
  }
  return { layers: out, removed };
}

/**
 * Merge a refined pass over the prior best: prefer the refined layers (the model's correction),
 * but re-add any HIGH-CONFIDENCE prior layer the refine dropped (so refinement never loses a
 * solid layer to a careless omission). Returns { merged, summary:{added,dropped,adjusted} }.
 */
function mergeRefined(prior, refined) {
  const priorLayers = Array.isArray(prior?.layers) ? prior.layers : [];
  const refinedLayers = Array.isArray(refined?.layers) ? refined.layers : [];
  const priorByKey = new Map(priorLayers.map((l) => [layerKey(l), l]));
  const refinedKeys = new Set(refinedLayers.map(layerKey));

  let added = 0, adjusted = 0;
  for (const rl of refinedLayers) {
    const twin = priorByKey.get(layerKey(rl));
    if (!twin) added++;
    else if (boxAdjusted(twin, rl)) adjusted++;
  }
  // Re-add high-confidence prior layers the refine forgot (respect MAX_LAYERS).
  const merged = refinedLayers.slice(0, MAX_LAYERS);
  let dropped = 0;
  for (const pl of priorLayers) {
    if (refinedKeys.has(layerKey(pl))) continue;
    if (isHighConfidenceLayer(pl) && merged.length < MAX_LAYERS) { merged.push(pl); dropped++; }
  }
  const out = {
    canvasRatio: Number(refined?.canvasRatio) || Number(prior?.canvasRatio) || null,
    archetype: (refined?.archetype && refined.archetype !== 'generic') ? refined.archetype : (prior?.archetype || refined?.archetype),
    background: refined?.background != null ? refined.background : prior?.background,
    backgroundKind: refined?.backgroundKind || prior?.backgroundKind,
    layers: merged,
  };
  return { merged: out, summary: { added, dropped, adjusted } };
}

// Above this flatness (mean |Δluminance| across the sampled border), the frame is NOT a flat fill —
// it's a busy photo edge — and we must not collapse it to a single averaged "dominant" hex. This is
// looser than the `strongFlat` solid-color threshold below; it marks the upper end where averaging
// would actively misrepresent the reference (Michael: "pure black is fine IF the bg truly is solid;
// it's wrong when a full-bleed photo gets flattened into a black/solid swatch").
const PHOTO_VARIANCE_THRESHOLD = 0.09;

/**
 * Reconcile the model's `background` (+ its own backgroundKind judgment) against a deterministic
 * border-pixel sample (FIX 1). The border sampler reads REAL pixels, so we trust it hard — the
 * model routinely mis-reports background luminance (says white on a black ad) AND routinely
 * flattens a full-bleed photo into a solid hex. Priority:
 * - Model gave a valid GRADIENT → trust it (the sampler only yields a flat color).
 * - Model explicitly said backgroundKind "photo" (background null) AND the sampled border is NOT
 *   strongly flat → trust the model + pixels agreeing it's a photo: return null + isPhoto.
 * - Sampler read a HIGH-VARIANCE (non-flat) border → this is a photo edge, not a solid fill, even
 *   if the model guessed a hex. Do NOT average it into a dominant color: return null + isPhoto so
 *   downstream uses the actual reference photo as the base layer instead of a flat swatch.
 * - Sampler read a STRONG FLAT frame (low flatness = a genuine solid-color border) → the pixels ARE
 *   the background. Keep the model's hex only when it agrees closely (Δlum ≤ 0.12); otherwise use
 *   the sampled hex. This is what stops a dark ad from resolving to white — and also what lets a
 *   truly solid black background resolve to black without being "corrected" away.
 * - Sampler read a mildly noisy (but not photo-level) frame → the model may know better; keep its
 *   hex unless luminance is WILDLY off (>0.4 delta), then fall back to pixels.
 * - Model gave null → use the sampled hex (unless variance says photo, handled above).
 * - Sampler failed (undecodable) → fall back to whatever the model gave (or null).
 * Returns { background, isPhoto, confidence }: background is a hex string, a {from,to,angle}
 * gradient, or null; isPhoto is true whenever background is null because the reference is a
 * full-bleed photo (as opposed to null just meaning "unknown"); confidence is 'high'|'normal' —
 * 'high' when the border average agrees closely with the image's single most dominant color
 * cluster (cross-checked via the median-cut palette), meaning two independent reads concur.
 * Never throws.
 */
function resolveBackground(modelBg, imagePath, progress, modelKind, precomputed = null) {
  // A valid gradient from the model wins outright — our sampler can't represent gradients.
  if (modelBg && typeof modelBg === 'object' && HEX_RE.test(String(modelBg.from)) && HEX_RE.test(String(modelBg.to))) {
    return { background: { from: modelBg.from, to: modelBg.to, angle: Number(modelBg.angle) || 180 }, isPhoto: false, confidence: 'normal' };
  }
  const modelHex = (modelBg && HEX_RE.test(String(modelBg)) && String(modelBg).startsWith('#')) ? String(modelBg) : null;
  const modelSaysPhoto = String(modelKind || '').toLowerCase() === 'photo';

  // Reuse the fan-out's border sample + palette when the caller precomputed them (the concurrent
  // analysis workers). Falls back to sampling here for the standalone/legacy callers.
  let sample = precomputed && 'sample' in precomputed ? precomputed.sample : undefined;
  if (sample === undefined) { try { sample = sampleBorderBackground(imagePath); } catch { sample = null; } }

  // Cross-check: does the border average agree with the single most dominant interior color
  // cluster? When they're close, two independent reads concur → report higher confidence on
  // whichever background hex we end up returning.
  let borderAgreesWithDominant = false;
  if (sample) {
    try {
      const palette = (precomputed && Array.isArray(precomputed.palette) && precomputed.palette.length)
        ? precomputed.palette
        : extractDominantPalette(imagePath, 5);
      if (palette.length) borderAgreesWithDominant = colorDistance(sample.hex, palette[0].hex) <= 0.12;
    } catch { /* palette is a bonus signal, never fatal */ }
  }
  const confidence = borderAgreesWithDominant ? 'high' : 'normal';

  if (sample) {
    const tone = sample.lum < 0.35 ? 'dark' : sample.lum > 0.72 ? 'light' : 'mid';
    const strongFlat = typeof sample.flatness === 'number' && sample.flatness <= 0.05;
    const highVariance = typeof sample.flatness === 'number' && sample.flatness >= PHOTO_VARIANCE_THRESHOLD;

    // A busy/non-uniform border means we're sampling a photo, not a solid fill — never collapse
    // it to a single "dominant" hex (the bug: a full-bleed photo misreported as a black/solid
    // swatch). Trust this over any hex the model guessed, and over a bare model hex with no kind.
    if (highVariance && !strongFlat) {
      progress(`border is non-flat (flatness ${sample.flatness.toFixed(3)}) — treating as photo background, not a solid fill`);
      return { background: null, isPhoto: true, confidence: 'normal' };
    }
    if (modelSaysPhoto && !strongFlat) {
      progress('model reports a photo background — honoring it (no flat fill)');
      return { background: null, isPhoto: true, confidence: 'normal' };
    }

    if (!modelHex) {
      progress(`background sampled from pixels: ${sample.hex} (${tone})${borderAgreesWithDominant ? ' · confirmed by dominant-color cross-check' : ''}`);
      return { background: sample.hex, isPhoto: false, confidence };
    }
    const mrgb = hexToRgb(modelHex);
    const modelLum = mrgb ? relLum(mrgb.r, mrgb.g, mrgb.b) : null;
    const dLum = modelLum != null ? Math.abs(modelLum - sample.lum) : 1;
    // A low flatness (≤0.05) means the frame is a genuine solid color — the deterministic read is
    // authoritative. Trust the pixels unless the model's hex is essentially the same tone. This is
    // also what lets a real solid-black background stay black instead of being second-guessed.
    if (strongFlat && dLum > 0.12) {
      progress(`solid ${tone} border ${sample.hex} overrides model bg ${modelHex} (Δlum ${dLum.toFixed(2)})`);
      return { background: sample.hex, isPhoto: false, confidence };
    }
    if (dLum > 0.4) {
      // The model is grossly wrong (e.g. said white on a black bg) — trust the pixels.
      progress(`model bg ${modelHex} contradicts pixels — using sampled ${sample.hex} (${tone})`);
      return { background: sample.hex, isPhoto: false, confidence };
    }
    // Model & pixels agree closely → keep the model's (usually more precise) hex.
    return { background: modelHex, isPhoto: false, confidence };
  }

  // Undecodable image (sampler failed) → whatever the model gave (still honor an explicit photo call).
  if (modelSaysPhoto) return { background: null, isPhoto: true, confidence: 'normal' };
  return { background: modelHex, isPhoto: false, confidence: 'normal' };
}

/**
 * One vision read with TRANSIENT-FAILURE RETRIES that do NOT consume a "real" pass. Empty
 * completions, parse failures, and timeouts get up to `maxAttempts` tries before giving up
 * (Michael: "retries 5 times first before stopping if gemma doesn't work"). A `noVision`
 * response is fatal (no point retrying) and is signaled via the returned shape.
 * Returns { raw, error, noVision, attempts }.
 */
async function visionRead(prompt, imagePath, { timeoutMs, maxAttempts, purpose, label, progress, isCanceled, signal = null, allowEmpty = false, maxTokens = undefined }) {
  // Retry strategy (rewritten after live evidence the old loop was useless): llmVision defaults to
  // temperature 0, so re-sending the IDENTICAL prompt after a parse failure provably returns the
  // identical wrong output (observed: 5 attempts, byte-identical token counts every time). So:
  //   • TRANSIENT NETWORK/HTTP failures → retry up to maxAttempts, unchanged.
  //   • TIMEOUT failures → cap at 2. A timeout means the model can't finish THIS read inside the
  //     budget; re-asking identically at the same budget mostly re-times-out (observed: 5×90 s =
  //     450 s of dead time on a dark X-post). Two tries, then give up so the caller can fall back to
  //     the cheaper two-step scoped read instead of burning minutes.
  //   • DETERMINISTIC failures (call ok but output unparsable) → exactly ONE corrective retry with
  //     a "reply with ONLY the JSON" nudge at temperature 0.4 (varies the sample), then stop.
  // `signal` (the run's AbortSignal) now reaches the in-flight HTTP call, so Stop/delete kills the
  // extraction promptly instead of waiting out a 90s vision call (RUN-1/RUN-9).
  const MAX_TIMEOUTS = 2;
  let lastErr = null;
  let parseFailures = 0;
  let timeouts = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (isCanceled() || signal?.aborted) return { raw: null, error: 'canceled', canceled: true };
    const corrective = parseFailures > 0;
    const p = corrective
      ? `${prompt}\n\nIMPORTANT: your previous reply was not parseable. Reply with ONLY the single JSON object — no prose, no markdown fences, no reasoning text — and make sure every bracket and quote closes.`
      : prompt;
    const vr = await llmVision(p, imagePath, {
      json: true, timeoutMs, purpose, signal,
      temperature: corrective ? 0.4 : 0,
      ...(maxTokens ? { maxTokens } : {}),
    });
    if (vr.aborted || isCanceled() || signal?.aborted) return { raw: null, error: 'canceled', canceled: true };
    if (vr.noVision) return { raw: null, error: vr.error, noVision: true };
    if (!vr.ok) {
      lastErr = vr.error;
      const isTimeout = /time?out|aborted/i.test(String(vr.error || ''));
      if (isTimeout && ++timeouts >= MAX_TIMEOUTS) {
        progress(`${label}: timed out ${timeouts}× at ${Math.round(timeoutMs / 1000)}s — stopping (won't finish in budget)`);
        return { raw: null, error: vr.error, timedOut: true };
      }
      progress(`${label}: attempt ${attempt}/${maxAttempts} failed (${vr.error})${attempt < maxAttempts ? ' — retrying' : ''}`);
      continue;
    }
    const raw = parseRaw(vr.text);
    const emptyOk = allowEmpty && raw && Array.isArray(raw.layers);
    if ((!raw || !Array.isArray(raw.layers) || raw.layers.length === 0) && !emptyOk) {
      parseFailures++;
      lastErr = 'unparsable / empty layout';
      if (parseFailures >= 2) {
        // base attempt + one corrective nudge both unparsable — a third identical ask cannot
        // succeed; stop early instead of burning the remaining attempts.
        progress(`${label}: still unparsable after a corrective retry — stopping (deterministic failure)`);
        return { raw: null, error: lastErr };
      }
      progress(`${label}: attempt ${attempt}/${maxAttempts} unparsable — one corrective retry`);
      continue;
    }
    return { raw, error: null, attempts: attempt };
  }
  return { raw: null, error: lastErr || 'no parsable layout from vision' };
}

/**
 * TWO-STEP scoped read (FIX 2a): STEP A = frame + archetype + the ≤6 biggest non-text regions;
 * STEP B = text layers only, given step A. Two small responses parse more reliably and each finishes
 * inside the per-pass budget — the remedy for the dense/dark single-read timeout. The results merge
 * back into the normal { canvasRatio, archetype, backgroundKind, background, layers[] } schema.
 * Returns the same shape as visionRead: { raw, error, noVision?, canceled? }. Each step gets a
 * SHORTER per-call timeout (the whole point is small, fast calls) and a tighter token budget.
 */
async function visionReadTwoStep(imagePath, { timeoutMs, purpose, progress, isCanceled, signal = null }) {
  // small scope → shorter budget per call, but scale with an explicitly larger budget (slow
  // local models) the same way extractLayout's perPass does.
  const stepTimeout = Math.min(timeoutMs, Math.max(55_000, Math.round(timeoutMs / 2)));
  progress('two-step read · step A: structure + archetype + regions');
  const a = await visionRead(STRUCT_PROMPT, imagePath, {
    timeoutMs: stepTimeout, maxAttempts: 3, purpose: `${purpose}-struct`,
    label: 'step A', progress, isCanceled, signal, allowEmpty: true, maxTokens: 3000,
  });
  if (a.canceled) return { raw: null, error: 'canceled', canceled: true };
  if (a.noVision) return { raw: null, error: a.error, noVision: true };
  if (!a.raw) return { raw: null, error: a.error || 'structure read failed' };

  const structJson = JSON.stringify({
    canvasRatio: a.raw.canvasRatio, archetype: a.raw.archetype,
    backgroundKind: a.raw.backgroundKind, background: a.raw.background,
    layers: (a.raw.layers || []).map((l) => ({ type: l.type, role: l.role, box: l.box })),
  });
  progress('two-step read · step B: text layers');
  const b = await visionRead(TEXT_PROMPT(structJson), imagePath, {
    timeoutMs: stepTimeout, maxAttempts: 3, purpose: `${purpose}-text`,
    label: 'step B', progress, isCanceled, signal, allowEmpty: true, maxTokens: 4000,
  });
  if (b.canceled) return { raw: null, error: 'canceled', canceled: true };
  // Step B may legitimately return no text (a pure-photo ad) — that's fine, keep step A's regions.
  const structLayers = Array.isArray(a.raw.layers) ? a.raw.layers : [];
  const textLayers = (b.raw && Array.isArray(b.raw.layers)) ? b.raw.layers : [];
  const merged = {
    canvasRatio: a.raw.canvasRatio,
    archetype: a.raw.archetype || 'generic',
    backgroundKind: a.raw.backgroundKind,
    background: a.raw.background,
    // regions (paint first) then text (paint last) — toSkeletonLayers re-bands anyway
    layers: [...structLayers, ...textLayers].slice(0, MAX_LAYERS),
  };
  if (!merged.layers.length) return { raw: null, error: 'two-step read produced no layers' };
  progress(`two-step read: ${structLayers.length} region(s) + ${textLayers.length} text layer(s)`);
  return { raw: merged, error: null };
}

// ── RENDER-AND-COMPARE SELF-CHECK ──────────────────────────────────────────────────────────────
// The refine loop above is a TEXT-level self-check: the model re-reads the image and corrects its
// own JSON. It never RENDERS the result and eyeballs it against the original. This block closes
// that gap: assemble the extracted skeleton into a doc, render it to a PNG (self-vision's
// renderCompPng), and ask vision "does this reconstruction match the reference? what's off?"
// (self-vision's compareToReference → structured {match, corrections:[{layer,problem,fix}]}). The
// returned corrections are then applied deterministically where the fix is unambiguous (recolor,
// nudge, resize). Gated + capped at ONE round; fully best-effort — a failed compare NEVER breaks
// extraction (the caller keeps the un-checked skeleton). self-vision.mjs imports codexSee from
// THIS module, so we import it back only DYNAMICALLY (inside the async fn) to avoid an ES-module
// import cycle at load time.

/**
 * Build a minimal renderable doc from an extracted skeleton so renderCompPng can composite it.
 * Prepends a BASE layer that reproduces the reference's background so the render sits on the same
 * ground the original does: a full-bleed <image> of the reference itself when backgroundIsPhoto
 * (the extracted overlays float over the real photo — exactly what downstream does), else a solid/
 * gradient shape filling the canvas. Extracted layers paint on top in their existing z-order.
 * Returns { doc, resolveImage } where resolveImage inlines the reference file for the base image.
 */
function buildDocFromSkeleton(layers, canvas, { background, backgroundIsPhoto, referencePath }) {
  const REF_SENTINEL = '__extract_ref__';
  const base = [];
  if (backgroundIsPhoto && referencePath) {
    base.push({
      id: 'ext-base-photo', type: 'image', role: 'base', name: 'Reference photo',
      src: REF_SENTINEL, fit: 'cover',
      box: { x: 0, y: 0, w: canvas.w, h: canvas.h },
      style: {},
    });
  } else if (background && typeof background === 'object' && background.from && background.to) {
    base.push({
      id: 'ext-base-grad', type: 'shape', role: 'base', name: 'Background',
      box: { x: 0, y: 0, w: canvas.w, h: canvas.h },
      style: { background: `linear-gradient(${Number(background.angle) || 180}deg, ${background.from}, ${background.to})`, opacity: 1 },
    });
  } else if (typeof background === 'string' && HEX_RE.test(background)) {
    base.push({
      id: 'ext-base-solid', type: 'shape', role: 'base', name: 'Background',
      box: { x: 0, y: 0, w: canvas.w, h: canvas.h },
      style: { background, opacity: 1 },
    });
  }
  const doc = {
    id: `extract-selfcheck-${Date.now().toString(36)}`,
    name: 'Extraction self-check',
    canvas: { w: canvas.w, h: canvas.h },
    layers: [...base, ...(Array.isArray(layers) ? layers : [])],
  };
  const resolveImage = (src) => {
    if (src === REF_SENTINEL && referencePath && existsSync(referencePath)) {
      try {
        const ext = /\.jpe?g$/i.test(referencePath) ? 'jpeg' : 'png';
        return `data:image/${ext};base64,${readFileSync(referencePath).toString('base64')}`;
      } catch { return src; }
    }
    return src;
  };
  return { doc, resolveImage };
}

/** Case-insensitive substring/word overlap between a correction's `layer` name and a skeleton
 *  layer's role/name/text — used to route a correction to the layer(s) it's about. */
function correctionMatchesLayer(corrLayer, layer) {
  const needle = String(corrLayer || '').toLowerCase().trim();
  if (!needle) return false;
  const hay = `${layer?.role || ''} ${layer?.name || ''} ${String(layer?.text || '')}`.toLowerCase();
  if (hay.includes(needle) || needle.includes(String(layer?.role || '').toLowerCase())) return true;
  // token overlap (e.g. "CTA button" ↔ role "cta"): any shared ≥3-char token counts
  const toks = needle.split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
  return toks.some((tk) => hay.includes(tk));
}

// Walk every leaf layer in a (possibly grouped) skeleton tree, applying `fn(layer)`; returns count.
function forEachLeaf(layers, fn) {
  let n = 0;
  for (const l of (Array.isArray(layers) ? layers : [])) {
    if (!l) continue;
    if (l.type === 'group' && Array.isArray(l.children)) { n += forEachLeaf(l.children, fn); continue; }
    if (fn(l)) n++;
  }
  return n;
}

const clampBox = (box, canvas) => ({
  x: Math.max(0, Math.min(box.x, canvas.w - 20)),
  y: Math.max(0, Math.min(box.y, canvas.h - 20)),
  w: Math.max(20, Math.min(box.w, canvas.w)),
  h: Math.max(16, Math.min(box.h, canvas.h)),
});

/**
 * Apply the structured corrections from compareToReference to the skeleton DETERMINISTICALLY, but
 * only where the fix is unambiguous and safe. Parses the free-text `fix` for a few well-formed
 * directives: a target #hex (recolor), a signed percentage move ("move up ~8%", "nudge right 5%"),
 * and a scale ("enlarge to 2x", "shrink 20%"). Each correction is routed to the layer(s) whose
 * role/name/text match its `layer` field. Corrections we can't parse into a concrete geometry/color
 * change are LEFT for the human (the reference underlay is shown in the editor) — we never guess a
 * position. Mutates copies; returns { layers, applied } where applied counts concrete edits made.
 * Never throws.
 */
function applyCorrections(layers, canvas, corrections) {
  let applied = 0;
  const list = Array.isArray(corrections) ? corrections : [];
  for (const c of list) {
    let touchedForThis = 0;
    const fix = String(c?.fix || '').toLowerCase();
    const problem = String(c?.problem || '').toLowerCase();
    const hexMatch = fix.match(/#[0-9a-f]{3,8}\b/);
    // vertical / horizontal nudges as a % of canvas
    const upM = fix.match(/\bmov\w*|\bnudg\w*|\bshift\w*/) ? fix.match(/(up|down|left|right)\b[^\d]*(\d{1,2})?\s*%?/) : null;
    const scaleX = fix.match(/(\d(?:\.\d)?)\s*x\b/);
    const grow = /\benlarge|\bbigger|\bincrease|\bgrow|\bscale up\b/.test(fix);
    const shrink = /\bshrink|\bsmaller|\breduce|\bscale down\b/.test(fix);
    const pctMove = upM && upM[2] ? Number(upM[2]) : 6; // default nudge 6% when unspecified
    const dir = upM ? upM[1] : null;

    touchedForThis = forEachLeaf(layers, (l) => {
      if (!correctionMatchesLayer(c?.layer, l)) return false;
      let touched = false;
      // COLOR: a concrete target hex + a color/contrast problem → recolor text/fill.
      if (hexMatch && /(color|colour|contrast|darker|lighter|tint)/.test(`${problem} ${fix}`)) {
        const hex = hexMatch[0];
        if (l.style) {
          // text → recolor glyphs; shape/image base → recolor fill
          if (l.type === 'text' || l.type === 'badge' || l.type === 'button') { l.style.color = hex; touched = true; }
          else if (l.style.background !== undefined || l.type === 'shape') { l.style.background = hex; touched = true; }
        }
      }
      // POSITION: a directional nudge → shift the box by pctMove% of the canvas, clamped.
      if (dir && l.box) {
        const dx = dir === 'left' ? -1 : dir === 'right' ? 1 : 0;
        const dy = dir === 'up' ? -1 : dir === 'down' ? 1 : 0;
        l.box = clampBox({
          x: l.box.x + dx * (pctMove / 100) * canvas.w,
          y: l.box.y + dy * (pctMove / 100) * canvas.h,
          w: l.box.w, h: l.box.h,
        }, canvas);
        touched = true;
      }
      // SIZE: an explicit "2x" scale, or a grow/shrink directive → resize the box about its center.
      if ((scaleX || grow || shrink) && l.box) {
        const factor = scaleX ? Math.max(0.3, Math.min(3, Number(scaleX[1]))) : (grow ? 1.25 : 0.8);
        const cx = l.box.x + l.box.w / 2, cy = l.box.y + l.box.h / 2;
        const nw = l.box.w * factor, nh = l.box.h * factor;
        l.box = clampBox({ x: cx - nw / 2, y: cy - nh / 2, w: nw, h: nh }, canvas);
        if (l.type === 'text' && l.style && typeof l.style.fontSize === 'number') {
          l.style.fontSize = Math.max(14, Math.round(l.style.fontSize * factor));
        }
        touched = true;
      }
      return touched;
    });
    applied += touchedForThis;
  }
  return { layers, applied };
}

/**
 * The gated render-and-compare self-check for an extracted skeleton. Best-effort and capped at ONE
 * round: render the skeleton (over the reference background), compare against the ORIGINAL reference
 * image via self-vision's compareToReference, and apply the structured corrections deterministically.
 * Returns { matched, corrections, applied, layers } — `layers` is the (possibly corrected) skeleton,
 * unchanged when nothing could be applied. NEVER throws; on any failure returns the input layers
 * untouched with matched:null so extraction is never broken by the self-check.
 */
async function renderCompareCorrect(layers, canvas, ctx) {
  const { referencePath, background, backgroundIsPhoto, progress, isCanceled } = ctx;
  try {
    if (isCanceled && isCanceled()) return { matched: null, corrections: [], applied: 0, layers };
    // Dynamic import breaks the layout-extract ⇄ self-vision ES-module cycle.
    let compareToReference;
    try { ({ compareToReference } = await import('./self-vision.mjs')); }
    catch (e) { progress(`self-check: self-vision unavailable (${e?.message || e}) — skipping`); return { matched: null, corrections: [], applied: 0, layers }; }
    if (typeof compareToReference !== 'function') return { matched: null, corrections: [], applied: 0, layers };

    const { doc, resolveImage } = buildDocFromSkeleton(layers, canvas, { background, backgroundIsPhoto, referencePath });
    progress('self-check: rendering the reconstruction and comparing to the reference…');
    const cmp = await compareToReference(doc, referencePath, { resolveImage });
    if (!cmp || !cmp.ok) {
      progress(`self-check: compare unavailable (${cmp?.error || 'no result'}) — keeping extraction as-is`);
      return { matched: null, corrections: [], applied: 0, layers };
    }
    const corrections = Array.isArray(cmp.corrections) ? cmp.corrections : [];
    const scoreStr = typeof cmp.score === 'number' ? ` (fidelity ${cmp.score})` : '';
    if (cmp.match || !corrections.length) {
      progress(`self-check: render matches the reference${scoreStr} — no corrections needed`);
      return { matched: true, score: cmp.score ?? null, corrections, applied: 0, layers };
    }
    // How many corrections carry a machine-applicable target (a #hex, a directional %, or an Nx
    // scale)? That's the actionable subset — surface it so the loop's precision is legible.
    const actionable = corrections.filter((c) => {
      const f = String(c?.fix || '').toLowerCase();
      return /#[0-9a-f]{3,8}\b/.test(f) || /\b(up|down|left|right)\b/.test(f) || /\d(?:\.\d)?\s*x\b/.test(f) || /\b(enlarge|shrink|bigger|smaller|reduce|grow)\b/.test(f);
    }).length;
    progress(`self-check${scoreStr}: ${corrections.length} correction${corrections.length === 1 ? '' : 's'} (${actionable} actionable) — ${corrections.map((c) => `${c.layer}: ${c.problem}`).slice(0, 3).join('; ')}`);
    const { layers: corrected, applied } = applyCorrections(layers, canvas, corrections);
    progress(`self-check: applied ${applied} deterministic correction${applied === 1 ? '' : 's'} (${corrections.length - applied} left as guidance)`);
    return { matched: false, score: cmp.score ?? null, corrections, applied, layers: corrected };
  } catch (e) {
    progress(`self-check: failed (${e?.message || e}) — keeping extraction as-is`);
    return { matched: null, corrections: [], applied: 0, layers };
  }
}

// ── ITERATIVE SELF-CHECK (score-gated loop) ─────────────────────────────────────────────────────
// The single-round self-check above is a one-shot: render, compare, apply corrections, done.
// This iterative version loops: if the fidelity score is still below threshold after applying
// corrections, it re-renders and re-compares. Capped at MAX_ITERATIVE_ITERS rounds; stops
// early when score >= ITERATIVE_SCORE_TARGET. Returns the same shape as renderCompareCorrect
// plus extraction metrics.
const MAX_ITERATIVE_ITERS = 3;     // hard cap on comparison rounds
const ITERATIVE_PASS_THRESHOLD = 80; // score below this → apply corrections and re-check
const ITERATIVE_SCORE_TARGET = 85;   // score at or above this → stop (good enough)

/**
 * Iterative render-compare-correct loop. Renders the current extraction, compares against the
 * reference, applies deterministic corrections if the score is below threshold, and repeats.
 * Returns { matched, score, iterations, correctionsApplied, totalCorrections, layers, notes }
 * — never throws. Best-effort: any failure mid-loop returns the best layers so far.
 */
async function iterativeSelfCheck(layers, canvas, ctx) {
  const { referencePath, background, backgroundIsPhoto, progress, isCanceled } = ctx;
  let currentLayers = layers;
  let totalCorrectionsApplied = 0;
  let totalCorrections = 0;
  let lastScore = null;
  let iterations = 0;
  const allNotes = [];

  for (let iter = 0; iter < MAX_ITERATIVE_ITERS; iter++) {
    if (isCanceled && isCanceled()) break;
    iterations++;

    try {
      const sc = await renderCompareCorrect(currentLayers, canvas, { referencePath, background, backgroundIsPhoto, progress, isCanceled });
      if (sc.matched === null) {
        // self-check unavailable — stop iterating
        allNotes.push(`iteration ${iter + 1}: self-check unavailable — stopping`);
        break;
      }
      lastScore = sc.score;
      totalCorrectionsApplied += sc.applied;
      totalCorrections += (sc.corrections || []).length;

      if (sc.matched) {
        allNotes.push(`iteration ${iter + 1}: match (score ${sc.score ?? '?'}) — done`);
        break;
      }
      if (sc.score != null && sc.score >= ITERATIVE_SCORE_TARGET) {
        allNotes.push(`iteration ${iter + 1}: score ${sc.score} >= ${ITERATIVE_SCORE_TARGET} — done`);
        break;
      }
      if (sc.score != null && sc.score >= ITERATIVE_PASS_THRESHOLD && sc.applied === 0) {
        // Score is OK-ish and no corrections were actionable — nothing more we can do
        allNotes.push(`iteration ${iter + 1}: score ${sc.score} with no actionable corrections — done`);
        break;
      }

      // Apply corrections and loop
      currentLayers = sc.layers;
      if (sc.score != null) {
        allNotes.push(`iteration ${iter + 1}: score ${sc.score} < ${ITERATIVE_PASS_THRESHOLD}, applied ${sc.applied} correction(s) — re-checking`);
      } else {
        allNotes.push(`iteration ${iter + 1}: applied ${sc.applied} correction(s) — re-checking (no score)`);
      }
    } catch (e) {
      allNotes.push(`iteration ${iter + 1}: failed (${e?.message || e}) — stopping`);
      break;
    }
  }

  const notes = allNotes.join(' · ');
  return {
    matched: lastScore != null ? lastScore >= ITERATIVE_SCORE_TARGET : null,
    score: lastScore,
    iterations,
    correctionsApplied: totalCorrectionsApplied,
    totalCorrections,
    layers: currentLayers,
    notes: notes || null,
  };
}

/**
 * Extract the COMPLETE design from an ad image — VISION-ENDPOINT ONLY (no codex; the operator
 * runs a local VL model like Gemma via VISION_BASE_URL). TRUE ITERATIVE REFINEMENT (not best-of-N):
 * pass 1 extracts fresh, then each later pass gets the SAME image PLUS the prior JSON and is asked
 * to correct it (add missing / fix wrong / drop hallucinated). The merge keeps the refined result
 * but re-adds any high-confidence layer a pass carelessly dropped; the loop stops once the score
 * stops rising. Transient failures RETRY without burning a pass. The BACKGROUND is then reconciled
 * against a DETERMINISTIC border-pixel sample (FIX 1) so a dark bg never resolves to white.
 * Returns { ok, layers, canvas, archetype, background, backgroundIsPhoto, error, passes }.
 * `background` is a hex string, a {from,to,angle} gradient, or null; `backgroundIsPhoto` is true
 * when background is null specifically because the reference is a full-bleed photo (a busy,
 * non-flat border was sampled and/or the model itself called it a photo) — a genuine solid-color
 * or gradient background is preserved as its real value, never forced to null or vice versa.
 * Options: timeoutMs, runId (cancelable), onProgress(msg), passes (default 5).
 */
export async function extractLayout(imagePath, { timeoutMs = 120_000, runId = null, onProgress = null, onStep = null, passes = 2, selfCheck = null, signal = null } = {}) {
  // Unified step vocabulary (shared with the design-edit agent — see agent-harness STEP_KINDS):
  // every extraction narration is BOTH a legacy `onProgress(msg)` (unchanged) AND a unified
  // `{kind:'thinking', summary}` step, so a caller that wants one activity component for both the
  // edit and reference-build paths just passes onStep. `emitStep` also carries `subagent` frames
  // (fan-out workers) straight through untouched.
  const emitStep = (step) => { try { if (onStep) onStep(step); } catch { /* observer only */ } };
  const progress = (msg) => {
    try { if (onProgress) onProgress(msg); } catch { /* observer only */ }
    emitStep({ i: 0, kind: 'thinking', summary: String(msg || '').slice(0, 300), at: Date.now() });
  };
  if (!existsSync(imagePath)) {
    progress(`failed: no such image: ${imagePath}`);
    return { ok: false, error: `no such image: ${imagePath}` };
  }
  const info = llmInfo();
  // Label the vision pass with the model ACTUALLY resolved (ornith — gemma is hard-blocked in
  // llm.mjs), not a stale hardcoded string. VISION_MODEL is intentionally unset; activePreferredModel
  // reports the real loaded model so the streamed progress never misleads ("vision@gemma-4-e4b" was
  // cosmetic and caused a false "it's using gemma" alarm).
  const _vbase = process.env.VISION_BASE_URL ? String(process.env.VISION_BASE_URL).replace(/\/$/, '') : null;
  const _visionModel = _vbase ? (await activePreferredModel(_vbase).catch(() => null)) : null;
  const vinfo = _vbase ? `vision@${_visionModel || 'local VL model'}` : `${info.provider} vision`;

  // TWO cancellation sources, now BRIDGED (this was RUN-1/RUN-2: the server's AbortController
  // registry — Stop button, comp delete — never reached this function, making copy-reference runs
  // unabortable): the legacy cooperative cancelExtraction(runId) flag AND the caller's AbortSignal.
  // isCanceled() honors both, and `signal` is also threaded into every vision HTTP call below so an
  // abort kills the in-flight request rather than waiting out its timeout.
  let canceled = false;
  if (runId) activeRuns.set(runId, { cancel: () => { canceled = true; } });
  const isCanceled = () => canceled || !!signal?.aborted;
  const cleanup = () => { if (runId) activeRuns.delete(runId); };

  // Per-pass budget: 90s default, but an EXPLICITLY larger overall budget (slow local models —
  // observed 1.5-4 min per ornith call on some machines) scales the per-pass window up too, or
  // every pass times out and the whole extraction fails despite the generous total.
  const perPass = Math.min(timeoutMs, Math.max(90_000, Math.round(timeoutMs / 3)));
  const n = Math.max(1, Math.min(4, passes));
  // Up to 5 vision ATTEMPTS for the (harder) first read before giving up entirely.
  const RETRIES = Math.max(5, n);

  // ── Pass 1: fresh extraction ────────────────────────────────────────────────────────────────
  progress(`reading the reference with ${vinfo} — pass 1/${n}…`);
  let first = await visionRead(PROMPT, imagePath, {
    timeoutMs: perPass, maxAttempts: RETRIES, purpose: 'layout-extract',
    label: 'pass 1', progress, isCanceled, signal,
  });
  if (first.canceled) { cleanup(); return { ok: false, error: 'canceled', canceled: true }; }
  if (first.noVision) {
    const msg = `no vision endpoint — start LM Studio with a vision-capable model (ornith) and set VISION_BASE_URL in studio/.env. (${info.provider}·${info.model} is text-only.)`;
    progress(`failed: ${msg}`); cleanup();
    return { ok: false, error: msg, noVision: true };
  }
  // FALLBACK: the single all-in-one read TIMED OUT (dense/dark reference the model can't finish in
  // budget) OR came back empty. Switch to the TWO-STEP scoped read (structure, then text) — smaller
  // per-call responses parse more reliably and each finishes inside the budget. This is the concrete
  // remedy for the 450 s dark-X-post timeout the eval surfaced.
  if ((!first.raw || first.timedOut) && !isCanceled()) {
    progress(first.timedOut ? 'single read timed out — retrying as a two-step scoped read' : 'single read failed — trying a two-step scoped read');
    const ts = await visionReadTwoStep(imagePath, { timeoutMs: perPass, purpose: 'layout-extract', progress, isCanceled, signal });
    if (ts.canceled) { cleanup(); return { ok: false, error: 'canceled', canceled: true }; }
    if (ts.raw) first = ts;
  }
  if (!first.raw) {
    progress(`failed: ${first.error}`); cleanup();
    return { ok: false, error: first.error };
  }
  let best = first.raw;
  let bestScore = scoreRaw(best);
  progress(`pass 1: ${best.layers.length} layers · ${best.archetype || 'generic'} (score ${bestScore.toFixed(1)})`);

  // DEGENERATE-COORDS RETRY (ad 002): a known VLM failure mode on dense references — the model
  // stops LOCALIZING and just ENUMERATES: every box gets the same height, x pinned to the left
  // edge, and y walking down in a perfect arithmetic sequence (observed live: y = 2,40,78,116,…
  // step 38, h = 30 for 15 layers). Those are fabricated list coordinates, not positions; no
  // downstream normalizer can fix them because the information was never read. Detect the
  // signature and burn ONE scoped two-step retry (different call shape → different sampling; the
  // scoped read almost always localizes properly). Keep the retry only if IT isn't degenerate.
  const degenerateCoords = (raw) => {
    const ls = (raw?.layers || []).filter((l) => l?.box);
    if (ls.length < 6) return false;
    const hs = ls.map((l) => Number(l.box.h) || 0).sort((a, b) => a - b);
    const hMed = hs[Math.floor(hs.length / 2)];
    const sameH = ls.filter((l) => Math.abs((Number(l.box.h) || 0) - hMed) <= 2).length;
    const leftX = ls.filter((l) => (Number(l.box.x) || 0) <= 8).length;
    const ys = ls.map((l) => Number(l.box.y) || 0).sort((a, b) => a - b);
    const deltas = [];
    for (let i = 1; i < ys.length; i++) deltas.push(ys[i] - ys[i - 1]);
    const dSorted = [...deltas].sort((a, b) => a - b);
    const dMed = dSorted[Math.floor(dSorted.length / 2)];
    const arithY = dMed > 0 && deltas.filter((d) => Math.abs(d - dMed) <= 4).length >= deltas.length * 0.6;
    // Two signatures: (a) uniform heights + left-pinned/arithmetic — the classic list dump;
    // (b) left-pinned + arithmetic-y even with VARIED heights (observed on ad 002: the model
    // invented plausible per-line heights but still walked x≈0, y+=38 — heights alone can't
    // clear a read whose positions are a counter).
    return ((sameH >= ls.length * 0.6) && (leftX >= ls.length * 0.6 || arithY))
      || (leftX >= ls.length * 0.7 && arithY);
  };
  if (degenerateCoords(best) && !isCanceled()) {
    progress('⚠ read returned fabricated list coordinates (uniform boxes, left-pinned/arithmetic y) — retrying as a scoped two-step read');
    const ts = await visionReadTwoStep(imagePath, { timeoutMs: perPass, purpose: 'layout-extract-degenerate-retry', progress, isCanceled, signal });
    if (ts.canceled) { cleanup(); return { ok: false, error: 'canceled', canceled: true }; }
    if (ts.raw && !degenerateCoords(ts.raw)) {
      best = ts.raw;
      bestScore = scoreRaw(best);
      progress(`degenerate-retry accepted: ${best.layers.length} layers (score ${bestScore.toFixed(1)})`);
    } else {
      progress('degenerate-retry did not improve localization — keeping the original read');
    }
  }

  // WEAK-TEXT RESCUE (copy-fidelity, ad 010): a read that SUCCEEDED but came back text-sparse on a
  // non-photo reference (few/short text layers on what is usually a text post) drops whole
  // paragraphs that no downstream stage can recover. Run the scoped two-step read and MERGE its
  // additions — costs extra vision calls only on weak reads.
  {
    const tl = (best.layers || []).filter((l) => (l?.type === 'text' || l?.type === 'badge' || l?.type === 'button') && String(l?.text || '').trim().length >= 4);
    const textChars = tl.reduce((s, l) => s + String(l.text).length, 0);
    const photoRef = String(best.backgroundKind || '').toLowerCase() === 'photo';
    if (!photoRef && tl.length < 6 && textChars < 260 && !isCanceled()) {
      progress(`read looks text-sparse (${tl.length} text layers, ${textChars} chars) — scoped re-read to recover missing copy`);
      const ts = await visionReadTwoStep(imagePath, { timeoutMs: perPass, purpose: 'layout-extract-rescue', progress, isCanceled, signal });
      if (ts.canceled) { cleanup(); return { ok: false, error: 'canceled', canceled: true }; }
      if (ts.raw) {
        const { merged, summary } = mergeRefined(best, ts.raw);
        const mergedScore = scoreRaw(merged);
        if (summary.added && mergedScore > bestScore) {
          progress(`rescue read recovered ${summary.added} layer(s) (score ${bestScore.toFixed(1)} → ${mergedScore.toFixed(1)})`);
          best = merged; bestScore = mergedScore;
        }
      }
    }
  }

  // PIXEL-BASED TEXT FALLBACK: when the vision extraction is text-sparse, run the deterministic
  // pixel contrast scan to find high-contrast regions the model missed. These regions have no text
  // content (pixel detection can't read characters), but their bounding boxes and colors are useful
  // for: (1) indicating "there's more text here" to the user, and (2) enriching the extraction
  // with regions the model silently dropped. Only runs when the vision read was text-sparse AND
  // the image is decodable. Zero model calls.
  {
    const tl = (best.layers || []).filter((l) => (l?.type === 'text' || l?.type === 'badge' || l?.type === 'button') && String(l?.text || '').trim().length >= 4);
    const textChars = tl.reduce((s, l) => s + String(l.text).length, 0);
    if (!isCanceled() && (tl.length < 4 || textChars < 180)) {
      progress('running pixel-based text region scan (OCR fallback)…');
      try {
        const pixelLayers = detectTextRegionsByPixels(imagePath, best.layers || []);
        if (pixelLayers.length) {
          progress(`pixel scan found ${pixelLayers.length} additional text region${pixelLayers.length === 1 ? '' : 's'} the vision model missed`);
          // Merge pixel-detected regions into the best extraction (append, dedup by overlap)
          const existing = best.layers || [];
          const novel = pixelLayers.filter((pl) => {
            return !existing.some((el) => {
              if (!el?.box) return false;
              const ex = Number(el.box.x) || 0, ey = Number(el.box.y) || 0;
              const ew = Number(el.box.w) || 0, eh = Number(el.box.h) || 0;
              const ix = Math.max(0, Math.min(pl.box.x + pl.box.w, ex + ew) - Math.max(pl.box.x, ex));
              const iy = Math.max(0, Math.min(pl.box.y + pl.box.h, ey + eh) - Math.max(pl.box.y, ey));
              return (ix * iy) / (pl.box.w * pl.box.h || 1) > 0.3;
            });
          });
          if (novel.length) {
            best.layers = [...existing, ...novel];
            bestScore = scoreRaw(best);
            progress(`merged ${novel.length} pixel-detected region(s) (score → ${bestScore.toFixed(1)})`);
          }
        }
      } catch (e) {
        progress(`pixel text scan failed (${e?.message || e}) — continuing without it`);
      }
    }
  }

  // FAST PATH: a strong first read (enough real layers, a recognized archetype, high score) needs
  // no refine — this is what turns the common case from ~4 min (5 sequential passes) into a single
  // ~60 s read. A weak read still gets ONE corrective pass.
  const firstStrong = best.layers.length >= 6 && bestScore >= 10 && best.archetype && best.archetype !== 'generic';
  const lastPass = firstStrong ? 1 : n;
  if (firstStrong && n >= 2) progress('first read is strong — skipping refinement');

  // ── FAN-OUT: deterministic image analysis (palette + border background) as CONCURRENT
  // sub-agents, kicked off HERE so they run in parallel with the vision refinement below. Both
  // workers need only `imagePath` (not the vision result), so they're genuinely independent — the
  // fitting orchestrator-worker decomposition. When onStep is wired, each worker streams a
  // `subagent` frame (start → done) sharing the unified vocabulary; the deterministic model label
  // reflects that these are local pixel passes, not ornith calls. Concurrency ≤3 (here 2). We only
  // AWAIT this after refinement, so the local passes overlap the (slow) vision refine round.
  const analysisModel = 'local·pixels';
  const analysisPromise = runFanOut({
    model: analysisModel, concurrency: 2, parentRunId: runId, onStep: onStep ? emitStep : undefined,
    subtasks: [
      {
        id: 'sa-palette', title: 'dominant palette',
        run: ({ update }) => {
          update('median-cut over the full image');
          try {
            const pal = extractDominantPalette(imagePath, 5).map((c) => ({ hex: c.hex, share: Number(c.share.toFixed(3)) }));
            update(pal.length ? `${pal.length} swatches` : 'no swatches');
            return { ok: true, palette: pal };
          } catch (e) { return { ok: false, error: String(e?.message || e), palette: [] }; }
        },
      },
      {
        id: 'sa-bg', title: 'background sampler',
        run: ({ update }) => {
          update('averaging the border frame');
          try {
            const sample = sampleBorderBackground(imagePath);
            update(sample ? `${sample.hex} (flatness ${sample.flatness.toFixed(3)})` : 'undecodable');
            return { ok: true, sample };
          } catch (e) { return { ok: false, error: String(e?.message || e), sample: null }; }
        },
      },
    ],
  });

  // ── Passes 2..N: REFINE against the prior best ──────────────────────────────────────────────
  for (let pass = 2; pass <= lastPass; pass++) {
    if (isCanceled()) { cleanup(); return { ok: false, error: 'canceled', canceled: true }; }
    progress(`refining — pass ${pass}/${n}…`);
    const priorJson = JSON.stringify({ archetype: best.archetype, backgroundKind: best.backgroundKind, background: best.background, layers: best.layers });
    const ref = await visionRead(REFINE_PROMPT(priorJson), imagePath, {
      timeoutMs: perPass, maxAttempts: RETRIES, purpose: 'layout-refine',
      label: `pass ${pass}`, progress, isCanceled, signal,
    });
    if (ref.canceled) { cleanup(); return { ok: false, error: 'canceled', canceled: true }; }
    if (!ref.raw) { progress(`pass ${pass}: no usable correction — keeping best`); break; }

    const { merged, summary } = mergeRefined(best, ref.raw);
    const mergedScore = scoreRaw(merged);
    const changed = summary.added || summary.dropped || summary.adjusted;
    progress(`pass ${pass}: +${summary.added} layers, ${summary.adjusted} boxes adjusted${summary.dropped ? `, kept ${summary.dropped} it dropped` : ''} (score ${mergedScore.toFixed(1)})`);
    if (mergedScore > bestScore) {
      best = merged; bestScore = mergedScore;
    } else if (!changed) {
      progress('refinement converged — stopping'); break;
    } else {
      // It changed things but didn't improve the score → stop; the read is stable.
      progress('no further improvement — stopping'); break;
    }
  }
  cleanup();

  // ── De-dupe: collapse the same product/text reported across passes into ONE (union outer edges) ─
  const beforeDedup = Array.isArray(best.layers) ? best.layers.length : 0;
  // PIXEL-COORDS NORMALIZER v2 (ads 026 + 002): the prompt asks for 0-100 percentages but the
  // model sometimes answers in PIXELS (x=540, w=980 …) — and with MULTI-PASS reads the two
  // passes can come back in DIFFERENT units (pass A percent, pass B pixels). The v1 normalizer
  // computed ONE global scale from the max edge and rescaled EVERYTHING — so when units were
  // mixed, the correct percent layers got crushed by the pixel layers' ~0.1x factor and the
  // whole design piled into the top-left corner (proven on ad 002: headline at x2=110 percent
  // × the pixel layers' 0.0975 scale = the observed 10%-wide headline). v2 classifies PER
  // LAYER: a box whose far edges both sit ≤110 is already percent and is left alone; only
  // boxes beyond that are treated as pixels and rescaled by the pixel-population's own extent.
  {
    const pix = [];
    let maxX = 0, maxY = 0;
    for (const l of (best.layers || [])) {
      const b = l?.box;
      if (!b) continue;
      const x2 = (Number(b.x) || 0) + (Number(b.w) || 0);
      const y2 = (Number(b.y) || 0) + (Number(b.h) || 0);
      if (!Number.isFinite(x2) || !Number.isFinite(y2)) continue;
      if (x2 > 110 || y2 > 110) {
        pix.push(l);
        maxX = Math.max(maxX, x2);
        maxY = Math.max(maxY, y2);
      }
    }
    if (pix.length && (maxX > 130 || maxY > 130)) {
      const sx = 100 / Math.max(100, maxX);
      const sy = 100 / Math.max(100, maxY);
      const sf = Math.min(sx, sy); // font sizes scale with the tighter axis
      for (const l of pix) {
        const b = l.box;
        if (Number.isFinite(Number(b.x))) b.x = Number(b.x) * sx;
        if (Number.isFinite(Number(b.w))) b.w = Number(b.w) * sx;
        if (Number.isFinite(Number(b.y))) b.y = Number(b.y) * sy;
        if (Number.isFinite(Number(b.h))) b.h = Number(b.h) * sy;
        const st = l?.style;
        if (st && Number.isFinite(Number(st.fontSizePct)) && Number(st.fontSizePct) > 15) {
          st.fontSizePct = Number(st.fontSizePct) * sf;
        }
      }
      progress(`⚠ ${pix.length} of ${(best.layers || []).length} boxes answered in pixels — rescaled those (max edge ${Math.round(Math.max(maxX, maxY))} → 100%); percent boxes untouched`);
    }
  }
  const dd = dedupeRawLayers(best.layers);
  best.layers = dd.layers;
  if (dd.removed) progress(`merged ${dd.removed} duplicate region${dd.removed === 1 ? '' : 's'} → ${best.layers.length} unique (from ${beforeDedup})`);

  // CONTENT DEDUPE (ad 052): multi-pass reads re-report the same copy in FRAGMENTS at slightly
  // different boxes ("No need to ruin" / "no need to ruin your hair to have perfect curls" piles
  // of garbled text). Geometry dedupe can't see it — compare normalized WORDS instead: a text
  // layer whose word set is contained in (or ≥70% shared with) a LONGER retained layer's is a
  // re-read fragment, not a design element. Keep the most complete read.
  {
    const norm = (t) => String(t || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
    const texts = (best.layers || []).filter((l) => (l?.type === 'text' || l?.type === 'badge' || l?.type === 'button') && String(l?.text || '').trim().length >= 8);
    const drop = new Set();
    for (const a of texts) {
      if (drop.has(a)) continue;
      const wa = norm(a.text);
      if (wa.length < 2) continue;
      for (const b of texts) {
        if (a === b || drop.has(b)) continue;
        const wb = norm(b.text);
        if (wb.length < 2 || wb.length > wa.length) continue;
        const setA = new Set(wa);
        const shared = wb.filter((w) => setA.has(w)).length;
        if (shared / wb.length >= 0.7) drop.add(b); // b is a fragment/duplicate of a
      }
    }
    if (drop.size) {
      best.layers = best.layers.filter((l) => !drop.has(l));
      progress(`dropped ${drop.size} duplicate text fragment${drop.size === 1 ? '' : 's'} (content dedupe)`);
    }
  }

  // IN-PHOTO LABEL TEXT FILTER (ad 002): despite the prompt rule, the model still sometimes
  // transcribes text printed ON the products in a photo (packaging brand names, ingredient
  // lists, nutrition small-print) as design layers — a supplement-bundle ad came back with ~15
  // junk text layers read off the jars' labels. Deterministic backstop: a SMALL text layer whose
  // box sits ≥60% inside a photo/product region belongs to the photo (it ships with the crop) —
  // drop it. Designer overlays ON photos are kept: big type (fontSizePct ≥ 3.2) and overlay-ish
  // roles (headline/price/cta/badge/button) are exempt.
  {
    const photoRegions = (best.layers || []).filter((l) => {
      if (!l?.box) return false;
      const role = String(l.role || '').toLowerCase();
      const area = (Number(l.box.w) || 0) * (Number(l.box.h) || 0);
      return (l.type === 'image' || (l.type === 'shape' && /product|photo|avatar|logo|packshot/.test(role))) && area >= 400; // ≥ ~4% of a 100x100 pct space
    });
    // Content signature of PACKAGING text — nutrition/ingredient vocabulary (NL+EN) and
    // pack-size descriptors. Position-independent: when the model enumerates label lines it
    // often FABRICATES their boxes (ad 002), so containment alone can't catch them.
    const NUTRITION_RE = /(ingredi[eë]nt|voedingswaarde|nutrition|\bkcal\b|\bkJ\b|\bmg\b|monohydraat|monohydrate|sucralose|emulgator|verdikkingsmiddel|zoetstof|\bper\s?\d+\s?g\b|\bca\.\s?\d+\s?scoops?\b)/i;
    const PACK_SIZE_RE = /\b(smaak|flavou?r)\b|\b\d+(\.\d+)?\s?(kg|g|ml|oz)\b\s*$/i;
    const nutritionHits = (t) => (String(t).match(new RegExp(NUTRITION_RE.source, 'gi')) || []).length;
    {
      const OVERLAY_ROLES = /headline|price|cta|badge|button|offer/i;
      const dropped = [];
      best.layers = (best.layers || []).filter((l) => {
        if (l?.type !== 'text' || !l?.box) return true;
        const text = String(l.text || '');
        // (a0) EMPTY text is pure geometry pollution — nothing renders, but the box overlaps
        // real layers and dirties the Figma import (observed: an empty text spanning 68% of the
        // canvas on ad 052).
        if (!text.trim()) { dropped.push(l); return false; }
        // (a1) PRODUCT-DESCRIPTOR captions ("CURL CRÈME TUBE", "CREATINE JAR") are the model
        // NAMING a product region, not design copy — when any photo region exists they duplicate
        // what the cutout already shows, usually at fabricated coordinates.
        if (photoRegions.length && /^[\p{Lu}0-9 &'’.\-]{3,40}\s(TUBE|JAR|POUCH|BAG|TUB|BOTTLE|CAN|PACK|PACKSHOT)$/u.test(text.trim())) { dropped.push(l); return false; }
        // (a) CONTENT: unmistakable nutrition/ingredient copy is packaging regardless of role/box
        if (nutritionHits(text) >= 2 || (nutritionHits(text) >= 1 && text.length > 60)) { dropped.push(l); return false; }
        if (OVERLAY_ROLES.test(String(l.role || ''))) return true;
        if ((Number(l.style?.fontSizePct) || 0) >= 3.2) return true;
        // (b) pack-size caption ("VANILLE SMAAK 1kg", "CITRUS SMAAK 350g") when a photo region exists
        if (photoRegions.length && PACK_SIZE_RE.test(text.trim())) { dropped.push(l); return false; }
        // (c) GEOMETRY: small text ≥60% inside a photo/product region ships with the crop
        const bx = Number(l.box.x) || 0, by = Number(l.box.y) || 0;
        const bw = Number(l.box.w) || 0, bh = Number(l.box.h) || 0;
        const area = bw * bh;
        if (!area) return true;
        for (const p of photoRegions) {
          const px = Number(p.box.x) || 0, py = Number(p.box.y) || 0;
          const pw = Number(p.box.w) || 0, ph = Number(p.box.h) || 0;
          const ix = Math.max(0, Math.min(bx + bw, px + pw) - Math.max(bx, px));
          const iy = Math.max(0, Math.min(by + bh, py + ph) - Math.max(by, py));
          if ((ix * iy) / area >= 0.6) { dropped.push(l); return false; }
        }
        return true;
      });
      if (dropped.length) progress(`dropped ${dropped.length} packaging-text layer${dropped.length === 1 ? '' : 's'} (label copy ships with the photo, not as layers)`);
    }
  }

  // TEXT-PILE PRUNER (ad 002): when a read partially degenerates, a SUBSET of text layers comes
  // back with fabricated near-identical boxes — 3+ texts stacked on one spot. Real designs never
  // do that. Cluster mutually-overlapping (≥40% of the smaller box) text layers; a cluster of ≥3
  // keeps only its largest-area member. Losing a line hurts less than shipping a garbled pile,
  // and the copy self-check can still correct surviving text against the reference.
  {
    const texts = (best.layers || []).filter((l) => l?.type === 'text' && l.box);
    const over = (A, B) => {
      const ix = Math.max(0, Math.min(A.x + A.w, B.x + B.w) - Math.max(A.x, B.x));
      const iy = Math.max(0, Math.min(A.y + A.h, B.y + B.h) - Math.max(A.y, B.y));
      return (ix * iy) / (Math.min(A.w * A.h, B.w * B.h) || 1) >= 0.4;
    };
    const clusterOf = new Map();
    for (const t of texts) {
      const box = { x: +t.box.x || 0, y: +t.box.y || 0, w: +t.box.w || 0, h: +t.box.h || 0 };
      let placed = null;
      for (const [seed, members] of clusterOf) {
        if (over(box, seed)) { members.push(t); placed = seed; break; }
      }
      if (!placed) clusterOf.set(box, [t]);
    }
    const drop = new Set();
    for (const members of clusterOf.values()) {
      if (members.length < 3) continue;
      const keep = members.reduce((a, b) => ((+a.box.w * +a.box.h) >= (+b.box.w * +b.box.h) ? a : b));
      for (const m of members) if (m !== keep) drop.add(m);
    }
    if (drop.size) {
      best.layers = best.layers.filter((l) => !drop.has(l));
      progress(`pruned ${drop.size} stacked text layer${drop.size === 1 ? '' : 's'} (pile of fabricated boxes — kept the dominant line per spot)`);
    }
  }

  // PIXEL-SNAP ORACLE (ad 002, the "full fixup"): the model's WORDS are reliable but its BOXES
  // sometimes aren't — partial degenerate reads give a subset of text layers fabricated
  // coordinates (tiny boxes crammed top-left) that no retry is guaranteed to fix. The pixels
  // don't lie: run the deterministic contrast-based text-region scan (zero model calls) and use
  // it as a BOX ORACLE — a text layer whose box is physically too small for its content gets
  // SNAPPED onto the best unclaimed pixel region in reading order. Gated conservatively: only
  // fires when there are ≥2 suspects AND enough unclaimed regions, and each pairing must be
  // size-plausible; a clean read has zero suspects and is untouched.
  {
    const texts = (best.layers || []).filter((l) => l?.type === 'text' && l.box && String(l.text || '').trim());
    const expectedW = (l) => {
      const fs = Number(l.style?.fontSizePct) || 3;
      const chars = String(l.text).trim().length;
      return Math.min(96, chars * fs * 0.55); // % of width, single-line estimate
    };
    const suspects = texts.filter((l) => {
      const bw = Number(l.box.w) || 0;
      const bh = Number(l.box.h) || 0;
      const ew = expectedW(l);
      // box too narrow for even a 3-line wrap of the content, or degenerate sliver
      return bw > 0 && (ew / bw > 2.5 || (bw < 12 && String(l.text).trim().length > 14) || bh < 1);
    });
    if (suspects.length >= 2) {
      try {
        const img = decodeImage(imagePath);
        if (img) {
          const merged = mergeTextRegions(findTextRegions(localContrastMap(img), img.width, img.height))
            .filter((r) => r.w >= TEXT_REGION_MIN_W_PCT && r.h >= TEXT_REGION_MIN_H_PCT);
          const wellPlaced = texts.filter((l) => !suspects.includes(l));
          const unclaimed = merged.filter((r) => !wellPlaced.some((l) => {
            const bx = Number(l.box.x) || 0, by = Number(l.box.y) || 0;
            const bw = Number(l.box.w) || 0, bh = Number(l.box.h) || 0;
            const ix = Math.max(0, Math.min(r.x + r.w, bx + bw) - Math.max(r.x, bx));
            const iy = Math.max(0, Math.min(r.y + r.h, by + bh) - Math.max(r.y, by));
            return r.w * r.h > 0 && (ix * iy) / (r.w * r.h) > 0.5;
          })).sort((a, b) => a.y - b.y || a.x - b.x);
          if (unclaimed.length >= 2) {
            // reading order on both sides; greedy 1:1 with a size-plausibility check per pair
            const orderedSuspects = [...suspects].sort((a, b) => (Number(a.box.y) || 0) - (Number(b.box.y) || 0) || (Number(a.box.x) || 0) - (Number(b.box.x) || 0));
            let snapped = 0;
            const taken = new Set();
            for (const s of orderedSuspects) {
              const ew = expectedW(s);
              let bestR = null, bestScore = Infinity;
              for (const r of unclaimed) {
                if (taken.has(r)) continue;
                // fontSizePct on a fabricated layer is itself unreliable — accept any pairing
                // where the region could hold the text within a 3-line wrap at the region's own
                // implied font size, and rank by width plausibility.
                const impliedFs = Math.max(1.5, r.h * 0.7);
                const fitLines = (String(s.text).trim().length * impliedFs * 0.55) / Math.max(1, r.w);
                if (fitLines > 3.5) continue; // text can't fit this region even at 3 lines
                const sizeRatio = ew > 0 ? Math.max(r.w / ew, ew / r.w) : 99;
                if (sizeRatio > 6) continue; // wildly implausible pairing
                const score = sizeRatio + r.y / 100; // prefer plausible size, then top-most
                if (score < bestScore) { bestScore = score; bestR = r; }
              }
              if (!bestR) continue;
              taken.add(bestR);
              s.box = { x: bestR.x, y: bestR.y, w: bestR.w, h: bestR.h };
              if (s.style && Number(s.style.fontSizePct) > bestR.h) s.style.fontSizePct = Math.max(1.5, bestR.h * 0.7);
              snapped++;
            }
            if (snapped) progress(`pixel-snap: relocated ${snapped} text layer${snapped === 1 ? '' : 's'} with fabricated boxes onto real pixel text regions`);
          }
        }
      } catch { /* oracle is best-effort — a failed scan changes nothing */ }
    }
  }

  // CARD-CONTAINMENT RECONCILIATION (ad 002): the model often reads a big content CARD's top
  // edge too low while reading the text ON the card roughly right — the header stack then
  // renders on the page background above the card instead of inside it. When ≥3 text layers sit
  // horizontally within a large card's span but vertically ABOVE its top by a plausible margin,
  // the card's top edge is the lie: extend it up to contain them (geometry-only; never moves
  // text, so a correct read is untouched).
  {
    const layersArr = best.layers || [];
    const cards = layersArr.filter((l) => l?.type === 'shape' && l.box
      && /card|panel|background/i.test(String(l.role || ''))
      && (Number(l.box.w) || 0) * (Number(l.box.h) || 0) >= 2500); // ≥25% of the 100×100 space
    for (const card of cards) {
      const cx0 = Number(card.box.x) || 0;
      const cx1 = cx0 + (Number(card.box.w) || 0);
      const cy0 = Number(card.box.y) || 0;
      const above = layersArr.filter((l) => {
        if (l?.type !== 'text' || !l.box) return false;
        const tcx = (Number(l.box.x) || 0) + (Number(l.box.w) || 0) / 2;
        const ty1 = (Number(l.box.y) || 0) + (Number(l.box.h) || 0);
        return tcx >= cx0 && tcx <= cx1 && ty1 <= cy0 + 2 && (cy0 - (Number(l.box.y) || 0)) <= 35;
      });
      if (above.length >= 3) {
        const minY = Math.min(...above.map((l) => Number(l.box.y) || 0));
        const newY = Math.max(0, minY - 3);
        card.box.h = (Number(card.box.h) || 0) + (cy0 - newY);
        card.box.y = newY;
        progress(`card top extended ${Math.round(cy0 - newY)}% to contain the ${above.length} header text layers sitting above it (model read the card edge low)`);
      }
    }
  }

  const trueRatio = imageRatio(imagePath);
  const ratio = trueRatio || Math.max(0.5, Math.min(2.6, Number(best.canvasRatio) || 1));
  const canvas = { w: CANON_W, h: Math.round(CANON_W * ratio) };
  if (trueRatio) progress(`canvas locked to reference aspect ${Math.round(CANON_W)}x${Math.round(CANON_W * ratio)}`);
  // Archetype: reconcile the model's guess with deterministic chrome-signal detection so an obvious
  // preset (x-post, apple-notes, …) is recognized even when the small VL model punts to generic.
  const archetype = resolveArchetype(best.archetype, best, progress);
  const det = detectArchetypeFromLayers(best);

  // Abort gate for the TAIL phases (RUN-8): the legacy registry entry is already cleaned up above,
  // but the caller's AbortSignal outlives it — a Stop/delete arriving during dedupe/self-check must
  // still land instead of running another whole vision round on a doc nobody wants.
  if (isCanceled()) return { ok: false, error: 'canceled', canceled: true };

  // ── GATHER the concurrent analysis sub-agents (palette + border background) launched above.
  // They overlapped the vision refinement, so awaiting here is usually instantaneous.
  const analysis = await analysisPromise;
  const paletteResult = analysis.results.find((r) => r && Array.isArray(r.palette)) || { palette: [] };
  const bgResult = analysis.results.find((r) => r && 'sample' in r) || {};

  // ── Background: model report, then RECONCILE against deterministic border pixels (FIX 1) ─────
  // Reuse the fan-out worker's border sample + palette so we don't re-decode the image.
  const { background, isPhoto: backgroundIsPhoto, confidence: backgroundConfidence } = resolveBackground(
    best.background, imagePath, progress, best.backgroundKind,
    { sample: bgResult.sample, palette: paletteResult.palette },
  );

  // LIGHT / DARK theme this reference implies — from the resolved background luminance (a photo
  // reference with no flat fill falls back to the sampled border tone). Downstream picks the
  // matching neutral base + text tokens instead of a single hardcoded color.
  const theme = themeFromBackground(background, bgResult.sample ? bgResult.sample.lum : undefined);

  // ── DOMINANT PALETTE: top 3-5 colors over the FULL image (median-cut), additive field for
  // downstream consumers (accent/product/brand color picking) — never affects layers/background.
  const dominantPalette = Array.isArray(paletteResult.palette) ? paletteResult.palette : [];
  if (dominantPalette.length) progress(`palette: ${dominantPalette.map((c) => `${c.hex} (${Math.round(c.share * 100)}%)`).join(', ')}`);

  // ── SELF-CHECK GATE ──────────────────────────────────────────────────────────────────────────
  // Decide ONCE whether to run the render-and-compare verification pass. Vision is guaranteed
  // available here (we passed the noVision guard on pass 1). Run it when the operator opts in
  // (selfCheck:true option, or SELFCHECK/EXTRACT_SELFCHECK env), OR — by default — only when the
  // first read WASN'T already strong (a weak read is the one worth double-checking; a strong read
  // stays fast). selfCheck:false hard-disables it (keeps the text-only path unchanged). Capped at
  // ONE compare+correct round downstream; never breaks extraction.
  const envSelfCheck = /^(1|true|on|yes)$/i.test(String(process.env.SELFCHECK || process.env.EXTRACT_SELFCHECK || ''));
  const runSelfCheck = isCanceled() ? false // an aborted run never spends another vision round
    : selfCheck === false ? false
    : (selfCheck === true || envSelfCheck) ? true
    : !firstStrong; // default: verify only the weaker reads
  const selfCheckCtx = { referencePath: imagePath, background, backgroundIsPhoto, progress, isCanceled };

  // ── DETECTION → PRESET FILL ─────────────────────────────────────────────────────────────────
  // When the archetype is a KNOWN preset AND we're reasonably confident (a strong deterministic
  // chrome signal, OR the vision model itself named this same non-generic archetype), map the
  // detected copy/regions onto the template's param slots and BUILD the composed 1:1 preset —
  // grouped, on-format — instead of loose boxes. Unmapped slots keep the template's defaults.
  if (archetype !== 'generic' && ARCHETYPE_TO_TEMPLATE[archetype]) {
    const confident = (det.strong && det.archetype === archetype) || best.archetype === archetype;
    // FAMILY GATE: editorial-layout archetypes (before-after, comparison, offer-hero, stat-chart)
    // are DESIGN PATTERNS whose actual arrangement varies enormously per ad — a comparison ad can
    // be side-by-side photos+checklists, stacked cards, a slider, with or without a product shot.
    // Forcing every one into ONE canonical template is exactly the "applies presets when it
    // shouldn't" bug (proven on ad 026: a real product photo became a flat teal slab and the
    // model hallucinated unrelated copy to fill the template's fixed OURS/THEIRS card shape).
    // native-chrome archetypes (imessage/x-post/ig-*/apple-notes/...) are the OPPOSITE: the
    // platform's chrome is genuinely fixed, so snapping is correct there. Hard-exclude editorial
    // families from ever snapping, regardless of geometry score — geometry distance can't detect
    // "the CONTENT was replaced to fit the slots", only "the boxes are roughly where expected".
    const family = templateFamily(ARCHETYPE_TO_TEMPLATE[archetype]);
    if (confident && family === 'editorial-layout') {
      progress(`detected ${archetype} (editorial layout — arrangement varies per ad) — never snapping to the template; keeping the reference's true geometry (loose layers, platform-styled)`);
    }
    if (confident && family !== 'editorial-layout') {
      const filled = fillPresetFromExtraction(archetype, best, canvas, null);
      // GEOMETRY GATE (coordinator FIX 1): only SNAP to the preset when the reference's actual
      // arrangement matches the template's canonical slots. Native ads are elements REARRANGED — if
      // the reference places its content differently from the template, snapping would relocate it
      // (the "applies presets when it shouldn't" complaint). On a mismatch we fall through to the
      // loose-layer path, which keeps the reference's TRUE geometry (and still styles text with the
      // platform-accurate font tokens the model read per layer).
      const geoMatch = filled ? presetGeometryMatch(best, filled.layers, canvas) : { match: false, meanDist: null };
      if (filled && filled.layers.length && geoMatch.match) {
        const mapped = Object.keys(filled.params);
        progress(`detected ${archetype} → layout matches ${filled.templateId} preset${geoMatch.meanDist != null ? ` (drift ${geoMatch.meanDist.toFixed(3)})` : ''} → filling it (${mapped.length ? 'mapped ' + mapped.join(', ') : 'template defaults'} · ${filled.layers.length} groups)`);
        let presetLayers = filled.layers;
        let selfCheckResult = null;
        if (runSelfCheck) {
          const sc = await iterativeSelfCheck(presetLayers, canvas, selfCheckCtx);
          presetLayers = sc.layers;
          selfCheckResult = { matched: sc.matched, score: sc.score ?? null, corrections: [], applied: sc.correctionsApplied, iterations: sc.iterations, totalCorrections: sc.totalCorrections };
        }
        progress(`done · ${presetLayers.length} layers · ${archetype} (preset)${backgroundIsPhoto ? ' · bg photo (full-bleed)' : background ? ' · bg ' + (typeof background === 'string' ? background : 'gradient') : ''} · ${theme}`);
        return { ok: true, layers: presetLayers, canvas, archetype, background, backgroundIsPhoto, backgroundConfidence, theme, dominantPalette, selfCheck: selfCheckResult, error: null, passes: n };
      }
      if (filled && filled.layers.length && !geoMatch.match) {
        progress(`detected ${archetype} but the reference's layout diverges from the preset${geoMatch.meanDist != null ? ` (drift ${geoMatch.meanDist.toFixed(3)} > 0.14)` : ''} — keeping the reference's true geometry (loose layers, platform-styled)`);
      } else {
        progress(`preset fill for ${archetype} produced nothing — falling back to grouped loose layers`);
      }
    }
  }

  // ── LOOSE-LAYER PATH (generic / low-confidence): skeleton boxes, GROUPED into region groups ──
  const repairLog = [];
  let cutoutMarked = 0;
  const flat = toSkeletonLayers(best, canvas, repairLog, {
    imagePath, onCutout: (n) => { cutoutMarked = n; },
  });
  if (repairLog.length) progress(`⚠ ${repairLog.length} layer${repairLog.length === 1 ? '' : 's'} auto-repaired (missing box fields): ${repairLog.slice(0, 3).map((r) => `${r.layer}[${r.fields.join(',')}]`).join(' · ')}`);
  if (cutoutMarked) progress(`${cutoutMarked} region${cutoutMarked === 1 ? '' : 's'} marked for cut-out from the reference`);
  if (!flat.length) { progress('failed: extraction found no design layers'); return { ok: false, error: 'extraction found no design layers' }; }
  // GEOMETRY SANITY: clamp on-canvas and separate overlapping text before grouping so the tree isn't
  // a pile of stacked/off-canvas boxes.
  const geo = sanitizeGeometry(flat, canvas);
  if (geo.fixed) progress(`geometry: separated ${geo.fixed} overlapping text box${geo.fixed === 1 ? '' : 'es'}`);
  let layers = groupLooseLayers(flat, canvas.h);

  let selfCheckResult = null;
  if (runSelfCheck) {
    const sc = await iterativeSelfCheck(layers, canvas, selfCheckCtx);
    layers = sc.layers;
    selfCheckResult = { matched: sc.matched, score: sc.score ?? null, corrections: [], applied: sc.correctionsApplied, iterations: sc.iterations, totalCorrections: sc.totalCorrections };
  }

  progress(`done · ${flat.length} layers · ${archetype}${backgroundIsPhoto ? ' · bg photo (full-bleed)' : background ? ' · bg ' + (typeof background === 'string' ? background : 'gradient') : ''} · ${theme}`);
  return { ok: true, layers, canvas, archetype, background, backgroundIsPhoto, backgroundConfidence, theme, dominantPalette, selfCheck: selfCheckResult, error: null, passes: n };
}

// ── PIXEL-BASED TEXT REGION DETECTION (OCR fallback) ───────────────────────────────────────────
// When the vision model misses text or returns no text layers, a deterministic pixel scan finds
// high-contrast edge regions that are likely text. This catches headlines, CTAs, and labels
// that the model silently dropped. Pure JS — reuses decodeImage for raw pixel access.
//
// Algorithm:
// 1. Compute a downsampled local-contrast map: for each pixel, the max luminance difference
//    in a small neighborhood (e.g. 5x5). High contrast = likely a glyph edge.
// 2. Binarize: pixels above a threshold become "text-edge candidates".
// 3. Run a simple connected-component pass (flood-fill on the downsampled grid) to merge
//    nearby edge pixels into rectangular regions.
// 4. Filter: regions must be at least 3% wide, 1.5% tall (to avoid noise), and have a
//    reasonable aspect ratio (text is wider than tall, or roughly square for single chars).
// 5. Estimate text color: sample the minority luminance cluster inside each region (same
//    logic as sampleGlyphColor — glyphs are the minority ink against a fill).

const CONTRAST_NEIGHBORHOOD = 5; // half-size of the local contrast kernel
const CONTRAST_THRESHOLD = 0.18; // minimum local luminance difference to qualify as text edge
const TEXT_REGION_MIN_W_PCT = 3;  // minimum region width as % of image width
const TEXT_REGION_MIN_H_PCT = 1.2; // minimum region height as % of image height
const TEXT_REGION_MAX_ASPECT = 12; // max width/height ratio (very long lines are OK)
const TEXT_GRID_STEP = 3;         // downsample step for the contrast scan (every Nth pixel)

/**
 * Compute a downsampled local-contrast map. Returns { w, h, data } where data is a Float64Array
 * of local contrast values (0..1) at the downsampled resolution. Higher = more edge activity.
 */
function localContrastMap(img) {
  const { width: w, height: h, channels: ch, data } = img;
  const step = TEXT_GRID_STEP;
  const gw = Math.ceil(w / step);
  const gh = Math.ceil(h / step);

  // Pre-compute a downsampled luminance grid (1x per step block, area-averaged)
  const lum = new Float64Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      let sum = 0, n = 0;
      const y0 = gy * step, x0 = gx * step;
      const y1 = Math.min(y0 + step, h), x1 = Math.min(x0 + step, w);
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const p = (y * w + x) * ch;
          const a = ch === 4 ? data[p + 3] : 255;
          if (a < 32) continue;
          sum += relLum(data[p], data[p + 1], data[p + 2]);
          n++;
        }
      }
      lum[gy * gw + gx] = n > 0 ? sum / n : 0.5;
    }
  }

  // Compute local contrast: max |lum[i] - lum[j]| in a neighborhood
  const nh = Math.min(CONTRAST_NEIGHBORHOOD, Math.floor(Math.min(gw, gh) / 2));
  if (nh < 1) return { w: gw, h: gh, data: new Float64Array(gw * gh) };
  const contrast = new Float64Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const center = lum[gy * gw + gx];
      let maxDiff = 0;
      for (let dy = -nh; dy <= nh; dy++) {
        const ny = gy + dy;
        if (ny < 0 || ny >= gh) continue;
        for (let dx = -nh; dx <= nh; dx++) {
          const nx = gx + dx;
          if (nx < 0 || nx >= gw) continue;
          const d = Math.abs(lum[ny * gw + nx] - center);
          if (d > maxDiff) maxDiff = d;
        }
      }
      contrast[gy * gw + gx] = maxDiff;
    }
  }
  return { w: gw, h: gh, data: contrast };
}

/**
 * Binarize + flood-fill to find connected components of high-contrast pixels.
 * Returns an array of bounding boxes in percentage space {x, y, w, h} (0..100).
 */
function findTextRegions(contrastMap, imgW, imgH) {
  const { w: gw, h: gh, data } = contrastMap;
  if (gw < 2 || gh < 2) return [];

  // Binarize
  const visited = new Uint8Array(gw * gh);
  const bins = new Uint8Array(gw * gh);
  for (let i = 0; i < data.length; i++) bins[i] = data[i] >= CONTRAST_THRESHOLD ? 1 : 0;

  const regions = [];
  const step = TEXT_GRID_STEP;

  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const idx = gy * gw + gx;
      if (!bins[idx] || visited[idx]) continue;

      // Flood-fill to find the connected component
      let minX = gx, maxX = gx, minY = gy, maxY = gy, count = 0;
      const stack = [gx, gy];
      visited[idx] = 1;

      while (stack.length) {
        const x = stack.pop();
        const y = stack.pop();
        count++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;

        // 4-connectivity neighbors
        const neighbors = [
          [x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1],
        ];
        for (const [nx, ny] of neighbors) {
          if (nx < 0 || nx >= gw || ny < 0 || ny >= gh) continue;
          const ni = ny * gw + nx;
          if (bins[ni] && !visited[ni]) {
            visited[ni] = 1;
            stack.push(nx, ny);
          }
        }
      }

      if (count < 3) continue; // too small — noise

      // Convert to percentage space
      const px = (minX * step / imgW) * 100;
      const py = (minY * step / imgH) * 100;
      const pw = ((maxX - minX + 1) * step / imgW) * 100;
      const ph = ((maxY - minY + 1) * step / imgH) * 100;

      // Filter: must meet minimum size and reasonable aspect ratio
      if (pw < TEXT_REGION_MIN_W_PCT || ph < TEXT_REGION_MIN_H_PCT) continue;
      const aspect = pw / Math.max(0.1, ph);
      if (aspect > TEXT_REGION_MAX_ASPECT || aspect < 0.1) continue;

      regions.push({ x: px, y: py, w: pw, h: ph, pixelCount: count });
    }
  }

  // Sort by pixel count (largest = most likely real text)
  regions.sort((a, b) => b.pixelCount - a.pixelCount);

  return regions;
}

/**
 * Merge overlapping/adjacent text regions. Two regions are merged when they overlap or are
 * within 2% of each other (a split character or tight kerning). Returns a deduplicated list.
 */
function mergeTextRegions(regions) {
  if (!regions.length) return [];
  const merged = [...regions];
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < merged.length; i++) {
      for (let j = i + 1; j < merged.length; j++) {
        const a = merged[i], b = merged[j];
        // Check overlap or proximity (2% gap tolerance)
        const overlapX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const overlapY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        const gapX = Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w));
        const gapY = Math.max(0, Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h));

        if ((overlapX > 0 && overlapY > 0) || (gapX <= 2 && overlapY > 0) || (overlapX > 0 && gapY <= 2)) {
          // Merge: union box
          const nx = Math.min(a.x, b.x);
          const ny = Math.min(a.y, b.y);
          merged[i] = {
            x: nx, y: ny,
            w: Math.max(a.x + a.w, b.x + b.w) - nx,
            h: Math.max(a.y + a.h, b.y + b.h) - ny,
            pixelCount: a.pixelCount + b.pixelCount,
          };
          merged.splice(j, 1);
          changed = true;
          break;
        }
      }
      if (changed) break;
    }
  }
  return merged;
}

/**
 * Deterministic pixel-based text region detection: finds high-contrast edge regions that the
 * vision model likely missed, and produces skeleton-style layer descriptors for each. This is
 * the OCR fallback — no model calls, pure pixel analysis.
 *
 * Returns an array of raw extraction layers (same schema as the vision model output):
 *   { type:'text', role:'caption', text:'', box:{x,y,w,h}, style:{color,fontSizePct} }
 *
 * The text content is LEFT EMPTY (pixel detection can't read characters), but the bounding
 * boxes and colors are provided so downstream can:
 * 1. Flag these as "detected but unreadable" regions for the user
 * 2. Use the boxes for gap detection (if the vision model missed a region, the gap tells it
 *    where to look on a re-read)
 *
 * `existingLayers` is the current extraction's raw layers — we skip regions that already
 * overlap existing ones (the model already found them).
 */
export function detectTextRegionsByPixels(imagePath, existingLayers = []) {
  try {
    const img = decodeImage(imagePath);
    if (!img) return [];

    const { width: imgW, height: imgH } = img;
    if (imgW < 20 || imgH < 20) return [];

    const contrastMap = localContrastMap(img);
    const rawRegions = findTextRegions(contrastMap, imgW, imgH);
    const merged = mergeTextRegions(rawRegions);

    const layers = [];
    for (const region of merged) {
      // Skip regions too small to be meaningful text
      if (region.w < TEXT_REGION_MIN_W_PCT || region.h < TEXT_REGION_MIN_H_PCT) continue;

      // Skip regions that overlap significantly with existing vision-extracted layers
      const overlapsExisting = existingLayers.some((l) => {
        if (!l || !l.box) return false;
        const b = l.box;
        // existing layers are in % space (raw extraction)
        const bx = Number(b.x) || 0, by = Number(b.y) || 0;
        const bw = Number(b.w) || 0, bh = Number(b.h) || 0;
        const ix = Math.max(0, Math.min(region.x + region.w, bx + bw) - Math.max(region.x, bx));
        const iy = Math.max(0, Math.min(region.y + region.h, by + bh) - Math.max(region.y, by));
        const interArea = ix * iy;
        const regionArea = region.w * region.h;
        return regionArea > 0 && (interArea / regionArea) > 0.5;
      });
      if (overlapsExisting) continue;

      // Estimate text color from the region's pixels
      const color = sampleGlyphColor(imagePath, { x: region.x, y: region.y, w: region.w, h: region.h }, img);

      // Estimate font size from region height (rough: cap height ≈ 70% of region height)
      const fontSizePct = Math.max(1.5, region.h * 0.7);

      layers.push({
        type: 'text',
        role: 'caption',
        text: '', // pixel detection can't read characters
        box: { x: region.x, y: region.y, w: region.w, h: region.h },
        style: {
          color: color || '#000000',
          fontSizePct: Math.round(fontSizePct * 10) / 10,
          fontWeight: 400,
          align: 'left',
        },
        _source: 'pixel-detect', // tag so downstream knows this is a pixel-detected region
      });
    }

    return layers.slice(0, 8); // cap at 8 pixel-detected regions to avoid noise
  } catch {
    return [];
  }
}

// ── describeImage (v3 agent attachments) ─────────────────────────────────────────────────────────

const DESC_PROMPT = 'You are a senior ad designer. Describe the attached image in EXACTLY 2 sentences: what it shows and what makes it useful as a design reference (palette, composition, mood). Plain text only, no lists, no preamble.';

/** Pull the agent's final plain-text message out of codex --json JSONL output. */
function extractPlainText(out) {
  let text = null;
  for (const line of String(out).split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    let obj;
    try { obj = JSON.parse(t); } catch { continue; }
    const kind = obj?.item?.type || obj?.msg?.type || obj?.type || '';
    const c = obj?.item?.text ?? obj?.msg?.message ?? (typeof obj?.text === 'string' ? obj.text : null);
    if (typeof c === 'string' && c.trim() && /agent|assistant|message/i.test(String(kind))) text = c;
  }
  return text ? text.trim() : null;
}

/**
 * 2-sentence designer description of an image via codex vision, cached at
 * .state/refs/{cacheId}.desc.txt so each reference is described at most once.
 * Returns { ok, text, error, cached? }. Never throws.
 */
export async function describeImage(imagePath, { cacheId = null, timeoutMs = 60_000 } = {}) {
  const refsDir = join(STUDIO_DIR, '.state', 'refs');
  const cacheFile = cacheId ? join(refsDir, `${String(cacheId).replace(/[^\w-]+/g, '-')}.desc.txt`) : null;
  if (cacheFile && existsSync(cacheFile)) {
    try {
      const text = readFileSync(cacheFile, 'utf8').trim();
      if (text) return { ok: true, text, error: null, cached: true };
    } catch { /* fall through to a fresh call */ }
  }
  // ONLY the configured vision endpoint (LM Studio) — codex-vision fallback removed entirely.
  const vr = await llmVision(DESC_PROMPT, imagePath, { timeoutMs: Math.min(timeoutMs, 60_000), purpose: 'describe-image' });
  if (vr.ok) {
    const trimmed = vr.text.replace(/\s+/g, ' ').slice(0, 500);
    if (cacheFile) { try { mkdirSync(refsDir, { recursive: true }); writeFileSync(cacheFile, trimmed); } catch { /* best-effort */ } }
    return { ok: true, text: trimmed, error: null };
  }
  if (vr.noVision) {
    return { ok: false, text: null, error: 'configured model has no vision — switch LM Studio to a vision-capable model', noVision: true };
  }
  return { ok: false, text: null, error: vr.error };
}

/** Generic codex-vision text call (fallback engine for self-vision & friends): prompt + image
 *  → plain text. Same spawn shape as describeImage. Returns { ok, text, error }. */
export function codexSee(prompt, imagePath, { timeoutMs = 90_000 } = {}) {
  return new Promise((resolve) => {
    if (!existsSync(imagePath)) { resolve({ ok: false, text: null, error: `no such image: ${imagePath}` }); return; }
    const args = [
      '-a', 'never', '-s', 'read-only', 'exec', '--json', '--skip-git-repo-check', '--ignore-rules',
      '-i', imagePath, '-C', STUDIO_DIR, String(prompt),
    ];
    const child = spawn(CODEX_CLI, args, { cwd: STUDIO_DIR, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try { child.kill('SIGTERM'); } catch { /* gone */ }
      const text = extractPlainText(out);
      resolve(text ? { ok: true, text: text.trim(), error: null } : { ok: false, text: null, error: 'no reply from codex vision' });
    };
    const t = setTimeout(finish, timeoutMs);
    const collect = (d) => { out += d.toString(); if (out.length > 200_000) out = out.slice(-200_000); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', () => { clearTimeout(t); finish(); });
    child.on('close', () => { clearTimeout(t); finish(); });
  });
}
