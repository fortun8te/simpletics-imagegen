// test/font-match-pack.test.mjs — Google-Fonts-pack matching (S8): manifest integrity,
// matchFontAll on a synthesized known-font crop, and metricFallback substitution.
//
// The matching test is SYNTHETIC and self-grounding, like font-match.test.mjs: render
// "Shop The Sale" in Archivo Black via the pack's own probe renderer, then ask matchFontAll —
// with no family hint — which manifest family reproduces that crop. Archivo Black (or at
// minimum a same-class heavy-display family) must be in the top-3. Skips gracefully when the
// pack has not been fetched (`node scripts/fetch-fonts.mjs`) or headless Chrome is missing.
//
// Runnable standalone: node test/font-match-pack.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadFontsManifest, FONTS_PACK_DIR, packFontFaceCss } from '../lib/font-faces.mjs';
import { matchFontAll, metricFallback, renderFontSample, CLASS_REPS } from '../lib/font-match.mjs';

const { entries } = loadFontsManifest();
const packFamilies = entries.filter((e) => e.source === 'google-pack' && Object.keys(e.files || {}).length);
const packOnDisk = packFamilies.length > 0
  && existsSync(join(FONTS_PACK_DIR, Object.values(packFamilies[0].files)[0]));

test('manifest loads with ≥40 pack families, sane shapes, and files that exist', (t) => {
  assert.ok(Array.isArray(entries) && entries.length >= 40, `manifest has ${entries.length} entries`);
  assert.ok(packFamilies.length >= 40, `expected ≥40 google-pack families with files, got ${packFamilies.length}`);
  for (const e of entries) {
    assert.equal(typeof e.family, 'string');
    assert.ok(e.family.length > 0);
    assert.ok(Array.isArray(e.weights), `${e.family}: weights must be an array`);
    assert.ok(typeof e.files === 'object' && e.files !== null, `${e.family}: files must be an object`);
    assert.ok(typeof e.figma === 'boolean', `${e.family}: figma flag required`);
    assert.ok(typeof e.cls === 'string' && e.cls.length > 0, `${e.family}: visual class required`);
    for (const [w, rel] of Object.entries(e.files)) {
      assert.ok(e.weights.includes(Number(w)), `${e.family}: file weight ${w} missing from weights[]`);
      assert.ok(!rel.startsWith('/') && !rel.includes('..'), `${e.family}: file path must be pack-relative`);
    }
  }
  if (!packOnDisk) t.diagnostic('pack files not on disk — run: node scripts/fetch-fonts.mjs');
  // every class representative used by the matcher's phase-1 filter must exist in the manifest
  for (const rep of Object.values(CLASS_REPS)) {
    assert.ok(entries.some((e) => e.family === rep), `class rep ${rep} missing from manifest`);
  }
});

test('packFontFaceCss emits file:// rules only for families with files on disk', { skip: !packOnDisk && 'fonts pack not fetched' }, () => {
  const css = packFontFaceCss([{ family: 'Archivo Black', weights: [400] }, { family: 'Helvetica Neue' }]);
  assert.match(css, /font-family:'Archivo Black'/);
  assert.match(css, /src:url\('file:\/\//);
  assert.doesNotMatch(css, /Helvetica Neue/, 'system families (no files) must not get @font-face rules');
});

test('matchFontAll finds Archivo Black (or a same-class family) for its own sample', { skip: !packOnDisk && 'fonts pack not fetched' }, async (t) => {
  const sample = renderFontSample('Archivo Black', 400, 'Shop The Sale', { fontSizePx: 72 });
  if (!sample) return t.skip('headless Chrome unavailable — cannot render the probe sample');
  const res = await matchFontAll(sample, { text: 'Shop The Sale' });
  assert.ok(Array.isArray(res) && res.length >= 3, `expected ≥3 candidates, got ${res.length}`);
  for (const c of res) {
    assert.equal(typeof c.family, 'string');
    assert.equal(typeof c.weight, 'number');
    assert.equal(typeof c.italic, 'boolean');
    assert.ok(c.score > -1 && c.score <= 1);
    assert.ok(['google-pack', 'system', 'bundled'].includes(c.source), `bad source ${c.source}`);
  }
  // sorted desc
  for (let i = 1; i < res.length; i++) assert.ok(res[i].score <= res[i - 1].score, 'candidates must be sorted by score desc');
  const heavyClass = new Set(entries.filter((e) => e.cls === 'heavy-display').map((e) => e.family));
  const top3 = res.slice(0, 3).map((c) => c.family);
  assert.ok(
    top3.includes('Archivo Black') || top3.some((f) => heavyClass.has(f)),
    `Archivo Black (or a heavy-display sibling) must be top-3, got: ${top3.join(', ')}`,
  );
  t.diagnostic(`top-3: ${res.slice(0, 3).map((c) => `${c.family}@${c.weight}=${c.score}`).join('  ')}`);
});

test('metricFallback substitutes a shippable pack family by metric distance', { skip: !packOnDisk && 'fonts pack not fetched' }, () => {
  // Helvetica Neue is a system font (figma:false-adjacent case) — its substitute must be a
  // pack family with files, and metrically it should land on a grotesk, not a serif/script.
  const sub = metricFallback('Helvetica Neue');
  assert.equal(typeof sub.family, 'string');
  const entry = entries.find((e) => e.family === sub.family);
  assert.ok(entry, `substitute ${sub.family} must be in the manifest`);
  if (sub.distance !== null) {
    assert.ok(Object.keys(entry.files || {}).length > 0, 'substitute must have shippable files');
    assert.ok(!['script', 'serif-display', 'serif-body', 'mono'].includes(entry.cls),
      `Helvetica Neue substitute landed in class ${entry.cls} (${sub.family}) — metrics are off`);
  }
  // unknown family degrades to the default, never throws
  const unknown = metricFallback('Definitely Not A Real Font 9000');
  assert.equal(typeof unknown.family, 'string');
});
