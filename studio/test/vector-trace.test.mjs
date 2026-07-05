// test/vector-trace.test.mjs — quality-gate thresholds, mono-merge behavior, deterministic
// output for a synthetic 2-color glyph, and graceful degradation. Trace-dependent tests are
// skipped when sharp/imagetracerjs are unavailable (mirrors test/matte.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  traceRegion, judgeTrace, monoMergeGroups, parseSvgPaths, signedPathArea, normalizePathD,
  traceResultToSvg,
  TRACE_MAX_PATHS, TRACE_MIN_COVERAGE, TRACE_MAX_COVERAGE, TRACE_MAX_SUBPATHS, TRACE_MERGE_DELTA,
} from '../lib/vector-trace.mjs';

let sharp = null;
try { sharp = (await import('sharp')).default; await import('imagetracerjs'); } catch { sharp = null; }

const tmp = mkdtempSync(join(tmpdir(), 'vtrace-test-'));

/** Render an SVG string to a PNG fixture (deterministic input for trace tests). */
async function svgFixture(name, svg) {
  const p = join(tmp, name);
  await sharp(Buffer.from(svg)).png().toFile(p);
  return p;
}

// ── pure gate thresholds ──────────────────────────────────────────────────────────────────────

test('judgeTrace: passes a sane logo trace', () => {
  assert.equal(judgeTrace({ pathCount: 1, coverage: 0.2, subpaths: 40 }).ok, true);
  assert.equal(judgeTrace({ pathCount: TRACE_MAX_PATHS, coverage: TRACE_MIN_COVERAGE, subpaths: TRACE_MAX_SUBPATHS }).ok, true);
});

test('judgeTrace: too many paths → ok:false', () => {
  const v = judgeTrace({ pathCount: TRACE_MAX_PATHS + 1, coverage: 0.3, subpaths: 40 });
  assert.equal(v.ok, false);
  assert.match(v.reason, /too many fills/);
});

test('judgeTrace: coverage out of range → ok:false (photo/gradient stays a crop)', () => {
  assert.equal(judgeTrace({ pathCount: 3, coverage: 0.999, subpaths: 40 }).ok, false); // fills tile everything
  assert.equal(judgeTrace({ pathCount: 1, coverage: TRACE_MAX_COVERAGE + 0.01, subpaths: 10 }).ok, false);
  assert.equal(judgeTrace({ pathCount: 1, coverage: TRACE_MIN_COVERAGE / 2, subpaths: 10 }).ok, false); // traced nothing
  assert.equal(judgeTrace({ pathCount: 0, coverage: 0, subpaths: 0 }).ok, false);
});

test('judgeTrace: subpath complexity cap → ok:false', () => {
  const v = judgeTrace({ pathCount: 2, coverage: 0.3, subpaths: TRACE_MAX_SUBPATHS + 1 });
  assert.equal(v.ok, false);
  assert.match(v.reason, /too complex/);
});

// ── mono-merge ────────────────────────────────────────────────────────────────────────────────

test('monoMergeGroups: near-identical fills collapse into ONE merged path group', () => {
  const kept = [
    { rgb: [16, 16, 16], ds: ['M 0 0 L 1 0 L 1 1 Z'], area: 100, subpaths: 1 },
    { rgb: [40, 40, 40], ds: ['M 2 2 L 3 2 L 3 3 Z'], area: 50, subpaths: 1 }, // dist ≈ 41.6 ≤ 48
  ];
  const g = monoMergeGroups(kept);
  assert.equal(g.length, 1);
  assert.equal(g[0].ds.length, 2);          // both d-strings kept as subpaths of one layer
  assert.equal(g[0].area, 150);
  assert.equal(g[0].subpaths, 2);
  assert.deepEqual(g[0].rgb, [16, 16, 16]); // largest-area fill wins the color slot
});

test('monoMergeGroups: distinct fills stay separate, largest-area first', () => {
  const kept = [
    { rgb: [200, 40, 40], ds: ['M 0 0 Z'], area: 50, subpaths: 1 },
    { rgb: [16, 16, 200], ds: ['M 1 1 Z'], area: 100, subpaths: 1 }, // far beyond TRACE_MERGE_DELTA
  ];
  const g = monoMergeGroups(kept);
  assert.equal(g.length, 2);
  assert.deepEqual(g[0].rgb, [16, 16, 200]); // sorted by area desc
  assert.ok(TRACE_MERGE_DELTA < 100);        // sanity: these really are beyond the delta
});

test('monoMergeGroups: empty input → empty output', () => {
  assert.deepEqual(monoMergeGroups([]), []);
});

// ── parsing / geometry helpers ────────────────────────────────────────────────────────────────

test('parseSvgPaths: pulls fill + opacity + d out of imagetracerjs SVG markup', () => {
  const svg = '<svg><path fill="rgb(10,20,30)" stroke="rgb(10,20,30)" stroke-width="0" opacity="1" d="M 0 0 L 4 0 L 4 4 Z " /><path fill="rgb(1,2,3)" stroke="rgb(1,2,3)" stroke-width="0" opacity="0" d="M 1 1 Z " /></svg>';
  const paths = parseSvgPaths(svg);
  assert.equal(paths.length, 2);
  assert.deepEqual(paths[0].rgb, [10, 20, 30]);
  assert.equal(paths[0].opacity, 1);
  assert.equal(paths[0].d, 'M 0 0 L 4 0 L 4 4 Z');
  assert.equal(paths[1].opacity, 0);
});

test('signedPathArea: shoelace with reverse-wound hole subpaths subtracting', () => {
  const outer = 'M 0 0 L 10 0 L 10 10 L 0 10 Z';                    // CW in screen coords → -100
  assert.equal(Math.abs(signedPathArea(outer)), 100);
  const withHole = outer + ' M 2 2 L 2 6 L 6 6 L 6 2 Z';            // reverse-wound 4×4 hole
  assert.equal(Math.abs(signedPathArea(withHole)), 100 - 16);
});

test('normalizePathD: rescales M/L/Q coords to 0..1 box-local', () => {
  const d = normalizePathD('M 0 0 L 100 0 Q 100 50 100 100 Z', 100, 200);
  assert.equal(d, 'M 0 0 L 1 0 Q 1 0.25 1 0.5 Z');
});

// ── end-to-end on synthetic fixtures (skipped without sharp) ──────────────────────────────────

const GLYPH_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128">
  <rect width="128" height="128" fill="#ffffff"/>
  <circle cx="64" cy="64" r="40" fill="#101010"/>
  <rect x="52" y="52" width="24" height="24" fill="#ffffff"/>
</svg>`;

test('traceRegion: synthetic 2-color glyph → ok, single mono path, sane coverage', { skip: !sharp }, async () => {
  const png = await svgFixture('glyph.png', GLYPH_SVG);
  const r = await traceRegion(png, { x: 0, y: 0, w: 1, h: 1 });
  assert.equal(r.ok, true, r.reason || '');
  assert.equal(r.pathCount, 1);                      // disc (with hole) merges to one ink layer
  assert.equal(r.viewBox, '0 0 1 1');
  assert.match(r.paths[0].fill, /^#[0-2][0-9a-f][0-2][0-9a-f][0-2][0-9a-f]$/); // near-black ink
  // disc − hole ≈ (π·40² − 24²) / 128² ≈ 0.27
  assert.ok(r.coverage > 0.18 && r.coverage < 0.38, `coverage ${r.coverage}`);
  // every coordinate normalized 0..1
  const nums = r.paths[0].d.split(/[\sMLQZ]+/).filter(Boolean).map(Number);
  assert.ok(nums.every((v) => v >= 0 && v <= 1));
  // the preview SVG builder wraps it verbatim
  assert.match(traceResultToSvg(r), /viewBox="0 0 1 1"/);
});

test('traceRegion: deterministic — identical output across runs', { skip: !sharp }, async () => {
  const png = await svgFixture('glyph-det.png', GLYPH_SVG);
  const a = await traceRegion(png, { x: 0, y: 0, w: 1, h: 1 });
  const b = await traceRegion(png, { x: 0, y: 0, w: 1, h: 1 });
  assert.deepEqual(
    { ok: a.ok, paths: a.paths, pathCount: a.pathCount, coverage: a.coverage, subpaths: a.subpaths },
    { ok: b.ok, paths: b.paths, pathCount: b.pathCount, coverage: b.coverage, subpaths: b.subpaths },
  );
});

test('traceRegion: gradient (photo-like) region FAILS the gate', { skip: !sharp }, async () => {
  const png = await svgFixture('gradient.png', `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#ff2200"/><stop offset="0.5" stop-color="#22cc88"/><stop offset="1" stop-color="#2200ff"/>
    </linearGradient></defs>
    <rect width="128" height="128" fill="url(#g)"/>
  </svg>`);
  const r = await traceRegion(png, { x: 0, y: 0, w: 1, h: 1 });
  assert.equal(r.ok, false);
  assert.ok(r.reason, 'gate must say why');
});

test('traceRegion: degrades — missing file / bad crop / oversized region → ok:false, never throws', { skip: !sharp }, async () => {
  const missing = await traceRegion('/nonexistent/logo.png', { x: 0, y: 0, w: 1, h: 1 });
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /cannot read source/);

  const badCrop = await traceRegion('/nonexistent/logo.png', { x: 0, y: 0, w: 0, h: 0 });
  assert.equal(badCrop.ok, false);
  assert.match(badCrop.reason, /bad crop/);

  const png = await svgFixture('glyph-region.png', GLYPH_SVG);
  const tooBig = await traceRegion(png, { x: 0, y: 0, w: 0.5, h: 0.5 }, { maxRegionFrac: 0.12 });
  assert.equal(tooBig.ok, false);
  assert.match(tooBig.reason, /region too large/);
});
