// test/design-agent-v3.test.mjs — harness smoke tests with an injected fake llmCall.
// Covers: batched multi-op turns (v5 loop), scoped observation shape, prose-wrapped/bare-op
// tolerance, per-turn token-estimate budget, per-op error feedback, and the contrast lint.
// Run: node --test test/design-agent-v3.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  runDesignAgent, observe, createAliasMap, applyOp, applySkeletonToDoc, decomposeEditIntoRegions,
  runCopyReference, classifyIntent, heuristicIntent, isVagueLayoutCommand, layoutDiagnostics, RUN_KINDS,
  deriveLayerName, themeFromLuminance,
} from '../lib/design-agent.mjs';
import { STEP_KINDS, runFanOut, makerChecker, mapConcurrent, runBatchAgent } from '../lib/agent-harness.mjs';
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
    // Ceiling tracks the edit contextBudgetTokens (4200, design-agent v8) + slack. The invariant
    // under test is that the guard HOLDS a ceiling, not the knob's value — 3000 left ~zero
    // headroom over the ~2950-token edit system prompt and crushed feedback/diagnostics.
    assert.ok((p.promptChars + p.systemChars) / 4 <= 4400, `turn ≤4.4k est tokens (got ${Math.round((p.promptChars + p.systemChars) / 4)})`);
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

test('cutout op builds a valid crop+shape image layer from the reference', () => {
  const doc = mkDoc();
  const before = doc.layers.length;
  // near-square avatar box, face region near the top-center of the source → auto circle mask
  const r = applyOp(doc, {
    op: 'cutout',
    box: { x: 60, y: 80, w: 140, h: 140 },
    region: { x: 0.34, y: 0.06, w: 0.14, h: 0.14 },
  });
  assert.match(r, /^cutout .* \(circle\)/, `summary names the shape (got: ${r})`);
  assert.equal(doc.layers.length, before + 1, 'one layer added');
  const layer = doc.layers[doc.layers.length - 1];
  assert.equal(layer.type, 'image', 'image layer');
  assert.equal(layer.src, '/img?path=x.png', 'defaults src to the base/reference image');
  assert.equal(layer.style.shapeKind, 'ellipse', 'near-square region → circle (ellipse) mask');
  // crop is normalized fractions 0..1 of the SOURCE image (a real sub-rect, not the whole image)
  assert.deepEqual(layer.style.crop, { x: 0.34, y: 0.06, w: 0.14, h: 0.14 }, 'crop = the region');
  assert.ok(layer.style.crop.w > 0 && layer.style.crop.w < 1, 'crop is a genuine sub-rect');

  // an explicit 'logo' hint on a wide box → rounded-rect mask (radius, no ellipse)
  const r2 = applyOp(doc, {
    op: 'cutout', shape: 'logo',
    box: { x: 60, y: 900, w: 300, h: 120 },
    region: { x: 0.1, y: 0.8, w: 0.4, h: 0.12 },
  });
  assert.match(r2, /\(roundedRect\)/, `logo hint → rounded (got: ${r2})`);
  const logo = doc.layers[doc.layers.length - 1];
  assert.ok(Number.isFinite(logo.style.radius) && logo.style.radius > 0, 'rounded → a corner radius');
  assert.equal(logo.style.shapeKind, undefined, 'rounded is not an ellipse');

  // a missing / identity region is rejected (the whole image is not a cut-out)
  assert.throws(() => applyOp(doc, { op: 'cutout', box: { x: 0, y: 0, w: 200, h: 200 } }), /region/);
  assert.throws(() => applyOp(doc, {
    op: 'cutout', box: { x: 0, y: 0, w: 200, h: 200 }, region: { x: 0, y: 0, w: 1, h: 1 },
  }), /region/);
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

test('keepCopy + allowReferenceTextFix: setText/draftText bypass the lock (self-check text-fix path)', async () => {
  const doc = mkDoc();
  doc.skeletonId = 'skel_x';
  const fakeLlm = async () => ({
    ok: true,
    text: JSON.stringify({ plan: 'fix headline to match reference', ops: [{ op: 'setText', id: 'head-1', text: 'Premium Silk' }], done: true }),
    error: null, usage: { inTok: 50, outTok: 20 },
  });
  const r = await runDesignAgent(doc, 'fix text to match reference', () => {}, { llmCall: fakeLlm, keepCopy: true, allowReferenceTextFix: true });
  const headline = r.doc.layers.find((l) => l.id === 'head-1');
  assert.ok(headline, 'target layer exists');
  assert.equal(headline.text, 'Premium Silk', 'text-fix applied despite keepCopy lock');
});

test('fan-out: multi-region edit spawns ≤3 concurrent sub-agents emitting unified subagent events', async () => {
  const doc = mkDoc();
  const steps = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const seenPurposes = [];
  // Each worker call proposes ONE op scoped to its region. Concurrency is observed by counting
  // overlapping in-flight calls (the fake yields to the event loop so real overlap shows up).
  const fakeLlm = async (prompt, opts = {}) => {
    seenPurposes.push(opts.purpose);
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    // route by which region's observation the worker was handed
    let op = null;
    if (/CTA region/.test(prompt) || /cta/i.test(prompt)) op = { op: 'setStyle', id: 'L4', style: { fontSize: 40 } };
    else op = { op: 'move', id: 'L2', x: 90, y: 60 };
    return { ok: true, text: JSON.stringify({ plan: 'region edit', ops: [op], done: true }), error: null, usage: { inTok: 80, outTok: 20 } };
  };
  const r = await runDesignAgent(
    doc,
    'restyle the headline and make the cta button pop',
    (ev) => { if (ev.step) steps.push(ev.step); },
    { llmCall: fakeLlm, fanOut: true },
  );
  const subEvents = steps.filter((s) => s.kind === 'subagent');
  const ids = new Set(subEvents.map((s) => s.data && s.data.id));
  assert.ok(subEvents.length >= 2, 'at least one frame per region worker');
  assert.ok(ids.size >= 2 && ids.size <= 3, 'fanned out to 2-3 distinct sub-agents (cap 3)');
  assert.ok(subEvents.some((s) => s.data && s.data.phase === 'start'), 'start phase emitted');
  assert.ok(subEvents.some((s) => s.data && s.data.phase === 'done'), 'done phase emitted');
  assert.ok(subEvents.every((s) => s.data && typeof s.data.model === 'string'), 'each worker carries a model label');
  assert.ok(subEvents.every((s) => s.data && s.data.parentRunId === r.runId), 'workers grouped under the parent run');
  assert.ok(maxInFlight >= 2, 'workers actually ran concurrently');
  assert.ok(maxInFlight <= 3, 'concurrency capped at 3');
  assert.ok(seenPurposes.includes('design-fanout-worker'), 'used the fan-out worker purpose');
  assert.ok(r.applied >= 2, 'gathered ops from multiple workers were applied');
  assert.match(r.source, /fanout/, 'source records the fan-out');
});

test('single-region / non-decomposing edit stays on the single-agent loop (no fan-out)', async () => {
  const doc = mkDoc();
  const steps = [];
  const fakeLlm = async () => ({ ok: true, text: JSON.stringify({ plan: 'p', ops: [{ op: 'move', id: 'L2', x: 90, y: 60 }], done: true }), error: null, usage: { inTok: 50, outTok: 10 } });
  // only names ONE region → must NOT fan out even with fanOut:true
  const r = await runDesignAgent(doc, 'move the headline down', (ev) => { if (ev.step) steps.push(ev.step); }, { llmCall: fakeLlm, fanOut: true });
  assert.equal(steps.filter((s) => s.kind === 'subagent').length, 0, 'no sub-agents for a single-region edit');
  assert.ok(!/fanout/.test(r.source), 'source is the normal single-loop source');
});

test('decomposeEditIntoRegions caps at 3 and only splits genuinely multi-region asks', () => {
  const doc = mkDoc();
  assert.equal(decomposeEditIntoRegions(doc, 'make the headline bigger').length, 0, 'single region → no split');
  assert.equal(decomposeEditIntoRegions(doc, 'move it').length, 0, 'no regions named → no split');
  const two = decomposeEditIntoRegions(doc, 'restyle the headline and fix the cta');
  assert.ok(two.length === 2, 'two named regions → 2 subtasks');
  assert.ok(two.every((t) => Array.isArray(t.ids) && t.ids.length), 'each subtask carries its region node ids');
  const many = decomposeEditIntoRegions(doc, 'change the headline, the caption, the product, and the cta');
  assert.ok(many.length <= 3, 'never more than 3 subtasks');
});

test('applySkeletonToDoc rebuilds overlays into the doc, keeps the base, scales to canvas', () => {
  const doc = mkDoc(); // canvas 1080x1080
  const skeleton = {
    id: 'skel_test',
    canvas: { w: 540, h: 540 },
    layers: [
      { id: 's1', type: 'text', role: 'headline', text: 'COPIED', box: { x: 50, y: 50, w: 200, h: 40 }, style: { fontSize: 20 } },
      { id: 's2', type: 'button', role: 'cta', text: 'GO', box: { x: 50, y: 400, w: 120, h: 40 }, style: { fontSize: 16 } },
    ],
  };
  const res = applySkeletonToDoc(doc, skeleton);
  assert.equal(res.added, 2, 'two overlays applied');
  const base = doc.layers.find((l) => l.role === 'base');
  assert.ok(base, 'base image kept');
  const head = doc.layers.find((l) => l.role === 'headline');
  assert.equal(head.text, 'COPIED');
  assert.equal(head.box.x, 100, 'box scaled 2x to the doc canvas');
  assert.equal(head.style.fontSize, 40, 'font scaled 2x to the doc canvas');
  assert.notEqual(head.id, 's1', 'fresh id assigned');
  assert.equal(doc.skeletonId, 'skel_test');
});

test('runCopyReference emits the unified vocabulary and never throws on a bad reference', async () => {
  const doc = mkDoc();
  const steps = [];
  const emit = (kind, summary, data = null) => steps.push({ kind, summary, data });
  // A path that does not exist → extractLayout returns {ok:false} (no vision / no image); the copy
  // run must degrade gracefully and still emit the shared vocabulary.
  const out = await runCopyReference(doc, { path: '/nonexistent/reference.png', label: 'test ref' }, emit, { runId: 'design_test' });
  const kinds = new Set(steps.map((s) => s.kind));
  assert.ok(kinds.has('thinking'), 'emits thinking');
  assert.ok(kinds.has('verify'), 'emits a terminal verify');
  assert.ok(steps.every((s) => STEP_KINDS.includes(s.kind)), 'every step uses the shared STEP_KINDS vocabulary');
  assert.equal(out.source, 'copy-reference');
  assert.ok(out.doc, 'returns a doc');
});

test('runFanOut caps concurrency at 3 and gathers results in order', async () => {
  let inFlight = 0; let peak = 0;
  const subtasks = [1, 2, 3, 4, 5].map((n) => ({
    id: `t${n}`, title: `task ${n}`,
    run: async ({ update }) => { inFlight++; peak = Math.max(peak, inFlight); update('working'); await new Promise((r) => setTimeout(r, 5)); inFlight--; return { ok: true, n }; },
  }));
  const frames = [];
  // runFanOut itself caps subtasks at 3 (a lead decomposes into ≤3) — pass 3.
  const { results } = await runFanOut({ subtasks: subtasks.slice(0, 3), concurrency: 5, onStep: (s) => frames.push(s), model: 'ornith' });
  assert.equal(results.length, 3);
  assert.ok(peak <= 3, 'never more than 3 concurrent');
  assert.ok(frames.some((f) => f.data.phase === 'start') && frames.some((f) => f.data.phase === 'done'));
  assert.ok(frames.every((f) => f.kind === 'subagent' && f.data.model === 'ornith'));
});

test('makerChecker uses the checker fix when validation fails', async () => {
  const ok = await makerChecker(() => 'raw', () => ({ ok: true }));
  assert.equal(ok.candidate, 'raw');
  const fixed = await makerChecker(() => 'raw', () => ({ ok: false, fixed: 'repaired', findings: ['bad'] }));
  assert.equal(fixed.candidate, 'repaired');
  assert.deepEqual(fixed.findings, ['bad']);
  // a throwing checker degrades to accepting the maker output
  const safe = await makerChecker(() => 'raw', () => { throw new Error('boom'); });
  assert.equal(safe.candidate, 'raw');
  assert.equal(safe.ok, true);
});

// ── INTENT GATE (v7) ──────────────────────────────────────────────────────────────────────────────

test('intent gate: "yo" classifies as chat with no ops and no canvas lock (locked:false)', async () => {
  const doc = mkDoc();
  const before = JSON.stringify(doc.layers);
  const events = [];
  // fakeLlm here would only be the chat reply — no op loop should ever run for chat
  const fakeLlm = async () => ({ ok: true, text: 'Hey! Tell me what to tweak.', error: null, usage: { inTok: 20, outTok: 10 } });
  const r = await runDesignAgent(doc, 'yo', (ev) => events.push(ev), { llmCall: fakeLlm });

  assert.equal(r.kind, 'chat', 'run result exposes kind:"chat"');
  assert.equal(r.locked, false, 'chat must NOT lock the canvas (locked:false)');
  assert.equal(r.source, 'chat');
  assert.equal(r.applied, 0, 'zero ops applied');
  assert.equal(JSON.stringify(doc.layers), before, 'doc untouched by a chat message');
  // the run-START event carries kind + locked so the frontend gates the lock BEFORE any op
  const startEv = events.find((e) => e.start);
  assert.ok(startEv, 'a run-start event was emitted');
  assert.equal(startEv.kind, 'chat', 'start event exposes kind');
  assert.equal(startEv.locked, false, 'start event says NOT locked for chat');
  // no `op` step other than the chat reply itself (which is flagged chat:true, not an edit op)
  const editOpSteps = r.steps.filter((s) => s.kind === 'op' && !(s.data && s.data.chat));
  assert.equal(editOpSteps.length, 0, 'no edit ops emitted for a chat message');
});

test('intent gate: greetings/meta → chat; real edits → edit (contract: locked ⇔ kind≠chat)', () => {
  assert.equal(heuristicIntent('yo'), 'chat');
  assert.equal(heuristicIntent('hey'), 'chat');
  assert.equal(heuristicIntent('thanks'), 'chat');
  assert.equal(heuristicIntent('why did you change that?'), 'chat');
  assert.equal(heuristicIntent('move the headline lower'), 'edit');
  assert.equal(heuristicIntent('make the cta bigger'), 'edit');
  assert.equal(heuristicIntent('fix the spacing'), 'edit');
  // a short ambiguous non-greeting is deferred to the model (null)
  assert.equal(heuristicIntent('the vibe'), null);
  // a copy ask only reads as copy when a reference is actually attached
  assert.equal(heuristicIntent('copy this reference', { hasReference: true }), 'copy');
  assert.equal(heuristicIntent('copy this reference', { hasReference: false }) !== 'copy', true);
  assert.ok(RUN_KINDS.includes('chat') && RUN_KINDS.includes('edit') && RUN_KINDS.includes('copy'));
});

test('classifyIntent: ambiguous short message escalates to a cheap ornith check, conservative to edit', async () => {
  // heuristic returns null ("hmm ok?" is short, no edit verb, not a clear greeting) → model asked
  let asked = 0;
  const chatModel = async () => { asked++; return { ok: true, text: 'chat', usage: { inTok: 5, outTok: 1 } }; };
  const c1 = await classifyIntent('hmm the thing', { llmCall: chatModel });
  assert.equal(c1.kind, 'chat');
  assert.equal(c1.via, 'model');
  assert.ok(asked >= 1, 'the model was consulted for the ambiguous case');
  // an unclear/garbled model reply → conservative fallback to edit (never swallow a real ask)
  const junkModel = async () => ({ ok: true, text: 'i am not sure', usage: { inTok: 5, outTok: 3 } });
  const c2 = await classifyIntent('hmm the thing', { llmCall: junkModel });
  assert.equal(c2.kind, 'edit');
  // a clear edit verb never even reaches the model (heuristic wins, free)
  let asked2 = 0;
  const c3 = await classifyIntent('make it bigger', { llmCall: async () => { asked2++; return { ok: true, text: 'chat' }; } });
  assert.equal(c3.kind, 'edit');
  assert.equal(c3.via, 'heuristic');
  assert.equal(asked2, 0, 'a clear edit is classified for free — no model call');
});

// ── VAGUE-COMMAND UNDERSTANDING (v7) ────────────────────────────────────────────────────────────────

test('layoutDiagnostics detects overlaps, uneven gaps, and misaligned edges', () => {
  // overlap case: b overlaps a AND b's left edge is off by 12px
  const overlapDoc = {
    id: 'diag-ov', canvas: { w: 1080, h: 1350 },
    layers: [
      { id: 'base', type: 'image', role: 'base', box: { x: 0, y: 0, w: 1080, h: 1350 }, src: '/x' },
      { id: 'a', type: 'text', role: 'headline', text: 'A', box: { x: 80, y: 100, w: 400, h: 120 }, style: { fontSize: 84 } },
      { id: 'b', type: 'text', role: 'subhead', text: 'B', box: { x: 92, y: 200, w: 400, h: 120 }, style: { fontSize: 40 } }, // overlaps A (y 200 < 220), x off by 12
    ],
  };
  const ovJoined = layoutDiagnostics(overlapDoc).join(' | ');
  assert.ok(/SPACING:.*overlap/i.test(ovJoined), `overlap detected (got: ${ovJoined})`);
  assert.ok(/ALIGN:.*left edges differ/i.test(ovJoined), `misaligned left edges detected (got: ${ovJoined})`);

  // uneven-rhythm case: three NON-overlapping blocks with very different gaps (20px then 480px)
  const unevenDoc = {
    id: 'diag-un', canvas: { w: 1080, h: 1350 },
    layers: [
      { id: 'base', type: 'image', role: 'base', box: { x: 0, y: 0, w: 1080, h: 1350 }, src: '/x' },
      { id: 'a', type: 'text', role: 'headline', text: 'A', box: { x: 80, y: 100, w: 400, h: 100 }, style: { fontSize: 84 } },
      { id: 'b', type: 'text', role: 'subhead', text: 'B', box: { x: 80, y: 220, w: 400, h: 100 }, style: { fontSize: 40 } }, // gap 20
      { id: 'c', type: 'text', role: 'caption', text: 'C', box: { x: 80, y: 800, w: 400, h: 60 }, style: { fontSize: 30 } }, // gap 480
    ],
  };
  assert.ok(/SPACING:.*uneven/i.test(layoutDiagnostics(unevenDoc).join(' | ')), `uneven vertical rhythm detected (got: ${layoutDiagnostics(unevenDoc).join(' | ')})`);
  // a clean, evenly-spaced, aligned stack → no findings
  const clean = {
    id: 'clean', canvas: { w: 1080, h: 1350 },
    layers: [
      { id: 'base', type: 'image', role: 'base', box: { x: 0, y: 0, w: 1080, h: 1350 }, src: '/x' },
      { id: 'a', type: 'text', role: 'headline', text: 'A', box: { x: 80, y: 100, w: 400, h: 100 }, style: {} },
      { id: 'b', type: 'text', role: 'subhead', text: 'B', box: { x: 80, y: 250, w: 400, h: 100 }, style: {} },
      { id: 'c', type: 'text', role: 'caption', text: 'C', box: { x: 80, y: 400, w: 400, h: 100 }, style: {} },
    ],
  };
  assert.equal(layoutDiagnostics(clean).length, 0, 'a clean layout yields no diagnostics');
});

test('vague command "fix the spacing" ships LAYOUT ISSUES and produces spacing-normalizing ops on the right layers', async () => {
  assert.equal(isVagueLayoutCommand('fix the spacing'), true);
  assert.equal(isVagueLayoutCommand('tighten it up'), true);
  assert.equal(isVagueLayoutCommand('fix the alignment'), true);
  assert.equal(isVagueLayoutCommand('make the headline bigger'), false);

  // a doc whose three text blocks overlap / are unevenly gapped
  const doc = {
    id: 'vague-doc', name: 'Vague', canvas: { w: 1080, h: 1350 }, createdAt: 1, updatedAt: 1,
    layers: [
      { id: 'base-1', type: 'image', role: 'base', box: { x: 0, y: 0, w: 1080, h: 1350 }, src: '/img?path=x.png' },
      { id: 'head-1', type: 'text', role: 'headline', text: 'BIG SALE', box: { x: 80, y: 100, w: 500, h: 140 }, style: { fontSize: 84, color: '#ffffff' } },
      { id: 'sub-1', type: 'text', role: 'subhead', text: 'this weekend', box: { x: 80, y: 210, w: 500, h: 120 }, style: { fontSize: 40, color: '#ffffff' } }, // overlaps headline
      { id: 'cap-1', type: 'text', role: 'caption', text: 'ends monday', box: { x: 80, y: 900, w: 500, h: 60 }, style: { fontSize: 30, color: '#ffffff' } }, // far below
    ],
  };

  let sawLayoutIssues = false;
  const seen = [];
  const fakeLlm = async (prompt) => {
    seen.push(prompt);
    if (/LAYOUT ISSUES/.test(prompt)) sawLayoutIssues = true;
    // Only propose ops the FIRST time (when the observation still shows the overlap). React to the
    // named ids in the LAYOUT ISSUES block: separate the overlap + even the gaps via distribute.
    if (seen.length === 1) {
      return {
        ok: true,
        text: JSON.stringify({
          plan: 'the LAYOUT ISSUES show head/sub overlap and uneven gaps — separate then even them out',
          ops: [
            { op: 'move', id: 'L3', x: 80, y: 300 },                    // push subhead below headline
            { op: 'distribute', ids: ['L2', 'L3', 'L4'], axis: 'y' },   // even the vertical rhythm
          ],
          done: false,
        }),
        error: null, usage: { inTok: 200, outTok: 60 },
      };
    }
    return { ok: true, text: JSON.stringify({ plan: 'spacing is even now', ops: [], done: true }), error: null, usage: { inTok: 80, outTok: 10 } };
  };

  const steps = [];
  const r = await runDesignAgent(doc, 'fix the spacing', (ev) => { if (ev.step) steps.push(ev.step); }, { llmCall: fakeLlm, fanOut: false });

  assert.ok(sawLayoutIssues, 'the observation shipped a LAYOUT ISSUES block for the vague ask');
  assert.equal(r.kind, 'edit');
  assert.ok(r.applied >= 2, `spacing-normalizing ops applied (got ${r.applied})`);
  // the ops touched the text blocks (not the base image) and the overlap is resolved
  const head = r.doc.layers.find((l) => l.id === 'head-1');
  const sub = r.doc.layers.find((l) => l.id === 'sub-1');
  assert.ok(sub.box.y >= head.box.y + head.box.h - 4, 'subhead no longer overlaps the headline');
  assert.equal(r.doc.layers.find((l) => l.role === 'base').box.y, 0, 'base image untouched');
});

// ── ABORT (v7) ────────────────────────────────────────────────────────────────────────────────────

test('runBatchAgent aborts promptly between ops and returns a clean partial', async () => {
  const controller = new AbortController();
  const applied = [];
  // one turn proposes 4 ops; the signal aborts AFTER the 2nd op is applied → ops 3 & 4 never run,
  // the loop stops promptly, and the already-applied ops are preserved (not corrupted).
  const fakeLlm = async () => ({
    ok: true,
    text: JSON.stringify({ plan: 'apply four', ops: [{ op: 'x', i: 1 }, { op: 'x', i: 2 }, { op: 'x', i: 3 }, { op: 'x', i: 4 }], done: false }),
    usage: { inTok: 10, outTok: 5 },
  });
  const run = await runBatchAgent({
    system: 'sys',
    buildObservation: () => 'state',
    maxOpsPerTurn: 6,
    maxTurns: 5,
    signal: controller.signal,
    llmCall: fakeLlm,
    applyOp: async (op) => {
      applied.push(op.i);
      if (applied.length === 2) controller.abort(); // user hits stop mid-turn
      return `did ${op.i}`;
    },
  });
  assert.deepEqual(applied, [1, 2], 'stopped promptly after the 2nd op — 3 & 4 never applied');
  assert.equal(run.applied, 2, 'applied count reflects the clean partial');
  assert.equal(run.stoppedBy, 'aborted', 'run reports it was aborted');
});

test('runDesignAgent honors an already-aborted signal: minimal work, clean partial result', async () => {
  const doc = mkDoc();
  const before = JSON.stringify(doc.layers);
  const controller = new AbortController();
  controller.abort(); // pre-aborted (the stop button was already hit)
  let calls = 0;
  const fakeLlm = async () => { calls++; return { ok: true, text: JSON.stringify({ plan: 'p', ops: [{ op: 'move', id: 'L2', x: 90, y: 60 }], done: true }), usage: { inTok: 10, outTok: 5 } }; };
  const r = await runDesignAgent(doc, 'move the headline lower', () => {}, { llmCall: fakeLlm, signal: controller.signal });
  // the edit loop must not have applied anything (it bailed on the aborted signal); the result is a
  // clean, non-throwing partial. The stored doc is untouched (agent works on a copy).
  assert.equal(r.aborted, true, 'result flags the abort');
  assert.equal(r.applied, 0, 'no ops applied under an aborted signal');
  assert.equal(JSON.stringify(doc.layers), before, 'stored doc untouched');
  assert.ok(r.doc, 'still returns a doc (clean partial, never throws)');
});

test('context budget guard keeps a huge comp (150 layers) under the per-turn window', async () => {
  // a big comp: 150 text blocks. Without the guard the observation would balloon; with it, every
  // turn's prompt stays under the configured ceiling regardless of comp size.
  const layers = [{ id: 'base-1', type: 'image', role: 'base', box: { x: 0, y: 0, w: 1080, h: 4000 }, src: '/x' }];
  for (let i = 0; i < 150; i++) {
    layers.push({ id: `t${i}`, type: 'text', role: 'caption', text: `layer number ${i} with some copy`, box: { x: 80, y: 60 + i * 24, w: 600, h: 40 }, style: { fontSize: 28, color: '#ffffff' } });
  }
  const doc = { id: 'big', name: 'Big', canvas: { w: 1080, h: 4000 }, createdAt: 1, updatedAt: 1, layers };

  const turnTokens = [];
  const fakeLlm = async (prompt, opts = {}) => {
    turnTokens.push(Math.round((prompt.length + (opts.system || '').length) / 4));
    return { ok: true, text: JSON.stringify({ plan: 'p', ops: [], done: true }), usage: { inTok: 100, outTok: 10 } };
  };
  const r = await runDesignAgent(doc, 'make the third caption bolder', () => {}, { llmCall: fakeLlm });
  assert.ok(turnTokens.length > 0, 'the model was called');
  for (const t of turnTokens) assert.ok(t <= 4400, `a 150-layer turn stayed under the window (got ${t} est tokens)`);
  assert.ok(r.doc, 'returns a doc');
});

test('layers get human names (not bare type) on add / cutout; user rename is never clobbered', () => {
  // deriveLayerName rules — pure helper
  assert.equal(deriveLayerName({ type: 'text', role: 'headline', text: 'Save 40% Today' }), 'Save 40% Today');
  assert.equal(deriveLayerName({ type: 'text', role: 'headline', text: '' }), 'Headline');
  assert.equal(deriveLayerName({ type: 'text', role: 'body', text: '' }), 'Body');
  assert.equal(deriveLayerName({ type: 'button', role: 'cta', text: 'Shop Now' }), 'Shop Now button');
  assert.equal(deriveLayerName({ type: 'image', role: 'product' }), 'Product');
  assert.equal(deriveLayerName({ type: 'image', role: 'avatar' }), 'Avatar');
  assert.equal(deriveLayerName({ type: 'image', role: 'cutout' }, { cutout: true }), 'Cut-out');
  assert.equal(deriveLayerName({ type: 'badge', role: 'badge', text: '' }), 'Badge');
  assert.ok(deriveLayerName({ type: 'text', role: 'headline', text: 'x'.repeat(200) }).length <= 60);

  // add op: a text/image/button layer without an explicit name gets a HUMAN name, not "text"/"image"
  const doc = mkDoc();
  const aliases = createAliasMap(); aliases.sync(doc);
  const ctx = { aliases };
  applyOp(doc, { op: 'add', layer: { type: 'text', role: 'headline', text: 'Save 40% Today', box: { x: 80, y: 400, w: 600, h: 100 } } }, ctx);
  applyOp(doc, { op: 'add', layer: { type: 'button', role: 'cta', text: 'Shop Now', box: { x: 80, y: 600, w: 300, h: 90 } } }, ctx);
  applyOp(doc, { op: 'add', layer: { type: 'image', role: 'product', box: { x: 80, y: 700, w: 300, h: 300 } } }, ctx);
  const added = doc.layers.slice(-3);
  assert.equal(added[0].name, 'Save 40% Today', 'headline named from its text');
  assert.equal(added[1].name, 'Shop Now button', 'button named "<text> button"');
  assert.equal(added[2].name, 'Product', 'image placeholder named by role, not "image"');
  for (const n of added) assert.ok(!['text', 'image', 'shape', 'button'].includes(n.name), `no bare-type name (${n.name})`);

  // setText SYNCS an auto-derived-from-text name to the new copy…
  const head = added[0];
  applyOp(doc, { op: 'setText', id: head.id, text: 'Limited Time Deal' }, ctx);
  assert.equal(head.name, 'Limited Time Deal', 'auto name follows edited copy');

  // …but a USER-renamed layer is NEVER clobbered by a later agent setText.
  const btn = added[1];
  btn.name = 'My Fancy CTA'; // simulate an inline rename in the panel
  applyOp(doc, { op: 'setText', id: btn.id, text: 'Buy Now' }, ctx);
  assert.equal(btn.name, 'My Fancy CTA', 'user rename survives a later setText');

  // an explicit model-supplied name also wins over the derived one.
  applyOp(doc, { op: 'add', layer: { type: 'text', role: 'caption', text: 'hi', name: 'Custom Name', box: { x: 80, y: 800, w: 200, h: 40 } } }, ctx);
  assert.equal(doc.layers[doc.layers.length - 1].name, 'Custom Name', 'explicit name not overridden');
});

// ── background handling: theme, no unwanted solid, correct default ─────────────────────────────────

test('themeFromLuminance: dark below mid-grey, light at/above', () => {
  assert.equal(themeFromLuminance(0.05), 'dark');   // near-black bg → dark theme
  assert.equal(themeFromLuminance(0.49), 'dark');
  assert.equal(themeFromLuminance(0.5), 'light');
  assert.equal(themeFromLuminance(0.95), 'light');  // near-white bg → light theme
  assert.equal(themeFromLuminance(null), 'light');  // unknown → light default
});

test('applySkeletonToDoc: a PHOTO reference does NOT inject a solid base', () => {
  // Doc starts with a real photo base (the reference underlay). A photo skeleton has background:null.
  const doc = {
    id: 'd', name: 'D', canvas: { w: 1080, h: 1080 }, createdAt: 1, updatedAt: 1,
    layers: [
      { id: 'base-1', type: 'image', role: 'base', name: 'Base', box: { x: 0, y: 0, w: 1080, h: 1080 }, src: '/img?path=photo.png', fit: 'cover' },
    ],
  };
  const skeleton = {
    id: 'skel_photo', canvas: { w: 1080, h: 1080 }, background: null, // photo → no flat fill
    layers: [{ id: 's-head', type: 'text', role: 'headline', text: 'HELLO', box: { x: 80, y: 120, w: 700, h: 120 }, style: { fontSize: 84, color: '#ffffff' } }],
  };
  applySkeletonToDoc(doc, skeleton);
  const bases = doc.layers.filter((l) => l.role === 'base');
  assert.equal(bases.length, 1, 'exactly one base');
  assert.equal(bases[0].type, 'image', 'photo base kept as the image underlay — not replaced by a solid shape');
  assert.equal(bases[0].src, '/img?path=photo.png', 'original photo src preserved');
  // no injected solid-fill shape base
  assert.ok(!doc.layers.some((l) => l.role === 'base' && l.type === 'shape'), 'no unwanted solid base injected for a photo reference');
});

test('applySkeletonToDoc: a SOLID reference replaces the base with that fill; GRADIENT → gradient', () => {
  const mk = () => ({
    id: 'd', name: 'D', canvas: { w: 1080, h: 1080 }, createdAt: 1, updatedAt: 1,
    layers: [{ id: 'base-1', type: 'shape', role: 'base', name: 'Background', box: { x: 0, y: 0, w: 1080, h: 1080 }, style: { background: '#ffffff' } }],
  });
  const solidDoc = mk();
  applySkeletonToDoc(solidDoc, { id: 's1', canvas: { w: 1080, h: 1080 }, background: '#0c0e14', layers: [] });
  const sBase = solidDoc.layers.find((l) => l.role === 'base');
  assert.equal(sBase.type, 'shape');
  assert.equal(sBase.style.background, '#0c0e14', 'solid reference background becomes the base fill');

  const gradDoc = mk();
  applySkeletonToDoc(gradDoc, { id: 's2', canvas: { w: 1080, h: 1080 }, background: { from: '#ff0000', to: '#0000ff', angle: 90 }, layers: [] });
  const gBase = gradDoc.layers.find((l) => l.role === 'base');
  assert.ok(gBase.style.gradient && gBase.style.gradient.stops.length === 2, 'gradient reference becomes a gradient base');
  assert.equal(gBase.style.gradient.stops[0].color, '#ff0000');
});
