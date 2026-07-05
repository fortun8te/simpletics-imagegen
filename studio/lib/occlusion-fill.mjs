// lib/occlusion-fill.mjs — OCCLUSION FILL for reference crops under editable overlays.
//
// THE BUG THIS KILLS: when an editable overlay (button / pill / badge / text-on-photo) sits on
// top of a photo region we CROP from the reference, the crop keeps the overlay's BAKED-IN pixels.
// Our editable overlay then renders on top → the element is DOUBLED; and if the user moves or
// edits the overlay, the baked ghost stays behind. Owner: "if there's a button on top of an
// image, the image below it still has the button — fix that, maybe with a fill."
// (Qwen-Image-Layered does this decomposition with a model; we approximate it deterministically.)
//
// Two exports:
//   planOcclusions(ext)                      — pure geometry: which crop-fraction rects of which
//                                              cutout asset are covered by editable overlays.
//   fillOccludedRegions(crop, rects, out)    — cheap deterministic content-aware fill of those
//                                              rects on the CROPPED asset (patch-based, sharp).
//
// The fill only needs to look sane at the overlay's edges (the re-added overlay covers the
// middle) and survive the overlay being nudged a bit. Perfect inpainting is not the bar.
//
// INTEGRATION (proposed, not applied — this module stays self-contained): the asset rewrite
// belongs where cutout assets are MATERIALIZED — design-agent.mjs AUTO-CUTOUT (runCopyReference,
// ~line 2937 `for (const n of candidates)`). planOcclusions() annotates each cutout layer's
// `cutoutCandidate.occluders` (crop-fraction rects), which survives in the local `cc` binding
// after `delete n.cutoutCandidate`. Patch sketch:
//
//   // after the matte branch (r.ok → n.src = /refasset?id=<matteId>):
//   if (Array.isArray(cc.occluders) && cc.occluders.length) {
//     const { fillOccludedRegions } = await import('./occlusion-fill.mjs');
//     if (n.style?.crop) {                      // rect crop → src is the SHARED ref png; never
//       const fillId = `${reference.ref}o${matteCacheKey(readFileSync(srcPng), cc.region).slice(0, 8)}`;
//       const fillPath = join(STATE_DIR, 'refs', `${fillId}.png`);
//       await sharpExtract(srcPng, cc.region, fillPath);       // materialize a DEDICATED crop
//       const f = await fillOccludedRegions(fillPath, cc.occluders, fillPath);
//       if (f.filled) { n.src = `/refasset?id=${fillId}`; delete n.style.crop; }
//     } else {                                  // matte → dedicated file already; fill in place
//       await fillOccludedRegions(join(STATE_DIR, 'refs', `${matteId}.png`), cc.occluders,
//                                 join(STATE_DIR, 'refs', `${matteId}.png`));
//     }
//   }
//   // photo-base case (`__photoBase` plan entry): materialize a filled copy of the full ref the
//   // same way and point the full-bleed base layer's src at it.

import { copyFileSync } from 'node:fs';

// Occluders covering more of the crop than this dominate it — a fill would be invention, skip.
export const MAX_OCCLUDER_FRAC = 0.45;
// Max Euclidean RGB distance between the two sampled strips' means before we declare the
// surroundings dissimilar (fill would smear two different worlds together) and skip.
export const STRIP_SIMILARITY_MAX_DIST = 64;
// An overlay counts as "on top of" a cutout when ≥ this fraction of the OVERLAY's area
// intersects the cutout's box.
export const MIN_OVERLAP_FRAC = 0.7;
// Synthetic id for the implicit full-bleed reference base used on photo-background reads
// (design-agent inserts the raw reference under rebuilt overlays — same baked-ghost problem).
export const PHOTO_BASE_ID = '__photoBase';

/* ── geometry helpers ──────────────────────────────────────────────────────────────────────── */

function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; }

function normBox(b) {
  if (!b || typeof b !== 'object') return null;
  const x = num(b.x), y = num(b.y), w = num(b.w), h = num(b.h);
  if (x === null || y === null || w === null || h === null || w <= 0 || h <= 0) return null;
  return { x, y, w, h };
}

function collectLeaves(layers, out = []) {
  for (const l of (Array.isArray(layers) ? layers : [])) {
    if (!l || typeof l !== 'object') continue;
    if (l.type === 'group' && Array.isArray(l.children)) { collectLeaves(l.children, out); continue; }
    out.push(l);
  }
  return out;
}

/** Editable overlays that get REBUILT on top of crops: text, badges, buttons, pills, CTAs. */
function isOverlay(l) {
  if (!l || l.cutoutCandidate) return false; // a cutout is never an occluder of another cutout
  if (l.type === 'text' || l.type === 'badge' || l.type === 'button' || l.type === 'pill') return true;
  if (typeof l.text === 'string' && l.text.trim()) return true;
  return /\b(badge|button|pill|cta)\b/i.test(String(l.role || ''));
}

function intersect(a, b) {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
  if (x2 <= x || y2 <= y) return null;
  return { x, y, w: x2 - x, h: y2 - y };
}

const clamp01 = (v) => Math.max(0, Math.min(1, v));

/**
 * Plan which crop-fraction rects of each cutout asset are occluded by editable overlays.
 *
 * Per cutout layer (`cutoutCandidate.region` present) — plus an implicit full-image pseudo-cutout
 * when `ext.backgroundIsPhoto` (the reference itself becomes the base layer) — find overlay
 * leaves whose box intersects the cutout's box by ≥ MIN_OVERLAP_FRAC of the OVERLAY's area, and
 * convert the intersection into fractions of the CROP (the cutout box ↔ crop mapping is linear:
 * crop pixel space spans exactly the cutout's canvas box).
 *
 * Returns [{ layerId, name, shape, region, rects: [{x,y,w,h,overlayId,overlayRole}] }] — entries
 * only for cutouts that HAVE occluders. Also annotates each real cutout layer in place with
 * `cutoutCandidate.occluders = rects` so the asset-materialization site (design-agent
 * AUTO-CUTOUT) can consume the plan without id bookkeeping. Pure + synchronous; never throws.
 */
export function planOcclusions(ext) {
  const plan = [];
  if (!ext || typeof ext !== 'object' || !Array.isArray(ext.layers)) return plan;
  const canvasW = num(ext.canvas?.w) || 1080;
  const canvasH = num(ext.canvas?.h) || 1080;

  const leaves = collectLeaves(ext.layers);
  const boxes = leaves.map((l) => normBox(l.box)).filter(Boolean);
  if (!boxes.length) return plan;
  // Unit sniff (same idea as scene-truth): all extents ≤ 2 → boxes are canvas fractions.
  const maxExtent = Math.max(...boxes.map((b) => Math.max(b.x + b.w, b.y + b.h)));
  const isFrac = maxExtent <= 2;
  const toFrac = (b) => (isFrac
    ? b
    : { x: b.x / canvasW, y: b.y / canvasH, w: b.w / canvasW, h: b.h / canvasH });

  const cutouts = [];
  for (let i = 0; i < leaves.length; i++) {
    const l = leaves[i];
    const region = l?.cutoutCandidate?.region;
    const b = normBox(l.box);
    if (region && b) {
      cutouts.push({ layer: l, id: l.id || `layer_${i}`, name: l.name || l.role || null, shape: l.cutoutCandidate.shape || 'rect', region, fbox: toFrac(b) });
    }
  }
  if (ext.backgroundIsPhoto) {
    // The raw reference becomes the full-bleed base under rebuilt overlays — an implicit
    // region {0,0,1,1} cutout with the exact same baked-overlay problem.
    cutouts.unshift({ layer: null, id: PHOTO_BASE_ID, name: 'Background (reference photo)', shape: 'photo-base', region: { x: 0, y: 0, w: 1, h: 1 }, fbox: { x: 0, y: 0, w: 1, h: 1 } });
  }
  if (!cutouts.length) return plan;

  const overlays = leaves
    .map((l) => ({ l, fbox: isOverlay(l) ? (normBox(l.box) && toFrac(normBox(l.box))) : null }))
    .filter((o) => o.fbox);

  for (const c of cutouts) {
    const rects = [];
    for (const o of overlays) {
      if (o.l === c.layer) continue;
      const inter = intersect(o.fbox, c.fbox);
      if (!inter) continue;
      const overlayArea = o.fbox.w * o.fbox.h;
      if (!(overlayArea > 0) || (inter.w * inter.h) / overlayArea < MIN_OVERLAP_FRAC) continue;
      rects.push({
        x: clamp01((inter.x - c.fbox.x) / c.fbox.w),
        y: clamp01((inter.y - c.fbox.y) / c.fbox.h),
        w: clamp01(inter.w / c.fbox.w),
        h: clamp01(inter.h / c.fbox.h),
        overlayId: o.l.id || null,
        overlayRole: o.l.role || o.l.type || null,
      });
    }
    if (!rects.length) continue;
    if (c.layer) c.layer.cutoutCandidate.occluders = rects; // see INTEGRATION note (header)
    plan.push({ layerId: c.id, name: c.name, shape: c.shape, region: c.region, rects });
  }
  return plan;
}

/* ── fill ──────────────────────────────────────────────────────────────────────────────────── */

/** Deterministic PRNG (mulberry32) — noise must be reproducible for a given rect. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Mean RGB (ignores alpha) of an RGBA raw buffer. */
function meanRgb(data) {
  let r = 0, g = 0, b = 0;
  const n = data.length / 4;
  for (let i = 0; i < data.length; i += 4) { r += data[i]; g += data[i + 1]; b += data[i + 2]; }
  return n ? [r / n, g / n, b / n] : [0, 0, 0];
}

function rgbDist(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/**
 * Blend two mirrored/stretched strips across a w×h region (RGBA raw).
 * axis 'y': A = strip above (Aw=w), B = strip below — vertical blend top→bottom.
 * axis 'x': A = strip left (Ah=h),  B = strip right — horizontal blend left→right.
 * Either strip may be null (one-sided mirror fill).
 */
function blendStrips(A, B, w, h, axis) {
  const out = Buffer.alloc(w * h * 4);
  for (let yy = 0; yy < h; yy++) {
    for (let xx = 0; xx < w; xx++) {
      let wA, ai, bi;
      if (axis === 'y') {
        const t = h > 1 ? yy / (h - 1) : 0;
        wA = A && B ? 1 - (yy + 0.5) / h : (A ? 1 : 0);
        // mirror across the seam, stretched to span the region: at the seam use the adjacent
        // strip row, at the far side the deepest sampled row.
        ai = A ? ((A.h - 1 - Math.round(t * (A.h - 1))) * A.w + Math.min(xx, A.w - 1)) * 4 : 0;
        bi = B ? (Math.round((1 - t) * (B.h - 1)) * B.w + Math.min(xx, B.w - 1)) * 4 : 0;
      } else {
        const t = w > 1 ? xx / (w - 1) : 0;
        wA = A && B ? 1 - (xx + 0.5) / w : (A ? 1 : 0);
        ai = A ? (Math.min(yy, A.h - 1) * A.w + (A.w - 1 - Math.round(t * (A.w - 1)))) * 4 : 0;
        bi = B ? (Math.min(yy, B.h - 1) * B.w + Math.round((1 - t) * (B.w - 1))) * 4 : 0;
      }
      const o = (yy * w + xx) * 4;
      for (let c = 0; c < 4; c++) {
        const vA = A ? A.data[ai + c] : 0;
        const vB = B ? B.data[bi + c] : 0;
        out[o + c] = Math.round(wA * vA + (1 - wA) * vB);
      }
    }
  }
  return out;
}

/**
 * Patch-based deterministic fill of occluded rects on a CROPPED asset.
 *
 * @param {string} cropPngPath  the crop/matte PNG produced from the reference
 * @param {Array<{x,y,w,h}>} occluderRectsInCropFrac  rects as fractions 0..1 OF THE CROP
 *        (the shape planOcclusions() emits — extra keys are ignored)
 * @param {string} outPath  where to write the result (may equal cropPngPath; always written,
 *        even when every rect is skipped, so callers can use outPath unconditionally)
 * @returns {{ok:boolean, outPath:string|null, filled:number, skipped:number,
 *            results:Array<{rect,filled?:boolean,skipped?:boolean,reason?:string}>, ms:number}}
 *
 * Method per rect: sample strips of surrounding texture immediately above/below the rect
 * (left/right instead when the rect is taller than wide), mirror/stretch them across the region
 * with a linear blend, blur (sigma ~2.5), add ~2% seeded noise so it reads as continuous
 * texture rather than a smear. Guards: skip rects covering > MAX_OCCLUDER_FRAC of the crop and
 * rects whose two surrounding strips disagree by > STRIP_SIMILARITY_MAX_DIST mean-RGB distance.
 */
export async function fillOccludedRegions(cropPngPath, occluderRectsInCropFrac, outPath, opts = {}) {
  const t0 = Date.now();
  const done = (extra) => ({ ok: false, outPath: null, filled: 0, skipped: 0, results: [], ms: Date.now() - t0, ...extra });

  let sharp;
  try { sharp = (await import('sharp')).default; } catch (e) { return done({ error: `sharp unavailable: ${e.message}` }); }

  let base;
  try {
    base = await sharp(cropPngPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  } catch (e) { return done({ error: `read crop: ${e.message}` }); }
  const W = base.info.width, H = base.info.height;
  const sigma = num(opts.sigma) || 2.5;
  const noiseAmp = (num(opts.noise) ?? 0.02) * 255;

  const rects = Array.isArray(occluderRectsInCropFrac) ? occluderRectsInCropFrac : [];
  const results = [];
  const patches = [];

  for (const r of rects) {
    const rb = normBox({ x: clamp01(num(r?.x) ?? -1), y: clamp01(num(r?.y) ?? -1), w: clamp01(num(r?.w) ?? 0), h: clamp01(num(r?.h) ?? 0) });
    if (!rb) { results.push({ rect: r, skipped: true, reason: 'degenerate rect' }); continue; }
    // fractions → px, padded 2px to swallow the baked overlay's anti-aliased edge
    const pad = 2;
    const x = Math.max(0, Math.round(rb.x * W) - pad);
    const y = Math.max(0, Math.round(rb.y * H) - pad);
    const w = Math.min(W - x, Math.round(rb.w * W) + 2 * pad);
    const h = Math.min(H - y, Math.round(rb.h * H) + 2 * pad);
    if (w < 2 || h < 2) { results.push({ rect: r, skipped: true, reason: 'degenerate rect' }); continue; }
    if ((w * h) / (W * H) > MAX_OCCLUDER_FRAC) {
      results.push({ rect: r, skipped: true, reason: `occluder covers >${Math.round(MAX_OCCLUDER_FRAC * 100)}% of the crop` });
      continue;
    }

    // sample strips on the SHORT axis so the mirrored texture travels the least distance
    const axis = h > w ? 'x' : 'y';
    const span = axis === 'y' ? h : w;
    const sWant = Math.max(3, Math.min(24, Math.round(span * 0.4)));
    const extract = (left, top, ew, eh) => ({
      data: extractRaw(base, left, top, ew, eh), w: ew, h: eh,
    });
    let A = null, B = null;
    if (axis === 'y') {
      const sA = Math.min(sWant, y);
      const sB = Math.min(sWant, H - (y + h));
      if (sA >= 3) A = extract(x, y - sA, w, sA);
      if (sB >= 3) B = extract(x, y + h, w, sB);
    } else {
      const sA = Math.min(sWant, x);
      const sB = Math.min(sWant, W - (x + w));
      if (sA >= 3) A = extract(x - sA, y, sA, h);
      if (sB >= 3) B = extract(x + w, y, sB, h);
    }
    if (!A && !B) { results.push({ rect: r, skipped: true, reason: 'no surrounding texture to sample' }); continue; }
    if (A && B) {
      const dist = rgbDist(meanRgb(A.data), meanRgb(B.data));
      if (dist > STRIP_SIMILARITY_MAX_DIST) {
        results.push({ rect: r, skipped: true, reason: `surrounding strips dissimilar (Δ=${Math.round(dist)})` });
        continue;
      }
    }

    // blend → blur → seeded noise
    let fill = blendStrips(A, B, w, h, axis);
    try {
      fill = await sharp(fill, { raw: { width: w, height: h, channels: 4 } }).blur(sigma).raw().toBuffer();
    } catch { /* blur is polish; the blend alone is acceptable */ }
    const rnd = mulberry32(((x * 73856093) ^ (y * 19349663) ^ (w * 83492791) ^ (h * 15485863)) >>> 0);
    for (let i = 0; i < fill.length; i += 4) {
      for (let c = 0; c < 3; c++) {
        const v = fill[i + c] + (rnd() * 2 - 1) * noiseAmp;
        fill[i + c] = v < 0 ? 0 : (v > 255 ? 255 : Math.round(v));
      }
    }
    patches.push({ raw: fill, x, y, w, h });
    results.push({ rect: r, filled: true });
  }

  try {
    if (patches.length) {
      const inputs = [];
      for (const p of patches) {
        inputs.push({
          input: await sharp(p.raw, { raw: { width: p.w, height: p.h, channels: 4 } }).png().toBuffer(),
          left: p.x, top: p.y,
        });
      }
      await sharp(cropPngPath).ensureAlpha().composite(inputs).png().toFile(`${outPath}.tmp.png`);
      copyFileSync(`${outPath}.tmp.png`, outPath);
      const { unlinkSync } = await import('node:fs');
      try { unlinkSync(`${outPath}.tmp.png`); } catch { /* best effort */ }
    } else if (outPath !== cropPngPath) {
      copyFileSync(cropPngPath, outPath);
    }
  } catch (e) { return done({ results, error: `write: ${e.message}` }); }

  return {
    ok: true, outPath,
    filled: results.filter((r) => r.filled).length,
    skipped: results.filter((r) => r.skipped).length,
    results, ms: Date.now() - t0,
  };
}

/** Extract a sub-rect from an RGBA raw {data, info} buffer (no sharp round-trip). */
function extractRaw(base, left, top, w, h) {
  const W = base.info.width;
  const out = Buffer.alloc(w * h * 4);
  for (let yy = 0; yy < h; yy++) {
    const srcOff = ((top + yy) * W + left) * 4;
    base.data.copy(out, yy * w * 4, srcOff, srcOff + w * 4);
  }
  return out;
}

export default { planOcclusions, fillOccludedRegions, MAX_OCCLUDER_FRAC, STRIP_SIMILARITY_MAX_DIST, MIN_OVERLAP_FRAC, PHOTO_BASE_ID };
