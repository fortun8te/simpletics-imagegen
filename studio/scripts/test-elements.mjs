// scripts/test-elements.mjs — smoke test for the parametric element library.
// Builds every element (defaults + randomized valid params + malformed params) into
// 1080x1080 / 1080x1350 / 1080x1920 docs, asserts geometry/provenance invariants, checks
// alias resolution + catalog hygiene + font sensibility, and renders each through
// renderDesignHtml (polyline markup must appear for chart-line).

import { ELEMENTS, ELEMENT_ALIASES, buildElement, coerceParams, elementCatalogLine, FONT_SUGGEST } from '../lib/elements.mjs';
import { renderDesignHtml } from '../lib/designstore.mjs';

const DOCS = [
  { id: 'sq', name: 'sq', canvas: { w: 1080, h: 1080 }, layers: [] },
  { id: 'p45', name: 'p45', canvas: { w: 1080, h: 1350 }, layers: [] },
  { id: 'story', name: 'story', canvas: { w: 1080, h: 1920 }, layers: [] },
];

let failures = 0;
const fail = (msg) => { failures++; console.error(`FAIL: ${msg}`); };

function checkNodes(nodes, elId, ctx, doc) {
  for (const n of nodes) {
    if (!n.id) fail(`${elId} [${ctx}]: node without id`);
    const b = n.box;
    if (!b || ![b.x, b.y, b.w, b.h].every((v) => Number.isFinite(v))) {
      fail(`${elId} [${ctx}]: non-finite box ${JSON.stringify(b)}`);
      continue;
    }
    if (b.x < -1 || b.y < -1 || b.x + b.w > doc.canvas.w + 1 || b.y + b.h > doc.canvas.h + 1) {
      fail(`${elId} [${ctx}] @${doc.canvas.w}x${doc.canvas.h}: box outside canvas ${JSON.stringify(b)} (node ${n.name || n.id})`);
    }
    if (n.type === 'group') {
      if (!Array.isArray(n.children) || !n.children.length) fail(`${elId} [${ctx}]: group without children`);
      else checkNodes(n.children, elId, ctx, doc);
    }
  }
}

const flat = (nodes) => nodes.flatMap((n) => (n.type === 'group' ? flat(n.children || []) : [n]));

function randomParams(def) {
  const out = {};
  for (const s of def.params) {
    switch (s.type) {
      case 'text': out[s.key] = `RND ${s.key} ${Math.random().toString(36).slice(2, 8)}`; break;
      case 'color': out[s.key] = `#${Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0')}`; break;
      case 'number': {
        const min = s.min ?? 0, max = s.max ?? 10;
        out[s.key] = min + Math.random() * (max - min); break;
      }
      case 'boolean': out[s.key] = Math.random() < 0.5; break;
      case 'enum': out[s.key] = s.options[Math.floor(Math.random() * s.options.length)]; break;
      case 'stringList': out[s.key] = ['alpha|1.00', 'beta|2.50', 'gamma|3.75'].slice(0, 1 + Math.floor(Math.random() * 3)); break;
      case 'series': out[s.key] = [{ label: 'R1', color: 'ff0044', points: [0.1, 0.5, 0.9, 0.4] }]; break;
    }
  }
  return out;
}

const MALFORMED = { text: 42, color: '2c5cff', number: '42', boolean: 'true', enum: 'NOT_AN_OPTION', stringList: 'single-scalar', series: 'garbage' };

for (const doc of DOCS) {
  for (const def of ELEMENTS) {
    for (const [ctx, raw] of [['defaults', undefined], ['random', randomParams(def)],
      ['malformed', Object.fromEntries(def.params.map((s) => [s.key, MALFORMED[s.type]]))]]) {
      let nodes;
      try {
        nodes = buildElement(def.id, doc, raw, ctx === 'random' ? { colors: ['#ff2200', '#00ccaa'], fonts: ['Test Grotesk'] } : undefined);
      } catch (e) { fail(`${def.id} [${ctx}]: build threw: ${e.message}`); continue; }
      if (!nodes.length) { fail(`${def.id} [${ctx}]: built nothing`); continue; }
      checkNodes(nodes, def.id, ctx, doc);
      const inst = nodes[0];
      if (!inst.element || inst.element.id !== def.id || inst.element.v !== 1 || typeof inst.element.params !== 'object') {
        fail(`${def.id} [${ctx}]: missing/bad .element provenance`);
      }
      // coerceParams round-trips cleanly on its own output
      const p2 = coerceParams(def, inst.element.params);
      if (JSON.stringify(p2) !== JSON.stringify(inst.element.params)) fail(`${def.id} [${ctx}]: coerceParams not idempotent`);
      // brand-kit font: applies ONLY to brandFont defs, never over artifact fonts
      if (ctx === 'random') {
        const texts = flat(nodes).filter((l) => ['text', 'badge', 'button'].includes(l.type));
        const kitFonted = texts.some((l) => l.style && l.style.fontFamily === 'Test Grotesk');
        if (def.brandFont && texts.length && !kitFonted) fail(`${def.id}: brandFont def ignored kit font`);
        if (!def.brandFont && kitFonted) fail(`${def.id}: non-brandable def picked up kit font`);
      }
      try {
        const html = renderDesignHtml({ ...doc, layers: nodes });
        if (def.id === 'chart-line' && !html.includes('<polyline')) fail(`chart-line [${ctx}]: no <polyline> in HTML render`);
      } catch (e) { fail(`${def.id} [${ctx}]: renderDesignHtml threw: ${e.message}`); }
    }
    // deterministic enum sweep — every option of every enum param must build in-bounds
    for (const s of def.params.filter((sp) => sp.type === 'enum')) {
      for (const opt of s.options) {
        try { checkNodes(buildElement(def.id, doc, { [s.key]: opt }), def.id, `enum ${s.key}=${opt}`, doc); }
        catch (e) { fail(`${def.id} [enum ${s.key}=${opt}]: build threw: ${e.message}`); }
      }
    }
    // boolean sweep — both states build in-bounds
    for (const s of def.params.filter((sp) => sp.type === 'boolean')) {
      for (const opt of [true, false]) {
        try { checkNodes(buildElement(def.id, doc, { [s.key]: opt }), def.id, `bool ${s.key}=${opt}`, doc); }
        catch (e) { fail(`${def.id} [bool ${s.key}=${opt}]: build threw: ${e.message}`); }
      }
    }
  }
}

// ── alias resolution ─────────────────────────────────────────────────────────────────────────────
{
  const doc = DOCS[1];
  for (const [aliasId, target] of Object.entries(ELEMENT_ALIASES)) {
    const nodes = buildElement(aliasId, doc);
    if (!nodes.length) { fail(`alias ${aliasId}: built nothing`); continue; }
    if (nodes[0].element?.id !== target.id) fail(`alias ${aliasId}: stamped '${nodes[0].element?.id}', want canonical '${target.id}'`);
    for (const [k, v] of Object.entries(target.params)) {
      if (nodes[0].element.params[k] !== v) fail(`alias ${aliasId}: param ${k}=${nodes[0].element.params[k]}, want ${v}`);
    }
  }
  // caller params still win over the alias preset
  const n = buildElement('ig-caption-light', doc, { style: 'dark', text: 'x' });
  if (n[0].element.params.style !== 'dark') fail('alias: caller params must override alias preset');
  // benefit-stack alias renders hook + items as two pill layers
  const bs = buildElement('benefit-stack', doc, { hook: 'Why it works:', items: ['a', 'b', 'c'] });
  const bsTexts = flat(bs).filter((l) => l.type === 'text');
  if (bsTexts.length !== 2) fail(`benefit-stack alias: expected hook+items pills, got ${bsTexts.length} texts`);
  if (!bsTexts[1] || bsTexts[1].text !== 'a\nb\nc') fail('benefit-stack alias: items not newline-joined');
  if (buildElement('nope-not-real', doc).length !== 0) fail('unknown id should build nothing');
}

// ── quality metrics (real-ad ratios) ─────────────────────────────────────────────────────────────
{
  const doc = DOCS[1]; // 1080x1350
  const cap = flat(buildElement('ig-caption', doc))[0];
  const wantFs = Math.round(doc.canvas.w * 0.046);
  if (cap.style.fontSize !== wantFs) fail(`ig-caption fontSize ${cap.style.fontSize}, want 4.6% of width = ${wantFs}`);
  if (cap.style.fontWeight !== 700 || cap.style.lineHeight !== 1.32) fail('ig-caption pill metrics drifted (want 700 / lh 1.32)');
  const cta = flat(buildElement('cta', doc))[0];
  const ctaFrac = cta.box.h / doc.canvas.h;
  if (Math.abs(ctaFrac - 0.055) > 0.005) fail(`cta pill height ${(ctaFrac * 100).toFixed(1)}% of canvas, want ≈5.5%`);
  const xp = flat(buildElement('x-post', doc));
  const metrics = xp.find((l) => l.name === 'Post metrics');
  const order = ['Replies', 'Reposts', 'Likes', 'Views'];
  const idxs = order.map((k) => (metrics ? metrics.text.indexOf(k) : -1));
  if (idxs.some((i) => i < 0) || idxs.some((v, i) => i && v < idxs[i - 1])) {
    fail(`x-post metrics row order wrong: "${metrics?.text}" (want replies · reposts · likes · views)`);
  }
  if (!xp.every((l) => l.type !== 'text' || l.style.fontFamily === FONT_SUGGEST.twitter)) fail('x-post: some text layer missing Chirp fontFamily');
  const anon = flat(buildElement('x-post', doc, { pixelated: true }));
  if (anon.find((l) => l.name === 'Name' || l.name === 'Handle')) fail('x-post pixelated: name/handle text still present');
  if (!anon.find((l) => l.name === 'Name (anon)') || !anon.find((l) => l.name === 'Handle (anon)')) fail('x-post pixelated: anon rects missing');
  // artifact font sensibility
  const fontOf = (id, params) => flat(buildElement(id, doc, params)).find((l) => l.type === 'text')?.style.fontFamily;
  if (fontOf('receipt') !== FONT_SUGGEST.mono) fail('receipt: not Menlo');
  if (fontOf('notes-card') !== FONT_SUGGEST.notes) fail('notes-card: not -apple-system');
  if (fontOf('handwritten') !== FONT_SUGGEST.hand) fail('handwritten: not Bradley Hand');
  const hand = flat(buildElement('handwritten', doc))[0];
  if (hand.rotation !== -2) fail('handwritten: rotation != -2');
  const sticky = flat(buildElement('sticky-note', doc));
  if (!sticky.every((l) => l.rotation === -3)) fail('sticky-note: layers not tilted -3');
  // checklist negative → red ✗
  const neg = flat(buildElement('checklist', doc, { negative: true }));
  const negMark = neg.find((l) => l.name === 'Mark 1');
  if (!negMark || negMark.text !== '✗' || negMark.style.color !== '#d92c2c') fail('checklist negative: no red ✗ marks');
}

// ── catalog hygiene ──────────────────────────────────────────────────────────────────────────────
console.log(`\nCatalog (${ELEMENTS.length} elements):`);
for (const def of ELEMENTS) {
  const line = elementCatalogLine(def);
  if (line.length > 60) fail(`catalog line >60 chars (${line.length}): ${line}`);
  console.log(`  ${line}`);
}
console.log(`Aliases: ${Object.keys(ELEMENT_ALIASES).join(', ')}`);

// every text layer autoH
for (const def of ELEMENTS) {
  for (const l of flat(buildElement(def.id, DOCS[0]))) {
    if (l.type === 'text' && !l.autoH) fail(`${def.id}: text layer '${l.name}' missing autoH`);
  }
}
// sensible defaultBox fractions
for (const def of ELEMENTS) {
  const b = def.defaultBox;
  if (!(b.x >= 0 && b.y >= 0 && b.w > 0 && b.h > 0 && b.x + b.w <= 1 && b.y + b.h <= 1)) {
    fail(`${def.id}: defaultBox not sane fractions ${JSON.stringify(b)}`);
  }
}

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nAll element tests passed.');
