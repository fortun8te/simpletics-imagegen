// test/matte-v2.test.mjs — ONNX matte v2 (BEN2 / BiRefNet-lite): pure helpers, graceful
// degrade, and (only when a model file is present in .state/models/) one end-to-end matte.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  matteCutoutV2, matteV2CacheKey, modelAvailable, mapToAlpha, toTensorData,
  fp16BitsToFloat32, alphaFraction, BACKENDS,
} from '../lib/matte-v2.mjs';

let sharpAvailable = true;
let ortAvailable = true;
try { await import('sharp'); } catch { sharpAvailable = false; }
try { await import('onnxruntime-node'); } catch { ortAvailable = false; }

const tmp = () => mkdtempSync(join(tmpdir(), 'matte-v2-test-'));

test('matteV2CacheKey: stable per content+crop+backend, differs across backends', () => {
  const buf = Buffer.from('fake png bytes');
  const crop = { x: 0.1, y: 0.2, w: 0.3, h: 0.4 };
  assert.equal(matteV2CacheKey(buf, crop, 'ben2'), matteV2CacheKey(buf, { ...crop }, 'ben2'));
  assert.notEqual(matteV2CacheKey(buf, crop, 'ben2'), matteV2CacheKey(buf, crop, 'birefnet'));
  assert.notEqual(matteV2CacheKey(buf, crop, 'ben2'), matteV2CacheKey(buf, { ...crop, w: 0.31 }, 'ben2'));
  assert.match(matteV2CacheKey(buf, crop, 'ben2'), /^[0-9a-f]{24}$/);
});

test('fp16BitsToFloat32: decodes IEEE-754 half bit patterns', () => {
  const out = fp16BitsToFloat32(Uint16Array.from([0x0000, 0x3C00, 0xC000, 0x3800, 0x7C00]));
  assert.equal(out[0], 0);      // +0
  assert.equal(out[1], 1);      // 1.0
  assert.equal(out[2], -2);     // -2.0
  assert.equal(out[3], 0.5);    // 0.5
  assert.equal(out[4], Infinity);
});

test('mapToAlpha: sigmoid maps logits, minmax stretches to full range', () => {
  const sig = mapToAlpha(Float32Array.from([-20, 0, 20]), 'sigmoid');
  assert.equal(sig[0], 0); assert.ok(Math.abs(sig[1] - 127.5) <= 0.5); assert.equal(sig[2], 255);
  const mm = mapToAlpha(Float32Array.from([0.2, 0.45, 0.7]), 'minmax');
  assert.equal(mm[0], 0); assert.ok(Math.abs(mm[1] - 127.5) <= 0.5); assert.equal(mm[2], 255);
  // constant map must not divide by zero
  const flat = mapToAlpha(Float32Array.from([0.3, 0.3]), 'minmax');
  assert.equal(flat[0], 0);
});

test('toTensorData: NCHW layout, optional ImageNet normalization', () => {
  // exercised via a 1024x1024 solid mid-grey plane (helper is fixed to MODEL_SIZE)
  const px = 1024 * 1024;
  const rgb = new Uint8Array(px * 3).fill(128);
  const plain = toTensorData(rgb, false);
  assert.equal(plain.length, 3 * px);
  assert.ok(Math.abs(plain[0] - 128 / 255) < 1e-6);          // R plane first
  assert.ok(Math.abs(plain[2 * px] - 128 / 255) < 1e-6);     // B plane offset
  const norm = toTensorData(rgb, true);
  assert.ok(Math.abs(norm[0] - (128 / 255 - 0.485) / 0.229) < 1e-5);
});

test('alphaFraction counts alpha>127 pixels', () => {
  const rgba = Buffer.from([0, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 200, 0, 0, 0, 100]);
  assert.equal(alphaFraction(rgba, 4), 0.5);
});

test('matteCutoutV2: degrades gracefully on bad inputs', async () => {
  const dir = tmp();
  let r = await matteCutoutV2(join(dir, 'nope.png'), { x: 0, y: 0, w: 1, h: 1 }, join(dir, 'o.png'), { cacheDir: dir });
  assert.equal(r.ok, false);
  assert.match(r.reason, /read source/);
  r = await matteCutoutV2(join(dir, 'nope.png'), { x: 0, y: 0, w: 0, h: 0 }, join(dir, 'o.png'), { cacheDir: dir });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bad crop');
  r = await matteCutoutV2(join(dir, 'nope.png'), { x: 0, y: 0, w: 1, h: 1 }, join(dir, 'o.png'), { cacheDir: dir, backend: 'nonsense' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /unknown backend/);
});

test('matteCutoutV2: missing model file reports reason, keeps ok:false', { skip: !sharpAvailable }, async () => {
  const sharp = (await import('sharp')).default;
  const dir = tmp();
  const src = join(dir, 'src.png');
  await sharp({ create: { width: 32, height: 32, channels: 3, background: '#fff' } }).png().toFile(src);
  const r = await matteCutoutV2(src, { x: 0, y: 0, w: 1, h: 1 }, join(dir, 'o.png'),
    { cacheDir: dir, backend: 'ben2', modelPath: join(dir, 'missing.onnx') });
  assert.equal(r.ok, false);
  assert.match(r.reason, /model missing/);
});

// End-to-end: only when a downloaded model is actually on disk (see matte-v2.mjs header).
for (const backend of Object.keys(BACKENDS)) {
  const available = sharpAvailable && ortAvailable && modelAvailable(backend);
  test(`matteCutoutV2 e2e (${backend}): mattes a salient disc, excludes soft shadow`,
    { skip: !available && `model ${backend} not downloaded` }, async () => {
      const sharp = (await import('sharp')).default;
      const dir = tmp();
      const src = join(dir, 'disc.png');
      const svg = Buffer.from('<svg width="256" height="256" xmlns="http://www.w3.org/2000/svg">'
        + '<rect width="256" height="256" fill="#f5f5f0"/>'
        + '<circle cx="128" cy="140" r="70" fill="#c0182b"/>'
        + '<ellipse cx="128" cy="215" rx="60" ry="10" fill="#00000022"/></svg>');
      await sharp(svg).png().toFile(src);
      const out = join(dir, 'out.png');
      const r = await matteCutoutV2(src, { x: 0, y: 0, w: 1, h: 1 }, out, { backend, cacheDir: dir });
      assert.equal(r.ok, true, `matte failed: ${r.reason}`);
      // disc is ~23.5% of the frame; accept a generous band, reject keep-everything mattes
      assert.ok(r.subjectFrac > 0.1 && r.subjectFrac < 0.6, `subjectFrac ${r.subjectFrac}`);
      assert.ok(r.solidity > 0.8, `solidity ${r.solidity}`);
      // cache round-trip
      const r2 = await matteCutoutV2(src, { x: 0, y: 0, w: 1, h: 1 }, out, { backend, cacheDir: dir });
      assert.equal(r2.cached, true);
    });
}
