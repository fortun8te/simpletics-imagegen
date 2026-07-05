// test/typo-truth.test.mjs — TYPO/BACKGROUND TRUTH v2 (lib/typo-truth.mjs).
// Synthetic PNGs per detail class the owner flags: bold vs regular ink density, sheared
// italic-like glyphs, subtle vertical background gradient, thick vs thin line stroke, and
// pointed vs rounded star rows. Run: node --test test/typo-truth.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { applyTypoTruth } from '../lib/typo-truth.mjs';

/** Minimal valid 8-bit RGB PNG of w×h where pixel(x,y) = fill(x,y) -> [r,g,b].
 *  (Same pattern as test/scene-truth.test.mjs / test/extract-photo-region.test.mjs.) */
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
  writeFileSync(path, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

const dir = mkdtempSync(join(tmpdir(), 'typo-truth-'));

/** Glyph-bar text stand-in: vertical bars of width bw on a pitch of `pitch`, rows y0..y1,
 *  starting at x0, n bars. Ink density within the tight block ≈ bw/pitch. Optional shear slants
 *  each bar (dx per row upward) like an italic stem. */
function bars(x, y, { x0, y0, y1, n, bw, pitch, shear = 0 }) {
  if (y < y0 || y >= y1) return false;
  const drift = shear * (y1 - y); // top rows shift right
  for (let i = 0; i < n; i++) {
    const bx = x0 + i * pitch + drift;
    if (x >= bx && x < bx + bw) return true;
  }
  return false;
}

// ── 1. FONT WEIGHT ───────────────────────────────────────────────────────────────────────────────
test('font weight: dense (bold) ink upgrades a reader-400 to heavy; thin ink keeps the reader value', () => {
  const p = join(dir, 'weight.png');
  // two "words": dense block (bw 18 / pitch 30 ⇒ density .60) + thin block (bw 6 / pitch 30 ⇒ .20)
  writeRgbPng(p, 500, 260, (x, y) =>
    (bars(x, y, { x0: 60, y0: 40, y1: 100, n: 12, bw: 18, pitch: 30 }) ||
     bars(x, y, { x0: 60, y0: 160, y1: 220, n: 12, bw: 6, pitch: 30 })) ? [17, 17, 17] : [255, 255, 255]);
  const ext = {
    ok: true, canvas: { w: 500, h: 260 }, background: '#ffffff', backgroundIsPhoto: false,
    layers: [
      { id: 'bold', type: 'text', text: 'DENSE BARS', box: { x: 40, y: 30, w: 420, h: 80 }, style: { fontSize: 60, fontWeight: 400, color: '#111111' } },
      { id: 'thin', type: 'text', text: 'THIN BARS', box: { x: 40, y: 150, w: 420, h: 80 }, style: { fontSize: 60, fontWeight: 400, color: '#111111' } },
    ],
  };
  const { ext: out, corrections } = applyTypoTruth(ext, p);
  assert.ok(out.layers[0].style.fontWeight >= 700, `dense block upgraded, got ${out.layers[0].style.fontWeight}`);
  assert.equal(out.layers[1].style.fontWeight, 400, 'thin block keeps the reader weight');
  assert.ok(corrections.some((c) => /fontWeight 400/.test(c)), 'weight correction reported');
});

test('font weight: measurement within the ±200 gap does not churn the reader value', () => {
  const p = join(dir, 'weight-gap.png');
  writeRgbPng(p, 500, 140, (x, y) =>
    bars(x, y, { x0: 60, y0: 40, y1: 100, n: 12, bw: 18, pitch: 30 }) ? [17, 17, 17] : [255, 255, 255]);
  const ext = {
    ok: true, canvas: { w: 500, h: 140 }, background: '#ffffff', backgroundIsPhoto: false,
    layers: [{ id: 't', type: 'text', text: 'DENSE', box: { x: 40, y: 30, w: 420, h: 80 }, style: { fontSize: 60, fontWeight: 700, color: '#111111' } }],
  };
  const { ext: out } = applyTypoTruth(ext, p);
  assert.equal(out.layers[0].style.fontWeight, 700, 'density ⇒ 800-class but reader said 700 (gap 100 < 200) — kept');
});

test('font weight: a photo partially overlapping the text box does not fake boldness', () => {
  const p = join(dir, 'weight-occl.png');
  // thin bars (density .20) + a busy "photo" block overlapping the bottom half of the text box
  const noise = (x, y) => [((x * 7919 + y * 104729) % 255), ((x * 31 + y * 17) % 255), ((x * 13 + y * 71) % 255)];
  writeRgbPng(p, 500, 200, (x, y) => {
    if (y >= 80 && x >= 60 && x < 460) return noise(x, y); // photo region
    return bars(x, y, { x0: 60, y0: 30, y1: 75, n: 12, bw: 6, pitch: 30 }) ? [17, 17, 17] : [255, 255, 255];
  });
  const ext = {
    ok: true, canvas: { w: 500, h: 200 }, background: '#ffffff', backgroundIsPhoto: false,
    layers: [
      { id: 't', type: 'text', text: 'THIN OVER PHOTO', box: { x: 40, y: 20, w: 420, h: 100 }, style: { fontSize: 40, fontWeight: 400, color: '#111111' } },
      { id: 'photo', type: 'shape', role: 'product', box: { x: 60, y: 80, w: 400, h: 120 }, style: {}, cutoutCandidate: { region: { x: 0.12, y: 0.4, w: 0.8, h: 0.6 }, shape: 'rect' } },
    ],
  };
  const { ext: out } = applyTypoTruth(ext, p);
  assert.equal(out.layers[0].style.fontWeight, 400, 'photo pixels excluded — no fake weight upgrade');
});

// ── 2. ITALIC ────────────────────────────────────────────────────────────────────────────────────
test('italic: sheared stems set style.italic, upright stems do not', () => {
  const p = join(dir, 'italic.png');
  writeRgbPng(p, 500, 260, (x, y) =>
    (bars(x, y, { x0: 60, y0: 40, y1: 100, n: 10, bw: 5, pitch: 30, shear: 0.25 }) ||
     bars(x, y, { x0: 60, y0: 160, y1: 220, n: 10, bw: 5, pitch: 30 })) ? [17, 17, 17] : [255, 255, 255]);
  const ext = {
    ok: true, canvas: { w: 500, h: 260 }, background: '#ffffff', backgroundIsPhoto: false,
    layers: [
      { id: 'slanted', type: 'text', text: 'SLANTED', box: { x: 40, y: 30, w: 420, h: 80 }, style: { fontSize: 60, fontWeight: 400, color: '#111111' } },
      { id: 'upright', type: 'text', text: 'UPRIGHT', box: { x: 40, y: 150, w: 420, h: 80 }, style: { fontSize: 60, fontWeight: 400, color: '#111111' } },
    ],
  };
  const { ext: out, corrections } = applyTypoTruth(ext, p);
  assert.equal(out.layers[0].style.italic, true, 'sheared stems detected as italic');
  assert.ok(!out.layers[1].style.italic, 'upright stems stay non-italic');
  assert.ok(corrections.some((c) => /italic/.test(c)), 'italic correction reported');
});

// ── 3. SUBTLE BACKGROUND GRADIENT ────────────────────────────────────────────────────────────────
test('background: subtle vertical ramp replaces the reader solid with a linear gradient', () => {
  const p = join(dir, 'grad.png');
  // ~13% luminance drift top→bottom (f2 → d0) — subtle enough that readers flatten it
  writeRgbPng(p, 400, 400, (x, y) => {
    const v = Math.round(0xf2 - (y / 399) * 0x22);
    if (x >= 150 && x < 250 && y >= 180 && y < 220) return [17, 17, 17]; // a text layer to exclude
    return [v, v, v];
  });
  const ext = {
    ok: true, canvas: { w: 400, h: 400 }, background: '#f2f2f2', backgroundIsPhoto: false,
    layers: [{ id: 't', type: 'text', text: 'HI', box: { x: 150, y: 180, w: 100, h: 40 }, style: { fontSize: 30, fontWeight: 700, color: '#111111' } }],
  };
  const { ext: out, corrections } = applyTypoTruth(ext, p);
  assert.equal(typeof out.background, 'object', 'background became a gradient object');
  assert.equal(out.background.type, 'linear');
  assert.ok(Array.isArray(out.background.stops) && out.background.stops.length === 2);
  assert.ok(out.background.from && out.background.to, 'from/to kept for baseFromSkeletonBackground');
  const lum = (hex) => (0.2126 * parseInt(hex.slice(1, 3), 16) + 0.7152 * parseInt(hex.slice(3, 5), 16) + 0.0722 * parseInt(hex.slice(5, 7), 16)) / 255;
  assert.ok(Math.abs(lum(out.background.from) - lum(out.background.to)) >= 0.05, 'stops span the measured drift');
  assert.ok(out.background.angle % 180 < 25 || out.background.angle % 180 > 155, `vertical drift ⇒ vertical angle, got ${out.background.angle}`);
  assert.ok(corrections.some((c) => /gradient/.test(c)), 'gradient correction reported');
});

test('background: a genuinely flat background stays a solid', () => {
  const p = join(dir, 'flat.png');
  writeRgbPng(p, 400, 400, () => [0xf2, 0xf2, 0xf2]);
  const ext = { ok: true, canvas: { w: 400, h: 400 }, background: '#f2f2f2', backgroundIsPhoto: false, layers: [] };
  const { ext: out } = applyTypoTruth(ext, p);
  assert.equal(out.background, '#f2f2f2', 'flat background untouched');
});

// ── 4. STROKE/LINE TRUTH ─────────────────────────────────────────────────────────────────────────
test('line: measured cross-section corrects a too-thin box and short endpoints', () => {
  const p = join(dir, 'line.png');
  // real line: vertical, 8px thick (x 196..204), y 50..350
  writeRgbPng(p, 400, 400, (x, y) => (x >= 196 && x < 204 && y >= 50 && y < 350) ? [17, 17, 17] : [255, 255, 255]);
  const ext = {
    ok: true, canvas: { w: 400, h: 400 }, background: '#ffffff', backgroundIsPhoto: false,
    layers: [{ id: 'divider', type: 'shape', box: { x: 199, y: 60, w: 2, h: 280 }, style: { shapeKind: 'line', background: '#111111' } }],
  };
  const { ext: out, corrections } = applyTypoTruth(ext, p);
  const b = out.layers[0].box;
  assert.ok(Math.abs(b.w - 8) <= 1, `stroke width corrected 2→~8, got ${b.w}`);
  assert.ok(Math.abs(b.y - 50) <= 3, `top endpoint corrected 60→~50, got ${b.y}`);
  assert.ok(Math.abs(b.h - 300) <= 6, `length corrected 280→~300, got ${b.h}`);
  assert.ok(out.layers[0].style.strokeWidthPx >= 7, 'measured stroke recorded on style');
  assert.ok(corrections.some((c) => /stroke|length/.test(c)), 'line correction reported');
});

test('line: an accurate thin line box is left alone', () => {
  const p = join(dir, 'line-ok.png');
  writeRgbPng(p, 400, 400, (x, y) => (x >= 198 && x < 201 && y >= 60 && y < 340) ? [17, 17, 17] : [255, 255, 255]);
  const ext = {
    ok: true, canvas: { w: 400, h: 400 }, background: '#ffffff', backgroundIsPhoto: false,
    layers: [{ id: 'divider', type: 'shape', box: { x: 198, y: 60, w: 3, h: 280 }, style: { shapeKind: 'line', background: '#111111' } }],
  };
  const { ext: out, corrections } = applyTypoTruth(ext, p);
  assert.deepEqual(out.layers[0].box, { x: 198, y: 60, w: 3, h: 280 }, 'accurate box untouched');
  assert.equal(corrections.length, 0, 'no corrections for a truthful line');
});

// ── 5. STAR ROWS ─────────────────────────────────────────────────────────────────────────────────
function starPoly(cx, cy, R, r) {
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rad = i % 2 === 0 ? R : r;
    pts.push([cx + rad * Math.cos(a), cy + rad * Math.sin(a)]);
  }
  return pts;
}
function inPoly(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
/** Rounded star = morphological opening of the polygon star with a disc of radius rho. */
function inRoundedStar(x, y, poly, rho) {
  for (let dy = -rho; dy <= rho; dy += 1.5) {
    for (let dx = -rho; dx <= rho; dx += 1.5) {
      if (dx * dx + dy * dy > rho * rho) continue;
      let fits = true;
      for (let a = 0; a < 2 * Math.PI && fits; a += Math.PI / 8) {
        if (!inPoly(x + dx + rho * Math.cos(a), y + dy + rho * Math.sin(a), poly)) fits = false;
      }
      if (fits) return true;
    }
  }
  return false;
}
function starTestExt(kind, path) {
  const polys = Array.from({ length: 5 }, (_, i) => starPoly(60 + i * 60, 300, 24, 10));
  writeRgbPng(path, 360, 600, (x, y) => {
    for (const poly of polys) {
      const cx = poly[0][0];
      if (Math.abs(x - cx) > 30 || Math.abs(y - 300) > 30) continue;
      if (kind === 'pointed' ? inPoly(x, y, poly) : inRoundedStar(x, y, poly, 3.5)) return [240, 170, 20];
    }
    return [255, 255, 255];
  });
  return {
    ok: true, canvas: { w: 360, h: 600 }, background: '#ffffff', backgroundIsPhoto: false,
    layers: [{ id: 'star-rating', type: 'shape', role: 'social-proof', box: { x: 25, y: 270, w: 310, h: 60 }, style: {} }],
  };
}

test('stars: pointed 5-star row is classified pointed', () => {
  const p = join(dir, 'stars-pointed.png');
  const { ext: out, corrections } = applyTypoTruth(starTestExt('pointed', p), p);
  assert.equal(out.layers[0].style.starStyle, 'pointed');
  assert.ok(corrections.some((c) => /pointed/.test(c)), 'star correction reported');
});

test('stars: rounded star row is classified rounded', () => {
  const p = join(dir, 'stars-rounded.png');
  const { ext: out } = applyTypoTruth(starTestExt('rounded', p), p);
  assert.equal(out.layers[0].style.starStyle, 'rounded');
});

// ── contract ─────────────────────────────────────────────────────────────────────────────────────
test('never throws: garbage ext / missing image return the input untouched', () => {
  assert.deepEqual(applyTypoTruth(null, '/nope.png').corrections, []);
  assert.deepEqual(applyTypoTruth({ ok: false }, '/nope.png').corrections, []);
  const ext = { ok: true, canvas: { w: 10, h: 10 }, layers: [{ id: 'x', type: 'text', text: 'hi', box: { x: 0, y: 0, w: 5, h: 5 }, style: {} }] };
  const { ext: out, corrections } = applyTypoTruth(ext, join(dir, 'does-not-exist.png'));
  assert.equal(out, ext);
  assert.deepEqual(corrections, []);
});
