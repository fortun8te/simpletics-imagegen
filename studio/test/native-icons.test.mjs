// native-icons.test.mjs — the resurrected exact-platform-chrome registry (lib/native-icons.mjs)
// and its wiring into templates (x-post-ad action row / verified badge, ig-feed-post action row)
// and the elements.mjs ICONS map.
import test from 'node:test';
import assert from 'node:assert/strict';

import { NATIVE_ICONS, nativeIcon, scalePath, TWITTER_ICONS, INSTAGRAM_ICONS } from '../lib/native-icons.mjs';
import { ICONS } from '../lib/elements.mjs';
import { buildTemplate } from '../lib/templates.mjs';

const DOC = { canvas: { w: 1080, h: 1350 }, layers: [] };

function flatten(layers, out = []) {
  for (const l of layers || []) {
    out.push(l);
    if (l.children) flatten(l.children, out);
  }
  return out;
}

test('registry: flat lookups resolve with d/viewBox/source', () => {
  for (const id of ['x-reply', 'x-repost', 'x-like-outline', 'x-bookmark-outline', 'x-share',
    'x-verified-badge', 'ig-heart-outline', 'ig-comment', 'ig-share', 'ig-bookmark-outline',
    'ig-verified-badge', 'ios-back', 'ios-check',
    'brand-x', 'brand-instagram', 'brand-facebook', 'brand-tiktok', 'brand-trustpilot', 'brand-whatsapp']) {
    const icon = nativeIcon(id);
    assert.ok(icon, `${id} resolves`);
    assert.match(icon.d, /^M/i, `${id} d-string starts with a moveto`);
    assert.ok(Array.isArray(icon.viewBox) && icon.viewBox.length === 2, `${id} viewBox [w,h]`);
    assert.ok(icon.source, `${id} carries provenance`);
  }
  assert.equal(nativeIcon('nope'), null);
});

test('registry: brand icons are normalized ~0..1 and carry official hex', () => {
  const tp = nativeIcon('brand-trustpilot');
  assert.equal(tp.hex, '#00B67A', 'Trustpilot green is the official #00B67A');
  // every number of a scaled 24-box path (absolute coords OR relative deltas) must have
  // magnitude ≤ ~1 after normalization — a raw 24-box path would still carry values like 12/24
  const nums = tp.d.match(/-?\d*\.?\d+/g).map(Number);
  assert.ok(nums.every((n) => Math.abs(n) <= 1.2), 'coords normalized to ~0..1 magnitude');
  assert.match(tp.source, /simple-icons \(CC0-1\.0\)/);
});

test('scalePath: scales coords but preserves arc flags/angle', () => {
  const d = 'M12 0A12 12 0 1 1 0 12l6 -6z';
  const out = scalePath(d, 1 / 24);
  assert.equal(out, 'M 0.5 0 A 0.5 0.5 0 1 1 0 0.5 l 0.25 -0.25 z');
});

test('elements ICONS map absorbed the native registry', () => {
  assert.equal(ICONS['x-like-outline'], NATIVE_ICONS['x-like-outline'].d);
  assert.equal(ICONS['brand-tiktok'], NATIVE_ICONS['brand-tiktok'].d);
  assert.ok(ICONS['check'], 'hand-drawn set still present');
});

test('x-post-ad build renders verbatim-path chrome (action row + verified badge)', () => {
  const layers = flatten(buildTemplate('x-post-ad', DOC, {}).layers);
  const paths = layers.filter((l) => l.style?.shapeKind === 'path').map((l) => l.style.path);
  for (const key of ['reply', 'repost', 'likeOutline', 'bookmarkOutline', 'share', 'verifiedBadge']) {
    assert.ok(paths.includes(TWITTER_ICONS[key].d), `x-post contains verbatim ${key} path`);
  }
  // no leftover glyph/polyline approximations in the action row
  const names = layers.map((l) => l.name || '');
  assert.ok(!layers.some((l) => l.style?.shapeKind === 'polyline' && /bookmark/i.test(l.name || '')),
    'bookmark polyline approximation replaced');
  assert.ok(names.some((n) => /share icon/i.test(n)), 'share is an icon layer, not the ⬆ glyph');
});

test('ig-feed-post build renders verbatim heart/comment/share paths + badge', () => {
  const layers = flatten(buildTemplate('ig-feed-post', DOC, {}).layers);
  const paths = layers.filter((l) => l.style?.shapeKind === 'path').map((l) => l.style.path);
  for (const key of ['heartOutline', 'comment', 'share', 'bookmarkOutline', 'verifiedBadge']) {
    assert.ok(paths.includes(INSTAGRAM_ICONS[key].d), `ig-feed contains ${key} path`);
  }
  assert.ok(!layers.some((l) => l.style?.shapeKind === 'polyline'), 'no polyline icons remain in ig-feed');
});
