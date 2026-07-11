// test/text-blocks.test.mjs — S2.5 line→block merge (lib/text-blocks.mjs).
//
// Synthetic cases exercise each merge criterion in isolation (fontSize delta, vertical
// gap, alignment guide, origin verdict, region boundary, ink ΔE via drawn pixels).
// Real-corpus cases (skip gracefully when ~/Downloads/IMAGE AD INSPO/ or bin/ocrjson is
// absent) run Apple-Vision OCR on ads 002/004/016/018, merge, PRINT the block list per
// case, and assert the wave-2 acceptance examples:
//   016 — the two headline lines merge into ONE block,
//   018 — "THE 10 SECOND" / "PARTY" / "UPGRADE" stay SEPARATE blocks,
//   004 — the ingredient fine-print lines merge into few blocks (not one per line),
//   002 — the ingredient paragraph merges.
//
// Run standalone: node test/text-blocks.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { mergeLinesToBlocks, measureInkColor, deltaE, otsuThreshold } from '../lib/text-blocks.mjs';

// ---------------------------------------------------------------------------------------------
// synthetic helpers
// ---------------------------------------------------------------------------------------------

/** Minimal S1 line: box + text (+optional words/quad). */
const line = (id, x, y, w, h, text = 'x', words = null) => ({
  id, text, conf: 1,
  box: { x, y, w, h },
  quad: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]],
  words: words ?? [{ text, conf: 1, box: { x, y, w, h } }],
});
const s1 = (w, h, lines) => ({ engine: 'test', source: { path: 't', w, h }, lines });

/** RGBA canvas filled with `bg`, with solid `fg` bars drawn inside the given boxes
 *  (stand-ins for glyph ink — enough for the Otsu sampler). */
function makePixels(w, h, bg, bars = []) {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) { data[i * 4] = bg[0]; data[i * 4 + 1] = bg[1]; data[i * 4 + 2] = bg[2]; data[i * 4 + 3] = 255; }
  for (const { box, color } of bars) {
    // draw ink bars over the middle 60% of the box height, striped to leave bg visible
    const y0 = Math.round(box.y + box.h * 0.2), y1 = Math.round(box.y + box.h * 0.8);
    for (let y = y0; y < y1; y++) {
      for (let x = Math.round(box.x + 2); x < Math.round(box.x + box.w - 2); x++) {
        if ((x >> 2) % 2) continue; // 4-px stripes ⇒ ~50% ink fraction
        const i = (y * w + x) * 4;
        data[i] = color[0]; data[i + 1] = color[1]; data[i + 2] = color[2];
      }
    }
  }
  return { data, width: w, height: h };
}

// ---------------------------------------------------------------------------------------------
// synthetic criteria tests
// ---------------------------------------------------------------------------------------------

test('adjacent aligned same-size lines merge into one block with joined text', () => {
  const facts = s1(1000, 600, [
    line('L0', 200, 100, 600, 60, 'FIRST LINE'),
    line('L1', 250, 175, 500, 60, 'SECOND LINE'), // centers 500/500, gap 15 ≤ 1.9×60
  ]);
  const { blocks } = mergeLinesToBlocks(facts);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].text, 'FIRST LINE\nSECOND LINE');
  assert.deepEqual(blocks[0].lineIds, ['L0', 'L1']);
  assert.equal(blocks[0].align, 'center');
  assert.equal(blocks[0].lineHeightPx, 75); // baseline delta 235−160
  assert.equal(blocks[0].fontSizePx, 60);
});

test('fontSize delta > 12% blocks the merge', () => {
  const facts = s1(1000, 600, [
    line('L0', 200, 100, 600, 60),
    line('L1', 200, 175, 600, 42), // 42 vs 60 = 30% delta
  ]);
  assert.equal(mergeLinesToBlocks(facts).blocks.length, 2);
});

test('vertical gap > 1.9× median line height blocks the merge', () => {
  const facts = s1(1000, 900, [
    line('L0', 200, 100, 600, 60),
    line('L1', 200, 300, 600, 60), // gap 140 > 1.9×60 = 114
  ]);
  assert.equal(mergeLinesToBlocks(facts).blocks.length, 2);
});

test('no shared left/center/right guide (±1.5% W) blocks the merge', () => {
  const facts = s1(1000, 600, [
    line('L0', 100, 100, 300, 60),
    line('L1', 450, 175, 400, 60), // L/C/R all differ by ≥ 25px > 15
  ]);
  assert.equal(mergeLinesToBlocks(facts).blocks.length, 2);
});

test('different S3 origin verdicts block the merge; same verdicts merge', () => {
  const facts = s1(1000, 600, [
    line('L0', 200, 100, 600, 60),
    line('L1', 200, 175, 600, 60),
  ]);
  const split = mergeLinesToBlocks(facts, { origins: { lines: [{ id: 'L0', origin: 'overlay' }, { id: 'L1', origin: 'scene' }] } });
  assert.equal(split.blocks.length, 2);
  const joined = mergeLinesToBlocks(facts, { origins: { L0: 'overlay', L1: 'overlay' } });
  assert.equal(joined.blocks.length, 1);
  assert.equal(joined.blocks[0].origin, 'overlay');
});

test('an S4 region boundary between the lines blocks the merge', () => {
  const facts = s1(1000, 600, [
    line('L0', 200, 100, 600, 60),
    line('L1', 200, 175, 600, 60),
  ]);
  // region bottom edge at y=170 crosses the inter-line band 160..175
  const split = mergeLinesToBlocks(facts, { regions: [{ x: 0, y: 0, w: 1000, h: 170 }] });
  assert.equal(split.blocks.length, 2);
  // region fully containing both lines is NOT a boundary between them
  const joined = mergeLinesToBlocks(facts, { regions: [{ x: 0, y: 0, w: 1000, h: 400 }] });
  assert.equal(joined.blocks.length, 1);
});

test('ink ΔE > 10 blocks the merge when pixels are provided', () => {
  const l0 = line('L0', 200, 100, 600, 60);
  const l1 = line('L1', 200, 175, 600, 60);
  const facts = s1(1000, 600, [l0, l1]);
  const sameInk = makePixels(1000, 600, [255, 255, 255], [
    { box: l0.box, color: [10, 10, 10] }, { box: l1.box, color: [10, 10, 10] },
  ]);
  assert.equal(mergeLinesToBlocks(facts, { pixels: sameInk }).blocks.length, 1);
  const diffInk = makePixels(1000, 600, [255, 255, 255], [
    { box: l0.box, color: [10, 10, 10] }, { box: l1.box, color: [180, 20, 20] },
  ]);
  assert.equal(mergeLinesToBlocks(facts, { pixels: diffInk }).blocks.length, 2);
});

test('measureInkColor reads the drawn ink; otsuThreshold splits a bimodal histogram', () => {
  const box = { x: 100, y: 100, w: 300, h: 60 };
  const px = makePixels(500, 300, [250, 250, 250], [{ box, color: [20, 40, 160] }]);
  const ink = measureInkColor(px, box);
  assert.ok(ink, 'ink measured');
  assert.ok(Math.abs(ink.rgb[0] - 20) <= 6 && Math.abs(ink.rgb[2] - 160) <= 6, `ink ${ink.rgb}`);
  assert.ok(deltaE(ink.lab, ink.lab) === 0);
  const hist = new Uint32Array(256); hist[10] = 500; hist[240] = 500;
  const t = otsuThreshold(hist);
  assert.ok(t >= 10 && t < 240, `otsu ${t}`);
});

test('degenerate input: no lines / malformed boxes never throw', () => {
  assert.deepEqual(mergeLinesToBlocks({ lines: [] }).blocks, []);
  assert.deepEqual(mergeLinesToBlocks({}).blocks, []);
  const { blocks } = mergeLinesToBlocks(s1(100, 100, [{ id: 'L0', text: 'x', box: { x: 0, y: 0, w: 0, h: 0 } }]));
  assert.deepEqual(blocks, []);
});

// ---------------------------------------------------------------------------------------------
// real-corpus acceptance cases (skip when corpus or OCR binary is unavailable)
// ---------------------------------------------------------------------------------------------

const CORPUS = path.join(homedir(), 'Downloads', 'IMAGE AD INSPO');
const corpusSource = (id) => {
  try {
    const hit = readdirSync(CORPUS).find((f) => f.startsWith(`${id}_`) && /\.(png|jpe?g|webp)$/i.test(f));
    return hit ? path.join(CORPUS, hit) : null;
  } catch { return null; }
};

async function blocksFor(id) {
  const img = corpusSource(id);
  if (!img) return null;
  const { recognizeText } = await import('../lib/ocr.mjs');
  const facts = await recognizeText(img);
  if (!facts.ok) return null;
  const sharp = (await import('sharp')).default;
  const { data, info } = await sharp(img).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const pixels = { data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), width: info.width, height: info.height };
  const { blocks } = mergeLinesToBlocks(facts, { pixels });
  console.log(`\n  [${id}] ${facts.lines.length} OCR lines → ${blocks.length} blocks`);
  for (const b of blocks) {
    console.log(`    ${b.id} [${b.box.x},${b.box.y} ${b.box.w}x${b.box.h}] fs=${b.fontSizePx} lh=${b.lineHeightPx} ls=${b.letterSpacing} ${b.align} (${b.lineIds.join(',')}) "${b.text.replaceAll('\n', ' ⏎ ').slice(0, 70)}"`);
  }
  return { facts, blocks };
}

test('corpus 016 — the two headline lines merge into ONE block', { skip: !corpusSource('016') }, async () => {
  const r = await blocksFor('016');
  if (!r) return; // OCR unavailable on this machine
  const head = r.blocks.find((b) => b.text.startsWith('How I get ALL my'));
  assert.ok(head, 'headline block exists');
  assert.equal(head.text, 'How I get ALL my\nnutrients on Ozempic:');
  assert.equal(head.lineIds.length, 2);
  assert.equal(head.align, 'center');
  // the "21+ vitamins / & minerals" callout is also a 2-line block
  const callout = r.blocks.find((b) => b.text.includes('21+ vitamins'));
  assert.ok(callout && callout.lineIds.length === 2, 'vitamins callout merged');
});

test('corpus 018 — the three staggered headline words stay SEPARATE blocks', { skip: !corpusSource('018') }, async () => {
  const r = await blocksFor('018');
  if (!r) return;
  for (const word of ['THE 10 SECOND', 'PARTY', 'UPGRADE']) {
    const b = r.blocks.find((x) => x.text === word);
    assert.ok(b, `"${word}" is its own block`);
    assert.equal(b.lineIds.length, 1, `"${word}" contains exactly its own line`);
  }
});

test('corpus 004 — ingredient fine-print merges into few blocks, not one per line', { skip: !corpusSource('004') }, async () => {
  const r = await blocksFor('004');
  if (!r) return;
  // the label fine print: lines in the card area x<560, y 1150..1300 (L13..L19)
  const fineIds = r.facts.lines
    .filter((l) => l.box.x < 560 && l.box.y > 1150 && l.box.y < 1300 && l.box.h < 40)
    .map((l) => l.id);
  assert.ok(fineIds.length >= 6, `found the fine-print lines (${fineIds.length})`);
  const holders = new Set(r.blocks.filter((b) => b.lineIds.some((id) => fineIds.includes(id))).map((b) => b.id));
  assert.ok(holders.size <= 4, `${fineIds.length} fine-print lines live in ${holders.size} blocks (≤4)`);
  assert.ok(r.blocks.length < 20, `total blocks ${r.blocks.length} < 20`);
});

test('corpus 002 — ingredient paragraph merges', { skip: !corpusSource('002') }, async () => {
  const r = await blocksFor('002');
  if (!r) return;
  const para = r.blocks.find((b) => b.text.startsWith('ingrediënten'));
  assert.ok(para, 'ingredient paragraph block exists');
  assert.ok(para.lineIds.length >= 3, `paragraph holds ${para.lineIds.length} lines (≥3)`);
  assert.ok(r.blocks.length < r.facts.lines.length * 0.75, `merging happened: ${r.blocks.length} blocks from ${r.facts.lines.length} lines`);
});
