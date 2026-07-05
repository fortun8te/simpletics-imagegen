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
//
// v7 — ORCHESTRATOR-WORKER FAN-OUT + a shared step vocabulary:
//   • runFanOut() — a lead decomposes work into ≤3 INDEPENDENT subtasks, runs them CONCURRENTLY
//     (each its own llmText/llmVision call against ornith — LM Studio serves PARALLEL=4, so 2-3
//     concurrent local calls are safe), then gathers. Emits one `subagent` step per worker with a
//     STABLE id, short title, the model label, a live substatus line, and start/done phases — so a
//     single UI activity component can list the workers. Falls back to a single call when a task
//     doesn't decompose (the caller decides via decompose()).
//   • makerChecker() — a cheap maker-checker verify: one pass GENERATES, a second VALIDATES/repairs.
//   • STEP_KINDS — the ONE progress/step vocabulary shared by every flow that streams through this
//     harness (the design-edit agent AND the reference-build/extraction path), so both render
//     identically. `thinking` (plan/narration) · `op` (an applied action + its summary) ·
//     `subagent` (a fan-out worker's lifecycle) · `verify` (the terminal maker-checker/summary).
//
// These are ADDITIVE: runBatchAgent is unchanged and remains the default single-agent path.

import { llmText } from './llm.mjs';

// The single step/event vocabulary every harness-driven flow emits. The frontend renders ONE
// activity component off these kinds — edit runs and reference-build runs look identical.
export const STEP_KINDS = ['thinking', 'op', 'subagent', 'verify'];

// Monotonic per-process counter so every spawned sub-agent gets a stable, unique id even when
// several fan-outs run back to back. `sa1`, `sa2`, … — short enough for tiny models to echo, and
// stable across the worker's start→update→done lifecycle so the UI can key its row on it.
let saSeq = 0;
export function nextSubAgentId(prefix = 'sa') { return `${prefix}${++saSeq}`; }

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
  // CONTEXT BUDGET (v7): a HARD ceiling (est tokens = chars/4) on the assembled per-turn PROMPT
  // (system + observation + last-turn feedback + lint + ask). ornith's window is ~60k; we keep a
  // turn well under it with a safe default so a huge comp (100+ layers) can never blow the window.
  // The guard prunes the OLDEST/least-critical context first (last-turn feedback), then truncates
  // the observation, so the current scene + the ask always survive. Set 0 to disable (tests).
  contextBudgetTokens = 12_000,
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
  let doneRejections = 0;  // times "done" was rejected by the lint gate (HARNESS-12 escalation)
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
  // failure; the retry gets 2× headroom. Ornith is a REASONING model that needs real room to
  // think THEN emit, so the ceiling is 8192 (a 4096 cap still truncated ornith mid-think). Unused
  // budget isn't billed locally.
  const bumpedCap = Math.min(Math.max(Math.round(maxTokensPerTurn * 2), 8000), 8192);
  // est-tokens of a string (chars/4, the same cheap model used everywhere in this harness).
  const est = (s) => Math.ceil(String(s || '').length / 4);

  const callModel = async (extra, { maxTokens = maxTokensPerTurn } = {}) => {
    const observation = buildObservation();
    const findings = lint ? lint() : [];
    const lintKey = findings.join('|');
    if (lintKey === lastLintKey && findings.length) lintShownTurns++;
    else lintShownTurns = findings.length ? 1 : 0;
    lastLintKey = lintKey;
    // degraded mode after a zero-applied turn: ask for ONE op — same code path, simpler reply
    // (weak models recover from a wasted turn far more reliably with a single-op ask)
    const opCap = zeroAppliedTurns > 0 ? 1 : maxOpsPerTurn;
    const askLine = extra || `Reply with ONE JSON object: {"plan":"…","ops":[…up to ${opCap} op${opCap === 1 ? '' : 's'}…],"done":true|false}. No prose.`;

    // ── CONTEXT-BUDGET GUARD (v7) ────────────────────────────────────────────────────────────────
    // Assemble the prompt sections with priorities, then prune to fit contextBudgetTokens (system +
    // sections). CRITICAL sections (the ask + the current observation) always survive; the OLDEST/
    // least-critical (last-turn feedback) is trimmed/dropped FIRST, then the observation is
    // truncated as a last resort. Guarantees a turn never exceeds ornith's ~60k window.
    let feedback = lastFeedback;
    let obs = observation;
    const budgetChars = (contextBudgetTokens > 0 ? contextBudgetTokens : Infinity) * 4;
    if (Number.isFinite(budgetChars)) {
      const fixedChars = est(system) * 4 + askLine.length + (findings.length ? 200 + findings.slice(0, 6).join('').length : 0) + 64;
      let avail = budgetChars - fixedChars;
      // 1) prune last-turn feedback oldest-first until it fits its share (leave ≥40% for the obs)
      const feedbackCap = Math.max(0, Math.floor(avail * 0.35));
      let fbText = feedback.length ? feedback.map((s, i) => `${i + 1}. ${s}`).join('\n') : '';
      while (fbText.length > feedbackCap && feedback.length) {
        feedback = feedback.slice(1); // drop the OLDEST feedback line
        fbText = feedback.length ? feedback.map((s, i) => `${i + 1}. ${s}`).join('\n') : '';
      }
      avail -= fbText.length;
      // 2) hard-truncate the observation if it (somehow) still overflows the remaining budget.
      // When the SYSTEM prompt alone already eats the whole budget (avail ≤ 0, e.g. the ~2800-token
      // edit prompt against a 3000 budget), `avail` can't be the truncation target or the full
      // observation would ship unpruned and blow the window (the exact failure the guard exists to
      // prevent). Clamp to a hard MINIMUM obs window so the current scene always survives AND is
      // always bounded — the current instruction + ask are in fixedChars and never pruned.
      const minObsChars = Math.min(obs.length, Math.max(600, Math.floor(budgetChars * 0.12)));
      const obsCap = Math.max(avail, minObsChars);
      if (obs.length > obsCap) {
        obs = `⚠ STATE TRUNCATED to fit the context budget — the scene below is INCOMPLETE. Reference ONLY node ids you can see; never invent or guess ids beyond this list.\n${obs.slice(0, Math.max(0, obsCap - 40))}\n…(truncated)`;
      }
    }

    const assemble = () => {
      const parts = [`CURRENT STATE:\n${obs}`];
      if (feedback.length) parts.unshift(`LAST TURN RESULTS:\n${feedback.map((s, i) => `${i + 1}. ${s}`).join('\n')}`);
      if (findings.length) parts.push(`LINT (fix before done):\n${findings.slice(0, 6).map((f, i) => `${i + 1}) ${f}`).join('\n')}`);
      parts.push(askLine);
      return parts.join('\n\n');
    };
    let prompt = assemble();
    // FINAL EXACT CLAMP: the arithmetic above works from an ESTIMATE of the fixed sections and
    // historically drifted a few dozen tokens over budget as prompt text evolved (section headers
    // and joiners aren't in fixedChars — observed 3014/3025 vs a 3000 budget). Enforce the budget
    // as a hard invariant on the ASSEMBLED prompt: shave the observation by the real overage.
    if (Number.isFinite(budgetChars)) {
      const overChars = (prompt.length + (system || '').length) - budgetChars;
      if (overChars > 0 && obs.length > overChars + 60) {
        const alert = obs.startsWith('⚠ STATE TRUNCATED') ? '' : '⚠ STATE TRUNCATED to fit the context budget — reference ONLY node ids you can see below.\n';
        obs = `${alert}${obs.slice(0, Math.max(0, obs.length - overChars - 60 - alert.length))}\n…(truncated)`;
        prompt = assemble();
      }
    }
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
      // ESCALATION (HARNESS-12): a model that keeps declaring done WITHOUT applying fixes is stuck
      // in a rejection loop — after 3 rejections with nothing applied in between, stop burning
      // turns and exit with an explicit verdict (callers run their deterministic repair/autolayout
      // fallbacks post-loop; looping to MAX_TURNS here just wasted latency).
      doneRejections += 1;
      if (doneRejections >= 3 && appliedThisTurn === 0) {
        emit('thinking', `done rejected ${doneRejections}× with no fixes applied — escalating to deterministic fallback (${post.slice(0, 2).join(' · ')})`);
        stoppedBy = 'lint-stuck';
        break;
      }
      lastFeedback.push(`done rejected — lint still has ${post.length} finding(s); fix EXACTLY these, then done: ${post.slice(0, 3).join(' · ')}`);
      emit('thinking', `done rejected: ${post.length} lint finding(s) remain`);
    }
    if (zeroAppliedTurns >= 2) { stoppedBy = 'skips'; break; }
  }

  if (signal?.aborted) stoppedBy = 'aborted';
  return { ok: applied > 0 || stoppedBy === 'done', steps, applied, turns, source: 'llm', usage, stoppedBy };
}

// ── Bounded-concurrency map ────────────────────────────────────────────────────────────────────
// Run `fn(item, i)` over `items` with at most `limit` in flight at once. Preserves input order in
// the returned results array; a worker that throws yields { ok:false, error } in its slot (never
// rejects the whole batch). Cap is hard: LM Studio serves ornith at PARALLEL=4, so ≤3 keeps a lane
// free for the lead/other traffic.
export async function mapConcurrent(items, limit, fn) {
  const list = Array.from(items || []);
  const cap = Math.max(1, Math.min(3, limit | 0 || 1));
  const results = new Array(list.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= list.length) return;
      try { results[i] = await fn(list[i], i); }
      catch (e) { results[i] = { ok: false, error: String(e?.message || e) }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(cap, list.length) }, worker));
  return results;
}

/**
 * ORCHESTRATOR-WORKER FAN-OUT.
 *
 * A lead has already DECOMPOSED a job into ≤3 independent subtasks (the caller supplies them —
 * this function does not itself decide whether a task decomposes; it just runs the fan-out once a
 * decomposition exists, and the caller falls back to the normal single loop when it doesn't).
 * Each subtask runs CONCURRENTLY as its own sub-agent (its own llm call), and every sub-agent's
 * lifecycle is streamed as `subagent` steps sharing the unified vocabulary.
 *
 * subtasks: [{ id?, title, run(ctx) }]  — `run` receives { id, title, update(line), model } and
 *           returns whatever the caller wants gathered (a result object; may include { ok, ... }).
 *           `update(line)` emits a live substatus line for that worker's row.
 * onStep:   (step) => void — receives {kind:'subagent', ...} frames (start / update / done).
 * model:    the model label to stamp on every worker row (e.g. 'ornith' / llmInfo().model).
 * concurrency: hard-capped at 3.
 * parentRunId: threaded onto every subagent frame so the UI can group workers under their run.
 *
 * Returns { results:[…in subtask order…], ok:boolean }. Never throws for a worker failure.
 */
export async function runFanOut({
  subtasks = [],
  onStep = () => {},
  model = 'ornith',
  concurrency = 3,
  parentRunId = null,
  signal = null,
} = {}) {
  const tasks = (Array.isArray(subtasks) ? subtasks : []).filter((t) => t && typeof t.run === 'function').slice(0, 3);
  if (!tasks.length) return { results: [], ok: false };

  const emitSub = (id, title, phase, status) => {
    try {
      onStep({
        i: 0, kind: 'subagent', at: Date.now(),
        summary: status ? `${title}: ${status}` : title,
        data: { id, title, model, status: status || '', phase, parentRunId },
      });
    } catch { /* observer only — a bad sink must never break the fan-out */ }
  };

  const results = await mapConcurrent(tasks, Math.min(3, concurrency), async (t) => {
    const id = t.id || nextSubAgentId();
    const title = String(t.title || 'subtask').slice(0, 60);
    emitSub(id, title, 'start', 'started');
    const update = (line) => emitSub(id, title, 'update', String(line || '').slice(0, 120));
    let out;
    try {
      if (signal?.aborted) throw new Error('aborted');
      out = await t.run({ id, title, update, model, signal });
      const okFlag = !(out && typeof out === 'object' && out.ok === false);
      emitSub(id, title, 'done', okFlag ? 'done' : `failed: ${(out && out.error) || 'error'}`);
    } catch (e) {
      out = { ok: false, error: String(e?.message || e) };
      emitSub(id, title, 'done', `failed: ${out.error}`);
    }
    return out;
  });

  const ok = results.some((r) => !(r && typeof r === 'object' && r.ok === false));
  return { results, ok };
}

/**
 * MAKER-CHECKER verify (cheap, one extra pass). `make()` produces a candidate; `check(candidate)`
 * validates it and returns { ok, findings?, fixed? }. When the check fails and returns a `fixed`
 * candidate, that repaired candidate is used. Purely a convenience wrapper so both flows share the
 * same generate-then-validate shape without each re-implementing it. Never throws — a checker
 * failure degrades to accepting the maker's output as-is.
 */
export async function makerChecker(make, check) {
  const candidate = await make();
  if (typeof check !== 'function') return { candidate, ok: true, findings: [] };
  try {
    const verdict = await check(candidate);
    if (verdict && verdict.ok) return { candidate, ok: true, findings: verdict.findings || [] };
    return {
      candidate: (verdict && verdict.fixed != null) ? verdict.fixed : candidate,
      ok: false,
      findings: (verdict && verdict.findings) || [],
    };
  } catch (e) {
    return { candidate, ok: true, findings: [`checker error: ${String(e?.message || e)}`] };
  }
}
