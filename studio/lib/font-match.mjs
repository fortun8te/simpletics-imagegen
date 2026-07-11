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

// PACK MATCHING (S8, COPY-ENGINE-V2 §3.6): matchFontAll() below extends the same silhouette
// idea to the REAL font library — the ~60-family Google Fonts pack from scripts/fetch-fonts.mjs
// (manifest lib/fonts-manifest.json) plus curated system fonts. Two-phase to stay bounded:
// (1) one probe SHEET with one representative per visual class picks the top 2-3 classes,
// (2) exhaustive scoring only within those classes' manifest families, then a weight/size
// refinement of the leaders. All candidates of a phase render on ONE headless-Chrome page
// (a vertical sheet of tiles) instead of one Chrome spawn per candidate — 3-4 spawns per crop
// total, ≤ ~40 candidate tiles. Results cached by (crop hash, manifest hash, text, opts).

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPng, downsampleGray } from '../scripts/pixel-diff.mjs';
import { renderCompPng } from './self-vision.mjs';
import { sampleRegionStats } from './layout-extract.mjs';
import { loadFontsManifest, packFontFaceCss } from './font-faces.mjs';

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

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// PACK MATCHING — matchFontAll / metricFallback (S8). See module header for the design.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/** One representative per visual class — phase-1 class filter renders ONLY these. */
export const CLASS_REPS = {
  grotesk: 'Inter',
  geometric: 'Poppins',
  humanist: 'Open Sans',
  condensed: 'Oswald',
  'heavy-display': 'Archivo Black',
  'serif-display': 'Playfair Display',
  'serif-body': 'Lora',
  mono: 'JetBrains Mono',
  script: 'Pacifico',
};

// ── headless Chrome (same pattern as lib/self-vision.mjs, but we screenshot RAW HTML sheets —
//    renderCompPng only takes DesignDocs and spawns once per doc, too slow for 40 candidates) ──

const SHEET_CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
];

let _sheetChrome; // undefined = unprobed, null = missing, string = binary path

function findSheetChrome() {
  if (_sheetChrome !== undefined) return _sheetChrome;
  for (const p of SHEET_CHROME_CANDIDATES) {
    if (existsSync(p)) { _sheetChrome = p; return p; }
  }
  if (platform() !== 'darwin') {
    for (const cmd of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
      try {
        const r = spawnSync('which', [cmd], { timeout: 5_000 });
        const p = r.status === 0 ? String(r.stdout || '').trim() : '';
        if (p) { _sheetChrome = p; return p; }
      } catch { /* keep probing */ }
    }
  }
  _sheetChrome = null;
  return null;
}

/** Screenshot an HTML string at exactly (w,h) CSS px. Returns PNG path or null. Cached by
 *  content hash — identical sheets (same candidates, same text) never re-render. */
function screenshotHtml(html, w, h) {
  const chrome = findSheetChrome();
  if (!chrome) return null;
  mkdirSync(STATE, { recursive: true });
  const key = md5(`${w}x${h}:${html}`);
  const pngPath = join(STATE, `sheet-${key}.png`);
  if (existsSync(pngPath)) return pngPath;
  const htmlPath = join(STATE, `sheet-${key}.html`);
  try {
    writeFileSync(htmlPath, html);
    const r = spawnSync(chrome, [
      '--headless', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
      '--force-device-scale-factor=1', '--allow-file-access-from-files',
      `--window-size=${Math.max(1, Math.round(w))},${Math.max(1, Math.round(h))}`,
      `--screenshot=${pngPath}`,
      `file://${htmlPath}`,
    ], { timeout: 30_000 });
    if (r.status !== 0 || !existsSync(pngPath)) return null;
    return pngPath;
  } catch {
    return null;
  }
}

// ── crop analysis helpers ─────────────────────────────────────────────────────────────────────

/** Normalize polarity: return { crop, inverted } where the crop's ink is DARK on a LIGHT bg
 *  (inverted=true when the reference was light-on-dark) — the crop-analysis helpers all assume
 *  dark ink. `inverted` is remembered so PROBES render in the reference's ORIGINAL polarity:
 *  white-on-dark text optically blooms (antialiasing spreads the bright side), and scoring a
 *  black-on-white probe against an inverted light-on-dark target systematically prefers one
 *  weight step too bold (corpus 042: clearly-regular body text matched @700). Rendering the
 *  probe white-on-black too reproduces the bloom and cancels the bias. */
function normalizeInkPolarity(crop) {
  const bg = borderLum(crop);
  const { gray } = crop;
  let dark = 0, light = 0;
  for (let i = 0; i < gray.length; i++) {
    const d = gray[i] - bg;
    if (d < -0.2) dark++;
    else if (d > 0.2) light++;
  }
  if (light <= dark) return { crop, inverted: false };
  // Invert in LINEAR light, not perceptual: white-on-dark strokes carry a bright antialias halo
  // that a naive (1−g) inversion turns into dark "ink", fattening every stroke ~a weight step
  // (corpus 042: regular body text matched @700). Linearize (γ2.2) → invert → re-encode keeps
  // halo pixels light, so apparent stroke width survives the polarity flip honestly.
  const inv = new Float32Array(gray.length);
  for (let i = 0; i < gray.length; i++) {
    inv[i] = (1 - gray[i] ** 2.2) ** (1 / 2.2);
  }
  return { crop: { width: crop.width, height: crop.height, gray: inv }, inverted: true };
}

// (Probes always render dark-on-light: Chrome's antialias blending is symmetric enough that a
// light-on-dark probe is the exact inverse of the dark-on-light one, and zero-mean NCC is
// negation-invariant — verified empirically: rendering probes in the reference's polarity
// changed no score by even 1e-4. The reference-side bloom is handled in normalizeInkPolarity.)

/** Ink bounding box of a (polarity-normalized) crop: pixels darker than bg−0.2. Null if blank. */
function inkBBox(crop) {
  const { width: w, height: h, gray } = crop;
  const bg = borderLum(crop);
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (gray[y * w + x] < bg - 0.2) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0 || x1 - x0 < 3 || y1 - y0 < 3) return null;
  return { x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

function subCrop(crop, x0, y0, w, h) {
  const W = crop.width, H = crop.height;
  x0 = Math.max(0, Math.min(W - 1, Math.round(x0)));
  y0 = Math.max(0, Math.min(H - 1, Math.round(y0)));
  w = Math.max(1, Math.min(W - x0, Math.round(w)));
  h = Math.max(1, Math.min(H - y0, Math.round(h)));
  const gray = new Float32Array(w * h);
  for (let y = 0; y < h; y++) gray.set(crop.gray.subarray((y0 + y) * W + x0, (y0 + y) * W + x0 + w), y * w);
  return { width: w, height: h, gray };
}

/** Rough stroke-weight hint from the target: median horizontal ink run length / fontSize.
 *  Only a phase-1 prior — phase 3 explores neighbor weights around whatever wins. */
function estimateWeightHint(crop, fontPx) {
  const { width: w, height: h, gray } = crop;
  const bg = borderLum(crop);
  const runs = [];
  const step = Math.max(1, Math.floor(h / 24));
  for (let y = 0; y < h; y += step) {
    let run = 0;
    for (let x = 0; x < w; x++) {
      if (gray[y * w + x] < bg - 0.2) run++;
      else if (run) { if (run < fontPx * 0.4) runs.push(run); run = 0; }
    }
    if (run && run < fontPx * 0.4) runs.push(run);
  }
  if (runs.length < 8) return 700; // too little ink to judge — ads skew bold
  runs.sort((a, b) => a - b);
  const stroke = runs[Math.floor(runs.length / 2)];
  const r = stroke / Math.max(1, fontPx);
  if (r < 0.085) return 400;
  if (r < 0.135) return 700;
  return 900;
}

/** Nearest available weight of a manifest entry to `want` (system entries use `weights`). */
function nearestWeight(entry, want) {
  const ws = (entry.weights && entry.weights.length ? entry.weights : [400]);
  let best = ws[0];
  for (const w of ws) if (Math.abs(w - want) < Math.abs(best - want)) best = w;
  return best;
}

// ── probe sheets: many candidates → ONE Chrome render ────────────────────────────────────────

const SHEET_PAD = 12;

/**
 * Render `tiles` (one per candidate) on a single page and score each against `target`
 * (a polarity-normalized, ink-trimmed crop). Tile geometry mirrors the target: the text is laid
 * out in a box of the target's ink dimensions (scaled by `S`), then the probe region is anchored
 * at the tile's own ink top-left, HEIGHT-normalized: the probe window is the tile's own ink
 * height × the target's aspect ratio, so an error in the estimated render size cancels out
 * (both crops are resampled to the same grid by silhouetteScore) while the WIDTH signal that
 * separates condensed from wide faces survives — a too-wide family overflows the aspect-matched
 * window (glyphs cut off), a too-narrow one leaves dead space, and both lose score.
 * (v1 cropped a fixed target-sized box instead; a 25% fontSize over-estimate — routine for
 * single-line mixed-case crops where the ink band spans ascender→descender — cut off a third of
 * every probe and made the TRUE family score 0.14 on its own sample.)
 * Returns Map(tileId -> score|null).
 */
function scoreTilesAgainstTarget(tiles, target, ctx) {
  const scores = new Map();
  const slots = renderTileSlots(tiles, ctx);
  for (const t of tiles) {
    const got = slots.get(t.id);
    if (!got) { scores.set(t.id, null); continue; }
    const { slot, bb } = got;
    // height-normalized, aspect-matched window anchored at the probe's own ink top-left
    const winW = Math.max(4, Math.round(bb.h * (target.width / Math.max(1, target.height))));
    const probe = subCrop(slot, bb.x0, bb.y0, winW, bb.h);
    scores.set(t.id, silhouetteScore(target, probe, { cols: ctx.cols || 48 }));
  }
  return scores;
}

/** Render tiles onto paginated sheets (ONE Chrome spawn per ≤12k-px-tall page) and return
 *  Map(tileId -> { slot, bb }) — the tile's crop and its ink bbox. Unrenderable/blank tiles
 *  are absent from the map. */
function renderTileSlots(tiles, ctx) {
  const out = new Map();
  if (!tiles.length) return out;
  const { boxW, boxH, fsTile, lineHeight, nowrap } = ctx;
  const slotH = boxH + SHEET_PAD * 2 + Math.ceil(fsTile * 0.7);
  const sheetW = Math.min(2600, Math.max(200, Math.round(nowrap ? boxW * 2.2 + SHEET_PAD * 2 : boxW * 1.35 + SHEET_PAD * 2)));

  const perSheet = Math.max(1, Math.floor(12_000 / slotH));
  for (let page = 0; page * perSheet < tiles.length; page++) {
    const batch = tiles.slice(page * perSheet, (page + 1) * perSheet);
    const needs = [];
    for (const t of batch) {
      if (t.hasFiles) needs.push({ family: t.family, weights: [t.weight] });
    }
    const divs = batch.map((t, i) => {
      const top = i * slotH + SHEET_PAD;
      const widthCss = nowrap ? 'max-content' : `${Math.round(boxW * 1.02)}px`;
      return `<div style="position:absolute;left:${SHEET_PAD}px;top:${top}px;width:${widthCss};` +
        `font-family:'${String(t.family).replace(/'/g, '')}';font-weight:${t.weight};` +
        `font-size:${t.fsTile || fsTile}px;line-height:${lineHeight};color:#000;` +
        `${nowrap ? 'white-space:nowrap;' : ''}font-kerning:normal;` +
        `-webkit-font-smoothing:antialiased;">${escapeHtmlText(ctx.text)}</div>`;
    }).join('\n');
    const html = `<!doctype html><meta charset="utf-8"><style>${packFontFaceCss(needs)}\n` +
      `html,body{margin:0;padding:0;background:#fff}</style>\n<body>${divs}</body>`;
    const png = screenshotHtml(html, sheetW, batch.length * slotH);
    const sheet = png ? readPng(png) : null;
    if (!sheet) continue;
    for (let i = 0; i < batch.length; i++) {
      const slot = subCrop(sheet, 0, i * slotH, sheetW, slotH);
      const bb = inkBBox(slot);
      if (bb) out.set(batch[i].id, { slot, bb });
    }
  }
  return out;
}

function escapeHtmlText(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Render a text sample in one pack/system family to a standalone PNG (white bg, black text).
 * Used by tests (synthesize a known-font crop) and debug side-by-sides. Returns path or null.
 */
export function renderFontSample(family, weight, text, { fontSizePx = 64, lineHeight = 1.2, maxWidth = 1400 } = {}) {
  const needs = [{ family, weights: [weight] }];
  const html = `<!doctype html><meta charset="utf-8"><style>${packFontFaceCss(needs)}\n` +
    `html,body{margin:0;padding:0;background:#fff}</style>\n<body>` +
    `<div style="position:absolute;left:16px;top:16px;width:max-content;max-width:${maxWidth}px;` +
    `font-family:'${String(family).replace(/'/g, '')}';font-weight:${weight};font-size:${fontSizePx}px;` +
    `line-height:${lineHeight};color:#000;-webkit-font-smoothing:antialiased;">${escapeHtmlText(text)}</div></body>`;
  const estW = Math.min(maxWidth + 32, Math.round(String(text).length * fontSizePx * 0.75) + 48);
  const estH = Math.round(fontSizePx * lineHeight * (1 + Math.ceil(String(text).length * fontSizePx * 0.6 / maxWidth))) + 48;
  return screenshotHtml(html, Math.max(200, estW), Math.max(120, estH));
}

// ── matchFontAll ──────────────────────────────────────────────────────────────────────────────

/**
 * Identify the font of a text crop against the WHOLE usable library (Google-Fonts pack manifest
 * + curated system fonts). Two-phase bounded search; see module header.
 *
 * @param {string|object} cropPngOrOpts — crop PNG path, or an opts object carrying `crop`.
 * @param {object} [opts] — {
 *   text:       string  (REQUIRED — the crop's own text; the reader/OCR already has it)
 *   topN:       number  (default 5)
 *   weightHint: number  (skip the stroke-width estimate)
 *   maxTiles:   number  (candidate-render budget, default 40)
 *   debugDir:   string  (write per-phase probe sheets info JSON here)
 * }
 * @returns {Promise<{family:string,weight:number,italic:boolean,score:number,source:string}[]>}
 *   top-N sorted desc — [] when the crop/text is unusable or Chrome is unavailable.
 */
export async function matchFontAll(cropPngOrOpts, opts = {}) {
  const o = typeof cropPngOrOpts === 'string'
    ? { ...opts, crop: cropPngOrOpts }
    : { ...(cropPngOrOpts || {}), ...opts };
  const cropPath = o.crop || o.cropPath || o.path;
  const text = String(o.text || '').trim();
  const topN = o.topN || 5;
  if (!cropPath || !existsSync(cropPath) || !text) return [];

  const { entries, hash: manifestHash } = loadFontsManifest();
  const usable = entries.filter((e) =>
    (e.files && Object.keys(e.files).length) || (e.source === 'system' && fontInstalled(e.family)));
  if (!usable.length) return [];

  // result cache — keyed by everything that affects the outcome
  let cropHash = 'na';
  try { cropHash = md5(readFileSync(cropPath).toString('base64')); } catch { /* keep na */ }
  const cacheKey = md5(JSON.stringify({ v: 6, cropHash, manifestHash, text, topN, wh: o.weightHint || 0 }));
  mkdirSync(STATE, { recursive: true });
  const cacheFile = join(STATE, `all-${cacheKey}.json`);
  if (existsSync(cacheFile)) {
    try { return JSON.parse(readFileSync(cacheFile, 'utf8')); } catch { /* recompute */ }
  }

  // decode → normalize polarity → trim to ink
  const dec = decodeImageAny(cropPath);
  if (!dec) return [];
  const { crop: norm, inverted } = normalizeInkPolarity(dec.png);
  const bb = inkBBox(norm);
  if (!bb) return [];
  const target = subCrop(norm, bb.x0, bb.y0, bb.w, bb.h);

  // measure font size / line pitch from ink bands (same 0.72em model as matchFont)
  const bands = inkBands(target, borderLum(target));
  const heights = bands.map(([a, b]) => b - a).sort((x, y) => x - y);
  const thickness = heights.length ? heights[Math.floor(heights.length / 2)] : target.height;
  // band thickness → em: 0.72 for caps-only (cap height); a single-line band with lowercase
  // spans ascender→descender ≈ 0.98em (with descenders) / 0.76em (without) — the height-
  // normalized probe window forgives the residual error, this just keeps renders close.
  let emFactor = 0.72;
  if (bands.length === 1 && /[a-z]/.test(text)) emFactor = /[gjpqy]/.test(text) ? 0.98 : 0.76;
  const fontPx = Math.max(10, Math.min(500, Math.round(thickness / emFactor)));
  let lineHeight = 1.2;
  if (bands.length >= 2) {
    const pitches = [];
    for (let i = 1; i < bands.length; i++) pitches.push(bands[i][0] - bands[i - 1][0]);
    pitches.sort((x, y) => x - y);
    lineHeight = Math.round(Math.max(0.8, Math.min(1.8, pitches[Math.floor(pitches.length / 2)] / fontPx)) * 100) / 100;
  }
  const nowrap = bands.length <= 1;

  // tile geometry: scale the target's ink box to a friendly render size
  let S = target.width > 720 ? 720 / target.width : 1;
  if (fontPx * S < 14) S = Math.min(4, 14 / fontPx);
  const ctx = {
    text,
    boxW: Math.max(8, Math.round(target.width * S)),
    boxH: Math.max(8, Math.round(target.height * S)),
    fsTile: Math.max(6, Math.round(fontPx * S)),
    lineHeight, nowrap, cols: o.cols || 48,
  };

  const byFamily = new Map(usable.map((e) => [e.family, e]));
  const wHint = o.weightHint || estimateWeightHint(target, fontPx);
  const memo = new Map(); // "family|weight|fs" -> score
  let tilesSpent = 0;
  const budget = o.maxTiles || 40;

  const runPhase = (specs) => {
    const fresh = specs.filter((s) => !memo.has(s.id));
    tilesSpent += fresh.length;
    const scored = scoreTilesAgainstTarget(fresh, target, ctx);
    for (const [id, sc] of scored) memo.set(id, sc);
    return specs.map((s) => ({ ...s, score: memo.get(s.id) ?? null }));
  };
  const spec = (entry, weight, fsTile = null) => ({
    id: `${entry.family}|${weight}|${fsTile || ctx.fsTile}`,
    family: entry.family, weight, fsTile,
    hasFiles: !!(entry.files && Object.keys(entry.files).length),
    source: entry.source || 'google-pack',
  });

  // ── phase 0 (multi-line only): SIZE CALIBRATION. Wrap boundaries are sharp: an fsTile a few
  // percent too big makes every normal-width family wrap a word early while condensed families
  // still fit — condensed then "wins" on wrap shape, not glyph shape (observed on corpus 042:
  // regular-width body text → Barlow Condensed 800). Render the grotesk rep once, compare its
  // measured line thickness to the target's, and correct fsTile before anyone is scored. ──
  if (!nowrap) {
    const calEntry = byFamily.get(CLASS_REPS.grotesk) || usable[0];
    const calTile = spec(calEntry, nearestWeight(calEntry, wHint));
    tilesSpent += 1;
    const got = renderTileSlots([calTile], ctx).get(calTile.id);
    if (got) {
      const pBands = inkBands(got.slot, borderLum(got.slot));
      const pHeights = pBands.map(([a, b]) => b - a).sort((x, y) => x - y);
      const pThick = pHeights.length ? pHeights[Math.floor(pHeights.length / 2)] : 0;
      const expected = thickness * S; // target band thickness in tile px
      if (pThick > 2 && expected > 2) {
        const ratio = expected / pThick;
        if (ratio > 0.7 && ratio < 1.4 && Math.abs(ratio - 1) > 0.03) {
          ctx.fsTile = Math.max(6, Math.round(ctx.fsTile * ratio));
        }
      }
    }
  }

  // ── phase 1: class filter — one representative per class at the hinted weight ──
  const classesPresent = [...new Set(usable.map((e) => e.cls).filter(Boolean))];
  const phase1 = [];
  for (const cls of classesPresent) {
    const rep = byFamily.get(CLASS_REPS[cls]) || usable.find((e) => e.cls === cls);
    if (rep) phase1.push(spec(rep, nearestWeight(rep, wHint)));
  }
  const p1 = runPhase(phase1).filter((r) => r.score != null);
  if (!p1.length) return [];
  p1.sort((a, b) => b.score - a.score);
  const repByFamily = new Map(usable.map((e) => [e.family, e]));
  const clsOf = (fam) => repByFamily.get(fam)?.cls;
  const topClasses = p1.slice(0, 3).map((r) => clsOf(r.family)).filter(Boolean);

  // ── phase 2: every family in the winning classes (budget-capped, best classes first) ──
  const phase2 = [];
  for (const cls of topClasses) {
    for (const e of usable) {
      if (e.cls !== cls) continue;
      const s = spec(e, nearestWeight(e, wHint));
      if (!memo.has(s.id)) phase2.push(s);
      else phase2.push(s); // already scored in phase 1 — free
    }
    if (tilesSpent + phase2.filter((s) => !memo.has(s.id)).length > budget * 0.75) break;
  }
  const p2 = runPhase(phase2);

  // best score so far per family
  const best = new Map(); // family -> { score, weight }
  for (const r of [...p1, ...p2]) {
    if (r.score == null) continue;
    const cur = best.get(r.family);
    if (!cur || r.score > cur.score) best.set(r.family, { score: r.score, weight: r.weight });
  }

  // ── phase 3: refine leaders — neighbor weights, and ±6% size when multi-line (wrap edges) ──
  const leaders = [...best.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, 5);
  const phase3 = [];
  for (const [family, cur] of leaders) {
    const e = byFamily.get(family);
    if (!e) continue;
    const ws = e.weights && e.weights.length ? e.weights : [400];
    const idx = ws.indexOf(cur.weight);
    for (const ni of [idx - 1, idx + 1]) {
      if (ni >= 0 && ni < ws.length) phase3.push(spec(e, ws[ni]));
    }
  }
  if (!nowrap) {
    for (const [family, cur] of leaders.slice(0, 3)) {
      const e = byFamily.get(family);
      for (const k of [0.94, 1.06]) phase3.push(spec(e, cur.weight, Math.round(ctx.fsTile * k)));
    }
  }
  const room = budget - tilesSpent;
  const p3 = runPhase(phase3.slice(0, Math.max(0, room)));
  for (const r of p3) {
    if (r.score == null) continue;
    const cur = best.get(r.family);
    if (!cur || r.score > cur.score) best.set(r.family, { score: r.score, weight: r.weight });
  }

  const out = [...best.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, topN)
    .map(([family, v]) => ({
      family,
      weight: v.weight,
      italic: false, // pack carries normal styles only; shear detection lives in typo-truth
      score: Math.round(v.score * 10_000) / 10_000,
      source: byFamily.get(family)?.source || 'google-pack',
    }));

  try { writeFileSync(cacheFile, `${JSON.stringify(out)}\n`); } catch { /* cache best-effort */ }
  if (o.debugDir) {
    try {
      mkdirSync(o.debugDir, { recursive: true });
      writeFileSync(join(o.debugDir, `match-${cacheKey}.json`), JSON.stringify({
        cropPath, text, fontPx, lineHeight, nowrap, wHint, tilesSpent,
        classes: p1.map((r) => ({ cls: clsOf(r.family), rep: r.family, score: r.score })),
        result: out,
      }, null, 2));
    } catch { /* debug best-effort */ }
  }
  return out;
}

// ── metric substitution ───────────────────────────────────────────────────────────────────────

const METRICS_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '.state', 'font-metrics.json');

/** Measure {xh, adv} for a list of families via probe sheets: per family, row 1 renders "xxxxx"
 *  at 100px (ink height = x-height), row 2 a pangram (ink width ≈ summed advances). Returns
 *  Map(family -> {xh, adv}) — xh in em, adv = mean advance per char in em. */
function measureMetricsSheet(fams /* [{family, weight, hasFiles}] */) {
  const SZ = 100, ROW = 150, PANGRAM = 'the quick brown fox jumps over a lazy dog';
  const out = new Map();
  const perSheet = Math.max(1, Math.floor(12_000 / (ROW * 2)));
  for (let page = 0; page * perSheet < fams.length; page++) {
    const batch = fams.slice(page * perSheet, (page + 1) * perSheet);
    const needs = batch.filter((f) => f.hasFiles).map((f) => ({ family: f.family, weights: [f.weight] }));
    const divs = batch.map((f, i) => {
      const base = `position:absolute;left:16px;white-space:nowrap;color:#000;` +
        `font-family:'${String(f.family).replace(/'/g, '')}';font-weight:${f.weight};font-size:${SZ}px;line-height:1;`;
      return `<div style="${base}top:${i * ROW * 2 + 20}px;">xxxxx</div>` +
        `<div style="${base}top:${i * ROW * 2 + ROW + 20}px;">${PANGRAM}</div>`;
    }).join('\n');
    const html = `<!doctype html><meta charset="utf-8"><style>${packFontFaceCss(needs)}\n` +
      `html,body{margin:0;padding:0;background:#fff}</style><body>${divs}</body>`;
    const png = screenshotHtml(html, 4200, batch.length * ROW * 2 + 40);
    const sheet = png ? readPng(png) : null;
    for (let i = 0; i < batch.length; i++) {
      if (!sheet) { out.set(batch[i].family, null); continue; }
      const rowX = subCrop(sheet, 0, i * ROW * 2 + 20 - 10, sheet.width, ROW - 20);
      const rowP = subCrop(sheet, 0, i * ROW * 2 + ROW + 20 - 10, sheet.width, ROW - 20);
      const bx = inkBBox(rowX), bp = inkBBox(rowP);
      out.set(batch[i].family, (bx && bp)
        ? { xh: Math.round((bx.h / SZ) * 1000) / 1000, adv: Math.round((bp.w / PANGRAM.length / SZ) * 1000) / 1000 }
        : null);
    }
  }
  return out;
}

/** All manifest families' metrics, measured once and cached in .state/font-metrics.json
 *  (keyed by manifest hash — a manifest change re-measures). */
export function fontMetricsAll() {
  const { entries, hash } = loadFontsManifest();
  let cache = null;
  try { cache = JSON.parse(readFileSync(METRICS_PATH, 'utf8')); } catch { /* remeasure */ }
  if (cache && cache.manifestHash === hash && cache.metrics) return cache.metrics;
  const fams = entries
    .filter((e) => (e.files && Object.keys(e.files).length) || (e.source === 'system' && fontInstalled(e.family)))
    .map((e) => ({ family: e.family, weight: nearestWeight(e, 400), hasFiles: !!(e.files && Object.keys(e.files).length) }));
  const measured = measureMetricsSheet(fams);
  const metrics = {};
  for (const [fam, m] of measured) if (m) metrics[fam] = m;
  try {
    mkdirSync(dirname(METRICS_PATH), { recursive: true });
    writeFileSync(METRICS_PATH, `${JSON.stringify({ manifestHash: hash, metrics }, null, 2)}\n`);
  } catch { /* cache best-effort */ }
  return metrics;
}

/**
 * Metric substitution (S8): given a family we can't ship (not in the pack / low-confidence
 * match), return the manifest family minimizing (x-height ratio, mean advance width) distance.
 * The requested family is measured live via the probe when it's installed locally; otherwise
 * we fall back to the class representative, and finally Inter.
 *
 * @returns {{ family:string, weight?:number, distance:number|null, via:string }}
 */
export function metricFallback(family, manifest = null) {
  const loaded = loadFontsManifest();
  const entries = Array.isArray(manifest) ? manifest : loaded.entries;
  const metrics = fontMetricsAll();

  let ref = metrics[family] || null;
  let via = 'manifest-metrics';
  if (!ref && fontInstalled(family)) {
    const m = measureMetricsSheet([{ family, weight: 400, hasFiles: false }]).get(family);
    if (m) { ref = m; via = 'live-probe'; }
  }
  if (!ref) {
    return { family: 'Inter', distance: null, via: 'default (family unmeasurable)' };
  }

  // x-height + advance CANNOT tell a serif from a sans (Helvetica Neue's metric twin is
  // Playfair Display) — when the requested family's visual class is known, only substitute
  // within the same class GROUP; metrics then pick the best fit inside it.
  const CLS_GROUP = {
    grotesk: 'sans', geometric: 'sans', humanist: 'sans', condensed: 'sans', 'heavy-display': 'sans',
    'serif-display': 'serif', 'serif-body': 'serif', mono: 'mono', script: 'script',
  };
  const refEntry = entries.find((e) => e.family === family);
  const refGroup = refEntry ? CLS_GROUP[refEntry.cls] || null : null;

  let best = null;
  for (const e of entries) {
    if (e.family === family) continue;
    if (!(e.files && Object.keys(e.files).length)) continue; // substitute must be SHIPPABLE
    if (refGroup && CLS_GROUP[e.cls] !== refGroup) continue;
    const m = metrics[e.family];
    if (!m) continue;
    const d = Math.hypot((m.xh - ref.xh) / Math.max(0.2, ref.xh), (m.adv - ref.adv) / Math.max(0.2, ref.adv));
    if (!best || d < best.d) best = { e, d };
  }
  if (!best) return { family: 'Inter', distance: null, via: 'default (no measurable candidates)' };
  return {
    family: best.e.family,
    weight: nearestWeight(best.e, 400),
    distance: Math.round(best.d * 1000) / 1000,
    via,
  };
}
