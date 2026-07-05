// test/font-match.test.mjs — silhouette font matching (lib/font-match.mjs).
//
// The end-to-end test is SYNTHETIC and self-grounding: render a known-Georgia headline through
// the real export renderer (renderCompPng), then ask matchFont — with no fontFamily hint — which
// family reproduces that crop. It must pick Georgia over the base sans. Skips gracefully when no
// headless render backend (Chrome/qlmanage) is available on the machine running the suite.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  matchFont,
  availableCandidates,
  fontInstalled,
  silhouetteScore,
  DEFAULT_CANDIDATES,
  DEFAULT_MIN_CONFIDENCE,
} from '../lib/font-match.mjs';
import { renderCompPng } from '../lib/self-vision.mjs';

test('candidate pool: base sans always present, list is a filtered subset', () => {
  const avail = availableCandidates();
  assert.ok(Array.isArray(avail));
  assert.ok(avail.includes(''), "base grotesk '' must always be available");
  for (const f of avail) assert.ok(DEFAULT_CANDIDATES.includes(f));
  assert.equal(fontInstalled(''), true);
  // a font that certainly does not exist is dropped when the installed list is readable
  const withFake = availableCandidates(['', 'Georgia', 'Definitely Not A Real Font 9000']);
  assert.ok(withFake.includes(''));
  assert.ok(!withFake.includes('Definitely Not A Real Font 9000') || withFake.length === 3,
    'fake font must be dropped unless the installed-font list was unreadable');
});

test('silhouetteScore: identical crops = 1, inverted crops strongly negative, flat crop = 0', () => {
  const w = 60, h = 24;
  const a = { width: w, height: h, gray: new Float32Array(w * h).fill(0.9) };
  for (let y = 6; y < 18; y++) for (let x = 10; x < 30; x++) a.gray[y * w + x] = 0.1; // fake glyph mass
  const inv = { width: w, height: h, gray: Float32Array.from(a.gray, (v) => 1 - v) };
  const flat = { width: w, height: h, gray: new Float32Array(w * h).fill(0.5) };
  assert.ok(silhouetteScore(a, a) > 0.999);
  // the ±2-cell shift search takes the MAX, so an inversion lands well below 0 but not at −1
  assert.ok(silhouetteScore(a, inv) < -0.25);
  assert.equal(silhouetteScore(a, flat), 0);
});

test('matchFont: unreadable reference fails soft', async () => {
  const res = await matchFont('/nonexistent/ref.png', {
    text: 'Hello', box: { x: 0, y: 0, w: 100, h: 40 }, style: { fontSize: 24 },
  }, { w: 200, h: 200 });
  assert.equal(res.fontFamily, null);
  assert.equal(res.confidence, 0);
  assert.deepEqual(res.tried, []);
  assert.ok(res.error);
});

test('e2e synthetic: picks Georgia over base sans on a Georgia-rendered headline', async (t) => {
  const canvas = { w: 900, h: 420 };
  const box = { x: 40, y: 110, w: 820, h: 200 };
  const style = { fontSize: 62, fontWeight: 600, color: '#1a1a1a', align: 'center', lineHeight: 1.2 };
  const refDoc = {
    id: 'font-match-test-ref',
    name: 'font-match synthetic reference',
    canvas,
    layers: [
      { id: 'bg', type: 'shape', role: 'base', box: { x: 0, y: 0, w: canvas.w, h: canvas.h }, style: { background: '#f2efe8' } },
      { id: 'headline', type: 'text', role: 'headline', text: 'Perfect curls without the damage', box, style: { ...style, fontFamily: 'Georgia' } },
    ],
  };
  const refPng = renderCompPng(refDoc);
  if (!refPng) {
    t.skip('no headless render backend (Chrome/qlmanage) available');
    return;
  }
  // no fontFamily hint on the probe layer — matchFont must recover it from silhouettes alone
  const layer = { id: 'headline', type: 'text', role: 'headline', text: 'Perfect curls without the damage', box, style };
  const res = await matchFont(refPng, layer, canvas, { candidates: ['', 'Georgia', 'Impact'] });
  assert.ok(res.tried.length >= 2, `needs at least 2 scored candidates, got ${JSON.stringify(res)}`);
  assert.equal(res.tried[0].family, 'Georgia',
    `Georgia must out-score the base sans: ${JSON.stringify(res.tried)}`);
  assert.equal(res.fontFamily, 'Georgia');
  assert.ok(res.confidence >= DEFAULT_MIN_CONFIDENCE,
    `confidence ${res.confidence} must clear the threshold ${DEFAULT_MIN_CONFIDENCE}`);
});
