import { runDesignAgent } from '../lib/design-agent.mjs';
import { saveDesign } from '../lib/designstore.mjs';
const cases = [
  { id: 'tpl-xpost', canvas: { w: 1080, h: 1350 }, instr: 'Generate an X post testimonial ad for a matte hair clay — real-user voice.', brief: 'Simpletics matte clay: strong hold, zero grease, held all day in the rain' },
  { id: 'tpl-beforeafter', canvas: { w: 1080, h: 1080 }, instr: 'Generate a before and after ad for the curl cream.', brief: 'Wavy everyday curl creme — perfect curls without ruining your hair' },
  { id: 'tpl-comparison', canvas: { w: 1080, h: 1080 }, instr: 'Generate an us vs them comparison ad.', brief: 'NanoX arthritis cream vs typical menthol creams: real relief vs cold-only sensation' },
];
for (const c of cases) {
  const doc = { id: c.id, name: c.id, canvas: c.canvas, createdAt: Date.now(), updatedAt: Date.now(), schemaVersion: 3,
    layers: [{ id: 'base-1', type: 'shape', role: 'base', name: 'Base', box: { x: 0, y: 0, w: c.canvas.w, h: c.canvas.h }, style: { background: '#151527' } }] };
  const steps = [];
  const r = await runDesignAgent(doc, c.instr, (ev) => { if (ev.step?.summary) steps.push(ev.step.summary); }, { mode: 'generate', brief: c.brief, noCodex: true });
  saveDesign(r.doc);
  console.log(`\n━━ ${c.id}: layout=${r.layoutScore} lint=${(r.lint||[]).length} verify=${r.verify?.ready} tok=${(r.usage.inTok+r.usage.outTok)}`);
  for (const s of steps.slice(0, 6)) console.log('  ·', s.slice(0, 140));
}
