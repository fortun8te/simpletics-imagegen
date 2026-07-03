#!/usr/bin/env node
// scripts/calibrate-native.mjs — CALIBRATION harness: render a scene-graph template to PNG and
// pixel-diff it against a REAL reference screenshot, so future preset/component fidelity work is
// MEASURED against reality instead of guessed.
//
//   node scripts/calibrate-native.mjs [fixtureOrTemplateId]
//
// With no argument, runs every fixture in studio/test/fixtures/native/manifest.json. With an
// argument, matches it against either a fixture filename (e.g. "x-post-ad9" or "x-post-ad9.png")
// or a template/archetype id (e.g. "x-post-ad") — whichever fixture(s) reference that archetype.
//
// For each fixture: (a) builds the CURRENT scene-graph template via buildTemplate (lib/templates
// — read-only import) using the fixture's canvas size and the template's OWN tuned defaults
// (params: {} — for x-post-ad9 these defaults were already tuned to this exact benchmark), (b)
// renders it to a PNG via renderCompPng (lib/self-vision — read-only import), (c) pixel-diffs the
// render against the fixture PNG, and (d) prints a report with the diff score, a pass/fail against
// a placeholder threshold, and the render path so a human can eyeball it.
//
// This is a scaffold: as more fixtures are added (ig-post, imessage, notes, ...) this script
// keeps working unchanged — just add an entry to manifest.json and a matching template build.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pixelDiff } from './pixel-diff.mjs';
import { buildTemplate } from '../studio/lib/templates.mjs';
import { renderCompPng } from '../studio/lib/self-vision.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const FIXTURES_DIR = join(REPO_ROOT, 'studio', 'test', 'fixtures', 'native');
const MANIFEST_PATH = join(FIXTURES_DIR, 'manifest.json');

// Placeholder — nobody has tuned this against real-world results yet. Start conservative and
// tighten (or loosen) once a handful of fixtures + renders have been eyeballed side by side.
const THRESHOLD = 0.15;

function loadManifest() {
  if (!existsSync(MANIFEST_PATH)) {
    console.error(`✗ no manifest at ${MANIFEST_PATH}`);
    process.exit(2);
  }
  try {
    return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  } catch (err) {
    console.error(`✗ could not parse manifest.json: ${err.message}`);
    process.exit(2);
  }
}

/** Build a minimal valid doc for a fixture's archetype at the fixture's canvas size, with a
 *  base layer (mirrors the shape used in test/templates.test.mjs's mkDoc helper). */
function mkDoc(canvas) {
  return {
    id: 'calibrate',
    canvas,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    layers: [
      { id: 'base-1', type: 'shape', role: 'base', box: { x: 0, y: 0, w: canvas.w, h: canvas.h }, style: { background: '#000000' } },
    ],
  };
}

/** Run one fixture: build → render → diff. Returns a result summary object. */
function runFixture(filename, meta) {
  const fixturePath = join(FIXTURES_DIR, filename);
  if (!existsSync(fixturePath)) {
    return { filename, ok: false, error: `fixture file missing: ${fixturePath}` };
  }
  const canvas = meta.canvas && meta.canvas.w && meta.canvas.h ? meta.canvas : { w: 1080, h: 1080 };
  const doc = mkDoc(canvas);
  // Params: {} — for x-post-ad9 the template's own defaults ARE the tuned benchmark params
  // (see lib/templates.mjs TEMPLATES[x-post-ad].params), so we don't override anything here.
  const { def, layers } = buildTemplate(meta.archetype, doc, {});
  if (!def) {
    return { filename, ok: false, error: `unknown archetype "${meta.archetype}" in manifest` };
  }
  doc.layers.push(...layers);
  // renderCompPng's headless-Chrome path hardcodes --force-device-scale-factor=3 (real retina
  // rendering), so the output PNG comes out at 3x the requested `size`. Reference screenshots
  // are plain 1x captures, so divide by 3 here to land on the fixture's exact pixel dimensions
  // and keep pixelDiff's same-size-only comparison meaningful (no resize step, per its contract).
  const CHROME_DPR = 3;
  const pngPath = renderCompPng(doc, { size: Math.max(canvas.w, canvas.h) / CHROME_DPR });
  if (!pngPath) {
    return { filename, ok: false, error: 'renderCompPng failed (no Chrome/qlmanage available?)' };
  }
  const diff = pixelDiff(pngPath, fixturePath);
  return { filename, archetype: meta.archetype, ok: true, renderPath: pngPath, diff };
}

function report(result) {
  console.log(`\n── ${result.filename} ${'─'.repeat(Math.max(1, 50 - result.filename.length))}`);
  if (!result.ok) {
    console.log(`  ✗ ${result.error}`);
    return false;
  }
  const { diff, renderPath, archetype } = result;
  console.log(`  archetype: ${archetype}`);
  console.log(`  render written to: ${renderPath}`);
  if (diff.sameSize === false) {
    console.log(`  ✗ pixel compare skipped — ${diff.error}`);
    return false;
  }
  const pct = (diff.diffScore * 100).toFixed(2);
  const passed = diff.diffScore <= THRESHOLD;
  console.log(`  size: ${diff.width}x${diff.height}`);
  console.log(`  diffPixels: ${diff.diffPixels} / ${diff.width * diff.height}`);
  console.log(`  diffScore: ${diff.diffScore.toFixed(4)} (${pct}% mean channel delta)`);
  console.log(`  threshold: ${THRESHOLD} (PLACEHOLDER — needs real-world tuning once more fixtures/renders have been eyeballed)`);
  console.log(`  ${passed ? '✓ within threshold' : '✗ ABOVE threshold'}`);
  return passed;
}

// ── main ──────────────────────────────────────────────────────────────────────────────────────

const manifest = loadManifest();
const arg = (process.argv[2] || '').trim();

let entries = Object.entries(manifest);
if (arg) {
  const wantFile = arg.endsWith('.png') ? arg : `${arg}.png`;
  const matched = entries.filter(([filename, meta]) =>
    filename === wantFile || filename === arg || meta.archetype === arg);
  if (!matched.length) {
    console.error(`✗ no fixture matches "${arg}" (checked filename and archetype against manifest.json)`);
    console.error(`  known fixtures: ${entries.map(([f]) => f).join(', ')}`);
    process.exit(2);
  }
  entries = matched;
}

console.log(`Calibration harness — ${entries.length} fixture(s)`);
let allPassed = true;
for (const [filename, meta] of entries) {
  const result = runFixture(filename, meta);
  const passed = report(result);
  allPassed = allPassed && passed;
}

console.log(`\n${allPassed ? '✓ all fixtures within (placeholder) threshold' : '✗ one or more fixtures above (placeholder) threshold'}`);
process.exit(allPassed ? 0 : 1);
