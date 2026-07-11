import test from 'node:test';
import assert from 'node:assert/strict';
import { isWordmarkCandidate, partitionWordmarks } from '../lib/wordmarks.mjs';

const canvas = { w: 1080, h: 1350 };
const line = (id, text, x, y, w, h) => ({ id, text, box: { x, y, w, h } });

test('wordmarks: brand lockups crop instead of becoming font-matched text', () => {
  assert.ok(isWordmarkCandidate(line('hears', 'Hears ♡ Earplugs', 54, 46, 275, 38), canvas));
  assert.ok(isWordmarkCandidate(line('hears-ocr', '• Hears Earplugs', 54, 46, 275, 38), canvas));
  assert.ok(isWordmarkCandidate(line('gruens', 'grüns', 70, 65, 130, 38), canvas));
  assert.ok(isWordmarkCandidate(line('upfront', 'UPFRONT', 390, 60, 220, 38), canvas));
});

test('wordmarks: ordinary header copy and CTAs stay editable text', () => {
  assert.equal(isWordmarkCandidate(line('headline', 'THE SLEEP YOU DESERVE', 52, 85, 700, 76), canvas), false);
  assert.equal(isWordmarkCandidate(line('cta', 'SHOP NOW', 60, 60, 150, 32), canvas), false);
  assert.equal(isWordmarkCandidate(line('body', 'Earplugs designed for deep sleep.', 56, 260, 530, 32), canvas), false);
});

test('wordmarks: partition preserves the whole heart lockup', () => {
  const out = partitionWordmarks([
    line('brand', 'Hears ♡ Earplugs', 54, 46, 275, 38),
    line('head', 'SLEEP DEEPER', 54, 200, 500, 80),
  ], canvas);
  assert.deepEqual(out.wordmarks.map((x) => x.id), ['brand']);
  assert.deepEqual(out.text.map((x) => x.id), ['head']);
});
