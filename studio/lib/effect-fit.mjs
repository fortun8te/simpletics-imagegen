// lib/effect-fit.mjs — S7 EFFECT PARAMETER FITTING: drop shadows + vignettes.
//
// THE GAP THIS KILLS: the old pipeline flattened every soft shadow and vignette into the
// background photo — cards floated with no depth, and darkened photo corners were baked into a
// wrong "photo" verdict. This module recovers PARAMETRIC effect layers by analysis-by-synthesis:
// hypothesize effect params, render the effect with the same math our renderer uses, and minimize
// pixel loss against the observed residual. 100% deterministic math — no model calls, no Chrome.
//
// fitDropShadow(pixels, element, background, opts) → { found, dx, dy, sigma, opacity, color, residualGain }
//   • residual halo = observed − background-model, measured OUTSIDE the element mask within a
//     search margin (~1.5× the max offset). background accepts the same flexible spec as
//     element-detect / fill-fit: {kind:'flat'|'linear'|'radial',...} (rendered via fill-fit's
//     renderFill), raw {data,width,height} pixels, or null → robust per-channel plane fit on
//     the non-element crop pixels (absorbs photo lighting drift; Huber-downweights the halo).
//     opts.excludeBoxes: canvas-space boxes (S1 text lines, sibling elements) dropped from
//     the residual, mirroring the pipeline's text masking.
//   • forward model: element silhouette (alpha if given, else the box rect) offset by (dx,dy),
//     blurred with a separable 3-pass box-blur Gaussian approximation at sigma, times
//     opacity·color, composited over the background. Coarse grid dx,dy ∈ ±24 step 8,
//     sigma ∈ {2,6,12,20,32} (+ a seed sigma fit from the halo edge falloff profile), per-channel
//     closed-form least-squares amplitude per candidate, then coordinate-descent refinement.
//   • found when the best model beats the "no shadow" baseline by ≥15% mean-|residual|
//     reduction (residualGain = 1 − bestErr/baselineErr) OR — for real photos where noise
//     dilutes the global mean — when the reduction ON THE SHADOW'S SUPPORT (supportGain,
//     pixels with model alpha > 0.02) is ≥30% with support ≥4% of the halo, amplitude above
//     noise, and the global residual still improved ≥5%.
//   • all work happens on a ≤512px crop around the element (<1 s per element).
//
// fitVignette(pixels, excludeBoxes) → { found, strength, radiusPct, centerBias }
//   • masks out excludeBoxes, fits the standard vignetting-correction polynomial
//     L(r) = L0·(1 + a·r² + b·r⁴) on radial-bin luminance medians (weighted least squares),
//     r normalized to the HALF-DIAGONAL (this matches the renderer: vignetteCanvas in
//     src/components/design/fills.ts uses R = hypot(w,h)/2, and vignetteSvgDef r=0.72).
//   • found when a,b are meaningfully negative (≥8% corner attenuation), the fit residual is
//     low, and the outer profile is monotone-ish decreasing.
//   • RENDERER MAPPING (READ fills.ts vignette + designstore.mjs vignetteCssJs): the renderer's
//     vignette layer is a radial gradient — transparent from center out to stop `size`
//     (fraction of half-diagonal, clamped 0..0.95), then LINEAR alpha ramp to `strength` at
//     r=1, color from style.background (black by default). Its luminance attenuation is
//     g(r) = 1 − strength·clamp((r−size)/(1−size), 0, 1). We fit (size, strength) to the
//     measured polynomial attenuation by least squares on sampled r ⇒
//     strength = layer.style.vignette.strength, radiusPct = 100·size (so callers set
//     style.vignette = { strength, size: radiusPct/100 }, style.background = '#000000').
//   • centerBias = { xPct, yPct }: offset of the best-fitting vignette center from the image
//     center, in percent of width/height (renderer only draws centered vignettes; a large bias
//     means "this is directional lighting, not a vignette" — we cap found at |bias| ≤ 20%).
//
// Invariants:
//   • Neither entry point ever throws — any internal failure returns { found: false, error }.
//   • Pure functions of the pixel input; dx/dy/sigma are reported in FULL-RESOLUTION px even
//     though fitting runs at analysis scale.

import { renderFill } from './fill-fit.mjs';

// ---------------------------------------------------------------------------------------------
// tunables
// ---------------------------------------------------------------------------------------------

const SHADOW = {
  maxOffset: 24,            // coarse grid reach (full-res px)
  offsetStep: 8,
  sigmas: [2, 6, 12, 20, 32],
  marginFactor: 1.5,        // search margin = marginFactor × maxOffset
  analysisMax: 512,         // crop is downscaled so max(w,h) ≤ this
  maxEvalPixels: 24000,     // subsample the halo ring beyond this for the coarse grid
  foundGain: 0.15,          // require ≥15% residual reduction vs no-shadow baseline
  maskDilate: 2,            // px (analysis scale) of element-mask dilation excluded from eval
  refineRounds: 3,
};

const VIGNETTE = {
  analysisMax: 320,
  bins: 30,                 // radial luminance bins
  minEdgeDrop: 0.08,        // ≥8% corner attenuation to count as a vignette
  maxRelResidual: 0.045,    // RMS of (bin − model)/L0
  maxCenterBias: 20,        // % — beyond this it's directional light, not a vignette
  centerGrid: [-0.16, -0.08, 0, 0.08, 0.16], // center offsets searched, fraction of dim
};

// ---------------------------------------------------------------------------------------------
// small pixel helpers
// ---------------------------------------------------------------------------------------------

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const round1 = (v) => Math.round(v * 10) / 10;
const round3 = (v) => Math.round(v * 1000) / 1000;
const toHex = (rgb) =>
  '#' + rgb.map((c) => clamp(Math.round(c), 0, 255).toString(16).padStart(2, '0')).join('');

// box-average downscale of an RGBA buffer by integer factor f
function downscaleRgba(src, w, h, f) {
  if (f <= 1) return { data: src, width: w, height: h };
  const ow = Math.max(1, Math.floor(w / f));
  const oh = Math.max(1, Math.floor(h / f));
  const out = new Uint8Array(ow * oh * 4);
  for (let oy = 0; oy < oh; oy++) {
    for (let ox = 0; ox < ow; ox++) {
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let dy = 0; dy < f; dy++) {
        const sy = oy * f + dy;
        if (sy >= h) break;
        for (let dx = 0; dx < f; dx++) {
          const sx = ox * f + dx;
          if (sx >= w) break;
          const i = (sy * w + sx) * 4;
          r += src[i]; g += src[i + 1]; b += src[i + 2]; a += src[i + 3]; n++;
        }
      }
      const o = (oy * ow + ox) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = a / n;
    }
  }
  return { data: out, width: ow, height: oh };
}

// box-average downscale of a single-channel Float32 buffer by integer factor f
function downscaleGray(src, w, h, f, ow, oh) {
  if (f <= 1) return src;
  const out = new Float32Array(ow * oh);
  for (let oy = 0; oy < oh; oy++) {
    for (let ox = 0; ox < ow; ox++) {
      let s = 0, n = 0;
      for (let dy = 0; dy < f; dy++) {
        const sy = oy * f + dy;
        if (sy >= h) break;
        for (let dx = 0; dx < f; dx++) {
          const sx = ox * f + dx;
          if (sx >= w) break;
          s += src[sy * w + sx]; n++;
        }
      }
      out[oy * ow + ox] = n ? s / n : 0;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// separable Gaussian via three box-blur passes (Kovesi's boxesForGauss)
// ---------------------------------------------------------------------------------------------

function boxesForGauss(sigma, n) {
  const wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(wIdeal);
  if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const mIdeal = (12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4);
  const m = Math.round(mIdeal);
  const sizes = [];
  for (let i = 0; i < n; i++) sizes.push(i < m ? wl : wu);
  return sizes;
}

function boxBlurH(src, dst, w, h, r) {
  const iarr = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = src[row] * (r + 1);
    for (let x = 0; x < r; x++) acc += src[row + Math.min(x, w - 1)];
    for (let x = 0; x < w; x++) {
      acc += src[row + Math.min(x + r, w - 1)] - src[row + Math.max(x - r - 1, 0)];
      dst[row + x] = acc * iarr;
    }
  }
}

function boxBlurV(src, dst, w, h, r) {
  const iarr = 1 / (2 * r + 1);
  for (let x = 0; x < w; x++) {
    let acc = src[x] * (r + 1);
    for (let y = 0; y < r; y++) acc += src[Math.min(y, h - 1) * w + x];
    for (let y = 0; y < h; y++) {
      acc += src[Math.min(y + r, h - 1) * w + x] - src[Math.max(y - r - 1, 0) * w + x];
      dst[y * w + x] = acc * iarr;
    }
  }
}

// gaussianBlur: Float32 in → new Float32 out; 3 box passes ≈ true Gaussian within ~3%
function gaussianBlur(src, w, h, sigma) {
  if (!(sigma > 0.3)) return Float32Array.from(src);
  let a = Float32Array.from(src);
  let b = new Float32Array(src.length);
  for (const size of boxesForGauss(sigma, 3)) {
    const r = Math.max(0, (size - 1) / 2);
    boxBlurH(a, b, w, h, r);
    boxBlurV(b, a, w, h, r);
  }
  return a;
}

// ---------------------------------------------------------------------------------------------
// background resolution (same flexible spec as element-detect / fill-fit verdicts)
// ---------------------------------------------------------------------------------------------

// returns an RGBA crop of the background model matching cropRect at full resolution
function resolveBackgroundCrop(pixels, spec, cropRect, elementMaskFullRes) {
  const { x, y, w, h } = cropRect;
  const crop = (srcData, srcW) => {
    const out = new Uint8Array(w * h * 4);
    for (let yy = 0; yy < h; yy++) {
      const so = ((y + yy) * srcW + x) * 4;
      out.set(srcData.subarray(so, so + w * 4), yy * w * 4);
    }
    return out;
  };
  if (spec && spec.data && spec.width === pixels.width && spec.height === pixels.height) {
    return crop(spec.data, spec.width); // raw background pixels
  }
  if (spec && (spec.kind === 'flat' || spec.kind === 'linear' || spec.kind === 'radial')) {
    // render the fitted fill at full canvas geometry (gradient params are canvas-relative)
    const rendered = renderFill(spec, pixels.width, pixels.height);
    return crop(rendered.data, rendered.width);
  }
  // null / unknown → ROBUST PLANE per channel fit on non-element crop pixels (2 IRLS rounds,
  // Huber weights). A flat median fails on real photos whose lighting drifts across the crop —
  // the plane absorbs that drift while the shadow bump gets downweighted as an outlier.
  const pts = [];
  const stride = Math.max(1, Math.floor(Math.sqrt((w * h) / 20000)));
  for (let yy = 0; yy < h; yy += stride) {
    for (let xx = 0; xx < w; xx += stride) {
      if (elementMaskFullRes && elementMaskFullRes[yy * w + xx]) continue;
      const i = ((y + yy) * pixels.width + (x + xx)) * 4;
      pts.push([xx, yy, pixels.data[i], pixels.data[i + 1], pixels.data[i + 2]]);
    }
  }
  const out = new Uint8Array(w * h * 4);
  if (pts.length < 16) { out.fill(128); for (let i = 3; i < out.length; i += 4) out[i] = 255; return out; }
  const planes = [];
  for (let c = 0; c < 3; c++) {
    let wts = new Float64Array(pts.length).fill(1);
    let coef = [0, 0, pts[0][2 + c]];
    for (let it = 0; it < 3; it++) {
      let sxx = 0, sxy2 = 0, sx = 0, syy = 0, sy = 0, sw = 0, vx = 0, vy = 0, v1 = 0;
      for (let k = 0; k < pts.length; k++) {
        const [px, py] = pts[k], L = pts[k][2 + c], wt = wts[k];
        sxx += wt * px * px; sxy2 += wt * px * py; syy += wt * py * py;
        sx += wt * px; sy += wt * py; sw += wt;
        vx += wt * px * L; vy += wt * py * L; v1 += wt * L;
      }
      const c3 = solveN([[sxx, sxy2, sx], [sxy2, syy, sy], [sx, sy, sw]], [vx, vy, v1], 3);
      if (!c3) break;
      coef = c3;
      // Huber reweight (delta = 10 levels)
      for (let k = 0; k < pts.length; k++) {
        const r = Math.abs(pts[k][2 + c] - (coef[0] * pts[k][0] + coef[1] * pts[k][1] + coef[2]));
        wts[k] = r <= 10 ? 1 : 10 / r;
      }
    }
    planes.push(coef);
  }
  for (let yy = 0; yy < h; yy++) {
    for (let xx = 0; xx < w; xx++) {
      const o = (yy * w + xx) * 4;
      for (let c = 0; c < 3; c++) {
        out[o + c] = clamp(Math.round(planes[c][0] * xx + planes[c][1] * yy + planes[c][2]), 0, 255);
      }
      out[o + 3] = 255;
    }
  }
  return out;
}

// element alpha → Float32 silhouette (0..1) at box size; accepts Uint8Array(box.w*box.h),
// {data,width,height} single-channel or RGBA (alpha channel used)
function silhouetteFromElement(element) {
  const { box, alpha } = element;
  const bw = Math.round(box.w), bh = Math.round(box.h);
  const sil = new Float32Array(bw * bh);
  if (alpha) {
    const a = alpha.data || alpha;
    const aw = alpha.width || bw, ah = alpha.height || bh;
    const chan = a.length === aw * ah * 4 ? 4 : 1;
    const off = chan === 4 ? 3 : 0;
    for (let yy = 0; yy < bh; yy++) {
      const sy = Math.min(ah - 1, Math.round((yy * ah) / bh));
      for (let xx = 0; xx < bw; xx++) {
        const sx = Math.min(aw - 1, Math.round((xx * aw) / bw));
        sil[yy * bw + xx] = a[(sy * aw + sx) * chan + off] / 255;
      }
    }
  } else {
    sil.fill(1);
  }
  return { sil, bw, bh };
}

// ---------------------------------------------------------------------------------------------
// fitDropShadow
// ---------------------------------------------------------------------------------------------

// opts.excludeBoxes: canvas-space boxes (e.g. S1 text lines) removed from the residual — the
// pipeline masks text before S7, so callers pass the known text/element boxes here
export function fitDropShadow(pixels, element, background, opts = {}) {
  try {
    return fitDropShadowInner(pixels, element, background, opts);
  } catch (err) {
    return { found: false, error: String(err?.message || err) };
  }
}

function fitDropShadowInner(pixels, element, background, opts = {}) {
  const W = pixels.width, H = pixels.height;
  const box = element?.box;
  if (!pixels?.data || !box || !(box.w > 0) || !(box.h > 0)) return { found: false, error: 'bad input' };

  const bx = clamp(Math.round(box.x), 0, W - 1);
  const by = clamp(Math.round(box.y), 0, H - 1);
  const bw = clamp(Math.round(box.w), 1, W - bx);
  const bh = clamp(Math.round(box.h), 1, H - by);

  // crop = box + search margin (blur/offset reach); full-res first
  const margin = Math.ceil(SHADOW.marginFactor * SHADOW.maxOffset) + 12; // +12 blur slack
  const cx0 = Math.max(0, bx - margin), cy0 = Math.max(0, by - margin);
  const cx1 = Math.min(W, bx + bw + margin), cy1 = Math.min(H, by + bh + margin);
  const cw = cx1 - cx0, ch = cy1 - cy0;
  if (cw < 8 || ch < 8) return { found: false, error: 'degenerate crop' };

  // full-res silhouette placed into crop coordinates (needed before bg for border-median mask)
  const { sil: boxSil, bw: sbw, bh: sbh } = silhouetteFromElement({ box: { ...box, w: bw, h: bh }, alpha: element.alpha });
  const silFull = new Float32Array(cw * ch);
  const maskFull = new Uint8Array(cw * ch);
  for (let yy = 0; yy < sbh; yy++) {
    const py = by - cy0 + yy;
    if (py < 0 || py >= ch) continue;
    for (let xx = 0; xx < sbw; xx++) {
      const px = bx - cx0 + xx;
      if (px < 0 || px >= cw) continue;
      const v = boxSil[yy * sbw + xx];
      silFull[py * cw + px] = v;
      if (v > 0.35) maskFull[py * cw + px] = 1;
    }
  }

  // observed + background crops (full res), then downscale everything to analysis scale
  const obsFull = new Uint8Array(cw * ch * 4);
  for (let yy = 0; yy < ch; yy++) {
    const so = ((cy0 + yy) * W + cx0) * 4;
    obsFull.set(pixels.data.subarray(so, so + cw * 4), yy * cw * 4);
  }
  const bgFull = resolveBackgroundCrop(pixels, background, { x: cx0, y: cy0, w: cw, h: ch }, maskFull);

  const f = Math.max(1, Math.ceil(Math.max(cw, ch) / SHADOW.analysisMax));
  const obs = downscaleRgba(obsFull, cw, ch, f);
  const bg = downscaleRgba(bgFull, cw, ch, f);
  const aw = obs.width, ah = obs.height;
  const sil = downscaleGray(silFull, cw, ch, f, aw, ah);

  // element mask at analysis scale, dilated — these pixels never enter the residual
  const mask = new Uint8Array(aw * ah);
  for (let i = 0; i < aw * ah; i++) if (sil[i] > 0.2) mask[i] = 1;
  const dil = new Uint8Array(mask);
  const r = SHADOW.maskDilate;
  for (let y = 0; y < ah; y++) {
    for (let x = 0; x < aw; x++) {
      if (!mask[y * aw + x]) continue;
      for (let dy = -r; dy <= r; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= ah) continue;
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx;
          if (xx >= 0 && xx < aw) dil[yy * aw + xx] = 1;
        }
      }
    }
  }

  // exclusion boxes (canvas space → analysis space): text/other elements the pipeline masks
  for (const b of opts.excludeBoxes || []) {
    const x0 = clamp(Math.floor((b.x - cx0) / f) - 1, 0, aw), y0 = clamp(Math.floor((b.y - cy0) / f) - 1, 0, ah);
    const x1 = clamp(Math.ceil((b.x + b.w - cx0) / f) + 1, 0, aw), y1 = clamp(Math.ceil((b.y + b.h - cy0) / f) + 1, 0, ah);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) dil[y * aw + x] = 1;
  }

  // residual (obs − bg) per channel over halo pixels
  const evalIdx = [];
  for (let i = 0; i < aw * ah; i++) if (!dil[i]) evalIdx.push(i);
  if (evalIdx.length < 64) return { found: false, error: 'no halo pixels' };

  const resR = new Float32Array(aw * ah), resG = new Float32Array(aw * ah), resB = new Float32Array(aw * ah);
  for (const i of evalIdx) {
    resR[i] = obs.data[i * 4] - bg.data[i * 4];
    resG[i] = obs.data[i * 4 + 1] - bg.data[i * 4 + 1];
    resB[i] = obs.data[i * 4 + 2] - bg.data[i * 4 + 2];
  }

  let baseErr = 0;
  for (const i of evalIdx) baseErr += (Math.abs(resR[i]) + Math.abs(resG[i]) + Math.abs(resB[i])) / 3;
  baseErr /= evalIdx.length;
  if (baseErr < 1.2) return { found: false, residualGain: 0 }; // background already explains everything

  // subsampled eval set for the coarse grid
  const stride = Math.max(1, Math.floor(evalIdx.length / SHADOW.maxEvalPixels));
  const coarseIdx = stride === 1 ? evalIdx : evalIdx.filter((_, k) => k % stride === 0);

  // sigma seed from the halo falloff profile: mean |res| vs distance from element mask;
  // for a Gaussian-CDF edge falloff, a(d)/a(edge) ≈ 0.32 at d = sigma
  const sigmaSeed = seedSigmaFromProfile(resR, resG, resB, mask, dil, aw, ah);

  const sigmaSetA = [...new Set(
    SHADOW.sigmas.map((s) => Math.max(0.6, s / f)).concat(sigmaSeed ? [sigmaSeed] : []),
  )].sort((p, q) => p - q);

  const blurCache = new Map();
  const blurred = (sA) => {
    const key = Math.round(sA * 100);
    if (!blurCache.has(key)) blurCache.set(key, gaussianBlur(sil, aw, ah, sA));
    return blurCache.get(key);
  };

  // candidate scoring: per-channel closed-form amplitude k_c minimizing Σ(res − a·k)²
  const score = (dxA, dyA, sA, idxSet) => {
    const A = blurred(sA);
    let saa = 0, sar = 0, sag = 0, sab = 0;
    for (const i of idxSet) {
      const x = (i % aw) - dxA, y = ((i / aw) | 0) - dyA;
      if (x < 0 || x >= aw || y < 0 || y >= ah) continue;
      const a = A[y * aw + x];
      if (a < 0.004) continue;
      saa += a * a; sar += a * resR[i]; sag += a * resG[i]; sab += a * resB[i];
    }
    if (saa < 1e-6) return { err: baseErr, k: [0, 0, 0] };
    const k = [sar / saa, sag / saa, sab / saa];
    let err = 0;
    for (const i of idxSet) {
      const x = (i % aw) - dxA, y = ((i / aw) | 0) - dyA;
      const a = x >= 0 && x < aw && y >= 0 && y < ah ? A[y * aw + x] : 0;
      err += (Math.abs(resR[i] - a * k[0]) + Math.abs(resG[i] - a * k[1]) + Math.abs(resB[i] - a * k[2])) / 3;
    }
    return { err: err / idxSet.length, k };
  };

  // coarse grid (analysis-scale offsets)
  const offA = [];
  for (let o = -SHADOW.maxOffset; o <= SHADOW.maxOffset; o += SHADOW.offsetStep) offA.push(o / f);
  let best = { err: Infinity, dx: 0, dy: 0, sigma: sigmaSetA[0], k: [0, 0, 0] };
  for (const sA of sigmaSetA) {
    for (const dyA of offA) {
      for (const dxA of offA) {
        const { err, k } = score(Math.round(dxA), Math.round(dyA), sA, coarseIdx);
        if (err < best.err) best = { err, dx: Math.round(dxA), dy: Math.round(dyA), sigma: sA, k };
      }
    }
  }

  // coordinate-descent refinement on the full eval set
  for (let round = 0; round < SHADOW.refineRounds; round++) {
    let improved = false;
    for (const step of [Math.max(1, Math.round(4 / f)), 1]) {
      for (const [ddx, ddy] of [[step, 0], [-step, 0], [0, step], [0, -step]]) {
        const cand = score(best.dx + ddx, best.dy + ddy, best.sigma, evalIdx);
        if (cand.err < best.err) { best = { ...best, err: cand.err, dx: best.dx + ddx, dy: best.dy + ddy, k: cand.k }; improved = true; }
      }
    }
    for (const mult of [0.7, 0.85, 1.18, 1.4]) {
      const sA = clamp(best.sigma * mult, 0.5, 64 / f);
      const cand = score(best.dx, best.dy, sA, evalIdx);
      if (cand.err < best.err) { best = { ...best, err: cand.err, sigma: sA, k: cand.k }; improved = true; }
    }
    if (!improved) break;
  }
  const finalScore = score(best.dx, best.dy, best.sigma, evalIdx);
  best.err = finalScore.err; best.k = finalScore.k;

  const residualGain = 1 - best.err / baseErr;

  // SUPPORT gain: residual reduction restricted to where the fitted shadow is active
  // (a > 0.02). On real photos the global mean dilutes a perfectly-explained shadow under
  // background noise, so a strong local explanation also counts — with guards (support must
  // be a real fraction of the halo, amplitude above noise, global residual not worsened).
  const Abest = blurred(best.sigma);
  let supN = 0, supBase = 0, supModel = 0;
  for (const i of evalIdx) {
    const x = (i % aw) - best.dx, y = ((i / aw) | 0) - best.dy;
    const a = x >= 0 && x < aw && y >= 0 && y < ah ? Abest[y * aw + x] : 0;
    if (a <= 0.02) continue;
    supN++;
    supBase += (Math.abs(resR[i]) + Math.abs(resG[i]) + Math.abs(resB[i])) / 3;
    supModel += (Math.abs(resR[i] - a * best.k[0]) + Math.abs(resG[i] - a * best.k[1]) + Math.abs(resB[i] - a * best.k[2])) / 3;
  }
  const supportFrac = supN / evalIdx.length;
  const supportGain = supN > 32 && supBase > 1e-6 ? 1 - supModel / supBase : 0;

  // amplitude must be a real darkening/coloring, not noise
  const kMag = Math.max(Math.abs(best.k[0]), Math.abs(best.k[1]), Math.abs(best.k[2]));
  if (process.env.EFFECT_FIT_DEBUG) {
    console.error('[effect-fit]', JSON.stringify({ residualGain, supportGain, supportFrac, kMag, baseErr, bestErr: best.err, dx: best.dx * f, dy: best.dy * f, sigma: best.sigma * f, k: best.k.map((v) => Math.round(v * 10) / 10) }));
  }
  const foundGlobal = residualGain >= SHADOW.foundGain && kMag >= 4;
  const foundLocal = supportGain >= 0.3 && supportFrac >= 0.04 && residualGain >= 0.05 && kMag >= 6;
  if (!foundGlobal && !foundLocal) {
    return {
      found: false,
      residualGain: round3(Math.max(0, residualGain)),
      supportGain: round3(Math.max(0, supportGain)),
    };
  }

  // decompose k_c = opacity·(color_c − bg_c): pick the minimal opacity keeping color in-gamut
  // (⇒ the "purest" consistent shadow color; black shadow on any bg recovers exactly)
  let mR = 0, mG = 0, mB = 0;
  for (const i of evalIdx) { mR += bg.data[i * 4]; mG += bg.data[i * 4 + 1]; mB += bg.data[i * 4 + 2]; }
  const bgMean = [mR / evalIdx.length, mG / evalIdx.length, mB / evalIdx.length];
  let opacity = 0.01;
  for (let c = 0; c < 3; c++) {
    const need = best.k[c] < 0 ? -best.k[c] / Math.max(1, bgMean[c]) : best.k[c] / Math.max(1, 255 - bgMean[c]);
    opacity = Math.max(opacity, need);
  }
  opacity = clamp(opacity, 0.01, 1);
  const color = toHex([0, 1, 2].map((c) => bgMean[c] + best.k[c] / opacity));

  return {
    found: true,
    dx: Math.round(best.dx * f),
    dy: Math.round(best.dy * f),
    sigma: round1(best.sigma * f),
    opacity: round3(opacity),
    color,
    residualGain: round3(residualGain),
    supportGain: round3(supportGain),
  };
}

// mean |residual| vs city-block distance from the element mask (BFS rings); returns the
// analysis-scale distance where the profile drops to ~0.32× its at-edge value (≈ sigma for a
// Gaussian-CDF edge falloff), or null when the profile is too flat/noisy to trust
function seedSigmaFromProfile(resR, resG, resB, mask, dil, w, h) {
  const dist = new Int16Array(w * h).fill(-1);
  let frontier = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x]) { dist[y * w + x] = 0; frontier.push(y * w + x); }
    }
  }
  if (!frontier.length) return null;
  const maxD = Math.min(48, Math.max(w, h));
  const sums = new Float64Array(maxD + 1), counts = new Float64Array(maxD + 1);
  for (let d = 1; d <= maxD && frontier.length; d++) {
    const next = [];
    for (const i of frontier) {
      const x = i % w, y = (i / w) | 0;
      for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        const j = ny * w + nx;
        if (dist[j] !== -1) continue;
        dist[j] = d;
        next.push(j);
        if (!dil[j]) {
          sums[d] += (Math.abs(resR[j]) + Math.abs(resG[j]) + Math.abs(resB[j])) / 3;
          counts[d]++;
        }
      }
    }
    frontier = next;
  }
  let p0 = 0, d0 = 0;
  for (let d = 1; d <= maxD; d++) {
    if (counts[d] >= 8) { p0 = sums[d] / counts[d]; d0 = d; break; }
  }
  if (p0 < 2) return null;
  for (let d = d0 + 1; d <= maxD; d++) {
    if (counts[d] < 8) continue;
    if (sums[d] / counts[d] <= 0.32 * p0) return clamp(d, 1, 48);
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// fitVignette
// ---------------------------------------------------------------------------------------------

export function fitVignette(pixels, excludeBoxes = []) {
  try {
    return fitVignetteInner(pixels, excludeBoxes);
  } catch (err) {
    return { found: false, error: String(err?.message || err) };
  }
}

function fitVignetteInner(pixels, excludeBoxes) {
  if (!pixels?.data || !(pixels.width > 8) || !(pixels.height > 8)) return { found: false, error: 'bad input' };
  const W = pixels.width, H = pixels.height;
  const f = Math.max(1, Math.ceil(Math.max(W, H) / VIGNETTE.analysisMax));
  const { data, width: w, height: h } = downscaleRgba(pixels.data, W, H, f);

  // LOG-luminance + exclusion mask. Vignettes are MULTIPLICATIVE (L·(1−s·ramp)) — in log
  // space they become additive, so the plane term can absorb content trends without the
  // trend×vignette interaction corrupting the radial fit (standard vignetting-correction move)
  const luma = new Float32Array(w * h);
  const excluded = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const L = 0.2126 * data[i * 4] + 0.7152 * data[i * 4 + 1] + 0.0722 * data[i * 4 + 2];
    luma[i] = Math.log(Math.max(2, L));
  }
  for (const b of excludeBoxes || []) {
    const x0 = clamp(Math.floor(b.x / f) - 1, 0, w), y0 = clamp(Math.floor(b.y / f) - 1, 0, h);
    const x1 = clamp(Math.ceil((b.x + b.w) / f) + 1, 0, w), y1 = clamp(Math.ceil((b.y + b.h) / f) + 1, 0, h);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) excluded[y * w + x] = 1;
  }

  // 2-D weighted LS fit L = c0 + c1·r² + c2·r⁴ + c3·xn + c4·yn on subsampled pixels
  // (xn, yn, r all normalized by the max corner distance). The PLANE TERMS absorb directional
  // lighting / content trends so they can't masquerade as (or drag the center of) a vignette —
  // the vignette verdict is judged on the radial terms alone. Returns bins of plane-corrected
  // luminance medians for the residual check + the renderer mapping.
  const fit2D = (cxFrac, cyFrac) => {
    const cx = cxFrac * (w - 1), cy = cyFrac * (h - 1);
    let rMax = 0;
    for (const [px, py] of [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]]) {
      rMax = Math.max(rMax, Math.hypot(px - cx, py - cy));
    }
    const stride = Math.max(1, Math.floor(Math.sqrt((w * h) / 40000)));
    const M = Array.from({ length: 5 }, () => new Float64Array(5));
    const v = new Float64Array(5);
    let nPts = 0;
    for (let y = 0; y < h; y += stride) {
      for (let x = 0; x < w; x += stride) {
        const i = y * w + x;
        if (excluded[i]) continue;
        const xn = (x - cx) / rMax, yn = (y - cy) / rMax;
        const r2 = xn * xn + yn * yn;
        const phi = [1, r2, r2 * r2, xn, yn];
        for (let a = 0; a < 5; a++) {
          v[a] += phi[a] * luma[i];
          for (let b = 0; b < 5; b++) M[a][b] += phi[a] * phi[b];
        }
        nPts++;
      }
    }
    if (nPts < 200) return null;
    const cPix = solveN(M, v, 5);
    if (!cPix) return null;
    // keep ONLY the plane (c3,c4) from the pixel fit — the radial coefficients get refit on
    // bin medians below (median binning is what makes the radial fit robust to texture)
    const c = [0, 0, 0, cPix[3], cPix[4]];
    // radial bins of plane-corrected luminance medians
    const nb = VIGNETTE.bins;
    const buckets = Array.from({ length: nb }, () => []);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (excluded[i]) continue;
        const xn = (x - cx) / rMax, yn = (y - cy) / rMax;
        const r = Math.sqrt(xn * xn + yn * yn);
        const bi = Math.min(nb - 1, Math.floor(r * nb));
        buckets[bi].push(luma[i] - c[3] * xn - c[4] * yn);
      }
    }
    const bins = [];
    for (let bi = 0; bi < nb; bi++) {
      const arr = buckets[bi];
      if (arr.length < 6) continue;
      arr.sort((p, q) => p - q);
      bins.push({ r: (bi + 0.5) / nb, L: arr[arr.length >> 1], n: arr.length });
    }
    if (bins.length < 6) return null;
    // weighted 3-param LS on the corrected bin medians: L = c0 + c1·r² + c2·r⁴
    const M3 = Array.from({ length: 3 }, () => new Float64Array(3));
    const v3 = new Float64Array(3);
    for (const { r, L, n } of bins) {
      const wgt = Math.sqrt(n);
      const phi = [1, r * r, r ** 4];
      for (let a = 0; a < 3; a++) {
        v3[a] += wgt * phi[a] * L;
        for (let b = 0; b < 3; b++) M3[a][b] += wgt * phi[a] * phi[b];
      }
    }
    const cr = solveN(M3, v3, 3);
    if (!cr || !(cr[0] > Math.log(10))) return null; // center level must exceed ~10/255

    // reference level = inner bins (r ≤ 0.35); per-bin measured attenuation g = exp(L − c0In)
    let c0In = 0, c0W = 0;
    for (const { r, L, n } of bins) if (r <= 0.35) { c0In += Math.sqrt(n) * L; c0W += Math.sqrt(n); }
    if (c0W < 1) return null;
    c0In /= c0W;
    const gBins = bins.map(({ r, L, n }) => ({ r, g: Math.exp(L - c0In), n }));

    // fit the RENDERER RAMP model g = 1 − strength·clamp((r−size)/(1−size),0,1) directly:
    // grid over size, closed-form strength, weighted LS — its residual (linear luminance
    // fraction) drives center selection and the found gate, because THIS is the model we
    // can actually render; the polynomial above only supplies the a,b-negative sanity gate
    let ramp = { sse: Infinity, size: 0.45, strength: 0, residual: 1 };
    for (let size = 0; size <= 0.9001; size += 0.05) {
      let num = 0, den = 0, sw2 = 0;
      for (const { r, g, n } of gBins) {
        const rr = clamp((r - size) / (1 - size), 0, 1);
        const wgt = Math.sqrt(n);
        num += wgt * rr * (1 - g); den += wgt * rr * rr; sw2 += wgt;
      }
      const strength = clamp(den > 1e-9 ? num / den : 0, 0, 1);
      let se2 = 0;
      for (const { r, g, n } of gBins) {
        const rr = clamp((r - size) / (1 - size), 0, 1);
        se2 += Math.sqrt(n) * (1 - strength * rr - g) ** 2;
      }
      if (se2 < ramp.sse) ramp = { sse: se2, size, strength, residual: Math.sqrt(se2 / sw2) };
    }

    return {
      c0: c0In, c1: cr[1], c2: cr[2], c3: c[3], c4: c[4],
      relResidual: ramp.residual, size: ramp.size, strength: ramp.strength,
      gBins, cx, cy, rMax,
    };
  };

  // center search: keep the geometric center unless an off-center fit is CLEARLY better —
  // the renderer only draws CENTERED vignettes, so bias is a rejection signal, not freedom
  const centered = fit2D(0.5, 0.5);
  if (!centered) return { found: false, error: 'not enough unmasked pixels' };
  let bestFit = centered, bestCx = 0.5, bestCy = 0.5;
  if (centered.relResidual > 0.035) {
    for (const ox of VIGNETTE.centerGrid) {
      for (const oy of VIGNETTE.centerGrid) {
        if (ox === 0 && oy === 0) continue;
        const fit = fit2D(0.5 + ox, 0.5 + oy);
        if (fit && fit.relResidual < 0.7 * centered.relResidual && fit.relResidual < bestFit.relResidual) {
          bestFit = fit; bestCx = 0.5 + ox; bestCy = 0.5 + oy;
        }
      }
    }
  }

  const { c1, c2, relResidual, gBins } = bestFit;
  const centerBias = { xPct: round1((bestCx - 0.5) * 100), yPct: round1((bestCy - 0.5) * 100) };

  // measured (model-free) edge attenuation: mean g of the outermost bins
  let eSum = 0, eW = 0;
  for (const { r, g, n } of gBins) if (r > 0.85) { eSum += Math.sqrt(n) * g; eW += Math.sqrt(n); }
  const edgeDrop = eW > 0 ? 1 - eSum / eW : 0;

  // monotone-ish decreasing measured attenuation in the outer half (reject noise/backlight)
  let violations = 0;
  const outer = gBins.filter((b) => b.r >= 0.45);
  for (let i = 1; i < outer.length; i++) if (outer[i].g > outer[i - 1].g + 0.025) violations++;
  const monotone = violations <= 1;

  // quadrant consistency on plane-corrected luminance: a real vignette darkens EVERY corner;
  // whatever directional trend the plane didn't absorb must not be the whole story
  const quadOk = quadrantConsistency(luma, excluded, w, h, bestFit, edgeDrop);

  const found =
    edgeDrop >= VIGNETTE.minEdgeDrop &&
    c1 + c2 < -0.05 &&                       // polynomial a,b meaningfully negative (log units)
    relResidual <= VIGNETTE.maxRelResidual &&
    monotone && quadOk &&
    Math.max(Math.abs(centerBias.xPct), Math.abs(centerBias.yPct)) <= VIGNETTE.maxCenterBias;

  if (!found) {
    return {
      found: false,
      strength: 0, radiusPct: 0, centerBias,
      edgeDrop: round3(edgeDrop), relResidual: round3(relResidual),
    };
  }

  return {
    found: true,
    strength: round3(bestFit.strength),          // → style.vignette.strength
    radiusPct: Math.round(bestFit.size * 100),   // → style.vignette.size = radiusPct/100
    centerBias,
    edgeDrop: round3(edgeDrop),
    relResidual: round3(relResidual),
  };
}

// every populated quadrant's outer-ring (r>0.7) attenuation (on plane-corrected luminance)
// must be ≥ 30% of the overall edge drop — one-sided darkening fails this, vignettes pass
function quadrantConsistency(luma, excluded, w, h, fit, edgeDrop) {
  const { c0, c3, c4, cx, cy, rMax } = fit;
  const quads = [[], [], [], []];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (excluded[i]) continue;
      const xn = (x - cx) / rMax, yn = (y - cy) / rMax;
      if (Math.sqrt(xn * xn + yn * yn) <= 0.7) continue;
      quads[(x >= cx ? 1 : 0) + (y >= cy ? 2 : 0)].push(luma[i] - c3 * xn - c4 * yn);
    }
  }
  const minDrop = Math.max(0.02, 0.3 * edgeDrop);
  let populated = 0;
  for (const q of quads) {
    if (q.length < 20) continue; // quadrant mostly excluded — don't judge it
    populated++;
    q.sort((p, r) => p - r);
    const drop = 1 - Math.exp(q[q.length >> 1] - c0); // log-luminance → relative attenuation
    if (drop < minDrop) return false;
  }
  return populated >= 2;
}

// n×n linear solve via Gaussian elimination with partial pivoting; returns null when singular
function solveN(M, v, n) {
  const A = Array.from({ length: n }, (_, i) => {
    const row = new Float64Array(n + 1);
    for (let j = 0; j < n; j++) row[j] = M[i][j];
    row[n] = v[i];
    return row;
  });
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    if (Math.abs(A[piv][col]) < 1e-9) return null;
    [A[col], A[piv]] = [A[piv], A[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const k = A[r][col] / A[col][col];
      for (let j = col; j <= n; j++) A[r][j] -= k * A[col][j];
    }
  }
  return Array.from({ length: n }, (_, i) => A[i][n] / A[i][i]);
}
