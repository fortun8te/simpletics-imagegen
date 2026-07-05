// test/refine-loop.test.mjs — synthetic end-to-end tests for the self-improving refine loop.
//
// No Chrome, no model calls: docs are rasterized with a tiny pure-JS renderer (rect fills +
// minimal PNG encoder), the reference is the render of a "truth" doc, and the broken doc has
// one layer deliberately offset 20px and wrong-colored. refineLoop must recover ≥ half the diff.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

import { refineLoop, leavesOf, cellsForBox, worstCells } from '../lib/refine-loop.mjs';
import { pixelDiff, readPng, downsampleGray } from '../scripts/pixel-diff.mjs';

// ── minimal PNG writer (8-bit truecolor, filter 0 — exactly what pixel-diff's readPng decodes) ──
function crc32(buf) {
  if (!crc32.table) {
    crc32.table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crc32.table[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = crc32.table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function writePngRgb(path, w, h, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; // bitDepth 8, colorType 2 (truecolor)
  const stride = w * 3;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  writeFileSync(path, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]));
}

// ── tiny doc rasterizer: white canvas, leaves painted in order as solid-fill boxes ──────────────
const hex = (s) => {
  const m = /^#([0-9a-f]{6})$/i.exec(s || '');
  return m ? [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) : [153, 153, 153]; // images → gray
};
function rasterize(doc, path) {
  const { w, h } = doc.canvas;
  const rgb = Buffer.alloc(w * h * 3, 255);
  for (const leaf of leavesOf(doc.layers)) {
    const b = leaf.box;
    if (!b) continue;
    const [r, g, bl] = leaf.type === 'image' ? [153, 153, 153] : hex(leaf.style?.background || leaf.style?.color);
    const x0 = Math.max(0, Math.round(b.x)), x1 = Math.min(w, Math.round(b.x + b.w));
    const y0 = Math.max(0, Math.round(b.y)), y1 = Math.min(h, Math.round(b.y + b.h));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const p = (y * w + x) * 3;
        rgb[p] = r; rgb[p + 1] = g; rgb[p + 2] = bl;
      }
    }
  }
  writePngRgb(path, w, h, rgb);
  return path;
}

const W = 640, H = 640;
function truthDoc() {
  return {
    id: 'refine-truth', canvas: { w: W, h: H },
    layers: [
      { id: 'hero', type: 'shape', role: 'card', box: { x: 160, y: 160, w: 200, h: 200 }, style: { background: '#202020' } },
      { id: 'photo', type: 'image', role: 'media', box: { x: 440, y: 440, w: 120, h: 120 }, style: { crop: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 } }, src: '/refasset?id=x' },
      { id: 'label', type: 'text', role: 'caption', text: 'HELLO', box: { x: 440, y: 80, w: 120, h: 40 }, style: { background: '#303030', fontSize: 32, color: '#303030' } },
    ],
  };
}

function makeHarness(dir, refPath) {
  let n = 0;
  return {
    renderFn: (d) => rasterize(d, join(dir, `render-${++n}.png`)),
    scoreFn: (p) => { const r = pixelDiff(refPath, p, { grid: 64 }); return r.ok ? r.score : null; },
  };
}

test('refineLoop recovers >= half the diff of an offset + wrong-colored layer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'refine-loop-'));
  const refPath = rasterize(truthDoc(), join(dir, 'reference.png'));

  // broken: hero shifted +20px in x and much too light
  const broken = truthDoc();
  broken.id = 'refine-broken';
  broken.layers[0].box.x += 20;
  broken.layers[0].style.background = '#909090';

  const { renderFn, scoreFn } = makeHarness(dir, refPath);
  const scoreBefore = scoreFn(renderFn(broken));
  assert.ok(scoreBefore < 100, 'broken doc must not already be perfect');

  const t0 = Date.now();
  const res = await refineLoop(broken, refPath, { maxRounds: 3, renderFn, scoreFn, maxRenders: 30 });
  assert.equal(res.ok, true, res.error || 'refineLoop failed');
  assert.equal(res.scoreBefore, scoreBefore);

  // improved, and recovered at least half of the distance to a perfect score
  assert.ok(res.scoreAfter > res.scoreBefore, `score must improve (${res.scoreBefore} → ${res.scoreAfter})`);
  const recovered = (res.scoreAfter - res.scoreBefore) / (100 - res.scoreBefore);
  assert.ok(recovered >= 0.5, `recovered ${(recovered * 100).toFixed(0)}% of the diff — need >= 50% (${res.scoreBefore} → ${res.scoreAfter})`);

  // corrections are concrete geometry/color ops on the offender layer
  assert.ok(res.applied.length >= 1, 'must report applied corrections');
  assert.ok(res.applied.every((a) => ['nudge', 'font', 'color'].includes(a.kind)), 'only nudge/font/color corrections exist');
  assert.ok(res.applied.some((a) => a.layerId === 'hero'), 'the offset layer must be among the corrected ones');

  // hard safety rules: text content and media crops are NEVER touched
  const keptLeaves = leavesOf(res.keptDoc.layers);
  assert.equal(keptLeaves.find((l) => l.id === 'label').text, 'HELLO');
  assert.deepEqual(keptLeaves.find((l) => l.id === 'photo').style.crop, { x: 0.1, y: 0.1, w: 0.5, h: 0.5 });
  assert.equal(keptLeaves.find((l) => l.id === 'photo').src, '/refasset?id=x');

  // budget accounting is real
  assert.ok(res.renders <= 30, `render count tracked (${res.renders})`);
  assert.ok(Date.now() - t0 < 45_000, 'synthetic loop stays far under the wall budget');

  // input doc was not mutated (keptDoc is a copy)
  assert.equal(broken.layers[0].style.background, '#909090');
  assert.equal(broken.layers[0].box.x, 180);
});

test('refineLoop returns an unchanged doc after 1 round when there is nothing to improve', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'refine-loop-noop-'));
  const refPath = rasterize(truthDoc(), join(dir, 'reference.png'));
  const doc = truthDoc(); // identical to the reference
  const { renderFn, scoreFn } = makeHarness(dir, refPath);

  const res = await refineLoop(doc, refPath, { maxRounds: 3, renderFn, scoreFn });
  assert.equal(res.ok, true, res.error || 'refineLoop failed');
  assert.equal(res.rounds, 1, 'stops after a single look');
  assert.deepEqual(res.applied, []);
  assert.deepEqual(res.keptDoc, doc, 'doc returned unchanged');
  assert.equal(res.scoreAfter, res.scoreBefore);
  assert.equal(res.renders, 1, 'only the base render is spent');
  assert.equal(res.bestRenderPath, null);
});

test('refineLoop respects the render budget and reports capping', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'refine-loop-cap-'));
  const refPath = rasterize(truthDoc(), join(dir, 'reference.png'));
  const broken = truthDoc();
  broken.layers[0].box.x += 20;
  broken.layers[0].style.background = '#909090';
  const { renderFn, scoreFn } = makeHarness(dir, refPath);

  const res = await refineLoop(broken, refPath, { maxRounds: 3, renderFn, scoreFn, maxRenders: 3 });
  assert.equal(res.ok, true);
  assert.ok(res.renders <= 3, `budget respected (${res.renders} renders)`);
  assert.equal(res.capped, 'renders');
});

test('comparator internals: worst cells land on the offset layer region', () => {
  const dir = mkdtempSync(join(tmpdir(), 'refine-loop-cells-'));
  const refPath = rasterize(truthDoc(), join(dir, 'reference.png'));
  const broken = truthDoc();
  broken.layers[0].box.x += 20;
  broken.layers[0].style.background = '#909090';
  const brokenPath = rasterize(broken, join(dir, 'broken.png'));

  const grid = 64;
  const refG = downsampleGray(readPng(refPath), grid, grid);
  const renG = downsampleGray(readPng(brokenPath), grid, grid);
  const worst = worstCells(refG, renG, grid, 16, 0.05);
  assert.ok(worst.length > 0, 'diff cells found');
  const r = cellsForBox(broken.layers[0].box, broken.canvas, grid, 1);
  assert.ok(
    worst.every((c) => c.gx >= r.x0 - 2 && c.gx <= r.x1 + 2 && c.gy >= r.y0 - 2 && c.gy <= r.y1 + 2),
    'all worst cells cluster on the broken layer',
  );
});
