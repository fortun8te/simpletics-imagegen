// lib/refine-loop.mjs — the SELF-IMPROVING LOOP: render → compare vs reference → correct → repeat.
//
// The owner's core complaint: the pipeline makes ONE pass and never checks its own work. This
// module makes iterative refinement real — and it does it DETERMINISTICALLY (zero model calls),
// so it's cheap enough to be always-on after every first render.
//
// Each round:
//   1. Grid-diff the current render against the reference (reuses scripts/pixel-diff.mjs
//      internals: readPng + downsampleGray on a ~64×64 luminance grid).
//   2. Find the K worst cells and map them onto the doc layers whose boxes cover them.
//   3. For the top offender layers, generate a handful of CONCRETE geometry corrections:
//        text  → ±dx/±dy nudges (≤ ~2% canvas, 4-connected, coarse-to-fine) and fontSize ±8%
//        shape → fill luminance re-sample toward the reference's mean in that region + edge nudges
//        image → box position nudges ONLY (style.crop / src are NEVER touched)
//      Text CONTENT is never changed.
//   4. Each candidate costs exactly ONE full render; it's accepted only if it improves the LOCAL
//      region diff. The round is kept only if the GLOBAL score (caller's scoreFn) improved.
//   5. Stop on no-improvement, maxRounds, the render budget (~12/ad) or the wall-time budget.
//
// Directions are ESTIMATED for free before spending renders: the render's diff grid is shifted one
// cell in each of the 4 directions inside the layer's region — directions that don't reduce the
// local error are never rendered. That's what keeps the loop inside ~12 renders.
//
// API:
//   refineLoop(doc, referencePngPath, { maxRounds=3, renderFn, scoreFn, ... })
//     renderFn(doc)        → path to a PNG render of the doc (may be async; null on failure)
//     scoreFn(renderPath)  → global similarity score 0..100 (may be async; null on failure)
//   → { ok, rounds, applied, scoreBefore, scoreAfter, keptDoc, renders, capped, ms,
//       bestRenderPath, error }
//
// keptDoc is a deep copy — the input doc is never mutated.

import { copyFileSync, existsSync, rmSync } from 'node:fs';
import { readPng, downsampleGray } from '../scripts/pixel-diff.mjs';

// ── tunables (defaults; all overridable via opts) ───────────────────────────────────────────────
const GRID = 64;              // diff grid — one cell ≈ 1.56% of the canvas (inside the 2% nudge cap)
const TOP_LAYERS = 3;         // offender layers examined per round
const MAX_VARIANTS = 5;       // candidate corrections rendered per layer per round
const MAX_RENDERS = 12;       // hard render budget per ad (renders dominate wall time)
const WALL_MS = 45_000;       // hard wall-time budget per ad
const WORST_K = 16;           // worst diff cells considered when ranking offenders
const MIN_CELL_DIFF = 0.05;   // cells below this |Δlum| are "fine" — never drive corrections
const LOCAL_EPS = 0.001;      // a candidate must beat the local MAE by at least this
const GLOBAL_EPS = 0.01;      // a round must beat the global score by at least this
const HUGE_AREA = 0.85;       // layers covering ≥ this canvas fraction: color-only, never nudged

// ── small utils ─────────────────────────────────────────────────────────────────────────────────
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

function parseHex(s) {
  if (typeof s !== 'string') return null;
  const m3 = /^#([0-9a-f]{3})$/i.exec(s.trim());
  if (m3) return m3[1].split('').map((c) => parseInt(c + c, 16));
  const m6 = /^#([0-9a-f]{6})$/i.exec(s.trim());
  if (m6) return [0, 2, 4].map((i) => parseInt(m6[1].slice(i, i + 2), 16));
  return null;
}
const toHex = (rgb) => '#' + rgb.map((c) => clamp(Math.round(c), 0, 255).toString(16).padStart(2, '0').toUpperCase()).join('');
const lumOf = (rgb) => (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255;

/** Flatten a (possibly nested) layer tree to leaves. Child coords are ABSOLUTE (designstore
 *  contract), so leaves can be nudged in place regardless of grouping. */
export function leavesOf(layers, out = []) {
  for (const l of Array.isArray(layers) ? layers : []) {
    if (!l) continue;
    if (l.type === 'group' && Array.isArray(l.children)) leavesOf(l.children, out);
    else out.push(l);
  }
  return out;
}

const validBox = (b) => b && [b.x, b.y, b.w, b.h].every(Number.isFinite) && b.w > 0 && b.h > 0;

/** Decode + downsample a PNG to a grid×grid luminance grid. Null if undecodable. */
function gridOf(path, grid) {
  if (!path || !existsSync(path)) return null;
  const png = readPng(path);
  if (!png) return null;
  return downsampleGray(png, grid, grid);
}

/** Cell-rect (inclusive) covered by a canvas-space box, expanded by `margin` cells. */
export function cellsForBox(box, canvas, grid, margin = 1) {
  const x0 = clamp(Math.floor((box.x / canvas.w) * grid) - margin, 0, grid - 1);
  const y0 = clamp(Math.floor((box.y / canvas.h) * grid) - margin, 0, grid - 1);
  const x1 = clamp(Math.ceil(((box.x + box.w) / canvas.w) * grid) - 1 + margin, 0, grid - 1);
  const y1 = clamp(Math.ceil(((box.y + box.h) / canvas.h) * grid) - 1 + margin, 0, grid - 1);
  return { x0, y0, x1, y1 };
}

const unionRect = (a, b) => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) });

/** Mean |ref−ren| over a cell-rect. */
function localMae(refG, renG, grid, r) {
  let sum = 0, n = 0;
  for (let gy = r.y0; gy <= r.y1; gy++) {
    for (let gx = r.x0; gx <= r.x1; gx++) { sum += Math.abs(refG[gy * grid + gx] - renG[gy * grid + gx]); n++; }
  }
  return n ? sum / n : 0;
}

/** Mean reference / render luminance over a cell-rect (for the shape color re-sample). */
function regionMeans(refG, renG, grid, r) {
  let sr = 0, sn = 0, n = 0;
  for (let gy = r.y0; gy <= r.y1; gy++) {
    for (let gx = r.x0; gx <= r.x1; gx++) { sr += refG[gy * grid + gx]; sn += renG[gy * grid + gx]; n++; }
  }
  return n ? { ref: sr / n, ren: sn / n } : { ref: 0, ren: 0 };
}

/** The K worst diff cells (each ≥ minCellDiff). */
export function worstCells(refG, renG, grid, k, minCellDiff) {
  const cells = [];
  for (let gy = 0; gy < grid; gy++) {
    for (let gx = 0; gx < grid; gx++) {
      const d = Math.abs(refG[gy * grid + gx] - renG[gy * grid + gx]);
      if (d >= minCellDiff) cells.push({ gx, gy, d });
    }
  }
  cells.sort((a, b) => b.d - a.d);
  return cells.slice(0, k);
}

/** FREE direction estimate: local MAE if the render's region content were shifted 1 cell in each
 *  4-connected direction. Returns directions sorted best-first, each with its predicted MAE. */
function estimateShifts(refG, renG, grid, r) {
  const dirs = [{ dx: 1, dy: 0 }, { dx: -1, dy: 0 }, { dx: 0, dy: 1 }, { dx: 0, dy: -1 }];
  const scored = dirs.map((d) => {
    let sum = 0, n = 0;
    for (let gy = r.y0; gy <= r.y1; gy++) {
      for (let gx = r.x0; gx <= r.x1; gx++) {
        const sx = gx - d.dx, sy = gy - d.dy; // content moved BY d ⇒ cell (gx,gy) shows old (gx−dx,gy−dy)
        if (sx < 0 || sy < 0 || sx >= grid || sy >= grid) continue;
        sum += Math.abs(refG[gy * grid + gx] - renG[sy * grid + sx]); n++;
      }
    }
    return { ...d, mae: n ? sum / n : Infinity };
  });
  scored.sort((a, b) => a.mae - b.mae);
  return scored;
}

// ── candidate corrections ───────────────────────────────────────────────────────────────────────
// Each candidate = { kind, describe(), apply(leaf) }. apply() mutates the leaf of a CLONED doc.
// HARD SAFETY RULES enforced here: never touch leaf.text (content), never touch style.crop or
// src on media layers — only their box positions may move.

function shiftCandidate(dx, dy, canvas) {
  // cap at ~2% of the canvas per axis (coarse step is one grid cell ≈ 1.56%, so this only trims
  // pathological canvas/grid combos)
  const cx = clamp(dx, -0.02 * canvas.w, 0.02 * canvas.w);
  const cy = clamp(dy, -0.02 * canvas.h, 0.02 * canvas.h);
  return {
    kind: 'nudge', dx: Math.round(cx), dy: Math.round(cy),
    describe() { return `nudge dx=${this.dx} dy=${this.dy}`; },
    apply(leaf) { leaf.box.x = Math.round(leaf.box.x + this.dx); leaf.box.y = Math.round(leaf.box.y + this.dy); },
  };
}

function fontCandidate(factor) {
  return {
    kind: 'font', factor,
    describe() { return `fontSize ×${this.factor}`; },
    apply(leaf) {
      const fs = Number(leaf.style?.fontSize);
      if (!Number.isFinite(fs) || fs <= 0) return;
      leaf.style.fontSize = Math.max(6, Math.round(fs * this.factor));
    },
  };
}

function colorCandidate(fromHex, toHex_) {
  return {
    kind: 'color', from: fromHex, to: toHex_,
    describe() { return `fill ${this.from} → ${this.to}`; },
    apply(leaf) { leaf.style.background = this.to; },
  };
}

const isMedia = (leaf) => leaf.type === 'image' || !!leaf.style?.crop || !!leaf.src;

/** Build the (ordered, ≤max) candidate list for one offender layer. Deterministic. */
export function candidatesFor(leaf, { refG, renG, grid, canvas, max = MAX_VARIANTS }) {
  const out = [];
  const region = cellsForBox(leaf.box, canvas, grid, 2);
  const cur = localMae(refG, renG, grid, region);
  const shifts = estimateShifts(refG, renG, grid, region).filter((s) => s.mae < cur - LOCAL_EPS);
  const stepX = canvas.w / grid, stepY = canvas.h / grid;
  const hugeArea = (leaf.box.w * leaf.box.h) / (canvas.w * canvas.h) >= HUGE_AREA;

  // shape/card fill re-sample: nudge the fill's luminance toward the reference's regional mean
  if (!isMedia(leaf) && leaf.type !== 'text') {
    const rgb = parseHex(leaf.style?.background);
    if (rgb) {
      const tight = cellsForBox(leaf.box, canvas, grid, 0);
      const means = regionMeans(refG, renG, grid, tight);
      if (Math.abs(means.ref - means.ren) >= 0.03 && means.ren > 0.01) {
        const factor = clamp(means.ref / means.ren, 0.5, 2.0);
        const next = toHex(rgb.map((c) => c * factor));
        if (next !== toHex(rgb)) out.push(colorCandidate(toHex(rgb), next));
      }
    }
  }

  // geometry nudges — coarse (1 cell) then fine (half cell) in the best predicted direction,
  // plus the second-best direction coarse. Huge (≈full-canvas) layers are never nudged.
  if (!hugeArea) {
    if (shifts[0]) {
      out.push(shiftCandidate(shifts[0].dx * stepX, shifts[0].dy * stepY, canvas));
      out.push(shiftCandidate(shifts[0].dx * stepX * 0.5, shifts[0].dy * stepY * 0.5, canvas));
    }
    if (leaf.type === 'text' && Number.isFinite(Number(leaf.style?.fontSize))) {
      out.push(fontCandidate(1.08));
      out.push(fontCandidate(0.92));
    }
    if (shifts[1]) out.push(shiftCandidate(shifts[1].dx * stepX, shifts[1].dy * stepY, canvas));
  }
  return out.slice(0, max);
}

// ── the loop ────────────────────────────────────────────────────────────────────────────────────

/**
 * Iteratively refine `doc` against the reference PNG. Deterministic — no model calls.
 * See module header for the contract. Never throws; returns { ok:false, error } on hard failures.
 */
export async function refineLoop(doc, referencePngPath, {
  maxRounds = 3,
  renderFn,
  scoreFn,
  grid = GRID,
  topLayers = TOP_LAYERS,
  maxVariantsPerLayer = MAX_VARIANTS,
  maxRenders = MAX_RENDERS,
  wallMsBudget = WALL_MS,
  worstK = WORST_K,
  minCellDiff = MIN_CELL_DIFF,
  initialRenderPath = null, // reuse an existing render of `doc` (saves one render)
  initialScore = null,      // its global score, if already computed
  keepRenderPath = null,    // where to persist the winning render (default: alongside a render)
  log = () => {},
} = {}) {
  const t0 = Date.now();
  const fail = (error) => ({
    ok: false, rounds: 0, applied: [], scoreBefore: initialScore, scoreAfter: initialScore,
    keptDoc: structuredClone(doc), renders: 0, capped: false, ms: Date.now() - t0,
    bestRenderPath: null, error,
  });
  if (typeof renderFn !== 'function' || typeof scoreFn !== 'function') return fail('renderFn and scoreFn are required');
  if (!doc || !doc.canvas || !Array.isArray(doc.layers)) return fail('doc missing canvas/layers');
  const canvas = { w: Number(doc.canvas.w) || 1080, h: Number(doc.canvas.h) || 1080 };

  const refG = gridOf(referencePngPath, grid);
  if (!refG) return fail(`could not decode reference ${referencePngPath}`);

  let renders = 0;
  let capped = false;
  const overBudget = () => {
    if (renders >= maxRenders) { capped = 'renders'; return true; }
    if (Date.now() - t0 >= wallMsBudget) { capped = 'time'; return true; }
    return false;
  };
  const render = async (d) => { renders++; return await renderFn(d); };

  // base render + score (reuse the caller's first render when provided)
  let curPath = initialRenderPath && existsSync(initialRenderPath) ? initialRenderPath : null;
  if (!curPath) {
    if (overBudget()) return fail('budget exhausted before base render');
    curPath = await render(doc);
    if (!curPath || !existsSync(curPath)) return fail('base render failed');
  }
  let curG = gridOf(curPath, grid);
  if (!curG) return fail('could not decode base render');
  const scoreBefore = initialScore != null ? initialScore : await scoreFn(curPath);
  if (scoreBefore == null) return fail('base score failed');

  const keptPath = keepRenderPath || `${curPath}.refine-best.png`;
  const candPath = `${keptPath}.cand`;

  let keptDoc = structuredClone(doc);
  let keptScore = scoreBefore;
  let keptG = curG;
  let anyRoundKept = false;
  const applied = [];
  let rounds = 0;

  for (let round = 1; round <= maxRounds; round++) {
    rounds = round;
    // working state for this round (revert target = last kept round)
    const workDoc = structuredClone(keptDoc);
    let workG = keptG;
    let workScore = keptScore;
    const roundApplied = [];

    // 1. worst cells of the CURRENT render vs the reference
    const worst = worstCells(refG, workG, grid, worstK, minCellDiff);
    if (!worst.length) { log(`refine r${round}: no cells above ${minCellDiff} — done`); break; }

    // 2. rank offender layers by how much worst-cell error their box covers
    let globalMae = 0;
    for (let i = 0; i < refG.length; i++) globalMae += Math.abs(refG[i] - workG[i]);
    globalMae /= refG.length;
    const allLeaves = leavesOf(workDoc.layers);
    const ranked = allLeaves
      .map((leaf, idx) => ({ leaf, idx }))
      .filter((e) => validBox(e.leaf.box))
      .map(({ leaf, idx }) => {
        const r = cellsForBox(leaf.box, canvas, grid, 1);
        let cover = 0;
        for (const c of worst) if (c.gx >= r.x0 && c.gx <= r.x1 && c.gy >= r.y0 && c.gy <= r.y1) cover += c.d;
        return { leaf, idx, cover };
      })
      .filter((e) => e.cover > 0)
      // ≈full-canvas layers only stay in play when the WHOLE canvas is off (their color is wrong)
      .filter((e) => (e.leaf.box.w * e.leaf.box.h) / (canvas.w * canvas.h) < HUGE_AREA || globalMae >= 0.10)
      .sort((a, b) => b.cover - a.cover)
      .slice(0, topLayers);
    if (!ranked.length) { log(`refine r${round}: no layer covers the worst cells — done`); break; }

    // 3. per offender: render each candidate once, keep the best LOCAL improvement
    let roundBudgetHit = false;
    for (const { leaf, idx } of ranked) {
      const cands = candidatesFor(leaf, { refG, renG: workG, grid, canvas, max: maxVariantsPerLayer });
      if (!cands.length) continue;
      const beforeRegion = cellsForBox(leaf.box, canvas, grid, 1);
      let best = null;
      for (const cand of cands) {
        if (overBudget()) { roundBudgetHit = true; break; }
        const variantDoc = structuredClone(workDoc);
        // same traversal order as `allLeaves` (structuredClone preserves structure) — index-safe
        // even when layers carry no ids
        const variantLeaf = leavesOf(variantDoc.layers)[idx];
        if (!variantLeaf || (leaf.id != null && variantLeaf.id !== leaf.id)) break;
        cand.apply(variantLeaf);
        const p = await render(variantDoc);
        if (!p || !existsSync(p)) continue;
        const g = gridOf(p, grid);
        if (!g) continue;
        const s = await scoreFn(p); // score NOW — render files are reused/overwritten by renderFn
        const region = unionRect(beforeRegion, cellsForBox(variantLeaf.box, canvas, grid, 1));
        const before = localMae(refG, workG, grid, region);
        const after = localMae(refG, g, grid, region);
        if (after < before - LOCAL_EPS && (!best || after < best.after)) {
          best = { cand, after, before, g, s, doc: variantDoc };
          try { copyFileSync(p, candPath); } catch { /* keep going — grid/score already captured */ }
        }
      }
      if (best) {
        // adopt the winning variant as the new working state (its render IS the working doc render)
        workDoc.layers = best.doc.layers;
        workG = best.g;
        if (best.s != null) workScore = best.s;
        roundApplied.push({
          round, layerId: leaf.id, layerName: leaf.name || leaf.role || leaf.type,
          kind: best.cand.kind, detail: best.cand.describe(),
          localMae: { before: Math.round(best.before * 1000) / 1000, after: Math.round(best.after * 1000) / 1000 },
        });
        log(`refine r${round}: ${leaf.id} ${best.cand.describe()} (local ${best.before.toFixed(3)}→${best.after.toFixed(3)})`);
      }
      if (roundBudgetHit) break;
    }

    if (!roundApplied.length) { log(`refine r${round}: no candidate improved locally — done`); break; }

    // 4. keep the round ONLY if the global score improved
    if (workScore > keptScore + GLOBAL_EPS) {
      keptDoc = workDoc;
      keptScore = workScore;
      keptG = workG;
      anyRoundKept = true;
      applied.push(...roundApplied);
      try { copyFileSync(candPath, keptPath); } catch { /* best-effort */ }
      log(`refine r${round}: KEPT — score ${keptScore}`);
    } else {
      log(`refine r${round}: reverted (score ${workScore} ≤ ${keptScore}) — done`);
      break;
    }
    if (capped) { log(`refine: budget capped (${capped}) after ${renders} renders / ${Date.now() - t0}ms`); break; }
  }

  try { rmSync(candPath, { force: true }); } catch { /* best-effort */ }
  if (capped) log(`refine: CAPPED by ${capped} (${renders} renders, ${Date.now() - t0}ms)`);
  return {
    ok: true, rounds, applied,
    scoreBefore, scoreAfter: keptScore,
    keptDoc, renders, capped,
    ms: Date.now() - t0,
    bestRenderPath: anyRoundKept && existsSync(keptPath) ? keptPath : null,
    error: null,
  };
}
