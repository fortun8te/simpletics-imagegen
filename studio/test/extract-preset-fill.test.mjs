// test/extract-preset-fill.test.mjs — DETECTION → PRESET FILL:
// a synthetic x-post extraction maps its detected name/handle/body/counts onto the x-post-ad
// template's param slots and BUILDS the composed 1:1 preset (grouped), instead of loose layers.
// Also: loose (generic) extractions get GROUPED into named region groups, never a flat pile.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fillPresetFromExtraction, groupLooseLayers, presetGeometryMatch, toSkeletonLayers } from '../lib/layout-extract.mjs';
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

test('preset geometry gate: a standard-arrangement x-post MATCHES its filled preset', () => {
  // The synthetic x-post above places name/handle/body where the x-post template also puts them.
  const raw = { archetype: 'x-post', layers: [
    { type: 'text', role: 'name', text: 'UPFRONT', box: { x: 15, y: 6, w: 30, h: 5 } },
    { type: 'text', role: 'handle', text: '@UpfrontFood', box: { x: 15, y: 11, w: 30, h: 4 } },
    { type: 'text', role: 'headline', text: 'A totally normal announcement about our sale today.', box: { x: 5, y: 22, w: 90, h: 24 } },
    { type: 'text', role: 'caption', text: '121K views · 257 replies', box: { x: 5, y: 82, w: 90, h: 5 } },
  ] };
  const filled = fillPresetFromExtraction('x-post', raw, CANVAS, null);
  const gm = presetGeometryMatch(raw, filled.layers, CANVAS);
  assert.equal(gm.match, true, `standard x-post should match its preset slots (drift ${gm.meanDist})`);
});

test('preset geometry gate: a REARRANGED layout does NOT match (keep true geometry)', () => {
  // Same archetype/copy, but everything shoved into the bottom-right quadrant — a rearranged native
  // ad, not the canonical x-post grid. The gate must reject the snap.
  const raw = { archetype: 'x-post', layers: [
    { type: 'text', role: 'name', text: 'UPFRONT', box: { x: 60, y: 70, w: 30, h: 5 } },
    { type: 'text', role: 'handle', text: '@UpfrontFood', box: { x: 60, y: 76, w: 30, h: 4 } },
    { type: 'text', role: 'headline', text: 'A wildly repositioned headline down here.', box: { x: 55, y: 82, w: 40, h: 12 } },
    { type: 'text', role: 'caption', text: '121K views', box: { x: 60, y: 95, w: 30, h: 4 } },
  ] };
  const filled = fillPresetFromExtraction('x-post', raw, CANVAS, null);
  const gm = presetGeometryMatch(raw, filled.layers, CANVAS);
  assert.equal(gm.match, false, `rearranged layout should NOT match the preset (drift ${gm.meanDist})`);
});

test('preset geometry gate: a big shape/card photo region with no comparable preset slot forces the loose path (ad 026)', () => {
  // 026-class: the model read a giant half-canvas pillow photo as two `shape/card` regions
  // ("Left half"/"Right half") — not `type:'image'` — and only ONE short text layer ("Silk").
  // With <2 text layers the geometry gate used to short-circuit to "trust the preset" WITHOUT
  // running the photo-slot check at all; the comparison template's small packshot slots also
  // happened to sit near the same columns, so even the size-agnostic photo check would have
  // falsely "matched" a 50%-of-canvas photo against a ~16%-of-canvas packshot slot by proximity
  // alone. Both are fixed: bigPhotoMismatch runs on the sparse-text path, and it now requires the
  // matching slot to be comparably SIZED (>=50% of the extracted region's area), not just nearby.
  const CANVAS_2 = { w: 1080, h: 1920 };
  const raw = { archetype: 'comparison', layers: [
    { type: 'shape', role: 'card', name: 'Left half', box: { x: 0, y: 0, w: 50, h: 100 }, style: { background: '#ffffff' } },
    { type: 'shape', role: 'card', name: 'Right half', box: { x: 50, y: 0, w: 50, h: 100 }, style: { background: '#19a5b8' } },
    { type: 'text', role: 'headline', text: 'Silk', box: { x: 44, y: 4, w: 12, h: 3.4 } },
  ] };
  const filled = fillPresetFromExtraction('comparison', raw, CANVAS_2, null);
  assert.ok(filled, 'preset build succeeds');
  const gm = presetGeometryMatch(raw, filled.layers, CANVAS_2);
  assert.equal(gm.pairs, 0, 'too few text layers to score signals A/B (sparse-text path)');
  assert.equal(gm.photoMismatch, true, 'big photo-ish region has no comparably-sized preset slot');
  assert.equal(gm.match, false, 'the gate rejects the preset snap — loose path takes over');
});

test('font signals survive from raw read into the skeleton (fidelity)', () => {
  // serif → Georgia, platform ios → SF (-apple-system), twitter → base (undefined), mono → Menlo.
  const raw = { layers: [
    { type: 'text', role: 'headline', text: 'Editorial', box: { x: 10, y: 10, w: 60, h: 8 }, style: { serif: true, fontSizePct: 6 } },
    { type: 'text', role: 'caption', text: 'Notes body', box: { x: 10, y: 30, w: 60, h: 6 }, style: { platform: 'ios' } },
    { type: 'text', role: 'name', text: 'Tweeter', box: { x: 10, y: 50, w: 40, h: 5 }, style: { platform: 'twitter' } },
    { type: 'text', role: 'price', text: 'CODE10', box: { x: 10, y: 70, w: 40, h: 5 }, style: { mono: true } },
  ] };
  const out = toSkeletonLayers(raw, { w: 1080, h: 1080 });
  const byText = (t) => out.find((l) => l.text === t);
  assert.equal(byText('Editorial').style.fontFamily, 'Georgia', 'serif → Georgia (single token)');
  assert.equal(byText('Editorial').style.serif, true, 'serif boolean carried through');
  assert.equal(byText('Notes body').style.fontFamily, '-apple-system', 'ios → SF stack single token');
  assert.equal(byText('Tweeter').style.fontFamily, undefined, 'twitter → base grotesk (unset family)');
  assert.equal(byText('CODE10').style.fontFamily, 'Menlo', 'mono → Menlo');
  // none of these are comma-lists (which the export renderer cannot load)
  for (const l of out) {
    if (l.style?.fontFamily) assert.ok(!l.style.fontFamily.includes(','), `single-token family, not a comma list: ${l.style.fontFamily}`);
  }
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
