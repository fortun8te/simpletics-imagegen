// lib/matte.mjs — TRUE subject cutouts (alpha mattes) for the copy-from-reference pipeline.
//
// Rectangular crops of reference photos lift the subject's BACKGROUND along with the subject
// (jars/bottles/people arrive as full rectangles). matteCutout() crops the candidate region,
// runs @imgly/background-removal-node on the CROP only, and writes an alpha PNG the renderer
// can place as a clean cut-out. Failed mattes (kept >92% or <8% of pixels) report ok:false so
// the caller keeps the rect crop.
//
// LICENSE NOTE: @imgly/background-removal(-node) is dual-licensed by IMG.LY. The browser
// variant is ALREADY a dependency of this repo (src/lib/bgRemoval.ts), so adding the node
// variant does not change our licensing posture — but COMMERCIAL DISTRIBUTION of this app
// requires verifying/obtaining the IMG.LY commercial license first.

import { createHash } from 'node:crypto';
import { mkdirSync, existsSync, copyFileSync, statSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MATTE_CACHE_DIR = join(__dirname, '..', '.state', 'mattes');

// Thresholds: a matte that kept nearly everything didn't separate a subject; one that kept
// almost nothing found no subject. Either way the rect crop is the safer render.
export const MATTE_MAX_SUBJECT_FRAC = 0.92;
export const MATTE_MIN_SUBJECT_FRAC = 0.08;

let _modelLogged = false;

/** Cache key: source file content + crop rect → stable hash. */
export function matteCacheKey(srcBuf, cropFrac) {
  const h = createHash('sha256');
  h.update(srcBuf);
  h.update(JSON.stringify({ x: cropFrac.x, y: cropFrac.y, w: cropFrac.w, h: cropFrac.h }));
  return h.digest('hex').slice(0, 24);
}

/** Judge a matte by its kept-pixel fraction. Exported for tests. */
export function judgeSubjectFrac(subjectFrac) {
  return subjectFrac >= MATTE_MIN_SUBJECT_FRAC && subjectFrac <= MATTE_MAX_SUBJECT_FRAC;
}

/** Fraction of pixels with alpha > 0.5 in an RGBA raw buffer. Exported for tests. */
export function alphaFraction(rgba, pixelCount) {
  let kept = 0;
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] > 127) kept++;
  return pixelCount ? kept / pixelCount : 0;
}

/**
 * Crop `cropFrac` ({x,y,w,h} as 0..1 fractions) out of srcPngPath, matte the crop, write an
 * alpha PNG to outPath. Returns { ok, outPath, ms, subjectFrac, cached?, reason? }.
 * Degrades gracefully ({ok:false, reason}) when the model/deps are unavailable (e.g. offline
 * before first model load) — callers must keep the rect crop in that case.
 */
export async function matteCutout(srcPngPath, cropFrac, outPath, opts = {}) {
  const t0 = Date.now();
  const fail = (reason, extra = {}) => ({ ok: false, outPath: null, ms: Date.now() - t0, subjectFrac: null, reason, ...extra });
  if (!cropFrac || !(cropFrac.w > 0) || !(cropFrac.h > 0)) return fail('bad crop');

  let srcBuf;
  try { srcBuf = await readFile(srcPngPath); } catch (e) { return fail(`read source: ${e.message}`); }

  const cacheDir = opts.cacheDir || MATTE_CACHE_DIR;
  const key = matteCacheKey(srcBuf, cropFrac);
  const cachePath = join(cacheDir, `${key}.png`);
  try { mkdirSync(cacheDir, { recursive: true }); } catch { /* best effort */ }
  if (existsSync(cachePath) && statSync(cachePath).size > 0) {
    // Cached mattes are only stored when they PASSED thresholds; sidecar json keeps the frac.
    let subjectFrac = null;
    try { subjectFrac = JSON.parse(await readFile(`${cachePath}.json`, 'utf8')).subjectFrac; } catch { /* optional */ }
    try { if (outPath && outPath !== cachePath) copyFileSync(cachePath, outPath); } catch (e) { return fail(`copy cached: ${e.message}`); }
    return { ok: true, outPath: outPath || cachePath, ms: Date.now() - t0, subjectFrac, cached: true };
  }

  let sharp, removeBackground;
  try {
    sharp = (await import('sharp')).default;
    ({ removeBackground } = await import('@imgly/background-removal-node'));
  } catch (e) { return fail(`deps unavailable: ${e.message}`); }

  // Crop the region (fractions → pixels, clamped) — matting the crop, not the full image,
  // keeps the model focused on the intended subject and is ~10x faster on big references.
  let cropBuf, cw, ch;
  try {
    const meta = await sharp(srcBuf).metadata();
    const W = meta.width, H = meta.height;
    const left = Math.max(0, Math.min(W - 1, Math.round(cropFrac.x * W)));
    const top = Math.max(0, Math.min(H - 1, Math.round(cropFrac.y * H)));
    cw = Math.max(1, Math.min(W - left, Math.round(cropFrac.w * W)));
    ch = Math.max(1, Math.min(H - top, Math.round(cropFrac.h * H)));
    cropBuf = await sharp(srcBuf).extract({ left, top, width: cw, height: ch }).png().toBuffer();
  } catch (e) { return fail(`crop: ${e.message}`); }

  // Matte. First call JIT-loads the ~40-80MB isnet model (bundled with the npm package; a
  // custom publicPath may fetch remotely — offline failures land in the catch below).
  if (!_modelLogged) { _modelLogged = true; console.log('[matte] loading background-removal model (first use, ~40-80MB)'); }
  let mattedPng;
  try {
    const blob = new Blob([cropBuf], { type: 'image/png' });
    const out = await removeBackground(blob, { output: { format: 'image/png' }, ...(opts.imgly || {}) });
    mattedPng = Buffer.from(await out.arrayBuffer());
  } catch (e) { return fail(`matte: ${e.message}`); }

  // Clean + judge: the model leaves faint ghost residue (alpha 1-60) over background text —
  // snap it to fully transparent, then measure the kept-pixel fraction.
  let subjectFrac;
  try {
    const { data, info } = await sharp(mattedPng).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    for (let i = 3; i < data.length; i += 4) if (data[i] < 60) data[i] = 0;
    subjectFrac = alphaFraction(data, info.width * info.height);
    mattedPng = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
  } catch (e) { return fail(`inspect: ${e.message}`); }
  if (!judgeSubjectFrac(subjectFrac)) return fail('matte failed thresholds', { subjectFrac });

  try {
    await writeFile(cachePath, mattedPng);
    await writeFile(`${cachePath}.json`, JSON.stringify({ subjectFrac, cropFrac, w: cw, h: ch }));
    if (outPath && outPath !== cachePath) await writeFile(outPath, mattedPng);
  } catch (e) { return fail(`write: ${e.message}`); }
  return { ok: true, outPath: outPath || cachePath, ms: Date.now() - t0, subjectFrac, cached: false };
}

export default { matteCutout, matteCacheKey, judgeSubjectFrac, alphaFraction };
