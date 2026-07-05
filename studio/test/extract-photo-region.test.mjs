// test/extract-photo-region.test.mjs — Fable's 026-escalation fixes:
// (1) large photo-like regions extracted as type:'shape' (not 'image') now get marked
//     cutoutCandidate via a deterministic pixel texture/entropy signal, so they become a real
//     crop of the reference instead of a synthesized grey slab.
// (2) large card/shape region fill colors are verified against the region's real sampled pixel
//     color and overridden when the model hallucinated a strongly different hex.
// Run: node --test test/extract-photo-region.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { sampleRegionStats, isPhotoLike, toSkeletonLayers } from '../lib/layout-extract.mjs';

/** Write a minimal valid 8-bit RGB PNG of w×h where pixel(x,y) = fill(x,y) -> [r,g,b]. */
function writeRgbPng(path, w, h, fill) {
  const crc32 = (buf) => { let c = ~0; for (let i = 0; i < buf.length; i++) { c ^= buf[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return (~c) >>> 0; };
  const chunk = (type, data) => { const t = Buffer.from(type, 'ascii'); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const [r, g, b] = fill(x, y);
      const p = y * (w * 3 + 1) + 1 + x * 3;
      raw[p] = r & 0xff; raw[p + 1] = g & 0xff; raw[p + 2] = b & 0xff;
    }
  }
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  writeFileSync(path, png);
}

// deterministic pseudo-random (no Math.random — reproducible test)
function prng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

const dir = mkdtempSync(join(tmpdir(), 'extract-photo-'));

test('flat region: low entropy/variance, isPhotoLike() is false', () => {
  const p = join(dir, 'flat.png');
  writeRgbPng(p, 200, 200, () => [0xf1, 0xf3, 0xf5]); // solid light grey, like the real 026 ref
  const stats = sampleRegionStats(p, { x: 0, y: 0, w: 100, h: 100 });
  assert.ok(stats, 'decoded region stats');
  assert.ok(stats.entropy < 1.0, `flat region entropy should be near 0, got ${stats.entropy}`);
  assert.ok(stats.variance < 0.001, `flat region variance should be near 0, got ${stats.variance}`);
  assert.equal(isPhotoLike(stats), false);
  assert.equal(stats.hex.toLowerCase(), '#f1f3f5');
});

test('noisy/textured region: high entropy/variance, isPhotoLike() is true', () => {
  const p = join(dir, 'noisy.png');
  const rand = prng(42);
  writeRgbPng(p, 200, 200, () => {
    const v = Math.floor(rand() * 256);
    return [v, Math.floor(rand() * 256), Math.floor(rand() * 256)];
  });
  const stats = sampleRegionStats(p, { x: 0, y: 0, w: 100, h: 100 });
  assert.ok(stats, 'decoded region stats');
  assert.ok(stats.entropy >= 1.8, `noisy region entropy should be high, got ${stats.entropy}`);
  assert.equal(isPhotoLike(stats), true);
});

test('toSkeletonLayers: a large shape region reading as a real photo gets cutoutCandidate', () => {
  const p = join(dir, 'photo-shape.png');
  const rand = prng(7);
  writeRgbPng(p, 400, 400, (x, y) => {
    // busy top-half "photo", flat bottom-half "bg" so we can also test the flat path below
    if (y < 200) return [Math.floor(rand() * 256), Math.floor(rand() * 256), Math.floor(rand() * 256)];
    return [0x10, 0x10, 0x10];
  });
  const raw = {
    layers: [
      { type: 'shape', role: 'product', text: 'pillow', box: { x: 0, y: 0, w: 100, h: 50 }, style: { color: '#19a5b8' } },
    ],
  };
  const out = toSkeletonLayers(raw, { w: 1080, h: 1080 }, null, { imagePath: p });
  const layer = out.find((l) => l.role === 'product' || /pillow/i.test(l.name || ''));
  assert.ok(layer, 'layer present');
  assert.ok(layer.cutoutCandidate, 'photo-like large shape region got a cutoutCandidate');
  assert.equal(layer.cutoutCandidate.shape, 'rect');
});

test('toSkeletonLayers: a large flat shape region overrides a hallucinated fill color', () => {
  const p = join(dir, 'flat-shape.png');
  writeRgbPng(p, 400, 400, () => [0xf1, 0xf3, 0xf5]); // real color is light grey everywhere
  const raw = {
    layers: [
      // model hallucinated a teal fill for what is actually a flat light-grey region
      { type: 'shape', role: 'card', text: 'panel', box: { x: 0, y: 0, w: 100, h: 100 }, style: { background: '#19a5b8', color: '#19a5b8' } },
    ],
  };
  const out = toSkeletonLayers(raw, { w: 1080, h: 1080 }, null, { imagePath: p });
  const layer = out.find((l) => l.role === 'card');
  assert.ok(layer, 'layer present');
  assert.notEqual(String(layer.style.background || '').toLowerCase(), '#19a5b8', 'hallucinated teal fill overridden');
  assert.ok(!layer.cutoutCandidate, 'flat region is not marked as a photo cutout');
});
