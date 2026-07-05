// test/scene-truth.test.mjs — PIXEL-TRUTH pass (lib/scene-truth.mjs).
// The reader's ESTIMATES for measurable attributes (bg color, fill color, text color, font size,
// alignment) must be overridden by MEASUREMENTS from the reference pixels — and only then:
// gradients, photo backgrounds, cutout crops, and ambiguous (contrast-less) boxes stay untouched.
// Run: node --test test/scene-truth.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { applySceneTruth } from '../lib/scene-truth.mjs';

/** Write a minimal valid 8-bit RGB PNG of w×h where pixel(x,y) = fill(x,y) -> [r,g,b].
 *  (Same pattern as test/extract-photo-region.test.mjs.) */
function writeRgbPng(path, w, h, fill) {
  const crc32 = (buf) => { let c = ~0; for (let i = 0; i < buf.length; i++) { c ^= buf[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return (~c) >>> 0; };
  const chunk = (type, data) => { const t = Buffer.from(type, 'ascii'); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const [r, g, b] = fill(x, y);
      const p = y * (w * 3 + 1) + 1 + x * 3;
      raw[p] = r & 0xff; raw[p + 1] = g & 0xff; raw[p + 2] = b & 0xff;
    }
  }
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  writeFileSync(path, png);
}

// deterministic pseudo-random (no Math.random — reproducible test)
function prng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

const hexDist = (a, b) => {
  const p = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const [r1, g1, b1] = p(a.toLowerCase()), [r2, g2, b2] = p(b.toLowerCase());
  return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2) / 441.67295593;
};

const dir = mkdtempSync(join(tmpdir(), 'scene-truth-'));

test('page background: wrong reader hex is corrected from border pixels (and theme follows)', () => {
  const p = join(dir, 'bg.png');
  writeRgbPng(p, 400, 400, () => [0x10, 0x23, 0x3a]); // dark navy everywhere
  const ext = {
    ok: true, canvas: { w: 400, h: 400 },
    background: '#ffffff', backgroundIsPhoto: false, theme: 'light',
    layers: [{ id: 'headline', type: 'text', role: 'headline', text: 'Hello', box: { x: 150, y: 180, w: 100, h: 40 }, style: { fontSize: 24, color: '#ffffff' } }],
  };
  const { ext: out, corrections } = applySceneTruth(ext, p);
  assert.ok(hexDist(out.background, '#10233a') < 0.05, `background measured, got ${out.background}`);
  assert.equal(out.theme, 'dark', 'theme follows the measured (dark) background');
  assert.ok(corrections.some((c) => /background/i.test(c)), 'background correction reported');
});

test('card fill: hallucinated interior color overridden; text child sub-region excluded', () => {
  const p = join(dir, 'card.png');
  writeRgbPng(p, 400, 400, () => [0xf1, 0xf3, 0xf5]); // real fill is light grey everywhere
  const ext = {
    ok: true, canvas: { w: 400, h: 400 }, background: '#f1f3f5', backgroundIsPhoto: false,
    layers: [
      { id: 'panel', type: 'shape', role: 'card', box: { x: 40, y: 40, w: 320, h: 320 }, style: { background: '#19a5b8' } }, // hallucinated teal
      { id: 'panel-text', type: 'text', role: 'body', text: 'inside', box: { x: 170, y: 190, w: 60, h: 20 }, style: { fontSize: 14, color: '#333333' } },
    ],
  };
  const { ext: out, corrections } = applySceneTruth(ext, p);
  const panel = out.layers.find((l) => l.id === 'panel');
  assert.ok(hexDist(panel.style.background, '#f1f3f5') < 0.05, `fill measured, got ${panel.style.background}`);
  assert.ok(corrections.some((c) => /panel fill/i.test(c)), 'fill correction reported');
});

test('text color: glyph minority cluster overrides the reader; ambiguous box keeps reader color', () => {
  const p = join(dir, 'text.png');
  // white page; inside the text box rows 165..194 carry dark-red "glyph" stripes (1 of 3 columns)
  writeRgbPng(p, 400, 400, (x, y) => {
    if (y >= 165 && y < 195 && x >= 60 && x < 340 && x % 3 === 0) return [0xb0, 0x12, 0x12];
    return [0xff, 0xff, 0xff];
  });
  const ext = {
    ok: true, canvas: { w: 400, h: 400 }, background: '#ffffff', backgroundIsPhoto: false,
    layers: [
      { id: 'claim', type: 'text', role: 'headline', text: 'Real ink', box: { x: 50, y: 150, w: 300, h: 60 }, style: { fontSize: 30, color: '#000000' } },
      // ambiguous: a box over the flat white page — zero contrast, sampler must NOT touch it
      { id: 'ghost', type: 'text', role: 'caption', text: 'ghost', box: { x: 50, y: 300, w: 200, h: 40 }, style: { fontSize: 20, color: '#123456' } },
    ],
  };
  const { ext: out, corrections } = applySceneTruth(ext, p);
  const claim = out.layers.find((l) => l.id === 'claim');
  const ghost = out.layers.find((l) => l.id === 'ghost');
  assert.ok(hexDist(claim.style.color, '#b01212') < 0.08, `glyph color measured, got ${claim.style.color}`);
  assert.equal(ghost.style.color, '#123456', 'ambiguous (contrast-less) box keeps the reader color');
  assert.ok(corrections.some((c) => /claim color/i.test(c)), 'text color correction reported');
});

test('font size: derived from ink rows within tolerance (2 lines, 60px baseline pitch → ~48px)', () => {
  const p = join(dir, 'font.png');
  // two full-width "text lines" of 20 ink rows each, tops at y=110 and y=170 → pitch 60 → fs≈48
  writeRgbPng(p, 400, 400, (x, y) => {
    const inLine = (y >= 110 && y < 130) || (y >= 170 && y < 190);
    if (inLine && x >= 60 && x < 340 && x % 2 === 0) return [0x11, 0x11, 0x11];
    return [0xff, 0xff, 0xff];
  });
  const ext = {
    ok: true, canvas: { w: 400, h: 400 }, background: '#ffffff', backgroundIsPhoto: false,
    layers: [
      { id: 'headline', type: 'text', role: 'headline', text: 'Two lines of text here', box: { x: 50, y: 100, w: 300, h: 150 }, style: { fontSize: 60, color: '#111111' } },
    ],
  };
  const { ext: out, corrections } = applySceneTruth(ext, p);
  const h = out.layers.find((l) => l.id === 'headline');
  assert.ok(Math.abs(h.style.fontSize - 48) <= 5, `fontSize derived near 48, got ${h.style.fontSize}`);
  assert.ok(h.box.h < 150, `box snapped to tight ink bounds + padding, got h=${h.box.h}`);
  assert.ok(corrections.some((c) => /fontSize/i.test(c)), 'fontSize correction reported');
});

test('alignment: near-center text snaps to exact canvas center; sibling left margins equalized', () => {
  const p = join(dir, 'align.png');
  writeRgbPng(p, 400, 400, () => [0xee, 0xee, 0xee]); // flat — no ink, so ONLY alignment moves boxes
  const ext = {
    ok: true, canvas: { w: 400, h: 400 }, background: '#eeeeee', backgroundIsPhoto: false,
    layers: [
      // center-x = 197, canvas center 200, off by 3px (< 2.5% of 400 = 10px) → snap to x=190
      { id: 'title', type: 'text', role: 'headline', text: 'Almost centered', box: { x: 187, y: 40, w: 20, h: 20 }, style: { fontSize: 16, color: '#111111', align: 'center' } },
      // left-margin siblings: 60, 60, 63 → mode 60 (63 differs < 1.5% of 400 = 6px)
      { id: 'line-a', type: 'text', role: 'body', text: 'aaa', box: { x: 60, y: 120, w: 100, h: 20 }, style: { fontSize: 16, color: '#111111' } },
      { id: 'line-b', type: 'text', role: 'body', text: 'bbb', box: { x: 60, y: 150, w: 100, h: 20 }, style: { fontSize: 16, color: '#111111' } },
      { id: 'line-c', type: 'text', role: 'body', text: 'ccc', box: { x: 63, y: 180, w: 100, h: 20 }, style: { fontSize: 16, color: '#111111' } },
    ],
  };
  const { ext: out, corrections } = applySceneTruth(ext, p);
  const title = out.layers.find((l) => l.id === 'title');
  const lineC = out.layers.find((l) => l.id === 'line-c');
  assert.equal(title.box.x, 190, 'center-x snapped exactly to canvas center');
  assert.equal(lineC.box.x, 60, 'left margin equalized to the sibling group mode');
  assert.equal(out.layers.map((l) => l.id).join(','), 'title,line-a,line-b,line-c', 'reading order preserved');
  assert.ok(corrections.some((c) => /center-x snapped/.test(c)), 'center snap reported');
  assert.ok(corrections.some((c) => /left margin/.test(c)), 'margin equalization reported');
});

test('untouchables: photo background, gradient fill, and cutoutCandidate layers stay as-read', () => {
  const p = join(dir, 'untouched.png');
  const rand = prng(7);
  // left half = busy photo texture, right half = flat grey
  writeRgbPng(p, 400, 400, (x) => {
    if (x < 200) return [Math.floor(rand() * 256), Math.floor(rand() * 256), Math.floor(rand() * 256)];
    return [0xcc, 0xcc, 0xcc];
  });
  const ext = {
    ok: true, canvas: { w: 400, h: 400 },
    background: '#ff00ff', backgroundIsPhoto: true, // photo bg — must NOT be "corrected"
    layers: [
      // cutout crop over the photo half: its placeholder tint is not a claim — never overridden
      { id: 'photo', type: 'shape', role: 'product', box: { x: 0, y: 0, w: 200, h: 400 }, style: { background: '#777777' }, cutoutCandidate: { region: { x: 0, y: 0, w: 0.5, h: 1 }, shape: 'rect' } },
      // gradient fill (object form) over the flat half — gradients are skipped, not flattened
      { id: 'grad', type: 'shape', role: 'card', box: { x: 220, y: 40, w: 160, h: 320 }, style: { background: { from: '#000000', to: '#ffffff' } } },
    ],
  };
  const { ext: out, corrections } = applySceneTruth(ext, p);
  assert.equal(out.background, '#ff00ff', 'photo background untouched');
  assert.equal(out.layers.find((l) => l.id === 'photo').style.background, '#777777', 'cutout layer tint untouched');
  assert.deepEqual(out.layers.find((l) => l.id === 'grad').style.background, { from: '#000000', to: '#ffffff' }, 'gradient fill untouched');
  assert.ok(!corrections.some((c) => /photo|grad|background/i.test(c)), `no corrections for untouchables, got: ${corrections.join(' | ')}`);
});

test('never throws: garbage ext / missing image / broken boxes are best-effort no-ops', () => {
  assert.doesNotThrow(() => applySceneTruth(null, '/nope/missing.png'));
  assert.doesNotThrow(() => applySceneTruth({ layers: 'not-an-array' }, '/nope/missing.png'));
  const r = applySceneTruth({ ok: true, canvas: { w: 400, h: 400 }, background: '#fff', layers: [{ type: 'text', text: 'x', box: { x: NaN, y: 0, w: -5, h: 0 }, style: {} }] }, join(dir, 'bg.png'));
  assert.ok(Array.isArray(r.corrections));
});
