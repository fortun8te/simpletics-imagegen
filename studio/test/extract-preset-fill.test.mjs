// test/extract-preset-fill.test.mjs — DETECTION → PRESET FILL:
// a synthetic x-post extraction maps its detected name/handle/body/counts onto the x-post-ad
// template's param slots and BUILDS the composed 1:1 preset (grouped), instead of loose layers.
// Also: loose (generic) extractions get GROUPED into named region groups, never a flat pile.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fillPresetFromExtraction, groupLooseLayers } from '../lib/layout-extract.mjs';
import { walkNodes } from '../lib/scene-tree.mjs';

const CANVAS = { w: 1080, h: 1350 };

test('x-post extraction fills the x-post-ad preset with detected copy', () => {
  const raw = { archetype: 'x-post', layers: [
    { type: 'text', role: 'nav', text: 'Post', box: { x: 40, y: 3, w: 20, h: 5 } },
    { type: 'text', role: 'name', text: 'UPFRONT', box: { x: 15, y: 6, w: 30, h: 5 } },
    { type: 'badge', role: 'verified', text: '✔', box: { x: 46, y: 6, w: 4, h: 4 } },
    { type: 'text', role: 'handle', text: '@UpfrontFood', box: { x: 15, y: 11, w: 30, h: 4 } },
    { type: 'text', role: 'headline', text: 'LAATSTE SITE WIDE SALE VAN 2026. Schrijf je nu in en mis geen enkele update.', box: { x: 5, y: 20, w: 90, h: 30 } },
    { type: 'text', role: 'caption', text: '121K views · 257 replies · 66 reposts · 21K likes', box: { x: 5, y: 80, w: 90, h: 5 } },
  ] };

  const filled = fillPresetFromExtraction('x-post', raw, CANVAS, null);
  assert.ok(filled, 'preset fill returned a build');
  assert.equal(filled.templateId, 'x-post-ad');

  // the DETECTED copy landed in the right param slots
  assert.equal(filled.params.name, 'UPFRONT', 'display name mapped');
  assert.equal(filled.params.handle, '@UpfrontFood', 'handle mapped');
  assert.ok(/LAATSTE SITE WIDE SALE/.test(filled.params.body), 'body copy mapped (verbatim)');
  assert.ok(/121K/.test(filled.params.views || ''), 'viewcount mapped');
  assert.equal(filled.params.verified, true, 'verified flag detected');

  // the BUILD is the composed, GROUPED preset — the detected name shows up in the layer tree,
  // and the top level is named groups (Nav/Header/Body), not a flat pile.
  const names = [];
  const texts = [];
  walkNodes(filled.layers, (l) => { if (l.name) names.push(l.name); if (l.text) texts.push(l.text); });
  assert.ok(filled.layers.some((l) => l.type === 'group'), 'preset builds top-level groups');
  assert.ok(texts.includes('UPFRONT'), 'detected name rendered in the comp');
  assert.ok(texts.includes('@UpfrontFood'), 'detected handle rendered in the comp');
});

test('unmapped params fall back to template defaults', () => {
  // a minimal x-post read: only a handle. Everything else must fall back to the preset defaults.
  const raw = { archetype: 'x-post', layers: [
    { type: 'text', role: 'handle', text: '@barelythere', box: { x: 15, y: 11, w: 30, h: 4 } },
  ] };
  const filled = fillPresetFromExtraction('x-post', raw, CANVAS, null);
  assert.ok(filled, 'still builds from defaults');
  assert.equal(filled.params.handle, '@barelythere');
  // body was not detected → not in mapped params → template supplies its own default at build time
  assert.equal('body' in filled.params, false, 'undetected body left for the template default');
  const texts = [];
  walkNodes(filled.layers, (l) => { if (l.text) texts.push(l.text); });
  assert.ok(texts.length >= 4, 'template default body/meta/actions still present');
});

test('a generic archetype does NOT fill a preset', () => {
  assert.equal(fillPresetFromExtraction('generic', { layers: [] }, CANVAS, null), null);
});

test('loose layers group into named region buckets (no flat pile)', () => {
  const flat = [
    { id: 'a', type: 'text', role: 'headline', text: 'BIG SALE', box: { x: 60, y: 40, w: 400, h: 80 } },
    { id: 'b', type: 'badge', role: 'badge', text: 'NEW', box: { x: 60, y: 120, w: 120, h: 50 } },
    { id: 'c', type: 'shape', role: 'product', box: { x: 200, y: 500, w: 400, h: 400 } },
    { id: 'd', type: 'text', role: 'logo', text: 'Brand', box: { x: 60, y: 480, w: 120, h: 40 } },
    { id: 'e', type: 'button', role: 'cta', text: 'SHOP', box: { x: 60, y: 1200, w: 300, h: 90 } },
  ];
  const grouped = groupLooseLayers(flat, CANVAS.h);
  const groups = grouped.filter((n) => n.type === 'group');
  assert.ok(groups.length >= 2, `built named region groups (${groups.map((g) => g.name).join(', ')})`);
  const names = new Set(groups.map((g) => g.name));
  assert.ok(names.has('Header'), 'header region grouped');
  assert.ok(names.has('Product'), 'product region grouped');
  // every original leaf is still reachable in the tree
  let count = 0;
  walkNodes(grouped, (l) => { if (l.type !== 'group') count++; });
  assert.equal(count, flat.length, 'no layers lost in grouping');
});
