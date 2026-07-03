// lib/llm.mjs — provider-agnostic LLM text client (OpenAI-compatible chat/completions).
//
// Default provider is DeepSeek (DEEPSEEK_API_KEY in studio/.env), but the same client works
// unchanged against any OpenAI-compatible endpoint (Ollama, LM Studio) via LLM_BASE_URL /
// LLM_MODEL / LLM_API_KEY. v4: runtime switching — the provider is resolved per call as
// runtime config (.state/llm-config.json via lib/llm-config.mjs) > env > DeepSeek default,
// so /api/llm/config changes apply without a restart. Zero-dep (node:* only). Every call —
// success or failure — appends one JSON line to .state/llm-usage.jsonl for /api/llm/usage.

import { readFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getLlmConfig, resolveLlm, DEFAULT_BASE } from './llm-config.mjs';

const STUDIO = join(dirname(fileURLToPath(import.meta.url)), '..');
const STATE_DIR = join(STUDIO, '.state');
const USAGE_FILE = join(STATE_DIR, 'llm-usage.jsonl');

// ── .env loader (same pattern as lib/trendtrack.mjs — process.env always wins) ───────────────────
function loadEnvFile() {
  const p = join(STUDIO, '.env');
  if (!existsSync(p)) return;
  try {
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (!m || line.trim().startsWith('#')) continue;
      const val = m[2].replace(/^["']|["']$/g, '');
      if (val && process.env[m[1]] === undefined) process.env[m[1]] = val;
    }
  } catch { /* unreadable .env = no key */ }
}
loadEnvFile();

// Resolution: runtime config (.state/llm-config.json) > env > DeepSeek default — re-read per
// call so /api/llm/config switches take effect immediately.
function config() {
  return resolveLlm(getLlmConfig(), process.env);
}

/** TEXT config: LM Studio (local) is the DEFAULT whenever it's reachable at all — Michael runs
 *  it with exactly one model loaded at a time (ornith9b, or now "gemma 4 12b" — whatever's
 *  actually loaded, never assume a specific name or that two models are loaded together), and
 *  wants it used over Codex/DeepSeek without having to flip a flag. So: if VISION_BASE_URL
 *  (the LM Studio endpoint) is configured AND responds to /models, route text there using
 *  whatever model id LM Studio reports as loaded — falling back to config()/DeepSeek only when
 *  LM Studio is genuinely unreachable. Force it always-on with ALL_ON_VISION=1 (now redundant
 *  but kept for explicit opt-in). */
async function textConfig() {
  const c = config();
  const vbase = process.env.VISION_BASE_URL ? String(process.env.VISION_BASE_URL).replace(/\/$/, '') : null;
  if (vbase) {
    const ids = await loadedModelIds(vbase);
    if (ids.length) {
      const model = (await activePreferredModel(vbase)) || ids[0]; // whatever's actually loaded — never a hardcoded name
      return { base: vbase, model, key: process.env.VISION_API_KEY || null, provider: 'vision-endpoint' };
    }
  }
  return c;
}

/** True when an LLM is usable RIGHT NOW (an API key, or a non-default base like a local
 *  LM Studio). A saved keyless config for a keyed provider correctly reads as false. */
export function hasLlm() {
  const { base, key } = config();
  if (!!key || base !== DEFAULT_BASE) return true;
  return !!process.env.VISION_BASE_URL; // LM Studio path: a local endpoint serves text too
}

export function llmInfo() {
  const { base, model, provider, source, key } = config();
  return { base, model, provider, source, hasKey: !!key };
}

function logUsage(entry) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    appendFileSync(USAGE_FILE, JSON.stringify(entry) + '\n');
  } catch { /* usage logging must never fail a call */ }
}

async function postChat(url, payload, headers, signal) {
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON error body */ }
  return { status: res.status, json, raw: text };
}

/**
 * One-shot text completion. Returns { ok, text, error, usage:{inTok,outTok,model,provider,ms} }.
 * Never throws (network/timeout/abort become { ok:false }).
 */
export async function llmText(prompt, {
  system = null,
  timeoutMs = 60_000,
  signal = null,
  purpose = 'general',
  json = false,
  maxTokens = 2000,
  temperature = 0,
  _noPrefer = false, // internal: skip the ornith preference (used for the ornith→DeepSeek fallback)
} = {}) {
  // LM Studio is the DEFAULT text route whenever it's reachable (textConfig() detects this via
  // /models); _noPrefer forces the plain resolved config (used for the LM-Studio→DeepSeek retry
  // below when the loaded model itself fails to answer).
  let { base, model, key, provider } = _noPrefer ? config() : await textConfig();
  const usedPreferred = !_noPrefer && provider === 'vision-endpoint';
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
  const onAbort = () => ctrl.abort(signal.reason || new Error('aborted'));
  if (signal) {
    if (signal.aborted) ctrl.abort(signal.reason || new Error('aborted'));
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  const messages = [];
  if (system) messages.push({ role: 'system', content: String(system) });
  messages.push({ role: 'user', content: String(prompt) });
  const payload = {
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
    stream: false,
  };
  if (json) payload.response_format = { type: 'json_object' };

  const headers = { 'Content-Type': 'application/json' };
  if (key) headers.Authorization = `Bearer ${key}`;

  const finish = (ok, text, error, usage) => {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
    const ms = Date.now() - started;
    const u = { inTok: usage?.prompt_tokens || 0, outTok: usage?.completion_tokens || 0, model, provider, ms };
    logUsage({ at: Date.now(), provider, model, purpose, inTok: u.inTok, outTok: u.outTok, ms, ok });
    return { ok, text, error, usage: u };
  };
  // ornith→DeepSeek fallback: if the preferred local model failed (e.g. couldn't load), retry once
  // on the base text config so the design agent never stalls.
  const fallbackToBase = () => {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
    return llmText(prompt, { system, timeoutMs, signal, purpose, json, maxTokens, temperature, _noPrefer: true });
  };

  try {
    let r = await postChat(`${base}/chat/completions`, payload, headers, ctrl.signal);
    // Some local providers (Ollama, LM Studio) mount the API under /v1.
    if (r.status === 404) {
      r = await postChat(`${base}/v1/chat/completions`, payload, headers, ctrl.signal);
    }
    // Providers that don't support response_format error with a 400 — retry without it.
    if (r.status === 400 && json && /response_format/i.test(r.raw || '')) {
      delete payload.response_format;
      r = await postChat(`${base}/chat/completions`, payload, headers, ctrl.signal);
      if (r.status === 404) r = await postChat(`${base}/v1/chat/completions`, payload, headers, ctrl.signal);
    }
    if (r.status < 200 || r.status >= 300) {
      const msg = r.json?.error?.message || r.raw?.slice(0, 200) || `HTTP ${r.status}`;
      if (usedPreferred) return fallbackToBase(); // ornith couldn't serve → DeepSeek
      return finish(false, null, `HTTP ${r.status}: ${msg}`, r.json?.usage);
    }
    const m = r.json?.choices?.[0]?.message || {};
    // Reasoning models (Gemma via the vision endpoint, deepseek-v4-flash) may leave `content`
    // empty and put the answer in `reasoning_content` when the budget runs low — salvage it.
    let text = typeof m.content === 'string' ? m.content : '';
    if (!text.trim() && typeof m.reasoning_content === 'string') text = m.reasoning_content;
    if (!text.trim()) {
      if (usedPreferred) return fallbackToBase(); // ornith returned nothing → DeepSeek
      return finish(false, null, 'empty completion', r.json?.usage);
    }
    return finish(true, text, null, r.json?.usage);
  } catch (e) {
    if (usedPreferred) return fallbackToBase(); // ornith errored/timed out → DeepSeek
    return finish(false, null, String(e?.message || e));
  }
}

/** Rollups over .state/llm-usage.jsonl: today + trailing 7 days. */
export function readLlmUsage() {
  const empty = () => ({ calls: 0, inTok: 0, outTok: 0, byPurpose: {} });
  const today = empty();
  const week = empty();
  if (!existsSync(USAGE_FILE)) return { today, week };
  const now = new Date();
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const weekStart = now.getTime() - 7 * 24 * 3600 * 1000;
  let lines;
  try { lines = readFileSync(USAGE_FILE, 'utf8').split('\n'); } catch { return { today, week }; }
  for (const line of lines) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (!e || typeof e.at !== 'number' || e.at < weekStart) continue;
    const add = (bucket) => {
      bucket.calls++;
      bucket.inTok += e.inTok || 0;
      bucket.outTok += e.outTok || 0;
      const p = e.purpose || 'general';
      const bp = bucket.byPurpose[p] || (bucket.byPurpose[p] = { calls: 0, inTok: 0, outTok: 0 });
      bp.calls++; bp.inTok += e.inTok || 0; bp.outTok += e.outTok || 0;
    };
    add(week);
    if (e.at >= dayStart) add(today);
  }
  return { today, week };
}

/**
 * Vision completion against the CONFIGURED OpenAI-compatible endpoint (image as a data URL in
 * the standard content-array shape). DeepSeek's platform API is TEXT-ONLY (verified 2026-07:
 * it rejects `image_url` parts), so with a stock DeepSeek config this returns
 * { ok:false, noVision:true } — point VISION_BASE_URL at LM Studio (or any OpenAI-compatible
 * multimodal endpoint) and this lights up. Codex vision has been REMOVED as a fallback (Michael:
 * "remove codex vision as an option") — when LM Studio has no vision-capable model loaded, this
 * simply errors; there is no silent CLI fallback anymore. Returns { ok, text, error, noVision?, usage }.
 */
/** Vision endpoint resolution: a DEDICATED vision endpoint (VISION_BASE_URL / VISION_MODEL /
 *  VISION_API_KEY in studio/.env — e.g. LM Studio running Gemma 3n e4b on :1234) wins over the
 *  main text config, so DeepSeek keeps the reasoning while a local VL model does the eyes. */
async function visionConfig() {
  const base = process.env.VISION_BASE_URL;
  if (base) {
    const b = base.replace(/\/$/, '');
    // Don't hardcode a model name — LM Studio only ever has ONE model loaded at a time (ornith9b,
    // "gemma 4 12b", or whatever Michael has open), so detect it via /models. VISION_MODEL still
    // overrides explicitly when set.
    let model = process.env.VISION_MODEL || '';
    if (!model) {
      const ids = await loadedModelIds(b);
      model = (await activePreferredModel(b)) || ids[0] || '';
    }
    return { base: b, model, key: process.env.VISION_API_KEY || null, provider: 'vision-endpoint' };
  }
  return config();
}

// ── LM Studio model detection ────────────────────────────────────────────────────────────────
// Michael runs LM Studio with exactly ONE model loaded at a time — ornith9b today, "gemma 4 12b"
// tomorrow, whatever else next (never assume both are loaded simultaneously, and never hardcode
// a model name as a fallback). Whenever LM Studio (VISION_BASE_URL) is reachable at all, it is
// preferred for BOTH text and vision over Codex/DeepSeek — Codex/DeepSeek are last-resort
// fallbacks only when LM Studio is genuinely unreachable. We detect what's loaded via the
// OpenAI-compatible GET /models and optionally match PREFERRED_MODEL (default: any id containing
// "ornith", smallest variant first). Cached ~20s so we don't poll on every call.
const _modelCache = { at: 0, base: '', ids: [] };
async function loadedModelIds(base) {
  const now = Date.now();
  if (base === _modelCache.base && now - _modelCache.at < 20_000) return _modelCache.ids;
  let ids = [];
  try {
    const res = await fetch(`${base}/models`, { signal: AbortSignal.timeout(2500) });
    const j = await res.json();
    ids = Array.isArray(j?.data) ? j.data.map((m) => String(m.id)) : [];
  } catch { ids = _modelCache.base === base ? _modelCache.ids : []; }
  _modelCache.at = now; _modelCache.base = base; _modelCache.ids = ids;
  return ids;
}
/** The active preferred-model id at `base`, or null when none is available. Prefers a SMALLER
 *  ornith variant (e.g. the 9b over a 35b) — a laptop can actually load the 9b, whereas the 35b
 *  fails with "insufficient system resources". `PREFERRED_MODEL` (exact or substring) overrides. */
export async function activePreferredModel(base) {
  if (!base) return null;
  const want = String(process.env.PREFERRED_MODEL || '').trim();
  const ids = await loadedModelIds(base);
  if (!ids.length) return null;
  if (want) {
    const hit = ids.find((id) => id === want) || ids.find((id) => id.toLowerCase().includes(want.toLowerCase()));
    if (hit) return hit;
  }
  const ornith = ids.filter((id) => /ornith/i.test(id));
  if (!ornith.length) return null;
  const paramB = (id) => { const mm = id.match(/(\d+)\s*b\b/i); return mm ? Number(mm[1]) : 999; };
  ornith.sort((a, b) => paramB(a) - paramB(b)); // smallest first — most likely to load
  return ornith[0];
}

export async function llmVision(prompt, imagePath, {
  system = null,
  timeoutMs = 90_000,
  purpose = 'vision',
  json = false,
  // Gemma-4-e4b (and most local VL models) are REASONING models — they burn hundreds of
  // tokens in reasoning_content before emitting the answer. A low cap runs out mid-think and
  // returns empty content. Big budget is cheap locally.
  maxTokens = 6000,
  _forceModel = null, // internal: pins a specific model id (rarely needed now — one model loaded at a time)
} = {}) {
  let { base, model, key, provider } = await visionConfig();
  // LM Studio only ever loads ONE model at a time, so visionConfig() already resolved whichever
  // one is active — no "prefer a smarter model" re-check needed, and no Gemma-specific fallback:
  // if the loaded model can't see the image, there is no other vision option (Codex vision was
  // removed — see codexVisionAllowed()). _forceModel lets a caller pin an explicit id.
  if (_forceModel) model = _forceModel;
  const started = Date.now();
  let b64;
  let mime = 'image/png';
  try {
    const { readFileSync: rf } = await import('node:fs');
    b64 = rf(imagePath).toString('base64');
    if (/\.jpe?g$/i.test(imagePath)) mime = 'image/jpeg';
    else if (/\.webp$/i.test(imagePath)) mime = 'image/webp';
  } catch (e) {
    return { ok: false, text: null, error: `cannot read image: ${e.message}` };
  }
  const messages = [];
  if (system) messages.push({ role: 'system', content: String(system) });
  messages.push({
    role: 'user',
    content: [
      { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } },
      { type: 'text', text: String(prompt) },
    ],
  });
  const payload = { model, messages, temperature: 0, max_tokens: maxTokens, stream: false };
  if (json) payload.response_format = { type: 'json_object' };
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers.Authorization = `Bearer ${key}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
  try {
    let r = await postChat(`${base}/chat/completions`, payload, headers, ctrl.signal);
    if (r.status === 404) r = await postChat(`${base}/v1/chat/completions`, payload, headers, ctrl.signal);
    // Local VL servers (LM Studio + Gemma) often reject response_format:json_object — retry
    // without it (the extractor's parser is tolerant of prose-wrapped JSON either way).
    if (r.status >= 400 && json && /response_format|json_object|json_schema/i.test(r.raw || '')) {
      delete payload.response_format;
      r = await postChat(`${base}/chat/completions`, payload, headers, ctrl.signal);
      if (r.status === 404) r = await postChat(`${base}/v1/chat/completions`, payload, headers, ctrl.signal);
    }
    clearTimeout(timer);
    const ms = Date.now() - started;
    const u = { inTok: r.json?.usage?.prompt_tokens || 0, outTok: r.json?.usage?.completion_tokens || 0, model, provider, ms };
    logUsage({ at: Date.now(), provider, model, purpose, inTok: u.inTok, outTok: u.outTok, ms, ok: r.status < 300 });
    if (r.status >= 300) {
      const msg = r.json?.error?.message || r.raw?.slice(0, 200) || `HTTP ${r.status}`;
      const noVision = /image_url|unknown variant|multimodal|vision/i.test(msg);
      return { ok: false, text: null, error: `HTTP ${r.status}: ${msg}`, noVision, usage: u };
    }
    const msg = r.json?.choices?.[0]?.message || {};
    // Reasoning VL models split their output: the answer lands in `content`, but if the token
    // budget was exhausted mid-think it stays empty while `reasoning_content` holds the work.
    // Salvage from reasoning_content (the callers' JSON/text parsers are tolerant of prose).
    let text = typeof msg.content === 'string' ? msg.content : '';
    if (!text.trim() && typeof msg.reasoning_content === 'string') text = msg.reasoning_content;
    const truncated = r.json?.choices?.[0]?.finish_reason === 'length';
    if (!text.trim()) {
      return { ok: false, text: null, error: truncated ? 'reasoning ran out of tokens before an answer (raise maxTokens)' : 'empty completion', usage: u };
    }
    return { ok: true, text, error: null, usage: u, truncated };
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, text: null, error: String(e?.message || e) };
  }
}

/** Codex vision fallback has been REMOVED entirely (Michael: "remove codex vision as an
 *  option") — vision requests only ever go through the configured LM Studio/VISION_BASE_URL
 *  endpoint now, and error clearly when it's unavailable instead of silently shelling out to
 *  the codex CLI. Kept as an always-false export so existing call sites (lib/layout-extract.mjs,
 *  lib/self-vision.mjs) degrade to "no fallback" without needing their own changes. */
export function codexVisionAllowed() {
  return false;
}
