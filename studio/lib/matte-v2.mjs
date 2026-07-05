// lib/matte-v2.mjs — next-gen subject cutouts via ONNX (BEN2 / BiRefNet-lite), same contract
// as lib/matte.mjs matteCutout(). Does NOT touch matte.mjs; callers can fallback-chain.
//
// WHY: the incumbent (@imgly isnet-medium) fails on soft/partial subjects, layered objects,
// edge contamination and hard-cut shadows. Both models here are 2025-class dichotomous-
// segmentation nets trained at 1024x1024 with proper soft-alpha edges:
//   - BEN2  (PramaLLC/BEN2, MIT, official ONNX export, 213MB)  — confidence-guided matting,
//     strong on hair/soft edges & shadows. Input: raw 0..1 RGB. Output: min-max normalized map.
//   - BiRefNet-lite (ZhengPeng7/BiRefNet swin-tiny, MIT, onnx-community export, 214MB)
//     Input: ImageNet-normalized RGB. Output: logits -> sigmoid.
// LICENSE: both MIT (verified on HF model cards 2026-07). RMBG-2.0 was evaluated and REJECTED:
// CC-BY-NC (non-commercial) + gated download.
//
// Models live in .state/models/ (gitignored). Missing model file => {ok:false, reason} so the
// caller keeps the rect crop (same graceful degrade as matte.mjs). Download:
//   curl -sL -o .state/models/ben2_base.onnx      https://huggingface.co/PramaLLC/BEN2/resolve/main/BEN2_Base.onnx
//   curl -sL -o .state/models/birefnet_lite.onnx  https://huggingface.co/onnx-community/BiRefNet_lite-ONNX/resolve/main/onnx/model.onnx

import { createHash } from 'node:crypto';
import { mkdirSync, existsSync, copyFileSync, statSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODELS_DIR = join(__dirname, '..', '.state', 'models');
const MATTE_CACHE_DIR = join(__dirname, '..', '.state', 'mattes-v2');
const MODEL_SIZE = 1024; // both nets are 1024x1024 native

export const BACKENDS = {
  ben2: { file: 'ben2_base.onnx', normalize: false, post: 'minmax' },
  birefnet: { file: 'birefnet_lite.onnx', normalize: true, post: 'sigmoid' },
};
export const DEFAULT_BACKEND = process.env.MATTE_V2_BACKEND || 'ben2';

// Same judging thresholds as v1 so fallback-chaining keeps one mental model.
export const MATTE_MAX_SUBJECT_FRAC = 0.92;
export const MATTE_MIN_SUBJECT_FRAC = 0.08;

export function matteV2CacheKey(srcBuf, cropFrac, backend) {
  const h = createHash('sha256');
  h.update(srcBuf);
  h.update(JSON.stringify({ x: cropFrac.x, y: cropFrac.y, w: cropFrac.w, h: cropFrac.h }));
  h.update(`v2-${backend}-gate-v1`);
  return h.digest('hex').slice(0, 24);
}

export function modelPathFor(backend) {
  const spec = BACKENDS[backend];
  return spec ? join(MODELS_DIR, spec.file) : null;
}

export function modelAvailable(backend = DEFAULT_BACKEND) {
  const p = modelPathFor(backend);
  try { return !!p && existsSync(p) && statSync(p).size > 1e6; } catch { return false; }
}

// One ORT session per backend, created lazily (~2-4s load, ~1GB RAM for swin-tiny fp32).
const _sessions = new Map();
async function getSession(backend, modelPath) {
  if (_sessions.has(backend)) return _sessions.get(backend);
  const ort = (await import('onnxruntime-node')).default;
  const session = await ort.InferenceSession.create(modelPath, {
    graphOptimizationLevel: 'all',
  });
  _sessions.set(backend, { ort, session });
  return _sessions.get(backend);
}

/** RGB raw (HWC uint8, MODEL_SIZE²) -> Float32Array NCHW, optionally ImageNet-normalized. */
export function toTensorData(rgb, normalize) {
  const px = MODEL_SIZE * MODEL_SIZE;
  const out = new Float32Array(3 * px);
  const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
  for (let i = 0; i < px; i++) {
    for (let c = 0; c < 3; c++) {
      const v = rgb[i * 3 + c] / 255;
      out[c * px + i] = normalize ? (v - mean[c]) / std[c] : v;
    }
  }
  return out;
}

/** Decode raw IEEE-754 half-precision bits (Uint16Array) to Float32Array. BEN2's ONNX export
 * emits a float16 output tensor; ORT node exposes it as raw uint16 bit patterns. */
export function fp16BitsToFloat32(u16) {
  const out = new Float32Array(u16.length);
  for (let i = 0; i < u16.length; i++) {
    const h = u16[i];
    const sign = (h & 0x8000) ? -1 : 1;
    const exp = (h >> 10) & 0x1f;
    const frac = h & 0x3ff;
    if (exp === 0) out[i] = sign * frac * 2 ** -24; // subnormal
    else if (exp === 31) out[i] = frac ? NaN : sign * Infinity;
    else out[i] = sign * (1 + frac / 1024) * 2 ** (exp - 15);
  }
  return out;
}

/** Model output map -> uint8 alpha (0..255), per-backend activation. Exported for tests. */
export function mapToAlpha(data, post) {
  const n = data.length;
  const alpha = new Uint8Array(n);
  if (post === 'sigmoid') {
    for (let i = 0; i < n; i++) alpha[i] = Math.round(255 / (1 + Math.exp(-data[i])));
  } else { // minmax (BEN2 reference postprocess)
    let mi = Infinity, ma = -Infinity;
    for (let i = 0; i < n; i++) { const v = data[i]; if (v < mi) mi = v; if (v > ma) ma = v; }
    const span = ma - mi || 1;
    for (let i = 0; i < n; i++) alpha[i] = Math.round(((data[i] - mi) / span) * 255);
  }
  return alpha;
}

export function alphaFraction(rgba, pixelCount) {
  let kept = 0;
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] > 127) kept++;
  return pixelCount ? kept / pixelCount : 0;
}

/**
 * Drop-in v2 of matteCutout: crop `cropFrac` (0..1 {x,y,w,h}) from srcPngPath, matte the crop
 * with an ONNX model, write alpha PNG to outPath.
 * opts: { backend: 'ben2'|'birefnet', cacheDir, modelPath, minSolidity }
 * Returns { ok, outPath, ms, subjectFrac, backend, solidity?, cached?, reason? }.
 */
export async function matteCutoutV2(srcPngPath, cropFrac, outPath, opts = {}) {
  const t0 = Date.now();
  const backend = opts.backend || DEFAULT_BACKEND;
  const fail = (reason, extra = {}) =>
    ({ ok: false, outPath: null, ms: Date.now() - t0, subjectFrac: null, backend, reason, ...extra });
  const spec = BACKENDS[backend];
  if (!spec) return fail(`unknown backend: ${backend}`);
  if (!cropFrac || !(cropFrac.w > 0) || !(cropFrac.h > 0)) return fail('bad crop');

  let srcBuf;
  try { srcBuf = await readFile(srcPngPath); } catch (e) { return fail(`read source: ${e.message}`); }

  const cacheDir = opts.cacheDir || MATTE_CACHE_DIR;
  const key = matteV2CacheKey(srcBuf, cropFrac, backend);
  const cachePath = join(cacheDir, `${key}.png`);
  try { mkdirSync(cacheDir, { recursive: true }); } catch { /* best effort */ }
  if (existsSync(cachePath) && statSync(cachePath).size > 0) {
    let subjectFrac = null;
    try { subjectFrac = JSON.parse(await readFile(`${cachePath}.json`, 'utf8')).subjectFrac; } catch { /* optional */ }
    try { if (outPath && outPath !== cachePath) copyFileSync(cachePath, outPath); } catch (e) { return fail(`copy cached: ${e.message}`); }
    return { ok: true, outPath: outPath || cachePath, ms: Date.now() - t0, subjectFrac, backend, cached: true };
  }

  const modelPath = opts.modelPath || modelPathFor(backend);
  if (!existsSync(modelPath)) return fail(`model missing: ${modelPath} (see header for download)`);

  let sharp;
  try { sharp = (await import('sharp')).default; } catch (e) { return fail(`deps unavailable: ${e.message}`); }

  // Crop (fractions -> pixels, clamped) and keep the crop's raw RGB for compositing.
  let cropRgb, cw, ch;
  try {
    const meta = await sharp(srcBuf).metadata();
    const W = meta.width, H = meta.height;
    const left = Math.max(0, Math.min(W - 1, Math.round(cropFrac.x * W)));
    const top = Math.max(0, Math.min(H - 1, Math.round(cropFrac.y * H)));
    cw = Math.max(1, Math.min(W - left, Math.round(cropFrac.w * W)));
    ch = Math.max(1, Math.min(H - top, Math.round(cropFrac.h * H)));
    cropRgb = await sharp(srcBuf).extract({ left, top, width: cw, height: ch })
      .removeAlpha().raw().toBuffer();
  } catch (e) { return fail(`crop: ${e.message}`); }

  // Preprocess: stretch-resize to 1024x1024 (both reference impls stretch, no letterbox).
  let outputMap;
  try {
    const resized = await sharp(cropRgb, { raw: { width: cw, height: ch, channels: 3 } })
      .resize(MODEL_SIZE, MODEL_SIZE, { fit: 'fill' }).raw().toBuffer();
    const { ort, session } = await getSession(backend, modelPath);
    const input = new ort.Tensor('float32', toTensorData(resized, spec.normalize),
      [1, 3, MODEL_SIZE, MODEL_SIZE]);
    const feeds = { [session.inputNames[0]]: input };
    const results = await session.run(feeds);
    // BiRefNet exports can emit multiple pyramid maps; the FINAL prediction is the last output.
    const outName = session.outputNames[session.outputNames.length - 1];
    const outTensor = results[outName];
    outputMap = outTensor.type === 'float16'
      ? fp16BitsToFloat32(outTensor.data)  // BEN2 export outputs fp16 (raw bits via ORT)
      : outTensor.data;
  } catch (e) { return fail(`inference(${backend}): ${e.message}`); }

  // Postprocess: activation -> alpha, resize mask back to crop size, join as alpha channel.
  let rgba, subjectFrac, solidity;
  try {
    const alpha1024 = Buffer.from(mapToAlpha(outputMap, spec.post));
    // NB: sharp promotes 1-channel raw to 3 channels through resize — stride by info.channels.
    const { data: alphaBuf, info: aInfo } = await sharp(alpha1024,
      { raw: { width: MODEL_SIZE, height: MODEL_SIZE, channels: 1 } })
      .resize(cw, ch, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
    const stride = aInfo.channels;
    rgba = Buffer.alloc(cw * ch * 4);
    for (let i = 0; i < cw * ch; i++) {
      rgba[i * 4] = cropRgb[i * 3]; rgba[i * 4 + 1] = cropRgb[i * 3 + 1];
      rgba[i * 4 + 2] = cropRgb[i * 3 + 2];
      const a = alphaBuf[i * stride];
      rgba[i * 4 + 3] = a < 8 ? 0 : a; // snap near-zero ghost residue
    }
    subjectFrac = alphaFraction(rgba, cw * ch);
    // Same translucency gate idea as v1: a mostly half-alpha subject renders washed out.
    let kept = 0, solid = 0;
    for (let i = 3; i < rgba.length; i += 4) if (rgba[i] > 60) { kept++; if (rgba[i] > 200) solid++; }
    solidity = kept ? solid / kept : 0;
    const minSolidity = opts.minSolidity ?? 0.72;
    if (kept && solidity < minSolidity) {
      return fail('matte too translucent (ghost subject)', { subjectFrac, solidity: Math.round(solidity * 100) / 100 });
    }
  } catch (e) { return fail(`postprocess: ${e.message}`); }
  if (!(subjectFrac >= MATTE_MIN_SUBJECT_FRAC && subjectFrac <= MATTE_MAX_SUBJECT_FRAC)) {
    return fail('matte failed thresholds', { subjectFrac });
  }

  try {
    const sharpMod = (await import('sharp')).default;
    const png = await sharpMod(rgba, { raw: { width: cw, height: ch, channels: 4 } }).png().toBuffer();
    await writeFile(cachePath, png);
    await writeFile(`${cachePath}.json`, JSON.stringify({ subjectFrac, solidity, backend, cropFrac, w: cw, h: ch }));
    if (outPath && outPath !== cachePath) await writeFile(outPath, png);
  } catch (e) { return fail(`write: ${e.message}`); }
  return {
    ok: true, outPath: outPath || cachePath, ms: Date.now() - t0,
    subjectFrac, solidity: Math.round(solidity * 100) / 100, backend, cached: false,
  };
}

export default { matteCutoutV2, matteV2CacheKey, modelAvailable, modelPathFor, mapToAlpha, toTensorData, fp16BitsToFloat32, alphaFraction, BACKENDS, DEFAULT_BACKEND };
