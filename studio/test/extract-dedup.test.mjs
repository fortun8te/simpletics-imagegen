// test/extract-dedup.test.mjs — the "same product 40 times" + "text behind elements" fixes:
// spatial de-dup collapses overlapping product reads into ONE union box (outer-edge tracking),
// and toSkeletonLayers emits layers in a sane paint order (text always on top).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dedupeRawLayers, toSkeletonLayers } from '../lib/layout-extract.mjs';

test('overlapping product reads collapse into one union box (outer edges)', () => {
  // five near-identical reads of the same bottle at slightly different boxes — the 40x bug in miniature
  const layers = [
    { type: 'image', role: 'product', text: 'bottle', box: { x: 30, y: 40, w: 40, h: 40 }, color: '#3a7' },
    { type: 'image', role: 'product', box: { x: 32, y: 41, w: 39, h: 41 } },
    { type: 'image', role: 'product', box: { x: 28, y: 38, w: 42, h: 43 } },
    { type: 'image', role: 'product', box: { x: 31, y: 40, w: 41, h: 40 } },
    { type: 'image', role: 'product', box: { x: 30, y: 39, w: 40, h: 42 } },
  ];
  const { layers: out, removed } = dedupeRawLayers(layers);
  assert.equal(out.length, 1, 'five overlapping products collapse to one');
  assert.equal(removed, 4);
  const b = out[0].box;
  // union spans the outer edges of every read: x from 28, right edge to max(70,74,...)
  assert.equal(b.x, 28, 'union left edge');
  assert.equal(b.y, 38, 'union top edge');
  assert.equal(b.x + b.w, Math.max(30 + 40, 32 + 39, 28 + 42, 31 + 41, 30 + 40), 'union right edge');
  assert.equal(out[0].text, 'bottle', 'kept the labelled read');
});

test('distinct products are NOT merged', () => {
  const { layers: out } = dedupeRawLayers([
    { type: 'image', role: 'product', box: { x: 5, y: 5, w: 20, h: 20 } },
    { type: 'image', role: 'product', box: { x: 70, y: 70, w: 20, h: 20 } },
  ]);
  assert.equal(out.length, 2, 'two separate products survive');
});

test('duplicate copy collapses to the stronger layer', () => {
  const { layers: out } = dedupeRawLayers([
    { type: 'text', role: 'headline', text: 'Save 45%', box: { x: 10, y: 10, w: 60, h: 8 } },
    { type: 'text', role: 'headline', text: 'save 45%', box: { x: 11, y: 10, w: 55, h: 8 } },
  ]);
  assert.equal(out.length, 1, 'same headline twice → once');
});

test('paint order: text lands above products and panels', () => {
  const raw = { layers: [
    { type: 'text', role: 'headline', text: 'BUY NOW', box: { x: 10, y: 10, w: 40, h: 8 }, style: { fontSizePct: 5 } },
    { type: 'image', role: 'product', text: 'jar', box: { x: 20, y: 20, w: 40, h: 40 }, color: '#c40' },
    { type: 'shape', role: 'bg', box: { x: 0, y: 0, w: 100, h: 100 }, style: {} },
  ] };
  const out = toSkeletonLayers(raw, { w: 1080, h: 1080 });
  const idx = (pred) => out.findIndex(pred);
  const bgIdx = idx((l) => l.role === 'bg');
  const productIdx = idx((l) => l.role === 'product');
  const textIdx = idx((l) => l.text === 'BUY NOW');
  assert.ok(bgIdx < productIdx, 'background paints before product');
  assert.ok(productIdx < textIdx, 'product paints before its overlay text (text on top)');
});
