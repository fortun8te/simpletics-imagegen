#!/usr/bin/env node
// scripts/native-ui-loop.mjs — CLI runner for the SELF-IMPROVEMENT LOOP (lib/native-ui-loop.mjs).
//
// Generates/copies a native-UI ad, RENDERS it, VISION-COMPARES it to a target reference, FIXES
// the discrepancies, re-renders, re-checks, and REPEATS until the render passes a fidelity bar or
// converges — printing the per-iteration fidelity score + verdict as it goes, and saving the seed
// render, the final render, and the final doc.
//
// Usage:
//   node scripts/native-ui-loop.mjs --ref <image> [--archetype x-post] [--maxIters 5] [--threshold 90]
//                                    [--patience 2] [--generate] [--brief "..."] [--out <dir>]
//
// Requires Ornith loaded at :1234 (VISION_BASE_URL in studio/.env) for a real run; without a
// reachable endpoint the loop still runs but scores degrade to the pixel-diff-only signal.

import { existsSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { join, dirname, basename, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { runSelfImproveLoop } from '../lib/native-ui-loop.mjs';
import { renderCompPng } from '../lib/self-vision.mjs';
import { hasLlm, llmInfo } from '../lib/llm.mjs';

const STUDIO = join(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

/** Resolve a reference path that may be relative, ~-prefixed, or a bare basename in the inspo dir. */
function resolveRef(ref) {
  if (!ref || ref === true) return null;
  let p = String(ref);
  if (p.startsWith('~/')) p = join(homedir(), p.slice(2));
  if (isAbsolute(p) && existsSync(p)) return p;
  const rel = resolve(process.cwd(), p);
  if (existsSync(rel)) return rel;
  const inspo = join(homedir(), 'Downloads', 'IMAGE AD INSPO', p);
  if (existsSync(inspo)) return inspo;
  return existsSync(p) ? p : null;
}

const BAR = (score, width = 24) => {
  const n = Math.max(0, Math.min(width, Math.round((Number(score) || 0) / 100 * width)));
  return '█'.repeat(n) + '·'.repeat(width - n);
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const referencePath = resolveRef(args.ref);
  if (!referencePath) {
    console.error('usage: node scripts/native-ui-loop.mjs --ref <image> [--archetype x-post] [--maxIters 5] [--threshold 90]');
    console.error(args.ref ? `  reference not found: ${args.ref}` : '  --ref is required');
    process.exit(2);
  }

  const archetype = typeof args.archetype === 'string' ? args.archetype : null;
  const maxIters = args.maxIters ? Number(args.maxIters) : 5;
  const threshold = args.threshold ? Number(args.threshold) : 90;
  const patience = args.patience ? Number(args.patience) : 2;
  const brief = typeof args.brief === 'string' ? args.brief : null;
  const copyReference = !args.generate;
  const outDir = typeof args.out === 'string' ? args.out : join(STUDIO, '.state', 'native-ui-loop');
  mkdirSync(outDir, { recursive: true });

  // Fix-agent tuning: bound each fix round so a slow local model converges in reasonable wall-clock.
  // --fixMaxApplied N caps ops/round (default 5); --fixVision keeps the agent's own vision self-check
  // ON (default OFF — the loop already does its own render+vision score every round, so the agent's
  // extra self-check is redundant latency here).
  const agentOpts = {
    maxApplied: args.fixMaxApplied ? Number(args.fixMaxApplied) : 5,
    mainTurnVision: !!args.fixVision,
  };

  // --seed <file.json>: start from an existing doc (skips the copy-reference/generate seed step).
  let seedDoc = null;
  if (typeof args.seed === 'string') {
    try {
      const { readFileSync } = await import('node:fs');
      seedDoc = JSON.parse(readFileSync(args.seed, 'utf8'));
    } catch (e) { console.error(`--seed: could not read ${args.seed}: ${e.message}`); process.exit(2); }
  }

  const info = llmInfo();
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(' SELF-IMPROVEMENT LOOP — render → vision-compare → fix → repeat');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(` reference : ${basename(referencePath)}`);
  console.log(` archetype : ${archetype || '(none / auto)'}`);
  console.log(` seed      : ${seedDoc ? `provided (${basename(args.seed)}, ${(seedDoc.layers || []).length} layers)` : copyReference ? 'copy-reference' : 'generate'}`);
  console.log(` budget    : maxIters=${maxIters}  threshold=${threshold}  patience=${patience}`);
  console.log(` endpoint  : ${info.model || '(none)'} @ ${info.base}  ${hasLlm() ? '' : '(NO LLM — pixel-diff only)'}`);
  console.log('');

  const t0 = Date.now();
  const result = await runSelfImproveLoop({
    referencePath, archetype, brief, copyReference, maxIters, threshold, patience, seedDoc, agentOpts,
    onEvent: (e) => {
      if (e.type === 'seed:start') console.log(`  seed: ${e.mode} …`);
      else if (e.type === 'seed:done') console.log(`  seed: applied ${e.applied ?? '?'} ops (source ${e.source ?? '?'})\n`);
      else if (e.type === 'seed:error') console.log(`  seed: ERROR ${e.error}\n`);
      else if (e.type === 'iter:score') {
        console.log(`  ── round ${e.round}/${e.of} ──────────────────────────────────`);
        console.log(`  fidelity ${String(e.score).padStart(5)} /100  [${BAR(e.score)}]`
          + (e.vision != null ? `  vision ${e.vision}` : '')
          + (e.pixel != null ? `  pixel ${e.pixel}` : ''));
        if (e.error) console.log(`  (score note: ${e.error})`);
        for (const d of (e.discrepancies || [])) console.log(`    · ${d}`);
      } else if (e.type === 'iter:applied') console.log(`  fix: applied ${e.applied ?? '?'} ops → re-scoring`);
      else if (e.type === 'iter:error') console.log(`  fix: ERROR ${e.error}`);
      else if (e.type === 'iter:done' && e.verdict && e.verdict !== 'continue') console.log(`  → ${e.verdict.toUpperCase()}`);
    },
  });

  // ── save seed vs final renders + the final doc ────────────────────────────────────────────────
  const stamp = basename(referencePath).replace(/\.[^.]+$/, '').replace(/[^\w-]+/g, '-').slice(0, 40);
  const finalPng = renderCompPng(result.bestDoc);
  const finalOut = join(outDir, `${stamp}.final.png`);
  const docOut = join(outDir, `${stamp}.final.doc.json`);
  const refOut = join(outDir, `${stamp}.reference.png`);
  try { if (finalPng) copyFileSync(finalPng, finalOut); } catch { /* best-effort */ }
  try { copyFileSync(referencePath, refOut); } catch { /* ref may be jpg — best-effort */ }
  try { writeFileSync(docOut, JSON.stringify(result.bestDoc, null, 2)); } catch { /* best-effort */ }
  // the seed render is the PNG scored in round 1 (self-vision left it on disk)
  const seedPng = result.iterations[0] && result.iterations[0].png;
  const seedOut = join(outDir, `${stamp}.seed.png`);
  try { if (seedPng && existsSync(seedPng)) copyFileSync(seedPng, seedOut); } catch { /* best-effort */ }

  // ── trajectory summary ────────────────────────────────────────────────────────────────────────
  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  const traj = result.iterations.map((it) => it.score).join(' → ');
  console.log(` VERDICT     : ${result.verdict.toUpperCase()}`);
  console.log(` TRAJECTORY  : ${traj}${result.verdict === 'pass' ? '  → PASS' : ''}`);
  console.log(` seed score  : ${result.seedScore}`);
  console.log(` best score  : ${result.bestScore}`);
  console.log(` improvement : ${(result.bestScore - result.seedScore >= 0 ? '+' : '')}${(result.bestScore - result.seedScore).toFixed(1)} over ${result.iterations.length} round(s)`);
  console.log(` elapsed     : ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log('');
  console.log(' artifacts:');
  console.log(`   reference : ${refOut}`);
  if (existsSync(seedOut)) console.log(`   seed png  : ${seedOut}`);
  console.log(`   final png : ${finalOut}`);
  console.log(`   final doc : ${docOut}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  process.exit(result.verdict === 'seed-failed' ? 1 : 0);
}

main().catch((err) => { console.error('loop crashed:', err); process.exit(1); });
