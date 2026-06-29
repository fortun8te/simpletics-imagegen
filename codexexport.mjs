#!/usr/bin/env node
// Friendly-name export. The codex/extension renders live at the SYSTEM path
//   ~/Downloads/static-factory-b1/renders/nanox/<batch>/ads/<AD>/<VAR>/<prompt>/run-N[-vN].png
// (that path IS the panel's slot identity, so it must stay). This copies each render into a flat,
// human-friendly deliverable folder matching the original convention:
//   ~/Downloads/static-factory-b1/exports/<Batch name>/<File Name>-<VARIATION>[-vN].png
// e.g. exports/Batch 1/5_Broad_a-Back_UGLY-A.png  (and ...-A-v2.png for later versions).
// Copies only (never moves/deletes), so re-running is safe and the renders stay put.
import { readFileSync, mkdirSync, copyFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

const HOME = process.env.HOME;
const RENDERS = join(HOME, 'Downloads', 'static-factory-b1', 'renders', 'nanox');
const EXPORTS = join(HOME, 'Downloads', 'static-factory-b1', 'exports');
const cfg = JSON.parse(readFileSync(join(dirname(new URL(import.meta.url).pathname), 'config.json'), 'utf8'));
const nx = cfg.brands.find((b) => b.id === 'nanox');

// (batchCode, adId) -> { title, batchName }
const meta = {};
for (const ba of nx.batches) for (const a of ba.ads) meta[`${ba.code}/${a.id}`] = { title: a.title || a.id, batchName: ba.name || ba.code };

function walk(dir) { // yield every run-*.png under dir
  const out = [];
  const rec = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) rec(p); else if (/^run-\d+(-v\d+)?\.png$/i.test(e.name)) out.push(p); } };
  if (existsSync(dir)) rec(dir);
  return out;
}

let copied = 0, skipped = 0;
for (const batchCode of (existsSync(RENDERS) ? readdirSync(RENDERS) : [])) {
  const adsDir = join(RENDERS, batchCode, 'ads');
  for (const path of walk(adsDir)) {
    // path tail: <AD>/<VAR>/<prompt>/run-N[-vN].png
    const rel = path.slice(adsDir.length + 1).split('/');
    if (rel.length < 4) continue;
    const [adId, variation, , fname] = rel;
    const m = /^run-\d+(?:-v(\d+))?\.png$/i.exec(fname);
    if (!m) continue;
    const info = meta[`${batchCode}/${adId}`];
    if (!info) { skipped++; continue; }
    const ver = m[1] ? `-v${m[1]}` : '';
    const name = `${info.title}-${variation}${ver}.png`;
    const dst = join(EXPORTS, info.batchName, name);
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(path, dst);
    copied++;
  }
}
console.log(`[codexexport] copied ${copied} friendly-named files${skipped ? `, skipped ${skipped} (no config match)` : ''} -> ${EXPORTS}`);
