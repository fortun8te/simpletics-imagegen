#!/usr/bin/env node
// studio-server.mjs — ImageGen Studio backend (zero-dep node:http).
//
// Owns the job queue + worker, scans the renders tree, proxies the bridge (:8787) for codex health,
// and serves the built frontend + /api/* + /img + /events (SSE) on :8788. ALL generation is driven
// from here via the worker — the agent never launches codex from a terminal. See ../PLAN.md §3 and
// lib/INTERFACES.md for the exact contract. Zero external deps: node:* + the three sibling lib
// modules (jobstore / worker / state, which themselves only use node:* + logic.js).
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname, normalize, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createJobStore } from './lib/jobstore.mjs';
import { createWorker } from './lib/worker.mjs';
import { buildState } from './lib/state.mjs';

// ── Paths (injected into the lib modules) ────────────────────────────────────────────────────────
const STUDIO = dirname(fileURLToPath(import.meta.url));            // .../simpletics-imagegen/studio
const REPO = join(STUDIO, '..');                                  // .../simpletics-imagegen (config.json, logic.js)
const RENDERS = join(process.env.HOME, 'Downloads', 'static-factory-b1', 'renders');
const STATE_DIR = join(STUDIO, '.state');
const DIST = join(STUDIO, 'dist');
const CONFIG = join(REPO, 'config.json');
const BRIDGE = 'http://localhost:8787';
const PORT = 8788;

// ── Wiring ───────────────────────────────────────────────────────────────────────────────────────
const store = createJobStore({ stateDir: STATE_DIR });
const worker = createWorker({
  store,
  renders: RENDERS,
  repoDir: REPO,
  concurrency: Number(process.env.CONCURRENCY) || 3,
  cooldownMin: Number(process.env.COOLDOWN_MIN) || 30,
  onChange: broadcast,
});
worker.start();

// ── SSE clients ──────────────────────────────────────────────────────────────────────────────────
// One Set of live response objects. `broadcast` is the worker's onChange and also fires on every
// store mutation, so any slot/job change pushes a fresh `state` (+ `queue`) event to every client.
const sseClients = new Set();

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
    req.on('data', (c) => { buf += c; if (buf.length > 5e6) buf = buf.slice(0, 5e6); });
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

const part = (v) => String(v || '').trim().replace(/[^a-zA-Z0-9_-]+/g, '-');

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
function enqueueSlot(brand, batch, ad, v, p, variants, sizeDefault) {
  const baseRun = doneRunCount(brand.id, batch.code, ad.id, v.id, p.id)
    + inflightCount(brand.id, batch.code, ad.id, v.id, p.id) + 1;
  const promptText = p.prompt;
  const size = (/^\d+x\d+$/.test(String(batch.aspect || '')) ? batch.aspect : '1024x1024');
  const ref = isTubeShot(promptText) ? tubeRefPath() : null;
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
      ref,
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
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=60' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found');
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

    // ── API ──────────────────────────────────────────────────────────────────────────────────────
    if (pathname === '/api/config' && method === 'GET') {
      sendJson(res, 200, readConfig());
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
      });
      return;
    }

    if (pathname === '/api/generate' && method === 'POST') {
      const body = await readBody(req);
      const config = readConfig();
      const brand = findBrand(config, body.brand);
      const batch = brand && findBatch(brand, body.batch);
      if (!brand || !batch) { sendJson(res, 400, { ok: false, error: 'unknown brand/batch' }); return; }
      const variants = Math.max(1, Math.min(10, Number(body.variants) || 1));
      const slots = resolveSlots(batch, body.scope);
      let enqueued = 0;
      for (const s of slots) enqueued += enqueueSlot(brand, batch, s.ad, s.variation, s.prompt, variants);
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

    if (pathname === '/api/cancel' && method === 'POST') {
      const body = await readBody(req);
      store.cancel({ jobId: body.jobId, all: body.all === true });
      sendJson(res, 200, { ok: true });
      return;
    }

    if (pathname === '/api/archive' && method === 'POST') {
      const body = await readBody(req);
      if (!body.relPath) { sendJson(res, 400, { ok: false, error: 'missing relPath' }); return; }
      store.setArchived(body.relPath, body.archived !== false);
      sendJson(res, 200, { ok: true });
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
