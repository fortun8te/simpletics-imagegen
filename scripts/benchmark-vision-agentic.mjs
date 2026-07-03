#!/usr/bin/env node
// scripts/benchmark-vision-agentic.mjs — ornith-9b vs gemma-4-12b, vision + agentic benchmark.
//
// CONSTRAINT this script is built around: Michael's LM Studio host ("degitaar", reachable via
// VISION_BASE_URL in studio/.env) can only have ONE model loaded at a time, and there is no API
// to force a remote model swap. So this script:
//   1. Detects whichever model is CURRENTLY loaded (GET {VISION_BASE_URL}/../api/v0/models,
//      which — unlike the plain OpenAI-compatible /models list — reports real `state:
//      "loaded"|"not-loaded"` per model; see probeLoadedModel() below).
//   2. Runs the FULL suite (vision + agentic) against that one loaded model, tagging every
//      result file with its model id.
//   3. Looks for a result file from the OTHER target model (ornith vs gemma) on disk. If found,
//      prints a side-by-side comparison. If not, it prints (loudly, to stdout) exactly what
//      Michael needs to do next: load the other model in LM Studio and re-run this script.
//
// Usage:  node scripts/benchmark-vision-agentic.mjs
// Deps:   none beyond node:* + studio/lib/llm.mjs (llmText, llmVision — read-only reuse).
// Output: studio/.state/benchmark-results/<model-id>-<category>.json (vision | agentic)
//
// ── SCORING RUBRIC (0-5 per task, assigned by this script, documented here for auditability) ──
// VISION tasks (extract a layout-JSON read of a real ad image):
//   0 — no usable output (empty / network error / totally unparsable text)
//   1 — text returned but JSON does not parse at all
//   2 — JSON parses but has no `layers` array, or an empty one
//   3 — JSON parses, has a `layers` array with >=1 real layer (non-empty text/box), but misses
//       obviously major elements (e.g. <40% of a rough expected-layer-count heuristic) or most
//       layers lack real box/text data
//   4 — JSON parses, layers array is substantive (>=40% of expected-layer-count heuristic) with
//       real text/box data on most layers, background + archetype present
//   5 — as 4, AND layer count is close to (>=70% of) the expected-layer-count heuristic, boxes
//       are well-formed (0-100 range, non-degenerate w/h), and the exact-text rule is respected
//       (at least one layer's text matches a substring we know is in the image, where checkable)
// The "expected-layer-count heuristic" is a hand-set rough completeness proxy per image (not
// ground truth — just "how many distinct visual elements a careful human would list"), declared
// per task below. This is a fair, consistent, but approximate judge — not a certified rubric.
//
// AGENTIC tasks (return structured edit-ops matching design-agent.mjs's op-grammar):
//   0 — no usable output
//   1 — text returned but no JSON array found at all
//   2 — a JSON array parses but zero elements are valid ops (wrong shape / unknown `op` field)
//   3 — some valid ops (>=1) but the plan is incomplete/inconsistent with the stated goal, or
//       most ops are invalid/malformed
//   4 — most/all ops are valid AND collectively address the stated goal (e.g. a contrast fix
//       actually changes colors on the flagged layer, not unrelated ones)
//   5 — as 4, AND the plan is minimal/coherent (no redundant/contradictory ops, targets the
//       right ids, plausible values) — a genuinely usable agent turn.
// Valid op shapes (mirrors lib/design-agent.mjs's grammar):
//   {op:"move",id,x,y} {op:"resize",id,w,h} {op:"setText",id,text}
//   {op:"setStyle",id,style:{...}} {op:"remove",id}

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { llmText, llmVision } from '../studio/lib/llm.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STUDIO = join(ROOT, 'studio');
const RESULTS_DIR = join(STUDIO, '.state', 'benchmark-results');
mkdirSync(RESULTS_DIR, { recursive: true });

const IMAGE_DIR = join(process.env.HOME || '', 'Downloads', 'IMAGE AD INSPO');
const VISION_BASE = (process.env.VISION_BASE_URL || 'http://localhost:1234/v1').replace(/\/$/, '');
// api/v0 sits alongside /v1 on the same LM Studio server — strip a trailing /v1 to get the host root.
const LMSTUDIO_HOST = VISION_BASE.replace(/\/v1$/, '');

// The two models Michael wants compared. Substring-matched against whatever LM Studio reports,
// so "ornith-1.0-9b" / "ornith-1.0-9b-mtp" / etc. all count as "ornith", and any "gemma-4-12b"
// variant counts as the new 12b Gemma (explicitly NOT the smaller gemma-4-e4b).
const TARGETS = {
  ornith: (id) => /ornith/i.test(id),
  'gemma-12b': (id) => /gemma-4-12b/i.test(id), // the NEW 12b — distinct from gemma-4-e4b
};

function log(msg) { console.log(msg); }

// ── Detect the currently LOADED model via LM Studio's /api/v0/models (reports state per model;
// the plain OpenAI-compatible /v1/models endpoint lists all downloaded models regardless of
// load state, so it cannot answer "what's loaded right now"). Falls back to VISION_MODEL from
// .env + a live probe if /api/v0 isn't available (e.g. a non-LM-Studio OpenAI-compatible server).
async function probeLoadedModel() {
  try {
    const res = await fetch(`${LMSTUDIO_HOST}/api/v0/models`, { signal: AbortSignal.timeout(4000) });
    if (res.ok) {
      const j = await res.json();
      const all = Array.isArray(j?.data) ? j.data : [];
      const loaded = all.filter((m) => m.state === 'loaded' && m.type !== 'embeddings');
      if (loaded.length) return { ids: loaded.map((m) => m.id), all };
    }
  } catch { /* not LM Studio, or unreachable — fall through */ }
  // Fallback: the plain /models list + configured VISION_MODEL as a best guess.
  try {
    const res = await fetch(`${VISION_BASE}/models`, { signal: AbortSignal.timeout(4000) });
    const j = await res.json();
    const ids = Array.isArray(j?.data) ? j.data.map((m) => m.id) : [];
    const preferred = process.env.VISION_MODEL;
    if (preferred && ids.includes(preferred)) return { ids: [preferred], all: ids.map((id) => ({ id })) };
    return { ids, all: ids.map((id) => ({ id })) };
  } catch (e) {
    return { ids: [], all: [], error: String(e?.message || e) };
  }
}

/** Which of TARGETS (if any) match the loaded ids. Picks the first match if multiple loaded. */
function classifyLoaded(ids) {
  for (const [name, test] of Object.entries(TARGETS)) {
    const hit = ids.find(test);
    if (hit) return { target: name, modelId: hit };
  }
  return { target: null, modelId: ids[0] || null };
}

// ── VISION TASKS ──────────────────────────────────────────────────────────────────────────────
// Reuses the real extraction prompt shape from studio/lib/layout-extract.mjs (PROMPT const),
// trimmed slightly (no refine pass, no MAX_LAYERS templating) since this is a benchmark read,
// not the production multi-pass pipeline.
const LAYOUT_PROMPT = `You digitize a social-media ad into JSON. Be exact and literal — no invention.

Capture EVERY element back-to-front (paint order: backgrounds/panels first, text last):
text blocks, badges/chips, buttons, cards/panels, background regions, gradient scrims, and each
photo/product region as type "image" with a 2-4 word label. Skip only platform chrome (app nav,
like/comment bars outside the ad).

Rules:
1. TEXT: copy the EXACT visible characters, including numbers/prices verbatim.
2. COLORS: give real #hex sampled AT that element (text color = glyph pixel; background = fill
   behind it). Don't default to #ffffff/#000000 unless it truly is white/black.
3. BACKGROUND: report "backgroundKind" ("solid"|"photo"|"gradient") and "background" (hex/gradient,
   or null for photo).
4. FONT: per text layer report serif(true/false), fontWeight(300-900), and "platform" if it's a
   recognizable UI font (ios/twitter/instagram).
5. ARCHETYPE: pick one of story-native|x-post|before-after|comparison|offer-hero|ig-dm|apple-notes|
   stat-chart|generic.

Reply with ONLY this JSON, no prose:
{"canvasRatio": <h/w>, "archetype": "...", "backgroundKind": "solid|photo|gradient",
 "background": "#hex or null",
 "layers": [{"type":"text|badge|button|shape|image","role":"...","text":"...",
   "box":{"x":<left%>,"y":<top%>,"w":<width%>,"h":<height%>},
   "style":{"color":"#hex","background":"#hex|null","fontSizePct":<num>,"fontWeight":<300-900>,
            "align":"left|center|right","uppercase":<bool>,"serif":<bool>}}]}
All boxes in % of the full image (0-100). Max 18 layers.`;

// expectedLayers: a rough hand-set completeness proxy (NOT ground truth) — see rubric comment above.
const VISION_TASKS = [
  {
    id: 'nutrition-label-text-heavy',
    file: '001_attached_13db963dcf9d6604.png',
    desc: 'Text-heavy product/nutrition-label ad (UPFRONT whey)',
    expectedLayers: 10, // headline, price strikethrough, price, product card, title, subtitle, weight,
                        // ingredients block, nutrition table, brand wordmark
    mustContainText: ['UPFRONT', 'WHEY'],
  },
  {
    id: 'photo-heavy-hero',
    file: '005_attached_23b6641d52f7bdfe.png',
    desc: 'Photo/product-heavy hero ad (chocolate pour + bar)',
    expectedLayers: 7, // big wordmark line1, wordmark line2, 3 bullet lines, product photo, discount, brand
    mustContainText: ['CHOCO', 'KORTING'],
  },
  {
    id: 'long-copy-text-only',
    file: '017_attached_92769a9e1f6a3219.png',
    desc: 'Pure long-form text ad, no imagery except an emoji (Hears earplugs)',
    expectedLayers: 4, // emoji/badge, headline, body copy, signature
    mustContainText: ['COPIED', 'Hears'],
  },
  {
    id: 'x-post-ui-mimic',
    file: '009_attached_885c19be02ccf229.png',
    desc: 'UI-mimicking ad — fake X/Twitter post',
    expectedLayers: 8, // nav, avatar, name, handle, body, views, action row, verified badge
    mustContainText: [],
  },
];

function tryParseJson(text) {
  if (!text) return null;
  const direct = (() => { try { return JSON.parse(text); } catch { return null; } })();
  if (direct) return direct;
  const m = String(text).match(/\{[\s\S]*"layers"[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* fall through */ } }
  return null;
}

function scoreVisionTask(task, parsed, rawText) {
  if (!rawText) return 0;
  if (!parsed) return 1;
  const layers = Array.isArray(parsed.layers) ? parsed.layers : null;
  if (!layers || layers.length === 0) return 2;
  const realLayers = layers.filter((l) => l && l.box && (String(l.text || '').trim() || l.type === 'image'));
  const ratio = realLayers.length / Math.max(1, task.expectedLayers);
  const wellFormed = (l) => {
    const b = l?.box || {};
    return ['x', 'y', 'w', 'h'].every((k) => typeof b[k] === 'number' && b[k] >= 0 && b[k] <= 100) && b.w > 0 && b.h > 0;
  };
  const wellFormedRatio = realLayers.length ? realLayers.filter(wellFormed).length / realLayers.length : 0;
  const hasBg = !!parsed.background || parsed.backgroundKind === 'photo';
  const hasArchetype = !!parsed.archetype;
  const textHit = task.mustContainText.length === 0
    || task.mustContainText.some((t) => layers.some((l) => String(l?.text || '').toUpperCase().includes(t.toUpperCase())));
  if (ratio < 0.4 || wellFormedRatio < 0.5) return 3;
  if (ratio < 0.7 || !hasBg || !hasArchetype) return 4;
  if (wellFormedRatio >= 0.8 && textHit) return 5;
  return 4;
}

async function runVisionTask(task) {
  const imgPath = join(IMAGE_DIR, task.file);
  if (!existsSync(imgPath)) {
    return { id: task.id, ok: false, error: `image not found: ${imgPath}` };
  }
  const started = Date.now();
  const r = await llmVision(LAYOUT_PROMPT, imgPath, { purpose: 'benchmark-vision', timeoutMs: 90_000, maxTokens: 6000 });
  const ms = Date.now() - started;
  const parsed = r.ok ? tryParseJson(r.text) : null;
  const score = scoreVisionTask(task, parsed, r.text);
  const layerCount = Array.isArray(parsed?.layers) ? parsed.layers.length : 0;
  return {
    id: task.id,
    desc: task.desc,
    file: task.file,
    ok: r.ok,
    error: r.error || null,
    latencyMs: ms,
    inTok: r.usage?.inTok || 0,
    outTok: r.usage?.outTok || 0,
    validJson: !!parsed,
    layerCount,
    expectedLayers: task.expectedLayers,
    score,
    archetype: parsed?.archetype || null,
    truncated: !!r.truncated,
  };
}

// ── AGENTIC TASKS ─────────────────────────────────────────────────────────────────────────────
// Mirrors what lib/design-agent.mjs actually asks models for: a small scene-graph observation +
// an instruction, replied to as a JSON array of ops in its exact grammar (see rubric above).
const OP_GRAMMAR = `Reply with ONLY a JSON array (max 8 items) of operations, no prose. Grammar:
{"op":"move","id":"…","x":n,"y":n} {"op":"resize","id":"…","w":n,"h":n}
{"op":"setText","id":"…","text":"…"} {"op":"setStyle","id":"…","style":{"fontSize":n,"color":"…","background":"…"}}
{"op":"remove","id":"…"}
Never touch the base image layer. Keep boxes inside the canvas (0-1080 x, 0-1350 y).`;

const AGENTIC_TASKS = [
  {
    id: 'contrast-fix',
    desc: 'Fix low-contrast headline on a dark background (structured scene-graph edit)',
    scene: `Scene graph (1080x1350 canvas):
base (background, #0a0a0a, full canvas)
headline (text "SAVE 40% TODAY", box x:80 y:200 w:900 h:140, color:#222222, fontSize:64) — LOW CONTRAST vs dark bg
subhead (text "Limited time only", box x:80 y:360 w:700 h:60, color:#cccccc, fontSize:32)
cta-button (button "Shop Now", box x:80 y:1150 w:320 h:90, background:#ffffff, color:#000000)`,
    instruction: 'Fix the contrast problem: the headline text is nearly invisible against the dark background. Adjust it so it reads clearly.',
    // A good answer touches "headline"'s color (to something light, since bg is #0a0a0a).
    expectId: 'headline',
    expectField: 'color',
  },
  {
    id: 'batch-reflow',
    desc: 'Given an overlapping layout, return ops to resolve overlap + resize CTA',
    scene: `Scene graph (1080x1350 canvas):
base (background, #ffffff, full canvas)
product-photo (image, box x:0 y:0 w:1080 h:700)
headline (text "NEW ARRIVAL", box x:60 y:650 w:960 h:120, fontSize:72, color:#111111) — OVERLAPS product-photo by 50px
price (text "$49.99", box x:60 y:800 w:300 h:60, fontSize:40)
cta-button (button "Buy Now", box x:60 y:1200 w:200 h:60, background:#111111, color:#ffffff) — TOO SMALL, hard to tap`,
    instruction: 'Resolve the overlap between the headline and the product photo (move the headline down so it starts after the photo ends), and resize the CTA button to be more tappable (at least 280 wide, 80 tall).',
    expectId: 'headline',
    expectField: 'y',
  },
  {
    id: 'remove-and-restyle',
    desc: 'Remove a redundant layer and restyle the remaining CTA to match brand color',
    scene: `Scene graph (1080x1350 canvas):
base (background, #f5f5f5, full canvas)
badge-old (text "50% OFF", box x:40 y:40 w:200 h:60, background:#ff0000, color:#ffffff) — DUPLICATE of price-badge below, should be removed
price-badge (text "50% OFF TODAY", box x:40 y:120 w:300 h:70, background:#ff0000, color:#ffffff)
cta-button (button "Get Started", box x:80 y:1180 w:300 h:90, background:#888888, color:#ffffff) — brand color should be #e63946`,
    instruction: 'Remove the duplicate badge-old layer (it repeats price-badge), and restyle cta-button to use the brand color #e63946 as its background.',
    expectId: null, // scored primarily on a remove op + a setStyle op on cta-button
    expectField: 'background',
  },
];

function parseOpsArray(text) {
  if (!text) return null;
  const m = String(text).match(/\[[\s\S]*\]/);
  if (!m) return null;
  try {
    const arr = JSON.parse(m[0]);
    return Array.isArray(arr) ? arr : null;
  } catch { return null; }
}

const VALID_OPS = new Set(['move', 'resize', 'setText', 'setStyle', 'remove']);
function isValidOp(op) {
  if (!op || typeof op !== 'object' || !VALID_OPS.has(op.op) || typeof op.id !== 'string') return false;
  if (op.op === 'move') return typeof op.x === 'number' && typeof op.y === 'number';
  if (op.op === 'resize') return typeof op.w === 'number' && typeof op.h === 'number';
  if (op.op === 'setText') return typeof op.text === 'string';
  if (op.op === 'setStyle') return op.style && typeof op.style === 'object';
  if (op.op === 'remove') return true;
  return false;
}

function scoreAgenticTask(task, ops, rawText) {
  if (!rawText) return 0;
  if (!ops) return 1;
  if (ops.length === 0) return 1;
  const valid = ops.filter(isValidOp);
  if (valid.length === 0) return 2;
  // does the plan actually address the goal? Look for an op touching the expected id/field, or
  // (remove-and-restyle) a remove op + a setStyle touching background.
  let addressesGoal = false;
  if (task.id === 'remove-and-restyle') {
    const hasRemove = valid.some((o) => o.op === 'remove');
    const hasRestyle = valid.some((o) => o.op === 'setStyle' && o.style && ('background' in o.style));
    addressesGoal = hasRemove && hasRestyle;
  } else {
    addressesGoal = valid.some((o) => o.id === task.expectId
      && ((task.expectField === 'color' && o.op === 'setStyle' && o.style && 'color' in o.style)
        || (task.expectField === 'y' && o.op === 'move' && typeof o.y === 'number')
        || (task.expectField === 'background' && o.op === 'setStyle' && o.style && 'background' in o.style)));
  }
  const validRatio = valid.length / ops.length;
  if (!addressesGoal || validRatio < 0.5) return 3;
  // coherence check: no two ops targeting the same id with contradictory fields, ids are ones
  // that exist in the scene we described.
  const knownIds = (task.scene.match(/^\S[\w-]*(?=\s*\()/gm) || []).map((s) => s.trim());
  const idsOk = valid.every((o) => knownIds.includes(o.id));
  const noRedundancy = new Set(valid.map((o) => `${o.op}:${o.id}`)).size === valid.length;
  if (addressesGoal && validRatio === 1 && idsOk && noRedundancy) return 5;
  return 4;
}

async function runAgenticTask(task) {
  const prompt = `You lay out ad comps by editing a JSON scene graph.\n${task.scene}\n\n`
    + `Instruction: ${task.instruction}\n${OP_GRAMMAR}`;
  const started = Date.now();
  const r = await llmText(prompt, { purpose: 'benchmark-agentic', timeoutMs: 60_000, maxTokens: 1500, _noPrefer: true });
  const ms = Date.now() - started;
  const ops = r.ok ? parseOpsArray(r.text) : null;
  const score = scoreAgenticTask(task, ops, r.text);
  return {
    id: task.id,
    desc: task.desc,
    ok: r.ok,
    error: r.error || null,
    latencyMs: ms,
    inTok: r.usage?.inTok || 0,
    outTok: r.usage?.outTok || 0,
    validOpsFound: Array.isArray(ops) ? ops.length : 0,
    validOpsCount: Array.isArray(ops) ? ops.filter(isValidOp).length : 0,
    score,
  };
}

// ── MAIN ──────────────────────────────────────────────────────────────────────────────────────
function summarize(results) {
  const n = results.length || 1;
  const avgScore = results.reduce((s, r) => s + r.score, 0) / n;
  const avgLatency = results.reduce((s, r) => s + (r.latencyMs || 0), 0) / n;
  const totalInTok = results.reduce((s, r) => s + (r.inTok || 0), 0);
  const totalOutTok = results.reduce((s, r) => s + (r.outTok || 0), 0);
  return { avgScore: Number(avgScore.toFixed(2)), avgLatencyMs: Math.round(avgLatency), totalInTok, totalOutTok };
}

function resultPath(modelId, category) {
  const safe = String(modelId).replace(/[^a-zA-Z0-9._-]/g, '_');
  return join(RESULTS_DIR, `${safe}-${category}.json`);
}

function findOtherModelResult(loadedTarget) {
  const other = loadedTarget === 'ornith' ? 'gemma-12b' : loadedTarget === 'gemma-12b' ? 'ornith' : null;
  if (!other) return null;
  // scan RESULTS_DIR for any file matching the other target's naming pattern
  let files = [];
  try { files = readdirSync(RESULTS_DIR); } catch { return null; }
  const test = other === 'ornith' ? /ornith/i : /gemma.*12b/i;
  const visionFile = files.find((f) => test.test(f) && f.endsWith('-vision.json'));
  const agenticFile = files.find((f) => test.test(f) && f.endsWith('-agentic.json'));
  if (!visionFile && !agenticFile) return null;
  const load = (f) => { try { return JSON.parse(readFileSync(join(RESULTS_DIR, f), 'utf8')); } catch { return null; } };
  return {
    target: other,
    vision: visionFile ? load(visionFile) : null,
    agentic: agenticFile ? load(agenticFile) : null,
  };
}

async function main() {
  log('='.repeat(78));
  log('BENCHMARK: ornith-9b vs gemma-4-12b — vision + agentic (studio local model comparison)');
  log('='.repeat(78));

  const probe = await probeLoadedModel();
  if (probe.error) log(`WARNING: could not reach ${LMSTUDIO_HOST} (${probe.error}). Is LM Studio running?`);
  if (!probe.ids.length) {
    log('No model appears to be loaded in LM Studio right now. Load ornith-9b or gemma-4-12b and re-run.');
    process.exit(1);
  }
  const { target, modelId } = classifyLoaded(probe.ids);
  log(`Detected loaded model(s): ${probe.ids.join(', ')}`);
  if (!target) {
    log(`NOTE: loaded model "${modelId}" does not match either target (ornith-* / gemma-4-12b).`);
    log('Running the suite anyway and tagging results with its real id, as a reference point.');
  } else {
    log(`Target match: "${target}" (model id: ${modelId})`);
  }
  if (target === 'gemma-12b' && probe.ids.some((id) => /gemma-4-e4b/i.test(id)) && probe.ids.length > 1) {
    log('NOTE: gemma-4-e4b is ALSO loaded alongside gemma-4-12b — this benchmark targets the 12b variant specifically.');
  }

  // ── VISION ──
  log('\n--- VISION tasks ---');
  const visionResults = [];
  for (const task of VISION_TASKS) {
    log(`  running: ${task.id} (${task.desc})...`);
    const r = await runVisionTask(task);
    visionResults.push(r);
    log(`    -> ok=${r.ok} score=${r.score}/5 latency=${r.latencyMs}ms layers=${r.layerCount}/${r.expectedLayers} tok(in/out)=${r.inTok}/${r.outTok}`);
  }
  const visionSummary = summarize(visionResults);
  const visionOut = { modelId, target, ranAt: new Date().toISOString(), category: 'vision', summary: visionSummary, tasks: visionResults };
  writeFileSync(resultPath(modelId, 'vision'), JSON.stringify(visionOut, null, 2));
  log(`  VISION summary: avgScore=${visionSummary.avgScore}/5 avgLatency=${visionSummary.avgLatencyMs}ms totalTok(in/out)=${visionSummary.totalInTok}/${visionSummary.totalOutTok}`);

  // ── AGENTIC ──
  log('\n--- AGENTIC tasks ---');
  const agenticResults = [];
  for (const task of AGENTIC_TASKS) {
    log(`  running: ${task.id} (${task.desc})...`);
    const r = await runAgenticTask(task);
    agenticResults.push(r);
    log(`    -> ok=${r.ok} score=${r.score}/5 latency=${r.latencyMs}ms validOps=${r.validOpsCount}/${r.validOpsFound} tok(in/out)=${r.inTok}/${r.outTok}`);
  }
  const agenticSummary = summarize(agenticResults);
  const agenticOut = { modelId, target, ranAt: new Date().toISOString(), category: 'agentic', summary: agenticSummary, tasks: agenticResults };
  writeFileSync(resultPath(modelId, 'agentic'), JSON.stringify(agenticOut, null, 2));
  log(`  AGENTIC summary: avgScore=${agenticSummary.avgScore}/5 avgLatency=${agenticSummary.avgLatencyMs}ms totalTok(in/out)=${agenticSummary.totalInTok}/${agenticSummary.totalOutTok}`);

  log(`\nResults saved:\n  ${resultPath(modelId, 'vision')}\n  ${resultPath(modelId, 'agentic')}`);

  // ── COMPARISON (if the other target's results exist on disk) ──
  const other = findOtherModelResult(target);
  log('\n' + '='.repeat(78));
  if (!other || (!other.vision && !other.agentic)) {
    const otherName = target === 'ornith' ? 'gemma-4-12b' : target === 'gemma-12b' ? 'ornith-9b' : '(the other target model)';
    log(`NO COMPARISON YET — only "${modelId}" has been benchmarked so far.`);
    log(`ACTION NEEDED: in LM Studio on degitaar, unload this model and load ${otherName} instead,`);
    log('then re-run this exact script:  node scripts/benchmark-vision-agentic.mjs');
    log('Once both models have result files on disk, this script will auto-print a comparison.');
  } else {
    log('COMPARISON — ornith vs gemma-4-12b');
    log('-'.repeat(78));
    const row = (label, cat, sum) => `  ${label} (${cat}): avgScore=${sum.avgScore}/5  avgLatency=${sum.avgLatencyMs}ms  tok(in/out)=${sum.totalInTok}/${sum.totalOutTok}`;
    log(row(target || modelId, 'vision', visionSummary));
    if (other.vision) log(row(other.target, 'vision', other.vision.summary));
    log(row(target || modelId, 'agentic', agenticSummary));
    if (other.agentic) log(row(other.target, 'agentic', other.agentic.summary));

    if (other.vision && other.agentic) {
      const meVision = visionSummary.avgScore, meAgentic = agenticSummary.avgScore;
      const otherVision = other.vision.summary.avgScore, otherAgentic = other.agentic.summary.avgScore;
      const gemmaVision = target === 'gemma-12b' ? meVision : otherVision;
      const ornithAgentic = target === 'ornith' ? meAgentic : otherAgentic;
      const gemmaAgentic = target === 'gemma-12b' ? meAgentic : otherAgentic;
      const ornithVision = target === 'ornith' ? meVision : otherVision;
      log('-'.repeat(78));
      log(`Hypothesis check — "gemma-4-12b better at vision, ornith better at agentic":`);
      log(`  vision:  gemma-4-12b=${gemmaVision.toFixed(2)}  ornith=${ornithVision.toFixed(2)}  -> ${gemmaVision > ornithVision ? 'SUPPORTS' : gemmaVision < ornithVision ? 'CONTRADICTS' : 'TIE'}`);
      log(`  agentic: ornith=${ornithAgentic.toFixed(2)}  gemma-4-12b=${gemmaAgentic.toFixed(2)}  -> ${ornithAgentic > gemmaAgentic ? 'SUPPORTS' : ornithAgentic < gemmaAgentic ? 'CONTRADICTS' : 'TIE'}`);
    }
  }
  log('='.repeat(78));
}

main().catch((e) => {
  console.error('benchmark failed:', e);
  process.exit(1);
});
