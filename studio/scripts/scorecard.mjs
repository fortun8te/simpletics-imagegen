#!/usr/bin/env node
// scripts/scorecard.mjs — S12 "a score that can't lie" (COPY-ENGINE-V2 §3.8).
//
// scoreCopy({sourcePath, renderPath, doc, ...opts}) -> scorecard. Replaces the 64×64
// grayscale MAE as the GATE for copy fidelity: the old pixel-diff scored destroyed
// layouts (004 text soup) at 88+ because a big flat background dominates the grid.
// This scorecard OCRs BOTH the source ad and the render (lib/ocr.mjs, cached Apple
// Vision), aligns source lines ↔ render lines ↔ doc text layers by normalized string
// similarity + position, measures per-region color error, and — most importantly —
// applies HARD FAILS that no average can wash out:
//   ghostText           the same string twice in the render at a small offset —
//                       the double-render signature (overlay text + the same text
//                       still baked into an image crop underneath). Matched at the
//                       WORD-SEQUENCE level (sliding word window over the concatenated
//                       render OCR words), so an overlay that WRAPPED to two lines
//                       still matches its unwrapped baked twin; plus a merged-residue
//                       variant for when OCR fuses overlay+twin into ONE garbled,
//                       inflated line (018's "Perfect Fit | 20dB…" ghost)
//   placeholderArtifact a doc TEXT layer whose text exists in NO source OCR line —
//                       an invented label ("WHITE EARPLUG" placeholder circles)
//   textPile            ≥3 mutually-overlapping doc text layer pairs (≥40% of the
//                       smaller box) — hard fail; 1-2 pairs = soft composite penalty
//   missingText         >20% of confident source OCR lines missing from the copy
//                       (not in any doc layer, not keptInPhoto, not visible in the
//                       render via a baked photo base)
//   wrapMismatch        a doc text layer renders with MORE lines than its source
//                       counterpart (source "A | B | C" one line, render two).
//                       Per-layer soft composite penalty; a headline/subhead-role
//                       over-wrap OR ≥2 single-source-line over-wraps = hard fail.
//                       Under-wraps are recorded only (render OCR merges lines)
// Soft-only signals: logoGlyphSub — a render OCR line starts with '•'/'·' where the
// source counterpart has no bullet (logo pictograph swallowed into a text layer).
//
// Output: { ok, hardFails:[{rule, detail}], text:{...}, regions:{...}, legacyPixel,
//           composite } — composite is a weighted 0-100 (text 50% / regions 30% /
// legacy pixel 20%, reweighted over available parts), but ok/hardFails is THE gate:
// a 90 composite with hardFails is a FAILED copy.
//
// Invariants:
// - Coordinates are normalized into DOC CANVAS px (doc.canvas) — source OCR boxes and
//   render OCR boxes are scaled by their respective image dims (contracts: coordinates
//   are source-image px; here the canvas is the common frame all three inputs share).
// - Never throws for engine reasons: OCR/pixel/region failures degrade to nulls and
//   the composite reweights; only programmer errors (missing doc) throw.
// - Testable without Chrome or the OCR CLI: pass opts.ocr (async path -> S1-shaped
//   object) and opts.regions:false / opts.decode to inject fixtures.
//
// Called by: scripts/copy-harness.mjs (per-case scoring + --scorecard-only re-scoring);
// standalone CLI: node scripts/scorecard.mjs <source> <render> <doc.json>
//
// Calibration (2026-07-09, 42-case corpus): 004/016/018 (soup / ghost text /
// placeholder labels) must come out ok:false with those reasons; 021/042/053
// (visually clean) must stay ok:true with composite ≥85; 002/003 (nutrition
// tables that legitimately repeat strings) must stay ghost-clean. Tune here,
// verify with `node scripts/copy-harness.mjs --scorecard-only`.
// Tightened 2026-07-09 (wrapped-ghost pass) after 018's copy-engine-out render
// shipped a visible ghost at 98.4/zero-hard-fails: ghost matching moved to word-
// sequence level + merged-residue variant; wrapMismatch + logoGlyphSub added.
// Verified true positives picked up by the tightening: 003 (subhead wraps 1→2),
// 008 (real "SCHRIJF JE IN…" dupe at y1459 absent from source), 017 ("Try the
// real thing." wraps 1→2) — confirmed against the renders, not rule artifacts.

import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pixelDiff } from './pixel-diff.mjs';

const STUDIO = join(dirname(fileURLToPath(import.meta.url)), '..');

// ── string alignment ─────────────────────────────────────────────────────────────────

/** Fold a string for comparison: lowercase, strip diacritics, drop everything that is
 *  not a letter/digit/currency-ish symbol. OCR noise (spacing, punctuation, case) and
 *  style transforms (uppercase:true) vanish; the letters have to speak for themselves. */
export function normText(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9€$£%&+]/g, '');
}

/** Levenshtein distance, plain O(n·m) two-row — strings here are short (ad copy). */
export function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Array(b.length + 1);
  let cur = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

/** Normalized-string similarity 0..1 (1 = identical after folding). */
export function similarity(rawA, rawB) {
  const a = normText(rawA), b = normText(rawB);
  if (!a.length || !b.length) return 0;
  const d = levenshtein(a, b);
  return 1 - d / Math.max(a.length, b.length);
}

/** Best fuzzy "does `needle` appear inside `hay`" score: slides a word window over hay
 *  and keeps the best window↔needle similarity. Catches a source OCR LINE that is one
 *  wrapped row of a multi-line doc text layer (and doc texts like "X.com" that OCR
 *  split into "X" + ".com"). */
export function fuzzyContains(hay, needle) {
  const whole = similarity(hay, needle);
  const words = String(hay || '').split(/\s+/).filter(Boolean);
  if (words.length <= 1) return whole;
  const target = normText(needle);
  let best = whole;
  for (let i = 0; i < words.length; i++) {
    let acc = '';
    for (let j = i; j < words.length; j++) {
      acc += normText(words[j]);
      if (!acc.length) continue;
      if (acc.length > target.length * 2.5) break;
      const d = levenshtein(acc, target);
      const sim = target.length ? 1 - d / Math.max(acc.length, target.length) : 0;
      if (sim > best) best = sim;
    }
  }
  return best;
}

/** Union of two boxes. */
function unionBox(a, b) {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

/** Best match of `text` against OCR `lines`, considering each line AND joins of up to
 *  `maxWindow` consecutive lines (multi-line doc layers OCR back as separate lines).
 *  Returns { sim, box, lineIdxs, meanLineH } or { sim: 0 } when lines is empty. */
export function bestLineMatch(text, lines, { maxWindow = 6 } = {}) {
  const target = normText(text);
  let best = { sim: 0, box: null, lineIdxs: [], meanLineH: null };
  if (!target.length) return best;
  for (let i = 0; i < lines.length; i++) {
    let joined = '';
    let box = null;
    let hSum = 0;
    for (let k = 0; k < maxWindow && i + k < lines.length; k++) {
      const line = lines[i + k];
      joined += normText(line.text);
      box = box ? unionBox(box, line.box) : { ...line.box };
      hSum += line.box.h;
      if (!joined.length) continue;
      if (joined.length > target.length * 2.5) break;
      const d = levenshtein(joined, target);
      const sim = 1 - d / Math.max(joined.length, target.length);
      if (sim > best.sim) {
        best = { sim, box, lineIdxs: Array.from({ length: k + 1 }, (_, n) => i + n), meanLineH: hSum / (k + 1) };
      }
    }
  }
  return best;
}

/** Split OCR lines into a WORD stream with approximate per-word boxes (proportional
 *  x-split of each line box by folded char share, which is exact enough for offset /
 *  axis-overlap math). One flat stream means a sliding word window can match a string
 *  REGARDLESS of how OCR broke it into lines — a wrapped overlay ("Perfect Fit | 20dB
 *  Reduction |" / "5 Styles") still matches its unwrapped baked twin. */
export function buildWordStream(lines) {
  const words = [];
  lines.forEach((line, lineIdx) => {
    const parts = String(line.text || '').split(/\s+/).filter(Boolean);
    const norms = parts.map(normText);
    const totalChars = norms.reduce((s, n) => s + Math.max(n.length, 1), 0);
    let acc = 0;
    parts.forEach((raw, i) => {
      const n = norms[i];
      const span = Math.max(n.length, 1);
      const x = line.box.x + line.box.w * (acc / totalChars);
      acc += span;
      if (!n.length) return;
      words.push({
        raw, norm: n, lineIdx,
        box: { x, y: line.box.y, w: line.box.w * (span / totalChars), h: line.box.h },
      });
    });
  });
  return words;
}

/** All DISJOINT sliding-word-window matches of `targetNorm` in a word stream, greedy
 *  best-sim-first. Window length is pruned to 0.55–1.6× the target's folded length.
 *  Returns [{ i0, i1, sim, box }] sorted by sim desc. */
export function windowMatches(words, targetNorm, { minSim = 0.78 } = {}) {
  const target = String(targetNorm || '');
  if (!target.length) return [];
  const all = [];
  for (let i = 0; i < words.length; i++) {
    let acc = '';
    let box = null;
    let best = null;
    for (let j = i; j < words.length; j++) {
      acc += words[j].norm;
      box = box ? unionBox(box, words[j].box) : { ...words[j].box };
      if (acc.length > target.length * 1.6) break;
      if (acc.length < target.length * 0.55) continue;
      const sim = 1 - levenshtein(acc, target) / Math.max(acc.length, target.length);
      if (!best || sim > best.sim) best = { i0: i, i1: j, sim, box: { ...box } };
    }
    if (best && best.sim >= minSim) all.push(best);
  }
  all.sort((a, b) => b.sim - a.sim);
  const picked = [];
  for (const m of all) {
    if (picked.every((p) => m.i1 < p.i0 || m.i0 > p.i1)) picked.push(m);
  }
  return picked;
}

// ── geometry helpers ──────────────────────────────────────────────────────────────────

function center(b) { return { x: b.x + b.w / 2, y: b.y + b.h / 2 }; }
function centerDist(a, b) { const ca = center(a), cb = center(b); return Math.hypot(ca.x - cb.x, ca.y - cb.y); }
function scaleBox(b, sx, sy) { return { x: b.x * sx, y: b.y * sy, w: b.w * sx, h: b.h * sy }; }

/** Overlap of two boxes as a fraction of the SMALLER box's area (the text-pile measure,
 *  ported from copy-harness.mjs). */
export function overlapFrac(A, B) {
  const ix = Math.max(0, Math.min(A.x + A.w, B.x + B.w) - Math.max(A.x, B.x));
  const iy = Math.max(0, Math.min(A.y + A.h, B.y + B.h) - Math.max(A.y, B.y));
  return (ix * iy) / (Math.min(A.w * A.h, B.w * B.h) || 1);
}

/** Axis-projection overlap fraction relative to the smaller extent — the ghost guard:
 *  a real double-render sits on (nearly) the same column/row; two legitimately similar
 *  strings side by side (price grid, before/after labels) do not. */
function axisOverlap(A, B) {
  const ox = Math.max(0, Math.min(A.x + A.w, B.x + B.w) - Math.max(A.x, B.x)) / (Math.min(A.w, B.w) || 1);
  const oy = Math.max(0, Math.min(A.y + A.h, B.y + B.h) - Math.max(A.y, B.y)) / (Math.min(A.h, B.h) || 1);
  return Math.max(ox, oy);
}

/** Collect visible text leaves (and non-text leaves) from a possibly-nested doc tree. */
function collectLeaves(layers, out = { texts: [], others: [] }) {
  for (const l of (Array.isArray(layers) ? layers : [])) {
    if (!l || l.hidden) continue;
    if (l.type === 'group') { collectLeaves(l.children, out); continue; }
    if (!l.box) continue;
    if (l.type === 'text' && String(l.text || '').trim()) out.texts.push(l);
    else if (l.type !== 'text') out.others.push(l);
  }
  return out;
}

// ── region ΔE (sRGB → Lab, D65) ───────────────────────────────────────────────────────

function srgbToLab(r, g, b) {
  const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const R = lin(r), G = lin(g), B = lin(b);
  const X = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047;
  const Y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
  const Z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(X), fy = f(Y), fz = f(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function deltaE76(rgb1, rgb2) {
  const a = srgbToLab(rgb1[0], rgb1[1], rgb1[2]);
  const b = srgbToLab(rgb2[0], rgb2[1], rgb2[2]);
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** Decode an image to raw RGB at exactly w×h (sharp; flattened over white). Returns
 *  { data, width, height, channels:3 } or null when sharp/decoding is unavailable. */
async function decodeToCanvas(path, w, h) {
  try {
    const sharp = (await import('sharp')).default;
    const data = await sharp(path).flatten({ background: '#ffffff' }).resize(w, h, { fit: 'fill' }).removeAlpha().raw().toBuffer();
    return { data, width: w, height: h, channels: 3 };
  } catch { return null; }
}

/** Per-region mean ΔE between source and render, sampling inside each non-text doc
 *  layer box with all TEXT rects (doc text boxes ∪ source OCR boxes) masked out —
 *  moved/re-set text must not pollute the fill/photo comparison. */
function regionDeltas(srcPx, renPx, regions, textRects, canvas) {
  const out = [];
  const inText = (x, y) => {
    for (const r of textRects) {
      if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return true;
    }
    return false;
  };
  for (const layer of regions) {
    const b = layer.box;
    const x0 = Math.max(0, Math.floor(b.x)), y0 = Math.max(0, Math.floor(b.y));
    const x1 = Math.min(canvas.w, Math.ceil(b.x + b.w)), y1 = Math.min(canvas.h, Math.ceil(b.y + b.h));
    if (x1 - x0 < 4 || y1 - y0 < 4) continue;
    const area = (x1 - x0) * (y1 - y0);
    const step = Math.max(1, Math.round(Math.sqrt(area / 4000)));
    let sum = 0, n = 0;
    for (let y = y0; y < y1; y += step) {
      for (let x = x0; x < x1; x += step) {
        if (inText(x, y)) continue;
        const p = (y * canvas.w + x) * 3;
        sum += deltaE76(
          [srcPx.data[p], srcPx.data[p + 1], srcPx.data[p + 2]],
          [renPx.data[p], renPx.data[p + 1], renPx.data[p + 2]],
        );
        n++;
      }
    }
    if (n < 40) continue; // fully text-covered or degenerate — nothing honest to measure
    out.push({
      id: layer.id || null, name: layer.name || layer.role || layer.type,
      type: layer.type, box: b, area, meanDeltaE: Math.round((sum / n) * 100) / 100, samples: n,
    });
  }
  return out;
}

// ── the scorecard ────────────────────────────────────────────────────────────────────

const clamp01 = (v) => Math.max(0, Math.min(1, v));

/**
 * Score a copy job. All heavy inputs are injectable for tests.
 * @param {object} args
 * @param {string} args.sourcePath   original reference ad (png/webp/jpg)
 * @param {string} args.renderPath   rendered copy PNG
 * @param {object} args.doc          assembled DesignDoc ({canvas, layers})
 * @param {string[]} [args.keptInPhoto]  strings intentionally left baked in the photo base
 * @param {(path:string)=>Promise<object>} [args.ocr]  S1-shaped OCR (default lib/ocr.mjs)
 * @param {boolean} [args.regions]   set false to skip the pixel/ΔE region pass (tests)
 * @param {number|null} [args.legacyPixel]  pre-computed legacy pixel score (skip pixel-diff)
 */
export async function scoreCopy({ sourcePath, renderPath, doc, keptInPhoto = [], ocr = null, regions: regionsEnabled = true, legacyPixel = undefined }) {
  if (!doc || !doc.canvas) throw new Error('scoreCopy: doc with canvas required');
  const canvas = { w: doc.canvas.w || 1080, h: doc.canvas.h || 1080 };
  const diag = Math.hypot(canvas.w, canvas.h);
  const hardFails = [];

  const kept = (Array.isArray(keptInPhoto) ? keptInPhoto : []).concat(Array.isArray(doc.keptInPhoto) ? doc.keptInPhoto : []);

  // 1. OCR both sides (cached; ~0.4s each cold). Injectable for tests.
  const runOcr = ocr || (await import('../lib/ocr.mjs')).recognizeText;
  let srcOcr = null, renOcr = null;
  try { srcOcr = await runOcr(sourcePath); } catch (e) { srcOcr = { ok: false, error: String(e?.message || e) }; }
  try { renOcr = await runOcr(renderPath); } catch (e) { renOcr = { ok: false, error: String(e?.message || e) }; }

  // scale OCR boxes into canvas space
  const srcLines = (srcOcr?.ok && Array.isArray(srcOcr.lines)) ? srcOcr.lines.map((l) => ({
    ...l,
    srcH: l.box?.h ?? 0,
    box: scaleBox(l.box, canvas.w / (srcOcr.source?.w || canvas.w), canvas.h / (srcOcr.source?.h || canvas.h)),
  })) : null;
  const renLines = (renOcr?.ok && Array.isArray(renOcr.lines)) ? renOcr.lines.map((l) => ({
    ...l,
    box: scaleBox(l.box, canvas.w / (renOcr.source?.w || canvas.w), canvas.h / (renOcr.source?.h || canvas.h)),
  })) : null;

  const { texts: docTexts, others: docOthers } = collectLeaves(doc.layers);

  // 2. per-doc-text-layer alignment: doc ↔ render OCR (did MY text survive rendering?)
  //    and doc ↔ source OCR (is this text REAL, i.e. present in the reference?).
  const layerRows = docTexts.map((l) => {
    const renMatch = renLines ? bestLineMatch(l.text, renLines) : { sim: null, box: null, meanLineH: null };
    const srcMatch = srcLines ? bestLineMatch(l.text, srcLines) : { sim: null, box: null, meanLineH: null };
    const stringOk = renMatch.sim == null ? null : renMatch.sim >= 0.85;
    // position: doc box vs where the string actually landed in the render is near-tautological
    // (the renderer puts it where the doc says) — the HONEST delta is source-position vs
    // render-position of the matched string: did the text end up where the reference had it?
    let posDeltaPx = null;
    if (renMatch.box && srcMatch.box && renMatch.sim >= 0.5 && srcMatch.sim >= 0.5) {
      posDeltaPx = Math.round(centerDist(renMatch.box, srcMatch.box) * 10) / 10;
    }
    let sizeDeltaPct = null;
    if (renMatch.meanLineH && srcMatch.meanLineH && renMatch.sim >= 0.5 && srcMatch.sim >= 0.5) {
      sizeDeltaPct = Math.round(Math.abs(renMatch.meanLineH - srcMatch.meanLineH) / srcMatch.meanLineH * 1000) / 10;
    }
    return {
      id: l.id || null, text: String(l.text).slice(0, 60),
      renderSim: renMatch.sim == null ? null : Math.round(renMatch.sim * 100) / 100,
      sourceSim: srcMatch.sim == null ? null : Math.round(srcMatch.sim * 100) / 100,
      stringOk, posDeltaPx, sizeDeltaPct,
      _norm: normText(l.text), _box: l.box, _full: String(l.text),
      _role: l.role || null, _srcMatch: srcMatch, _renMatch: renMatch,
    };
  });

  // 3. source-line coverage: each confident source line must live SOMEWHERE in the copy —
  //    a doc text layer, an explicit keptInPhoto entry, or visibly baked into the render
  //    (photo-base copies carry the source text in an image layer; the render OCR sees it).
  const confident = (srcLines || []).filter((l) => (l.conf ?? 1) >= 0.5 && l.srcH >= 12 && normText(l.text).length >= 2);
  const coverage = confident.map((l) => {
    let how = null;
    for (const row of layerRows) {
      if (fuzzyContains(row._full, l.text) >= 0.7) { how = 'doc-layer'; break; }
    }
    if (!how) {
      for (const k of kept) { if (similarity(k, l.text) >= 0.8 || fuzzyContains(k, l.text) >= 0.8) { how = 'kept-in-photo'; break; } }
    }
    if (!how && renLines) {
      const m = bestLineMatch(l.text, renLines, { maxWindow: 3 });
      if (m.sim >= 0.85 && m.box && centerDist(m.box, l.box) <= diag * 0.2) how = 'render-baked';
    }
    return { text: String(l.text).slice(0, 60), covered: !!how, how };
  });
  const missing = coverage.filter((c) => !c.covered);

  // 4. hard fails ---------------------------------------------------------------------

  // ghostText: the same string twice in the render at a small offset, stacked on the
  // same column/row — overlay text doubled over its still-baked twin. Matched at the
  // WORD-SEQUENCE level (buildWordStream + windowMatches over the concatenated render
  // words), NOT whole-line strings: a wrapped overlay ("Perfect Fit | 20dB Reduction |"
  // / "5 Styles") must still match its unwrapped one-line baked twin, which line-level
  // pairing structurally cannot see (018's ghost shipped at 98.4 exactly this way).
  // 0.78 (not 0.9) because the baked copy under a semi-opaque overlay OCRs back garbled
  // by a char or two ("prebiotics"/"preelotics"); the axis-overlap guard keeps legit
  // side-by-side repetition (price grids, before/after labels) out; the source guards
  // keep strings the REFERENCE legitimately repeats (nutrition tables list "creatine
  // monohydraat" twice) from reading as ghosts:
  //   - count guard: the string occurs ≥2× in the source anywhere — counted at the
  //     WORD-SEQUENCE level too ("CREATINE" repeats inside longer source lines like
  //     "UPFRONT CREATINE"; line-level similarity never sees that), OR
  //   - anchor guard: BOTH render occurrences sit on top of a real source occurrence —
  //     a true ghost has only its BAKED half anchored; the overlay half sits where the
  //     source has nothing (or unrelated text). Line-level text-compat stays lenient at
  //     tight position+width match because the source's second occurrence may itself
  //     OCR back garbled (002's 6px-tall "sttestre monnhutraar").
  const srcWordStream = srcLines ? buildWordStream(srcLines) : [];
  const srcOccCache = new Map();
  const srcOccurrences = (norm) => {
    if (!srcOccCache.has(norm)) srcOccCache.set(norm, windowMatches(srcWordStream, norm));
    return srcOccCache.get(norm);
  };
  const srcDupCount = (text) => {
    const lineCount = (srcLines || []).filter((s) => similarity(s.text, text) >= 0.7).length;
    return Math.max(lineCount, srcOccurrences(normText(text)).length);
  };
  if (renLines) {
    // line-level anchor (ported from the pairwise rule): does this render LINE sit on
    // top of a real source line with compatible text/geometry?
    const lineAnchored = (line) => (srcLines || []).some((s) => {
      const d = centerDist(s.box, line.box);
      if (d > 25) return false;
      const sim = similarity(s.text, line.text);
      if (sim >= 0.6) return true;
      const wOk = Math.abs(s.box.w - line.box.w) / Math.max(s.box.w, line.box.w, 1) <= 0.3;
      return sim >= 0.3 && d <= 12 && wOk;
    });
    const okLines = renLines.filter((l) => (l.conf ?? 1) >= 0.25);
    const words = buildWordStream(okLines);
    // occurrence-level anchor: a word-window occurrence is anchored when the source has
    // the same word sequence at (nearly) the same spot, OR when EVERY render line it
    // draws words from is itself line-anchored — a sub-line fragment ("creatine" inside
    // an anchored table row) must inherit its host line's anchor, not lose it to
    // word-box geometry (002's 6px table rows anchor only via the lenient line check).
    const anchoredOcc = (occ, norm) => {
      if (srcOccurrences(norm).some((o) => centerDist(o.box, occ.box) <= 25)) return true;
      const lineIdxs = new Set();
      for (let k = occ.i0; k <= occ.i1; k++) lineIdxs.add(words[k].lineIdx);
      return [...lineIdxs].every((li) => lineAnchored(okLines[li]));
    };
    // targets: every render line + every doc text layer (the overlay's SOURCE OF TRUTH —
    // its ghost may OCR back too garbled to be a target itself), deduped by folded text.
    const targets = new Map();
    for (const l of okLines) { const n = normText(l.text); if (n.length >= 6) targets.set(n, String(l.text)); }
    for (const row of layerRows) { if (row._norm.length >= 6) targets.set(row._norm, row._full); }
    for (const [norm, text] of targets) {
      if (srcDupCount(text) >= 2) continue; // repeated in the reference too
      const occ = windowMatches(words, norm);
      if (occ.length < 2) continue;
      let fired = false;
      for (let i = 0; i < occ.length && !fired; i++) {
        for (let j = i + 1; j < occ.length && !fired; j++) {
          // wrap changes an occurrence's box SHAPE (2-line union vs 1 line), which
          // drags the center — the top-left origin stays put. Either distance in the
          // ghost band counts; both must clear the 8px OCR-jitter floor.
          const cOff = centerDist(occ[i].box, occ[j].box);
          const oOff = Math.hypot(occ[i].box.x - occ[j].box.x, occ[i].box.y - occ[j].box.y);
          const off = Math.min(cOff, oOff);
          if (off < 8 || off > 80) continue;
          if (axisOverlap(occ[i].box, occ[j].box) < 0.5) continue;
          if (anchoredOcc(occ[i], norm) && anchoredOcc(occ[j], norm)) continue; // both halves mirror real source lines
          hardFails.push({
            rule: 'ghostText',
            detail: `"${text.slice(0, 40)}" ×2 in render (word-window sims ${occ[i].sim.toFixed(2)}/${occ[j].sim.toFixed(2)}, offset ${Math.round(off)}px)`,
          });
          fired = true;
        }
      }
    }
  }

  // ghostText (merged-residue variant): Apple Vision often FUSES the overlay with its
  // baked twin into ONE garbled line instead of reporting two — 018's render OCRs as
  // "Perfect Fit)20dB Reductiohes" (h 55px, starting 10px ABOVE the layer box) + "5
  // Styles", so no word sequence ever appears twice. The physical signature that
  // survives: the layer WRAPPED (≥2 render lines) while the source had ONE line, and
  // the fused line's ink is both INFLATED (≥1.28× the source line height — a clean
  // wrap keeps the source's type size or shrinks) and OVERHANGING the layer box top
  // (the twin's ink sits above where the overlay draws). Both conditions must hold:
  // 018's logo layer also wraps 1→2 but stays at honest line heights and does not fire.
  if (renLines && srcLines) {
    for (const row of layerRows) {
      const sm = row._srcMatch, rm = row._renMatch;
      if (!sm?.box || !rm?.box || sm.sim < 0.7 || rm.sim < 0.7) continue;
      if (row._norm.length < 8) continue;
      if (sm.lineIdxs.length !== 1 || rm.lineIdxs.length < 2) continue; // src one line, render wrapped
      if (srcDupCount(row._full) >= 2) continue;
      const srcH = sm.meanLineH || sm.box.h;
      const maxLineH = Math.max(...rm.lineIdxs.map((i) => renLines[i].box.h));
      const minLineY = Math.min(...rm.lineIdxs.map((i) => renLines[i].box.y));
      if (maxLineH >= srcH * 1.28 && minLineY <= row._box.y - 4) {
        hardFails.push({
          rule: 'ghostText',
          detail: `layer "${row.text}" wrapped to ${rm.lineIdxs.length} render lines with fused ghost ink (OCR line h ${Math.round(maxLineH)}px vs source ${Math.round(srcH)}px, ink ${Math.round(row._box.y - minLineY)}px above the layer box)`,
        });
      }
    }
  }

  // wrapMismatch: a doc text layer renders with a DIFFERENT line count than its source
  // counterpart — source "Perfect Fit | 20dB Reduction | 5 Styles" is ONE line, the
  // copy wraps it to TWO (font/tracking drift). Render OCR gives the rendered line
  // count; the doc text's own '\n' count is a second signal when OCR under-splits.
  // Only OVER-wraps (render > source) are penalized/gated: render OCR merges adjacent
  // lines all the time (018's fused ghost line is itself proof), so a LOWER render
  // count is unreliable evidence — under-wraps are recorded, nothing more. Soft
  // composite penalty per over-wrapped layer; hard fail when a headline/subhead-role
  // layer over-wraps OR ≥2 single-source-line layers over-wrap (a wrapped headline or
  // a pattern of wrapped taglines/CTAs is a broken ad, not drift).
  const wrapMismatches = [];
  if (renLines && srcLines) {
    for (const row of layerRows) {
      const sm = row._srcMatch, rm = row._renMatch;
      if (!sm?.box || !rm?.box || sm.sim < 0.75 || rm.sim < 0.75) continue; // only confident alignments
      if (row._norm.length < 6) continue;
      const docCount = String(row._full).split('\n').filter((s) => s.trim()).length;
      const renCount = Math.max(rm.lineIdxs.length, docCount > 1 ? docCount : 0);
      const srcCount = sm.lineIdxs.length;
      if (renCount !== srcCount) {
        wrapMismatches.push({
          id: row.id, text: row.text, role: row._role,
          sourceLines: srcCount, renderLines: renCount,
        });
      }
    }
    const overWraps = wrapMismatches.filter((m) => m.renderLines > m.sourceLines);
    const roleHit = overWraps.find((m) => m.role === 'headline' || m.role === 'subhead');
    const singleLineWraps = overWraps.filter((m) => m.sourceLines === 1);
    if (roleHit || singleLineWraps.length >= 2) {
      hardFails.push({
        rule: 'wrapMismatch',
        detail: `${overWraps.length} layer(s) wrap past their source line count${roleHit ? ` incl. ${roleHit.role}` : ''}: ${overWraps.slice(0, 4).map((m) => `"${m.text.slice(0, 30)}" ${m.sourceLines}→${m.renderLines}`).join(', ')}`,
      });
    }
  }

  // logoGlyphSub (soft): a render OCR line starts with '•'/'·' where the source
  // counterpart has no bullet — a logo pictograph got swallowed into a text layer and
  // re-rendered as a generic bullet character.
  const logoGlyphSubs = [];
  if (renLines && srcLines) {
    const bullet = (s) => /^\s*[•·]/.test(String(s));
    for (const rl of renLines) {
      if (!bullet(rl.text)) continue;
      let best = null;
      for (const sl of srcLines) {
        const s = similarity(sl.text, rl.text);
        if (!best || s > best.s) best = { s, sl };
      }
      if (best && best.s >= 0.6 && !bullet(best.sl.text)) {
        logoGlyphSubs.push({ render: String(rl.text).slice(0, 40), source: String(best.sl.text).slice(0, 40) });
      }
    }
  }

  // placeholderArtifact: a doc TEXT layer whose text appears in NO source OCR line —
  // the pipeline INVENTED a label (matte-fallback placeholder circles etc.). Two tests
  // must BOTH miss: (a) line-window similarity (sourceSim), and (b) an order-free word
  // bag — multi-column ads interleave columns in OCR reading order, so a real layer like
  // "✓ Protects skin & hair" can score low on (a) while every word exists in the source.
  // Word matches are strict (sim ≥0.9): "EARPLUG" must not ride on the source's
  // "Earplugs" to launder an invented "WHITE EARPLUG" label.
  if (srcLines) {
    const srcWords = [];
    for (const l of srcLines) for (const w of String(l.text).split(/\s+/)) { const n = normText(w); if (n.length >= 3) srcWords.push(n); }
    const wordCoverage = (text) => {
      const words = String(text).split(/\s+/).map(normText).filter((w) => w.length >= 3);
      if (!words.length) return 1;
      let hit = 0;
      for (const w of words) {
        if (srcWords.some((s) => (1 - levenshtein(w, s) / Math.max(w.length, s.length)) >= 0.9)) hit++;
      }
      return hit / words.length;
    };
    for (const row of layerRows) {
      if (row._norm.length < 6) continue; // too short to judge honestly
      if (row.sourceSim == null || row.sourceSim >= 0.55) continue;
      const cov = wordCoverage(row._full);
      if (cov < 0.5) {
        hardFails.push({ rule: 'placeholderArtifact', detail: `invented text layer "${row.text}" (best source sim ${row.sourceSim}, word coverage ${Math.round(cov * 100)}%)` });
      }
    }
  }

  // textPile: mutual doc-text-box overlap ≥40% of the smaller box (ported from
  // copy-harness.mjs text-pile penalty) — ≥3 pairs is a destroyed layout, hard fail;
  // 1-2 pairs stay a soft composite penalty below.
  let pileOverlaps = 0;
  const pilePairs = [];
  for (let a = 0; a < layerRows.length; a++) {
    for (let b = a + 1; b < layerRows.length; b++) {
      if (overlapFrac(layerRows[a]._box, layerRows[b]._box) >= 0.4) {
        pileOverlaps++;
        if (pilePairs.length < 6) pilePairs.push(`"${layerRows[a].text.slice(0, 20)}"×"${layerRows[b].text.slice(0, 20)}"`);
      }
    }
  }
  if (pileOverlaps >= 3) {
    hardFails.push({ rule: 'textPile', detail: `${pileOverlaps} overlapping text pairs (≥40% mutual): ${pilePairs.join(', ')}` });
  }

  // missingText: >20% of confident source lines are nowhere in the copy. ≥2 absolute
  // so a single OCR hiccup on a 4-line ad can't hard-fail an otherwise perfect copy.
  if (srcLines && confident.length >= 3) {
    const frac = missing.length / confident.length;
    if (frac > 0.2 && missing.length >= 2) {
      hardFails.push({
        rule: 'missingText',
        detail: `${missing.length}/${confident.length} source lines missing (${Math.round(frac * 100)}%): ${missing.slice(0, 4).map((m) => `"${m.text.slice(0, 30)}"`).join(', ')}`,
      });
    }
  }

  // 5. aggregates + subscores ----------------------------------------------------------
  const okRows = layerRows.filter((r) => r.stringOk != null);
  const textRenderAcc = okRows.length ? okRows.filter((r) => r.stringOk).length / okRows.length : null;
  const textRecall = coverage.length ? coverage.filter((c) => c.covered).length / coverage.length : null;
  const posRows = layerRows.filter((r) => r.posDeltaPx != null);
  const meanPosDelta = posRows.length ? Math.round(posRows.reduce((s, r) => s + r.posDeltaPx, 0) / posRows.length * 10) / 10 : null;

  let textScore = null;
  {
    const parts = [];
    if (textRecall != null) parts.push([0.5, textRecall]);
    if (textRenderAcc != null) parts.push([0.35, textRenderAcc]);
    if (meanPosDelta != null) parts.push([0.15, clamp01(1 - meanPosDelta / (diag * 0.12))]);
    const wSum = parts.reduce((s, [w]) => s + w, 0);
    if (wSum > 0) textScore = Math.round((parts.reduce((s, [w, v]) => s + w * v, 0) / wSum) * 1000) / 10;
  }

  // 6. regions: masked ΔE per non-text doc layer box
  let regionRows = null, regionScore = null, meanDeltaE = null;
  if (regionsEnabled && docOthers.length) {
    const srcPx = await decodeToCanvas(sourcePath, canvas.w, canvas.h);
    const renPx = await decodeToCanvas(renderPath, canvas.w, canvas.h);
    if (srcPx && renPx) {
      const textRects = layerRows.map((r) => r._box).concat((srcLines || []).map((l) => l.box));
      regionRows = regionDeltas(srcPx, renPx, docOthers, textRects, canvas);
      if (regionRows.length) {
        meanDeltaE = Math.round(regionRows.reduce((s, r) => s + r.meanDeltaE, 0) / regionRows.length * 100) / 100;
        // AREA-weighted: a slightly-off 200px badge must not outvote a clean full-canvas
        // photo base — the score answers "how much of the canvas has the right colors?".
        const areaSum = regionRows.reduce((s, r) => s + r.area, 0);
        regionScore = Math.round(regionRows.reduce((s, r) => s + r.area * clamp01(1 - r.meanDeltaE / 40), 0) / areaSum * 1000) / 10;
      }
    }
  }

  // 7. legacy pixel score (demoted to tiebreaker, kept for continuity). Source may be
  //    webp (pixel-diff decodes PNG only) — transcode via sharp once when needed.
  let legacy = legacyPixel;
  if (legacy === undefined) {
    legacy = null;
    let d = pixelDiff(sourcePath, renderPath, { grid: 64 });
    if (!d.ok && !/\.png$/i.test(sourcePath)) {
      try {
        const sharp = (await import('sharp')).default;
        const tmp = join(STUDIO, '.state', `scorecard-legacy-${process.pid}-${Date.now()}.png`);
        await sharp(sourcePath).png().toFile(tmp);
        d = pixelDiff(tmp, renderPath, { grid: 64 });
        rmSync(tmp, { force: true });
      } catch { /* legacy stays null */ }
    }
    if (d.ok) legacy = d.score;
  }

  // 8. composite: text 50 / regions 30 / legacy 20, reweighted over available parts,
  //    minus the soft text-pile penalty (hard fail already covers ≥3 pairs).
  let composite = null;
  {
    const parts = [];
    if (textScore != null) parts.push([0.5, textScore]);
    if (regionScore != null) parts.push([0.3, regionScore]);
    if (legacy != null) parts.push([0.2, legacy]);
    const wSum = parts.reduce((s, [w]) => s + w, 0);
    if (wSum > 0) {
      composite = parts.reduce((s, [w, v]) => s + w * v, 0) / wSum;
      composite -= Math.min(15, pileOverlaps * 3); // soft pile penalty (kept from the harness)
      composite -= Math.min(12, wrapMismatches.filter((m) => m.renderLines > m.sourceLines).length * 4); // over-wrap drift
      composite -= Math.min(6, logoGlyphSubs.length * 3); // swallowed pictographs
      composite = Math.max(0, Math.min(100, Math.round(composite * 10) / 10));
    }
  }

  return {
    ok: hardFails.length === 0,
    hardFails,
    text: {
      ocrOk: { source: !!srcLines, render: !!renLines },
      ocrError: { source: srcLines ? null : (srcOcr?.error || 'no lines'), render: renLines ? null : (renOcr?.error || 'no lines') },
      layers: layerRows.map(({ _norm, _box, _full, _role, _srcMatch, _renMatch, ...row }) => row),
      wrapMismatches,
      logoGlyphSubs,
      sourceLines: coverage,
      textRecall: textRecall == null ? null : Math.round(textRecall * 100) / 100,
      textRenderAcc: textRenderAcc == null ? null : Math.round(textRenderAcc * 100) / 100,
      meanPosDelta,
      pileOverlaps,
      score: textScore,
    },
    regions: { regions: regionRows, meanDeltaE, score: regionScore },
    legacyPixel: legacy,
    composite,
  };
}

// ── CLI: node scripts/scorecard.mjs <source> <render> <doc.json> [--out file] ─────────
if (import.meta.url === `file://${process.argv[1]}`) {
  const [source, render, docPath] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (!source || !render || !docPath) {
    console.error('usage: node scripts/scorecard.mjs <source.(png|webp)> <render.png> <doc.json> [--out scorecard.json]');
    process.exit(2);
  }
  const doc = JSON.parse(readFileSync(docPath, 'utf8'));
  const sc = await scoreCopy({ sourcePath: source, renderPath: render, doc });
  const oi = process.argv.indexOf('--out');
  if (oi >= 0 && process.argv[oi + 1]) writeFileSync(process.argv[oi + 1], JSON.stringify(sc, null, 2));
  console.log(JSON.stringify(sc, null, 2));
  if (!sc.ok) process.exitCode = 1;
}
