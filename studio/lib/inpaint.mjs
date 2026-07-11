// lib/inpaint.mjs — S6/S9 hole inpainting: MI-GAN ONNX first-line, deterministic patch fill
// as the never-fail fallback (COPY-ENGINE-V2 §3.4, contract in COPY-ENGINE-V2-CONTRACTS.md).
//
// Contract:  inpaint(pixels {data RGBA, width, height}, mask Uint8Array (255=hole), opts)
//              -> Promise<{ data, width, height, engine: 'migan'|'patch' }>
// NEVER throws, ALWAYS returns an image — worst case the input pixels come back untouched
// (engine still says what actually ran). Alpha is preserved verbatim; only RGB of hole pixels
// change (mattes keep their transparency).
//
// Model: .state/models/migan.onnx (downloader: scripts/fetch-migan.mjs). Two exports exist in
// the wild and both are handled:
//   - pipeline-v2 (official, what the downloader prefers): uint8 image [1,3,H,W] dynamic +
//     uint8 mask [1,1,H,W] where 255=KNOWN / 0=hole (note: INVERSE of our contract — we flip),
//     all crop/resize/blend baked into the graph → feed the full image.
//   - fixed-size raw export (e.g. 512×512): we crop a padded square around the hole bbox,
//     resize to the model size, run, resize back and composite ONLY hole pixels.
// ORT session is a lazy singleton (~0.1s create, reused across calls); a load failure is
// memoized so a broken model file doesn't re-pay the failure per call.
//
// Callers: lib/occlusion-fill.mjs (routes fillOccludedRegions through here), future S9 stage.
// Engine choice: opts.engine > env INPAINT_ENGINE ('migan'|'patch') > migan-when-model-present.

import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const MIGAN_MODEL_PATH = join(__dirname, '..', '.state', 'models', 'migan.onnx');
const HOLE = 128; // mask values >= HOLE count as hole (mask must effectively be binary)

export function miganAvailable() {
  try { return existsSync(MIGAN_MODEL_PATH) && statSync(MIGAN_MODEL_PATH).size > 5e6; }
  catch { return false; }
}

/** 'migan' | 'patch' — opts.engine wins, then INPAINT_ENGINE env, then model presence. */
export function resolveEngine(opts = {}) {
  const want = String(opts.engine || process.env.INPAINT_ENGINE || '').toLowerCase();
  if (want === 'patch') return 'patch';
  if (want === 'migan') return miganAvailable() ? 'migan' : 'patch';
  return miganAvailable() ? 'migan' : 'patch';
}

/* ── MI-GAN session (lazy singleton, memoized failure) ─────────────────────────────────────── */

let _sessionPromise = null;
async function getSession() {
  if (!_sessionPromise) {
    _sessionPromise = (async () => {
      const ort = await import('onnxruntime-node');
      const session = await ort.InferenceSession.create(MIGAN_MODEL_PATH);
      // Sniff the export flavor once: numeric H/W in the image input → fixed-size raw model.
      const imgMeta = (session.inputMetadata ?? []).find((m) => m.name === 'image');
      const dims = imgMeta?.shape || [];
      const fixed = typeof dims[2] === 'number' && typeof dims[3] === 'number' ? dims[2] : null;
      if (imgMeta && imgMeta.type !== 'uint8') throw new Error(`unsupported model input type ${imgMeta.type}`);
      return { ort, session, fixed };
    })();
    _sessionPromise.catch(() => {}); // avoid unhandled-rejection noise; failure memoized below
  }
  return _sessionPromise;
}

/**
 * Binary dilation of a hole mask (values >= HOLE) by radius r — two-pass sliding max.
 * WHY: the pipeline graph blends prediction with the ORIGINAL image at the mask boundary, so
 * whatever sat in the hole (ghost text, black) bleeds into a 1–3px ring. Feeding a slightly
 * fatter mask puts that blend ring on clean pixels instead. We composite back over the dilated
 * area too — those extra pixels are model output blended from clean context.
 */
function dilateMask(mask, W, H, r) {
  if (!(r > 0)) return mask;
  const tmp = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      let v = 0;
      for (let k = Math.max(0, x - r), e = Math.min(W - 1, x + r); k <= e; k++) {
        if (mask[row + k] >= HOLE) { v = 255; break; }
      }
      tmp[row + x] = v;
    }
  }
  const out = new Uint8Array(W * H);
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) {
      let v = 0;
      for (let k = Math.max(0, y - r), e = Math.min(H - 1, y + r); k <= e; k++) {
        if (tmp[k * W + x] >= HOLE) { v = 255; break; }
      }
      out[y * W + x] = v;
    }
  }
  return out;
}

/** RGBA interleaved → uint8 planar [3,H,W] (alpha dropped). */
function toPlanar(data, n) {
  const img = new Uint8Array(3 * n);
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    img[p] = data[i]; img[n + p] = data[i + 1]; img[2 * n + p] = data[i + 2];
  }
  return img;
}

/** Our mask (255=hole) → MI-GAN mask (255=known, 0=hole), binarized. Returns null if no hole. */
function toModelMask(mask, n) {
  const m = new Uint8Array(n);
  let holes = 0;
  for (let p = 0; p < n; p++) { const hole = mask[p] >= HOLE; m[p] = hole ? 0 : 255; if (hole) holes++; }
  return holes ? m : null;
}

/** Composite planar RGB result back into a copy of the RGBA input — HOLE pixels only. */
function compositeHoles(data, mask, res, n) {
  const out = Buffer.from(data); // independent copy (Buffer.from copies for Buffer and TypedArray alike)
  for (let p = 0; p < n; p++) {
    if (mask[p] >= HOLE) {
      const i = p * 4;
      out[i] = res[p]; out[i + 1] = res[n + p]; out[i + 2] = res[2 * n + p];
      // alpha untouched: mattes keep transparency; opaque photos stay opaque
    }
  }
  return out;
}

async function runMiganFull(ctx, pixels, mask) {
  const { width: W, height: H } = pixels;
  const n = W * H;
  const m = toModelMask(mask, n);
  if (!m) return null; // empty mask — nothing to inpaint
  const feeds = {
    image: new ctx.ort.Tensor('uint8', toPlanar(pixels.data, n), [1, 3, H, W]),
    mask: new ctx.ort.Tensor('uint8', m, [1, 1, H, W]),
  };
  const out = await ctx.session.run(feeds);
  const res = out[ctx.session.outputNames[0]].data;
  return compositeHoles(pixels.data, mask, res, n);
}

// Blend-ring dilation radius (px) applied to the caller's mask before the model call — see
// dilateMask(). Override via opts.dilate (0 disables).
export const MIGAN_DILATE_PX = 4;

/** Fixed-size export path: padded square crop around the hole bbox → resize → run → resize back. */
async function runMiganFixed(ctx, pixels, mask) {
  const sharp = (await import('sharp')).default;
  const { width: W, height: H } = pixels;
  // hole bbox
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (mask[y * W + x] >= HOLE) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null; // empty mask
  // padded square around the bbox (context is what the net paints from), clamped to the image
  const pad = Math.max(32, Math.round(Math.max(x1 - x0, y1 - y0) * 0.5));
  let side = Math.min(Math.max(x1 - x0, y1 - y0) + 2 * pad, Math.min(W, H));
  let cx = Math.min(Math.max(Math.round((x0 + x1) / 2 - side / 2), 0), W - side);
  let cy = Math.min(Math.max(Math.round((y0 + y1) / 2 - side / 2), 0), H - side);

  const S = ctx.fixed;
  const cropRGBA = Buffer.alloc(side * side * 4);
  const cropMask = Buffer.alloc(side * side);
  const flat = Buffer.isBuffer(pixels.data) ? pixels.data : Buffer.from(pixels.data.buffer, pixels.data.byteOffset, pixels.data.byteLength);
  for (let y = 0; y < side; y++) {
    const src = ((cy + y) * W + cx) * 4;
    flat.copy(cropRGBA, y * side * 4, src, src + side * 4);
    for (let x = 0; x < side; x++) cropMask[y * side + x] = mask[(cy + y) * W + (cx + x)];
  }
  const img512 = await sharp(cropRGBA, { raw: { width: side, height: side, channels: 4 } })
    .resize(S, S, { kernel: 'lanczos3' }).raw().toBuffer();
  const mask512 = await sharp(cropMask, { raw: { width: side, height: side, channels: 1 } })
    .resize(S, S, { kernel: 'nearest' }).raw().toBuffer();
  const n512 = S * S;
  const m = toModelMask(mask512, n512);
  if (!m) return null;
  const feeds = {
    image: new ctx.ort.Tensor('uint8', toPlanar(img512, n512), [1, 3, S, S]),
    mask: new ctx.ort.Tensor('uint8', m, [1, 1, S, S]),
  };
  const out = await ctx.session.run(feeds);
  const res = out[ctx.session.outputNames[0]].data; // planar [3,S,S]
  const inter = Buffer.alloc(n512 * 3);
  for (let p = 0; p < n512; p++) { inter[p * 3] = res[p]; inter[p * 3 + 1] = res[n512 + p]; inter[p * 3 + 2] = res[2 * n512 + p]; }
  const back = await sharp(inter, { raw: { width: S, height: S, channels: 3 } })
    .resize(side, side, { kernel: 'lanczos3' }).raw().toBuffer();
  // composite ONLY hole pixels of the crop window back into a copy of the full image
  const outData = Buffer.from(pixels.data);
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const p = (cy + y) * W + (cx + x);
      if (mask[p] >= HOLE) {
        const i = p * 4, j = (y * side + x) * 3;
        outData[i] = back[j]; outData[i + 1] = back[j + 1]; outData[i + 2] = back[j + 2];
      }
    }
  }
  return outData;
}

/**
 * MI-GAN only — returns { data, width, height, engine:'migan' } or NULL on any failure
 * (model absent, session error, empty mask, bad input). Never throws. Exposed so callers
 * that keep their own per-rect bookkeeping (occlusion-fill) can fall back themselves.
 */
export async function tryMigan(pixels, mask, opts = {}) {
  try {
    if (!miganAvailable()) return null;
    const { width: W, height: H, data } = pixels || {};
    if (!Number.isInteger(W) || !Number.isInteger(H) || W < 8 || H < 8) return null;
    if (!data || data.length !== W * H * 4 || !mask || mask.length !== W * H) return null;
    const r = Number.isFinite(opts.dilate) ? Math.max(0, opts.dilate | 0) : MIGAN_DILATE_PX;
    const fat = dilateMask(mask, W, H, r);
    const ctx = await getSession();
    const out = ctx.fixed ? await runMiganFixed(ctx, pixels, fat) : await runMiganFull(ctx, pixels, fat);
    if (!out) return null;
    return { data: out, width: W, height: H, engine: 'migan' };
  } catch {
    return null;
  }
}

/* ── patch fallback: mask → rects → occlusion-fill's deterministic strip blend ─────────────── */

/** Connected components (4-conn) of the hole mask → pixel bboxes, capped for sanity. */
export function maskToRects(mask, W, H, maxRects = 64) {
  const seen = new Uint8Array(W * H);
  const rects = [];
  const stack = [];
  for (let start = 0; start < W * H; start++) {
    if (mask[start] < HOLE || seen[start]) continue;
    let x0 = W, y0 = H, x1 = 0, y1 = 0;
    stack.length = 0; stack.push(start); seen[start] = 1;
    while (stack.length) {
      const p = stack.pop();
      const x = p % W, y = (p / W) | 0;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0 && !seen[p - 1] && mask[p - 1] >= HOLE) { seen[p - 1] = 1; stack.push(p - 1); }
      if (x < W - 1 && !seen[p + 1] && mask[p + 1] >= HOLE) { seen[p + 1] = 1; stack.push(p + 1); }
      if (y > 0 && !seen[p - W] && mask[p - W] >= HOLE) { seen[p - W] = 1; stack.push(p - W); }
      if (y < H - 1 && !seen[p + W] && mask[p + W] >= HOLE) { seen[p + W] = 1; stack.push(p + W); }
    }
    rects.push({ x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 });
    if (rects.length >= maxRects) break;
  }
  return rects;
}

/**
 * inpaint() — the S6/S9 contract entry point. Fills mask holes (255=hole) in an RGBA image.
 * Engine preference migan → patch; NEVER throws; ALWAYS returns { data, width, height, engine }.
 * opts: { engine: 'migan'|'patch' } (also env INPAINT_ENGINE). `engine` in the result reflects
 * what actually produced the pixels, not what was asked for.
 */
export async function inpaint(pixels, mask, opts = {}) {
  const W = pixels?.width | 0, H = pixels?.height | 0;
  const safe = () => ({ data: pixels?.data, width: W, height: H, engine: 'patch' });
  try {
    if (!pixels?.data || !mask || W < 2 || H < 2) return safe();

    if (resolveEngine(opts) === 'migan') {
      const r = await tryMigan(pixels, mask);
      if (r) return r;
    }

    // patch fallback — reuse occlusion-fill's deterministic strip blend per hole bbox.
    // Dynamic import: occlusion-fill imports us the same way, this keeps the cycle lazy.
    const { patchFillRects } = await import('./occlusion-fill.mjs');
    const rects = maskToRects(mask, W, H);
    if (!rects.length) return safe();
    const pf = await patchFillRects(pixels, rects, opts);
    return { data: pf.data, width: W, height: H, engine: 'patch' };
  } catch {
    return safe();
  }
}

export default { inpaint, tryMigan, miganAvailable, resolveEngine, maskToRects, MIGAN_MODEL_PATH };
