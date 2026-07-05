// test/extract-dedup.test.mjs — the "same product 40 times" + "text behind elements" fixes:
// spatial de-dup collapses overlapping product reads into ONE union box (outer-edge tracking),
// and toSkeletonLayers emits layers in a sane paint order (text always on top).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dedupeRawLayers, toSkeletonLayers, sanitizeGeometry } from '../lib/layout-extract.mjs';

// Walk leaves of a (possibly grouped) skeleton tree.
function leaves(layers) {
  const out = [];
  for (const l of (layers || [])) {
    if (l?.type === 'group' && Array.isArray(l.children)) out.push(...leaves(l.children));
    else out.push(l);
  }
  return out;
}

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

test('image shape + color read from style (the prompt example nests them there)', () => {
  // The model nests shape/color under style per the prompt example — toSkeletonLayers must read both.
  const raw = { layers: [
    { type: 'image', role: 'product', text: 'protein pouch', box: { x: 30, y: 20, w: 40, h: 50 }, style: { shape: 'pouch', color: '#2f7d3a' } },
  ] };
  const out = leaves(toSkeletonLayers(raw, { w: 1080, h: 1350 }));
  const product = out.find((l) => l.role === 'product');
  assert.ok(product, 'product region emitted');
  // tint (with alpha) comes from the style.color, not the gray default
  assert.ok(product.style.background.toLowerCase().startsWith('#2f7d3a'), `tint from style.color (got ${product.style.background})`);
  // a non-round product gets a synthesized organic silhouette path
  assert.equal(product.style.shapeKind, 'path', 'organic silhouette synthesized');
  assert.ok(typeof product.style.path === 'string' && product.style.path.startsWith('M '), 'valid SVG path');
});

test('silhouette hint inferred from label words when the model gives none', () => {
  // No shape hint at all — must infer "tube" from the label and still synthesize a path.
  const raw = { layers: [
    { type: 'image', role: 'product', text: 'curl crème tube', box: { x: 55, y: 40, w: 25, h: 45 }, color: '#8a9a5b' },
  ] };
  const out = leaves(toSkeletonLayers(raw, { w: 1080, h: 1920 }));
  const product = out.find((l) => l.role === 'product');
  assert.equal(product.style.shapeKind, 'path', 'silhouette synthesized from inferred hint');
  assert.ok(product.style.background.toLowerCase().startsWith('#8a9a5b'), 'top-level color still honored');
});

test('avatar/logo/photo regions are flagged as cut-out candidates (not rebuilt)', () => {
  const raw = { layers: [
    { type: 'image', role: 'avatar', text: 'profile pic', box: { x: 4, y: 4, w: 12, h: 12 }, style: { color: '#ccc' } },
    { type: 'image', role: 'logo', text: 'brand logo', box: { x: 40, y: 2, w: 20, h: 8 }, color: '#222' },
    { type: 'image', role: 'product', text: 'greens bag', box: { x: 30, y: 40, w: 40, h: 45 }, style: { shape: 'bag', color: '#2f7d3a' } },
  ] };
  let cutoutN = 0;
  const out = leaves(toSkeletonLayers(raw, { w: 1080, h: 1920 }, null, { onCutout: (n) => { cutoutN = n; } }));
  assert.equal(cutoutN, 2, 'avatar + logo flagged, product is not');
  const avatar = out.find((l) => l.name.startsWith('Avatar'));
  assert.ok(avatar.cutoutCandidate, 'avatar carries cutoutCandidate');
  // region is fractions 0..1 of the source image, matching design-agent cutout op's contract
  assert.ok(avatar.cutoutCandidate.region.x >= 0 && avatar.cutoutCandidate.region.x <= 1, 'region.x is a fraction');
  assert.equal(avatar.cutoutCandidate.shape, 'avatar', 'avatar mask hint');
  assert.ok(Math.abs(avatar.cutoutCandidate.region.w - 0.12) < 0.001, 'region.w = box w% / 100');
  const product = out.find((l) => l.role === 'product');
  assert.equal(product.cutoutCandidate, undefined, 'a plain product is NOT a cut-out candidate');
  assert.equal(product.style.shapeKind, 'path', 'the product still gets its silhouette previs');
});

test('geometry sanity: overlapping text boxes are separated, boxes clamped on-canvas', () => {
  const canvas = { w: 1080, h: 1080 };
  const layers = [
    { type: 'text', text: 'Line A', box: { x: 100, y: 100, w: 400, h: 120 }, style: {} },
    { type: 'text', text: 'Line B', box: { x: 120, y: 130, w: 400, h: 120 }, style: {} }, // ~overlaps A
    { type: 'text', text: 'Off canvas', box: { x: 1000, y: 1020, w: 400, h: 200 }, style: {} },
  ];
  const { fixed } = sanitizeGeometry(layers, canvas);
  assert.ok(fixed >= 1, 'at least one overlap separated');
  // B pushed below A
  assert.ok(layers[1].box.y >= layers[0].box.y + layers[0].box.h, 'B now sits below A');
  // off-canvas box clamped fully inside
  const c = layers[2].box;
  assert.ok(c.x + c.w <= canvas.w && c.y + c.h <= canvas.h, 'off-canvas box clamped inside');
});

test('geometry sanity: horizontally-disjoint text is NOT moved (side-by-side columns)', () => {
  const canvas = { w: 1080, h: 1080 };
  const layers = [
    { type: 'text', text: 'Left col', box: { x: 40, y: 200, w: 400, h: 300 }, style: {} },
    { type: 'text', text: 'Right col', box: { x: 640, y: 200, w: 400, h: 300 }, style: {} },
  ];
  const before = layers.map((l) => ({ ...l.box }));
  sanitizeGeometry(layers, canvas);
  assert.deepEqual(layers[0].box, before[0], 'left column untouched');
  assert.deepEqual(layers[1].box, before[1], 'right column untouched (no vertical stacking)');
});
