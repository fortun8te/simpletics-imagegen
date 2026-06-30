// dashboard.mjs — ImageGen Dashboard server (Node ESM, no external deps)
// See dashboard/CONTRACT.md "Server routes" section. Listens on http://localhost:8788.

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { exec, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REPO = __dirname;
const ROOT = path.join(REPO, 'dashboard');
const RENDERS = path.join(os.homedir(), 'Downloads', 'static-factory-b1', 'renders');
const BRIDGE = 'http://localhost:8787';
const PORT = 8788;

// ---------------------------------------------------------------------------
// Codex usage tracker — loaded from codex-tracker.mjs in the same directory.
// The tracker degrades gracefully with no API keys (returns last-known state), so it's safe to import eagerly.
// ---------------------------------------------------------------------------
import { CodexUsageTracker } from './codex-tracker.mjs';

const _tracker = new CodexUsageTracker(); // created at module load — cheap, fast.

// ---------------------------------------------------------------------------
// checkBackendAvailability — uses the tracker + a direct OpenAI health probe for backend indicator.
// Returns { useCodex: boolean|null, reason, fallback, percentage, resetAt }.
// ---------------------------------------------------------------------------
async function checkBackendAvailability() {
  try {
    const quota = await _tracker.getQuotaStatus();

    // Direct OpenAI models endpoint check for rate-limit headers (gives us the current backend state).
    const apiKey = process.env.OPENAI_API_KEY || '';
    if (!apiKey) return { useCodex: null, reason: 'no-api-key', fallback: true };

    try {
      const r = await fetch('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(8000),
      });
      if (r.status === 429) return { useCodex: false, reason: 'rate-limited', fallback: true };
      const data = await r.json();
      let totalUsed = 0;
      for (const m of Array.isArray(data.data) ? data.data : []) {
        if (m.usage?.total_tokens || m.usage?.total_usage_tokens) {
          totalUsed += Number(m.usage.total_tokens);
        }
      }
      const pct = Math.min((totalUsed / 5_000_000) * 100, 100);
      return { useCodex: pct < 95, reason: pct >= 85 ? 'approaching-limit' : 'healthy', percentage: Number(pct.toFixed(1)), fallback: false };
    } catch (err) {
      if (err.name === 'AbortError') return { useCodex: null, reason: 'timeout', fallback: false };
      const pct = quota?.overall?.percentage || 0;
      return { useCodex: pct < 95, reason: pct >= 85 ? 'approaching-limit' : 'healthy', percentage: Number(pct.toFixed(1)), fallback: false };
    }
  } catch (err) {
    // Tracker failed — degrade gracefully.
    return { useCodex: null, reason: 'tracker-error', fallback: false };
  }
}

// Fetch the bridge /status; tolerate the bridge being down → null.
async function fetchBridgeStatus() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    const r = await fetch(BRIDGE + '/status', { signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}

function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8' });
}

// Resolve a bool for whether any codex generation is alive (the resume-runner OR a bare codexbatch).
function runnerAlive() {
  return new Promise((resolve) => {
    exec("pgrep -f 'codex-runner.mjs|codexbatch.mjs'", (err, stdout) => {
      resolve(!err && String(stdout).trim().length > 0);
    });
  });
}

// bridgeReachable() — reuses the existing fetchBridgeStatus() above.
async function bridgeReachable() {
  return (await fetchBridgeStatus()) != null;
}

// Parse "run-3-v2.png" → { num:3, version:2 }; "run-3.png" → { num:3, version:1 }.
function parseRun(name) {
  const m = /^run-(\d+)(?:-v(\d+))?\.png$/i.exec(name);
  if (!m) return null;
  return { num: parseInt(m[1], 10), version: m[2] ? parseInt(m[2], 10) : 1 };
}

// Scan one prompt dir for its run-*.png files → sorted runs array.
async function scanPromptRuns(brand, batch, adId, varId, promptId) {
  const dir = path.join(RENDERS, brand, batch, 'ads', adId, varId, promptId);
  let names = [];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return [];
  }
  const runs = [];
  for (const name of names) {
    const parsed = parseRun(name);
    if (!parsed) continue;
    let mtime = 0;
    try {
      mtime = (await fsp.stat(path.join(dir, name))).mtimeMs;
    } catch {
      continue;
    }
    const relPath = [brand, batch, 'ads', adId, varId, promptId, name].join('/');
    runs.push({ version: parsed.version, relPath, mtime, _num: parsed.num });
  }
  runs.sort((a, b) => (a._num - b._num) || (a.version - b.version));
  return runs.map(({ version, relPath, mtime }) => ({ version, relPath, mtime }));
}

async function readConfig() {
  const raw = await fsp.readFile(path.join(REPO, 'config.json'), 'utf8');
  return JSON.parse(raw);
}

// Find a brand object in config by id (tolerant of shape).
function findBrand(config, brandId) {
  const brands = (config && config.brands) || [];
  return brands.find((b) => b && (b.id === brandId || b.brand === brandId)) || null;
}

// Find a batch object within config for the given brand+batch code (tolerant).
function findBatch(config, brandId, batchCode) {
  // Batches may live on the brand or at top level.
  const brand = findBrand(config, brandId);
  const candidates = [];
  if (brand && Array.isArray(brand.batches)) candidates.push(...brand.batches);
  if (Array.isArray(config.batches)) candidates.push(...config.batches);
  return candidates.find(
    (b) => b && (b.code === batchCode || b.id === batchCode || b.batch === batchCode)
  ) || null;
}

// Build the ads tree for /api/state by reading config structure and scanning runs.
async function buildAds(config, brandId, batchCode) {
  const batch = findBatch(config, brandId, batchCode);
  const adsSrc = (batch && Array.isArray(batch.ads)) ? batch.ads : [];
  const ads = [];
  for (const ad of adsSrc) {
    const adId = ad.id || ad.code || ad.name;
    const variationsSrc = Array.isArray(ad.variations) ? ad.variations : [];
    const variations = [];
    for (const v of variationsSrc) {
      const varId = v.id || v.label || v.code;
      // Use the descriptive label when available, otherwise a numbered fallback instead of bare IDs.
      const variationLabel = v.label || `Variation ${v.id}`;
      const promptsSrc = Array.isArray(v.prompts) ? v.prompts : [];
      const prompts = [];
      for (const p of promptsSrc) {
        const promptId = p.id || p.code || p.name;
        const runs = await scanPromptRuns(brandId, batchCode, adId, varId, promptId);
        prompts.push({ id: promptId, runs });
      }
      variations.push({ id: varId, label: variationLabel, prompts });
    }
    ads.push({ id: adId, title: ad.title || ad.name || `${escape(ad.product)} ${ad.type || ''}`, type: ad.type || '', variations });
  }
  return ads;
}

// ---- request body helper ----
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => resolve(data));
    req.on('error', () => resolve(''));
  });
}

// ---- static file serving from dashboard/ ----
async function serveStatic(res, relName) {
  const filePath = path.join(ROOT, relName);
  // Keep static reads inside ROOT.
  const resolved = path.resolve(filePath);
  if (resolved !== path.resolve(ROOT) && !resolved.startsWith(path.resolve(ROOT) + path.sep)) {
    return send(res, 403, 'Forbidden');
  }
  try {
    const buf = await fsp.readFile(resolved);
    const ext = path.extname(resolved).toLowerCase();
    send(res, 200, buf, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  } catch {
    send(res, 404, 'Not found');
  }
}

// ---- /img with path-traversal guard ----
async function serveImg(res, relPath) {
  if (!relPath) return send(res, 404, 'Not found');
  const joined = path.join(RENDERS, relPath);
  const resolved = path.resolve(joined);
  const base = path.resolve(RENDERS);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    return send(res, 403, 'Forbidden');
  }
  try {
    const buf = await fsp.readFile(resolved);
    send(res, 200, buf, { 'Content-Type': 'image/png' });
  } catch {
    send(res, 404, 'Not found');
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost:' + PORT);
    const pathname = url.pathname;
    const method = req.method || 'GET';

    // GET / and /index.html
    if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      return serveStatic(res, 'index.html');
    }

    // GET /<name>.css | /<name>.js
    if (method === 'GET' && /^\/[^/]+\.(css|js)$/.test(pathname)) {
      return serveStatic(res, pathname.slice(1));
    }

    // GET /api/config
    if (method === 'GET' && pathname === '/api/config') {
      try {
        const config = await readConfig();
        return sendJson(res, 200, config);
      } catch {
        return sendJson(res, 500, {});
      }
    }

    // GET /api/state
    if (method === 'GET' && pathname === '/api/state') {
      const brand = url.searchParams.get('brand') || '';
      const batch = url.searchParams.get('batch') || '';
      let config = {};
      try { config = await readConfig(); } catch { config = {}; }
      let ads = [];
      try { ads = await buildAds(config, brand, batch); } catch { ads = []; }
      const status = await fetchBridgeStatus();
      const codexProgress = status && status.codexProgress ? status.codexProgress : null;
      const queue = status && status.queue ? status.queue : null;
      const alive = await runnerAlive();
      return sendJson(res, 200, {
        brand,
        batch,
        ads,
        codexProgress,
        queue,
        runner: { alive },
      });
    }

    // GET /img?path=
    if (method === 'GET' && pathname === '/img') {
      return serveImg(res, url.searchParams.get('path') || '');
    }

    // GET /api/codex/log
    if (method === 'GET' && pathname === '/api/codex/log') {
      let text = '';
      try {
        const buf = await fsp.readFile(path.join(REPO, 'codex-runner.log'), 'utf8');
        text = buf.length > 6000 ? buf.slice(buf.length - 6000) : buf;
      } catch {
        text = '';
      }
      return send(res, 200, text, { 'Content-Type': 'text/plain; charset=utf-8' });
    }

    // GET /api/codex/usage — current quota status + per-model breakdown.
    if (method === 'GET' && pathname === '/api/codex/usage') {
      const tracker = _tracker;
      let quotaStatus;
      try { quotaStatus = await tracker.getQuotaStatus(); } catch {}

      // Fallback availability check for the backend indicator.
      const backendCheck = await checkBackendAvailability(tracker);

      return sendJson(res, 200, {
        overall: quotaStatus?.overall || {},
        models: quotaStatus?.models || [],
        historyFile: quotaStatus?.historyFile || null,
        cacheHit: quotaStatus?.cacheHit,
        backendIndicator: backendCheck.useCodex,
        updatedAt: new Date().toISOString(),
      });
    }

    // POST /api/fallback/check — checks if Codex is available; records a generation event.
    if (method === 'POST' && pathname === '/api/fallback/check') {
      let body = {};
      try { body = JSON.parse(await readBody(req) || '{}'); } catch {}

      const tracker = _tracker;
      const model = body.model || 'gpt-image-2';
      const tokens = Number(body.tokens) || 1;

      // Record the generation so in-memory counters stay accurate.
      try { tracker.recordGeneration(model, tokens); } catch {}

      // Check backend availability for the decision result.
      const checkResult = await checkBackendAvailability(tracker);

      return sendJson(res, 200, checkResult);
    }

    // POST /api/fallback/status — lightweight poll for dashboard to show live fallback state.
    if (method === 'POST' && pathname === '/api/fallback/status') {
      const tracker = _tracker;
      try {
        await tracker.getQuotaStatus();
        return sendJson(res, 200, { ok: true, timestamp: Date.now() });
      } catch {
        return sendJson(res, 503, { ok: false, error: 'tracker-unavailable' });
      }
    }

    // POST /api/codex/run
    if (method === 'POST' && pathname === '/api/codex/run') {
      const alive = await runnerAlive();
      if (alive) {
        return sendJson(res, 409, { ok: false, error: 'already running' });
      }
      let body = {};
      try { body = JSON.parse(await readBody(req) || '{}'); } catch { body = {}; }
      const brand = body.brand || 'nanox';
      const batch = body.batch;
      const variants = Math.max(1, Math.min(6, Number(body.variants) || 2));
      // "Run in Codex" = generate <variants> fresh variations of this batch NOW (never-overwrite adds
      // new versions). codexbatch does one pass; the runner-alive guard above (which now also matches a
      // bare codexbatch) prevents a second overlapping run.
      const child = spawn('node', ['codexbatch.mjs', 'edu', '--brand=' + brand, '--batch=' + batch], {
        cwd: REPO,
        env: { ...process.env, VARIANTS: String(variants) },
        stdio: 'ignore',
        detached: true,
      });
      child.unref();
      return sendJson(res, 200, { ok: true, brand, batch, variants });
    }

    // POST /api/codex/stop
    if (method === 'POST' && pathname === '/api/codex/stop') {
      exec('pkill -f codex-runner.mjs; pkill -f codexbatch.mjs', () => {});
      return sendJson(res, 200, { ok: true });
    }

    // GET /api/health
    if (method === 'GET' && pathname === '/api/health') {
      const [bridge, runner] = await Promise.all([bridgeReachable(), runnerAlive()]);
      return sendJson(res, 200, { ok: true, bridge, runner });
    }

    return send(res, 404, 'Not found');
  } catch (err) {
    try { sendJson(res, 500, { ok: false, error: String(err && err.message || err) }); } catch {}
  }
});

server.listen(PORT, () => {
  console.log('[dashboard] http://localhost:8788  renders=' + RENDERS);
});
