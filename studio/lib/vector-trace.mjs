// lib/vector-trace.mjs — VECTORIZATION for small logos/emblems in reference ads (research TOP-5 #4).
//
// A small logo the agent can't rebuild from primitives used to become a fuzzy raster crop (or a
// matte). traceRegion() crops the candidate region, quantizes + traces it with imagetracerjs and
// returns crisp SVG path layers the scene graph can render as style.shapeKind:'path' with a
// normalized 0..1 box-local style.path d-string (same convention as productSilhouettePath in
// lib/layout-extract.mjs and the freeform-path branches in raster.ts / designSvg.ts / Stage.tsx).
//
// QUALITY GATE (critical — a bad trace is WORSE than a crop): the result is ok:true only when
//   • the crop reads as flat art (≤6 significant color clusters — photos/gradients fail early),
//   • the traced output collapses to ≤ TRACE_MAX_PATHS fill groups,
//   • total subpath count is sane (≤ TRACE_MAX_SUBPATHS — noisy AA traces have hundreds), and
//   • the non-background ink covers a sane fraction of the crop (TRACE_MIN/MAX_COVERAGE —
//     ~zero means nothing traced; ~everything means the "background" was photo/gradient tiling).
// Callers must ALSO keep the region small (≤ ~12% of the canvas) — pass opts.maxRegionFrac to
// enforce it here. On ok:false the caller keeps today's crop/matte path. Never throws.
//
// Mono logos (the common case — e.g. the ad-002 handshake emblem) quantize to bg+ink; the ink
// fills are near-identical, so they merge into ONE path layer whose fill is re-sampled from the
// actual source pixels (per-channel median of the pixels assigned to the ink — the quantized
// palette color is washed out by anti-aliasing). Multi-color logos come back as one path layer
// per distinct fill, ordered by area (largest first — back-to-front paint order).
//
// LICENSE: imagetracerjs 1.2.6 is Unlicense (public domain) — no distribution constraints.
// sharp arrives transitively via @imgly/background-removal-node (same dep matte.mjs leans on);
// it is dynamically imported so environments without it degrade to ok:false instead of crashing.

import { existsSync } from 'node:fs';

// ── gate thresholds (exported for tests + callers) ────────────────────────────────────────────
/** Max RESULT path layers (fill groups after mono-merge). More = too busy to be a logo. */
export const TRACE_MAX_PATHS = 12;
/** Min/max fraction of the crop the non-background ink may cover. Near-0 traced nothing;
 *  near-1 means the fills tile the whole rect (photo/gradient — no real background found). */
export const TRACE_MIN_COVERAGE = 0.02;
export const TRACE_MAX_COVERAGE = 0.85;
/** Max total subpaths ('M' commands) across kept fills. The 002 emblem (intricate line art)
 *  needs ~50; anti-aliasing noise and photos produce hundreds. */
export const TRACE_MAX_SUBPATHS = 160;
/** Fills whose RGB colors are all within this Euclidean distance merge into one mono path. */
export const TRACE_MERGE_DELTA = 48;
/** Crops with more significant color clusters than this fail early (photo/gradient). */
export const TRACE_MAX_COLORS = 6;

// Deterministic imagetracerjs options: colorsampling 2 (deterministic sampling) and
// mincolorratio 0 (no random palette re-seeding) are the two knobs that keep Math.random out
// of the pipeline. numberofcolors is chosen per-crop from the color census (2..6).
const TRACER_BASE_OPTS = {
  ltres: 1, qtres: 1, pathomit: 12,
  colorsampling: 2, mincolorratio: 0, colorquantcycles: 3,
  blurradius: 0, rightangleenhance: true, roundcoords: 2,
  strokewidth: 0, linefilter: false, viewbox: true, desc: false, scale: 1,
};

// ── pure helpers (exported for tests) ─────────────────────────────────────────────────────────

/** Parse imagetracerjs SVG output into [{ rgb:[r,g,b], opacity, d }]. Hole subpaths are already
 *  embedded (reverse-wound) in each element's d by the library. */
export function parseSvgPaths(svg) {
  const re = /<path [^>]*fill="rgb\((\d+),(\d+),(\d+)\)"[^>]*opacity="([\d.]+)"[^>]*d="([^"]+)"/g;
  const out = [];
  let m;
  while ((m = re.exec(svg))) out.push({ rgb: [+m[1], +m[2], +m[3]], opacity: +m[4], d: m[5].trim() });
  return out;
}

/** Signed area of a (possibly multi-subpath) M/L/Q/Z d-string via the shoelace formula over
 *  segment endpoints (Q approximated by its endpoint — plenty for a coverage GATE). Reverse-wound
 *  hole subpaths contribute negative area, so |sum| is "outer minus holes". */
export function signedPathArea(d) {
  const toks = d.split(/[\s,]+/).filter(Boolean);
  let i = 0, total = 0, pts = [];
  const flush = () => {
    if (pts.length >= 3) {
      let s = 0;
      for (let k = 0; k < pts.length; k++) {
        const a = pts[k], b = pts[(k + 1) % pts.length];
        s += a[0] * b[1] - b[0] * a[1];
      }
      total += s / 2;
    }
    pts = [];
  };
  while (i < toks.length) {
    const t = toks[i];
    if (t === 'M') { flush(); pts.push([+toks[i + 1], +toks[i + 2]]); i += 3; }
    else if (t === 'L') { pts.push([+toks[i + 1], +toks[i + 2]]); i += 3; }
    else if (t === 'Q') { pts.push([+toks[i + 3], +toks[i + 4]]); i += 5; }
    else i += 1; // Z or noise
  }
  flush();
  return total;
}

/** Rescale every coordinate of an M/L/Q/Z d-string by (1/w, 1/h) → normalized 0..1 box-local
 *  (4 decimals, matching the smoothClosedPath convention in layout-extract). */
export function normalizePathD(d, w, h) {
  const toks = d.split(/[\s,]+/).filter(Boolean);
  const fx = (v) => Number((+v / w).toFixed(4));
  const fy = (v) => Number((+v / h).toFixed(4));
  let i = 0;
  const out = [];
  while (i < toks.length) {
    const t = toks[i];
    if (t === 'M' || t === 'L') { out.push(t, fx(toks[i + 1]), fy(toks[i + 2])); i += 3; }
    else if (t === 'Q') { out.push(t, fx(toks[i + 1]), fy(toks[i + 2]), fx(toks[i + 3]), fy(toks[i + 4])); i += 5; }
    else if (t === 'Z') { out.push('Z'); i += 1; }
    else i += 1;
  }
  return out.join(' ');
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const toHex = (rgb) => '#' + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');

/** The pure gate: judge a grouped trace. Exported so tests can probe thresholds directly. */
export function judgeTrace({ pathCount, coverage, subpaths }) {
  if (!(pathCount >= 1)) return { ok: false, reason: 'nothing traced' };
  if (pathCount > TRACE_MAX_PATHS) return { ok: false, reason: `too many fills (${pathCount} > ${TRACE_MAX_PATHS})` };
  if (subpaths > TRACE_MAX_SUBPATHS) return { ok: false, reason: `too complex (${subpaths} subpaths > ${TRACE_MAX_SUBPATHS})` };
  if (coverage < TRACE_MIN_COVERAGE) return { ok: false, reason: `coverage ${coverage.toFixed(3)} below ${TRACE_MIN_COVERAGE}` };
  if (coverage > TRACE_MAX_COVERAGE) return { ok: false, reason: `coverage ${coverage.toFixed(3)} above ${TRACE_MAX_COVERAGE} — background not separable (photo/gradient?)` };
  return { ok: true, reason: null };
}

/** Standalone SVG preview for a traceRegion result (bench/debug). */
export function traceResultToSvg(result, size = 512) {
  const paths = (result?.paths || [])
    .map((p) => `<path fill="${p.fill}" d="${p.d}"/>`)
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 1 1">${paths}</svg>`;
}

// ── internals ─────────────────────────────────────────────────────────────────────────────────

/** Significant color clusters in RGBA raw: 3-bit/channel histogram, then GREEDY MERGE of nearby
 *  buckets (biggest first, absorb within RGB distance 64) so anti-aliased fringe and shading of
 *  the same color count as ONE cluster. Returns the number of merged clusters holding ≥3% of
 *  sampled pixels — the "how many real colors does this crop have" number the pre-gate uses. */
function colorCensus(data, pixelCount) {
  const buckets = new Map();
  const step = Math.max(1, Math.floor(pixelCount / 8192)); // sample ≤ ~8k pixels
  let n = 0;
  for (let p = 0; p < pixelCount; p += step) {
    const i = p * 4;
    if (data[i + 3] < 32) continue; // ignore transparent
    const key = ((data[i] >> 5) << 6) | ((data[i + 1] >> 5) << 3) | (data[i + 2] >> 5);
    buckets.set(key, (buckets.get(key) || 0) + 1);
    n++;
  }
  if (!n) return 0;
  // bucket key → representative RGB (bucket center)
  const entries = [...buckets.entries()]
    .map(([key, count]) => ({
      rgb: [(((key >> 6) & 7) << 5) + 16, (((key >> 3) & 7) << 5) + 16, ((key & 7) << 5) + 16],
      count,
    }))
    .sort((a, b) => b.count - a.count);
  const centers = [];
  for (const e of entries) {
    const home = centers.find((c) => dist(c.rgb, e.rgb) <= 64);
    if (home) home.count += e.count;
    else centers.push({ rgb: e.rgb, count: e.count });
  }
  return centers.filter((c) => c.count / n >= 0.03).length;
}

/** Average color of the crop's 1px border frame (the region's background, same trick as
 *  layout-extract's sampleBorderBackground). */
function borderColor(data, w, h) {
  let r = 0, g = 0, b = 0, n = 0;
  const add = (x, y) => {
    const i = (y * w + x) * 4;
    if (data[i + 3] > 32) { r += data[i]; g += data[i + 1]; b += data[i + 2]; n++; }
  };
  for (let x = 0; x < w; x++) { add(x, 0); add(x, h - 1); }
  for (let y = 1; y < h - 1; y++) { add(0, y); add(w - 1, y); }
  return n ? [r / n, g / n, b / n] : null;
}

/** Per-channel MEDIAN of the sampled pixels nearest to `target` among `centers` — recovers the
 *  true ink color that quantization washes out with anti-aliased fringe. */
function medianAssignedColor(data, pixelCount, centers, targetIdx) {
  const ch = [[], [], []];
  const step = Math.max(1, Math.floor(pixelCount / 4096));
  for (let p = 0; p < pixelCount; p += step) {
    const i = p * 4;
    if (data[i + 3] < 32) continue;
    const px = [data[i], data[i + 1], data[i + 2]];
    let best = 0, bestD = Infinity;
    for (let c = 0; c < centers.length; c++) {
      const d = dist(px, centers[c]);
      if (d < bestD) { bestD = d; best = c; }
    }
    if (best === targetIdx) { ch[0].push(px[0]); ch[1].push(px[1]); ch[2].push(px[2]); }
  }
  if (!ch[0].length) return null;
  return ch.map((arr) => { arr.sort((a, b) => a - b); return arr[arr.length >> 1]; });
}

// ── main API ──────────────────────────────────────────────────────────────────────────────────

/**
 * Trace a small region of a reference image into crisp vector path layers.
 *
 * @param {string} srcPngPath — source image (PNG/JPG/WEBP — anything sharp reads)
 * @param {{x:number,y:number,w:number,h:number}} cropFrac — region as 0..1 fractions of the source
 * @param {object} [opts]
 * @param {number} [opts.maxRegionFrac] — when set, fail regions larger than this fraction of the
 *   source area (design-agent passes 0.12: vectorization is for SMALL logos only)
 * @param {number} [opts.pathomit] — override tracer speckle filter (default 12)
 * @returns {Promise<{ ok:boolean, paths:Array<{d:string,fill:string}>, viewBox:string,
 *   pathCount:number, coverage:number, subpaths:number, colors:number, ms:number, reason:string|null }>}
 *   `paths[i].d` is normalized 0..1 box-local (drop into style.path with style.shapeKind:'path').
 *   Multi-fill results are ordered largest-area first (paint back-to-front, one layer per fill).
 */
export async function traceRegion(srcPngPath, cropFrac, opts = {}) {
  const t0 = Date.now();
  const fail = (reason, extra = {}) => ({
    ok: false, paths: [], viewBox: '0 0 1 1', pathCount: 0, coverage: 0, subpaths: 0,
    colors: 0, ms: Date.now() - t0, reason, ...extra,
  });
  try {
    if (!cropFrac || !(cropFrac.w > 0) || !(cropFrac.h > 0)) return fail('bad crop rect');
    if (typeof opts.maxRegionFrac === 'number' && cropFrac.w * cropFrac.h > opts.maxRegionFrac) {
      return fail(`region too large (${(cropFrac.w * cropFrac.h * 100).toFixed(1)}% > ${(opts.maxRegionFrac * 100).toFixed(0)}% of source)`);
    }
    if (!srcPngPath || !existsSync(srcPngPath)) return fail('cannot read source');

    let sharp, ImageTracer;
    try {
      sharp = (await import('sharp')).default;
      ImageTracer = (await import('imagetracerjs')).default;
    } catch (e) {
      return fail(`deps unavailable: ${e?.message || e}`);
    }

    const meta = await sharp(srcPngPath).metadata();
    if (!meta.width || !meta.height) return fail('cannot read source dimensions');
    const left = Math.max(0, Math.round(cropFrac.x * meta.width));
    const top = Math.max(0, Math.round(cropFrac.y * meta.height));
    const width = Math.min(meta.width - left, Math.round(cropFrac.w * meta.width));
    const height = Math.min(meta.height - top, Math.round(cropFrac.h * meta.height));
    if (width < 8 || height < 8) return fail('crop too small to trace');

    // Upscale small crops before tracing (smoother curves, AA fringe shrinks relative to ink);
    // integer factor so it stays deterministic and cheap. Target min-dimension ≈ 256px, cap 4x.
    const scale = Math.max(1, Math.min(4, Math.ceil(256 / Math.min(width, height))));
    const { data, info } = await sharp(srcPngPath)
      .extract({ left, top, width, height })
      .resize({ width: width * scale, height: height * scale, kernel: 'lanczos3', fit: 'fill' })
      .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const W = info.width, H = info.height, pixelCount = W * H;

    // PRE-GATE: photos/gradients have many significant color clusters — refuse to trace them.
    const colors = colorCensus(data, pixelCount);
    if (colors < 1) return fail('empty/transparent crop');
    if (colors > TRACE_MAX_COLORS) return fail(`too many colors (${colors} clusters — photo/gradient?)`, { colors });

    const svg = ImageTracer.imagedataToSVG(
      { width: W, height: H, data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength) },
      { ...TRACER_BASE_OPTS, pathomit: opts.pathomit ?? TRACER_BASE_OPTS.pathomit, numberofcolors: Math.max(2, Math.min(TRACE_MAX_COLORS, colors)) },
    );
    const rawPaths = parseSvgPaths(svg).filter((p) => p.opacity >= 0.5);
    if (!rawPaths.length) return fail('nothing traced', { colors });

    // Drop BACKGROUND fills: near the border color, or any fill tiling ≥88% of the crop.
    const border = borderColor(data, W, H);
    const cropArea = W * H;
    const byFill = new Map();
    for (const p of rawPaths) {
      const key = p.rgb.join(',');
      const e = byFill.get(key) || { rgb: p.rgb, ds: [], area: 0, subpaths: 0 };
      e.ds.push(p.d);
      e.area += Math.abs(signedPathArea(p.d));
      e.subpaths += (p.d.match(/M /g) || []).length;
      byFill.set(key, e);
    }
    const kept = [];
    for (const e of byFill.values()) {
      const isBorderColor = border && dist(e.rgb, border) <= 60;
      const tilesEverything = e.area / cropArea >= 0.88;
      if (!isBorderColor && !tilesEverything) kept.push(e);
    }
    if (!kept.length) return fail('only background traced', { colors });

    // MONO-MERGE: when every kept fill is near-identical (mono logos — the common case), collapse
    // to a single path layer. Fill color is re-sampled from source pixels (median of the pixels
    // assigned to the ink cluster) because quantized palette colors are AA-washed.
    kept.sort((a, b) => b.area - a.area);
    const allNearIdentical = kept.length > 1
      && kept.every((e) => dist(e.rgb, kept[0].rgb) <= TRACE_MERGE_DELTA);
    const groups = (allNearIdentical || kept.length === 1)
      ? [{
          rgb: kept[0].rgb,
          ds: kept.flatMap((e) => e.ds),
          area: kept.reduce((s, e) => s + e.area, 0),
          subpaths: kept.reduce((s, e) => s + e.subpaths, 0),
        }]
      : kept;

    const centers = groups.map((g) => g.rgb).concat(border ? [border] : []);
    const paths = groups.map((g, i) => {
      const resampled = medianAssignedColor(data, pixelCount, centers, i);
      return {
        d: g.ds.map((d) => normalizePathD(d, W, H)).join(' '),
        fill: toHex(resampled || g.rgb),
      };
    });

    const coverage = Math.min(1, groups.reduce((s, g) => s + g.area, 0) / cropArea);
    const subpaths = groups.reduce((s, g) => s + g.subpaths, 0);
    const pathCount = paths.length;
    const verdict = judgeTrace({ pathCount, coverage, subpaths });
    return {
      ok: verdict.ok, paths, viewBox: '0 0 1 1', pathCount, coverage, subpaths, colors,
      ms: Date.now() - t0, reason: verdict.reason,
    };
  } catch (e) {
    return fail(`trace failed: ${e?.message || e}`);
  }
}
