// one-time: measure Inter advance widths (per char, per weight) via headless Chrome canvas.
import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fontFaceStyleTag } from '../../lib/font-faces.mjs';

const chars = [];
for (let c = 32; c < 127; c++) chars.push(String.fromCharCode(c));
for (const c of ['€', '’', '‘', '“', '”', '–', '—', '…', 'ü', 'é', 'ä', 'ö', 'ß', '•', '·', '×', '│', '¦']) chars.push(c);

const html = `<!doctype html><html><head><meta charset="utf-8">${fontFaceStyleTag()}</head><body>
<div id="out" style="white-space:pre;font-size:10px"></div>
<script>
async function go() {
  const weights = [400, 500, 600, 700, 800];
  const chars = ${JSON.stringify(chars)};
  await Promise.all(weights.map((w) => document.fonts.load(w + ' 100px Inter')));
  const ctx = document.createElement('canvas').getContext('2d');
  const table = {};
  for (const w of weights) {
    ctx.font = w + " 100px 'Inter','Helvetica Neue',Arial,sans-serif";
    const row = {};
    for (const ch of chars) row[ch] = Math.round(ctx.measureText(ch).width * 100) / 100;
    // pair-kern probe: average difference between joint and sum widths on a sample
    const sample = 'AVATAWAYoToTr.,';
    let joint = ctx.measureText(sample).width, sum = 0;
    for (const ch of sample) sum += row[ch];
    row['__kernAdj'] = Math.round((joint - sum) / (sample.length - 1) * 100) / 100;
    table[w] = row;
  }
  document.getElementById('out').textContent = 'WIDTHS' + JSON.stringify(table) + 'END';
}
go();
</script></body></html>`;
writeFileSync('/tmp/measure-inter.html', html);
const r = spawnSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ['--headless', '--disable-gpu', '--no-sandbox', '--virtual-time-budget=4000', '--dump-dom', 'file:///tmp/measure-inter.html'],
  { timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
const out = String(r.stdout || '');
const m = out.match(/WIDTHS(\{.*\})END/s);
if (!m) { console.error('no widths in dump'); process.exit(1); }
writeFileSync(new URL('./inter-widths.json', import.meta.url).pathname, m[1]);
console.log('ok, sample W700:', JSON.parse(m[1])['700']['A'], JSON.parse(m[1])['700']['i'], 'kern', JSON.parse(m[1])['700']['__kernAdj']);
