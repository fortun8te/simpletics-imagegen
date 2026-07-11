// test/inpaint.test.mjs — inpaint(): fills mask holes (255=hole) in RGBA pixels, MI-GAN when
// .state/models/migan.onnx is present, deterministic patch fill otherwise; never throws.
// Migan-specific asserts are skip-marked when the model file is absent so the suite passes on
// machines that never ran scripts/fetch-migan.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';

import { inpaint, tryMigan, miganAvailable, resolveEngine, maskToRects } from '../lib/inpaint.mjs';

const HAVE_MIGAN = miganAvailable();

/* ── synthetic scene: 400×400 two-tone vertical gradient, 80×80 hole in the middle ─────────── */

const W = 400, H = 400;
const HOLE = { x: 160, y: 160, w: 80, h: 80 };

/** Vertical gradient: teal (top) → warm sand (bottom). Smooth ⇒ any sane fill ≈ gradient. */
function gradientPixels() {
  const data = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) {
    const t = y / (H - 1);
    const r = Math.round(40 + t * 180), g = Math.round(120 + t * 60), b = Math.round(140 - t * 60);
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
    }
  }
  return { data, width: W, height: H };
}

/** Punch the hole visibly (solid black) so "unchanged mask pixels" is detectable. */
function punched() {
  const px = gradientPixels();
  for (let y = HOLE.y; y < HOLE.y + HOLE.h; y++) {
    for (let x = HOLE.x; x < HOLE.x + HOLE.w; x++) {
      const i = (y * W + x) * 4;
      px.data[i] = 0; px.data[i + 1] = 0; px.data[i + 2] = 0;
    }
  }
  return px;
}

function holeMask() {
  const mask = new Uint8Array(W * H);
  for (let y = HOLE.y; y < HOLE.y + HOLE.h; y++) mask.fill(255, y * W + HOLE.x, y * W + HOLE.x + HOLE.w);
  return mask;
}

/** Max per-channel |fill − true gradient| over the hole + count of untouched (still black) px. */
function holeStats(out) {
  const truth = gradientPixels().data;
  let maxErr = 0, black = 0;
  for (let y = HOLE.y; y < HOLE.y + HOLE.h; y++) {
    for (let x = HOLE.x; x < HOLE.x + HOLE.w; x++) {
      const i = (y * W + x) * 4;
      let sum = 0;
      for (let c = 0; c < 3; c++) {
        maxErr = Math.max(maxErr, Math.abs(out.data[i + c] - truth[i + c]));
        sum += out.data[i + c];
      }
      if (sum < 30) black++;
    }
  }
  return { maxErr, black };
}

/* ── the contract ──────────────────────────────────────────────────────────────────────────── */

test('inpaint: hole is reconstructed near the gradient, engine reflects reality', async () => {
  const res = await inpaint(punched(), holeMask());
  assert.equal(res.width, W);
  assert.equal(res.height, H);
  assert.ok(res.data && res.data.length === W * H * 4, 'full RGBA image returned');
  assert.equal(res.engine, HAVE_MIGAN ? 'migan' : 'patch',
    `engine must reflect what ran (model ${HAVE_MIGAN ? 'present' : 'absent'})`);
  const { maxErr, black } = holeStats(res);
  assert.equal(black, 0, `${black} hole pixels still black (unfilled)`);
  // Smooth two-tone gradient: both engines should land well within 60/255 of ground truth.
  assert.ok(maxErr < 60, `hole deviates from the gradient by up to ${maxErr}/255`);
  // pixels OUTSIDE the mask must be untouched
  const i = (10 * W + 10) * 4;
  const truth = gradientPixels().data;
  for (let c = 0; c < 4; c++) assert.equal(res.data[i + c], truth[i + c], 'non-hole pixel changed');
});

test('inpaint: forced patch engine works and reports engine=patch', async () => {
  const res = await inpaint(punched(), holeMask(), { engine: 'patch' });
  assert.equal(res.engine, 'patch');
  const { maxErr, black } = holeStats(res);
  assert.equal(black, 0);
  assert.ok(maxErr < 60, `patch fill deviates by ${maxErr}/255`);
});

test('inpaint: migan engine fills the hole (skipped when model absent)', { skip: !HAVE_MIGAN && 'migan.onnx not downloaded (run scripts/fetch-migan.mjs)' }, async () => {
  const res = await inpaint(punched(), holeMask(), { engine: 'migan' });
  assert.equal(res.engine, 'migan');
  const { maxErr, black } = holeStats(res);
  assert.equal(black, 0);
  assert.ok(maxErr < 60, `migan fill deviates by ${maxErr}/255`);
  // low-level helper agrees
  const raw = await tryMigan(punched(), holeMask());
  assert.ok(raw && raw.engine === 'migan');
});

test('inpaint: alpha channel is preserved verbatim (mattes keep transparency)', async () => {
  const px = punched();
  // make the hole's left half transparent
  for (let y = HOLE.y; y < HOLE.y + HOLE.h; y++) {
    for (let x = HOLE.x; x < HOLE.x + HOLE.w / 2; x++) px.data[(y * W + x) * 4 + 3] = 0;
  }
  const res = await inpaint(px, holeMask());
  assert.equal(res.data[(HOLE.y * W + HOLE.x) * 4 + 3], 0, 'transparent stayed transparent');
  assert.equal(res.data[(HOLE.y * W + HOLE.x + HOLE.w - 1) * 4 + 3], 255, 'opaque stayed opaque');
});

test('inpaint: never throws — empty mask, garbage input, tiny image all return an image', async () => {
  const px = gradientPixels();
  const empty = await inpaint(px, new Uint8Array(W * H));
  assert.equal(empty.width, W);
  assert.ok(empty.data);
  const junk = await inpaint(null, null);
  assert.ok(junk && 'engine' in junk);
  const tiny = await inpaint({ data: Buffer.alloc(4), width: 1, height: 1 }, new Uint8Array([255]));
  assert.ok(tiny && 'engine' in tiny);
});

test('resolveEngine: opts > env > model presence', () => {
  assert.equal(resolveEngine({ engine: 'patch' }), 'patch');
  const prev = process.env.INPAINT_ENGINE;
  process.env.INPAINT_ENGINE = 'patch';
  assert.equal(resolveEngine(), 'patch');
  process.env.INPAINT_ENGINE = 'migan';
  assert.equal(resolveEngine(), HAVE_MIGAN ? 'migan' : 'patch');
  if (prev === undefined) delete process.env.INPAINT_ENGINE; else process.env.INPAINT_ENGINE = prev;
  assert.equal(resolveEngine(), HAVE_MIGAN ? 'migan' : 'patch');
});

test('maskToRects: connected components become pixel bboxes', () => {
  const mw = 20, mh = 10;
  const m = new Uint8Array(mw * mh);
  for (let y = 1; y < 4; y++) m.fill(255, y * mw + 2, y * mw + 6);   // 4×3 blob
  for (let y = 6; y < 9; y++) m.fill(255, y * mw + 12, y * mw + 15); // 3×3 blob
  const rects = maskToRects(m, mw, mh);
  assert.equal(rects.length, 2);
  assert.deepEqual(rects[0], { x: 2, y: 1, w: 4, h: 3 });
  assert.deepEqual(rects[1], { x: 12, y: 6, w: 3, h: 3 });
});
