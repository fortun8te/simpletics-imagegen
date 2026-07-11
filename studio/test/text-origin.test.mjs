// test/text-origin.test.mjs — S3 overlay/scene classifier vs the hand-labeled
// 5-case fixture corpus (002/004/016/018/020) in test/fixtures/text-origin/.
// Each fixture is an S1-shaped JSON plus a `label` per line and hand-drawn
// photoRegions; source images are copied next to the fixtures so the test is
// self-contained. PASS bar: ≥85% of labels exactly correct AND zero catastrophic
// errors (confident scene→overlay on the big package print of 004/016).
// Runnable standalone: node test/text-origin.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyTextOrigins, semanticPrior, rectangularityFeature, gridAlignFeature, WEIGHTS,
} from '../lib/text-origin.mjs';

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'text-origin');

let sharpAvailable = true;
try { await import('sharp'); } catch { sharpAvailable = false; }

// ---------------------------------------------------------------------------
// pure helpers (no pixels)
// ---------------------------------------------------------------------------
test('semanticPrior: CTA/offer/price ⇒ overlay, nutrition/label ⇒ scene, else neutral', () => {
  assert.equal(semanticPrior('SHOP NOW'), 0.85);
  assert.equal(semanticPrior('Bestel op Upfront.nl'), 0.85);
  assert.equal(semanticPrior('Up To 30% Off'), 0.85);
  assert.equal(semanticPrior('€49'), 0.85);
  assert.equal(semanticPrior('link in bio'), 0.85);
  assert.equal(semanticPrior('ingrediënten'), 0.15);
  assert.equal(semanticPrior('voedingswaarden per 100g'), 0.15);
  assert.equal(semanticPrior('MANGO SMAAK'), 0.15);
  // units-table density (≥2 unit tokens) is label-shaped even without keywords
  assert.equal(semanticPrior('1259 kJ 73 kJ 295 kcal'), 0.2);
  // single unit token is NOT enough (callout copy like "6g fiber" is overlay)
  assert.equal(semanticPrior('6g fiber'), 0.5);
  assert.equal(semanticPrior('PARTY'), 0.5);
  assert.equal(semanticPrior(''), 0.5);
});

test('rectangularityFeature: axis-aligned rect ⇒ 1, rotation/perspective decays', () => {
  const rect = [[0, 0], [100, 0], [100, 20], [0, 20]];
  assert.equal(rectangularityFeature(rect), 1);
  // 12° rotated rect (020 magazine) must decay well below 1
  const rot = [[0, 0], [98, 21], [94, 41], [-4, 20]];
  assert.ok(rectangularityFeature(rot) < 0.6);
  // perspective (non-parallel edges) decays too
  const persp = [[0, 0], [100, 8], [96, 34], [4, 18]];
  assert.ok(rectangularityFeature(persp) < 0.75);
  // missing quad = assume rectangular
  assert.equal(rectangularityFeature(null), 1);
});

test('gridAlignFeature: canvas-center and shared guides count, adjacent neighbors do not', () => {
  const mk = (id, x, y, w, h) => ({ id, box: { x, y, w, h } });
  const a = mk('a', 100, 100, 200, 30);
  const bFar = mk('b', 100, 500, 300, 30);    // same left, far away → guide
  const bNear = mk('c', 100, 135, 300, 30);   // same left, adjacent → ignored
  assert.equal(gridAlignFeature(a, [a, bFar], 1000), 1);
  assert.equal(gridAlignFeature(a, [a, bNear], 1000), 0);
  const centered = mk('d', 400, 100, 200, 30); // center 500 = canvas center
  assert.equal(gridAlignFeature(centered, [centered], 1000), 1);
});

test('classifyTextOrigins: empty input ⇒ empty output', async () => {
  const res = await classifyTextOrigins('/nonexistent.png', { lines: [] });
  assert.deepEqual(res, { lines: [] });
});

// ---------------------------------------------------------------------------
// fixture corpus — accuracy + confusion + catastrophic gate
// ---------------------------------------------------------------------------
// "catastrophic" = the corpus failures this stage exists to kill: big package
// print confidently classified overlay (004 nutrition-label soup, 016 bag print)
const CATASTROPHIC = {
  '004': ['L5', 'L6', 'L7', 'L8', 'L9'], // UPFRONT/CREATINE/ingrediënten/ELECTROLYTES/MANGO
  '016': ['L8'],                          // 'grüns' bag print
};

test('fixture corpus: ≥85% exact, zero catastrophic scene→overlay', { skip: !sharpAvailable && 'sharp not installed' }, async () => {
  const files = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.json')).sort();
  assert.ok(files.length >= 5, 'expected the 5 hand-labeled fixtures');

  const confusion = {}; // label -> predicted -> count
  const perCase = [];
  const catastrophes = [];
  let correct = 0, total = 0, ambiguous = 0;

  for (const file of files) {
    const fx = JSON.parse(readFileSync(join(FIXTURE_DIR, file), 'utf8'));
    const imagePath = join(FIXTURE_DIR, fx.source.path);
    const res = await classifyTextOrigins(imagePath, fx, { photoRegions: fx.photoRegions });
    assert.equal(res.lines.length, fx.lines.length, `${fx.case}: one verdict per line`);

    let caseCorrect = 0;
    for (const verdict of res.lines) {
      const line = fx.lines.find((l) => l.id === verdict.id);
      assert.ok(line, `${fx.case}: verdict for unknown id ${verdict.id}`);
      assert.ok(verdict.score >= 0 && verdict.score <= 1, 'score is P(overlay) in [0,1]');
      assert.ok(['overlay', 'scene', 'ambiguous'].includes(verdict.origin));
      for (const key of ['edgeRamp', 'inkTightness', 'rectangularity', 'gridAlign', 'ringStroke', 'semantic']) {
        assert.ok(key in verdict.features, `${fx.case}/${verdict.id}: features.${key} present`);
      }

      confusion[line.label] ??= {};
      confusion[line.label][verdict.origin] = (confusion[line.label][verdict.origin] || 0) + 1;
      total++;
      if (verdict.origin === line.label) { correct++; caseCorrect++; }
      if (verdict.origin === 'ambiguous') ambiguous++;
      if ((CATASTROPHIC[fx.case] || []).includes(verdict.id) && verdict.origin === 'overlay') {
        catastrophes.push(`${fx.case}/${verdict.id} "${line.text}" scored ${verdict.score} → overlay`);
      }
    }
    perCase.push({ case: fx.case, correct: caseCorrect, total: fx.lines.length });
  }

  // report ------------------------------------------------------------------
  console.log('\n  per-case accuracy:');
  for (const c of perCase) {
    console.log(`    ${c.case}: ${c.correct}/${c.total} (${((100 * c.correct) / c.total).toFixed(1)}%)`);
  }
  console.log('\n  confusion (rows = hand label, cols = predicted):');
  console.log('    label     overlay  scene  ambiguous');
  for (const label of ['overlay', 'scene']) {
    const row = confusion[label] || {};
    console.log(`    ${label.padEnd(9)} ${String(row.overlay || 0).padEnd(8)} ${String(row.scene || 0).padEnd(6)} ${row.ambiguous || 0}`);
  }
  const acc = (100 * correct) / total;
  console.log(`\n  exact: ${correct}/${total} (${acc.toFixed(1)}%), ambiguous: ${ambiguous}\n`);

  // gates ---------------------------------------------------------------------
  assert.deepEqual(catastrophes, [], `catastrophic scene→overlay on package print:\n${catastrophes.join('\n')}`);
  assert.ok(acc >= 85, `expected ≥85% exact accuracy, got ${acc.toFixed(1)}%`);
  // no confident wrong-direction verdicts: an overlay label must never be
  // confidently 'scene' AND vice versa is covered by the catastrophic gate
  const overlayRow = confusion.overlay || {};
  assert.ok((overlayRow.scene || 0) <= 1, 'at most one overlay line may drop to a confident scene verdict');
});

test('fixture corpus: deterministic (same input ⇒ same verdicts)', { skip: !sharpAvailable && 'sharp not installed' }, async () => {
  const fx = JSON.parse(readFileSync(join(FIXTURE_DIR, '016.json'), 'utf8'));
  const imagePath = join(FIXTURE_DIR, fx.source.path);
  const a = await classifyTextOrigins(imagePath, fx, { photoRegions: fx.photoRegions });
  const b = await classifyTextOrigins(imagePath, fx, { photoRegions: fx.photoRegions });
  assert.deepEqual(a, b);
});

test('photoRegions hint is optional (nullable) and only nudges weak lines', { skip: !sharpAvailable && 'sharp not installed' }, async () => {
  const fx = JSON.parse(readFileSync(join(FIXTURE_DIR, '004.json'), 'utf8'));
  const imagePath = join(FIXTURE_DIR, fx.source.path);
  const withHint = await classifyTextOrigins(imagePath, fx, { photoRegions: fx.photoRegions });
  const noHint = await classifyTextOrigins(imagePath, fx, { photoRegions: null });
  assert.equal(noHint.lines.length, withHint.lines.length);
  // overlay verdicts protected by CTA semantics survive the hint unchanged
  const bestel = (r) => r.lines.find((l) => l.id === 'L4');
  assert.equal(bestel(withHint).origin, 'overlay');
  assert.equal(bestel(noHint).origin, 'overlay');
  // the headline far from any photo region is untouched by the hint
  assert.equal(withHint.lines[0].score, noHint.lines[0].score);
  console.log(`  WEIGHTS: ${JSON.stringify(WEIGHTS)}`);
});
