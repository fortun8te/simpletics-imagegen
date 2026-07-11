// test/ocr.test.mjs — S1 OCR facts (lib/ocr.mjs + bin/ocrjson, Apple Vision).
// Real-corpus test: runs the CLI on harness case 002 ("ALLE ESSENTIALS" ad) and checks
// the S1 contract: ok flag, line count, key headline hit, boxes inside image bounds,
// sha256 cache write, and that the second call is served from cache WITHOUT spawning
// the binary (proven by hiding the binary — a cache hit returns before any spawn).
// Skipped when the corpus image is absent (fresh checkout: .state/ is gitignored).
// Run: node --test test/ocr.test.mjs   (or: node test/ocr.test.mjs)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { recognizeText } from '../lib/ocr.mjs';

const STUDIO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const IMG = path.join(STUDIO, '.state', 'refs', 'harness-002.png');
const BIN = path.join(STUDIO, 'bin', 'ocrjson');
const CACHE_DIR = path.join(STUDIO, '.state', 'ocr-cache');

const haveImg = existsSync(IMG);
const cachePathFor = (file) =>
  path.join(CACHE_DIR, `${createHash('sha256').update(readFileSync(file)).digest('hex')}.json`);

test('S1 on corpus 002: contract shape, headline hit, boxes in bounds, cache round-trip', { skip: !haveImg && 'corpus image .state/refs/harness-002.png not present' }, async () => {
  // start from a cold cache for this image so the first call is a real engine run
  const cachePath = cachePathFor(IMG);
  rmSync(cachePath, { force: true });

  const r = await recognizeText(IMG);
  assert.equal(r.ok, true, `expected ok, got: ${r.error}`);
  assert.equal(r.cached, false, 'cold cache must be a fresh engine run');
  assert.equal(r.engine, 'apple-vision');
  assert.ok(Number.isFinite(r.ms) && r.ms > 0, 'ms timing present');
  assert.ok(r.source.w > 0 && r.source.h > 0, 'source dims present');
  assert.ok(r.lines.length >= 3, `expected >=3 lines, got ${r.lines.length}`);

  const headline = r.lines.find((l) => /ALLE ESSENTIALS/i.test(l.text));
  assert.ok(headline, `no line matched /ALLE ESSENTIALS/i in: ${r.lines.map((l) => l.text).join(' | ')}`);
  const { x, y, w, h } = headline.box;
  assert.ok(x >= 0 && y >= 0 && x + w <= r.source.w && y + h <= r.source.h, `headline box out of bounds: ${JSON.stringify(headline.box)}`);
  assert.ok(w > 0 && h > 0, 'headline box degenerate');
  assert.equal(headline.quad.length, 4, 'quad has 4 corners');
  assert.ok(headline.conf > 0.5, `headline conf too low: ${headline.conf}`);
  assert.ok(headline.words.length >= 2, 'per-word boxes present');
  assert.ok(headline.words.every((wd) => wd.box.w > 0 && Array.isArray(wd.quad)), 'word boxes well-formed');
  // ids follow reading order: L0, L1, ...
  assert.deepEqual(r.lines.slice(0, 3).map((l) => l.id), ['L0', 'L1', 'L2']);

  assert.ok(existsSync(cachePath), `cache file not written: ${cachePath}`);

  // second call must come from the cache WITHOUT spawning: hide the binary — a spawn
  // (or a rebuild attempt) can then only fail, so success proves the cache path.
  const hidden = `${BIN}.test-hidden`;
  renameSync(BIN, hidden);
  try {
    const t0 = Date.now();
    const r2 = await recognizeText(IMG);
    const wall = Date.now() - t0;
    assert.equal(r2.ok, true, `cached call failed: ${r2.error}`);
    assert.equal(r2.cached, true, 'second call must be a cache hit');
    assert.equal(r2.lines.length, r.lines.length, 'cache returns the same document');
    assert.ok(wall < 500, `cache hit suspiciously slow (${wall}ms) — did it spawn?`);
  } finally {
    renameSync(hidden, BIN);
  }

  // cache=false bypasses the cache and spawns again
  const r3 = await recognizeText(IMG, { cache: false });
  assert.equal(r3.ok, true);
  assert.equal(r3.cached, false);
});

test('never throws for engine reasons: missing file → {ok:false, error}', async () => {
  const r = await recognizeText('/nope/definitely-missing.png');
  assert.equal(r.ok, false);
  assert.ok(typeof r.error === 'string' && r.error.length > 0);
});
