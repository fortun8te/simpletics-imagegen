#!/usr/bin/env node
// scripts/benchmark-models-v2.mjs — three-way local model benchmark: gemma-4-e4b vs ornith-9b
// vs gemma-4-12b, extended with a real end-to-end CREATIVE GENERATION category + consistency
// (repeat-twice) testing on top of the proven vision + agentic categories from
// scripts/benchmark-vision-agentic.mjs (read in full for reusable patterns; NOT modified —
// that script stays intact as a fallback).
//
// CONSTRAINT: Michael's LM Studio host ("degitaar", VISION_BASE_URL in studio/.env) can only
// have ONE model loaded at a time. This script never assumes which one — it always probes
// /api/v0/models (LM Studio's richer endpoint that reports real per-model `state:"loaded"`,
// unlike the plain OpenAI-compatible /v1/models list which just enumerates downloads) and
// labels every result by the EXACT id string LM Studio reports, distinguishing:
//   gemma-4-e4b   (small/fast Gemma)
//   gemma-4-12b   (large Gemma — NOT matched by the e4b pattern)
//   ornith-9b     (Ornith)
// Michael re-invokes this script by hand each time he's swapped the loaded model in LM Studio.
//
// Usage:
//   node scripts/benchmark-models-v2.mjs             — full suite (vision+agentic+creative,
//                                                       incl. repeat-twice pass) against whatever
//                                                       is loaded right now; saves + prints summary.
//   node scripts/benchmark-models-v2.mjs --compare    — reads ALL saved result files across all
//                                                       models/categories/runs on disk and prints
//                                                       a 3-way comparison table + verdict.
//
// Output: studio/.state/benchmark-results/<model-id>-<category>-<runIndex>.json
//   runIndex lets repeated invocations (esp. the twice-repeated creative/vision tasks) accumulate
//   without clobbering — run 0, run 1, run 2, ... per (model, category) combo, newest wins ties
//   in --compare reporting but all runs are kept on disk.
//
// ── SCORING RUBRICS ──
// VISION (0-5): reused near-verbatim from benchmark-vision-agentic.mjs's proven rubric — see
//   scoreVisionTask() below for the exact bands (parses? layers? completeness? well-formed
//   boxes? exact-text hit?).
// AGENTIC (0-5): reused near-verbatim — valid op-grammar shapes, goal-addressing, coherence.
// CREATIVE (0-5): a NEW rubric for a full brief -> ad-JSON generation task, standalone-prompt
//   style (mirrors design-agent.mjs's generate-mode target shape without invoking the full
//   template/best-of-N/verify harness, which is deterministic-op-heavy and not representative
//   of raw model quality). Scored on: valid parse, headline/body/cta role presence, layer-count
//   sanity vs a per-brief expectation, and — the objective signal — studio/lib/design-lint.mjs's
//   lintDesign() finding count on the produced doc (fewer findings = cleaner = better), via a
//   real, unmodified import of the production lint module.
//   0 — no usable output (empty / network error / totally unparsable)
//   1 — text returned but JSON does not parse at all
//   2 — JSON parses but has no `layers` array, or an empty/degenerate one (<2 real layers)
//   3 — parses, has a substantive layers array, but missing >=1 of headline/body/cta roles, or
//       layer count is well outside the brief's sane range, or lint finds >=6 findings
//   4 — has headline+cta at least, layer count in a sane range, lint findings <=5
//   5 — has headline+body+cta, layer count in a sane range, well-formed boxes, lint findings <=2
//
// CONSISTENCY (repeat-twice): for the creative category (mandatory) and one vision task
// (best-effort), the exact same task is run twice in the same session. We report:
//   - latencyDeltaMs / latencyDeltaPct
//   - scoreDelta (run2.score - run1.score)
//   - archetypeMatch (creative/vision: did both runs pick the same archetype?)
//   - layerCountDelta and layerCountRatio (structural similarity proxy)
//   - a single 0-5 "stability" score: 5 = near-identical structure+score, 0 = wildly divergent
// This makes flaky output visible instead of averaging it away.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { llmText, llmVision } from '../studio/lib/llm.mjs';
import { lintDesign } from '../studio/lib/design-lint.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STUDIO = join(ROOT, 'studio');
const RESULTS_DIR = join(STUDIO, '.state', 'benchmark-results');
mkdirSync(RESULTS_DIR, { recursive: true });

const IMAGE_DIR = join(process.env.HOME || '', 'Downloads', 'IMAGE AD INSPO');
const VISION_BASE = (process.env.VISION_BASE_URL || 'http://localhost:1234/v1').replace(/\/$/, '');
const LMSTUDIO_HOST = VISION_BASE.replace(/\/v1$/, '');

// ── Model targets — full-id substring checks, checked in order so the MORE SPECIFIC pattern
// (gemma-4-12b) is tried before a broader one could ever accidentally swallow it. gemma-4-e4b
// and gemma-4-12b are deliberately DISTINCT entries — never collapse them into one "gemma" bucket.
const TARGETS = [
  ['gemma-4-12b', (id) => /gemma-4-12b/i.test(id)],
  ['gemma-4-e4b', (id) => /gemma-4-e4b|gemma-4e4b|gemma-3n-e4b/i.test(id)], // LM Studio sometimes renders 3n/4 naming differently
  ['ornith-9b', (id) => /ornith/i.test(id)],
];

function log(msg) { console.log(msg); }
const isCompareMode = process.argv.includes('--compare');

// ── Detect the currently LOADED model via /api/v0/models (per-model state), falling back to
// the plain /models list + VISION_MODEL best guess if /api/v0 isn't available.
async function probeLoadedModel() {
  try {
    const res = await fetch(`${LMSTUDIO_HOST}/api/v0/models`, { signal: AbortSignal.timeout(4000) });
    if (res.ok) {
      const j = await res.json();
      const all = Array.isArray(j?.data) ? j.data : [];
      const loaded = all.filter((m) => m.state === 'loaded' && m.type !== 'embeddings');
      if (loaded.length) return { ids: loaded.map((m) => m.id), all };
    }
  } catch { /* not LM Studio, or unreachable */ }
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

/** Classify loaded ids against TARGETS, checked in specificity order. */
function classifyLoaded(ids) {
  for (const [name, test] of TARGETS) {
    const hit = ids.find(test);
    if (hit) return { target: name, modelId: hit };
  }
  return { target: null, modelId: ids[0] || null };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// VISION category — reused near-verbatim from benchmark-vision-agentic.mjs (validated rubric).
// ═══════════════════════════════════════════════════════════════════════════════════════════
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

const VISION_TASKS = [
  {
    id: 'nutrition-label-text-heavy',
    file: '001_attached_13db963dcf9d6604.png',
    desc: 'Text-heavy product/nutrition-label ad (UPFRONT whey)',
    expectedLayers: 10,
    mustContainText: ['UPFRONT', 'WHEY'],
  },
  {
    id: 'photo-heavy-hero',
    file: '005_attached_23b6641d52f7bdfe.png',
    desc: 'Photo/product-heavy hero ad (chocolate pour + bar)',
    expectedLayers: 7,
    mustContainText: ['CHOCO', 'KORTING'],
  },
  {
    id: 'long-copy-text-only',
    file: '017_attached_92769a9e1f6a3219.png',
    desc: 'Pure long-form text ad, no imagery except an emoji (Hears earplugs)',
    expectedLayers: 4,
    mustContainText: ['COPIED', 'Hears'],
  },
  {
    id: 'x-post-ui-mimic',
    file: '009_attached_885c19be02ccf229.png',
    desc: 'UI-mimicking ad — fake X/Twitter post',
    expectedLayers: 8,
    mustContainText: [],
    repeatTwice: true, // "maybe try the same ad twice too" — one vision task, best-effort
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
  if (!existsSync(imgPath)) return { id: task.id, ok: false, error: `image not found: ${imgPath}` };
  const started = Date.now();
  const r = await llmVision(LAYOUT_PROMPT, imgPath, { purpose: 'benchmark-vision', timeoutMs: 90_000, maxTokens: 6000 });
  const ms = Date.now() - started;
  const parsed = r.ok ? tryParseJson(r.text) : null;
  const score = scoreVisionTask(task, parsed, r.text);
  const layerCount = Array.isArray(parsed?.layers) ? parsed.layers.length : 0;
  return {
    id: task.id, desc: task.desc, file: task.file, ok: r.ok, error: r.error || null,
    latencyMs: ms, inTok: r.usage?.inTok || 0, outTok: r.usage?.outTok || 0,
    validJson: !!parsed, layerCount, expectedLayers: task.expectedLayers, score,
    archetype: parsed?.archetype || null, truncated: !!r.truncated,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// AGENTIC category — reused near-verbatim from benchmark-vision-agentic.mjs.
// ═══════════════════════════════════════════════════════════════════════════════════════════
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
    expectId: 'headline', expectField: 'color',
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
    expectId: 'headline', expectField: 'y',
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
    expectId: null, expectField: 'background',
  },
];

function parseOpsArray(text) {
  if (!text) return null;
  const m = String(text).match(/\[[\s\S]*\]/);
  if (!m) return null;
  try { const arr = JSON.parse(m[0]); return Array.isArray(arr) ? arr : null; } catch { return null; }
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
    id: task.id, desc: task.desc, ok: r.ok, error: r.error || null, latencyMs: ms,
    inTok: r.usage?.inTok || 0, outTok: r.usage?.outTok || 0,
    validOpsFound: Array.isArray(ops) ? ops.length : 0,
    validOpsCount: Array.isArray(ops) ? ops.filter(isValidOp).length : 0,
    score,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// CREATIVE GENERATION category — NEW. A standalone prompt that mirrors design-agent.mjs's
// generate-mode target shape (archetype + a doc of {canvas,layers[]} matching the
// design-lint.mjs input contract: layers have {type, role, box:{x,y,w,h}, style:{...}}), so a
// REAL, unmodified lintDesign() call gives an objective cleanliness signal on top of structural
// checks. This deliberately does NOT invoke the full runDesignAgent() harness (that pipeline is
// template-scaffold + best-of-N + verify — mostly deterministic ops, not a fair read of raw model
// quality) — see header comment for rationale.
// ═══════════════════════════════════════════════════════════════════════════════════════════
const CREATIVE_PROMPT_TEMPLATE = (brief) => `You are an ad-creative generator for a design tool. Given a brief, produce a complete
scene-graph JSON for a single square (1080x1080) social ad — a real, finished creative a human
could ship, not a wireframe.

BRIEF: ${brief}

Reply with ONLY this JSON shape, no prose, no markdown fences:
{"archetype": "story-native|x-post|before-after|comparison|offer-hero|ig-dm|apple-notes|stat-chart|generic",
 "canvas": {"w": 1080, "h": 1080},
 "layers": [
   {"type":"shape","role":"base","box":{"x":0,"y":0,"w":1080,"h":1080},"style":{"background":"#hex"}},
   {"type":"image","role":"product","box":{"x":n,"y":n,"w":n,"h":n},"style":{}},
   {"type":"text","role":"headline","text":"...","box":{"x":n,"y":n,"w":n,"h":n},"style":{"color":"#hex","fontSize":n}},
   {"type":"text","role":"body","text":"...","box":{"x":n,"y":n,"w":n,"h":n},"style":{"color":"#hex","fontSize":n}},
   {"type":"button","role":"cta","text":"...","box":{"x":n,"y":n,"w":n,"h":n},"style":{"background":"#hex","color":"#hex","fontSize":n}}
 ]}
Include 5-10 layers total (base + product/image + headline + body + cta + optional badge/price/logo).
Boxes are in PIXELS on the 1080x1080 canvas, non-overlapping where it matters (headline/body/cta
must not overlap each other), font sizes realistic for a mobile ad (headline 48-96, body 24-40,
cta 28-44). Use real, on-brief, ready-to-ship copy — not placeholder text like "Lorem ipsum" or
"Your headline here".`;

const CREATIVE_BRIEFS = [
  {
    id: 'skincare-product',
    desc: 'Skincare product ad — headline + product + CTA',
    brief: 'Product: "Lumé Glow Serum" (vitamin-C brightening serum). Headline should promise '
      + 'visible glow in days. CTA: "Shop Now". Platform: Instagram feed ad. Tone: clean, premium beauty.',
    expectedLayerRange: [5, 11],
  },
  {
    id: 'saas-offer',
    desc: 'SaaS offer ad — headline + value prop + CTA',
    brief: 'Product: "Flowbase" (project management SaaS). Offer: "14-day free trial, no credit '
      + 'card". Headline should target overwhelmed team leads. CTA: "Start Free Trial". '
      + 'Platform: LinkedIn/Facebook feed ad. Tone: confident, modern B2B.',
    expectedLayerRange: [5, 11],
  },
  {
    id: 'testimonial-style',
    desc: 'Testimonial-style ad — quote + attribution + CTA',
    brief: 'Product: "Rested" sleep supplement. Format: testimonial/review-style ad quoting a '
      + 'happy customer about better sleep within a week. Include a star rating element. '
      + 'CTA: "Try Rested Risk-Free". Platform: Instagram story ad. Tone: warm, credible, UGC-like.',
    expectedLayerRange: [5, 12],
  },
];

function tryParseCreativeJson(text) {
  if (!text) return null;
  const direct = (() => { try { return JSON.parse(text); } catch { return null; } })();
  if (direct) return direct;
  const m = String(text).match(/\{[\s\S]*"layers"[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* fall through */ } }
  return null;
}

/** Runs real lintDesign() against a produced doc — returns { findings, count } or null if the
 *  doc shape is too broken to lint safely (lintDesign expects doc.layers to be an array of leaf
 *  nodes with .box; we defensively guard rather than let a malformed doc throw). */
function safeLint(doc) {
  try {
    if (!doc || !Array.isArray(doc.layers)) return null;
    const findings = lintDesign(doc, null);
    return { findings, count: findings.length };
  } catch (e) {
    return { findings: [`lint threw: ${e.message}`], count: 8, threw: true };
  }
}

function scoreCreativeTask(brief, parsed, rawText, lint) {
  if (!rawText) return { score: 0, reason: 'no output' };
  if (!parsed) return { score: 1, reason: 'unparsable JSON' };
  const layers = Array.isArray(parsed.layers) ? parsed.layers : null;
  if (!layers || layers.length < 2) return { score: 2, reason: 'no/degenerate layers array' };
  const roles = new Set(layers.map((l) => l?.role).filter(Boolean));
  const hasHeadline = roles.has('headline');
  const hasBody = roles.has('body');
  const hasCta = roles.has('cta') || layers.some((l) => l?.type === 'button');
  const [lo, hi] = brief.expectedLayerRange;
  const countSane = layers.length >= lo - 1 && layers.length <= hi + 2;
  const lintCount = lint && !lint.threw ? lint.count : 8; // unlintable ~= as bad as maximally-flawed
  const wellFormedBoxes = layers.filter((l) => l?.box
    && ['x', 'y', 'w', 'h'].every((k) => typeof l.box[k] === 'number') && l.box.w > 0 && l.box.h > 0).length / layers.length;

  let score;
  if (!hasHeadline || !hasCta || !countSane || lintCount >= 6) score = 3;
  else if (hasHeadline && hasCta && countSane && lintCount <= 5) score = 4;
  if (hasHeadline && hasBody && hasCta && countSane && wellFormedBoxes >= 0.9 && lintCount <= 2) score = 5;
  if (score === undefined) score = 3;
  return {
    score, hasHeadline, hasBody, hasCta, countSane, wellFormedBoxes: Number(wellFormedBoxes.toFixed(2)),
    lintCount, reason: `layers=${layers.length} roles=${[...roles].join(',')} lint=${lintCount}`,
  };
}

async function runCreativeTask(brief) {
  const prompt = CREATIVE_PROMPT_TEMPLATE(brief.brief);
  const started = Date.now();
  const r = await llmText(prompt, { purpose: 'benchmark-creative', timeoutMs: 90_000, maxTokens: 3000, _noPrefer: true });
  const ms = Date.now() - started;
  const parsed = r.ok ? tryParseCreativeJson(r.text) : null;
  const lint = parsed ? safeLint(parsed) : null;
  const scoring = scoreCreativeTask(brief, parsed, r.text, lint);
  return {
    id: brief.id, desc: brief.desc, ok: r.ok, error: r.error || null, latencyMs: ms,
    inTok: r.usage?.inTok || 0, outTok: r.usage?.outTok || 0,
    validJson: !!parsed, archetype: parsed?.archetype || null,
    layerCount: Array.isArray(parsed?.layers) ? parsed.layers.length : 0,
    lintFindings: lint?.findings || null,
    ...scoring,
  };
}

// ── Consistency (repeat-twice) helper ───────────────────────────────────────────────────────
/** Runs `fn()` twice back-to-back and computes a stability comparison. Generic over vision/
 *  creative task result shapes (both expose latencyMs, score, layerCount, archetype). */
async function runTwiceForConsistency(label, fn) {
  log(`    [consistency] running "${label}" a 2nd time on the identical input...`);
  const run1 = await fn();
  const run2 = await fn();
  const latencyDeltaMs = (run2.latencyMs || 0) - (run1.latencyMs || 0);
  const latencyDeltaPct = run1.latencyMs ? Number(((latencyDeltaMs / run1.latencyMs) * 100).toFixed(1)) : null;
  const scoreDelta = (run2.score ?? 0) - (run1.score ?? 0);
  const archetypeMatch = !!run1.archetype && run1.archetype === run2.archetype;
  const layerCountDelta = (run2.layerCount || 0) - (run1.layerCount || 0);
  const layerCountRatio = run1.layerCount ? Number((run2.layerCount / run1.layerCount).toFixed(2)) : null;
  // stability 0-5: start at 5, dock for divergence.
  let stability = 5;
  if (Math.abs(scoreDelta) >= 1) stability -= 2;
  else if (Math.abs(scoreDelta) >= 0.5) stability -= 1;
  if (run1.archetype && !archetypeMatch) stability -= 1;
  if (layerCountRatio !== null && (layerCountRatio < 0.7 || layerCountRatio > 1.3)) stability -= 1;
  if (latencyDeltaPct !== null && Math.abs(latencyDeltaPct) > 80) stability -= 1;
  stability = Math.max(0, stability);
  return {
    label, run1, run2,
    latencyDeltaMs, latencyDeltaPct, scoreDelta, archetypeMatch,
    layerCountDelta, layerCountRatio, stability,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// Result persistence — <model-id>-<category>-<runIndex>.json, non-clobbering.
// ═══════════════════════════════════════════════════════════════════════════════════════════
function safeModelId(modelId) { return String(modelId).replace(/[^a-zA-Z0-9._-]/g, '_'); }

function nextRunIndex(modelId, category) {
  const safe = safeModelId(modelId);
  let files = [];
  try { files = readdirSync(RESULTS_DIR); } catch { return 0; }
  const re = new RegExp(`^${safe}-${category}-(\\d+)\\.json$`);
  let max = -1;
  for (const f of files) {
    const m = re.exec(f);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

function resultPath(modelId, category, runIndex) {
  return join(RESULTS_DIR, `${safeModelId(modelId)}-${category}-${runIndex}.json`);
}

function summarize(results) {
  const n = results.length || 1;
  const avgScore = results.reduce((s, r) => s + (r.score || 0), 0) / n;
  const avgLatency = results.reduce((s, r) => s + (r.latencyMs || 0), 0) / n;
  const totalInTok = results.reduce((s, r) => s + (r.inTok || 0), 0);
  const totalOutTok = results.reduce((s, r) => s + (r.outTok || 0), 0);
  const timeouts = results.filter((r) => !r.ok && /timeout/i.test(r.error || '')).length;
  return {
    avgScore: Number(avgScore.toFixed(2)), avgLatencyMs: Math.round(avgLatency),
    totalInTok, totalOutTok, timeouts,
    tokPerSec: avgLatency > 0 ? Number(((totalOutTok / n) / (avgLatency / 1000)).toFixed(1)) : 0,
  };
}

function saveCategory(modelId, target, category, results, summary, extra = {}) {
  const runIndex = nextRunIndex(modelId, category);
  const out = { modelId, target, ranAt: new Date().toISOString(), category, runIndex, summary, tasks: results, ...extra };
  const p = resultPath(modelId, category, runIndex);
  writeFileSync(p, JSON.stringify(out, null, 2));
  return { path: p, runIndex, out };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// --compare mode: read every saved result across all models/categories/runs and print a 3-way
// comparison table + verdict.
// ═══════════════════════════════════════════════════════════════════════════════════════════
function loadAllResults() {
  let files = [];
  try { files = readdirSync(RESULTS_DIR); } catch { return []; }
  const out = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try { out.push({ file: f, data: JSON.parse(readFileSync(join(RESULTS_DIR, f), 'utf8')) }); } catch { /* skip corrupt */ }
  }
  return out;
}

/** Canonical grouping key for a result record. Grouped by the REAL modelId string (re-classified
 *  against TARGETS here, not trusted from the saved `target` field) so records from an older/
 *  differently-named benchmark run (e.g. a legacy "gemma-12b" target label) still merge with this
 *  script's "gemma-4-12b" naming for the same underlying model id — old result files on disk are
 *  read-only inputs here, never rewritten. */
function canonicalKey(data) {
  const id = data.modelId || '';
  for (const [name, test] of TARGETS) { if (test(id)) return name; }
  return data.target || id || 'unknown';
}

/** Groups all result records by canonical model key, keeping ALL runs (not just latest) so
 *  consistency/repeat data survives, but also computing a "latest run per category" view for the
 *  headline comparison table. */
function groupByModel(allResults) {
  const byModel = new Map(); // key -> { modelId, target, categories: { vision:[...], agentic:[...], creative:[...] } }
  for (const { data } of allResults) {
    const key = canonicalKey(data);
    if (!byModel.has(key)) byModel.set(key, { modelId: data.modelId, target: key, categories: {} });
    const entry = byModel.get(key);
    if (!entry.categories[data.category]) entry.categories[data.category] = [];
    entry.categories[data.category].push(data);
  }
  for (const entry of byModel.values()) {
    for (const cat of Object.values(entry.categories)) cat.sort((a, b) => (a.runIndex ?? 0) - (b.runIndex ?? 0));
  }
  return byModel;
}

/** Backfills missing summary fields (tokPerSec, timeouts) for result files saved by an older
 *  benchmark script version that didn't compute them, so --compare never prints "undefined". */
function normalizeSummary(summary, taskCount) {
  if (!summary) return null;
  const n = Math.max(1, taskCount || 1);
  const timeouts = typeof summary.timeouts === 'number' ? summary.timeouts : 0;
  const tokPerSec = typeof summary.tokPerSec === 'number'
    ? summary.tokPerSec
    : (summary.avgLatencyMs > 0 ? Number((((summary.totalOutTok || 0) / n) / (summary.avgLatencyMs / 1000)).toFixed(1)) : 0);
  return { ...summary, timeouts, tokPerSec };
}

function latestOf(arr) { return arr && arr.length ? arr[arr.length - 1] : null; }

function printCompare() {
  const all = loadAllResults();
  log('='.repeat(96));
  log('THREE-WAY MODEL COMPARISON — gemma-4-e4b vs ornith-9b vs gemma-4-12b');
  log('='.repeat(96));
  if (!all.length) {
    log('No result files found in .state/benchmark-results/. Run this script (no flags) after');
    log('loading a model in LM Studio to produce data, then re-run --compare.');
    log('='.repeat(96));
    return;
  }
  const byModel = groupByModel(all);
  const order = ['gemma-4-e4b', 'ornith-9b', 'gemma-4-12b'];
  const keys = [...byModel.keys()].sort((a, b) => {
    const ia = order.indexOf(a); const ib = order.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });

  log(`\nModels with data on disk: ${keys.length ? keys.join(', ') : '(none)'}\n`);

  const rows = [];
  for (const key of keys) {
    const entry = byModel.get(key);
    const vision = latestOf(entry.categories.vision);
    const agentic = latestOf(entry.categories.agentic);
    const creative = latestOf(entry.categories.creative);
    const visionRuns = entry.categories.vision?.length || 0;
    const agenticRuns = entry.categories.agentic?.length || 0;
    const creativeRuns = entry.categories.creative?.length || 0;
    rows.push({
      key, modelId: entry.modelId,
      vision: normalizeSummary(vision?.summary, vision?.tasks?.length), visionRuns,
      agentic: normalizeSummary(agentic?.summary, agentic?.tasks?.length), agenticRuns,
      creative: normalizeSummary(creative?.summary, creative?.tasks?.length), creativeRuns,
      creativeConsistency: creative?.consistency || null,
      visionConsistency: vision?.consistency || null,
    });
  }

  const fmt = (v, d = '—') => (v === null || v === undefined ? d : v);
  log('-'.repeat(96));
  log(`${'MODEL'.padEnd(16)} | ${'VISION'.padEnd(28)} | ${'AGENTIC'.padEnd(24)} | ${'CREATIVE'.padEnd(24)}`);
  log('-'.repeat(96));
  for (const r of rows) {
    const v = r.vision ? `${r.vision.avgScore}/5 @ ${r.vision.tokPerSec}tok/s (${r.vision.timeouts}TO, n=${r.visionRuns})` : 'no data';
    const a = r.agentic ? `${r.agentic.avgScore}/5 @ ${r.agentic.tokPerSec}tok/s (n=${r.agenticRuns})` : 'no data';
    const c = r.creative ? `${r.creative.avgScore}/5 @ ${r.creative.tokPerSec}tok/s (n=${r.creativeRuns})` : 'no data';
    log(`${r.key.padEnd(16)} | ${v.padEnd(28)} | ${a.padEnd(24)} | ${c.padEnd(24)}`);
  }
  log('-'.repeat(96));

  // consistency call-outs
  for (const r of rows) {
    if (r.creativeConsistency) {
      const cc = r.creativeConsistency;
      log(`  ${r.key} CREATIVE consistency (repeat-twice): stability=${cc.stability}/5, scoreDelta=${cc.scoreDelta}, `
        + `archetypeMatch=${cc.archetypeMatch}, layerCountRatio=${fmt(cc.layerCountRatio)}, latencyDelta=${cc.latencyDeltaMs}ms (${fmt(cc.latencyDeltaPct)}%)`);
    }
    if (r.visionConsistency) {
      const vc = r.visionConsistency;
      log(`  ${r.key} VISION consistency (repeat-twice, x-post-ui-mimic): stability=${vc.stability}/5, scoreDelta=${vc.scoreDelta}, `
        + `archetypeMatch=${vc.archetypeMatch}, layerCountRatio=${fmt(vc.layerCountRatio)}`);
    }
  }

  // per-category winners
  log('-'.repeat(96));
  const withData = (cat) => rows.filter((r) => r[cat]);
  const winner = (cat) => {
    const cands = withData(cat);
    if (!cands.length) return null;
    return cands.reduce((best, r) => (r[cat].avgScore > best[cat].avgScore ? r : best));
  };
  const wVision = winner('vision'); const wAgentic = winner('agentic'); const wCreative = winner('creative');
  log(`WINNER — vision:   ${wVision ? `${wVision.key} (${wVision.vision.avgScore}/5)` : 'insufficient data'}`);
  log(`WINNER — agentic:  ${wAgentic ? `${wAgentic.key} (${wAgentic.agentic.avgScore}/5)` : 'insufficient data'}`);
  log(`WINNER — creative: ${wCreative ? `${wCreative.key} (${wCreative.creative.avgScore}/5)` : 'insufficient data'}`);

  // overall latency profile
  log('-'.repeat(96));
  log('LATENCY PROFILE (avg ms per task, lower = faster):');
  for (const r of rows) {
    const vL = r.vision ? r.vision.avgLatencyMs : null;
    const aL = r.agentic ? r.agentic.avgLatencyMs : null;
    const cL = r.creative ? r.creative.avgLatencyMs : null;
    log(`  ${r.key.padEnd(16)} vision=${fmt(vL, 'n/a')}ms  agentic=${fmt(aL, 'n/a')}ms  creative=${fmt(cL, 'n/a')}ms`);
  }

  // hypothesis check — needs >=2 models with vision AND agentic data
  log('-'.repeat(96));
  const haveBoth = rows.filter((r) => r.vision && r.agentic);
  if (haveBoth.length >= 2) {
    log(`Hypothesis check — "gemma is better at vision, ornith is better at agentic":`);
    const gemmaRows = rows.filter((r) => /^gemma/.test(r.key) && r.vision);
    const ornithRow = rows.find((r) => r.key === 'ornith-9b');
    if (gemmaRows.length && ornithRow?.vision) {
      for (const g of gemmaRows) {
        const v = g.vision.avgScore > ornithRow.vision.avgScore ? 'SUPPORTS' : g.vision.avgScore < ornithRow.vision.avgScore ? 'CONTRADICTS' : 'TIE';
        log(`  vision:  ${g.key}=${g.vision.avgScore}  ornith-9b=${ornithRow.vision.avgScore}  -> ${v}`);
      }
    }
    const gemmaAgRows = rows.filter((r) => /^gemma/.test(r.key) && r.agentic);
    if (gemmaAgRows.length && ornithRow?.agentic) {
      for (const g of gemmaAgRows) {
        const v = ornithRow.agentic.avgScore > g.agentic.avgScore ? 'SUPPORTS' : ornithRow.agentic.avgScore < g.agentic.avgScore ? 'CONTRADICTS' : 'TIE';
        log(`  agentic: ornith-9b=${ornithRow.agentic.avgScore}  ${g.key}=${g.agentic.avgScore}  -> ${v}`);
      }
    }
    if (!ornithRow) log('  (no ornith-9b data yet — load ornith-9b and re-run to complete this check)');
  } else {
    log('Hypothesis check — need >=2 models with BOTH vision+agentic data. Currently have:');
    for (const r of rows) log(`  ${r.key}: vision=${r.vision ? 'yes' : 'no'} agentic=${r.agentic ? 'yes' : 'no'}`);
  }
  log('='.repeat(96));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// MAIN — default mode: detect loaded model, run full suite, save, print summary.
// ═══════════════════════════════════════════════════════════════════════════════════════════
async function main() {
  if (isCompareMode) { printCompare(); return; }

  log('='.repeat(96));
  log('BENCHMARK v2: gemma-4-e4b vs ornith-9b vs gemma-4-12b — vision + agentic + creative generation');
  log('='.repeat(96));

  const probe = await probeLoadedModel();
  if (probe.error) log(`WARNING: could not reach ${LMSTUDIO_HOST} (${probe.error}). Is LM Studio running?`);
  if (!probe.ids.length) {
    log('No model appears to be loaded in LM Studio right now. Load gemma-4-e4b, ornith-9b, or gemma-4-12b and re-run.');
    process.exit(1);
  }
  const { target, modelId } = classifyLoaded(probe.ids);
  log(`Detected loaded model(s): ${probe.ids.join(', ')}`);
  if (!target) {
    log(`NOTE: loaded model "${modelId}" does not match any of the three known targets (gemma-4-e4b / gemma-4-12b / ornith-9b).`);
    log('Running the suite anyway and tagging results with its real id, as a reference point.');
  } else {
    log(`Target match: "${target}" (model id: ${modelId})`);
  }
  if (probe.ids.length > 1) {
    log(`NOTE: multiple models reported loaded (${probe.ids.join(', ')}) — this benchmark targets "${modelId}" specifically.`);
  }

  // ── VISION ──
  log('\n--- VISION tasks ---');
  const visionResults = [];
  let visionConsistency = null;
  for (const task of VISION_TASKS) {
    log(`  running: ${task.id} (${task.desc})...`);
    const r = await runVisionTask(task);
    visionResults.push(r);
    log(`    -> ok=${r.ok} score=${r.score}/5 latency=${r.latencyMs}ms layers=${r.layerCount}/${r.expectedLayers} tok(in/out)=${r.inTok}/${r.outTok}`);
    if (task.repeatTwice) {
      const consistency = await runTwiceForConsistency(task.id, () => runVisionTask(task));
      // replace the single sample above with run1 for the saved tasks array; append run2 separately.
      visionResults[visionResults.length - 1] = consistency.run1;
      visionResults.push({ ...consistency.run2, id: `${task.id}-repeat2` });
      visionConsistency = {
        taskId: task.id, stability: consistency.stability, scoreDelta: consistency.scoreDelta,
        archetypeMatch: consistency.archetypeMatch, layerCountDelta: consistency.layerCountDelta,
        layerCountRatio: consistency.layerCountRatio, latencyDeltaMs: consistency.latencyDeltaMs,
        latencyDeltaPct: consistency.latencyDeltaPct,
      };
      log(`    -> [consistency] stability=${consistency.stability}/5 scoreDelta=${consistency.scoreDelta} archetypeMatch=${consistency.archetypeMatch}`);
    }
  }
  const visionSummary = summarize(visionResults);
  const visionSave = saveCategory(modelId, target, 'vision', visionResults, visionSummary, { consistency: visionConsistency });
  log(`  VISION summary: avgScore=${visionSummary.avgScore}/5 avgLatency=${visionSummary.avgLatencyMs}ms tok/s=${visionSummary.tokPerSec} timeouts=${visionSummary.timeouts}`);

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
  const agenticSave = saveCategory(modelId, target, 'agentic', agenticResults, agenticSummary);
  log(`  AGENTIC summary: avgScore=${agenticSummary.avgScore}/5 avgLatency=${agenticSummary.avgLatencyMs}ms tok/s=${agenticSummary.tokPerSec}`);

  // ── CREATIVE GENERATION (incl. mandatory repeat-twice on one brief) ──
  log('\n--- CREATIVE GENERATION tasks (full brief -> ad JSON, lint-scored) ---');
  const creativeResults = [];
  let creativeConsistency = null;
  for (const brief of CREATIVE_BRIEFS) {
    log(`  running: ${brief.id} (${brief.desc})...`);
    const r = await runCreativeTask(brief);
    creativeResults.push(r);
    log(`    -> ok=${r.ok} score=${r.score}/5 latency=${r.latencyMs}ms layers=${r.layerCount} archetype=${r.archetype} lint=${r.lintCount ?? 'n/a'} tok(in/out)=${r.inTok}/${r.outTok}`);
    if (r.lintFindings?.length) log(`       lint findings: ${r.lintFindings.slice(0, 3).join(' | ')}${r.lintFindings.length > 3 ? ' ...' : ''}`);
  }
  // Mandatory repeat-twice pass on the FIRST brief ("maybe try the same ad twice too").
  const repeatBrief = CREATIVE_BRIEFS[0];
  log(`  [consistency] repeating "${repeatBrief.id}" a 2nd time on the identical brief...`);
  const consistency = await runTwiceForConsistency(repeatBrief.id, () => runCreativeTask(repeatBrief));
  creativeResults.push({ ...consistency.run2, id: `${repeatBrief.id}-repeat2` });
  creativeConsistency = {
    taskId: repeatBrief.id, stability: consistency.stability, scoreDelta: consistency.scoreDelta,
    archetypeMatch: consistency.archetypeMatch, layerCountDelta: consistency.layerCountDelta,
    layerCountRatio: consistency.layerCountRatio, latencyDeltaMs: consistency.latencyDeltaMs,
    latencyDeltaPct: consistency.latencyDeltaPct,
  };
  log(`    -> [consistency] stability=${consistency.stability}/5 scoreDelta=${consistency.scoreDelta} archetypeMatch=${consistency.archetypeMatch} layerCountRatio=${consistency.layerCountRatio}`);

  const creativeSummary = summarize(creativeResults);
  const creativeSave = saveCategory(modelId, target, 'creative', creativeResults, creativeSummary, { consistency: creativeConsistency });
  log(`  CREATIVE summary: avgScore=${creativeSummary.avgScore}/5 avgLatency=${creativeSummary.avgLatencyMs}ms tok/s=${creativeSummary.tokPerSec}`);

  log(`\nResults saved:\n  ${visionSave.path}\n  ${agenticSave.path}\n  ${creativeSave.path}`);

  // ── quick same-session summary for THIS model ──
  log('\n' + '='.repeat(96));
  log(`SUMMARY — ${modelId} (target: ${target || 'unrecognized'})`);
  log('-'.repeat(96));
  log(`  VISION:   avgScore=${visionSummary.avgScore}/5  tok/s=${visionSummary.tokPerSec}  timeouts=${visionSummary.timeouts}/${VISION_TASKS.length + 1}`);
  log(`  AGENTIC:  avgScore=${agenticSummary.avgScore}/5  tok/s=${agenticSummary.tokPerSec}`);
  log(`  CREATIVE: avgScore=${creativeSummary.avgScore}/5  tok/s=${creativeSummary.tokPerSec}  consistency-stability=${creativeConsistency.stability}/5`);
  log('-'.repeat(96));
  log('Next: load a DIFFERENT model in LM Studio on degitaar, then re-run this exact script with no');
  log('flags (`node scripts/benchmark-models-v2.mjs`) — results accumulate across invocations.');
  log('Once >=2 models have data, run `node scripts/benchmark-models-v2.mjs --compare` for the full table.');
  log('='.repeat(96));
}

main().catch((e) => {
  console.error('benchmark failed:', e);
  process.exit(1);
});
