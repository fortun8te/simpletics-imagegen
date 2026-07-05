// test/template-element-clip.test.mjs — deterministic NO-CLIP audit for every template + element.
//
// Owner mandate (copy-fidelity marathon): "presets are bad… clipping even in the preset" and
// "some elements are also bad". This test builds EVERY template and EVERY element at multiple
// canvas sizes with DEFAULT params and asserts, using the same text-measurement utilities the
// builders themselves use (intrinsicTextW / estimateTextBoxH — lib/elements.mjs, lib/type-scale.mjs):
//   1. no text leaf's intrinsic longest-line width exceeds its box width (horizontal clip),
//   2. no text leaf's wrap-aware needed height exceeds its box height (vertical clip),
//   3. no leaf's box escapes the canvas (canvas clip).
// autoH:false artifacts (marquee strips, echo rows) are exempt from #2 — their clipping is the
// design (same exemption fitElementText applies). A small slack absorbs sub-pixel rounding.
//
// Run: node --test test/template-element-clip.test.mjs

import { test } from 'node:test';
import assert from 'node:assert';
import { TEMPLATES, buildTemplate } from '../lib/templates.mjs';
import { ELEMENTS, buildElement, intrinsicTextW } from '../lib/elements.mjs';
import { estimateTextBoxH } from '../lib/type-scale.mjs';
import { walkNodes } from '../lib/scene-tree.mjs';

const CANVASES = [
  { w: 1080, h: 1080, name: '1:1' },
  { w: 1080, h: 1350, name: '4:5' },
  { w: 1080, h: 1920, name: '9:16' },
];

const SLACK_W = 6;   // px slack for rounding differences between builder + audit
const SLACK_H = 4;
const CANVAS_SLACK = 2; // deliberate tiny bleed tolerance

/** Audit one built layer tree. Returns array of violation strings (empty = clean). */
function auditLayers(layers, canvas, label) {
  const violations = [];
  walkNodes(layers, (l) => {
    if (!l || l.type === 'group' || !l.box) return;
    const { x, y, w, h } = l.box;
    const name = `${label} · ${l.name || l.role || l.type}`;

    // canvas containment (any leaf type). Full-bleed backgrounds may deliberately cover
    // the canvas exactly; only flag ESCAPES beyond slack.
    if (x < -CANVAS_SLACK || y < -CANVAS_SLACK ||
        x + w > canvas.w + CANVAS_SLACK || y + h > canvas.h + CANVAS_SLACK) {
      // vignettes/scrims/backgrounds legitimately bleed a little; shapes used as decor
      // (blob/wave/starburst) also overshoot by design. Only text-bearing leaves are hard errors.
      if (l.type === 'text' || l.type === 'badge' || l.type === 'button') {
        violations.push(`${name}: text box escapes canvas (box ${x},${y} ${w}×${h} vs ${canvas.w}×${canvas.h})`);
      }
    }

    // text measurement fit
    if ((l.type === 'text' || l.type === 'badge' || l.type === 'button') && l.text) {
      const iw = intrinsicTextW(l);
      // Multi-line-capable boxes wrap: horizontal clip only matters when wrapping can't save it —
      // i.e. a single WORD (no break opportunity) wider than the box, or nowrap-ish pills.
      const longestWord = String(l.text).split(/\s+/).reduce((best, word) => {
        const wpx = intrinsicTextW({ ...l, text: word });
        return Math.max(best, wpx);
      }, 0);
      if (longestWord > w + SLACK_W) {
        violations.push(`${name}: word wider than box (${longestWord}px word vs ${w}px box) — will clip horizontally`);
      }
      if (l.autoH !== false) {
        const need = estimateTextBoxH(l);
        if (need > h + SLACK_H) {
          violations.push(`${name}: needs ${need}px height, box is ${h}px — will clip vertically`);
        }
      }
    }
  });
  return violations;
}

test('every TEMPLATE builds without text clipping at 3 canvas sizes', () => {
  const allViolations = [];
  for (const tpl of TEMPLATES) {
    for (const canvas of CANVASES) {
      const doc = { id: 'clip-test', canvas: { w: canvas.w, h: canvas.h }, layers: [] };
      let built;
      try {
        built = buildTemplate(tpl.id, doc, {});
      } catch (e) {
        allViolations.push(`${tpl.id}@${canvas.name}: buildTemplate THREW: ${e.message}`);
        continue;
      }
      const layers = built?.layers || built || [];
      if (!Array.isArray(layers) || !layers.length) {
        allViolations.push(`${tpl.id}@${canvas.name}: built no layers`);
        continue;
      }
      allViolations.push(...auditLayers(layers, canvas, `${tpl.id}@${canvas.name}`));
    }
  }
  assert.deepStrictEqual(allViolations, [], `template clip violations:\n  ${allViolations.join('\n  ')}`);
});

// Copy-mode reality: extracted reference text is often LONGER than the demo defaults. Stress
// every string param with realistic long copy and re-audit. Colors/enums/urls are left alone
// (heuristic: only stretch params whose default already looks like prose — has a space or is
// ≥12 chars — so 'light', '#fff', 'left' style knobs are untouched).
const LONG_TEXT = 'This Is A Much Longer Headline That Real Extracted Ad Copy Produces In Practice';
function stressParams(defaults) {
  const out = {};
  for (const [k, v] of Object.entries(defaults || {})) {
    if (typeof v === 'string' && (v.includes(' ') || v.length >= 12)) out[k] = LONG_TEXT;
    else if (Array.isArray(v) && v.every((x) => typeof x === 'string')) {
      out[k] = v.map((x) => (x.includes(' ') || x.length >= 12 ? LONG_TEXT : x));
    } else out[k] = v;
  }
  return out;
}

test('every TEMPLATE survives LONG copy without text clipping', () => {
  const allViolations = [];
  for (const tpl of TEMPLATES) {
    for (const canvas of CANVASES) {
      const doc = { id: 'clip-test', canvas: { w: canvas.w, h: canvas.h }, layers: [] };
      let built;
      try {
        built = buildTemplate(tpl.id, doc, stressParams(tpl.params));
      } catch (e) {
        allViolations.push(`${tpl.id}@${canvas.name}: buildTemplate THREW on long copy: ${e.message}`);
        continue;
      }
      const layers = built?.layers || built || [];
      if (!Array.isArray(layers) || !layers.length) continue;
      allViolations.push(...auditLayers(layers, canvas, `${tpl.id}@${canvas.name}[long]`));
    }
  }
  assert.deepStrictEqual(allViolations, [], `template LONG-copy clip violations:\n  ${allViolations.join('\n  ')}`);
});

test('every ELEMENT survives LONG copy without text clipping', () => {
  const allViolations = [];
  const canvas = { w: 1080, h: 1350, name: '4:5' };
  for (const def of ELEMENTS) {
    const doc = { id: 'clip-test', canvas: { w: canvas.w, h: canvas.h }, layers: [] };
    // elements declare typed params — stress every text/stringList param with long copy
    const stress = {};
    for (const p of (def.params || [])) {
      if (p.type === 'text') stress[p.key] = LONG_TEXT;
      else if (p.type === 'stringList' && Array.isArray(p.default)) stress[p.key] = p.default.map(() => LONG_TEXT.slice(0, 40));
    }
    if (!Object.keys(stress).length) continue;
    let built;
    try {
      built = buildElement(def.id, doc, stress);
    } catch (e) {
      allViolations.push(`${def.id}: buildElement THREW on long copy: ${e.message}`);
      continue;
    }
    const layers = Array.isArray(built) ? built : (built?.layers || []);
    if (!Array.isArray(layers) || !layers.length) continue;
    allViolations.push(...auditLayers(layers, canvas, `${def.id}[long]`));
  }
  assert.deepStrictEqual(allViolations, [], `element LONG-copy clip violations:\n  ${allViolations.join('\n  ')}`);
});

test('every ELEMENT builds without text clipping at default params', () => {
  const allViolations = [];
  const canvas = { w: 1080, h: 1350, name: '4:5' };
  for (const def of ELEMENTS) {
    const doc = { id: 'clip-test', canvas: { w: canvas.w, h: canvas.h }, layers: [] };
    let built;
    try {
      built = buildElement(def.id, doc, undefined);
    } catch (e) {
      allViolations.push(`${def.id}: buildElement THREW: ${e.message}`);
      continue;
    }
    const layers = Array.isArray(built) ? built : (built?.layers || []);
    if (!Array.isArray(layers) || !layers.length) {
      allViolations.push(`${def.id}: built no layers`);
      continue;
    }
    allViolations.push(...auditLayers(layers, canvas, def.id));
  }
  assert.deepStrictEqual(allViolations, [], `element clip violations:\n  ${allViolations.join('\n  ')}`);
});
