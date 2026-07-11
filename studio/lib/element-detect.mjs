// lib/element-detect.mjs — S4 element detection via residual connected components
// (COPY-ENGINE-V2-CONTRACTS "Wave 2, S4"). Replaces VLM cutoutCandidates entirely.
//
// detectElements(pixels, {textLines, background, photoRegions?}) computes
// residual = |source − explained(background)|, masks OUT overlay text boxes
// (dilated ~30%), thresholds on luminance+chroma, morphologically closes (radius 2
// ⇒ 5 px window), labels 8-connected components, and keeps each CC as an element
// candidate when:
//   - area ≥ 24 px² (contract minimum),
//   - NOT >60% inside a declared photoRegion (photo content is not an element),
//   - NOT ≥90% inside the union of raw OCR line boxes (LayerD's OCR-CC rule:
//     such a CC is text remnants, never an element).
// A final consolidation pass folds a CC whose bbox sits ≥85% inside a larger
// non-photo element into that element (badge interiors get text-masked, splitting
// one visual element into ring + inner mark).
//
// `background` is one of:
//   - a fitted fill descriptor {kind:'flat'|'linear'|'radial', ...} (S5 shape) —
//     rendered internally via lib/fill-fit.mjs renderFill for comparison,
//   - a raw pixels object {data RGBA, width, height} (e.g. an S9 reconstruction) —
//     nearest-sampled if its dimensions differ from the source,
//   - null / a 'photo' verdict — honest fallback: flat median border color.
//
// kind heuristic (per contract order): 'shape' when ≤3 dominant colors (3-bit/channel
// quantization, bins covering 85% of samples) AND high solidity (bbox extent ≥ 0.45);
// else 'icon' when small (<4% canvas) AND high edge density (≥12% of CC pixels on a
// luminance gradient); else 'photo-fragment'.
//
// Output: { elements: [{ id:"E<n>", box:{x,y,w,h}, mask:{data Uint8Array (255=element),
//   width, height} (box-local), kind, area (px), coverage (area/canvas),
//   stats:{solidity, domColors, edgeDensity} }] } sorted by area desc.
//
// Invariants: pure + deterministic, sync, no I/O, no LLM (sharp is allowed repo-wide
// but this module never touches disk — callers decode/encode). Never throws for
// degenerate inputs (empty text list, no background, tiny images).
// Callers: copy pipeline S4 stage (feeds S6 cutout/vectorize), test/element-detect.test.mjs.

import { renderFill } from './fill-fit.mjs';

// ---------------------------------------------------------------------------------------------
// tunables
// ---------------------------------------------------------------------------------------------
const DEFAULTS = {
  lumaThresh: 14,        // |ΔY| above ⇒ residual pixel
  chromaThresh: 20,      // |Δ(R−Y)|+|Δ(B−Y)| above ⇒ residual pixel
  textDilate: 0.15,      // 15% each side ⇒ ~30% total box dilation (contract)
  closeRadius: 2,        // morphological close radius (2 ⇒ 5 px window, contract 3-5 px)
  minArea: 24,           // px², contract
  photoInsideFrac: 0.6,  // CC >60% inside a photoRegion ⇒ dropped
  textOverlapFrac: 0.9,  // CC ≥90% inside OCR line boxes ⇒ text, dropped
  shapeSolidity: 0.45,   // bbox extent for 'shape'
  shapeMaxColors: 3,     // dominant colors for 'shape'
  iconMaxCanvasFrac: 0.04,
  iconEdgeDensity: 0.12,
  edgeGradThresh: 50,    // central-difference luminance gradient ⇒ "edge" pixel
  nestedInsideFrac: 0.85,// CC bbox ≥85% inside a larger non-photo element ⇒ same element
  maxElements: 64,       // keep the largest N candidates
};

/** Fraction of box a's area inside box b. */
const insideFrac = (a, b) => {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return (ix * iy) / Math.max(1, a.w * a.h);
};

const luma = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

// ---------------------------------------------------------------------------------------------
// background → explained pixels
// ---------------------------------------------------------------------------------------------

/** Per-channel median of a 2-px border ring — the honest flat fallback. */
export function estimateBorderColor(pixels) {
  const { data, width, height } = pixels;
  const chans = [[], [], []];
  const ring = 2;
  const push = (x, y) => {
    const i = (y * width + x) * 4;
    chans[0].push(data[i]); chans[1].push(data[i + 1]); chans[2].push(data[i + 2]);
  };
  for (let x = 0; x < width; x++) for (let y = 0; y < Math.min(ring, height); y++) { push(x, y); push(x, height - 1 - y); }
  for (let y = 0; y < height; y++) for (let x = 0; x < Math.min(ring, width); x++) { push(x, y); push(width - 1 - x, y); }
  const med = (arr) => { const s = arr.sort((a, b) => a - b); return s[s.length >> 1] ?? 0; };
  return [med(chans[0]), med(chans[1]), med(chans[2])];
}

/** Render/resample the `background` argument into an RGBA buffer matching (w,h). */
function explainedPixels(pixels, background) {
  const { width, height } = pixels;
  if (background && background.data && background.width && background.height) {
    if (background.width === width && background.height === height) return background;
    // nearest-sample to source dims
    const out = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
      const sy = Math.min(background.height - 1, Math.round((y * background.height) / height));
      for (let x = 0; x < width; x++) {
        const sx = Math.min(background.width - 1, Math.round((x * background.width) / width));
        const si = (sy * background.width + sx) * 4, di = (y * width + x) * 4;
        out[di] = background.data[si]; out[di + 1] = background.data[si + 1];
        out[di + 2] = background.data[si + 2]; out[di + 3] = 255;
      }
    }
    return { data: out, width, height };
  }
  if (background && (background.kind === 'flat' || background.kind === 'linear' || background.kind === 'radial')) {
    return renderFill(background, width, height); // -> {data, width, height}
  }
  // null / 'photo' / unknown ⇒ flat median border color
  const [r, g, b] = estimateBorderColor(pixels);
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) { data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b; data[i * 4 + 3] = 255; }
  return { data, width, height };
}

// ---------------------------------------------------------------------------------------------
// binary morphology (separable box dilate/erode) + connected components
// ---------------------------------------------------------------------------------------------

function boxMorph(mask, width, height, radius, isDilate) {
  const pass = (src, w, h, horizontal) => {
    const dst = new Uint8Array(src.length);
    const outer = horizontal ? h : w, inner = horizontal ? w : h;
    for (let o = 0; o < outer; o++) {
      for (let i = 0; i < inner; i++) {
        let v = isDilate ? 0 : 1;
        for (let k = -radius; k <= radius; k++) {
          const ii = i + k;
          if (ii < 0 || ii >= inner) { if (!isDilate) { v = 0; break; } continue; }
          const idx = horizontal ? o * w + ii : ii * w + o;
          if (isDilate) { if (src[idx]) { v = 1; break; } }
          else if (!src[idx]) { v = 0; break; }
        }
        dst[horizontal ? o * w + i : i * w + o] = v;
      }
    }
    return dst;
  };
  return pass(pass(mask, width, height, true), width, height, false);
}

const morphClose = (mask, w, h, r) => boxMorph(boxMorph(mask, w, h, r, true), w, h, r, false);

/** 8-connected component labeling. Returns { labels Int32Array (0 = none), count }. */
function labelComponents(mask, width, height) {
  const labels = new Int32Array(width * height);
  const stack = new Int32Array(width * height);
  let next = 0;
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || labels[start]) continue;
    next++;
    let sp = 0;
    stack[sp++] = start;
    labels[start] = next;
    while (sp > 0) {
      const p = stack[--sp];
      const px = p % width, py = (p / width) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = py + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = px + dx;
          if (nx < 0 || nx >= width) continue;
          const q = ny * width + nx;
          if (mask[q] && !labels[q]) { labels[q] = next; stack[sp++] = q; }
        }
      }
    }
  }
  return { labels, count: next };
}

// ---------------------------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------------------------

/**
 * Detect non-text, non-background elements as residual connected components.
 * @param {{data:Uint8Array, width:number, height:number}} pixels  source RGBA
 * @param {{ textLines?: Array<{box:{x,y,w,h}}|{x,y,w,h}>,
 *           background?: object|null,
 *           photoRegions?: Array<{x,y,w,h}> }} [io]
 * @returns {{ elements: Array }}
 */
export function detectElements(pixels, { textLines = [], background = null, photoRegions = [], ...rest } = {}) {
  const opts = { ...DEFAULTS, ...rest.opts };
  const { data, width, height } = pixels;
  const n = width * height;
  if (!n) return { elements: [] };

  const explained = explainedPixels(pixels, background);
  const ex = explained.data;

  // 1. residual mask: luminance + chroma difference vs explained
  const mask = new Uint8Array(n);
  const gray = new Uint8Array(n); // source luminance, reused for edge density
  for (let i = 0; i < n; i++) {
    const s = i * 4;
    const ys = luma(data[s], data[s + 1], data[s + 2]);
    const ye = luma(ex[s], ex[s + 1], ex[s + 2]);
    gray[i] = ys;
    const dY = Math.abs(ys - ye);
    const dCr = Math.abs((data[s] - ys) - (ex[s] - ye));
    const dCb = Math.abs((data[s + 2] - ys) - (ex[s + 2] - ye));
    if (dY > opts.lumaThresh || dCr + dCb > opts.chromaThresh) mask[i] = 1;
  }

  // 2. mask OUT overlay text boxes, dilated ~30%
  const normBox = (t) => (t?.box ? t.box : t);
  const lineBoxes = textLines.map(normBox).filter((b) => b && b.w > 0 && b.h > 0);
  for (const b of lineBoxes) {
    const dx = b.w * opts.textDilate, dy = b.h * opts.textDilate;
    const x0 = Math.max(0, Math.floor(b.x - dx)), x1 = Math.min(width, Math.ceil(b.x + b.w + dx));
    const y0 = Math.max(0, Math.floor(b.y - dy)), y1 = Math.min(height, Math.ceil(b.y + b.h + dy));
    for (let y = y0; y < y1; y++) mask.fill(0, y * width + x0, y * width + x1);
  }

  // 3. morphological close
  const closed = morphClose(mask, width, height, opts.closeRadius);

  // 4. connected components
  const { labels, count } = labelComponents(closed, width, height);
  if (!count) return { elements: [] };

  // membership masks for the drop rules (raw, undilated line boxes per contract)
  const inText = new Uint8Array(n);
  for (const b of lineBoxes) {
    const x0 = Math.max(0, Math.floor(b.x)), x1 = Math.min(width, Math.ceil(b.x + b.w));
    const y0 = Math.max(0, Math.floor(b.y)), y1 = Math.min(height, Math.ceil(b.y + b.h));
    for (let y = y0; y < y1; y++) inText.fill(1, y * width + x0, y * width + x1);
  }
  const inPhoto = new Uint8Array(n);
  for (const b of photoRegions || []) {
    if (!b || !(b.w > 0 && b.h > 0)) continue;
    const x0 = Math.max(0, Math.floor(b.x)), x1 = Math.min(width, Math.ceil(b.x + b.w));
    const y0 = Math.max(0, Math.floor(b.y)), y1 = Math.min(height, Math.ceil(b.y + b.h));
    for (let y = y0; y < y1; y++) inPhoto.fill(1, y * width + x0, y * width + x1);
  }

  // 5. per-CC accumulation in one pass
  const area = new Uint32Array(count + 1);
  const textHit = new Uint32Array(count + 1);
  const photoHit = new Uint32Array(count + 1);
  const minX = new Int32Array(count + 1).fill(width);
  const minY = new Int32Array(count + 1).fill(height);
  const maxX = new Int32Array(count + 1).fill(-1);
  const maxY = new Int32Array(count + 1).fill(-1);
  for (let i = 0; i < n; i++) {
    const L = labels[i];
    if (!L) continue;
    area[L]++;
    if (inText[i]) textHit[L]++;
    if (inPhoto[i]) photoHit[L]++;
    const x = i % width, y = (i / width) | 0;
    if (x < minX[L]) minX[L] = x;
    if (x > maxX[L]) maxX[L] = x;
    if (y < minY[L]) minY[L] = y;
    if (y > maxY[L]) maxY[L] = y;
  }

  // 6. filter + classify
  const candidates = [];
  for (let L = 1; L <= count; L++) {
    if (area[L] < opts.minArea) continue;
    if (textHit[L] / area[L] >= opts.textOverlapFrac) continue;            // LayerD OCR-CC rule
    if (photoHit[L] / area[L] > opts.photoInsideFrac) continue;            // inside declared photo
    const bx = minX[L], by = minY[L], bw = maxX[L] - minX[L] + 1, bh = maxY[L] - minY[L] + 1;
    const solidity = area[L] / (bw * bh);

    // dominant colors (3-bit/channel quantization; bins covering 85% of pixels)
    // + edge density (central-difference luminance gradient) over this CC's pixels
    const bins = new Map();
    let edgePx = 0;
    const elMask = new Uint8Array(bw * bh);
    for (let y = by; y <= maxY[L]; y++) {
      for (let x = bx; x <= maxX[L]; x++) {
        const i = y * width + x;
        if (labels[i] !== L) continue;
        elMask[(y - by) * bw + (x - bx)] = 255;
        const s = i * 4;
        const key = ((data[s] >> 5) << 6) | ((data[s + 1] >> 5) << 3) | (data[s + 2] >> 5);
        bins.set(key, (bins.get(key) || 0) + 1);
        const gx = Math.abs(gray[y * width + Math.min(width - 1, x + 1)] - gray[y * width + Math.max(0, x - 1)]);
        const gy = Math.abs(gray[Math.min(height - 1, y + 1) * width + x] - gray[Math.max(0, y - 1) * width + x]);
        if (gx + gy > opts.edgeGradThresh) edgePx++;
      }
    }
    const counts = [...bins.values()].sort((a, b) => b - a);
    let acc = 0, domColors = 0;
    for (const c of counts) { acc += c; domColors++; if (acc >= 0.85 * area[L]) break; }
    const edgeDensity = edgePx / area[L];

    let kind;
    if (domColors <= opts.shapeMaxColors && solidity >= opts.shapeSolidity) kind = 'shape';
    else if (area[L] < opts.iconMaxCanvasFrac * n && edgeDensity >= opts.iconEdgeDensity) kind = 'icon';
    else kind = 'photo-fragment';

    candidates.push({
      box: { x: bx, y: by, w: bw, h: bh },
      mask: { data: elMask, width: bw, height: bh },
      kind,
      area: area[L],
      coverage: Math.round((area[L] / n) * 1e4) / 1e4,
      stats: {
        solidity: Math.round(solidity * 100) / 100,
        domColors,
        edgeDensity: Math.round(edgeDensity * 100) / 100,
      },
    });
  }

  // 7. nested-CC consolidation: a CC whose bbox sits ≥85% inside a larger NON-photo
  // element's bbox is a piece of the same element (e.g. a logo inside a badge frame
  // whose interior was text-masked). Photo-fragment hosts never absorb — their
  // sprawling bboxes would swallow genuinely separate small elements sitting on top.
  candidates.sort((a, b) => b.box.w * b.box.h - a.box.w * a.box.h);
  const merged = [];
  for (const c of candidates) {
    const host = merged.find((m) => m.kind !== 'photo-fragment' && insideFrac(c.box, m.box) >= opts.nestedInsideFrac);
    if (!host) { merged.push(c); continue; }
    // union boxes + masks; host keeps its kind/stats identity
    const x0 = Math.min(host.box.x, c.box.x), y0 = Math.min(host.box.y, c.box.y);
    const x1 = Math.max(host.box.x + host.box.w, c.box.x + c.box.w);
    const y1 = Math.max(host.box.y + host.box.h, c.box.y + c.box.h);
    const ub = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    const um = new Uint8Array(ub.w * ub.h);
    for (const part of [host, c]) {
      for (let yy = 0; yy < part.mask.height; yy++) {
        const srcOff = yy * part.mask.width;
        const dstOff = (part.box.y - y0 + yy) * ub.w + (part.box.x - x0);
        for (let xx = 0; xx < part.mask.width; xx++) if (part.mask.data[srcOff + xx]) um[dstOff + xx] = 255;
      }
    }
    host.box = ub;
    host.mask = { data: um, width: ub.w, height: ub.h };
    host.area += c.area;
    host.coverage = Math.round((host.area / n) * 1e4) / 1e4;
  }

  merged.sort((a, b) => b.area - a.area);
  const elements = merged.slice(0, opts.maxElements).map((e, i) => ({ id: `E${i}`, ...e }));
  return { elements };
}

export default { detectElements, estimateBorderColor };
