#!/usr/bin/env node
// Re-push every on-disk codex render to the bridge /codex-result endpoint, so the extension's
// background ingest (which polls /codex-results every ~3s) persists + live-renders them in the panel.
// WHY: each time the bridge restarts it loses its in-memory relay buffer, so images relayed in a
// previous session never reach the panel. The PNGs are safe on disk — this just re-feeds them.
// Idempotent: the panel keys previews by relPath, latest version wins. Safe to run anytime.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const RENDERS = join(process.env.HOME, 'Downloads', 'static-factory-b1', 'renders');
const BRIDGE = 'http://localhost:8787';

function walk(dir) {
  let out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out = out.concat(walk(p));
    else if (/^run-\d+(-v\d+)?\.png$/i.test(e.name)) out.push(p);
  }
  return out;
}

const ver = (f) => { const m = /-v(\d+)\.png$/i.exec(f); return m ? Number(m[1]) : 1; };
const files = walk(join(RENDERS, 'nanox')).sort((a, b) => ver(a) - ver(b)); // v1 first so latest wins
let ok = 0, fail = 0;
for (const f of files) {
  const relPath = f.slice(RENDERS.length + 1).split('\\').join('/');
  try {
    const dataUrl = 'data:image/png;base64,' + readFileSync(f).toString('base64');
    const r = await fetch(`${BRIDGE}/codex-result`, { method: 'POST', body: JSON.stringify({ name: relPath.replace(/\//g, '_'), relPath, dataUrl }) });
    r.ok ? ok++ : fail++;
  } catch { fail++; }
}
console.log(`[resync] pushed ${ok} renders to ${BRIDGE}/codex-result${fail ? `, ${fail} failed` : ''}. Extension drains /codex-results every ~3s — reload the side panel if tiles don't fill in.`);
