// test/occlusion-fill.test.mjs — occlusion fill: baked overlays inside reference crops get
// deterministically inpainted so the re-added editable overlay isn't doubled.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  planOcclusions, fillOccludedRegions,
  MAX_OCCLUDER_FRAC, PHOTO_BASE_ID,
} from '../lib/occlusion-fill.mjs';

const sharp = (await import('sharp')).default;
const dir = mkdtempSync(join(tmpdir(), 'occl-'));

/* ── synthetic texture helpers ─────────────────────────────────────────────────────────────── */

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Sandy texture: smooth sinusoid + fine seeded noise — "photo-like" continuous background. */
function textureRaw(w, h, seed = 42) {
  const rnd = mulberry32(seed);
  const data = Buffer.alloc(w * h * 3);
  const base = [176, 148, 118];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = Math.sin(x * 0.13) * 5 + Math.cos(y * 0.09) * 5 + (rnd() * 2 - 1) * 8;
      const o = (y * w + x) * 3;
      for (let c = 0; c < 3; c++) data[o + c] = Math.max(0, Math.min(255, Math.round(base[c] + v)));
    }
  }
  return data;
}

/** Texture PNG with a solid "button" rect burned in at pixel rect {x,y,w,h}. */
async function texturedWithButton(path, W, H, btn) {
  const tex = sharp(textureRaw(W, H), { raw: { width: W, height: H, channels: 3 } });
  const button = { create: { width: btn.w, height: btn.h, channels: 4, background: { r: 30, g: 60, b: 200, alpha: 1 } } };
  await tex.composite([{ input: button, left: btn.x, top: btn.y }]).png().toFile(path);
}

async function rawOf(path) {
  return sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
}

function regionMean({ data, info }, x, y, w, h) {
  let r = 0, g = 0, b = 0, n = 0;
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      const o = (yy * info.width + xx) * 4;
      r += data[o]; g += data[o + 1]; b += data[o + 2]; n++;
    }
  }
  return [r / n, g / n, b / n];
}

/** Mean per-channel abs diff between two horizontal rows (seam-hardness metric). */
function rowDiff({ data, info }, x, w, yA, yB) {
  let d = 0, n = 0;
  for (let xx = x; xx < x + w; xx++) {
    const a = (yA * info.width + xx) * 4, b = (yB * info.width + xx) * 4;
    for (let c = 0; c < 3; c++) { d += Math.abs(data[a + c] - data[b + c]); n++; }
  }
  return d / n;
}

/* ── fillOccludedRegions ───────────────────────────────────────────────────────────────────── */

test('fill: burned-in button rect blends back into surrounding texture', async () => {
  const W = 240, H = 240;
  const btn = { x: 72, y: 96, w: 96, h: 36 }; // wide → vertical strips above/below
  const before = join(dir, 'button-before.png');
  const after = join(dir, 'button-after.png');
  await texturedWithButton(before, W, H, btn);

  const rect = { x: btn.x / W, y: btn.y / H, w: btn.w / W, h: btn.h / H };
  const res = await fillOccludedRegions(before, [rect], after);
  assert.equal(res.ok, true);
  assert.equal(res.filled, 1);
  assert.equal(res.skipped, 0);

  const beforeRaw = await rawOf(before);
  const afterRaw = await rawOf(after);

  // mean color of the filled region ≈ surrounding texture (sample a ring strip above the rect)
  const filledMean = regionMean(afterRaw, btn.x, btn.y, btn.w, btn.h);
  const ringMean = regionMean(afterRaw, btn.x, btn.y - 14, btn.w, 10);
  for (let c = 0; c < 3; c++) {
    assert.ok(Math.abs(filledMean[c] - ringMean[c]) < 12,
      `channel ${c}: filled mean ${filledMean[c].toFixed(1)} vs ring ${ringMean[c].toFixed(1)}`);
  }

  // no hard edges: seam gradient at the top boundary (fill pads 2px, boundary at y-2) must be
  // soft after the fill and was hard before it. Rows 2px either side of the boundary.
  const seamBefore = rowDiff(beforeRaw, btn.x + 4, btn.w - 8, btn.y - 4, btn.y + 1);
  const seamAfter = rowDiff(afterRaw, btn.x + 4, btn.w - 8, btn.y - 4, btn.y + 1);
  assert.ok(seamBefore > 60, `test precondition: baked button must be a hard seam (got ${seamBefore.toFixed(1)})`);
  assert.ok(seamAfter < 25, `seam still hard after fill (${seamAfter.toFixed(1)})`);
  // bottom seam too
  const seamBottom = rowDiff(afterRaw, btn.x + 4, btn.w - 8, btn.y + btn.h - 1, btn.y + btn.h + 4);
  assert.ok(seamBottom < 25, `bottom seam still hard after fill (${seamBottom.toFixed(1)})`);
});

test('fill: deterministic — same input twice produces identical bytes', async () => {
  const W = 160, H = 160;
  const btn = { x: 40, y: 60, w: 80, h: 30 };
  const src = join(dir, 'det-src.png');
  await texturedWithButton(src, W, H, btn);
  const rect = { x: btn.x / W, y: btn.y / H, w: btn.w / W, h: btn.h / H };
  const o1 = join(dir, 'det-1.png');
  const o2 = join(dir, 'det-2.png');
  await fillOccludedRegions(src, [rect], o1);
  await fillOccludedRegions(src, [rect], o2);
  assert.ok(readFileSync(o1).equals(readFileSync(o2)), 'fill output must be byte-identical across runs');
});

test('fill: skips occluders covering more than 45% of the crop', async () => {
  const W = 200, H = 200;
  const src = join(dir, 'big-src.png');
  await texturedWithButton(src, W, H, { x: 10, y: 10, w: 20, h: 20 });
  const res = await fillOccludedRegions(src, [{ x: 0.05, y: 0.05, w: 0.9, h: 0.6 }], join(dir, 'big-out.png'));
  assert.equal(res.ok, true);
  assert.equal(res.filled, 0);
  assert.equal(res.skipped, 1);
  assert.match(res.results[0].reason, new RegExp(`${Math.round(MAX_OCCLUDER_FRAC * 100)}%`));
});

test('fill: skips when the surrounding strips are wildly different', async () => {
  const W = 200, H = 200;
  // top half near-black, bottom half near-white; rect straddles the boundary
  const data = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) {
    const v = y < H / 2 ? 12 : 240;
    for (let x = 0; x < W; x++) data.fill(v, (y * W + x) * 3, (y * W + x) * 3 + 3);
  }
  const src = join(dir, 'split-src.png');
  await sharp(data, { raw: { width: W, height: H, channels: 3 } }).png().toFile(src);
  const res = await fillOccludedRegions(src, [{ x: 0.2, y: 0.35, w: 0.6, h: 0.3 }], join(dir, 'split-out.png'));
  assert.equal(res.ok, true);
  assert.equal(res.filled, 0);
  assert.equal(res.skipped, 1);
  assert.match(res.results[0].reason, /dissimilar/);
});

test('fill: tall rect uses left/right strips and still blends', async () => {
  const W = 240, H = 240;
  const btn = { x: 100, y: 40, w: 36, h: 140 }; // taller than wide → horizontal strips
  const before = join(dir, 'tall-before.png');
  const after = join(dir, 'tall-after.png');
  await texturedWithButton(before, W, H, btn);
  const res = await fillOccludedRegions(before, [{ x: btn.x / W, y: btn.y / H, w: btn.w / W, h: btn.h / H }], after);
  assert.equal(res.filled, 1);
  const afterRaw = await rawOf(after);
  const filledMean = regionMean(afterRaw, btn.x, btn.y, btn.w, btn.h);
  const ringMean = regionMean(afterRaw, btn.x - 14, btn.y, 10, btn.h);
  for (let c = 0; c < 3; c++) assert.ok(Math.abs(filledMean[c] - ringMean[c]) < 12, `channel ${c} off`);
});

/* ── planOcclusions ────────────────────────────────────────────────────────────────────────── */

test('plan: overlays ≥70% inside a cutout box map to crop-fraction rects', () => {
  const ext = {
    canvas: { w: 1000, h: 1000 },
    layers: [
      { id: 'photo', type: 'shape', role: 'product', box: { x: 100, y: 100, w: 600, h: 600 }, cutoutCandidate: { region: { x: 0.1, y: 0.1, w: 0.6, h: 0.6 }, shape: 'rect' } },
      { id: 'btn', type: 'badge', role: 'badge', text: 'SHOP NOW', box: { x: 150, y: 550, w: 200, h: 80 } }, // fully inside
      { id: 'far', type: 'text', role: 'caption', text: 'far away', box: { x: 750, y: 800, w: 100, h: 40 } }, // outside
      { id: 'half', type: 'text', role: 'caption', text: 'partial', box: { x: 500, y: 650, w: 400, h: 100 } }, // 25% overlap → excluded
    ],
  };
  const plan = planOcclusions(ext);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].layerId, 'photo');
  assert.equal(plan[0].rects.length, 1);
  const r = plan[0].rects[0];
  assert.equal(r.overlayId, 'btn');
  assert.ok(Math.abs(r.x - 50 / 600) < 1e-9 && Math.abs(r.y - 450 / 600) < 1e-9);
  assert.ok(Math.abs(r.w - 200 / 600) < 1e-9 && Math.abs(r.h - 80 / 600) < 1e-9);
  // the plan is also annotated onto the layer for the asset-materialization site
  assert.deepEqual(ext.layers[0].cutoutCandidate.occluders, plan[0].rects);
});

test('plan: photo background gets an implicit full-image pseudo-cutout', () => {
  const ext = {
    canvas: { w: 1000, h: 2000 },
    backgroundIsPhoto: true,
    layers: [
      { id: 'h1', type: 'text', role: 'headline', text: 'HELLO', box: { x: 100, y: 200, w: 300, h: 100 } },
      { id: 'decor', type: 'shape', role: 'decor', box: { x: 0, y: 0, w: 50, h: 50 } }, // not an overlay
    ],
  };
  const plan = planOcclusions(ext);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].layerId, PHOTO_BASE_ID);
  assert.equal(plan[0].rects.length, 1);
  const pr = plan[0].rects[0];
  for (const [k, v] of Object.entries({ x: 0.1, y: 0.1, w: 0.3, h: 0.05 })) {
    assert.ok(Math.abs(pr[k] - v) < 1e-9, `${k}: ${pr[k]} != ${v}`);
  }
});

test('plan: fraction-unit boxes are handled; empty/absent input never throws', () => {
  const ext = {
    canvas: { w: 1080, h: 1080 },
    layers: [
      { id: 'cut', type: 'shape', role: 'product', box: { x: 0.1, y: 0.1, w: 0.6, h: 0.6 }, cutoutCandidate: { region: { x: 0.1, y: 0.1, w: 0.6, h: 0.6 }, shape: 'rect' } },
      { id: 'pill', type: 'text', role: 'cta pill', text: 'BUY', box: { x: 0.2, y: 0.5, w: 0.2, h: 0.08 } },
    ],
  };
  const plan = planOcclusions(ext);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].rects[0].overlayId, 'pill');
  assert.deepEqual(planOcclusions(null), []);
  assert.deepEqual(planOcclusions({ layers: [] }), []);
});
