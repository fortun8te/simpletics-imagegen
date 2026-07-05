// test/templates.test.mjs — archetype template contract: every template builds a full,
// lint-sane composition at its natural aspect; detection maps briefs to archetypes; the
// agent's template op replaces non-base layers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TEMPLATES, buildTemplate, detectTemplate } from '../lib/templates.mjs';
import { applyOp, createAliasMap } from '../lib/design-agent.mjs';
import { lintDesign } from '../lib/design-lint.mjs';
import { walkNodes } from '../lib/scene-tree.mjs';

const CANVAS = { 'story-native': { w: 1080, h: 1920 }, 'x-post-ad': { w: 1080, h: 1350 },
  'before-after': { w: 1080, h: 1080 }, comparison: { w: 1080, h: 1080 }, 'offer-hero': { w: 1080, h: 1920 } };

const mkDoc = (canvas) => ({ id: 't', canvas, createdAt: 1, updatedAt: 1, layers: [
  { id: 'base-1', type: 'image', role: 'base', box: { x: 0, y: 0, w: canvas.w, h: canvas.h }, src: '/x' },
] });

test('every template builds inside its canvas with text content', () => {
  for (const t of TEMPLATES) {
    const canvas = CANVAS[t.id] || { w: 1080, h: 1350 };
    const doc = mkDoc(canvas);
    const { layers } = buildTemplate(t.id, doc, {}, undefined);
    // templates now return ONE named top-level group (clean Figma export) with nested leaves
    let leaves = 0;
    let texts = 0;
    walkNodes(layers, (l) => {
      if (l.type !== 'group') leaves++;
      if (l.text) texts++;
      if (!l.box) return;
      assert.ok(l.box.x >= -1 && l.box.y >= -1, `${t.id}/${l.name} inside canvas (x,y)`);
      assert.ok(l.box.x + l.box.w <= canvas.w + 2, `${t.id}/${l.name} inside canvas w (${l.box.x}+${l.box.w} vs ${canvas.w})`);
      assert.ok(l.box.y + l.box.h <= canvas.h + 2, `${t.id}/${l.name} inside canvas h (${l.box.y}+${l.box.h} vs ${canvas.h})`);
    });
    assert.ok(leaves >= 2, `${t.id} builds layers (${leaves} leaves)`);
    assert.ok(texts >= 2, `${t.id} has real copy (${texts} text layers)`);
  }
});

test('template op replaces non-base layers and is lint-viable', () => {
  const doc = mkDoc({ w: 1080, h: 1350 });
  doc.layers.push({ id: 'old', type: 'text', role: 'caption', autoH: true, text: 'old stuff', box: { x: 60, y: 60, w: 400, h: 60 }, style: { fontSize: 36, color: '#fff' } });
  const aliases = createAliasMap(); aliases.sync(doc);
  const r = applyOp(doc, { op: 'template', template: 'x-post-ad', params: { body: 'Held all day. Zero grease.' } }, { aliases });
  assert.match(r, /template x-post-ad/);
  assert.equal(doc.layers.some((l) => l.id === 'old'), false, 'old layers replaced');
  assert.equal(doc.layers[0].role, 'base', 'base kept');
  const findings = lintDesign(doc);
  assert.ok(findings.length <= 2, `x-post-ad near-lint-clean (got: ${findings.join(' | ')})`);
});

test('aliases and detection map to archetypes', () => {
  assert.equal(buildTemplate('tweet', mkDoc({ w: 1080, h: 1350 })).def.id, 'x-post-ad');
  assert.equal(detectTemplate('make me a twitter testimonial ad'), 'x-post-ad');
  assert.equal(detectTemplate('a before and after for the curl cream'), 'before-after');
  assert.equal(detectTemplate('us vs them comparison against typical tubes'), 'comparison');
  assert.equal(detectTemplate('9:16 story with hook pills'), 'story-native');
  assert.equal(detectTemplate('Save £48 on your first bundle'), 'offer-hero');
  assert.equal(detectTemplate('just a nice product ad'), null);
});

test('unknown template throws with the archetype list', () => {
  const doc = mkDoc({ w: 1080, h: 1080 });
  assert.throws(() => applyOp(doc, { op: 'template', template: 'nope' }, {}), /story-native, x-post-ad/);
});

test('ig-dm benchmark: full thread anatomy inside the card, gradient progression', () => {
  const doc = { id: 't', canvas: { w: 1080, h: 1920 }, createdAt: 1, updatedAt: 1, layers: [
    { id: 'base-1', type: 'shape', role: 'base', box: { x: 0, y: 0, w: 1080, h: 1920 }, style: { background: '#fff' } },
  ] };
  const { layers } = buildTemplate('ig-dm', doc, {});
  const names = [];
  walkNodes(layers, (l) => names.push(l.name || l.role));
  for (const need of ['Frame', 'Caption', 'DM card', 'Divider label', 'Replied label', 'Quote bar', 'Avatar']) {
    assert.ok(names.some((n) => String(n).includes(need)), `${need} present`);
  }
  // every bubble inside the card, sent bubbles get progressively bluer (r channel falls)
  let card = null;
  walkNodes(layers, (l) => { if (l.name === 'DM card') card = l; });
  const sent = [];
  walkNodes(layers, (l) => {
    if (l.name === 'My message') sent.push(l);
    if (l.name && /message|bubble/i.test(l.name) && l.box) {
      assert.ok(l.box.x >= card.box.x && l.box.x + l.box.w <= card.box.x + card.box.w + 1, `${l.text?.slice(0, 15)} inside card x`);
      assert.ok(l.box.y >= card.box.y && l.box.y + l.box.h <= card.box.y + card.box.h + 1, `${l.text?.slice(0, 15)} inside card y`);
    }
  });
  assert.ok(sent.length >= 3, 'multiple sent bubbles');
  const reds = sent.map((l) => parseInt(l.style.background.slice(1, 3), 16));
  assert.ok(reds[0] > reds[reds.length - 1], `gradient: top sent bubble more purple than bottom (${reds.join(',')})`);
});

test('new presets (ig-feed-post, notes-checklist, imessage) build in-canvas, ≥2 texts, lint ≤2', () => {
  for (const id of ['ig-feed-post', 'notes-checklist', 'imessage']) {
    const canvas = { w: 1080, h: 1350 };
    const doc = mkDoc(canvas);
    const { layers } = buildTemplate(id, doc, {});
    let texts = 0;
    walkNodes(layers, (l) => {
      if (l.text) texts++;
      if (!l.box) return;
      assert.ok(l.box.x >= -1 && l.box.y >= -1, `${id}/${l.name} inside canvas`);
      assert.ok(l.box.x + l.box.w <= canvas.w + 2, `${id}/${l.name} inside canvas w`);
      assert.ok(l.box.y + l.box.h <= canvas.h + 2, `${id}/${l.name} inside canvas h`);
    });
    assert.ok(texts >= 2, `${id} has ≥2 texts (${texts})`);
    doc.layers = [doc.layers[0], ...layers];
    const findings = lintDesign(doc);
    assert.ok(findings.length <= 2, `${id} lint ≤2 (got: ${findings.join(' | ')})`);
  }
});

test('detection + aliases reach the new presets', () => {
  assert.equal(detectTemplate('make an instagram feed post'), 'ig-feed-post');
  assert.equal(detectTemplate('a checklist note screenshot'), 'notes-checklist');
  assert.equal(detectTemplate('an imessage thread with mom'), 'imessage');
  assert.equal(buildTemplate('ig-post', mkDoc({ w: 1080, h: 1350 })).def.id, 'ig-feed-post');
  // sms routes to the dedicated GREEN thread now — the old sms→imessage alias produced BLUE sent
  // bubbles, which real SMS never has (research-confirmed fix).
  assert.equal(buildTemplate('sms', mkDoc({ w: 1080, h: 1350 })).def.id, 'sms');
  assert.equal(detectTemplate('a green bubble sms convo'), 'sms');
  assert.equal(detectTemplate('facebook post testimonial ad'), 'fb-post');
});

test('sms template renders GREEN sent bubbles + "Text Message" composer; imessage stays blue', () => {
  const flatten = (ns, out = []) => { ns.forEach((n) => { out.push(n); if (n.children) flatten(n.children, out); }); return out; };
  const sms = flatten(buildTemplate('sms', mkDoc({ w: 1080, h: 1350 })).layers);
  assert.equal(sms.find((n) => n.name === 'Sent bubble')?.style?.background, '#34c759');
  assert.equal(sms.find((n) => n.name === 'Send button')?.style?.background, '#34c759');
  assert.equal(sms.find((n) => n.name === 'Placeholder')?.text, 'Text Message');
  const im = flatten(buildTemplate('imessage', mkDoc({ w: 1080, h: 1350 })).layers);
  assert.equal(im.find((n) => n.name === 'Sent bubble')?.style?.background, '#0a84ff');
});

test('fb-post template builds the FDS structure (header/body/photo/meta/actions)', () => {
  const { def, layers } = buildTemplate('fb-post', mkDoc({ w: 1080, h: 1350 }));
  assert.equal(def.id, 'fb-post');
  const names = layers.map((l) => l.name || l.role);
  for (const part of ['Header', 'Post text', 'Meta', 'Actions']) {
    assert.ok(names.some((n) => String(n).includes(part)), `has ${part}`);
  }
  const flatten = (ns, out = []) => { ns.forEach((n) => { out.push(n); if (n.children) flatten(n.children, out); }); return out; };
  const flat = flatten(layers);
  assert.equal(flat.find((n) => n.name === 'Post text')?.style?.color, '#050505'); // FDS primary
  assert.equal(flat.find((n) => n.name === 'Time')?.style?.color, '#65676b');      // FDS secondary
});

test('avatar pixelate effect emits a distinct mosaic (not just blur) on x-post-ad', () => {
  const doc = mkDoc({ w: 1080, h: 1350 });
  const { layers } = buildTemplate('x-post-ad', doc, { avatarEffect: 'pixelate' });
  const mosaic = [];
  walkNodes(layers, (l) => { if (/Mosaic/.test(l.name || '')) mosaic.push(l); });
  assert.ok(mosaic.length >= 8, `pixelate emits a mosaic grid (got ${mosaic.length} cells)`);
  // mosaic cells are solid blocks, NOT a gaussian blur
  assert.ok(mosaic.every((c) => c.style && c.style.background && !c.style.blur), 'mosaic cells are solid blocks');
  // and blur mode is still a single blurred circle (regression guard)
  const blurDoc = mkDoc({ w: 1080, h: 1350 });
  const { layers: bl } = buildTemplate('x-post-ad', blurDoc, { avatarEffect: 'blur' });
  let blurred = null;
  walkNodes(bl, (l) => { if (l.name === 'Avatar' && l.style && l.style.blur) blurred = l; });
  assert.ok(blurred, 'blur effect still yields a blurred avatar circle');
});

test('x-post-ad quote-tweet media card builds inside canvas', () => {
  const doc = mkDoc({ w: 1080, h: 1350 });
  const { layers } = buildTemplate('x-post-ad', doc, { media: 'quote' });
  let quote = null;
  walkNodes(layers, (l) => { if (l.name === 'Quote tweet') quote = l; });
  assert.ok(quote, 'quote-tweet card present');
  walkNodes([quote], (l) => {
    if (!l.box) return;
    assert.ok(l.box.x + l.box.w <= 1080 + 2 && l.box.y + l.box.h <= 1350 + 2, `${l.name} inside canvas`);
  });
});

test('ig-dm agent edit: setText on a bubble re-flows the whole thread', () => {
  const doc = { id: 't', canvas: { w: 1080, h: 1920 }, createdAt: 1, updatedAt: 1, layers: [
    { id: 'base-1', type: 'shape', role: 'base', box: { x: 0, y: 0, w: 1080, h: 1920 }, style: { background: '#fff' } },
  ] };
  applyOp(doc, { op: 'template', template: 'ig-dm' }, {});
  const bubble = (() => { let b = null; walkNodes(doc.layers, (l) => { if (!b && l.name === 'Their message') b = l; }); return b; })();
  const beforeW = bubble.box.w;
  const r = applyOp(doc, { op: 'setText', id: bubble.id, text: 'ok' }, {});
  assert.match(r, /re-flowed/);
  const after = (() => { let b = null; walkNodes(doc.layers, (l) => { if (l.id === bubble.id) b = l; }); return b; })();
  assert.ok(after, 'bubble id preserved across the rebuild');
  assert.equal(after.text, 'ok');
  assert.ok(after.box.w < beforeW, `bubble re-hugged shorter text (${after.box.w} < ${beforeW})`);
});
