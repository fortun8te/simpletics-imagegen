// test/semantics.test.mjs — S10 semantics validator + facts-payload budget (lib/semantics.mjs).
//
// NO live model calls: validateSemantics and buildFactsPayload are pure, so every contract rule
// (unknown ids dropped, missing→'other', role coercion, order-permutation gate, groups ≥2,
// flag-note truncation) is exercised with hand-written malformed replies. The budget test feeds
// 60 blocks and asserts the deterministic reduction ladder keeps the payload under the cap.
//
// Run standalone: node test/semantics.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFactsPayload, validateSemantics, tolerantParseJson, fillToString,
  TEXT_ROLES, ELEMENT_ROLES,
} from '../lib/semantics.mjs';

// ---------------------------------------------------------------------------------------------
// shared fixture facts (contract-shaped)
// ---------------------------------------------------------------------------------------------
const FACTS = {
  canvas: { w: 1080, h: 1350 },
  texts: [
    { id: 'B0', text: 'THE 10 SECOND', box: { x: 86, y: 340, w: 594, h: 109 }, fontSizePx: 88 },
    { id: 'B1', text: 'Up To 30% Off', box: { x: 324, y: 1224, w: 432, h: 71 }, fontSizePx: 36 },
    { id: 'B2', text: 'Perfect Fit | 20dB Reduction', box: { x: 108, y: 1115, w: 734, h: 54 }, fontSizePx: 28 },
  ],
  elements: [
    { id: 'E0', box: { x: 702, y: 748, w: 378, h: 340 }, kind: 'photo' },
    { id: 'E1', box: { x: 22, y: 517, w: 324, h: 340 }, kind: 'shape' },
  ],
  regions: [
    { id: 'R0', box: { x: 0, y: 0, w: 1080, h: 1350 }, fill: 'flat #101010' },
  ],
};

// ---------------------------------------------------------------------------------------------
// validateSemantics — contract rules against malformed replies
// ---------------------------------------------------------------------------------------------
test('validator: clean reply passes through, output covers every id in facts order', () => {
  const clean = validateSemantics({
    texts: [{ id: 'B0', role: 'headline' }, { id: 'B1', role: 'cta' }, { id: 'B2', role: 'caption' }],
    elements: [{ id: 'E0', role: 'product' }, { id: 'E1', role: 'product' }],
    groups: [{ name: 'cta block', members: ['B1', 'B2'] }],
    order: [],
    flags: [{ id: 'E0', note: 'black earplug cutout' }],
  }, FACTS);
  assert.deepEqual(clean.texts, [
    { id: 'B0', role: 'headline' }, { id: 'B1', role: 'cta' }, { id: 'B2', role: 'caption' },
  ]);
  assert.deepEqual(clean.elements, [{ id: 'E0', role: 'product' }, { id: 'E1', role: 'product' }]);
  assert.deepEqual(clean.groups, [{ name: 'cta block', members: ['B1', 'B2'] }]);
  assert.deepEqual(clean.order, []);
  assert.deepEqual(clean.flags, [{ id: 'E0', note: 'black earplug cutout' }]);
});

test('validator: unknown ids dropped, missing ids defaulted to other', () => {
  const clean = validateSemantics({
    texts: [
      { id: 'B0', role: 'headline' },
      { id: 'B7', role: 'cta' },          // invented id → dropped
      { id: 'E0', role: 'cta' },          // element id in the texts list → dropped
    ],
    elements: [{ id: 'E99', role: 'product' }],  // invented → dropped
  }, FACTS);
  assert.deepEqual(clean.texts, [
    { id: 'B0', role: 'headline' },
    { id: 'B1', role: 'other' },          // missing → defaulted
    { id: 'B2', role: 'other' },
  ]);
  assert.deepEqual(clean.elements, [{ id: 'E0', role: 'other' }, { id: 'E1', role: 'other' }]);
});

test('validator: role typos and case coerced to the enum ("CTA", "head line", "Head-Line")', () => {
  const clean = validateSemantics({
    texts: [
      { id: 'B0', role: 'head line' },
      { id: 'B1', role: 'CTA' },
      { id: 'B2', role: 'Sub-Head' },
    ],
    elements: [
      { id: 'E0', role: 'PRODUCT' },
      { id: 'E1', role: 'ui chrome' },
    ],
  }, FACTS);
  assert.deepEqual(clean.texts.map((t) => t.role), ['headline', 'cta', 'subhead']);
  assert.deepEqual(clean.elements.map((e) => e.role), ['product', 'ui-chrome']);
});

test('validator: unknown role words become other, never invented enum values', () => {
  const clean = validateSemantics({
    texts: [{ id: 'B0', role: 'mega-title-9000' }, { id: 'B1', role: 42 }, { id: 'B2', role: null }],
    elements: [{ id: 'E0', role: 'spaceship' }],
  }, FACTS);
  for (const t of clean.texts) assert.ok(TEXT_ROLES.includes(t.role));
  for (const e of clean.elements) assert.ok(ELEMENT_ROLES.includes(e.role));
  assert.deepEqual(clean.texts.map((t) => t.role), ['other', 'other', 'other']);
  assert.equal(clean.elements[0].role, 'other');
});

test('validator: order rejected when it contains non-ambiguous ids or is not a permutation', () => {
  // caller marked E0/E1 ambiguous
  const opts = { ambiguousIds: ['E0', 'E1'] };
  // contains a non-ambiguous id → rejected
  assert.deepEqual(validateSemantics({ order: ['E0', 'B0'] }, FACTS, opts).order, []);
  // wrong length → rejected
  assert.deepEqual(validateSemantics({ order: ['E0'] }, FACTS, opts).order, []);
  // duplicates → rejected
  assert.deepEqual(validateSemantics({ order: ['E0', 'E0'] }, FACTS, opts).order, []);
  // exact permutation → accepted verbatim
  assert.deepEqual(validateSemantics({ order: ['E1', 'E0'] }, FACTS, opts).order, ['E1', 'E0']);
  // no ambiguous set declared → any order is ignored
  assert.deepEqual(validateSemantics({ order: ['E0', 'E1'] }, FACTS).order, []);
});

test('validator: groups of 1 dropped, unknown members filtered, dupes deduped', () => {
  const clean = validateSemantics({
    groups: [
      { name: 'lonely', members: ['B0'] },                       // 1 member → dropped
      { name: 'ghosts', members: ['Z1', 'Z2'] },                 // all unknown → dropped
      { name: 'body', members: ['B1', 'ZZZ', 'B1', 'B2'] },      // filter + dedupe → 2 members
      { name: 'x'.repeat(200), members: ['E0', 'E1'] },          // name truncated
      { members: ['B0', 'E0'] },                                  // missing name → default
    ],
  }, FACTS);
  assert.equal(clean.groups.length, 3);
  assert.deepEqual(clean.groups[0], { name: 'body', members: ['B1', 'B2'] });
  assert.equal(clean.groups[1].name.length, 60);
  assert.equal(clean.groups[2].name, 'group');
});

test('validator: flags — unknown ids dropped, notes truncated to 120 chars, empty notes dropped', () => {
  const clean = validateSemantics({
    flags: [
      { id: 'E0', note: 'y'.repeat(500) },
      { id: 'NOPE', note: 'invented id' },
      { id: 'B0', note: '   ' },
      { id: 'R0', note: 'page background' },   // region ids are known ids too
    ],
  }, FACTS);
  assert.equal(clean.flags.length, 2);
  assert.equal(clean.flags[0].id, 'E0');
  assert.equal(clean.flags[0].note.length, 120);
  assert.deepEqual(clean.flags[1], { id: 'R0', note: 'page background' });
});

test('validator: garbage replies (null, prose string, arrays, extra keys) yield safe defaults', () => {
  for (const junk of [null, undefined, 'sure, here you go!', 42, ['texts'], { texts: 'B0', elements: { id: 'E0' }, geometry: [{ id: 'B0', box: { x: 0 } }], bonus: true }]) {
    const clean = validateSemantics(junk, FACTS, { ambiguousIds: ['E0', 'E1'] });
    assert.deepEqual(Object.keys(clean).sort(), ['elements', 'flags', 'groups', 'order', 'texts']);
    assert.deepEqual(clean.texts.map((t) => t.role), ['other', 'other', 'other']);
    assert.deepEqual(clean.elements.map((e) => e.role), ['other', 'other']);
    assert.deepEqual(clean.groups, []);
    assert.deepEqual(clean.order, []);
    assert.deepEqual(clean.flags, []);
    // no extra keys survive on items either
    assert.deepEqual(Object.keys(clean.texts[0]).sort(), ['id', 'role']);
  }
});

test('validator: per-item extra keys (box, text, score) are stripped from the output', () => {
  const clean = validateSemantics({
    texts: [{ id: 'B0', role: 'headline', box: { x: 1, y: 2 }, text: 'INJECTED', score: 0.9 }],
    elements: [{ id: 'E0', role: 'product', geometry: [1, 2, 3] }],
  }, FACTS);
  assert.deepEqual(clean.texts[0], { id: 'B0', role: 'headline' });
  assert.deepEqual(clean.elements[0], { id: 'E0', role: 'product' });
});

// ---------------------------------------------------------------------------------------------
// tolerantParseJson — fenced / prose-wrapped replies
// ---------------------------------------------------------------------------------------------
test('tolerant parse: plain JSON, ```fences```, and trailing prose all parse', () => {
  const obj = { texts: [{ id: 'B0', role: 'headline' }] };
  const json = JSON.stringify(obj);
  assert.deepEqual(tolerantParseJson(json), obj);
  assert.deepEqual(tolerantParseJson('```json\n' + json + '\n```'), obj);
  assert.deepEqual(tolerantParseJson('Here is the labeling you asked for:\n' + json + '\nLet me know if you need anything else!'), obj);
  assert.deepEqual(tolerantParseJson('```\n' + json + '\n``` hope that helps {smile}'), obj);
  assert.equal(tolerantParseJson('no json here at all'), null);
  assert.equal(tolerantParseJson(''), null);
  assert.equal(tolerantParseJson(null), null);
});

test('tolerant parse: balanced scan survives prose containing braces after the object', () => {
  const obj = { a: 1, b: { c: 'x}y' } };
  const s = JSON.stringify(obj) + ' — note: {this trailing pseudo-block is not JSON';
  assert.deepEqual(tolerantParseJson(s), obj);
});

// ---------------------------------------------------------------------------------------------
// fillToString — compact fill strings
// ---------------------------------------------------------------------------------------------
test('fillToString: flat / linear / radial / photo compaction', () => {
  assert.equal(fillToString({ kind: 'flat', color: '#101010' }), 'flat #101010');
  assert.equal(fillToString({ kind: 'linear', angleDeg: 172.4, stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: '#333333' }] }), 'linear #000→#333 172°');
  assert.equal(fillToString({ kind: 'radial', stops: [{ offset: 0, color: '#ffffff' }, { offset: 1, color: '#a1b2c3' }] }), 'radial #fff→#a1b2c3');
  assert.equal(fillToString({ kind: 'photo' }), 'photo');
  assert.equal(fillToString(null), 'photo');
  assert.equal(fillToString('flat #123456'), 'flat #123456');
});

// ---------------------------------------------------------------------------------------------
// buildFactsPayload — budget + deterministic reduction
// ---------------------------------------------------------------------------------------------
test('payload: small facts pass through untouched (text ≤80, regions kept)', () => {
  const p = buildFactsPayload(FACTS);
  assert.ok(p.tokens <= 2000);
  assert.deepEqual(p.dropped, []);
  assert.equal(p.facts.regions.length, 1);
  assert.equal(p.facts.texts[0].text, 'THE 10 SECOND');
  assert.equal(p.imageBudget, 2000 - p.tokens);
  // boxes rounded to ints
  const parsed = JSON.parse(p.factsJson);
  assert.equal(parsed.texts[0].box.x, 86);
});

test('payload: 60 long blocks stay under the ~2000 token cap; reduction is deterministic', () => {
  const blocks = Array.from({ length: 60 }, (_, i) => ({
    id: `B${i}`,
    text: `Block ${i}: ${'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor '.repeat(3)}`,
    box: { x: 10.7 + i, y: 20.2 + i * 22, w: 900.9, h: 21.1 },
    fontSizePx: 18.6,
  }));
  const regions = Array.from({ length: 12 }, (_, i) => ({
    id: `R${i}`, box: { x: 0, y: i * 100, w: 1080, h: 100 },
    fill: { kind: 'linear', angleDeg: 90 + i, stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: '#333333' }] },
  }));
  const input = { canvas: { w: 1080, h: 1350 }, blocks, elements: FACTS.elements, regions };
  const p1 = buildFactsPayload(input);
  assert.ok(p1.tokens <= 2000, `payload over cap: ${p1.tokens} tokens`);
  assert.ok(p1.dropped.length >= 1, 'expected the reduction ladder to fire');
  // regions are the FIRST thing to go
  assert.match(p1.dropped[0], /^regions/);
  assert.equal(p1.facts.regions, undefined);
  // every text still ≤80 chars and every id survives
  assert.equal(p1.facts.texts.length, 60);
  for (const t of p1.facts.texts) assert.ok(t.text.length <= 80);
  // deterministic: identical input → byte-identical payload and identical drop log
  const p2 = buildFactsPayload(input);
  assert.equal(p1.factsJson, p2.factsJson);
  assert.deepEqual(p1.dropped, p2.dropped);
});

test('payload: extreme text volume falls through the whole ladder and still fits', () => {
  const blocks = Array.from({ length: 60 }, (_, i) => ({
    id: `B${i}`, text: 'x'.repeat(400) + ` tail-${i}`, box: { x: 0, y: i, w: 100, h: 20 }, fontSizePx: 16,
  }));
  const p = buildFactsPayload({ canvas: { w: 1080, h: 1080 }, blocks, elements: [], regions: [] });
  assert.ok(p.tokens <= 2000, `still over cap after full ladder: ${p.tokens}`);
  assert.ok(p.dropped.some((d) => /text truncated/.test(d)));
});

test('payload: missing ids are synthesized (B<n>/E<n>/R<n>) and inputs may be sparse', () => {
  const p = buildFactsPayload({
    canvas: { w: 500, h: 500 },
    blocks: [{ text: 'hello', box: { x: 1, y: 2, w: 3, h: 4 } }],
    elements: [{ box: { x: 0, y: 0, w: 10, h: 10 }, kind: 'icon' }],
  });
  assert.equal(p.facts.texts[0].id, 'B0');
  assert.equal(p.facts.elements[0].id, 'E0');
  assert.equal(p.facts.regions.length, 0);
});
