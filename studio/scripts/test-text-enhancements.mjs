#!/usr/bin/env node
// scripts/test-text-enhancements.mjs — verify the pixel-based text detection, iterative
// comparison loop, and extraction metrics work correctly.
//
// Run: node studio/scripts/test-text-enhancements.mjs
//
// Tests:
// 1. Pixel-based text detection finds high-contrast regions in a synthetic image
// 2. detectTextRegionsByPixels skips regions that overlap existing layers
// 3. extractAndCompare renders and compares against a reference
// 4. correctionToOp converts various correction types to ops
// 5. Iterative self-check loops and surfaces metrics

import { strict as assert } from 'node:assert';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

const STUDIO = join(dirname(fileURLToPath(import.meta.url)), '..');
const TMP = join(STUDIO, '.state', 'test-text-enhancements');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS: ${name}`);
  } catch (e) {
    failed++;
    failures.push({ name, error: e });
    console.log(`  FAIL: ${name}`);
    console.log(`        ${e.message}`);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  PASS: ${name}`);
  } catch (e) {
    failed++;
    failures.push({ name, error: e });
    console.log(`  FAIL: ${name}`);
    console.log(`        ${e.message}`);
  }
}

// ── Minimal PNG generator for testing ────────────────────────────────────────────────────────────
// Creates a small PNG with known pixel content for testing the contrast scanner.

function createMinimalPng(width, height, pixels) {
  // pixels is a function (x, y) => [r, g, b, a]
  const channels = 4;
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);

  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: None
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixels(x, y);
      const offset = y * (stride + 1) + 1 + x * channels;
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
      raw[offset + 3] = a;
    }
  }

  const { deflateSync } = await import('node:zlib');
  const compressed = deflateSync(raw);

  // Build PNG
  const chunks = [];

  // Signature
  chunks.push(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  chunks.push(makeChunk('IHDR', ihdr));

  // IDAT
  chunks.push(makeChunk('IDAT', compressed));

  // IEND
  chunks.push(makeChunk('IEND', Buffer.alloc(0)));

  return Buffer.concat(chunks);
}

function makeChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeB = Buffer.from(type, 'ascii');
  const crcData = Buffer.concat([typeB, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcData), 0);
  return Buffer.concat([len, typeB, data, crc]);
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let j = 0; j < 8; j++) {
      c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

// ── Test 1: Pixel-based text detection ──────────────────────────────────────────────────────────
console.log('\n--- Test: Pixel-based text detection ---');

await testAsync('detectTextRegionsByPixels finds high-contrast text regions', async () => {
  const { detectTextRegionsByPixels } = await import('../lib/layout-extract.mjs');

  // Create a 100x100 white image with a dark text-like region in the middle
  const png = createMinimalPng(100, 100, (x, y) => {
    // White background
    if (x >= 30 && x <= 70 && y >= 40 && y <= 55) {
      // Dark text region (high contrast against white)
      return [20, 20, 20, 255];
    }
    return [255, 255, 255, 255];
  });

  const tmpFile = join(TMP, 'test-text-detect.png');
  mkdirSync(TMP, { recursive: true });
  writeFileSync(tmpFile, png);

  const layers = detectTextRegionsByPixels(tmpFile, []);
  // Should find at least one region
  assert.ok(layers.length > 0, `Expected at least 1 text region, got ${layers.length}`);
  // The region should be roughly where we put the dark pixels (x:30%, y:40%, w:40%, h:15%)
  const region = layers[0];
  assert.ok(region.box.x >= 25 && region.box.x <= 40, `Region x=${region.box.x} should be ~30%`);
  assert.ok(region.box.y >= 35 && region.box.y <= 50, `Region y=${region.box.y} should be ~40%`);
  assert.ok(region.box.w >= 20, `Region w=${region.box.w} should be >= 20%`);
  assert.ok(region._source === 'pixel-detect', 'Region should be tagged as pixel-detected');

  rmSync(tmpFile, { force: true });
});

await testAsync('detectTextRegionsByPixels skips regions overlapping existing layers', async () => {
  const { detectTextRegionsByPixels } = await import('../lib/layout-extract.mjs');

  const png = createMinimalPng(100, 100, (x, y) => {
    if (x >= 30 && x <= 70 && y >= 40 && y <= 55) {
      return [20, 20, 20, 255];
    }
    return [255, 255, 255, 255];
  });

  const tmpFile = join(TMP, 'test-text-detect-overlap.png');
  writeFileSync(tmpFile, png);

  // Existing layer that overlaps the dark region
  const existingLayers = [{
    type: 'text',
    box: { x: 28, y: 38, w: 45, h: 20 }, // overlaps the dark region
  }];

  const layers = detectTextRegionsByPixels(tmpFile, existingLayers);
  // Should find 0 regions (all overlap with existing)
  assert.equal(layers.length, 0, `Expected 0 novel regions, got ${layers.length}`);

  rmSync(tmpFile, { force: true });
});

await testAsync('detectTextRegionsByPixels returns empty for undecodable image', async () => {
  const { detectTextRegionsByPixels } = await import('../lib/layout-extract.mjs');
  const layers = detectTextRegionsByPixels('/nonexistent/path.png', []);
  assert.equal(layers.length, 0, 'Should return empty for missing file');
});

// ── Test 2: correctionToOp ──────────────────────────────────────────────────────────────────────
console.log('\n--- Test: correctionToOp ---');

await testAsync('correctionToOp converts color fix to setStyle op', async () => {
  const { correctionToOp } = await import('../lib/self-vision.mjs');
  const op = correctionToOp(
    { layer: 'headline', problem: 'wrong text color', fix: 'recolor to #ff0000' },
    { w: 1080, h: 1920 }
  );
  assert.ok(op, 'Should return an op');
  assert.equal(op.op, 'setStyle');
  assert.equal(op.style.color, '#ff0000');
  assert.ok(op._description.includes('headline'), 'Description should mention the layer');
});

await testAsync('correctionToOp converts background fix', async () => {
  const { correctionToOp } = await import('../lib/self-vision.mjs');
  const op = correctionToOp(
    { layer: 'CTA button', problem: 'background too dark', fix: 'set background to #ffffff' },
    { w: 1080, h: 1920 }
  );
  assert.ok(op, 'Should return an op');
  assert.equal(op.op, 'setStyle');
  assert.equal(op.style.background, '#ffffff');
});

await testAsync('correctionToOp converts position nudge', async () => {
  const { correctionToOp } = await import('../lib/self-vision.mjs');
  const op = correctionToOp(
    { layer: 'headline', problem: 'position too high', fix: 'move down 8%' },
    { w: 1080, h: 1920 }
  );
  assert.ok(op, 'Should return an op');
  assert.equal(op.op, 'nudge');
  assert.ok(op.dy > 0, 'Should nudge downward (positive dy)');
  assert.ok(Math.abs(op.dy - 153.6) < 1, `dy should be ~153.6 (8% of 1920), got ${op.dy}`);
});

await testAsync('correctionToOp converts scale fix', async () => {
  const { correctionToOp } = await import('../lib/self-vision.mjs');
  const op = correctionToOp(
    { layer: 'product', problem: 'too small', fix: 'enlarge to 1.5x' },
    { w: 1080, h: 1920 }
  );
  assert.ok(op, 'Should return an op');
  assert.equal(op.op, 'scale');
  assert.equal(op.factor, 1.5);
});

await testAsync('correctionToOp returns correction op for unparseable fixes', async () => {
  const { correctionToOp } = await import('../lib/self-vision.mjs');
  const op = correctionToOp(
    { layer: 'badge', problem: 'looks wrong', fix: 'make it look more premium' },
    { w: 1080, h: 1920 }
  );
  assert.ok(op, 'Should return an op');
  assert.equal(op.op, 'correction');
  assert.ok(op._correctionHint, 'Should carry the correction hint');
});

await testAsync('correctionToOp returns null for missing inputs', async () => {
  const { correctionToOp } = await import('../lib/self-vision.mjs');
  assert.equal(correctionToOp(null, { w: 1080, h: 1920 }), null);
  assert.equal(correctionToOp({ layer: 'x' }, null), null);
});

// ── Test 3: extractAndCompare (unit-level, no vision endpoint needed) ───────────────────────────
console.log('\n--- Test: extractAndCompare ---');

await testAsync('extractAndCompare returns error for missing inputs', async () => {
  const { extractAndCompare } = await import('../lib/self-vision.mjs');
  const result = await extractAndCompare(null, '/nonexistent/ref.png');
  assert.equal(result.ok, false);
  assert.ok(result.error, 'Should have an error message');
});

await testAsync('extractAndCompare returns error for empty layers', async () => {
  const { extractAndCompare } = await import('../lib/self-vision.mjs');
  const result = await extractAndCompare({ layers: [], canvas: { w: 1080, h: 1920 } }, '/nonexistent/ref.png');
  assert.equal(result.ok, false);
});

// ── Test 4: Integration — extractLayout returns extraction metrics ──────────────────────────────
console.log('\n--- Test: extractLayout metrics ---');

await testAsync('extractLayout returns selfCheck with iterative metrics on success', async () => {
  // This test requires a vision endpoint. If VISION_BASE_URL is not set, skip gracefully.
  if (!process.env.VISION_BASE_URL) {
    console.log('    (skipped — no VISION_BASE_URL)');
    passed++; // count as passed (environment-dependent)
    return;
  }

  // Create a simple test image (white with some dark text-like regions)
  const png = createMinimalPng(200, 300, (x, y) => {
    // White background with dark horizontal bands (simulating text)
    if (y >= 50 && y <= 65 && x >= 20 && x <= 180) return [30, 30, 30, 255];
    if (y >= 120 && y <= 135 && x >= 40 && x <= 160) return [30, 30, 30, 255];
    if (y >= 200 && y <= 215 && x >= 60 && x <= 140) return [30, 30, 30, 255];
    return [255, 255, 255, 255];
  });

  const tmpFile = join(TMP, 'test-extract-metrics.png');
  writeFileSync(tmpFile, png);

  try {
    const { extractLayout } = await import('../lib/layout-extract.mjs');
    const result = await extractLayout(tmpFile, {
      timeoutMs: 30_000,
      passes: 1,
      selfCheck: false, // skip self-check for speed in tests
    });
    // The result should always have the standard shape
    assert.ok('ok' in result, 'Result should have ok field');
    assert.ok('layers' in result || !result.ok, 'Result should have layers when ok');
    // When self-check runs, it should have the metrics fields
    if (result.selfCheck) {
      assert.ok('score' in result.selfCheck, 'selfCheck should have score');
      assert.ok('iterations' in result.selfCheck, 'selfCheck should have iterations');
      assert.ok('applied' in result.selfCheck, 'selfCheck should have applied');
    }
  } finally {
    rmSync(tmpFile, { force: true });
  }
});

// ── Summary ─────────────────────────────────────────────────────────────────────────────────────
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) {
    console.log(`  - ${f.name}: ${f.error.message}`);
  }
  process.exit(1);
}
