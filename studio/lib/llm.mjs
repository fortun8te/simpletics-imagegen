// lib/llm.mjs — provider-agnostic LLM text client (OpenAI-compatible chat/completions).
//
// Default provider is DeepSeek (DEEPSEEK_API_KEY in studio/.env), but the same client works
// unchanged against any OpenAI-compatible endpoint (Ollama, LM Studio) via LLM_BASE_URL /
// LLM_MODEL / LLM_API_KEY. v4: runtime switching — the provider is resolved per call as
// runtime config (.state/llm-config.json via lib/llm-config.mjs) > env > DeepSeek default,
// so /api/llm/config changes apply without a restart. Zero-dep (node:* only). Every call —
// success or failure — appends one JSON line to .state/llm-usage.jsonl for /api/llm/usage.

import { readFileSync, existsSync, mkdirSync, appendFileSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { getLlmConfig, resolveLlm, DEFAULT_BASE } from './llm-config.mjs';

const STUDIO = join(dirname(fileURLToPath(import.meta.url)), '..');
const STATE_DIR = join(STUDIO, '.state');
const USAGE_FILE = join(STATE_DIR, 'llm-usage.jsonl');
const VISION_TMP_DIR = join(STATE_DIR, 'vision-tmp');

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
    // activePreferredModel resolves ornith from the DOWNLOADED set (JIT-loads it if needed), so a
    // box that booted with only gemma loaded — or nothing loaded — still gets ornith, not gemma
    // and not a DeepSeek fallback. Only when LM Studio is unreachable/empty does model come back
    // null and we fall through to the DeepSeek text config.
    const model = await activePreferredModel(vbase);
    if (model) return { base: vbase, model, key: process.env.VISION_API_KEY || null, provider: 'vision-endpoint' };
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
  _forceModel = null, // internal: pins a specific model id (LM Studio can have >1 model loaded at once)
  _bumped = false, // internal: this call is already the larger-cap reasoning retry (don't loop)
} = {}) {
  // LM Studio is the DEFAULT text route whenever it's reachable (textConfig() detects this via
  // /models); _noPrefer forces the plain resolved config (used for the LM-Studio→DeepSeek retry
  // below when the loaded model itself fails to answer).
  let { base, model, key, provider } = _noPrefer ? config() : await textConfig();
  if (_forceModel) model = _forceModel;
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
      // Reasoning-model truncation (ornith): it burned the whole budget in reasoning_content and
      // never emitted the answer — the tell is finish_reason:'length' / outTok == the cap. Retry
      // ONCE with a much larger cap so it can reason THEN emit (local tokens are cheap) before
      // giving up. Only for the local/preferred route, and only once (_bumped guards the loop).
      const truncated = r.json?.choices?.[0]?.finish_reason === 'length'
        || (r.json?.usage?.completion_tokens || 0) >= maxTokens;
      if (usedPreferred && truncated && !_bumped) {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        return llmText(prompt, {
          system, timeoutMs, signal, purpose, json, temperature, _forceModel,
          maxTokens: Math.max(maxTokens * 2, 8000), _bumped: true,
        });
      }
      if (usedPreferred) return fallbackToBase(); // ornith still returned nothing → DeepSeek
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
    // REMOTE vision provider fast-path (e.g. OpenCode Zen: VISION_BASE_URL=https://opencode.ai/zen/v1,
    // VISION_MODEL=<a vision-capable id>, VISION_API_KEY=<key>). A hosted provider does NOT expose LM
    // Studio's "loaded models" semantics — the /models dance below (activePreferredModel, loaded-set
    // filtering, JIT-load avoidance) is meaningless there and would mis-resolve the model. So when the
    // host is remote (not localhost) AND an explicit VISION_MODEL is set, send it directly. gemma is
    // still hard-blocked. Confirm the chosen model actually accepts images first with
    // `node scripts/probe-vision-backends.mjs` — a text-only model here yields noVision at call time.
    try {
      const host = new URL(b).hostname;
      const isLocal = ['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]'].includes(host);
      const want = String(process.env.VISION_MODEL || '').trim();
      if (!isLocal && want && !BLOCKED_MODEL.test(want)) {
        return { base: b, model: want, key: process.env.VISION_API_KEY || null, provider: 'remote-vision' };
      }
    } catch { /* not a parseable URL — fall through to the LM Studio path */ }
    // Resolve the model to send ONLY from the loaded set (activePreferredModel) — ornith does
    // vision+reasoning so it's the vision default too. A stale VISION_MODEL env (e.g. it points at
    // gemma, which is downloaded but NOT loaded) is honored ONLY if that id is actually loaded;
    // otherwise it's ignored so it can't JIT-load a second model. Empty model = no LM Studio model
    // loaded → caller degrades (no silent fallback that spawns a load).
    // Same resolution as text: ornith for vision too (it does vision+reasoning). A VISION_MODEL
    // override is honored ONLY if that id is actually downloaded (so it can be JIT-loaded); an
    // unset/stale VISION_MODEL falls through to activePreferredModel → ornith. gemma is never sent.
    const raw = await modelIds(b);
    // gemma is hard-blocked everywhere (see BLOCKED_MODEL) — strip it before any pick.
    const loaded = raw.loaded.filter((id) => !BLOCKED_MODEL.test(id));
    const all = raw.all.filter((id) => !BLOCKED_MODEL.test(id));
    const want = String(process.env.VISION_MODEL || '').trim();
    let model = '';
    if (want && !BLOCKED_MODEL.test(want)) {
      const pick = (list) => list.find((id) => id === want) || list.find((id) => id.toLowerCase().includes(want.toLowerCase()));
      model = pick(loaded) || pick(all) || '';
    }
    if (!model) model = (await activePreferredModel(b)) || '';
    // No non-gemma model available (e.g. only gemma is loaded) → DON'T send an empty model id, which
    // LM Studio would resolve to its own default (possibly gemma). Fall through to the text config
    // so vision degrades to noVision instead of secretly using gemma.
    if (model) return { base: b, model, key: process.env.VISION_API_KEY || null, provider: 'vision-endpoint' };
  }
  return config();
}

// ── LM Studio model detection ────────────────────────────────────────────────────────────────
// CRITICAL: never trigger a JIT model load. LM Studio auto-loads any DOWNLOADED-but-unloaded
// model the moment a request names its id — so if routing ever sends a stale/persisted name
// (VISION_MODEL env, config.json model field, a picker choice) that isn't the currently-loaded
// model, LM Studio spins up a SECOND model → contention, slowness, and "loads unused models".
// So we resolve the model id to send ONLY from the set LM Studio reports as actually `loaded`.
//
// The plain OpenAI-compatible GET /models lists every DOWNLOAD (loaded or not) and carries no
// load state — using it is exactly what causes the unwanted loads. LM Studio's native
// GET /api/v0/models gives per-model `state:"loaded"`, so we prefer it and keep only loaded ids;
// we fall back to /v1/models (all ids, treated as "loaded") only if v0 is unreachable.
// Michael's stated default is ornith for EVERYTHING (it does vision+reasoning), so when ornith is
// loaded we use it; if ornith isn't loaded but something else is, we use whatever IS loaded — we
// never force-load ornith (that would itself spawn a second model). Cached ~20s.
const _modelCache = { at: 0, base: '', ids: [], all: [] };

/** Derive LM Studio's native REST root ("http://host:1234/api/v0") from an OpenAI-compat base
 *  ("http://host:1234/v1" or "http://host:1234"). */
function v0Root(base) {
  const b = String(base || '').replace(/\/+$/, '');
  const host = b.replace(/\/v1$/, '');
  return `${host}/api/v0`;
}

/** Model ids at `base`, split into { loaded, all }. `loaded` = models LM Studio reports
 *  `state:"loaded"`; `all` = every DOWNLOADED model (loaded or not). Prefers the native
 *  /api/v0/models `state` field; falls back to /v1/models (no state → every id treated as both
 *  loaded and downloaded) only when v0 is unreachable. Cached ~20s so we don't poll per call. */
async function modelIds(base) {
  const now = Date.now();
  if (base === _modelCache.base && now - _modelCache.at < 20_000) return { loaded: _modelCache.ids, all: _modelCache.all };
  let loaded = null;
  let all = null;
  // 1) native endpoint with real load state — the authoritative source
  try {
    const res = await fetch(`${v0Root(base)}/models`, { signal: AbortSignal.timeout(2500) });
    const j = await res.json();
    if (Array.isArray(j?.data)) {
      const usable = j.data.filter((m) => m.type !== 'embeddings');
      loaded = usable.filter((m) => String(m.state || '').toLowerCase() === 'loaded').map((m) => String(m.id));
      all = usable.map((m) => String(m.id));
    }
  } catch { loaded = null; all = null; }
  // 2) fallback: OpenAI-compat list (no state — can't distinguish; treat every id as available)
  if (loaded == null) {
    try {
      const res = await fetch(`${base}/models`, { signal: AbortSignal.timeout(2500) });
      const j = await res.json();
      all = Array.isArray(j?.data) ? j.data.map((m) => String(m.id)) : [];
      loaded = all;
    } catch {
      loaded = _modelCache.base === base ? _modelCache.ids : [];
      all = _modelCache.base === base ? _modelCache.all : [];
    }
  }
  _modelCache.at = now; _modelCache.base = base; _modelCache.ids = loaded; _modelCache.all = all;
  return { loaded, all };
}

/** Back-compat: just the loaded set. */
async function loadedModelIds(base) { return (await modelIds(base)).loaded; }

/** The model id to actually SEND at `base`. Michael's rule: **ornith for EVERYTHING**, and gemma
 *  must NEVER be used even when it's loaded. So the desired model (PREFERRED_MODEL, default ornith)
 *  is resolved against ALL downloaded models, not just the loaded set — if it's downloaded but not
 *  loaded, we send its id anyway and let LM Studio JIT-load it (that's a DESIRED load, not the
 *  "unused second model" problem the loaded-only rule was guarding against). We only ever send the
 *  desired id, so gemma is never used as long as ornith is downloaded. The old "use whatever's
 *  loaded" was the bug: booting with gemma loaded + ornith unloaded made the app use gemma.
 *  Precedence: loaded-preferred → downloaded-preferred (JIT) → loaded-ornith → downloaded-ornith
 *  (JIT, smallest variant — the 35b can't load on this machine) → loaded-anything. null if empty. */
// Models we must NEVER select — Michael: "stop using gemma completely." Any id matching this is
// stripped from every candidate list below, so gemma is never sent (and thus never JIT-loaded by
// us) even if it's the only thing LM Studio has loaded. When exclusion leaves nothing, we return
// null → text falls back to DeepSeek, vision degrades to noVision — never gemma.
const BLOCKED_MODEL = /gemma/i;
export async function activePreferredModel(base) {
  if (!base) return null;
  const raw = await modelIds(base);
  const loaded = raw.loaded.filter((id) => !BLOCKED_MODEL.test(id));
  const all = raw.all.filter((id) => !BLOCKED_MODEL.test(id));
  if (!loaded.length && !all.length) return null;
  const want = String(process.env.PREFERRED_MODEL || 'ornith').trim(); // default the hint to ornith
  const matches = (list, needle) => list.find((id) => id === needle)
    || list.find((id) => id.toLowerCase().includes(needle.toLowerCase()));
  const smallest = (list) => {
    const paramB = (id) => { const mm = id.match(/(\d+)\s*b\b/i); return mm ? Number(mm[1]) : 999; };
    return [...list].sort((a, b) => paramB(a) - paramB(b))[0];
  };
  if (want) {
    // Prefer an already-loaded match (no load), else a downloaded match (JIT-load the DESIRED model).
    const wantMatches = (list) => list.filter((id) => id === want || id.toLowerCase().includes(want.toLowerCase()));
    const loadedWant = wantMatches(loaded);
    if (loadedWant.length) return smallest(loadedWant);
    const downloadedWant = wantMatches(all);
    if (downloadedWant.length) return smallest(downloadedWant); // JIT-load ornith — desired, not stray
  }
  // No explicit hint match: prefer any ornith (loaded first, else downloaded → JIT), smallest variant.
  const loadedOrnith = loaded.filter((id) => /ornith/i.test(id));
  if (loadedOrnith.length) return smallest(loadedOrnith);
  const anyOrnith = all.filter((id) => /ornith/i.test(id));
  if (anyOrnith.length) return smallest(anyOrnith);
  return loaded[0] || all[0]; // no ornith downloaded at all → whatever's available
}

// ── vision-incompatible image formats ────────────────────────────────────────────────────────
// LM Studio's multimodal endpoint (ornith) only accepts jpeg/png (confirmed live: a real .webp
// reference — a VERY common ad-screenshot format, a large fraction of ~/Downloads/IMAGE AD
// INSPO/*.webp — returns a hard `HTTP 400: 'url' field must be a base64 encoded image`). Prior
// to this fix that surfaced as a mystifying "unparsable / empty layout" from layout-extract (the
// vision call failed outright, so extraction just saw a string of retries with no real signal).
// Convert unsupported formats to PNG via macOS `sips` (zero-dep, same shell-out pattern as
// self-vision.mjs's qlmanage/Chrome rendering) before ever base64-encoding for the API. Cached to
// .state/vision-tmp/ keyed by source path + mtime so repeated attempts (layout-extract retries up
// to 5× per pass) don't reconvert the same file.
const VISION_OK_EXT = /\.(png|jpe?g)$/i;
const _visionConvertCache = new Map(); // "path:mtimeMs" -> converted png path
function ensureVisionCompatible(imagePath) {
  if (VISION_OK_EXT.test(imagePath)) return { path: imagePath, mime: /\.jpe?g$/i.test(imagePath) ? 'image/jpeg' : 'image/png' };
  let mtimeMs = 0;
  try { mtimeMs = statSync(imagePath).mtimeMs; } catch { /* fall through to conversion attempt */ }
  const cacheKey = `${imagePath}:${mtimeMs}`;
  const cached = _visionConvertCache.get(cacheKey);
  if (cached && existsSync(cached)) return { path: cached, mime: 'image/png' };
  mkdirSync(VISION_TMP_DIR, { recursive: true });
  const out = join(VISION_TMP_DIR, `${basename(imagePath).replace(/\.[^.]+$/, '')}-${Date.now()}.png`);
  const r = spawnSync('sips', ['-s', 'format', 'png', imagePath, '--out', out], { timeout: 15_000 });
  if (r.status === 0 && existsSync(out)) {
    _visionConvertCache.set(cacheKey, out);
    return { path: out, mime: 'image/png' };
  }
  // Conversion failed (sips missing / unreadable source) — fall through with the original path;
  // the API call will surface its own clear error rather than us inventing one.
  return { path: imagePath, mime: 'image/png' };
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
  signal = null, // caller AbortSignal — aborts the in-flight HTTP call promptly (mirrors llmText)
  // temperature 0 by default (deterministic extraction), but retry strategies NEED to vary it —
  // at temp 0 an identical re-ask provably returns the identical wrong answer (observed live:
  // 5 retries, byte-identical token counts every time). Callers doing a corrective retry pass
  // temperature > 0 to actually change the outcome.
  temperature = 0,
  _forceModel = null, // internal: pins a specific model id (rarely needed now — one model loaded at a time)
  _bumped = false, // internal: guards the one-shot truncation retry below from looping
  extraImages = [], // NEW: array of file paths for additional images to send alongside the primary
} = {}) {
  if (signal?.aborted) return { ok: false, text: null, error: 'aborted', aborted: true };
  let { base, model, key, provider } = await visionConfig();
  // LM Studio only ever loads ONE model at a time, so visionConfig() already resolved whichever
  // one is active — no "prefer a smarter model" re-check needed, and no Gemma-specific fallback:
  // if the loaded model can't see the image, there is no other vision option (Codex vision was
  // removed — see codexVisionAllowed()). _forceModel lets a caller pin an explicit id.
  if (_forceModel) model = _forceModel;
  const started = Date.now();
  let b64;
  let mime;
  try {
    const compat = ensureVisionCompatible(imagePath);
    mime = compat.mime;
    const { readFileSync: rf } = await import('node:fs');
    b64 = rf(compat.path).toString('base64');
  } catch (e) {
    return { ok: false, text: null, error: `cannot read image: ${e.message}` };
  }
  // Build content: primary image + any extra images + text prompt
  const content = [
    { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } },
  ];
  // Encode and append extra images (e.g. reference image for comparison)
  for (const extra of extraImages) {
    try {
      const extraCompat = ensureVisionCompatible(extra);
      const { readFileSync: rf } = await import('node:fs');
      const extraB64 = rf(extraCompat.path).toString('base64');
      content.push({ type: 'image_url', image_url: { url: `data:${extraCompat.mime};base64,${extraB64}` } });
    } catch { /* skip unreadable extra images */ }
  }
  content.push({ type: 'text', text: String(prompt) });
  const messages = [];
  if (system) messages.push({ role: 'system', content: String(system) });
  messages.push({ role: 'user', content });
  const payload = { model, messages, temperature, max_tokens: maxTokens, stream: false };
  if (json) payload.response_format = { type: 'json_object' };
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers.Authorization = `Bearer ${key}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
  // Forward the caller's AbortSignal into the HTTP call so a Stop/delete kills the in-flight
  // vision request immediately (this was the RUN-1 gap: extraction vision calls were unabortable).
  const onAbort = () => ctrl.abort(signal?.reason || new Error('aborted'));
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  const cleanupAbort = () => { if (signal) signal.removeEventListener('abort', onAbort); };
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
    cleanupAbort();
    const ms = Date.now() - started;
    const u = { inTok: r.json?.usage?.prompt_tokens || 0, outTok: r.json?.usage?.completion_tokens || 0, model, provider, ms };
    logUsage({ at: Date.now(), provider, model, purpose, inTok: u.inTok, outTok: u.outTok, ms, ok: r.status < 300 });
    if (r.status >= 300) {
      const msg = r.json?.error?.message || r.raw?.slice(0, 200) || `HTTP ${r.status}`;
      const noVision = /image_url|unknown variant|multimodal|vision/i.test(msg);
      return { ok: false, text: null, error: `HTTP ${r.status}: ${msg}`, noVision, usage: u };
    }
    // PROVIDER-FALLBACK GUARD v2 (9router pools): the gateway can serve a request from a pool
    // ("opencode-free-priority") whose members include TEXT-ONLY models — under rate pressure a
    // vision request gets answered by e.g. nvidia/minimax and the extraction comes back as
    // "unparsable/empty layout" with no clue why. v1 compared respModel against the REQUESTED id
    // and false-positived the moment the requested id became a pool alias (it rejected a genuine
    // mimo answer). v2 checks an EXPLICIT expectation instead: VISION_EXPECT_MODEL (regex, e.g.
    // "mimo") declares which model family is allowed to answer VISION calls; a response from
    // anything else is rejected loudly so callers back off and retry until the pool serves the
    // right family. Unset = no guard (single-model setups don't need one).
    {
      const respModel = String(r.json?.model || '');
      const expect = String(process.env.VISION_EXPECT_MODEL || '').trim();
      if (respModel && expect) {
        let expectRe = null;
        try { expectRe = new RegExp(expect, 'i'); } catch { /* bad regex → no guard */ }
        if (expectRe && !expectRe.test(respModel)) {
          logUsage({ at: Date.now(), provider, model, purpose, inTok: u.inTok, outTok: u.outTok, ms, ok: false, note: `fallback:${respModel}` });
          return { ok: false, text: null, error: `pool served non-vision model "${respModel}" (expected /${expect}/i) — rate-limited; retry after backoff`, noVision: false, providerFallback: true, usage: u };
        }
      }
    }
    const msg = r.json?.choices?.[0]?.message || {};
    // Reasoning VL models split their output: the answer lands in `content`, but if the token
    // budget was exhausted mid-think it stays empty while `reasoning_content` holds the work.
    // Salvage from reasoning_content (the callers' JSON/text parsers are tolerant of prose).
    let text = typeof msg.content === 'string' ? msg.content : '';
    if (!text.trim() && typeof msg.reasoning_content === 'string') text = msg.reasoning_content;
    const truncated = r.json?.choices?.[0]?.finish_reason === 'length';
    // Same fix as llmText: a reasoning model (ornith) that hit finish_reason:'length' has either
    // emitted nothing yet, or emitted a JSON payload CUT OFF mid-structure (e.g. a layout-extract
    // array truncated mid-layer) — that reads as "unparsable" to the caller even though ok:true was
    // returned. Retry ONCE at a much larger cap so it can finish reasoning THEN emit the full
    // answer (local tokens are cheap) before giving up, exactly mirroring llmText's bump-retry.
    if (truncated && !_bumped) {
      cleanupAbort();
      // A doubled token budget needs more WALL-CLOCK too — retrying at the same timeoutMs made the
      // bump itself time out on a slow local model (PERF audit). Scale the deadline with the budget.
      return llmVision(prompt, imagePath, {
        system, timeoutMs: Math.max(timeoutMs * 2, 150_000), purpose, json, signal, temperature, _forceModel,
        maxTokens: Math.max(maxTokens * 2, 12_000), _bumped: true,
      });
    }
    if (!text.trim()) {
      return { ok: false, text: null, error: truncated ? 'reasoning ran out of tokens before an answer (raise maxTokens)' : 'empty completion', usage: u };
    }
    return { ok: true, text, error: null, usage: u, truncated };
  } catch (e) {
    clearTimeout(timer);
    cleanupAbort();
    const aborted = !!signal?.aborted;
    return { ok: false, text: null, error: aborted ? 'aborted' : String(e?.message || e), aborted };
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
