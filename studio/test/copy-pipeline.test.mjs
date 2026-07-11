// test/copy-pipeline.test.mjs — fast pure-helper unit tests for the copy pipeline.
// No Chrome, no model, no image decode: z-order, name formatting, keptInPhoto bookkeeping.
//
//   node --test test/copy-pipeline.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { rgbToHex, zRankForRole, formatLayerName, partitionKeptInPhoto, reconcileFontFamilies, accentStrokeBox } from '../lib/copy-pipeline.mjs';

test('rgbToHex clamps + pads', () => {
  assert.equal(rgbToHex([0, 0, 0]), '#000000');
  assert.equal(rgbToHex([255, 255, 255]), '#ffffff');
  assert.equal(rgbToHex([300, -5, 16]), '#ff0010');
  assert.equal(rgbToHex([13, 13, 13]), '#0d0d0d');
});

test('z-order: base < cutout < shape < text < badge', () => {
  assert.ok(zRankForRole('base') < zRankForRole('product'));
  assert.ok(zRankForRole('product') < zRankForRole('icon'));
  assert.ok(zRankForRole('icon') < zRankForRole('headline')); // headline → default text rank
  assert.ok(zRankForRole('headline') < zRankForRole('badge'));
  assert.equal(zRankForRole('base'), 0);
});

test('formatLayerName produces semantic names', () => {
  assert.equal(formatLayerName('text', { role: 'headline', text: 'THE 10 SECOND PARTY UPGRADE' }), 'Headline — "THE 10 SECOND PART…"');
  assert.equal(formatLayerName('text', { role: 'headline', text: 'PARTY' }), 'Headline — "PARTY"');
  assert.equal(formatLayerName('image', { role: 'product', label: 'cutout' }), 'Product — cutout');
  assert.equal(formatLayerName('shape', { role: 'badge', label: '45% Off' }), 'Badge — 45% Off');
});

test('partitionKeptInPhoto: scene → kept, overlay → layers, ambiguous defaults overlay', () => {
  const lines = [
    { id: 'a', text: 'How I get ALL my nutrients' },
    { id: 'b', text: 'grüns' },
    { id: 'c', text: 'ingredients: kale, spinach' },
    { id: 'd', text: 'maybe' },
  ];
  const origins = { lines: [
    { id: 'a', origin: 'overlay' },
    { id: 'b', origin: 'scene' },
    { id: 'c', origin: 'scene' },
    { id: 'd', origin: 'ambiguous' },
  ] };
  const { overlay, keptInPhoto } = partitionKeptInPhoto(lines, origins);
  assert.deepEqual(keptInPhoto, ['grüns', 'ingredients: kale, spinach']);
  assert.deepEqual(overlay.map((l) => l.id), ['a', 'd']); // ambiguous kept as overlay
  assert.ok(!keptInPhoto.includes('grüns'.toUpperCase())); // exact string preserved
});

test('partitionKeptInPhoto: ambiguous → kept when keepAmbiguousAsOverlay=false', () => {
  const lines = [{ id: 'x', text: 'Nutrition Facts' }];
  const origins = { lines: [{ id: 'x', origin: 'ambiguous' }] };
  const { overlay, keptInPhoto } = partitionKeptInPhoto(lines, origins, { keepAmbiguousAsOverlay: false });
  assert.equal(overlay.length, 0);
  assert.deepEqual(keptInPhoto, ['Nutrition Facts']);
});

test('partitionKeptInPhoto: missing origin defaults to overlay', () => {
  const lines = [{ id: 'z', text: 'Buy now' }];
  const { overlay, keptInPhoto } = partitionKeptInPhoto(lines, { lines: [] });
  assert.equal(overlay.length, 1);
  assert.equal(keptInPhoto.length, 0);
});

test('reconcileFontFamilies: sibling labels vote together without flattening a distinct headline', () => {
  const item = (id, y, fs, matches) => ({ block: { id, box: { y, h: fs }, _fontSize: fs, _weight: 500 }, matches, family: matches[0].family });
  const blocks = [
    item('a', 200, 20, [{ family: 'Inter', score: 0.72 }, { family: 'DM Sans', score: 0.70 }]),
    item('b', 203, 20, [{ family: 'DM Sans', score: 0.71 }, { family: 'Inter', score: 0.70 }]),
    item('c', 206, 20, [{ family: 'DM Sans', score: 0.74 }, { family: 'Inter', score: 0.69 }]),
    item('head', 50, 58, [{ family: 'Archivo Black', score: 0.90 }, { family: 'Inter', score: 0.40 }]),
  ];
  reconcileFontFamilies(blocks);
  assert.deepEqual(blocks.slice(0, 3).map((x) => x.family), ['DM Sans', 'DM Sans', 'DM Sans']);
  assert.equal(blocks[3].family, 'Archivo Black');
});

test('accentStrokeBox finds a saturated decorative underline, not a blank headline region', () => {
  const data = Buffer.alloc(100 * 60 * 4, 240);
  for (let y = 42; y < 45; y++) for (let x = 25; x < 75; x++) {
    const i = (y * 100 + x) * 4; data[i] = 40; data[i + 1] = 180; data[i + 2] = 90; data[i + 3] = 255;
  }
  const hit = accentStrokeBox({ data, width: 100, height: 60 }, { x: 0, y: 0, w: 100, h: 45 });
  assert.ok(hit && hit.w >= 50 && hit.h >= 2);
  assert.equal(accentStrokeBox({ data: Buffer.alloc(100 * 60 * 4, 240), width: 100, height: 60 }, { x: 0, y: 0, w: 100, h: 45 }), null);
});
