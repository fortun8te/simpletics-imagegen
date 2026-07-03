// lib/planner.mjs — the Plan mode brain (BRIEF Phase 1).
//
// One planner agent, 100% visible: every step is pushed through onStep() and the server
// broadcasts it over SSE as a `plan` event, so the PlanView rail streams the run live.
// Hard cap 15 steps. One run at a time.
//
// Model routing per the BRIEF: classify + rank are RULES (fast, free, deterministic);
// only hypothesis/brief writing uses a frontier call — through the user's own codex CLI
// (lib/codex-text.mjs), with a deterministic template fallback so a rate-limited codex
// never fails the run. TrendTrack is read from the LOCAL cache only (0 credits) — imports
// stay a separate, explicit user action.
//
// Two flows (both land on the same proposal shape):
//   brief → refs : rank cached ads against the brief text, then write hypothesis + prompts
//   refs  → brief: read the picked cached ads, then write hypothesis + prompts from them
//
// The run returns a PROPOSAL — hypothesis, ranked refs, prompt drafts. It never writes
// config.json itself; the user applies drafts from the UI (human-in-the-loop by design).

import * as ttCache from './trendtrack-cache.mjs';
import { boostFor } from './taste.mjs';
import { codexText } from './codex-text.mjs';
import { llmText, hasLlm } from './llm.mjs';

const MAX_STEPS = 15;

// ── ad-type classification (rules — BRIEF: "Rules + small LLM", rules are enough here) ────────────
const TYPE_RULES = [
  { type: 'carousel', re: /carousel|slide|2x2|3x3|grid/i },
  { type: 'ugc', re: /ugc|ugly|candid|selfie|iphone photo|first-person|phone photo/i },
  { type: 'offer', re: /offer|% ?off|discount|sale|price|bundle|free shipping/i },
  { type: 'native', re: /native|testimonial|review|quote|customer/i },
];

/** Classify an ad/copy blob into native|static|offer|carousel|ugc|face. Deterministic. */
export function classifyAdType({ kind, type, title, text } = {}) {
  if (kind === 'face') return 'face';
  const hay = [type, title, text].filter(Boolean).join(' ');
  for (const r of TYPE_RULES) if (r.re.test(hay)) return r.type;
  return 'static';
}

// ── ref ranking (token overlap + signals + taste) ─────────────────────────────────────────────────
const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'for', 'with', 'your', 'you', 'our', 'this', 'that', 'its', 'is', 'are', 'was', 'to', 'of', 'in', 'on', 'at', 'it', 'de', 'la', 'le']);
const tokens = (s) => String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2 && !STOP.has(t));

/** Rank cached TrendTrack ads against a text query. 0 credits — local cache only.
 *  Score = token overlap (hook ×2, body ×1) + scaling/proven bonus + taste boost. */
export function rankRefs(query, { brand = null, adType = null, limit = 12 } = {}) {
  const q = new Set(tokens(query));
  const brands = brand ? [brand] : ttCache.listBrands().map((b) => b.brand);
  const scored = [];
  for (const b of brands) {
    const hit = ttCache.getCachedBrand(b, { ttlMs: Infinity }); // ranking never expires the cache
    for (const ad of hit?.ads || []) {
      if (adType && classifyAdType({ type: ad.media_type, title: ad.hook, text: ad.primary_text }) !== adType) continue;
      let score = 0;
      for (const t of tokens(ad.hook)) if (q.has(t)) score += 2;
      for (const t of tokens(ad.primary_text)) if (q.has(t)) score += 1;
      if (ad.scaling_verdict === 'scaling') score += 3;
      else if (ad.scaling_verdict === 'proven') score += 1.5;
      score += boostFor(`ref:${ad.id}`);
      scored.push({ ad, score });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(({ ad, score }) => ({
    id: ad.id, brand: ad.brand, hook: ad.hook, primary_text: ad.primary_text,
    scaling_verdict: ad.scaling_verdict, reach: ad.reach, days_running: ad.days_running,
    cta: ad.cta, media_type: ad.media_type, local_image: ad.local_image,
    score: Math.round(score * 10) / 10,
  }));
}

// ── prompt wrapper (deterministic template — nanox-batch style rules) ─────────────────────────────
function wrapPrompt(hook, { adType, product = 'the product' }) {
  if (adType === 'ugc' || adType === 'native') {
    return `Real candid phone photo, authentic UGC, vertical 9:16 portrait crop. ${hook}. `
      + `Slightly soft focus, a touch of motion blur, visible JPEG compression and sensor noise, `
      + `imperfect framing a little too close and off-centre, everyday home lighting — not studio, `
      + `not color-graded, not a polished ad. ${product} visible naturally in frame, label readable.`;
  }
  if (adType === 'offer') {
    return `Clean studio product shot for a direct-response offer static. ${hook}. `
      + `${product} hero-centered on a simple seamless background, crisp label, strong single light `
      + `with soft shadow, generous negative space top and bottom for headline and price overlays.`;
  }
  return `High-quality lifestyle product photograph. ${hook}. ${product} in a real environment, `
    + `natural light, editorial composition with clear space for copy overlay, label readable.`;
}

// ── hypothesis (frontier via codex; template fallback) ────────────────────────────────────────────
function fallbackHypothesis(briefText, refs) {
  const hooks = refs.slice(0, 3).map((r) => r.hook).filter(Boolean);
  return [
    `Angle: ${briefText.split(/[.\n]/)[0].trim()}.`,
    hooks.length ? `What's working nearby (cached refs): ${hooks.map((h) => `“${h}”`).join(' · ')}.` : null,
    `Recommendation: lead with the concrete daily-pain moment, prove it with a real-person visual, keep copy under 12 words.`,
  ].filter(Boolean).join('\n');
}

async function writeHypothesis(briefText, refs, emit) {
  const refLines = refs.slice(0, 5).map((r) =>
    `- [${r.scaling_verdict}] ${r.hook || '(no hook)'} — ${String(r.primary_text || '').slice(0, 120)}`).join('\n');
  const prompt =
    `You are an ads strategist. Brief: "${briefText}".\n`
    + `Competitor ads that are running (style reference only — do NOT copy them):\n${refLines || '(none cached)'}\n`
    + `Write, in under 130 words total, plain text: 1) the angle hypothesis (one sentence), `
    + `2) three hook lines (one per line, <=10 words each), 3) one format recommendation. `
    + `Same energy as the refs, never the same layout or wording.`;
  if (hasLlm()) {
    const jsonPrompt = `${prompt}\nReply as a JSON object: {"text":"<the plain-text answer, newlines allowed>"}`;
    const l = await llmText(jsonPrompt, { purpose: 'plan-hypothesis', json: true, timeoutMs: 60_000 });
    if (l.ok && l.text) {
      let text = l.text;
      try { const o = JSON.parse(l.text); if (o && typeof o.text === 'string') text = o.text; } catch { /* use raw */ }
      return { text, source: 'llm' };
    }
    emit('write_hypothesis', `llm unavailable (${l.error}) — trying codex`, null);
  }
  const r = await codexText(prompt, { timeoutMs: 90_000 });
  if (r.ok && r.text) return { text: r.text, source: 'codex' };
  emit('write_hypothesis', `codex unavailable (${r.error}) — using template fallback`, null);
  return { text: fallbackHypothesis(briefText, refs), source: 'fallback' };
}

// ── the run ───────────────────────────────────────────────────────────────────────────────────────
let activeRun = null; // { id, steps, done, result } — one at a time, kept for GET polling

export function getActiveRun() { return activeRun; }

/**
 * Run the planner. mode 'brief' (brief → refs) or 'refs' (refs → brief).
 * opts: { brief?, refIds?, brand?, adType?, product? }. onStep(step) fires per step (→ SSE).
 * Returns the completed run { id, steps, result }.
 */
export async function runPlan(opts = {}, onStep = () => {}) {
  if (activeRun && !activeRun.done) throw new Error('a plan run is already active');
  const id = `plan_${Date.now().toString(36)}`;
  const steps = [];
  activeRun = { id, steps, done: false, result: null, startedAt: Date.now() };

  const emit = (tool, summary, data = null) => {
    if (steps.length >= MAX_STEPS) return;
    const step = { i: steps.length + 1, tool, summary, data, at: Date.now() };
    steps.push(step);
    onStep({ runId: id, step });
  };

  try {
    const mode = opts.mode === 'refs' ? 'refs' : 'brief';
    const briefText = String(opts.brief || '').trim();
    const product = String(opts.product || 'the product');

    // 1 — TrendTrack balance (free) + cache overview. Never a metered call inside a run.
    const brands = ttCache.listBrands();
    emit('get_usage', `cache: ${brands.length} brand(s), ${brands.reduce((n, b) => n + b.count, 0)} ads local · imports are a separate explicit action`, { brands });

    // 2 — classify the working ad type.
    const adType = opts.adType || classifyAdType({ text: briefText });
    emit('classify_ad_type', `ad type: ${adType}`, { adType });

    // 3 — refs.
    let refs = [];
    if (mode === 'refs') {
      refs = (opts.refIds || []).map((rid) => ttCache.getAd(rid)).filter(Boolean).map((ad) => ({
        id: ad.id, brand: ad.brand, hook: ad.hook, primary_text: ad.primary_text,
        scaling_verdict: ad.scaling_verdict, reach: ad.reach, days_running: ad.days_running,
        cta: ad.cta, media_type: ad.media_type, local_image: ad.local_image, score: null,
      }));
      emit('read_refs', `read ${refs.length} picked ref(s) from cache (0 credits)`, { refs });
    } else {
      refs = rankRefs(briefText, { brand: opts.brand || null, limit: 12 });
      emit('search_cached_refs', `ranked ${refs.length} cached ref(s) against the brief (0 credits)`, { refs });
    }

    // 4 — hypothesis (the one frontier step; falls back to template).
    const seed = briefText || refs.map((r) => r.hook).filter(Boolean).slice(0, 3).join(' / ') || 'the product story';
    const hyp = await writeHypothesis(seed, refs, emit);
    emit('write_hypothesis', `hypothesis written (${hyp.source})`, { hypothesis: hyp.text, source: hyp.source });

    // 5 — hook lines out of the hypothesis (lines that read like hooks), then prompt drafts.
    const hookLines = hyp.text.split('\n').map((l) => l.replace(/^[\s\-•\d).]+/, '').trim())
      .filter((l) => l
        && l.length <= 90
        && !l.endsWith(':')                                   // section headers ("Hooks:")
        && !/^(angle|format|recommendation|what|hooks?)\b/i.test(l))
      .slice(0, 3);
    const hooks = hookLines.length ? hookLines : [seed.slice(0, 80)];
    const prompts = hooks.map((h, i) => ({
      id: `draft-${i + 1}`,
      hook: h,
      prompt: wrapPrompt(h, { adType, product }),
    }));
    emit('write_prompt', `${prompts.length} generation prompt draft(s) written (template wrapper)`, { prompts });

    // 6 — done.
    const result = { mode, adType, brief: briefText, hypothesis: hyp.text, hypothesisSource: hyp.source, refs, prompts };
    emit('done', 'proposal ready — apply drafts from the rail', null);
    activeRun = { ...activeRun, done: true, result, finishedAt: Date.now() };
    onStep({ runId: id, done: true, result });
    return activeRun;
  } catch (e) {
    const error = String(e && e.message || e);
    emit('error', error, null);
    activeRun = { ...activeRun, done: true, error, finishedAt: Date.now() };
    onStep({ runId: id, done: true, error });
    return activeRun;
  }
}
