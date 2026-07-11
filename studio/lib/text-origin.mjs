// lib/text-origin.mjs — S3 of the copy engine (COPY-ENGINE-V2 §3.2): classify every
// OCR line as OVERLAY (designer-added text → becomes an editable layer) vs SCENE
// (text physically inside the photo: package print, product labels, screenshots).
// Deterministic pixel + geometry features combined through a hand-tuned logistic —
// no LLM, no network, sharp only. Kills the 004/016 class of failures (nutrition
// labels / bag print extracted as text layers).
//
// Contract (COPY-ENGINE-V2-CONTRACTS.md, S3):
//   classifyTextOrigins(imagePath, s1Facts, opts?) -> Promise<{ lines: [
//     { id, origin: 'overlay'|'scene'|'ambiguous', score /* P(overlay) 0..1 */,
//       features: { edgeRamp, inkTightness, rectangularity, gridAlign, ringStroke,
//                   semantic, ... } } ] }>
// Invariants:
//   - input is the S1 shape (lines[].{id,text,box,quad}); never imports lib/ocr.mjs
//   - score is P(overlay); origin = overlay >0.65, scene <0.35, else ambiguous
//   - deterministic: same image + same s1 ⇒ same output
//   - opts.photoRegions ([{x,y,w,h}] | null) is an optional hint: a line mostly
//     inside a confident photo region with weak overlay evidence leans scene
// Callers: copy pipeline S3 stage (writes s3.origin.json), test/text-origin.test.mjs.

import sharp from 'sharp';

// ---------------------------------------------------------------------------
// tunables — logistic weights hand-tuned on the 5-case fixture corpus
// (002/004/016/018/020). See test/text-origin.test.mjs; overfit risk is real,
// these are priors to be re-fit when the corpus grows.
// ---------------------------------------------------------------------------
export const WEIGHTS = {
  bias: 0.35,
  ramp: 0.9,        // × (1.6 − glyph ramp px): crisp anti-alias edge ⇒ overlay
  rampRel: 0.55,    // × log2(glyph sharpness / annulus sharpness), clamped ±2
  ink: 0.55,        // × (0.10 − inkTightness)×10: tight ink cluster ⇒ overlay
  rect: 0.9,        // × (rectangularity − 0.75)×4: perspective/rotation ⇒ scene
  grid: 0.45,       // × gridAlign (0/1): shares layout guides ⇒ overlay
  ring: 1.1,        // × ringStroke (0/1): uniform contrast ring ⇒ strong overlay
  sem: 1.5,         // × (semantic − 0.5)×2: CTA/price ⇒ overlay, nutrition ⇒ scene
  shade: 1.0,       // × bg shading 0..1: lighting drift under the line ⇒ scene
  photoPenalty: 3.4 // × overlap × (0.25 + 0.75·shading), when inside a photo region
};

const AMBIG_LO = 0.35;
const AMBIG_HI = 0.65;

// semantic priors ------------------------------------------------------------
const OVERLAY_RE = [
  /\bshop now\b/i, /\bbuy now\b/i, /\border (now|today)\b/i, /\blink in bio\b/i,
  /\bbestel\b/i, /\bkoop nu\b/i, /\bshop\b.{0,12}\.(nl|com|de|co)\b/i,
  /\bfree shipping\b/i, /\bgratis verzending\b/i, /\bsale\b/i, /\bkorting\b/i,
  /\d+\s?%\s?(off|korting)/i, /\bup to\b.*%/i, /%\s?off\b/i,
  /[€$£]\s?\d/, /\d+[.,]-/, /\btijdelijk\b/i, /\bnu voor\b/i,
  /\bget (up to|yours)\b/i, /\blimited\b/i, /\bnew\b[!:]?$/i
];
const SCENE_RE = [
  /ingredi[eë]nt/i, /\bnutrition\b/i, /voedingswaarde/i, /mineraalsamenstelling/i,
  /supplement facts/i, /\bserving\b/i, /daily value/i, /\bper\s?\d+\s?(g|ml)\b/i,
  /\bnet\s?wt\b/i,
  /\bsmaak\b/i, /\bflavou?r\b/i, /\bmonohydra?at\b/i, /\bscoops?\b/i,
  /barcode|®|™/, /\b(RI|ADH)%/i
];
// dense fine print (lots of digits + unit tokens) is package-label shaped
const UNIT_TOKEN_RE = /\d+[.,]?\d*\s?(g|mg|ml|kj|kcal|%|st)\b/gi;

export function semanticPrior(text) {
  const t = String(text || '');
  if (!t.trim()) return 0.5;
  for (const re of SCENE_RE) if (re.test(t)) return 0.15;
  for (const re of OVERLAY_RE) if (re.test(t)) return 0.85;
  const units = t.match(UNIT_TOKEN_RE);
  if (units && units.length >= 2) return 0.2; // units-table density ⇒ scene
  return 0.5;
}

// ---------------------------------------------------------------------------
// small numeric helpers (no deps)
// ---------------------------------------------------------------------------
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const sigmoid = (z) => 1 / (1 + Math.exp(-z));

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function percentile(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[clamp(Math.round((s.length - 1) * p), 0, s.length - 1)];
}

// Otsu threshold over a 256-bin histogram of a 0..255 scalar field
function otsu(values) {
  const hist = new Float64Array(256);
  for (const v of values) hist[clamp(Math.round(v), 0, 255)]++;
  const total = values.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, bestT = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; bestT = t; }
  }
  return bestT;
}

// tiny k-means on RGB triples; returns { centers, assign, withinStd }
function kmeansRGB(pixels /* [[r,g,b],...] */, k = 2, iters = 12) {
  if (!pixels.length) return { centers: [], sizes: [], withinStd: 0 };
  // init: darkest + brightest (+ middle) by luminance — deterministic
  const byLum = [...pixels].sort(
    (a, b) => (a[0] * 3 + a[1] * 6 + a[2]) - (b[0] * 3 + b[1] * 6 + b[2]));
  const centers = [];
  for (let i = 0; i < k; i++) {
    centers.push([...byLum[Math.min(byLum.length - 1,
      Math.round((byLum.length - 1) * (k === 1 ? 0.5 : i / (k - 1))))]]);
  }
  const assign = new Uint8Array(pixels.length);
  for (let it = 0; it < iters; it++) {
    let moved = false;
    for (let i = 0; i < pixels.length; i++) {
      let bi = 0, bd = Infinity;
      for (let c = 0; c < k; c++) {
        const dr = pixels[i][0] - centers[c][0];
        const dg = pixels[i][1] - centers[c][1];
        const db = pixels[i][2] - centers[c][2];
        const d = dr * dr + dg * dg + db * db;
        if (d < bd) { bd = d; bi = c; }
      }
      if (assign[i] !== bi) { assign[i] = bi; moved = true; }
    }
    const acc = Array.from({ length: k }, () => [0, 0, 0, 0]);
    for (let i = 0; i < pixels.length; i++) {
      const a = acc[assign[i]];
      a[0] += pixels[i][0]; a[1] += pixels[i][1]; a[2] += pixels[i][2]; a[3]++;
    }
    for (let c = 0; c < k; c++) {
      if (acc[c][3]) {
        centers[c] = [acc[c][0] / acc[c][3], acc[c][1] / acc[c][3], acc[c][2] / acc[c][3]];
      }
    }
    if (!moved) break;
  }
  // per-cluster std (mean over channels), weighted by cluster size
  const sizes = new Array(k).fill(0);
  const varAcc = Array.from({ length: k }, () => [0, 0, 0]);
  for (let i = 0; i < pixels.length; i++) {
    const c = assign[i]; sizes[c]++;
    for (let ch = 0; ch < 3; ch++) {
      const d = pixels[i][ch] - centers[c][ch];
      varAcc[c][ch] += d * d;
    }
  }
  let withinStd = 0, wTot = 0;
  for (let c = 0; c < k; c++) {
    if (!sizes[c]) continue;
    const v = (varAcc[c][0] + varAcc[c][1] + varAcc[c][2]) / (3 * sizes[c]);
    withinStd += Math.sqrt(v) * sizes[c];
    wTot += sizes[c];
  }
  return { centers, sizes, withinStd: wTot ? withinStd / wTot : 0 };
}

// ---------------------------------------------------------------------------
// pixel access over one decoded RGBA buffer
// ---------------------------------------------------------------------------
function lumAt(img, x, y) {
  const i = (y * img.width + x) * 4;
  return 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2];
}
function rgbAt(img, x, y) {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
}

function clampBox(box, W, H) {
  const x = clamp(Math.round(box.x), 0, W - 1);
  const y = clamp(Math.round(box.y), 0, H - 1);
  const w = clamp(Math.round(box.w), 1, W - x);
  const h = clamp(Math.round(box.h), 1, H - y);
  return { x, y, w, h };
}

// Build the glyph mask for a padded line crop.
// Background = median RGB of the crop's border ring; scalar field = color distance
// to that background; Otsu splits ink from ground even for colored text.
function glyphMask(img, box) {
  const W = img.width, H = img.height;
  const pad = clamp(Math.round(box.h * 0.3), 4, 28);
  const c = clampBox({ x: box.x - pad, y: box.y - pad, w: box.w + 2 * pad, h: box.h + 2 * pad }, W, H);
  const cw = c.w, ch = c.h;

  // border ring sample → background color estimate (median per channel)
  const br = [], bg_ = [], bb = [];
  const ring = Math.max(1, Math.min(3, Math.floor(Math.min(cw, ch) / 8)));
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      if (x >= ring && x < cw - ring && y >= ring && y < ch - ring) continue;
      const [r, g, b] = rgbAt(img, c.x + x, c.y + y);
      br.push(r); bg_.push(g); bb.push(b);
    }
  }
  const bgColor = [median(br), median(bg_), median(bb)];

  // distance field + Otsu
  const dist = new Float32Array(cw * ch);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const [r, g, b] = rgbAt(img, c.x + x, c.y + y);
      const dr = r - bgColor[0], dg = g - bgColor[1], db = b - bgColor[2];
      dist[y * cw + x] = Math.sqrt((dr * dr + dg * dg + db * db) / 3);
    }
  }
  const t = otsu(dist);
  let mask = new Uint8Array(cw * ch);
  let on = 0;
  for (let i = 0; i < dist.length; i++) { if (dist[i] > t) { mask[i] = 1; on++; } }
  // glyphs should be the minority phase of the padded crop
  if (on > mask.length * 0.55) {
    for (let i = 0; i < mask.length; i++) mask[i] ^= 1;
    on = mask.length - on;
  }
  const frac = on / mask.length;
  return { crop: c, cw, ch, mask, bgColor, maskFrac: frac, threshold: t };
}

function dilate(mask, w, h, r) {
  let cur = mask;
  for (let it = 0; it < r; it++) {
    const next = new Uint8Array(cur.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (cur[i] ||
            (x > 0 && cur[i - 1]) || (x < w - 1 && cur[i + 1]) ||
            (y > 0 && cur[i - w]) || (y < h - 1 && cur[i + w])) next[i] = 1;
      }
    }
    cur = next;
  }
  return cur;
}

// ---------------------------------------------------------------------------
// features
// ---------------------------------------------------------------------------

// Feature 1 — edge ramp. Measures the median 10–90% anti-alias rise width (px)
// across glyph boundaries, plus the ratio of glyph edge sharpness to the sharpest
// structure in a surrounding annulus (overlay text stays crisp even when the photo
// underneath is soft; printed text inherits the photo's blur).
function edgeRampFeature(img, gm, box) {
  const { crop, cw, ch, mask } = gm;
  // ink/bg luminance levels from the mask phases
  let inkL = 0, inkN = 0, bgL = 0, bgN = 0;
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const l = lumAt(img, crop.x + x, crop.y + y);
      if (mask[y * cw + x]) { inkL += l; inkN++; } else { bgL += l; bgN++; }
    }
  }
  if (!inkN || !bgN) return { rampPx: 3, rel: 1 };
  inkL /= inkN; bgL /= bgN;
  const contrast = Math.abs(inkL - bgL);
  if (contrast < 12) return { rampPx: 3, rel: 1 };
  const lo = Math.min(inkL, bgL) + 0.1 * contrast;
  const hi = Math.min(inkL, bgL) + 0.9 * contrast;

  const ramps = [];
  const rowStep = Math.max(1, Math.floor(ch / 48));
  for (let y = 1; y < ch - 1; y += rowStep) {
    for (let x = 1; x < cw - 1; x++) {
      const i = y * cw + x;
      if (mask[i] === mask[i - 1]) continue; // not a boundary
      // walk the luminance profile around the transition, count px in (lo,hi)
      let count = 0;
      for (let dx = -4; dx <= 4; dx++) {
        const xx = x + dx;
        if (xx < 0 || xx >= cw) continue;
        const l = lumAt(img, crop.x + xx, crop.y + y);
        if (l > lo && l < hi) count++;
      }
      ramps.push(Math.max(count, 0.5));
      x += 2; // skip the rest of this transition
    }
    if (ramps.length > 400) break;
  }
  const rampPx = ramps.length >= 6 ? median(ramps) : 3;

  // glyph edge sharpness = contrast-normalized max gradient at boundaries
  const grads = [];
  for (let y = 1; y < ch - 1; y += rowStep) {
    for (let x = 1; x < cw - 1; x++) {
      const i = y * cw + x;
      if (mask[i] === mask[i - 1]) continue;
      let g = 0;
      for (let dx = -1; dx <= 1; dx++) {
        const xx = clamp(x + dx, 1, cw - 2);
        g = Math.max(g, Math.abs(lumAt(img, crop.x + xx + 1, crop.y + y) -
                                 lumAt(img, crop.x + xx - 1, crop.y + y)) / 2);
      }
      grads.push(g / contrast);
      x += 2;
    }
    if (grads.length > 400) break;
  }
  const glyphSharp = grads.length >= 6 ? percentile(grads, 0.5) : 0.3;

  // annulus: expand the box, exclude the crop, measure the sharpest structure
  const W = img.width, H = img.height;
  const grow = Math.max(12, Math.round(box.h * 0.9));
  const a = clampBox({ x: box.x - grow, y: box.y - grow, w: box.w + 2 * grow, h: box.h + 2 * grow }, W, H);
  const ag = [];
  const step = Math.max(1, Math.floor(Math.sqrt((a.w * a.h) / 20000)));
  let aMin = 255, aMax = 0;
  for (let y = a.y + 1; y < a.y + a.h - 1; y += step) {
    for (let x = a.x + 1; x < a.x + a.w - 1; x += step) {
      if (x >= crop.x && x < crop.x + crop.w && y >= crop.y && y < crop.y + crop.h) continue;
      const l = lumAt(img, x, y);
      aMin = Math.min(aMin, l); aMax = Math.max(aMax, l);
      const gx = (lumAt(img, x + 1, y) - lumAt(img, x - 1, y)) / 2;
      const gy = (lumAt(img, x, y + 1) - lumAt(img, x, y - 1)) / 2;
      ag.push(Math.abs(gx) + Math.abs(gy));
    }
  }
  const aContrast = Math.max(aMax - aMin, 1);
  const annulusSharp = ag.length > 50 && aContrast > 25
    ? percentile(ag, 0.95) / aContrast
    : null; // flat/untextured annulus ⇒ no relative signal
  const rel = annulusSharp && annulusSharp > 0.02
    ? glyphSharp / annulusSharp
    : 1; // neutral
  return { rampPx, rel };
}

// Feature 2 — ink tightness: k-means cluster spread of glyph pixel colors plus
// ink-color drift across the line's horizontal thirds. Overlay ink is one flat
// color; print on packaging picks up lighting variation along the baseline.
function inkTightnessFeature(img, gm) {
  const { crop, cw, ch, mask } = gm;
  const px = []; const xs = [];
  const step = Math.max(1, Math.floor(Math.sqrt((cw * ch) / 6000)));
  for (let y = 0; y < ch; y += step) {
    for (let x = 0; x < cw; x += step) {
      if (!mask[y * cw + x]) continue;
      px.push(rgbAt(img, crop.x + x, crop.y + y));
      xs.push(x);
    }
  }
  if (px.length < 30) return { tightness: 0.12, drift: 0 };
  const k2 = kmeansRGB(px, 2);
  // if one cluster dominates (≥78%), treat its std as the ink spread; else the
  // text itself is multi-colored/lit — use the weighted within-std
  let spread = k2.withinStd;
  const domIdx = k2.sizes[0] >= k2.sizes[1] ? 0 : 1;
  if (k2.sizes[domIdx] / px.length >= 0.78) {
    // recompute std of dominant cluster only
    let acc = [0, 0, 0], n = 0;
    for (let i = 0; i < px.length; i++) {
      // cheap re-assign to dominant center
      const c0 = k2.centers[domIdx], c1 = k2.centers[1 - domIdx];
      const d0 = (px[i][0] - c0[0]) ** 2 + (px[i][1] - c0[1]) ** 2 + (px[i][2] - c0[2]) ** 2;
      const d1 = (px[i][0] - c1[0]) ** 2 + (px[i][1] - c1[1]) ** 2 + (px[i][2] - c1[2]) ** 2;
      if (d0 <= d1) { acc[0] += d0; n++; }
    }
    if (n) spread = Math.sqrt(acc[0] / n / 3);
  }
  // drift across thirds (dominant-ink mean per third)
  const thirds = [[], [], []];
  for (let i = 0; i < px.length; i++) {
    thirds[clamp(Math.floor((xs[i] / cw) * 3), 0, 2)].push(px[i]);
  }
  const means = thirds
    .filter((t) => t.length >= 10)
    .map((t) => {
      const m = [0, 0, 0];
      for (const p of t) { m[0] += p[0]; m[1] += p[1]; m[2] += p[2]; }
      return m.map((v) => v / t.length);
    });
  let drift = 0;
  for (let i = 0; i < means.length; i++) {
    for (let j = i + 1; j < means.length; j++) {
      const d = Math.sqrt(
        ((means[i][0] - means[j][0]) ** 2 +
         (means[i][1] - means[j][1]) ** 2 +
         (means[i][2] - means[j][2]) ** 2) / 3);
      drift = Math.max(drift, d);
    }
  }
  return { tightness: (spread + 0.5 * drift) / 255, drift: drift / 255 };
}

// Feature 3 — quad rectangularity/rotation: 1.0 for an axis-aligned rectangle,
// decays with edge non-parallelism, shear, and rotation (perspective ⇒ on-object).
export function rectangularityFeature(quad, box) {
  if (!Array.isArray(quad) || quad.length !== 4) return 1; // no quad = assume rect
  const [tl, tr, br, bl] = quad;
  const ang = (v) => Math.atan2(v[1], v[0]);
  const deg = (r) => (r * 180) / Math.PI;
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
  const top = sub(tr, tl), bot = sub(br, bl), left = sub(bl, tl), right = sub(br, tr);
  const angDiff = (a, b) => {
    let d = Math.abs(deg(ang(a)) - deg(ang(b))) % 180;
    return Math.min(d, 180 - d);
  };
  const parTB = angDiff(top, bot);
  const parLR = angDiff(left, right);
  let rot = Math.abs(deg(ang(top))) % 90;
  rot = Math.min(rot, 90 - rot);
  let ortho = angDiff(top, left);
  ortho = Math.abs(90 - ortho);
  const penalty = parTB / 4 + parLR / 4 + ortho / 8 + rot / 7;
  return clamp(Math.exp(-penalty * 0.45), 0, 1);
}

// Feature 4 — grid alignment: the line shares a left/center/right guide (±1.5% of
// canvas W) with at least one non-adjacent line, or is centered on the canvas.
export function gridAlignFeature(line, allLines, canvasW) {
  const tol = canvasW * 0.015;
  const b = line.box;
  const cx = b.x + b.w / 2;
  if (Math.abs(cx - canvasW / 2) <= tol) return 1; // canonical: canvas-centered
  for (const o of allLines) {
    if (o.id === line.id) continue;
    const ob = o.box;
    // ignore immediate vertical neighbors (same local text block, e.g. a label);
    // designer grids repeat across the layout, not just within one paragraph
    const vGap = Math.max(ob.y - (b.y + b.h), b.y - (ob.y + ob.h));
    if (vGap < b.h) continue;
    const ocx = ob.x + ob.w / 2;
    if (Math.abs(b.x - ob.x) <= tol) return 1;
    if (Math.abs(cx - ocx) <= tol) return 1;
    if (Math.abs((b.x + b.w) - (ob.x + ob.w)) <= tol) return 1;
  }
  return 0;
}

// Feature 5 — contrast ring / stroke: dilate the glyph mask and test whether the
// 1–3 px shell holds one tight color distinct from both ink and the wider ground
// (a designer stroke/halo). Uniform-width ring ⇒ strong overlay.
function ringStrokeFeature(img, gm) {
  const { crop, cw, ch, mask, bgColor } = gm;
  const d2 = dilate(mask, cw, ch, 2);
  const d4 = dilate(d2, cw, ch, 2);
  const shellPx = [];
  const outerPx = [];
  const step = Math.max(1, Math.floor(Math.sqrt((cw * ch) / 8000)));
  for (let y = 0; y < ch; y += step) {
    for (let x = 0; x < cw; x += step) {
      const i = y * cw + x;
      if (d2[i] && !mask[i]) shellPx.push(rgbAt(img, crop.x + x, crop.y + y));
      else if (d4[i] && !d2[i]) outerPx.push(rgbAt(img, crop.x + x, crop.y + y));
    }
  }
  if (shellPx.length < 40 || outerPx.length < 40) return 0;
  const mean = (a) => {
    const m = [0, 0, 0];
    for (const p of a) { m[0] += p[0]; m[1] += p[1]; m[2] += p[2]; }
    return m.map((v) => v / a.length);
  };
  const dist = (a, b) => Math.sqrt(((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2) / 3);
  const sMean = mean(shellPx), oMean = mean(outerPx);
  let sVar = 0;
  for (const p of shellPx) sVar += dist(p, sMean) ** 2;
  const sStd = Math.sqrt(sVar / shellPx.length);
  // tight shell that differs from the wider ground AND from plain background
  if (sStd < 22 && dist(sMean, oMean) > 38 && dist(sMean, bgColor) > 38) return 1;
  return 0;
}

// Feature 7 — background shading: least-squares luminance plane over the crop's
// ground pixels (glyphs + a dilated shell excluded). Print sits on a physical
// surface, so its local ground carries smooth lighting drift (curved packages,
// bags) or photo texture; designer text sits on flat fills / gradients so small
// that the drift is negligible. Returns { slope: total luminance drift across the
// crop, resid: rms plane residual, shading: 0..1 combined evidence }.
function bgShadingFeature(img, gm) {
  const { crop, cw, ch, mask } = gm;
  const shell = dilate(mask, cw, ch, 2);
  const xs = [], ys = [], ls = [];
  const step = Math.max(1, Math.floor(Math.sqrt((cw * ch) / 6000)));
  for (let y = 0; y < ch; y += step) {
    for (let x = 0; x < cw; x += step) {
      if (shell[y * cw + x]) continue;
      xs.push(x); ys.push(y); ls.push(lumAt(img, crop.x + x, crop.y + y));
    }
  }
  const n = ls.length;
  if (n < 60) return { slope: 0, resid: 0, shading: 0 };
  // least squares lum = a·x + b·y + c
  let sx = 0, sy = 0, sl = 0, sxx = 0, syy = 0, sxy = 0, sxl = 0, syl = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i]; sy += ys[i]; sl += ls[i];
    sxx += xs[i] * xs[i]; syy += ys[i] * ys[i]; sxy += xs[i] * ys[i];
    sxl += xs[i] * ls[i]; syl += ys[i] * ls[i];
  }
  const mx = sx / n, my = sy / n, ml = sl / n;
  const cxx = sxx / n - mx * mx, cyy = syy / n - my * my, cxy = sxy / n - mx * my;
  const cxl = sxl / n - mx * ml, cyl = syl / n - my * ml;
  const det = cxx * cyy - cxy * cxy;
  let a = 0, b = 0;
  if (Math.abs(det) > 1e-6) {
    a = (cxl * cyy - cyl * cxy) / det;
    b = (cyl * cxx - cxl * cxy) / det;
  }
  let rss = 0;
  for (let i = 0; i < n; i++) {
    const e = ls[i] - (a * (xs[i] - mx) + b * (ys[i] - my) + ml);
    rss += e * e;
  }
  const resid = Math.sqrt(rss / n);
  const slope = Math.hypot(a, b) * Math.hypot(cw, ch);
  const shading = clamp((slope - 8) / 22, 0, 1) * 0.6 + clamp((resid - 5) / 14, 0, 1) * 0.4;
  return { slope, resid, shading };
}

// photoRegions hint: fraction of the line's box inside any photo region
function photoOverlap(box, regions) {
  if (!Array.isArray(regions) || !regions.length) return 0;
  const area = box.w * box.h;
  if (area <= 0) return 0;
  let best = 0;
  for (const r of regions) {
    const ix = Math.max(0, Math.min(box.x + box.w, r.x + r.w) - Math.max(box.x, r.x));
    const iy = Math.max(0, Math.min(box.y + box.h, r.y + r.h) - Math.max(box.y, r.y));
    best = Math.max(best, (ix * iy) / area);
  }
  return best;
}

// ---------------------------------------------------------------------------
// main entry
// ---------------------------------------------------------------------------
export async function classifyTextOrigins(imagePath, s1Facts, opts = {}) {
  const { photoRegions = null, weights = WEIGHTS } = opts;
  const lines = s1Facts?.lines || [];
  if (!lines.length) return { lines: [] };

  const { data, info } = await sharp(imagePath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const img = { data, width: info.width, height: info.height };
  const W = s1Facts?.source?.w || info.width;
  // scale S1 coordinates if the decoded image differs from the S1 source size
  const scale = info.width / W;

  const scaled = lines.map((l) => ({
    ...l,
    box: {
      x: l.box.x * scale, y: l.box.y * scale,
      w: l.box.w * scale, h: l.box.h * scale
    },
    quad: Array.isArray(l.quad) ? l.quad.map(([x, y]) => [x * scale, y * scale]) : l.quad
  }));
  const regions = Array.isArray(photoRegions)
    ? photoRegions.map((r) => ({ x: r.x * scale, y: r.y * scale, w: r.w * scale, h: r.h * scale }))
    : null;

  const out = [];
  for (const line of scaled) {
    const box = clampBox(line.box, img.width, img.height);
    const gm = glyphMask(img, box);
    const degenerate = gm.maskFrac < 0.015 || gm.maskFrac > 0.9;

    const ramp = degenerate ? { rampPx: 3, rel: 1 } : edgeRampFeature(img, gm, box);
    const ink = degenerate ? { tightness: 0.12, drift: 0 } : inkTightnessFeature(img, gm);
    const rect = rectangularityFeature(line.quad, box);
    const grid = gridAlignFeature(line, scaled, img.width);
    const ring = degenerate ? 0 : ringStrokeFeature(img, gm);
    const sem = semanticPrior(line.text);
    const shade = degenerate ? { slope: 0, resid: 0, shading: 0 } : bgShadingFeature(img, gm);

    let z = weights.bias
      + weights.ramp * clamp(1.6 - Math.min(ramp.rampPx, 5), -3.4, 1.1)
      + weights.rampRel * clamp(Math.log2(Math.max(ramp.rel, 1e-3)), -2, 2)
      + weights.ink * clamp((0.10 - ink.tightness) * 10, -2.5, 1.0)
      + weights.rect * clamp((rect - 0.75) * 4, -3, 1)
      + weights.grid * grid
      + weights.ring * ring
      + weights.sem * (sem - 0.5) * 2
      - weights.shade * shade.shading;

    // photo-region hint: mostly inside a confident photo AND weak overlay
    // evidence ⇒ lean scene. Strong evidence (a contrast ring or CTA/offer
    // semantics) is exempt; the penalty scales with how "physical" the local
    // ground looks (lighting drift/texture), so a flat designer badge that
    // happens to sit over the photo keeps its overlay verdict.
    const inPhoto = regions ? photoOverlap(line.box, regions) : 0;
    if (inPhoto >= 0.85 && !ring && sem <= 0.5) {
      z -= weights.photoPenalty * inPhoto * (0.25 + 0.75 * shade.shading);
    }

    const score = sigmoid(z);
    const origin = score >= AMBIG_HI ? 'overlay' : score <= AMBIG_LO ? 'scene' : 'ambiguous';
    out.push({
      id: line.id,
      origin,
      score: Math.round(score * 1000) / 1000,
      features: {
        edgeRamp: Math.round(ramp.rampPx * 100) / 100,
        edgeRampRel: Math.round(ramp.rel * 100) / 100,
        inkTightness: Math.round(ink.tightness * 1000) / 1000,
        inkDrift: Math.round(ink.drift * 1000) / 1000,
        rectangularity: Math.round(rect * 1000) / 1000,
        gridAlign: grid,
        ringStroke: ring,
        semantic: sem,
        bgSlope: Math.round(shade.slope * 10) / 10,
        bgResid: Math.round(shade.resid * 10) / 10,
        bgShading: Math.round(shade.shading * 100) / 100,
        photoOverlap: Math.round(inPhoto * 100) / 100,
        maskFrac: Math.round(gm.maskFrac * 1000) / 1000
      }
    });
  }
  return { lines: out };
}

export default { classifyTextOrigins, WEIGHTS, semanticPrior };
