// test/effect-fit.test.mjs — S7 effect parameter fitting (lib/effect-fit.mjs).
//
// Synthetic-only, fully deterministic: shadows are composed with sharp's TRUE Gaussian blur
// (independent of the module's 3-pass box-blur forward model), vignettes with raw math on a
// PRNG pseudo-photo. Cases:
//   (a) rounded-rect card over flat bg, known shadow dx=0 dy=8 σ=12 op=0.35 → recover
//       dx±3, dy±3, σ±40%, opacity±0.08
//   (b) same card, NO shadow → found=false
//   (c) rect element without alpha (box silhouette path) + offset shadow → found + sane params
//   (d) pseudo-photo with a known renderer-style vignette → found, strength within 25%
//   (e) clean pseudo-photo → found=false
//   (f) garbage inputs never throw
//
// Run standalone: node test/effect-fit.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { fitDropShadow, fitVignette } from '../lib/effect-fit.mjs';

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------

function prng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

async function rawPixels(sharpImg) {
  const { data, info } = await sharpImg.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data), width: info.width, height: info.height };
}

// compose: flat bg + (optional) true-Gaussian shadow of the card silhouette + card
async function composeCardScene({ W = 480, H = 480, bg = '#e8e2d8', card = '#ffffff',
  box = { x: 140, y: 150, w: 200, h: 140 }, rx = 18, shadow = null }) {
  const cardSvg = Buffer.from(
    `<svg width="${box.w}" height="${box.h}"><rect x="0" y="0" width="${box.w}" height="${box.h}" rx="${rx}" fill="${card}"/></svg>`,
  );
  const cardPng = await sharp(cardSvg).png().toBuffer();
  const alphaRaw = await sharp(cardPng).ensureAlpha().extractChannel(3).raw()
    .toBuffer({ resolveWithObject: true });

  const layers = [];
  if (shadow) {
    // silhouette on a full-canvas transparent sheet, offset, true-Gaussian blur, colorized
    const sil = await sharp({
      create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .composite([{
        input: await sharp(cardSvg).png().toBuffer(),
        left: box.x + shadow.dx, top: box.y + shadow.dy,
      }])
      .png().toBuffer();
    const blurredAlpha = await sharp(sil).ensureAlpha().extractChannel(3)
      .blur(shadow.sigma).raw().toBuffer(); // sharp.blur(sigma) = true Gaussian
    const shRgba = Buffer.alloc(W * H * 4);
    const [sr, sg, sb] = [1, 3, 5].map((p) => parseInt((shadow.color || '#000000').slice(p, p + 2), 16));
    for (let i = 0; i < W * H; i++) {
      shRgba[i * 4] = sr; shRgba[i * 4 + 1] = sg; shRgba[i * 4 + 2] = sb;
      shRgba[i * 4 + 3] = Math.round(blurredAlpha[i] * shadow.opacity);
    }
    layers.push({ input: shRgba, raw: { width: W, height: H, channels: 4 } });
  }
  layers.push({ input: cardPng, left: box.x, top: box.y });

  const scene = sharp({
    create: { width: W, height: H, channels: 4, background: bg },
  }).composite(layers).png();
  const pixels = await rawPixels(sharp(await scene.toBuffer()));
  return {
    pixels,
    element: {
      box,
      alpha: { data: new Uint8Array(alphaRaw.data), width: alphaRaw.info.width, height: alphaRaw.info.height },
    },
    background: { kind: 'flat', color: bg },
  };
}

// deterministic pseudo-photo: smooth low-frequency color field + PRNG grain
function makePseudoPhoto(W, H, seed = 7) {
  const rnd = prng(seed);
  const noise = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) noise[i] = (rnd() - 0.5) * 24;
  const data = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const u = x / W, v = y / H;
      const base = 150 + 28 * Math.sin(u * 5.1) + 22 * Math.cos(v * 4.3 + 1.2) + noise[i];
      data[i * 4] = Math.max(0, Math.min(255, base + 14 * Math.sin(u * 9)));
      data[i * 4 + 1] = Math.max(0, Math.min(255, base));
      data[i * 4 + 2] = Math.max(0, Math.min(255, base - 12 * Math.cos(v * 7)));
      data[i * 4 + 3] = 255;
    }
  }
  return { data, width: W, height: H };
}

// renderer-model vignette: multiply by 1 − strength·clamp((r−size)/(1−size),0,1), r/half-diag
function applyVignette(pixels, size, strength) {
  const { data, width: W, height: H } = pixels;
  const out = new Uint8Array(data);
  const cx = (W - 1) / 2, cy = (H - 1) / 2, R = Math.hypot(W, H) / 2;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const r = Math.hypot(x - cx, y - cy) / R;
      const ramp = Math.max(0, Math.min(1, (r - size) / (1 - size)));
      const m = 1 - strength * ramp;
      const i = (y * W + x) * 4;
      out[i] = data[i] * m; out[i + 1] = data[i + 1] * m; out[i + 2] = data[i + 2] * m;
    }
  }
  return { data: out, width: W, height: H };
}

// ---------------------------------------------------------------------------------------------
// drop shadow
// ---------------------------------------------------------------------------------------------

test('fitDropShadow recovers a known card shadow (dx=0 dy=8 σ=12 op=0.35)', async () => {
  const truth = { dx: 0, dy: 8, sigma: 12, opacity: 0.35, color: '#000000' };
  const { pixels, element, background } = await composeCardScene({ shadow: truth });
  const t0 = Date.now();
  const fit = fitDropShadow(pixels, element, background);
  const ms = Date.now() - t0;
  assert.equal(fit.found, true, `expected found, got ${JSON.stringify(fit)}`);
  assert.ok(Math.abs(fit.dx - truth.dx) <= 3, `dx ${fit.dx} vs ${truth.dx}`);
  assert.ok(Math.abs(fit.dy - truth.dy) <= 3, `dy ${fit.dy} vs ${truth.dy}`);
  assert.ok(Math.abs(fit.sigma - truth.sigma) <= truth.sigma * 0.4, `sigma ${fit.sigma} vs ${truth.sigma}`);
  assert.ok(Math.abs(fit.opacity - truth.opacity) <= 0.08, `opacity ${fit.opacity} vs ${truth.opacity}`);
  assert.ok(ms < 1500, `too slow: ${ms}ms`);
});

test('fitDropShadow: no-shadow control comes back found=false', async () => {
  const { pixels, element, background } = await composeCardScene({ shadow: null });
  const fit = fitDropShadow(pixels, element, background);
  assert.equal(fit.found, false, `false positive: ${JSON.stringify(fit)}`);
});

test('fitDropShadow: box-silhouette path (no alpha) with offset shadow', async () => {
  const truth = { dx: 8, dy: 16, sigma: 10, opacity: 0.4, color: '#000000' };
  const { pixels, element, background } = await composeCardScene({ rx: 0, shadow: truth });
  const fit = fitDropShadow(pixels, { box: element.box }, background); // alpha withheld
  assert.equal(fit.found, true, `expected found, got ${JSON.stringify(fit)}`);
  assert.ok(Math.abs(fit.dx - truth.dx) <= 4, `dx ${fit.dx} vs ${truth.dx}`);
  assert.ok(Math.abs(fit.dy - truth.dy) <= 4, `dy ${fit.dy} vs ${truth.dy}`);
  assert.ok(Math.abs(fit.sigma - truth.sigma) <= truth.sigma * 0.5, `sigma ${fit.sigma} vs ${truth.sigma}`);
});

test('fitDropShadow: null background falls back to border-median flat', async () => {
  const truth = { dx: 0, dy: 8, sigma: 12, opacity: 0.35, color: '#000000' };
  const { pixels, element } = await composeCardScene({ shadow: truth });
  const fit = fitDropShadow(pixels, element, null);
  assert.equal(fit.found, true, `expected found, got ${JSON.stringify(fit)}`);
  assert.ok(Math.abs(fit.dy - truth.dy) <= 3, `dy ${fit.dy} vs ${truth.dy}`);
});

// ---------------------------------------------------------------------------------------------
// vignette
// ---------------------------------------------------------------------------------------------

test('fitVignette recovers a known renderer-style vignette', () => {
  const clean = makePseudoPhoto(480, 360);
  const truth = { size: 0.4, strength: 0.55 };
  const fit = fitVignette(applyVignette(clean, truth.size, truth.strength), []);
  assert.equal(fit.found, true, `expected found, got ${JSON.stringify(fit)}`);
  assert.ok(Math.abs(fit.strength - truth.strength) <= truth.strength * 0.25,
    `strength ${fit.strength} vs ${truth.strength}`);
  assert.ok(Math.abs(fit.radiusPct / 100 - truth.size) <= 0.2, `radiusPct ${fit.radiusPct} vs size ${truth.size}`);
  assert.ok(Math.abs(fit.centerBias.xPct) <= 10 && Math.abs(fit.centerBias.yPct) <= 10,
    `centerBias ${JSON.stringify(fit.centerBias)}`);
});

test('fitVignette: clean photo comes back found=false', () => {
  const fit = fitVignette(makePseudoPhoto(480, 360), []);
  assert.equal(fit.found, false, `false positive: ${JSON.stringify(fit)}`);
});

test('fitVignette: excludeBoxes are honored (bright card in a vignetted photo)', () => {
  const clean = makePseudoPhoto(480, 360, 11);
  const vig = applyVignette(clean, 0.4, 0.55);
  // paste a bright card near a corner — without exclusion this would fight the fit
  const box = { x: 330, y: 240, w: 120, h: 90 };
  for (let y = box.y; y < box.y + box.h; y++) {
    for (let x = box.x; x < box.x + box.w; x++) {
      const i = (y * vig.width + x) * 4;
      vig.data[i] = 250; vig.data[i + 1] = 250; vig.data[i + 2] = 248;
    }
  }
  const fit = fitVignette(vig, [box]);
  assert.equal(fit.found, true, `expected found, got ${JSON.stringify(fit)}`);
  assert.ok(Math.abs(fit.strength - 0.55) <= 0.55 * 0.3, `strength ${fit.strength}`);
});

// ---------------------------------------------------------------------------------------------
// never throws
// ---------------------------------------------------------------------------------------------

test('both entry points never throw on garbage input', () => {
  assert.equal(fitDropShadow(null, null, null).found, false);
  assert.equal(fitDropShadow({ data: new Uint8Array(4), width: 1, height: 1 },
    { box: { x: 0, y: 0, w: 0, h: 0 } }, { kind: 'nonsense' }).found, false);
  assert.equal(fitVignette(null).found, false);
  assert.equal(fitVignette({ data: new Uint8Array(16), width: 2, height: 2 }, undefined).found, false);
});
