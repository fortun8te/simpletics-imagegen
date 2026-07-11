// test/fill-fit.test.mjs — S5 parametric fill fitting (lib/fill-fit.mjs).
//
// Synthetic cases are generated with raw math + a deterministic PRNG so every run is identical:
// (a) flat + gaussian noise, (b) 2-stop linear at 37°, (c) 3-stop linear with dither noise,
// (d) off-center radial, (e) a REAL corpus photo crop must come back 'photo', (f) solveScrim must
// recover a flat 55% black scrim and a to-top black gradient scrim over a real photo crop.
// The real-image cases (e)/(f) skip gracefully when the corpus source image (kept in
// .state/vision-tmp/, gitignored) is not present on this machine.
//
// Run standalone: node test/fill-fit.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { fitRegionFill, solveScrim, loadPixels, renderFill } from '../lib/fill-fit.mjs';

const STUDIO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------------------------
// synthesis helpers (deterministic)
// ---------------------------------------------------------------------------------------------

function makePixels(w, h, fn) {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = fn(x, y);
      const i = (y * w + x) * 4;
      data[i] = clampByte(r); data[i + 1] = clampByte(g); data[i + 2] = clampByte(b); data[i + 3] = 255;
    }
  }
  return { data, width: w, height: h };
}
const clampByte = (v) => Math.max(0, Math.min(255, Math.round(v)));

function prng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}
function gaussian(rnd) {
  const u = Math.max(rnd(), 1e-9), v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const hexRgb = (hex) => [1, 3, 5].map((p) => parseInt(hex.slice(p, p + 2), 16));

// simple ΔE-ish per-channel distance (max abs channel diff)
const maxChanDiff = (hexA, hexB) => {
  const a = hexRgb(hexA), b = hexRgb(hexB);
  return Math.max(...a.map((c, i) => Math.abs(c - b[i])));
};

// locate a corpus source image (only .webp/.png/.jpg starting with "<id>_"); they live in
// .state/vision-tmp on the machines that ran the harness — skip real-image tests when absent
function findCorpusSource(id) {
  const dir = path.join(STUDIO, '.state', 'vision-tmp');
  try {
    const hit = readdirSync(dir).filter((f) => f.startsWith(`${id}_`) && /\.(png|jpe?g|webp)$/i.test(f)).sort()[0];
    return hit ? path.join(dir, hit) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// (a) flat + noise
// ---------------------------------------------------------------------------------------------

test('(a) flat #3450a2 with gaussian noise σ4 → flat verdict, color within ~ΔE3', () => {
  const rnd = prng(42);
  const img = makePixels(200, 150, () => [52, 80, 162].map((c) => c + gaussian(rnd) * 4));
  const fit = fitRegionFill(img, null);
  assert.equal(fit.kind, 'flat');
  assert.ok(maxChanDiff(fit.color, '#3450a2') <= 5, `color ${fit.color} vs #3450a2`);
  assert.ok(fit.residual < 5, `residual ${fit.residual}`);
  assert.ok(fit.confidence > 0.5, `confidence ${fit.confidence}`);
});

// ---------------------------------------------------------------------------------------------
// (b) 2-stop linear at 37°
// ---------------------------------------------------------------------------------------------

test('(b) 2-stop linear gradient at 37° → linear, angle ±4°, endpoint colors ±6/channel', () => {
  const angle = 37, c0 = hexRgb('#14213d'), c1 = hexRgb('#fca311');
  const th = (angle * Math.PI) / 180, dx = Math.sin(th), dy = -Math.cos(th);
  const W = 240, H = 180;
  const projs = [[0, 0], [W - 1, 0], [0, H - 1], [W - 1, H - 1]].map(([x, y]) => x * dx + y * dy);
  const pMin = Math.min(...projs), pMax = Math.max(...projs);
  const img = makePixels(W, H, (x, y) => {
    const t = (x * dx + y * dy - pMin) / (pMax - pMin);
    return c0.map((c, i) => c + (c1[i] - c) * t);
  });
  const fit = fitRegionFill(img, null);
  assert.equal(fit.kind, 'linear');
  const angErr = Math.min(Math.abs(fit.angleDeg - angle), 360 - Math.abs(fit.angleDeg - angle));
  assert.ok(angErr <= 4, `angle ${fit.angleDeg} vs ${angle}`);
  assert.equal(fit.stops.length, 2, `expected minimal 2 stops, got ${fit.stops.length}`);
  assert.ok(maxChanDiff(fit.stops[0].color, '#14213d') <= 6, `stop0 ${fit.stops[0].color}`);
  assert.ok(maxChanDiff(fit.stops[1].color, '#fca311') <= 6, `stop1 ${fit.stops[1].color}`);
  assert.equal(fit.stops[0].offset, 0);
  assert.equal(fit.stops[1].offset, 1);
  assert.ok(fit.residual < 4, `residual ${fit.residual}`);
});

test('(b2) renderFill(linear) roundtrips: refitting the render reproduces angle and colors', () => {
  const fit0 = {
    kind: 'linear', angleDeg: 205,
    stops: [{ offset: 0, color: '#0b3d2e' }, { offset: 1, color: '#e9c46a' }],
  };
  const rendered = renderFill(fit0, 220, 260);
  const refit = fitRegionFill(rendered, null);
  assert.equal(refit.kind, 'linear');
  const angErr = Math.min(Math.abs(refit.angleDeg - 205), 360 - Math.abs(refit.angleDeg - 205));
  assert.ok(angErr <= 4, `roundtrip angle ${refit.angleDeg}`);
  assert.ok(maxChanDiff(refit.stops[0].color, '#0b3d2e') <= 6);
  assert.ok(maxChanDiff(refit.stops[refit.stops.length - 1].color, '#e9c46a') <= 6);
});

// ---------------------------------------------------------------------------------------------
// (c) 3-stop linear with dither noise
// ---------------------------------------------------------------------------------------------

test('(c) 3-stop linear with dither noise → ≤4 stops, middle stop position ±0.08', () => {
  const rnd = prng(7);
  const stops = [
    { o: 0, c: [10, 10, 10] },
    { o: 0.45, c: [230, 57, 70] },
    { o: 1, c: [255, 255, 255] },
  ];
  const evalStops = (t) => {
    for (let i = 1; i < stops.length; i++) {
      if (t <= stops[i].o) {
        const f = (t - stops[i - 1].o) / (stops[i].o - stops[i - 1].o);
        return stops[i - 1].c.map((c, ch) => c + (stops[i].c[ch] - c) * f);
      }
    }
    return stops[stops.length - 1].c;
  };
  // 90° = to right; ±3 uniform dither
  const img = makePixels(300, 200, (x) => evalStops(x / 299).map((c) => c + (rnd() * 6 - 3)));
  const fit = fitRegionFill(img, null);
  assert.equal(fit.kind, 'linear');
  assert.ok(fit.stops.length >= 3 && fit.stops.length <= 4, `stop count ${fit.stops.length}`);
  const angErr = Math.min(Math.abs(fit.angleDeg - 90), 360 - Math.abs(fit.angleDeg - 90));
  assert.ok(angErr <= 4, `angle ${fit.angleDeg}`);
  const middles = fit.stops.slice(1, -1).map((s) => s.offset);
  assert.ok(middles.some((o) => Math.abs(o - 0.45) <= 0.08), `middle stops ${middles} vs 0.45`);
  assert.ok(fit.residual < 5, `residual ${fit.residual}`);
});

// ---------------------------------------------------------------------------------------------
// (d) off-center radial
// ---------------------------------------------------------------------------------------------

test('(d) radial gradient centered at (30%,40%) → radial, center within ±8pct', () => {
  const W = 240, H = 200, cx = 0.3 * W, cy = 0.4 * H;
  let rMax = 0;
  for (const [x, y] of [[0, 0], [W - 1, 0], [0, H - 1], [W - 1, H - 1]]) {
    rMax = Math.max(rMax, Math.hypot(x - cx, y - cy));
  }
  const inner = hexRgb('#ffffff'), outer = hexRgb('#1d3557');
  const img = makePixels(W, H, (x, y) => {
    const t = Math.min(1, Math.hypot(x - cx, y - cy) / rMax);
    return inner.map((c, i) => c + (outer[i] - c) * t);
  });
  const fit = fitRegionFill(img, null);
  assert.equal(fit.kind, 'radial');
  assert.ok(Math.abs(fit.center.xPct - 30) <= 8, `xPct ${fit.center.xPct}`);
  assert.ok(Math.abs(fit.center.yPct - 40) <= 8, `yPct ${fit.center.yPct}`);
  assert.ok(fit.stops.length >= 2);
  assert.ok(maxChanDiff(fit.stops[0].color, '#ffffff') <= 12, `inner ${fit.stops[0].color}`);
  assert.ok(fit.residual < 6, `residual ${fit.residual}`);
});

// ---------------------------------------------------------------------------------------------
// robustness: never throws, degenerate inputs
// ---------------------------------------------------------------------------------------------

test('never throws: empty region, bad mask, 1×1 image all return verdicts', () => {
  const img = makePixels(10, 10, () => [100, 100, 100]);
  const empty = fitRegionFill(img, { x: 20, y: 20, w: 5, h: 5 });
  assert.equal(empty.kind, 'photo');
  assert.equal(empty.confidence, 0);
  assert.ok(empty.error);
  const one = fitRegionFill(makePixels(1, 1, () => [10, 200, 30]), null);
  assert.ok(['flat', 'photo'].includes(one.kind));
  const masked = fitRegionFill(img, { x: 0, y: 0, w: 10, h: 10, mask: new Uint8Array(100).fill(1) });
  assert.equal(masked.kind, 'flat');
  const badScrim = solveScrim(img, makePixels(3, 3, () => [0, 0, 0]), { x: 0, y: 0, w: 10, h: 10 });
  assert.equal(badScrim.ok, false);
});

// ---------------------------------------------------------------------------------------------
// (e) real corpus photo crop → photo
// ---------------------------------------------------------------------------------------------

test('(e) real corpus photo crop (013 product bag) → photo verdict', async (t) => {
  const src = findCorpusSource('013');
  if (!src) return t.skip('corpus source image for 013 not on this machine (.state/vision-tmp)');
  const pixels = await loadPixels(src);
  // the grüns product bag with printed bear face + text — unambiguous photo content
  const fit = fitRegionFill(pixels, { x: 400, y: 760, w: 400, h: 480 });
  assert.equal(fit.kind, 'photo', `got ${JSON.stringify(fit)}`);
  assert.ok(fit.residual > 10, `photo residual should be high, got ${fit.residual}`);
});

// ---------------------------------------------------------------------------------------------
// (f) scrim solving over a real photo crop
// ---------------------------------------------------------------------------------------------

test('(f) solveScrim recovers flat 55% black + to-top gradient scrims over a real photo crop', async (t) => {
  const src = findCorpusSource('013');
  if (!src) return t.skip('corpus source image for 013 not on this machine (.state/vision-tmp)');
  const full = await loadPixels(src);
  const region = { x: 400, y: 760, w: 360, h: 360 };
  // cut the clean background crop
  const bg = makePixels(region.w, region.h, (x, y) => {
    const i = ((region.y + y) * full.width + (region.x + x)) * 4;
    return [full.data[i], full.data[i + 1], full.data[i + 2]];
  });

  // flat 55% black scrim
  const flatObs = makePixels(region.w, region.h, (x, y) => {
    const i = (y * region.w + x) * 4;
    return [bg.data[i], bg.data[i + 1], bg.data[i + 2]].map((c) => 0.45 * c);
  });
  const flatSol = solveScrim(flatObs, bg, null);
  assert.equal(flatSol.ok, true, JSON.stringify(flatSol));
  assert.equal(flatSol.alpha.kind, 'flat');
  assert.ok(Math.abs(flatSol.alpha.value - 0.55) <= 0.06, `alpha ${flatSol.alpha.value} vs 0.55`);
  assert.ok(maxChanDiff(flatSol.color, '#000000') <= 24, `scrim color ${flatSol.color}`);

  // to-top black gradient scrim: α = 0.75 at bottom → 0.05 at top
  const gradObs = makePixels(region.w, region.h, (x, y) => {
    const a = 0.05 + (0.75 - 0.05) * (y / (region.h - 1));
    const i = (y * region.w + x) * 4;
    return [bg.data[i], bg.data[i + 1], bg.data[i + 2]].map((c) => (1 - a) * c);
  });
  const gradSol = solveScrim(gradObs, bg, null);
  assert.equal(gradSol.ok, true, JSON.stringify(gradSol));
  assert.equal(gradSol.alpha.kind, 'linear');
  const [lo, hi] = [gradSol.alpha.from, gradSol.alpha.to].sort((a, b) => a - b);
  assert.ok(Math.abs(lo - 0.05) <= 0.06, `alpha lo ${lo} vs 0.05`);
  assert.ok(Math.abs(hi - 0.75) <= 0.06, `alpha hi ${hi} vs 0.75`);
  // axis must be vertical: increasing-α direction points down (180°) or the equivalent flip
  const ang = gradSol.alpha.angleDeg;
  assert.ok(Math.min(Math.abs(ang - 180), Math.abs(ang - 0), 360 - ang) <= 15, `angle ${ang}`);
  assert.ok(maxChanDiff(gradSol.color, '#000000') <= 24, `scrim color ${gradSol.color}`);
});
