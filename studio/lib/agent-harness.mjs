// lib/agent-harness.mjs — v3: a BATCHED plan-act-verify loop.
//
// One LLM turn = one JSON object {"plan":"…","ops":[…],"done":bool}. Ops are validated and
// applied in order; a bad op never wastes the turn — its error is reported per-op in the next
// turn's feedback block alongside the successes. Whole compact state is re-sent every turn
// (research: observation *diffs* are where weak models fail — Aider edit-format data; an ad
// scene serializes to a few hundred tokens, so full-state resend is cheap and unambiguous).
// In-loop verification: opts.lint() runs after every turn; findings are appended as LINT:
// lines, and "done" is only accepted when lint is clean or the model has seen the findings
// for two consecutive turns (prevents both premature stops and infinite lint-chasing).
//
// Degraded mode for very small models = maxOpsPerTurn: 1 — same code path, not a fork.
// Parsing stays tolerant (code fences, surrounding prose, bare op objects); a fully
// unparsable reply gets ONE same-turn retry quoting the error.

import { llmText } from './llm.mjs';

/** Strip code fences and pull the first balanced {...} JSON object out of a model reply. */
export function parseOneOp(text) {
  let s = String(text || '').trim();
  s = s.replace(/```(?:json)?/gi, '');
  const start = s.indexOf('{');
  if (start === -1) return { op: null, error: 'no JSON object found in reply' };
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try { return { op: JSON.parse(s.slice(start, i + 1)), error: null }; }
        catch (e) { return { op: null, error: `invalid JSON: ${e.message}` }; }
      }
    }
  }
  return { op: null, error: 'unbalanced JSON object in reply' };
}

/**
 * Parse one batch turn: {"plan","ops":[…],"done"}. Tolerates a bare single op object
 * (treated as a one-op batch) so degraded/legacy replies still work.
 */
export function parseBatch(text) {
  const { op: obj, error } = parseOneOp(text);
  if (!obj) return { plan: '', ops: [], done: false, error };
  if (Array.isArray(obj.ops)) {
    return {
      plan: typeof obj.plan === 'string' ? obj.plan.slice(0, 300) : '', // talkative: 1-2 sentences shown live
      ops: obj.ops.filter((o) => o && typeof o === 'object').map(normalizeOp),
      done: obj.done === true,
      error: null,
    };
  }
  // bare op object (legacy one-op reply)
  if (typeof obj.op === 'string' || typeof obj.operation === 'string') {
    const op = normalizeOp(obj);
    const done = op.op === 'done';
    return { plan: '', ops: done ? [] : [op], done, error: null, doneSummary: done ? op.summary : undefined };
  }
  return { plan: '', ops: [], done: false, error: 'reply has neither "ops" array nor an "op" field' };
}

/** Numeric/observation-index ids → alias form (2 → "L2") that resolveNode understands. */
function normalizeId(v) {
  if (typeof v === 'number' && Number.isInteger(v)) return `L${v}`;
  if (typeof v === 'string' && /^\d+$/.test(v)) return `L${v}`;
  return v;
}

/**
 * Tolerate the op-schema variants weak models drift into (observed live with deepseek-v4-flash):
 *   {"operation":"modify","id":2,"changes":{"text":"…"}}  → {"op":"setText","id":"L2","text":"…"}
 *   {"op":"update"/"edit","...}                           → mapped by the field it carries
 *   {"id":2,...}                                          → {"id":"L2",...}
 * Only reshapes clearly-recognizable variants; anything else passes through unchanged so the
 * existing per-op validation still reports precise errors.
 */
export function normalizeOp(raw) {
  if (!raw || typeof raw !== 'object') return raw;
  let op = { ...raw };
  // op vs operation
  if (typeof op.op !== 'string' && typeof op.operation === 'string') { op.op = op.operation; delete op.operation; }
  // id normalization (also common: target / layer / layerId)
  const idKey = ['id', 'target', 'layer', 'layerId'].find((k) => op[k] != null && typeof op[k] !== 'object');
  if (idKey) { op.id = normalizeId(op[idKey]); if (idKey !== 'id') delete op[idKey]; }
  // a "changes"/"props" bag → flatten onto the op, then infer the specific op verb
  const bag = (op.changes && typeof op.changes === 'object') ? op.changes
    : (op.props && typeof op.props === 'object') ? op.props : null;
  if (bag) {
    op = { ...op, ...bag };
    delete op.changes; delete op.props;
  }
  // generic verbs (modify/update/edit/change/set) → the specific op implied by the fields present
  if (/^(modify|update|edit|change|set)$/i.test(op.op || '')) {
    if (typeof op.text === 'string') op.op = 'setText';
    else if (op.style && typeof op.style === 'object') op.op = 'setStyle';
    else if (op.x != null || op.y != null) op.op = 'move';
    else if (op.w != null || op.h != null) op.op = 'resize';
    else if (op.params && typeof op.params === 'object') op.op = 'setParams';
  }
  return op;
}

/**
 * Run the batched plan-act-verify loop.
 *   system            — full system prompt (batch protocol + ops schema + few-shot examples).
 *   buildObservation()— returns the CURRENT compact scene state (called fresh every turn).
 *   applyOp(op)       — apply one op; may be async. Return a summary string,
 *                       {done:true, summary?} for a stop op, or throw with an explanatory
 *                       message (the error is fed back per-op next turn). A null return is
 *                       treated as "op was rejected as invalid".
 *   lint()            — optional; returns finding strings after each turn. Injected as LINT:
 *                       lines; gates "done" (clean lint, or findings shown for 2 turns).
 *   maxTurns          — LLM calls (excl. one same-turn parse retry). Default 8.
 *   maxOpsPerTurn     — ops applied per turn (extra ops are dropped with a note). Default 4;
 *                       set 1 for degraded tiny-model mode.
 * Returns { ok, steps, applied, turns, source:'llm', usage:{inTok,outTok,estTokens}, stoppedBy }.
 */
export async function runBatchAgent({
  system,
  buildObservation,
  applyOp,
  lint = null,
  maxTurns = 8,
  maxOpsPerTurn = 4,
  timeoutMsPerTurn = 60_000,
  onStep = () => {},
  purpose = 'ops-agent',
  signal = null,
  llmCall = llmText,
  // Reasoning models (deepseek-v4-flash) burn 400–650 tokens THINKING before the JSON — a low
  // cap truncates mid-reasoning and returns an empty completion (→ silent autolayout fallback,
  // the model contributes nothing). Headroom is cheap: unused budget isn't billed.
  maxTokensPerTurn = 3000,
  maxApplied = null,
  // Main-turn VISION (v6): when the active model can see (LM Studio serving a gemma VL model),
  // SHOW it the canvas instead of only describing it. `imageForTurn(turnIndex)` returns a PNG
  // path (or null to skip) and `visionCall(prompt, imagePath, opts)` shares llmText's contract.
  // Failures fall back silently to the text-only call — vision is an upgrade, never a gate.
  visionCall = null,
  imageForTurn = null,
} = {}) {
  const steps = [];
  const usage = { inTok: 0, outTok: 0, estTokens: 0 };
  let applied = 0;
  let turns = 0;
  let stoppedBy = 'maxTurns';
  let lastFeedback = [];   // per-op results from the previous turn (successes AND errors)
  let lintShownTurns = 0;  // consecutive turns the current lint findings have been visible
  let lastLintKey = '';
  let zeroAppliedTurns = 0;

  const emit = (kind, summary, data = null) => {
    summary = String(summary || '').slice(0, 300); // room for talkative plans + op feedback
    const step = { i: steps.length + 1, kind, summary, at: Date.now(), data };
    steps.push(step);
    onStep(step);
    return step;
  };

  // Retry cap bump: every observed harness call failure in .state/llm-usage.jsonl had outTok
  // EXACTLY at the completion cap (220/300/700/2500/3000) — the model burned the whole budget
  // thinking and the completion was truncated/empty. Retrying at the SAME cap just repeats the
  // failure; the retry gets 1.5× headroom (≤4096). Unused budget isn't billed.
  const bumpedCap = Math.min(Math.round(maxTokensPerTurn * 1.5), 4096);

  const callModel = async (extra, { maxTokens = maxTokensPerTurn } = {}) => {
    const parts = [`CURRENT STATE:\n${buildObservation()}`];
    if (lastFeedback.length) parts.unshift(`LAST TURN RESULTS:\n${lastFeedback.map((s, i) => `${i + 1}. ${s}`).join('\n')}`);
    const findings = lint ? lint() : [];
    const lintKey = findings.join('|');
    if (lintKey === lastLintKey && findings.length) lintShownTurns++;
    else lintShownTurns = findings.length ? 1 : 0;
    lastLintKey = lintKey;
    if (findings.length) parts.push(`LINT (fix before done):\n${findings.slice(0, 6).map((f, i) => `${i + 1}) ${f}`).join('\n')}`);
    // degraded mode after a zero-applied turn: ask for ONE op — same code path, simpler reply
    // (weak models recover from a wasted turn far more reliably with a single-op ask)
    const opCap = zeroAppliedTurns > 0 ? 1 : maxOpsPerTurn;
    parts.push(extra || `Reply with ONE JSON object: {"plan":"…","ops":[…up to ${opCap} op${opCap === 1 ? '' : 's'}…],"done":true|false}. No prose.`);
    const prompt = parts.join('\n\n');
    usage.estTokens += Math.ceil((prompt.length + (system || '').length) / 4);
    turns++;
    let r = null;
    if (visionCall && imageForTurn) {
      // show the model the actual render for this turn (usually just turn 0 — see design-agent);
      // any render/vision failure degrades to the plain text call below.
      let img = null;
      try { img = await imageForTurn(turns - 1); } catch { img = null; }
      if (img) {
        const vp = `The attached image is the CURRENT RENDER of the comp — trust your eyes for placement/contrast/overlap.\n\n${prompt}`;
        try { r = await visionCall(vp, img, { system, timeoutMs: timeoutMsPerTurn, purpose, json: true, maxTokens }); } catch { r = null; }
        if (r && !r.ok) r = null; // vision path failed → retry text-only, same turn
      }
    }
    if (!r) r = await llmCall(prompt, { system, timeoutMs: timeoutMsPerTurn, purpose, json: true, signal, maxTokens });
    if (r.usage) { usage.inTok += r.usage.inTok || 0; usage.outTok += r.usage.outTok || 0; }
    return { r, findings };
  };

  for (let turn = 0; turn < maxTurns; turn++) {
    if (signal?.aborted) { stoppedBy = 'aborted'; break; }

    let { r, findings } = await callModel();
    if (!r.ok) {
      // Reasoning models (deepseek-v4-flash) intermittently return an EMPTY completion after a
      // long think in json_mode — a known transient. One retry (with a bumped completion cap —
      // see bumpedCap above) recovers it; only a second consecutive failure ends the run
      // (was: first failure killed it → silent no-op run).
      emit('thinking', `model call failed (${r.error}) — retrying once with more headroom`);
      ({ r, findings } = await callModel('Reply with ONE JSON object {"plan":"…","ops":[…],"done":bool} only. No prose, no empty reply.', { maxTokens: bumpedCap }));
      if (!r.ok) {
        emit('thinking', `model call failed again: ${r.error}`);
        stoppedBy = 'llm-error';
        break;
      }
    }

    let batch = parseBatch(r.text);
    if (batch.error) {
      // one same-turn retry quoting the parse error; "unbalanced" JSON is the truncation
      // signature (reply cut mid-object at the cap) → the retry also gets the bumped cap
      const truncated = /unbalanced/.test(batch.error);
      const retry = await callModel(
        `Your last reply was invalid: ${batch.error}. Reply with ONE JSON object {"plan":"…","ops":[…],"done":bool} only.`,
        truncated ? { maxTokens: bumpedCap } : {},
      );
      if (!retry.r.ok) { emit('thinking', `model call failed: ${retry.r.error}`); stoppedBy = 'llm-error'; break; }
      batch = parseBatch(retry.r.text);
      if (batch.error) {
        lastFeedback = [`your reply was unparsable: ${batch.error}`];
        emit('op', `skipped unparsable turn (${batch.error})`, { usage: { ...usage } });
        zeroAppliedTurns++;
        if (zeroAppliedTurns >= 2) { stoppedBy = 'skips'; break; }
        continue;
      }
    }

    if (batch.plan) emit('thinking', batch.plan, { plan: true });

    const feedback = [];
    let appliedThisTurn = 0;
    let doneResult = batch.done ? { done: true, summary: batch.doneSummary || batch.plan || 'done' } : null;
    const ops = batch.ops.slice(0, maxOpsPerTurn);
    if (batch.ops.length > maxOpsPerTurn) feedback.push(`(${batch.ops.length - maxOpsPerTurn} extra ops dropped — max ${maxOpsPerTurn} per turn)`);

    for (const op of ops) {
      if (signal?.aborted) break;
      try {
        const result = await applyOp(op);
        if (result && typeof result === 'object' && result.done) { doneResult = result; break; }
        if (result == null) throw new Error('op was rejected as invalid');
        const summary = typeof result === 'string' ? result : JSON.stringify(result);
        feedback.push(`ok: ${summary}`);
        applied++;
        appliedThisTurn++;
        emit('op', summary, { op, usage: { ...usage } });
        if (maxApplied != null && applied >= maxApplied) { doneResult = doneResult || { done: true, summary: 'max ops reached' }; break; }
      } catch (e) {
        const msg = String(e?.message || e);
        feedback.push(`FAILED ${op.op || '?'}: ${msg}`);
        emit('op', `skipped ${op.op || '?'}: ${msg}`, { op, failed: true, usage: { ...usage } });
      }
    }
    lastFeedback = feedback;
    zeroAppliedTurns = appliedThisTurn === 0 ? zeroAppliedTurns + 1 : 0;

    if (doneResult) {
      // done gate: lint must be clean, or the model must have seen these findings ≥2 turns
      const post = lint ? lint() : [];
      if (!post.length || lintShownTurns >= 2) {
        emit('op', doneResult.summary || 'done', { op: { op: 'done' }, usage: { ...usage } });
        stoppedBy = maxApplied != null && applied >= maxApplied ? 'maxApplied' : 'done';
        break;
      }
      lastFeedback.push(`done rejected — lint still has ${post.length} finding(s); fix them first`);
      emit('thinking', `done rejected: ${post.length} lint finding(s) remain`);
    }
    if (zeroAppliedTurns >= 2) { stoppedBy = 'skips'; break; }
  }

  if (signal?.aborted) stoppedBy = 'aborted';
  return { ok: applied > 0 || stoppedBy === 'done', steps, applied, turns, source: 'llm', usage, stoppedBy };
}
