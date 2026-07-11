#!/usr/bin/env node
// scripts/copy-batch.mjs — run the copy pipeline on one or more ads, render the DesignDoc, and
// export a side-by-side (source | render) into ~/Downloads/copy-engine-out/<id>.sidebyside.png.
//
// Usage:
//   node scripts/copy-batch.mjs <imageOrDir> [--ids 004,016] [--out ~/Downloads/copy-engine-out]
//
// Per ad prints: timing · layer count · keptInPhoto count · scorecard composite + hardFails.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, copyFileSync, statSync } from 'node:fs';
import { join, basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';

import { runCopyPipeline } from '../lib/copy-pipeline.mjs';
import { renderCompPng } from '../lib/self-vision.mjs';
import { makeImageResolver } from '../lib/designstore.mjs';
import { scoreCopy } from './scorecard.mjs';

const STUDIO = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = join(STUDIO, '..');
const RENDERS = join(STUDIO, '.state', 'renders');

function adId(name) { return basename(name).split('_')[0]; }

/** Build a source | render side-by-side PNG via headless Chrome (same approach as copy-harness). */
function buildSideBySide(refPng, renderPng, outPath) {
  try {
    const refB64 = readFileSync(refPng).toString('base64');
    const renderB64 = readFileSync(renderPng).toString('base64');
    const html = `<!doctype html><html><head><meta charset="utf-8"></head>
<body style="margin:0;background:#222;display:flex;align-items:flex-start">
<img src="data:image/png;base64,${refB64}" style="max-width:540px;max-height:900px;object-fit:contain;border-right:2px solid red">
<img src="data:image/png;base64,${renderB64}" style="max-width:540px;max-height:900px;object-fit:contain">
</body></html>`;
    const tmpHtml = outPath.replace(/\.png$/, '.html');
    writeFileSync(tmpHtml, html);
    const chrome = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ].find((p) => existsSync(p));
    if (!chrome) return false;
    const r = spawnSync(chrome, [
      '--headless', '--disable-gpu', `--screenshot=${outPath}`,
      '--window-size=1100,950', '--force-device-scale-factor=2',
      '--hide-scrollbars', '--no-sandbox', `file://${tmpHtml}`,
    ], { timeout: 25_000 });
    return r.status === 0 && existsSync(outPath);
  } catch { return false; }
}

function countLeaves(layers) {
  let n = 0;
  for (const l of (Array.isArray(layers) ? layers : [])) {
    if (!l) continue;
    if (l.type === 'group' && Array.isArray(l.children)) n += countLeaves(l.children);
    else n++;
  }
  return n;
}

function collectTargets(input, ids) {
  const p = resolve(input.replace(/^~/, homedir()));
  let files = [];
  if (existsSync(p) && statSync(p).isDirectory()) {
    files = readdirSync(p).filter((f) => /\.(png|webp|jpe?g)$/i.test(f)).map((f) => join(p, f));
  } else if (existsSync(p)) {
    files = [p];
  }
  if (ids && ids.length) files = files.filter((f) => ids.includes(adId(f)));
  return files.sort();
}

async function main() {
  const args = process.argv.slice(2);
  const input = args.find((a) => !a.startsWith('--')) || join(homedir(), 'Downloads', 'IMAGE AD INSPO');
  const idsIdx = args.indexOf('--ids');
  const ids = idsIdx >= 0 ? String(args[idsIdx + 1] || '').split(',').map((s) => s.trim()).filter(Boolean) : null;
  const outIdx = args.indexOf('--out');
  const outDir = resolve((outIdx >= 0 ? args[outIdx + 1] : join(homedir(), 'Downloads', 'copy-engine-out')).replace(/^~/, homedir()));

  mkdirSync(outDir, { recursive: true });
  mkdirSync(RENDERS, { recursive: true });
  const targets = collectTargets(input, ids);
  if (!targets.length) { console.error(`no images found for ${input}${ids ? ` ids=${ids}` : ''}`); process.exit(1); }

  const resolveImage = makeImageResolver({ renders: RENDERS, repo: REPO, ttImagePath: () => null });
  console.log(`\n=== copy-batch — ${targets.length} ad(s) → ${outDir} ===\n`);
  const rows = [];

  for (const src of targets) {
    const id = adId(src);
    process.stdout.write(`  ${id} ${basename(src)} ... `);
    const t0 = Date.now();
    const row = { id, ms: null, layers: null, kept: null, composite: null, hardFails: [], error: null, sbs: null };
    try {
      const { ok, doc, keptInPhoto, error } = await runCopyPipeline(src);
      if (!ok) throw new Error(error || 'pipeline not ok');
      row.layers = countLeaves(doc.layers);
      row.kept = keptInPhoto.length;

      const renderPath = renderCompPng(doc, { resolveImage, size: 1000 });
      const renderOut = join(outDir, `${id}.render.png`);
      copyFileSync(renderPath, renderOut);

      const sbs = join(outDir, `${id}.sidebyside.png`);
      if (buildSideBySide(src, renderOut, sbs)) row.sbs = sbs;

      // 016 assertion (defect D6): 'grüns' must be keptInPhoto AND appear exactly once in the
      // render (baked in the photo/cutout, never doubled by an overlay layer).
      if (id === '016') {
        try {
          const norm = (s) => String(s || '').toLowerCase().replace(/ü/g, 'u');
          const keptOk = keptInPhoto.some((k) => norm(k).includes('gruns'));
          const { recognizeText } = await import('../lib/ocr.mjs');
          const renOcr = await recognizeText(renderOut, { cache: false });
          const hits = (renOcr?.lines || []).filter((l) => norm(l.text).includes('gruns')).length;
          row.grunsAssert = keptOk && hits === 1 ? 'ok' : `FAIL kept=${keptOk} renderHits=${hits}`;
          console.log(`\n    016 grüns assert: ${row.grunsAssert}`);
          process.stdout.write('    ');
        } catch (e) { row.grunsAssert = `error: ${e.message}`; }
      }

      try {
        const sc = await scoreCopy({ sourcePath: src, renderPath: renderOut, doc, keptInPhoto });
        row.composite = sc.composite;
        row.hardFails = (sc.hardFails || []).map((f) => f.rule);
      } catch (e) { row.error = `score: ${e.message}`; }

      row.ms = Date.now() - t0;
      row.keptTexts = keptInPhoto.slice(0, 30);
      console.log(`ok  ${(row.ms / 1000).toFixed(1)}s  layers=${row.layers}  kept=${row.kept}  composite=${row.composite ?? 'n/a'}${row.hardFails.length ? ` HARDFAIL:${row.hardFails.join('+')}` : ''}${row.grunsAssert ? `  grüns=${row.grunsAssert}` : ''}`);
    } catch (e) {
      row.error = e.message;
      row.ms = Date.now() - t0;
      console.log(`FAIL (${e.message})`);
    }
    rows.push(row);
  }

  writeFileSync(join(outDir, 'batch-report.json'), JSON.stringify({ at: new Date().toISOString(), rows }, null, 2));
  console.log(`\n  id    ms      layers  kept  composite  hardFails               sidebyside`);
  for (const r of rows) {
    console.log(`  ${r.id.padEnd(5)} ${String(r.ms ?? '—').padEnd(7)} ${String(r.layers ?? '—').padEnd(7)} ${String(r.kept ?? '—').padEnd(5)} ${String(r.composite ?? '—').padEnd(10)} ${(r.hardFails.join('+') || (r.error ? `ERR:${r.error}` : '-')).padEnd(23)} ${r.sbs ? basename(r.sbs) : '-'}`);
  }
  console.log(`\n  wrote ${join(outDir, 'batch-report.json')}\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
