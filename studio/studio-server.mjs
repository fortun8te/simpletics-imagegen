#!/usr/bin/env node
// studio-server.mjs — ImageGen Studio backend (zero-dep node:http).
//
// Owns the job queue + worker, scans the renders tree, proxies the bridge (:8787) for codex health,
// and serves the built frontend + /api/* + /img + /events (SSE) on :8788. ALL generation is driven
// from here via the worker — the agent never launches codex from a terminal. See ../PLAN.md §3 and
// lib/INTERFACES.md for the exact contract. Zero external deps: node:* + the three sibling lib
// modules (jobstore / worker / state, which themselves only use node:* + logic.js).
import http from 'node:http';
import { readFile, stat, rm } from 'node:fs/promises';
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname, normalize, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { createJobStore } from './lib/jobstore.mjs';
import { createWorker, MAX_CONCURRENT_JOBS } from './lib/worker.mjs';
import { buildState } from './lib/state.mjs';
import { getCodexUsage, refreshCodexUsage, noteGenerated, noteRateLimit, clearRateLimit, verifyCodexQuota, getBlockers, getSettings, updateSettings, getDailyCap, grantDailyBonus } from './lib/usage.mjs';
import { collectBatchFiles, buildBatchZip } from './lib/exportBatch.mjs';
import * as trendtrack from './lib/trendtrack.mjs';
import * as ttCache from './lib/trendtrack-cache.mjs';
import * as designs from './lib/designstore.mjs';
import * as skeletons from './lib/skeletons.mjs';
import { extractLayout, cancelExtraction, describeImage } from './lib/layout-extract.mjs';
import * as taste from './lib/taste.mjs';
import { runPlan, getActiveRun, rankRefs } from './lib/planner.mjs';
import { runDesignAgent } from './lib/design-agent.mjs';
import { loadBrandSkill, saveBrandSkill } from './lib/brand-skills.mjs';
import { readLlmUsage, hasLlm, llmInfo } from './lib/llm.mjs';
import { setLlmConfig, DEFAULT_BASE, DEFAULT_MODEL } from './lib/llm-config.mjs';

// ── Paths (injected into the lib modules) ────────────────────────────────────────────────────────
const STUDIO = dirname(fileURLToPath(import.meta.url));            // .../NEUEGEN/studio
const REPO = join(STUDIO, '..');                                  // .../NEUEGEN (config.json, logic.js)
const RENDERS = join(process.env.HOME, 'Downloads', 'static-factory-b1', 'renders');
const STATE_DIR = join(STUDIO, '.state');
const REFS_DIR = join(STATE_DIR, 'refs');   // uploaded Revise board reference images
const DIST = join(STUDIO, 'dist');
const CONFIG = join(REPO, 'config.json');
const BRIDGE = 'http://localhost:8787';
const PORT = Number(process.env.PORT) || 8788;

// ── Wiring ───────────────────────────────────────────────────────────────────────────────────────
const store = createJobStore({ stateDir: STATE_DIR });
const worker = createWorker({
  store,
  renders: RENDERS,
  repoDir: REPO,
  concurrency: Number(process.env.CONCURRENCY) || MAX_CONCURRENT_JOBS,
  cooldownMin: Number(process.env.COOLDOWN_MIN) || 30,
  onChange: broadcast,
  // Feed the best-effort codex-usage probe with the two real signals the worker has: a completed
  // job (an honest "generated this session" tick) and the start of a rate-limit cooldown.
  // Pass the job's real finishedAt so usage.mjs can fold it into the windowed used5h/used7d estimate
  // (and a success clears any dead-auth signal). Read the fresh record for an accurate timestamp.
  onComplete: (job) => {
    let finishedAt = Date.now();
    try { const j = store.get(job && job.id); if (j && j.finishedAt) finishedAt = j.finishedAt; } catch {}
    noteGenerated(1, finishedAt);
  },
  onRateLimit: ({ resumeAt }) => { noteRateLimit({ resumeAt }); },
});
worker.start();

// ── SSE clients ──────────────────────────────────────────────────────────────────────────────────
// One Set of live response objects. `broadcast` is the worker's onChange and also fires on every
// store mutation, so any slot/job change pushes a fresh `state` (+ `queue`) event to every client.
const sseClients = new Set();

// Push one named event to every connected SSE client — the plan/design agents stream their
// steps through this (channel = event name; the payload carries runId + step).
function ssePush(event, data) {
  for (const res of sseClients) {
    try { sseSend(res, event, data); } catch { /* dropped client — cleanup happens on close */ }
  }
}

// Live sync: one `doc` SSE event on every save/delete of a design/skeleton/element/brandkit so
// open editors can refresh without polling. kind ∈ 'design'|'skeleton'|'element'|'brandkit'.
function pushDoc(kind, id, extra = {}) {
  ssePush('doc', { kind, id: id ?? null, updatedAt: Date.now(), ...extra });
}

function sseSend(res, event, data) {
  try {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data ?? {})}\n\n`);
  } catch {}
}

function broadcast() {
  let counts = {};
  try { counts = store.counts(); } catch {}
  for (const res of sseClients) {
    sseSend(res, 'state', {});
    sseSend(res, 'queue', counts);
  }
}

// Re-broadcast on every store change too (the worker calls onChange, but enqueue/cancel/archive from
// the HTTP routes also mutate the store directly — this guarantees those reach clients).
store.on('change', broadcast);

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────────
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let buf = '';
    let over = false;
    // 48MB — design exports carry a full-res PNG + SVG as data URLs (a 1080×1920 comp is
    // several MB each). Overflow REJECTS (empty body) instead of silently truncating,
    // which used to corrupt the JSON and made big exports fail as a confusing 404.
    req.on('data', (c) => { if (over) return; buf += c; if (buf.length > 4.8e7) { over = true; buf = ''; } });
    req.on('end', () => {
      if (!buf) return resolve({});
      try { resolve(JSON.parse(buf)); } catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

function readConfig() {
  // Read fresh every time so config edits show up without a restart.
  return JSON.parse(readFileSync(CONFIG, 'utf8'));
}

function findBrand(config, brandId) {
  if (!config || !Array.isArray(config.brands)) return null;
  return config.brands.find((b) => b.id === brandId)
    || config.brands.find((b) => String(b.name).toLowerCase() === String(brandId).toLowerCase())
    || null;
}
function findBatch(brand, batchCode) {
  if (!brand || !Array.isArray(brand.batches)) return null;
  return brand.batches.find((ba) => ba.code === batchCode) || null;
}
function findAd(batch, adId) {
  return (batch.ads || []).find((a) => a.id === adId) || null;
}
function findVariation(ad, varId) {
  return ad ? (ad.variations || []).find((v) => v.id === varId) || null : null;
}
function promptEntries(variation) {
  // Mirror codexbatch: explicit prompts[], else a single synthesized p1 from variation.prompt.
  const list = (variation && variation.prompts && variation.prompts.length)
    ? variation.prompts
    : [{ id: 'p1', prompt: variation && variation.prompt }];
  return list.map((e, i) => ({ id: e.id || `p${i + 1}`, prompt: e.prompt }));
}
function findPrompt(variation, promptId) {
  return promptEntries(variation).find((p) => p.id === promptId) || null;
}

// codex --ref does image-to-image EDITS, so attach the product tube ONLY to shots that actually show
// it. Same detector codexbatch uses (the prompt names "Image 1 is the ... tube" / "tube reading").
const TUBE_RE = /image 1 is the [^.]*tube|tube reading/i;
function isTubeShot(promptText) { return TUBE_RE.test(String(promptText || '')); }
function tubeRefPath() {
  const p = join(REPO, 'assets', 'nanox.png');
  return existsSync(p) ? p : null;
}

function assetRefPath(name) {
  const p = join(REPO, 'assets', `${name}.png`);
  return existsSync(p) ? p : null;
}

function layoutRefPath(file) {
  if (!file) return null;
  const p = join(REPO, 'assets', 'refs', file);
  return existsSync(p) ? p : null;
}

function modelRenderRel(brand, batch, adId, modelId) {
  return `${part(brand)}/${part(batch)}/models/${part(adId)}/${part(modelId)}/run-1.png`;
}

// Build the full reference list for a prompt (product, layout, model face, extras, tube).
function buildPromptRefs(brand, batch, ad, variation, promptText) {
  const refs = [];
  const seen = new Set();
  const push = (role, name, url) => {
    const key = `${role}:${url}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push({ role, name, url });
  };

  if (ad.product && assetRefPath(ad.product)) {
    push('product', ad.product, `/asset?name=${encodeURIComponent(ad.product)}`);
  }
  if (ad.ref && layoutRefPath(ad.ref)) {
    push('layout', ad.ref, `/refs?name=${encodeURIComponent(ad.ref)}`);
  }
  if (ad.kind === 'face') {
    const modelId = variation.model || (ad.models && ad.models[0] && ad.models[0].id);
    if (modelId) {
      const rel = modelRenderRel(brand.id, batch.code, ad.id, modelId);
      push('model', modelId, `/img?path=${encodeURIComponent(rel)}&w=320`);
    }
  }
  for (const key of ad.extraRefs || []) {
    if (assetRefPath(key)) push('extra', key, `/asset?name=${encodeURIComponent(key)}`);
  }
  if (isTubeShot(promptText) && tubeRefPath()) {
    push('tube', 'nanox', '/asset?name=nanox');
  }
  return refs;
}

// Phase 0.4 — the DISK-PATH twin of buildPromptRefs above. buildPromptRefs resolves refs to
// display URLs for the Plan UI; generation needs absolute file paths for `gen.mjs -i`. Same
// order (product, layout, model, extras, tube), deduped by resolved path so e.g. a nanox tube
// shot doesn't attach assets/nanox.png twice (product ref and tube ref are the same file).
// Missing files are skipped — a face ad whose model render isn't on disk yet generates without
// the model ref rather than failing.
function buildPromptRefPaths(brand, batch, ad, variation, promptText) {
  const paths = [];
  const seen = new Set();
  const push = (p) => { if (p && !seen.has(p)) { seen.add(p); paths.push(p); } };

  if (ad.product) push(assetRefPath(ad.product));
  if (ad.ref) push(layoutRefPath(ad.ref));
  if (ad.kind === 'face') {
    const modelId = variation.model || (ad.models && ad.models[0] && ad.models[0].id);
    if (modelId) {
      const abs = join(RENDERS, modelRenderRel(brand.id, batch.code, ad.id, modelId));
      if (existsSync(abs)) push(abs);
    }
  }
  for (const key of ad.extraRefs || []) push(assetRefPath(key));
  if (isTubeShot(promptText)) push(tubeRefPath());
  return paths;
}

const part = (v) => String(v || '').trim().replace(/[^a-zA-Z0-9_-]+/g, '-');

// Shallow recursive walk of a batch's render dir, collecting every `run-*.png`. Returns { count,
// modifiedAt } where modifiedAt is the newest mtime (ms) seen, 0 if none. Tolerates missing dirs.
function scanBatchRenders(brandId, batchCode) {
  const root = join(RENDERS, part(brandId), part(batchCode));
  let count = 0;
  let modifiedAt = 0;
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!/^run-.*\.png$/i.test(e.name)) continue;
      count++;
      try { const m = statSync(full).mtimeMs; if (m > modifiedAt) modifiedAt = m; } catch {}
    }
  };
  walk(root);
  return { count, modifiedAt };
}

// How many done render files already exist for a prompt (any run/version), by scanning the prompt
// dir. Used to compute the next free run index for /api/generate.
function doneRunCount(brand, batch, adId, varId, promptId) {
  const dir = join(RENDERS, part(brand), part(batch), 'ads', part(adId), part(varId), part(promptId));
  if (!existsSync(dir)) return 0;
  try {
    return readdirSync(dir).filter((f) => /^run-\d+(-v\d+)?\.png$/i.test(f)).length;
  } catch { return 0; }
}
// How many queued/running jobs target this exact slot (any run) — so concurrent enqueues don't
// collide on the same run index.
function inflightCount(brand, batch, adId, varId, promptId) {
  let n = 0;
  for (const j of store.forBatch(brand, batch)) {
    if ((j.status === 'queued' || j.status === 'running')
      && j.ad === adId && j.variation === varId && j.prompt === promptId) n++;
  }
  return n;
}

// Resolve every targeted (ad, variation, prompt) slot for a generate scope. Scope semantics per
// src/types.ts: exactly one of prompt / variation / ads; omit all = the whole batch.
function resolveSlots(batch, scope) {
  const out = [];
  const addPrompt = (ad, v, p) => out.push({ ad, variation: v, prompt: p });
  const addVariation = (ad, v) => { for (const p of promptEntries(v)) addPrompt(ad, v, p); };
  const addAd = (ad) => { for (const v of ad.variations || []) addVariation(ad, v); };

  if (scope && scope.prompt) {
    const ad = findAd(batch, scope.prompt.ad);
    const v = findVariation(ad, scope.prompt.variation);
    const p = v && findPrompt(v, scope.prompt.prompt);
    if (ad && v && p) addPrompt(ad, v, p);
  } else if (scope && scope.variation) {
    const ad = findAd(batch, scope.variation.ad);
    const v = findVariation(ad, scope.variation.variation);
    if (ad && v) addVariation(ad, v);
  } else if (scope && Array.isArray(scope.ads) && scope.ads.length) {
    for (const id of scope.ads) { const ad = findAd(batch, id); if (ad) addAd(ad); }
  } else {
    for (const ad of batch.ads || []) addAd(ad);
  }
  return out;
}

// Enqueue `variants` jobs for one resolved slot, computing the next free run index up front and
// laying the variants out across consecutive runs (so they don't all collide on the same run).
function enqueueSlot(brand, batch, ad, v, p, variants, promptOverride, refsOverride, scheduledAt = null) {
  const baseRun = doneRunCount(brand.id, batch.code, ad.id, v.id, p.id)
    + inflightCount(brand.id, batch.code, ad.id, v.id, p.id) + 1;
  const promptText = promptOverride || p.prompt;
  const size = (/^\d+x\d+$/.test(String(batch.aspect || '')) ? batch.aspect : '1024x1024');
  // Revise supplies its own refs (the original image + any board uploads); otherwise attach the
  // FULL resolved reference set — product, layout, model face, extras, tube — the same refs the
  // Plan UI displays (Phase 0.4 fix: previously only the tube ref reached codex on normal
  // generate, so product/layout/model refs were shown but never used). `refs` drives gen.mjs -i.
  const refs = (Array.isArray(refsOverride) && refsOverride.length)
    ? refsOverride.filter(Boolean)
    : buildPromptRefPaths(brand, batch, ad, v, promptText);
  const n = Math.max(1, Math.min(10, Number(variants) || 1));
  let enqueued = 0;
  for (let i = 0; i < n; i++) {
    store.enqueue({
      brand: brand.id,
      batch: batch.code,
      ad: ad.id,
      variation: v.id,
      prompt: p.id,
      run: baseRun + i,
      variants: n,
      promptText,
      size,
      refs,
      ref: refs[0] || null,
      scheduledAt,
    });
    enqueued++;
  }
  return enqueued;
}

// Parse a render relPath back into slot coords: <brand>/<batch>/ads/<ad>/<var>/<prompt>/run-N[-vN].png
function parseRelPath(relPath) {
  const clean = String(relPath || '').replace(/^\/+/, '');
  const parts = clean.split('/');
  // [brand, batch, 'ads', ad, var, prompt, file]
  if (parts.length < 7 || parts[2] !== 'ads') return null;
  const [brand, batch, , ad, variation, prompt] = parts;
  const m = /^run-(\d+)(?:-v(\d+))?\.png$/i.exec(parts[parts.length - 1]);
  if (!m) return null;
  return { brand, batch, ad, variation, prompt, run: Number(m[1]) };
}

async function fetchBridgeProgress() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    const r = await fetch(`${BRIDGE}/status`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) return { progress: null, bridge: true };
    const j = await r.json();
    return { progress: j && j.codexProgress ? j.codexProgress : null, bridge: true };
  } catch {
    return { progress: null, bridge: false };
  }
}

// Assemble the RunInfo (src/types.ts) for the active batch: `state`/`resumeAt` come from the worker
// (the single source of truth for the run lifecycle); the counts come from the store, scoped to the
// jobs belonging to this brand/batch so the progress reflects THIS run, not unrelated batches.
function buildRunInfo(brand, batch) {
  const { state, resumeAt } = worker.runState();
  let running = 0, queued = 0, waiting = 0, done = 0, failed = 0;
  for (const j of store.forBatch(brand, batch)) {
    if (j.status === 'running') running++;
    else if (j.status === 'queued') queued++;
    else if (j.status === 'waiting') waiting++;
    else if (j.status === 'done') done++;
    else if (j.status === 'failed') failed++;
  }
  return { state, running, queued, waiting, done, failed, total: running + queued + waiting + done + failed, resumeAt: resumeAt ?? null };
}

// ── Static file serving (SPA) ────────────────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.map': 'application/json',
};

async function serveStatic(req, res, pathname) {
  if (!existsSync(DIST)) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><meta charset="utf-8"><body style="font:14px -apple-system,system-ui;padding:40px;color:#333">'
      + 'ImageGen Studio backend is running, but the frontend is not built yet.<br><br>'
      + 'Run <code>npm run build</code> in <code>studio/</code> to build the UI, then reload.</body>');
    return;
  }
  // Resolve a safe path under DIST; SPA fallback to index.html for unknown routes.
  let rel = decodeURIComponent(pathname.replace(/^\/+/, ''));
  if (rel === '') rel = 'index.html';
  let filePath = normalize(join(DIST, rel));
  if (!filePath.startsWith(DIST + sep) && filePath !== DIST) {
    // traversal attempt — fall back to the SPA shell
    filePath = join(DIST, 'index.html');
  }
  let useFallback = false;
  try {
    const s = await stat(filePath);
    if (!s.isFile()) useFallback = true;
  } catch { useFallback = true; }
  if (useFallback) filePath = join(DIST, 'index.html');

  try {
    const data = await readFile(filePath);
    const type = MIME[extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': filePath.endsWith('index.html') ? 'no-store' : 'public, max-age=3600' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
}

// ── /img — serve a full PNG from RENDERS (path-traversal-guarded) ─────────────────────────────────
async function serveImg(req, res, query) {
  const rel = query.get('path');
  if (!rel) { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('missing path'); return; }
  // Reject traversal: normalize and require the resolved file to live under RENDERS.
  const filePath = normalize(join(RENDERS, rel.replace(/^\/+/, '')));
  if (!filePath.startsWith(RENDERS + sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end('forbidden'); return;
  }
  try {
    const data = await readFile(filePath); // ?w accepted but ignored for v1 — serve full PNG
    const headers = { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=60' };
    const filename = query.get('filename');
    if (filename) {
      const safe = String(filename).replace(/[^\w.\- ]+/g, '').slice(0, 180) || 'image.png';
      headers['Content-Disposition'] = `attachment; filename="${safe}"`;
    }
    res.writeHead(200, headers);
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found');
  }
}

// ── /asset — serve a named PNG from REPO/assets (path-traversal-guarded) ──────────────────────────
async function serveAsset(req, res, query) {
  const name = query.get('name');
  if (!name) { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('missing name'); return; }
  const ASSETS = join(REPO, 'assets');
  // Reject traversal: normalize and require the resolved file to live under REPO/assets.
  const filePath = normalize(join(ASSETS, `${name.replace(/^\/+/, '')}.png`));
  if (!filePath.startsWith(ASSETS + sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end('forbidden'); return;
  }
  try {
    const data = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=300' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found');
  }
}

// ── /refs — serve a layout reference image from REPO/assets/refs (jpg/png) ───────────────────────
async function serveLayoutRef(req, res, query) {
  const name = query.get('name');
  if (!name || name.includes('..') || name.includes('/') || name.includes('\\')) {
    res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('bad name'); return;
  }
  const REFS_ROOT = join(REPO, 'assets', 'refs');
  const lower = name.toLowerCase();
  const candidates = [name];
  if (!lower.endsWith('.jpg') && !lower.endsWith('.jpeg') && !lower.endsWith('.png')) {
    candidates.push(`${name}.jpg`, `${name}.png`);
  }
  let filePath = null;
  for (const candidate of candidates) {
    const p = normalize(join(REFS_ROOT, candidate));
    if (p.startsWith(REFS_ROOT + sep) && existsSync(p)) { filePath = p; break; }
  }
  if (!filePath) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
  const ext = extname(filePath).toLowerCase();
  const type = ext === '.png' ? 'image/png' : 'image/jpeg';
  try {
    const data = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=300' });
    res.end(data);
  } catch {
    res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end('read error');
  }
}

// ── Request router ───────────────────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  const { pathname } = u;
  const q = u.searchParams;
  const method = req.method || 'GET';

  try {
    // ── SSE ──────────────────────────────────────────────────────────────────────────────────────
    if (pathname === '/events' && method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      sseClients.add(res);
      sseSend(res, 'hello', { ok: true });
      // initial queue snapshot so a fresh client paints immediately
      try { sseSend(res, 'queue', store.counts()); } catch {}
      const hb = setInterval(() => { try { res.write(':hb\n\n'); } catch {} }, 20000);
      if (hb.unref) hb.unref();
      req.on('close', () => { clearInterval(hb); sseClients.delete(res); });
      return;
    }

    // ── /img ───────────────────────────────────────────────────────────────────────────────────
    if (pathname === '/img' && method === 'GET') {
      await serveImg(req, res, q);
      return;
    }

    // ── /asset ─────────────────────────────────────────────────────────────────────────────────
    if (pathname === '/asset' && method === 'GET') {
      await serveAsset(req, res, q);
      return;
    }

    // ── /refs — layout reference images from assets/refs ─────────────────────────────────────────
    if (pathname === '/refs' && method === 'GET') {
      await serveLayoutRef(req, res, q);
      return;
    }

    // ── /refasset — preview an uploaded Revise-board reference image by id ────────────────────────
    if (pathname === '/refasset' && method === 'GET') {
      const id = q.get('id') || '';
      if (!/^[a-zA-Z0-9_-]+$/.test(id)) { res.writeHead(400); res.end('bad id'); return; }
      const file = join(REFS_DIR, `${id}.png`);
      if (!existsSync(file)) { res.writeHead(404); res.end('not found'); return; }
      try {
        const buf = await readFile(file);
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=3600' });
        res.end(buf);
      } catch { res.writeHead(500); res.end('read error'); }
      return;
    }

    // ── API ──────────────────────────────────────────────────────────────────────────────────────
    if (pathname === '/api/config' && method === 'GET') {
      sendJson(res, 200, readConfig());
      return;
    }

    if (pathname === '/api/batches' && method === 'GET') {
      const config = readConfig();
      const brand = findBrand(config, q.get('brand'));
      if (!brand) { sendJson(res, 200, []); return; }
      const out = (brand.batches || []).map((ba) => {
        const label = ba.name || ba.code;
        const { count, modifiedAt } = scanBatchRenders(brand.id, ba.code);
        return {
          code: ba.code,
          name: ba.name || ba.code,
          kind: /listicle/i.test(label) ? 'listicle' : 'ads',
          modifiedAt,
          count,
        };
      });
      sendJson(res, 200, out);
      return;
    }

    if (pathname === '/api/prompt' && method === 'GET') {
      const config = readConfig();
      const brand = findBrand(config, q.get('brand'));
      const batch = brand && findBatch(brand, q.get('batch'));
      const ad = batch && findAd(batch, q.get('ad'));
      const v = ad && findVariation(ad, q.get('variation'));
      const p = v && findPrompt(v, q.get('prompt'));
      const text = p ? p.prompt : (v ? v.prompt : null);
      if (!text) { sendJson(res, 200, { ok: false, text: '' }); return; }
      const refs = buildPromptRefs(brand, batch, ad, v, text);
      const legacy = refs.find((r) => r.role === 'tube') || refs[0] || null;
      sendJson(res, 200, {
        ok: true,
        text,
        label: (p && p.label) || (p && p.id) || null,
        copy: v ? (v.copy || null) : null,
        recipe: (p && p.recipe) || null,
        refs,
        refName: legacy ? legacy.name : null,
        refUrl: legacy ? legacy.url : null,
      });
      return;
    }

    if (pathname === '/api/state' && method === 'GET') {
      const config = readConfig();
      const brandId = q.get('brand') || (config.brands[0] && config.brands[0].id);
      const brand = findBrand(config, brandId);
      const batchCode = q.get('batch') || (brand && brand.batches[0] && brand.batches[0].code);
      if (!brand) { sendJson(res, 404, { error: `unknown brand "${brandId}"` }); return; }
      const { progress } = await fetchBridgeProgress();
      const codex = { alive: worker.busy(), progress };
      const state = buildState({
        brand: brand.id,
        batch: batchCode,
        config,
        store,
        renders: RENDERS,
        codex,
        run: buildRunInfo(brand.id, batchCode),
        codexUsage: getCodexUsage({ force: true }),
        blockers: getBlockers(),
      });
      sendJson(res, 200, state);
      return;
    }

    if (pathname === '/api/health' && method === 'GET') {
      const { bridge } = await fetchBridgeProgress();
      sendJson(res, 200, {
        ok: true,
        bridge,
        codex: { alive: worker.busy() },
        queue: store.counts(),
        codexUsage: getCodexUsage({ force: true }),
        blockers: getBlockers(),
        // Rolling average single-image generation time (lib/jobstore.mjs), for GenerateDialog's
        // per-image / total-batch ETA. Falls back to a 30s default when there's no history yet.
        estimate: store.avgDurationSeconds(),
      });
      return;
    }

    if (pathname === '/api/usage/refresh' && method === 'POST') {
      const r = await refreshCodexUsage();
      broadcast();
      sendJson(res, 200, {
        ok: !!r.ok,
        codexUsage: r.usage,
        blockers: getBlockers(),
        error: r.error,
      });
      return;
    }

    // LLM usage rollups (.state/llm-usage.jsonl) + provider info.
    if (pathname === '/api/llm/usage' && method === 'GET') {
      sendJson(res, 200, { ok: true, ...readLlmUsage(), provider: llmInfo(), hasLlm: hasLlm() });
      return;
    }

    // ── LLM provider config (ModelSelector in AgentPanel / DesignView) ──
    // GET: current effective config (lib/llm.mjs's llmInfo() — runtime override > env > DeepSeek
    // default) + a preset list to switch between. LM Studio's entry is detected live via its own
    // /models — we don't own lib/llm.mjs so we replicate a minimal fetch here rather than adding
    // an export there.
    if (pathname === '/api/llm/config' && method === 'GET') {
      const info = llmInfo(); // { base, model, provider, source, hasKey }
      const presets = [
        { label: 'DeepSeek', baseUrl: DEFAULT_BASE, model: DEFAULT_MODEL },
      ];
      const vbase = process.env.VISION_BASE_URL ? String(process.env.VISION_BASE_URL).replace(/\/$/, '') : null;
      if (vbase) {
        try {
          const r = await fetch(`${vbase}/models`, { signal: AbortSignal.timeout(2500) });
          const j = await r.json();
          const ids = Array.isArray(j?.data) ? j.data.map((m) => String(m.id)) : [];
          if (ids.length) {
            const modelId = ids[0];
            presets.push({ label: `LM Studio (${modelId})`, baseUrl: vbase, model: modelId });
          }
        } catch { /* LM Studio unreachable — omit its preset */ }
      }
      sendJson(res, 200, {
        ok: true,
        config: { baseUrl: info.base, model: info.model, label: `${info.provider} · ${info.model}` },
        presets,
      });
      return;
    }

    if (pathname === '/api/llm/config' && method === 'POST') {
      const body = await readBody(req);
      try {
        const saved = setLlmConfig({ baseUrl: body.baseUrl, model: body.model, apiKey: body.apiKey });
        const info = llmInfo();
        sendJson(res, 200, {
          ok: true,
          config: saved
            ? { baseUrl: saved.baseUrl, model: saved.model || info.model, label: `${info.provider} · ${saved.model || info.model}` }
            : { baseUrl: info.base, model: info.model, label: `${info.provider} · ${info.model}` },
        });
      } catch (e) {
        sendJson(res, 400, { ok: false, error: String(e && e.message || e) });
      }
      return;
    }

    if (pathname === '/api/export/batch' && method === 'GET') {
      const config = readConfig();
      const brandId = q.get('brand');
      const batchCode = q.get('batch');
      const brand = findBrand(config, brandId);
      const batch = brand && findBatch(brand, batchCode);
      if (!brand || !batch) { sendJson(res, 400, { ok: false, error: 'unknown brand/batch' }); return; }
      const includeArchived = q.get('archived') === '1';
      const files = collectBatchFiles({ renders: RENDERS, brand: brand.id, batch: batch.code, config, store, includeArchived });
      if (!files.length) { sendJson(res, 404, { ok: false, error: 'no images to export' }); return; }
      try {
        const { data, tmp } = await buildBatchZip(files);
        const name = `${part(brand.id)}-${part(batch.code)}-export.zip`;
        res.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="${name}"`,
          'Content-Length': data.length,
          'Cache-Control': 'no-store',
        });
        res.end(data);
        rm(tmp, { recursive: true, force: true }).catch(() => {});
      } catch (e) {
        sendJson(res, 500, { ok: false, error: String(e && e.message || e) });
      }
      return;
    }

    // ── TrendTrack (Phase 0) ─────────────────────────────────────────────────────────────────
    // Ingestion-only: /import is the ONLY metered route; usage is free; cache + image reads
    // never touch the API. See lib/trendtrack.mjs (client + credit guard) and
    // lib/trendtrack-cache.mjs (.state/trendtrack-cache/ layout).
    if (pathname === '/api/trendtrack/usage' && method === 'GET') {
      if (!trendtrack.hasKey()) { sendJson(res, 200, { ok: false, error: 'no_api_key' }); return; }
      try {
        const u = await trendtrack.getUsage();
        sendJson(res, 200, { ok: true, remaining: u.remaining, raw: u.raw });
      } catch (e) {
        sendJson(res, 502, { ok: false, error: String(e && e.message || e) });
      }
      return;
    }

    if (pathname === '/api/trendtrack/import' && method === 'POST') {
      if (!trendtrack.hasKey()) { sendJson(res, 400, { ok: false, error: 'no_api_key' }); return; }
      const body = await readBody(req);
      try {
        let brand = String(body.brand || '').trim().toLowerCase();
        let rows = [];
        if (Array.isArray(body.adIds) && body.adIds.length) {
          // Per-id fetch (1 credit each). GET /v1/ads/{adId}.
          for (const id of body.adIds.slice(0, 25)) {
            try {
              const r = await trendtrack.getAdById(id);
              const row = r?.data || r;
              if (row && row.id) rows.push(row);
            } catch { /* skip bad ids — the rest of the import still lands */ }
          }
          brand = brand || String(rows[0]?.advertiser?.name || '').toLowerCase();
        } else if (brand || body.url) {
          // Canonical advanced query: search by brand text (or the raw url string), top reach first.
          const term = brand || String(body.url);
          const r = await trendtrack.queryAds(
            { search: [term], searchType: 'brand', status: 'active', sortBy: 'reach', order: 'desc' },
            { limit: Number(body.limit) || 25 },
          );
          rows = r?.data || [];
          brand = brand || String(rows[0]?.advertiser?.name || '').toLowerCase();
        } else {
          sendJson(res, 400, { ok: false, error: 'need brand, url, or adIds[]' });
          return;
        }
        if (!brand) brand = 'unknown';
        const records = ttCache.cacheBrand(brand, rows);
        // Copy creatives locally at import time — upstream URLs expire.
        let images = 0;
        for (const rec of records) {
          if (await ttCache.downloadImage(rec.id, rec.image_url)) images++;
        }
        sendJson(res, 200, {
          ok: true,
          brand,
          cached: records.length,
          images,
          creditsRemaining: trendtrack.lastKnownCredits(),
        });
      } catch (e) {
        const status = e && e.code === 'credit_guard' ? 429 : 502;
        sendJson(res, status, { ok: false, error: String(e && e.message || e), code: e && e.code });
      }
      return;
    }

    // FREE local search across the whole cache — never touches the paid API.
    if (pathname === '/api/trendtrack/search' && method === 'GET') {
      const ads = ttCache.searchCache(q.get('q') || '', { limit: Number(q.get('limit')) || 60 });
      sendJson(res, 200, {
        ok: true,
        ads: ads.map((a) => ({ ...a, raw: undefined, hasImage: !!ttCache.imagePath(a.id) })),
        creditsRemaining: trendtrack.lastKnownCredits(),
      });
      return;
    }
    if (pathname === '/api/trendtrack/cache' && method === 'GET') {
      const brand = q.get('brand');
      if (brand) {
        const hit = ttCache.getCachedBrand(brand);
        sendJson(res, 200, hit ? { ok: true, ...hit } : { ok: false, error: 'not cached (or stale)' });
      } else {
        sendJson(res, 200, { ok: true, brands: ttCache.listBrands() });
      }
      return;
    }

    if (pathname.startsWith('/api/trendtrack/image/') && method === 'GET') {
      const id = pathname.slice('/api/trendtrack/image/'.length);
      const p = ttCache.imagePath(id);
      if (!p) { sendJson(res, 404, { ok: false, error: 'no cached image' }); return; }
      try {
        const data = await readFile(p);
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': data.length, 'Cache-Control': 'public, max-age=86400' });
        res.end(data);
      } catch { sendJson(res, 500, { ok: false, error: 'read error' }); }
      return;
    }

    if (pathname === '/api/generate' && method === 'POST') {
      const body = await readBody(req);
      const config = readConfig();
      const brand = findBrand(config, body.brand);
      const batch = brand && findBatch(brand, body.batch);
      if (!brand || !batch) { sendJson(res, 400, { ok: false, error: 'unknown brand/batch' }); return; }
      const variants = Math.max(1, Math.min(10, Number(body.variants) || 1));
      const runAt = Number(body.runAt);
      const scheduledAt = Number.isFinite(runAt) && runAt > Date.now() ? runAt : null;
      const slots = resolveSlots(batch, body.scope);
      let enqueued = 0;
      for (const s of slots) enqueued += enqueueSlot(brand, batch, s.ad, s.variation, s.prompt, variants, null, null, scheduledAt);
      sendJson(res, 200, { ok: true, enqueued });
      return;
    }

    if (pathname === '/api/regenerate' && method === 'POST') {
      const body = await readBody(req);
      const coords = parseRelPath(body.relPath);
      if (!coords) { sendJson(res, 400, { ok: false, error: 'bad relPath' }); return; }
      const config = readConfig();
      const brand = findBrand(config, coords.brand);
      const batch = brand && findBatch(brand, coords.batch);
      const ad = batch && findAd(batch, coords.ad);
      const v = ad && findVariation(ad, coords.variation);
      const p = v && findPrompt(v, coords.prompt);
      if (!brand || !batch || !ad || !v || !p) { sendJson(res, 400, { ok: false, error: 'slot not found in config' }); return; }
      const enqueued = enqueueSlot(brand, batch, ad, v, p, 1);
      sendJson(res, 200, { ok: true, enqueued });
      return;
    }

    // Revise = regenerate this slot with the original prompt PLUS a change instruction, as a NEW
    // version (never overwrites). Same resolution as /api/regenerate, only the prompt is augmented.
    if (pathname === '/api/revise' && method === 'POST') {
      const body = await readBody(req);
      const coords = parseRelPath(body.relPath);
      const instruction = String(body.instruction || '').trim();
      if (!coords) { sendJson(res, 400, { ok: false, error: 'bad relPath' }); return; }
      if (!instruction) { sendJson(res, 400, { ok: false, error: 'empty instruction' }); return; }
      const config = readConfig();
      const brand = findBrand(config, coords.brand);
      const batch = brand && findBatch(brand, coords.batch);
      const ad = batch && findAd(batch, coords.ad);
      const v = ad && findVariation(ad, coords.variation);
      const p = v && findPrompt(v, coords.prompt);
      if (!brand || !batch || !ad || !v || !p) { sendJson(res, 400, { ok: false, error: 'slot not found in config' }); return; }
      // The user types stable @imgN labels (1st board upload = @img1, 2nd = @img2, ...) but the
      // underlying multimodal model sees a flat reference list with the ORIGINAL image always first
      // — so @imgN is actually "Image N+1" once the original is prepended. Translate before building
      // the prompt; this is purely a text rewrite, every attached extraRef is still always sent below
      // regardless of whether it was @-mentioned.
      const translatedInstruction = instruction.replace(/@img(\d+)/gi, (_m, n) => `Image ${Number(n) + 1}`);
      const revisedPrompt = `${p.prompt}\n\nApply this change to the image: ${translatedInstruction}`;
      // References: ALWAYS the original image first (so the new version builds on it), then any board
      // uploads the user attached (resolved from their upload ids → .state/refs/<id>.png).
      const origAbs = join(RENDERS, String(body.relPath).replace(/^\/+/, ''));
      const extraAbs = (Array.isArray(body.extraRefs) ? body.extraRefs : [])
        .filter((id) => /^[a-zA-Z0-9_-]+$/.test(String(id)))
        .map((id) => join(REFS_DIR, `${id}.png`))
        .filter((f) => existsSync(f));
      const refs = [existsSync(origAbs) ? origAbs : null, ...extraAbs].filter(Boolean);
      const enqueued = enqueueSlot(brand, batch, ad, v, p, 1, revisedPrompt, refs);
      sendJson(res, 200, { ok: true, enqueued, refs: refs.length });
      return;
    }

    // Upload a Revise-board reference image (base64 data URL) → saved to .state/refs/<id>.png.
    // Returns the id (passed back in /api/revise extraRefs) + a /refasset url to preview it.
    if (pathname === '/api/upload-ref' && method === 'POST') {
      const body = await readBody(req);
      const m = /^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(body.dataUrl || ''));
      if (!m) { sendJson(res, 400, { ok: false, error: 'expected a base64 image data URL' }); return; }
      try {
        mkdirSync(REFS_DIR, { recursive: true });
        const id = randomUUID();
        writeFileSync(join(REFS_DIR, `${id}.png`), Buffer.from(m[2], 'base64'));
        sendJson(res, 200, { ok: true, id, url: `/refasset?id=${id}` });
      } catch (e) {
        sendJson(res, 500, { ok: false, error: String(e && e.message || e) });
      }
      return;
    }

    // Reorder QUEUED jobs within one brand/batch (drag-and-drop priority in ActivityDock). Body:
    // { brand, batch, jobIds: string[] } — the full desired front-to-back order of the batch's
    // currently-queued job ids. Rewrites each job's `order` so the worker's nextQueued() (the actual
    // picker — see lib/jobstore.mjs) honors the new priority, not just the displayed list.
    if (pathname === '/api/queue/reorder' && method === 'POST') {
      const body = await readBody(req);
      const jobIds = Array.isArray(body.jobIds) ? body.jobIds.filter((id) => typeof id === 'string') : [];
      if (!body.brand || !body.batch || jobIds.length === 0) {
        sendJson(res, 400, { ok: false, error: 'missing brand/batch/jobIds' });
        return;
      }
      const reordered = store.reorder(body.brand, body.batch, jobIds);
      sendJson(res, 200, { ok: true, reordered });
      return;
    }

    if (pathname === '/api/cancel' && method === 'POST') {
      const body = await readBody(req);
      store.cancel({ jobId: body.jobId, all: body.all === true });
      if (body.all === true) worker.abortRun();
      sendJson(res, 200, { ok: true, run: worker.runState() });
      return;
    }

    // Run state machine controls (worker-owned). pause/resume call the worker's onChange, which
    // fires broadcast() → SSE, so run-state changes reach clients without extra plumbing.
    if (pathname === '/api/pause' && method === 'POST') {
      worker.pause(); // stop pulling new jobs; in-flight jobs finish
      sendJson(res, 200, { ok: true, run: worker.runState() });
      return;
    }

    if (pathname === '/api/resume' && method === 'POST') {
      const body = await readBody(req);
      const { cooling, cooldownReady, rateLimitHold } = worker.status();
      const needsVerify = body.verify !== false && (cooling || cooldownReady || rateLimitHold);
      if (needsVerify) {
        const v = await verifyCodexQuota();
        if (!v.ok) {
          broadcast();
          sendJson(res, 200, {
            ok: false,
            resumed: false,
            stillLimited: true,
            reason: v.reason,
            resetAt: v.resetAt ?? null,
            error: v.error ?? null,
            codexUsage: v.usage ?? getCodexUsage({ force: true }),
            blockers: getBlockers(),
            run: worker.runState(),
          });
          return;
        }
      }
      worker.resume();
      broadcast();
      sendJson(res, 200, {
        ok: true,
        resumed: true,
        codexUsage: getCodexUsage({ force: true }),
        blockers: getBlockers(),
        run: worker.runState(),
      });
      return;
    }

    if (pathname === '/api/resume/dismiss' && method === 'POST') {
      worker.dismissReady();
      broadcast();
      sendJson(res, 200, { ok: true, run: worker.runState() });
      return;
    }

    if (pathname === '/api/reset' && method === 'POST') {
      // Clear the whole queue, drop any rate-limit cooldown, and snap back to idle.
      store.cancel({ all: true });
      worker.abortRun();
      sendJson(res, 200, { ok: true, run: worker.runState() });
      return;
    }

    if (pathname === '/api/archive' && method === 'POST') {
      const body = await readBody(req);
      if (!body.relPath) { sendJson(res, 400, { ok: false, error: 'missing relPath' }); return; }
      store.setArchived(body.relPath, body.archived !== false);
      sendJson(res, 200, { ok: true });
      return;
    }

    // Append a new prompt entry ("another take") to a variation's prompts[] in config.json. Body:
    // { brand, batch, ad, variation }. Auto-numbers the next id (p3, p4, ...) and clones the text of
    // the LAST existing prompt verbatim — a genuine "another take" slot, not invented content. The
    // user edits/regenerates it like any other prompt once it exists. Read-modify-write straight from
    // disk (mirrors readConfig(), which always re-reads fresh) so we never clobber concurrent edits to
    // other batches/ads.
    if (pathname === '/api/prompt/patch' && method === 'POST') {
      const body = await readBody(req);
      const { brand, batch, ad: adId, variation: varId, prompt: promptId, patch } = body;
      if (!brand || !batch || !adId || !varId || !promptId || !patch || typeof patch !== 'object') {
        sendJson(res, 400, { ok: false, error: 'missing fields' });
        return;
      }
      const config = readConfig();
      const brandObj = findBrand(config, brand);
      const batchObj = findBatch(brandObj, batch);
      const ad = batchObj && findAd(batchObj, adId);
      const variation = ad && findVariation(ad, varId);
      if (!variation) { sendJson(res, 404, { ok: false, error: 'variation not found' }); return; }
      if (!Array.isArray(variation.prompts)) {
        variation.prompts = [{ id: 'p1', label: 'Prompt 1', prompt: variation.prompt || '' }];
      }
      const entry = variation.prompts.find((p) => p.id === promptId);
      if (!entry) { sendJson(res, 404, { ok: false, error: 'prompt not found' }); return; }
      if (typeof patch.prompt === 'string') entry.prompt = patch.prompt;
      if (typeof patch.label === 'string') entry.label = patch.label;
      if (patch.recipe && typeof patch.recipe === 'object') entry.recipe = patch.recipe;
      writeFileSync(CONFIG, JSON.stringify(config, null, 2) + '\n');
      sendJson(res, 200, { ok: true, prompt: entry });
      return;
    }

    if (pathname === '/api/prompt/add' && method === 'POST') {
      const body = await readBody(req);
      const { brand, batch, ad: adId, variation: varId } = body;
      if (!brand || !batch || !adId || !varId) {
        sendJson(res, 400, { ok: false, error: 'missing brand/batch/ad/variation' });
        return;
      }
      const config = readConfig();
      const brandObj = findBrand(config, brand);
      const batchObj = findBatch(brandObj, batch);
      const ad = batchObj && findAd(batchObj, adId);
      const variation = ad && findVariation(ad, varId);
      if (!variation) {
        sendJson(res, 404, { ok: false, error: 'variation not found' });
        return;
      }
      // Make sure prompts[] is materialized (mirrors promptEntries()'s p1-synthesis fallback) before
      // appending, so a variation authored with only the legacy `prompt` string also gets a real array.
      if (!Array.isArray(variation.prompts) || !variation.prompts.length) {
        variation.prompts = [{ id: 'p1', label: 'Prompt 1', prompt: variation.prompt || '' }];
      }
      const last = variation.prompts[variation.prompts.length - 1];
      const nextNum = variation.prompts.length + 1;
      const newPrompt = { id: `p${nextNum}`, label: `Prompt ${nextNum}`, prompt: last && last.prompt || '' };
      variation.prompts.push(newPrompt);
      writeFileSync(CONFIG, JSON.stringify(config, null, 2) + '\n');
      sendJson(res, 200, { ok: true, prompt: newPrompt });
      return;
    }

    // Clear job records now (Area 2 manual clear). Body: { scope:'failed'|'canceled'|'done'|'all',
    // brand?, batch? }. Only removes terminal records; never touches queued/waiting/running jobs.
    if (pathname === '/api/jobs/clear' && method === 'POST') {
      const body = await readBody(req);
      const scope = ['failed', 'canceled', 'done', 'all'].includes(body.scope) ? body.scope : 'failed';
      const cleared = store.clear({ scope, brand: body.brand, batch: body.batch });
      sendJson(res, 200, { ok: true, cleared });
      return;
    }

    // Requeue failed jobs (Area 2 retry). Body: { scope:'failed', brand?, batch? }. Resets attempts
    // to 0 and flips status → queued so the worker picks them up again.
    if (pathname === '/api/jobs/retry' && method === 'POST') {
      const body = await readBody(req);
      const requeued = store.retryFailed({ brand: body.brand, batch: body.batch });
      sendJson(res, 200, { ok: true, requeued });
      return;
    }

    // Read the persisted settings ({ graceSeconds, budget:{maxPer5h,maxPer7d} }) — Area 1/4.
    // ── Design mode (Phase 2/3) ──────────────────────────────────────────────────────────────
    // Scene-graph docs in .state/designs/, exports (json+html+png+FIGMA.md) in exports/{id}/.
    // ── Brand kits: per-workspace colors/fonts/notes that inform elements + the design agent ──
    if (pathname === '/api/brandkit' && method === 'GET') {
      const b = String(q.get('brand') || '').replace(/[^a-zA-Z0-9_-]+/g, '-');
      if (!b) { sendJson(res, 400, { ok: false, error: 'brand required' }); return; }
      try {
        const kit = JSON.parse(readFileSync(join(STATE_DIR, 'brandkits', `${b}.json`), 'utf8'));
        sendJson(res, 200, { ok: true, kit });
      } catch {
        sendJson(res, 200, { ok: true, kit: { colors: [], fonts: [], notes: '', prompt: '' } });
      }
      return;
    }
    if (pathname === '/api/brandkit' && method === 'POST') {
      const body = await readBody(req);
      const b = String(body.brand || '').replace(/[^a-zA-Z0-9_-]+/g, '-');
      if (!b) { sendJson(res, 400, { ok: false, error: 'brand required' }); return; }
      const kit = {
        colors: Array.isArray(body.kit?.colors) ? body.kit.colors.slice(0, 16).map(String) : [],
        fonts: Array.isArray(body.kit?.fonts) ? body.kit.fonts.slice(0, 6).map(String) : [],
        notes: String(body.kit?.notes || '').slice(0, 800),
        prompt: String(body.kit?.prompt || '').slice(0, 800),
      };
      const dir = join(STATE_DIR, 'brandkits');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${b}.json`), JSON.stringify(kit, null, 2));
      pushDoc('brandkit', b, { brand: b });
      sendJson(res, 200, { ok: true, kit });
      return;
    }
    if (pathname === '/api/designs' && method === 'GET') {
      // ?brand=X filters to that workspace; legacy docs (brand null) show everywhere.
      const brand = q.get('brand');
      let list = designs.listDesigns();
      if (brand) list = list.filter((d) => !d.brand || d.brand === brand);
      sendJson(res, 200, { ok: true, designs: list });
      return;
    }
    // Gallery thumbnail (written on save from the client raster).
    if (pathname === '/api/design/thumb' && method === 'GET') {
      const p = designs.thumbPath(q.get('id'));
      if (!p) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
      res.end(readFileSync(p));
      return;
    }
    if (pathname === '/api/design' && method === 'GET') {
      const doc = designs.getDesign(q.get('id'));
      sendJson(res, doc ? 200 : 404, doc ? { ok: true, design: doc } : { ok: false, error: 'not found' });
      return;
    }
    if (pathname === '/api/design/save' && method === 'POST') {
      const body = await readBody(req);
      try {
        const saved = designs.saveDesign(body.design || body);
        if (body.thumb) designs.saveThumb(saved.id, body.thumb);
        pushDoc('design', saved.id, { brand: saved.brand ?? null, updatedAt: saved.updatedAt });
        sendJson(res, 200, { ok: true, design: saved });
      } catch (e) {
        sendJson(res, 400, { ok: false, error: String(e && e.message || e) });
      }
      return;
    }
    if (pathname === '/api/design/delete' && method === 'POST') {
      const body = await readBody(req);
      const ok = designs.deleteDesign(body.id);
      if (ok) pushDoc('design', body.id, { deleted: true });
      sendJson(res, 200, { ok });
      return;
    }
    // Live sync (Figma-style): mid-gesture box/rotation frames from one tab, fanned out to every
    // other tab over SSE 'live'. NO disk write — commit-level truth still flows through
    // /api/design/save → pushDoc('design'). Payload: { id, origin, nodes:[{id, box, rotation?}] }.
    if (pathname === '/api/design/live' && method === 'POST') {
      const body = await readBody(req);
      const id = typeof body.id === 'string' ? body.id : '';
      const raw = Array.isArray(body.nodes) ? body.nodes.slice(0, 200) : [];
      if (!id || !raw.length) { sendJson(res, 400, { ok: false, error: 'id + nodes required' }); return; }
      const nodes = [];
      for (const n of raw) {
        if (!n || typeof n.id !== 'string' || !n.box || typeof n.box !== 'object') continue;
        const b = n.box;
        if (![b.x, b.y, b.w, b.h].every((v) => Number.isFinite(v))) continue;
        nodes.push({
          id: n.id,
          box: { x: b.x, y: b.y, w: b.w, h: b.h },
          ...(Number.isFinite(n.rotation) ? { rotation: n.rotation } : {}),
        });
      }
      ssePush('live', { id, origin: String(body.origin || '').slice(0, 64), nodes, at: Date.now() });
      sendJson(res, 200, { ok: true });
      return;
    }

    // Standalone HTML render (images inlined as data URLs) — preview + the Figma clipboard path.
    if (pathname === '/api/design/html' && method === 'GET') {
      const doc = designs.getDesign(q.get('id'));
      if (!doc) { sendJson(res, 404, { ok: false, error: 'not found' }); return; }
      const resolve = designs.makeImageResolver({ renders: RENDERS, repo: REPO, ttImagePath: ttCache.imagePath });
      const html = designs.renderDesignHtml(doc, resolve);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
      return;
    }
    if (pathname === '/api/design/export' && method === 'POST') {
      const body = await readBody(req);
      const doc = designs.getDesign(body.id) || body.design;
      if (!doc) { sendJson(res, 404, { ok: false, error: 'not found' }); return; }
      try {
        const resolve = designs.makeImageResolver({ renders: RENDERS, repo: REPO, ttImagePath: ttCache.imagePath });
        const out = designs.exportDesign(doc, { resolveImage: resolve, pngBase64: body.png || null, svg: body.svg || null });
        sendJson(res, 200, { ok: true, dir: out.dir, files: Object.keys(out.files) });
      } catch (e) {
        sendJson(res, 500, { ok: false, error: String(e && e.message || e) });
      }
      return;
    }
    // Agent chat history — .state/agent-chats/{docId}.json (the agent route appends automatically).
    if (pathname === '/api/design/chat' && method === 'GET') {
      const id = q.get('id');
      if (!id) { sendJson(res, 400, { ok: false, error: 'id required' }); return; }
      sendJson(res, 200, { ok: true, chat: designs.getChat(id) });
      return;
    }
    if (pathname === '/api/design/chat/clear' && method === 'POST') {
      const body = await readBody(req);
      sendJson(res, 200, { ok: designs.clearChat(body.id) });
      return;
    }

    // Workspace memory — .state/memory/{brand}.md; POST appends one dated bullet.
    if (pathname === '/api/memory' && (method === 'GET' || method === 'POST')) {
      const brandParam = method === 'GET' ? q.get('brand') : (await readBody(req).then((b) => { req._memBody = b; return b.brand; }));
      const b = String(brandParam || '').replace(/[^a-zA-Z0-9_-]+/g, '-');
      if (!b) { sendJson(res, 400, { ok: false, error: 'brand required' }); return; }
      const memDir = join(STATE_DIR, 'memory');
      const memFile = join(memDir, `${b}.md`);
      if (method === 'GET') {
        let text = '';
        try { text = readFileSync(memFile, 'utf8'); } catch { /* none yet */ }
        sendJson(res, 200, { ok: true, brand: b, text });
        return;
      }
      const note = String((req._memBody && req._memBody.text) || '').trim().slice(0, 500);
      if (!note) { sendJson(res, 400, { ok: false, error: 'text required' }); return; }
      mkdirSync(memDir, { recursive: true });
      const line = `- ${new Date().toISOString().slice(0, 10)}: ${note.replace(/\n+/g, ' ')}\n`;
      writeFileSync(memFile, (existsSync(memFile) ? readFileSync(memFile, 'utf8') : '') + line);
      sendJson(res, 200, { ok: true, brand: b, text: readFileSync(memFile, 'utf8') });
      return;
    }

    // Per-brand agent skill (.state/skills/{brand}.md) — MagicPath-style instruction bundle.
    if (pathname === '/api/brand/skill' && method === 'GET') {
      const b = String(q.get('brand') || '').replace(/[^a-zA-Z0-9_-]+/g, '-');
      if (!b) { sendJson(res, 400, { ok: false, error: 'brand required' }); return; }
      sendJson(res, 200, { ok: true, brand: b, text: loadBrandSkill(b) });
      return;
    }
    if (pathname === '/api/brand/skill' && method === 'POST') {
      const body = await readBody(req);
      const b = String(body.brand || '').replace(/[^a-zA-Z0-9_-]+/g, '-');
      if (!b) { sendJson(res, 400, { ok: false, error: 'brand required' }); return; }
      try {
        const text = saveBrandSkill(b, body.text);
        sendJson(res, 200, { ok: true, brand: b, text });
      } catch (e) {
        sendJson(res, 400, { ok: false, error: String(e && e.message || e) });
      }
      return;
    }

    // Design agent — proposes + applies scene-graph ops; steps stream over SSE `design`.
    // mode: edit | improve | generate (template seed + copy polish).
    if (pathname === '/api/design/agent' && method === 'POST') {
      const body = await readBody(req);
      const doc = designs.getDesign(body.id);
      if (!doc) { sendJson(res, 404, { ok: false, error: 'not found' }); return; }
      const mode = body.mode === 'improve' ? 'improve' : body.mode === 'generate' ? 'generate' : 'edit';
      if (mode === 'edit' && !String(body.instruction || '').trim()) { sendJson(res, 400, { ok: false, error: 'need instruction' }); return; }
      // Context enrichment: variation copy / ad title from config (via doc.link) and the
      // TrendTrack reference ad's hook/primary_text when the doc came from one.
      let brief = null;
      let referenceText = null;
      try {
        if (doc.link && doc.link.brand) {
          const config = readConfig();
          const brand = findBrand(config, doc.link.brand);
          const batch = brand && findBatch(brand, doc.link.batch);
          const ad = batch && findAd(batch, doc.link.ad);
          if (ad) {
            const v = (ad.variations || [])[0];
            brief = [ad.title || ad.name || ad.id, v && v.copy].filter(Boolean).join(' — ').slice(0, 400) || null;
          }
        }
        if (doc.reference && doc.reference.kind === 'trendtrack' && doc.reference.ref) {
          const rec = ttCache.getAd(doc.reference.ref);
          if (rec) referenceText = [rec.hook, rec.primary_text].filter(Boolean).join(' — ').slice(0, 400) || null;
        }
        // (brand kit handled below as a structured object — the agent designs ON brand)
      } catch { /* context is best-effort — never fail the run over it */ }
      // Brand kit as a structured object (v2 agent takes kit separately from the brief).
      let kit = null;
      let memory = null;
      const bk = String(doc.brand || (doc.link && doc.link.brand) || '').replace(/[^a-zA-Z0-9_-]+/g, '-');
      if (bk) {
        try { kit = JSON.parse(readFileSync(join(STATE_DIR, 'brandkits', `${bk}.json`), 'utf8')); } catch { /* no kit */ }
        try { memory = readFileSync(join(STATE_DIR, 'memory', `${bk}.md`), 'utf8').slice(-500); } catch { /* no notes */ }
      }
      // Attachments with intent: [{ref, note}] → 2-sentence codex description (cached per ref).
      const attachments = [];
      for (const a of (Array.isArray(body.attachments) ? body.attachments.slice(0, 3) : [])) {
        const ref = a && String(a.ref || '').replace(/[^\w-]+/g, '-');
        if (!ref) continue;
        const imgPath = join(REFS_DIR, `${ref}.png`);
        if (!existsSync(imgPath)) continue;
        const d = await describeImage(imgPath, { cacheId: ref });
        attachments.push({ ref, note: String(a.note || '').slice(0, 120), desc: d.ok ? d.text : 'reference image (no description available)' });
      }
      const instruction = mode === 'improve' ? '(improve)' : mode === 'generate' ? (String(body.instruction || '').trim() || '(generate)') : String(body.instruction);
      designs.appendChat(doc.id, {
        role: 'user',
        text: instruction,
        ...(attachments.length ? { attachments: attachments.map(({ ref, note }) => ({ ref, note })) } : {}),
      });
      // focusIds: canvas selections the user referenced in chat — scopes the agent's observe().
      const focusIds = Array.isArray(body.focusIds)
        ? body.focusIds.filter((x) => typeof x === 'string' && x).slice(0, 20)
        : null;
      try {
        // Stamp every step/done/error frame with the doc it belongs to. `design` is a single
        // global SSE broadcast channel and MAX_CONCURRENT design-agent runs can be >1 (e.g. two
        // variant docs being edited/generated at once) — without docId, a client watching variant
        // A can't tell its own agent's steps apart from variant B's on the same wire.
        const { doc: next, steps, source, runId, applied, lint, totals, verify } = await runDesignAgent(
          doc,
          mode === 'improve' ? '' : mode === 'generate' ? String(body.instruction || '') : String(body.instruction),
          (ev) => ssePush('design', { docId: doc.id, ...ev }),
          { brief, referenceText, kit, memory, attachments, mode, focusIds: focusIds && focusIds.length ? focusIds : null },
        );
        const saved = designs.saveDesign(next);
        pushDoc('design', saved.id, { brand: saved.brand ?? null, updatedAt: saved.updatedAt });
        // Chat stores the compact narration only: generated one-liners from applied ops + summary.
        const opLines = steps.filter((s) => s.kind === 'op').map((s) => s.summary).slice(-8);
        const doneStep = steps.find((s) => s.kind === 'verify');
        designs.appendChat(saved.id, {
          role: 'agent',
          text: [...opLines, doneStep ? doneStep.summary : ''].filter(Boolean).join('\n').slice(0, 1200),
          runId,
          result: { applied, source, model: llmInfo().model, inTok: totals.inTok, outTok: totals.outTok, turns: totals.turns, parts: totals.parts, verifyReady: verify?.ready },
        });
        sendJson(res, 200, { ok: true, design: saved, steps, source, runId, applied, lint: lint || undefined, totals, verify });
      } catch (e) {
        const msg = String(e && e.message || e);
        // 429 only for the concurrency cap — any other agent failure is a server error
        sendJson(res, /already running/.test(msg) ? 429 : 500, { ok: false, error: msg });
      }
      return;
    }

    // ── Layout extraction + skeletons (reference-first Design mode) ─────────────────────────
    // Extract runs codex VISION on the reference image (once per reference — result persists
    // as a skeleton and is stamped on the TrendTrack record). Steps stream over SSE `design`.
    if (pathname === '/api/design/extract' && method === 'POST') {
      const body = await readBody(req);
      const source = body.source || {};
      // Client may supply its own runId (so it can follow SSE steps from the very first push
      // and cancel mid-flight); fall back to a server-generated one.
      const runId = (typeof body.runId === 'string' && /^[\w-]{1,64}$/.test(body.runId))
        ? body.runId
        : `extract_${Date.now().toString(36)}`;
      let imagePath = null;
      let sourceRef = null;
      if (source.kind === 'trendtrack' && source.ref) {
        const cached = ttCache.getAd(source.ref);
        // Reuse a previous extraction for free when one exists.
        if (cached && cached.layoutId) {
          const existing = skeletons.getSkeleton(cached.layoutId);
          if (existing) { sendJson(res, 200, { ok: true, skeleton: existing, cached: true, runId }); return; }
        }
        imagePath = ttCache.imagePath(source.ref);
        sourceRef = { kind: 'trendtrack', ref: source.ref, url: `/api/trendtrack/image/${encodeURIComponent(source.ref)}`, label: cached && cached.hook || source.ref };
      } else if (source.kind === 'upload' && source.ref) {
        imagePath = join(REFS_DIR, `${part(source.ref)}.png`);
        sourceRef = { kind: 'upload', ref: source.ref, url: `/refasset?id=${encodeURIComponent(source.ref)}`, label: 'Uploaded reference' };
      } else if (source.kind === 'render' && source.ref) {
        imagePath = join(RENDERS, String(source.ref));
        sourceRef = { kind: 'render', ref: source.ref, url: `/img?path=${encodeURIComponent(source.ref)}`, label: source.ref };
      }
      if (!imagePath || !existsSync(imagePath)) { sendJson(res, 404, { ok: false, error: 'reference image not found', runId }); return; }
      let stepI = 0;
      const pushStep = (summary, done) => {
        stepI += 1;
        ssePush('design', { runId, step: { i: stepI, kind: 'progress', summary, at: Date.now() }, ...(done ? { done: true } : {}) });
      };
      pushStep('reading the reference with vision — usually ~1 fast pass…');
      const r = await extractLayout(imagePath, { runId, onProgress: (msg) => pushStep(msg) });
      if (!r.ok) {
        const summary = r.canceled
          ? 'extraction canceled'
          : `extraction failed (${r.error})`;
        pushStep(summary, true);
        sendJson(res, 200, { ok: false, error: r.error, canceled: !!r.canceled, runId });
        return;
      }
      const skeleton = skeletons.saveSkeleton({
        id: `skel_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        name: (sourceRef && sourceRef.label ? String(sourceRef.label).slice(0, 60) : 'Extracted layout'),
        canvas: r.canvas,
        layers: r.layers,
        archetype: r.archetype || 'generic',   // extraction v2: classified ad archetype
        background: r.background || null,      // dominant flat bg (null = photo)
        sourceRef,
        extractedBy: 'vision',
        createdAt: Date.now(),
      });
      if (source.kind === 'trendtrack') ttCache.attachLayout(source.ref, skeleton.id);
      pushDoc('skeleton', skeleton.id, { brand: skeleton.brand ?? null });
      pushStep(`extracted ${r.layers.length} design layer(s) · ${r.archetype || 'generic'} — skeleton saved`, true);
      sendJson(res, 200, { ok: true, skeleton, cached: false, runId });
      return;
    }
    // Cancel an in-flight extraction — kills the codex child; the original request resolves
    // with { ok:false, canceled:true } and its SSE stream closes with done:true.
    if (pathname === '/api/design/extract/cancel' && method === 'POST') {
      const body = await readBody(req);
      const canceled = cancelExtraction(String(body.runId || ''));
      sendJson(res, 200, { ok: true, canceled });
      return;
    }
    if (pathname === '/api/skeletons' && method === 'GET') {
      const brand = q.get('brand');
      let list = skeletons.listSkeletons();
      if (brand) list = list.filter((s) => !s.brand || s.brand === brand);
      sendJson(res, 200, { ok: true, skeletons: list });
      return;
    }
    if (pathname === '/api/skeleton' && method === 'GET') {
      const s = skeletons.getSkeleton(q.get('id'));
      sendJson(res, s ? 200 : 404, s ? { ok: true, skeleton: s } : { ok: false, error: 'not found' });
      return;
    }
    if (pathname === '/api/skeleton/save' && method === 'POST') {
      const body = await readBody(req);
      try {
        const sk = skeletons.saveSkeleton(body.skeleton || body);
        pushDoc('skeleton', sk.id, { brand: sk.brand ?? null });
        sendJson(res, 200, { ok: true, skeleton: sk });
      } catch (e) { sendJson(res, 400, { ok: false, error: String(e && e.message || e) }); }
      return;
    }
    if (pathname === '/api/skeleton/delete' && method === 'POST') {
      const body = await readBody(req);
      const ok = skeletons.deleteSkeleton(body.id);
      if (ok) pushDoc('skeleton', body.id, { deleted: true });
      sendJson(res, 200, { ok });
      return;
    }

    // Batch apply — one comp's design onto N base images → N new linked comps.
    if (pathname === '/api/design/apply-batch' && method === 'POST') {
      const body = await readBody(req);
      const doc = designs.getDesign(body.id);
      if (!doc) { sendJson(res, 404, { ok: false, error: 'not found' }); return; }
      const images = Array.isArray(body.images) ? body.images.slice(0, 40) : [];
      if (!images.length) { sendJson(res, 400, { ok: false, error: 'need images[]' }); return; }
      const created = [];
      for (const img of images) {
        if (!img || !img.src) continue;
        const copy = JSON.parse(JSON.stringify(doc));
        copy.id = `comp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        copy.name = `${doc.name} · ${String(img.label || created.length + 1)}`;
        copy.source = img.source || null;
        copy.createdAt = Date.now();
        copy.updatedAt = Date.now();
        const base = copy.layers.find((l) => l.role === 'base');
        if (base) base.src = String(img.src);
        designs.saveDesign(copy);
        pushDoc('design', copy.id, { brand: copy.brand ?? null });
        created.push({ id: copy.id, name: copy.name });
      }
      sendJson(res, 200, { ok: true, created });
      return;
    }

    // User-saved elements (.state/elements.json) — "save selection as element".
    if (pathname === '/api/elements' && method === 'GET') {
      let saved = [];
      try { saved = JSON.parse(readFileSync(join(STATE_DIR, 'elements.json'), 'utf8')).elements || []; } catch { /* none yet */ }
      sendJson(res, 200, { ok: true, elements: saved });
      return;
    }
    if (pathname === '/api/elements/save' && method === 'POST') {
      const body = await readBody(req);
      if (!body.name || !Array.isArray(body.layers) || !body.layers.length) {
        sendJson(res, 400, { ok: false, error: 'need name + layers[]' });
        return;
      }
      let saved = [];
      try { saved = JSON.parse(readFileSync(join(STATE_DIR, 'elements.json'), 'utf8')).elements || []; } catch { /* fresh */ }
      saved.unshift({
        id: `el_${Date.now().toString(36)}`,
        name: String(body.name).slice(0, 60),
        canvas: body.canvas || { w: 1080, h: 1080 },
        layers: body.layers.slice(0, 8),
        createdAt: Date.now(),
      });
      saved = saved.slice(0, 60);
      mkdirSync(STATE_DIR, { recursive: true });
      writeFileSync(join(STATE_DIR, 'elements.json'), JSON.stringify({ elements: saved }, null, 2));
      pushDoc('element', saved[0] && saved[0].id);
      sendJson(res, 200, { ok: true, elements: saved });
      return;
    }
    if (pathname === '/api/elements/delete' && method === 'POST') {
      const body = await readBody(req);
      let saved = [];
      try { saved = JSON.parse(readFileSync(join(STATE_DIR, 'elements.json'), 'utf8')).elements || []; } catch { /* none */ }
      saved = saved.filter((e) => e.id !== body.id);
      writeFileSync(join(STATE_DIR, 'elements.json'), JSON.stringify({ elements: saved }, null, 2));
      pushDoc('element', body.id, { deleted: true });
      sendJson(res, 200, { ok: true, elements: saved });
      return;
    }

    // ── Planner (Phase 1) ────────────────────────────────────────────────────────────────────
    // Kicks off async; steps stream over SSE `plan`; GET returns the active/last run snapshot.
    if (pathname === '/api/plan/run' && method === 'POST') {
      const body = await readBody(req);
      const active = getActiveRun();
      if (active && !active.done) { sendJson(res, 409, { ok: false, error: 'a plan run is already active' }); return; }
      runPlan(body || {}, (ev) => ssePush('plan', ev)).catch(() => { /* run records its own error */ });
      // Give the run a beat to register so the response can carry its id.
      setTimeout(() => {
        const run = getActiveRun();
        sendJson(res, 200, { ok: true, runId: run && run.id });
      }, 30);
      return;
    }
    if (pathname === '/api/plan/run' && method === 'GET') {
      sendJson(res, 200, { ok: true, run: getActiveRun() });
      return;
    }
    // 0-credit ranked cache search (the rail's live ref search without a full run).
    if (pathname === '/api/plan/refs' && method === 'GET') {
      sendJson(res, 200, { ok: true, refs: rankRefs(q.get('q') || '', { brand: q.get('brand') || null, limit: Number(q.get('limit')) || 12 }) });
      return;
    }

    // ── Taste (Phase 4 feedback loop) ────────────────────────────────────────────────────────
    if (pathname === '/api/taste' && method === 'GET') {
      sendJson(res, 200, { ok: true, votes: taste.getVotes() });
      return;
    }
    if (pathname === '/api/taste' && method === 'POST') {
      const body = await readBody(req);
      sendJson(res, 200, { ok: true, votes: taste.vote(body.key, body.verdict) });
      return;
    }

    // Daily-cap Continue: the banner's button — grants +10 more percentage points of the weekly
    // window for today, then the cap re-arms at the next +10. GET returns the live readout.
    if (pathname === '/api/daily-cap' && method === 'GET') {
      sendJson(res, 200, { ok: true, dailyCap: getDailyCap() });
      return;
    }
    if (pathname === '/api/daily-cap/continue' && method === 'POST') {
      const dailyCap = grantDailyBonus();
      broadcast(); // the worker may be unblocked now — push fresh state to every client
      sendJson(res, 200, { ok: true, dailyCap, blockers: getBlockers() });
      return;
    }

    if (pathname === '/api/settings' && method === 'GET') {
      sendJson(res, 200, { ok: true, settings: getSettings() });
      return;
    }

    // Merge a settings patch ({ graceSeconds?, budget?:{maxPer5h?,maxPer7d?} }) and persist it. The
    // change takes effect immediately (worker reads getGraceSeconds() each tick; budget gates spawns).
    if (pathname === '/api/settings' && method === 'POST') {
      const body = await readBody(req);
      const settings = updateSettings(body || {});
      broadcast(); // surface the new budget/grace to any listening clients
      sendJson(res, 200, { ok: true, settings });
      return;
    }

    if (pathname.startsWith('/api/')) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }

    // ── Static (SPA) for any other GET ─────────────────────────────────────────────────────────
    if (method === 'GET' || method === 'HEAD') {
      await serveStatic(req, res, pathname);
      return;
    }

    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('Method not allowed');
  } catch (e) {
    sendJson(res, 500, { error: String((e && e.message) || e) });
  }
});

server.listen(PORT, () => {
  console.log(`[studio] http://localhost:${PORT}`);
});
