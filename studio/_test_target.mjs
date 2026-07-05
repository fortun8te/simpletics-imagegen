import { runDesignAgent } from './lib/design-agent.mjs';
import { readFileSync } from 'node:fs';
const doc = JSON.parse(readFileSync('./.state/designs/comp_stress120.json','utf8'));
let opFrames=[], withBox=0;
const onStep=(ev)=>{
  if(ev?.step?.kind==='op'){
    const d=ev.step.data||{};
    opFrames.push({summary:(ev.step.summary||'').slice(0,40), targetId:d.targetId, targetBox:d.targetBox});
    if(d.targetBox) withBox++;
  }
};
try{
  const r = await runDesignAgent(doc, 'move the Headline down by 40 pixels', onStep, {});
  console.log('applied:', r.applied, 'source:', r.source);
  console.log('op frames:', opFrames.length, 'withTargetBox:', withBox);
  console.log(JSON.stringify(opFrames.slice(0,6),null,1));
}catch(e){ console.log('ERR', e.message, e.stack?.split('\n')[1]); }
process.exit(0);
