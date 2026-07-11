// test/scorecard.test.mjs — unit tests for the S12 scorecard's HARD-FAIL rules
// (scripts/scorecard.mjs) on synthetic doc + OCR fixtures. No Chrome, no OCR CLI,
// no pixels: OCR is injected via the `ocr` opts hook, the region/ΔE pass is disabled
// (`regions:false`) and the legacy pixel score pinned (`legacyPixel:null`), so the
// tests exercise pure rule logic. The real-corpus behavior is covered by the
// calibration run: `node scripts/copy-harness.mjs --scorecard-only`.
// Runnable standalone: node test/scorecard.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scoreCopy, normText, similarity, fuzzyContains, bestLineMatch, overlapFrac,
  buildWordStream, windowMatches,
} from '../scripts/scorecard.mjs';

// ---------------------------------------------------------------------------
// fixture helpers
// ---------------------------------------------------------------------------
const line = (text, x, y, w, h, conf = 1) => ({ text, conf, box: { x, y, w, h } });
const s1 = (lines, w = 1000, h = 1000) => ({ ok: true, engine: 'fixture', source: { w, h }, lines });
const textLayer = (text, x, y, w, h, id) => ({ id, type: 'text', text, box: { x, y, w, h } });
const doc = (layers) => ({ canvas: { w: 1000, h: 1000 }, layers });

/** scoreCopy with injected OCR keyed on path, pixels off, legacy pinned. */
function score({ src, ren, doc: d, keptInPhoto }) {
  return scoreCopy({
    sourcePath: 'SRC', renderPath: 'REN', doc: d, keptInPhoto,
    ocr: async (p) => (p === 'SRC' ? src : ren),
    regions: false, legacyPixel: null,
  });
}

const rules = (sc) => sc.hardFails.map((f) => f.rule);

// ---------------------------------------------------------------------------
// string helpers
// ---------------------------------------------------------------------------
test('normText folds case, diacritics, spacing and punctuation', () => {
  assert.equal(normText('  Grüns — Gummy Bears! '), 'grunsgummybears');
  assert.equal(normText('€10.-'), '€10');
  assert.equal(normText('UPGRADE'), normText('upgrade'));
});

test('similarity: identical ⇒ 1, garbled-by-a-char stays high, unrelated low', () => {
  assert.equal(similarity('prebiotics', 'prebiotics'), 1);
  assert.ok(similarity('prebiotics', 'preelotics') >= 0.78);
  assert.ok(similarity('prebiotics', 'gut health') < 0.3);
});

test('fuzzyContains finds a line inside a longer paragraph', () => {
  const para = 'TIJDENS EARLY ACCESS ALLEEN VANDAAG';
  assert.ok(fuzzyContains(para, 'TIJDENS EARLY') >= 0.95);
  assert.ok(fuzzyContains(para, 'iets heel anders qq') < 0.5);
});

test('bestLineMatch joins consecutive OCR lines for multi-line layer text', () => {
  const lines = [line('THE 10 SECOND', 0, 0, 300, 40), line('PARTY', 0, 50, 120, 40), line('UPGRADE', 0, 100, 200, 40)];
  const m = bestLineMatch('THE 10 SECOND PARTY UPGRADE', lines);
  assert.ok(m.sim >= 0.95);
  assert.equal(m.lineIdxs.length, 3);
});

test('overlapFrac is the fraction of the SMALLER box covered', () => {
  assert.equal(overlapFrac({ x: 0, y: 0, w: 100, h: 100 }, { x: 0, y: 0, w: 50, h: 50 }), 1);
  assert.equal(overlapFrac({ x: 0, y: 0, w: 100, h: 100 }, { x: 200, y: 200, w: 50, h: 50 }), 0);
});

// ---------------------------------------------------------------------------
// ghostText
// ---------------------------------------------------------------------------
test('ghostText: same string twice at a small offset ⇒ hard fail', async () => {
  const src = s1([line('SUMMER SALE 50% OFF', 100, 100, 300, 40)]);
  const ren = s1([
    line('SUMMER SALE 50% OFF', 100, 100, 300, 40),   // baked copy (anchored to source)
    line('SUMMER SALE 50% OFF', 112, 130, 300, 40),   // the doubled overlay
  ]);
  const d = doc([textLayer('SUMMER SALE 50% OFF', 100, 100, 300, 40, 't1')]);
  const sc = await score({ src, ren, doc: d });
  assert.equal(sc.ok, false);
  assert.deepEqual(rules(sc), ['ghostText']);
});

test('ghostText: NOT fired when the offset is large (legit repetition elsewhere)', async () => {
  const src = s1([line('SUMMER SALE 50% OFF', 100, 100, 300, 40)]);
  const ren = s1([
    line('SUMMER SALE 50% OFF', 100, 100, 300, 40),
    line('SUMMER SALE 50% OFF', 100, 600, 300, 40), // 500px away — a footer repeat, not a ghost
  ]);
  const d = doc([textLayer('SUMMER SALE 50% OFF', 100, 100, 300, 40, 't1')]);
  const sc = await score({ src, ren, doc: d });
  assert.equal(rules(sc).includes('ghostText'), false);
});

test('ghostText: NOT fired when the source repeats the string too (count guard)', async () => {
  const src = s1([
    line('creatine monohydraat', 100, 100, 200, 20),
    line('creatine monohydraat', 100, 160, 200, 20), // nutrition table lists it twice
  ]);
  const ren = s1([
    line('creatine monohydraat', 100, 100, 200, 20),
    line('creatine monahydraat', 100, 160, 200, 20),
  ]);
  const d = doc([textLayer('creatine monohydraat', 100, 100, 200, 20, 't1'), textLayer('creatine monohydraat', 100, 160, 200, 20, 't2')]);
  const sc = await score({ src, ren, doc: d });
  assert.equal(rules(sc).includes('ghostText'), false);
});

test('ghostText: NOT fired when both occurrences anchor to real source lines (garbled 2nd row)', async () => {
  // the source's second occurrence OCRs back too garbled for the count guard (<0.7)
  // but sits at EXACTLY the same position/width — the anchor guard must clear it.
  const src = s1([
    line('creatine monohydraat', 100, 100, 200, 20),
    line('sttestre monnhutraar', 100, 160, 200, 8), // 8px print, hopeless OCR
  ]);
  const ren = s1([
    line('creatine monohydraat', 100, 100, 200, 20),
    line('creatine monahydraat', 100, 160, 200, 20),
  ]);
  const d = doc([textLayer('creatine monohydraat', 100, 100, 200, 20, 't1'), textLayer('creatine monohydraat', 100, 160, 200, 20, 't2')]);
  const sc = await score({ src, ren, doc: d });
  assert.equal(rules(sc).includes('ghostText'), false);
});

// ---------------------------------------------------------------------------
// word-stream machinery
// ---------------------------------------------------------------------------
test('buildWordStream splits lines into words with proportional boxes', () => {
  const words = buildWordStream([line('Perfect Fit', 100, 500, 200, 38)]);
  assert.equal(words.length, 2);
  assert.equal(words[0].norm, 'perfect');
  assert.equal(words[1].norm, 'fit');
  assert.equal(words[0].box.x, 100);
  assert.ok(words[1].box.x > words[0].box.x);
  assert.ok(Math.abs(words[0].box.w + words[1].box.w - 200) < 0.01);
});

test('windowMatches finds a target across a line break (wrapped overlay)', () => {
  const words = buildWordStream([
    line('Perfect Fit | 20dB Reduction |', 100, 500, 450, 38),
    line('5 Styles', 100, 545, 120, 38),
  ]);
  const occ = windowMatches(words, normText('Perfect Fit | 20dB Reduction | 5 Styles'));
  assert.equal(occ.length, 1); // ONE match spanning both lines — not zero, not per-line noise
  assert.ok(occ[0].sim >= 0.95);
});

test('windowMatches returns disjoint occurrences for a repeated string', () => {
  const words = buildWordStream([
    line('SUMMER SALE 50% OFF', 100, 100, 300, 40),
    line('SUMMER SALE 50% OFF', 112, 130, 300, 40),
  ]);
  const occ = windowMatches(words, normText('SUMMER SALE 50% OFF'));
  assert.equal(occ.length, 2);
});

// ---------------------------------------------------------------------------
// ghostText — wrapped-overlay variants (the 018 miss)
// ---------------------------------------------------------------------------
test('ghostText: WRAPPED overlay still matches its unwrapped baked twin (word-sequence)', async () => {
  // the overlay re-flowed "Perfect Fit | 20dB Reduction | 5 Styles" onto two lines;
  // the baked twin is one line at a small offset. Line-level pairing can never match
  // a 2-line string against a 1-line string — the word stream must.
  const src = s1([line('Perfect Fit | 20dB Reduction | 5 Styles', 100, 500, 574, 38)]);
  const ren = s1([
    line('Perfect Fit | 20dB Reduction |', 100, 500, 450, 38), // overlay line 1
    line('5 Styles', 100, 545, 120, 38),                       // overlay line 2 (wrapped)
    line('Perfect Fit | 20dB Reduction | 5 Styles', 110, 516, 574, 38), // baked twin, one line
  ]);
  const d = doc([textLayer('Perfect Fit | 20dB Reduction | 5 Styles', 100, 500, 574, 38, 't1')]);
  const sc = await score({ src, ren, doc: d });
  assert.equal(sc.ok, false);
  assert.ok(rules(sc).includes('ghostText'));
});

test('ghostText: merged-residue — OCR fuses overlay+twin into one inflated line (018)', async () => {
  // real 018 geometry: Apple Vision reports the ghost and the overlay's first line as
  // ONE garbled line ("Perfect Fit)20dB Reductiohes", h 55px vs the 38px source line,
  // starting 10px above the layer box) — no word sequence ever appears twice.
  const src = s1([
    line('• Hears Earplugs', 322, 187, 430, 57),
    line('THE 10 SECOND', 94, 368, 574, 66),
    line('Perfect Fit | 20dB Reduction | 5 Styles', 100, 1028, 574, 38),
  ], 1080, 1360);
  const ren = s1([
    line('• Hears', 424, 191, 216, 60),
    line('Earplugs', 415, 247, 247, 62),
    line('THE 10 SECOND', 90, 368, 526, 68),
    line('Perfect Fit)20dB Reductiohes', 98, 1017, 577, 55), // overlay line 1 FUSED with ghost
    line('5 Styles', 98, 1070, 154, 40),                     // overlay line 2
  ], 1080, 1360);
  const d = {
    canvas: { w: 1080, h: 1360 },
    layers: [
      { id: 'logo', type: 'text', role: 'logo', text: '• Hears Earplugs', box: { x: 322, y: 187, w: 430, h: 57 } },
      { id: 'head', type: 'text', role: 'headline', text: 'THE 10 SECOND', box: { x: 94, y: 368, w: 574, h: 66 } },
      { id: 'sub', type: 'text', role: 'subhead', text: 'Perfect Fit | 20dB Reduction | 5 Styles', box: { x: 100, y: 1028, w: 574, h: 38 } },
    ],
  };
  const sc = await score({ src, ren, doc: d });
  assert.equal(sc.ok, false);
  assert.ok(rules(sc).includes('ghostText'));
  assert.match(sc.hardFails.find((f) => f.rule === 'ghostText').detail, /fused ghost ink/);
  // …and the same render must also flag the wrap drift (logo AND subhead wrapped 1→2)
  assert.ok(rules(sc).includes('wrapMismatch'));
  assert.equal(sc.text.wrapMismatches.length, 2);
});

test('ghostText residue: honest wrap (clean line heights, no overhang) does NOT fire', async () => {
  // 018's logo layer also wraps 1→2 but its OCR lines keep honest heights and stay
  // inside the box — wrap drift alone is wrapMismatch business, not a ghost.
  const src = s1([line('• Hears Earplugs', 322, 187, 430, 57)], 1080, 1360);
  const ren = s1([line('• Hears', 424, 191, 216, 60), line('Earplugs', 415, 247, 247, 62)], 1080, 1360);
  const d = {
    canvas: { w: 1080, h: 1360 },
    layers: [{ id: 'logo', type: 'text', role: 'logo', text: '• Hears Earplugs', box: { x: 322, y: 187, w: 430, h: 57 } }],
  };
  const sc = await score({ src, ren, doc: d });
  assert.equal(rules(sc).includes('ghostText'), false);
});

test('ghostText: word inside an anchored table row does NOT pair with a nearby label (002)', async () => {
  // render has a "CREATINE" label + a table row "creatine monohydraat" right under it;
  // the source's row OCRs back garbled 6px soup, so only the lenient line-level anchor
  // sees it — the word-level occurrence must inherit that anchor, not fire as a ghost.
  const src = s1([
    line('CREATINE', 717, 1461, 126, 30),
    line('sttestre monnhutraar', 728, 1520, 109, 6), // hopeless 6px table row OCR
  ], 1080, 1920);
  const ren = s1([
    line('CREATINE', 717, 1462, 126, 28),
    line('creatine monohydraat', 728, 1521, 109, 14),
  ], 1080, 1920);
  const d = {
    canvas: { w: 1080, h: 1920 },
    layers: [
      { id: 'lbl', type: 'text', text: 'CREATINE', box: { x: 717, y: 1461, w: 126, h: 30 } },
      { id: 'row', type: 'text', text: 'creatine monohydraat', box: { x: 728, y: 1520, w: 109, h: 14 } },
    ],
  };
  const sc = await score({ src, ren, doc: d });
  assert.equal(rules(sc).includes('ghostText'), false);
});

// ---------------------------------------------------------------------------
// wrapMismatch
// ---------------------------------------------------------------------------
test('wrapMismatch: subhead over-wrap (source 1 line → render 2) ⇒ hard fail', async () => {
  const src = s1([line('Waar je voorheen stopte, begin je nu.', 285, 463, 522, 34)]);
  const ren = s1([
    line('Waar je voorheen stopte, begin je', 240, 469, 600, 34),
    line('nu.', 511, 522, 59, 28),
  ]);
  const d = doc([{ id: 'sub', type: 'text', role: 'subhead', text: 'Waar je voorheen stopte, begin je nu.', box: { x: 285, y: 463, w: 522, h: 34 } }]);
  const sc = await score({ src, ren, doc: d });
  assert.equal(sc.ok, false);
  assert.ok(rules(sc).includes('wrapMismatch'));
  assert.deepEqual(sc.text.wrapMismatches, [{ id: 'sub', text: 'Waar je voorheen stopte, begin je nu.', role: 'subhead', sourceLines: 1, renderLines: 2 }]);
});

test('wrapMismatch: single non-headline over-wrap is a soft penalty, not a hard fail', async () => {
  const src = s1([line('GRAB YOURS TODAY', 100, 800, 300, 30)]);
  const wrapped = s1([line('GRAB YOURS', 100, 800, 180, 30), line('TODAY', 100, 835, 90, 30)]);
  const clean = s1([line('GRAB YOURS TODAY', 100, 800, 300, 30)]);
  const d = doc([{ id: 'cta', type: 'text', role: 'cta', text: 'GRAB YOURS TODAY', box: { x: 100, y: 800, w: 300, h: 30 } }]);
  const scWrapped = await score({ src, ren: wrapped, doc: d });
  const scClean = await score({ src, ren: clean, doc: d });
  assert.equal(scWrapped.ok, true); // one caption/cta wrap ⇒ soft only
  assert.equal(scWrapped.text.wrapMismatches.length, 1);
  assert.ok(scWrapped.composite < scClean.composite); // …but the composite pays for it
});

test('wrapMismatch: two single-source-line over-wraps ⇒ hard fail even without roles', async () => {
  const src = s1([
    line('creatine monohvdraat', 205, 1264, 147, 27),
    line('Bestel op Upfront.nl', 357, 1515, 371, 45),
  ], 1080, 1620);
  const ren = s1([
    line('creatine', 206, 1267, 89, 20),
    line('monohvdraat', 206, 1295, 145, 20),
    line('Bestel op', 441, 1517, 207, 47),
    line('Upfront.nl', 430, 1560, 229, 50),
  ], 1080, 1620);
  const d = {
    canvas: { w: 1080, h: 1620 },
    layers: [
      { id: 'cap', type: 'text', role: 'caption', text: 'creatine monohvdraat', box: { x: 205, y: 1264, w: 147, h: 27 } },
      { id: 'cta', type: 'text', role: 'cta', text: 'Bestel op Upfront.nl', box: { x: 357, y: 1515, w: 371, h: 45 } },
    ],
  };
  const sc = await score({ src, ren, doc: d });
  assert.equal(sc.ok, false);
  assert.ok(rules(sc).includes('wrapMismatch'));
});

test('wrapMismatch: under-wrap (render merges lines) is recorded but never penalized', async () => {
  const src = s1([line('Get up', 100, 100, 100, 30), line('to', 100, 135, 40, 30)]);
  const ren = s1([line('Get up to', 100, 100, 150, 30)]);
  const d = doc([{ id: 'b', type: 'text', role: 'badge', text: 'Get up to', box: { x: 100, y: 100, w: 150, h: 65 } }]);
  const sc = await score({ src, ren, doc: d });
  assert.equal(sc.ok, true);
  assert.equal(rules(sc).includes('wrapMismatch'), false);
  assert.equal(sc.text.wrapMismatches.length, 1); // visible in the report…
  assert.equal(sc.text.wrapMismatches[0].renderLines, 1); // …as 2→1
  assert.equal(sc.text.wrapMismatches[0].sourceLines, 2);
});

// ---------------------------------------------------------------------------
// logoGlyphSub (soft)
// ---------------------------------------------------------------------------
test('logoGlyphSub: render bullet where the source has none ⇒ recorded + composite penalty', async () => {
  const src = s1([line('ACME SHOES', 100, 100, 300, 40), line('OTHER LINE HERE', 100, 300, 300, 30)]);
  const renBullet = s1([line('• ACME SHOES', 95, 100, 320, 40), line('OTHER LINE HERE', 100, 300, 300, 30)]);
  const renClean = s1([line('ACME SHOES', 100, 100, 300, 40), line('OTHER LINE HERE', 100, 300, 300, 30)]);
  const d = doc([
    textLayer('• ACME SHOES', 95, 100, 320, 40, 't1'),
    textLayer('OTHER LINE HERE', 100, 300, 300, 30, 't2'),
  ]);
  const dClean = doc([
    textLayer('ACME SHOES', 100, 100, 300, 40, 't1'),
    textLayer('OTHER LINE HERE', 100, 300, 300, 30, 't2'),
  ]);
  const scBullet = await score({ src, ren: renBullet, doc: d });
  const scClean = await score({ src, ren: renClean, doc: dClean });
  assert.equal(scBullet.ok, true); // soft signal only
  assert.equal(scBullet.text.logoGlyphSubs.length, 1);
  assert.match(scBullet.text.logoGlyphSubs[0].render, /ACME/);
  assert.ok(scBullet.composite < scClean.composite);
});

test('logoGlyphSub: NOT recorded when the source line has the bullet too', async () => {
  const src = s1([line('• Hears Earplugs', 322, 187, 430, 57)]);
  const ren = s1([line('• Hears Earplugs', 322, 187, 430, 57)]);
  const d = doc([textLayer('• Hears Earplugs', 322, 187, 430, 57, 't1')]);
  const sc = await score({ src, ren, doc: d });
  assert.equal(sc.text.logoGlyphSubs.length, 0);
});

// ---------------------------------------------------------------------------
// placeholderArtifact
// ---------------------------------------------------------------------------
test('placeholderArtifact: invented label absent from source OCR ⇒ hard fail', async () => {
  const src = s1([line('THE 10 SECOND', 100, 100, 300, 40), line('PARTY UPGRADE', 100, 160, 300, 40), line('Hears Earplugs', 100, 300, 200, 30)]);
  const ren = s1([line('THE 10 SECOND', 100, 100, 300, 40), line('PARTY UPGRADE', 100, 160, 300, 40), line('WHITE EARPLUG', 500, 400, 200, 30)]);
  const d = doc([
    textLayer('THE 10 SECOND', 100, 100, 300, 40, 't1'),
    textLayer('PARTY UPGRADE', 100, 160, 300, 40, 't2'),
    textLayer('WHITE EARPLUG', 500, 400, 200, 30, 't3'), // matte-fallback placeholder label
  ]);
  const sc = await score({ src, ren, doc: d });
  assert.equal(sc.ok, false);
  assert.deepEqual(rules(sc), ['placeholderArtifact']);
  assert.match(sc.hardFails[0].detail, /WHITE EARPLUG/);
});

test('placeholderArtifact: NOT fired on real text with matching source line', async () => {
  const src = s1([line('SHOP THE SALE', 100, 100, 300, 40)]);
  const ren = s1([line('SHOP THE SALE', 100, 100, 300, 40)]);
  const d = doc([textLayer('SHOP THE SALE', 100, 100, 300, 40, 't1')]);
  const sc = await score({ src, ren, doc: d });
  assert.equal(sc.ok, true);
});

test('placeholderArtifact: word-bag saves column-interleaved OCR reading order', async () => {
  // two-column VS layout: OCR interleaves the columns, so no consecutive-line window
  // reconstructs "Protects skin and hair" — but every word exists in the source.
  const src = s1([
    line('Protects', 700, 100, 150, 40),
    line('Causes friction with', 100, 120, 300, 40),
    line('skin and hair', 700, 150, 200, 40),
  ]);
  const ren = s1([
    line('Protects', 700, 100, 150, 40),
    line('Causes friction with', 100, 120, 300, 40),
    line('skin and hair', 700, 150, 200, 40),
  ]);
  const d = doc([
    textLayer('Protects skin and hair', 700, 100, 200, 90, 't1'),
    textLayer('Causes friction with', 100, 120, 300, 40, 't2'),
  ]);
  const sc = await score({ src, ren, doc: d });
  assert.equal(rules(sc).includes('placeholderArtifact'), false);
});

// ---------------------------------------------------------------------------
// textPile
// ---------------------------------------------------------------------------
test('textPile: ≥3 mutually-overlapping text pairs ⇒ hard fail', async () => {
  const src = s1([line('AAA BBB CCC', 100, 100, 300, 40)]);
  const ren = s1([line('AAA BBB CCC', 100, 100, 300, 40)]);
  const d = doc([
    textLayer('AAA BBB CCC', 100, 100, 300, 40, 't1'),
    textLayer('AAA BBB CCC', 105, 105, 300, 40, 't2'),
    textLayer('AAA BBB CCC', 110, 110, 300, 40, 't3'), // 3 layers stacked ⇒ 3 pairs
  ]);
  const sc = await score({ src, ren, doc: d });
  assert.equal(sc.ok, false);
  assert.ok(rules(sc).includes('textPile'));
  assert.equal(sc.text.pileOverlaps, 3);
});

test('textPile: 1 overlapping pair is a soft penalty, not a hard fail', async () => {
  const src = s1([line('AAA BBB CCC', 100, 100, 300, 40), line('DDD EEE FFF', 100, 300, 300, 40)]);
  const ren = s1([line('AAA BBB CCC', 100, 100, 300, 40), line('DDD EEE FFF', 100, 300, 300, 40)]);
  const clean = doc([
    textLayer('AAA BBB CCC', 100, 100, 300, 40, 't1'),
    textLayer('DDD EEE FFF', 100, 300, 300, 40, 't2'),
  ]);
  const piled = doc([
    textLayer('AAA BBB CCC', 100, 100, 300, 40, 't1'),
    textLayer('DDD EEE FFF', 110, 110, 300, 40, 't2'), // overlaps t1
  ]);
  const scClean = await score({ src, ren, doc: clean });
  const scPiled = await score({ src, ren, doc: piled });
  assert.equal(scPiled.ok, true); // no hard fail at 1 pair…
  assert.equal(scPiled.text.pileOverlaps, 1);
  assert.ok(scPiled.composite < scClean.composite); // …but the composite pays for it
});

// ---------------------------------------------------------------------------
// missingText
// ---------------------------------------------------------------------------
const missingSrc = () => s1([
  line('HEADLINE HERE', 100, 100, 400, 50),
  line('SUBLINE COPY TEXT', 100, 200, 400, 30),
  line('CALL TO ACTION', 100, 300, 300, 30),
  line('FINE PRINT DETAILS', 100, 400, 300, 20),
  line('LAST LINE STANDING', 100, 500, 300, 20),
]);

test('missingText: >20% of source lines nowhere in the copy ⇒ hard fail', async () => {
  const ren = s1([line('HEADLINE HERE', 100, 100, 400, 50), line('SUBLINE COPY TEXT', 100, 200, 400, 30), line('CALL TO ACTION', 100, 300, 300, 30)]);
  const d = doc([
    textLayer('HEADLINE HERE', 100, 100, 400, 50, 't1'),
    textLayer('SUBLINE COPY TEXT', 100, 200, 400, 30, 't2'),
    textLayer('CALL TO ACTION', 100, 300, 300, 30, 't3'),
    // FINE PRINT DETAILS + LAST LINE STANDING dropped ⇒ 2/5 = 40% missing
  ]);
  const sc = await score({ src: missingSrc(), ren, doc: d });
  assert.equal(sc.ok, false);
  assert.deepEqual(rules(sc), ['missingText']);
  assert.equal(sc.text.textRecall, 0.6);
});

test('missingText: keptInPhoto entries rescue intentionally-baked strings', async () => {
  const ren = s1([line('HEADLINE HERE', 100, 100, 400, 50), line('SUBLINE COPY TEXT', 100, 200, 400, 30), line('CALL TO ACTION', 100, 300, 300, 30)]);
  const d = doc([
    textLayer('HEADLINE HERE', 100, 100, 400, 50, 't1'),
    textLayer('SUBLINE COPY TEXT', 100, 200, 400, 30, 't2'),
    textLayer('CALL TO ACTION', 100, 300, 300, 30, 't3'),
  ]);
  const sc = await score({ src: missingSrc(), ren, doc: d, keptInPhoto: ['FINE PRINT DETAILS', 'LAST LINE STANDING'] });
  assert.equal(sc.ok, true);
  assert.equal(sc.text.textRecall, 1);
});

test('missingText: text visibly baked in the render (photo base) counts as covered', async () => {
  // 021-class copy: doc is ONE image layer, all text rides in the photo — the render
  // OCR finds every string at the source position, so nothing is "missing".
  const src = s1([line('BUY TWO', 100, 100, 300, 60), line('FOR FREE', 100, 200, 300, 60), line('LIMITED OFFER', 100, 300, 300, 30)]);
  const ren = s1([line('BUY TWO', 100, 100, 300, 60), line('FOR FREE', 100, 200, 300, 60), line('LIMITED OFFER', 100, 300, 300, 30)]);
  const d = doc([{ id: 'bg', type: 'image', box: { x: 0, y: 0, w: 1000, h: 1000 } }]);
  const sc = await score({ src, ren, doc: d });
  assert.equal(sc.ok, true);
  assert.equal(sc.text.textRecall, 1);
  assert.ok(sc.text.sourceLines.every((l) => l.how === 'render-baked'));
});

// ---------------------------------------------------------------------------
// alignment aggregates + output shape
// ---------------------------------------------------------------------------
test('aggregates: stringOk / posDelta / recall / composite on a clean copy', async () => {
  const src = s1([line('HELLO WORLD', 100, 100, 300, 40), line('SECOND LINE', 100, 200, 300, 30), line('THIRD LINE HERE', 100, 300, 300, 30)]);
  const ren = s1([line('HELLO WORLD', 104, 103, 300, 40), line('SECOND LINE', 100, 200, 300, 30), line('THIRD LINE HERE', 100, 300, 300, 30)]);
  const d = doc([
    textLayer('HELLO WORLD', 100, 100, 300, 40, 't1'),
    textLayer('SECOND LINE', 100, 200, 300, 30, 't2'),
    textLayer('THIRD LINE HERE', 100, 300, 300, 30, 't3'),
  ]);
  const sc = await score({ src, ren, doc: d });
  assert.equal(sc.ok, true);
  assert.equal(sc.text.textRenderAcc, 1);
  assert.equal(sc.text.textRecall, 1);
  assert.ok(sc.text.layers.every((l) => l.stringOk === true));
  const t1 = sc.text.layers.find((l) => l.id === 't1');
  assert.ok(t1.posDeltaPx > 0 && t1.posDeltaPx < 10); // (104,103) vs (100,100)
  assert.ok(sc.composite >= 95);
  // shape: every contract field present
  for (const k of ['ok', 'hardFails', 'text', 'regions', 'legacyPixel', 'composite']) assert.ok(k in sc, `missing ${k}`);
});

test('garbled render text ⇒ stringOk false, renderAcc drops', async () => {
  const src = s1([line('SUPPLEMENTEN DIE AANVULLEN', 100, 100, 500, 50)]);
  const ren = s1([line('SUPPLEMEN7EN D1E AANVLLLLEN xx yy', 40, 400, 300, 50)]);
  const d = doc([textLayer('SUPPLEMENTEN DIE AANVULLEN', 100, 100, 500, 50, 't1')]);
  const sc = await score({ src, ren, doc: d });
  const t1 = sc.text.layers.find((l) => l.id === 't1');
  assert.equal(t1.stringOk, false);
  assert.equal(sc.text.textRenderAcc, 0);
});

test('degrades gracefully when OCR fails on both sides (no throw, no hard fails)', async () => {
  const bad = { ok: false, error: 'engine down' };
  const sc = await scoreCopy({
    sourcePath: 'SRC', renderPath: 'REN', doc: doc([textLayer('ANY TEXT HERE', 0, 0, 100, 20, 't1')]),
    ocr: async () => bad, regions: false, legacyPixel: null,
  });
  assert.equal(sc.ok, true); // no evidence ⇒ no hard fails; gate stays honest elsewhere
  assert.equal(sc.text.ocrOk.source, false);
  assert.equal(sc.text.ocrOk.render, false);
  assert.equal(sc.composite, null);
});
