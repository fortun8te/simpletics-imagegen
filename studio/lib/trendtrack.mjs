// trendtrack.mjs — zero-dep TrendTrack REST client (https://docs.trendtrack.io).
//
// Credits model: 1 credit = 1 RETURNED AD ROW (not per request); 10k/month. GET /v1/usage is
// free — call it before any metered work. Every metered response carries X-Credits-Remaining /
// X-Usage-Cost headers; we log them and keep the last-known balance for the credit guard.
//
// Credit guard: metered calls REFUSE to run when the last-known balance is below MIN_CREDITS
// (500) — checked against a fresh (free) usage probe when we have no cached reading. A 402
// (insufficient_credits) from the API is surfaced as the same guard error so callers/loops
// stop cleanly instead of hammering the API.
//
// Auth: Authorization: Bearer $TRENDTRACK_API_KEY, loaded from studio/.env (gitignored) or the
// process environment. No key → hasKey() is false and every call throws a clear 'no_api_key'.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const STUDIO = join(dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://api.trendtrack.io/v1';
const MIN_CREDITS = 500;   // refuse metered work below this — leave headroom for manual use
const MAX_LIMIT = 25;      // hard row cap per metered request (dev rule from BRIEF.md)

// ── .env loader (zero-dep) ───────────────────────────────────────────────────────────────────────
// KEY=value lines; quotes optional; # comments. Only fills vars not already in process.env so a
// real environment always wins over the file.
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

export function hasKey() {
  return !!(process.env.TRENDTRACK_API_KEY || '').trim();
}

// Last-known credit balance, updated from every response that reports it. null = never seen.
let creditsRemaining = null;
export function lastKnownCredits() { return creditsRemaining; }

class TrendTrackError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

function readCreditHeaders(res, label) {
  const remaining = res.headers.get('x-credits-remaining');
  const cost = res.headers.get('x-usage-cost');
  if (remaining != null && remaining !== '') {
    creditsRemaining = Number(remaining);
    // Log every metered call's cost + balance — the paper trail for the 10k/month budget.
    console.log(`[trendtrack] ${label}: cost=${cost ?? '?'} remaining=${creditsRemaining}`);
  }
}

async function request(method, path, { body, label, metered = false } = {}) {
  if (!hasKey()) throw new TrendTrackError('no_api_key', 'TRENDTRACK_API_KEY missing — add it to studio/.env');
  if (metered) {
    // Guard: fresh (free) usage probe when we have no cached balance, then refuse below floor.
    if (creditsRemaining == null) await getUsage();
    if (creditsRemaining != null && creditsRemaining < MIN_CREDITS) {
      throw new TrendTrackError('credit_guard', `refusing metered call — ${creditsRemaining} credits left (< ${MIN_CREDITS} floor)`);
    }
  }
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${process.env.TRENDTRACK_API_KEY.trim()}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  readCreditHeaders(res, label || path);
  if (res.status === 402) throw new TrendTrackError('insufficient_credits', 'TrendTrack: out of credits (402)');
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new TrendTrackError(`http_${res.status}`, `TrendTrack ${method} ${path} → ${res.status} ${text.slice(0, 200)}`);
  }
  return res.json();
}

// ── API surface ──────────────────────────────────────────────────────────────────────────────────

/** Free balance probe — call at boot / before metered work. Returns the raw usage payload with a
 *  normalized `remaining` folded in (from body or the response header, whichever is present). */
export async function getUsage() {
  const data = await request('GET', '/usage', { label: 'usage' });
  const remaining =
    Number(data?.credits_remaining ?? data?.remaining ?? data?.credits ?? NaN);
  if (Number.isFinite(remaining)) creditsRemaining = remaining;
  return { remaining: creditsRemaining, raw: data };
}

/** Brand/domain/handle resolution (ZERO-credit per the API docs — /me, /usage, /lookup are free).
 *  Param is `q` + type=auto (the docs' "non-negotiable routing rule"). */
export function lookup(q) {
  const params = new URLSearchParams({ q: String(q || '').trim(), type: 'auto' });
  return request('GET', `/lookup?${params}`, { label: `lookup(${q})` });
}

/** Query ads (metered — 1 credit per RETURNED row). `limit` hard-capped at 25.
 *  Canonical body shape: { search: ["brand"], searchType: "brand"|"adCopy", status, sortBy, order, limit }.
 *  Response: { requestId, data: [row...] } — rows carry media.thumbnailUrl/mediaUrl directly. */
export function queryAds(filters = {}, { limit = MAX_LIMIT } = {}) {
  const capped = Math.max(1, Math.min(MAX_LIMIT, Number(limit) || MAX_LIMIT));
  return request('POST', '/ads/query', {
    label: `ads/query(limit=${capped})`,
    metered: true,
    body: { ...filters, limit: capped },
  });
}

/** One ad by id (metered — 1 row). */
export function getAdById(adId) {
  return request('GET', `/ads/${encodeURIComponent(String(adId))}`, {
    label: `ads/${adId}`,
    metered: true,
  });
}
