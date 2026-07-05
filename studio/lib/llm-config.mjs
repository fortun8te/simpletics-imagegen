// lib/llm-config.mjs — runtime LLM provider config (v4), persisted at .state/llm-config.json.
//
// Lets the UI switch models WITHOUT a restart or .env edit. lib/llm.mjs resolves its provider
// through resolveLlm() with this precedence:
//   runtime config (this file) > env (LLM_BASE_URL / LLM_MODEL / LLM_API_KEY / DEEPSEEK_API_KEY)
//   > DeepSeek default.
// Saving a keyless config for a provider that needs a key is ALLOWED — hasLlm() in llm.mjs
// reflects reality (no key + default DeepSeek base ⇒ false). Zero-dep (node:* only).

import { readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeAtomic } from './atomic-write.mjs';

const STUDIO = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_FILE = join(STUDIO, '.state', 'llm-config.json');

// The RESOLVED fallback when nothing local is reachable stays DeepSeek (resolveLlm's contract:
// runtime > env > this default — llm.mjs textConfig() auto-prefers LM Studio whenever it
// responds to /models, so the DeepSeek default only ever serves when the local box is down).
export const DEFAULT_BASE = 'https://api.deepseek.com';
export const DEFAULT_MODEL = 'deepseek-v4-flash';

// DEAD-17: the PRESETS / DEFAULT_PRESET_ID exports were removed here — they had zero importers
// after the ModelSelector UI was deleted (the /api/llm-config server route builds its own inline
// preset list). Keeping them would have re-implied a picker that no longer exists.

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);

/** https anywhere; plain http ONLY for localhost. Returns the normalized base (no trailing /)
 *  or throws with a human-readable reason. */
export function validateBaseUrl(raw) {
  const s = String(raw || '').trim().replace(/\/+$/, '');
  if (!s) throw new Error('baseUrl required');
  let u;
  try { u = new URL(s); } catch { throw new Error(`baseUrl "${s}" is not a valid URL`); }
  if (u.protocol === 'https:') return s;
  if (u.protocol === 'http:' && LOCAL_HOSTS.has(u.hostname)) return s;
  throw new Error('baseUrl must be https:// (plain http:// is allowed for localhost only)');
}

/** Read the persisted runtime config, or null when none is set / the file is unreadable. */
export function getLlmConfig({ file = CONFIG_FILE } = {}) {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'));
    if (!j || typeof j.baseUrl !== 'string' || !j.baseUrl.trim()) return null;
    return {
      baseUrl: j.baseUrl.trim().replace(/\/+$/, ''),
      model: typeof j.model === 'string' ? j.model.trim() : '',
      apiKey: typeof j.apiKey === 'string' ? j.apiKey.trim() : '',
      label: typeof j.label === 'string' ? j.label.slice(0, 60) : '',
      updatedAt: Number(j.updatedAt) || 0,
    };
  } catch { return null; }
}

/** Validate + persist a runtime config ({baseUrl, model?, apiKey?, label?}). Pass null to clear
 *  (falls back to env/default). Returns the saved config (or null when cleared); throws on an
 *  invalid baseUrl. An empty model falls back to LLM_MODEL / the DeepSeek default at resolve time. */
export function setLlmConfig(cfg, { file = CONFIG_FILE } = {}) {
  if (cfg == null) {
    try { rmSync(file); } catch { /* already clear */ }
    return null;
  }
  const out = {
    baseUrl: validateBaseUrl(cfg.baseUrl),
    model: String(cfg.model || '').trim().slice(0, 120),
    updatedAt: Date.now(),
  };
  const apiKey = String(cfg.apiKey || '').trim();
  if (apiKey) out.apiKey = apiKey;
  if (cfg.label) out.label = String(cfg.label).trim().slice(0, 60);
  writeAtomic(file, JSON.stringify(out, null, 2));
  return getLlmConfig({ file });
}

function providerOf(base) {
  if (/deepseek/i.test(base)) return 'deepseek';
  try { return new URL(base).hostname; } catch { return 'custom'; }
}

/**
 * Pure precedence resolver (unit-testable without fs): runtime > env > DeepSeek default.
 * Returns { base, model, key, provider, source:'runtime'|'env'|'default' }.
 * Key rule when a runtime base is set: the runtime apiKey wins; env keys only flow to a
 * MATCHING provider (DEEPSEEK_API_KEY → deepseek bases, LLM_API_KEY → the env LLM_BASE_URL)
 * so a saved local/custom endpoint never gets sent a DeepSeek key.
 */
export function resolveLlm(runtime = getLlmConfig(), env = process.env) {
  if (runtime && runtime.baseUrl) {
    const base = runtime.baseUrl.replace(/\/+$/, '');
    const model = runtime.model || env.LLM_MODEL || DEFAULT_MODEL;
    let key = (runtime.apiKey || '').trim();
    if (!key) {
      if (/deepseek/i.test(base)) key = (env.DEEPSEEK_API_KEY || env.LLM_API_KEY || '').trim();
      else if ((env.LLM_BASE_URL || '').replace(/\/+$/, '') === base) key = (env.LLM_API_KEY || '').trim();
    }
    return { base, model, key, provider: providerOf(base), source: 'runtime' };
  }
  const base = (env.LLM_BASE_URL || DEFAULT_BASE).replace(/\/+$/, '');
  const model = env.LLM_MODEL || DEFAULT_MODEL;
  const key = (env.LLM_API_KEY || env.DEEPSEEK_API_KEY || '').trim();
  const source = env.LLM_BASE_URL || env.LLM_MODEL ? 'env' : 'default';
  return { base, model, key, provider: providerOf(base), source };
}
