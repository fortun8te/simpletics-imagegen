// lib/fill-fit.mjs — S5 PARAMETRIC FILL FITTING: flat / linear gradient / radial gradient / photo.
//
// THE GAP THIS KILLS: the old pipeline could only say "background: #hex" — every gradient page,
// gradient card and photo-scrim came out as a wrong flat color ("it can't do gradients"). This
// module looks at raw RGBA pixels for a region and returns a PARAMETRIC fill verdict with fitted
// parameters, residual and confidence. 100% deterministic math — no model calls, no network.
//
// Verdicts (see docs/COPY-ENGINE-V2-CONTRACTS.md §S5):
//   flat    — tight per-channel histogram (p95−p5 below threshold) → dominant color
//   linear  — per-channel least-squares plane c(x,y)=ax+by+k in sRGB, IRLS/Huber-robust against
//             dither + JPEG block noise; requires low residual, cross-channel (a,b) collinearity
//             and a near-monotone 1-D profile along the shared axis (≤1 direction reversal per
//             channel — real multi-stop gradients aren't strictly channel-monotone, see corpus
//             013's blue channel, but photos/stripes oscillate); stops recovered from the profile
//             by greedy piecewise-linear (Douglas–Peucker) reduction to the MINIMAL stop list.
//             angleDeg is CSS convention (0 = to top, 90 = to right); offset 0 = the gradient-line
//             end the CSS angle points AWAY from (i.e. matches linear-gradient(angleDeg, stops)).
//   radial  — luminance gradient field converging on a point; center = least-squares intersection
//             of the gradient lines (xPct/yPct of region); stops from the monotone radius profile;
//             radiusPct = 100 · (radius at offset 1 in px) / (half the region diagonal).
//   photo   — everything parametric failed (high residual under all models).
//
// Invariants:
//   • Never throws — any internal error degrades to {kind:'photo', confidence:0, error}.
//   • Pure functions of the pixel input; fitting happens on a ≥4×-downsampled, lightly
//     box-blurred copy (dither/JPEG robustness + speed); all colors are sRGB.
//   • Every verdict carries residual (mean abs error 0..255 vs the fitted model; for gradient
//     verdicts this is the 15%-trimmed inlier mean so stray occluders can't flip the verdict —
//     the untrimmed mean is added as residualFull when it diverges) + confidence 0..1.
//
// Entry points (callers: S5 stage runner writing s5.fills.json; S9 re-renders fitted fills over
// occlusion holes via renderFill):
//   loadPixels(imagePath)                            → Promise<{data:Uint8Array RGBA,width,height}>
//   fitRegionFill(pixels, region, opts)              → verdict (see above)
//   solveScrim(pixelsObserved, pixelsBackground, region) → {ok, color, alpha:{kind,...}, residual}
//   renderFill(fit, width, height)                   → {data:Uint8Array RGBA, width, height}

// ---------------------------------------------------------------------------------------------
// tunables
// ---------------------------------------------------------------------------------------------
const DEFAULTS = {
  minDownsampleFactor: 4,   // contract: fit on a ≥4×-downsampled copy
  maxGridDim: 160,          // cap the downsampled grid's larger dimension
  superFlatSpread: 5,       // p95−p5 below this → flat immediately, skip gradient models
  flatSpread: 12,           // p95−p5 below this → flat fallback when gradients fail
  minGradientSpan: 6,       // a channel participates in gradient direction if it moves ≥ this
  collinearSinMax: 0.22,    // ~12.7° max angle between per-channel gradient directions
  maxReversals: 1,          // profile may bend (multi-stop) but not oscillate: ≤1 direction reversal
  linearResidualMax: 8,     // mean abs error (0..255) budget for a linear verdict
  radialResidualMax: 10,    // budget for a radial verdict
  radialCoherenceMin: 0.75, // mean |cos| between luminance gradients and radial directions
  stopTol: 5,               // piecewise-linear knot insertion stops once max error ≤ this
  maxStops: 5,              // hard cap on recovered stops
  profileBins: 28,          // 1-D profile resolution
  scrimResidualMax: 12,     // solveScrim ok-threshold
};

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v) => clamp(v, 0, 1);
const toHex = (rgb) =>
  '#' + rgb.map((c) => clamp(Math.round(c), 0, 255).toString(16).padStart(2, '0')).join('');

// ---------------------------------------------------------------------------------------------
// pixel I/O
// ---------------------------------------------------------------------------------------------

/** Decode any sharp-readable image to {data: Uint8Array RGBA, width, height}. */
export async function loadPixels(imagePath) {
  const sharp = (await import('sharp')).default;
  const { data, info } = await sharp(imagePath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), width: info.width, height: info.height };
}

// ---------------------------------------------------------------------------------------------
// region extraction + downsampling
// ---------------------------------------------------------------------------------------------

// Pull the region out of the RGBA buffer as float RGB + validity map.
// region: {x,y,w,h} rect, optionally with {mask}: Uint8Array (nonzero = inside), either sized
// w*h (region-local) or width*height (image-global). {mask} alone = image-global mask.
function extractRegion(pixels, region) {
  const { data, width, height } = pixels;
  let x = 0, y = 0, w = width, h = height, mask = null, maskGlobal = false;
  if (region) {
    if (Number.isFinite(region.x) || Number.isFinite(region.w)) {
      x = Math.max(0, Math.floor(region.x || 0));
      y = Math.max(0, Math.floor(region.y || 0));
      w = Math.min(width - x, Math.floor(region.w ?? width - x));
      h = Math.min(height - y, Math.floor(region.h ?? height - y));
    }
    if (region.mask) {
      mask = region.mask;
      maskGlobal = mask.length === width * height;
      if (!maskGlobal && mask.length !== w * h) mask = null; // unusable mask → ignore
    }
  }
  if (w <= 0 || h <= 0) throw new Error(`empty region ${w}x${h}`);
  const rgb = new Float32Array(w * h * 3);
  const valid = new Uint8Array(w * h);
  for (let ry = 0; ry < h; ry++) {
    for (let rx = 0; rx < w; rx++) {
      const ri = ry * w + rx;
      const m = mask ? (maskGlobal ? mask[(y + ry) * width + (x + rx)] : mask[ri]) : 1;
      if (!m) continue;
      const si = ((y + ry) * width + (x + rx)) * 4;
      if (data[si + 3] < 8) continue; // fully transparent source pixels don't vote
      rgb[ri * 3] = data[si];
      rgb[ri * 3 + 1] = data[si + 1];
      rgb[ri * 3 + 2] = data[si + 2];
      valid[ri] = 1;
    }
  }
  return { x, y, w, h, rgb, valid };
}

function chooseFactor(w, h, minFactor, maxGridDim) {
  let f = Math.max(minFactor, Math.ceil(Math.max(w, h) / maxGridDim));
  while (f > 1 && Math.min(w, h) / f < 6) f--; // tiny regions: keep ≥6 cells on the short side
  return Math.max(1, f);
}

// Box-average downsample (valid-aware) + one light 3×3 box blur. Returns a cell grid.
function downsampleRegion(reg, factor) {
  const gw = Math.max(1, Math.floor(reg.w / factor));
  const gh = Math.max(1, Math.floor(reg.h / factor));
  const rgb = new Float32Array(gw * gh * 3);
  const valid = new Uint8Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      let r = 0, g = 0, b = 0, n = 0;
      const y0 = gy * factor, x0 = gx * factor;
      const y1 = Math.min(reg.h, y0 + factor), x1 = Math.min(reg.w, x0 + factor);
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = yy * reg.w + xx;
          if (!reg.valid[i]) continue;
          r += reg.rgb[i * 3]; g += reg.rgb[i * 3 + 1]; b += reg.rgb[i * 3 + 2]; n++;
        }
      }
      const gi = gy * gw + gx;
      if (n > 0) {
        rgb[gi * 3] = r / n; rgb[gi * 3 + 1] = g / n; rgb[gi * 3 + 2] = b / n;
        valid[gi] = 1;
      }
    }
  }
  // light box blur (valid-aware) — knocks down residual dither without moving gradients
  const out = new Float32Array(gw * gh * 3);
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const gi = gy * gw + gx;
      if (!valid[gi]) continue;
      let r = 0, g = 0, b = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const yy = gy + dy, xx = gx + dx;
          if (yy < 0 || yy >= gh || xx < 0 || xx >= gw) continue;
          const j = yy * gw + xx;
          if (!valid[j]) continue;
          r += rgb[j * 3]; g += rgb[j * 3 + 1]; b += rgb[j * 3 + 2]; n++;
        }
      }
      out[gi * 3] = r / n; out[gi * 3 + 1] = g / n; out[gi * 3 + 2] = b / n;
    }
  }
  // factor: cell → source px scale, used to keep directions in pixel space
  return { w: gw, h: gh, rgb: out, valid, factor };
}

// ---------------------------------------------------------------------------------------------
// small math helpers
// ---------------------------------------------------------------------------------------------

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const i = clamp((sorted.length - 1) * p, 0, sorted.length - 1);
  const lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

function solve3x3(A, b) {
  const m = [
    [A[0][0], A[0][1], A[0][2], b[0]],
    [A[1][0], A[1][1], A[1][2], b[1]],
    [A[2][0], A[2][1], A[2][2], b[2]],
  ];
  for (let col = 0; col < 3; col++) {
    let piv = col;
    for (let r = col + 1; r < 3; r++) if (Math.abs(m[r][col]) > Math.abs(m[piv][col])) piv = r;
    if (Math.abs(m[piv][col]) < 1e-12) return null;
    [m[col], m[piv]] = [m[piv], m[col]];
    for (let r = 0; r < 3; r++) {
      if (r === col) continue;
      const f = m[r][col] / m[col][col];
      for (let c = col; c < 4; c++) m[r][c] -= f * m[col][c];
    }
  }
  return [m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2]];
}

// IRLS/Huber plane fit v ≈ a·x + b·y + k on sampled points. x,y in cell coords.
function fitPlaneIRLS(xs, ys, vs, iterations = 4) {
  const n = xs.length;
  const w = new Float64Array(n).fill(1);
  let a = 0, b = 0, k = 0;
  for (let it = 0; it <= iterations; it++) {
    let sxx = 0, sxy = 0, sx = 0, syy = 0, sy = 0, s1 = 0, sxv = 0, syv = 0, sv = 0;
    for (let i = 0; i < n; i++) {
      const wi = w[i], x = xs[i], y = ys[i], v = vs[i];
      sxx += wi * x * x; sxy += wi * x * y; sx += wi * x;
      syy += wi * y * y; sy += wi * y; s1 += wi;
      sxv += wi * x * v; syv += wi * y * v; sv += wi * v;
    }
    const sol = solve3x3([[sxx, sxy, sx], [sxy, syy, sy], [sx, sy, s1]], [sxv, syv, sv]);
    if (!sol) break;
    [a, b, k] = sol;
    if (it === iterations) break;
    // Huber reweight: δ from the residual MAD so designer dither doesn't dominate
    const res = new Float64Array(n);
    for (let i = 0; i < n; i++) res[i] = Math.abs(vs[i] - (a * xs[i] + b * ys[i] + k));
    const sortedRes = Float64Array.from(res).sort();
    const delta = Math.max(3, 1.5 * percentile(Array.from(sortedRes), 0.5));
    for (let i = 0; i < n; i++) w[i] = res[i] <= delta ? 1 : delta / res[i];
  }
  let resSum = 0;
  for (let i = 0; i < n; i++) resSum += Math.abs(vs[i] - (a * xs[i] + b * ys[i] + k));
  return { a, b, k, residual: n ? resSum / n : 255 };
}

// CSS angle (deg, 0 = to top, 90 = to right) from a pixel-space direction (y down).
function cssAngleFromDir(dx, dy) {
  return (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360;
}
// Inverse: pixel-space unit direction the gradient runs along (offset 0 → offset 1).
function dirFromCssAngle(angleDeg) {
  const rad = (angleDeg * Math.PI) / 180;
  return { dx: Math.sin(rad), dy: -Math.cos(rad) };
}

// ---------------------------------------------------------------------------------------------
// 1-D profile → minimal stops
// ---------------------------------------------------------------------------------------------

// Bin (t ∈ [0,1], rgb) samples into a profile. Per-bin per-channel MEDIAN, not mean — small
// occluders left inside the region (stray product blobs, shadows, imperfect masks) are a minority
// of each bin's pixels, and the median simply ignores them (Theil–Sen spirit).
function buildProfile(ts, rgbs, bins) {
  const buckets = Array.from({ length: bins }, () => [[], [], []]);
  for (let i = 0; i < ts.length; i++) {
    const b = buckets[clamp(Math.floor(ts[i] * bins), 0, bins - 1)];
    b[0].push(rgbs[i * 3]); b[1].push(rgbs[i * 3 + 1]); b[2].push(rgbs[i * 3 + 2]);
  }
  const pts = [];
  for (let bIdx = 0; bIdx < bins; bIdx++) {
    const b = buckets[bIdx];
    if (!b[0].length) continue;
    const rgb = b.map((vals) => percentile(vals.sort((p, q) => p - q), 0.5));
    // in-bin MAD: a true 1-D gradient is constant across each bin, so a large spread means the
    // bin is contaminated (occluder shadow bleeding past a mask, layer sliver, texture)
    let mad = 0;
    for (let ch = 0; ch < 3; ch++) {
      mad += percentile(b[ch].map((v) => Math.abs(v - rgb[ch])).sort((p, q) => p - q), 0.5);
    }
    pts.push({ t: (bIdx + 0.5) / bins, rgb, n: b[0].length, mad: mad / 3 });
  }
  // drop unreliable bins — slivers (few cells after masking) and high-spread contaminated bins.
  // The stop model simply interpolates across the gaps.
  if (pts.length > 6) {
    const medianN = percentile(pts.map((p) => p.n).sort((a, b) => a - b), 0.5);
    const medianMad = percentile(pts.map((p) => p.mad).sort((a, b) => a - b), 0.5);
    const kept = pts.filter((p) => p.n >= Math.max(2, medianN * 0.12) && p.mad <= Math.max(4, medianMad * 3));
    if (kept.length >= Math.max(4, pts.length * 0.5)) return kept;
  }
  return pts; // ordered by t, empty bins skipped
}

// Direction-reversal count per channel with hysteresis. Strict per-channel monotonicity is TOO
// strict for real multi-stop designer gradients (corpus 013: green→yellow page gradient has a
// blue channel that rises ~20 levels through the mid-green then falls again — one clean
// reversal), while photos and stripe patterns oscillate many times. A gradient channel is
// accepted with ≤1 significant reversal; the piecewise stop model absorbs the bend.
function reversalCount(pts, ch, hysteresis) {
  let reversals = 0;
  let dir = 0; // -1 falling, +1 rising, 0 undecided
  let hi = pts[0].rgb[ch]; // running max since last confirmed low (or start)
  let lo = pts[0].rgb[ch]; // running min since last confirmed high (or start)
  for (let i = 1; i < pts.length; i++) {
    const v = pts[i].rgb[ch];
    if (v > hi) hi = v;
    if (v < lo) lo = v;
    if (dir !== -1 && hi - v > hysteresis) {
      if (dir === 1) reversals++;
      dir = -1; lo = v;
    } else if (dir !== 1 && v - lo > hysteresis) {
      if (dir === -1) reversals++;
      dir = 1; hi = v;
    }
  }
  return reversals;
}

function lerpRgb(c0, c1, f) {
  return [c0[0] + (c1[0] - c0[0]) * f, c0[1] + (c1[1] - c0[1]) * f, c0[2] + (c1[2] - c0[2]) * f];
}

function evalKnots(knots, t) {
  if (t <= knots[0].t) return knots[0].rgb;
  for (let i = 1; i < knots.length; i++) {
    if (t <= knots[i].t) {
      const span = knots[i].t - knots[i - 1].t || 1;
      return lerpRgb(knots[i - 1].rgb, knots[i].rgb, (t - knots[i - 1].t) / span);
    }
  }
  return knots[knots.length - 1].rgb;
}

// Greedy piecewise-linear reduction (Douglas–Peucker flavored): start with the two endpoints,
// insert the worst-error profile point until maxErr ≤ tol or the stop cap is hit. Endpoints are
// then extrapolated from their nearest segment to exact offsets 0/1 (bin centers sit at half-bin).
function fitStops(pts, { tol, maxStops }) {
  if (pts.length === 1) return { stops: [{ offset: 0, rgb: pts[0].rgb }, { offset: 1, rgb: pts[0].rgb }], maxErr: 0 };
  const knots = [pts[0], pts[pts.length - 1]];
  while (knots.length < maxStops) {
    let worst = -1, worstErr = 0;
    for (let i = 1; i < pts.length - 1; i++) {
      const est = evalKnots(knots, pts[i].t);
      const err = Math.max(
        Math.abs(est[0] - pts[i].rgb[0]),
        Math.abs(est[1] - pts[i].rgb[1]),
        Math.abs(est[2] - pts[i].rgb[2]),
      );
      if (err > worstErr) { worstErr = err; worst = i; }
    }
    if (worst < 0 || worstErr <= tol) break;
    const p = pts[worst];
    const at = knots.findIndex((kn) => kn.t > p.t);
    knots.splice(at === -1 ? knots.length : at, 0, p);
  }
  // extrapolate first/last knot to exact 0 / 1 along their adjacent segment slope
  const ex = knots.map((kn) => ({ t: kn.t, rgb: kn.rgb.slice() }));
  if (ex.length >= 2) {
    const [k0, k1] = [ex[0], ex[1]];
    const span0 = k1.t - k0.t || 1;
    ex[0] = { t: 0, rgb: lerpRgb(k0.rgb, k1.rgb, (0 - k0.t) / span0) };
    const [ka, kb] = [ex[ex.length - 2], ex[ex.length - 1]];
    const span1 = kb.t - ka.t || 1;
    ex[ex.length - 1] = { t: 1, rgb: lerpRgb(ka.rgb, kb.rgb, (1 - ka.t) / span1) };
  }
  // merge stops that landed nearly on top of each other
  let merged = [ex[0]];
  for (let i = 1; i < ex.length; i++) {
    if (ex[i].t - merged[merged.length - 1].t < 0.04 && i < ex.length - 1) continue;
    merged.push(ex[i]);
  }
  // greedy MINIMAL-stop prune: drop any interior knot whose removal keeps the profile error
  // inside tol (DP occasionally leaves a redundant knot after endpoint extrapolation)
  const profErr = (knots) => {
    let e = 0;
    for (const p of pts) {
      const est = evalKnots(knots, p.t);
      e = Math.max(e,
        Math.abs(est[0] - p.rgb[0]), Math.abs(est[1] - p.rgb[1]), Math.abs(est[2] - p.rgb[2]));
    }
    return e;
  };
  let pruned = true;
  while (pruned && merged.length > 2) {
    pruned = false;
    let bestIdx = -1, bestErr = Infinity;
    for (let i = 1; i < merged.length - 1; i++) {
      const without = merged.slice(0, i).concat(merged.slice(i + 1));
      const e = profErr(without);
      if (e < bestErr) { bestErr = e; bestIdx = i; }
    }
    if (bestIdx !== -1 && bestErr <= tol) {
      merged = merged.slice(0, bestIdx).concat(merged.slice(bestIdx + 1));
      pruned = true;
    }
  }
  const maxErr = profErr(merged);
  const stops = merged.map((kn) => ({
    offset: Math.round(clamp01(kn.t) * 1000) / 1000,
    rgb: kn.rgb.map((c) => clamp(c, 0, 255)),
  }));
  return { stops, maxErr };
}

// residual of a stop model over samples projected to t: {mean, trimmed}. `trimmed` drops the
// worst 15% of per-cell errors so small unmasked occluders can't flip a clean gradient to photo;
// gates and confidence use `trimmed`, `mean` is reported when it diverges.
function stopModelResidual(ts, rgbs, stops) {
  const knots = stops.map((s) => ({ t: s.offset, rgb: s.rgb }));
  const errs = new Float64Array(ts.length);
  for (let i = 0; i < ts.length; i++) {
    const est = evalKnots(knots, ts[i]);
    errs[i] = (Math.abs(est[0] - rgbs[i * 3]) + Math.abs(est[1] - rgbs[i * 3 + 1]) + Math.abs(est[2] - rgbs[i * 3 + 2])) / 3;
  }
  if (!ts.length) return { mean: 255, trimmed: 255 };
  let sum = 0;
  for (const e of errs) sum += e;
  const sorted = Float64Array.from(errs).sort();
  const keep = Math.max(1, Math.floor(sorted.length * 0.85));
  let tSum = 0;
  for (let i = 0; i < keep; i++) tSum += sorted[i];
  return { mean: sum / errs.length, trimmed: tSum / keep };
}

// ---------------------------------------------------------------------------------------------
// model attempts on the downsampled grid
// ---------------------------------------------------------------------------------------------

function collectCells(grid) {
  const xs = [], ys = [], idx = [];
  for (let y = 0; y < grid.h; y++) {
    for (let x = 0; x < grid.w; x++) {
      const i = y * grid.w + x;
      if (grid.valid[i]) { xs.push(x); ys.push(y); idx.push(i); }
    }
  }
  return { xs, ys, idx };
}

function flatStats(grid, cells) {
  const med = [0, 0, 0], spread = [0, 0, 0];
  let residual = 0;
  for (let ch = 0; ch < 3; ch++) {
    const vals = cells.idx.map((i) => grid.rgb[i * 3 + ch]).sort((p, q) => p - q);
    med[ch] = percentile(vals, 0.5);
    spread[ch] = percentile(vals, 0.95) - percentile(vals, 0.05);
  }
  for (const i of cells.idx) {
    residual += (Math.abs(grid.rgb[i * 3] - med[0]) + Math.abs(grid.rgb[i * 3 + 1] - med[1]) + Math.abs(grid.rgb[i * 3 + 2] - med[2])) / 3;
  }
  residual /= Math.max(1, cells.idx.length);
  return { color: med, maxSpread: Math.max(...spread), residual };
}

function tryLinear(grid, cells, o) {
  const planes = [];
  for (let ch = 0; ch < 3; ch++) {
    const vs = cells.idx.map((i) => grid.rgb[i * 3 + ch]);
    planes.push(fitPlaneIRLS(cells.xs, cells.ys, vs));
  }
  // per-channel gradient direction in cell space; span = color change across the grid extent
  const dirs = planes.map((p) => {
    const span = Math.hypot(p.a * (grid.w - 1), p.b * (grid.h - 1));
    return { a: p.a, b: p.b, span };
  });
  const active = dirs.filter((d) => d.span >= o.minGradientSpan);
  if (!active.length) return { ok: false, reason: 'no channel moves', residual: mean3(planes) };
  // collinearity across active channels (parallel up to sign)
  let ref = active[0];
  for (const d of active) if (d.span > ref.span) ref = d;
  const refMag = Math.hypot(ref.a, ref.b) || 1;
  for (const d of active) {
    const mag = Math.hypot(d.a, d.b) || 1;
    const sin = Math.abs(d.a * ref.b - d.b * ref.a) / (mag * refMag);
    if (sin > o.collinearSinMax) return { ok: false, reason: 'channels not collinear', residual: mean3(planes) };
  }
  // shared axis: magnitude-weighted average of sign-aligned channel directions (cell space)
  let ax = 0, ay = 0;
  for (const d of active) {
    const s = d.a * ref.a + d.b * ref.b >= 0 ? 1 : -1;
    ax += s * d.a * d.span; ay += s * d.b * d.span;
  }
  const am = Math.hypot(ax, ay);
  if (am < 1e-9) return { ok: false, reason: 'degenerate axis', residual: mean3(planes) };
  ax /= am; ay /= am; // unit, cell space == pixel space direction (square cells)

  // 1-D profile along the axis over valid cells
  let pMin = Infinity, pMax = -Infinity;
  const proj = new Float64Array(cells.idx.length);
  for (let i = 0; i < cells.idx.length; i++) {
    const p = cells.xs[i] * ax + cells.ys[i] * ay;
    proj[i] = p;
    if (p < pMin) pMin = p;
    if (p > pMax) pMax = p;
  }
  const span = pMax - pMin || 1;
  const ts = Array.from(proj, (p) => (p - pMin) / span);
  const rgbs = new Float32Array(cells.idx.length * 3);
  cells.idx.forEach((gi, i) => {
    rgbs[i * 3] = grid.rgb[gi * 3]; rgbs[i * 3 + 1] = grid.rgb[gi * 3 + 1]; rgbs[i * 3 + 2] = grid.rgb[gi * 3 + 2];
  });
  const pts = buildProfile(ts, rgbs, Math.min(o.profileBins, Math.max(8, Math.round(span))));
  if (pts.length < 4) return { ok: false, reason: 'profile too short', residual: mean3(planes) };
  for (let ch = 0; ch < 3; ch++) {
    // every channel votes here (a stripe pattern can oscillate in a channel whose plane fit is
    // flat); hysteresis scales with the channel's profile range so noise doesn't count
    let cLo = Infinity, cHi = -Infinity;
    for (const p of pts) { cLo = Math.min(cLo, p.rgb[ch]); cHi = Math.max(cHi, p.rgb[ch]); }
    const range = cHi - cLo;
    if (range < o.minGradientSpan) continue; // channel effectively flat → no vote
    const hyst = Math.max(3, range * 0.18);
    const rev = reversalCount(pts, ch, hyst);
    if (rev > o.maxReversals) {
      return { ok: false, reason: `channel ${ch} oscillates (${rev} reversals)`, residual: mean3(planes) };
    }
  }
  const { stops } = fitStops(pts, { tol: o.stopTol, maxStops: o.maxStops });
  const res = stopModelResidual(ts, rgbs, stops);
  if (res.trimmed > o.linearResidualMax) return { ok: false, reason: 'residual too high', residual: res.trimmed };
  return {
    ok: true,
    residual: res.trimmed,
    residualFull: res.mean,
    angleDeg: Math.round(cssAngleFromDir(ax, ay) * 10) / 10,
    stops: stops.map((s) => ({ offset: s.offset, color: toHex(s.rgb) })),
    colorSpan: Math.max(
      ...[0, 1, 2].map((ch) => {
        let lo = Infinity, hi = -Infinity;
        for (const s of stops) { lo = Math.min(lo, s.rgb[ch]); hi = Math.max(hi, s.rgb[ch]); }
        return hi - lo;
      }),
    ),
  };
}

function mean3(planes) {
  return (planes[0].residual + planes[1].residual + planes[2].residual) / 3;
}

function tryRadial(grid, cells, o) {
  const { w, h } = grid;
  if (w < 5 || h < 5) return { ok: false, reason: 'grid too small', residual: 255 };
  // luminance + Sobel over fully-valid neighborhoods
  const lum = new Float32Array(w * h);
  for (const i of cells.idx) lum[i] = 0.2126 * grid.rgb[i * 3] + 0.7152 * grid.rgb[i * 3 + 1] + 0.0722 * grid.rgb[i * 3 + 2];
  const gpts = [];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      let ok = true;
      for (let dy = -1; dy <= 1 && ok; dy++) for (let dx = -1; dx <= 1; dx++) if (!grid.valid[(y + dy) * w + (x + dx)]) { ok = false; break; }
      if (!ok) continue;
      const L = (yy, xx) => lum[yy * w + xx];
      const gx = (L(y - 1, x + 1) + 2 * L(y, x + 1) + L(y + 1, x + 1) - L(y - 1, x - 1) - 2 * L(y, x - 1) - L(y + 1, x - 1)) / 8;
      const gy = (L(y + 1, x - 1) + 2 * L(y + 1, x) + L(y + 1, x + 1) - L(y - 1, x - 1) - 2 * L(y - 1, x) - L(y - 1, x + 1)) / 8;
      const mag = Math.hypot(gx, gy);
      if (mag > 0.15) gpts.push({ x, y, gx: gx / mag, gy: gy / mag, mag });
    }
  }
  if (gpts.length < 12) return { ok: false, reason: 'too few gradient samples', residual: 255 };
  // keep the stronger half so flat inner cores don't drown the signal
  gpts.sort((p, q) => q.mag - p.mag);
  const used = gpts.slice(0, Math.max(12, Math.floor(gpts.length * 0.6)));
  // center = least-squares intersection of lines through p along g: Σ w·(I − ggᵀ)(c − p) = 0
  let a00 = 0, a01 = 0, a11 = 0, b0 = 0, b1 = 0;
  for (const p of used) {
    const wgt = p.mag;
    const pxx = 1 - p.gx * p.gx, pxy = -p.gx * p.gy, pyy = 1 - p.gy * p.gy;
    a00 += wgt * pxx; a01 += wgt * pxy; a11 += wgt * pyy;
    b0 += wgt * (pxx * p.x + pxy * p.y);
    b1 += wgt * (pxy * p.x + pyy * p.y);
  }
  const det = a00 * a11 - a01 * a01;
  if (Math.abs(det) < 1e-9) return { ok: false, reason: 'singular center system', residual: 255 };
  const cx = (a11 * b0 - a01 * b1) / det;
  const cy = (a00 * b1 - a01 * b0) / det;
  if (cx < -0.6 * w || cx > 1.6 * w || cy < -0.6 * h || cy > 1.6 * h) {
    return { ok: false, reason: 'center far outside region', residual: 255 };
  }
  // coherence: gradients should point along the radial direction (either sign)
  let coh = 0, cohW = 0;
  for (const p of used) {
    const rx = p.x - cx, ry = p.y - cy;
    const rm = Math.hypot(rx, ry);
    if (rm < 1.5) continue;
    coh += p.mag * Math.abs((rx * p.gx + ry * p.gy) / rm);
    cohW += p.mag;
  }
  const coherence = cohW ? coh / cohW : 0;
  if (coherence < o.radialCoherenceMin) return { ok: false, reason: 'gradient field not radial', residual: 255, coherence };
  // radius profile over ALL valid cells
  let rMax = 0;
  const rs = new Float64Array(cells.idx.length);
  for (let i = 0; i < cells.idx.length; i++) {
    const r = Math.hypot(cells.xs[i] - cx, cells.ys[i] - cy);
    rs[i] = r;
    if (r > rMax) rMax = r;
  }
  rMax = rMax || 1;
  const ts = Array.from(rs, (r) => r / rMax);
  const rgbs = new Float32Array(cells.idx.length * 3);
  cells.idx.forEach((gi, i) => {
    rgbs[i * 3] = grid.rgb[gi * 3]; rgbs[i * 3 + 1] = grid.rgb[gi * 3 + 1]; rgbs[i * 3 + 2] = grid.rgb[gi * 3 + 2];
  });
  const pts = buildProfile(ts, rgbs, o.profileBins);
  if (pts.length < 4) return { ok: false, reason: 'radius profile too short', residual: 255 };
  const { stops } = fitStops(pts, { tol: o.stopTol, maxStops: o.maxStops });
  const res = stopModelResidual(ts, rgbs, stops);
  if (res.trimmed > o.radialResidualMax) return { ok: false, reason: 'residual too high', residual: res.trimmed, coherence };
  // cell coords → region-pixel percentages
  const f = grid.factor;
  const pxW = grid.w * f, pxH = grid.h * f;
  return {
    ok: true,
    residual: res.trimmed,
    residualFull: res.mean,
    coherence,
    center: {
      xPct: Math.round(((cx + 0.5) * f / pxW) * 1000) / 10,
      yPct: Math.round(((cy + 0.5) * f / pxH) * 1000) / 10,
    },
    radiusPct: Math.round((rMax * f / (0.5 * Math.hypot(pxW, pxH))) * 1000) / 10,
    stops: stops.map((s) => ({ offset: s.offset, color: toHex(s.rgb) })),
  };
}

// ---------------------------------------------------------------------------------------------
// public: fitRegionFill
// ---------------------------------------------------------------------------------------------

/**
 * Decide flat / linear / radial / photo for a region and fit parameters.
 * @param pixels {data: Uint8Array RGBA, width, height}
 * @param region {x,y,w,h} and/or {mask} (see extractRegion); null/undefined = whole image
 * @param opts   overrides for DEFAULTS
 */
export function fitRegionFill(pixels, region, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  try {
    const reg = extractRegion(pixels, region);
    const factor = chooseFactor(reg.w, reg.h, o.minDownsampleFactor, o.maxGridDim);
    const grid = downsampleRegion(reg, factor);
    const cells = collectCells(grid);
    if (cells.idx.length < 4) {
      // degenerate: average what we have and call it flat with low confidence
      const st = flatStats(grid, cells);
      return { kind: 'flat', color: toHex(st.color), residual: round2(st.residual), confidence: 0.3 };
    }
    const flat = flatStats(grid, cells);
    if (flat.maxSpread <= o.superFlatSpread) {
      return {
        kind: 'flat', color: toHex(flat.color),
        residual: round2(flat.residual),
        confidence: round2(clamp01(1 - flat.maxSpread / 20)),
      };
    }
    const lin = tryLinear(grid, cells, o);
    if (lin.ok && lin.colorSpan >= o.minGradientSpan) {
      const out = {
        kind: 'linear', stops: lin.stops, angleDeg: lin.angleDeg,
        residual: round2(lin.residual),
        confidence: round2(clamp01(1 - lin.residual / (o.linearResidualMax * 1.5))),
      };
      if (lin.residualFull - lin.residual > 1) out.residualFull = round2(lin.residualFull);
      return out;
    }
    const rad = tryRadial(grid, cells, o);
    if (rad.ok) {
      const out = {
        kind: 'radial', stops: rad.stops, center: rad.center, radiusPct: rad.radiusPct,
        residual: round2(rad.residual),
        confidence: round2(clamp01((1 - rad.residual / (o.radialResidualMax * 1.5)) * rad.coherence)),
      };
      if (rad.residualFull - rad.residual > 1) out.residualFull = round2(rad.residualFull);
      return out;
    }
    if (flat.maxSpread <= o.flatSpread) {
      return {
        kind: 'flat', color: toHex(flat.color),
        residual: round2(flat.residual),
        confidence: round2(clamp01(1 - flat.maxSpread / 30)),
      };
    }
    const bestResidual = Math.min(flat.residual, lin.residual ?? 255, rad.residual ?? 255);
    return {
      kind: 'photo',
      residual: round2(bestResidual),
      confidence: round2(clamp01((bestResidual - o.linearResidualMax) / 25)),
      detail: { flatSpread: round2(flat.maxSpread), linear: lin.reason, radial: rad.reason },
    };
  } catch (err) {
    return { kind: 'photo', residual: 255, confidence: 0, error: String(err?.message || err) };
  }
}

const round2 = (v) => Math.round(v * 100) / 100;

// ---------------------------------------------------------------------------------------------
// public: solveScrim
// ---------------------------------------------------------------------------------------------

/**
 * Solve observed = α·scrim + (1−α)·background per pixel for ONE scrim color + an alpha field,
 * then classify the alpha field as flat or a linear ramp.
 * @param pixelsObserved   {data,width,height} — the composited image
 * @param pixelsBackground {data,width,height} — the clean background (inpaint or clean crop);
 *                         either same size as observed, or exactly region-sized
 * @param region           {x,y,w,h} (+optional mask) in observed coords
 */
export function solveScrim(pixelsObserved, pixelsBackground, region) {
  try {
    const obs = extractRegion(pixelsObserved, region);
    const bgRegion =
      pixelsBackground.width === obs.w && pixelsBackground.height === obs.h
        ? { x: 0, y: 0, w: obs.w, h: obs.h, mask: region?.mask && region.mask.length === obs.w * obs.h ? region.mask : undefined }
        : region;
    const bg = extractRegion(pixelsBackground, bgRegion);
    if (bg.w !== obs.w || bg.h !== obs.h) throw new Error('observed/background region size mismatch');
    const factor = chooseFactor(obs.w, obs.h, DEFAULTS.minDownsampleFactor, DEFAULTS.maxGridDim);
    const gObs = downsampleRegion(obs, factor);
    const gBg = downsampleRegion(bg, factor);
    const idx = [];
    for (let i = 0; i < gObs.valid.length; i++) if (gObs.valid[i] && gBg.valid[i]) idx.push(i);
    if (idx.length < 8) throw new Error('too few overlapping samples');

    // init scrim color: darkening scrims → black, lightening → white
    let meanObs = 0, meanBg = 0;
    for (const i of idx) {
      meanObs += gObs.rgb[i * 3] + gObs.rgb[i * 3 + 1] + gObs.rgb[i * 3 + 2];
      meanBg += gBg.rgb[i * 3] + gBg.rgb[i * 3 + 1] + gBg.rgb[i * 3 + 2];
    }
    let s = meanObs <= meanBg ? [0, 0, 0] : [255, 255, 255];
    const alpha = new Float64Array(idx.length);
    // alternating least squares: α given s, then s given α
    for (let it = 0; it < 10; it++) {
      for (let n = 0; n < idx.length; n++) {
        const i = idx[n];
        let num = 0, den = 0;
        for (let ch = 0; ch < 3; ch++) {
          const d = s[ch] - gBg.rgb[i * 3 + ch];
          num += (gObs.rgb[i * 3 + ch] - gBg.rgb[i * 3 + ch]) * d;
          den += d * d;
        }
        alpha[n] = den > 1e-6 ? clamp01(num / den) : 0;
      }
      const sNew = [0, 0, 0];
      let denom = 0;
      for (let n = 0; n < idx.length; n++) {
        const i = idx[n], al = alpha[n];
        denom += al * al;
        for (let ch = 0; ch < 3; ch++) sNew[ch] += al * (gObs.rgb[i * 3 + ch] - (1 - al) * gBg.rgb[i * 3 + ch]);
      }
      if (denom < 1e-6) break; // no scrim present
      let moved = 0;
      for (let ch = 0; ch < 3; ch++) {
        const v = clamp(sNew[ch] / denom, 0, 255);
        moved += Math.abs(v - s[ch]);
        s[ch] = v;
      }
      if (moved < 0.5) break;
    }
    // reconstruction residual
    let residual = 0;
    for (let n = 0; n < idx.length; n++) {
      const i = idx[n], al = alpha[n];
      for (let ch = 0; ch < 3; ch++) {
        residual += Math.abs(gObs.rgb[i * 3 + ch] - (al * s[ch] + (1 - al) * gBg.rgb[i * 3 + ch])) / 3;
      }
    }
    residual /= idx.length;

    // classify the alpha field: plane fit → flat vs linear ramp
    const xs = idx.map((i) => i % gObs.w), ys = idx.map((i) => Math.floor(i / gObs.w));
    const plane = fitPlaneIRLS(xs, ys, Array.from(alpha));
    const rampSpan = Math.hypot(plane.a * (gObs.w - 1), plane.b * (gObs.h - 1));
    let alphaOut;
    if (rampSpan < 0.08) {
      let m = 0;
      for (const al of alpha) m += al;
      alphaOut = { kind: 'flat', value: round3(m / alpha.length) };
    } else {
      const am = Math.hypot(plane.a, plane.b) || 1;
      const ax = plane.a / am, ay = plane.b / am;
      let pMin = Infinity, pMax = -Infinity;
      for (let n = 0; n < xs.length; n++) {
        const p = xs[n] * ax + ys[n] * ay;
        if (p < pMin) pMin = p;
        if (p > pMax) pMax = p;
      }
      // evaluate the plane at the two axis extremes — the component of (x,y) perpendicular to
      // the gradient direction contributes nothing, so α along the axis is |grad|·p + k
      const from = clamp01(plane.a * (ax * pMin) + plane.b * (ay * pMin) + plane.k);
      const to = clamp01(plane.a * (ax * pMax) + plane.b * (ay * pMax) + plane.k);
      alphaOut = {
        kind: 'linear',
        from: round3(from),
        to: round3(to),
        angleDeg: Math.round(cssAngleFromDir(ax, ay) * 10) / 10,
      };
    }
    let meanAlpha = 0;
    for (const al of alpha) meanAlpha += al;
    meanAlpha /= alpha.length;
    return {
      ok: residual <= DEFAULTS.scrimResidualMax && meanAlpha >= 0.03,
      color: toHex(s),
      alpha: alphaOut,
      residual: round2(residual),
    };
  } catch (err) {
    return { ok: false, color: '#000000', alpha: { kind: 'flat', value: 0 }, residual: 255, error: String(err?.message || err) };
  }
}

const round3 = (v) => Math.round(v * 1000) / 1000;

// ---------------------------------------------------------------------------------------------
// public: renderFill — re-render a fitted fill (S9 uses this to refill occlusion holes; tests and
// debug overlays use it for visual comparison). Photo verdicts render mid-gray.
// ---------------------------------------------------------------------------------------------

export function renderFill(fit, width, height) {
  const data = new Uint8Array(width * height * 4);
  const put = (i, rgb) => {
    data[i * 4] = clamp(Math.round(rgb[0]), 0, 255);
    data[i * 4 + 1] = clamp(Math.round(rgb[1]), 0, 255);
    data[i * 4 + 2] = clamp(Math.round(rgb[2]), 0, 255);
    data[i * 4 + 3] = 255;
  };
  const hexRgb = (hex) => [1, 3, 5].map((p) => parseInt(hex.slice(p, p + 2), 16));
  try {
    if (fit.kind === 'flat') {
      const rgb = hexRgb(fit.color);
      for (let i = 0; i < width * height; i++) put(i, rgb);
    } else if (fit.kind === 'linear') {
      const { dx, dy } = dirFromCssAngle(fit.angleDeg ?? 180);
      const corners = [[0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1]];
      let pMin = Infinity, pMax = -Infinity;
      for (const [x, y] of corners) {
        const p = x * dx + y * dy;
        pMin = Math.min(pMin, p); pMax = Math.max(pMax, p);
      }
      const span = pMax - pMin || 1;
      const knots = fit.stops.map((s) => ({ t: s.offset, rgb: hexRgb(s.color) }));
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const t = (x * dx + y * dy - pMin) / span;
          put(y * width + x, evalKnots(knots, t));
        }
      }
    } else if (fit.kind === 'radial') {
      const cx = ((fit.center?.xPct ?? 50) / 100) * width;
      const cy = ((fit.center?.yPct ?? 50) / 100) * height;
      const rNorm = ((fit.radiusPct ?? 100) / 100) * 0.5 * Math.hypot(width, height) || 1;
      const knots = fit.stops.map((s) => ({ t: s.offset, rgb: hexRgb(s.color) }));
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const t = Math.hypot(x - cx, y - cy) / rNorm;
          put(y * width + x, evalKnots(knots, t));
        }
      }
    } else {
      for (let i = 0; i < width * height; i++) put(i, [128, 128, 128]);
    }
  } catch {
    for (let i = 0; i < width * height; i++) put(i, [128, 128, 128]);
  }
  return { data, width, height };
}

export { DEFAULTS as FILL_FIT_DEFAULTS };
