// test/icon-match.test.mjs — zero-framework (node:test) coverage for lib/icon-match.mjs.
//
// SYNTHETIC (always runs): render a real NATIVE_ICONS glyph into a padded box and confirm
// matchIcon recovers its exact id top-1 with the canonical path; a random blob → matched:false;
// the outline-vs-filled variants stay distinct; an OFF-COLOR (red) render still matches on shape.
//
// REAL CORPUS (runs only if the inspo image is present on disk): the 009 X-post action row +
// chrome. Asserts the strong action-row icons resolve to their canonical X ids, and writes
// source-crop | canonical-render side-by-sides to .state/icon-atlas/debug/ for visual audit.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

import { matchIcon, loadIconAtlas, iconRoleName } from '../lib/icon-match.mjs';
import { NATIVE_ICONS } from '../lib/native-icons.mjs';

const STUDIO_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEBUG_DIR = join(STUDIO_DIR, '.state', 'icon-atlas', 'debug');
const CORPUS_009 = join(process.env.HOME || '', 'Downloads', 'IMAGE AD INSPO', '009_attached_885c19be02ccf229.png');

/** Render a normalized 0..1 path into a size×size PNG with padding (simulates an ad crop). */
async function renderProbe(d, { color = 'black', bg = 'white', size = 120, pad = 18 } = {}) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">`
    + `<rect width="${size}" height="${size}" fill="${bg}"/>`
    + `<g transform="translate(${pad},${pad}) scale(${size - 2 * pad})"><path d="${d}" fill="${color}"/></g></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}
const fullBox = (size = 120) => ({ x: 0, y: 0, w: size, h: size });

test('atlas builds from NATIVE_ICONS + notes-icons', async () => {
  const atlas = await loadIconAtlas();
  assert.ok(atlas.entries.length >= 30, `expected ≥30 atlas entries, got ${atlas.entries.length}`);
  const ids = new Set(atlas.entries.map((e) => e.id));
  for (const id of ['x-like-outline', 'x-reply', 'x-verified-badge', 'x-share', 'x-more']) {
    assert.ok(ids.has(id), `atlas missing ${id}`);
  }
});

test('synthetic self-recognition: each rendered glyph matches its own id top-1', async () => {
  const ids = ['x-like-outline', 'x-reply', 'x-verified-badge', 'x-share', 'x-more',
    'x-repost', 'x-bookmark-outline', 'ig-comment', 'ig-share'];
  for (const id of ids) {
    const png = await renderProbe(NATIVE_ICONS[id].d);
    const r = await matchIcon(png, fullBox(), { units: 'px' });
    assert.equal(r.matched, true, `${id} should match (score ${r.score})`);
    assert.equal(r.id, id, `${id} matched ${r.id} instead`);
    assert.equal(r.path, NATIVE_ICONS[id].d, `${id} must return the canonical path`);
    assert.ok(r.score >= 0.86, `${id} score ${r.score} below gate`);
  }
});

test("X 'like' returns id 'x-like-outline' + canonical path, top-1", async () => {
  const png = await renderProbe(NATIVE_ICONS['x-like-outline'].d);
  const r = await matchIcon(png, fullBox(), { units: 'px' });
  assert.equal(r.matched, true);
  assert.equal(r.id, 'x-like-outline');
  assert.equal(r.name, 'action/like');
  assert.equal(r.path, NATIVE_ICONS['x-like-outline'].d);
});

test('random blob → matched:false (falls through to trace)', async () => {
  const blob = await sharp(Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="120" height="120" fill="white"/>'
    + '<path d="M20 30 Q60 10 90 60 T40 100 Z" fill="black"/></svg>')).png().toBuffer();
  const r = await matchIcon(blob, fullBox(), { units: 'px' });
  assert.equal(r.matched, false, `blob should not match (matched ${r.id} @ ${r.score})`);
});

test('outline vs filled variants stay distinct', async () => {
  const outline = await matchIcon(await renderProbe(NATIVE_ICONS['x-like-outline'].d), fullBox(), { units: 'px' });
  const filled = await matchIcon(await renderProbe(NATIVE_ICONS['x-like-filled'].d), fullBox(), { units: 'px' });
  assert.equal(outline.id, 'x-like-outline');
  assert.equal(filled.id, 'x-like-filled');
});

test('off-color + inverted (red / white-on-black) still match on shape', async () => {
  const red = await matchIcon(await renderProbe(NATIVE_ICONS['x-like-outline'].d, { color: 'red' }), fullBox(), { units: 'px' });
  assert.equal(red.matched, true);
  assert.equal(red.id, 'x-like-outline', 'red like should still match on shape');
  const inv = await matchIcon(await renderProbe(NATIVE_ICONS['x-like-outline'].d, { color: 'white', bg: 'black' }), fullBox(), { units: 'px' });
  assert.equal(inv.matched, true);
  assert.equal(inv.id, 'x-like-outline', 'white-on-black like should still match on shape');
});

test('role-based names derive from id', () => {
  assert.equal(iconRoleName('x-like-outline'), 'action/like');
  assert.equal(iconRoleName('x-verified-badge'), 'badge/verified');
  assert.equal(iconRoleName('x-back'), 'nav/back');
  assert.equal(iconRoleName('brand-tiktok'), 'brand/tiktok');
});

test('REAL corpus 009 — X action row resolves to canonical X ids (+ debug side-by-sides)', async (t) => {
  if (!existsSync(CORPUS_009)) { t.skip('009 inspo image not on disk'); return; }
  mkdirSync(DEBUG_DIR, { recursive: true });
  const S = 1080;
  // Calibrated icon boxes (fractions of frame), read directly from the image.
  const boxes = {
    'x-back':     { x: 0.026, y: 0.052, w: 0.052, h: 0.043 }, // full arrow-left — NOT the canonical chevron
    'x-more':     { x: 0.900, y: 0.056, w: 0.062, h: 0.024 },
    'x-verified': { x: 0.327, y: 0.139, w: 0.044, h: 0.042 }, // check-cutout gap keeps it a near-miss
    'reply':      { x: 0.028, y: 0.933, w: 0.052, h: 0.050 },
    'repost':     { x: 0.246, y: 0.937, w: 0.072, h: 0.046 },
    'like':       { x: 0.474, y: 0.938, w: 0.055, h: 0.043 },
    'bookmark':   { x: 0.700, y: 0.934, w: 0.050, h: 0.050 },
    'share':      { x: 0.931, y: 0.936, w: 0.043, h: 0.048 },
  };
  const expect = { // action-row icons we assert as canonical HITs
    reply: 'x-reply', repost: 'x-repost', like: 'x-like-outline',
    bookmark: 'x-bookmark-outline', share: 'x-share', 'x-more': 'x-more',
  };

  const strips = [];
  const results = {};
  for (const [label, b] of Object.entries(boxes)) {
    const r = await matchIcon(CORPUS_009, b, { units: 'fraction' });
    results[label] = r;
    const canonId = r.id || r.candidates?.[0]?.id;
    const px = { left: Math.round(b.x * S), top: Math.round(b.y * S), width: Math.round(b.w * S), height: Math.round(b.h * S) };
    const crop = await sharp(CORPUS_009).extract(px).resize(128, 128, { fit: 'contain', background: '#333' }).png().toBuffer();
    const canon = await sharp(Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1" width="128" height="128"><rect width="1" height="1" fill="#111"/>`
      + `<path d="${NATIVE_ICONS[canonId]?.d || ''}" fill="#4af"/></svg>`)).png().toBuffer();
    const lab = await sharp(Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="272" height="20"><rect width="272" height="20" fill="#000"/>`
      + `<text x="4" y="15" fill="#fff" font-size="12" font-family="monospace">${label} -> ${canonId} ${r.matched ? 'HIT' : 'miss'} ${r.score}</text></svg>`)).png().toBuffer();
    strips.push(await sharp({ create: { width: 272, height: 148, channels: 4, background: '#222' } })
      .composite([{ input: crop, left: 0, top: 20 }, { input: canon, left: 138, top: 20 }, { input: lab, left: 0, top: 0 }]).png().toBuffer());
  }
  writeFileSync(join(DEBUG_DIR, '009_contact.png'), await sharp({ create: { width: 272, height: 148 * strips.length, channels: 4, background: '#000' } })
    .composite(strips.map((s, i) => ({ input: s, left: 0, top: i * 148 }))).png().toBuffer());

  // Assert the strong action-row icons resolve to their canonical X ids.
  for (const [label, id] of Object.entries(expect)) {
    const r = results[label];
    assert.equal(r.id, id, `009 ${label} matched ${r.id || 'MISS'} (score ${r.score}), expected ${id}`);
  }
  // x-back is a full arrow (not the canonical chevron) → correctly NOT matched.
  assert.equal(results['x-back'].matched, false, '009 back (full arrow) should not match the chevron canonical');
});
