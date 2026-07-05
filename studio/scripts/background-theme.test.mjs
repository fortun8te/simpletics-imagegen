// background-theme.test.mjs — sceneGraph.ts background/theme handling.
//
// Covers the three fixes for the design-agent BACKGROUND bug:
//   1. A PHOTO reference (skeleton.background null) does NOT get a solid base injected — the doc's
//      existing base (a real photo underlay) is kept untouched.
//   2. A blank comp uses the corrected NEUTRAL default (theme-aware light background), not an
//      empty/broken image base or a jarring hardcoded color.
//   3. Dark context → dark background token + light foreground token; light → the inverse. Theme is
//      derived from luminance so base + text stay consistent.
//
// Loads the REAL sceneGraph.ts via the shared ts-loader (no reimplementation).
// Run: node --experimental-strip-types --test scripts/background-theme.test.mjs

import { register } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const HERE = dirname(fileURLToPath(import.meta.url));
register(join(HERE, 'lib/ts-loader.mjs'), import.meta.url);

const sg = await import(join(HERE, '../src/lib/sceneGraph.ts'));
const {
  buildBlankDoc, applySkeleton, baseFromSkeletonBackground,
  themeFromLuminance, themeBaseLayer, THEME_BG, THEME_FG,
} = sg;

test('themeFromLuminance: dark below mid-grey, light at/above', () => {
  assert.equal(themeFromLuminance(0.02), 'dark');
  assert.equal(themeFromLuminance(0.49), 'dark');
  assert.equal(themeFromLuminance(0.5), 'light');
  assert.equal(themeFromLuminance(0.9), 'light');
  assert.equal(themeFromLuminance(null), 'light'); // unknown → light default
});

test('dark context → dark background token + light foreground token; light → inverse', () => {
  const dark = themeFromLuminance(0.03);
  const light = themeFromLuminance(0.92);
  assert.equal(THEME_BG[dark], '#0c0e14', 'dark theme uses a true near-black surface');
  assert.equal(THEME_FG[dark], '#f5f5f5', 'dark theme flips text light');
  assert.equal(THEME_BG[light], '#f7f8fa', 'light theme uses a soft off-white (not harsh #fff)');
  assert.equal(THEME_FG[light], '#111111', 'light theme keeps text dark');

  // the base a dark context produces is the dark surface, and its foreground the light token
  const base = themeBaseLayer(dark, { w: 1080, h: 1080 });
  assert.equal(base.style.background, '#0c0e14');
  assert.equal(base.role, 'base');
});

test('buildBlankDoc: empty src → corrected NEUTRAL light default (not an empty image base)', () => {
  const doc = buildBlankDoc('', { w: 1080, h: 1080 }, { name: 'New comp' });
  const base = doc.layers.find((l) => l.role === 'base');
  assert.ok(base, 'a base layer exists');
  assert.equal(base.type, 'shape', 'base is a solid fill, not a broken empty <image>');
  assert.equal(base.style.background, '#f7f8fa', 'default is the neutral light background token');
  // and an explicit dark override works
  const darkDoc = buildBlankDoc('theme:dark', { w: 1080, h: 1080 });
  assert.equal(darkDoc.layers[0].style.background, '#0c0e14');
});

test('baseFromSkeletonBackground: photo (null) → no base; solid → solid; gradient → gradient', () => {
  const canvas = { w: 1080, h: 1080 };
  assert.equal(baseFromSkeletonBackground(null, canvas), null, 'photo reference gets NO auto base');
  assert.equal(baseFromSkeletonBackground(undefined, canvas), null, 'unknown → no base');

  const solid = baseFromSkeletonBackground('#123456', canvas);
  assert.equal(solid.type, 'shape');
  assert.equal(solid.style.background, '#123456');

  const grad = baseFromSkeletonBackground({ from: '#ff0000', to: '#0000ff', angle: 90 }, canvas);
  assert.ok(grad.style.gradient && grad.style.gradient.stops.length === 2);
  assert.equal(grad.style.gradient.angle, 90);
});

test('applySkeleton: a PHOTO reference does NOT inject a solid base over the photo underlay', () => {
  // Doc already carries the real photo as its base (the reference underlay).
  const doc = buildBlankDoc('/img?path=photo.png', { w: 1080, h: 1080 });
  const photoBase = doc.layers.find((l) => l.role === 'base');
  assert.equal(photoBase.type, 'image', 'seeded photo base is an image layer');

  const skeleton = {
    id: 'skel_photo', name: 'photo', canvas: { w: 1080, h: 1080 }, createdAt: 1,
    background: null, // PHOTO reference → no flat fill
    layers: [{ id: 's-head', type: 'text', role: 'headline', text: 'HELLO', box: { x: 80, y: 120, w: 700, h: 120 }, style: { fontSize: 84, color: '#fff' } }],
  };
  const out = applySkeleton(doc, skeleton);
  const bases = out.layers.filter((l) => l.role === 'base');
  assert.equal(bases.length, 1, 'exactly one base');
  assert.equal(bases[0].type, 'image', 'photo underlay kept — NOT replaced by a solid shape');
  assert.equal(bases[0].src, '/img?path=photo.png', 'original photo src preserved');
  assert.ok(!out.layers.some((l) => l.role === 'base' && l.type === 'shape'), 'no unwanted solid base injected');
  assert.ok(out.layers.some((l) => l.role === 'headline'), 'overlays applied');
});

test('applySkeleton: a solid/gradient reference REPLACES the base with that fill', () => {
  const mk = () => buildBlankDoc('color:#ffffff', { w: 1080, h: 1080 });

  const solidDoc = applySkeleton(mk(), { id: 's1', name: 's', canvas: { w: 1080, h: 1080 }, createdAt: 1, background: '#0c0e14', layers: [] });
  const sBase = solidDoc.layers.find((l) => l.role === 'base');
  assert.equal(sBase.style.background, '#0c0e14', 'solid reference background becomes the base fill');

  const gradDoc = applySkeleton(mk(), { id: 's2', name: 's', canvas: { w: 1080, h: 1080 }, createdAt: 1, background: { from: '#ff0000', to: '#0000ff', angle: 45 }, layers: [] });
  const gBase = gradDoc.layers.find((l) => l.role === 'base');
  assert.ok(gBase.style.gradient, 'gradient reference becomes a gradient base');
  assert.equal(gBase.style.gradient.stops[0].color, '#ff0000');
});
