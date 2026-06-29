#!/usr/bin/env node
// Claude's driver: read batch.json + bundled refs, build jobs (prompt + ref data URLs +
// project name + the real IMG file code as the name), and push them to the bridge. The
// extension running in the user's ChatGPT tab does the rest. This is how Claude generates
// the batch on the user's normal quota without touching a browser.
//
//   node drive.mjs                 # enqueue the whole NATIVE batch
//   node drive.mjs --ad IMG04      # just one ad
//   node drive.mjs --port 8787 --out /Users/mk/Downloads/static-factory-b1/renders
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (f, d) => { const i = process.argv.indexOf(f); return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const PORT = arg('--port', '8787');
const ONLY = arg('--ad', null);
const OUT = arg('--out', join(process.env.HOME, 'Downloads', 'static-factory-b1', 'renders'));
const PROJECT = arg('--project', `Simpletics Statics - Batch 1 - ${new Date().toISOString().slice(0, 10)}`);

const batch = JSON.parse(readFileSync(join(HERE, 'batch.json'), 'utf8'));
const refCache = {};
function refDataUrl(key) {
  if (key in refCache) return refCache[key];
  const p = join(HERE, 'assets', `${key}.png`);
  refCache[key] = existsSync(p) ? `data:image/png;base64,${readFileSync(p).toString('base64')}` : null;
  return refCache[key];
}
function jobRefs(ad) {
  const key = ad.kind === 'face' ? 'face' : ad.product;
  const d = refDataUrl(key);
  return d ? [{ dataUrl: d, name: `${key}.png` }] : [];
}

const jobs = [];
for (const ad of batch.ads) {
  if (ONLY && ad.id !== ONLY) continue;
  for (const c of ad.concepts) {
    jobs.push({
      name: `${ad.id}_${batch.code}_${ad.type}_NATIVE_${ad.product}_${c.id}`,
      prompt: c.prompt,
      refs: jobRefs(ad),
      project: PROJECT,
    });
  }
}

const batchNum = Number((batch.code || 'b1').replace(/\D/g, '')) || 1;
const res = await fetch(`http://localhost:${PORT}/enqueue`, {
  method: 'POST',
  body: JSON.stringify({ jobs, out: resolve(OUT), batch: batchNum }),
}).then((r) => r.json()).catch((e) => ({ ok: false, error: String(e.message || e) }));

if (res.ok) console.log(`[drive] enqueued ${res.added.length} jobs -> ${res.out}\n[drive] watch: curl -s localhost:${PORT}/status | python3 -m json.tool`);
else console.error(`[drive] bridge not reachable on :${PORT}. Start it: node bridge.mjs --out "${OUT}"\n  ${res.error || ''}`);
