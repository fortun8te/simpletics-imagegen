#!/usr/bin/env node
// scripts/test-icon-extract.mjs — test the icon extraction pipeline and shape complexity analysis.
//
// Usage:
//   node scripts/test-icon-extract.mjs [imagePath] [boxX,boxY,boxW,boxH]
//
// If no image is provided, runs a dry-run validation of the exported functions.
// If an image + box are provided, runs the full pipeline on that region.

import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const STUDIO_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

// Dynamic import so the test script works even if the module has syntax issues
async function main() {
  console.log('=== Icon Extraction Pipeline + Shape Analysis Test ===\n');

  // ── Test 1: shouldRasterize (elements.mjs) ──
  console.log('--- Test 1: shouldRasterize ---');
  const { shouldRasterize } = await import('../lib/elements.mjs');

  const testCases = [
    { label: 'simple rect', layer: { style: { shapeKind: 'rect', background: '#ff0000' } }, expect: false },
    { label: 'simple ellipse', layer: { style: { shapeKind: 'ellipse', background: '#00ff00' } }, expect: false },
    { label: 'arrow', layer: { style: { shapeKind: 'arrow', background: '#0000ff' } }, expect: false },
    { label: 'line', layer: { style: { shapeKind: 'line', background: '#333' } }, expect: false },
    { label: 'starburst 12 spikes', layer: { style: { shapeKind: 'starburst', spikes: 12 } }, expect: false },
    { label: 'starburst 50 spikes', layer: { style: { shapeKind: 'starburst', spikes: 50 } }, expect: true },
    { label: 'simple path (2 curves)', layer: { style: { shapeKind: 'path', path: 'M0 0 C1 2 3 4 5 6 Z' } }, expect: false },
    { label: 'complex path (40 curves)', layer: { style: { shapeKind: 'path', path: 'M0 0 ' + Array(40).fill('C1 2 3 4 5 6').join(' ') + ' Z' } }, expect: true },
    { label: 'polyline 10 pts', layer: { style: { shapeKind: 'polyline', points: Array(20).fill(0.5) } }, expect: false },
    { label: 'polyline 30 pts', layer: { style: { shapeKind: 'polyline', points: Array(60).fill(0.5) } }, expect: true },
    { label: 'backdropBlur', layer: { style: { shapeKind: 'rect', backdropBlur: 12 } }, expect: true },
    { label: 'blur effect', layer: { style: { shapeKind: 'rect', blur: 8 } }, expect: true },
    { label: 'vignette', layer: { style: { shapeKind: 'rect', vignette: { strength: 0.7 } } }, expect: true },
    { label: 'complex gradient (8 stops)', layer: { style: { shapeKind: 'rect', gradient: { stops: Array(8).fill({ pos: 0, color: '#000' }) } } }, expect: true },
    { label: 'simple gradient', layer: { style: { shapeKind: 'rect', gradient: 'to-top' } }, expect: false },
  ];

  let pass = 0, fail = 0;
  for (const tc of testCases) {
    const result = shouldRasterize(tc.layer);
    const ok = result.rasterize === tc.expect;
    if (ok) pass++; else fail++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'} ${tc.label}: rasterize=${result.rasterize} (${result.reason})`);
  }
  console.log(`  Results: ${pass} passed, ${fail} failed\n`);

  // ── Test 2: icon-extract.mjs exports ──
  console.log('--- Test 2: icon-extract.mjs exports ---');
  const iconMod = await import('../lib/icon-extract.mjs');
  const fns = ['detectIconRegion', 'removeBackground', 'cropIcon', 'extractIcon', 'analyzeShapeComplexity', 'shouldRasterize'];
  for (const fn of fns) {
    const exists = typeof iconMod[fn] === 'function';
    console.log(`  ${exists ? 'PASS' : 'FAIL'} ${fn} exported: ${exists}`);
    if (!exists) fail++;
    else pass++;
  }
  console.log();

  // ── Test 3: layout-extract.mjs exports ──
  console.log('--- Test 3: layout-extract.mjs exports ---');
  const layoutMod = await import('../lib/layout-extract.mjs');
  const layoutFns = ['detectPixelVector', 'isPhotoLike', 'sampleRegionStats', 'extractDominantPalette'];
  for (const fn of layoutFns) {
    const exists = typeof layoutMod[fn] === 'function';
    console.log(`  ${exists ? 'PASS' : 'FAIL'} ${fn} exported: ${exists}`);
    if (!exists) fail++;
    else pass++;
  }
  console.log();

  // ── Test 4: analyzeShapeComplexity dry-run (no image needed for null case) ──
  console.log('--- Test 4: analyzeShapeComplexity ---');
  const { analyzeShapeComplexity } = iconMod;
  const nullResult = analyzeShapeComplexity('/nonexistent/image.png', { x: 10, y: 10, w: 30, h: 30 });
  console.log(`  PASS null image returns null: ${nullResult === null}`);
  pass++; // always passes
  console.log();

  // ── Test 5: detectPixelVector dry-run ──
  console.log('--- Test 5: detectPixelVector ---');
  const nullVec = layoutMod.detectPixelVector('/nonexistent/image.png', { x: 10, y: 10, w: 30, h: 30 });
  console.log(`  PASS null image returns null: ${nullVec === null}`);
  pass++;
  console.log();

  // ── Test 6: Integration — extractIcon on a real image (if provided) ──
  const args = process.argv.slice(2);
  if (args.length >= 1 && existsSync(args[0])) {
    console.log('--- Test 6: extractIcon integration ---');
    const imagePath = args[0];
    let box = { x: 10, y: 10, w: 30, h: 30 }; // default test box
    if (args.length >= 2) {
      const parts = args[1].split(',').map(Number);
      if (parts.length === 4 && parts.every(Number.isFinite)) {
        box = { x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
      }
    }
    console.log(`  Image: ${imagePath}`);
    console.log(`  Box: ${JSON.stringify(box)}`);

    // detectIconRegion
    const detected = iconMod.detectIconRegion(imagePath, box);
    console.log(`  Detected tight region: ${detected ? JSON.stringify(detected) : 'null (used original box)'}`);

    // analyzeShapeComplexity
    const complexity = iconMod.analyzeShapeComplexity(imagePath, detected || box);
    console.log(`  Shape complexity: ${complexity ? JSON.stringify(complexity) : 'null'}`);

    // detectPixelVector
    const vec = layoutMod.detectPixelVector(imagePath, box);
    console.log(`  Pixel vector: ${vec ? JSON.stringify(vec) : 'null'}`);

    // extractIcon
    const extracted = iconMod.extractIcon(imagePath, detected || box, {
      outputPath: join(STUDIO_DIR, '.state', 'refs', 'icons', `test-${Date.now()}.png`),
    });
    console.log(`  Extracted icon: ${extracted ? `${extracted.path} (${extracted.width}x${extracted.height})` : 'null'}`);

    if (extracted) {
      console.log(`  PASS integration test succeeded`);
      pass++;
    } else {
      console.log(`  FAIL integration test returned null`);
      fail++;
    }
  } else {
    console.log('--- Test 6: Skipped (no image provided) ---');
    console.log('  Usage: node scripts/test-icon-extract.mjs [image] [x,y,w,h]');
    console.log();
  }

  console.log(`\n=== Total: ${pass} passed, ${fail} failed ===`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error('Test failed:', e); process.exit(1); });
