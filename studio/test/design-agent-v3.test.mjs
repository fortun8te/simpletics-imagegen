// test/design-agent-v3.test.mjs — harness smoke tests with an injected fake llmCall.
// Covers: batched multi-op turns (v5 loop), scoped observation shape, prose-wrapped/bare-op
// tolerance, per-turn token-estimate budget, per-op error feedback, and the contrast lint.
// Run: node --test test/design-agent-v3.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDesignAgent, observe, createAliasMap, applyOp } from '../lib/design-agent.mjs';
import { parseBatch } from '../lib/agent-harness.mjs';
import { lintDesign } from '../lib/design-lint.mjs';
import { verifyDesign } from '../lib/design-verify.mjs';
import { smartAdRepair, analyzeLayerContext } from '../lib/ad-context.mjs';

const mkDoc = () => ({
  id: 'test-doc',
  name: 'Test',
  canvas: { w: 1080, h: 1080 },
  createdAt: 1,
  updatedAt: 1,
  layers: [
    { id: 'base-1', type: 'image', role: 'base', name: 'Base', box: { x: 0, y: 0, w: 1080, h: 1080 }, src: '/img?path=x.png' },
    { id: 'head-1', type: 'text', role: 'headline', name: 'Headline', text: 'BIG SALE', box: { x: 80, y: 120, w: 700, h: 120 }, style: { fontSize: 84, fontWeight: 800, color: '#ffffff' } },
    { id: 'cap-1', type: 'text', role: 'caption', name: 'Caption', text: 'Now with more', box: { x: 80, y: 300, w: 500, h: 60 }, style: { fontSize: 36, color: '#ffffff' } },
    { id: 'cta-1', type: 'button', role: 'cta', name: 'CTA', text: 'SHOP NOW', box: { x: 80, y: 900, w: 320, h: 90 }, style: { fontSize: 34, background: '#2c5cff', color: '#ffffff' } },
  ],
});

test('scoped observation collapses out-of-scope nodes', () => {
  const doc = mkDoc();
  const aliases = createAliasMap();
  aliases.sync(doc);
  const obs = observe(doc, { aliases, focusRegion: { x: 0, y: 800, w: 1080, h: 280 } });
  assert.match(obs, /outside scope: \d+ nodes/);
  assert.match(obs, /cta/);            // in-region node stays full
  assert.doesNotMatch(obs, /headline/); // out-of-region node collapsed
  assert.ok(obs.length <= 1200 * 4, 'observation within token budget');
});

test('batched turn applies multiple ops, one global loop (no director)', async () => {
  const doc = mkDoc();
  const prompts = []; // { purpose, promptChars, systemChars, maxTokens }
  const replies = [
    JSON.stringify({
      plan: 'move headline down, then make the cta pop',
      ops: [
        { op: 'move', id: 'L2', x: 90, y: 180 },
        { op: 'setStyle', id: 'L4', style: { fontSize: 40 } },
      ],
      done: false,
    }),
    JSON.stringify({ plan: 'all requested edits are in', ops: [], done: true }),
  ];
  const fakeLlm = async (prompt, opts = {}) => {
    prompts.push({ purpose: opts.purpose, promptChars: prompt.length, systemChars: (opts.system || '').length, maxTokens: opts.maxTokens });
    const text = replies.length ? replies.shift() : JSON.stringify({ plan: 'done', ops: [], done: true });
    return { ok: true, text, error: null, usage: { inTok: 200, outTok: 60 } };
  };

  const longInstruction = 'Move the headline down a bit and make it pop more; then restyle the CTA button so it stands out; then tidy the caption spacing.';
  const steps = [];
  const r = await runDesignAgent(doc, longInstruction, (ev) => { if (ev.step) steps.push(ev.step); }, { llmCall: fakeLlm });

  assert.equal(r.source !== 'fallback', true);
  assert.ok(r.applied >= 2, `both batch ops applied (got ${r.applied})`);
  assert.equal(r.totals.parts, 1, 'ONE loop — no director/worker parts');
  assert.ok(r.totals.turns <= 3, `multi-part instruction finished in ≤3 turns (got ${r.totals.turns})`);
  assert.ok(r.totals.inTok > 0 && r.totals.outTok > 0, 'token totals tracked');
  assert.ok(steps.some((s) => /move headline down/.test(s.summary)), 'plan narrated');
  assert.ok(Array.isArray(r.lint), 'final lint report returned');
  assert.equal(prompts.some((p) => p.purpose === 'design-director'), false, 'no director call');
  for (const p of prompts) {
    assert.ok((p.promptChars + p.systemChars) / 4 <= 3000, `turn ≤3k est tokens (got ${Math.round((p.promptChars + p.systemChars) / 4)})`);
    assert.equal(p.maxTokens <= 3000, true, 'completion cap ≤3000 (reasoning headroom for deepseek-v4-flash)');
  }
});

test('prose-wrapped bare op is used silently (no retry burn)', async () => {
  const doc = mkDoc();
  let calls = 0;
  const fakeLlm = async () => {
    calls++;
    if (calls === 1) {
      return { ok: true, text: 'Sure! Here is the operation you asked for:\n```json\n{"op":"move","id":"L2","x":90,"y":540}\n```\nHope that helps!', error: null, usage: { inTok: 100, outTok: 60 } };
    }
    return { ok: true, text: '{"plan":"done","ops":[],"done":true}', error: null, usage: { inTok: 80, outTok: 10 } };
  };
  const r = await runDesignAgent(doc, 'move headline lower', () => {}, { llmCall: fakeLlm });
  assert.equal(r.applied, 1);
  assert.equal(calls, 2, 'exactly two model calls — the prose-wrapped bare op did not trigger a retry');
});

test('failed op in a batch reports per-op feedback and does not waste the turn', async () => {
  const doc = mkDoc();
  const seenPrompts = [];
  let calls = 0;
  const fakeLlm = async (prompt) => {
    calls++;
    seenPrompts.push(prompt);
    if (calls === 1) {
      return {
        ok: true,
        text: JSON.stringify({
          plan: 'move base (invalid) and headline (valid)',
          ops: [
            { op: 'move', id: 'base-1', x: 0, y: 100 },   // base is untouchable → explanatory error
            { op: 'move', id: 'L2', x: 90, y: 200 },       // valid
          ],
          done: false,
        }),
        error: null, usage: { inTok: 100, outTok: 40 },
      };
    }
    return { ok: true, text: '{"plan":"done","ops":[],"done":true}', error: null, usage: { inTok: 80, outTok: 10 } };
  };
  const r = await runDesignAgent(doc, 'shift things around', () => {}, { llmCall: fakeLlm });
  assert.equal(r.applied, 1, 'valid op applied despite invalid sibling');
  const turn2 = seenPrompts[1] || '';
  assert.match(turn2, /LAST TURN RESULTS:/);
  assert.match(turn2, /FAILED move: the base image cannot be moved/);
  assert.match(turn2, /ok: move/);
});

test('parseBatch tolerates fenced batches and bare ops', () => {
  const b1 = parseBatch('```json\n{"plan":"x","ops":[{"op":"move","id":"L1","x":1,"y":2}],"done":false}\n```');
  assert.equal(b1.error, null);
  assert.equal(b1.ops.length, 1);
  const b2 = parseBatch('{"op":"done","summary":"fin"}');
  assert.equal(b2.done, true);
  const b3 = parseBatch('no json here');
  assert.ok(b3.error);
});

test('observe includes type scale line', () => {
  const doc = mkDoc();
  const aliases = createAliasMap();
  aliases.sync(doc);
  const obs = observe(doc, { aliases });
  assert.match(obs, /scale@1080/);
  assert.match(obs, /hd=\d+/);
});

test('autolayout op repairs wrong font sizes deterministically', () => {
  const doc = mkDoc();
  doc.layers[1].style.fontSize = 22; // headline too small
  const r = applyOp(doc, { op: 'autolayout' });
  assert.ok(typeof r === 'string' && /headline.*fs/.test(r));
  assert.ok(doc.layers[1].style.fontSize >= 80);
});

test('generation mode seeds headline and cta deterministically', async () => {
  const doc = {
    id: 'gen-test',
    name: 'Gen',
    canvas: { w: 1080, h: 1350 },
    layers: [
      { id: 'base-1', type: 'image', role: 'base', box: { x: 0, y: 0, w: 1080, h: 1350 }, src: '/x' },
    ],
    createdAt: 1, updatedAt: 1,
  };
  const fakeLlm = async () => ({ ok: true, text: '{"plan":"copy reads well","ops":[],"done":true}', error: null, usage: { inTok: 50, outTok: 10 } });
  // "50% off" brief → detected offer-hero archetype (template scaffold, not the generic seed)
  const r = await runDesignAgent(doc, 'generate ad from brief', () => {}, {
    mode: 'generate', llmCall: fakeLlm, brief: 'Summer Sale — 50% off', bestOf: 1,
  });
  const collectRoles = (ns, out = []) => { for (const l of ns || []) { if (l.role && l.role !== 'base') out.push(l.role); if (l.children) collectRoles(l.children, out); } return out; };
  const roles = collectRoles(r.doc.layers);
  assert.ok(roles.includes('headline'), `offer-hero scaffolded a headline (got ${roles.join(',')})`);
  assert.ok(roles.includes('scrim'), `offer-hero scaffolded its scrim (got ${roles.join(',')})`);
  assert.equal(r.source, 'generate');
  assert.ok(r.verify);

  // archetype-free brief → classic headline/cta element seed
  const doc2 = JSON.parse(JSON.stringify(doc));
  doc2.layers = doc2.layers.filter((l) => l.role === 'base');
  const r2 = await runDesignAgent(doc2, 'generate ad from brief', () => {}, {
    mode: 'generate', llmCall: fakeLlm, brief: 'A calm skincare product for sensitive skin', bestOf: 1,
  });
  const roles2 = collectRoles(r2.doc.layers);
  assert.ok(roles2.includes('headline'), `headline seeded (got ${roles2.join(',')})`);
  assert.ok(roles2.includes('cta'), `cta seeded (got ${roles2.join(',')})`);
});

test('verifyDesign flags weak layout', () => {
  const doc = mkDoc();
  doc.layers[1].style.fontSize = 12;
  const v = verifyDesign(doc);
  assert.equal(typeof v.ready, 'boolean');
  assert.ok(v.layoutScore >= 0);
});

test('smartAdRepair adds pill on wide text over photo', () => {
  const doc = {
    id: 'ad-ctx',
    canvas: { w: 1080, h: 1350 },
    layers: [
      { id: 'base', type: 'image', role: 'base', box: { x: 0, y: 0, w: 1080, h: 1350 }, src: '/x' },
      {
        id: 'cap', type: 'text', role: 'caption', autoH: true,
        text: 'This is a very long caption that spans the entire width of the ad on top of the photo',
        box: { x: 40, y: 900, w: 1000, h: 80 },
        style: { fontSize: 22, color: '#ffffff' },
      },
    ],
  };
  const before = analyzeLayerContext(doc, doc.layers[1]);
  assert.equal(before.wideOnPhoto, true);
  const r = smartAdRepair(doc);
  assert.ok(r.summaries.length > 0);
  assert.ok(doc.layers[1].style.pill || doc.layers[1].style.background, 'pill/scrim added');
  assert.ok(doc.layers[1].box.w < 1000, 'box narrowed');
  assert.ok(doc.layers[1].style.fontSize >= 30, 'font floored');
});

test('smartAdRepair skips sizeLocked (element-built) and agent-styled layers', () => {
  const doc = {
    id: 'ad-ctx-2',
    canvas: { w: 1080, h: 1350 },
    layers: [
      { id: 'base', type: 'image', role: 'base', box: { x: 0, y: 0, w: 1080, h: 1350 }, src: '/x' },
      { id: 'el', type: 'text', role: 'caption', sizeLocked: true, autoH: true, text: 'marquee strip text that is full width by design and long', box: { x: 0, y: 1290, w: 1080, h: 48 }, style: { fontSize: 30, color: '#111111', background: '#d4af37' } },
      { id: 'styled', type: 'text', role: 'caption', autoH: true, text: 'agent removed my pill on purpose for a clean look here', box: { x: 40, y: 900, w: 1000, h: 80 }, style: { fontSize: 34, color: '#ffffff' } },
    ],
  };
  const r = smartAdRepair(doc, { excludeIds: new Set(['styled']) });
  assert.equal(doc.layers[1].box.w, 1080, 'sizeLocked width untouched');
  assert.equal(doc.layers[2].style.pill, undefined, 'agent-styled layer not re-pilled');
  assert.equal(r.summaries.length, 0);
});

test('improve mode: contrast lint catches white-on-white', async () => {
  const doc = mkDoc();
  doc.layers.splice(1, 0, { id: 'card-1', type: 'shape', role: 'card', name: 'Card', box: { x: 60, y: 100, w: 760, h: 300 }, style: { background: '#ffffff' } });
  const findings = lintDesign(doc, { colors: ['#2c5cff', '#111111'] });
  assert.ok(findings.some((f) => /contrast/.test(f)), `contrast finding present (got: ${findings.join(' | ')})`);

  let sawLintStep = false;
  const fakeLlm = async () => ({ ok: true, text: '{"plan":"fix contrast","ops":[{"op":"setStyle","id":"L2","style":{"color":"#111111"}}],"done":false}', error: null, usage: { inTok: 100, outTok: 20 } });
  const r = await runDesignAgent(doc, '', (ev) => { if (ev.step && /lint:/.test(ev.step.summary)) sawLintStep = true; }, { mode: 'improve', llmCall: fakeLlm });
  assert.ok(sawLintStep, 'lint step narrated');
  assert.ok(r.applied >= 1);
  assert.ok(Array.isArray(r.lint) && r.lint.length > 0, 'lint findings returned to the route');
});

test('order / duplicate / distribute ops', () => {
  const doc = mkDoc();
  // order: bring caption to front
  let r = applyOp(doc, { op: 'order', id: 'cap-1', to: 'front' });
  assert.match(r, /order .* front/);
  assert.equal(doc.layers[doc.layers.length - 1].id, 'cap-1');
  // order back stays above base
  r = applyOp(doc, { op: 'order', id: 'cap-1', to: 'back' });
  assert.equal(doc.layers[1].id, 'cap-1');
  assert.equal(doc.layers[0].role, 'base');
  // duplicate
  const before = doc.layers.length;
  r = applyOp(doc, { op: 'duplicate', id: 'cta-1' });
  assert.match(r, /duplicate/);
  assert.equal(doc.layers.length, before + 1);
  // distribute along y
  const ids = doc.layers.filter((l) => l.role !== 'base').slice(0, 3).map((l) => l.id);
  r = applyOp(doc, { op: 'distribute', ids, axis: 'y' });
  assert.match(r, /distribute .* along y/);
  // errors are explanatory
  assert.throws(() => applyOp(doc, { op: 'order', id: 'base-1', to: 'front' }), /base image/);
  assert.throws(() => applyOp(doc, { op: 'distribute', ids: ids.slice(0, 2), axis: 'y' }), /3\+/);
});

test('normalizeOp tolerates weak-model schema drift', () => {
  const a = parseBatch(JSON.stringify({ plan: 'x', ops: [{ operation: 'modify', id: 2, changes: { text: 'Hi' } }], done: false }));
  assert.equal(a.ops[0].op, 'setText');
  assert.equal(a.ops[0].id, 'L2');
  assert.equal(a.ops[0].text, 'Hi');
  const b = parseBatch(JSON.stringify({ plan: 'x', ops: [{ op: 'update', target: 5, style: { color: '#fff' } }], done: false }));
  assert.equal(b.ops[0].op, 'setStyle');
  assert.equal(b.ops[0].id, 'L5');
  const c = parseBatch(JSON.stringify({ op: 'change', id: '3', x: 10, y: 20 }));
  assert.equal(c.ops[0].op, 'move');
  assert.equal(c.ops[0].id, 'L3');
  // a well-formed op is untouched
  const d = parseBatch(JSON.stringify({ plan: '', ops: [{ op: 'setText', id: 'L2', text: 'ok' }], done: false }));
  assert.equal(d.ops[0].op, 'setText');
  assert.equal(d.ops[0].id, 'L2');
});

test('chit-chat gate: "yo" gets a chat reply, zero ops, doc untouched', async () => {
  const { isChitChat } = await import('../lib/design-agent.mjs');
  assert.equal(isChitChat('yo'), true);
  assert.equal(isChitChat('why did you change that?'), true);
  assert.equal(isChitChat('thanks'), true);
  assert.equal(isChitChat('move the headline lower'), false);
  assert.equal(isChitChat('can you make the cta bigger?'), false);
  const doc = mkDoc();
  const before = JSON.stringify(doc.layers);
  const fakeLlm = async () => ({ ok: true, text: 'Hey! Tell me what to tweak.', error: null, usage: { inTok: 20, outTok: 10 } });
  const r = await runDesignAgent(doc, 'yo', () => {}, { llmCall: fakeLlm });
  assert.equal(r.source, 'chat');
  assert.equal(r.applied, 0);
  assert.equal(JSON.stringify(doc.layers), before, 'doc untouched');
  assert.ok(r.steps.some((s) => /Tell me what to tweak/.test(s.summary)), 'chat reply surfaced');
});

test('keepCopy: reference-sourced docs lock setText/draftText', async () => {
  const doc = mkDoc();
  doc.skeletonId = 'skel_x';
  let sawLockError = false;
  const replies = [
    JSON.stringify({ plan: 'try to rewrite the headline', ops: [{ op: 'setText', id: 'L2', text: 'NEW COPY' }], done: false }),
    JSON.stringify({ plan: 'ok, structure only', ops: [], done: true }),
  ];
  const fakeLlm = async (prompt) => {
    if (/reference copy verbatim/.test(prompt)) sawLockError = true;
    return { ok: true, text: replies.shift() || '{"plan":"done","ops":[],"done":true}', error: null, usage: { inTok: 50, outTok: 20 } };
  };
  const r = await runDesignAgent(doc, 'polish the layout structure', () => {}, { llmCall: fakeLlm });
  const headline = r.doc.layers.find((l) => l.id === 'head-1');
  assert.equal(headline.text, 'BIG SALE', 'reference copy untouched');
  assert.ok(sawLockError, 'lock error fed back to the model');
});
