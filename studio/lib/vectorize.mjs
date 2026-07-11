// lib/vectorize.mjs — STACKED VECTORIZATION for icons/badges/logos/shapes (COPY-ENGINE-V2
// Phase 2 "icon/element vectorization"; wave-2 `vectorize` stream).
//
// vectorizeElement() turns a flat-design element crop into clean stacked vector paths that
// the figma-vectors stream encodes into REAL Figma VECTOR nodes (vectorNetworkBlob). The
// d-string CONTRACT with that stream: plain ABSOLUTE commands only — M / L / C / Z — in
// viewBox pixel coordinates, document order = paint order (back-to-front).
//
// Engines (best available wins):
//   1. vtracer subprocess (.state/bin/vtracer, installed by scripts/fetch-vtracer.mjs) in
//      --hierarchical stacked --mode spline — hole-free stacked color paths, ideal for flat art.
//   2. imagetracerjs (same dep lib/vector-trace.mjs uses) mapped to the same output shape.
//
// QUALITY GATE (the point of this module — a bad trace is WORSE than a raster crop):
//   • complexity: > VEC_MAX_PATHS paths or > VEC_MAX_D_BYTES total d bytes → ok:false
//     (caller keeps the raster crop; Figma would choke on noisy megapath traces anyway)
//   • fidelity: the paths are rasterized BACK (sharp/librsvg when available, else a pure-JS
//     nonzero-winding scanline rasterizer over flattened Béziers) and compared against the
//     source crop: score = 1 − meanAbsDiff/255 over pixels with source alpha ≥ 128, both
//     sides flattened over white. score < VEC_MIN_SCORE → ok:false.
//   Fill colors are re-sampled from the source (per-channel median of each path's top-most
//   pixels via the scanline index map) — quantizer palettes are AA-washed, medians are not.
//
// Never throws: every failure returns { ok:false, reason }. Callers: element pipeline (S4/S6
// candidates) + scripts/copy-harness debug. Read-only siblings: lib/vector-trace.mjs (small
// logo tracer with its own gates — kept as-is; this module supersedes it for Phase-2 elements).

import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const VTRACER_BIN = join(__dirname, '..', '.state', 'bin', 'vtracer');
const TMP_DIR = join(__dirname, '..', '.state', 'vectorize-tmp');

// ── gate thresholds (exported for tests + callers) ────────────────────────────────────────────
/** Below this raster-back similarity the trace lies about the source → keep the raster crop. */
export const VEC_MIN_SCORE = 0.90;
/** More result paths than this = too busy for a clean Figma element. */
export const VEC_MAX_PATHS = 40;
/** Total bytes across all d strings — megapath traces bloat files and stall Figma. */
export const VEC_MAX_D_BYTES = 60_000;

// ── path-data normalization: any SVG d → absolute M/L/C/Z ─────────────────────────────────────

const NUM_RE = /[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g;

/** Tokenize an SVG path d-string into [{cmd, args:number[]}] (raw, per spec repetition). */
function tokenizePath(d) {
  const out = [];
  const re = /([MmLlHhVvCcSsQqTtAaZz])([^MmLlHhVvCcSsQqTtAaZz]*)/g;
  let m;
  while ((m = re.exec(d))) {
    const nums = (m[2].match(NUM_RE) || []).map(Number);
    out.push({ cmd: m[1], args: nums });
  }
  return out;
}

const ARITY = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };

/**
 * Normalize any SVG path d-string to ABSOLUTE M/L/C/Z commands (the figma-vectors contract):
 * relative → absolute, H/V → L, S/T reflection resolved, Q → C (exact degree elevation),
 * A → L to endpoint (neither engine emits arcs; approximation is a safety net, not a feature).
 * Coordinates are transformed by x' = (x+tx)*scale, y' = (y+ty)*scale and rounded to 2 decimals.
 */
export function toAbsoluteCubicPath(d, { tx = 0, ty = 0, scale = 1 } = {}) {
  const toks = tokenizePath(d);
  let x = 0, y = 0, sx = 0, sy = 0;          // current point, subpath start
  let px = null, py = null, pcmd = '';        // previous control point (for S/T)
  const fmt = (v) => {
    const r = Math.round(v * 100) / 100;
    return Object.is(r, -0) ? '0' : String(r);
  };
  const X = (v) => fmt((v + tx) * scale);
  const Y = (v) => fmt((v + ty) * scale);
  const out = [];
  for (const { cmd, args } of toks) {
    const abs = cmd === cmd.toUpperCase();
    const C = cmd.toUpperCase();
    const n = ARITY[C];
    if (C === 'Z') { out.push('Z'); x = sx; y = sy; pcmd = 'Z'; continue; }
    if (n === 0 || !args.length) continue;
    for (let i = 0; i + n <= args.length; i += n) {
      const a = args.slice(i, i + n);
      switch (C) {
        case 'M': {
          const nx = abs ? a[0] : x + a[0], ny = abs ? a[1] : y + a[1];
          // implicit lineto after the first pair is handled by spec: subsequent pairs are L
          if (i === 0) { out.push('M', X(nx), Y(ny)); sx = nx; sy = ny; }
          else out.push('L', X(nx), Y(ny));
          x = nx; y = ny; break;
        }
        case 'L': {
          const nx = abs ? a[0] : x + a[0], ny = abs ? a[1] : y + a[1];
          out.push('L', X(nx), Y(ny)); x = nx; y = ny; break;
        }
        case 'H': {
          const nx = abs ? a[0] : x + a[0];
          out.push('L', X(nx), Y(y)); x = nx; break;
        }
        case 'V': {
          const ny = abs ? a[0] : y + a[0];
          out.push('L', X(x), Y(ny)); y = ny; break;
        }
        case 'C': {
          const c = abs ? a : [x + a[0], y + a[1], x + a[2], y + a[3], x + a[4], y + a[5]];
          out.push('C', X(c[0]), Y(c[1]), X(c[2]), Y(c[3]), X(c[4]), Y(c[5]));
          px = c[2]; py = c[3]; x = c[4]; y = c[5]; break;
        }
        case 'S': {
          const c2x = abs ? a[0] : x + a[0], c2y = abs ? a[1] : y + a[1];
          const nx = abs ? a[2] : x + a[2], ny = abs ? a[3] : y + a[3];
          const c1x = (pcmd === 'C' || pcmd === 'S') && px != null ? 2 * x - px : x;
          const c1y = (pcmd === 'C' || pcmd === 'S') && py != null ? 2 * y - py : y;
          out.push('C', X(c1x), Y(c1y), X(c2x), Y(c2y), X(nx), Y(ny));
          px = c2x; py = c2y; x = nx; y = ny; break;
        }
        case 'Q': case 'T': {
          let qx, qy, nx, ny;
          if (C === 'Q') {
            qx = abs ? a[0] : x + a[0]; qy = abs ? a[1] : y + a[1];
            nx = abs ? a[2] : x + a[2]; ny = abs ? a[3] : y + a[3];
          } else {
            qx = (pcmd === 'Q' || pcmd === 'T') && px != null ? 2 * x - px : x;
            qy = (pcmd === 'Q' || pcmd === 'T') && py != null ? 2 * y - py : y;
            nx = abs ? a[0] : x + a[0]; ny = abs ? a[1] : y + a[1];
          }
          // exact quadratic → cubic degree elevation
          const c1x = x + (2 / 3) * (qx - x), c1y = y + (2 / 3) * (qy - y);
          const c2x = nx + (2 / 3) * (qx - nx), c2y = ny + (2 / 3) * (qy - ny);
          out.push('C', X(c1x), Y(c1y), X(c2x), Y(c2y), X(nx), Y(ny));
          px = qx; py = qy; x = nx; y = ny; break;
        }
        case 'A': {
          const nx = abs ? a[5] : x + a[5], ny = abs ? a[6] : y + a[6];
          out.push('L', X(nx), Y(ny)); x = nx; y = ny; break;
        }
      }
      pcmd = C;
    }
  }
  return out.join(' ');
}

// ── SVG output parsing (vtracer + imagetracerjs) ──────────────────────────────────────────────

const toHex = (rgb) => '#' + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');

/** Parse a fill attribute value ("#abc", "#aabbcc", "rgb(1,2,3)") → [r,g,b] or null. */
export function parseFillColor(s) {
  if (!s || s === 'none') return null;
  let m = /^#([0-9a-f]{6})$/i.exec(s);
  if (m) return [0, 1, 2].map((i) => parseInt(m[1].slice(i * 2, i * 2 + 2), 16));
  m = /^#([0-9a-f]{3})$/i.exec(s);
  if (m) return [0, 1, 2].map((i) => parseInt(m[1][i] + m[1][i], 16));
  m = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i.exec(s);
  if (m) return [+m[1], +m[2], +m[3]];
  return null;
}

/**
 * Parse engine SVG output into [{ d, fill:'#rrggbb', opacity? }] in DOCUMENT ORDER (that IS
 * the paint order for stacked traces). Handles vtracer's transform="translate(x,y)" and
 * imagetracerjs's rgb() fills + opacity attr. `scale` maps traced coords back to crop px.
 */
export function parseEngineSvg(svg, { scale = 1 } = {}) {
  const out = [];
  const re = /<path\b([^>]*)\/?>/g;
  let m;
  while ((m = re.exec(svg))) {
    const attrs = m[1];
    const get = (name) => {
      const a = new RegExp(`${name}="([^"]*)"`).exec(attrs);
      return a ? a[1] : null;
    };
    const d = get('d');
    const rgb = parseFillColor(get('fill'));
    if (!d || !rgb) continue;
    const op = get('opacity') != null ? Number(get('opacity')) : 1;
    if (!(op >= 0.5)) continue; // sub-half-opacity layers are tracer noise
    let tx = 0, ty = 0;
    const tr = get('transform');
    if (tr) {
      const t = /translate\(\s*([-\d.]+)\s*[, ]\s*([-\d.]+)\s*\)/.exec(tr);
      if (t) { tx = +t[1]; ty = +t[2]; }
    }
    const dAbs = toAbsoluteCubicPath(d, { tx, ty, scale });
    if (!dAbs || !dAbs.startsWith('M')) continue;
    out.push({ d: dAbs, fill: toHex(rgb), ...(op < 1 ? { opacity: op } : {}) });
  }
  return mergeAdjacentFills(out);
}

/** Collapse CONSECUTIVE same-fill/same-opacity paths into one multi-subpath path. Safe for
 *  paint order (they were adjacent) and visually identical (same color); imagetracerjs emits
 *  one <path> per traced blob, so this turns hundreds of speckle paths into one per layer. */
export function mergeAdjacentFills(paths) {
  const out = [];
  for (const p of paths) {
    const last = out[out.length - 1];
    if (last && last.fill === p.fill && (last.opacity ?? 1) === (p.opacity ?? 1)) last.d += ` ${p.d}`;
    else out.push({ ...p });
  }
  return out;
}

// ── pure-JS rasterizer: flatten M/L/C/Z → polylines → nonzero scanline fill ───────────────────

/** Flatten an absolute M/L/C/Z d-string into closed polyline loops [[x,y],...]. */
export function flattenAbsPath(d, curveSegs = 12) {
  const toks = d.split(/\s+/);
  const loops = [];
  let cur = null, x = 0, y = 0, i = 0;
  const start = (nx, ny) => { if (cur && cur.length > 2) loops.push(cur); cur = [[nx, ny]]; x = nx; y = ny; };
  const lineTo = (nx, ny) => { cur && cur.push([nx, ny]); x = nx; y = ny; };
  while (i < toks.length) {
    const t = toks[i];
    if (t === 'M') { start(+toks[i + 1], +toks[i + 2]); i += 3; }
    else if (t === 'L') { lineTo(+toks[i + 1], +toks[i + 2]); i += 3; }
    else if (t === 'C') {
      const [c1x, c1y, c2x, c2y, ex, ey] = toks.slice(i + 1, i + 7).map(Number);
      for (let k = 1; k <= curveSegs; k++) {
        const s = k / curveSegs, u = 1 - s;
        cur && cur.push([
          u * u * u * x + 3 * u * u * s * c1x + 3 * u * s * s * c2x + s * s * s * ex,
          u * u * u * y + 3 * u * u * s * c1y + 3 * u * s * s * c2y + s * s * s * ey,
        ]);
      }
      x = ex; y = ey; i += 7;
    } else if (t === 'Z') { if (cur && cur.length > 2) loops.push(cur); cur = null; i += 1; }
    else i += 1;
  }
  if (cur && cur.length > 2) loops.push(cur);
  return loops;
}

/**
 * Rasterize paths (painter's order) into an RGBA buffer via nonzero-winding scanline fill.
 * Also returns `idx` (Int16Array, -1 = uncovered) — the TOP-MOST path index per pixel, which
 * fill re-sampling uses. Deterministic, no deps: the fallback when sharp/librsvg is absent.
 */
export function rasterizePathsJS(paths, w, h) {
  const data = new Uint8ClampedArray(w * h * 4);
  const idx = new Int16Array(w * h).fill(-1);
  paths.forEach((p, pi) => {
    const rgb = parseFillColor(p.fill) || [0, 0, 0];
    const op = p.opacity ?? 1;
    const loops = flattenAbsPath(p.d);
    if (!loops.length) return;
    let minY = Infinity, maxY = -Infinity;
    for (const loop of loops) for (const [, ly] of loop) { if (ly < minY) minY = ly; if (ly > maxY) maxY = ly; }
    const y0 = Math.max(0, Math.floor(minY)), y1 = Math.min(h - 1, Math.ceil(maxY));
    for (let yy = y0; yy <= y1; yy++) {
      const sy = yy + 0.5;
      const xs = []; // crossings with winding direction
      for (const loop of loops) {
        for (let k = 0; k < loop.length; k++) {
          const a = loop[k], b = loop[(k + 1) % loop.length];
          if ((a[1] <= sy && b[1] > sy) || (b[1] <= sy && a[1] > sy)) {
            const tt = (sy - a[1]) / (b[1] - a[1]);
            xs.push({ x: a[0] + tt * (b[0] - a[0]), wind: b[1] > a[1] ? 1 : -1 });
          }
        }
      }
      xs.sort((a, b) => a.x - b.x);
      let wind = 0;
      for (let k = 0; k < xs.length - 1; k++) {         // span between crossing k and k+1 is
        wind += xs[k].wind;                             // inside iff accumulated winding ≠ 0
        if (wind === 0) continue;
        const xa = Math.max(0, Math.ceil(xs[k].x - 0.5));
        const xb = Math.min(w - 1, Math.floor(xs[k + 1].x - 0.5));
        for (let xx = xa; xx <= xb; xx++) {
          const o = (yy * w + xx);
          const b4 = o * 4;
          if (op >= 1) {
            data[b4] = rgb[0]; data[b4 + 1] = rgb[1]; data[b4 + 2] = rgb[2]; data[b4 + 3] = 255;
          } else {
            const ia = data[b4 + 3] / 255;
            const oa = op + ia * (1 - op);
            data[b4] = (rgb[0] * op + data[b4] * ia * (1 - op)) / (oa || 1);
            data[b4 + 1] = (rgb[1] * op + data[b4 + 1] * ia * (1 - op)) / (oa || 1);
            data[b4 + 2] = (rgb[2] * op + data[b4 + 2] * ia * (1 - op)) / (oa || 1);
            data[b4 + 3] = oa * 255;
          }
          idx[o] = pi;
        }
      }
    }
  });
  return { data, idx };
}

/** Build a standalone SVG string from a vectorizeElement result (debug / raster-back). */
export function pathsToSvg(paths, w, h) {
  const body = paths.map((p) =>
    `<path d="${p.d}" fill="${p.fill}"${p.opacity != null ? ` fill-opacity="${p.opacity}"` : ''}/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`;
}

// ── scoring ───────────────────────────────────────────────────────────────────────────────────

/**
 * score = 1 − meanAbsDiff/255 across RGB on pixels where SOURCE alpha ≥ 128, both buffers
 * flattened over white (uncovered render pixels read as white → honestly penalized).
 */
export function scoreAgainstSource(srcRGBA, renderRGBA, w, h) {
  let sum = 0, n = 0;
  for (let p = 0; p < w * h; p++) {
    const i = p * 4;
    const sa = srcRGBA[i + 3] / 255;
    if (sa < 0.5) continue;
    const ra = renderRGBA[i + 3] / 255;
    for (let c = 0; c < 3; c++) {
      const sv = srcRGBA[i + c] * sa + 255 * (1 - sa);
      const rv = renderRGBA[i + c] * ra + 255 * (1 - ra);
      sum += Math.abs(sv - rv);
    }
    n += 3;
  }
  return n ? 1 - (sum / n) / 255 : 0;
}

// ── engines ───────────────────────────────────────────────────────────────────────────────────

let _sharp; // undefined = unprobed, null = missing
async function getSharp() {
  if (_sharp !== undefined) return _sharp;
  try { _sharp = (await import('sharp')).default; } catch { _sharp = null; }
  return _sharp;
}

/** vtracer flags tuned for flat design art (sweep on the copy-harness badge corpus):
 *  spline mode, stacked hierarchy, color_precision 4 bits, gradient_step 32 keeps flat fills
 *  as single layers, filter_speckle scaled to crop size (CLI caps it at 16). */
function vtracerArgs(inPath, outPath, minDim, maxColors) {
  const speckle = Math.max(4, Math.min(16, Math.round(minDim / 32)));
  const precision = maxColors <= 4 ? 3 : 4;
  return [
    '--input', inPath, '--output', outPath,
    '--colormode', 'color', '--hierarchical', 'stacked', '--mode', 'spline',
    '--filter_speckle', String(speckle), '--color_precision', String(precision),
    '--gradient_step', '32', '--path_precision', '2',
  ];
}

/** Deterministic imagetracerjs options (same anti-Math.random knobs as lib/vector-trace.mjs). */
const IMAGETRACER_OPTS = {
  ltres: 1, qtres: 1, pathomit: 12,
  colorsampling: 2, mincolorratio: 0, colorquantcycles: 3,
  blurradius: 0, rightangleenhance: true, roundcoords: 2,
  strokewidth: 0, linefilter: false, viewbox: true, desc: false, scale: 1,
};

// ── main API ──────────────────────────────────────────────────────────────────────────────────

/**
 * Vectorize an element crop into stacked Figma-ready vector paths.
 *
 * @param {Buffer|{data:Uint8Array|Uint8ClampedArray, width:number, height:number}} input
 *   PNG (or any sharp-readable) buffer, OR raw RGBA pixels.
 * @param {object} [opts]
 * @param {{x:number,y:number,w:number,h:number}} [opts.box] — crop rect in source pixels
 * @param {number}  [opts.maxColors=6] — palette budget (flat design art target)
 * @param {'stacked'} [opts.mode='stacked'] — reserved; only stacked is implemented
 * @param {'vtracer'|'imagetracer'} [opts.engine] — force one engine (tests / debug)
 * @returns {Promise<{ ok:boolean, paths:Array<{d:string,fill:string,opacity?:number}>,
 *   viewBox:{w:number,h:number}, engine:'vtracer'|'imagetracer'|null, score:number,
 *   reason:string|null, ms:number }>}
 *   `paths[i].d` = ABSOLUTE M/L/C/Z in viewBox px, document order = back-to-front paint order.
 */
export async function vectorizeElement(input, opts = {}) {
  const t0 = Date.now();
  const { maxColors = 6, engine: forceEngine } = opts;
  const fail = (reason, extra = {}) => ({
    ok: false, paths: [], viewBox: { w: 0, h: 0 }, engine: null, score: 0,
    reason, ms: Date.now() - t0, ...extra,
  });
  try {
    // ── 1. normalize input → raw RGBA crop ────────────────────────────────────────────────
    const sharp = await getSharp();
    let raw; // { data, width, height }
    if (input && input.data && input.width > 0 && input.height > 0) {
      let { data, width, height } = input;
      if (data.length !== width * height * 4) return fail('pixels must be RGBA (length = w*h*4)');
      if (opts.box) {
        const bx = Math.max(0, Math.round(opts.box.x)), by = Math.max(0, Math.round(opts.box.y));
        const bw = Math.min(width - bx, Math.round(opts.box.w)), bh = Math.min(height - by, Math.round(opts.box.h));
        if (bw < 8 || bh < 8) return fail('crop box too small');
        const out = new Uint8ClampedArray(bw * bh * 4);
        for (let yy = 0; yy < bh; yy++) {
          out.set(data.subarray(((by + yy) * width + bx) * 4, ((by + yy) * width + bx + bw) * 4), yy * bw * 4);
        }
        data = out; width = bw; height = bh;
      }
      raw = { data, width, height };
    } else if (Buffer.isBuffer(input) || input instanceof Uint8Array) {
      if (!sharp) return fail('sharp unavailable — cannot decode image buffer (pass raw pixels instead)');
      let img = sharp(Buffer.from(input));
      if (opts.box) {
        const meta = await img.metadata();
        const bx = Math.max(0, Math.round(opts.box.x)), by = Math.max(0, Math.round(opts.box.y));
        const bw = Math.min((meta.width || 0) - bx, Math.round(opts.box.w));
        const bh = Math.min((meta.height || 0) - by, Math.round(opts.box.h));
        if (bw < 8 || bh < 8) return fail('crop box too small');
        img = img.extract({ left: bx, top: by, width: bw, height: bh });
      }
      const { data, info } = await img.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      raw = { data, width: info.width, height: info.height };
    } else {
      return fail('input must be a PNG buffer or {data,width,height} RGBA pixels');
    }
    const W = raw.width, H = raw.height;
    if (W < 8 || H < 8) return fail('crop too small to vectorize');

    // Upscale tiny crops before tracing (smoother splines); coords divide back afterwards.
    const minDim = Math.min(W, H);
    const preScale = minDim < 128 ? Math.min(4, Math.ceil(128 / minDim)) : 1;

    // ── 2. run engines (vtracer preferred, imagetracer fallback), gate each ───────────────
    const candidates = [];
    const engines = forceEngine
      ? [forceEngine]
      : (existsSync(VTRACER_BIN) ? ['vtracer', 'imagetracer'] : ['imagetracer']);

    for (const eng of engines) {
      let paths = null;
      try {
        paths = eng === 'vtracer'
          ? await traceVtracer(raw, preScale, maxColors, sharp)
          : await traceImagetracer(raw, preScale, maxColors, sharp);
      } catch (e) {
        candidates.push(fail(`${eng} failed: ${e?.message || e}`, { engine: eng }));
        continue;
      }
      if (!paths || !paths.length) {
        candidates.push(fail(`${eng} traced nothing`, { engine: eng }));
        continue;
      }
      const judged = await judgeCandidate(paths, raw, eng, sharp, t0);
      if (judged.ok && !forceEngine) return judged; // first passing engine wins (vtracer preferred)
      candidates.push(judged);
    }

    // no engine passed — return the best-scoring failure (honest negative for the caller)
    candidates.sort((a, b) => (b.score || 0) - (a.score || 0));
    return candidates[0] || fail('no engine available');
  } catch (e) {
    return fail(`vectorize failed: ${e?.message || e}`);
  }
}

/** Rasterize (idx map), re-sample fills, complexity-gate, raster-back score. */
async function judgeCandidate(paths, raw, engineName, sharp, t0) {
  const W = raw.width, H = raw.height;
  const result = (ok, score, reason) => ({
    ok, paths, viewBox: { w: W, h: H }, engine: engineName, score,
    reason, ms: Date.now() - t0,
  });

  // complexity gate FIRST (cheap; megapath traces aren't worth scoring)
  if (paths.length > VEC_MAX_PATHS) {
    return result(false, 0, `too many paths (${paths.length} > ${VEC_MAX_PATHS})`);
  }
  const dBytes = paths.reduce((s, p) => s + p.d.length, 0);
  if (dBytes > VEC_MAX_D_BYTES) {
    return result(false, 0, `path data too large (${dBytes} B > ${VEC_MAX_D_BYTES} B)`);
  }

  // scanline pass gives the top-most path index per pixel → re-sample TRUE fills (medians).
  const js = rasterizePathsJS(paths, W, H);
  refineFills(paths, raw, js.idx);

  // raster-back: prefer sharp/librsvg (real SVG semantics); scanline result as fallback.
  let render = null;
  if (sharp) {
    try {
      const svg = pathsToSvg(paths, W, H);
      const r = await sharp(Buffer.from(svg), { density: 72 })
        .resize(W, H, { fit: 'fill' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      if (r.info.width === W && r.info.height === H) render = r.data;
    } catch { /* fall through to scanline */ }
  }
  if (!render) render = rasterizePathsJS(paths, W, H).data; // fills changed → re-rasterize

  const score = scoreAgainstSource(raw.data, render, W, H);
  if (score < VEC_MIN_SCORE) {
    return result(false, score, `raster-back score ${score.toFixed(3)} < ${VEC_MIN_SCORE} — trace diverges from source (photo/gradient/AA-heavy?)`);
  }
  return result(true, score, null);
}

/** Replace each path's quantized fill with the per-channel median of the source pixels it
 *  actually tops (alpha ≥ 128, ≥ 16 samples) — kills AA-washed palette colors. */
function refineFills(paths, raw, idx) {
  const W = raw.width, H = raw.height;
  const samples = paths.map(() => [[], [], []]);
  const step = Math.max(1, Math.floor((W * H) / 20000));
  for (let p = 0; p < W * H; p += step) {
    const pi = idx[p];
    if (pi < 0) continue;
    const i = p * 4;
    if (raw.data[i + 3] < 128) continue;
    samples[pi][0].push(raw.data[i]);
    samples[pi][1].push(raw.data[i + 1]);
    samples[pi][2].push(raw.data[i + 2]);
  }
  paths.forEach((p, pi) => {
    if (samples[pi][0].length < 16 || (p.opacity ?? 1) < 1) return;
    const med = samples[pi].map((arr) => { arr.sort((a, b) => a - b); return arr[arr.length >> 1]; });
    p.fill = toHex(med);
  });
}

/** vtracer subprocess: temp PNG in → SVG out → parsed stacked paths (crop px coords). */
async function traceVtracer(raw, preScale, maxColors, sharp) {
  if (!sharp) throw new Error('sharp unavailable — cannot write vtracer temp PNG');
  mkdirSync(TMP_DIR, { recursive: true });
  const stem = join(TMP_DIR, `vt-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const inPath = `${stem}.png`, outPath = `${stem}.svg`;
  try {
    let img = sharp(Buffer.from(raw.data.buffer, raw.data.byteOffset, raw.data.byteLength),
      { raw: { width: raw.width, height: raw.height, channels: 4 } });
    // vtracer treats transparency as its own cluster; flatten fully-transparent px to white
    if (preScale > 1) {
      img = img.resize({ width: raw.width * preScale, height: raw.height * preScale, kernel: 'lanczos3', fit: 'fill' });
    }
    await img.flatten({ background: '#ffffff' }).png().toFile(inPath);
    const r = spawnSync(VTRACER_BIN,
      vtracerArgs(inPath, outPath, Math.min(raw.width, raw.height) * preScale, maxColors),
      { encoding: 'utf8', timeout: 60000 });
    if (r.status !== 0) throw new Error(`vtracer exited ${r.status}: ${(r.stderr || r.stdout || '').trim().slice(0, 200)}`);
    const svg = readFileSync(outPath, 'utf8');
    return parseEngineSvg(svg, { scale: 1 / preScale });
  } finally {
    for (const p of [inPath, outPath]) { try { rmSync(p); } catch { /* best effort */ } }
  }
}

/** imagetracerjs in-process: raw pixels → SVG string → parsed paths (crop px coords). */
async function traceImagetracer(raw, preScale, maxColors, sharp) {
  const ImageTracer = (await import('imagetracerjs')).default;
  let px = raw;
  if (preScale > 1 && sharp) {
    const { data, info } = await sharp(Buffer.from(raw.data.buffer, raw.data.byteOffset, raw.data.byteLength),
      { raw: { width: raw.width, height: raw.height, channels: 4 } })
      .resize({ width: raw.width * preScale, height: raw.height * preScale, kernel: 'lanczos3', fit: 'fill' })
      .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    px = { data, width: info.width, height: info.height };
  }
  const svg = ImageTracer.imagedataToSVG(
    { width: px.width, height: px.height, data: new Uint8ClampedArray(px.data.buffer, px.data.byteOffset, px.data.byteLength) },
    { ...IMAGETRACER_OPTS, numberofcolors: Math.max(2, Math.min(16, maxColors)) },
  );
  const scale = px.width / raw.width;
  return parseEngineSvg(svg, { scale: 1 / scale });
}
