// test/native-ui-loop.test.mjs — control-flow tests for the SELF-IMPROVEMENT LOOP.
// Drives runSelfImproveLoop with INJECTED agent + scorer stubs (no LLM / no render), so the
// convergence, best-doc-tracking, PASS threshold, discrepancy→instruction, and crash-safety
// behavior are all deterministic. Also covers the pixel-diff self-identity signal.
// Run: node --test test/native-ui-loop.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSelfImproveLoop, discrepanciesToInstruction } from '../lib/native-ui-loop.mjs';
import { pixelDiff, downsampleGray, contentSpread } from '../scripts/pixel-diff.mjs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

/** Write a minimal valid 8-bit grayscale PNG of `w`×`h` where pixel(x,y)=fill(x,y) 0..255. */
function writePng(path, w, h, fill) {
  const crc32 = (buf) => { let c = ~0; for (let i = 0; i < buf.length; i++) { c ^= buf[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return (~c) >>> 0; };
  const chunk = (type, data) => { const t = Buffer.from(type, 'ascii'); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 0; // grayscale
  const raw = Buffer.alloc((w + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w + 1)] = 0; for (let x = 0; x < w; x++) raw[y * (w + 1) + 1 + x] = fill(x, y) & 0xff; }
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  writeFileSync(path, png);
}

const mkDoc = (tag) => ({ id: `d-${tag}`, canvas: { w: 100, h: 100 }, layers: [{ id: 'base-1', type: 'image', role: 'base', box: { x: 0, y: 0, w: 100, h: 100 } }] });

/** A scorer stub that returns a scripted score per round (by how many times it's been called). */
function scriptedScorer(scores) {
  let n = 0;
  return async (doc) => {
    const score = scores[Math.min(n, scores.length - 1)];
    n++;
    return { ok: true, score, vision: score, pixel: score, match: score >= 90, corrections: score >= 90 ? [] : [{ layer: 'headline', problem: 'too small', fix: 'enlarge' }], png: `/tmp/r${n}.png`, error: null };
  };
}

/** An agent stub that just stamps a round marker on the doc and reports 1 applied op. */
function markingAgent() {
  let n = 0;
  return async (doc) => { n++; return { doc: { ...doc, _fix: n }, applied: 1, source: 'stub' }; };
}

test('PASS: stops as soon as score ≥ threshold and returns the passing doc', async () => {
  const r = await runSelfImproveLoop({
    referencePath: '/ref.png', seedDoc: mkDoc('seed'), threshold: 90, maxIters: 5,
    agent: markingAgent(), scorer: scriptedScorer([62, 78, 92, 99]),
  });
  assert.equal(r.verdict, 'pass');
  assert.equal(r.bestScore, 92);           // stops at the first ≥90, doesn't keep going to 99
  assert.equal(r.iterations.length, 3);    // 62, 78, 92
  assert.deepEqual(r.iterations.map((i) => i.score), [62, 78, 92]);
});

test('trajectory trends up across rounds (the core proof shape)', async () => {
  const r = await runSelfImproveLoop({
    referencePath: '/ref.png', seedDoc: mkDoc('seed'), threshold: 95, maxIters: 4,
    agent: markingAgent(), scorer: scriptedScorer([60, 75, 88, 93]),
  });
  const scores = r.iterations.map((i) => i.score);
  assert.deepEqual(scores, [60, 75, 88, 93]);
  for (let i = 1; i < scores.length; i++) assert.ok(scores[i] > scores[i - 1], 'monotonically improving');
  assert.equal(r.seedScore, 60);
  assert.equal(r.bestScore, 93);
});

test('CONVERGED: stops after `patience` non-improving rounds, keeps the BEST doc not the last', async () => {
  // scores: 70 (best), then flat/worse — no gain for 2 rounds → converged; best stays 70's doc.
  const agent = markingAgent();
  const r = await runSelfImproveLoop({
    referencePath: '/ref.png', seedDoc: mkDoc('seed'), threshold: 90, patience: 2, maxIters: 6,
    agent, scorer: scriptedScorer([70, 69, 68]),
  });
  assert.equal(r.verdict, 'converged');
  assert.equal(r.bestScore, 70);                 // best-so-far, not the last (68)
  assert.equal(r.iterations.length, 3);          // 70, 69 (stale=1), 68 (stale=2 → stop)
});

test('best-doc tracking: a round that regresses does not become the returned doc', async () => {
  const r = await runSelfImproveLoop({
    referencePath: '/ref.png', seedDoc: mkDoc('seed'), threshold: 99, patience: 5, maxIters: 3,
    agent: markingAgent(), scorer: scriptedScorer([80, 55, 60]),
  });
  // exhausted after 3 rounds; best was round 1 (80)
  assert.equal(r.verdict, 'exhausted');
  assert.equal(r.bestScore, 80);
});

test('crash-safety: a scorer that throws degrades to score 0, loop does not crash', async () => {
  const flaky = async () => { throw new Error('vision endpoint down'); };
  const r = await runSelfImproveLoop({
    referencePath: '/ref.png', seedDoc: mkDoc('seed'), threshold: 90, patience: 2, maxIters: 4,
    agent: markingAgent(), scorer: flaky,
  });
  assert.equal(r.ok, true);                       // returned cleanly, no throw
  assert.ok(['converged', 'exhausted'].includes(r.verdict));
  assert.equal(r.iterations[0].score, 0);
  assert.match(r.iterations[0].error, /vision endpoint down/);
});

test('crash-safety: a fix agent that throws is caught; loop keeps scoring', async () => {
  const boom = async () => { throw new Error('agent blew up'); };
  const r = await runSelfImproveLoop({
    referencePath: '/ref.png', seedDoc: mkDoc('seed'), threshold: 90, patience: 5, maxIters: 3,
    agent: boom, scorer: scriptedScorer([50, 50, 50]),
  });
  assert.equal(r.ok, true);
  assert.equal(r.iterations.length, 3);
  assert.ok(r.iterations.some((it) => /agent blew up/.test(it.error || '')));
});

test('structured events stream every phase for the activity feed', async () => {
  const seen = [];
  await runSelfImproveLoop({
    referencePath: '/ref.png', seedDoc: mkDoc('seed'), threshold: 90, maxIters: 3,
    agent: markingAgent(), scorer: scriptedScorer([60, 92]),
    onEvent: (e) => seen.push(e.type),
  });
  assert.ok(seen.includes('seed:start'));
  assert.ok(seen.includes('iter:score'));
  assert.ok(seen.includes('iter:fix'));
  assert.ok(seen.includes('loop:done'));
});

test('discrepanciesToInstruction: numbers the top-4 corrections, locks copy', () => {
  const ins = discrepanciesToInstruction(
    [{ layer: 'headline', problem: 'too small', fix: 'enlarge 2x' }, { layer: 'avatar', problem: 'wrong spot', fix: 'move up' }],
    { score: 74, archetype: 'x-post' },
  );
  assert.match(ins, /74 \/100/);
  assert.match(ins, /x-post/);
  assert.match(ins, /1\. headline: too small → enlarge 2x/);
  assert.match(ins, /2\. avatar: wrong spot → move up/);
  assert.match(ins, /Do not change the copy wording/);
});

test('discrepanciesToInstruction: empty corrections at a LOW score → actionable autolayout/fit instruction', () => {
  const ins = discrepanciesToInstruction([], { score: 70 });
  assert.match(ins, /70/);
  assert.match(ins, /autolayout/i);        // concrete op the agent can always run
  assert.match(ins, /overflow|clip/i);     // targets the common oversized-text defect
});

test('discrepanciesToInstruction: empty corrections at a HIGH score → single-delta look pass (AI-11 plateau fix)', () => {
  // near the pass bar, generic autolayout advice was non-actionable and stalled the loop to
  // patience — the instruction must instead force a look + ONE precise remaining delta.
  const ins = discrepanciesToInstruction([], { score: 88 });
  assert.match(ins, /88/);
  assert.match(ins, /"op":"look"/);                      // render-and-compare first
  assert.match(ins, /SINGLE most important/);            // exactly one precise fix
  assert.doesNotMatch(ins, /Run autolayout/);            // the old generic advice is gone up here
});

test('pixelDiff self-identity is ~100 and a flat vs black image is far apart', () => {
  // downsampleGray sanity: a uniform grid stays uniform
  const flat = { width: 4, height: 4, gray: new Float32Array(16).fill(0.5) };
  const g = downsampleGray(flat, 2, 2);
  assert.ok(g.every((v) => Math.abs(v - 0.5) < 1e-6));
  // pixelDiff on a missing file is a clean failure, not a throw
  const bad = pixelDiff('/does/not/exist/a.png', '/does/not/exist/b.png');
  assert.equal(bad.ok, false);
  assert.equal(bad.score, 0);
});

test('PNG decode round-trips real files: identical→100, checker vs blank→low, spread discriminates', () => {
  const d = tmpdir();
  const checker = join(d, `nui-checker-${process.pid}.png`);
  const blank = join(d, `nui-blank-${process.pid}.png`);
  // 32x32 checkerboard (content-rich) vs an all-black image (blank)
  writePng(checker, 32, 32, (x, y) => ((x >> 2) + (y >> 2)) % 2 ? 255 : 0);
  writePng(blank, 32, 32, () => 0);
  // real PNG decode + self-identity
  const same = pixelDiff(checker, checker, { grid: 16 });
  assert.equal(same.ok, true);
  assert.ok(same.score > 99, `identical PNGs score ~100 (got ${same.score})`);
  // checker vs blank is far apart (half the cells differ)
  const diff = pixelDiff(checker, blank, { grid: 16 });
  assert.ok(diff.score < 60, `checker vs blank far apart (got ${diff.score})`);
  // contentSpread: checker has high luminance spread, blank has ~0 — the blank-render signal
  assert.ok(contentSpread(checker) > 0.3, 'checker is content-rich');
  assert.ok(contentSpread(blank) < 0.02, 'blank image has ~0 spread');
});
