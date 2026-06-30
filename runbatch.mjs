#!/usr/bin/env node
// Claude's config-aware batch driver. Reads config.json, builds jobs (with ref data URLs)
// and enqueues them to the bridge, which the extension runs in the real ChatGPT tab.
// Modes:
//   smoke        one educational product shot (proves the full pipeline)
//   edu          all educational variations (product shots, no model needed)
//   models       all testimonial model candidates (face-swap)
//   testimonials all testimonial variations, using each ad's first generated model as the ref
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 8787;
// Args: positional [mode] [onlyAd], plus optional --brand=<id> and --batch=<code> selectors.
// Without --brand we default to the first brand (Simpletics) for backward compatibility.
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
const cfg = JSON.parse(readFileSync(join(HERE, 'config.json'), 'utf8'));
const brandSel = flags.brand || null;
const brand = brandSel
  ? (cfg.brands.find((b) => b.id === brandSel) || cfg.brands.find((b) => String(b.name).toLowerCase() === String(brandSel).toLowerCase()))
  : cfg.brands[0];
if (!brand) {
  console.error(`[runbatch] unknown brand "${brandSel}". Available: ${cfg.brands.map((b) => b.id).join(', ')}`);
  process.exit(1);
}
const batchSel = flags.batch || null;
const batch = batchSel ? (brand.batches.find((ba) => ba.code === batchSel) || brand.batches[0]) : brand.batches[0];
const B = brand.id, BA = batch.code;
// The project name is a clean timestamped string with no version label — avoids cluttering
// filenames and output paths with "v1" / version text that the imagegen tool would misread.
const project = `${batch.project || brand.name + ' ' + batch.name}  ${new Date().getFullYear()}-${String(new Date().getMonth()+1).padStart(2,'0')}-${String(new Date().getDate()).padStart(2,'0')} ${String(new Date().getHours()).padStart(2,'0')}:${String(new Date().getMinutes()).padStart(2,'0')}`;

const part = (v) => String(v || '').trim().replace(/[^a-zA-Z0-9_-]+/g, '-');
const dataUrl = (p) => existsSync(p) ? `data:image/png;base64,${readFileSync(p).toString('base64')}` : null;
const refsAsset = (k) => dataUrl(join(HERE, 'assets', `${k}.png`));
const refsLayout = (f) => f ? dataUrl(join(HERE, 'assets', 'refs', f)) : null;

// Descriptive names: use ad.title/product label + batch name + variation.label + prompt.label instead of bare IDs.
function modelName(a, m, r) { return { name: `${a}_${BA}_model_${m}_r${r}`, relativePath: `${B}/${BA}/models/${a}/${m}/run-${r}.png` }; }
// finalName now uses `${title || 'Ad'}_${batch.name}_${variation.label}_r${run}` so activity lanes and error messages show readable text.
function finalName(a, v, p, r) { return { name: `${part(a.title || a.product || 'Ad')}_${BA}_${v.label || v.id}_${p.label || p.id}_r${r}`, relativePath: `${B}/${BA}/ads/${a}/${v}/${p}/run-${r}.png` }; }

function promptEntries(variation) {
  const ps = variation.prompts && variation.prompts.length ? variation.prompts : [{ id: 'p1', prompt: variation.prompt }];
  return ps.map((e, i) => ({ id: e.id || `p${i + 1}`, prompt: e.prompt }));
}

const jobs = [];
const ads = batch.ads.filter((a) => !onlyAd || a.id === onlyAd);
const faceRef = refsAsset('face');
// VARIANTS=N -> one chat per prompt asks ChatGPT for N variants and captures all N,
// instead of opening N separate chats. Default 2 (matches the panel's per-prompt default),
// env-overridable, clamped to 1..10. Models always make 2 candidates to pick from.
const VARIANTS = Math.max(1, Math.min(10, Number(process.env.VARIANTS) || 2));

for (const ad of ads) {
  const layout = refsLayout(ad.ref);
  if (mode === 'models' && ad.kind === 'face') {
    for (const m of ad.models || []) {
      const runs = [modelName(ad.id, m.id, 1), modelName(ad.id, m.id, 2)]; // 2 candidates to pick from, one chat
      jobs.push({ ...runs[0], prompt: m.prompt, refs: faceRef ? [{ dataUrl: faceRef, name: 'face.png' }] : [], project, variants: 2, variantPaths: runs.map((r) => r.relativePath) });
    }
  }
  if ((mode === 'edu' || mode === 'smoke') && ad.kind === 'product') {
    // Smoke proves the pipeline with a single image; edu honors the VARIANTS default.
    const count = mode === 'smoke' ? 1 : VARIANTS;
    for (const v of ad.variations) {
      for (const p of promptEntries(v)) {
        const runs = Array.from({ length: count }, (_, i) => finalName(ad.id, v.id, p.id, i + 1));
        const refs = [];
        if (refsAsset(ad.product)) refs.push({ dataUrl: refsAsset(ad.product), name: `${ad.product}.png` });
        if (layout) refs.push({ dataUrl: layout, name: ad.ref });
        for (const k of ad.extraRefs || []) { const d = refsAsset(k); if (d) refs.push({ dataUrl: d, name: `${k}.png` }); }
        jobs.push({ ...runs[0], prompt: p.prompt, refs, project, variants: count, variantPaths: runs.map((r) => r.relativePath) });
        if (mode === 'smoke') break;
      }
      if (mode === 'smoke') break;
    }
  }
  if (mode === 'testimonials' && ad.kind === 'face') {
    // use this ad's first generated model candidate as the face ref
    const firstModel = (ad.models || [])[0];
    const modelPng = firstModel && join(HERE, '..', 'static-factory-b1', 'renders', `${B}/${BA}/models/${ad.id}/${firstModel.id}/run-1.png`);
    const modelData = modelPng && dataUrl(modelPng);
    if (!modelData) { console.log(`[skip] ${ad.id}: no generated model yet (run "models" first)`); continue; }
    for (const v of ad.variations) {
      for (const p of promptEntries(v)) {
        const runs = Array.from({ length: VARIANTS }, (_, i) => finalName(ad.id, v.id, p.id, i + 1));
        const refs = [{ dataUrl: modelData, name: 'model.png' }];
        if (layout) refs.push({ dataUrl: layout, name: ad.ref });
        for (const k of ad.extraRefs || []) { const d = refsAsset(k); if (d) refs.push({ dataUrl: d, name: `${k}.png` }); }
        jobs.push({ ...runs[0], prompt: p.prompt, refs, project, variants: VARIANTS, variantPaths: runs.map((r) => r.relativePath) });
      }
    }
  }
}

if (mode === 'smoke') jobs.splice(1); // exactly one job

const res = await fetch(`http://localhost:${PORT}/enqueue`, {
  method: 'POST', body: JSON.stringify({ jobs, out: join(process.env.HOME, 'Downloads', 'static-factory-b1', 'renders'), batch: 1 }),
}).then((r) => r.json()).catch((e) => ({ ok: false, error: String(e.message || e) }));

console.log(res.ok ? `[runbatch:${mode}] enqueued ${res.added.length} jobs -> ${res.out}` : `[runbatch] bridge not reachable: ${res.error}`);
if (res.ok) console.log(`watch: curl -s localhost:${PORT}/status | python3 -m json.tool`);
