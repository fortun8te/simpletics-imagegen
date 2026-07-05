// test/matte.test.mjs — cache-hash behavior, failed-matte thresholds, offline degrade.
// Model-dependent paths are skipped when the imgly deps/model are unavailable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  matteCutout, matteCacheKey, judgeSubjectFrac, alphaFraction,
  MATTE_MAX_SUBJECT_FRAC, MATTE_MIN_SUBJECT_FRAC,
} from '../lib/matte.mjs';

let sharpAvailable = true;
let modelAvailable = true;
try { await import('sharp'); await import('@imgly/background-removal-node'); } catch { sharpAvailable = modelAvailable = false; }

const tmp = () => mkdtempSync(join(tmpdir(), 'matte-test-'));

test('matteCacheKey: stable for same content+crop, differs on either change', () => {
  const buf = Buffer.from('fake png bytes');
  const crop = { x: 0.1, y: 0.2, w: 0.3, h: 0.4 };
  assert.equal(matteCacheKey(buf, crop), matteCacheKey(buf, { ...crop }));
  assert.notEqual(matteCacheKey(buf, crop), matteCacheKey(buf, { ...crop, w: 0.31 }));
  assert.notEqual(matteCacheKey(buf, crop), matteCacheKey(Buffer.from('other bytes'), crop));
  assert.match(matteCacheKey(buf, crop), /^[0-9a-f]{24}$/);
});

test('judgeSubjectFrac: thresholds — >92% or <8% kept is a FAILED matte', () => {
  assert.equal(judgeSubjectFrac(0.5), true);
  assert.equal(judgeSubjectFrac(MATTE_MIN_SUBJECT_FRAC), true);
  assert.equal(judgeSubjectFrac(MATTE_MAX_SUBJECT_FRAC), true);
  assert.equal(judgeSubjectFrac(0.95), false); // kept nearly everything — no separation
  assert.equal(judgeSubjectFrac(0.05), false); // kept nearly nothing — no subject found
  assert.equal(judgeSubjectFrac(0), false);
  assert.equal(judgeSubjectFrac(1), false);
});

test('alphaFraction: counts alpha>0.5 pixels', () => {
  // 4 RGBA pixels: alpha 255, 200, 127, 0 → 2 of 4 pass the >127 bar.
  const rgba = Buffer.from([0,0,0,255, 0,0,0,200, 0,0,0,127, 0,0,0,0]);
  assert.equal(alphaFraction(rgba, 4), 0.5);
});

test('degrade: missing source file → {ok:false}, never throws', async () => {
  const r = await matteCutout('/nonexistent/source.png', { x: 0, y: 0, w: 1, h: 1 }, join(tmp(), 'out.png'), { cacheDir: tmp() });
  assert.equal(r.ok, false);
  assert.match(r.reason, /read source/);
});

test('degrade: bad crop rect → {ok:false}', async () => {
  const r = await matteCutout('/whatever.png', { x: 0, y: 0, w: 0, h: 0 }, null);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bad crop');
});

test('degrade: corrupt image with deps present → {ok:false} at crop step', { skip: !sharpAvailable }, async () => {
  const dir = tmp();
  const src = join(dir, 'notpng.png');
  writeFileSync(src, 'this is not a png');
  const r = await matteCutout(src, { x: 0, y: 0, w: 1, h: 1 }, join(dir, 'out.png'), { cacheDir: dir });
  assert.equal(r.ok, false);
  assert.match(r.reason, /crop|matte|deps/);
});

test('cache: second call with same content+crop is a hit and copies to outPath', { skip: !modelAvailable }, async (t) => {
  // Tiny synthetic image: dark square subject on white — model may or may not pass thresholds;
  // if the matte fails we can't exercise the cache path, so skip dynamically.
  const sharp = (await import('sharp')).default;
  const dir = tmp();
  const src = join(dir, 'src.png');
  const subject = await sharp({ create: { width: 60, height: 60, channels: 3, background: { r: 20, g: 30, b: 40 } } }).png().toBuffer();
  await sharp({ create: { width: 128, height: 128, channels: 3, background: { r: 255, g: 255, b: 255 } } })
    .composite([{ input: subject, left: 34, top: 34 }]).png().toFile(src);
  const crop = { x: 0, y: 0, w: 1, h: 1 };
  const out1 = join(dir, 'a.png'), out2 = join(dir, 'b.png');
  const r1 = await matteCutout(src, crop, out1, { cacheDir: dir });
  if (!r1.ok) { t.skip(`model produced failed matte on synthetic image (${r1.reason})`); return; }
  assert.equal(r1.cached, false);
  assert.ok(existsSync(out1));
  const r2 = await matteCutout(src, crop, out2, { cacheDir: dir });
  assert.equal(r2.ok, true);
  assert.equal(r2.cached, true);
  assert.equal(r2.subjectFrac, r1.subjectFrac); // sidecar json preserved the frac
  assert.deepEqual(readFileSync(out1), readFileSync(out2));
  assert.ok(r2.ms <= r1.ms); // cache hit must not be slower than the full matte
});
