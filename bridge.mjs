#!/usr/bin/env node
// Simpletics ImageGen bridge.
// The one piece that lets Claude drive generation through the user's REAL ChatGPT
// session (where images render and it's the normal quota). Claude enqueues jobs here;
// the extension polls /next, runs each in the live ChatGPT tab, and POSTs the PNG back,
// which this server writes to disk so Claude has the files. No browser automation, no
// Codex bucket: the user's own logged-in tab does the work.
//
//   node bridge.mjs [--port 8787] [--out /abs/render/dir]
//
// Claude:    curl -s -XPOST localhost:8787/enqueue -d '{"jobs":[...],"out":"/abs"}'
//            curl -s localhost:8787/status
// Extension: GET /next  -> one pending job   |   POST /result {id, ok, dataUrl|error}
import http from 'node:http';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { startTelegramControl, sendPhoto, sendMessage, helpText } from './telegram-control.mjs';
import { applyQueueCommand, queueSnapshot, writeVariants } from './bridge-queue.mjs';
import { CodexUsageTracker } from './codex-tracker.mjs';

// ---------------------------------------------------------------------------
// Lazy-init the Codex usage tracker and FallbackManager. They're not created at module load
// because API keys may not be set yet — first use triggers initialization. The Codex tracker
// degrades gracefully with no keys (returns last-known state), so this never throws.
// ---------------------------------------------------------------------------
let _codexTracker = null;
function getCodexTracker() {
  if (!_codexTracker) {
    try {
      _codexTracker = new CodexUsageTracker();
    } catch {}
  }
  return _codexTracker;
}

// FallbackManager is only needed when Codex is configured (has API keys). It's created on first use.
let _fallbackManager = null;
function getFallbackManager() {
  if (!_fallbackManager) {
    try {
      const tracker = getCodexTracker();
      _fallbackManager = new FallbackManager(process.env.BRIDGE_URL || 'http://localhost:8787', tracker);
    } catch {}
  }
  return _fallbackManager;
}

// Record a generation event so the in-memory counter stays accurate.
function recordGeneration(model, tokens) {
  try { getCodexTracker().recordGeneration(model, Number(tokens)); } catch {}
}

// Codex availability check — returns a snapshot of current quota status. Falls back to defaults if no API keys are set.
async function getCodexAvailability() {
  const tracker = getCodexTracker();
  try {
    return await tracker.getQuotaStatus();
  } catch {
    // Tracker unavailable — return safe defaults so the dashboard still renders.
    return {
      overall: { totalUsed: 0, weeklyLimit: 2_550_000, percentage: '0.0', updatedAt: new Date().toISOString() },
      models: [
        { model: 'gpt-image-1', used: 0, limit: 50_000, available: 50_000, percentage: 0, dailyResetAt: null, backend: 'openai' },
        { model: 'gpt-image-2', used: 0, limit: 500_000, available: 500_000, percentage: 0, dailyResetAt: null, backend: 'openai' },
        { model: 'gemini-pro-vision', used: 0, limit: 1_000_000, available: 1_000_000, percentage: 0, dailyResetAt: null, backend: 'gemini' },
      ],
    };
  }
}

// Check whether Codex is currently healthy enough to use. Returns the decision object from FallbackManager.
async function checkCodexAvailability() {
  const manager = getFallbackManager();
  if (!manager) return { useCodex: null, reason: 'tracker-not-configured', fallback: false };

  try {
    return await manager.shouldUseCodex();
  } catch (err) {
    // Last-resort: return cached state or degrade gracefully.
    const cached = manager._getCachedStatus?.() || {};
    if (cached.percentage !== undefined) return manager._buildDecision(cached.percentage, cached.resetAt || null);
    return { useCodex: null, reason: 'fallback-check-error', fallback: false };
  }
}

const arg = (f, d) => { const i = process.argv.indexOf(f); return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const PORT = Number(arg('--port', '8787'));
let OUT = resolve(arg('--out', join(process.env.HOME, 'Downloads', 'static-factory-b1', 'renders')));

const jobs = new Map(); // id -> job
const reported = new Map(); // name -> last reported job payload (for /regen)
let reportSeenBatch = false; // low-noise: only announce the first "generating" of a wave
let seq = 0;
let reloadRequested = false; // Claude can POST /reload to make the extension reload itself
let abortRequested = false; // /command {type:'abort'} latches this; next /next returns {abort:true} once
let paused = false;
// Codex-backend batch progress (codexbatch.mjs renders via the separate Codex-usage quota and POSTs
// here). Mirrored into /status and /health so the extension panel can show codex progress in sync.
let codexProgress = null;
// Codex-backend result relay. codexbatch.mjs already wrote each finished image to disk itself; it
// POSTs the dataURL here only so the extension panel can show a live preview. The bridge does NOT
// write files for these — it just buffers them until the background drains them via /codex-results.
const codexResults = [];
// Health signals for agentic introspection. lastPollAt: last /next poll (extension liveness).
// lastLoggedIn/lastPingAt: last /ping from the extension reporting ChatGPT login state.
let lastPollAt = 0, lastLoggedIn = null, lastPingAt = 0;

// Telegram milestones reuse the skill's notify.mjs (genStarted / genHalfway / genDone /
// blocked). One-way, prints when no token is set. Fired as the batch moves, not per image.
const NOTIFY = process.env.SF_NOTIFY || join(process.env.HOME, '.claude', 'skills', 'static-factory', 'scripts', 'notify.mjs');
let BATCH_N = 1, fired = { start: false, half: false, done: false, blocked: false };
function notify(event, data) { try { spawn('node', [NOTIFY, '--event', event, '--data', JSON.stringify(data)], { stdio: 'ignore' }); } catch {} }
function counts() { return queueSnapshot(jobs, { paused }); }
// A phone-friendly live summary. Pulls in jobs reported by the extension panel (which
// never enter the bridge queue) so the count reflects everything generating, not just
// Claude-enqueued work.
function statusMessage() {
  const c = queueSnapshot(jobs, { paused });
  const generating = [...reported.values()].filter((r) => r.status === 'generating').map((r) => r.name);
  const reportedErrors = [...reported.values()].filter((r) => r.status === 'error').length;
  const current = c.current || generating[0] || null;
  const live = c.running + generating.length;
  const errors = c.error + reportedErrors;
  const lines = [`ImageGen: ${c.done}/${c.total} done`];
  if (live) lines.push(`${live} generating`);
  if (c.pending) lines.push(`${c.pending} waiting`);
  if (errors) lines.push(`${errors} failed`);
  if (c.skipped) lines.push(`${c.skipped} skipped`);
  let text = lines.join(', ') + '.';
  if (current) text += `\nNow: ${current}`;
  if (paused) text += '\nPaused.';
  return text;
}
function command(command) {
  if (command.type === 'help') { return { message: helpText() }; }
  if (command.type === 'pause') { paused = true; return { message: 'ImageGen paused after the current image.' }; }
  if (command.type === 'resume') { paused = false; return { message: 'ImageGen resumed.' }; }
  if (command.type === 'skip') { const job = [...jobs.values()].find((j) => j.status === 'pending'); if (!job) return { message: 'Nothing is waiting to skip.' }; job.status = 'skipped'; job.error = 'skipped from Telegram'; milestones(); return { message: `Skipped ${job.name}.` }; }
  if (command.type === 'retry') { const job = [...jobs.values()].find((j) => j.name === command.name && (j.status === 'error' || j.status === 'skipped')); if (!job) return { message: `No failed job named ${command.name}.` }; job.status = 'pending'; job.error = null; return { message: `Retrying ${job.name}.` }; }
  if (command.type === 'regen') { return regen(command.name); }
  if (command.type === 'runs') return applyQueueCommand(jobs, command, { nextId: () => `j${++seq}` });
  // Abort: clear the queue, unpause, reset milestones (like /reset) and latch abortRequested so the
  // next /next returns {abort:true} exactly once. The extension consumes that to abort its tabs.
  if (command.type === 'abort') { jobs.clear(); paused = false; fired = { start: false, half: false, done: false, blocked: false }; abortRequested = true; console.log('[bridge] abort requested; queue cleared, extension will abort on next poll'); return { message: 'Aborting: queue cleared, the extension will stop its tabs on the next poll.' }; }
  return { message: 'Unknown command.' };
}
// Re-enqueue an image by name. First try a queue job already known to the bridge,
// otherwise fall back to the last payload the extension reported for that name so panel
// runs are regenerable too. Pushes a fresh pending job the extension will pick up.
function regen(name) {
  const existing = [...jobs.values()].find((j) => j.name === name);
  if (existing) { existing.status = 'pending'; existing.error = null; delete existing.path; return { message: `Regenerating ${name}.` }; }
  const ref = reported.get(name);
  if (!ref) return { message: `No job named ${name} to regenerate.` };
  const id = `j${++seq}`;
  jobs.set(id, { id, name: ref.name, prompt: ref.prompt, refs: ref.refs || [], project: ref.project || null, relativePath: ref.relativePath || null, aspect: ref.aspect || null, status: 'pending' });
  return { message: `Regenerating ${name}.` };
}
// Normalize a ref entry to { dataUrl, name }. Two shapes are accepted: { dataUrl, name } (used
// as-is) and { path } (read from disk so callers can enqueue tiny path payloads instead of huge
// base64). A path that cannot be read is skipped with a warning rather than crashing the enqueue.
function resolveRefs(refs) {
  const out = [];
  for (const r of refs || []) {
    if (!r) continue;
    if (r.dataUrl) { out.push({ dataUrl: r.dataUrl, name: r.name }); continue; }
    if (r.path) {
      try {
        const b64 = readFileSync(r.path).toString('base64');
        out.push({ dataUrl: `data:image/png;base64,${b64}`, name: r.name || basename(r.path) });
      } catch (e) {
        console.log(`[bridge] skipping ref (could not read ${r.path}): ${e.message || e}`);
      }
      continue;
    }
  }
  return out;
}
// Orphan watchdog. A job is served to a lane via /next and marked "running"; only /result moves it
// off "running". If that lane's service worker is evicted mid-generation (the recurring MV3 bug)
// the job never gets a /result and would sit "running" forever, stalling the whole batch. Here we
// re-drive any job that has been "running" longer than ORPHAN_MS: re-queue it (back to "pending")
// up to MAX_ATTEMPTS so a transient eviction self-heals, then fail it permanently so the batch can
// settle instead of hanging. A generation takes ~2min, so ORPHAN_MS is set well above that.
// This timer runs every 20 seconds (setInterval(reclaimOrphans, 20 * 1000).unref() at module end)
// and fires even when the extension has stopped polling /next entirely — it never depends on a
// connected poller to recover stuck jobs. The bridge process itself is long-running and unref'd,
// so this watchdog survives any pause in extension activity.
const ORPHAN_MS = 10 * 60 * 1000; // 10min: a multi-variant job is N sequential generations + retries, far longer than one
const MAX_ATTEMPTS = 3;
const HEARTBEAT_FRESH_MS = 4 * 60 * 1000; // a live lane re-reports 'generating' ~every 60s; 4min covers one slow take
function reclaimOrphans() {
  const now = Date.now();
  for (const job of jobs.values()) {
    if (job.status !== 'running') continue;
    if (!job.startedAt || now - job.startedAt < ORPHAN_MS) continue;
    // Heartbeat guard: a lane that reported 'generating' recently is genuinely in flight. Do NOT
    // re-queue it, or a second lane double-spends quota and both race to /result.
    const beat = reported.get(job.name);
    if (beat && beat.status === 'generating' && now - (beat.at || 0) < HEARTBEAT_FRESH_MS) continue;
    if ((job.attempts || 0) < MAX_ATTEMPTS) {
      // Re-queue: a later /next (or the live extension on its next poll) picks it up again.
      job.status = 'pending';
      job.error = null;
      console.log(`[bridge] orphan re-queued ${job.name} (attempt ${job.attempts || 0}/${MAX_ATTEMPTS})`);
    } else {
      job.status = 'error';
      job.error = 'lane died before returning an image (max attempts reached)';
      console.log(`[bridge] orphan failed ${job.name}: ${job.error}`);
      milestones();
    }
  }
}

function milestones() {
  const c = counts();
  if (!fired.half && c.total > 1 && c.done >= Math.ceil(c.total / 2)) { fired.half = true; notify('genHalfway', { batch: BATCH_N, done: c.done, total: c.total }); }
  if (!fired.done && c.total > 0 && c.settled === c.total) { fired.done = true; notify('genDone', { batch: BATCH_N, done: c.done, total: c.total, errors: c.error }); }
}
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' };
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', ...cors }); res.end(JSON.stringify(obj)); };
const body = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b)); });

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  const url = new URL(req.url, 'http://localhost');

  // QUEUE SEMANTICS — FIFO / one-at-a-time serving. When /enqueue is called with multiple jobs,
  // every job is appended to the END of a single queue (Map insertion order). Only ONE pending
  // job is served per /next call: `jobs.values().find(j => j.status === 'pending')` picks the
  // oldest entry that hasn't yet been claimed. When something is running and a new item arrives,
  // it waits in line — no preemption, no batching into one chat request. The extension polls /next
  // repeatedly; each poll pulls exactly one job off "pending" (or returns null if nothing is left).
  // This means: enqueue N jobs -> /next serves them sequentially 1..N with gaps between each as the
  // lane processes and reports back via /result. Queue position is deterministic: first-in-first-out.
  if (url.pathname === '/enqueue' && req.method === 'POST') {
    const data = JSON.parse((await body(req)) || '{}');
    if (data.out) OUT = resolve(data.out);
    if (data.batch) BATCH_N = data.batch;
    const added = [];
    for (const j of data.jobs || []) {
      const id = `j${++seq}`;
      jobs.set(id, { id, name: j.name, prompt: j.prompt, refs: resolveRefs(j.refs), project: j.project || null, relativePath: j.relativePath || null, variants: j.variants || 1, variantPaths: j.variantPaths || null, aspect: j.aspect || null, status: 'pending' });
      added.push(id);
    }
    if (!fired.start && added.length) { fired = { start: true, half: false, done: false, blocked: false }; notify('genStarted', { batch: BATCH_N, count: counts().total }); }
    return json(res, 200, { ok: true, added, out: OUT });
  }

  if (url.pathname === '/reload' && req.method === 'POST') { reloadRequested = true; console.log('[bridge] reload requested; extension will reload on next poll'); return json(res, 200, { ok: true }); }

  if (url.pathname === '/next' && req.method === 'GET') {
    lastPollAt = Date.now(); // extension liveness: /health uses this to detect a connected poller
    if (!server._connected) { server._connected = true; console.log('[bridge] extension connected (first poll received)'); }
    if (reloadRequested) { reloadRequested = false; return json(res, 200, { reload: true }); }
    if (abortRequested) { abortRequested = false; return json(res, 200, { abort: true }); }
    if (paused) return json(res, 200, { job: null, paused: true });
    // Re-drive any orphaned jobs (a lane that died mid-await never posts /result) before serving.
    reclaimOrphans();
    const job = [...jobs.values()].find((j) => j.status === 'pending');
    if (!job) return json(res, 200, { job: null });
    job.status = 'running';
    // Stamp serve time + bump the attempt counter so the watchdog can detect and re-drive a lane
    // that was evicted mid-generation (the #1 MV3 failure: SW dies, job stuck "running" forever).
    job.startedAt = Date.now();
    job.attempts = (job.attempts || 0) + 1;
    return json(res, 200, { job: { id: job.id, name: job.name, prompt: job.prompt, refs: job.refs, project: job.project, relativePath: job.relativePath, variants: job.variants || 1, variantPaths: job.variantPaths || null, aspect: job.aspect || null } });
  }

  if (url.pathname === '/result' && req.method === 'POST') {
    const data = JSON.parse((await body(req)) || '{}');
    const job = jobs.get(data.id);
    if (!job) return json(res, 404, { ok: false, error: 'unknown id' });
    // Accept images:[dataUrl,...] (one per variant) or a single dataUrl (back-compat). The bridge
    // is the ONLY writer rooted at OUT, so writing every variant here puts all N in the right place.
    const images = Array.isArray(data.images) && data.images.length ? data.images : (data.dataUrl ? [data.dataUrl] : []);
    if (data.ok && images.length) {
      const written = writeVariants(OUT, job, images);
      const expected = data.expected || job.variants || (job.variantPaths && job.variantPaths.length) || 1;
      // A short multi-variant result still SAVES (status 'partial', never discarded), distinct from done.
      job.status = written.length < expected ? 'partial' : 'done';
      job.path = written[0] ? written[0].path : null; job.paths = written.map((w) => w.path);
      job.captured = written.length; job.expected = expected;
      job.renamed = !!data.renamed; job.moved = !!data.moved; job.diag = data.diag || null; job.chatUrl = data.chatUrl || null;
      console.log(`[bridge] ${job.status} ${job.name} -> ${job.paths.join(', ')} (${written.length}/${expected})${data.renamed ? ' renamed' : ''}${data.moved ? ' filed' : ''}`);
    } else {
      job.status = 'error'; job.error = data.error || 'failed';
      console.log(`[bridge] fail ${job.name}: ${job.error}`);
      if (!fired.blocked && /too many|rate|limit|quota/i.test(job.error)) { fired.blocked = true; notify('blocked', { batch: BATCH_N, reason: job.error }); }
    }
    milestones();
    return json(res, 200, { ok: true });
  }

  // Every generation the extension performs (panel runs included) is POSTed here so
  // Telegram becomes a live window into generation: { job, status, dataUrl, error }.
  // status is 'generating' | 'done' | 'error'; job has at least { name, prompt, project }.
  if (url.pathname === '/report' && req.method === 'POST') {
    const data = JSON.parse((await body(req)) || '{}');
    const job = data.job || {};
    const name = job.name || 'image';
    const status = data.status || 'generating';
    // Keep the latest payload so /regen can re-run this image later.
    reported.set(name, { ...job, name, status, error: data.error || null, at: Date.now() });
    if (status === 'done') {
      reportSeenBatch = false; // the wave is settling; let the next one announce itself
      const line = job.project ? `${job.project} | done` : 'done';
      if (data.dataUrl) sendPhoto(data.dataUrl, `${name}\n${line}`).catch(() => {});
      else sendMessage(`${name} done.`).catch(() => {});
    } else if (status === 'error') {
      sendMessage(`${name} failed: ${data.error || 'unknown error'}`).catch(() => {});
    } else if (status === 'generating') {
      // Low-noise: only announce the first of a wave, then stay quiet until something finishes.
      if (!reportSeenBatch) { reportSeenBatch = true; sendMessage(`Generating ${name}...`).catch(() => {}); }
    }
    return json(res, 200, { ok: true });
  }

  if (url.pathname === '/status') {
    const tracker = getCodexTracker();
    let codexUsage = null;
    try {
      codexUsage = await tracker.getQuotaStatus();
    } catch {}
    return json(res, 200, { ...queueSnapshot(jobs, { out: OUT, paused, codexUsage }), codexProgress, reported: [...reported.values()], lastPollAt, lastLoggedIn, lastPingAt });
  }

  // Extension heartbeat: reports ChatGPT login state so /health can tell logged-in from logged-out.
  if (url.pathname === '/ping' && req.method === 'POST') {
    const data = JSON.parse((await body(req)) || '{}');
    lastLoggedIn = !!data.loggedIn; lastPingAt = Date.now();
    return json(res, 200, { ok: true });
  }

  // Health probe for agentic callers. extensionConnected: a /next poll landed recently.
  // loggedIn: the last /ping said logged-in and was recent. Carries the live queue snapshot + Codex usage.
  if (url.pathname === '/health') {
    const tracker = getCodexTracker();
    let codexUsage = null;
    try { codexUsage = await tracker.getQuotaStatus(); } catch {}
    return json(res, 200, { ok: true, bridge: true, extensionConnected: (Date.now() - lastPollAt < 40000), loggedIn: (lastLoggedIn === true && Date.now() - lastPingAt < 60000), queue: queueSnapshot(jobs, { out: OUT, paused, codexUsage }), codexProgress });
  }

  // codexbatch.mjs POSTs its progress here as it renders via the separate Codex-usage quota.
  if (url.pathname === '/codex-progress' && req.method === 'POST') {
    const d = JSON.parse((await body(req)) || '{}');
    codexProgress = { done: d.done || 0, failed: d.failed || 0, skipped: d.skipped || 0, total: d.total || 0, current: d.current || null, error: d.error || null, updatedAt: Date.now() };
    return json(res, 200, { ok: true });
  }

  // Codex usage endpoint — returns current quota status + per-model breakdown. Used by the
  // dashboard to show a live "tokens used vs limit" panel with weekly progress bars and reset dates.
  if (url.pathname === '/api/codex/usage' && req.method === 'GET') {
    const tracker = getCodexTracker();
    let codexUsage;
    try { codexUsage = await tracker.getQuotaStatus(); } catch {}

    // If no tracker is available, return safe defaults so the dashboard still renders.
    if (!codexUsage) {
      codexUsage = {
        overall: { totalUsed: 0, weeklyLimit: 2_550_000, percentage: '0.0', updatedAt: new Date().toISOString() },
        models: [
          { model: 'gpt-image-1', used: 0, limit: 50_000, available: 50_000, percentage: 0, dailyResetAt: null, monthlyResetAt: null, backend: 'openai' },
          { model: 'gpt-image-2', used: 0, limit: 500_000, available: 500_000, percentage: 0, dailyResetAt: null, monthlyResetAt: null, backend: 'openai' },
          { model: 'gemini-pro-vision', used: 0, limit: 1_000_000, available: 1_000_000, percentage: 0, dailyResetAt: null, monthlyResetAt: null, backend: 'gemini' },
        ],
      };
    }

    return json(res, 200, codexUsage);
  }

  // Fallback check endpoint — tells the bridge whether Codex is healthy enough to use.
  // Returns { useCodex: boolean|null, reason: string, fallback: boolean, percentage?, resetAt? }.
  // If Codex is exhausted (useCodex === false && fallback === true), callers should route via /enqueue.
  if (url.pathname === '/api/fallback/check' && req.method === 'POST') {
    const body = JSON.parse((await body(req)) || '{}');

    // Optional: record a generation event so the tracker's in-memory counters stay accurate.
    if (body.record) {
      try {
        getCodexTracker().recordGeneration(body.model || 'gpt-image-2', Number(body.tokens) || 1);
      } catch {}
    }

    const decision = await checkCodexAvailability();

    // If Codex is exhausted, log the fallback event and notify via Telegram.
    if (decision.fallback && !decision.useCodex) {
      try { getFallbackManager()?.reportStatus('chatgpt-used', body.name || 'unknown'); } catch {}
      const reason = decision.reason || 'unknown';
      console.log(`[bridge] Codex fallback: ${reason}`);
    }

    return json(res, 200, decision);
  }

  // codexbatch.mjs relays each finished image's dataURL here (the file is already on disk). The
  // bridge buffers it for the extension panel's live preview only — it writes nothing. Cap at the
  // most recent ~80 so a stalled drain can't balloon the Node heap (each item is a 2-3MB base64
  // dataURL, so an unbounded buffer OOMs the consumer).
  if (url.pathname === '/codex-result' && req.method === 'POST') {
    const d = JSON.parse((await body(req)) || '{}');
    codexResults.push({ name: d.name, relPath: d.relPath, dataUrl: d.dataUrl, at: Date.now() });
    if (codexResults.length > 80) codexResults.splice(0, codexResults.length - 80);
    return json(res, 200, { ok: true });
  }

  // The background drains pending codex results here in batches of at most 8 (splice -> each
  // delivered exactly once). Draining the whole buffer at once produced a single ~200MB JSON
  // response that OOMed the consumer, so callers must poll repeatedly: `remaining` reports how
  // many items are still buffered after this splice, signalling whether to fetch again.
  if (url.pathname === '/codex-results' && req.method === 'GET') {
    const results = codexResults.splice(0, 8);
    return json(res, 200, { results, remaining: codexResults.length });
  }
  if (url.pathname === '/command' && req.method === 'POST') return json(res, 200, { ok: true, ...command(JSON.parse((await body(req)) || '{}')) });

  // Reset clears the queue AND unpauses: a fresh batch (after a stop or a rate-limit pause) must
  // always start servable, never inherit a stale paused latch from a prior run.
  if (url.pathname === '/reset' && req.method === 'POST') { jobs.clear(); seq = 0; paused = false; abortRequested = false; fired = { start: false, half: false, done: false, blocked: false }; return json(res, 200, { ok: true }); }

  json(res, 404, { ok: false, error: 'not found' });
});

server.listen(PORT, '127.0.0.1', async () => {
  console.log(`[bridge] listening on http://localhost:${PORT}  out=${OUT}`);
  const telegram = await startTelegramControl({ handle: command, status: () => ({ message: statusMessage() }) });
  console.log(telegram.enabled ? '[bridge] Telegram controls enabled' : '[bridge] Telegram controls not configured');
});

// Watchdog: re-drive orphaned "running" jobs even when the extension has stopped polling /next
// entirely (e.g. its service worker is fully evicted). Runs in the bridge process, which never
// sleeps, so a stalled job is always recovered and re-served the moment the extension wakes.
// unref() so this timer never keeps the process alive on its own.
setInterval(reclaimOrphans, 20 * 1000).unref();
