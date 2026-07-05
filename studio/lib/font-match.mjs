// lib/font-match.mjs — silhouette-based FONT MATCHING against a reference crop.
//
// The owner flags wrong font choices constantly: the reader (vision extraction) localizes text
// well but guesses fontFamily poorly ("that's a serif" → Georgia everywhere, or nothing at all).
// This module settles the question EMPIRICALLY: render the layer's own text in each candidate
// stack via the real export renderer (lib/self-vision.mjs renderCompPng — the same headless
// Chrome that produces the final PNG, so what we score is what ships), crop the same box from
// both the reference and each probe render, and compare downsampled grayscale SILHOUETTES with
// shift-tolerant normalized cross-correlation. The winning family is the one whose glyph shapes
// actually reproduce the reference's ink pattern — no vision model in the loop.
//
// CANDIDATES follow lib/elements.mjs FONT_SUGGEST philosophy: only fonts installed effectively
// everywhere, each value a single family name (never a comma list — five renderers quote
// style.fontFamily inconsistently and a comma list collapses to one invalid family; spaced
// single names like 'Bradley Hand' are fine, see the FONT_SUGGEST note). '' means "leave
// fontFamily unset" → the base clean-sans stack (Inter server-side).
//
// SIZE NORMALIZATION (the bug that made a mono "win" on a serif headline): the reader's
// fontSize is often wrong (052: read 60, real ≈83), which changes LINE WRAPPING per family —
// an overflowing probe's sheer ink mass out-correlates the honest ones. So the target crop's
// row-ink profile is analyzed into line BANDS (thickness ≈ 0.72em → fontSize, band pitch →
// lineHeight), and every candidate is also rendered at that estimated size; a family scores
// the max across the read-size and estimated-size probes. Verified on 052: Georgia 0.47→0.83
// while Menlo stays ~0.43 — the false winner disappears once sizes are honest.
//
// Contract:
//   matchFont(referencePath, textLayer, canvas, opts?) →
//     { fontFamily, confidence, tried:[{family,score}], error? }
//     fontFamily: winning family ('' = base sans, meaning CLEAR fontFamily), or null when the
//     top-2 margin is below the confidence threshold (keep the reader's choice).
//   matchFontsForScene(scenePath, referencePath, { roles }) → patches scene JSON in place
//     (style.fontFamily on confident wins) and returns a per-layer summary.
//
// Renders are cached under .state/font-match/ keyed by everything that affects the probe
// (text, family, size, weight, color, bg, box, canvas) so repeat runs are ~free.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPng, downsampleGray } from '../scripts/pixel-diff.mjs';
import { renderCompPng } from './self-vision.mjs';
import { sampleRegionStats } from './layout-extract.mjs';

const STATE = join(dirname(fileURLToPath(import.meta.url)), '..', '.state', 'font-match');

// ── candidate stacks ─────────────────────────────────────────────────────────────────────────
// One representative per visual class (grotesk / serif display / serif body / mono / condensed /
// heavy display / script / rounded) — enough spread to catch "wrong class" errors (the complaint)
// without exploding render count. All verified installed via fc-list / system_profiler at runtime.
export const DEFAULT_CANDIDATES = [
  '',                       // base grotesk (Inter/system stack) — FONT_SUGGEST.sans
  'Georgia',                // serif display — FONT_SUGGEST.display
  'Times New Roman',        // serif body
  'Menlo',                  // mono — FONT_SUGGEST.mono
  'Arial Narrow',           // condensed grotesk
  'Impact',                 // heavy condensed display — FONT_PAIR.display
  'Bradley Hand',           // script/handwritten — FONT_SUGGEST.hand
  'Arial Rounded MT Bold',  // rounded display
];

/** Margin between the top-2 NCC scores below which we refuse to override the reader's choice.
 *  With size-normalized probes, margins between font CLASSES (serif vs sans vs script) land
 *  ≥ ~0.1 in practice (052 headline: Georgia 0.83 vs Impact 0.60); margins within a class
 *  (Georgia vs Times) can dip lower — a sub-threshold winner is a coin flip we don't take. */
export const DEFAULT_MIN_CONFIDENCE = 0.03;

// ── installed-font verification (cached to disk — fc-list is fast, system_profiler is not) ────

let _installedLower; // undefined = not probed; null = unverifiable (keep all); string = list

function installedFontListLower() {
  if (_installedLower !== undefined) return _installedLower;
  mkdirSync(STATE, { recursive: true });
  const cacheFile = join(STATE, 'installed-fonts.txt');
  let txt = null;
  try {
    if (existsSync(cacheFile)) txt = readFileSync(cacheFile, 'utf8');
  } catch { /* re-probe */ }
  if (!txt) {
    try {
      const fc = spawnSync('fc-list', [':', 'family'], { timeout: 30_000, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
      if (fc.status === 0 && String(fc.stdout || '').trim()) txt = fc.stdout;
    } catch { /* fall through */ }
    if (!txt) {
      try {
        const sp = spawnSync('system_profiler', ['SPFontsDataType'], { timeout: 120_000, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
        if (sp.status === 0 && String(sp.stdout || '').trim()) txt = sp.stdout;
      } catch { /* fall through */ }
    }
    if (txt) { try { writeFileSync(cacheFile, txt); } catch { /* cache is best-effort */ } }
  }
  _installedLower = txt ? txt.toLowerCase() : null;
  return _installedLower;
}

/** Is `family` installed? '' (base stack) is always available. When the font list can't be
 *  probed at all we return true — better to score an occasionally-missing candidate (it just
 *  renders in the fallback sans and loses) than to silently shrink the pool. */
export function fontInstalled(family) {
  if (!family) return true;
  const list = installedFontListLower();
  if (list === null) return true;
  return list.includes(String(family).toLowerCase());
}

/** The candidate families that are actually installed on this machine. */
export function availableCandidates(candidates = DEFAULT_CANDIDATES) {
  return candidates.filter((f) => fontInstalled(f));
}

// ── decode + crop helpers ─────────────────────────────────────────────────────────────────────

function md5(s) { return createHash('md5').update(s).digest('hex').slice(0, 16); }

/** Decode any image into pixel-diff's {width,height,gray}. Non-PNG (webp/jpeg refs) or exotic
 *  PNGs (palette) are converted once via sips into .state/font-match/ and cached by mtime.
 *  Returns { png, pngPath } or null. */
function decodeImageAny(path) {
  let png = readPng(path);
  if (png) return { png, pngPath: path };
  try {
    const st = statSync(path);
    const out = join(STATE, `ref-${md5(`${resolve(path)}:${st.mtimeMs}:${st.size}`)}.png`);
    if (!existsSync(out)) {
      mkdirSync(STATE, { recursive: true });
      const r = spawnSync('sips', ['-s', 'format', 'png', path, '--out', out], { timeout: 30_000 });
      if (r.status !== 0) return null;
    }
    png = readPng(out);
    return png ? { png, pngPath: out } : null;
  } catch {
    return null;
  }
}

/** Crop a decoded {width,height,gray} to a layer box given in CANVAS coordinates — the image may
 *  be a different native resolution than the canvas (refs often are), so the box is scaled. */
function cropGray(png, box, canvas) {
  const sx = png.width / Math.max(1, canvas.w);
  const sy = png.height / Math.max(1, canvas.h);
  const x0 = Math.max(0, Math.min(png.width - 1, Math.round(box.x * sx)));
  const y0 = Math.max(0, Math.min(png.height - 1, Math.round(box.y * sy)));
  const x1 = Math.max(x0 + 1, Math.min(png.width, Math.round((box.x + box.w) * sx)));
  const y1 = Math.max(y0 + 1, Math.min(png.height, Math.round((box.y + box.h) * sy)));
  const w = x1 - x0, h = y1 - y0;
  if (w < 4 || h < 4) return null;
  const gray = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const src = (y0 + y) * png.width + x0;
    gray.set(png.gray.subarray(src, src + w), y * w);
  }
  return { width: w, height: h, gray };
}

// ── silhouette scoring ────────────────────────────────────────────────────────────────────────

/** Zero-mean NCC between two equal-size grids over the overlap at shift (dx,dy). */
function nccAt(a, b, cols, rows, dx, dy) {
  const x0 = Math.max(0, dx), x1 = Math.min(cols, cols + dx);
  const y0 = Math.max(0, dy), y1 = Math.min(rows, rows + dy);
  const n = (x1 - x0) * (y1 - y0);
  if (n < 8) return 0;
  let sa = 0, sb = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) { sa += a[y * cols + x]; sb += b[(y - dy) * cols + (x - dx)]; }
  }
  const ma = sa / n, mb = sb / n;
  let cov = 0, va = 0, vb = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const da = a[y * cols + x] - ma;
      const db = b[(y - dy) * cols + (x - dx)] - mb;
      cov += da * db; va += da * da; vb += db * db;
    }
  }
  if (va < 1e-9 || vb < 1e-9) return 0; // flat crop — no silhouette to correlate
  return cov / Math.sqrt(va * vb);
}

/** Shift-tolerant silhouette similarity between two crops ({width,height,gray}), −1..1.
 *  Both are area-averaged to a ~`cols`-wide grid (aspect from crop A) — NCC is invariant to the
 *  brightness/contrast offset between the sampled probe bg and the real reference bg, and the
 *  ±2-cell shift search absorbs baseline/centering drift between renderer and reference. */
export function silhouetteScore(cropA, cropB, { cols = 48 } = {}) {
  if (!cropA || !cropB) return 0;
  const rows = Math.max(6, Math.min(120, Math.round(cols * (cropA.height / Math.max(1, cropA.width)))));
  const ga = downsampleGray(cropA, cols, rows);
  const gb = downsampleGray(cropB, cols, rows);
  let best = -1;
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const s = nccAt(ga, gb, cols, rows, dx, dy);
      if (s > best) best = s;
    }
  }
  return best;
}

// ── probe rendering (cached) ──────────────────────────────────────────────────────────────────

/** Median luminance of a crop's border ring — local-bg estimate (text lives in the middle). */
function borderLum(crop) {
  const vals = [];
  const { width: w, height: h, gray } = crop;
  for (let x = 0; x < w; x++) { vals.push(gray[x], gray[(h - 1) * w + x]); }
  for (let y = 0; y < h; y++) { vals.push(gray[y * w], gray[y * w + (w - 1)]); }
  vals.sort((a, b) => a - b);
  return vals[Math.floor(vals.length / 2)] ?? 0.5;
}

function lumToHex(lum) {
  const hx = Math.round(Math.max(0, Math.min(1, lum)) * 255).toString(16).padStart(2, '0');
  return `#${hx}${hx}${hx}`;
}

/** Horizontal ink bands (text lines) of a crop: rows where ≥2% of pixels differ from the local
 *  bg luminance by >0.2, merged across ≤3px gaps (glyph interiors), specks dropped. Native px. */
function inkBands(crop, bgLum) {
  const { width: w, height: h, gray } = crop;
  const minInk = Math.max(2, Math.round(w * 0.02));
  const bands = [];
  let start = -1;
  for (let y = 0; y < h; y++) {
    let c = 0;
    for (let x = 0; x < w; x++) { if (Math.abs(gray[y * w + x] - bgLum) > 0.2) c++; }
    const on = c >= minInk;
    if (on && start < 0) start = y;
    if (!on && start >= 0) { bands.push([start, y]); start = -1; }
  }
  if (start >= 0) bands.push([start, h]);
  const merged = [];
  for (const b of bands) {
    if (merged.length && b[0] - merged[merged.length - 1][1] <= 3) merged[merged.length - 1][1] = b[1];
    else merged.push([b[0], b[1]]);
  }
  return merged.filter(([a, b]) => b - a >= 6);
}

/** Estimate the reference's REAL fontSize/lineHeight from the target crop's ink bands — the
 *  reader's fontSize is frequently off, and a wrong size changes per-family line wrapping (the
 *  false-mono-win failure mode; see module header). Band thickness ≈ 0.72em (asc→desc for mixed
 *  case, ≈cap-height for all-caps); pitch between band tops → lineHeight. Box coords are canvas
 *  space, the crop is native reference px — scale back. Returns null when no legible bands. */
function estimateSizeFromTarget(target, box, canvas, readFs, readLh) {
  const bands = inkBands(target, borderLum(target));
  if (!bands.length) return null;
  const toCanvas = (box.h > 0 && target.height > 0) ? box.h / target.height : 1;
  const heights = bands.map(([a, b]) => (b - a) * toCanvas).sort((x, y) => x - y);
  const thickness = heights[Math.floor(heights.length / 2)];
  const fontSize = Math.max(12, Math.min(Math.round(thickness / 0.72), Math.round(readFs * 2.2)));
  if (fontSize < readFs * 0.6) return null; // implausibly small bands — noise, keep read size
  let lineHeight = readLh;
  if (bands.length >= 2) {
    const pitches = [];
    for (let i = 1; i < bands.length; i++) pitches.push((bands[i][0] - bands[i - 1][0]) * toCanvas);
    pitches.sort((x, y) => x - y);
    const pitch = pitches[Math.floor(pitches.length / 2)];
    lineHeight = Math.round(Math.max(0.8, Math.min(1.8, pitch / fontSize)) * 100) / 100;
  }
  return { fontSize, lineHeight, lines: bands.length };
}

/** Render the probe doc (local bg + the layer's own text in `family`, at `variant`'s
 *  fontSize/lineHeight) and return the PNG path, cached under .state/font-match/ keyed by every
 *  render-affecting input. Null on render failure. */
function renderProbe(layer, family, canvas, bgHex, variant) {
  const style = { ...(layer.style || {}) };
  if (family) style.fontFamily = family; else delete style.fontFamily;
  if (variant) { style.fontSize = variant.fontSize; style.lineHeight = variant.lineHeight; }
  const key = md5(JSON.stringify({
    v: 1, text: layer.text, family, canvas: { w: canvas.w, h: canvas.h },
    box: layer.box, type: layer.type, autoH: !!layer.autoH, bg: bgHex, style,
  }));
  mkdirSync(STATE, { recursive: true });
  const cached = join(STATE, `render-${key}.png`);
  if (existsSync(cached)) return cached;
  const doc = {
    id: `font-match-${key}`,
    name: `font-match probe ${family || 'base'}`,
    canvas: { w: canvas.w, h: canvas.h },
    layers: [
      { id: 'bg', type: 'shape', role: 'base', box: { x: 0, y: 0, w: canvas.w, h: canvas.h }, style: { background: bgHex } },
      { id: 'probe', type: layer.type === 'badge' ? 'badge' : 'text', role: layer.role || 'text', text: layer.text, box: { ...layer.box }, autoH: !!layer.autoH, style },
    ],
  };
  const out = renderCompPng(doc);
  if (!out) return null;
  try { copyFileSync(out, cached); return cached; } catch { return out; }
}

// ── public API ────────────────────────────────────────────────────────────────────────────────

/**
 * Match the font of one text layer against the reference image.
 *
 * @param {string} referencePath — the reference ad image (png/webp/jpeg)
 * @param {object} textLayer — { text, box:{x,y,w,h}, style:{fontSize,fontWeight,color,...}, type?, role? }
 *                             box in CANVAS coordinates
 * @param {{w:number,h:number}} canvas — canvas the box coordinates live in
 * @param {object} [opts] — { candidates?, minConfidence?, cols? }
 * @returns {Promise<{fontFamily:string|null, confidence:number, tried:{family:string,score:number}[], error?:string}>}
 *   fontFamily '' = confidently the base sans (clear any fontFamily); null = not confident.
 */
export async function matchFont(referencePath, textLayer, canvas, opts = {}) {
  const minConfidence = opts.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const fail = (error) => ({ fontFamily: null, confidence: 0, tried: [], error });

  const text = String(textLayer?.text || '').trim();
  if (!text) return fail('layer has no text');
  const box = textLayer.box;
  if (!box || !(box.w > 0) || !(box.h > 0)) return fail('layer has no box');
  if (!canvas || !(canvas.w > 0) || !(canvas.h > 0)) return fail('bad canvas');

  const ref = decodeImageAny(referencePath);
  if (!ref) return fail(`could not decode reference: ${referencePath}`);
  const target = cropGray(ref.png, box, canvas);
  if (!target) return fail('reference crop degenerate (box too small or off-canvas)');

  // Local background under the text — dominant color of the region (text ink is the minority);
  // falls back to the crop's border-median gray if the sampler can't read the region.
  let bgHex = null;
  try {
    const stats = sampleRegionStats(ref.pngPath, {
      x: (box.x / canvas.w) * 100, y: (box.y / canvas.h) * 100,
      w: (box.w / canvas.w) * 100, h: (box.h / canvas.h) * 100,
    });
    if (stats?.hex) bgHex = stats.hex;
  } catch { /* fall back below */ }
  if (!bgHex) bgHex = lumToHex(borderLum(target));

  // Size variants: always the reader's size; plus a ±12% scan around the target-measured size
  // (see estimateSizeFromTarget — wrong read sizes wreck per-family wrapping). The FINE scan
  // matters: families have different metrics, so any single size sits ON a wrap boundary for
  // some of them, and wrap boundaries are sharp (052: Georgia@83 wraps a word early → 0.50,
  // Georgia@78 wraps like the reference → 0.83 — the win/lose gap lives inside a 6% size step).
  // A family's score is its best across variants — an honest size can only help, never hurt.
  const readFs = textLayer.style?.fontSize || 40;
  const readLh = textLayer.style?.lineHeight || 1.2;
  const variants = [{ fontSize: readFs, lineHeight: readLh }];
  const est = estimateSizeFromTarget(target, box, canvas, readFs, readLh);
  if (est) {
    for (const k of [0.88, 0.94, 1.0, 1.06, 1.12]) {
      const fs = Math.round(est.fontSize * k);
      const dup = variants.some((v) => Math.abs(v.fontSize - fs) / fs < 0.03 && Math.abs(v.lineHeight - est.lineHeight) < 0.08);
      if (!dup) variants.push({ fontSize: fs, lineHeight: est.lineHeight });
    }
  }

  const candidates = availableCandidates(opts.candidates || DEFAULT_CANDIDATES);
  const memo = new Map(); // family|fs|lh → score (dedupes coarse scan vs refinement probes)
  const scoreAt = (family, variant) => {
    const key = `${family}|${variant.fontSize}|${variant.lineHeight}`;
    if (memo.has(key)) return memo.get(key);
    let score = null;
    const probePath = renderProbe(textLayer, family, canvas, bgHex, variant);
    if (probePath) {
      const probePng = readPng(probePath);
      const probeCrop = probePng ? cropGray(probePng, box, canvas) : null;
      if (probeCrop) score = silhouetteScore(target, probeCrop, { cols: opts.cols || 48 });
    }
    memo.set(key, score);
    return score;
  };

  // coarse scan — every candidate at every size variant, best per family
  const tried = [];
  for (const family of candidates) {
    let best = null;
    for (const variant of variants) {
      const score = scoreAt(family, variant);
      if (score != null && (!best || score > best.score)) {
        best = { score, fontSize: variant.fontSize, lineHeight: variant.lineHeight };
      }
    }
    if (best) tried.push({ family, ...best });
  }
  if (!tried.length) return fail('no candidate could be rendered (headless Chrome/qlmanage unavailable?)');
  tried.sort((a, b) => b.score - a.score);

  // refine the top families with a 2-round ±size hill-climb: wrap boundaries are so sharp that
  // a family's honest wrap can sit BETWEEN any fixed grid's points (052 caption: Georgia@57 =
  // 0.80 while both neighbors 55/59 score ≈0.64) — a couple of local steps recovers it.
  for (let i = 0; i < Math.min(3, tried.length); i++) {
    const t = tried[i];
    let step = Math.max(1, Math.round(t.fontSize * 0.03));
    for (let round = 0; round < 2 && step >= 1; round++) {
      for (const fs of [t.fontSize - step, t.fontSize + step]) {
        if (fs < 12) continue;
        const score = scoreAt(t.family, { fontSize: fs, lineHeight: t.lineHeight });
        if (score != null && score > t.score) { t.score = score; t.fontSize = fs; }
      }
      step = Math.floor(step / 2);
    }
  }
  tried.sort((a, b) => b.score - a.score);

  const ranked = tried.map((t) => ({ family: t.family, score: Math.round(t.score * 10_000) / 10_000, fontSize: t.fontSize }));
  const confidence = ranked.length >= 2
    ? Math.round((ranked[0].score - ranked[1].score) * 10_000) / 10_000
    : 0;
  const fontFamily = confidence >= minConfidence ? ranked[0].family : null;
  const out = { fontFamily, confidence, tried: ranked };
  if (est) out.sizeHint = est; // measured { fontSize, lineHeight, lines } — reader-QA signal
  return out;
}

/**
 * Batch: match fonts for every text layer of a scene whose role is in `roles`, patch the scene
 * JSON IN PLACE (style.fontFamily set on confident wins; deleted when the base sans wins), and
 * return a summary. Layers where the match is unconfident keep the reader's choice untouched.
 */
export async function matchFontsForScene(scenePath, referencePath, opts = {}) {
  const roles = opts.roles || ['headline', 'subhead', 'body', 'caption', 'cta'];
  let scene;
  try {
    scene = JSON.parse(readFileSync(scenePath, 'utf8'));
  } catch (e) {
    return { ok: false, error: `could not read scene: ${e.message}`, scenePath, referencePath, patched: 0, layers: [] };
  }
  const canvas = scene.canvas;
  if (!canvas || !(canvas.w > 0) || !(canvas.h > 0)) {
    return { ok: false, error: 'scene has no canvas', scenePath, referencePath, patched: 0, layers: [] };
  }

  // flatten one level of groups — scene reads occasionally nest text in groups
  const flat = [];
  const collect = (nodes) => {
    for (const l of Array.isArray(nodes) ? nodes : []) {
      if (!l) continue;
      if (l.type === 'group' && Array.isArray(l.children)) collect(l.children);
      else flat.push(l);
    }
  };
  collect(scene.layers);

  const summary = { ok: true, scenePath, referencePath, patched: 0, layers: [] };
  for (const layer of flat) {
    const isTextish = (layer.type === 'text' || layer.type === 'badge') && String(layer.text || '').trim();
    if (!isTextish || !roles.includes(layer.role)) continue;
    const previous = layer.style?.fontFamily ?? null;
    const res = await matchFont(referencePath, layer, canvas, opts);
    let patched = false;
    if (res.fontFamily !== null && res.fontFamily !== previous && !(res.fontFamily === '' && previous == null)) {
      layer.style = layer.style || {};
      if (res.fontFamily === '') delete layer.style.fontFamily;
      else layer.style.fontFamily = res.fontFamily;
      patched = true;
      summary.patched++;
    }
    summary.layers.push({
      id: layer.id, role: layer.role, text: String(layer.text).slice(0, 60),
      previous, fontFamily: res.fontFamily, confidence: res.confidence, patched,
      tried: res.tried, ...(res.error ? { error: res.error } : {}),
    });
  }

  if (summary.patched > 0) {
    try {
      writeFileSync(scenePath, `${JSON.stringify(scene, null, 2)}\n`);
    } catch (e) {
      summary.ok = false;
      summary.error = `matched but could not write scene: ${e.message}`;
    }
  }
  return summary;
}
