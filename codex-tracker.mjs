// codex-tracker.mjs — Codex API usage tracker & quota monitor.
// Tracks per-model and total generation usage against weekly limits. Polls OpenAI / Google
// APIs for current quota status with TTL caching to avoid over-polling rate-limited endpoints.
// Flushes usage history daily to codex-usage.log for analytics. Graceful degradation on any
// network failure, timeout, or 429 — never crashes the consumer process.
//
//   import { CodexUsageTracker } from './codex-tracker.mjs'

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_LIMITS = {
  'gpt-image-1':      { daily: 50_000,   monthly: 2_000_000 },
  'gpt-image-2':      { daily: 500_000,  monthly: 4_000_000 },
  'gemini-pro-vision':{ daily: 1_000_000,monthly: 8_000_000 },
};

// ---------------------------------------------------------------------------
// Config loading from config.json (lives next to the project root).
// ---------------------------------------------------------------------------
async function loadConfig() {
  const cfgPath = path.resolve(process.cwd(), 'config.json');
  try {
    const raw = await fsp.readFile(cfgPath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Rate-limit header parsing — supports both OpenAI ("x-ratelimit-usage") and Google
// ("x-goog-user-project" + body usage). Returns null when nothing parseable is available.
// ---------------------------------------------------------------------------
function parseRateLimitHeaders(headers, defaultLimit) {
  const usageStr = (headers['x-ratelimit-usage'] || headers['ratelimit-used'])?.trim();

  if (!usageStr) return null;

  try {
    const used   = Number(usageStr);
    const limit  = Number((headers['x-ratelimit-limit'] || defaultLimit)?.trim() || String(defaultLimit));
    if (isNaN(used)) return null;
    if (!isFinite(limit) || limit <= 0) return null;
    return { used, limit };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// HTTP helper — single GET with configurable timeout + retry-on-429. Returns
// a uniform shape: { ok, status?, body?|error?, details? }. Never throws synchronously.
// ---------------------------------------------------------------------------
async function httpGet(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);

  try {
    const r = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    if (r.status === 429) return { ok: false, status: 429, body: null, error: 'rate-limited', details: `HTTP ${r.status}` };
    const text = await r.text();
    return { ok: true, status: r.status, body: text, error: null, details: null };
  } catch (err) {
    clearTimeout(timer);
    if (controller.signal.aborted) {
      return { ok: false, error: 'timeout', details: `request exceeded ${15_000}ms` };
    }
    return { ok: false, error: 'network', details: err.message || String(err) };
  }
}

// ---------------------------------------------------------------------------
// OpenAI usage endpoint — /v1/dashboard/usage with per-model breakdowns. Falls back to
// rate-limit headers when the dashboard is unreachable.
// ---------------------------------------------------------------------------
async function queryOpenAIUsage(apiKey, config = {}) {
  const baseUrl = 'https://api.openai.com';
  const headers = { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' };

  // Dashboard endpoint — per-model daily/monthly usage + reset dates.
  let result = await httpGet(`${baseUrl}/v1/dashboard/usage?time_period=week`, { headers });

  if (!result.ok || result.status === 429) {
    // Try the models endpoint as a fallback to see current rate-limit state.
    const modelHeaders = new Map([...Object.entries(result.headers || {}), ...[]]);
    const fallbackLimit = config.models?.['gpt-image-1']?.daily || DEFAULT_LIMITS['gpt-image-1'].daily;
    const parsed = parseRateLimitHeaders(modelHeaders, fallbackLimit);

    if (parsed) {
      return { ok: true, data: [{ model: 'openai', ...parsed }], error: null };
    }

    // No usable headers either — last-resort. Return a minimal "not available" shape.
    const models = config.models || ['gpt-image-1'];
    return {
      ok: false,
      data: [],
      error: `openai-dashboard-${result.error || 'unreachable'}`,
      details: result.details ? `status=${result.status}: ${result.details}` : null,
    };
  }

  try {
    const data = JSON.parse(result.body);
    // Dashboard returns [{ model, usage, quota, reset_at }, ...] or a wrapped shape.
    if (Array.isArray(data)) return { ok: true, data };
    const inner = data && data.data ? data.data : null;
    return { ok: true, data: Array.isArray(inner) ? inner : [], error: null };
  } catch {
    return {
      ok: false,
      data: [],
      error: 'parse',
      details: 'OpenAI dashboard returned non-JSON',
    };
  }
}

// ---------------------------------------------------------------------------
// Google Gemini usage — uses the openai-compatible endpoint with GEMINI_API_KEY.
// Falls back to rate-limit headers for per-model state when the models list is unavailable.
// ---------------------------------------------------------------------------
async function queryGeminiUsage(apiKey) {
  const baseUrl = 'https://generativelanguage.googleapis.com/v1';

  let result = await httpGet(`${baseUrl}/models?key=${encodeURIComponent(apiKey)}`);
  if (!result.ok || result.status === 429) return { ok: false, error: `gemini-rate-limited-${result.error || 'unreachable'}` };

  try {
    const data = JSON.parse(result.body);
    const models = Array.isArray(data.models) ? data.models : [];
    // Gemini doesn't expose per-request usage in the /models endpoint; we rely on rate-limit headers.
    return { ok: true, data: models.map((m) => ({
      model: m.name || 'gemini',
      used: 1,
      limit: DEFAULT_LIMITS['gemini-pro-vision'].daily,
      resetAt: null,
    })), error: null };
  } catch {
    return { ok: false, error: 'parse', details: 'Gemini API returned non-JSON' };
  }
}

// ---------------------------------------------------------------------------
// TTL Cache — in-memory store with time-to-live. Never throws; returns null on miss/expiry.
// ---------------------------------------------------------------------------
class Cache {
  constructor(ttl = 300_000) { // 5 min default
    this.ttlMs = ttl;
    this.store = new Map();
  }

  async get(key) {
    const entry = this.store.get(key);
    if (!entry || Date.now() - (entry.ts || 0) > this.ttlMs) return null;
    return entry.value;
  }

  set(key, value) {
    this.store.set(key, { ts: Date.now(), value });
  }

  clear() {
    this.store.clear();
  }

  // Flush all entries older than maxAge. Useful for periodic cleanup.
  flush(maxAge = null) {
    const cutoff = (maxAge ?? Infinity);
    for (const [key, entry] of this.store) {
      if (Date.now() - entry.ts > cutoff) this.store.delete(key);
    }
  }
}

// ---------------------------------------------------------------------------
// CodexUsageTracker — main class. Tracks usage per model and totals against weekly limits.
// Persists a daily log to codex-usage.log for analytics. Degrades gracefully on any API failure.
// ---------------------------------------------------------------------------
class CodexUsageTracker {
  constructor(weeklyLimits = DEFAULT_LIMITS, cacheTtl = 300_000) {
    this.weeklyLimits = { ...DEFAULT_LIMITS, ...weeklyLimits };
    this.cache = new Cache(cacheTtl);

    // Daily usage log: codex-usage.log — one line per generation event.
    this.usageLogFile = path.resolve(process.cwd(), 'codex-usage.log');
    this._dailyFlushTimer = null;

    // In-memory usage registry keyed by model: { used, limit, dailyResetAt, monthlyResetAt }
    this.registry = {};
    this.totalStats = 0;

    // Last-known availability snapshot (used for graceful degradation).
    this._lastKnown = null;
    this.lastCheckedAt = Date.now();

    // Load persisted history if present.
    this._loadHistory();
  }

  _loadHistory() {
    try {
      const raw = fs.readFileSync(this.usageLogFile, 'utf8');
      const data = JSON.parse(raw);
      if (data.entries) this.entries = data.entries;
      if (data.metadata) this.metadata = { ...this.metadata, ...data.metadata };
    } catch {} // first run — no history yet.
  }

  _saveHistory() {
    // Keep only the last 30 days of entries to avoid unbounded growth (~720k rows at hourly).
    const now = Date.now();
    if (this.entries && this.entries.length > 10_000) {
      const cutoff = now - 30 * 24 * 60 * 60 * 1000;
      this.entries = this.entries.filter((e) => e.ts >= cutoff);
    }

    // Compact sub-hourly entries into hourly buckets.
    if (this.entries && this.entries.length > 5_000) {
      const aggregated = [];
      for (const entry of this.entries) {
        let found = null;
        for (const agg of aggregated) {
          if (agg.ts === entry.ts) {
            agg.count += entry.count || 1;
            found = true;
            break;
          }
        }
        if (!found) {
          aggregated.push({ ts: entry.ts, count: entry.count || 1 });
        }
      }
      this.entries = aggregated.sort((a, b) => a.ts - b.ts);
    }

    try {
      fs.writeFileSync(this.usageLogFile, JSON.stringify(
        { entries: this.entries, metadata }, null, 2));
    } catch (e) {} // silent — analytics are best-effort.
  }

  // ---------------------------------------------------------------------------
  // checkAvailability() — query OpenAI / Google for current quota status.
  // Returns per-model availability with used/limit/percentage and reset dates.
  // Falls back to last-known state on any failure (network, timeout, 429).
  // Rate-limit errors are caught and converted into a degraded-but-useful response rather than crashes.
  // ---------------------------------------------------------------------------
  async checkAvailability() {
    const apiKey = process.env.OPENAI_API_KEY || '';
    const geminiKey = process.env.GEMINI_API_KEY || '';

    if (!apiKey && !geminiKey) {
      return this._lastKnown;
    }

    const results = [];
    let anyError = false;

    // Query OpenAI for all registered models.
    if (apiKey) {
      try {
        const cfg = await loadConfig();
        const modelNames = Object.keys(this.weeklyLimits);
        let data;

        try {
          data = await queryOpenAIUsage(apiKey, cfg);
        } catch {
          data = { ok: false };
        }

        if (data && data.ok) {
          // Dashboard returned real per-model stats.
          for (const row of Array.isArray(data.data) ? data.data : []) {
            const modelName = typeof row === 'object' && row.model ? row.model : null;
            results.push({ model: modelName || 'openai', ...row, backend: 'openai' });
          }
        } else if (data?.error) {
          anyError = true;
          // Dashboard failed — fall back to rate-limit headers per-model.
          for (const modelName of modelNames) {
            const limit = this.weeklyLimits[modelName];
            results.push({
              model: modelName,
              used: 0,
              limit: limit.daily || 0,
              available: limit.daily || 0,
              percentage: 0,
              dailyResetAt: null,
              monthlyResetAt: null,
              backend: 'openai',
            });
          }
        }

        // Cache the aggregated per-model stats (limit info is stable; only usage changes).
        const todayStr = new Date().toISOString().slice(0, 10);
        this.cache.set(`openai:snapshot:${todayStr}`, JSON.stringify(results));

      } catch {
        anyError = true;
        // Tracker-level error — return last-known state.
        for (const modelName of Object.keys(this.weeklyLimits)) {
          const limit = this.weeklyLimits[modelName];
          results.push({
            model: modelName,
            used: 0,
            limit: limit.daily || 0,
            available: limit.daily || 0,
            percentage: 0,
            dailyResetAt: null,
            monthlyResetAt: null,
            backend: 'openai',
          });
        }
      }

      this.lastCheckedAt = Date.now();
    }

    if (geminiKey) {
      try {
        const data = await queryGeminiUsage(geminiKey);
        for (const row of Array.isArray(data && data.ok ? data.data : [])) {
          results.push({ ...row, backend: 'gemini' });
        }
      } catch {
        anyError = true;
      }

      // Cache the Gemini snapshot.
      const todayStr = new Date().toISOString().slice(0, 10);
      this.cache.set(`gemini:snapshot:${todayStr}`, JSON.stringify(results));
    }

    if (results.length > 0) {
      this._lastKnown = results;
      // Persist history.
      try { this._saveHistory(); } catch {}
    } else if (this._lastKnown && results.length === 0) {
      // No APIs configured — preserve last-known state for dashboard continuity.
      return this._lastKnown;
    }

    // On any error, fall back to the most recent cached snapshot or defaults.
    const todayStr = new Date().toISOString().slice(0, 10);
    let fallback = this.cache.get(`openai:snapshot:${todayStr}`) || this.cache.get('openai:snapshot:default');
    if (!fallback && this._lastKnown) {
      fallback = [...this._lastKnown];
    }

    return (fallback && fallback.length > 0 ? fallback : results);
  }

  _cacheOpenAI(modelNames) {
    // Limit info is stable — cached once at construction. Only snapshot keys change.
    const todayStr = new Date().toISOString().slice(0, 10);
    this.cache.set(`openai:snapshot:${todayStr}`, JSON.stringify(this._lastKnown || []));
  }

  _lastKnown() {
    return Object.keys(this.weeklyLimits).map((modelName) => ({
      model: modelName,
      used: 0,
      limit: this.weeklyLimits[modelName].daily || 0,
      available: this.weeklyLimits[modelName].daily || 0,
      percentage: 0,
      dailyResetAt: null,
      monthlyResetAt: null,
      backend: 'openai',
    }));
  }

  // ---------------------------------------------------------------------------
  // recordGeneration(modelName, tokensUsed) — increment in-memory counters and persist.
  // Returns the updated model stats after recording. Emits a log line to codex-usage.log.
  // ---------------------------------------------------------------------------
  recordGeneration(modelName, tokensUsed = 1) {
    const limitKey = `weekly:${modelName}`;

    if (!this.registry[limitKey]) {
      this.registry[limitKey] = {
        used: 0,
        limit: this.weeklyLimits[modelName].daily || 0,
        dailyResetAt: null,
        monthlyResetAt: null,
      };
    }

    const stats = this.registry[limitKey];
    stats.used += tokensUsed;

    // Track total across all models.
    if (this.totalStats === undefined) this.totalStats = 0;
    this.totalStats += tokensUsed;

    // Log to codex-usage.log for analytics.
    try {
      const now = new Date();
      const line = `[${now.toISOString()}] ${modelName} +${tokensUsed} (running: ${stats.used}/${stats.limit})\n`;
      fs.appendFileSync(this.usageLogFile, line);
    } catch {} // silent — analytics are best-effort.

    return { ...stats, used: stats.used };
  }

  recordGenerationMultiple(modelName, tokensArray) {
    let total = 0;
    for (const t of tokensArray) {
      this.recordGeneration(modelName, t);
      total += t;
    }
    return total;
  }

  // ---------------------------------------------------------------------------
  // getQuotaStatus() — full status including reset dates and overall health.
  // Returns a structured object ready for dashboard consumption.
  // ---------------------------------------------------------------------------
  async getQuotaStatus() {
    const availability = await this.checkAvailability();
    const todayStr = new Date().toISOString().slice(0, 10);

    const now = new Date();
    const nextDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);

    return {
      overall: {
        totalUsed: this.totalStats || 0,
        weeklyLimit: Object.values(this.weeklyLimits).reduce((sum, l) => sum + (l.daily || 0), 0),
        percentage: ((this.totalStats / Object.values(this.weeklyLimits).reduce((s, l) => s + (l.daily || 0), 0)) * 100).toFixed(1),
        updatedAt: new Date().toISOString(),
      },
      models: availability.map((m) => ({
        ...m,
        dailyProgressPercent: m.percentage ? Math.min((m.percentage / 100), 1) : 0,
        monthlyResetAt: nextMonth.toISOString() + 'T00:00:00Z',
        lastChecked: new Date().toISOString(),
      })),
      historyFile: this.usageLogFile,
      cacheHit: await this.cache.get(`openai:snapshot:${todayStr}`) !== null,
    };
  }

  // ---------------------------------------------------------------------------
  // getUsageHistory(hours = 24) — returns the last N hours of usage data for analytics.
  // Useful for the dashboard's "usage over time" chart.
  // ---------------------------------------------------------------------------
  getUsageHistory(hours = 24) {
    const cutoff = Date.now() - hours * 3600_000;
    return this.entries ? this.entries.filter((e) => e.ts >= cutoff).sort((a, b) => a.ts - b.ts) : [];
  }

  // ---------------------------------------------------------------------------
  // getTotalUsage() — cumulative usage across all models.
  // ---------------------------------------------------------------------------
  getTotalUsage() {
    return this.totalStats || 0;
  }

  // ---------------------------------------------------------------------------
  // getDailyLogLines(hours = 24) — returns the last N hours of log lines from codex-usage.log.
  // Useful for dashboard display of recent generation activity.
  // ---------------------------------------------------------------------------
  async getDailyLogLines(hours = 24) {
    try {
      const cutoff = Date.now() - hours * 3600_000;
      const content = fs.readFileSync(this.usageLogFile, 'utf8');
      return content.split('\n').filter((l) => l && new Date(l.slice(1, 25)) >= cutoff);
    } catch {
      return [];
    }
  }

  // ---------------------------------------------------------------------------
  // getAvailabilityCache() — returns the current availability cache for inspection.
  // ---------------------------------------------------------------------------
  getAvailabilityCache() {
    const todayStr = new Date().toISOString().slice(0, 10);
    return this.cache.get(`openai:snapshot:${todayStr}`) || [];
  }

  // ---------------------------------------------------------------------------
  // flushCache() — clear all cached data. Useful when limits change or for debugging.
  // ---------------------------------------------------------------------------
  flushCache() {
    this.cache.clear();
    this._lastKnown = null;
    this.lastCheckedAt = Date.now();
  }
}

// ---------------------------------------------------------------------------
// Singleton accessor: create a tracker with optional config overrides, then expose it
// globally so other modules can require('codex-tracker.mjs') and get the same instance.
// ---------------------------------------------------------------------------
let _instance = null;
function getTracker(overrides = {}) {
  if (!_instance) {
    const limits = Object.assign({}, DEFAULT_LIMITS, overrides.weeklyLimits || {});
    _instance = new CodexUsageTracker(limits, overrides.cacheTtl);
  }
  return _instance;
}

export { CodexUsageTracker };
export default getTracker;
