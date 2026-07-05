// lib/native-ui-loop.mjs — the SELF-IMPROVEMENT LOOP engine.
//
// Autonomous "make the render actually match the target" loop the owner keeps asking for. It
// wires together building blocks that already exist — it does NOT reinvent them:
//   • lib/design-agent.mjs   runDesignAgent(...)  — seed (copy-reference) + apply fixes
//   • lib/self-vision.mjs     scoreFidelity(doc, ref) — render → vision-compare + pixel-diff → {score, corrections}
//   • scripts/pixel-diff.mjs  (through scoreFidelity) — objective secondary signal
//
// The shape (runSelfImproveLoop):
//   1. SEED    — copy the reference (or generate) → initial doc.
//   2. ITERATE up to maxIters:
//        a. render + score the doc vs the reference → { score, discrepancies[] }.
//        b. log iteration i (structured progress → streams to the UI activity feed later).
//        c. score ≥ threshold → PASS, stop.
//        d. no improvement for `patience` consecutive rounds → CONVERGED, stop.
//        e. else turn the discrepancies into concrete fix instructions → one agent run → new doc.
//   3. RETURN the BEST-scoring doc (not necessarily the last) + score + per-iteration history.
//
// Context safety: every fix iteration is a FRESH runDesignAgent run fed a COMPACT observation
// (the top few discrepancies only — never the accumulated history), so it stays far under
// Ornith's ~60k window. Robustness: a failed render / compare / agent run in ANY iteration is
// caught and the loop keeps the best doc so far — one bad round never crashes the whole run.
//
// Ornith-only: this module never names a model. It calls runDesignAgent / scoreFidelity, which
// route to whatever the endpoint has loaded.

import { basename } from 'node:path';
import { runDesignAgent } from './design-agent.mjs';
import { scoreFidelity } from './self-vision.mjs';

// COPY_IMPROVE_PASSES lets a faster backend (a remote vision model) afford more scoring rounds
// than slow local ornith could — clamped to a sane ceiling so a typo (e.g. "500") can't turn one
// copy into an unbounded loop of vision calls.
const envPasses = Number(process.env.COPY_IMPROVE_PASSES);
const maxItersDefault = envPasses > 0 ? Math.min(20, Math.floor(envPasses)) : 5;

const DEFAULTS = {
  maxIters: maxItersDefault, // total scoring rounds (seed counts as round 1)
  threshold: 90,    // fidelity score that counts as a PASS
  patience: 2,      // stop after this many consecutive non-improving rounds
  minGain: 1.0,     // a round must beat the best-so-far by at least this to reset patience
};

/** Turn structured vision discrepancies into ONE compact, concrete instruction for the design
 *  agent. Deliberately small (top 4) so the fix run's observation stays tiny — we never feed the
 *  agent the running history, only "here is what's still wrong, fix exactly this". */
export function discrepanciesToInstruction(corrections, { score, archetype } = {}) {
  const top = (Array.isArray(corrections) ? corrections : []).slice(0, 4);
  if (!top.length) {
    // No specific vision deltas this round. At HIGH scores the old generic "run autolayout" advice
    // was useless — the judge thought it was nearly done but wouldn't say why, so the loop churned
    // non-actionable rounds until patience expired (AI-11). Near the top of the range, force a
    // LOOK-driven single-delta pass instead: the agent renders, compares, and fixes the ONE most
    // important remaining difference with maximum precision.
    if (typeof score === 'number' && score >= 85) {
      return `The render scores ${score}/100 — very close to the reference${archetype ? ` (${archetype})` : ''} but not a pass. Use {"op":"look"} to see the current render, identify the SINGLE most important remaining visual difference vs the reference (a text color, an exact spacing, one element's size, the background shade), state it precisely in your plan, and fix EXACTLY that one thing. Do not touch anything else.`;
    }
    // Lower scores: fall back to a concrete legibility/fit pass the agent can always act on —
    // targets the most common seed defect (oversized/clipped text) without needing the judge to
    // enumerate it.
    return `The render is close (fidelity ${score ?? '?'} /100) but not a pass yet. Run autolayout so no text overflows or clips off the canvas edges, then bring any oversized type down to a legible size and ensure strong contrast, matching the reference's proportions.`;
  }
  const lines = top.map((c, i) => {
    const layer = c.layer ? `${c.layer}: ` : '';
    const fix = c.fix ? ` → ${c.fix}` : '';
    return `${i + 1}. ${layer}${c.problem}${fix}`;
  });
  return [
    `This render currently scores ${score ?? '?'} /100 fidelity against the reference${archetype ? ` (${archetype})` : ''}.`,
    'Fix ONLY these specific visual discrepancies to make it match the reference more closely, then finish:',
    ...lines,
    'Do not change the copy wording. Adjust position, size, color, spacing and hierarchy only.',
  ].join('\n');
}

/** Best-effort fidelity score for a doc; a thrown/failed compare degrades to a zero score with
 *  the error captured rather than crashing the loop. */
async function safeScore(scorer, doc, referencePath, opts) {
  try {
    const r = await scorer(doc, referencePath, opts);
    return r && typeof r.score === 'number'
      ? r
      : { ok: false, score: 0, vision: null, pixel: null, corrections: [], notes: null, png: null, error: (r && r.error) || 'score unavailable' };
  } catch (err) {
    return { ok: false, score: 0, vision: null, pixel: null, corrections: [], notes: null, png: null, error: String(err && err.message || err) };
  }
}

/** A minimal blank doc for the copy-reference seed. runCopyReference locks the canvas to the
 *  reference's real aspect, so the placeholder size here is unimportant. */
function seedDocFor(referencePath) {
  const id = `loop_${Date.now().toString(36)}`;
  const canvas = { w: 1080, h: 1350 };
  return {
    id,
    name: `self-improve · ${basename(referencePath)}`,
    canvas,
    layers: [
      { id: 'base-1', type: 'image', role: 'base', name: 'Base', box: { x: 0, y: 0, w: canvas.w, h: canvas.h }, src: '/img?path=placeholder.png' },
    ],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    schemaVersion: 3,
  };
}

/**
 * Run the self-improvement loop against a reference image.
 *
 * @param {object}   o
 * @param {string}   o.referencePath        absolute path to the target reference image (required)
 * @param {object}  [o.seedDoc]             an existing doc to start from (skips copy-reference seed)
 * @param {string}  [o.archetype]           archetype hint (e.g. 'x-post') — used for copy label + fix prompt
 * @param {string}  [o.brief]               brief text passed through to the agent
 * @param {boolean} [o.copyReference=true]  seed by COPYING the reference (vs generating from brief)
 * @param {number}  [o.maxIters=5]          max scoring rounds
 * @param {number}  [o.threshold=90]        PASS score
 * @param {number}  [o.patience=2]          consecutive non-improving rounds → CONVERGED
 * @param {object}  [o.agentOpts]           extra opts forwarded to runDesignAgent
 * @param {function}[o.onEvent]             structured progress sink (see EVENT shapes below)
 * @param {AbortSignal}[o.signal]
 * @param {function}[o.agent]               injectable runDesignAgent (defaults to the real one)
 * @param {function}[o.scorer]              injectable scoreFidelity (defaults to the real one)
 *
 * @returns {Promise<{ ok, verdict, bestDoc, bestScore, seedScore, iterations, referencePath, error }>}
 *   verdict ∈ 'pass' | 'converged' | 'exhausted' | 'seed-failed'
 *   iterations: [{ i, score, vision, pixel, discrepancies, instruction?, applied?, verdict?, error? }]
 */
export async function runSelfImproveLoop(o = {}) {
  const {
    referencePath,
    seedDoc = null,
    archetype = null,
    brief = null,
    copyReference = true,
    agentOpts = {},
    onEvent = () => {},
    signal = null,
    // dependency seams (default to the real building blocks) — let tests drive the control flow
    // deterministically without an LLM/render, and let the app swap in its own instrumented calls.
    agent = runDesignAgent,
    scorer = scoreFidelity,
  } = o;
  const maxIters = Number(o.maxIters) > 0 ? Math.floor(Number(o.maxIters)) : DEFAULTS.maxIters;
  const threshold = Number.isFinite(Number(o.threshold)) ? Number(o.threshold) : DEFAULTS.threshold;
  const patience = Number(o.patience) > 0 ? Math.floor(Number(o.patience)) : DEFAULTS.patience;

  const emit = (type, data) => { try { onEvent({ type, at: Date.now(), ...data }); } catch { /* sink must never break the loop */ } };

  if (!referencePath) {
    return { ok: false, verdict: 'seed-failed', bestDoc: null, bestScore: 0, seedScore: 0, iterations: [], referencePath, error: 'referencePath is required' };
  }

  // ── 1. SEED ─────────────────────────────────────────────────────────────────────────────────
  emit('seed:start', { referencePath, archetype, mode: seedDoc ? 'provided' : copyReference ? 'copy-reference' : 'generate' });
  let doc = seedDoc ? JSON.parse(JSON.stringify(seedDoc)) : seedDocFor(referencePath);
  if (!seedDoc) {
    try {
      const seedOut = copyReference
        ? await agent(doc, 'Copy this reference exactly.', () => {}, {
          ...agentOpts,
          reference: { path: referencePath, label: archetype || basename(referencePath) },
          brief: brief || undefined,
          signal,
        })
        : await agent(doc, brief || 'Generate this native-UI ad.', () => {}, {
          ...agentOpts, mode: 'generate', brief: brief || undefined, signal,
        });
      if (seedOut && seedOut.doc) doc = seedOut.doc;
      emit('seed:done', { applied: seedOut && seedOut.applied, source: seedOut && seedOut.source, layoutScore: seedOut && seedOut.layoutScore });
    } catch (err) {
      // A failed seed is not fatal — we can still score/fix the blank/placeholder doc — but flag it.
      emit('seed:error', { error: String(err && err.message || err) });
    }
  }

  // ── 2. ITERATE ──────────────────────────────────────────────────────────────────────────────
  const iterations = [];
  let best = { doc: JSON.parse(JSON.stringify(doc)), score: -1 };
  let seedScore = 0;
  let stale = 0; // consecutive rounds without a real gain over best

  for (let i = 1; i <= maxIters; i++) {
    if (signal && signal.aborted) { emit('aborted', { round: i }); break; }

    // a+b. render + score + log
    const scored = await safeScore(scorer, doc, referencePath, {});
    const rec = {
      i,
      score: scored.score,
      vision: scored.vision,
      pixel: scored.pixel,
      match: !!scored.match,
      discrepancies: scored.corrections || [],
      png: scored.png || null,
      error: scored.error || null,
    };
    if (i === 1) seedScore = scored.score;
    emit('iter:score', {
      round: i, of: maxIters, score: scored.score, vision: scored.vision, pixel: scored.pixel,
      discrepancies: (scored.corrections || []).map((c) => `${c.layer ? c.layer + ': ' : ''}${c.problem}`).slice(0, 4),
      error: scored.error || null,
    });

    // convergence is measured against the PREVIOUS best — capture it BEFORE we fold this round in.
    const prevBest = best.score;

    // track best-so-far (keep a deep copy so later mutating rounds can't corrupt it)
    if (scored.score > best.score) {
      best = { doc: JSON.parse(JSON.stringify(doc)), score: scored.score };
    }

    // c. PASS?
    if (scored.score >= threshold) {
      rec.verdict = 'pass';
      iterations.push(rec);
      emit('iter:done', { round: i, verdict: 'pass', score: scored.score });
      emit('loop:done', { verdict: 'pass', bestScore: best.score, rounds: i, seedScore });
      return { ok: true, verdict: 'pass', bestDoc: best.doc, bestScore: best.score, seedScore, iterations, referencePath, error: null };
    }

    // d. convergence — no meaningful improvement over the prior best for `patience` rounds in a row
    const gain = i === 1 ? Infinity : scored.score - prevBest;
    if (i > 1) {
      if (gain < DEFAULTS.minGain) stale += 1; else stale = 0;
    }
    if (stale >= patience) {
      rec.verdict = 'converged';
      iterations.push(rec);
      emit('iter:done', { round: i, verdict: 'converged', score: scored.score, stale });
      emit('loop:done', { verdict: 'converged', bestScore: best.score, rounds: i, seedScore });
      return { ok: true, verdict: 'converged', bestDoc: best.doc, bestScore: best.score, seedScore, iterations, referencePath, error: null };
    }

    // Last round: nothing left to fix into — stop after scoring (don't waste an agent run).
    if (i === maxIters) {
      rec.verdict = 'exhausted';
      iterations.push(rec);
      emit('iter:done', { round: i, verdict: 'exhausted', score: scored.score });
      break;
    }

    // e. turn discrepancies → concrete fixes → ONE fresh agent run (compact observation).
    const instruction = discrepanciesToInstruction(scored.corrections, { score: scored.score, archetype });
    rec.instruction = instruction;
    emit('iter:fix', { round: i, instruction });
    try {
      const fixOut = await agent(doc, instruction, () => {}, {
        ...agentOpts,
        // The reference stays available so the fix run can SEE the target it's matching to.
        reference: undefined, // fixes are edits on the existing doc, not a re-copy
        brief: brief || undefined,
        signal,
      });
      if (fixOut && fixOut.doc) doc = fixOut.doc;
      rec.applied = fixOut && fixOut.applied;
      emit('iter:applied', { round: i, applied: fixOut && fixOut.applied, source: fixOut && fixOut.source });
    } catch (err) {
      // A failed fix round doesn't crash the loop: keep the current doc, let the next round re-score.
      rec.error = String(err && err.message || err);
      emit('iter:error', { round: i, error: rec.error });
    }
    iterations.push(rec);
    emit('iter:done', { round: i, verdict: 'continue', score: scored.score });
  }

  const verdict = 'exhausted';
  emit('loop:done', { verdict, bestScore: best.score, rounds: iterations.length, seedScore });
  return {
    ok: best.score >= 0,
    verdict,
    bestDoc: best.doc,
    bestScore: best.score,
    seedScore,
    iterations,
    referencePath,
    error: null,
  };
}
