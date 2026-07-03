// figma-roundtrip.test.mjs — export → import roundtrip over the native Figma clipboard payload.
// Run from studio/:  npx tsx scripts/figma-roundtrip.test.mjs
// Never touches the system clipboard: uses the pure buildFigmaClipboardHtml payload builder.

import assert from 'node:assert/strict';
import {
  buildFigmaClipboardHtml,
  gradientTransformFromAngle,
  FIGMA_PATH_PLUGIN_ID,
  FIGMA_PATH_PLUGIN_KEY,
} from '../src/components/design/figmaClipboard.ts';
import {
  parseFigmaClipboard,
  sniffFigmaClipboard,
} from '../src/components/design/figmaImport.ts';
import { designToSvg } from '../src/components/design/designSvg.ts';
import { decodeFigmaClipboardHtml, encodeFigmaClipboardHtml } from '../src/vendor/figma-kiwi/index.ts';

// ── fixture: v3 doc — root text + group(text autoH + gradient shape + nested group(badge)) + vignette

const doc = {
  id: 'comp_test',
  name: 'Roundtrip Fixture',
  canvas: { w: 1080, h: 1350 },
  layers: [
    {
      id: 'headline', type: 'text', role: 'headline', name: 'Headline', text: 'HELLO FIGMA',
      box: { x: 60, y: 80, w: 960, h: 140 },
      style: { fontSize: 88, fontWeight: 700, color: '#ffffff', align: 'center', uppercase: true },
    },
    {
      id: 'grp-main', type: 'group', name: 'Main Group',
      box: { x: 100, y: 300, w: 880, h: 600 },
      style: { opacity: 0.9 },
      children: [
        {
          id: 'sub', type: 'text', name: 'Subhead', text: 'Auto height text that wraps',
          box: { x: 120, y: 320, w: 600, h: 60 },
          style: { fontSize: 40, color: '#eeeeee' },
          autoH: true,
        },
        {
          id: 'grad', type: 'shape', name: 'Gradient Shape',
          box: { x: 100, y: 420, w: 880, h: 300 },
          style: {
            gradient: {
              type: 'linear', angle: 90,
              stops: [{ color: '#ff0000', pos: 0 }, { color: '#0000ff', pos: 1 }],
            },
            radius: 24,
            stroke: { color: '#ffffff', width: 3 },
          },
        },
        {
          id: 'grp-badge', type: 'group', name: 'Badge Group',
          box: { x: 140, y: 760, w: 300, h: 120 },
          children: [
            {
              id: 'badge', type: 'badge', name: 'Badge', text: 'NEW',
              box: { x: 140, y: 760, w: 300, h: 120 },
              style: { fontSize: 36, color: '#000000', background: '#ffee00', radius: 60, align: 'center' },
            },
          ],
        },
      ],
    },
    {
      id: 'vig', type: 'vignette', name: 'Vignette',
      box: { x: 0, y: 0, w: 1080, h: 1350 },
      style: { vignette: { strength: 0.7, size: 0.45 } },
    },
    {
      id: 'rot-text', type: 'text', name: 'Rotated Text', text: 'Tilted 15',
      box: { x: 200, y: 950, w: 400, h: 80 },
      rotation: 15,
      // NOT Inter: Inter is now the export-side fallback family, so an explicit override must
      // be a different family to be distinguishable on the wire.
      style: { fontSize: 48, color: '#ffffff', fontFamily: 'Georgia' },
    },
    {
      id: 'rot-shape', type: 'shape', name: 'Rotated Shape',
      box: { x: 640, y: 940, w: 200, h: 100 },
      rotation: -30,
      style: { background: '#22cc88', radius: 12 },
    },
    {
      id: 'ell', type: 'shape', name: 'Ellipse Shape',
      box: { x: 80, y: 1060, w: 160, h: 160 },
      style: { shapeKind: 'ellipse', background: '#3366ff' },
    },
    {
      id: 'star', type: 'shape', name: 'Starburst Badge',
      box: { x: 280, y: 1060, w: 180, h: 180 },
      style: { shapeKind: 'starburst', spikes: 12, background: '#ff3355' },
    },
    {
      id: 'arrow', type: 'shape', name: 'Callout Arrow',
      box: { x: 500, y: 1060, w: 220, h: 120 },
      style: { shapeKind: 'arrow', background: '#ffcc00' },
    },
    {
      id: 'price', type: 'text', name: 'Old Price', text: '€19',
      box: { x: 760, y: 1080, w: 120, h: 50 },
      style: { fontSize: 40, color: '#999999', strikethrough: true },
    },
    {
      id: 'glass', type: 'shape', name: 'Glass Card',
      box: { x: 120, y: 1240, w: 840, h: 90 },
      style: { background: 'rgba(255,255,255,0.2)', radius: 20, backdropBlur: 24 },
    },
    // ── effects/structure round fixtures ──
    {
      id: 'blend-txt', type: 'text', name: 'Blend Text', text: 'Blend Multiply',
      box: { x: 60, y: 10, w: 400, h: 50 },
      style: { fontSize: 40, color: '#ffffff', blend: 'multiply' },
    },
    {
      id: 'blur-ell', type: 'shape', name: 'Blurred Ellipse',
      box: { x: 900, y: 1060, w: 120, h: 120 },
      style: { shapeKind: 'ellipse', background: '#ff8800', blur: 8 },
    },
    {
      id: 'glass-opaque', type: 'shape', name: 'Glass Opaque',
      box: { x: 120, y: 1150, w: 300, h: 70 },
      style: { background: '#112233', radius: 16, backdropBlur: 24 },
    },
    {
      id: 'corners', type: 'shape', name: 'Corner Mix',
      box: { x: 460, y: 1150, w: 200, h: 70 },
      style: { background: '#00ffcc', radius: 8, radiusCorners: [40, 0, 40, 0] },
    },
    {
      id: 'clipgrp', type: 'group', name: 'Clip Group', clip: true,
      box: { x: 700, y: 1150, w: 260, h: 80 },
      children: [
        { id: 'clip-a', type: 'shape', name: 'Clip A', box: { x: 700, y: 1150, w: 200, h: 80 }, style: { background: '#4444ff' } },
        { id: 'clip-b', type: 'shape', name: 'Clip B', box: { x: 820, y: 1170, w: 200, h: 60 }, style: { background: '#ff4444' } },
      ],
    },
    {
      id: 'maskgrp', type: 'group', name: 'Mask Group',
      box: { x: 60, y: 600, w: 200, h: 200 },
      children: [
        {
          id: 'mask-ell', type: 'shape', name: 'Mask Ellipse', isMask: true,
          box: { x: 60, y: 600, w: 200, h: 200 }, style: { shapeKind: 'ellipse', background: '#ffffff' },
        },
        {
          id: 'mask-img', type: 'image', name: 'Masked Photo',
          src: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
          box: { x: 60, y: 600, w: 200, h: 200 },
        },
      ],
    },
    {
      id: 'poly', type: 'shape', name: 'Poly Wave',
      box: { x: 500, y: 600, w: 200, h: 100 },
      style: {
        shapeKind: 'polyline',
        points: [0, 1, 0.25, 0.5, 0.5, 0.75, 0.75, 0.25, 1, 0], // 5 points
        background: '#ff00ff',
        stroke: { color: '#ff00ff', width: 6 },
      },
    },
    {
      id: 'el-cta', type: 'button', text: 'SHOP NOW', element: { id: 'cta', params: {}, v: 1 },
      box: { x: 760, y: 600, w: 240, h: 70 },
      style: { fontSize: 32, color: '#000000', background: '#ffffff', radius: 35, align: 'center' },
    },
    // ── freeform paths + masking round fixtures ──
    {
      id: 'tri', type: 'shape', name: 'Triangle',
      box: { x: 300, y: 640, w: 160, h: 140 },
      style: { shapeKind: 'path', path: 'M 0.5 0 L 1 1 L 0 1 Z', background: '#00ff88' },
    },
    {
      id: 'maskgrp2', type: 'group', name: 'Mask Trio',
      box: { x: 60, y: 850, w: 220, h: 220 },
      children: [
        {
          id: 'trio-mask', type: 'shape', name: 'Trio Mask', isMask: true,
          box: { x: 60, y: 850, w: 220, h: 220 }, style: { shapeKind: 'ellipse', background: '#ffffff' },
        },
        {
          id: 'trio-a', type: 'shape', name: 'Trio A',
          box: { x: 60, y: 850, w: 220, h: 110 }, style: { background: '#ff8800' },
        },
        {
          id: 'trio-b', type: 'shape', name: 'Trio B',
          box: { x: 60, y: 960, w: 220, h: 110 }, style: { background: '#0088ff' },
        },
      ],
    },
  ],
  createdAt: 0, updatedAt: 0, schemaVersion: 3,
};

// 1×1 transparent PNG for the masked image layer (pure builder takes pre-fetched bytes).
const TINY_PNG = Uint8Array.from(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
));
const fixtureImages = new Map([
  ['mask-img', { bytes: TINY_PNG, hash: new Uint8Array(20).fill(7), width: 1, height: 1 }],
]);

let failures = 0;
function check(label, fn) {
  try { fn(); console.log(`ok   ${label}`); }
  catch (err) { failures++; console.error(`FAIL ${label}\n     ${err.message}`); }
}
async function checkAsync(label, fn) {
  try { await fn(); console.log(`ok   ${label}`); }
  catch (err) { failures++; console.error(`FAIL ${label}\n     ${err.message}`); }
}

// ── 1. gradientTransformFromAngle(180) must equal Figma's legacy vertical matrix EXACTLY.
check('gradientTransformFromAngle(180) === legacy vertical matrix', () => {
  assert.deepEqual(gradientTransformFromAngle(180), { m00: 0, m01: 1, m02: 0, m10: -1, m11: 0, m12: 1 });
});

// ── 2. export → import roundtrip.
const html = buildFigmaClipboardHtml(doc, fixtureImages);
// Wire-level view of the exported payload (what Figma actually receives), used by both the
// structure checks below and the effects checks further down.
const changes = decodeFigmaClipboardHtml(html).message.nodeChanges;
const changeByName = (name) => changes.find((c) => c.name === name);
check('sniffFigmaClipboard', () => {
  assert.equal(sniffFigmaClipboard(html), true);
  assert.equal(sniffFigmaClipboard('<p>nope</p>'), false);
  assert.equal(sniffFigmaClipboard(null), false);
});

const result = await parseFigmaClipboard(html);
check('parse ok', () => assert.equal(result.ok, true, result.error));

const nodes = result.nodes ?? [];
const findByName = (list, name) => {
  for (const n of list) {
    if (n.name === name) return n;
    if (n.type === 'group') { const hit = findByName(n.children, name); if (hit) return hit; }
  }
  return null;
};

check('canvas size = outer frame', () => {
  assert.deepEqual(result.canvas, { w: 1080, h: 1350 });
  assert.equal(result.name, 'Roundtrip Fixture');
});

check('tree depth preserved (group > group)', () => {
  const main = findByName(nodes, 'Main Group');
  assert.ok(main && main.type === 'group', 'Main Group present as group');
  const badgeGrp = main.children.find((c) => c.name === 'Badge Group');
  assert.ok(badgeGrp && badgeGrp.type === 'group', 'nested Badge Group present');
  assert.ok(badgeGrp.children.length >= 1, 'badge group has children');
});

check('plain groups emit a REAL Figma GROUP node (named), not a FRAME', () => {
  // The user-visible fix: a scene GroupNode → NodeType.GROUP so Figma's layers panel shows a
  // named, expandable "Group" (not a flat dump, not a Frame). Names + nesting preserved.
  const main = changeByName('Main Group');
  assert.ok(main, 'Main Group on the wire');
  assert.equal(main.type, 'GROUP', `Main Group must be a GROUP, got ${main.type}`);
  const badge = changeByName('Badge Group');
  assert.ok(badge, 'nested Badge Group on the wire');
  assert.equal(badge.type, 'GROUP', `nested Badge Group must be a GROUP, got ${badge.type}`);
  // GROUP nodes carry no frame-only paint/layout fields.
  assert.equal(main.resizeToFit, undefined, 'GROUP must not carry resizeToFit');
  assert.equal(main.fillPaints, undefined, 'GROUP must not carry fillPaints');
  // The nested GROUP is parented under the outer GROUP (real nesting on the wire).
  assert.deepEqual(badge.parentIndex.guid, main.guid, 'Badge Group nested under Main Group');
});

check('node count', () => {
  // roots: bg shape (frame fill) + headline text + main group + vignette
  //        + rotated text + rotated shape + ellipse + starburst + arrow + price + glass = 11
  //        + blend text + blurred ellipse + glass opaque + corner mix + clip group
  //        + mask group + polyline + element cta (bg rect + text siblings) = 20
  //        + path triangle + mask trio group = 22
  assert.equal(nodes.length, 22, `got ${nodes.length}: ${nodes.map((n) => n.name).join(', ')}`);
});

check('names preserved', () => {
  // Text nodes are named by their characters (existing export behavior); containers/shapes
  // keep their layer names.
  for (const name of ['Main Group', 'Gradient Shape', 'Badge Group', 'Vignette',
    'HELLO FIGMA', 'Auto height text that wraps', 'Badge bg', 'NEW']) {
    assert.ok(findByName(nodes, name), `missing "${name}"`);
  }
});

check('gradient recovered with angle ≈ 90', () => {
  const shape = findByName(nodes, 'Gradient Shape');
  const g = shape.style?.gradient;
  assert.ok(g && typeof g === 'object', 'gradient fill present');
  assert.equal(g.type, 'linear');
  assert.ok(Math.abs(g.angle - 90) <= 1, `angle ${g.angle} !≈ 90`);
  assert.equal(g.stops.length, 2);
  assert.equal(g.stops[0].color, '#ff0000');
  assert.equal(g.stops[1].color, '#0000ff');
});

check('stroke recovered', () => {
  const shape = findByName(nodes, 'Gradient Shape');
  assert.deepEqual(shape.style.stroke, { color: '#ffffff', width: 3 });
});

check('autoH text roundtrips', () => {
  const sub = findByName(nodes, 'Auto height text that wraps');
  assert.equal(sub.type, 'text');
  assert.equal(sub.autoH, true);
  assert.equal(sub.text, 'Auto height text that wraps');
});

check('group child coords back to ABSOLUTE canvas space', () => {
  const shape = findByName(nodes, 'Gradient Shape');
  assert.deepEqual(shape.box, { x: 100, y: 420, w: 880, h: 300 });
  const badge = findByName(nodes, 'Badge Group');
  assert.deepEqual(badge.box, { x: 140, y: 760, w: 300, h: 120 });
});

check('vignette present as radial-gradient shape', () => {
  const vig = findByName(nodes, 'Vignette');
  assert.ok(vig, 'vignette node present');
  const g = vig.style?.gradient;
  assert.ok(g && g.type === 'radial', 'radial gradient fill');
  assert.equal(g.stops.length, 2);
  assert.ok(Math.abs(g.stops[0].pos - 0.45) < 1e-6, 'inner stop at size');
  assert.equal(g.stops[1].pos, 1);
});

check('uppercase + align roundtrip', () => {
  const byText = findByName(nodes, 'HELLO FIGMA');
  assert.ok(byText, 'headline text node present');
  assert.equal(byText.style.uppercase, true);
  assert.equal(byText.style.align, 'center');
});

// ── new scene-graph capabilities: rotation, shapeKind, strikethrough, fontFamily, backdropBlur ──

check('rotation roundtrips (15° text, within 0.5°)', () => {
  const t = findByName(nodes, 'Tilted 15');
  assert.ok(t, 'rotated text node present');
  assert.ok(Math.abs(t.rotation - 15) <= 0.5, `rotation ${t.rotation} !≈ 15`);
  // unrotated top-left recovered from the rotated matrix
  assert.ok(Math.abs(t.box.x - 200) <= 1 && Math.abs(t.box.y - 950) <= 1,
    `box (${t.box.x},${t.box.y}) drifted from (200,950)`);
});

check('rotation roundtrips (−30° shape, within 0.5°)', () => {
  const sh = findByName(nodes, 'Rotated Shape');
  assert.ok(sh, 'rotated shape present');
  assert.ok(Math.abs(sh.rotation - -30) <= 0.5, `rotation ${sh.rotation} !≈ -30`);
  assert.ok(Math.abs(sh.box.x - 640) <= 1 && Math.abs(sh.box.y - 940) <= 1,
    `box (${sh.box.x},${sh.box.y}) drifted from (640,940)`);
  assert.equal(sh.box.w, 200);
  assert.equal(sh.box.h, 100);
});

check('ellipse → ELLIPSE → shapeKind ellipse', () => {
  const e = findByName(nodes, 'Ellipse Shape');
  assert.equal(e.style.shapeKind, 'ellipse');
  assert.equal(e.style.background, '#3366ff');
  assert.deepEqual(e.box, { x: 80, y: 1060, w: 160, h: 160 });
});

check('starburst → STAR(count 12) → spikes 12 exact', () => {
  const st = findByName(nodes, 'Starburst Badge');
  assert.equal(st.style.shapeKind, 'starburst');
  assert.equal(st.style.spikes, 12);
  assert.equal(st.style.background, '#ff3355');
});

check('arrow → LINE(strokeCap ARROW_LINES) → shapeKind arrow', () => {
  const a = findByName(nodes, 'Callout Arrow');
  assert.equal(a.style.shapeKind, 'arrow');
  assert.equal(a.style.background, '#ffcc00');
  assert.ok(!a.style.flipDiag, 'default diagonal (↘) has no flipDiag');
  assert.deepEqual(a.box, { x: 500, y: 1060, w: 220, h: 120 });
});

check('strikethrough price roundtrips', () => {
  const p = findByName(nodes, '€19');
  assert.ok(p, 'price text node present');
  assert.equal(p.style.strikethrough, true);
});

check('glass card backdropBlur 24 exact', () => {
  const g = findByName(nodes, 'Glass Card');
  assert.equal(g.style.backdropBlur, 24);
  assert.equal(g.style.radius, 20);
});

check('custom fontFamily roundtrips (fallback stays implicit)', () => {
  const t = findByName(nodes, 'Tilted 15');
  assert.equal(t.style.fontFamily, 'Georgia');
  const headline = findByName(nodes, 'HELLO FIGMA');
  assert.equal(headline.style.fontFamily, undefined, 'Inter fallback must not materialize');
});

// ── effects/structure round: blend, layer blur, glass, corners, clip, mask, polyline, names ──

check('blend multiply text: MULTIPLY on the wire, style.blend back', () => {
  const wire = changeByName('Blend Multiply'); // text nodes named by characters
  assert.ok(wire, 'blend text node on wire');
  assert.equal(wire.blendMode, 'MULTIPLY');
  const t = findByName(nodes, 'Blend Multiply');
  assert.ok(t, 'blend text imported');
  assert.equal(t.style.blend, 'multiply');
});

check('layer blur: FOREGROUND_BLUR 8 on the wire, style.blur back (≠ backdropBlur)', () => {
  const wire = changeByName('Blurred Ellipse');
  assert.ok(wire, 'blurred ellipse on wire');
  const fx = (wire.effects || []).find((e) => e.type === 'FOREGROUND_BLUR');
  assert.ok(fx, 'FOREGROUND_BLUR effect present (schema has no LAYER_BLUR — verified enum)');
  assert.equal(fx.radius, 8);
  const e = findByName(nodes, 'Blurred Ellipse');
  assert.equal(e.style.blur, 8);
  assert.equal(e.style.backdropBlur, undefined, 'layer blur must not leak into backdropBlur');
});

check('glass fix: opaque fill re-emitted translucent under BACKGROUND_BLUR', () => {
  const wire = changeByName('Glass Opaque');
  assert.ok(wire, 'glass node on wire');
  const blur = (wire.effects || []).find((e) => e.type === 'BACKGROUND_BLUR');
  assert.ok(blur && blur.radius === 24, 'BACKGROUND_BLUR 24 on the node');
  const fill = (wire.fillPaints || [])[0];
  assert.ok(fill && fill.type === 'SOLID', 'solid fill present');
  assert.ok(fill.color.a < 1, `fill alpha ${fill.color.a} must be < 1 for the blur to read`);
  assert.ok(Math.abs(fill.color.a - 0.35) < 0.01, `fill alpha ${fill.color.a} ≈ 0.35`);
  assert.ok(wire.cornerRadius === 16, 'cornerRadius kept');
  // import: blur + the translucent fill alpha both come back
  const g = findByName(nodes, 'Glass Opaque');
  assert.equal(g.style.backdropBlur, 24);
  assert.equal(g.style.radius, 16);
  assert.equal(g.style.background, '#11223359'); // 0.35 alpha kept in the background color
});

check('glass fix: already-translucent fill untouched', () => {
  const wire = changeByName('Glass Card');
  const fill = (wire.fillPaints || [])[0];
  assert.ok(Math.abs(fill.color.a - 0.2) < 0.01, `translucent fill alpha ${fill.color.a} stays 0.2`);
});

check('per-corner radius [40,0,40,0] roundtrips', () => {
  const wire = changeByName('Corner Mix');
  assert.equal(wire.rectangleTopLeftCornerRadius, 40);
  assert.equal(wire.rectangleTopRightCornerRadius, 0);
  assert.equal(wire.rectangleBottomRightCornerRadius, 40);
  assert.equal(wire.rectangleBottomLeftCornerRadius, 0);
  assert.equal(wire.rectangleCornerRadiiIndependent, true);
  const c = findByName(nodes, 'Corner Mix');
  assert.deepEqual(c.style.radiusCorners, [40, 0, 40, 0]);
});

check('clip group → real clipping FRAME → clip:true back, sizes preserved', () => {
  const wire = changeByName('Clip Group');
  assert.equal(wire.type, 'FRAME');
  assert.equal(wire.resizeToFit, false);
  assert.equal(wire.frameMaskDisabled, false);
  const g = findByName(nodes, 'Clip Group');
  assert.equal(g.type, 'group');
  assert.equal(g.clip, true);
  assert.deepEqual(g.box, { x: 700, y: 1150, w: 260, h: 80 });
  assert.equal(g.children.length, 2);
  assert.deepEqual(g.children[0].box, { x: 700, y: 1150, w: 200, h: 80 });
});

check('plain group still imports without clip', () => {
  const g = findByName(nodes, 'Main Group');
  assert.ok(!g.clip, 'resizeToFit group must not become a clip group');
});

check('mask: isMask first child → mask:true + maskType ALPHA → isMask back, order kept', () => {
  const wire = changeByName('Mask Ellipse');
  assert.ok(wire, 'mask ellipse on wire');
  assert.equal(wire.mask, true);
  assert.equal(wire.maskType, 'ALPHA');
  const g = findByName(nodes, 'Mask Group');
  assert.ok(g && g.type === 'group', 'mask group imported');
  assert.equal(g.children.length, 2, 'both children back');
  assert.equal(g.children[0].name, 'Mask Ellipse');
  assert.equal(g.children[0].isMask, true);
  assert.equal(g.children[1].type, 'image', 'image sibling preserved after the mask');
  assert.equal((result.images || []).length, 1, 'embedded image bytes travel');
});

check('polyline (5 points) → LINE group with hint → polyline back', () => {
  const frame = changeByName('Poly Wave');
  assert.ok(frame, 'polyline frame on wire');
  const segs = changes.filter((c) => String(c.name || '').startsWith('polyline·'));
  assert.equal(segs.length, 4, '4 LINE segments for 5 points');
  for (const s of segs) assert.equal(s.type, 'LINE');
  const p = findByName(nodes, 'Poly Wave');
  assert.ok(p, 'polyline imported');
  assert.equal(p.style.shapeKind, 'polyline');
  assert.equal(p.style.points.length, 10);
  const want = [0, 1, 0.25, 0.5, 0.5, 0.75, 0.75, 0.25, 1, 0];
  want.forEach((v, i) => assert.ok(Math.abs(p.style.points[i] - v) < 0.02, `point[${i}] ${p.style.points[i]} !≈ ${v}`));
  assert.equal(p.style.stroke.width, 6);
  assert.equal(p.style.background, '#ff00ff');
});

check('naming discipline: every exported node has a non-empty name', () => {
  for (const c of changes) {
    assert.ok(typeof c.name === 'string' && c.name.length > 0,
      `node ${c.type} guid ${JSON.stringify(c.guid)} has empty name`);
  }
});

check('element instance exports with the element display name', () => {
  // Layer.element {id:'cta'} and no layer name → node named "CTA button" (elements.ts meta).
  assert.ok(changeByName('CTA button'), 'text node named after element def');
  assert.ok(changeByName('CTA button bg'), 'bg rect named after element def');
});

// ── freeform paths + masking round: path fallback, mask trio, fonts, VECTOR import, SVG ──

check('path triangle: ROUNDED_RECTANGLE fallback + " (path)" suffix + pluginData d-string', () => {
  // DOCUMENTED FALLBACK: a real VECTOR needs vectorData.vectorNetworkBlob (opaque non-kiwi
  // binary) — the box pastes as a rect with the real fill; the d-string rides in pluginData.
  const wire = changeByName('Triangle (path)');
  assert.ok(wire, 'path shape on wire with suffixed name');
  assert.equal(wire.type, 'ROUNDED_RECTANGLE');
  const pd = (wire.pluginData || []).find((p) => p.pluginID === FIGMA_PATH_PLUGIN_ID && p.key === FIGMA_PATH_PLUGIN_KEY);
  assert.ok(pd, 'pluginData path entry present');
  assert.equal(pd.value, 'M 0.5 0 L 1 1 L 0 1 Z');
  const fill = (wire.fillPaints || [])[0];
  assert.ok(fill && fill.type === 'SOLID', 'real fill on the fallback rect');
});

check('path triangle imports back as shapeKind path (suffix stripped)', () => {
  const t = findByName(nodes, 'Triangle');
  assert.ok(t, 'triangle back under its original name');
  assert.equal(t.type, 'shape');
  assert.equal(t.style.shapeKind, 'path');
  assert.equal(t.style.path, 'M 0.5 0 L 1 1 L 0 1 Z');
  assert.equal(t.style.background, '#00ff88');
  assert.deepEqual(t.box, { x: 300, y: 640, w: 160, h: 140 });
  assert.ok(!findByName(nodes, 'Triangle (path)'), 'suffixed name must not survive import');
});

check('mask trio: ellipse mask + 2 following siblings survive in order', () => {
  const wire = changeByName('Trio Mask');
  assert.ok(wire, 'trio mask on wire');
  assert.equal(wire.mask, true);
  assert.equal(wire.maskType, 'ALPHA');
  for (const sib of ['Trio A', 'Trio B']) {
    const s = changeByName(sib);
    assert.ok(s, `${sib} on wire`);
    assert.ok(!s.mask, `${sib} must not be a mask`);
  }
  const g = findByName(nodes, 'Mask Trio');
  assert.ok(g && g.type === 'group', 'mask trio group imported');
  assert.equal(g.children.length, 3, 'mask + 2 siblings back');
  assert.equal(g.children[0].name, 'Trio Mask');
  assert.equal(g.children[0].isMask, true);
  assert.equal(g.children[0].style.shapeKind, 'ellipse');
  assert.equal(g.children[1].name, 'Trio A');
  assert.equal(g.children[2].name, 'Trio B');
  assert.ok(!g.children[1].isMask && !g.children[2].isMask, 'siblings stay non-mask');
});

check('fonts: plain text doc → ONE family (Inter, Figma-native) and ≤2 minimal styles', () => {
  // Regression for the "missing fonts" dialog: default-family text must resolve to Figma's own
  // Inter (never Geist), and weights map onto the minimal style set — no exotic style names.
  const fontDoc = {
    id: 'comp_fonts', name: 'Fonts', canvas: { w: 1080, h: 1080 },
    // Typical statics: default weight (600), explicit 600s, and bold accents — the doc must
    // not fan out into one missing-font entry per layer.
    layers: [undefined, 600, 600, 700, 700].map((weight, i) => ({
      id: `t${i}`, type: 'text', name: `T${i}`, text: `Text ${i}`,
      box: { x: 40, y: 40 + i * 120, w: 1000, h: 100 },
      style: { fontSize: 40, color: '#ffffff', ...(weight ? { fontWeight: weight } : {}) },
    })),
    createdAt: 0, updatedAt: 0, schemaVersion: 3,
  };
  const fontHtml = buildFigmaClipboardHtml(fontDoc, new Map());
  const texts = decodeFigmaClipboardHtml(fontHtml).message.nodeChanges.filter((c) => c.type === 'TEXT');
  assert.equal(texts.length, 5, 'five TEXT nodes on the wire');
  const families = new Set(texts.map((t) => t.fontName?.family));
  const styles = new Set(texts.map((t) => t.fontName?.style));
  assert.deepEqual([...families], ['Inter'], `exactly one family, Inter — got ${[...families].join(', ')}`);
  assert.ok(styles.size <= 2, `≤2 styles across TEXT nodes — got ${[...styles].join(', ')}`);
  const MINIMAL = new Set(['Regular', 'Medium', 'Semi Bold', 'Bold']);
  for (const s of styles) assert.ok(MINIMAL.has(s), `style "${s}" outside the minimal Inter set`);
});

await checkAsync('Figma VECTOR imports as locked placeholder + passthrough (stale blob index dropped)', async () => {
  // Hand-built payload: a VECTOR node the way Figma would send one (vectorData with a
  // vectorNetworkBlob index). We can't rebuild the blob on export, so the stash must carry the
  // node WITHOUT the per-message blob index.
  const docGuid = { sessionID: 0, localID: 0 };
  const pageGuid = { sessionID: 0, localID: 1 };
  const message = {
    type: 'NODE_CHANGES', sessionID: 0, ackID: 0, pasteID: 1, pasteFileKey: 'x'.repeat(22),
    pasteIsPartiallyOutsideEnclosingFrame: false, pastePageId: pageGuid, isCut: false,
    pasteEditorType: 'DESIGN', publishedAssetGuids: [],
    nodeChanges: [
      { guid: docGuid, phase: 'CREATED', type: 'DOCUMENT', name: 'Document', visible: true },
      {
        guid: pageGuid, phase: 'CREATED', parentIndex: { guid: docGuid, position: '!' },
        type: 'CANVAS', name: 'Page 1', visible: true,
      },
      {
        guid: { sessionID: 1, localID: 2 }, phase: 'CREATED',
        parentIndex: { guid: pageGuid, position: '!' },
        type: 'VECTOR', name: 'Figma Vector', visible: true, opacity: 1,
        size: { x: 120, y: 60 }, transform: { m00: 1, m01: 0, m02: 10, m10: 0, m11: 1, m12: 20 },
        vectorData: { vectorNetworkBlob: 0, normalizedSize: { x: 120, y: 60 } },
        fillPaints: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0, a: 1 }, opacity: 1, visible: true, blendMode: 'NORMAL' }],
      },
    ],
    blobs: [{ bytes: Uint8Array.from([1, 2, 3, 4]) }],
  };
  const vHtml = encodeFigmaClipboardHtml({ fileKey: message.pasteFileKey, pasteID: 1, dataType: 'scene' }, message);
  const vRes = await parseFigmaClipboard(vHtml);
  assert.equal(vRes.ok, true, vRes.error);
  const v = findByName(vRes.nodes, 'Figma Vector');
  assert.ok(v, 'vector imported');
  assert.equal(v.type, 'shape');
  assert.equal(v.locked, true, 'placeholder is locked');
  assert.equal(v.figma?.type, 'VECTOR', 'raw node type stashed for copy-back');
  assert.equal(v.figma?.vectorData?.vectorNetworkBlob, undefined,
    'per-message blob index must not enter the stash');
  assert.ok(v.figma?.vectorData?.normalizedSize, 'rest of vectorData survives');
});

await checkAsync('designSvg: <path> geometry + <clipPath> masks (node-safe shapes-only doc)', async () => {
  const svgDoc = {
    id: 'comp_svg', name: 'Svg Fixture', canvas: { w: 400, h: 400 },
    layers: [
      {
        id: 'p1', type: 'shape', name: 'Tri',
        box: { x: 40, y: 40, w: 100, h: 100 },
        style: { shapeKind: 'path', path: 'M 0.5 0 L 1 1 L 0 1 Z', background: '#123456', stroke: { color: '#ffffff', width: 3 } },
      },
      {
        id: 'g1', type: 'group', name: 'Masked', box: { x: 200, y: 40, w: 120, h: 120 },
        children: [
          { id: 'm1', type: 'shape', name: 'M', isMask: true, box: { x: 200, y: 40, w: 120, h: 120 }, style: { shapeKind: 'ellipse', background: '#fff' } },
          { id: 's1', type: 'shape', name: 'A', box: { x: 200, y: 40, w: 120, h: 60 }, style: { background: '#ff0000' } },
          { id: 's2', type: 'shape', name: 'B', box: { x: 200, y: 100, w: 120, h: 60 }, style: { background: '#00ff00' } },
        ],
      },
    ],
    createdAt: 0, updatedAt: 0, schemaVersion: 3,
  };
  const svg = await designToSvg(svgDoc);
  assert.ok(svg.includes('<path d="M 0.5 0 L 1 1 L 0 1 Z"'), 'normalized d-string emitted');
  assert.ok(svg.includes('transform="translate(40 40) scale(100 100)"'), 'box transform on the path');
  assert.ok(svg.includes('vector-effect="non-scaling-stroke"'), 'stroke width survives the scale');
  assert.ok(svg.includes('<clipPath id="mask-m1"><ellipse'), 'mask geometry in defs');
  assert.ok(svg.includes('<g clip-path="url(#mask-m1)">'), 'following siblings wrapped in the clip');
  const maskIdx = svg.indexOf('<g clip-path="url(#mask-m1)">');
  const aIdx = svg.indexOf('id="A"');
  const bIdx = svg.indexOf('id="B"');
  assert.ok(maskIdx !== -1 && maskIdx < aIdx && aIdx < bIdx, 'clip opens BEFORE the following siblings');
  assert.ok(!svg.includes('id="M"'), 'the mask layer itself does not paint');
  // balanced markup: every <g opens once and closes once
  const opens = (svg.match(/<g /g) || []).length;
  const closes = (svg.match(/<\/g>/g) || []).length;
  assert.equal(opens, closes, `unbalanced <g>: ${opens} opens vs ${closes} closes`);
});

console.log(failures ? `\n${failures} failure(s)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
