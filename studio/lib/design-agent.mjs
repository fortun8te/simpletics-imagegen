// lib/design-agent.mjs — the agentic half of Design mode, v2: tiny-model-proof.
//
// The agent NAVIGATES THE SCENE GRAPH, not pixels. v3 docs are trees (groups with absolute
// child coords); ops resolve targets via lib/scene-tree.mjs so nesting works. Every op is
// validated + auto-repaired + clamped here — the model is never trusted.
//
// v2 additions:
//   • element / setParams — parametric element library (lib/elements.mjs) with brand-kit defaults
//   • align — canvas-relative alignment with 5% margins
//   • short-id aliases (L1…/g1…) so tiny models never have to echo long generated ids
//   • compressed observations (OBS_TOKEN_BUDGET est tokens max) with element instances collapsed
//   • auto-repair: numbers-as-strings coerced, bare 6-hex colors get '#', enums echoed on failure
//   • coherence guards: soft 12-col grid snap on move/resize/add/element + clamp inside canvas
//   • improve mode: instruction auto-composed from lib/design-lint.mjs findings
//   • draftCopy — one-shot {headline, subline, cta} suggestions (does not mutate the doc)
//
// v4 additions:
//   • coherence guards log repairs into op summaries: grid snap "(grid)", brand-kit color
//     soft-snap "(kit)", radius quantization to the doc's radius set "(doc)"
//   • DESIGN PRINCIPLES block in the system prompt (dominant size / 12-col grid / ≤2 fonts,
//     ≤3 colors / breathing room / contrast / compose-don't-scatter)
//   • run memory: buildRunMemory(docId) compresses the last ≤3 agent chat results into
//     "earlier: …" lines injected into the system prompt (≤ ~90 est tokens)
//   • element op accepts legacy alias ids (ELEMENT_ALIASES → canonical def + preset params)
//
// v6 additions:
//   • FAST PATH: isTrivialEdit() routes short single-target edits ("make the headline bigger")
//     into 1-2 turns with a minimal prompt + scoped 500-token observation, no lint gate — zero
//     applied ops escalates to the untouched full loop
//   • {"op":"center", id, axis:'x'|'y'|'both'} — first-class canvas centering (no pixel math)
//   • deliberate text placement: added text snaps to canvas center or an existing column edge,
//     with style.align kept consistent with the box; near-center moves snap exact
//   • main-turn vision: when LM Studio serves the worker (a gemma VL model), turn 0 of each
//     batch includes the actual render; visionRefine drops 2→1 rounds then
//
// Model priority: llmText (DeepSeek / any OpenAI-compatible endpoint) via the BATCHED
// plan-act-verify harness (lib/agent-harness.mjs runBatchAgent, v5) → codex CLI single-shot
// (legacy) → deterministic fallback. Lint runs IN the loop and gates "done"; generation mode
// seeds from templates + retrieval exemplars (lib/layout-library.mjs) and samples best-of-N
// scored by layoutScore. The "draftText" op is an in-loop copywriter with per-layer char
// budgets computed from the real boxes.
//
// Op grammar (validated here):
//   { "op":"element",  "element", "x"?, "y"?, "w"?, "params"? }   (insert from the element library)
//   { "op":"setParams","id"|"role", "params":{…} }                (rebuild an element instance)
//   { "op":"move",     "id"|"role", "x", "y" }                    (groups move with their children)
//   { "op":"align",    "id"|"ids", "h"?, "v"? }                   (left|center|right / top|middle|bottom)
//   { "op":"resize",   "id"|"role", "w", "h" }
//   { "op":"setText",  "id"|"role", "text" }
//   { "op":"setStyle", "id"|"role", "style":{…} }                 (STYLE_KEYS whitelist; rotation → node.rotation)
//   { "op":"remove",   "id"|"role" }
//   { "op":"group",    "ids":[…], "name"? }                       (must share one parent list)
//   { "op":"ungroup",  "id" }
//   { "op":"reparent", "id", "into": groupId|null, "index"? }     (validated but not advertised in the prompt)
//   { "op":"add",      "layer":{type,role,text,box,style} }       (type:'image' becomes a gray placeholder)
//   { "op":"autolayout" }                                          (ZERO-token deterministic layout pass)
//   { "op":"done",     "summary"? }

import { codexText } from './codex-text.mjs';
import { llmText, llmVision, hasLlm, llmInfo } from './llm.mjs';
import { runBatchAgent, parseBatch } from './agent-harness.mjs';
import { exemplarBlock, aspectTag, indexLayout, docSkeleton } from './layout-library.mjs';
import { ELEMENTS, ELEMENT_ALIASES, buildElement, elementCatalogLine, applyElementTextEdit } from './elements.mjs';
import { buildTemplate, templateCatalog, detectTemplate, applyTemplateTextEdit } from './templates.mjs';
import { lookAtComp, renderCompPng } from './self-vision.mjs';

import { lintDesign, parseColor, luminance } from './design-lint.mjs';
import { getChat } from './designstore.mjs';
import { autoLayoutDoc, layoutScore } from './layout-engine.mjs';
import { repairTextLayer, roleFontSize, typeScaleLine } from './type-scale.mjs';
import { loadBrandSkill } from './brand-skills.mjs';
import { verifyDesign, verifySummary } from './design-verify.mjs';
import {
  isGenerateIntent, seedFromTemplate, buildGeneratePrompt, filterGenerateOp,
} from './generation-mode.mjs';
import { smartAdRepair, visualContextBlock } from './ad-context.mjs';
import {
  walkNodes, leaves, findNode, findParentList, groupBounds, normalizeGroups, translateNode,
  countNodes, scaleNodeInto,
} from './scene-tree.mjs';

const MAX_OPS = 10;       // codex single-shot cap (legacy)
const MAX_TURNS = 12;     // ONE global LLM-turn budget per run — headroom for complex multi-part asks
const MAX_OPS_PER_TURN = 6;
const MAX_CONCURRENT = 2;
const OBS_TOKEN_BUDGET = 1200;   // est tokens (chars/4) per observation — 32k-context safe
let inFlight = 0;

const STYLE_KEYS = new Set([
  'fontSize', 'fontWeight', 'color', 'background', 'radius', 'align', 'lineHeight', 'padding',
  'shadow', 'uppercase', 'opacity', 'letterSpacing', 'gradient',
  'pill', 'vignette', 'stroke', 'effects', 'autoH',
  // v2 additions (mirrors src/lib/sceneGraph.ts LayerStyle). backdropBlur (glass) is back —
  // real frosted panels for over-photo product cards (benchmark 129); renders in DOM/HTML/Figma.
  'rotation', 'strikethrough', 'fontFamily', 'blend', 'blur', 'backdropBlur', 'radiusCorners',
  'shapeKind', 'spikes', 'flipDiag', 'points', 'fit',
]);

// numeric style keys — '84' is coerced to 84 with a repair note
const NUM_STYLE_KEYS = new Set([
  'fontSize', 'fontWeight', 'radius', 'lineHeight', 'padding', 'opacity', 'letterSpacing',
  'rotation', 'blur', 'backdropBlur', 'spikes',
]);
const COLOR_STYLE_KEYS = new Set(['color', 'background']);
const STYLE_ENUMS = {
  // restricted 2026-07: only the modes that map cleanly across all 5 renderers
  blend: ['normal', 'multiply', 'screen', 'overlay'],
  shapeKind: ['rect', 'ellipse', 'starburst', 'arrow', 'line', 'polyline'],
  align: ['left', 'center', 'right'],
  fit: ['cover', 'contain'],
};

const LEAF_TYPES = new Set(['image', 'text', 'badge', 'button', 'shape', 'vignette']);

const clamp = (v, min, max) => Math.max(min, Math.min(max, Number(v) || 0));

// ── Duplicate-suppression ("same product 40 times") ──────────────────────────────────────────
// An inserted element/product that lands essentially ON TOP of an existing same-kind node is a
// runaway duplicate — not an intentional row. IoU on absolute-pixel boxes; >0.82 = the same spot.
// Intentional repeats (stars, hook pills) sit in a spaced row → low IoU → never blocked.
function boxIoU(a, b) {
  if (!a || !b) return 0;
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = ix * iy;
  if (inter <= 0) return 0;
  const uni = a.w * a.h + b.w * b.h - inter;
  return uni > 0 ? inter / uni : 0;
}
/** An existing top-level non-base node of the SAME element-def (or role) whose box nearly
 *  coincides with `box` — i.e. inserting here would just stack a duplicate. */
function findDuplicateSpot(doc, box, { elementId = null, role = null } = {}) {
  for (const n of doc.layers) {
    if (!n || n.role === 'base' || !n.box) continue;
    const sameKind = (elementId && n.element && n.element.id === elementId) || (role && n.role === role);
    if (sameKind && boxIoU(n.box, box) > 0.82) return n;
  }
  return null;
}
const label = (n) => n.role || n.name || n.id;

let addSeq = 0;
const newId = (prefix) => `${prefix}-${Date.now().toString(36)}-${(addSeq++).toString(36)}`;

// ── final-deliverable grouping ─────────────────────────────────────────────────────────────────
// A finished, usable ad has HIERARCHY, not a flat pile of 50 leaves (Michael: "the agent's output
// is difficult to use and requires extensive editing"). When a generated comp is still flat at the
// top level (the element-seed path, not a template scaffold), fold its non-base leaves into named
// REGION groups by vertical band + role so the layer tree reads header / body / product / cta.
const REGION_LABEL = { header: 'Header', body: 'Body', product: 'Product', cta: 'CTA' };
const REGION_SEQ = ['header', 'body', 'product', 'cta'];

/** Region bucket for a top-level leaf by role + vertical position. */
function leafRegion(node, ch) {
  const role = String(node?.role || '').toLowerCase();
  const cy = (Number(node?.box?.y) || 0) / Math.max(1, ch);
  if (/cta|button/.test(role) || node?.type === 'button') return 'cta';
  if (/product|avatar|image|photo|logo/.test(role) || node?.type === 'image') return 'product';
  if (/headline|title|nav|header|badge/.test(role) && cy < 0.28) return 'header';
  if (cy < 0.2) return 'header';
  if (cy > 0.82) return 'cta';
  return 'body';
}

/**
 * Fold flat top-level leaves into named region groups (header/body/product/cta) so a generated
 * comp ships with a clean hierarchy. Only groups a region with 2+ members; a lone member stays a
 * top-level leaf. Existing groups and base/background layers are left untouched. Mutates doc.
 * Returns the number of groups created.
 */
export function groupIntoRegions(doc) {
  const { h: ch } = doc.canvas || { h: 1 };
  const top = doc.layers || [];
  // already grouped? (a template scaffold / prior grouping) — leave it alone
  const looseLeaves = top.filter((n) => n && n.type !== 'group' && n.role !== 'base' && n.role !== 'background');
  if (top.some((n) => n && n.type === 'group') || looseLeaves.length < 3) return 0;
  const keep = top.filter((n) => n && (n.type === 'group' || n.role === 'base' || n.role === 'background'));
  const buckets = { header: [], body: [], product: [], cta: [] };
  for (const n of looseLeaves) {
    try { buckets[leafRegion(n, ch)].push(n); } catch { keep.push(n); }
  }
  const out = [...keep];
  let made = 0;
  for (const key of REGION_SEQ) {
    const kids = buckets[key];
    if (kids.length >= 2) {
      out.push({ id: newId('group'), type: 'group', name: REGION_LABEL[key], box: groupBounds(kids) || { x: 0, y: 0, w: 0, h: 0 }, children: kids });
      made++;
    } else if (kids.length === 1) {
      out.push(kids[0]);
    }
  }
  doc.layers = out;
  normalizeGroups(doc);
  return made;
}

// ── auto-repair helpers ──────────────────────────────────────────────────────────────────────────

/** '42' → 42 (with a repair note); non-numeric → throw with the expected shape. */
function repairNum(v, key, notes) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const n = Number(String(v).trim());
  if (Number.isFinite(n)) { notes.push(`${key} "${v}"→${n}`); return n; }
  throw new Error(`"${key}" must be a number (got ${JSON.stringify(v)})`);
}

/** '2c5cff' → '#2c5cff' (with a repair note). */
function repairColor(v, key, notes) {
  if (typeof v !== 'string') return v;
  const c = v.trim();
  if (/^[0-9a-fA-F]{6}$/.test(c) || /^[0-9a-fA-F]{3}$/.test(c)) { notes.push(`${key} "${v}"→"#${c}"`); return `#${c}`; }
  return c;
}

const noteStr = (notes) => (notes.length ? ` (repaired: ${notes.join(', ')})` : '');

/** After mutating a textual layer, snap typography + grow autoH box.h (server-side). */
function touchText(node, doc, notes = []) {
  if (!node || node.type === 'group') return notes;
  const repaired = repairTextLayer(node, doc);
  return notes.concat(repaired);
}

/** Soft-snap a coordinate to the 12-column grid (unit = canvas.w/12) when within 8px. */
function snapGrid(v, cw) {
  const col = cw / 12;
  const s = Math.round(v / col) * col;
  return Math.abs(s - v) <= 8 ? Math.round(s) : Math.round(v);
}

/** snapGrid + a repair note when the snap actually moved the value (coherence guard, v4). */
function snapGridNote(v, cw, key, notes) {
  const r = Math.round(Number(v) || 0);
  const s = snapGrid(v, cw);
  if (s !== r) notes.push(`${key} ${r}→${s} (grid)`);
  return s;
}

/** Deliberate placement for agent-ADDED text ("text appears randomly placed"): a box whose
 *  center lands within 6% of the canvas center snaps to the EXACT center (and gets
 *  align:center so glyphs match the box); otherwise the left edge snaps to the nearest
 *  existing text column edge within 24px (and gets align:left). Mutates box/style; logs notes. */
function placeTextBox(doc, box, style, notes) {
  const { w: cw } = doc.canvas;
  const offCenter = box.x + box.w / 2 - cw / 2;
  if (Math.abs(offCenter) <= cw * 0.06) {
    const nx = Math.round((cw - box.w) / 2);
    if (nx !== box.x) { notes.push(`x ${box.x}→${nx} (centered)`); box.x = nx; }
    if (!style.align) style.align = 'center';
    return;
  }
  let best = null;
  let bestD = 25;
  for (const n of leaves(doc.layers || [])) {
    if (!n.box || n.text == null || n.hidden) continue;
    const d = Math.abs(n.box.x - box.x);
    if (d > 0 && d < bestD) { bestD = d; best = n.box.x; }
  }
  if (best != null) { notes.push(`x ${box.x}→${best} (column)`); box.x = best; }
  if (!style.align) style.align = 'left';
}

const KIT_SNAP_DIST = 60; // Manhattan RGB tolerance for the brand-kit color soft-snap

/** Soft-snap a color to the nearest brand-kit color (plus pure white/black) when within
 *  KIT_SNAP_DIST — a cheap ΔE stand-in. Logs a repair note on change. */
function snapKitColor(v, kit, key, notes) {
  const kitColors = kit && Array.isArray(kit.colors) ? kit.colors : [];
  // <2 kit colors = no real palette to snap to (matches lint's off-kit threshold) — a 1-color
  // kit would otherwise pull every deliberate accent toward that single color.
  if (kitColors.length < 2) return v;
  const rgb = parseColor(v);
  if (!rgb) return v;
  let best = null;
  let bestD = Infinity;
  for (const kc of [...kitColors, '#ffffff', '#000000']) {
    const kr = parseColor(kc);
    if (!kr) continue;
    const d = Math.abs(rgb[0] - kr[0]) + Math.abs(rgb[1] - kr[1]) + Math.abs(rgb[2] - kr[2]);
    if (d < bestD) { bestD = d; best = kc; }
  }
  if (best && bestD > 0 && bestD <= KIT_SNAP_DIST && String(best).toLowerCase() !== String(v).toLowerCase()) {
    notes.push(`${key} ${v}→${best} (kit)`);
    return best;
  }
  return v;
}

/** Quantize a radius to the doc's existing radius set when within 4px (excluding the target
 *  node's own current radius so small deliberate tweaks aren't undone). */
function quantizeRadius(v, doc, excludeId, notes) {
  let best = null;
  let bestD = Infinity;
  for (const n of leaves(doc.layers || [])) {
    if (n.id === excludeId) continue;
    const r = n.style && n.style.radius;
    if (!Number.isFinite(r)) continue;
    const d = Math.abs(r - v);
    if (d < bestD) { bestD = d; best = r; }
  }
  if (best != null && bestD > 0 && bestD <= 4) {
    notes.push(`radius ${v}→${best} (doc)`);
    return best;
  }
  return v;
}

// ── reactive contrast-pair guard (v4.1) ─────────────────────────────────────────────────────────
// The existing smartAdRepair contrast flip (lib/ad-context.mjs) only fixes text color against
// what's UNDERNEATH the layer in the doc (a scrim, a photo, a solid base) and runs as a blanket
// FINAL pass. It does NOT catch the specific case Michael flagged: the user's OWN instruction sets
// color/background on a node that has BOTH already set on ITSELF (e.g. an ig-caption pill: text
// color + its own background), and the literal edit collides with the property left untouched
// (black caption text requested on a pill whose own background is already near-black → invisible).
// This fires precisely on the setStyle op that just ran, on the node's own color/background pair,
// complementing (not duplicating) the final pass: this is "the exact thing the user just touched",
// the final pass is "everything else in the doc".
const MIN_SELF_CONTRAST = 0.35; // luminance delta below which text-on-its-own-background reads as invisible/near-invisible

/**
 * After a setStyle op changes 'color' or 'background' on a node that has BOTH set, check the
 * resulting self-contrast (text color vs that node's own background — e.g. a pill/badge/card).
 * If inadequate, auto-correct the OTHER property to a contrasting value and return a note
 * describing the flip; returns '' when no correction was needed/applicable.
 */
function reactiveContrastGuard(node, changedKeys) {
  if (!node || node.type === 'group' || !node.style) return '';
  const touchedColorPair = changedKeys.includes('color') || changedKeys.includes('background');
  if (!touchedColorPair) return '';
  const { color, background } = node.style;
  if (!color || !background) return ''; // needs BOTH set to be a contrast pair worth checking
  const fg = parseColor(color);
  const bg = parseColor(background);
  if (!fg || !bg) return '';
  const delta = Math.abs(luminance(fg) - luminance(bg));
  if (delta >= MIN_SELF_CONTRAST) return '';
  // Inadequate contrast: honor the literal instruction (keep what the user's op just set) and
  // adapt the OTHER property so the result is legible. If the user set 'color' this op, flip
  // 'background' to contrast with it; if the user set 'background' (and not 'color'), flip
  // 'color' instead. If somehow both were set in the same op, flip the background — matches
  // Michael's example ("make the caption black" → flips the pill, keeps the requested text color).
  const userSetColor = changedKeys.includes('color');
  const userSetBg = changedKeys.includes('background');
  const fgLum = luminance(fg);
  const bgLum = luminance(bg);
  if (userSetBg && !userSetColor) {
    const newColor = bgLum < 0.5 ? '#ffffff' : '#111111';
    if (newColor.toLowerCase() !== String(color).toLowerCase()) {
      node.style.color = newColor;
      return `auto-flipped color → ${newColor} (was invisible against its background)`;
    }
    return '';
  }
  const newBg = fgLum < 0.5 ? '#ffffff' : '#111111';
  if (newBg.toLowerCase() !== String(background).toLowerCase()) {
    node.style.background = newBg;
    return `auto-flipped background → ${newBg} (was invisible against text color)`;
  }
  return '';
}

// ── short-id alias map ───────────────────────────────────────────────────────────────────────────

/** Per-run alias map: L1…/g1… assigned in tree order once; new nodes get the next number;
 *  ids are NEVER renumbered. resolve(): alias → real id (falls through to id/role lookup). */
export function createAliasMap() {
  const idToAlias = new Map();
  const aliasToId = new Map();
  let lSeq = 0;
  let gSeq = 0;
  return {
    sync(doc) {
      walkNodes(doc.layers || [], (n) => {
        if (!idToAlias.has(n.id)) {
          const a = n.type === 'group' ? `g${++gSeq}` : `L${++lSeq}`;
          idToAlias.set(n.id, a);
          aliasToId.set(a, n.id);
        }
      });
    },
    alias(id) { return idToAlias.get(id) || id; },
    resolve(ref) { return aliasToId.get(String(ref)) || ref; },
  };
}

/** Resolve an op target: alias → real id → role. */
function resolveNode(doc, ref, ctx) {
  if (!ref) return null;
  return findNode(doc, ctx && ctx.aliases ? ctx.aliases.resolve(ref) : ref);
}

/** Apply one validated op in place on the doc tree. Returns a human summary string,
 *  { done:true, summary } for the done op, or null when the op is invalid. Throws with an
 *  explanatory message (echoing expected values) on repairable-looking hard failures so the
 *  harness retry quotes them back to the model.
 *  ctx: { kit?, aliases?, lastTarget? } — kit feeds element builds; aliases resolve short ids;
 *  ctx.lastTarget is written so observations can keep the touched instance expanded. */
export function applyOp(doc, op, ctx = {}) {
  if (!op || typeof op !== 'object') return null;
  const { w: cw, h: ch } = doc.canvas;
  const ref = op.id || op.role;
  const node = ref ? resolveNode(doc, ref, ctx) : null;
  const aliasOf = (id) => (ctx.aliases ? ctx.aliases.alias(id) : id);
  const touch = (n) => { if (n) ctx.lastTarget = n.id; };

  switch (op.op) {
    case 'done':
      return { done: true, summary: op.summary ? String(op.summary).slice(0, 120) : 'done' };

    case 'autolayout': {
      const r = autoLayoutDoc(doc, { kit: ctx.kit });
      normalizeGroups(doc);
      if (ctx.aliases) ctx.aliases.sync(doc);
      return r.summary;
    }

    case 'template': {
      // whole-ad archetype scaffold (story-native, x-post-ad, before-after, comparison,
      // offer-hero) — replaces every non-base layer with the archetype's full composition
      const { def, layers: built } = buildTemplate(op.template, doc, op.params || {}, ctx.kit || undefined);
      if (!def) throw new Error(`unknown template "${op.template}" — expected one of: story-native, x-post-ad, before-after, comparison, offer-hero`);
      doc.layers = doc.layers.filter((n) => n.role === 'base');
      doc.layers.push(...built);
      normalizeGroups(doc);
      if (ctx.aliases) ctx.aliases.sync(doc);
      return `template ${def.id} → ${built.length} layers (edit copy with setText, swap gray image slots for real shots)`;
    }

    case 'element': {
      // legacy alias ids (ELEMENT_ALIASES) are accepted — buildElement resolves them to the
      // canonical def with preset params and stamps the canonical id on the instance
      const alias = ELEMENT_ALIASES[op.element];
      const def = ELEMENTS.find((e) => e.id === op.element) || (alias && ELEMENTS.find((e) => e.id === alias.id));
      if (!def) throw new Error(`unknown element "${op.element}" — expected one of: ${ELEMENTS.map((e) => e.id).join(', ')}`);
      const inst = buildElement(op.element, doc, op.params || {}, ctx.kit || undefined)[0];
      if (!inst) return null;
      const notes = [];
      if (op.w !== undefined) {
        const nw = clamp(repairNum(op.w, 'w', notes), 40, cw);
        const ratio = inst.box.w ? nw / inst.box.w : 1;
        const nh = clamp(Math.round(inst.box.h * ratio), 20, ch);
        scaleNodeInto(inst, { ...inst.box }, { x: inst.box.x, y: inst.box.y, w: nw, h: nh });
        if (inst.element) inst.element.userScale = ratio; // future setParams rebuilds honor this
      }
      const tx = op.x !== undefined ? repairNum(op.x, 'x', notes) : inst.box.x;
      const ty = op.y !== undefined ? repairNum(op.y, 'y', notes) : inst.box.y;
      const gx = clamp(snapGridNote(clamp(tx, 0, Math.max(0, cw - inst.box.w)), cw, 'x', notes), 0, Math.max(0, cw - inst.box.w));
      const gy = clamp(Math.round(ty), 0, Math.max(0, ch - inst.box.h)); // y never grid-snapped (12-col unit is a width unit)
      translateNode(inst, gx - inst.box.x, gy - inst.box.y);
      // Guard the runaway "same product 40 times": if this element would stack on top of an
      // existing same-def node, skip it and tell the agent it is already present.
      const dupe = findDuplicateSpot(doc, inst.box, { elementId: def.id, role: inst.role });
      if (dupe) return `already present — ${def.id} exists at ${aliasOf(dupe.id)} (${dupe.box.x},${dupe.box.y}); not duplicated`;
      doc.layers.push(inst);
      normalizeGroups(doc);
      if (ctx.aliases) ctx.aliases.sync(doc);
      walkNodes([inst], (n) => { if (n.type !== 'group') touchText(n, doc, notes); });
      touch(inst);
      return `element ${def.id} → ${aliasOf(inst.id)} @ ${inst.box.x},${inst.box.y} ${inst.box.w}×${inst.box.h}${noteStr(notes)}`;
    }

    case 'setParams': {
      if (!node) return null;
      if (!node.element || !node.element.id) {
        throw new Error(`${aliasOf(node.id)} is not an element instance — setParams only works on nodes inserted via {"op":"element"}`);
      }
      // instances are stamped with the canonical id, but tolerate alias-stamped older docs
      const elAlias = ELEMENT_ALIASES[node.element.id];
      const def = ELEMENTS.find((e) => e.id === node.element.id) || (elAlias && ELEMENTS.find((e) => e.id === elAlias.id));
      if (!def) return null;
      if (!op.params || typeof op.params !== 'object') throw new Error('setParams needs a "params" object');
      const merged = { ...node.element.params, ...op.params };
      const fresh = buildElement(node.element.id, doc, merged, ctx.kit || undefined)[0];
      if (!fresh) return null;
      // v2: rebuild keeps POSITION but takes its natural measured size — squeezing the fresh
      // content into the old bounds (geometric scaling) distorted fonts and re-clipped text.
      // A deliberate user resize is honored via the explicit scale ratio when one was applied.
      const oldBox = { ...node.box };
      const userScale = node.element.userScale;
      if (userScale && Number.isFinite(userScale) && userScale !== 1) {
        scaleNodeInto(fresh, { ...fresh.box }, {
          x: fresh.box.x, y: fresh.box.y,
          w: Math.round(fresh.box.w * userScale), h: Math.round(fresh.box.h * userScale),
        });
        fresh.element.userScale = userScale;
      }
      translateNode(fresh, oldBox.x - fresh.box.x, oldBox.y - fresh.box.y);
      fresh.id = node.id;
      fresh.name = node.name;
      if (node.locked) fresh.locked = node.locked;
      const list = findParentList(doc, node.id);
      if (!list) return null;
      list.splice(list.indexOf(node), 1, fresh);
      normalizeGroups(doc);
      if (ctx.aliases) ctx.aliases.sync(doc);
      touchText(fresh, doc);
      touch(fresh);
      return `setParams ${aliasOf(fresh.id)} (${def.id}) → ${Object.keys(op.params).join(', ')}`;
    }

    case 'align': {
      const H = ['left', 'center', 'right'];
      const V = ['top', 'middle', 'bottom'];
      if (op.h !== undefined && !H.includes(op.h)) throw new Error(`"h" must be one of: ${H.join('|')}`);
      if (op.v !== undefined && !V.includes(op.v)) throw new Error(`"v" must be one of: ${V.join('|')}`);
      if (op.h === undefined && op.v === undefined) throw new Error('align needs "h" and/or "v"');
      const refs = Array.isArray(op.ids) ? op.ids : ref ? [ref] : [];
      const nodes = refs.map((r) => resolveNode(doc, r, ctx)).filter((n) => n && n.role !== 'base' && !n.locked);
      if (!nodes.length) throw new Error('align: no movable targets found — pass "id" or "ids" with short ids from the observation');
      const mx = Math.round(cw * 0.05);
      const my = Math.round(ch * 0.05);
      const moved = [];
      for (const n of nodes) {
        let nx = n.box.x;
        let ny = n.box.y;
        if (op.h === 'left') nx = mx;
        if (op.h === 'center') nx = Math.round((cw - n.box.w) / 2);
        if (op.h === 'right') nx = cw - n.box.w - mx;
        if (op.v === 'top') ny = my;
        if (op.v === 'middle') ny = Math.round((ch - n.box.h) / 2);
        if (op.v === 'bottom') ny = ch - n.box.h - my;
        nx = clamp(nx, 0, Math.max(0, cw - n.box.w));
        ny = clamp(ny, 0, Math.max(0, ch - n.box.h));
        translateNode(n, nx - n.box.x, ny - n.box.y);
        moved.push(aliasOf(n.id));
        touch(n);
      }
      normalizeGroups(doc);
      return `align ${moved.join('+')} → ${[op.h, op.v].filter(Boolean).join('/')}`;
    }

    case 'center': {
      // first-class canvas centering — models were computing (cw-w)/2 pixel math by hand and
      // getting it wrong ("text appears randomly placed"). {op:'center', id, axis:'x'|'y'|'both'}.
      if (!node) throw new Error(`unknown target "${ref}" — use a short id from the observation (L1, g2) or a role`);
      if (node.role === 'base') throw new Error('the base image cannot be moved');
      if (node.locked) throw new Error(`${aliasOf(node.id)} is locked — pick another node`);
      const axis = ['x', 'y', 'both'].includes(op.axis) ? op.axis : 'x';
      let nx = node.box.x;
      let ny = node.box.y;
      if (axis !== 'y') nx = Math.round((cw - node.box.w) / 2);
      if (axis !== 'x') ny = Math.round((ch - node.box.h) / 2);
      translateNode(node, clamp(nx, 0, Math.max(0, cw - node.box.w)) - node.box.x, clamp(ny, 0, Math.max(0, ch - node.box.h)) - node.box.y);
      // a centered text box with left-aligned glyphs still READS off-center — keep them consistent
      const notes = [];
      if (axis !== 'y' && node.type !== 'group' && node.text != null && !node.sizeLocked) {
        node.style = node.style || {};
        if (node.style.align !== 'center') { node.style.align = 'center'; notes.push('align→center (matches centered box)'); }
      }
      normalizeGroups(doc);
      touch(node);
      return `center ${aliasOf(node.id)} (${axis}) → ${node.box.x},${node.box.y}${noteStr(notes)}`;
    }

    case 'move': {
      if (!node) throw new Error(`unknown target "${ref}" — use a short id from the observation (L1, g2) or a role`);
      if (node.role === 'base') throw new Error('the base image cannot be moved');
      if (node.locked) throw new Error(`${aliasOf(node.id)} is locked — pick another node`);
      const notes = [];
      let nx = clamp(snapGridNote(clamp(repairNum(op.x, 'x', notes), 0, Math.max(0, cw - node.box.w)), cw, 'x', notes), 0, Math.max(0, cw - node.box.w));
      // y is NOT grid-snapped: the 12-col unit is a WIDTH unit — snapping y to it drifts
      // careful vertical placements by up to 8px for no compositional gain.
      const ny = clamp(Math.round(repairNum(op.y, 'y', notes)), 0, Math.max(0, ch - node.box.h));
      // near-center text snaps to EXACT center (models aiming for "centered" land ±15px off,
      // which reads as sloppy) — deliberate off-center moves (>16px) are untouched.
      if (node.type !== 'group' && node.text != null) {
        const exact = Math.round((cw - node.box.w) / 2);
        if (nx !== exact && Math.abs(nx + node.box.w / 2 - cw / 2) <= 16) { notes.push(`x ${nx}→${exact} (centered)`); nx = exact; }
        if (nx === exact && !node.sizeLocked) {
          node.style = node.style || {};
          if (node.style.align !== 'center') { node.style.align = 'center'; notes.push('align→center'); }
        }
      }
      translateNode(node, nx - node.box.x, ny - node.box.y);
      normalizeGroups(doc);
      touch(node);
      return `move ${aliasOf(node.id)} → ${node.box.x},${node.box.y}${noteStr(notes)}`;
    }

    case 'resize': {
      if (!node) throw new Error(`unknown target "${ref}" — use a short id from the observation (L1, g2) or a role`);
      if (node.role === 'base') throw new Error('the base image cannot be resized');
      if (node.locked) throw new Error(`${aliasOf(node.id)} is locked — pick another node`);
      if (node.type === 'group') throw new Error(`${aliasOf(node.id)} is a group — resize its children, or use setParams on element instances`);
      const notes = [];
      node.box.w = clamp(repairNum(op.w, 'w', notes), 40, cw);
      node.box.h = clamp(repairNum(op.h, 'h', notes), 30, ch);
      node.box.x = clamp(snapGridNote(clamp(node.box.x, 0, cw - node.box.w), cw, 'x', notes), 0, cw - node.box.w);
      node.box.y = clamp(Math.round(node.box.y), 0, ch - node.box.h);
      normalizeGroups(doc);
      touch(node);
      return `resize ${aliasOf(node.id)} → ${node.box.w}×${node.box.h}${noteStr(notes)}`;
    }

    case 'setText': {
      if (!node) throw new Error(`unknown target "${ref}" — use a short id from the observation (L1, g2) or a role`);
      if (node.type === 'image') throw new Error(`${aliasOf(node.id)} is an image — setText only works on text layers`);
      if (node.type === 'group') throw new Error(`${aliasOf(node.id)} is a group — setText one of its text children, or use setParams on element instances`);
      if (typeof op.text !== 'string') throw new Error('"text" must be a string');
      // v2 single edit path: element children route through their param → clean rebuild
      // (re-measured boxes, zero stale styles). Template layers (DM bubbles, tweet body…)
      // rebuild the WHOLE archetype so the thread/stack re-flows. Falls through for plain layers.
      const viaParam = applyElementTextEdit(doc, node.id, op.text.slice(0, 300), ctx.kit || undefined)
        || applyTemplateTextEdit(doc, node.id, op.text.slice(0, 300), ctx.kit || undefined);
      if (viaParam) {
        normalizeGroups(doc);
        if (ctx.aliases) ctx.aliases.sync(doc);
        touch(node);
        return viaParam;
      }
      const notes = [];
      node.text = op.text.slice(0, 300);
      touchText(node, doc, notes);
      touch(node);
      return `text ${aliasOf(node.id)} → “${node.text.slice(0, 50)}”${noteStr(notes)}`;
    }

    case 'setStyle': {
      if (!node) throw new Error(`unknown target "${ref}" — use a short id from the observation (L1, g2) or a role`);
      if (!op.style || typeof op.style !== 'object') throw new Error('setStyle needs a "style" object');
      // element children are styled by their builder — raw style edits leave stale residue;
      // rotation/opacity are safe cosmetic exceptions.
      if (node.sizeLocked) {
        const safe = new Set(['rotation', 'opacity', 'autoH']);
        const blocked = Object.keys(op.style).filter((k) => !safe.has(k));
        if (blocked.length) {
          throw new Error(`${aliasOf(node.id)} is element-built — use {"op":"setParams"} on its instance to change ${blocked.join('/')}`);
        }
      }
      const applied = [];
      const notes = [];
      // rotation is a NODE field (works on groups too) — clamped to -180..180
      if ('rotation' in op.style) {
        node.rotation = clamp(repairNum(op.style.rotation, 'rotation', notes), -180, 180);
        applied.push('rotation');
      }
      // autoH is a NODE field too — style.autoH used to be silently written where nothing
      // reads it, making auto-height impossible for the agent to control.
      if ('autoH' in op.style) {
        node.autoH = op.style.autoH !== false && op.style.autoH !== 'false' && op.style.autoH !== 0;
        applied.push('autoH');
      }
      if (node.type !== 'group') {
        node.style = node.style || {};
        for (const [k, vRaw] of Object.entries(op.style)) {
          if (k === 'rotation' || k === 'autoH' || !STYLE_KEYS.has(k)) continue;
          let v = vRaw;
          if (STYLE_ENUMS[k]) {
            if (!STYLE_ENUMS[k].includes(v)) throw new Error(`invalid ${k} "${v}" — expected one of: ${STYLE_ENUMS[k].join('|')}`);
          } else if (NUM_STYLE_KEYS.has(k)) {
            v = repairNum(v, k, notes);
            if (k === 'radius') v = quantizeRadius(v, doc, node.id, notes); // coherence guard (v4)
          } else if (COLOR_STYLE_KEYS.has(k)) {
            v = snapKitColor(repairColor(v, k, notes), ctx.kit, k, notes);  // coherence guard (v4)
          } else if (k === 'radiusCorners' || k === 'points') {
            if (!Array.isArray(v) || !v.every((n) => Number.isFinite(Number(n)))) {
              throw new Error(`"${k}" must be an array of numbers${k === 'radiusCorners' ? ' [tl,tr,br,bl]' : ' (flat x,y pairs 0..1)'}`);
            }
            v = v.map(Number);
          }
          node.style[k] = v;
          applied.push(k);
        }
      }
      // Reactive contrast-pair guard: if this op just changed color and/or background on a node
      // that has BOTH set (a pill/badge/card with its own text+fill), and the result is
      // near-invisible, auto-correct the property the user did NOT just set — precise, immediate,
      // on the exact node the instruction targeted. Complements (doesn't replace) the final
      // smartAdRepair pass, which only sees the layer against what's BEHIND it in the doc.
      const contrastNote = reactiveContrastGuard(node, applied);
      if (contrastNote) notes.push(contrastNote);
      if (applied.length) touchText(node, doc, notes);
      if (applied.length) touch(node);
      return applied.length ? `style ${aliasOf(node.id)} → ${applied.join(', ')}${noteStr(notes)}` : null;
    }

    case 'remove': {
      if (!node) throw new Error(`unknown target "${ref}" — use a short id from the observation (L1, g2) or a role`);
      if (node.role === 'base') throw new Error('the base image cannot be removed');
      const list = findParentList(doc, node.id);
      if (!list) return null;
      list.splice(list.indexOf(node), 1);
      normalizeGroups(doc);
      return `remove ${aliasOf(node.id)} (${label(node)})`;
    }

    case 'group': {
      const ids = Array.isArray(op.ids) ? op.ids : null;
      if (!ids || ids.length < 2) throw new Error('group needs "ids": an array of 2+ node ids');
      const nodes = ids.map((i) => resolveNode(doc, i, ctx)).filter(Boolean);
      if (nodes.length !== ids.length) throw new Error('group: one or more ids not found — use short ids from the observation');
      if (nodes.some((n) => n.role === 'base')) throw new Error('the base image cannot be grouped');
      const list = findParentList(doc, nodes[0].id);
      if (!list || nodes.some((n) => findParentList(doc, n.id) !== list)) {
        throw new Error('group: all ids must share the same parent — ungroup first or pick siblings');
      }
      const box = groupBounds(nodes) || { x: 0, y: 0, w: cw, h: ch };
      const g = { id: newId('group'), type: 'group', name: op.name ? String(op.name).slice(0, 60) : 'Group', box, children: [] };
      const insertAt = Math.min(...nodes.map((n) => list.indexOf(n)));
      for (const n of nodes) list.splice(list.indexOf(n), 1);
      g.children = nodes;
      list.splice(Math.min(insertAt, list.length), 0, g);
      normalizeGroups(doc);
      if (ctx.aliases) ctx.aliases.sync(doc);
      touch(g);
      return `group ${nodes.map((n) => aliasOf(n.id)).join('+')} → ${aliasOf(g.id)}`;
    }

    case 'ungroup': {
      if (!node || node.type !== 'group') return null;
      const list = findParentList(doc, node.id);
      if (!list) return null;
      const at = list.indexOf(node);
      list.splice(at, 1, ...(node.children || []));
      normalizeGroups(doc);
      return `ungroup ${aliasOf(node.id)} (${(node.children || []).length} children)`;
    }

    case 'order': {
      // z-order: paint order = list order (later paints on top).
      if (!node) throw new Error(`unknown target "${ref}" — use a short id from the observation (L1, g2) or a role`);
      if (node.role === 'base') throw new Error('the base image stays at the back');
      const list = findParentList(doc, node.id);
      if (!list) return null;
      const to = String(op.to || '');
      if (!['front', 'back', 'forward', 'backward'].includes(to)) {
        throw new Error('"to" must be one of: front|back|forward|backward');
      }
      const at = list.indexOf(node);
      list.splice(at, 1);
      // "back" still paints above the base image when the base shares this list
      const floor = list.length && list[0].role === 'base' ? 1 : 0;
      const idx = to === 'front' ? list.length
        : to === 'back' ? floor
          : to === 'forward' ? Math.min(list.length, at + 1)
            : Math.max(floor, at - 1);
      list.splice(idx, 0, node);
      touch(node);
      return `order ${aliasOf(node.id)} → ${to}`;
    }

    case 'duplicate': {
      if (!node) throw new Error(`unknown target "${ref}" — use a short id from the observation (L1, g2) or a role`);
      if (node.role === 'base') throw new Error('the base image cannot be duplicated');
      const list = findParentList(doc, node.id);
      if (!list) return null;
      const copy = JSON.parse(JSON.stringify(node));
      walkNodes([copy], (n) => { n.id = newId(n.type || 'layer'); });
      const notes = [];
      const dx = op.x !== undefined ? repairNum(op.x, 'x', notes) - copy.box.x : Math.round(cw * 0.03);
      const dy = op.y !== undefined ? repairNum(op.y, 'y', notes) - copy.box.y : Math.round(ch * 0.03);
      translateNode(copy, dx, dy);
      translateNode(copy, clamp(copy.box.x, 0, Math.max(0, cw - copy.box.w)) - copy.box.x, clamp(copy.box.y, 0, Math.max(0, ch - copy.box.h)) - copy.box.y);
      list.splice(list.indexOf(node) + 1, 0, copy);
      normalizeGroups(doc);
      if (ctx.aliases) ctx.aliases.sync(doc);
      touch(copy);
      return `duplicate ${aliasOf(node.id)} → ${aliasOf(copy.id)} @ ${copy.box.x},${copy.box.y}${noteStr(notes)}`;
    }

    case 'distribute': {
      // evenly space 3+ siblings along an axis (edge-to-edge gaps equalized)
      const refs = Array.isArray(op.ids) ? op.ids : [];
      const nodes = refs.map((r) => resolveNode(doc, r, ctx)).filter((n) => n && n.role !== 'base' && !n.locked);
      if (nodes.length < 3) throw new Error('distribute needs "ids" of 3+ unlocked nodes and "axis":"x"|"y"');
      const axis = op.axis === 'y' ? 'y' : 'x';
      const size = axis === 'x' ? 'w' : 'h';
      nodes.sort((a, b) => a.box[axis] - b.box[axis]);
      const first = nodes[0].box[axis];
      const last = nodes[nodes.length - 1].box[axis] + nodes[nodes.length - 1].box[size];
      const total = nodes.reduce((s, n) => s + n.box[size], 0);
      const gap = Math.max(0, Math.round((last - first - total) / (nodes.length - 1)));
      let cur = first;
      const moved = [];
      for (const n of nodes) {
        const d = Math.round(cur) - n.box[axis];
        if (d) translateNode(n, axis === 'x' ? d : 0, axis === 'y' ? d : 0);
        moved.push(aliasOf(n.id));
        cur += n.box[size] + gap;
      }
      normalizeGroups(doc);
      return `distribute ${moved.join('+')} along ${axis} (gap ${gap})`;
    }

    case 'reparent': {
      if (!node || node.role === 'base') return null;
      const from = findParentList(doc, node.id);
      if (!from) return null;
      let into;
      if (op.into == null) into = doc.layers;
      else {
        const g = resolveNode(doc, op.into, ctx);
        if (!g || g.type !== 'group') return null;
        // never reparent a group into itself/its own subtree
        let cycle = g === node;
        walkNodes(node.type === 'group' ? node.children || [] : [], (n) => { if (n === g) cycle = true; });
        if (cycle) return null;
        into = g.children;
      }
      from.splice(from.indexOf(node), 1);
      const idx = Number.isInteger(op.index) ? clamp(op.index, 0, into.length) : into.length;
      into.splice(idx, 0, node);
      normalizeGroups(doc);
      touch(node);
      return `reparent ${aliasOf(node.id)} → ${op.into || 'root'}[${idx}]`;
    }

    case 'add': {
      const l = op.layer;
      if (!l || typeof l !== 'object' || !LEAF_TYPES.has(l.type)) return null;
      if (!l.box || typeof l.box !== 'object') return null;
      const notes = [];
      // type:'image' with a src of /refasset?id=REF is a REAL image layer when REF is one of
      // this run's attachments (ctx.allowedRefs). Anything else stays a gray placeholder —
      // the model must never invent srcs.
      let imageSrc = null;
      if (l.type === 'image' && typeof l.src === 'string' && ctx.allowedRefs) {
        const m = /^\/refasset\?id=([\w-]+)$/.exec(l.src.trim());
        if (m && ctx.allowedRefs.has(m[1])) imageSrc = `/refasset?id=${m[1]}`;
      }
      const placeholder = l.type === 'image' && !imageSrc;
      const box = {
        w: clamp(repairNum(l.box.w, 'box.w', notes), 40, cw),
        h: clamp(repairNum(l.box.h, 'box.h', notes), 30, ch),
      };
      box.x = clamp(snapGridNote(clamp(repairNum(l.box.x, 'box.x', notes), 0, cw - box.w), cw, 'x', notes), 0, cw - box.w);
      box.y = clamp(Math.round(repairNum(l.box.y, 'box.y', notes)), 0, ch - box.h); // y never grid-snapped
      const type = placeholder ? 'shape' : l.type;
      const layer = {
        id: newId(type),
        type,
        role: typeof l.role === 'string' ? l.role.slice(0, 40) : type,
        name: typeof l.name === 'string' ? l.name.slice(0, 60) : (placeholder ? 'Image placeholder' : type),
        box,
      };
      if (imageSrc) layer.src = imageSrc;
      if (!placeholder && type !== 'image' && typeof l.text === 'string') layer.text = l.text.slice(0, 300);
      if (placeholder) {
        layer.style = { background: '#9aa0a6', opacity: 0.5, radius: 12 };
      } else if (l.style && typeof l.style === 'object') {
        layer.style = {};
        for (const [k, vRaw] of Object.entries(l.style)) {
          if (!STYLE_KEYS.has(k)) continue;
          let v = vRaw;
          if (NUM_STYLE_KEYS.has(k) && (typeof v === 'string')) { try { v = repairNum(v, k, notes); } catch { continue; } }
          if (k === 'radius' && Number.isFinite(v)) v = quantizeRadius(v, doc, layer.id, notes);
          if (COLOR_STYLE_KEYS.has(k)) v = snapKitColor(repairColor(v, k, notes), ctx.kit, k, notes);
          layer.style[k] = v;
        }
      }
      doc.layers.push(layer);
      if (ctx.aliases) ctx.aliases.sync(doc);
      if (type !== 'image' && type !== 'shape') touchText(layer, doc, notes);
      // deliberate placement for new text-bearing layers (AFTER touchText re-measures the box):
      // snap to canvas center or an existing column edge, and keep style.align consistent with
      // the box (centered box + left-aligned glyphs is the "randomly placed" look).
      if (['text', 'badge', 'button'].includes(type)) {
        layer.style = layer.style || {};
        placeTextBox(doc, layer.box, layer.style, notes);
      }
      touch(layer);
      const note = placeholder ? ' (no src — added a gray shape placeholder instead of a real image)' : noteStr(notes);
      return `add ${layer.type} ${layer.role} → ${aliasOf(layer.id)} @ ${box.x},${box.y} ${box.w}×${box.h}${note}`;
    }

    default:
      throw new Error(`unknown op "${op.op}" — expected one of: template, element, setParams, move, center, align, resize, setText, setStyle, draftText, look, order, duplicate, distribute, add, remove, group, ungroup, autolayout, done`);
  }
}

// ── observation ──────────────────────────────────────────────────────────────────────────────────

/** Compact non-default style summary: {fs:84,w:800,#111,bg:#fff,pill,rot:-6,blend:multiply}. */
function styleBits(n) {
  const s = n.style || {};
  const bits = [];
  if (s.fontSize) bits.push(`fs:${s.fontSize}`);
  if (s.fontWeight && s.fontWeight !== 400) bits.push(`w:${s.fontWeight}`);
  if (s.color) bits.push(String(s.color));
  if (s.background) bits.push(`bg:${s.background}`);
  if (s.pill) bits.push('pill');
  if (n.rotation) bits.push(`rot:${n.rotation}`);
  if (s.blend && s.blend !== 'normal') bits.push(`blend:${s.blend}`);
  return bits.length ? ` {${bits.join(',')}}` : '';
}

function subtreeHasId(node, id) {
  if (!id) return false;
  if (node.id === id) return true;
  let hit = false;
  walkNodes(node.children || [], (n) => { if (n.id === id) hit = true; });
  return hit;
}

const countIn = (g) => { let c = 0; walkNodes(g.children || [], () => { c++; }); return c; };

const boxesIntersect = (a, b) =>
  a && b && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * Compressed observation of a doc. Element instances collapse to one line unless the LAST op
 * targeted the instance or one of its children. Budget ≈ 1200 est tokens (chars/4): when over,
 * all groups collapse; still over → lines are truncated with `(+N more)`.
 *
 * SCOPING (v3, sub-agent workers): pass focusRegion {x,y,w,h} and/or focusIds (aliases or real
 * ids) — only nodes intersecting the region / matching the ids (or containing lastTarget) get
 * full lines; everything else collapses into one trailing "outside scope: N nodes" line.
 */
export function observe(doc, {
  aliases = null, lastTarget = null, budgetTokens = OBS_TOKEN_BUDGET,
  focusRegion = null, focusIds = null,
} = {}) {
  const aliasOf = (id) => (aliases ? aliases.alias(id) : id);
  const budget = budgetTokens * 4;
  const idSet = focusIds && focusIds.length
    ? new Set(focusIds.map((r) => (aliases ? aliases.resolve(r) : r)))
    : null;
  const scoped = !!(focusRegion || idSet);
  const inScope = (n) => {
    if (!scoped) return true;
    if (n.id === lastTarget || subtreeHasId(n, lastTarget)) return true;
    if (idSet) {
      if (idSet.has(n.id)) return true;
      let hit = false;
      walkNodes(n.children || [], (c) => { if (idSet.has(c.id)) hit = true; });
      if (hit) return true;
    }
    if (focusRegion && boxesIntersect(n.box, focusRegion)) return true;
    return false;
  };

  const leafLine = (n, i, depth) => {
    const txt = n.text ? String(n.text).replace(/\s+/g, ' ') : '';
    const ex = txt ? ` "${txt.slice(0, 24)}${txt.length > 24 ? '…' : ''}"` : '';
    const flags = `${n.hidden ? ' hidden' : ''}${n.locked ? ' locked' : ''}`;
    let fsHint = '';
    if (n.style?.fontSize && n.role && ['headline', 'subhead', 'caption', 'cta', 'badge'].includes(n.role)) {
      const target = roleFontSize(doc, n.role);
      const delta = n.style.fontSize - target;
      if (Math.abs(delta) > target * 0.2) fsHint = ` fsΔ${delta > 0 ? '+' : ''}${delta}`;
    }
    return `${'  '.repeat(depth)}[${i}] ${aliasOf(n.id)} ${n.role || '-'} ${n.type} ${n.box.x},${n.box.y} ${n.box.w}x${n.box.h}${ex}${styleBits(n)}${fsHint}${flags}`;
  };
  const groupLine = (g, i, depth, collapsed) => {
    const tag = g.element ? `el:${g.element.id}` : (g.name || 'group');
    const tail = collapsed ? ` (${countIn(g)} layers)` : '';
    return `${'  '.repeat(depth)}[${i}] ${aliasOf(g.id)} ${tag} ${g.box.x},${g.box.y} ${g.box.w}x${g.box.h}${tail}`;
  };

  const render = (collapseAll) => {
    const lines = [`canvas ${doc.canvas.w}x${doc.canvas.h}`, typeScaleLine(doc)];
    try {
      const vctx = visualContextBlock(doc, { aliases, budgetChars: 380 });
      if (vctx) lines.push(vctx);
    } catch { /* observation must never throw */ }
    let i = 0;
    let outside = 0;
    const walk = (nodes, depth) => {
      for (const n of nodes || []) {
        i++;
        if (depth === 0 && !inScope(n)) {
          outside += 1 + (n.type === 'group' ? countIn(n) : 0);
          continue;
        }
        if (n.type === 'group') {
          const expanded = lastTarget && subtreeHasId(n, lastTarget);
          const collapse = collapseAll || (n.element && !expanded);
          lines.push(groupLine(n, i, depth, collapse));
          if (!collapse) walk(n.children || [], depth + 1);
        } else {
          lines.push(leafLine(n, i, depth));
        }
      }
    };
    walk(doc.layers || [], 0);
    if (outside) lines.push(`outside scope: ${outside} nodes`);
    return lines;
  };

  let lines = render(false);
  if (lines.join('\n').length > budget) lines = render(true);      // collapse all groups first
  if (lines.join('\n').length > budget) {                          // then hard-truncate
    const kept = [lines[0]];
    let used = lines[0].length + 16;
    let idx = 1;
    while (idx < lines.length && used + lines[idx].length + 1 <= budget) {
      used += lines[idx].length + 1;
      kept.push(lines[idx]);
      idx++;
    }
    kept.push(`(+${lines.length - idx} more)`);
    lines = kept;
  }
  return lines.join('\n');
}

// ── prompts ──────────────────────────────────────────────────────────────────────────────────────

/** RUN MEMORY (v4): compress the last ≤3 agent chat results for a doc (from .state/agent-chats)
 *  into one compact line each ("earlier: move L2 → 90,180 · style L4 → fontSize") so follow-up
 *  instructions have continuity without context growth. Total ≤ ~90 est tokens.
 *  opts.chat lets tests inject a chat object instead of reading the store. */
export function buildRunMemory(docId, { chat = null } = {}) {
  let messages = [];
  try { messages = ((chat || getChat(docId)) || {}).messages || []; } catch { return []; }
  const lines = [];
  for (const m of messages.filter((x) => x && x.role === 'agent').slice(-3)) {
    const ops = String(m.text || '').split('\n')
      .map((s) => s.replace(/\s*\(repaired:[^)]*\)/g, '').trim())
      .filter((s) => s && !/\d+\/\d+ ops/.test(s))   // drop the verify tail line
      .slice(0, 3)
      .map((s) => s.slice(0, 40));
    if (ops.length) lines.push(`earlier: ${ops.join(' · ')}`.slice(0, 120));
  }
  return lines.slice(-3);
}

/** v2 system prompt: ops grammar + element catalog + design principles + context. ≤~2600 est tokens
 *  (measured — the ≤3k per-turn budget must hold with the observation added; see the v3 test).
 *  v3: also injects WORKSPACE NOTES (memory) and ATTACHED IMAGE lines (attachments with intent).
 *  v4: DESIGN PRINCIPLES block + runMemory ("earlier: …" continuity lines from buildRunMemory).
 *  v5: the "look" op is only advertised when a vision endpoint is configured (opts.vision,
 *  default VISION_BASE_URL) — advertising it on text-only DeepSeek burned ops on doomed calls. */
export function buildSystemPrompt(instruction, { brief, referenceText, kit, memory, attachments, runMemory, brandSkill, copyLock, vision = !!process.env.VISION_BASE_URL } = {}) {
  const ctx = [];
  if (Array.isArray(runMemory)) for (const line of runMemory.slice(-3)) ctx.push(String(line).slice(0, 120));
  if (brief) ctx.push(`Brief/copy: ${String(brief).slice(0, 400)}`);
  if (referenceText) ctx.push(`Reference ad text: ${String(referenceText).slice(0, 400)}`);
  if (kit?.prompt) ctx.push(`BRAND STYLE (follow exactly): ${String(kit.prompt).slice(0, 400)}`);
  if (kit && ((kit.colors || []).length || (kit.fonts || []).length || kit.notes)) {
    const parts = [];
    if (kit.colors && kit.colors.length) parts.push(`colors ${kit.colors.slice(0, 6).join(' ')}`);
    if (kit.fonts && kit.fonts.length) parts.push(`fonts ${kit.fonts.slice(0, 3).join(', ')}`);
    if (kit.notes) parts.push(String(kit.notes).slice(0, 160));
    ctx.push(`Brand kit: ${parts.join('; ')}`);
  }
  if (brandSkill) ctx.push(`BRAND SKILL:\n${String(brandSkill).slice(0, 1200)}`);
  if (memory) ctx.push(`WORKSPACE NOTES: ${String(memory).slice(-500)}`);
  const atts = Array.isArray(attachments) ? attachments.filter((a) => a && a.ref).slice(0, 3) : [];
  atts.forEach((a, i) => {
    const note = a.note ? ` (${String(a.note).slice(0, 80)})` : '';
    ctx.push(`ATTACHED IMAGE ${i + 1}${note}: ${String(a.desc || 'no description').slice(0, 200)} — src /refasset?id=${a.ref}`);
  });
  const attRule = atts.length
    ? `\n- You MAY add an attached image: {"op":"add","layer":{"type":"image","src":"/refasset?id=${atts[0].ref}","box":{…}}} (only the listed attachment srcs work).`
    : '';
  const catalog = ELEMENTS.map((d) => elementCatalogLine(d)).join('\n');
  const scale = typeScaleLine({ canvas: { w: 1080, h: 1350 } });
  return `You edit an ad comp's scene graph. Each turn you reply with ONE JSON object: {"plan":"<1-2 sentences: what you observe in the current state and WHY these ops>","ops":[…1-${MAX_OPS_PER_TURN} ops…],"done":true|false}. The plan is shown to the user live — narrate like a designer thinking out loud, not a robot. Address nodes by short id (L1, g2) or role. Coordinates are absolute px. Never touch the base image (role "base") or locked nodes.

TYPE SIZES (use these — do NOT guess): headline≈8%w subhead≈4%w caption≈3%w cta≈3.4%w badge≈2.6%w of canvas width.
Example at 1080w: ${scale.replace('scale@1080(portrait): ', '')}
COPY BUDGETS (max chars per line — write copy to fit): headline≤22 subhead≤36 caption≤42 cta≤18 badge≤24.
Prefer {"op":"element"} for headline/cta/badge — they ship correct sizes. Use {"op":"autolayout"} when layout is messy.

OPS (exact shapes):
{"op":"autolayout"}
{"op":"template","template":"x-post-ad","params":{"body":"…"}}   (REPLACES all non-base layers with a whole-ad archetype)
{"op":"element","element":"headline","x":60,"y":800,"params":{"text":"BIG SALE"}}
{"op":"element","element":"cta","x":60,"y":1700,"w":400,"params":{"text":"SHOP NOW"}}
{"op":"setParams","id":"g2","params":{"stars":4}}
{"op":"move","id":"L3","x":60,"y":120}
{"op":"center","id":"L3","axis":"x"}   (axis: x|y|both — exact canvas centering, never do the pixel math yourself)
{"op":"align","id":"L3","h":"center","v":"bottom"}   (h: left|center|right · v: top|middle|bottom)
{"op":"resize","id":"L3","w":400,"h":120}
{"op":"setText","id":"L3","text":"…"}
{"op":"setStyle","id":"L3","style":{"fontSize":84,"fontWeight":800,"color":"#111111","background":"#ffffff","rotation":-6}}
{"op":"add","layer":{"type":"text","role":"caption","text":"…","box":{"x":60,"y":120,"w":400,"h":80},"style":{}}}
{"op":"remove","id":"L3"}
{"op":"group","ids":["L2","L3"],"name":"…"}
{"op":"ungroup","id":"g1"}
{"op":"order","id":"L3","to":"front"}   (front|back|forward|backward — paint order)
{"op":"duplicate","id":"L3","x":60,"y":400}   (x/y optional — default offsets slightly)
{"op":"distribute","ids":["L2","L3","L4"],"axis":"y"}   (3+ nodes, equal gaps)
{"op":"draftText","ids":["L2","L3"]}   (asks the copywriter to rewrite those layers' text to fit their boxes — use for captions)${vision ? '\n{"op":"look"}   (render the comp and critique it with vision — use before done)' : ''}

TEMPLATES — whole-ad archetypes; when the task matches one, start with {"op":"template"} then refine copy/positions:
${templateCatalog()}

ELEMENTS — prefer {"op":"element"} over raw add; every param is optional (good defaults, brand-aware):
${catalog}
Param notes: list params like items[] REPLACE the text param (ig-caption items[] = one pill per line); series = [{label,color,points:0..1}].

DESIGN PRINCIPLES:
- HIERARCHY: read order headline > subhead > body/caption > cta > legal. The headline is the ONE
  dominant size (≈2× the subhead) — one glance must show where to look.
- FONTS: TWO faces max (display for headline/offer, clean for body/CTA). Elements ship this pairing —
  don't reset fontFamily; match brand-kit fonts when given, else leave element defaults alone.
- 12-column grid, ~5% margins; align every block's LEFT edge to the same column. Max 2 fonts, 3 colors —
  prefer the kit. Over a photo use a scrim/pill, never wash the whole frame or use muddy mid-gray.
- PLACEMENT: never eyeball coordinates. To center something use {"op":"center"} or {"op":"align"} —
  not hand-computed x/y. NEW text goes either exactly centered on the canvas OR left-aligned to an
  existing column edge; vertically place it in the band its role belongs to (header top ~20%, body
  middle, cta bottom ~15%). Keep style.align consistent with the box: centered box → "align":"center".
- Breathing room: generous, CONSISTENT spacing; never crowd edges. Compose, don't scatter.
- Text must contrast with what's behind it (scrim/pill if needed) — legibility beats prettiness.
- CONTRAST PAIRS: when changing "color" OR "background" on a node that has BOTH set (pill/badge/card,
  e.g. ig-caption), a literal one-property edit can leave the pair invisible (black text on a
  near-black pill). ALSO adjust the paired property so it reads, and say so in your plan (e.g.
  "caption text black, flipped its pill to white"). Same check in reverse when changing a background
  under colored text.
- DARK MODE on platform elements = that platform's REAL dark theme, never a naive invert. Match the
  platform from element id/role and apply its bg/text/accent as a SET, naming it in your plan:
  Instagram (ig-*): bg #0C1014, text #F5F5F5, muted #A8A8A8 · Apple Notes: bg #000000 (card #1C1C1E),
  white text, accent #FFD60A (not #FFCC00) · iMessage: sent bubble STAYS #0A84FF, received → #262626 ·
  X post: already dark (#000000) — usually a color no-op. Non-platform elements: true near-black bg +
  light text (not inverted photo colors), per CONTRAST PAIRS.
- If fsΔ shows in observation, fix that layer's fontSize toward the TYPE SIZES above.
- VISUAL CONTEXT lines show what's under each layer (photo/solid) and warnings (wide-on-photo, tiny-type).
- NEVER place wide text (>70% canvas) directly on a photo — pill/scrim or narrow the box.
- ONE archetype per comp — never stack two archetypes or duplicate an element in the same spot
  (duplicates are auto-suppressed).${attRule}

EXAMPLE TURN (imitate this shape exactly):
State shows: [2] L2 headline text 80,120 700x120 "BIG SALE" {fs:84,w:800,#ffffff} · [4] L4 cta button 80,900 320x90
Task: "move the headline lower and make the CTA stand out"
Reply:
{"plan":"drop headline to the lower third, give the cta a brand pill","ops":[{"op":"move","id":"L2","x":80,"y":620},{"op":"setStyle","id":"L4","style":{"background":"#2c5cff","color":"#ffffff"}}],"done":false}
Next turn, if state + lint look right: {"plan":"both edits landed clean","ops":[],"done":true}

${copyLock ? 'COPY LOCK: this comp keeps its reference copy VERBATIM — setText/draftText are disabled; edit position, size, color and structure only.\n' : ''}HOUSE RULES (auto-enforced after every op — work WITH them, never fight them):
- x soft-snaps to a 12-column grid (±8px); y is never snapped.
- colors near a brand-kit color snap to the kit (kits with 2+ colors); radii quantize to the doc's radius set.
- text height auto-grows to fit content (autoH); opt out with {"op":"setStyle","style":{"autoH":false}}.
- element-built text is size-locked — change it via setParams, never setStyle.fontSize.
- non-element text below role minimums is floored; wide unstyled text on photos gets a pill.
- setStyle on a color/background that would leave text invisible against its own pill/card fill
  auto-flips the OTHER property to a contrasting value — you don't need to also do this yourself,
  but plan for it and mention the trade-off (e.g. "black text will need a light pill") up front.
Op feedback lines show what the rules changed, e.g. "(repaired: x 63→60 (grid), color #2b5bfe→#2c5cff (kit))".
${ctx.length ? `\nCONTEXT:\n${ctx.join('\n')}\n` : ''}
TASK: ${instruction}

Reply with ONE JSON object per turn: {"plan":"…","ops":[…],"done":false}. Set "done":true when the task is complete and lint is clean (ops may be [] then). No prose, no code fences. Prefer few, decisive ops — autolayout + element beats many tiny setStyle calls.`;
}

/** Pull the first JSON array out of a codex reply (tolerates prose/code fences). */
function parseOpsArray(text) {
  const m = String(text || '').match(/\[[\s\S]*\]/);
  if (!m) return null;
  try {
    const arr = JSON.parse(m[0]);
    return Array.isArray(arr) ? arr.slice(0, MAX_OPS) : null;
  } catch { return null; }
}

// Deterministic fallback: classic direct-response layout pass. Bounded, always valid.
function fallbackOps(doc) {
  const ops = [];
  const { w: cw, h: ch } = doc.canvas;
  for (const l of leaves(doc.layers || [])) {
    if (l.role === 'headline') ops.push({ op: 'move', id: l.id, x: Math.round(cw * 0.055), y: Math.round(ch * 0.62) });
    if (l.role === 'caption') ops.push({ op: 'move', id: l.id, x: Math.round(cw * 0.055), y: Math.round(ch * 0.80) });
    if (l.role === 'cta') ops.push({ op: 'move', id: l.id, x: Math.round(cw - l.box.w - cw * 0.055), y: Math.round(ch - l.box.h - ch * 0.05) });
    if (l.role === 'badge') ops.push({ op: 'move', id: l.id, x: Math.round(cw * 0.055), y: Math.round(ch * 0.055) });
  }
  return ops.slice(0, MAX_OPS);
}

/** Compose the improve-mode instruction from lint findings. */
function improveInstruction(findings) {
  if (!findings.length) {
    return 'Lint found no problems. Make ONE tasteful improvement of your choice (hierarchy, spacing, or contrast). Then done.';
  }
  const listed = findings.slice(0, 6).map((f, i) => `${i + 1}) ${f}`).join(' ');
  return `Fix: ${listed} Then one improvement of your choice. Then done.`;
}

/**
 * Run the design agent over a doc. Mutates a COPY; returns
 * { doc, steps, source, runId, applied, usage, lint, totals:{turns,parts,inTok,outTok} }.
 * onStep({ runId, step }) fires per visible step.
 * opts: { brief?, referenceText?, kit?, memory?, attachments?:[{ref,note,desc}], signal?,
 *         mode?: 'edit'|'improve'|'generate', llmCall? (tests), brandSkill?, bestOf? }.
 *
 * v5: ONE batched plan-act-verify loop (runBatchAgent) with a single global turn budget —
 * the director/worker chain, post-run lint→fix rerun, and verify auto-retry are gone. Lint
 * runs IN the loop (findings appear as LINT: lines each turn and gate "done"). Multi-part
 * instructions are handled by the batch protocol itself: the model plans each turn.
 * mode 'improve' ignores `instruction` and auto-composes one from lintDesign findings.
 */

/** Chit-chat/meta messages ("yo", "why did you change that?", "thanks") must NOT trigger a
 *  scene read + op loop. Conservative: only clearly conversational inputs match — anything
 *  carrying an edit verb or design noun falls through to the real agent. */
export function isChitChat(s) {
  const t = String(s || '').trim().toLowerCase();
  if (!t) return false;
  if (t.length <= 4 && !/\d/.test(t)) return true; // "yo", "hey", "sup", "ok"
  if (/^(yo|hey|hi|hello|sup|thanks|thank you|nice|cool|lol|wtf|bro|ok|okay)\b[!.?\s]*$/.test(t)) return true;
  // META questions/complaints about behavior are chat even when they mention design words:
  // "why did you change that?", "it keeps making changes". REQUESTS ("can you make…") run.
  if (/^(why|what|when|who|how come|did you|are you|were you|do you)\b/.test(t)) return true;
  if (/\b(keeps?|stop|don'?t)\b.+\b(making|changing|doing|moving)\b/.test(t)) return true;
  const editIntent = /\b(add|move|resize|change|make|set|remove|delete|swap|replace|generate|create|align|center|rewrite|fix|bigger|smaller|color|colour|template|caption|headline|cta|bubble|text|layout|design|font|image|pill|badge)\b/;
  const question = /\?\s*$/.test(t);
  if (question && !editIntent.test(t)) return true;
  return false;
}

// ── FAST PATH (v6): trivial edits skip the full observe→plan→verify machinery ─────────────────
// "make the headline bigger" was taking 30-60s through the 12-turn loop with full observations,
// lint gating and post-passes. A trivial instruction = ONE turn, minimal prompt (~15% the size),
// scoped observation, no lint gate, done in the same reply. Complex flows are untouched — this
// is an additive routing decision at the top of edit mode.
const FAST_VERB = /\b(make|set|change|move|nudge|center|centre|align|resize|rename|rewrite|remove|delete|hide|show|rotate|shrink|enlarge|bump|drop|raise|lower|bigger|smaller|larger|wider|taller|bolder|say|says)\b/;
const FAST_TARGET = /\b(headline|title|subhead|subheading|subline|caption|body|cta|button|badge|logo|price|pill|label|tagline|offer|text|copy|word(?:ing)?|it|this|that|l\d+|g\d+)\b/;
// anything that smells multi-part, generative, or structural stays on the full loop
const FAST_BLOCK = /\b(generate|create|design|redesign|rebuild|redo|template|layout|autolayout|everything|whole|entire|all the|from scratch|then|also|after that|as well)\b|&|\bplus\b/;

/** True when `instruction` is a single trivial edit (short + edit verb + identifiable target,
 *  or any short edit ask when focusIds pin the target) that the fast path can run in 1-2 turns. */
export function isTrivialEdit(instruction, opts = {}) {
  if (opts.mode === 'improve' || opts.mode === 'generate') return false;
  const t = String(instruction || '').trim().toLowerCase();
  if (!t || t.length > 140 || isChitChat(t)) return false;
  if (FAST_BLOCK.test(t)) return false;
  if ((t.match(/,/g) || []).length >= 2) return false; // 2+ commas = a list of asks
  const hasFocus = Array.isArray(opts.focusIds) && opts.focusIds.length > 0;
  return FAST_VERB.test(t) && (FAST_TARGET.test(t) || hasFocus);
}

/** Best-effort focus for the fast path when the caller gave no focusIds: nodes whose role/name
 *  (or a text fragment) is literally mentioned in the instruction. Keeps huge-doc observations
 *  down to the relevant lines. Returns real ids ([] = observe everything). */
export function deriveFocusIds(doc, instruction) {
  const t = String(instruction || '').toLowerCase();
  const ids = [];
  walkNodes(doc.layers || [], (n) => {
    if (!n || n.role === 'base') return;
    const role = String(n.role || '').toLowerCase();
    const name = String(n.name || '').toLowerCase();
    if ((role && role.length > 2 && t.includes(role)) || (name && name.length > 2 && t.includes(name))) { ids.push(n.id); return; }
    const words = String(n.text || '').toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    if (words.length && words.some((w) => t.includes(w))) ids.push(n.id);
  });
  return ids.slice(0, 8);
}

/** Minimal fast-path system prompt (~15% of the full one): the trivial-op subset, placement
 *  rules, done-in-same-reply. No template/element catalogs, no design-principles essay. */
export function buildFastPrompt(instruction, { copyLock = false } = {}) {
  return `You edit an ad comp's scene graph. This is a SMALL edit — finish it in ONE reply.
Reply with ONE JSON object: {"plan":"<one short sentence>","ops":[…1-3 ops…],"done":true}. No prose, no code fences.
Address nodes by short id (L1, g2) or role. Coordinates are absolute px. Never touch role "base" or locked nodes.

OPS (exact shapes):
{"op":"move","id":"L3","x":60,"y":120}
{"op":"center","id":"L3","axis":"x"}   (axis: x|y|both — exact canvas centering, never compute it yourself)
{"op":"align","id":"L3","h":"center","v":"bottom"}   (h: left|center|right · v: top|middle|bottom)
{"op":"resize","id":"L3","w":400,"h":120}
{"op":"setText","id":"L3","text":"…"}
{"op":"setStyle","id":"L3","style":{"fontSize":84,"fontWeight":800,"color":"#111111"}}   (plain text layers — the DEFAULT choice)
{"op":"setParams","id":"g2","params":{"text":"…"}}   (ONLY for element instances — their state line shows "el:…"; everything else uses setStyle/setText)
{"op":"remove","id":"L3"}

RULES:
- "bigger"/"smaller" on text ≈ ±25% fontSize via setStyle (setParams only when the line shows el:…).
- Centered/moved text: use "center"/"align", and keep style.align consistent with the box.
- Do exactly what was asked — nothing extra.${copyLock ? '\n- COPY LOCK: text is verbatim-locked — setText is disabled; edit position/size/color only.' : ''}

TASK: ${instruction}

Reply now with the ops AND "done":true in the SAME object.`;
}

export async function runDesignAgent(doc, instruction, onStep = () => {}, opts = {}) {
  if (inFlight >= MAX_CONCURRENT) throw new Error(`max ${MAX_CONCURRENT} design agents already running`);
  inFlight++;
  const runId = `design_${Date.now().toString(36)}`;
  const steps = [];
  const model = llmInfo();
  const usage = { inTok: 0, outTok: 0 };
  const emit = (kind, summary, data = null) => {
    const step = { i: steps.length + 1, kind, summary, data, at: Date.now() };
    steps.push(step);
    onStep({ runId, step });
  };

  try {
    // Conversational gate: chit-chat gets a chat reply, ZERO doc reads, zero ops — "yo" must
    // never re-layout an ad. Only plain edit-mode messages hit this path.
    if (opts.mode !== 'improve' && opts.mode !== 'generate' && isChitChat(instruction)) {
      const call = opts.llmCall || llmText;
      const r = await call(`You are the design agent inside an ad editor. The user said: "${String(instruction).slice(0, 200)}". Reply in ONE friendly sentence (you may reference that you edit designs when asked). Plain text.`, {
        system: 'Reply with one short sentence, no JSON.', maxTokens: 800, purpose: 'design-chat',
      });
      if (r.usage) { usage.inTok += r.usage.inTok || 0; usage.outTok += r.usage.outTok || 0; }
      const reply = (r.ok && r.text ? r.text : 'Ready when you are — tell me what to change.').trim().slice(0, 200);
      emit('op', reply, { chat: true });
      onStep({ runId, done: true });
      const lint = lintDesign(JSON.parse(JSON.stringify(doc)), opts.kit || null);
      return {
        doc, steps, source: 'chat', runId, applied: 0, usage, lint,
        totals: { turns: 1, parts: 1, inTok: usage.inTok, outTok: usage.outTok },
        layoutScore: layoutScore(doc, opts.kit || null),
        verify: verifyDesign(doc, { kit: opts.kit || null, skeletonId: doc.skeletonId }),
      };
    }

    const work = JSON.parse(JSON.stringify(doc)); // agents never mutate the stored doc directly
    const kit = opts.kit || null;
    const brandSkill = opts.brandSkill != null
      ? String(opts.brandSkill).slice(0, 1200)
      : loadBrandSkill(doc.brand || (doc.link && doc.link.brand) || '');
    // run memory: last ≤3 chat results for this doc, one compact line each (tests may inject)
    const runMemory = Array.isArray(opts.runMemory) ? opts.runMemory : buildRunMemory(doc.id);
    let lintReport = null;
    const generateMode = opts.mode === 'generate' || isGenerateIntent(instruction, opts.mode);

    if (opts.mode === 'improve') {
      lintReport = lintDesign(work, kit);
      instruction = improveInstruction(lintReport);
      emit('thinking', lintReport.length ? `lint: ${lintReport.length} finding(s)` : 'lint: clean', { findings: lintReport });
    } else if (generateMode && !String(instruction || '').trim()) {
      instruction = 'Generate a production-ready ad from the brief and brand style.';
    }
    if (opts.mode !== 'improve' && !String(instruction || '').trim()) throw new Error('need an instruction');

    const aliases = createAliasMap();
    aliases.sync(work);
    const allowedRefs = Array.isArray(opts.attachments) && opts.attachments.length
      ? new Set(opts.attachments.map((a) => String(a.ref)))
      : null;
    const opCtx = { kit, aliases, lastTarget: null, allowedRefs };
    // layers the agent deliberately styled/edited this run — post-op repair must not revert them
    const styledIds = new Set();

    emit('thinking', `${generateMode ? 'generation' : 'edit'} mode · ${countNodes(work)} nodes · “${String(instruction).slice(0, 80)}”`);

    let source = generateMode ? 'generate' : 'fallback';
    let applied = 0;
    let opsTotal = 0;
    const totals = { turns: 0, parts: 1, inTok: 0, outTok: 0 };

    // ZERO-token pre-pass: GENERATE mode only, and only on bare docs. Running autolayout on
    // every low-scoring EDIT reshuffled deliberate compositions before the model even saw
    // them ("auto layout scaling is garbage") — edits now start from the doc exactly as-is;
    // autolayout remains available as an explicit op.
    const beforeScore = layoutScore(work, kit);
    if (generateMode) {
      const pre = autoLayoutDoc(work, { kit });
      emit('op', pre.summary, { op: { op: 'autolayout' }, deterministic: true });
      const ad = smartAdRepair(work, { kit });
      if (ad.summaries.length) emit('op', ad.summary, { deterministic: true });
    }

    // Post-op ad repair on every mutating apply (catches wide-on-photo etc. immediately) —
    // but never on layers the agent styled itself this run: silently re-adding a pill the
    // agent just removed reverts its intent while the op log reports success.
    const postApplyRepair = () => {
      const ad = smartAdRepair(work, { kit, excludeIds: styledIds });
      if (ad.summaries.length) return ad.summary;
      return null;
    };

    const useHarness = hasLlm() || typeof opts.llmCall === 'function';
    const call = opts.llmCall || llmText;

    // Reference fidelity: docs built FROM an extracted reference keep the reference's exact
    // copy — the polish pass may fix contrast/positions but never rewrites text (opts.keepCopy
    // overrides in either direction).
    const keepCopy = opts.keepCopy != null ? !!opts.keepCopy : !!(work.skeletonId || work.reference);

    // One op application shared by both modes. Handles draftText (in-loop copywriter with
    // full scene context) and marks agent-styled layers so postApplyRepair never reverts them.
    // Retrieval exemplars (LayoutGPT-style): proven layout skeletons matching the brief +
    // aspect, injected into generate prompts so the model adapts instead of inventing.
    let exemplars = '';
    if (generateMode) {
      try { exemplars = exemplarBlock({ brief: String(opts.brief || instruction || ''), aspect: aspectTag(work.canvas.w, work.canvas.h) }); }
      catch { /* cold library — no exemplars */ }
      if (exemplars) emit('thinking', 'retrieved exemplar layouts from the library');
    }

    // set when generate mode scaffolds a whole-ad archetype — the layout is then FINISHED:
    // autolayout would reshuffle the artifact (tweet cards don't follow the 12-col grid) and
    // the completeness lint (add a cta!) would bolt ad furniture onto a native-format post.
    let templateSeeded = false;

    const applyFn = async (op) => {
      if (op && op.op === 'autolayout' && templateSeeded) {
        throw new Error('this comp is a finished archetype template — autolayout would wreck it; edit copy with setText/draftText instead');
      }
      if (op && op.op === 'template') templateSeeded = true;
      if (op && op.op === 'look') {
        // self-vision: render the current comp and critique it with the vision endpoint.
        // Fast-fail without one — the usage log showed repeated instant (~7ms) failed calls
        // when the op was attempted against a down/absent endpoint.
        if (!process.env.VISION_BASE_URL) throw new Error('no vision endpoint configured — finish without "look"');
        const r = await lookAtComp(work);
        if (!r.ok) throw new Error(r.error || 'look failed');
        return `looked at the render → ${r.critique}`;
      }
      if (op && op.op === 'draftText') {
        const refs = Array.isArray(op.ids) ? op.ids : op.id ? [op.id] : [];
        const targets = refs.map((r) => resolveNode(work, r, opCtx)).filter((n) => n && n.type !== 'image' && n.type !== 'group');
        const r = await draftTextForLayers(work, targets, { brief: opts.brief, referenceText: opts.referenceText, kit, brandSkill, llmCall: call, signal: opts.signal });
        if (!r.ok) throw new Error(r.error || 'draftText failed');
        for (const id of r.touched) styledIds.add(id);
        return r.summary;
      }
      if (keepCopy && (op.op === 'setText' || op.op === 'draftText')) {
        throw new Error('this comp keeps its reference copy verbatim — text edits are locked (ask the user to unlock if copy changes are wanted)');
      }
      if (generateMode) {
        const filtered = filterGenerateOp(op);
        if (!filtered) throw new Error(`op "${op && op.op}" not allowed in generation mode — use setText, setStyle(color/bg), autolayout, or done`);
        op = filtered;
      }
      const r = applyOp(work, op, opCtx);
      if (r && (op.op === 'setStyle' || op.op === 'setText') && opCtx.lastTarget) {
        styledIds.add(opCtx.lastTarget);
      }
      if (r && typeof r === 'string' && !generateMode) {
        const fix = postApplyRepair();
        if (fix) return `${r} · ${fix}`;
      }
      return r;
    };

    // Main-turn VISION (v6): when llmText routes through LM Studio (VISION_BASE_URL reachable),
    // the worker model IS the vision model — so SHOW it the canvas render on the first turn of
    // each batch instead of only describing the scene. Render/vision failures degrade silently
    // to the text-only call inside the harness. Off for tests (opts.llmCall) and the fast path
    // (a render costs more wall-clock than the whole trivial edit).
    const mainTurnVision = !opts.llmCall && !!process.env.VISION_BASE_URL && opts.mainTurnVision !== false;

    // ONE batched loop, one global turn budget. Lint runs in-loop and gates "done".
    // fast: trivial-edit mode — minimal prompt, scoped low-budget observation, no lint gate.
    const runBatch = async (goal, { maxTurns = MAX_TURNS, generate = false, fast = false } = {}) => {
      const promptCtx = { ...opts, kit, runMemory, brandSkill, exemplars, copyLock: keepCopy };
      const fastFocus = fast
        ? (Array.isArray(opts.focusIds) && opts.focusIds.length ? opts.focusIds : deriveFocusIds(work, goal))
        : null;
      const run = await runBatchAgent({
        system: generate ? buildGeneratePrompt(goal, promptCtx)
          : fast ? buildFastPrompt(goal, { copyLock: keepCopy })
            : buildSystemPrompt(goal, promptCtx),
        buildObservation: () => observe(work, {
          aliases,
          lastTarget: opCtx.lastTarget,
          focusIds: fast ? (fastFocus && fastFocus.length ? fastFocus : null) : (opts.focusIds || null),
          // fast path: don't ship a huge doc — only the focused/relevant nodes fit a 500-token cap
          ...(fast ? { budgetTokens: 500 } : {}),
        }),
        applyOp: applyFn,
        // Lint gates "done". In generate/improve mode the whole ad is in scope, so completeness
        // findings (missing headline/cta) are fair. But a SCOPED EDIT ("rewrite the caption")
        // must not be blocked into building an entire ad it wasn't asked for — filter those two
        // completeness findings out of the edit-mode gate (quality findings still apply).
        // The FAST path drops the lint gate entirely — a verify pass on "make the headline
        // bigger" is pure latency (the final deterministic repair/verify still run post-loop).
        lint: fast ? null : () => {
          try {
            const findings = lintDesign(work, kit);
            // completeness findings (add headline/cta) apply to open-ended generates and
            // improve mode — NOT to scoped edits or finished archetype templates (a tweet ad
            // doesn't want a CTA pill bolted on).
            if ((generate && !templateSeeded) || opts.mode === 'improve') return findings;
            return findings.filter((f) => !/^no (headline|cta) layer/.test(f));
          } catch { return []; }
        },
        maxTurns,
        maxOpsPerTurn: fast ? 3 : (opts.maxOpsPerTurn || MAX_OPS_PER_TURN),
        timeoutMsPerTurn: 60_000,
        purpose: fast ? 'design-agent-fast' : generate ? 'design-generate' : 'design-agent',
        signal: opts.signal || null,
        llmCall: opts.llmCall || undefined,
        maxTokensPerTurn: opts.maxTokensPerTurn || 3000, // reasoning headroom (see agent-harness)
        maxApplied: opts.maxApplied || null,
        // main-turn vision: render once (turn 0) per batch — later turns already have op feedback
        ...(mainTurnVision && !fast ? {
          visionCall: (p, img, o) => llmVision(p, img, o),
          imageForTurn: (turn) => (turn === 0 ? renderCompPng(work) : null),
        } : {}),
        // targetId: the REAL node id the op touched (aliases like L2 are per-run) — the UI
        // uses it to flash the edited element on the canvas.
        onStep: (s) => emit(s.kind, s.summary, { ...(s.data || {}), model: model.model, ...(s.kind === 'op' && opCtx.lastTarget ? { targetId: opCtx.lastTarget } : {}) }),
      });
      totals.turns += run.turns || 0;
      usage.inTok += run.usage.inTok;
      usage.outTok += run.usage.outTok;
      applied += run.applied;
      opsTotal += run.steps.filter((s) => s.kind === 'op').length;
      return run;
    };

    // Best-of-N (generate mode): sample N candidate op batches, apply each to a CLONE, keep
    // the highest layoutScore — the deterministic verifier is free, so weak-model samples are
    // cheap quality (test-time compute, arXiv:2408.03314).
    // ADAPTIVE best-of-N (token minimization): sample 1, and only spend more samples when the
    // first is weak. Best-of-N was the #1 DeepSeek token sink (always 3× full generate calls);
    // most first samples already score ≥ GOOD, so this cuts ~50-60% of generate tokens with no
    // quality loss. Stops as soon as a candidate clears GOOD.
    const GOOD = 90;
    const bestOfSeed = async (n) => {
      const promptCtx = { ...opts, kit, runMemory, brandSkill, exemplars };
      const system = buildGeneratePrompt(instruction, promptCtx);
      const obs = observe(work, { aliases });
      const prompt = `CURRENT STATE:\n${obs}\n\nReply with ONE JSON object: {"plan":"…","ops":[…up to 6 setText/setStyle ops…],"done":true}. No prose.`;
      const candidates = [];
      for (let i = 0; i < n; i++) {
        if (opts.signal && opts.signal.aborted) break;
        const r = await call(prompt, { system, json: true, maxTokens: 2500, timeoutMs: 60_000, purpose: 'design-generate-bestof', signal: opts.signal, temperature: i === 0 ? 0 : 0.9 });
        totals.turns += 1;
        if (r.usage) { usage.inTok += r.usage.inTok || 0; usage.outTok += r.usage.outTok || 0; }
        if (!r.ok) continue;
        const batch = parseBatch(r.text);
        if (batch.error || !batch.ops.length) continue;
        const clone = JSON.parse(JSON.stringify(work));
        const cloneCtx = { ...opCtx, aliases, lastTarget: null };
        let ok = 0;
        for (const op of batch.ops.slice(0, 6)) {
          const f = filterGenerateOp(op);
          if (!f) continue;
          try { if (applyOp(clone, f, cloneCtx)) ok++; } catch { /* skip bad op */ }
        }
        if (ok) {
          const score = layoutScore(clone, kit);
          candidates.push({ ops: batch.ops.slice(0, 6), score, ok });
          if (score >= GOOD) break; // good enough — don't burn more samples
        }
      }
      if (!candidates.length) return false;
      candidates.sort((a, b) => b.score - a.score);
      emit('thinking', `best-of (adaptive): ${candidates.length} sample${candidates.length === 1 ? '' : 's'} → score ${candidates[0].score}`);
      for (const op of candidates[0].ops) {
        try { const s = await applyFn(op); if (typeof s === 'string') { applied++; opsTotal++; emit('op', s, { op, bestOf: true }); } } catch { /* skip */ }
      }
      return true;
    };

    // ── GENERATION MODE: archetype template OR element seed → best-of-N polish → verify ──
    if (generateMode) {
      // archetype detection: an explicit opts.template wins; else read the instruction + brief
      const archetype = opts.template || detectTemplate(`${instruction} ${opts.brief || ''}`);
      if (archetype) {
        emit('thinking', `this reads like a ${archetype} ad — scaffolding the full archetype, then polishing copy`);
        const r = applyOp(work, { op: 'template', template: archetype, params: opts.templateParams || {} }, opCtx);
        templateSeeded = true; // finished layout: no autolayout, no completeness lint
        emit('op', typeof r === 'string' ? r : `template ${archetype}`, { deterministic: true });
      } else {
        emit('thinking', 'no clear archetype in the brief — seeding headline/cta from the element library');
        const seeds = seedFromTemplate(work, opCtx, { brief: opts.brief, kit });
        for (const s of seeds) emit('op', s, { deterministic: true });
      }
      if (useHarness) {
        const n = Number.isFinite(opts.bestOf) ? opts.bestOf : 3;
        const seeded = n > 1 ? await bestOfSeed(n) : false;
        // short batch pass to react to lint / finish the polish
        await runBatch(instruction, { maxTurns: seeded ? 2 : 3, generate: true });

        // CONVERGENCE GUARD (raise the self-review bar — "don't stop half-built"): if there's no
        // vision endpoint to critique with AND the comp still lints dirty / scores below GOOD, run
        // ONE more corrective batch aimed squarely at the remaining findings. Token-disciplined:
        // fires at most once, and only when the polish left real problems.
        if (!process.env.VISION_BASE_URL) {
          let findings = [];
          try { findings = lintDesign(work, kit); } catch { findings = []; }
          if (findings.length || layoutScore(work, kit) < GOOD) {
            const goal = findings.length
              ? `The comp still has issues — fix them so it ships clean: ${findings.slice(0, 5).join('; ')}. Then done.`
              : 'Tighten hierarchy and contrast so the comp reads as a finished, shippable ad. Then done.';
            emit('thinking', `polish left ${findings.length} finding(s) / score ${layoutScore(work, kit)} — one corrective pass`);
            await runBatch(goal, { maxTurns: 2, generate: true });
          }
        }

        // TRUE self-improvement: when a vision endpoint is up (Gemma), the agent LOOKS at its
        // own render and fixes what it sees — not just N blind samples. Render → critique →
        // one corrective turn, up to `visionRefine` rounds (default 2, off without vision or
        // when opts.visionRefine === 0). This is what makes "3× reads" become real iteration.
        // main-turn vision already showed the model its render each batch — one refine round
        // is enough then (was 2); text-only workers keep the full 2-round critique loop.
        const refineRounds = opts.visionRefine != null ? opts.visionRefine : (process.env.VISION_BASE_URL ? (mainTurnVision ? 1 : 2) : 0);
        for (let vr = 0; vr < refineRounds; vr++) {
          if (opts.signal && opts.signal.aborted) break;
          emit('thinking', `looking at the render (self-critique ${vr + 1}/${refineRounds})…`);
          let crit;
          try { crit = await lookAtComp(work); } catch { crit = { ok: false }; }
          if (!crit.ok || !crit.critique) { emit('thinking', 'vision critique unavailable — skipping'); break; }
          if (/^\s*ready\b/i.test(crit.critique)) { emit('op', `self-critique: ready`, { deterministic: true }); break; }
          emit('op', `self-critique → ${crit.critique.slice(0, 140)}`, { deterministic: true });
          await runBatch(`Fix these issues you can SEE in the current render: ${crit.critique}`, { maxTurns: 2, generate: true });
        }
      }
    } else if (useHarness) {
      source = model.provider === 'deepseek' ? 'deepseek' : model.provider;
      // FAST PATH routing: short single-target trivial edits run ONE focused turn (cap 2) with
      // the minimal prompt and a scoped observation — no lint gate, no vision, no best-of.
      // Zero applied ops escalates to the untouched full loop, so nothing is ever lost.
      const fast = opts.fast !== false && isTrivialEdit(instruction, opts);
      let run = null;
      if (fast) {
        emit('thinking', 'fast path: trivial edit — one focused turn, minimal context');
        run = await runBatch(instruction, { maxTurns: 2, fast: true });
        // ZERO applied ops = the fast turn changed nothing (even if the model said done) —
        // escalate to the untouched full loop so the user's ask is never silently dropped.
        if (run.applied === 0) {
          emit('thinking', 'fast path produced no applied ops — escalating to the full loop');
          run = null;
        }
      }
      if (!run) run = await runBatch(instruction, { maxTurns: MAX_TURNS });
      if (!run.ok && run.applied === 0) {
        if (opts.noCodex) {
          emit('thinking', `${source} produced no applied ops (${run.stoppedBy}) — deterministic autolayout`);
          const pre = autoLayoutDoc(work, { kit });
          emit('op', pre.summary, { deterministic: true });
          source = 'autolayout';
        } else {
          emit('thinking', `${source} produced no applied ops (${run.stoppedBy}) — trying codex fallback`);
          source = null; // fall through
        }
      }
    }

    if ((source == null || !useHarness) && !opts.noCodex && !generateMode) {
      // ── fallback: codex single-shot JSON array (legacy behavior) — skipped when noCodex ──
      const nodeLines = observe(work, { aliases });
      const prompt =
        `You lay out ad comps by editing a JSON scene graph.\n${nodeLines}\n`
        + `Instruction: ${instruction}\n`
        + `Reply with ONLY a JSON array (max ${MAX_OPS} items) of operations, no prose. Grammar:\n`
        + `{"op":"move","id":"…","x":n,"y":n} {"op":"resize","id":"…","w":n,"h":n} `
        + `{"op":"setText","id":"…","text":"…"} {"op":"setStyle","id":"…","style":{"fontSize":n,"color":"…","background":"…"}} `
        + `{"op":"remove","id":"…"}\n`
        + `Never touch the base image layer. Keep boxes inside the canvas.`;
      let ops = null;
      source = 'codex';
      const r = await codexText(prompt, { timeoutMs: 90_000 });
      if (r.ok) ops = parseOpsArray(r.text);
      if (!ops) {
        source = 'fallback';
        emit('thinking', `codex unavailable or unparsable (${r.error || 'bad ops JSON'}) — using auto-layout fallback`);
        ops = fallbackOps(work);
      }
      applied = 0;
      opsTotal = ops.length;
      for (const op of ops) {
        let summary = null;
        try { summary = applyOp(work, op, opCtx); } catch { summary = null; }
        if (summary && typeof summary === 'string') { applied++; emit('op', summary, { op, model: source === 'codex' ? 'codex' : null }); }
        else emit('op', `skipped invalid op (${op && op.op})`, { op });
      }
    }

    // FINAL grouping (generate mode): a shippable ad has a clean layer hierarchy, not a flat pile.
    // A template scaffold is already grouped; the element-seed path is not — fold its loose leaves
    // into named region groups so the user opens a tidy tree (header/body/product/cta), not 50
    // ungrouped layers. Never fires on edits (which must preserve the doc's existing structure).
    if (generateMode) {
      try {
        const made = groupIntoRegions(work);
        if (made) { if (aliases) aliases.sync(work); emit('op', `grouped into ${made} named region${made === 1 ? '' : 's'} (header/body/product/cta)`, { deterministic: true }); }
      } catch { /* grouping must never fail a run */ }
    }

    // FINAL contrast pass (zero-token): the per-op repair excludes agent-styled layers, and a
    // setText on an element child rebuilds it from params at its DEFAULT color — so a headline
    // the agent rewrote can end up invisible on a dark base. Re-run the deterministic contrast
    // flip once here, with NO exclusions, so final colors match final positions/fills.
    try {
      const finalAd = smartAdRepair(work, { kit });
      if (finalAd.summaries.length) emit('op', finalAd.summary, { deterministic: true });
    } catch { /* repair must never fail a run */ }

    work.updatedAt = Date.now();
    totals.inTok = usage.inTok;
    totals.outTok = usage.outTok;
    const afterScore = layoutScore(work, kit);
    lintReport = lintReport || lintDesign(work, kit);

    // Verify is REPORTING-ONLY now — lint runs inside the loop every turn and gates "done",
    // so a post-run fix rerun would just re-litigate what the loop already saw.
    const verify = verifyDesign(work, { kit, skeletonId: work.skeletonId });

    // Self-improving retrieval: verified high-scoring generations feed the layout library, so
    // the next generate run retrieves proven structures instead of inventing (LayoutGPT-style
    // ICL — the more the agent ships, the better its exemplars get). Best-effort, never fatal.
    if (generateMode && verify.ready && afterScore >= 85 && applied > 0) {
      try {
        indexLayout({
          id: `gen-${work.id}`,
          tags: String(opts.brief || instruction || '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 3).slice(0, 12),
          aspect: aspectTag(work.canvas.w, work.canvas.h),
          skeleton: docSkeleton(work),
          score: afterScore,
          source: `agent:${runId}`,
        });
        emit('thinking', `layout indexed for retrieval (score ${afterScore})`);
      } catch { /* library write is best-effort */ }
    }

    emit('verify',
      `${verifySummary(verify)} · ${totals.parts} part${totals.parts === 1 ? '' : 's'} · ${applied}/${opsTotal} ops · layout ${beforeScore}→${afterScore} · ${((usage.inTok + usage.outTok) / 1000).toFixed(1)}k tok · ${source}`,
      { model: source === 'deepseek' ? model.model : source, totals, layoutScore: afterScore, verify });
    onStep({ runId, done: true });
    return { doc: work, steps, source, runId, applied, usage, lint: lintReport, totals, layoutScore: afterScore, verify };
  } finally {
    inFlight--;
  }
}

// ── copy drafting ────────────────────────────────────────────────────────────────────────────────

/** Rough max chars per wrapped line for a text layer (same glyph-width model as type-scale). */
function layerCharBudget(node) {
  const s = node.style || {};
  const fs = s.fontSize || 40;
  const fw = s.fontWeight || 600;
  const glyph = fs * (fw >= 800 ? 0.58 : fw >= 700 ? 0.55 : 0.52);
  const pad = s.pill && s.background ? fs * 0.55 : (s.padding || 0);
  const usable = Math.max(8, (node.box?.w || 200) - pad * 2);
  return Math.max(4, Math.floor(usable / glyph));
}

/** Per-layer copy context lines: role, current text, chars/line budget, max lines that fit. */
function copyContextLines(doc, nodes) {
  return nodes.map((n) => {
    const s = n.style || {};
    const fs = s.fontSize || 40;
    const lineH = fs * (s.lineHeight || 1.2) * (s.pill && s.background ? 1.25 : 1);
    const maxLines = n.autoH !== false ? 4 : Math.max(1, Math.floor((n.box?.h || fs) / lineH));
    const cur = n.text ? ` now:"${String(n.text).replace(/\s+/g, ' ').slice(0, 60)}"` : '';
    return `${n.id} role=${n.role || n.type} budget=${layerCharBudget(n)} chars/line, ≤${maxLines} lines${cur}`;
  });
}

/**
 * In-loop copywriter (the agent's "draftText" op): rewrites the given layers' text with FULL
 * scene + brand context and per-layer character budgets computed from the actual boxes — the
 * root fix for captions that clip. Mutates the doc via setText-equivalent + touchText.
 * Returns { ok, summary?, touched:[ids], error? }.
 */
export async function draftTextForLayers(doc, nodes, { brief, referenceText, kit, brandSkill, llmCall = llmText, signal = null } = {}) {
  if (!nodes || !nodes.length) return { ok: false, error: 'draftText: no valid text layers — pass "ids" of text layers', touched: [] };
  const ctx = [];
  if (brief) ctx.push(`Brief/copy: ${String(brief).slice(0, 400)}`);
  if (referenceText) ctx.push(`Reference ad text: ${String(referenceText).slice(0, 400)}`);
  if (brandSkill) ctx.push(`BRAND VOICE:\n${String(brandSkill).slice(0, 1200)}`);
  if (kit && kit.notes) ctx.push(`Brand notes: ${String(kit.notes).slice(0, 200)}`);
  const scene = leaves(doc.layers || [])
    .filter((n) => n.text && !n.hidden)
    .slice(0, 12)
    .map((n) => `${n.role || n.type}: "${String(n.text).replace(/\s+/g, ' ').slice(0, 60)}"`)
    .join('\n');
  const targets = copyContextLines(doc, nodes);
  const prompt = `${ctx.length ? `CONTEXT:\n${ctx.join('\n')}\n\n` : ''}ALL TEXT IN THE COMP (for tone/consistency):\n${scene || '(none)'}\n\nREWRITE THESE LAYERS (respect each budget EXACTLY — copy that exceeds chars/line will wrap or clip):\n${targets.join('\n')}\n\nDraft punchy direct-response ad copy. Reply with ONLY a JSON object mapping layer id → new text, e.g. {"${nodes[0].id}":"…"}. Use \\n for deliberate line breaks. Every line ≤ its budget.`;
  const r = await llmCall(prompt, {
    system: 'You write short, high-converting ad copy that fits exact character budgets. Reply with one JSON object only.',
    json: true,
    maxTokens: 1500, // reasoning headroom (see agent-harness maxTokensPerTurn)
    purpose: 'draft-copy',
    temperature: 1.0, // DeepSeek writes flat copy at temp 0 — creative tasks want ~1.0
    signal,
  });
  if (!r.ok) return { ok: false, error: r.error, touched: [] };
  let j;
  try {
    const m = String(r.text).match(/\{[\s\S]*\}/);
    j = JSON.parse(m ? m[0] : r.text);
  } catch { return { ok: false, error: 'unparsable copy JSON', touched: [] }; }
  const touched = [];
  const notes = [];
  for (const n of nodes) {
    const t = j[n.id];
    if (typeof t !== 'string' || !t.trim()) continue;
    // hard-enforce the budget: wrap-aware truncation per line
    const budget = layerCharBudget(n);
    const clipped = t.trim().split('\n').map((line) => line.length > budget * 1.15 ? line.slice(0, budget).replace(/\s+\S*$/, '') : line).join('\n').slice(0, 300);
    n.text = clipped;
    touchText(n, doc, notes);
    touched.push(n.id);
  }
  if (!touched.length) return { ok: false, error: 'model returned no usable copy for the given ids', touched: [] };
  return { ok: true, summary: `draftText → ${touched.length} layer(s) rewritten${noteStr(notes)}`, touched };
}

/**
 * One-shot copy suggestions for a doc: { headline, subline, cta }. Pure suggestion — the doc is
 * NOT mutated. Now layout-aware: budgets from the real headline/subhead/cta boxes are included
 * so suggestions fit. Returns { ok, suggestions?, error?, usage? }.
 */
export async function draftCopy(doc, { brief, referenceText, kit, brandSkill } = {}) {
  const texts = leaves(doc.layers || []).filter((n) => n.text != null && !n.hidden);
  const byRole = (role) => texts.find((n) => n.role === role) || null;
  const budgetOf = (role, dflt) => { const n = byRole(role); return n ? layerCharBudget(n) : dflt; };
  const existing = texts.slice(0, 10).map((n) => `${n.role || n.type}: "${String(n.text).slice(0, 80)}"`).join('\n');
  const ctx = [];
  if (brief) ctx.push(`Brief/copy: ${String(brief).slice(0, 400)}`);
  if (referenceText) ctx.push(`Reference ad text: ${String(referenceText).slice(0, 400)}`);
  if (brandSkill) ctx.push(`BRAND VOICE:\n${String(brandSkill).slice(0, 1200)}`);
  if (kit && kit.notes) ctx.push(`Brand notes: ${String(kit.notes).slice(0, 200)}`);
  const prompt = `${ctx.length ? `CONTEXT:\n${ctx.join('\n')}\n\n` : ''}CURRENT TEXT LAYERS:\n${existing || '(none)'}\n\nDraft punchy direct-response ad copy for this comp. Reply with ONLY a JSON object: {"headline":"…","subline":"…","cta":"…"}. Budgets (max chars — copy exceeding them clips): headline ≤ ${budgetOf('headline', 22)}, subline ≤ ${budgetOf('subhead', 36) * 2}, cta ≤ ${budgetOf('cta', 18)}.`;
  const r = await llmText(prompt, {
    system: 'You write short, high-converting ad copy that fits exact character budgets. Reply with one JSON object only.',
    json: true,
    maxTokens: 1500, // reasoning headroom (see agent-harness maxTokensPerTurn)
    purpose: 'draft-copy',
    temperature: 1.0,
  });
  if (!r.ok) return { ok: false, error: r.error, usage: r.usage };
  try {
    const m = String(r.text).match(/\{[\s\S]*\}/);
    const j = JSON.parse(m ? m[0] : r.text);
    const pick = (k, max) => (typeof j[k] === 'string' ? j[k].trim().slice(0, max) : '');
    const suggestions = { headline: pick('headline', 80), subline: pick('subline', 120), cta: pick('cta', 40) };
    if (!suggestions.headline && !suggestions.subline && !suggestions.cta) {
      return { ok: false, error: 'model returned no usable copy', usage: r.usage };
    }
    return { ok: true, suggestions, usage: r.usage };
  } catch {
    return { ok: false, error: 'unparsable copy JSON', usage: r.usage };
  }
}
