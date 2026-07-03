// run-inspo-round.mjs <roundNum> — generate N ads from random IMAGE AD INSPO refs.
import { readdirSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDesignAgent } from './lib/design-agent.mjs';
import { describeImage } from './lib/layout-extract.mjs';
import { saveDesign } from './lib/designstore.mjs';
import { lintDesign } from './lib/design-lint.mjs';

const STUDIO = dirname(fileURLToPath(import.meta.url));
const INSPO = '/Users/michael/Downloads/IMAGE AD INSPO';
const REFS = join(STUDIO, '.state', 'refs');
mkdirSync(REFS, { recursive: true });
const N = Number(process.argv[3] || 3);
const round = process.argv[2] || '1';
// deterministic-but-varied pick: hash the round + index into the sorted file list
const files = readdirSync(INSPO).filter(f => /\.(png|jpe?g|webp)$/i.test(f)).sort();
const seed = [...`round-${round}-${Date.now()}`].reduce((a,c)=>a*31+c.charCodeAt(0)>>>0, 7);
const picks = [];
for (let i=0;i<N;i++) picks.push(files[(seed + i*97) % files.length]);

const results = [];
for (const f of picks) {
  const id = `inspo-${f.replace(/\.[^.]+$/,'').replace(/[^\w-]+/g,'-')}`.slice(0,54);
  const src = join(INSPO, f);
  const pngRef = join(REFS, `${id}.png`);
  // convert/copy to png + read dimensions via sips
  try { execFileSync('sips', ['-s','format','png', src, '--out', pngRef], { stdio: 'ignore' }); }
  catch { copyFileSync(src, pngRef); }
  let w=1080,h=1350;
  try {
    const out = execFileSync('sips', ['-g','pixelWidth','-g','pixelHeight', pngRef], {encoding:'utf8'});
    w = Number(out.match(/pixelWidth:\s*(\d+)/)?.[1]||1080);
    h = Number(out.match(/pixelHeight:\s*(\d+)/)?.[1]||1350);
  } catch {}
  // normalize to 1080-wide canvas
  const cw = 1080, ch = Math.round(1080 * h / w);
  const desc = await describeImage(pngRef, { cacheId: id });
  const brief = desc.ok ? desc.text : `ad inspired by ${f}`;
  const docId = `gen-r${round}-${id}`.slice(0,60);
  // Neutral gradient base — the inspo images are FINISHED ads whose baked-in text double-stacks
  // with the harness output. Using a clean base means 100% of the render is harness composition
  // (headline/subhead/cta/badges/layout), judged fairly. The inspo drives the brief only.
  const doc = {
    id: docId, name: `Round ${round} · ${f.slice(0,20)}`, canvas: { w: cw, h: ch },
    createdAt: Date.now(), updatedAt: Date.now(), schemaVersion: 3,
    layers: [ { id:'base-1', type:'shape', role:'base', name:'Base', box:{x:0,y:0,w:cw,h:ch},
      style:{ background:'#151527', gradient:'to-bottom' } } ],
  };
  const t0 = Date.now();
  let r;
  try { r = await runDesignAgent(doc, 'Generate a complete production-ready ad from the brief: headline, supporting copy, a CTA, and any offer badge. Compose on the grid with strong hierarchy and contrast.', ()=>{}, { mode:'generate', brief, noCodex:true }); }
  catch(e){ results.push({ f, error:String(e.message||e) }); continue; }
  const saved = saveDesign(r.doc);
  const lint = lintDesign(r.doc);
  const tok = (r.usage.inTok||0)+(r.usage.outTok||0);
  results.push({ f, docId: saved.id, canvas:`${cw}x${ch}`, source:r.source, applied:r.applied, turns:r.totals.turns,
    layout:r.layoutScore, lint:lint.length, verify:r.verify?.ready, tok, ms:Date.now()-t0,
    brief: brief.slice(0,90) });
}
console.log(JSON.stringify(results, null, 2));
