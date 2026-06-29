// lib/usage.mjs — best-effort codex usage/quota probe (backend-owned).
//
// The codex path (ChatGPT-auth, driven through the bridge / gen.mjs) does NOT expose a reliable
// "remaining quota" number anywhere we can read: ~/.codex/auth.json carries the account + plan but
// no usage counter, and the only quota signal codex ever surfaces is a `RATE_LIMIT:` error when the
// window is exhausted (which tells us we're *out*, not how much is *left*). So this module is honest
// by construction: it NEVER fabricates a number. It returns a `CodexUsage` (see ../src/types.ts) that
// is `known:false` with a meaningful `label` in the normal case, and only flips to `known:true` if a
// real signal ever becomes available.
//
// Two inputs feed it:
//   1. sessionGenerated — jobs this process has completed (a real, honest "work done" signal). The
//      server bumps this via `noteGenerated()` whenever a job finishes.
//   2. a recent RATE_LIMIT note — the worker hands us the latest rate-limit hit (with the cooldown's
//      resumeAt) via `noteRateLimit()`. While that cooldown is live we can say "rate-limited" instead
//      of a bare "unknown".
//
// Results are cached for ~30s so /api/state and /api/health don't re-read auth.json on every poll.
// Zero external deps: node:* only.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CACHE_MS = 30_000;
const AUTH_PATH = join(process.env.HOME || '', '.codex', 'auth.json');
// Settings (the usage limit) persist next to the job state, in studio/.state/settings.json.
const STATE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '.state');
const SETTINGS_PATH = join(STATE_DIR, 'settings.json');

// --- mutable session signals (set by the server/worker, read by getCodexUsage) -------------------
let sessionGenerated = 0;        // count of jobs this process has completed
let lastRateLimit = null;        // { at:number, resumeAt:number|null } — most recent RATE_LIMIT hit

// Usage limit: max images to generate this session before auto-pausing. null = unlimited (the default
// — "go through the entire usage"). Persisted so it survives restarts.
let usageLimit = (() => {
  try {
    const v = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8')).usageLimit;
    return typeof v === 'number' && v > 0 ? v : null;
  } catch { return null; }
})();

/** Set the session usage cap. n>0 caps generation; null/0 = unlimited. Persisted. */
export function setUsageLimit(n) {
  usageLimit = typeof n === 'number' && n > 0 ? Math.floor(n) : null;
  try { mkdirSync(STATE_DIR, { recursive: true }); writeFileSync(SETTINGS_PATH, JSON.stringify({ usageLimit }), 'utf8'); } catch { /* ignore */ }
  cache = null;
  return usageLimit;
}
export function getUsageLimit() { return usageLimit; }
/** True when a cap is set and this session has already generated at least that many. */
export function isLimitReached() { return usageLimit != null && sessionGenerated >= usageLimit; }

// --- cache ---------------------------------------------------------------------------------------
let cache = null;                // { value:CodexUsage, at:number }

/** Record a completed generation (one image). Called by the server on each job 'done'. */
export function noteGenerated(n = 1) {
  sessionGenerated += Number(n) || 0;
  cache = null; // invalidate so the next read reflects the new count
}

/** Record a codex RATE_LIMIT hit so usage can report a 'rate-limited' state during the cooldown. */
export function noteRateLimit({ resumeAt = null } = {}) {
  lastRateLimit = { at: Date.now(), resumeAt: resumeAt == null ? null : Number(resumeAt) };
  cache = null;
}

/** The honest session-work signal (images generated this process). */
export function getSessionGenerated() {
  return sessionGenerated;
}

// Read the codex account/plan from ~/.codex/auth.json (best-effort). Returns { email, plan } or {}.
// We decode the id_token's middle (JWT payload) only to label the meter — no quota number lives here.
function readAccount() {
  try {
    const auth = JSON.parse(readFileSync(AUTH_PATH, 'utf8'));
    const token = auth && auth.tokens && auth.tokens.id_token;
    if (!token || typeof token !== 'string') return {};
    const seg = token.split('.')[1];
    if (!seg) return {};
    const payload = JSON.parse(Buffer.from(seg, 'base64').toString('utf8'));
    const claims = payload['https://api.openai.com/auth'] || {};
    return {
      email: payload.email || null,
      plan: claims.chatgpt_plan_type || null,
    };
  } catch {
    return {}; // missing / unreadable / not a JWT — fine, we just won't have a label
  }
}

/**
 * Best-effort codex usage. Cached ~30s.
 *
 * @returns {import('../src/types').CodexUsage}
 *   Always `known:false` today (no reliable remaining-quota source). `label` is the most useful
 *   honest string we can produce: "rate-limited" while a cooldown is live, else the plan name
 *   ("Plus") if we could read it, else "unknown". `sessionGenerated` is always the real count.
 */
export function getCodexUsage() {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_MS) return cache.value;

  // Is a rate-limit cooldown still in effect? (resumeAt in the future, or hit within the last hour.)
  const rl = lastRateLimit;
  const cooling = !!rl && (
    (rl.resumeAt != null && rl.resumeAt > now) ||
    (rl.resumeAt == null && now - rl.at < 60 * 60 * 1000)
  );

  const account = readAccount();

  let label;
  if (cooling) label = 'rate-limited';
  else if (account.plan) label = `Codex ${capitalize(account.plan)}`;
  else label = 'unknown';

  // We do not have a trustworthy remaining number from the codex path, so known stays false and we
  // never set remaining/total/percent. resetAt mirrors a live cooldown's resume time if we have one.
  const value = {
    known: false,
    label,
    sessionGenerated,
    limit: usageLimit,
    resetAt: cooling && rl.resumeAt != null ? rl.resumeAt : null,
  };

  cache = { value, at: now };
  return value;
}

function capitalize(s) {
  s = String(s || '');
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}
