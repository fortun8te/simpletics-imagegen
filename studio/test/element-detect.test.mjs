// test/element-detect.test.mjs — S4 residual-CC element detection (lib/element-detect.mjs).
//
// Synthetic cases exercise: residual vs a flat/gradient/raw background, the dilated
// text mask, the OCR-CC drop rule (≥90% overlap), the photoRegion drop rule (>60%
// inside), minArea, kind heuristics, and the null-background border-median fallback.
// Real-corpus cases (skip gracefully when ~/Downloads/IMAGE AD INSPO/ or bin/ocrjson is
// absent) run cases 016 (flat yellow bg — null-background fallback path) and 018 (dark
// gradient+stripes bg — approximated by a row-median "reconstruction" passed as raw
// background pixels, the S9-shaped input). Each real case PRINTS its element list and
// writes a box overlay PNG to .state/element-detect-debug/<id>.png for eyeballing.
//
// Run standalone: node test/element-detect.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectElements, estimateBorderColor } from '../lib/element-detect.mjs';

const STUDIO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------------------------
// synthetic helpers
// ---------------------------------------------------------------------------------------------

function flat(w, h, rgb) {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) { data[i * 4] = rgb[0]; data[i * 4 + 1] = rgb[1]; data[i * 4 + 2] = rgb[2]; data[i * 4 + 3] = 255; }
  return { data, width: w, height: h };
}
function drawRect(px, x0, y0, w, h, rgb) {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
    const i = (y * px.width + x) * 4;
    px.data[i] = rgb[0]; px.data[i + 1] = rgb[1]; px.data[i + 2] = rgb[2];
  }
}

// ---------------------------------------------------------------------------------------------
// synthetic tests
// ---------------------------------------------------------------------------------------------

test('a solid square on a flat background is detected as a shape with a tight box', () => {
  const px = flat(200, 200, [40, 80, 200]);
  drawRect(px, 60, 70, 40, 30, [230, 40, 40]);
  const { elements } = detectElements(px, { background: { kind: 'flat', color: '#2850c8' } });
  assert.equal(elements.length, 1);
  const e = elements[0];
  assert.equal(e.kind, 'shape');
  assert.ok(Math.abs(e.box.x - 60) <= 2 && Math.abs(e.box.y - 70) <= 2, `box ${JSON.stringify(e.box)}`);
  assert.ok(Math.abs(e.box.w - 40) <= 4 && Math.abs(e.box.h - 30) <= 4, `box ${JSON.stringify(e.box)}`);
  assert.ok(e.area >= 40 * 30 * 0.9, `area ${e.area}`);
  assert.ok(e.mask.data.length === e.box.w * e.box.h, 'mask is box-local');
  assert.ok(e.coverage > 0 && e.coverage < 0.05, `coverage ${e.coverage}`);
});

test('null background falls back to border-median flat (element still found)', () => {
  const px = flat(200, 200, [250, 240, 160]); // yellow-ish page
  drawRect(px, 100, 100, 50, 50, [30, 60, 30]);
  assert.deepEqual(estimateBorderColor(px), [250, 240, 160]);
  const { elements } = detectElements(px, { background: null });
  assert.equal(elements.length, 1);
  assert.equal(elements[0].kind, 'shape');
});

test('raw background pixels explain a gradient; only the foreign blob remains', () => {
  const w = 200, h = 200;
  const bgPx = flat(w, h, [0, 0, 0]);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4; const v = Math.round((y / (h - 1)) * 200);
    bgPx.data[i] = v; bgPx.data[i + 1] = v; bgPx.data[i + 2] = 60;
  }
  const src = { data: new Uint8Array(bgPx.data), width: w, height: h };
  drawRect(src, 30, 140, 40, 40, [240, 240, 240]);
  const { elements } = detectElements(src, { background: bgPx });
  assert.equal(elements.length, 1);
  assert.ok(Math.abs(elements[0].box.x - 30) <= 2 && Math.abs(elements[0].box.y - 140) <= 2);
});

test('text-line boxes are masked out; a CC ≥90% inside an OCR box is dropped', () => {
  const px = flat(300, 200, [255, 255, 255]);
  drawRect(px, 40, 40, 100, 20, [20, 20, 20]);   // "text" the OCR saw
  drawRect(px, 200, 120, 40, 40, [200, 30, 30]); // a real element
  const textLines = [{ box: { x: 38, y: 38, w: 104, h: 24 } }];
  const { elements } = detectElements(px, { textLines, background: { kind: 'flat', color: '#ffffff' } });
  assert.equal(elements.length, 1, 'only the non-text blob survives');
  assert.ok(elements[0].box.x >= 190);
  // and with dilation disabled, the ≥0.9-overlap OCR-CC rule itself must drop it
  const { elements: e2 } = detectElements(px, { textLines, background: { kind: 'flat', color: '#ffffff' }, opts: { textDilate: 0 } });
  assert.equal(e2.length, 1, 'OCR-CC overlap rule drops the text blob');
});

test('a CC >60% inside a declared photoRegion is dropped', () => {
  const px = flat(300, 300, [255, 255, 255]);
  drawRect(px, 50, 50, 60, 60, [90, 140, 90]);   // inside the photo
  drawRect(px, 200, 200, 60, 60, [90, 140, 90]); // outside
  const photoRegions = [{ x: 30, y: 30, w: 120, h: 120 }];
  const { elements } = detectElements(px, { background: { kind: 'flat', color: '#ffffff' }, photoRegions });
  assert.equal(elements.length, 1);
  assert.ok(elements[0].box.x >= 190, 'the in-photo CC was dropped');
});

test('CCs under 24 px² are dropped; nested CCs consolidate into their host', () => {
  const px = flat(300, 300, [255, 255, 255]);
  drawRect(px, 10, 10, 4, 4, [0, 0, 0]); // 16 px² < 24 ⇒ dropped
  // ring + inner dot = one visual element (ring interior matches bg)
  drawRect(px, 100, 100, 80, 80, [30, 30, 200]);
  drawRect(px, 110, 110, 60, 60, [255, 255, 255]); // punch the interior
  drawRect(px, 130, 130, 20, 20, [30, 30, 200]);   // inner mark
  const { elements } = detectElements(px, { background: { kind: 'flat', color: '#ffffff' } });
  assert.equal(elements.length, 1, `ring+mark consolidated, speck dropped (got ${elements.length})`);
  assert.ok(elements[0].box.w >= 78 && elements[0].box.h >= 78, 'host box kept');
});

test('degenerate input: empty image / no residual never throws', () => {
  assert.deepEqual(detectElements({ data: new Uint8Array(0), width: 0, height: 0 }, {}).elements, []);
  const px = flat(50, 50, [128, 128, 128]);
  assert.deepEqual(detectElements(px, { background: { kind: 'flat', color: '#808080' } }).elements, []);
});

// ---------------------------------------------------------------------------------------------
// real-corpus cases (skip when corpus or OCR binary is unavailable)
// ---------------------------------------------------------------------------------------------

const CORPUS = path.join(homedir(), 'Downloads', 'IMAGE AD INSPO');
const corpusSource = (id) => {
  try {
    const hit = readdirSync(CORPUS).find((f) => f.startsWith(`${id}_`) && /\.(png|jpe?g|webp)$/i.test(f));
    return hit ? path.join(CORPUS, hit) : null;
  } catch { return null; }
};

/** Row-median background — a cheap stand-in for the S9 reconstruction: per row, the
 *  per-channel median explains page gradients and full-width bands, not the subjects. */
function rowMedianBackground(px) {
  const { data, width, height } = px;
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const rs = [], gs = [], bs = [];
    for (let x = 0; x < width; x++) { const i = (y * width + x) * 4; rs.push(data[i]); gs.push(data[i + 1]); bs.push(data[i + 2]); }
    const med = (a) => a.sort((p, q) => p - q)[a.length >> 1];
    const r = med(rs), g = med(gs), b = med(bs);
    for (let x = 0; x < width; x++) { const i = (y * width + x) * 4; out[i] = r; out[i + 1] = g; out[i + 2] = b; out[i + 3] = 255; }
  }
  return { data: out, width, height };
}

const boxesIntersect = (a, b) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

async function runCase(id, makeBackground, opts) {
  const img = corpusSource(id);
  if (!img) return null;
  const { recognizeText } = await import('../lib/ocr.mjs');
  const facts = await recognizeText(img);
  if (!facts.ok) return null;
  const sharp = (await import('sharp')).default;
  const { data, info } = await sharp(img).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const pixels = { data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), width: info.width, height: info.height };
  const background = makeBackground ? makeBackground(pixels) : null;
  const { elements } = detectElements(pixels, { textLines: facts.lines, background, opts });
  console.log(`\n  [${id}] ${elements.length} elements`);
  for (const e of elements) {
    console.log(`    ${e.id} ${e.kind} [${e.box.x},${e.box.y} ${e.box.w}x${e.box.h}] area=${e.area} cov=${e.coverage} sol=${e.stats.solidity} colors=${e.stats.domColors} edge=${e.stats.edgeDensity}`);
  }
  // debug overlay for visual verification
  const dbgDir = path.join(STUDIO, '.state', 'element-detect-debug');
  mkdirSync(dbgDir, { recursive: true });
  const colors = { shape: '#00c8ff', icon: '#ff37c8', 'photo-fragment': '#ffd400' };
  const rects = elements.map((e) =>
    `<rect x="${e.box.x}" y="${e.box.y}" width="${e.box.w}" height="${e.box.h}" fill="none" stroke="${colors[e.kind]}" stroke-width="4"/>` +
    `<text x="${e.box.x + 4}" y="${Math.max(18, e.box.y - 6)}" font-size="24" fill="${colors[e.kind]}" font-family="monospace">${e.id}:${e.kind}</text>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${pixels.width}" height="${pixels.height}">${rects}</svg>`;
  const out = path.join(dbgDir, `${id}.png`);
  await sharp(img).composite([{ input: Buffer.from(svg) }]).png().toFile(out);
  console.log(`    overlay → ${out}`);
  return { elements, pixels };
}

test('corpus 018 — three earplug photos, CTA pill, reddot badge', { skip: !corpusSource('018') }, async () => {
  // stripes-over-gradient background ⇒ pass a row-median reconstruction as raw bg
  // pixels; lumaThresh raised to 22 to absorb the diagonal-stripe-edge mismatch of
  // that approximation (the fitted S5/S9 background will not have this error).
  const r = await runCase('018', rowMedianBackground, { lumaThresh: 22 });
  if (!r) return;
  assert.ok(r.elements.length >= 3 && r.elements.length <= 9, `element count ${r.elements.length} in 3..9`);
  const productZones = [
    { x: 650, y: 250, w: 430, h: 350 },  // white earplug, top right
    { x: 0, y: 500, w: 350, h: 350 },    // blue/black earplug, mid left
    { x: 650, y: 780, w: 430, h: 340 },  // black earplug, bottom right
  ];
  for (const z of productZones) {
    const hit = r.elements.find((e) => e.area > 15000 && boxesIntersect(e.box, z));
    assert.ok(hit, `large element in product zone ${JSON.stringify(z)}`);
  }
  const pill = r.elements.find((e) => boxesIntersect(e.box, { x: 370, y: 1100, w: 340, h: 75 }) && e.area > 5000);
  assert.ok(pill, 'CTA pill detected');
  const reddot = r.elements.find((e) => boxesIntersect(e.box, { x: 460, y: 1200, w: 180, h: 120 }) && e.area > 500);
  assert.ok(reddot, 'reddot badge detected');
});

test('corpus 016 — gummy-bear/bag area and callout arrows on the flat yellow bg', { skip: !corpusSource('016') }, async () => {
  const r = await runCase('016', null); // null bg exercises the border-median fallback
  if (!r) return;
  assert.ok(r.elements.length >= 2 && r.elements.length <= 10, `element count ${r.elements.length} in 2..10`);
  // the product area (bears row + visible bag top + the 45% badge riding on it)
  const bag = r.elements.find((e) => e.kind === 'photo-fragment' && e.box.w > 700 && e.box.y > 150 && e.area > 100000);
  assert.ok(bag, 'bag/bear-row element detected');
  assert.ok(boxesIntersect(bag.box, { x: 770, y: 560, w: 220, h: 220 }), 'the 45% badge area is inside the detected product element');
  // at least one thin black callout arrow surfaces as an icon
  const arrow = r.elements.find((e) => e.kind === 'icon' && e.box.y > 300 && e.box.y < 500 && e.area < 5000);
  assert.ok(arrow, 'a callout arrow surfaces as an icon element');
});
