// lib/icon-extract.mjs — Icon extraction pipeline for reference images.
//
// When an icon in a reference image can't be faithfully reproduced as a vector shape (too complex,
// too many paths, anti-aliased/bitmap source), we extract it as a cropped PNG with transparency.
// The pipeline:
//   1. detectIconRegion — find the tight icon boundary within a larger box
//   2. removeBackground — threshold-based background removal (simple luminance check)
//   3. cropIcon — crop with padding, output as transparent PNG
//   4. extractIcon — full pipeline: detect → remove bg → crop → write to disk
//
// All operations use the existing zero-dep PNG decoder from layout-extract.mjs (decodeImage) for
// reading, and Node's built-in zlib + fs for writing. No npm dependencies.

import { existsSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const STUDIO_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

// ── PNG encode (minimal, zero-dep) ──────────────────────────────────────────────────────────
// We only need to write 8-bit RGBA PNGs (the icon output format). Minimal encoder: IHDR + IDAT
// (deflated filtered scanlines) + IEND. No palette, no interlace, no ancillary chunks.

/** CRC32 lookup (used for PNG chunk checksums). */
const crcTable = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  crcTable[i] = c;
}
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([len, typeAndData, crc]);
}

/**
 * Encode raw RGBA pixel data into a minimal PNG file.
 * @param {number} width
 * @param {number} height
 * @param {Buffer} rgba — raw RGBA bytes (width * height * 4)
 * @returns {Buffer} PNG file bytes
 */
function encodePng(width, height, rgba) {
  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter: adaptive
  ihdr[12] = 0; // interlace: none

  // Filtered scanlines: prepend a 0-byte (filter None) to each row, then DEFLATE.
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter None
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const compressed = deflateSync(raw, { level: 9 });

  // Signature + chunks
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Luminance helpers ──────────────────────────────────────────────────────────────────────

function relLum(r, g, b) {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

// ── decodeImage (subset from layout-extract.mjs) ───────────────────────────────────────────
// We import the minimal PNG decode + image helpers we need. Rather than creating a circular
// dependency on layout-extract.mjs, we duplicate the minimal decode logic here (it's ~40 lines).

import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * Minimal PNG decoder — 8-bit RGB/RGBA only. Returns { width, height, channels, data } or null.
 */
function decodePng(buf) {
  try {
    if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) return null;
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
      } else if (type === 'IEND') break;
      off = dataStart + len + 4;
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
      const row = out.subarray(y * stride, y * stride + stride);
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

/** Decode an image file (PNG native, JPG/WEBP via sips transcoding). */
function decodeImage(imagePath) {
  let buf;
  try { buf = readFileSync(imagePath); } catch { return null; }
  const isPng = buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47;
  if (isPng) { const d = decodePng(buf); if (d) return d; }
  let tmp = null;
  try {
    tmp = join(tmpdir(), `icon-extract-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.png`);
    const r = spawnSync('sips', ['-s', 'format', 'png', imagePath, '--out', tmp], { timeout: 15_000, encoding: 'utf8' });
    if (r.status === 0 && existsSync(tmp)) {
      const d = decodePng(readFileSync(tmp));
      if (d) return d;
    }
  } catch { /* sips unavailable */ }
  finally { if (tmp) { try { rmSync(tmp, { force: true }); } catch { /* best effort */ } } }
  return null;
}

// ── detectIconRegion ───────────────────────────────────────────────────────────────────────
/**
 * Find the tight icon boundary within a larger bounding box. Analyzes the region's pixel content
 * to find the actual icon extent (trimming transparent/matching-background margins).
 *
 * @param {string} imagePath — path to the source image
 * @param {{ x:number, y:number, w:number, h:number }} box — region in percentage coords (0..100)
 * @param {object} [opts] — optional overrides
 * @param {number} [opts.edgeThreshold=20] — luminance difference to count as "not background"
 * @returns {{ x:number, y:number, w:number, h:number }|null} — tight bounding box in pct coords, or null
 */
export function detectIconRegion(imagePath, box, opts = {}) {
  const img = decodeImage(imagePath);
  if (!img) return null;
  const { width: iw, height: ih, channels: ch, data } = img;
  if (iw < 4 || ih < 4) return null;

  const edgeThreshold = opts.edgeThreshold || 20;
  const inset = 0.03; // skip the outermost 3% to avoid the region's own border stroke

  const x0 = Math.max(0, Math.floor(((box.x / 100) + (box.w / 100) * inset) * iw));
  const y0 = Math.max(0, Math.floor(((box.y / 100) + (box.h / 100) * inset) * ih));
  const x1 = Math.min(iw, Math.ceil(((box.x / 100) + (box.w / 100) * (1 - inset)) * iw));
  const y1 = Math.min(ih, Math.ceil(((box.y / 100) + (box.h / 100) * (1 - inset)) * ih));
  const rw = x1 - x0, rh = y1 - y0;
  if (rw < 4 || rh < 4) return null;

  // Sample the background luminance from the border pixels (top/bottom rows, left/right cols)
  const at = (x, y) => {
    const p = (y * iw + x) * ch;
    return { r: data[p], g: data[p + 1], b: data[p + 2], a: ch === 4 ? data[p + 3] : 255 };
  };
  const borderLums = [];
  const stepX = Math.max(1, Math.floor(rw / 40));
  const stepY = Math.max(1, Math.floor(rh / 40));
  for (let x = x0; x < x1; x += stepX) {
    const t = at(x, y0), b = at(x, y1 - 1);
    if (t.a >= 32) borderLums.push(relLum(t.r, t.g, t.b));
    if (b.a >= 32) borderLums.push(relLum(b.r, b.g, b.b));
  }
  for (let y = y0; y < y1; y += stepY) {
    const l = at(x0, y), r = at(x1 - 1, y);
    if (l.a >= 32) borderLums.push(relLum(l.r, l.g, l.b));
    if (r.a >= 32) borderLums.push(relLum(r.r, r.g, r.b));
  }
  if (!borderLums.length) return null;
  // FIX: Use MEDIAN instead of mean — robust against up to 50% outlier pixels (icon touching
  // the box edge, compression artifacts, gradient borders). The mean was pulled by the minority
  // of icon-edge pixels, causing background color misidentification.
  borderLums.sort((a, b) => a - b);
  const mid = Math.floor(borderLums.length / 2);
  const bgLum = borderLums.length % 2 === 0
    ? (borderLums[mid - 1] + borderLums[mid]) / 2
    : borderLums[mid];

  // Scan for the tight bounding box of non-background pixels
  let minRX = rw, minRY = rh, maxRX = 0, maxRY = 0;
  let found = false;
  const scanStepX = Math.max(1, Math.floor(rw / 100));
  const scanStepY = Math.max(1, Math.floor(rh / 100));
  for (let y = y0; y < y1; y += scanStepY) {
    for (let x = x0; x < x1; x += scanStepX) {
      const px = at(x, y);
      if (px.a < 32) continue; // transparent = background
      const lum = relLum(px.r, px.g, px.b);
      if (Math.abs(lum - bgLum) * 255 > edgeThreshold) {
        const rx = x - x0, ry = y - y0;
        if (rx < minRX) minRX = rx;
        if (ry < minRY) minRY = ry;
        if (rx > maxRX) maxRX = rx;
        if (ry > maxRY) maxRY = ry;
        found = true;
      }
    }
  }
  if (!found) return null;

  // Convert back to percentage coords
  const tightW = (maxRX - minRX) / iw;
  const tightH = (maxRY - minRY) / ih;
  if (tightW < 0.01 || tightH < 0.01) return null;
  return {
    x: Math.round(((x0 + minRX) / iw) * 10000) / 100,
    y: Math.round(((y0 + minRY) / ih) * 10000) / 100,
    w: Math.round(tightW * 10000) / 100,
    h: Math.round(tightH * 10000) / 100,
  };
}

// ── removeBackground ──────────────────────────────────────────────────────────────────────
/**
 * Remove the background from an icon region by making near-background-color pixels transparent.
 * Uses a simple luminance-distance threshold against the sampled background.
 *
 * @param {string} imagePath
 * @param {{ x:number, y:number, w:number, h:number }} box — region in percentage coords (0..100)
 * @param {object} [opts]
 * @param {number} [opts.threshold=0.12] — max normalized luminance distance to consider "background"
 * @param {number} [opts.alphaThreshold=32] — minimum alpha to keep (below = transparent)
 * @returns {{ data:Buffer, width:number, height:number, channels:4 }|null} — RGBA pixels of the
 *   cropped region, with background pixels set to alpha=0
 */
export function removeBackground(imagePath, box, opts = {}) {
  const img = decodeImage(imagePath);
  if (!img) return null;
  const { width: iw, height: ih, channels: ch, data } = img;
  if (iw < 4 || ih < 4) return null;

  const threshold = opts.threshold || 0.12;
  const alphaThreshold = opts.alphaThreshold || 32;

  const x0 = Math.max(0, Math.floor((box.x / 100) * iw));
  const y0 = Math.max(0, Math.floor((box.y / 100) * ih));
  const x1 = Math.min(iw, Math.ceil(((box.x + box.w) / 100) * iw));
  const y1 = Math.min(ih, Math.ceil(((box.y + box.h) / 100) * ih));
  const rw = x1 - x0, rh = y1 - y0;
  if (rw < 2 || rh < 2) return null;

  const at = (x, y) => {
    const p = (y * iw + x) * ch;
    return { r: data[p], g: data[p + 1], b: data[p + 2], a: ch === 4 ? data[p + 3] : 255 };
  };

  // Sample border to determine the background color
  const borderPixels = [];
  const stepX = Math.max(1, Math.floor(rw / 30));
  const stepY = Math.max(1, Math.floor(rh / 30));
  for (let x = x0; x < x1; x += stepX) {
    borderPixels.push(at(x, y0), at(x, y1 - 1));
  }
  for (let y = y0; y < y1; y += stepY) {
    borderPixels.push(at(x0, y), at(x1 - 1, y));
  }
  const validBorder = borderPixels.filter((p) => p.a >= alphaThreshold);
  if (!validBorder.length) return null;
  // FIX: Use MEDIAN per channel instead of mean — robust against icon-edge pixels that
  // contaminate the border sample when the icon touches the box boundary.
  const sortedR = validBorder.map(p => p.r).sort((a, b) => a - b);
  const sortedG = validBorder.map(p => p.g).sort((a, b) => a - b);
  const sortedB = validBorder.map(p => p.b).sort((a, b) => a - b);
  const mid = Math.floor(sortedR.length / 2);
  const bgR = sortedR.length % 2 === 0 ? (sortedR[mid - 1] + sortedR[mid]) / 2 : sortedR[mid];
  const bgG = sortedG.length % 2 === 0 ? (sortedG[mid - 1] + sortedG[mid]) / 2 : sortedG[mid];
  const bgB = sortedB.length % 2 === 0 ? (sortedB[mid - 1] + sortedB[mid]) / 2 : sortedB[mid];
  const bgDist = (r, g, b) => {
    const dr = r - bgR, dg = g - bgG, db = b - bgB;
    return Math.sqrt(dr * dr + dg * dg + db * db) / 441.67; // normalized 0..1
  };

  // Build output RGBA buffer
  const out = Buffer.alloc(rw * rh * 4);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const px = at(x, y);
      const outP = ((y - y0) * rw + (x - x0)) * 4;
      out[outP] = px.r;
      out[outP + 1] = px.g;
      out[outP + 2] = px.b;
      if (px.a < alphaThreshold || bgDist(px.r, px.g, px.b) < threshold) {
        out[outP + 3] = 0; // transparent
      } else {
        out[outP + 3] = Math.min(255, Math.max(0, px.a));
      }
    }
  }
  return { data: out, width: rw, height: rh, channels: 4 };
}

// ── cropIcon ──────────────────────────────────────────────────────────────────────────────
/**
 * Crop an icon from the image with padding and write it as a transparent PNG.
 *
 * @param {string} imagePath
 * @param {{ x:number, y:number, w:number, h:number }} box — region in percentage coords (0..100)
 * @param {object} [opts]
 * @param {number} [opts.padding=0.02] — extra padding as fraction of box dimensions
 * @param {number} [opts.outputScale=2] — output scale factor (2x for retina)
 * @param {string} [opts.outputPath] — where to write the PNG (default: .state/refs/icons/{timestamp}.png)
 * @returns {{ path:string, width:number, height:number }|null}
 */
export function cropIcon(imagePath, box, opts = {}) {
  const img = decodeImage(imagePath);
  if (!img) return null;
  const { width: iw, height: ih, channels: ch, data } = img;
  if (iw < 4 || ih < 4) return null;

  const padding = opts.padding || 0.02;
  const outputScale = opts.outputScale || 2;

  // Apply padding to the box (in percentage coords)
  const padX = box.w * padding;
  const padY = box.h * padding;
  const cropBox = {
    x: Math.max(0, box.x - padX),
    y: Math.max(0, box.y - padY),
    w: Math.min(100 - Math.max(0, box.x - padX), box.w + padX * 2),
    h: Math.min(100 - Math.max(0, box.y - padY), box.h + padY * 2),
  };

  const x0 = Math.max(0, Math.floor((cropBox.x / 100) * iw));
  const y0 = Math.max(0, Math.floor((cropBox.y / 100) * ih));
  const x1 = Math.min(iw, Math.ceil(((cropBox.x + cropBox.w) / 100) * iw));
  const y1 = Math.min(ih, Math.ceil(((cropBox.y + cropBox.h) / 100) * ih));
  const rw = x1 - x0, rh = y1 - y0;
  if (rw < 2 || rh < 2) return null;

  const at = (x, y) => {
    const p = (y * iw + x) * ch;
    return { r: data[p], g: data[p + 1], b: data[p + 2], a: ch === 4 ? data[p + 3] : 255 };
  };

  // Sample background for removal
  const borderPixels = [];
  const stepX = Math.max(1, Math.floor(rw / 20));
  const stepY = Math.max(1, Math.floor(rh / 20));
  for (let x = x0; x < x1; x += stepX) {
    borderPixels.push(at(x, y0), at(x, y1 - 1));
  }
  for (let y = y0; y < y1; y += stepY) {
    borderPixels.push(at(x0, y), at(x1 - 1, y));
  }
  const validBorder = borderPixels.filter((p) => p.a >= 32);
  const bgR = validBorder.length ? validBorder.reduce((s, p) => s + p.r, 0) / validBorder.length : 128;
  const bgG = validBorder.length ? validBorder.reduce((s, p) => s + p.g, 0) / validBorder.length : 128;
  const bgB = validBorder.length ? validBorder.reduce((s, p) => s + p.b, 0) / validBorder.length : 128;
  const bgDist = (r, g, b) => Math.sqrt((r - bgR) ** 2 + (g - bgG) ** 2 + (b - bgB) ** 2) / 441.67;

  // Build output at scale
  const outW = Math.round(rw * outputScale);
  const outH = Math.round(rh * outputScale);
  const out = Buffer.alloc(outW * outH * 4);

  for (let oy = 0; oy < outH; oy++) {
    for (let ox = 0; ox < outW; ox++) {
      // Map output pixel back to source (bilinear-ish: nearest-neighbor at scale)
      const sx = Math.min(iw - 1, x0 + Math.floor(ox / outputScale));
      const sy = Math.min(ih - 1, y0 + Math.floor(oy / outputScale));
      const px = at(sx, sy);
      const outP = (oy * outW + ox) * 4;
      out[outP] = px.r;
      out[outP + 1] = px.g;
      out[outP + 2] = px.b;
      if (px.a < 32 || bgDist(px.r, px.g, px.b) < 0.12) {
        out[outP + 3] = 0;
      } else {
        // Slight alpha edge refinement: if the pixel is close to the threshold, soften the edge
        const dist = bgDist(px.r, px.g, px.b);
        const edgeAlpha = dist < 0.18 ? Math.round(((dist - 0.12) / 0.06) * 255) : 255;
        out[outP + 3] = Math.min(255, Math.max(0, Math.round(px.a * (edgeAlpha / 255))));
      }
    }
  }

  // Write the PNG
  const png = encodePng(outW, outH, out);
  let outputPath = opts.outputPath;
  if (!outputPath) {
    const iconsDir = join(STUDIO_DIR, '.state', 'refs', 'icons');
    if (!existsSync(iconsDir)) mkdirSync(iconsDir, { recursive: true });
    outputPath = join(iconsDir, `icon-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.png`);
  }
  try {
    writeFileSync(outputPath, png);
    return { path: outputPath, width: outW, height: outH };
  } catch { return null; }
}

// ── extractIcon (full pipeline) ──────────────────────────────────────────────────────────
/**
 * Full icon extraction pipeline: detect tight bounds → crop with bg removal → write transparent PNG.
 *
 * @param {string} imagePath — source image path
 * @param {{ x:number, y:number, w:number, h:number }} box — region in percentage coords (0..100)
 * @param {object} [opts]
 * @param {number} [opts.padding] — crop padding (default 0.02)
 * @param {number} [opts.outputScale] — output resolution scale (default 2)
 * @param {string} [opts.outputPath] — explicit output path
 * @param {boolean} [opts.skipDetect=false] — skip tight-bound detection, use box directly
 * @returns {{ path:string, width:number, height:number, box:{x:number,y:number,w:number,h:number} }|null}
 */
export function extractIcon(imagePath, box, opts = {}) {
  if (!existsSync(imagePath)) return null;
  if (!box || !(box.w > 0) || !(box.h > 0)) return null;

  // Step 1: detect tight icon boundary (optional — skip when the box IS the icon)
  let iconBox = box;
  if (!opts.skipDetect) {
    const tight = detectIconRegion(imagePath, box);
    if (tight && tight.w >= 0.01 && tight.h >= 0.01) {
      iconBox = tight;
    }
  }

  // Step 2+3: crop with background removal and write PNG
  const result = cropIcon(imagePath, iconBox, opts);
  if (!result) return null;

  return {
    path: result.path,
    width: result.width,
    height: result.height,
    box: iconBox,
  };
}

// ── Shape Complexity Analysis ─────────────────────────────────────────────────────────────
// Used by the harness to decide whether a detected shape should be rendered as a vector
// (rect, ellipse, arrow, line) or needs rasterization (complex path, gradient, effects).

/**
 * Analyze the visual complexity of a region to decide if it should be a vector shape or raster.
 * Examines edge density, color variation, and contour irregularity within the region.
 *
 * @param {string} imagePath — source image path
 * @param {{ x:number, y:number, w:number, h:number }} box — region in percentage coords (0..100)
 * @param {object} [opts]
 * @param {object} [opts._img] — pre-decoded image (avoids re-decoding per region)
 * @returns {{ type:'simple'|'complex', shapeKind:'rect'|'ellipse'|'arrow'|'line'|'polyline'|'path', confidence:number, reasons:string[] }|null}
 */
export function analyzeShapeComplexity(imagePath, box, opts = {}) {
  const img = opts._img || decodeImage(imagePath);
  if (!img) return null;
  const { width: iw, height: ih, channels: ch, data } = img;
  if (iw < 4 || ih < 4) return null;

  const x0 = Math.max(0, Math.floor((box.x / 100) * iw));
  const y0 = Math.max(0, Math.floor((box.y / 100) * ih));
  const x1 = Math.min(iw, Math.ceil(((box.x + box.w) / 100) * iw));
  const y1 = Math.min(ih, Math.ceil(((box.y + box.h) / 100) * ih));
  const rw = x1 - x0, rh = y1 - y0;
  if (rw < 4 || rh < 4) return null;

  const at = (x, y) => {
    const p = (y * iw + x) * ch;
    return { r: data[p], g: data[p + 1], b: data[p + 2], a: ch === 4 ? data[p + 3] : 255 };
  };

  // Collect luminance grid for analysis
  const stepX = Math.max(1, Math.floor(rw / 40));
  const stepY = Math.max(1, Math.floor(rh / 40));
  const lums = [];
  const colors = [];
  let edgeCount = 0;
  let totalPixels = 0;

  for (let y = y0; y < y1; y += stepY) {
    for (let x = x0; x < x1; x += stepX) {
      const px = at(x, y);
      const lum = relLum(px.r, px.g, px.b);
      lums.push(lum);
      colors.push([px.r, px.g, px.b]);
      totalPixels++;

      // Simple edge detection: compare to right neighbor
      if (x + stepX < x1) {
        const npx = at(x + stepX, y);
        const nlum = relLum(npx.r, npx.g, npx.b);
        if (Math.abs(lum - nlum) > 0.08) edgeCount++;
      }
      // Compare to bottom neighbor
      if (y + stepY < y1) {
        const npx = at(x, y + stepY);
        const nlum = relLum(npx.r, npx.g, npx.b);
        if (Math.abs(lum - nlum) > 0.08) edgeCount++;
      }
    }
  }
  if (lums.length < 8) return null;

  const edgeDensity = totalPixels > 0 ? edgeCount / totalPixels : 0;

  // Color quantization: how many distinct colors?
  const colorSet = new Set();
  for (const [r, g, b] of colors) {
    // Quantize to 8-level per channel (32 per channel bins)
    colorSet.add(`${r >> 5},${g >> 5},${b >> 5}`);
  }
  const colorDiversity = colorSet.size;

  // Luminance variance
  const meanL = lums.reduce((s, v) => s + v, 0) / lums.length;
  const variance = lums.reduce((s, v) => s + (v - meanL) ** 2, 0) / lums.length;

  // Entropy (coarse histogram)
  const buckets = new Array(8).fill(0);
  for (const l of lums) buckets[Math.min(7, Math.floor(l * 8))]++;
  let entropy = 0;
  for (const c of buckets) { if (!c) continue; const p = c / lums.length; entropy -= p * Math.log2(p); }

  const reasons = [];

  // ── Classification logic ──

  // Very simple: few colors, low edge density, low entropy = solid fill (rect/ellipse)
  if (colorDiversity <= 4 && edgeDensity < 0.05 && entropy < 1.0) {
    reasons.push('solid fill (few colors, low edges, low entropy)');
    return { type: 'simple', shapeKind: 'rect', confidence: 0.9, reasons };
  }

  // High edge density + high color diversity = complex shape (icon, logo, detailed illustration)
  if (edgeDensity > 0.3 && colorDiversity > 12) {
    reasons.push(`high edge density (${edgeDensity.toFixed(2)}) + diverse colors (${colorDiversity})`);
    return { type: 'complex', shapeKind: 'path', confidence: 0.85, reasons };
  }

  // High entropy + many colors = needs raster (gradient, photo-like, complex texture)
  if (entropy > 3.0 && colorDiversity > 20) {
    reasons.push(`high entropy (${entropy.toFixed(1)} bits) + ${colorDiversity} quantized colors`);
    return { type: 'complex', shapeKind: 'path', confidence: 0.8, reasons };
  }

  // Moderate complexity — check aspect ratio for arrow/line hints
  const aspect = rw / rh;
  if (aspect > 3.0 || aspect < 0.33) {
    // Very elongated — likely a line or arrow
    if (edgeDensity > 0.1 && edgeDensity < 0.5) {
      reasons.push(`elongated shape (aspect ${aspect.toFixed(1)}) with moderate edges`);
      return { type: 'simple', shapeKind: 'arrow', confidence: 0.6, reasons };
    }
    reasons.push(`elongated shape (aspect ${aspect.toFixed(1)}) — likely line/arrow`);
    return { type: 'simple', shapeKind: 'line', confidence: 0.55, reasons };
  }

  // Moderate edges + moderate colors — possibly a simple path (star, heart, etc.)
  if (edgeDensity > 0.1 && colorDiversity > 4 && colorDiversity <= 12) {
    reasons.push(`moderate complexity (edges=${edgeDensity.toFixed(2)}, colors=${colorDiversity})`);
    return { type: 'simple', shapeKind: 'path', confidence: 0.5, reasons };
  }

  // Default: simple shape
  reasons.push(`low complexity (edges=${edgeDensity.toFixed(2)}, colors=${colorDiversity}, entropy=${entropy.toFixed(1)})`);
  return { type: 'simple', shapeKind: 'rect', confidence: 0.7, reasons };
}

// ── Smart Vector/Raster Decision ──────────────────────────────────────────────────────────
/**
 * Decide whether an element definition should be rendered as a vector shape or rasterized.
 *
 * @param {object} elementDef — an ElementDef or layer with style params
 * @param {object} [params] — element params (e.g. spikes count for starburst)
 * @returns {{ rasterize:boolean, reason:string }}
 */
export function shouldRasterize(elementDef, params = {}) {
  const style = elementDef?.style || {};
  const kind = style.shapeKind || 'rect';

  // Simple shapes: NEVER rasterize
  if (kind === 'rect' || kind === 'ellipse' || kind === 'line' || kind === 'arrow') {
    return { rasterize: false, reason: `simple shape: ${kind}` };
  }

  // Starburst: vector (polygon computed from spike count)
  if (kind === 'starburst') {
    const spikes = params.spikes || style.spikes || 12;
    if (spikes <= 40) return { rasterize: false, reason: `starburst with ${spikes} spikes (vector polygon)` };
    return { rasterize: true, reason: `starburst with ${spikes} spikes (>40, complex polygon)` };
  }

  // Freeform path: check path complexity
  if (kind === 'path' && style.path) {
    // Count path commands — a complex SVG path (many curves) may be better as raster
    const cmdCount = (style.path.match(/[CcSsQqTtAa]/g) || []).length;
    const pointCount = (style.path.match(/[ML]/gi) || []).length;
    if (cmdCount > 30 || pointCount > 50) {
      return { rasterize: true, reason: `complex path (${cmdCount} curves, ${pointCount} points)` };
    }
    return { rasterize: false, reason: `simple path (${cmdCount} curves, ${pointCount} points)` };
  }

  // Polyline: vector for reasonable point counts
  if (kind === 'polyline' && Array.isArray(style.points)) {
    const n = style.points.length / 2;
    if (n <= 24) return { rasterize: false, reason: `polyline with ${n} points` };
    return { rasterize: true, reason: `polyline with ${n} points (>24, complex)` };
  }

  // Effects that require rasterization
  if (style.backdropBlur && style.backdropBlur > 0) {
    return { rasterize: true, reason: `backdropBlur effect (${style.backdropBlur}px)` };
  }
  if (style.blur && style.blur > 0) {
    return { rasterize: true, reason: `blur effect (${style.blur}px)` };
  }
  if (style.vignette) {
    return { rasterize: true, reason: 'vignette effect' };
  }

  // Gradient: depends on complexity
  if (style.gradient) {
    if (typeof style.gradient === 'object' && Array.isArray(style.gradient.stops)) {
      if (style.gradient.stops.length > 6) {
        return { rasterize: true, reason: `gradient with ${style.gradient.stops.length} stops (>6)` };
      }
    }
    // Simple 2-stop or named gradient: vector is fine
    return { rasterize: false, reason: 'simple gradient (vector CSS)' };
  }

  // Default: vector
  return { rasterize: false, reason: 'no complex features detected' };
}
