// test/elements-v2.test.mjs — the v2 element engine contract:
//   1. FIT: every measurable text leaf's box fits its content (boxes are measurement OUTPUT)
//      across default / long-text / many-items params and three canvas aspects.
//   2. IDEMPOTENT: rebuilding with identical params yields identical geometry.
//   3. SINGLE EDIT PATH: applyElementTextEdit routes an element child's text edit through its
//      param → clean rebuild (text updated, box re-hugged, no stale styles).
// Run: node --test test/elements-v2.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ELEMENTS, buildElement, applyElementTextEdit, intrinsicTextW,
} from '../lib/elements.mjs';
import { estimateTextBoxH } from '../lib/type-scale.mjs';
import { walkNodes } from '../lib/scene-tree.mjs';

const CANVASES = [
  { w: 1080, h: 1080 },
  { w: 1080, h: 1350 },
  { w: 1080, h: 1920 },
];

const LONG = 'This is a deliberately long piece of ad copy that should wrap across several lines without ever clipping outside its measured box, no matter the canvas';

const textLeaves = (inst) => {
  const out = [];
  walkNodes([inst], (l) => {
    if (l.type === 'group' || !l.box) return;
    if ((l.type === 'text' || l.type === 'badge' || l.type === 'button') && l.text && l.autoH !== false) out.push(l);
  });
  return out;
};

/** Param variants per def: default, long first text param, maxed stringLists. */
function variants(def) {
  const out = [{ name: 'default', params: {} }];
  const firstText = (def.params || []).find((p) => p.type === 'text' && p.key !== 'code' && p.key !== 'time');
  if (firstText) out.push({ name: 'long-text', params: { [firstText.key]: LONG.slice(0, firstText.maxLen || 400) } });
  const list = (def.params || []).find((p) => p.type === 'stringList');
  if (list) {
    out.push({
      name: 'many-items',
      params: { [list.key]: Array.from({ length: list.maxItems || 8 }, (_, i) => `Benefit line number ${i + 1} with words`) },
    });
  }
  return out;
}

test('FIT: every text leaf box fits its content across params × aspects', () => {
  const failures = [];
  for (const canvas of CANVASES) {
    const doc = { id: 't', canvas, layers: [] };
    for (const def of ELEMENTS) {
      for (const v of variants(def)) {
        const [inst] = buildElement(def.id, doc, v.params);
        if (!inst) continue;
        for (const l of textLeaves(inst)) {
          const needH = estimateTextBoxH(l);
          const needW = intrinsicTextW(l);
          if (needH > l.box.h * 1.08) failures.push(`${def.id}/${v.name}@${canvas.w}x${canvas.h} "${l.name}" H ${l.box.h} < ${needH}`);
          // width only clips when the text CAN'T wrap into the box (single word wider than box)
          const longestWord = Math.max(...String(l.text).split(/\s+/).map((w) => w.length));
          const wordW = needW * (longestWord / Math.max(1, ...String(l.text).split('\n').map((t) => t.length)));
          if (wordW > l.box.w * 1.15) failures.push(`${def.id}/${v.name}@${canvas.w}x${canvas.h} "${l.name}" W ${l.box.w} < word ${Math.ceil(wordW)}`);
        }
      }
    }
  }
  assert.deepEqual(failures, []);
});

test('IDEMPOTENT: identical params → identical geometry', () => {
  const doc = { id: 't', canvas: { w: 1080, h: 1350 }, layers: [] };
  for (const def of ELEMENTS) {
    const [a] = buildElement(def.id, doc, {});
    const [b] = buildElement(def.id, doc, {});
    if (!a || !b) continue;
    const boxesOf = (inst) => {
      const boxes = [];
      walkNodes([inst], (l) => { if (l.box) boxes.push(`${l.box.x},${l.box.y},${l.box.w},${l.box.h}`); });
      return boxes;
    };
    assert.deepEqual(boxesOf(a), boxesOf(b), `${def.id} rebuild geometry stable`);
  }
});

test('SINGLE EDIT PATH: element child text edit rebuilds via param, no stale styles', () => {
  const doc = { id: 't', canvas: { w: 1080, h: 1350 }, layers: [] };
  const [inst] = buildElement('ig-caption', doc, { text: 'Why my hair finally holds all day:' });
  doc.layers.push(inst);
  const leaf = textLeaves(inst)[0];
  assert.ok(leaf.paramRef, 'text leaf carries a paramRef');
  const beforeW = leaf.box.w;
  const r = applyElementTextEdit(doc, leaf.id, 'Short.');
  assert.match(r, /rebuilt/);
  const fresh = doc.layers[0];
  assert.equal(fresh.id, inst.id, 'instance identity preserved');
  const freshLeaf = textLeaves(fresh)[0];
  assert.equal(freshLeaf.text, 'Short.');
  assert.ok(freshLeaf.box.w < beforeW, `box re-hugged shorter text (${freshLeaf.box.w} < ${beforeW})`);
  assert.equal(fresh.element.params.text, 'Short.', 'param updated');
  // preset toggle leaves no stale chrome: minimal preset must drop the pill background
  const r2 = buildElement('ig-caption', doc, { text: 'x', preset: 'minimal' })[0];
  const minimalLeaf = textLeaves(r2)[0];
  assert.ok(!minimalLeaf.style.background, 'minimal preset has no background residue');
  assert.ok(!minimalLeaf.style.pill, 'minimal preset has no pill residue');
});

test('handwritten note hugs its words (the reported glitch)', () => {
  const doc = { id: 't', canvas: { w: 1080, h: 1350 }, layers: [] };
  const [inst] = buildElement('handwritten', doc, { text: 'this one actually works →' });
  const leaf = textLeaves(inst)[0];
  // built width used to be a fixed 80% of canvas (864px); v2 hugs the measured text
  assert.ok(leaf.box.w < 700, `handwritten box hugs text (got ${leaf.box.w}px)`);
});
