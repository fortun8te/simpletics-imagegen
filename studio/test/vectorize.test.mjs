// test/vectorize.test.mjs — lib/vectorize.mjs: path normalization to the absolute-M/L/C/Z
// contract, SVG parsing (vtracer + imagetracerjs dialects), the pure-JS scanline rasterizer,
// raster-back scoring, and the end-to-end quality gate on synthetic fixtures (flat star+ring
// must vectorize; photo noise must be refused). Engine-agnostic: every gate assert runs on the
// imagetracerjs fallback so the suite passes with vtracer absent; a vtracer run is added only
// when .state/bin/vtracer exists. Trace tests skip when sharp is unavailable (matte.test.mjs
// pattern).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  vectorizeElement, toAbsoluteCubicPath, parseFillColor, parseEngineSvg, mergeAdjacentFills,
  flattenAbsPath, rasterizePathsJS, scoreAgainstSource, pathsToSvg,
  VEC_MIN_SCORE, VEC_MAX_PATHS, VEC_MAX_D_BYTES,
} from '../lib/vectorize.mjs';

let sharp = null;
try { sharp = (await import('sharp')).default; } catch { sharp = null; }

const VTRACER = join(dirname(fileURLToPath(import.meta.url)), '..', '.state', 'bin', 'vtracer');

/** d-string contract check: absolute M/L/C/Z only, starts with M, all args numeric. */
function assertContractD(d) {
  assert.ok(d.startsWith('M'), `d must start with M: ${d.slice(0, 40)}`);
  const toks = d.split(/\s+/);
  let i = 0;
  while (i < toks.length) {
    const t = toks[i];
    if (t === 'M' || t === 'L') { assert.ok(isFinite(+toks[i + 1]) && isFinite(+toks[i + 2]), `bad ${t} args`); i += 3; }
    else if (t === 'C') { for (let k = 1; k <= 6; k++) assert.ok(isFinite(+toks[i + k]), 'bad C args'); i += 7; }
    else if (t === 'Z') { i += 1; }
    else assert.fail(`non-contract token "${t}" in d-string (only absolute M/L/C/Z allowed)`);
  }
  assert.equal(toks[toks.length - 1], 'Z', 'd must end with Z');
}

// ── path normalization ────────────────────────────────────────────────────────────────────────

test('toAbsoluteCubicPath: relative commands become absolute', () => {
  assert.equal(toAbsoluteCubicPath('m 10 10 l 5 0 l 0 5 z'), 'M 10 10 L 15 10 L 15 15 Z');
});

test('toAbsoluteCubicPath: H/V collapse to L', () => {
  assert.equal(toAbsoluteCubicPath('M 0 0 H 10 V 10 h -10 Z'), 'M 0 0 L 10 0 L 10 10 L 0 10 Z');
});

test('toAbsoluteCubicPath: Q converts to exact cubic (degree elevation)', () => {
  const d = toAbsoluteCubicPath('M 0 0 Q 30 0 30 30 Z');
  assert.equal(d, 'M 0 0 C 20 0 30 10 30 30 Z'); // 2/3 control interpolation
});

test('toAbsoluteCubicPath: translate + scale transform applied to all coords', () => {
  assert.equal(toAbsoluteCubicPath('M 10 10 L 20 10 Z', { tx: 5, ty: -5, scale: 0.5 }),
    'M 7.5 2.5 L 12.5 2.5 Z');
});

test('toAbsoluteCubicPath: implicit lineto after multi-pair M', () => {
  assert.equal(toAbsoluteCubicPath('M 0 0 10 0 10 10 Z'), 'M 0 0 L 10 0 L 10 10 Z');
});

// ── SVG parsing (both engine dialects) ────────────────────────────────────────────────────────

test('parseFillColor: hex6 / hex3 / rgb() / none', () => {
  assert.deepEqual(parseFillColor('#2d9b78'), [45, 155, 120]);
  assert.deepEqual(parseFillColor('#fff'), [255, 255, 255]);
  assert.deepEqual(parseFillColor('rgb(1, 2,3)'), [1, 2, 3]);
  assert.equal(parseFillColor('none'), null);
});

test('parseEngineSvg: vtracer dialect (hex fill + translate transform)', () => {
  const svg = '<svg><path d="M0 0 C1 0 2 1 2 2 Z" fill="#123456" transform="translate(10,20)"/></svg>';
  const paths = parseEngineSvg(svg);
  assert.equal(paths.length, 1);
  assert.equal(paths[0].fill, '#123456');
  assert.equal(paths[0].d, 'M 10 20 C 11 20 12 21 12 22 Z');
});

test('parseEngineSvg: imagetracer dialect (rgb fill, opacity noise filtered, scale)', () => {
  const svg = '<svg><path fill="rgb(200,10,10)" stroke="none" opacity="1" d="M 2 2 L 6 2 L 6 6 Z"/>'
    + '<path fill="rgb(1,1,1)" opacity="0.1" d="M 0 0 L 1 0 L 1 1 Z"/></svg>';
  const paths = parseEngineSvg(svg, { scale: 0.5 });
  assert.equal(paths.length, 1, 'sub-half-opacity layer dropped');
  assert.equal(paths[0].d, 'M 1 1 L 3 1 L 3 3 Z');
});

test('mergeAdjacentFills: consecutive same-fill paths collapse into one multi-subpath d', () => {
  const merged = mergeAdjacentFills([
    { d: 'M 0 0 L 1 0 L 1 1 Z', fill: '#111111' },
    { d: 'M 2 2 L 3 2 L 3 3 Z', fill: '#111111' },
    { d: 'M 4 4 L 5 4 L 5 5 Z', fill: '#222222' },
  ]);
  assert.equal(merged.length, 2);
  assert.equal((merged[0].d.match(/M/g) || []).length, 2);
});

// ── pure-JS rasterizer + scoring ──────────────────────────────────────────────────────────────

test('rasterizePathsJS: fills a square, honors nonzero holes, tracks top-most index', () => {
  const outer = 'M 2 2 L 14 2 L 14 14 L 2 14 Z M 6 6 L 6 10 L 10 10 L 10 6 Z'; // hole reverse-wound
  const { data, idx } = rasterizePathsJS([{ d: outer, fill: '#ff0000' }], 16, 16);
  const at = (x, y) => (y * 16 + x);
  assert.equal(data[at(4, 4) * 4], 255, 'ring area filled red');
  assert.equal(data[at(4, 4) * 4 + 3], 255);
  assert.equal(data[at(8, 8) * 4 + 3], 0, 'hole stays empty (nonzero winding)');
  assert.equal(idx[at(4, 4)], 0);
  assert.equal(idx[at(8, 8)], -1);
  assert.equal(idx[at(0, 0)], -1, 'outside untouched');
});

test('rasterizePathsJS: later paths paint over earlier (stacked order)', () => {
  const sq = (x0, y0, s) => `M ${x0} ${y0} L ${x0 + s} ${y0} L ${x0 + s} ${y0 + s} L ${x0} ${y0 + s} Z`;
  const { data, idx } = rasterizePathsJS(
    [{ d: sq(0, 0, 12), fill: '#0000ff' }, { d: sq(4, 4, 4), fill: '#00ff00' }], 12, 12);
  assert.equal(data[(6 * 12 + 6) * 4 + 1], 255, 'top square wins');
  assert.equal(idx[6 * 12 + 6], 1);
  assert.equal(idx[1 * 12 + 1], 0);
});

test('flattenAbsPath: cubic flattens to a polyline ending at the endpoint', () => {
  const loops = flattenAbsPath('M 0 0 C 10 0 20 10 20 20 L 0 20 Z');
  assert.equal(loops.length, 1);
  const pts = loops[0];
  assert.deepEqual(pts[0], [0, 0]);
  assert.ok(pts.some(([x, y]) => Math.abs(x - 20) < 1e-9 && Math.abs(y - 20) < 1e-9), 'curve endpoint reached');
});

test('scoreAgainstSource: identical → 1, transparent source pixels excluded', () => {
  const w = 4, h = 4;
  const a = new Uint8ClampedArray(w * h * 4).fill(255);
  assert.equal(scoreAgainstSource(a, a, w, h), 1);
  const b = new Uint8ClampedArray(a);
  b.fill(0, 0, 4); b[3] = 255; // one black pixel vs white → score drops but stays < 1
  const s = scoreAgainstSource(a, b, w, h);
  assert.ok(s < 1 && s > 0.9, `one-pixel diff scored ${s}`);
  a[3] = 0; // make that source pixel transparent → excluded → back to 1
  assert.equal(scoreAgainstSource(a, b, w, h), 1);
});

// ── end-to-end gate (imagetracerjs fallback — must pass with vtracer absent) ──────────────────

const STAR = '#e63946', RING = '#1d3557';

/** Deterministic two-color fixture: dark ring + red 5-point star on white, 256×256. */
async function starRingPng() {
  const pts = [];
  for (let k = 0; k < 10; k++) {
    const a = -Math.PI / 2 + (k * Math.PI) / 5;
    const r = k % 2 ? 36 : 88;
    pts.push(`${(128 + r * Math.cos(a)).toFixed(1)},${(128 + r * Math.sin(a)).toFixed(1)}`);
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256">`
    + `<rect width="256" height="256" fill="#ffffff"/>`
    + `<circle cx="128" cy="128" r="108" fill="none" stroke="${RING}" stroke-width="14"/>`
    + `<polygon points="${pts.join(' ')}" fill="${STAR}"/></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/** Deterministic RGB noise (seeded LCG) — a stand-in for a photo crop that must be refused. */
function noisePixels(w = 128, h = 128) {
  let seed = 42;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = rnd() * 255; data[i + 1] = rnd() * 255; data[i + 2] = rnd() * 255; data[i + 3] = 255;
  }
  return { data, width: w, height: h };
}

const closeTo = (hex, target, tol = 10) => {
  const a = parseFillColor(hex), b = parseFillColor(target);
  return a && b && a.every((v, i) => Math.abs(v - b[i]) <= tol);
};

for (const engine of ['imagetracer', ...(existsSync(VTRACER) ? ['vtracer'] : [])]) {
  test(`vectorizeElement(${engine}): star+ring passes the gate with faithful fills`, { skip: !sharp && 'sharp unavailable' }, async () => {
    const res = await vectorizeElement(await starRingPng(), { engine });
    assert.equal(res.ok, true, `expected ok:true, got: ${res.reason}`);
    assert.equal(res.engine, engine);
    assert.deepEqual(res.viewBox, { w: 256, h: 256 });
    assert.ok(res.paths.length >= 2 && res.paths.length <= 8, `expected 2..8 paths, got ${res.paths.length}`);
    assert.ok(res.score >= 0.93, `expected score ≥ 0.93, got ${res.score.toFixed(3)}`);
    for (const p of res.paths) assertContractD(p.d);
    assert.ok(res.paths.some((p) => closeTo(p.fill, STAR)), `no fill near ${STAR}: ${res.paths.map((p) => p.fill)}`);
    assert.ok(res.paths.some((p) => closeTo(p.fill, RING)), `no fill near ${RING}: ${res.paths.map((p) => p.fill)}`);
  });

  test(`vectorizeElement(${engine}): photo noise is refused (honest negative)`, { skip: !sharp && 'sharp unavailable' }, async () => {
    const res = await vectorizeElement(noisePixels(), { engine });
    assert.equal(res.ok, false);
    assert.ok(res.reason, 'refusal carries a reason');
    assert.ok(res.score < VEC_MIN_SCORE, `refused result must not report a passing score (${res.score})`);
  });
}

test('vectorizeElement: box option crops raw pixels before tracing', { skip: !sharp && 'sharp unavailable' }, async () => {
  // 64×64 red square centered in a 256×256 noise field — the box isolates the flat square
  const px = noisePixels(256, 256);
  for (let y = 96; y < 160; y++) {
    for (let x = 96; x < 160; x++) {
      const i = (y * 256 + x) * 4;
      px.data[i] = 220; px.data[i + 1] = 30; px.data[i + 2] = 40; px.data[i + 3] = 255;
    }
  }
  const res = await vectorizeElement(px, { box: { x: 96, y: 96, w: 64, h: 64 }, engine: 'imagetracer' });
  assert.equal(res.ok, true, `expected ok:true, got: ${res.reason}`);
  assert.deepEqual(res.viewBox, { w: 64, h: 64 });
  assert.ok(res.paths.some((p) => closeTo(p.fill, '#dc1e28', 14)), `fills: ${res.paths.map((p) => p.fill)}`);
});

test('vectorizeElement: garbage input fails gracefully (never throws)', async () => {
  assert.equal((await vectorizeElement(null)).ok, false);
  assert.equal((await vectorizeElement({ data: new Uint8Array(10), width: 100, height: 100 })).ok, false);
  assert.equal((await vectorizeElement(Buffer.from('not a png'))).ok, false);
});

test('gate constants stay within the vectorize contract', () => {
  assert.equal(VEC_MIN_SCORE, 0.90);
  assert.equal(VEC_MAX_PATHS, 40);
  assert.equal(VEC_MAX_D_BYTES, 60_000);
});
