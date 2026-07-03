// scripts/pixel-diff.mjs — zero-dep PNG pixel-diff helper for the calibration harness.
//
// Decodes two same-size PNGs and reports a normalized per-pixel RGB difference score, so
// preset/component fidelity work can be MEASURED against a real reference screenshot instead
// of guessed. The PNG decoder below is the same approach already proven in
// studio/lib/layout-extract.mjs (decodePng/decodeImage: node:zlib inflateSync, no npm dep) —
// duplicated here (rather than imported) so this tool has zero coupling to the studio/lib
// module graph and stays trivially runnable on its own. Keep the two decoders in sync if the
// upstream one gains format support (16-bit, palette, interlace, etc).

import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';

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
export function decodePng(buf) {
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

/** Decode via decodePng, transcoding JPG/WEBP (or a mis-named/exotic PNG) to PNG with macOS
 *  `sips` first when needed. Returns { width, height, channels, data } or null. Never throws. */
export function decodeImage(imagePath) {
  let buf;
  try { buf = readFileSync(imagePath); } catch { return null; }
  const isPng = buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47;
  if (isPng) {
    const d = decodePng(buf);
    if (d) return d;
  }
  let tmp = null;
  try {
    tmp = join(tmpdir(), `pixeldiff-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.png`);
    const r = spawnSync('sips', ['-s', 'format', 'png', imagePath, '--out', tmp], { timeout: 15_000, encoding: 'utf8' });
    if (r.status === 0 && existsSync(tmp)) {
      const d = decodePng(readFileSync(tmp));
      if (d) return d;
    }
  } catch { /* sips unavailable / failed → give up gracefully */ }
  finally { if (tmp) { try { unlinkSync(tmp); } catch { /* best effort */ } } }
  return null;
}

// A per-channel delta below this (0..255) is treated as anti-aliasing/compression noise and
// does NOT count the pixel as "different" — only deltas past this threshold accumulate.
const CHANNEL_NOISE_FLOOR = 24;

/**
 * Compare two PNGs pixel-by-pixel. Same-size images only (no resize — out of scope for v1).
 * Returns { diffScore, diffPixels, width, height, sameSize }.
 *   - sameSize:false → dimensions differ; diffScore/diffPixels are null and no compare ran.
 *   - diffScore: 0..1, mean per-pixel normalized RGB difference across ALL pixels (0 = identical).
 *     Per-pixel difference is the mean absolute difference across R/G/B (alpha ignored), divided
 *     by 255. Differences below CHANNEL_NOISE_FLOOR per channel are zeroed first so ordinary
 *     anti-aliasing/JPEG-noise along edges doesn't dominate the score.
 *   - diffPixels: count of pixels whose (post-floor) mean channel delta is > 0 — i.e. pixels
 *     that register as "different enough to count" at all.
 */
export function pixelDiff(pathA, pathB) {
  const a = decodeImage(pathA);
  const b = decodeImage(pathB);
  if (!a || !b) {
    return { diffScore: null, diffPixels: null, width: null, height: null, sameSize: false, error: !a ? `could not decode ${pathA}` : `could not decode ${pathB}` };
  }
  if (a.width !== b.width || a.height !== b.height) {
    return { diffScore: null, diffPixels: null, width: null, height: null, sameSize: false,
      error: `size mismatch: ${a.width}x${a.height} vs ${b.width}x${b.height}` };
  }
  const { width, height } = a;
  const chA = a.channels, chB = b.channels;
  let diffPixels = 0;
  let sumNorm = 0;
  const n = width * height;
  for (let p = 0; p < n; p++) {
    const ia = p * chA, ib = p * chB;
    let dr = Math.abs(a.data[ia] - b.data[ib]);
    let dg = Math.abs(a.data[ia + 1] - b.data[ib + 1]);
    let db = Math.abs(a.data[ia + 2] - b.data[ib + 2]);
    if (dr < CHANNEL_NOISE_FLOOR) dr = 0;
    if (dg < CHANNEL_NOISE_FLOOR) dg = 0;
    if (db < CHANNEL_NOISE_FLOOR) db = 0;
    const mean = (dr + dg + db) / 3;
    if (mean > 0) diffPixels++;
    sumNorm += mean / 255;
  }
  const diffScore = n > 0 ? sumNorm / n : 0;
  return { diffScore, diffPixels, width, height, sameSize: true, error: null };
}

// CLI: node scripts/pixel-diff.mjs a.png b.png
if (import.meta.url === `file://${process.argv[1]}`) {
  const [a, b] = process.argv.slice(2);
  if (!a || !b) {
    console.error('usage: node scripts/pixel-diff.mjs <a.png> <b.png>');
    process.exit(2);
  }
  const r = pixelDiff(a, b);
  console.log(JSON.stringify(r, null, 2));
  if (r.sameSize === false) process.exit(1);
}
