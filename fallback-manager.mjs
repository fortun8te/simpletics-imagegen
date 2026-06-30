// fallback-manager.mjs — Auto-fallback system for switching between Codex and ChatGPT backends.
// Checks Codex availability BEFORE starting a batch (not mid-job). If Codex is exhausted,
// automatically switches to the ChatGPT extension via bridge. Tracks which jobs used which
// backend for reporting. Production-ready: handles rate limits, timeouts, network failures,
// and gracefully degrades when APIs are unreachable.
//
//   import { FallbackManager } from './fallback-manager.mjs'

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const FALLBACK_LOG_FILE = 'fallback-log.json';
const HEALTHY_THRESHOLD = 0.85;    // Above 85% → Codex is "low on quota" (warning only)
const EXHAUSTED_THRESHOLD = 0.95;  // Above 95% → switch to ChatGPT before hitting the limit

// ---------------------------------------------------------------------------
// FallbackManager — decides whether to use Codex or fall back to ChatGPT bridge.
// ---------------------------------------------------------------------------
class FallbackManager {
  constructor(bridgeUrl = 'http://localhost:8787', codexTracker) {
    this.bridgeUrl = bridgeUrl;
    this.codexTracker = codexTracker || null;

    // In-memory state
    this.lastCodexCheck = null;
    this._lastQuota = null;
    this.lastCheckedAt = Date.now();
    this.checkCacheTtl = 60_000;   // 1 minute — don't check every time (APIs are rate-limited)
    this.forceCodex = false;       // Manual override: always try Codex first
    this.codexExhaustedCount = 0;

    // Per-job backend tracking: jobId -> { backend, startedAt }
    this.jobBackends = new Map();

    // History of fallback decisions (last 200 entries) for analytics.
    this.history = [];
    this._loadHistory();

    // Notification callback (injectable for testing) — defaults to console.log.
    this.onFallbackEvent = null;
  }

  _loadHistory() {
    if (!fs.existsSync(FALLBACK_LOG_FILE)) {
      fs.writeFileSync(FALLBACK_LOG_FILE, JSON.stringify({ entries: [], metadata: {} }));
    }
    try {
      const raw = fs.readFileSync(FALLBACK_LOG_FILE, 'utf8');
      const data = JSON.parse(raw);
      if (data.entries) this.history = data.entries;
      if (data.metadata) this.metadata = { ...this.metadata, ...data.metadata };
    } catch {}
  }

  // ---------------------------------------------------------------------------
  // shouldUseCodex() — check if Codex is available and healthy enough to use.
  // Returns { useCodex: boolean|null, reason: string, fallback: boolean, percentage?: number, resetAt?: string }.
  //   useCodex === true    → safe to use Codex
  //   useCodex === false   → Codex exhausted, MUST fall back
  //   useCodex === null    → unknown state (API unreachable) — caller decides
  // If Codex is exhausted (>= EXHAUSTED_THRESHOLD), returns { fallback: true }.
  // Uses cached data when within checkCacheTtl to avoid hammering APIs.
  // ---------------------------------------------------------------------------
  async shouldUseCodex() {
    if (this.forceCodex) return { useCodex: true, reason: 'forced', fallback: false };

    // Check cache first — avoid hammering APIs on every call.
    const cached = this._getCachedStatus();
    if (cached !== null) {
      const pct = this._computePercentage(cached);
      return this._buildDecision(pct, cached.resetAt || null);
    }

    // No cached data — fetch fresh from the tracker or directly.
    try {
      let quota;
      if (this.codexTracker) {
        quota = await this.codexTracker.getQuotaStatus();
      } else {
        // Fallback: make a direct HTTP check against OpenAI's models endpoint to see if we're rate-limited.
        const apiKey = process.env.OPENAI_API_KEY || '';
        if (!apiKey) return { useCodex: false, reason: 'no-api-key', fallback: true };

        try {
          quota = await this._queryOpenAIRateLimits(apiKey);
        } catch (err) {
          // Network error or timeout — degrade gracefully. Don't force fallback on a transient blip.
          return { useCodex: null, reason: 'api-unreachable', fallback: false };
        }

        if (!quota || !quota.ok) {
          const models = quota.data || [];
          let totalUsed = 0;
          for (const m of models) {
            if (m.usage?.total_usage_tokens || m.usage?.total_tokens) {
              totalUsed += Number(m.usage.total_tokens);
            }
          }
          return this._buildDecision(
            Math.min((totalUsed / 5_000_000) * 100, 100), // rough estimate against weekly limit
            null
          );
        }

        const pct = quota.overall?.percentage || 0;
        this._cacheStatus(quota);
        return this._buildDecision(pct, quota.models[0]?.dailyResetAt || null);
      }

      if (quota && !quota.overall) {
        // Tracker returned something unexpected. Use safe defaults.
        return this._buildDecision(0, null);
      }

      const pct = quota?.overall?.percentage || 0;
      this._cacheStatus(quota);
      return this._buildDecision(pct, quota?.models[0]?.dailyResetAt || null);
    } catch (err) {
      // Tracker itself failed — last resort. Use cached state or degrade gracefully.
      const cached = this._getCachedStatus();
      if (cached && cached.percentage !== undefined) return this._buildDecision(cached.percentage, cached.resetAt || null);
      return { useCodex: null, reason: 'tracker-error', fallback: false };
    }
  }

  // ---------------------------------------------------------------------------
  // _queryOpenAIRateLimits — direct fetch of OpenAI rate-limit headers for a quick health check.
  // Uses AbortSignal.timeout() for automatic cancellation (no manual controller needed).
  // ---------------------------------------------------------------------------
  async _queryOpenAIRateLimits(apiKey) {
    try {
      const r = await fetch('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(8000), // 8s timeout — don't wait forever on a health check
      });

      if (r.status === 429) return { ok: false, error: 'rate-limited', status: 429 };
      if (!r.ok && r.status >= 500) return { ok: false, error: `server-${r.status}` };

      const data = await r.json();
      // Extract per-model usage from response metadata. Gemini/OpenAI both return this shape.
      const models = Array.isArray(data.data) ? data.data : [];
      let totalUsed = 0;
      for (const m of models) {
        if (m.usage?.total_usage_tokens || m.usage?.total_tokens) {
          totalUsed += Number(m.usage.total_tokens);
        }
      }

      // Parse rate-limit headers for reset dates.
      const headers = r.headers;
      let dailyResetAt = null;
      try {
        if (headers['x-ratelimit-reset'] || headers['ratelimit-reset']) {
          dailyResetAt = new Date(headers['x-ratelimit-reset'] || headers['ratelimit-reset']).toISOString();
        }
      } catch {}

      return { ok: true, models, totalUsed, limit: 5_000_000, percentage: Math.min((totalUsed / 5_000_000) * 100, 100), dailyResetAt };
    } catch (err) {
      if (err instanceof TypeError && err.message.includes('timeout')) {
        return { ok: false, error: 'timeout', details: `OpenAI models endpoint exceeded 8s timeout` };
      }
      throw err; // Re-throw non-timeout errors to caller.
    }
  }

  _getCachedStatus() {
    const now = Date.now();
    if (this.lastCheckedAt && (now - this.lastCheckedAt) < this.checkCacheTtl) {
      return this._lastQuota;
    }
    return null;
  }

  _cacheStatus(quota) {
    this._lastQuota = quota;
    this.lastCheckedAt = Date.now();
  }

  _computePercentage(quota) {
    return quota?.overall?.percentage || 0;
  }

  // ---------------------------------------------------------------------------
  // _buildDecision — convert a percentage into a concrete yes/no decision.
  // Thresholds: HEALTHY_THRESHOLD (85%) and EXHAUSTED_THRESHOLD (95%).
  // ---------------------------------------------------------------------------
  _buildDecision(percentage, resetAt) {
    if (percentage === null || percentage === undefined) return { useCodex: null, reason: 'unknown', fallback: false };
    if (percentage >= EXHAUSTED_THRESHOLD) {
      this.codexExhaustedCount++;
      const reason = `quota-exceeded (${percentage.toFixed(1)}%)`;
      // Fire notification callback so Telegram / dashboard can react.
      this._fireEvent('codex-exhausted', { percentage, resetAt });
      return {
        useCodex: false,
        reason,
        fallback: true,
        percentage,
        resetAt,
        exhaustedCount: this.codexExhaustedCount,
      };
    }
    if (percentage > HEALTHY_THRESHOLD) {
      // Approaching limit — warn but allow usage. Codex may still serve a job successfully.
      const reason = `approaching-limit (${percentage.toFixed(1)}%)`;
      this._fireEvent('codex-warning', { percentage, resetAt });
      return { useCodex: true, reason, fallback: false, percentage };
    }
    return { useCodex: true, reason: 'healthy', fallback: false, percentage };
  }

  // ---------------------------------------------------------------------------
  // _fireEvent — dispatch the onFallbackEvent callback if set. Used for notifications.
  // ---------------------------------------------------------------------------
  _fireEvent(event, data) {
    try {
      this.onFallbackEvent?.(event, data);
    } catch (err) {
      console.error(`[fallback] notification error (${event}):`, err.message);
    }
  }

  // ---------------------------------------------------------------------------
  // executeWithFallback(job) — try Codex first. If exhausted or unhealthy, switch to ChatGPT bridge.
  // Returns { backend: 'codex'|'chatgpt', job, result }. Tracks backend usage in history for analytics.
  // Executes BEFORE the job starts (not mid-job). On failure at any stage, falls back to bridge.
  // ---------------------------------------------------------------------------
  async executeWithFallback(job) {
    const jobId = this.jobBackends.size > 0 ? [...this.jobBackends.keys()].pop() : `job-${Date.now().toString(36)}`;

    if (!job || !job.name) return { error: 'invalid-job', backend: null };

    // Check Codex availability BEFORE starting the job (not mid-job).
    const codexCheck = await this.shouldUseCodex();

    if (!codexCheck.useCodex && codexCheck.fallback) {
      // Codex is exhausted — switch to ChatGPT bridge immediately.
      return this._executeViaBridge(job, 'chatgpt', codexCheck.reason);
    }

    // Codex is available (or we're forcing it). Try Codex first.
    try {
      const result = await this._executeViaCodex(job);
      if (result.ok) {
        this.jobBackends.set(jobId, { backend: 'codex', startedAt: Date.now() });
        return { ...result, backend: 'codex' };
      }

      // Codex failed — fall back to ChatGPT.
      console.log(`[fallback] Codex failed for "${job.name}" (${result.error}) → switching to ChatGPT`);
      this.history.push({ jobId, name: job.name, attemptedBackend: 'codex', failedError: result.error });
      return this._executeViaBridge(job, 'chatgpt', `codex-failed-${result.error}`);
    } catch (err) {
      // Unexpected error from Codex — fall back.
      console.log(`[fallback] Codex threw for "${job.name}": ${err.message} → switching to ChatGPT`);
      this.history.push({ jobId, name: job.name, attemptedBackend: 'codex', failedError: err.message });
      return this._executeViaBridge(job, 'chatgpt', `codex-throw-${err.message}`);
    }
  }

  // ---------------------------------------------------------------------------
  // _executeViaCodex — try running via codex-runner.mjs (the existing runner).
  // Detects rate-limit signals in stdout/stderr and returns a structured failure.
  // ---------------------------------------------------------------------------
  async _executeViaCodex(job) {
    return new Promise((resolve, reject) => {
      const child = process.spawn('node', ['codex-runner.mjs'], {
        cwd: path.resolve(process.cwd()),
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (d) => { stdout += d.toString(); process.stdout.write(d); });
      child.stderr.on('data', (d) => { stderr += d.toString(); });
      child.on('close', async (code, signal) => {
        const text = stdout + stderr;

        // Detect rate-limit / usage-limit signals in output.
        const limitedPatterns = [/HTTP 429/, /usage limit/, /too many requests/i, /rate.?limit/i];
        let limited = false;
        for (const pat of limitedPatterns) {
          if (pat.test(text)) { limited = true; break; }
        }

        // Also check OpenAI rate-limit headers from the runner output.
        const headerMatch = text.match(/HTTP\/1\.1\s+429/);
        if (!limited && headerMatch) limited = true;

        if (limited) {
          resolve({ ok: false, error: 'codex-rate-limited', fallback: true });
          return;
        }

        if (code !== 0) {
          // Non-zero exit — check if it's a known transient error.
          const exitCodes = {
            137: 'oom-killed',
            143: 'signal-terminated',
          };
          resolve({ ok: false, error: `codex-exit-${code}`, fallback: true });
        } else {
          resolve({ ok: true, output: stdout || '', backend: 'codex' });
        }

        this.jobBackends.set(jobId, { backend: 'codex', startedAt: Date.now() });
      });

      child.on('error', (err) => {
        // Spawn failed — fall back gracefully. This is rare but can happen if codex-runner.mjs doesn't exist.
        console.log(`[fallback] codex-runner spawn error for "${job.name}": ${err.message}`);
        resolve({ ok: false, error: `spawn-error-${err.code}`, fallback: true });
      });

      // 30-second timeout — if the runner is hung, don't block forever.
      setTimeout(() => {
        try { child.kill('SIGTERM'); } catch {}
        reject(new Error('codex-runner-timedout'));
      }, 30_000);
    });
  }

  // ---------------------------------------------------------------------------
  // _executeViaBridge — route the job through the bridge (ChatGPT extension).
  // Uses fetch() for modern, timeout-aware HTTP. Returns structured result.
  // ---------------------------------------------------------------------------
  async _executeViaBridge(job, backend) {
    try {
      const data = JSON.stringify({ jobs: [{ name: job.name, prompt: job.prompt }] });

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000); // 10s timeout for enqueue.

      const response = await fetch(`${this.bridgeUrl}/enqueue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: data,
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        return { ok: false, error: `bridge-${response.status}`, fallback: true };
      }

      let result;
      try {
        result = JSON.parse(text || '{}');
      } catch {
        return { ok: false, error: 'bridge-parse-error', fallback: true };
      }

      this.jobBackends.set(jobId, { backend, startedAt: Date.now() });
      return { ok: true, response: result, backend };
    } catch (err) {
      if (err.name === 'AbortError') {
        return { ok: false, error: 'bridge-timeout', fallback: true };
      }
      console.log(`[fallback] bridge error for "${job.name}": ${err.message}`);
      this.jobBackends.set(jobId, { backend, startedAt: Date.now() });
      return { ok: false, error: `bridge-${err.message}`, fallback: true };
    }
  }

  // ---------------------------------------------------------------------------
  // reportStatus(status) — log the fallback decision and persist to history.
  // Status: 'codex-success', 'codex-failed', 'chatgpt-used'
  // ---------------------------------------------------------------------------
  reportStatus(status, jobName = null) {
    const entry = {
      ts: new Date().toISOString(),
      status,
      name: jobName || 'unknown',
      backendUsed: status === 'codex-failed' ? 'chatgpt' : (status === 'codex-success' ? 'codex' : null),
    };

    this.history.push(entry);
    // Keep history bounded at 200 entries.
    if (this.history.length > 200) {
      this.history = this.history.slice(-100);
    }

    try {
      fs.writeFileSync(FALLBACK_LOG_FILE, JSON.stringify(
        { entries: this.history, metadata: { totalEntries: this.history.length }, timestamp: Date.now() },
        null, 2));
    } catch {} // silent — analytics are best-effort.
  }

  // ---------------------------------------------------------------------------
  // getBackendStats() — returns how many jobs used which backend (for reporting).
  // Aggregates from both in-memory jobBackends and history entries.
  // ---------------------------------------------------------------------------
  getBackendStats() {
    const stats = { codex: 0, chatgpt: 0, unknown: 0 };

    // From in-memory tracking.
    for (const [, info] of this.jobBackends) {
      if (info.backend === 'codex') stats.codex++;
      else if (info.backend === 'chatgpt') stats.chatgpt++;
      else stats.unknown++;
    }

    // Also count from history.
    const hist = {};
    for (const entry of this.history) {
      const backend = entry.backendUsed || 'unknown';
      hist[backend] = (hist[backend] || 0) + 1;
    }

    return stats;
  }

  // ---------------------------------------------------------------------------
  // getLastFallbackEvent() — returns the most recent fallback event for dashboard display.
  // Useful for showing "Codex exhausted → switching to ChatGPT" messages in real-time.
  // ---------------------------------------------------------------------------
  getLastFallbackEvent() {
    return this.history.length > 0 ? this.history[this.history.length - 1] : null;
  }

  // ---------------------------------------------------------------------------
  // getTotalExhaustedCount() — cumulative count of times Codex was exhausted and we fell back.
  // Useful for long-running monitoring dashboards.
  // ---------------------------------------------------------------------------
  getTotalExhaustedCount() {
    return this.codexExhaustedCount;
  }

  // ---------------------------------------------------------------------------
  // forceCodexOn() / forceCodexOff() — manual override for testing or forced Codex use.
  // ---------------------------------------------------------------------------
  forceCodexOn() {
    this.forceCodex = true;
    console.log('[fallback] forcing Codex (manual override)');
  }

  forceCodexOff() {
    this.forceCodex = false;
    console.log('[fallback] Codex override cleared');
  }

  // ---------------------------------------------------------------------------
  // resetCache() — clear the availability cache. Useful when limits change or after a forced fallback.
  // ---------------------------------------------------------------------------
  resetCache() {
    this.lastCheckedAt = null;
    this._lastQuota = null;
  }
}

export { FallbackManager };
export default FallbackManager;
