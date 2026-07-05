#!/usr/bin/env node
// scripts/pixel-diff.mjs — objective, dependency-free pixel similarity between two PNGs.
//
// Used as the SECONDARY (structural) signal in the self-improvement loop's fidelity score,
// complementing the vision judge. Pure Node: decodes PNG via zlib.inflate + scanline un-filter
// (no npm deps — the whole project is Ornith-only / zero-dep), then compares on a normalized
// grayscale grid so two renders of different pixel dimensions still compare apples-to-apples.
//
// Exports:
//   readPng(path)                    → { width, height, gray:Float32Array(w*h) 0..1 } | null
//   downsampleGray(png, cols, rows)  → Float32Array(cols*rows) area-averaged luminance grid
//   pixelDiff(pathA, pathB, opts?)   → { ok, score 0..100, mae 0..1, grid, error }
//
// The score is 100 * (1 - meanAbsError) on a 64x64 (default) luminance grid: a coarse structural
// match ("are the dark/light masses in the same places?"), robust to sub-pixel jitter, anti-alias,
// and the reference/render being different native resolutions. CLI: node scripts/pixel-diff.mjs a.png b.png

import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Paeth predictor (PNG filter type 4). */
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Decode a PNG file into a normalized grayscale buffer. Supports the render backends' output:
 * 8-bit truecolor (RGB / RGBA) and grayscale (with/without alpha), no interlace — which is what
 * headless-Chrome and qlmanage emit. Returns null on anything it can't read (never throws).
 */
export function readPng(path) {
  try {
    const buf = readFileSync(path);
    if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) return null;
    let off = 8;
    let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
    const idat = [];
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
    const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
    if (!channels) return null; // palette (3) needs PLTE handling we skip — renders don't use it
    const raw = inflateSync(Buffer.concat(idat));
    const stride = width * channels;
    if (raw.length < (stride + 1) * height) return null;
    // un-filter scanlines in place → contiguous pixel bytes
    const out = Buffer.alloc(stride * height);
    let prevRow = null;
    for (let y = 0; y < height; y++) {
      const filter = raw[y * (stride + 1)];
      const rowStart = y * (stride + 1) + 1;
      const cur = out.subarray(y * stride, y * stride + stride);
      raw.copy(cur, 0, rowStart, rowStart + stride);
      for (let x = 0; x < stride; x++) {
        const a = x >= channels ? cur[x - channels] : 0;
        const b = prevRow ? prevRow[x] : 0;
        const c = prevRow && x >= channels ? prevRow[x - channels] : 0;
        let v = cur[x];
        if (filter === 1) v += a;
        else if (filter === 2) v += b;
        else if (filter === 3) v += (a + b) >> 1;
        else if (filter === 4) v += paeth(a, b, c);
        cur[x] = v & 0xff;
      }
      prevRow = cur;
    }
    // → grayscale 0..1, alpha-composited over white (transparent render bg = white like the ref)
    const gray = new Float32Array(width * height);
    const gI = colorType === 2 || colorType === 6; // has RGB
    for (let i = 0, p = 0; i < width * height; i++, p += channels) {
      let r, g, b, alpha = 1;
      if (gI) {
        r = out[p]; g = out[p + 1]; b = out[p + 2];
        if (colorType === 6) alpha = out[p + 3] / 255;
      } else {
        r = g = b = out[p];
        if (colorType === 4) alpha = out[p + 1] / 255;
      }
      const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      gray[i] = lum * alpha + (1 - alpha); // over white
    }
    return { width, height, gray };
  } catch {
    return null;
  }
}

/** Area-average a decoded grayscale image down to a cols×rows grid (resolution-independent). */
export function downsampleGray(png, cols, rows) {
  const { width, height, gray } = png;
  const grid = new Float32Array(cols * rows);
  for (let gy = 0; gy < rows; gy++) {
    const y0 = Math.floor((gy * height) / rows);
    const y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * height) / rows));
    for (let gx = 0; gx < cols; gx++) {
      const x0 = Math.floor((gx * width) / cols);
      const x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * width) / cols));
      let sum = 0, n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) { sum += gray[y * width + x]; n++; }
      }
      grid[gy * cols + gx] = n ? sum / n : 0;
    }
  }
  return grid;
}

/** Luminance std-dev of a decoded PNG on a `grid`×`grid` sampling — a cheap "how much CONTENT is
 *  here?" signal. A blank/near-uniform render (all-black placeholder, empty canvas) has ~0 spread;
 *  a real, content-rich ad has high spread. Lets a fidelity score reject a blank render that would
 *  otherwise trivially "match" a dark reference's background. Returns 0..~0.5, or null if undecodable. */
export function contentSpread(path, { grid = 64 } = {}) {
  const png = readPng(path);
  if (!png) return null;
  const g = downsampleGray(png, grid, grid);
  let mean = 0;
  for (let i = 0; i < g.length; i++) mean += g[i];
  mean /= g.length;
  let variance = 0;
  for (let i = 0; i < g.length; i++) { const d = g[i] - mean; variance += d * d; }
  return Math.sqrt(variance / g.length);
}

/**
 * Structural pixel similarity between two PNGs, resolution-independent. Both are downsampled to a
 * `grid`×`grid` luminance grid; score = 100·(1 − mean|Δ|). Never throws — returns
 * { ok:false, error } when either image can't be decoded.
 */
export function pixelDiff(pathA, pathB, { grid = 64 } = {}) {
  const a = readPng(pathA);
  const b = readPng(pathB);
  if (!a) return { ok: false, score: 0, mae: 1, grid, error: `could not decode ${pathA}` };
  if (!b) return { ok: false, score: 0, mae: 1, grid, error: `could not decode ${pathB}` };
  const ga = downsampleGray(a, grid, grid);
  const gb = downsampleGray(b, grid, grid);
  let sum = 0;
  for (let i = 0; i < ga.length; i++) sum += Math.abs(ga[i] - gb[i]);
  const mae = sum / ga.length;
  return { ok: true, score: Math.round(100 * (1 - mae) * 10) / 10, mae, grid, error: null };
}

// CLI: node scripts/pixel-diff.mjs <a.png> <b.png> [--grid 64]
if (import.meta.url === `file://${process.argv[1]}`) {
  const [a, b] = process.argv.slice(2).filter((x) => !x.startsWith('--'));
  if (!a || !b) { console.error('usage: node scripts/pixel-diff.mjs <a.png> <b.png> [--grid N]'); process.exit(2); }
  const gi = process.argv.indexOf('--grid');
  const grid = gi >= 0 ? Number(process.argv[gi + 1]) || 64 : 64;
  const r = pixelDiff(a, b, { grid });
  if (!r.ok) { console.error(r.error); process.exit(1); }
  console.log(`pixel similarity: ${r.score}/100  (MAE ${r.mae.toFixed(4)}, ${grid}×${grid} grid)`);
}
