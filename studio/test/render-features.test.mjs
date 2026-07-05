// test/render-features.test.mjs — server HTML renderer smoke tests (lib/designstore.mjs
// renderDesignHtml) for the three 1:1-reconstruction features added 2026-07:
//   1. positioned radial gradients ({type:'radial', cx, cy, r, ry?} — fractions of the layer box)
//   2. rotation via the style.rotation alias (degrees clockwise about the box center)
//   3. outlined text (style.textStroke + style.textFillTransparent)
// These assert the emitted CSS — the same strings headless Chrome renders in the copy harness —
// so a renderer regression fails fast without a browser. Parity partners: fills.ts (Stage/raster/
// SVG serializers) and figmaClipboard.ts, covered by scripts/figma-roundtrip.test.mjs.
// Run: node --test test/render-features.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderDesignHtml } from '../lib/designstore.mjs';

const doc = (layers) => ({
  id: 'render_features_test', name: 'Render Features', canvas: { w: 1080, h: 1920 },
  layers, createdAt: 0, updatedAt: 0, schemaVersion: 3,
});

test('positioned radial → CSS radial-gradient(ellipse rx% ry% at cx% cy%)', () => {
  const html = renderDesignHtml(doc([{
    id: 'blob', type: 'shape', role: 'decor', box: { x: 0, y: 0, w: 1080, h: 1920 },
    style: {
      gradient: {
        type: 'radial', cx: 0.28, cy: 0.505, r: 0.6, ry: 0.225,
        stops: [{ color: '#EE4238', pos: 0 }, { color: '#FFFFFF', pos: 1 }],
      },
    },
  }]));
  assert.ok(html.includes('radial-gradient(ellipse 60% 22.5% at 28% 50.5%'), `positioned ellipse radial emitted, got: ${html.match(/radial-gradient\([^)]*/)?.[0]}`);
  assert.ok(html.includes('#EE4238 0%'), 'stops emitted');
});

test('legacy centered radial (no cx/cy/r) keeps the old circle output byte-identical', () => {
  const html = renderDesignHtml(doc([{
    id: 'legacy', type: 'shape', box: { x: 0, y: 0, w: 500, h: 500 },
    style: { gradient: { type: 'radial', stops: [{ color: '#000000', pos: 0 }, { color: '#ffffff', pos: 1 }] } },
  }]));
  assert.ok(html.includes('radial-gradient(circle, #000000 0%, #ffffff 100%)'), 'legacy circle radial unchanged');
});

test('style.rotation alias → transform:rotate about the box center (Layer.rotation wins when set)', () => {
  const html = renderDesignHtml(doc([
    { id: 'alias', type: 'shape', box: { x: 100, y: 100, w: 200, h: 100 }, style: { background: '#ff0088', rotation: -8 } },
    { id: 'both', type: 'shape', box: { x: 100, y: 300, w: 200, h: 100 }, rotation: 15, style: { background: '#0088ff', rotation: -8 } },
  ]));
  assert.ok(html.includes('transform:rotate(-8deg)'), 'style.rotation alias rendered');
  assert.ok(html.includes('transform:rotate(15deg)'), 'node-level rotation wins over the alias');
  assert.ok(html.includes('transform-origin:center'), 'rotates about the box center');
});

test('textStroke + textFillTransparent → -webkit-text-stroke, transparent fill, shadow suppressed', () => {
  const html = renderDesignHtml(doc([{
    id: 'outline', type: 'text', text: 'FRIDAY', box: { x: 100, y: 100, w: 800, h: 160 },
    style: {
      fontSize: 170, fontWeight: 900, color: '#2B3BEB', align: 'center', uppercase: true,
      textStroke: { color: '#2B3BEB', width: 4 }, textFillTransparent: true, shadow: true,
    },
  }]));
  assert.ok(html.includes('-webkit-text-stroke:4px #2B3BEB'), 'text stroke emitted');
  assert.ok(html.includes('color:transparent'), 'outline-only fill is transparent');
  assert.ok(!html.includes('text-shadow'), 'shadow suppressed on outline-only text');
});

test('filled text with textStroke keeps its fill color (stroke + fill compose)', () => {
  const html = renderDesignHtml(doc([{
    id: 'filled-outline', type: 'text', text: 'BLACK', box: { x: 100, y: 100, w: 800, h: 160 },
    style: { fontSize: 170, color: '#2B3BEB', textStroke: { color: '#111111', width: 2 } },
  }]));
  assert.ok(html.includes('-webkit-text-stroke:2px #111111'), 'stroke emitted');
  assert.ok(html.includes('color:#2B3BEB'), 'fill color kept');
});
