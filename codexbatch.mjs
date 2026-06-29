#!/usr/bin/env node
// Codex batch driver. Renders the SAME config.json batch as runbatch.mjs, but through the
// chatgpt-imagegen codex backend (a headless POST to chatgpt.com/backend-api/codex/responses using
// ~/.codex/auth.json). That bills the SEPARATE Codex-usage bucket, so when the ChatGPT-web image
// cap is hit you can keep generating here. Images land in the SAME local folders the extension uses
// (~/Downloads/static-factory-b1/renders/<brand>/<batch>/ads/...), so nothing is duplicated or lost.
// NEVER OVERWRITES — every run writes a fresh versioned path (run-N.png -> run-N-v2.png -> ...), so
// "regenerate" always adds a new version and an earlier image is never replaced. Progress is POSTed
// to the bridge (/codex-progress) so the extension panel shows it in sync, and each finished image
// is RELAYED to the extension (/codex-result) as a dataURL for live panel preview.
//
//   node codexbatch.mjs [edu|smoke] [adId] --brand=nanox --batch=b2
//   VARIANTS=2 CODEX_PARALLEL=2 node codexbatch.mjs edu --brand=nanox --batch=b2
//   node codexbatch.mjs edu AD-ART-01 --brand=nanox --batch=b2   # regenerating adds a new version
//
// Requires: `codex login` (so ~/.codex/auth.json exists) and python3 with the chatgpt-imagegen tool.
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { versionedRelPath } = require('./logic.js');

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 8787;
const BRIDGE = `http://localhost:${PORT}`;
const OUT = join(process.env.HOME, 'Downloads', 'static-factory-b1', 'renders');
// The chatgpt-imagegen CLI. Override with CHATGPT_IMAGEGEN if it lives elsewhere.
const TOOL = process.env.CHATGPT_IMAGEGEN || join(process.env.HOME, 'Downloads', 'chatgpt-unlimited', 'tools', 'chatgpt-imagegen.py');
const PARALLEL = Math.max(1, Math.min(4, Number(process.env.CODEX_PARALLEL) || 2));
// Some Python builds (e.g. homebrew python) ship with NO CA bundle, so the codex backend's HTTPS
// call to chatgpt.com fails with CERTIFICATE_VERIFY_FAILED. Point the child at a real CA bundle:
// an explicit SSL_CERT_FILE if set, else the macOS system bundle. Harmless if the python already
// has certs. Override with SSL_CERT_FILE=/path if your machine differs.
const CA_BUNDLE = process.env.SSL_CERT_FILE || (existsSync('/etc/ssl/cert.pem') ? '/etc/ssl/cert.pem' : null);

const flags = {};
const positional = [];
for (const arg of process.argv.slice(2)) {
  const m = /^--([^=]+)=(.*)$/.exec(arg);
  if (m) flags[m[1]] = m[2];
  else if (arg.startsWith('--')) flags[arg.slice(2)] = true;
  else positional.push(arg);
}
const mode = positional[0] || 'smoke';
const onlyAd = positional[1] || null;
// RESUME: skip any slot that already has its base image (used by codex-runner.mjs to retry after a
// usage-limit cooldown without re-spending on finished images).
const RESUME = process.env.RESUME === '1' || !!flags.resume;

const cfg = JSON.parse(readFileSync(join(HERE, 'config.json'), 'utf8'));
const brand = flags.brand
  ? (cfg.brands.find((b) => b.id === flags.brand) || cfg.brands.find((b) => String(b.name).toLowerCase() === String(flags.brand).toLowerCase()))
  : cfg.brands[0];
if (!brand) { console.error(`[codexbatch] unknown brand "${flags.brand}". Available: ${cfg.brands.map((b) => b.id).join(', ')}`); process.exit(1); }
const batch = flags.batch ? (brand.batches.find((ba) => ba.code === flags.batch) || brand.batches[0]) : brand.batches[0];
const B = brand.id, BA = batch.code;
const VARIANTS = Math.max(1, Math.min(10, Number(process.env.VARIANTS) || 2));
const size = /^\d+x\d+$/.test(String(batch.aspect || '')) ? batch.aspect : '1024x1024';

const part = (v) => String(v || '').trim().replace(/[^a-zA-Z0-9_-]+/g, '-');
const finalRel = (a, v, p, r) => `${part(B)}/${part(BA)}/ads/${part(a)}/${part(v)}/${part(p)}/run-${r}.png`;
const promptEntries = (variation) => (variation.prompts && variation.prompts.length ? variation.prompts : [{ id: 'p1', prompt: variation.prompt }])
  .map((e, i) => ({ id: e.id || `p${i + 1}`, prompt: e.prompt }));
// codex --ref does image-to-image EDITS, so attach the product tube ONLY to shots that actually
// show it (the prompt names "Image 1 is the ... tube" / "tube reading NANO X"). Joint/people shots
// stay pure text-to-image so they don't get rendered as the tube.
const isTubeShot = (prompt) => /\bimage 1 is the [^.]*tube\b/i.test(prompt) || /tube reading\b/i.test(prompt);
const productRef = (ad) => { const p = join(HERE, 'assets', `${ad.product}.png`); return existsSync(p) ? p : null; };

// Build the job list (same paths as runbatch/the extension).
const jobs = [];
const ads = batch.ads.filter((a) => !onlyAd || a.id === onlyAd);
for (const ad of ads) {
  if (!((mode === 'edu' || mode === 'smoke') && ad.kind === 'product')) continue;
  const count = mode === 'smoke' ? 1 : VARIANTS;
  for (const v of ad.variations) {
    // Codex generates each call independently and varies on its own, so the web-only "p2 second
    // take" is redundant here — use only the first authored prompt (p1) per variation.
    for (const p of promptEntries(v).slice(0, 1)) {
      const ref = isTubeShot(p.prompt) ? productRef(ad) : null;
      for (let r = 1; r <= count; r++) {
        jobs.push({ name: `${ad.id}_${BA}_${v.id}_${p.id}_r${r}`, prompt: p.prompt, rel: finalRel(ad.id, v.id, p.id, r), ref });
        if (mode === 'smoke') break;
      }
      if (mode === 'smoke') break;
    }
    if (mode === 'smoke') break;
  }
  if (mode === 'smoke') break;
}
if (mode === 'smoke') jobs.splice(1);

if (!jobs.length) { console.error(`[codexbatch] no product jobs for ${B}/${BA}${onlyAd ? '/' + onlyAd : ''}`); process.exit(1); }
if (!existsSync(TOOL)) { console.error(`[codexbatch] chatgpt-imagegen tool not found at ${TOOL} (set CHATGPT_IMAGEGEN)`); process.exit(1); }

console.log(`[codexbatch:${mode}] ${B}/${BA} — ${jobs.length} images via codex backend (size ${size}, parallel ${PARALLEL}) -> ${OUT}`);
console.log(`watch: curl -s ${BRIDGE}/status | python3 -m json.tool   (codexProgress field)`);

let done = 0, failed = 0, skipped = 0;
const total = jobs.length;
async function reportProgress(current, error) {
  try {
    await fetch(`${BRIDGE}/codex-progress`, { method: 'POST', body: JSON.stringify({ done, failed, skipped, total, current, error: error || null }) });
  } catch {}
}

// Relay a finished image to the extension for live panel preview. Reads the written PNG, base64s it
// as a dataURL, POSTs to /codex-result. Non-fatal: if the bridge is down the file is still saved.
async function relayResult(name, relPath, outPath) {
  try {
    const buf = await readFile(outPath);
    const dataUrl = `data:image/png;base64,${buf.toString('base64')}`;
    await fetch(`${BRIDGE}/codex-result`, { method: 'POST', body: JSON.stringify({ name, relPath, dataUrl }) });
  } catch {}
}

function generate(job) {
  return new Promise((resolve) => {
    const out = join(OUT, job.rel);
    mkdirSync(dirname(out), { recursive: true });
    const args = [TOOL, job.prompt, '-o', out, '--backend', 'codex', '--size', size];
    if (job.ref) args.push('-i', job.ref);
    // Codex on MINIMAL reasoning: just execute the prompt, don't think (faster, less metered spend).
    // Overridable via CHATGPT_IMAGEGEN_EFFORT (e.g. 'low') if 'minimal' is ever rejected.
    const env = { ...process.env, CHATGPT_IMAGEGEN_EFFORT: process.env.CHATGPT_IMAGEGEN_EFFORT || 'low', CHATGPT_IMAGEGEN_VERBOSITY: process.env.CHATGPT_IMAGEGEN_VERBOSITY || 'low', ...(CA_BUNDLE ? { SSL_CERT_FILE: CA_BUNDLE, REQUESTS_CA_BUNDLE: CA_BUNDLE } : {}) };
    const child = spawn('python3', args, { stdio: ['ignore', 'ignore', 'pipe'], env });
    let err = '';
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('close', (code) => {
      const ok = code === 0 && existsSync(out);
      resolve({ ok, out, error: ok ? null : (err.trim().split('\n').slice(-4).join(' | ') || `exit ${code}`) });
    });
    child.on('error', (e) => resolve({ ok: false, out, error: String(e.message || e) }));
  });
}

// Small concurrency pool.
let cursor = 0;
async function worker() {
  for (;;) {
    const i = cursor++;
    if (i >= jobs.length) return;
    const job = jobs[i];
    // RESUME: if this slot already has its base image, skip it — a retry after a usage-limit
    // cooldown only fills the MISSING images and never re-spends on finished ones.
    if (RESUME && existsSync(join(OUT, job.rel))) {
      skipped++;
      console.log(`[skip ${done + failed + skipped}/${total}] ${job.rel} (already present)`);
      await reportProgress(job.name);
      continue;
    }
    // Never overwrite: route every write through the next free versioned path (run-N.png ->
    // run-N-v2.png -> ...). Regenerating always adds a new version, never replaces an earlier one.
    job.rel = versionedRelPath(job.rel, (rel) => existsSync(join(OUT, rel)));
    await reportProgress(job.name);
    const res = await generate(job);
    if (res.ok) {
      done++;
      console.log(`[ok ${done + failed + skipped}/${total}] ${job.rel}${job.ref ? ' (tube ref)' : ''}`);
      await relayResult(job.name, job.rel, res.out);
    } else { failed++; console.log(`[FAIL ${done + failed + skipped}/${total}] ${job.rel}: ${res.error}`); }
    await reportProgress(job.name, res.ok ? null : res.error);
  }
}

await reportProgress(null);
await Promise.all(Array.from({ length: PARALLEL }, () => worker()));
await reportProgress(null);
console.log(`[codexbatch:${mode}] complete — ${done} generated, ${skipped} cached/skipped, ${failed} failed, of ${total}. Saved under ${OUT}/${B}/${BA}/ads/`);
process.exit(failed && !done ? 1 : 0);
