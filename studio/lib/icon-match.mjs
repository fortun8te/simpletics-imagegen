// lib/icon-match.mjs — recognize native-UI chrome in an ad and substitute the CANONICAL vector
// (from lib/native-icons.mjs + lib/notes-icons.mjs) instead of tracing it.
//
// WHERE THIS SITS (docs/EMOJI-ICONS-SPEC.md §0, §5): the element pipeline classifies small,
// edge-dense connected components as kind:'icon' (lib/element-detect.mjs). For a MONOCHROME
// (non-colorful) icon candidate, the assembler should call matchIcon() BEFORE vectorizeElement().
// On a hit we keep the detected box and swap the geometry for the canonical 0..1-normalized path
// that native-icons.mjs already ships (verbatim x.com / instagram.com DOM paths + Bootstrap/
// simple-icons). On a miss we return {matched:false} and the caller falls back to trace.
//
// APPROACH (spec §5.2): render every NATIVE_ICONS/NOTES icon to a 64×64 monochrome silhouette
// once (sharp rasterizes the SVG path buffer — no new deps), cache bitmaps + a DCT pHash in
// .state/icon-atlas/manifest.json keyed by a hash of the icon set (rebuilds when icons change).
// Per candidate: binarize (Otsu) the crop, isolate the FOREGROUND mask (works whether the icon
// is light-on-dark or dark-on-light, and regardless of the icon's actual COLOR — we match on
// SHAPE/coverage, not color), normalize to a centred 64×64 silhouette, prefilter atlas ids by
// pHash Hamming distance, then fine-rank by silhouette NCC (zero-normalized cross-correlation).
// Filled-vs-outline ambiguity is broken by comparing foreground fill fraction.
//
// This mirrors the silhouette-matching the repo already uses for fonts (lib/font-match.mjs).
// Icons are axis-aligned UI chrome, so no rotation search is needed.
//
// Owns ONLY: this file, test/icon-match.test.mjs, and the .state/icon-atlas/ cache. Imports
// native-icons.mjs / notes-icons.mjs READ-ONLY. Never throws (all public fns catch internally).

import sharp from 'sharp';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import { writeAtomic } from './atomic-write.mjs';
import { NATIVE_ICONS } from './native-icons.mjs';
import {
  NOTES_CHEVRON_BACK, NOTES_SHARE_ICON, NOTES_MORE_CIRCLE_RING,
  NOTES_MORE_DOTS, NOTES_CHECKLIST_DONE_CIRCLE,
} from './notes-icons.mjs';

const STUDIO_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const ATLAS_DIR = join(STUDIO_DIR, '.state', 'icon-atlas');
const MANIFEST_PATH = join(ATLAS_DIR, 'manifest.json');

const N = 64;                 // silhouette resolution (N×N)
const PH_SIZE = 32;           // DCT input size for pHash
const PH_LOW = 8;             // low-frequency block kept (8×8 → 64-bit hash)

// ── the icon set we build an atlas from ───────────────────────────────────────────────────────
// native-icons entries are { d, viewBox:[w,h], ... }; notes-icons entries are { d, color } and are
// already normalized to their own 0..1 box (no viewBox). Both render from a "0 0 1 1" viewBox.
const NOTES_ENTRIES = {
  'notes-back': NOTES_CHEVRON_BACK,
  'notes-share': NOTES_SHARE_ICON,
  'notes-more-ring': NOTES_MORE_CIRCLE_RING,
  'notes-more-dots': NOTES_MORE_DOTS,
  'notes-checklist-done': NOTES_CHECKLIST_DONE_CIRCLE,
};

/** All { id -> d } pairs that make up the substitution atlas. */
function iconSourceEntries() {
  const out = [];
  for (const [id, entry] of Object.entries(NATIVE_ICONS)) {
    if (entry && typeof entry.d === 'string') out.push({ id, d: entry.d, viewBox: entry.viewBox });
  }
  for (const [id, entry] of Object.entries(NOTES_ENTRIES)) {
    if (entry && typeof entry.d === 'string') out.push({ id, d: entry.d, viewBox: [1, 1] });
  }
  return out;
}

/** Role-based, html.to.design-quality layer name from a flat icon id (spec §6). */
export function iconRoleName(id) {
  const s = String(id || '');
  if (/verified/.test(s)) return 'badge/verified';
  if (/back$/.test(s) || /chevron/.test(s)) return 'nav/back';
  if (/reply|comment/.test(s)) return 'action/reply';
  if (/repost/.test(s)) return 'action/repost';
  if (/like|heart/.test(s)) return 'action/like';
  if (/bookmark|save/.test(s)) return 'action/bookmark';
  if (/share/.test(s)) return 'action/share';
  if (/more|dots/.test(s)) return 'action/more';
  if (/check/.test(s)) return 'action/check';
  if (/circle-unchecked/.test(s)) return 'action/checkbox';
  if (s.startsWith('brand-')) return `brand/${s.slice(6)}`;
  if (s.startsWith('notes-')) return `notes/${s.slice(6)}`;
  return `icon/${s}`;
}

// ── image loading / decoding ──────────────────────────────────────────────────────────────────
// Accepts a file path (string), a PNG Buffer, or a pre-decoded { data, width, height, channels }.

async function toRGBA(input) {
  if (input && typeof input === 'object' && input.data && input.width && input.height) {
    const ch = input.channels || 4;
    if (ch === 4) return { data: input.data, width: input.width, height: input.height };
    // expand to RGBA
    const out = Buffer.alloc(input.width * input.height * 4);
    for (let i = 0, j = 0; i < input.width * input.height; i++) {
      out[j++] = input.data[i * ch]; out[j++] = input.data[i * ch + 1];
      out[j++] = input.data[i * ch + 2]; out[j++] = ch === 4 ? input.data[i * ch + 3] : 255;
    }
    return { data: out, width: input.width, height: input.height };
  }
  const src = Buffer.isBuffer(input) ? input : input; // path string or Buffer both accepted by sharp
  const { data, info } = await sharp(src).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/** Interpret a box against an image of (imgW, imgH). Supports px / fraction / percent units. */
function resolveBox(box, imgW, imgH, opts = {}) {
  let { x, y, w, h } = box;
  const units = opts.units
    || (Math.max(x + w, y + h) <= 1.5 ? 'fraction'
      : (Math.max(x + w, y + h) <= 100 && opts.assumePct ? 'pct' : 'px'));
  if (units === 'fraction') { x *= imgW; y *= imgH; w *= imgW; h *= imgH; }
  else if (units === 'pct') { x = (x / 100) * imgW; y = (y / 100) * imgH; w = (w / 100) * imgW; h = (h / 100) * imgH; }
  x = Math.max(0, Math.floor(x)); y = Math.max(0, Math.floor(y));
  w = Math.min(imgW - x, Math.ceil(w)); h = Math.min(imgH - y, Math.ceil(h));
  return { x, y, w, h };
}

// ── binarize + foreground isolation ───────────────────────────────────────────────────────────

/** Otsu threshold over a 0..255 luminance histogram. */
function otsu(hist, total) {
  let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, thr = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (wB === 0) continue;
    const wF = total - wB; if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; thr = t; }
  }
  return thr;
}

/**
 * From an RGBA crop, produce a binary FOREGROUND mask (Uint8Array, 1=ink). Handles: transparent
 * background (uses alpha), light-on-dark and dark-on-light, and off-color icons (color ignored —
 * split on luminance, then the border-majority class is called background). Returns null if the
 * crop is effectively blank.
 */
function foregroundMask(rgba, w, h) {
  const { data } = rgba;
  const n = w * h;
  // If the crop has meaningful transparency, alpha IS the mask.
  let transp = 0;
  for (let i = 0; i < n; i++) if (data[i * 4 + 3] < 128) transp++;
  if (transp > n * 0.08 && transp < n * 0.98) {
    const mask = new Uint8Array(n);
    let fg = 0;
    for (let i = 0; i < n; i++) { if (data[i * 4 + 3] >= 128) { mask[i] = 1; fg++; } }
    return fg > 0 ? mask : null;
  }
  // Otherwise binarize on luminance via Otsu.
  const lum = new Uint8Array(n);
  const hist = new Uint32Array(256);
  for (let i = 0; i < n; i++) {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
    const l = (0.2126 * r + 0.7152 * g + 0.0722 * b) | 0;
    lum[i] = l; hist[l]++;
  }
  const thr = otsu(hist, n);
  // Decide which side is background by sampling the border ring.
  let borderDark = 0, borderTot = 0;
  const bx = Math.max(1, Math.floor(w * 0.06)), by = Math.max(1, Math.floor(h * 0.06));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x >= bx && x < w - bx && y >= by && y < h - by) continue;
      borderTot++; if (lum[y * w + x] <= thr) borderDark++;
    }
  }
  const bgIsDark = borderTot > 0 && borderDark > borderTot / 2;
  const mask = new Uint8Array(n);
  let fg = 0;
  for (let i = 0; i < n; i++) {
    const dark = lum[i] <= thr;
    const isFg = bgIsDark ? !dark : dark; // foreground = the non-background class
    if (isFg) { mask[i] = 1; fg++; }
  }
  if (fg === 0 || fg === n) return null;
  return mask;
}

/** Trim a binary mask to its ink bbox, then resize/center into an N×N float coverage silhouette
 *  (aspect-preserving). Returns { sil:Float32Array(N*N), aspect, fillFrac } or null. */
function maskToSilhouette(mask, w, h) {
  let minX = w, minY = h, maxX = -1, maxY = -1, count = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (mask[y * w + x]) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y; count++;
    }
  }
  if (maxX < minX || maxY < minY) return null;
  const bw = maxX - minX + 1, bh = maxY - minY + 1;
  const aspect = bw / bh;
  // Fit the ink bbox into N×N preserving aspect, centered.
  const scale = Math.min(N / bw, N / bh) * 0.92; // small margin
  const dw = Math.max(1, Math.round(bw * scale)), dh = Math.max(1, Math.round(bh * scale));
  const offX = ((N - dw) / 2) | 0, offY = ((N - dh) / 2) | 0;
  const sil = new Float32Array(N * N);
  // Area-ish downsample: accumulate source ink into destination cells.
  const acc = new Float32Array(N * N), cnt = new Float32Array(N * N);
  for (let sy = minY; sy <= maxY; sy++) {
    const dy = offY + Math.min(dh - 1, ((sy - minY) * dh / bh) | 0);
    for (let sx = minX; sx <= maxX; sx++) {
      const dx = offX + Math.min(dw - 1, ((sx - minX) * dw / bw) | 0);
      const di = dy * N + dx;
      acc[di] += mask[sy * w + sx]; cnt[di]++;
    }
  }
  for (let i = 0; i < N * N; i++) sil[i] = cnt[i] ? acc[i] / cnt[i] : 0;
  // Light box-blur: thin UI strokes are 1–2px, so a small smoothing makes silhouette NCC robust
  // to the sub-pixel misalignment between the atlas render and the ad's own rasterization.
  return { sil: blurSil(sil, 2), aspect, fillFrac: count / (bw * bh) };
}

/** Separable box blur (radius r) over an N×N float silhouette. */
function blurSil(src, r) {
  if (r <= 0) return src;
  const tmp = new Float32Array(N * N), out = new Float32Array(N * N);
  const w = 2 * r + 1;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    let s = 0; for (let k = -r; k <= r; k++) s += src[y * N + Math.min(N - 1, Math.max(0, x + k))];
    tmp[y * N + x] = s / w;
  }
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    let s = 0; for (let k = -r; k <= r; k++) s += tmp[Math.min(N - 1, Math.max(0, y + k)) * N + x];
    out[y * N + x] = s / w;
  }
  return out;
}

// ── perceptual hash (DCT pHash) ───────────────────────────────────────────────────────────────

const _dctCos = (() => {
  const t = new Float32Array(PH_SIZE * PH_SIZE);
  for (let u = 0; u < PH_SIZE; u++) for (let x = 0; x < PH_SIZE; x++) {
    t[u * PH_SIZE + x] = Math.cos(((2 * x + 1) * u * Math.PI) / (2 * PH_SIZE));
  }
  return t;
})();

/** 64-bit DCT pHash of an N×N silhouette, returned as a hex string. */
function pHash(sil) {
  // Downsample silhouette (N×N) to PH_SIZE×PH_SIZE by block averaging.
  const g = new Float32Array(PH_SIZE * PH_SIZE);
  const bs = N / PH_SIZE;
  for (let y = 0; y < PH_SIZE; y++) for (let x = 0; x < PH_SIZE; x++) {
    let s = 0;
    for (let yy = 0; yy < bs; yy++) for (let xx = 0; xx < bs; xx++) {
      s += sil[((y * bs + yy) | 0) * N + ((x * bs + xx) | 0)];
    }
    g[y * PH_SIZE + x] = s / (bs * bs);
  }
  // 2D DCT, keep PH_LOW×PH_LOW low-frequency block.
  const rows = new Float32Array(PH_SIZE * PH_SIZE);
  for (let y = 0; y < PH_SIZE; y++) for (let u = 0; u < PH_LOW; u++) {
    let s = 0; for (let x = 0; x < PH_SIZE; x++) s += g[y * PH_SIZE + x] * _dctCos[u * PH_SIZE + x];
    rows[y * PH_SIZE + u] = s;
  }
  const block = new Float32Array(PH_LOW * PH_LOW);
  for (let u = 0; u < PH_LOW; u++) for (let v = 0; v < PH_LOW; v++) {
    let s = 0; for (let y = 0; y < PH_SIZE; y++) s += rows[y * PH_SIZE + u] * _dctCos[v * PH_SIZE + y];
    block[v * PH_LOW + u] = s;
  }
  // Median threshold (skip DC term at 0).
  const vals = Array.from(block.slice(1)).sort((a, b) => a - b);
  const med = vals[vals.length >> 1];
  let hi = 0n, lo = 0n;
  for (let i = 0; i < 64; i++) {
    const bit = block[i] > med ? 1n : 0n;
    if (i < 32) lo |= bit << BigInt(i); else hi |= bit << BigInt(i - 32);
  }
  return hi.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0');
}

function hamming(a, b) {
  let d = 0;
  const ah = BigInt('0x' + a), bh = BigInt('0x' + b);
  let x = ah ^ bh;
  while (x) { d += Number(x & 1n); x >>= 1n; }
  return d;
}

/** Zero-normalized cross-correlation (Pearson) of two equal-length float silhouettes → 0..1. */
function ncc(a, b) {
  const n = a.length;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const xa = a[i] - ma, xb = b[i] - mb;
    num += xa * xb; da += xa * xa; db += xb * xb;
  }
  if (da === 0 || db === 0) return 0;
  const r = num / Math.sqrt(da * db);
  return r > 0 ? r : 0;
}

// ── atlas rendering + cache ───────────────────────────────────────────────────────────────────

/** Rasterize one 0..1-normalized path `d` to an N×N foreground silhouette via sharp. */
async function renderPathSilhouette(d) {
  const SS = 256; // supersample, then maskToSilhouette area-downsamples to N (anti-aliased coverage)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1" width="${SS}" height="${SS}">`
    + `<rect width="1" height="1" fill="white"/><path d="${d}" fill="black"/></svg>`;
  const { data } = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  // black ink on white → foreground mask where dark.
  const mask = new Uint8Array(SS * SS);
  for (let i = 0; i < SS * SS; i++) {
    const l = 0.2126 * data[i * 4] + 0.7152 * data[i * 4 + 1] + 0.0722 * data[i * 4 + 2];
    if (l < 128) mask[i] = 1;
  }
  return maskToSilhouette(mask, SS, SS);
}

function setHash() {
  const h = createHash('sha1');
  for (const { id, d } of iconSourceEntries()) h.update(id + '|' + d + '\n');
  h.update(`v2|N=${N}|ph=${PH_SIZE}/${PH_LOW}`);
  return h.digest('hex').slice(0, 16);
}

/** Encode a silhouette Float32 to an 8-bit PNG (N×N grayscale-in-RGBA) for the disk cache. */
async function silToPng(sil) {
  const buf = Buffer.alloc(N * N * 4);
  for (let i = 0; i < N * N; i++) {
    const v = Math.max(0, Math.min(255, Math.round(sil[i] * 255)));
    buf[i * 4] = v; buf[i * 4 + 1] = v; buf[i * 4 + 2] = v; buf[i * 4 + 3] = 255;
  }
  return sharp(buf, { raw: { width: N, height: N, channels: 4 } }).png().toBuffer();
}

async function pngToSil(pngBuf) {
  const { data } = await sharp(pngBuf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const sil = new Float32Array(N * N);
  for (let i = 0; i < N * N; i++) sil[i] = data[i * 4] / 255;
  return sil;
}

let _atlasCache = null;

/**
 * Build (or load from cache) the rendered icon atlas. Cached in .state/icon-atlas/ keyed by a
 * hash of the icon set — rebuilds automatically when native-icons/notes-icons change.
 * @returns {Promise<{ hash, entries: Array<{ id, name, d, viewBox, sil:Float32Array, phash, aspect, fillFrac }> }>}
 */
export async function loadIconAtlas(opts = {}) {
  const hash = setHash();
  if (_atlasCache && _atlasCache.hash === hash && !opts.force) return _atlasCache;
  const srcById = new Map(iconSourceEntries().map((e) => [e.id, e]));

  // Try disk cache.
  if (!opts.force && existsSync(MANIFEST_PATH)) {
    try {
      const man = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
      if (man.hash === hash && Array.isArray(man.entries)) {
        const entries = [];
        for (const m of man.entries) {
          const png = join(ATLAS_DIR, m.bitmap);
          if (!existsSync(png)) { entries.length = 0; break; }
          const sil = await pngToSil(readFileSync(png));
          const src = srcById.get(m.id);
          entries.push({ id: m.id, name: m.name, d: src?.d, viewBox: src?.viewBox,
            sil, phash: m.phash, aspect: m.aspect, fillFrac: m.fillFrac });
        }
        if (entries.length) { _atlasCache = { hash, entries }; return _atlasCache; }
      }
    } catch { /* fall through to rebuild */ }
  }

  // Rebuild.
  mkdirSync(ATLAS_DIR, { recursive: true });
  const entries = [];
  const manEntries = [];
  for (const { id, d, viewBox } of iconSourceEntries()) {
    let s;
    try { s = await renderPathSilhouette(d); } catch { s = null; }
    if (!s) continue;
    const phash = pHash(s.sil);
    const name = iconRoleName(id);
    const bitmap = `${id}.png`;
    try { writeAtomic(join(ATLAS_DIR, bitmap), await silToPng(s.sil)); } catch { /* best effort */ }
    entries.push({ id, name, d, viewBox, sil: s.sil, phash, aspect: s.aspect, fillFrac: s.fillFrac });
    manEntries.push({ id, name, bitmap, phash, aspect: s.aspect, fillFrac: s.fillFrac });
  }
  try {
    writeAtomic(MANIFEST_PATH, JSON.stringify({ hash, builtAt: new Date().toISOString(), entries: manEntries }, null, 2));
  } catch { /* best effort */ }
  _atlasCache = { hash, entries };
  return _atlasCache;
}

// ── public: matchIcon ─────────────────────────────────────────────────────────────────────────

const DEFAULTS = {
  accept: 0.86,       // silhouette NCC accept gate (spec §5.3 ~0.88; slightly relaxed, empirically tuned)
  phashMax: 22,       // pHash Hamming prefilter (keep candidates within this distance)
  topK: 40,           // fine-rank this many pHash-nearest entries (≥ atlas size ⇒ score everything)
  aspectTol: 0.45,    // ±45% aspect band for a soft prefilter (lenient — trims are noisy)
};

/**
 * Match a candidate icon region against the canonical native-icon atlas.
 *
 * @param {string|Buffer|{data,width,height,channels}} input — image path, PNG buffer, or decoded RGBA.
 * @param {{x,y,w,h}} box — the icon region. Units auto-detected (≤1 ⇒ fraction, else px); override
 *   with opts.units:'px'|'fraction'|'pct'.
 * @param {object} [opts] — { atlas, accept, phashMax, topK, units }.
 * @returns {Promise<{matched:boolean, id?, name?, path?, viewBox?, score:number, box, candidates?}>}
 *   On a hit: { matched:true, id, name, path (canonical 0..1 d-string), viewBox, score, box }.
 *   On a miss: { matched:false, score, box, candidates } (caller falls back to lib/vectorize.mjs).
 *   Never throws.
 */
export async function matchIcon(input, box, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const fail = (score = 0, extra = {}) => ({ matched: false, score, box, ...extra });
  try {
    const atlas = opts.atlas || await loadIconAtlas();
    const img = await toRGBA(input);
    const rb = resolveBox(box, img.width, img.height, opts);
    if (rb.w < 3 || rb.h < 3) return fail();

    // Crop the region into a tight RGBA buffer.
    const crop = Buffer.alloc(rb.w * rb.h * 4);
    for (let y = 0; y < rb.h; y++) {
      const srcRow = ((rb.y + y) * img.width + rb.x) * 4;
      img.data.copy(crop, y * rb.w * 4, srcRow, srcRow + rb.w * 4);
    }
    const mask = foregroundMask({ data: crop }, rb.w, rb.h);
    if (!mask) return fail();
    const cand = maskToSilhouette(mask, rb.w, rb.h);
    if (!cand) return fail();
    const candHash = pHash(cand.sil);

    // Prefilter by pHash Hamming, then keep topK nearest.
    const ranked = atlas.entries
      .map((e) => ({ e, hd: hamming(candHash, e.phash) }))
      .sort((a, b) => a.hd - b.hd)
      .slice(0, cfg.topK);

    // Fine-rank by silhouette NCC, with a soft aspect penalty + filled/outline fill-fraction tie-break.
    let best = null;
    const scored = [];
    for (const { e, hd } of ranked) {
      let score = ncc(cand.sil, e.sil);
      const aspectRatio = cand.aspect > 0 && e.aspect > 0
        ? Math.min(cand.aspect, e.aspect) / Math.max(cand.aspect, e.aspect) : 1;
      if (aspectRatio < 1 - cfg.aspectTol) score *= 0.9;   // mild penalty only
      // Fill-fraction agreement helps separate filled vs outline variants of the same glyph.
      const fillPenalty = 1 - Math.min(0.12, Math.abs(cand.fillFrac - e.fillFrac) * 0.4);
      score *= fillPenalty;
      scored.push({ id: e.id, name: e.name, score: +score.toFixed(4), hd, aspect: +e.aspect.toFixed(2) });
      if (!best || score > best.score) best = { e, score };
    }
    scored.sort((a, b) => b.score - a.score);
    if (!best) return fail(0, { candidates: scored.slice(0, 5) });

    if (best.score >= cfg.accept) {
      return {
        matched: true,
        id: best.e.id,
        name: best.e.name,
        path: best.e.d,
        viewBox: best.e.viewBox,
        score: +best.score.toFixed(4),
        box,
        candidates: scored.slice(0, 5),
      };
    }
    return fail(+best.score.toFixed(4), { candidates: scored.slice(0, 5) });
  } catch (err) {
    return { matched: false, score: 0, box, error: String(err && err.message || err) };
  }
}

export default { loadIconAtlas, matchIcon, iconRoleName };
