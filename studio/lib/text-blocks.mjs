// lib/text-blocks.mjs — S2.5 line→block merge (COPY-ENGINE-V2-CONTRACTS "Wave 2, S2.5").
//
// OCR (S1) emits LINES; the scene graph wants text BLOCKS (Figma text layers =
// paragraphs). mergeLinesToBlocks(s1, {origins?, regions?, pixels?}) applies the
// deterministic contract merge rule: two vertically adjacent lines join a block iff
// ALL of —
//   1. same S3 origin verdict (when `origins` is provided),
//   2. |fontSize delta| ≤ 12% (fontSize ≈ median word-box height, fallback line box
//      height) — with a ±2.5 px absolute noise floor on top of the 12% ratio, because
//      word-box heights of <20 px text quantize coarser than 12% (deviation noted in
//      the workstream report; ratio rule is unchanged for normal sizes),
//   3. ink color ΔE(Lab, CIE76) ≤ 10 — measured by Otsu-thresholding the line crop
//      when `pixels` ({data RGBA, width, height}) is provided; criterion is SKIPPED
//      (never blocks a merge) when pixels are absent or the ink read is unreliable,
//   4. shared alignment guide: left/center/right x within ±1.5% of canvas width,
//   5. vertical gap (lower.box.y − upper box bottom) ≤ 1.9 × median line height of
//      the pair,
//   6. no S4 region boundary between them (`regions` = [{x,y,w,h}]): containment
//      mismatch or a region edge crossing the inter-line band blocks the merge.
//
// Output: { blocks: [{ id:"B<n>", lineIds, box, text (\n-joined), align, origin?,
//   lineHeightPx (median baseline delta; single line → box height), fontSizePx,
//   letterSpacing (px estimate: per-char advance minus mean glyph-ink run width,
//   Otsu column projection; null without pixels) }] } in reading order.
//
// Invariants: pure + deterministic (same inputs ⇒ same output), sync, no I/O, no LLM;
// never throws on malformed lines (they pass through as single-line blocks).
// Callers: copy pipeline S2.5 stage (writes s2.blocks.json), test/text-blocks.test.mjs.

// ---------------------------------------------------------------------------------------------
// tunables
// ---------------------------------------------------------------------------------------------
const DEFAULTS = {
  fontDeltaPct: 0.12,       // contract: |fontSize delta| ≤ 12%
  fontDeltaAbsPx: 2.5,      // measurement-noise floor for small text (see header)
  inkDeltaE: 10,            // contract: ink ΔE ≤ 10 (CIE76 Lab)
  guidePctW: 0.015,         // contract: alignment guide ±1.5% canvas W
  gapFactor: 1.9,           // contract: gap ≤ 1.9 × median line height of the pair
  belowFactor: 0.35,        // "vertically adjacent": lower center ≥ 0.35×min(h) below
  regionSpanFrac: 0.3,      // region edge must span ≥30% of the pair's x-extent to count
  minInkFrac: 0.02,         // Otsu glyph class must be 2..98% of the crop to be trusted
  minInkSeparation: 70,     // Otsu class-mean gray separation below which the ink read is
                            // noise (small/blurred/scene text) ⇒ ink criterion is skipped
};

// ---------------------------------------------------------------------------------------------
// small math helpers
// ---------------------------------------------------------------------------------------------
const median = (arr) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const round1 = (v) => Math.round(v * 10) / 10;

/** sRGB [0..255] → CIE Lab (D65). */
export function rgbToLab([r, g, b]) {
  const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  // sRGB→XYZ (D65)
  let X = R * 0.4124564 + G * 0.3575761 + B * 0.1804375;
  let Y = R * 0.2126729 + G * 0.7151522 + B * 0.072175;
  let Z = R * 0.0193339 + G * 0.119192 + B * 0.9503041;
  X /= 0.95047; Z /= 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const [fx, fy, fz] = [f(X), f(Y), f(Z)];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIE76 ΔE between two Lab triples. */
export const deltaE = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Otsu threshold of a 256-bin histogram. Returns the threshold gray level. */
export function otsuThreshold(hist) {
  const total = hist.reduce((a, b) => a + b, 0);
  if (!total) return 128;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 128, bestVar = -1;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const v = wB * wF * (mB - mF) * (mB - mF);
    if (v > bestVar) { bestVar = v; best = t; }
  }
  return best;
}

// ---------------------------------------------------------------------------------------------
// pixel sampling — ink color + glyph mask of a line/word crop
// ---------------------------------------------------------------------------------------------

function clampBox(box, width, height) {
  const x = Math.max(0, Math.floor(box.x)), y = Math.max(0, Math.floor(box.y));
  const w = Math.min(width - x, Math.ceil(box.w)), h = Math.min(height - y, Math.ceil(box.h));
  return w > 0 && h > 0 ? { x, y, w, h } : null;
}

/** Otsu-split a crop into glyph vs background. Glyph class = the one whose mean gray
 *  is farther from the crop's border mean (borders are almost always background).
 *  Returns { glyph: Uint8Array w*h (1=glyph), frac, w, h } or null on degenerate crops. */
function glyphMask(pixels, rawBox) {
  const box = clampBox(rawBox, pixels.width, pixels.height);
  if (!box || box.w < 2 || box.h < 2) return null;
  const { data, width } = pixels;
  const { x, y, w, h } = box;
  const gray = new Uint8Array(w * h);
  const hist = new Uint32Array(256);
  let borderSum = 0, borderN = 0;
  for (let ry = 0; ry < h; ry++) {
    for (let rx = 0; rx < w; rx++) {
      const si = ((y + ry) * width + (x + rx)) * 4;
      const g = Math.round(0.299 * data[si] + 0.587 * data[si + 1] + 0.114 * data[si + 2]);
      gray[ry * w + rx] = g;
      hist[g]++;
      if (ry === 0 || ry === h - 1 || rx === 0 || rx === w - 1) { borderSum += g; borderN++; }
    }
  }
  const t = otsuThreshold(hist);
  // class means
  let s0 = 0, n0 = 0, s1 = 0, n1 = 0;
  for (let i = 0; i < 256; i++) (i <= t ? (s0 += i * hist[i], n0 += hist[i]) : (s1 += i * hist[i], n1 += hist[i]));
  if (!n0 || !n1) return null;
  const m0 = s0 / n0, m1 = s1 / n1, borderMean = borderSum / Math.max(1, borderN);
  const glyphIsDark = Math.abs(m0 - borderMean) >= Math.abs(m1 - borderMean);
  const glyph = new Uint8Array(w * h);
  let count = 0;
  for (let i = 0; i < w * h; i++) {
    const isG = glyphIsDark ? gray[i] <= t : gray[i] > t;
    if (isG) { glyph[i] = 1; count++; }
  }
  return { glyph, frac: count / (w * h), box, w, h, borderMean, separation: Math.abs(m1 - m0) };
}

/** Ink RGB (+Lab) of a line crop. Glyph pixels come from the Otsu split; the color is
 *  averaged over the glyph CORE — the half of glyph pixels whose gray is farthest from
 *  the crop-border mean — because anti-alias blend pixels drag a plain mean toward the
 *  background and make small text's measured lightness fluctuate line-to-line.
 *  Returns null when unreliable (degenerate crop, <20 glyph px, lopsided Otsu split,
 *  or weak Otsu class separation — blurred/low-contrast text yields noise, not color). */
export function measureInkColor(pixels, rawBox, opts = DEFAULTS) {
  const gm = glyphMask(pixels, rawBox);
  if (!gm || gm.frac < opts.minInkFrac || gm.frac > 1 - opts.minInkFrac) return null;
  if (gm.separation < opts.minInkSeparation) return null;
  const { data, width } = pixels;
  const { x, y, w, h } = gm.box;
  const px = []; // [distFromBorderGray, r, g, b]
  for (let ry = 0; ry < h; ry++) {
    for (let rx = 0; rx < w; rx++) {
      if (!gm.glyph[ry * w + rx]) continue;
      const si = ((y + ry) * width + (x + rx)) * 4;
      const gray = 0.299 * data[si] + 0.587 * data[si + 1] + 0.114 * data[si + 2];
      px.push([Math.abs(gray - gm.borderMean), data[si], data[si + 1], data[si + 2]]);
    }
  }
  if (px.length < 20) return null; // too few glyph pixels to trust
  px.sort((a, b) => b[0] - a[0]);
  const core = px.slice(0, Math.max(10, px.length >> 1));
  let r = 0, g = 0, b = 0;
  for (const p of core) { r += p[1]; g += p[2]; b += p[3]; }
  const rgb = [r / core.length, g / core.length, b / core.length];
  return { rgb: rgb.map(Math.round), lab: rgbToLab(rgb), frac: gm.frac };
}

/** Letter-spacing estimate for one line, px: median over words of
 *  (per-char advance − mean glyph-ink column-run width). Column runs come from the
 *  Otsu glyph mask projected onto x. Null when nothing measurable. */
function estimateLetterSpacing(pixels, line) {
  const words = (line.words || []).filter((w) => w?.box && (w.text || '').replace(/\s/g, '').length >= 3);
  const ests = [];
  for (const word of words) {
    const nChars = word.text.replace(/\s/g, '').length;
    const gm = glyphMask(pixels, word.box);
    if (!gm || gm.frac < 0.03 || gm.frac > 0.97) continue;
    const cols = new Uint16Array(gm.w);
    for (let ry = 0; ry < gm.h; ry++) for (let rx = 0; rx < gm.w; rx++) if (gm.glyph[ry * gm.w + rx]) cols[rx]++;
    const runs = [];
    let run = 0;
    for (let rx = 0; rx < gm.w; rx++) {
      if (cols[rx] > 0) run++;
      else if (run) { runs.push(run); run = 0; }
    }
    if (run) runs.push(run);
    if (!runs.length) continue;
    const meanRun = runs.reduce((a, b) => a + b, 0) / runs.length;
    const advance = gm.box.w / nChars;
    ests.push(advance - meanRun);
  }
  return ests.length ? round1(median(ests)) : null;
}

// ---------------------------------------------------------------------------------------------
// merge criteria
// ---------------------------------------------------------------------------------------------

function sharesGuide(a, b, canvasW, opts) {
  const tol = opts.guidePctW * canvasW;
  const dL = Math.abs(a.box.x - b.box.x);
  const dC = Math.abs((a.box.x + a.box.w / 2) - (b.box.x + b.box.w / 2));
  const dR = Math.abs((a.box.x + a.box.w) - (b.box.x + b.box.w));
  return Math.min(dL, dC, dR) <= tol;
}

function regionBoundaryBetween(a, b, rawRegions, opts) {
  if (!rawRegions?.length) return false;
  const regions = rawRegions.map((r) => (r?.box ? r.box : r)); // accept S4 element records too
  const inR = (l, r) => {
    const cx = l.box.x + l.box.w / 2, cy = l.box.y + l.box.h / 2;
    return cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h;
  };
  const bandTop = a.box.y + a.box.h, bandBot = b.box.y;
  const x0 = Math.min(a.box.x, b.box.x), x1 = Math.max(a.box.x + a.box.w, b.box.x + b.box.w);
  for (const r of regions) {
    if (!r || !(r.w > 0 && r.h > 0)) continue;
    if (inR(a, r) !== inR(b, r)) return true; // one inside, one outside ⇒ boundary between
    if (bandBot > bandTop) {
      const overlap = Math.min(x1, r.x + r.w) - Math.max(x0, r.x);
      if (overlap >= opts.regionSpanFrac * (x1 - x0)) {
        for (const edgeY of [r.y, r.y + r.h]) {
          if (edgeY > bandTop && edgeY < bandBot) return true;
        }
      }
    }
  }
  return false;
}

/** All six contract criteria for appending line b below line a. */
function canMerge(a, b, ctx) {
  const { opts, canvasW, regions } = ctx;
  // vertical adjacency: b strictly below a
  if (b.cy - a.cy < opts.belowFactor * Math.min(a.box.h, b.box.h)) return false;
  // (1) same origin verdict
  if (a.origin && b.origin && a.origin !== b.origin) return false;
  // (2) fontSize delta ≤ 12% (with small-text noise floor)
  const fMax = Math.max(a.fontSize, b.fontSize);
  if (Math.abs(a.fontSize - b.fontSize) > Math.max(opts.fontDeltaPct * fMax, opts.fontDeltaAbsPx)) return false;
  // (3) ink ΔE ≤ 10 — only when both sides measured reliably
  if (a.ink && b.ink && deltaE(a.ink.lab, b.ink.lab) > opts.inkDeltaE) return false;
  // (4) shared alignment guide
  if (!sharesGuide(a, b, canvasW, opts)) return false;
  // (5) vertical gap ≤ 1.9 × median line height of the pair
  const gap = b.box.y - (a.box.y + a.box.h);
  if (gap > opts.gapFactor * median([a.box.h, b.box.h])) return false;
  // (6) no region boundary between
  if (regionBoundaryBetween(a, b, regions, opts)) return false;
  return true;
}

// ---------------------------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------------------------

/**
 * Merge S1 OCR lines into text blocks per the S2.5 contract.
 * @param {{source?:{w,h}, lines:Array}} s1  S1 facts (lib/ocr.mjs shape)
 * @param {{origins?: object, regions?: Array, pixels?: {data,width,height}}} [io]
 *   origins: S3 result ({lines:[{id,origin}]}) or a plain {lineId: origin} map;
 *   regions: S4 region/element boxes [{x,y,w,h}];
 *   pixels:  decoded RGBA of the SOURCE image (enables ink-ΔE + letterSpacing).
 * @returns {{blocks: Array}}
 */
export function mergeLinesToBlocks(s1, { origins = null, regions = null, pixels = null, ...rest } = {}) {
  const opts = { ...DEFAULTS, ...rest.opts };
  const rawLines = Array.isArray(s1?.lines) ? s1.lines : [];
  const canvasW = s1?.source?.w
    || pixels?.width
    || Math.max(1, ...rawLines.map((l) => (l?.box ? l.box.x + l.box.w : 1)));

  // normalize origins → id map
  let originOf = null;
  if (origins) {
    originOf = {};
    if (Array.isArray(origins.lines)) for (const o of origins.lines) originOf[o.id] = o.origin;
    else if (typeof origins === 'object') for (const [k, v] of Object.entries(origins)) originOf[k] = typeof v === 'string' ? v : v?.origin;
  }

  // per-line derived facts
  const lines = [];
  for (const l of rawLines) {
    if (!l?.box || !(l.box.w > 0 && l.box.h > 0)) continue;
    const wordHeights = (l.words || []).map((w) => w?.box?.h).filter((h) => h > 0);
    const fontSize = wordHeights.length ? median(wordHeights) : l.box.h;
    // baseline ≈ mean y of the bottom quad edge (BL,BR); fallback box bottom
    const baseline = Array.isArray(l.quad) && l.quad.length === 4
      ? (l.quad[2][1] + l.quad[3][1]) / 2
      : l.box.y + l.box.h;
    lines.push({
      id: l.id, text: l.text ?? '', box: l.box,
      cy: l.box.y + l.box.h / 2,
      fontSize, baseline,
      origin: originOf ? originOf[l.id] ?? null : null,
      ink: pixels ? measureInkColor(pixels, l.box, opts) : null,
      letterSpacing: pixels ? estimateLetterSpacing(pixels, l) : null,
    });
  }
  lines.sort((a, b) => a.cy - b.cy || a.box.x - b.box.x);

  // greedy chain merge: each new line attaches below the block whose LAST line
  // satisfies all criteria; among candidates pick the smallest vertical gap
  const ctx = { opts, canvasW, regions };
  const groups = [];
  for (const line of lines) {
    let best = null, bestGap = Infinity;
    for (const g of groups) {
      const last = g[g.length - 1];
      if (!canMerge(last, line, ctx)) continue;
      const gap = line.box.y - (last.box.y + last.box.h);
      if (gap < bestGap) { bestGap = gap; best = g; }
    }
    if (best) best.push(line);
    else groups.push([line]);
  }

  // assemble block records
  const blocks = groups.map((g) => {
    const x0 = Math.min(...g.map((l) => l.box.x));
    const y0 = Math.min(...g.map((l) => l.box.y));
    const x1 = Math.max(...g.map((l) => l.box.x + l.box.w));
    const y1 = Math.max(...g.map((l) => l.box.y + l.box.h));
    const box = { x: round1(x0), y: round1(y0), w: round1(x1 - x0), h: round1(y1 - y0) };

    // align: the guide with the smallest spread across member lines
    let align;
    if (g.length === 1) {
      const c = g[0].box.x + g[0].box.w / 2;
      align = Math.abs(c - canvasW / 2) <= opts.guidePctW * canvasW ? 'center' : 'left';
    } else {
      const spread = (vals) => Math.max(...vals) - Math.min(...vals);
      const sL = spread(g.map((l) => l.box.x));
      const sC = spread(g.map((l) => l.box.x + l.box.w / 2));
      const sR = spread(g.map((l) => l.box.x + l.box.w));
      align = sC <= sL && sC <= sR ? 'center' : sL <= sR ? 'left' : 'right';
    }

    const baselineDeltas = [];
    for (let i = 1; i < g.length; i++) baselineDeltas.push(g[i].baseline - g[i - 1].baseline);
    const lineHeightPx = baselineDeltas.length ? round1(median(baselineDeltas)) : round1(g[0].box.h);

    const spacings = g.map((l) => l.letterSpacing).filter((v) => v != null);
    const origin = g[0].origin ?? undefined;

    return {
      lineIds: g.map((l) => l.id),
      box,
      text: g.map((l) => l.text).join('\n'),
      align,
      ...(origin !== undefined && origin !== null ? { origin } : {}),
      lineHeightPx,
      fontSizePx: round1(median(g.map((l) => l.fontSize))),
      letterSpacing: spacings.length ? round1(median(spacings)) : null,
    };
  });

  // reading order: top→bottom, then left→right; ids assigned after sort
  blocks.sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
  blocks.forEach((b, i) => { b.id = `B${i}`; });
  return { blocks: blocks.map(({ id, ...rest2 }) => ({ id, ...rest2 })) };
}

export default { mergeLinesToBlocks, measureInkColor, rgbToLab, deltaE, otsuThreshold };
