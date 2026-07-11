// lib/emoji-detect.mjs — detect + identify emoji glyphs in reference-ad regions.
//
// Per docs/EMOJI-ICONS-SPEC.md §2. Emoji are NEVER vectorized: this matcher runs ahead of
// vectorizeElement() on COLORFUL, square-ish icon candidates and returns the emoji character +
// codepoint + the rendering platform (set). The caller emits the character as a Figma text run
// (inline) or the platform PNG as an image fill (set-fidelity-critical); on a miss/low
// confidence it returns set:'unknown' and the caller keeps tracing.
//
// Pipeline (per candidate box):
//   1. colorfulness gate  — isColorfulSquare(): nonGrayFraction ≥ 0.25 OR domColors ≥ 4, and a
//      roughly-square aspect. Monochrome UI icons fail this and are left for the icon matcher.
//   2. normalize          — crop to box, flatten alpha onto white, grayscale, resize 64×64.
//   3. coarse recall      — dHash/aHash Hamming vs every atlas entry (min over sets) → top-K.
//   4. fine rank (NCC)    — normalized cross-correlation of the 64×64 gray vs each set's
//                           rendering of each top-K codepoint. Best codepoint = max NCC.
//   5. set identification — for the winning codepoint, argmax NCC across sets = platform;
//                           setMargin = best − 2nd. Below the confidence gate → set:'unknown'.
//
// Skin-tone (U+1F3FB..FF) and ZWJ sequences are handled implicitly: the atlas is keyed by the
// full dash-joined codepoint (incl. toned variants), so NCC picks the composed glyph directly.
//
// Atlas is built by scripts/build-emoji-atlas.mjs into .state/emoji-atlas/. Never throws.
// Only dependency is sharp.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import sharp from 'sharp';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ATLAS_DIR = join(__dirname, '..', '.state', 'emoji-atlas');
const CELL = 64;   // gray hashing size
const RGB = 32;    // color-thumbnail edge (must match scripts/build-emoji-atlas.mjs)
const SETS = ['apple', 'twemoji', 'noto', 'openmoji'];

// Thresholds (spec §2.6, retuned for color-NCC on real ad crops) — overridable via opts.
const DEFAULTS = {
  nonGrayFraction: 0.20,
  domColors: 4,
  aspectTol: 1.9,      // max(w/h, h/w) allowed for "square-ish"
  hammingMax: 26,      // recall: keep codepoints within this dHash Hamming (of 64)
  topK: 24,
  nccAccept: 0.70,     // color-NCC confidence gate → hit; below → set:'unknown'
  setMargin: 0.04,     // below this set-ID margin → set:'other'
  bgDist: 44,          // candidate background-removal color distance
};

// ── hashing (MUST match scripts/build-emoji-atlas.mjs) ──
function aHash(gray) {
  const s = 8, block = CELL / s, small = new Float64Array(64);
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
    let sum = 0;
    for (let by = 0; by < block; by++) for (let bx = 0; bx < block; bx++)
      sum += gray[(y * block + by) * CELL + (x * block + bx)];
    small[y * s + x] = sum / (block * block);
  }
  let mean = 0; for (const v of small) mean += v; mean /= 64;
  let bits = 0n; for (let i = 0; i < 64; i++) if (small[i] >= mean) bits |= (1n << BigInt(i));
  return bits;
}
function dHash(gray) {
  const w = 9, h = 8, bw = CELL / w, bh = CELL / h, small = new Float64Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let sum = 0, n = 0;
    const x0 = Math.floor(x * bw), x1 = Math.floor((x + 1) * bw);
    const y0 = Math.floor(y * bh), y1 = Math.floor((y + 1) * bh);
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { sum += gray[yy * CELL + xx]; n++; }
    small[y * w + x] = n ? sum / n : 0;
  }
  let bits = 0n, i = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w - 1; x++) {
    if (small[y * w + x] < small[y * w + x + 1]) bits |= (1n << BigInt(i));
    i++;
  }
  return bits;
}
function hamming(a, b) {
  let x = a ^ b, c = 0;
  while (x) { x &= (x - 1n); c++; }
  return c;
}

// normalized cross-correlation of two equal-length gray vectors → [-1, 1]
function ncc(a, b) {
  const n = a.length;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma, y = b[i] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  if (da <= 1e-6 || db <= 1e-6) return 0;
  return num / Math.sqrt(da * db);
}

// ── atlas loading ──
let _atlasCache = null;
/**
 * Load + decode the emoji atlas manifest into memory (cached per process).
 * Returns { cell, sets:{...counts}, entries:[{codepoint,char, byGray:{set:Uint8Array}, hashes:[{dhash,ahash}]}] }.
 * On any failure returns an empty atlas (entries:[]) — callers degrade to no-emoji, never throw.
 */
export function loadEmojiAtlases(opts = {}) {
  if (_atlasCache && !opts.force && !opts.atlasDir) return _atlasCache;
  const dir = opts.atlasDir || DEFAULT_ATLAS_DIR;
  const manifestPath = join(dir, 'manifest.json');
  const empty = { cell: CELL, dir, setCounts: {}, entries: [] };
  if (!existsSync(manifestPath)) return empty;
  let manifest;
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); }
  catch { return empty; }
  const entries = [];
  for (const [cp, e] of Object.entries(manifest.entries || {})) {
    const byGray = {};
    let byRgb = null;
    const hashes = [];
    for (const set of SETS) {
      if (!e[set]) continue;
      try {
        const gray = new Uint8Array(Buffer.from(e[set].gray, 'base64'));
        if (gray.length !== CELL * CELL) continue;
        byGray[set] = gray;
        if (e[set].rgb) {
          const rgb = new Uint8Array(Buffer.from(e[set].rgb, 'base64'));
          if (rgb.length === RGB * RGB * 3) (byRgb ||= {})[set] = rgb;
        }
        hashes.push({ dhash: BigInt('0x' + e[set].dhash), ahash: BigInt('0x' + e[set].ahash), set });
      } catch { /* skip */ }
    }
    if (Object.keys(byGray).length) entries.push({ codepoint: cp, char: e.char, byGray, byRgb, hashes });
  }
  const atlas = { cell: manifest.cell || CELL, dir, setCounts: manifest.setCounts || {}, entries };
  if (!opts.atlasDir) _atlasCache = atlas;
  return atlas;
}

// ── input normalization ──
// Accept: a PNG/JPEG Buffer, a file path (string), or a raw pixel object
// {data, width|w, height|h, channels}. Returns {rgba, width, height} with 4 channels, or null.
async function toRGBA(input) {
  try {
    if (input && typeof input === 'object' && (input.data || input.pixels) && (input.width || input.w)) {
      const width = input.width || input.w, height = input.height || input.h;
      const channels = input.channels || (input.data.length / (width * height)) | 0;
      const buf = Buffer.from(input.data || input.pixels);
      const { data, info } = await sharp(buf, { raw: { width, height, channels } })
        .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      return { rgba: data, width: info.width, height: info.height };
    }
    const src = typeof input === 'string' ? input : Buffer.from(input);
    const { data, info } = await sharp(src).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return { rgba: data, width: info.width, height: info.height };
  } catch { return null; }
}

// Resolve a box {x,y,w,h} to integer pixel bounds inside a WxH image. Auto-detects
// fractional boxes (all coords ≤ 1.5) unless opts.boxUnits forces 'pixel'/'fraction'.
function resolveBox(box, W, H, boxUnits) {
  let { x, y, w, h } = box;
  const frac = boxUnits === 'fraction' ||
    (boxUnits !== 'pixel' && x <= 1.5 && y <= 1.5 && w <= 1.5 && h <= 1.5);
  if (frac) { x *= W; y *= H; w *= W; h *= H; }
  x = Math.max(0, Math.round(x)); y = Math.max(0, Math.round(y));
  w = Math.min(W - x, Math.round(w)); h = Math.min(H - y, Math.round(h));
  return { x, y, w, h };
}

// Colorfulness + aspect stats over an RGBA crop.
function regionStats(rgba, W, px) {
  const { x, y, w, h } = px;
  if (w < 2 || h < 2) return { nonGrayFraction: 0, domColors: 0, aspect: Infinity, opaque: 0 };
  let nonGray = 0, counted = 0;
  const dom = new Set();
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const idx = ((y + j) * W + (x + i)) * 4;
      const a = rgba[idx + 3];
      if (a < 32) continue; // ignore transparent
      const r = rgba[idx], g = rgba[idx + 1], b = rgba[idx + 2];
      counted++;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      const sat = mx === 0 ? 0 : (mx - mn) / mx;
      if (sat > 0.15) nonGray++;
      dom.add(((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5)); // 3-bit/channel quantize
    }
  }
  const aspect = Math.max(w / h, h / w);
  return {
    nonGrayFraction: counted ? nonGray / counted : 0,
    domColors: dom.size,
    aspect,
    opaque: counted,
  };
}

/**
 * Colorfulness + aspect gate (spec §2.2). Splits element-detect icon candidates into
 * emoji-route (colorful, square-ish) vs monochrome UI-icon route.
 * @param pixels  raw RGBA object {data,width,height} OR result of toRGBA — see detectEmoji.
 * @returns { colorful, square, pass, nonGrayFraction, domColors, aspect }
 */
export function isColorfulSquare(pixels, box, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const W = pixels.width || pixels.w, H = pixels.height || pixels.h;
  const rgba = pixels.rgba || pixels.data;
  if (!rgba || !W || !H) return { colorful: false, square: false, pass: false, nonGrayFraction: 0, domColors: 0, aspect: Infinity };
  const px = resolveBox(box, W, H, opts.boxUnits);
  const s = regionStats(rgba, W, px);
  const colorful = s.nonGrayFraction >= o.nonGrayFraction || s.domColors >= o.domColors;
  const square = s.aspect <= o.aspectTol;
  return { colorful, square, pass: colorful && square, ...s };
}

// Normalize a candidate region to match the atlas convention (glyph trimmed to content,
// on a white field). Estimates the region's background from its border, knocks it out to
// white, trims to the content bbox, then emits a CELL gray (hashing) + RGB color thumbnail.
async function normalizeCandidate(rgba, W, H, px, bgDist) {
  const { x, y, w, h } = px;
  // border-median background color
  const bs = [];
  const push = (i) => bs.push([rgba[i], rgba[i + 1], rgba[i + 2]]);
  for (let i = 0; i < w; i++) { push(((y) * W + (x + i)) * 4); push(((y + h - 1) * W + (x + i)) * 4); }
  for (let j = 0; j < h; j++) { push(((y + j) * W + x) * 4); push(((y + j) * W + (x + w - 1)) * 4); }
  const med = (k) => { const a = bs.map((p) => p[k]).sort((m, n) => m - n); return a[a.length >> 1] || 0; };
  const bg = [med(0), med(1), med(2)];

  // content mask + bbox
  const crop = new Uint8Array(w * h * 4);
  let minX = w, minY = h, maxX = -1, maxY = -1, content = 0;
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const s = ((y + j) * W + (x + i)) * 4, d = (j * w + i) * 4;
    const r = rgba[s], g = rgba[s + 1], b = rgba[s + 2];
    const dist = Math.abs(r - bg[0]) + Math.abs(g - bg[1]) + Math.abs(b - bg[2]);
    if (dist > bgDist) {
      crop[d] = r; crop[d + 1] = g; crop[d + 2] = b; crop[d + 3] = 255;
      if (i < minX) minX = i; if (i > maxX) maxX = i; if (j < minY) minY = j; if (j > maxY) maxY = j; content++;
    } else { crop[d] = 255; crop[d + 1] = 255; crop[d + 2] = 255; crop[d + 3] = 255; }
  }
  // fallback: too little content → use whole crop flattened on white
  if (content < w * h * 0.02 || maxX < minX) { minX = 0; minY = 0; maxX = w - 1; maxY = h - 1; }
  const bw = maxX - minX + 1, bh = maxY - minY + 1;
  const trimmed = new Uint8Array(bw * bh * 4);
  for (let j = 0; j < bh; j++) for (let i = 0; i < bw; i++) {
    const s = ((minY + j) * w + (minX + i)) * 4, d = (j * bw + i) * 4;
    trimmed[d] = crop[s]; trimmed[d + 1] = crop[s + 1]; trimmed[d + 2] = crop[s + 2]; trimmed[d + 3] = 255;
  }
  const base = sharp(Buffer.from(trimmed), { raw: { width: bw, height: bh, channels: 4 } });
  const grayBuf = await base.clone().resize(CELL, CELL, { fit: 'fill' }).grayscale().raw().toBuffer();
  const rgbBuf = await base.clone().resize(RGB, RGB, { fit: 'fill' }).removeAlpha().raw().toBuffer();
  return { gray: Uint8Array.from(grayBuf.subarray(0, CELL * CELL)), rgb: Uint8Array.from(rgbBuf) };
}

/**
 * Detect emoji within candidate regions of an image.
 * @param input          PNG/JPEG Buffer | file path | raw {data,width,height,channels}.
 * @param candidateBoxes array of {x,y,w,h} (pixel or fractional — auto-detected; force via opts.boxUnits).
 * @param opts           { atlas?, atlasDir?, boxUnits?, ...thresholds }
 * @returns { emoji: [{ box, codepoint, char, set:'apple'|'twemoji'|'noto'|'openmoji'|'unknown', confidence, setMargin }] }
 * Never throws. Boxes that fail the colorfulness gate or the confidence gate yield no emoji
 * (a below-gate glyph is returned with set:'unknown' only when explicitly requested via opts.keepUnknown).
 */
export async function detectEmoji(input, candidateBoxes = [], opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const out = { emoji: [] };
  try {
    const atlas = opts.atlas || loadEmojiAtlases(opts);
    if (!atlas.entries.length) return out;
    const img = await toRGBA(input);
    if (!img) return out;
    const { rgba, width: W, height: H } = img;

    for (const box of candidateBoxes) {
      const px = resolveBox(box, W, H, opts.boxUnits);
      if (px.w < 4 || px.h < 4) continue;
      const gate = isColorfulSquare({ rgba, width: W, height: H }, box, opts);
      if (!gate.pass) continue;

      const { gray, rgb } = await normalizeCandidate(rgba, W, H, px, o.bgDist);
      const cdh = dHash(gray);

      // coarse recall: min Hamming over a codepoint's set-hashes
      const scored = [];
      for (const e of atlas.entries) {
        let best = 999;
        for (const hsh of e.hashes) {
          const d = hamming(cdh, hsh.dhash);
          if (d < best) best = d;
        }
        scored.push({ e, ham: best });
      }
      scored.sort((a, b) => a.ham - b.ham);
      const pool = scored.filter((s) => s.ham <= o.hammingMax).slice(0, o.topK);
      const recall = pool.length ? pool : scored.slice(0, o.topK); // fallback if all far

      // fine rank: COLOR NCC per codepoint (max over sets), then set-ID for the winner.
      // Falls back to gray NCC for entries without a color thumbnail.
      let bestEntry = null, bestNcc = -2, bestSetScores = null;
      for (const { e } of recall) {
        const setScores = {};
        let cpBest = -2;
        for (const set of SETS) {
          const cg = e.byRgb && e.byRgb[set];
          const gg = e.byGray[set];
          let s;
          if (cg && gg) s = 0.45 * ncc(rgb, cg) + 0.55 * ncc(gray, gg); // color hue + fine features
          else if (cg) s = ncc(rgb, cg);
          else if (gg) s = ncc(gray, gg);
          else continue;
          setScores[set] = s;
          if (s > cpBest) cpBest = s;
        }
        if (cpBest > bestNcc) { bestNcc = cpBest; bestEntry = e; bestSetScores = setScores; }
      }
      if (!bestEntry || !bestSetScores) continue;

      // set identification: argmax + margin
      const sorted = Object.entries(bestSetScores).sort((a, b) => b[1] - a[1]);
      const bestSet = sorted[0][0];
      const setMargin = sorted.length > 1 ? sorted[0][1] - sorted[1][1] : 1;

      const confidence = bestNcc;
      let set;
      if (confidence < o.nccAccept) {
        set = 'unknown';
        if (!opts.keepUnknown) continue;
      } else {
        set = setMargin >= o.setMargin ? bestSet : 'other';
      }

      out.emoji.push({
        box: px,
        codepoint: bestEntry.codepoint,
        char: bestEntry.char,
        set,
        confidence: Math.round(confidence * 1000) / 1000,
        setMargin: Math.round(setMargin * 1000) / 1000,
      });
    }
  } catch { /* never throw */ }
  return out;
}

export default { detectEmoji, isColorfulSquare, loadEmojiAtlases };
