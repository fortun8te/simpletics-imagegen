#!/usr/bin/env node
// audit-elements.mjs — build every element at default params on square + portrait canvases and
// flag any textual layer whose box can't fit its default text (server-side wrap estimate).
// Read-only. Run: node scripts/audit-elements.mjs

import { ELEMENTS, buildElement } from '../lib/elements.mjs';
import { estimateTextBoxH, isTextual } from '../lib/type-scale.mjs';

const CANVASES = [{ w: 1080, h: 1080 }, { w: 1080, h: 1350 }];

// Known by-design "clipping": marquee is a horizontally-overflowing strip; echo rows and the
// stat value are single lines of caps at lineHeight 1 where the estimator's 1.2× line box
// overestimates. Verified visually 2026-07 — remove from this list if their builders change.
const BY_DESIGN = new Set(['marquee', 'echo', 'stat-card']);
let flags = 0;

for (const canvas of CANVASES) {
  const doc = { id: 'audit', canvas, layers: [] };
  for (const def of ELEMENTS) {
    if (BY_DESIGN.has(def.id)) continue;
    const [inst] = buildElement(def.id, doc);
    if (!inst) continue;
    const leaves = inst.type === 'group' ? inst.children : [inst];
    for (const l of leaves || []) {
      if (!isTextual(l) || !l.text) continue;
      const need = estimateTextBoxH(l);
      const have = l.box?.h || 0;
      // autoH layers self-grow on insert/commit — only flag gross mismatch (default box lies
      // by >2×). Fixed-height layers (autoH:false) get the strict 8% threshold.
      const threshold = l.autoH === false ? 1.08 : 2.0;
      if (need > have * threshold) {
        flags++;
        console.log(`CLIP ${def.id} @${canvas.w}x${canvas.h} · "${l.name || l.role}" needs ${need}px, has ${have}px${l.autoH === false ? ' (FIXED)' : ' (autoH default lies >2×)'} (${l.style?.fontSize}px "${String(l.text).slice(0, 28)}…")`);
      }
    }
  }
}

console.log(flags ? `\n${flags} clipping risk(s) found` : 'all elements fit their default text');
process.exit(flags ? 1 : 0);
