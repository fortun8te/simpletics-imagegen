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
// plan-act-verify harness (lib/agent-harness.mjs runBatchAgent, v5) → deterministic auto-layout
// fallback (codex was REMOVED — Ornith-only, never shell out to another model). Lint runs IN the
// loop and gates "done"; generation mode
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
//   { "op":"cutout",   "box", "region", "src"?, "shape"? }         (LAST RESORT: lift a non-editable
//                                                                   avatar/logo out of the reference —
//                                                                   crop sub-rect + auto shape mask)
//   { "op":"autolayout" }                                          (ZERO-token deterministic layout pass)
//   { "op":"done",     "summary"? }

import { llmText, llmVision, hasLlm, llmInfo } from './llm.mjs';
import { runBatchAgent, parseBatch, runFanOut, makerChecker, nextSubAgentId } from './agent-harness.mjs';
import { extractLayout } from './layout-extract.mjs';
import { exemplarBlock, aspectTag, indexLayout, docSkeleton } from './layout-library.mjs';
import { ELEMENTS, ELEMENT_ALIASES, buildElement, elementCatalogLine, applyElementTextEdit } from './elements.mjs';
import { buildTemplate, templateCatalog, detectTemplate, applyTemplateTextEdit } from './templates.mjs';
import { lookAtComp, renderCompPng, compareToReference } from './self-vision.mjs';
import { matteCutout, matteCacheKey } from './matte.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// .state dir (matte-upgraded cutout assets are written into .state/refs/ so the existing
// /refasset?id= route serves them unchanged).
const STATE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '.state');

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
  // cut-out crop: a sub-rect of the SOURCE image (fractions 0..1) — see the {"op":"cutout"} op.
  'crop',
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

// ── Meaningful auto-naming ─────────────────────────────────────────────────────────────────────
// A layer without an explicit model-supplied name used to fall back to its bare TYPE ("text",
// "image", "Group"), which then flowed into both the layers panel AND the Figma export. deriveLayerName
// gives every layer a HUMAN name instead — deterministic, ≤60 chars — so the tree and Figma nodes read
// like a designer named them. NEVER call this to override a name the model explicitly provided.

/** Title-Case a short text snippet for use as a layer name. Collapses whitespace/newlines,
 *  strips wrapping quotes, truncates to ~24 chars on a word boundary (…), and caps each word. */
function titleSnippet(raw, max = 24) {
  let s = String(raw || '').replace(/\s+/g, ' ').replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim();
  if (!s) return '';
  if (s.length > max) {
    const cut = s.slice(0, max);
    const sp = cut.lastIndexOf(' ');
    s = (sp > max * 0.5 ? cut.slice(0, sp) : cut).trim() + '…';
  }
  // Title-case ASCII words but leave ALL-CAPS acronyms and %/$ tokens alone.
  return s.replace(/[A-Za-z][A-Za-z'’]*/g, (w) => (
    w.length > 1 && w === w.toUpperCase() ? w : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
  ));
}

// role → friendly label for image/shape/group layers with no usable text.
const ROLE_IMAGE_LABEL = {
  product: 'Product', avatar: 'Avatar', background: 'Background', bg: 'Background',
  base: 'Background', logo: 'Logo', photo: 'Photo', hero: 'Hero image', icon: 'Icon',
  cutout: 'Cut-out',
};
const ROLE_TEXT_LABEL = {
  headline: 'Headline', title: 'Headline', subhead: 'Subhead', subtitle: 'Subhead',
  body: 'Body', caption: 'Body', eyebrow: 'Eyebrow', price: 'Price', quote: 'Quote',
  disclaimer: 'Disclaimer', label: 'Label',
};
const ROLE_SHAPE_LABEL = {
  badge: 'Badge', card: 'Card', divider: 'Divider', scrim: 'Scrim', vignette: 'Vignette',
  decor: 'Decoration', line: 'Divider', pill: 'Pill', panel: 'Panel', chart: 'Chart',
};

/** Human display name for a layer that has no explicit model-supplied name. Pure + deterministic,
 *  ≤60 chars. `opts.cutout` forces the image label to "Cut-out"; `opts.placeholder` marks a gray
 *  image placeholder. Rules:
 *    text/badge/button → Title-Cased text snippet, else its role label ("Headline"/"Body"/…)
 *    button            → "<text|role> button"  ("Shop Now button")
 *    image             → role label ("Product"/"Avatar"/"Background"/"Logo") or "Cut-out"
 *    shape/group       → role label ("Badge"/"Card"/"Divider") else a sensible type default    */
export function deriveLayerName(layer, opts = {}) {
  if (!layer || typeof layer !== 'object') return 'Layer';
  const type = layer.type;
  const role = String(layer.role || '').toLowerCase();
  const snippet = titleSnippet(layer.text);

  if (type === 'button') {
    const label = snippet || ROLE_TEXT_LABEL[role] || (role && role !== 'button' ? titleSnippet(role) : 'Button');
    return `${label} button`.slice(0, 60);
  }
  if (type === 'text' || type === 'badge') {
    if (type === 'badge' && !snippet) return (ROLE_SHAPE_LABEL[role] || 'Badge').slice(0, 60);
    if (snippet) return snippet.slice(0, 60);
    return (ROLE_TEXT_LABEL[role] || (role ? titleSnippet(role) : 'Text')).slice(0, 60);
  }
  if (type === 'image') {
    if (opts.cutout) return 'Cut-out';
    if (ROLE_IMAGE_LABEL[role]) return ROLE_IMAGE_LABEL[role];
    if (opts.placeholder) return 'Image placeholder';
    // Enhanced: include crop info if present
    const crop = layer.style && layer.style.crop;
    if (crop && role) return `${titleSnippet(role)} (cropped)`.slice(0, 60);
    return role ? titleSnippet(role).slice(0, 60) : 'Image';
  }
  if (type === 'group') {
    return (layer.name || (role ? titleSnippet(role) : 'Group')).slice(0, 60);
  }
  // shape / vignette / anything else — enhanced with shapeKind and visual hints
  if (type === 'shape') {
    const shapeKind = layer.style && layer.style.shapeKind;
    const hasGradient = layer.style && layer.style.gradient;
    const hasStroke = layer.style && layer.style.stroke && layer.style.stroke.width > 0;
    let base = ROLE_SHAPE_LABEL[role] || (role && role !== type ? titleSnippet(role) : null);
    if (!base) {
      if (shapeKind === 'ellipse') base = 'Ellipse';
      else if (shapeKind === 'polyline') base = 'Polyline';
      else if (shapeKind === 'arrow' || shapeKind === 'line') base = 'Line';
      else base = 'Rectangle';
    }
    // Add visual descriptors for Figma-friendliness
    const descriptors = [];
    if (hasGradient) descriptors.push('gradient');
    if (hasStroke) descriptors.push('stroked');
    if (shapeKind === 'starburst') descriptors.push('starburst');
    if (layer.style && layer.style.backdropBlur) descriptors.push('glass');
    if (descriptors.length) return `${base} (${descriptors.join(', ')})`.slice(0, 60);
    return base.slice(0, 60);
  }
  // vignette / anything else
  return (ROLE_SHAPE_LABEL[role] || (role && role !== type ? titleSnippet(role) : titleSnippet(type) || 'Shape')).slice(0, 60);
}

/** Name for a freshly-formed group with no explicit name: prefer a CTA/product/header cue from
 *  its children, else the headline/first-text snippet, else "Group". Deterministic, ≤60 chars.
 *  v2: includes a descriptive suffix from the dominant child content when available. */
export function deriveGroupName(children) {
  const kids = Array.isArray(children) ? children : [];
  const roles = kids.map((n) => String(n?.role || '').toLowerCase());

  // CTA groups: include the button text or role hint
  if (roles.some((r) => /cta|button/.test(r)) || kids.some((n) => n?.type === 'button')) {
    const btn = kids.find((n) => n?.type === 'button' || /cta|button/.test(String(n?.role || '')));
    const snippet = btn ? titleSnippet(btn.text || btn.role || '') : '';
    return snippet ? `CTA - ${snippet}`.slice(0, 60) : 'CTA';
  }

  // Product groups: describe what kind of product visual
  if (roles.some((r) => /product|avatar|photo|hero/.test(r))) {
    const img = kids.find((n) => /product|avatar|photo|hero/.test(String(n?.role || '')));
    const roleLabel = img ? titleSnippet(img.role || '') : '';
    return roleLabel ? `Product - ${roleLabel}`.slice(0, 60) : 'Product';
  }

  // Header groups: include the headline text
  if (roles.some((r) => /headline|title|nav|badge/.test(r))) {
    const head = kids.find((n) => /headline|title|nav/.test(String(n?.role || '')) && n?.text);
    const snippet = head ? titleSnippet(head.text) : '';
    return snippet ? `Header - ${snippet}`.slice(0, 60) : 'Header';
  }

  // Decorative: background shapes, dividers, vignettes
  const shapeKids = kids.filter((n) => n?.type === 'shape' || n?.type === 'vignette');
  if (shapeKids.length >= kids.length * 0.6 && kids.length >= 2) {
    return 'Decorative elements';
  }

  // Fallback: use the first text snippet
  const head = kids.find((n) => (n?.type === 'text' || n?.type === 'badge') && n?.text);
  if (head) return titleSnippet(head.text).slice(0, 60) || 'Group';
  return 'Group';
}

/** True when `name` is exactly what deriveLayerName would produce from `layer`'s CURRENT text —
 *  i.e. the name was auto-derived from text and never user-renamed. Used by setText to keep an
 *  auto name in sync with edited copy WITHOUT ever clobbering a user/model-chosen name. */
function nameIsAutoFromText(layer, name) {
  if (!name || typeof name !== 'string') return false;
  const type = layer.type;
  if (type !== 'text' && type !== 'badge' && type !== 'button') return false;
  return name === deriveLayerName(layer);
}

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

// ── theme-aware backgrounds (server mirror of src/lib/sceneGraph.ts THEME_BG/THEME_FG) ───────────
// A comp's base + text colors follow the ad's LIGHT / DARK theme rather than a single hardcoded
// color. THEME_BG is the neutral base fill; THEME_FG is the foreground token the contrast rules
// flip text to. Extraction derives the theme from the reference background luminance.
const THEME_BG = { light: '#f7f8fa', dark: '#0c0e14' };
const THEME_FG = { light: '#111111', dark: '#f5f5f5' };

/** Theme from a background luminance (0..1): darker than mid-grey → 'dark'. Matches the contrast
 *  rule (bgLum < 0.5) so a comp's base and its text flips stay consistent. */
export function themeFromLuminance(bgLum) {
  return typeof bgLum === 'number' && bgLum < 0.5 ? 'dark' : 'light';
}

/** The base layer a skeleton's `background` dictates, or null when none is warranted. A gradient →
 *  gradient base; a genuine solid hex → solid base; a PHOTO reference (background null) → null (the
 *  overlays float over the doc's existing base — NO unwanted flat solid injected). */
function baseFromSkeletonBackground(bg, canvas) {
  if (bg && typeof bg === 'object' && bg.from && bg.to) {
    return {
      id: newId('base'), type: 'shape', role: 'base', name: 'Base gradient',
      box: { x: 0, y: 0, w: canvas.w, h: canvas.h },
      style: {
        background: bg.from,
        gradient: { type: 'linear', angle: Math.round(Number(bg.angle) || 180), stops: [{ color: bg.from, pos: 0 }, { color: bg.to, pos: 1 }] },
      },
    };
  }
  if (typeof bg === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(bg)) {
    return {
      id: newId('base'), type: 'shape', role: 'base', name: 'Base color',
      box: { x: 0, y: 0, w: canvas.w, h: canvas.h },
      style: { shapeKind: 'rect', background: bg },
    };
  }
  return null;
}

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

// ── enhanced semantic grouping (v2) ─────────────────────────────────────────────────────────────
// `groupIntoRegions` does a basic vertical-band fold for flat docs. `semanticGrouping` goes further:
// it works on ALREADY-grouped docs too, creating a meaningful 3-level hierarchy (Header / Body / CTA
// / Product / Decorative) with descriptive sub-group names. Designed for Figma export: layer names
// read like a designer organized them, nesting depth stays at 3 (Figma-optimal), and every group
// has bounds encompassing all children.

/** Classify a leaf node into one of 5 semantic categories by role, type, content, and position. */
function semanticCategory(node, ch) {
  if (!node || !node.box) return 'body';
  const role = String(node.role || '').toLowerCase();
  const type = node.type;
  const cy = (Number(node.box.y) || 0) / Math.max(1, ch);
  const cx = (Number(node.box.x) + (Number(node.box.w) || 0) / 2) / Math.max(1, 1);

  // CTA: buttons, CTAs, action-oriented roles
  if (/cta|button|buy|shop|shop now|order|sign up|subscribe|learn more|get started|add to cart/i.test(role + ' ' + (node.text || ''))) return 'cta';
  if (type === 'button') return 'cta';

  // Header: top zone + headline/title/nav/badge roles
  if (/headline|title|nav|logo|header|eyebrow|badge|tag/i.test(role)) return 'header';
  if (cy < 0.22 && (type === 'text' || type === 'badge')) return 'header';

  // Product: product images, avatars, hero visuals, cut-outs
  if (/product|avatar|photo|hero|cutout|model|person|face|shot|lifestyle/i.test(role)) return 'product';
  if (type === 'image' && /product|avatar|photo|hero|cutout/.test(role)) return 'product';

  // Decorative: background shapes, dividers, vignettes, scrim layers
  if (/scrim|divider|vignette|decor|background|bg|base/.test(role)) return 'decorative';
  if (type === 'vignette') return 'decorative';
  if (type === 'shape' && (node.style?.backdropBlur || node.style?.gradient || /scrim|divider/.test(role))) return 'decorative';

  // Body: everything else (captions, descriptions, prices, subheads, body text)
  return 'body';
}

/** Descriptive suffix for a semantic group based on the dominant children. */
function semanticGroupSuffix(category, children) {
  if (!children || !children.length) return '';
  const roles = children.map((n) => String(n?.role || '').toLowerCase());
  const types = children.map((n) => n?.type || '');

  switch (category) {
    case 'header': {
      const hasLogo = roles.some((r) => /logo/.test(r));
      const hasNav = roles.some((r) => /nav|menu/.test(r));
      const parts = [];
      if (hasLogo) parts.push('Logo');
      if (hasNav) parts.push('Nav');
      const headlineChild = children.find((n) => /headline|title/.test(String(n?.role || '')));
      if (headlineChild?.text) parts.push(titleSnippet(headlineChild.text));
      else if (children.some((n) => n?.type === 'badge')) parts.push('Badge');
      return parts.length ? ` - ${parts.slice(0, 2).join(' & ')}` : '';
    }
    case 'product': {
      const imgs = children.filter((n) => n?.type === 'image');
      const texts = children.filter((n) => n?.type !== 'image');
      if (imgs.length === 1 && texts.length === 0) {
        const roleLabel = ROLE_IMAGE_LABEL[roles.find((r) => ROLE_IMAGE_LABEL[r]) || ''] || '';
        return roleLabel ? ` - ${roleLabel}` : '';
      }
      if (imgs.length > 1) return ` - ${imgs.length} visuals`;
      return '';
    }
    case 'cta': {
      const btn = children.find((n) => n?.type === 'button' || /cta|button/.test(String(n?.role || '')));
      if (btn?.text) return ` - ${titleSnippet(btn.text)}`;
      const label = children.find((n) => n?.text);
      if (label?.text) return ` - ${titleSnippet(label.text)}`;
      return '';
    }
    case 'decorative': {
      const kinds = [...new Set(children.map((n) => {
        if (n?.type === 'vignette') return 'Vignette';
        if (n?.style?.backdropBlur) return 'Glass';
        if (n?.style?.gradient) return 'Gradient';
        if (/scrim/.test(String(n?.role || ''))) return 'Scrim';
        if (/divider|line/.test(String(n?.role || ''))) return 'Divider';
        return 'Shape';
      }))];
      return kinds.length <= 2 ? ` - ${kinds.join(' & ')}` : ` - ${kinds.length} effects`;
    }
    default: return '';
  }
}

const SEMANTIC_LABELS = {
  header: 'Header',
  body: 'Body',
  cta: 'CTA',
  product: 'Product',
  decorative: 'Decorative',
};

/**
 * Enhanced semantic grouping: organizes a doc's layers into a meaningful 3-level hierarchy
 * with descriptive names. Works on both flat and already-grouped docs. For Figma export:
 * groups have bounds encompassing all children, names are descriptive, depth stays at 3 max.
 *
 * Mutates doc. Returns { groups: number, renamed: number } with counts of changes made.
 */
export function semanticGrouping(doc) {
  const { h: ch } = doc.canvas || { h: 1 };
  const top = doc.layers || [];
  let groupsCreated = 0;
  let namesImproved = 0;

  // Collect all loose leaves (not in any group, not base/background)
  const loose = [];
  const keep = [];
  for (const n of top) {
    if (!n) continue;
    if (n.type === 'group') {
      keep.push(n);
      // Improve names of existing groups
      const improved = improveGroupName(n, ch);
      if (improved !== n.name) { n.name = improved; namesImproved++; }
    } else if (n.role === 'base' || n.role === 'background') {
      keep.push(n);
    } else {
      loose.push(n);
    }
  }

  // Need at least 3 loose leaves to bother grouping
  if (loose.length < 3) {
    doc.layers = keep;
    normalizeGroups(doc);
    return { groups: 0, renamed: namesImproved };
  }

  // Classify and bucket
  const buckets = { header: [], body: [], cta: [], product: [], decorative: [] };
  for (const n of loose) {
    const cat = semanticCategory(n, ch);
    buckets[cat].push(n);
  }

  // Build groups with descriptive names
  const out = [...keep];
  const ORDER = ['header', 'product', 'body', 'cta', 'decorative'];
  for (const cat of ORDER) {
    const kids = buckets[cat];
    if (kids.length >= 2) {
      const suffix = semanticGroupSuffix(cat, kids);
      const name = `${SEMANTIC_LABELS[cat]}${suffix}`.slice(0, 60);
      out.push({
        id: newId('group'),
        type: 'group',
        name,
        box: groupBounds(kids) || { x: 0, y: 0, w: 0, h: 0 },
        children: kids,
      });
      groupsCreated++;
    } else if (kids.length === 1) {
      out.push(kids[0]);
    }
  }

  doc.layers = out;
  normalizeGroups(doc);
  return { groups: groupsCreated, renamed: namesImproved };
}

/** Improve an existing group's name if it's generic (Group, unnamed) or can be made more descriptive. */
function improveGroupName(group, ch) {
  if (!group || group.type !== 'group') return group?.name || 'Group';
  const currentName = group.name || '';
  // Don't override explicitly descriptive names (contain " - " or are specific like "Header - …")
  if (currentName.includes(' - ') || (currentName.length > 4 && !/^(Group|Layer|Section)$/i.test(currentName))) {
    return currentName;
  }
  // Try to derive a better name from the children
  const derived = deriveGroupName(group.children || []);
  if (derived && derived !== 'Group' && derived.length > currentName.length) return derived;
  return currentName || derived || 'Group';
}

// ── skeleton → doc (server-side apply, mirrors src/lib/sceneGraph.ts applySkeleton) ───────────────
// The "copy this reference" build step: fold an extracted skeleton's overlay nodes into the CURRENT
// doc — fresh ids, boxes + typographic metrics scaled to the doc's canvas, the base image kept, any
// previous overlay layers replaced. Kept here (not imported from the TS frontend) so the design
// agent can run copy-reference as an in-editor agent run without a round-trip to the browser.
function scaleBoxInto(box, from, to) {
  const sx = to.w / from.w;
  const sy = to.h / from.h;
  return {
    x: Math.round((box.x || 0) * sx),
    y: Math.round((box.y || 0) * sy),
    w: Math.round((box.w || 0) * sx),
    h: Math.round((box.h || 0) * sy),
  };
}
/** Scale the width-relative typographic metrics of a style by `s` (uniform min-axis scale). */
function scaleStyleMetrics(style, s) {
  if (!style || typeof style !== 'object') return style;
  const out = { ...style };
  for (const k of ['fontSize', 'radius', 'padding', 'letterSpacing']) {
    if (typeof out[k] === 'number') out[k] = Math.round(out[k] * s * 10) / 10;
  }
  if (out.stroke && typeof out.stroke === 'object' && typeof out.stroke.width === 'number') {
    out.stroke = { ...out.stroke, width: Math.max(1, Math.round(out.stroke.width * s)) };
  }
  return out;
}

/**
 * Apply an extracted skeleton ({ canvas, layers, background }) onto `doc` in place. Replaces the
 * doc's non-base overlay layers with the skeleton's (fresh ids, scaled to the doc canvas), keeps
 * the base image, stamps skeletonId. Returns { added } for the op summary.
 */
export function applySkeletonToDoc(doc, skeleton) {
  const from = skeleton.canvas || doc.canvas;
  const to = doc.canvas;
  const s = Math.min(to.w / from.w, to.h / from.h);
  const fresh = JSON.parse(JSON.stringify(skeleton.layers || []));
  let count = 0;
  walkNodes(fresh, (n) => {
    n.id = newId(n.role || n.type || 'layer');
    if (n.box) n.box = scaleBoxInto(n.box, from, to);
    if (n.type !== 'group') {
      if (n.style) n.style = scaleStyleMetrics(n.style, s);
      if (n.type === 'text' || n.type === 'badge' || n.type === 'button') n.autoH = true;
    }
    count++;
  });
  const overlays = fresh.filter((n) => n.type === 'group' || n.role !== 'base');
  const keptBase = (doc.layers || []).filter((n) => n.type !== 'group' && n.role === 'base');
  // The reference's OWN background drives the base: a solid/gradient reference replaces the doc's
  // seeded base with that fill; a PHOTO reference (skeleton.background null) keeps the doc's
  // existing base untouched — we never auto-inject a flat solid the reference didn't have.
  const skelBase = baseFromSkeletonBackground(skeleton.background, to);
  const base = skelBase ? [skelBase] : keptBase;
  doc.layers = [...base, ...overlays];
  if (skeleton.id) doc.skeletonId = skeleton.id;
  normalizeGroups(doc);
  return { added: overlays.length, nodes: count };
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

// ── cut-out crop (server mirror of src/lib/sceneGraph.ts) ───────────────────────────────────────
// The rendering foundation lives in src/lib/sceneGraph.ts (LayerStyle.crop + resolveCrop +
// autoCutoutShape + cropImageCss) and every renderer already draws it. That's a TS module the
// browser owns; the server keeps a byte-parity JS mirror (same pattern as resolveCropJs in
// designstore.mjs). These two helpers let the AGENT construct a cut-out image layer server-side.

/** PARITY with sceneGraph.ts resolveCrop: normalize a crop to a sane in-bounds sub-rect (fractions
 *  0..1 of the SOURCE image), or null for a missing / identity / degenerate crop. */
function normCropJs(crop) {
  if (!crop || typeof crop !== 'object') return null;
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const x = Math.min(Math.max(num(crop.x, 0), 0), 1);
  const y = Math.min(Math.max(num(crop.y, 0), 0), 1);
  const w = Math.min(Math.max(num(crop.w, 1), 0), 1 - x);
  const h = Math.min(Math.max(num(crop.h, 1), 0), 1 - y);
  if (!(w > 0) || !(h > 0)) return null;
  if (x < 1e-6 && y < 1e-6 && w > 1 - 1e-6 && h > 1 - 1e-6) return null;
  const r = (v) => Math.round(v * 1e6) / 1e6;
  return { x: r(x), y: r(y), w: r(w), h: r(h) };
}

/** PARITY with sceneGraph.ts autoCutoutShape: pick the mask shape for a cut-out from the box aspect
 *  (+ optional hint 'avatar'|'circle'|'logo'|'rounded'|'rect'|'square'). Returns { shape, radius }
 *  where shape is 'circle' (→ shapeKind:'ellipse') / 'roundedRect' (→ radius) / 'rect'. */
function autoCutoutShapeJs(box, hint) {
  const w = Math.max(1, Number(box?.w) || 1);
  const h = Math.max(1, Number(box?.h) || 1);
  const ratio = w / h;
  const longEdge = Math.max(w, h);
  const radius = Math.round(Math.min(w, h) * 0.12);
  if (hint === 'avatar' || hint === 'circle') return { shape: 'circle', radius };
  if (hint === 'rounded') return { shape: 'roundedRect', radius };
  if (hint === 'rect') return { shape: 'rect', radius: 0 };
  if (hint === 'logo' || hint === 'square') return { shape: 'roundedRect', radius };
  if (ratio >= 0.85 && ratio <= 1.18) return { shape: 'circle', radius };
  if (ratio >= 2.4 || ratio <= 1 / 2.4 || longEdge / Math.min(w, h) >= 2.4) return { shape: 'rect', radius: 0 };
  return { shape: 'roundedRect', radius };
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
    // Dark own-background → light text token, light → dark — the SAME theme mapping the base uses,
    // so a flipped text color lands on the theme's foreground rather than a divergent hardcoded hex.
    const newColor = THEME_FG[themeFromLuminance(bgLum)];
    if (newColor.toLowerCase() !== String(color).toLowerCase()) {
      node.style.color = newColor;
      return `auto-flipped color → ${newColor} (was invisible against its background)`;
    }
    return '';
  }
  // Flip the pill/card fill to the theme background OPPOSITE the text so the two stay legible:
  // dark text → light surface token, light text → dark surface token.
  const newBg = THEME_BG[fgLum < 0.5 ? 'light' : 'dark'];
  if (newBg.toLowerCase() !== String(background).toLowerCase()) {
    node.style.background = newBg;
    return `auto-flipped background → ${newBg} (was invisible against text color)`;
  }
  return '';
}

/**
 * Contrast SWEEP over a freshly-built subtree (element insert / setParams rebuild): the reactive
 * guard above only fires on setStyle, so builder-set color+background pairs were never checked
 * (HARNESS-9) — a rebuilt pill could ship invisible text. Walks every leaf carrying BOTH color and
 * background and flips the background to the theme surface opposite the text when the pair is
 * illegible (keeps the builder's text color — matches the guard's flip direction). Returns a note
 * string ('' when nothing needed fixing).
 */
function contrastSweepNote(root) {
  const fixes = [];
  walkNodes([root], (n) => {
    if (!n || n.type === 'group' || !n.style) return;
    const { color, background } = n.style;
    if (!color || !background) return;
    const fg = parseColor(color);
    const bg = parseColor(background);
    if (!fg || !bg) return;
    if (Math.abs(luminance(fg) - luminance(bg)) >= MIN_SELF_CONTRAST) return;
    const newBg = THEME_BG[luminance(fg) < 0.5 ? 'light' : 'dark'];
    if (newBg.toLowerCase() !== String(background).toLowerCase()) {
      n.style.background = newBg;
      fixes.push(`${n.role || n.type}→${newBg}`);
    }
  });
  return fixes.length ? ` (contrast-fixed: ${fixes.join(', ')})` : '';
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
      if (!inst) throw new Error(`element "${op.element}" failed to build — its builder returned nothing (check the params)`);
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
      const contrastNote = contrastSweepNote(inst); // HARNESS-9: builder-set pairs get checked too
      return `element ${def.id} → ${aliasOf(inst.id)} @ ${inst.box.x},${inst.box.y} ${inst.box.w}×${inst.box.h}${noteStr(notes)}${contrastNote}`;
    }

    case 'setParams': {
      if (!node) throw new Error(`unknown target "${ref}" — use a short id from the observation (L1, g2) or a role`);
      if (!node.element || !node.element.id) {
        throw new Error(`${aliasOf(node.id)} is not an element instance — setParams only works on nodes inserted via {"op":"element"}`);
      }
      // instances are stamped with the canonical id, but tolerate alias-stamped older docs
      const elAlias = ELEMENT_ALIASES[node.element.id];
      const def = ELEMENTS.find((e) => e.id === node.element.id) || (elAlias && ELEMENTS.find((e) => e.id === elAlias.id));
      if (!def) throw new Error(`${aliasOf(node.id)}'s element definition no longer exists — it cannot be rebuilt via setParams`);
      if (!op.params || typeof op.params !== 'object') throw new Error('setParams needs a "params" object');
      const merged = { ...node.element.params, ...op.params };
      const fresh = buildElement(node.element.id, doc, merged, ctx.kit || undefined)[0];
      if (!fresh) throw new Error(`rebuilding ${aliasOf(node.id)} with those params produced nothing — check the param values`);
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
      if (!list) throw new Error(`${aliasOf(node.id)} has no parent list — it was likely removed or regrouped by an earlier op this turn; re-read the state before targeting it`);
      list.splice(list.indexOf(node), 1, fresh);
      normalizeGroups(doc);
      if (ctx.aliases) ctx.aliases.sync(doc);
      touchText(fresh, doc);
      touch(fresh);
      const contrastNote = contrastSweepNote(fresh); // HARNESS-9
      return `setParams ${aliasOf(fresh.id)} (${def.id}) → ${Object.keys(op.params).join(', ')}${contrastNote}`;
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
      // Was this layer's name auto-derived from its OLD text (never user/model-renamed)? If so,
      // refresh it to track the new copy. A user-renamed layer won't match → its name is preserved.
      const syncName = nameIsAutoFromText(node, node.name);
      node.text = op.text.slice(0, 300);
      if (syncName) node.name = deriveLayerName(node);
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
      if (!list) throw new Error(`${aliasOf(node.id)} has no parent list — it was likely removed or regrouped by an earlier op this turn; re-read the state before targeting it`);
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
      // explicit group name wins; else name after the dominant child role/text (e.g. "CTA", "Product")
      const gName = op.name ? String(op.name).slice(0, 60) : deriveGroupName(nodes);
      const g = { id: newId('group'), type: 'group', name: gName, box, children: [] };
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
      if (!node) throw new Error(`unknown target "${ref}" — use a short id from the observation`);
      if (node.type !== 'group') throw new Error(`${aliasOf(node.id)} is not a group — ungroup only works on group nodes (g1, g2, …)`);
      const list = findParentList(doc, node.id);
      if (!list) throw new Error(`${aliasOf(node.id)} has no parent list — it was likely removed or regrouped by an earlier op this turn; re-read the state before targeting it`);
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
      if (!list) throw new Error(`${aliasOf(node.id)} has no parent list — it was likely removed or regrouped by an earlier op this turn; re-read the state before targeting it`);
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
      if (!list) throw new Error(`${aliasOf(node.id)} has no parent list — it was likely removed or regrouped by an earlier op this turn; re-read the state before targeting it`);
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
      if (!node) throw new Error(`unknown target "${ref}" — use a short id from the observation`);
      if (node.role === 'base') throw new Error('the base image cannot be reparented');
      const from = findParentList(doc, node.id);
      if (!from) throw new Error(`${aliasOf(node.id)} has no parent list — it was likely removed by an earlier op this turn`);
      let into;
      if (op.into == null) into = doc.layers;
      else {
        const g = resolveNode(doc, op.into, ctx);
        if (!g) throw new Error(`unknown "into" target "${op.into}"`);
        if (g.type !== 'group') throw new Error(`"into" must be a group — ${aliasOf(g.id)} is a ${g.type}`);
        // never reparent a group into itself/its own subtree
        let cycle = g === node;
        walkNodes(node.type === 'group' ? node.children || [] : [], (n) => { if (n === g) cycle = true; });
        if (cycle) throw new Error(`cannot reparent ${aliasOf(node.id)} into its own subtree`);
        into = g.children;
      }
      from.splice(from.indexOf(node), 1);
      const idx = Number.isInteger(op.index) ? clamp(op.index, 0, into.length) : into.length;
      into.splice(idx, 0, node);
      normalizeGroups(doc);
      touch(node);
      return `reparent ${aliasOf(node.id)} → ${op.into || 'root'}[${idx}]`;
    }

    case 'cutout': {
      // LAST-RESORT non-destructive lift of a NON-EDITABLE visual element (a profile picture, a
      // complex logo/icon) out of a REFERENCE image we shouldn't remake — an image layer with a
      // `crop` sub-rect + a shape mask. NEVER for text or anything we can rebuild as an element.
      //   box    = destination on the canvas (absolute px)
      //   region = the sub-rect of the SOURCE image to cut (fractions 0..1 of the source's own w/h)
      //   src    = which image to cut from (default: the base/reference image this comp is built on)
      //   shape  = optional hint (else autoCutoutShape decides from box aspect + region)
      const bx = op.box;
      if (!bx || typeof bx !== 'object') throw new Error('cutout needs a "box" {x,y,w,h} (destination on the canvas, absolute px)');
      const region = normCropJs(op.region);
      if (!region) throw new Error('cutout needs a "region" {x,y,w,h} — the sub-rect of the SOURCE image as fractions 0..1 (e.g. a face at {"x":0.34,"y":0.08,"w":0.32,"h":0.24}); the whole image is not a cut-out');
      // Resolve the source image. Default: the base/reference image the comp was built on. An
      // explicit /refasset?id=REF is honored only when it's one of this run's attachments — the
      // model must never invent srcs (same rule as the `add` op).
      const baseNode = (doc.layers || []).find((n) => n && n.type === 'image' && n.role === 'base' && typeof n.src === 'string');
      let src = baseNode ? baseNode.src : null;
      if (typeof op.src === 'string' && op.src.trim()) {
        const raw = op.src.trim();
        const m = /^\/refasset\?id=([\w-]+)$/.exec(raw);
        if (m && ctx.allowedRefs && ctx.allowedRefs.has(m[1])) src = `/refasset?id=${m[1]}`;
        else if (baseNode && raw === baseNode.src) src = baseNode.src;
        // else: an invented/disallowed src → fall through to the base image below.
      }
      if (!src) throw new Error('cutout: no source image — this comp has no base/reference image to cut from');
      const notes = [];
      const box = {
        w: clamp(repairNum(bx.w, 'box.w', notes), 40, cw),
        h: clamp(repairNum(bx.h, 'box.h', notes), 30, ch),
      };
      // ASPECT LOCK: the crop renders with a fill/cover contract, so a destination box whose
      // aspect differs from the source region's would visibly STRETCH the cut-out (a 4:3 face in
      // a 1:1 box). Preserve the region's aspect by adjusting the box's shorter constraint —
      // keeps the requested width, derives the height (parity-harness-confirmed behavior).
      // Region fractions are of the SOURCE image; assume near-square source pixels (refs are
      // screenshots), so region.w/region.h approximates the true pixel aspect.
      const regionAspect = region.w > 0 && region.h > 0 ? region.w / region.h : 1;
      const boxAspect = box.w / box.h;
      if (Math.abs(boxAspect - regionAspect) / regionAspect > 0.08) {
        const nh = clamp(Math.round(box.w / regionAspect), 30, ch);
        notes.push(`box.h ${box.h}→${nh} (matched to the region's aspect so the cut-out doesn't stretch)`);
        box.h = nh;
      }
      box.x = clamp(snapGridNote(clamp(repairNum(bx.x, 'box.x', notes), 0, cw - box.w), cw, 'x', notes), 0, cw - box.w);
      box.y = clamp(Math.round(repairNum(bx.y, 'box.y', notes)), 0, ch - box.h); // y never grid-snapped
      const HINTS = ['avatar', 'circle', 'logo', 'rounded', 'rect', 'square'];
      const hint = HINTS.includes(op.shape) ? op.shape : null;
      const { shape, radius } = autoCutoutShapeJs(box, hint);
      const style = { crop: region };
      if (shape === 'circle') style.shapeKind = 'ellipse';
      else if (shape === 'roundedRect' && radius > 0) style.radius = radius;
      // else 'rect' → no shapeKind/radius (plain rectangular crop)
      const cutoutRole = typeof op.role === 'string' ? op.role.slice(0, 40) : 'cutout';
      const layer = {
        id: newId('cutout'),
        type: 'image',
        role: cutoutRole,
        // explicit name wins; else a role label ("Avatar"/"Logo"), defaulting to "Cut-out"
        name: typeof op.name === 'string' && op.name.trim()
          ? op.name.slice(0, 60)
          : deriveLayerName({ type: 'image', role: cutoutRole }, { cutout: cutoutRole === 'cutout' }),
        src,
        fit: 'cover',
        box,
        style,
      };
      doc.layers.push(layer);
      normalizeGroups(doc);
      if (ctx.aliases) ctx.aliases.sync(doc);
      touch(layer);
      return `cutout ${aliasOf(layer.id)} (${shape}) → ${box.x},${box.y} ${box.w}×${box.h} of ${region.w}×${region.h}@${region.x},${region.y}${noteStr(notes)}`;
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
        box,
      };
      // set text FIRST so a text-derived name can see it (placeholders/images carry no text)
      if (!placeholder && type !== 'image' && typeof l.text === 'string') layer.text = l.text.slice(0, 300);
      // human display name — the model's explicit name wins; else derive from text/role/type.
      // For a gray image placeholder, prefer a role label ("Product"/"Avatar"/…) computed from the
      // ORIGINAL image type; only unroled placeholders fall back to "Image placeholder".
      if (typeof l.name === 'string' && l.name.trim()) {
        layer.name = l.name.slice(0, 60);
      } else if (placeholder) {
        const imgName = deriveLayerName({ type: 'image', role: layer.role }, { placeholder: true });
        layer.name = imgName === 'Image placeholder' ? 'Image placeholder' : imgName;
      } else {
        layer.name = deriveLayerName(layer);
      }
      if (imageSrc) layer.src = imageSrc;
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
      // `look` and `draftText` are HARNESS-level ops: runDesignAgent's applyFn intercepts them
      // before this switch (they need the run's LLM/vision closures). A standalone applyOp caller
      // reaching here with one gets a precise error instead of a misleading "unknown op".
      if (op.op === 'look' || op.op === 'draftText') {
        throw new Error(`"${op.op}" is only available inside a design-agent run (it needs the run's vision/copywriter context) — not via applyOp directly`);
      }
      throw new Error(`unknown op "${op.op}" — expected one of: template, element, setParams, move, center, align, resize, setText, setStyle, draftText, look, order, duplicate, distribute, add, cutout, remove, group, ungroup, autolayout, done`);
  }
}

// ── layout diagnostics (v7): turn vague commands into concrete facts ──────────────────────────────
// "fix the spacing" / "fix the alignment" / "tighten it up" are under-specified. Rather than let a
// tiny model guess, we DETECT the concrete problems deterministically from the scene graph and put
// them in the observation as SPACING/ALIGN lines the model can act on directly. Only top-level
// non-base movable leaves+groups in the relevant region are considered; overlaps and uneven
// vertical rhythm are the two failure modes owners flag. Pure function; never throws.

/** Top-level, movable, on-canvas nodes (non-base, non-locked, has a box) — the layout blocks. */
function layoutBlocks(doc) {
  return (doc.layers || []).filter((n) => n && n.role !== 'base' && n.role !== 'background' && !n.locked && n.box && n.box.h > 0);
}

/**
 * Deterministic spacing/alignment findings for the CURRENT doc, optionally scoped to a set of node
 * ids (aliases or real ids resolved by the caller). Returns compact strings:
 *   "SPACING: L2 and L3 overlap by 24px"
 *   "SPACING: vertical gaps uneven (12/48/12px) — normalize to ~24px"
 *   "ALIGN: L2,L4 left edges differ (60 vs 92) — snap to a shared column"
 * ids: optional Set of REAL node ids to restrict the analysis to (from deriveFocusIds). null = all.
 */
export function layoutDiagnostics(doc, aliasOf = (id) => id, ids = null) {
  const out = [];
  try {
    let blocks = layoutBlocks(doc);
    if (ids && ids.size) blocks = blocks.filter((n) => ids.has(n.id));
    if (blocks.length < 2) return out;
    // sort into vertical reading order
    const col = blocks.slice().sort((a, b) => a.box.y - b.box.y);
    // 1) OVERLAPS (vertical) — adjacent blocks whose boxes intersect on the y-axis by >4px
    for (let i = 0; i < col.length - 1; i++) {
      const a = col[i];
      const b = col[i + 1];
      const overlap = (a.box.y + a.box.h) - b.box.y;
      // only flag when they also overlap horizontally (a true collision, not two side-by-side)
      const hOverlap = a.box.x < b.box.x + b.box.w && b.box.x < a.box.x + a.box.w;
      if (overlap > 4 && hOverlap) out.push(`SPACING: ${aliasOf(a.id)} and ${aliasOf(b.id)} overlap by ${Math.round(overlap)}px — separate them`);
    }
    // 2) UNEVEN VERTICAL RHYTHM — gaps between consecutive non-overlapping blocks vary a lot
    const gaps = [];
    for (let i = 0; i < col.length - 1; i++) {
      const g = col[i + 1].box.y - (col[i].box.y + col[i].box.h);
      if (g >= 0) gaps.push(Math.round(g));
    }
    if (gaps.length >= 2) {
      const min = Math.min(...gaps);
      const max = Math.max(...gaps);
      const avg = Math.round(gaps.reduce((s, g) => s + g, 0) / gaps.length);
      // "uneven" = spread is both large in absolute terms and relative to the average
      if (max - min > 16 && max - min > avg * 0.6) {
        out.push(`SPACING: vertical gaps uneven (${gaps.join('/')}px) — even them out to ~${avg}px with distribute or move`);
      }
    }
    // 3) MISALIGNED LEFT EDGES — text/blocks that are almost-but-not-quite on a shared column
    const xs = col.filter((n) => n.type !== 'group').map((n) => ({ id: n.id, x: Math.round(n.box.x) }));
    for (let i = 0; i < xs.length; i++) {
      for (let j = i + 1; j < xs.length; j++) {
        const d = Math.abs(xs[i].x - xs[j].x);
        if (d > 2 && d <= 24) { out.push(`ALIGN: ${aliasOf(xs[i].id)},${aliasOf(xs[j].id)} left edges differ (${xs[i].x} vs ${xs[j].x}) — snap to one column with align h:left`); }
      }
    }
  } catch { /* diagnostics must never break an observation */ }
  return out.slice(0, 6);
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
  focusRegion = null, focusIds = null, diagnostics = false,
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
    // vague-command diagnostics: concrete spacing/alignment problems the model can act on directly
    // (only injected when the caller asked for them — a "fix the spacing" style instruction).
    if (diagnostics) {
      const diag = layoutDiagnostics(doc, aliasOf, idSet);
      if (diag.length) lines.push(`LAYOUT ISSUES (fix these concretely):\n${diag.join('\n')}`);
    }
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
// PLATFORM STACKS — per-platform playbook lines with RESEARCH-VERIFIED tokens, so the agent
// "sees platform X → whips out stack X" instead of inventing colors. Injected into the prompt
// ONLY for the platform(s) the task/doc actually references (max 2) — the edit budget never pays
// for seven platforms it isn't touching.
const PLATFORM_STACKS = {
  'apple-notes': 'APPLE NOTES stack: {"op":"template","id":"apple-notes"} (or notes-checklist) · nav gold #E2AE0C · checklist done #FDB902 · ink #1C1C1E · muted #8A8A8E · bg #FFF · DARK: bg #000, card #1C1C1E, accent #FFD60A · SF font',
  'notes-checklist': 'APPLE NOTES CHECKLIST stack: {"op":"template","id":"notes-checklist"} · done badge #FDB902 + white ✓ · nav gold #E2AE0C · ink #1C1C1E · SF font',
  imessage: 'IMESSAGE stack: {"op":"template","id":"imessage"} · sent #0A84FF (white text) · received #E9E9EB (black text; DARK #262626) · tint #007AFF · timestamps #8E8E93 · bubble radius ≈18 · SF font · for GREEN/SMS use template "sms" (#34C759) — real SMS is never blue',
  sms: 'SMS stack: {"op":"template","id":"sms"} · GREEN sent #34C759 · "Text Message" composer · otherwise identical iOS chrome; never blue bubbles',
  'ig-dm': 'IG DM stack: {"op":"template","id":"ig-dm"} · card #0C1014 (never pure black) · received #262626 text #E9E9EE · sent gradient #A033FF→#0AA6FF · muted #A8A8A8',
  'ig-feed-post': 'IG FEED stack: {"op":"template","id":"ig-feed-post"} · ink #262626 · muted #737373 · hairline #DBDBDB · verified #0095F6 · DARK: bg #0C1014 text #F5F5F5 muted #A8A8A8',
  'story-native': 'IG STORY stack: {"op":"template","id":"story-native"} + ig-caption pill elements · white pill + #0A0A0A text (DARK: black pill + white text) · pill fs ≈4.6% of min(w,h)',
  'x-post-ad': 'X POST stack: {"op":"template","id":"x-post-ad"} · bg #000 · ink #E7E9EA · muted #71767B · verified #1D9BF0 · Chirp ≈ base grotesk (leave fontFamily unset)',
  'fb-post': 'FACEBOOK stack: {"op":"template","id":"fb-post"} · card #FFF · ink #050505 · secondary #65676B · blue #1877F2 · divider #CED0D4 · DARK: bg #18191A card #242526 text #E4E6EB · system font',
};

/** The stack lines relevant to THIS task: platform named in the instruction + platform(s) the doc
 *  is already built from (tpl provenance stamps). Max 2 lines to protect the edit budget. */
export function platformStackLines(instruction, doc) {
  const hits = new Set();
  const det = detectTemplate(String(instruction || ''));
  if (det && PLATFORM_STACKS[det]) hits.add(det);
  try {
    walkNodes(doc?.layers || [], (n) => { if (n.tpl && PLATFORM_STACKS[n.tpl]) hits.add(n.tpl); });
  } catch { /* best-effort */ }
  return [...hits].slice(0, 2).map((k) => PLATFORM_STACKS[k]);
}

export function buildSystemPrompt(instruction, { brief, referenceText, kit, memory, attachments, runMemory, brandSkill, copyLock, vague = false, lintBaseline = '', platformStack = [], vision = !!process.env.VISION_BASE_URL } = {}) {
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
  if (lintBaseline) ctx.push(String(lintBaseline).slice(0, 400)); // HARNESS-11: edit runs start with the known findings
  for (const line of platformStack || []) ctx.push(line); // native-platform playbook (only when relevant)
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

{"op":"cutout","box":{px},"region":{src 0..1},"shape"?} LAST RESORT: mask a fixed ref (face/logo); not text.

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
- CONTRAST PAIRS: on a node with BOTH color+background set (pill/badge/card, e.g. ig-caption),
  a one-property edit can go invisible (black text on a near-black pill). Adjust the PAIRED
  property too and say so in your plan; same check in reverse under colored text.
- DARK MODE = the platform's REAL dark theme (from element id/role), applied as a bg/text/accent SET,
  never a naive invert: ig-* bg #0C1014 text #F5F5F5 · Apple Notes bg #000 (card #1C1C1E) accent #FFD60A ·
  iMessage sent STAYS #0A84FF, received #262626 · X already #000. Others: near-black bg + light text.
- If fsΔ shows in observation, fix that layer's fontSize toward the TYPE SIZES above.${vague ? '\n- VAGUE ASK → obey each LAYOUT ISSUES line exactly (position ops only, off blocks only); none = clean.' : ''}
- VISUAL CONTEXT lines show what's under each layer (photo/solid) and warnings (wide-on-photo, tiny-type).
- NEVER place wide text (>70% canvas) directly on a photo — pill/scrim or narrow the box.
- ONE archetype per comp — never stack two archetypes or duplicate an element in the same spot
  (duplicates are auto-suppressed).${attRule}

EXAMPLE TURN (imitate the JSON SHAPE only — the color below is a random placeholder, NEVER copy it
literally; always derive real colors from the doc's own brand-kit/background/context):
State shows: [2] L2 headline text 80,120 700x120 "BIG SALE" {fs:84,w:800,#ffffff} · [4] L4 cta button 80,900 320x90
Task: "move the headline lower and make the CTA stand out"
Reply:
{"plan":"drop headline to the lower third, give the cta a brand pill","ops":[{"op":"move","id":"L2","x":80,"y":620},{"op":"setStyle","id":"L4","style":{"background":"#e8734a","color":"#ffffff"}}],"done":false}
Next turn, if state + lint look right: {"plan":"both edits landed clean","ops":[],"done":true}

${copyLock ? 'COPY LOCK: this comp keeps its reference copy VERBATIM — setText/draftText are disabled, fontFamily is LOCKED (the reference\'s typography IS part of the copy — adjust size/weight/color, never the face), and new elements/templates are off-limits unless the user asks; edit position, size, color and structure only.\n' : ''}HOUSE RULES (auto-enforced after every op — work WITH them, never fight them):
- x soft-snaps to a 12-column grid (±8px); y is never snapped.
- colors near a brand-kit color snap to the kit (kits with 2+ colors); radii quantize to the doc's radius set.
- text height auto-grows to fit content (autoH); opt out with {"op":"setStyle","style":{"autoH":false}}.
- element-built text is size-locked — change it via setParams, never setStyle.fontSize.
- non-element text below role minimums is floored; wide unstyled text on photos gets a pill.
- setStyle on a color/background that would leave text invisible against its own pill/card fill
  auto-flips the OTHER property to a contrasting value — you don't need to also do this yourself,
  but plan for it and mention the trade-off (e.g. "black text will need a light pill") up front.
Op feedback lines show what the rules changed, e.g. "(repaired: x 63→60 (grid), color #f2903f→#e8734a (kit))".
${ctx.length ? `\nCONTEXT:\n${ctx.join('\n')}\n` : ''}
TASK: ${instruction}

Reply with ONE JSON object per turn: {"plan":"…","ops":[…],"done":false}. Set "done":true when the task is complete and lint is clean (ops may be [] then). No prose, no code fences. Prefer few, decisive ops — autolayout + element beats many tiny setStyle calls.`;
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
  const question = /\?\s*$/.test(t);
  if (question && !EDIT_INTENT_RE.test(t)) return true;
  return false;
}

// ── INTENT GATE (v7): classify chat vs edit vs copy at the START of a run ──────────────────────────
// Michael: saying "Yo" still locks the canvas and runs edit ops. The intent gate classifies the
// user's message FIRST so a greeting/thanks/meta-question stays conversational (kind:'chat',
// locked:false, ZERO ops) while a real change (kind:'edit') or a "copy this reference" ask
// (kind:'copy') proceeds into the op loop. Cheap heuristic first; an AMBIGUOUS short message gets
// one quick ornith intent check. The contract the frontend gates the canvas lock on:
//   kind:'chat' → locked:false (no lock, no ops)   ·   kind:'edit'|'copy' → locked:true (op loop)
export const RUN_KINDS = ['chat', 'edit', 'copy'];

// A real imperative EDIT verb or a concrete design noun — the signal that a message is an actual
// change to the comp, not small talk. Shared by isChitChat and classifyIntent.
const EDIT_INTENT_RE = /\b(add|move|resize|change|make|set|remove|delete|swap|replace|generate|create|align|center|centre|rewrite|fix|tighten|tidy|clean|cleanup|space|spacing|gap|nudge|shift|rotate|flip|crop|recolou?r|bigger|smaller|larger|wider|taller|bolder|shrink|enlarge|colou?r|template|caption|headline|subhead|cta|button|bubble|text|copy|layout|design|font|image|photo|logo|pill|badge|price|offer|margin|padding|balance|contrast|hierarchy)\b/;

// "copy this reference / make it look like / match this" — a distinct intent that rebuilds the
// comp FROM a reference. Recognized so the frontend can label the run and (with a reference
// attached) route to the copy pipeline. Purely lexical; the actual copy path also needs a
// reference image (opts.reference) to fire.
const COPY_INTENT_RE = /\b(copy|clone|recreate|replicate|reproduce|mimic|match)\b.*\b(this|that|the|reference|ref|image|design|ad|it|layout)\b|\b(make|do) (it|this) (look )?like\b|\blike (this|that|the) (reference|ref|image|design|ad)\b/;

/**
 * Cheap deterministic intent heuristic. Returns 'chat' | 'edit' | 'copy' | null (null = ambiguous,
 * caller may escalate to a quick ornith check). Pure function of the message text + whether a
 * reference image is attached to the run.
 */
export function heuristicIntent(instruction, { hasReference = false } = {}) {
  const t = String(instruction || '').trim().toLowerCase();
  if (!t) return 'chat';
  // an explicit copy ask (only meaningful when a reference is actually attached)
  if (hasReference && COPY_INTENT_RE.test(t)) return 'copy';
  // clear chit-chat / meta → chat
  if (isChitChat(t)) return 'chat';
  // clear edit signal → edit
  if (EDIT_INTENT_RE.test(t)) return 'edit';
  // short and no edit signal and not obviously chat → ambiguous (let ornith decide). Longer
  // messages without any edit verb are unusual; treat as edit (the model can no-op) rather than
  // burning a classify call — the risk we guard against is the SHORT greeting, not a paragraph.
  if (t.length <= 24) return null;
  return 'edit';
}

/**
 * Classify a run's intent as 'chat' | 'edit' | 'copy'. Heuristic first (free, deterministic);
 * only an AMBIGUOUS short message triggers one cheap ornith intent check. The ornith check is
 * strictly conservative — anything that isn't a confident CHAT falls back to EDIT so no real
 * instruction is ever swallowed. Never throws; a failed/absent model degrades to 'edit'.
 *
 * opts: { hasReference?, llmCall?, signal? }
 * Returns { kind, via:'heuristic'|'model'|'fallback', reply? } — `reply` is only set when the
 * model was asked and volunteered a short conversational line for a chat classification.
 */
export async function classifyIntent(instruction, { hasReference = false, llmCall = null, signal = null } = {}) {
  const h = heuristicIntent(instruction, { hasReference });
  if (h) return { kind: h, via: 'heuristic' };
  // ambiguous: a quick ornith intent check. Conservative — only a confident "chat" wins.
  const call = llmCall || llmText;
  try {
    if (signal?.aborted) return { kind: 'edit', via: 'fallback' };
    const r = await call(
      `A user is talking to an ad-design assistant that edits a design canvas. Classify their message as exactly one word:\n- "chat" if it is a greeting, thanks, small talk, or a question ABOUT the assistant (not a change to the design)\n- "edit" if it asks to change/create/fix anything in the design\nMessage: "${String(instruction).slice(0, 200)}"\nReply with ONLY the single word chat or edit.`,
      { system: 'You are an intent classifier. Reply with exactly one word: chat or edit.', maxTokens: 400, purpose: 'design-intent', signal, temperature: 0 },
    );
    if (r && r.ok && typeof r.text === 'string') {
      const word = r.text.toLowerCase();
      if (/\bchat\b/.test(word) && !/\bedit\b/.test(word)) return { kind: 'chat', via: 'model' };
    }
  } catch { /* classify is best-effort — never blocks a run */ }
  return { kind: 'edit', via: 'fallback' };
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

// A vague LAYOUT command ("fix the spacing", "tighten it up", "fix the alignment", "make it
// cleaner", "even it out") — under-specified asks that must map to CONCRETE spacing/alignment ops.
// When matched, the observation ships the deterministic LAYOUT ISSUES block so the model acts on
// facts, not guesses. Kept separate from FAST_* so a vague ask can still use the fast path but
// with diagnostics turned on.
const VAGUE_LAYOUT_RE = /\b(spacing|spaced?|space it|alignment|aligned?|align it|line ?it ?up|tighten|tidy|clean\s*(it|this|up)?|cleaner|neaten|even(?:\s*(it|them))?\s*out|balance|breathing room|too (?:cramped|tight|crowded|close|much space)|overlap|overlapping|not aligned|off\s*center|uneven|messy|declutter|fix the (?:layout|gaps?))\b/i;

/** True when the instruction is a vague layout/spacing/alignment ask that benefits from the
 *  deterministic LAYOUT ISSUES diagnostics block in the observation. */
export function isVagueLayoutCommand(instruction) {
  const t = String(instruction || '').trim().toLowerCase();
  if (!t) return false;
  return VAGUE_LAYOUT_RE.test(t);
}

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

// ── ORCHESTRATOR: decompose an edit into ≤3 independent region subtasks ────────────────────────────
// A task decomposes when the user's instruction touches SEVERAL distinct regions of the comp that
// can be worked independently (e.g. "restyle the header AND fix the CTA AND tidy the footer"). We
// map the instruction onto the comp's region bands (header/body/product/cta), keep only the regions
// the instruction actually names, and emit one subtask per region (each with the region's node ids
// as its focus). Returns [] when the task does NOT decompose (≤1 region named, or too few nodes) so
// the caller falls back to the normal single loop — we NEVER fan out a task that doesn't split.
const REGION_KEYWORDS = {
  header: ['header', 'headline', 'title', 'nav', 'logo', 'top', 'badge'],
  body: ['body', 'caption', 'subhead', 'text', 'paragraph', 'middle', 'copy'],
  product: ['product', 'image', 'photo', 'avatar', 'picture', 'shot'],
  cta: ['cta', 'button', 'footer', 'bottom', 'call to action', 'buy', 'shop'],
};
/**
 * Split an edit instruction into independent region subtasks. Returns
 * [{ region, ids:[nodeId…], hint }] for the regions the instruction names (max 3), or [] when the
 * task doesn't cleanly decompose. Deterministic — pure function of (doc, instruction).
 */
export function decomposeEditIntoRegions(doc, instruction) {
  const t = String(instruction || '').toLowerCase();
  const ch = (doc.canvas && doc.canvas.h) || 1;
  // multi-part intent signal: the instruction must actually describe several things
  const conjunctions = (t.match(/\band\b|;|,|\bthen\b|\balso\b/g) || []).length;
  if (conjunctions < 1) return [];
  // bucket the comp's real leaves into region bands
  const buckets = { header: [], body: [], product: [], cta: [] };
  walkNodes(doc.layers || [], (n) => {
    if (!n || n.type === 'group' || n.role === 'base' || n.role === 'background' || !n.box) return;
    try { buckets[leafRegion(n, ch)].push(n.id); } catch { /* skip */ }
  });
  const named = [];
  for (const region of REGION_SEQ) {
    if (!buckets[region] || !buckets[region].length) continue;
    const kws = REGION_KEYWORDS[region] || [region];
    if (kws.some((k) => t.includes(k))) named.push({ region, ids: buckets[region], hint: REGION_LABEL[region] });
  }
  // decomposes only when the instruction independently names 2+ populated regions
  return named.length >= 2 ? named.slice(0, 3) : [];
}

/** Minimal fast-path system prompt (~15% of the full one): the trivial-op subset, placement
 *  rules, done-in-same-reply. No template/element catalogs, no design-principles essay. */
export function buildFastPrompt(instruction, { copyLock = false, vague = false } = {}) {
  return `You edit an ad comp's scene graph. This is a SMALL edit — finish it in ONE reply.
Reply with ONE JSON object: {"plan":"<one short sentence>","ops":[…1-3 ops…],"done":true}. No prose, no code fences.
Address nodes by short id (L1, g2) or role. Coordinates are absolute px. Never touch role "base" or locked nodes.

OPS (exact shapes):
{"op":"move","id":"L3","x":60,"y":120}
{"op":"center","id":"L3","axis":"x"}   (axis: x|y|both — exact canvas centering, never compute it yourself)
{"op":"align","ids":["L2","L3"],"h":"left"}   (snap edges to ONE column · h: left|center|right · v: top|middle|bottom)
{"op":"distribute","ids":["L2","L3","L4"],"axis":"y"}   (3+ stacked blocks → equal gaps)
{"op":"resize","id":"L3","w":400,"h":120}
{"op":"setText","id":"L3","text":"…"}
{"op":"setStyle","id":"L3","style":{"fontSize":84,"fontWeight":800,"color":"#111111"}}   (plain text layers — the DEFAULT choice)
{"op":"setParams","id":"g2","params":{"text":"…"}}   (ONLY for element instances — their state line shows "el:…"; everything else uses setStyle/setText)
{"op":"remove","id":"L3"}

RULES:
- "bigger"/"smaller" on text ≈ ±25% fontSize via setStyle (setParams only when the line shows el:…).
- Centered/moved text: use "center"/"align", and keep style.align consistent with the box.
- Do exactly what was asked — nothing extra.${copyLock ? '\n- COPY LOCK: text is verbatim-locked — setText is disabled; edit position/size/color only.' : ''}${vague ? `
- VAGUE ASK: the observation has a LAYOUT ISSUES block naming the EXACT problems — act on those ids.
  · spacing → separate overlaps with "move"; even vertical gaps with "distribute" (3+) or "move".
    Spacing is POSITION only — do NOT resize or restyle.
  · alignment → snap the named blocks' left edges to one column with {"op":"align","ids":[…],"h":"left"}.
  · If LAYOUT ISSUES is empty, the layout is already clean — reply {"plan":"already clean","ops":[],"done":true}.` : ''}

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
  // ABORT (v7): the stop button must halt a run PROMPTLY. runBatchAgent already checks opts.signal
  // between turns AND between ops (and passes it to every llmCall so the in-flight request aborts);
  // this helper lets the MULTI-PHASE orchestration in runDesignAgent (generate best-of, fan-out
  // gather, vision-refine, self-check, final passes) bail out between phases too, so no phase runs
  // after the user hit stop. Applied ops are preserved on `work` — a clean partial, never corrupt.
  const aborted = () => !!(opts.signal && opts.signal.aborted);

  try {
    // ── INTENT GATE (v7) ─────────────────────────────────────────────────────────────────────────
    // Classify the message FIRST so a greeting/thanks/meta-question ("yo", "nice", "what can you
    // do?") stays conversational — NO canvas lock, NO scene read, ZERO ops — while a real change
    // runs the op loop. improve/generate modes are always edits; a run with a reference image is a
    // copy. The `kind` (chat|edit|copy) drives the frontend lock contract: locked ⇔ kind≠'chat'.
    // Emitted on the run-START event so the other agent can gate the canvas lock before the first op.
    const hasReference = !!(opts.reference && opts.reference.path);
    let kind;
    if (opts.mode === 'improve' || opts.mode === 'generate') kind = 'edit';
    else if (hasReference) kind = 'copy';
    else {
      const cls = await classifyIntent(instruction, { hasReference, llmCall: opts.llmCall || null, signal: opts.signal || null });
      kind = cls.kind;
    }
    const locked = kind !== 'chat';
    // Run-start contract for the frontend: kind + locked land on the FIRST event of the run so the
    // canvas lock is gated before any op (locked ONLY when kind==='edit'|'copy').
    onStep({ runId, start: true, kind, locked });

    // Conversational gate: chit-chat gets a chat reply, ZERO doc reads, zero ops — "yo" must
    // never re-layout an ad. locked:false so the client never locks the canvas.
    if (kind === 'chat') {
      const call = opts.llmCall || llmText;
      let reply = 'Ready when you are — tell me what to change.';
      if (!(opts.signal && opts.signal.aborted)) {
        const r = await call(`You are the design agent inside an ad editor. The user said: "${String(instruction).slice(0, 200)}". Reply in ONE friendly sentence (you may reference that you edit designs when asked). Plain text.`, {
          system: 'Reply with one short sentence, no JSON.', maxTokens: 800, purpose: 'design-chat', signal: opts.signal || null,
        });
        if (r.usage) { usage.inTok += r.usage.inTok || 0; usage.outTok += r.usage.outTok || 0; }
        reply = (r.ok && r.text ? r.text : reply).trim().slice(0, 200);
      }
      emit('op', reply, { chat: true });
      onStep({ runId, done: true, kind, locked: false });
      const lint = lintDesign(JSON.parse(JSON.stringify(doc)), opts.kit || null);
      return {
        doc, steps, source: 'chat', kind: 'chat', locked: false, runId, applied: 0, usage, lint,
        totals: { turns: 1, parts: 1, inTok: usage.inTok, outTok: usage.outTok },
        layoutScore: layoutScore(doc, opts.kit || null),
        verify: verifyDesign(doc, { kit: opts.kit || null, skeletonId: doc.skeletonId }),
      };
    }

    // ── COPY-REFERENCE as an in-editor agent RUN ────────────────────────────────────────────────
    // "copy this reference" is an AGENT ACTION, not a separate pipeline: when the caller hands the
    // run a reference image (opts.reference.path), the design agent extracts its layout and builds
    // it INTO the current doc, streaming the SAME unified vocabulary (thinking / subagent / op /
    // verify) as a normal edit — so the editor's activity panel renders it identically. The
    // standalone extractLayout endpoint still works; this just lets the loop invoke the same core.
    if (opts.reference && opts.reference.path) {
      const out = await runCopyReference(doc, opts.reference, emit, { ...opts, runId });
      // COPY SELF-CHECK (multi-pass, checks its own work — copy-from-reference is THE product's
      // most important flow): render the ASSEMBLED copy, compare it against the original
      // reference with vision, and run ONE constrained corrective round on the visible
      // differences. Text and fonts stay locked (keepCopy); positions/sizes/colors only.
      if (out && out.doc && out.applied > 0 && !opts.signal?.aborted && !opts.llmCall && process.env.VISION_BASE_URL) {
        try {
          emit('thinking', 'self-check: rendering the copy and comparing it to the reference…');
          // checkText:true — the copy-reference self-check must diff TEXT CONTENT against the
          // reference (missing/hallucinated headlines, eyebrows, "vs" chips, CTA labels), not
          // just visual geometry — the generic compare prompt explicitly ignores text.
          const cmp = await compareToReference(out.doc, opts.reference.path, { checkText: true });
          const corrections = (cmp && Array.isArray(cmp.corrections)) ? cmp.corrections.slice(0, 6) : [];
          const textFixes = corrections.filter((c) => c.textFix === true);
          const visualFixes = corrections.filter((c) => c.textFix !== true);
          const nestedStep = (ev) => { if (ev && ev.step) onStep({ ...ev, runId }); };
          // TEXT-FIX ROUND FIRST: bypasses keepCopy's setText lock ONLY here — corrections toward
          // the reference's real copy are the point, not a copy-lock violation.
          if (textFixes.length) {
            emit('thinking', `self-check found ${textFixes.length} text mismatch${textFixes.length === 1 ? '' : 'es'} vs the reference — fixing`);
            const fixes = textFixes.map((c, i) => `${i + 1}. ${c.layer ? `${c.layer}: ` : ''}${c.problem}${c.fix ? ` → ${c.fix}` : ''}`).join('\n');
            const textFixRun = await runDesignAgent(
              out.doc,
              `The rendered TEXT differs from the reference's real copy — fix ONLY these text mismatches by setting the text to match the reference exactly:\n${fixes}`,
              nestedStep,
              { ...opts, reference: undefined, keepCopy: true, allowReferenceTextFix: true, mainTurnVision: false },
            );
            if (textFixRun && textFixRun.doc && textFixRun.applied > 0) {
              out.doc = textFixRun.doc;
              out.applied += textFixRun.applied;
              emit('op', `self-check text corrections applied (${textFixRun.applied} op${textFixRun.applied === 1 ? '' : 's'})`, { deterministic: true });
            }
          }
          if (visualFixes.length) {
            emit('thinking', `self-check found ${visualFixes.length} visible difference${visualFixes.length === 1 ? '' : 's'} vs the reference — fixing`);
            const fixes = visualFixes.map((c, i) => `${i + 1}. ${c.layer ? `${c.layer}: ` : ''}${c.problem}${c.fix ? ` → ${c.fix}` : ''}`).join('\n');
            // nested constrained edit run; its step frames stream into THIS run's feed (re-stamped
            // with the outer runId; nested start/done frames are dropped so the panel state holds).
            const fixRun = await runDesignAgent(
              out.doc,
              `The copy differs from the reference — fix ONLY these visible differences (positions, sizes, colors; text and fonts are LOCKED):\n${fixes}`,
              nestedStep,
              { ...opts, reference: undefined, keepCopy: true, mainTurnVision: false },
            );
            if (fixRun && fixRun.doc && fixRun.applied > 0) {
              out.doc = fixRun.doc;
              out.applied += fixRun.applied;
              emit('op', `self-check corrections applied (${fixRun.applied} op${fixRun.applied === 1 ? '' : 's'})`, { deterministic: true });
            }
          }
          if (!corrections.length && cmp && cmp.match !== false) {
            emit('thinking', 'self-check: the copy matches the reference render');
          }
        } catch { /* self-check is best-effort — never fails the copy */ }
      }
      onStep({ runId, done: true, kind: 'copy', locked: true });
      return { ...out, runId, steps, kind: 'copy', locked: true };
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
    // Per-runBatch gates (set fresh in runBatch below) against the "takes elements / applies
    // presets when it shouldn't" failure mode: the model reaching for a whole-ad template on a
    // populated comp, or decorating a reference copy with elements nobody asked for.
    let allowArchetypeOps = true; // template op allowed (generate mode, or the task names an archetype)
    let allowElementOps = true;   // element op allowed (always outside copy; inside copy only when asked)

    const applyFn = async (op) => {
      if (op && op.op === 'autolayout' && templateSeeded) {
        throw new Error('this comp is a finished archetype template — autolayout would wreck it; edit copy with setText/draftText instead');
      }
      if (op && op.op === 'template') {
        if (!allowArchetypeOps) {
          let leaves = 0;
          walkNodes(work.layers || [], (n) => { if (n.type !== 'group' && n.role !== 'base') leaves++; });
          if (leaves > 4) {
            throw new Error('this comp already has real content and the task did not ask for an archetype — a template would REPLACE the existing layout; edit the existing layers (move/resize/setStyle) instead');
          }
        }
        templateSeeded = true;
      }
      if (op && op.op === 'element' && keepCopy && !allowElementOps) {
        throw new Error('this comp is a reference COPY — reproduce what the reference shows by editing existing layers; inserting new design elements is locked unless the user asks for one');
      }
      // FONT LOCK under copy: the reference’s typography is part of the copy. The model kept
      // "fixing" fonts to something completely different — strip fontFamily from setStyle on copy
      // docs (the rest of the style edit still applies) so extracted serif/platform stacks survive.
      let fontStripped = false;
      if (keepCopy && op && op.op === 'setStyle' && op.style && typeof op.style === 'object' && 'fontFamily' in op.style) {
        delete op.style.fontFamily;
        fontStripped = true;
        if (!Object.keys(op.style).length) {
          throw new Error('fontFamily is locked on a reference copy — the reference’s typography is part of the copy; adjust size/weight/color instead');
        }
      }
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
      // TEXT-FIX BYPASS (Fable's 026-escalation fix #3): the copy self-check's corrective round
      // may need to fix TEXT TOWARD THE REFERENCE (e.g. hallucinated "OURS/THEIRS" headers
      // replacing the real "Premium Silk/Satin") — that is not a user-copy-lock violation, it's
      // the entire point of a copy. opts.allowReferenceTextFix is set ONLY on that nested run.
      if (keepCopy && !opts.allowReferenceTextFix && (op.op === 'setText' || op.op === 'draftText')) {
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
      if (r && typeof r === 'string') {
        const fontNote = fontStripped ? ' · (fontFamily kept — the reference\'s typography is part of the copy)' : '';
        if (!generateMode) {
          const fix = postApplyRepair();
          if (fix) return `${r} · ${fix}${fontNote}`;
        }
        if (fontNote) return `${r}${fontNote}`;
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
      // vague layout ask ("fix the spacing") → ship the deterministic LAYOUT ISSUES diagnostics
      // (overlaps / uneven rhythm / misaligned edges) so the model maps it to concrete ops. Off in
      // generate mode (the whole comp is being built, not tidied).
      // Diagnostics run on EVERY non-generate edit against a multi-node doc, not only on exact
      // vague-keyword matches ("fix the spacing") — "the layout is broken" used to get NOTHING and
      // the model had to invent corrections instead of acting on measured facts (HARNESS-8). The
      // scan is deterministic and cheap; `vague` still tightens the prompt rules for vague asks.
      const vagueAsk = !generate && isVagueLayoutCommand(goal);
      const multiNode = (() => { try { let n = 0; walkNodes(work.layers, () => { n++; }); return n >= 3; } catch { return false; } })();
      const wantDiagnostics = !generate && (vagueAsk || multiNode);
      // LINT BASELINE (HARNESS-11): edit runs used to start blind — the lint gate only fired AFTER
      // turn 1, so on an already-broken doc the model wasted a turn discovering problems instead
      // of fixing them. Compute the findings up-front and hand them to the model as context
      // (improve mode already did this; scoped edits now get the same head start).
      let lintBaseline = '';
      if (!generate && !fast) {
        try {
          const base = lintDesign(work, kit).slice(0, 4);
          if (base.length) lintBaseline = `LINT baseline (already wrong before your edit — fix any that overlap your task): ${base.join(' · ')}`;
        } catch { /* baseline is best-effort */ }
      }
      // Archetype/element gates for THIS batch (see applyFn): a template op is only allowed when
      // generating, or when the task actually names an archetype; on a reference COPY, inserting
      // new elements needs the user to have asked for one ("add a badge/rating/…").
      allowArchetypeOps = generate || !!detectTemplate(goal) || /\b(template|preset|archetype|rebuild|start over|from scratch)\b/i.test(String(goal || ''));
      allowElementOps = !keepCopy || /\b(add|insert|element|badge|button|pill|sticker|arrow|caption|rating|stars?|scrim|logo)\b/i.test(String(goal || ''));
      const run = await runBatchAgent({
        system: generate ? buildGeneratePrompt(goal, promptCtx)
          : fast ? buildFastPrompt(goal, { copyLock: keepCopy, vague: vagueAsk })
            : buildSystemPrompt(goal, { ...promptCtx, vague: vagueAsk, lintBaseline, platformStack: platformStackLines(goal, work) }),
        buildObservation: () => observe(work, {
          aliases,
          lastTarget: opCtx.lastTarget,
          focusIds: fast ? (fastFocus && fastFocus.length ? fastFocus : null) : (opts.focusIds || null),
          diagnostics: wantDiagnostics,
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
        // Reasoning headroom (see agent-harness). Ornith is a REASONING model — it burns its whole
        // budget in reasoning_content BEFORE emitting JSON, so a 3000 cap truncates it mid-think and
        // it silently no-ops (benchmark CREATIVE 1/5, every call outTok:3000/validJson:false).
        // Generate calls emit the most JSON, so give them the most room; edits still fine at 3000.
        maxTokensPerTurn: opts.maxTokensPerTurn || (generate ? 8000 : 3000),
        // CONTEXT BUDGET (v8): a hard per-turn prompt ceiling well under ornith's ~60k window.
        // Edit budget is 4200 (was 3000): the edit SYSTEM prompt alone has grown to ~2950 est
        // tokens, so 3000 left ~zero headroom — the guard crushed per-op feedback and the LAYOUT
        // ISSUES diagnostics into slivers (observed live: the FAILED-op feedback line pruned,
        // diagnostics truncated mid-word). 4200 keeps turns snappy locally while giving
        // observation + feedback + lint real room; generate turns carry the element/template
        // catalogs, so they get more. Guarantees a 100+-layer comp can't blow the window.
        contextBudgetTokens: opts.contextBudgetTokens || (generate ? 14_000 : 4200),
        maxApplied: opts.maxApplied || null,
        // main-turn vision: render once (turn 0) per batch and SHOW it to the worker — later turns
        // already carry op feedback. Fires for BOTH generate AND non-trivial edit batches (the
        // `runBatch` closure is shared), so an edit like "center the headline" is judged from the
        // actual render, not just coordinates. Off for the fast path and text-only workers.
        ...(mainTurnVision && !fast ? {
          visionCall: (p, img, o) => llmVision(p, img, o),
          imageForTurn: (turn) => (turn === 0 ? renderCompPng(work) : null),
        } : {}),
        // targetId + targetBox: the REAL node the op touched (aliases like L2 are per-run) and its
        // CURRENT canvas box + canvas dims — the UI flashes the edited element AND steers the
        // agent-cursor overlay to hover exactly over what is being edited (owner ask: "the agent
        // mouse movements are only going over that element").
        onStep: (s) => {
          let target = null;
          if (s.kind === 'op' && opCtx.lastTarget) {
            target = { targetId: opCtx.lastTarget };
            try {
              const n = findNode(work, opCtx.lastTarget);
              if (n && n.box) target.targetBox = { x: n.box.x, y: n.box.y, w: n.box.w, h: n.box.h, cw: work.canvas.w, ch: work.canvas.h };
            } catch { /* box is best-effort enrichment */ }
          }
          emit(s.kind, s.summary, { ...(s.data || {}), model: model.model, ...(target || {}) });
        },
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
        const r = await call(prompt, { system, json: true, maxTokens: 8000, timeoutMs: 60_000, purpose: 'design-generate-bestof', signal: opts.signal, temperature: i === 0 ? 0 : 0.9 });
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
        if (aborted()) break;
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
      if (useHarness && !aborted()) {
        const n = Number.isFinite(opts.bestOf) ? opts.bestOf : 3;
        const seeded = n > 1 ? await bestOfSeed(n) : false;
        // short batch pass to react to lint / finish the polish
        if (!aborted()) await runBatch(instruction, { maxTurns: seeded ? 2 : 3, generate: true });

        // CONVERGENCE GUARD (raise the self-review bar — "don't stop half-built"): if there's no
        // vision endpoint to critique with AND the comp still lints dirty / scores below GOOD, run
        // ONE more corrective batch aimed squarely at the remaining findings. Token-disciplined:
        // fires at most once, and only when the polish left real problems.
        if (!aborted() && !process.env.VISION_BASE_URL) {
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

      // ── ORCHESTRATOR-WORKER FAN-OUT (opt-in / auto) ─────────────────────────────────────────────
      // When the edit decomposes into 2-3 INDEPENDENT regions, spawn one concurrent sub-agent per
      // region (each its own model call proposing ops scoped to that region), then GATHER and apply
      // the non-conflicting ops. Regions are disjoint node sets, so applying serially after the
      // concurrent proposals never conflicts. Streams a `subagent` frame per worker. Falls back to
      // the single loop below when the task doesn't decompose. Off for generate/improve/fast and for
      // the trivial-edit case; disable entirely with opts.fanOut === false.
      // AUTO-fan-out fires only at real runtime (a live endpoint, not an injected test llmCall), so
      // the single-agent path stays the deterministic default under test and existing edits never
      // regress; opts.fanOut === true forces it on (used by the fan-out-specific test).
      const fanOutAllowed = opts.fanOut === true || (opts.fanOut !== false && !opts.llmCall);
      const regions = (!fanOutAllowed || generateMode || opts.mode === 'improve' || aborted())
        ? []
        : decomposeEditIntoRegions(work, instruction);
      if (regions.length >= 2) {
        emit('thinking', `this edit spans ${regions.length} independent regions — fanning out ${regions.length} sub-agents (${regions.map((r) => r.hint).join(', ')})`);
        const promptCtx = { ...opts, kit, runMemory, brandSkill, exemplars, copyLock: keepCopy };
        const fan = await runFanOut({
          model: model.model || 'ornith', parentRunId: runId, concurrency: 3, signal: opts.signal,
          onStep: (step) => emit('subagent', step.summary, step.data),
          subtasks: regions.map((rg) => ({
            id: nextSubAgentId(), title: `${rg.hint} region`,
            run: async ({ update }) => {
              update(`proposing edits for ${rg.hint}`);
              const obs = observe(work, { aliases, focusIds: rg.ids });
              const sys = buildSystemPrompt(instruction, promptCtx);
              const prompt = `CURRENT STATE (focus: ${rg.hint} region):\n${obs}\n\nOnly edit the ${rg.hint} region for this instruction: "${instruction}". Reply with ONE JSON object {"plan":"…","ops":[…≤4 ops…],"done":true}. No prose.`;
              const r = await call(prompt, { system: sys, json: true, maxTokens: 3000, timeoutMs: 60_000, purpose: 'design-fanout-worker', signal: opts.signal, temperature: 0 });
              if (r.usage) { usage.inTok += r.usage.inTok || 0; usage.outTok += r.usage.outTok || 0; }
              totals.turns += 1;
              if (!r.ok) { update('model call failed'); return { ok: false, error: r.error, ops: [] }; }
              const batch = parseBatch(r.text);
              if (batch.error) { update(`unparsable (${batch.error})`); return { ok: false, error: batch.error, ops: [] }; }
              update(`${batch.ops.length} op${batch.ops.length === 1 ? '' : 's'} proposed`);
              return { ok: true, ops: batch.ops.slice(0, 4), region: rg.hint };
            },
          })),
        });
        // GATHER: apply each worker's proposed ops to the shared doc (regions are disjoint).
        for (const res of fan.results) {
          if (aborted()) break;
          if (!res || !Array.isArray(res.ops)) continue;
          for (const op of res.ops) {
            if (aborted()) break;
            try {
              const s = await applyFn(op);
              if (typeof s === 'string') { applied++; opsTotal++; emit('op', s, { op, fanOut: true, region: res.region }); }
            } catch (e) { emit('op', `skipped ${op && op.op}: ${String(e?.message || e)}`, { op, failed: true }); }
          }
        }
        if (applied > 0) source = `${source}·fanout`;
      }

      // FAST PATH routing: short single-target trivial edits run ONE focused turn (cap 2) with
      // the minimal prompt and a scoped observation — no lint gate, no vision, no best-of.
      // Zero applied ops escalates to the untouched full loop, so nothing is ever lost.
      // (Skipped when the fan-out already applied edits.)
      const fannedOut = applied > 0 && /·fanout$/.test(source);
      const fast = !fannedOut && opts.fast !== false && isTrivialEdit(instruction, opts);
      let ranFast = false;
      let run = null;
      if (fast) {
        emit('thinking', 'fast path: trivial edit — one focused turn, minimal context');
        run = await runBatch(instruction, { maxTurns: 2, fast: true });
        ranFast = run.applied > 0; // only "stayed fast" if the trivial turn actually landed ops
        // ZERO applied ops = the fast turn changed nothing (even if the model said done) —
        // escalate to the untouched full loop so the user's ask is never silently dropped.
        if (run.applied === 0) {
          emit('thinking', 'fast path produced no applied ops — escalating to the full loop');
          run = null;
        }
      }
      // The fan-out IS the run when it landed edits — don't re-run the single loop over the same
      // instruction (it would just re-litigate the disjoint regions the workers already handled).
      if (!run && !fannedOut) run = await runBatch(instruction, { maxTurns: MAX_TURNS });
      // ABORT (v7): an aborted run that applied nothing must stay a clean no-op — do NOT fall
      // through to the deterministic autolayout, which would re-layout the whole comp AFTER the
      // user pressed stop (orphaned work). The autolayout fallback only exists to salvage a run
      // the model failed to resolve, never one the user deliberately cancelled.
      if (run && !run.ok && run.applied === 0 && run.stoppedBy !== 'aborted' && !aborted()) {
        // No codex fallback anymore (Ornith-only): a no-op local run degrades to the zero-token
        // deterministic autolayout, never to another model.
        emit('thinking', `${source} produced no applied ops (${run.stoppedBy}) — deterministic autolayout`);
        const pre = autoLayoutDoc(work, { kit });
        emit('op', pre.summary, { deterministic: true });
        source = 'autolayout';
      }

      // VISUAL SELF-CHECK on non-trivial edits (mirrors generate mode's self-critique loop):
      // the model just edited from the text scene-graph + turn-0 render — now LOOK at the result
      // and, if a real VISIBLE problem is left ("headline overlaps the product", "off-canvas"),
      // run ONE corrective turn scoped to what it can SEE. Capped at 1 round — edits are targeted,
      // so we do NOT want the open-ended 2-round redesign iteration generate mode uses.
      // Gated hard: only when a vision endpoint is up (mainTurnVision ⇒ not a test, not text-only),
      // the edit was NON-trivial (never the fast path — a render costs more than the whole trivial
      // edit), and the batch actually changed something on a real LLM source (not a codex fallthrough).
      if (mainTurnVision && !ranFast && source && applied > 0 && !(opts.signal && opts.signal.aborted)) {
        emit('thinking', 'looking at the edited render (self-check)…');
        let crit;
        try { crit = await lookAtComp(work, { goal: instruction }); } catch { crit = { ok: false }; }
        if (crit.ok && crit.critique && !/^\s*ready\b/i.test(crit.critique)) {
          emit('op', `self-check → ${crit.critique.slice(0, 140)}`, { deterministic: true });
          await runBatch(
            `You just made this edit: "${String(instruction).slice(0, 160)}". Looking at the current render, fix ONLY these visible problems, then done: ${crit.critique}`,
            { maxTurns: 2 },
          );
        } else if (crit.ok) {
          emit('op', 'self-check: edit looks right', { deterministic: true });
        }
      }
    }

    if ((source == null || !useHarness) && !generateMode) {
      // ── fallback: DETERMINISTIC auto-layout only ──────────────────────────────────────────────
      // The codex single-shot editing fallback has been REMOVED (Michael: Ornith for everything,
      // never pull in other models). When the local/ornith harness path doesn't resolve, we do NOT
      // shell out to codex — that surfaced model:'codex' in the agent UI and read as "looping in
      // other models". Instead we apply the zero-token deterministic auto-layout and report the
      // honest 'fallback' source. No agent op ever reports model:'codex'.
      source = 'fallback';
      emit('thinking', 'local agent did not resolve an edit — using zero-token auto-layout fallback');
      const ops = fallbackOps(work);
      applied = 0;
      opsTotal = ops.length;
      for (const op of ops) {
        let summary = null;
        try { summary = applyOp(work, op, opCtx); } catch { summary = null; }
        if (summary && typeof summary === 'string') { applied++; emit('op', summary, { op }); }
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

    // Abort surfaces as a clean PARTIAL result: applied ops are preserved on `work`, the run just
    // stopped early. Report it honestly in the verify line and on the result so the caller/UI knows.
    const wasAborted = aborted();
    emit('verify',
      `${wasAborted ? 'stopped (partial) · ' : ''}${verifySummary(verify)} · ${totals.parts} part${totals.parts === 1 ? '' : 's'} · ${applied}/${opsTotal} ops · layout ${beforeScore}→${afterScore} · ${((usage.inTok + usage.outTok) / 1000).toFixed(1)}k tok · ${source}`,
      { model: source === 'deepseek' ? model.model : source, totals, layoutScore: afterScore, verify, aborted: wasAborted });
    onStep({ runId, done: true, kind, locked, aborted: wasAborted });
    return { doc: work, steps, source, kind, locked, aborted: wasAborted, runId, applied, usage, lint: lintReport, totals, layoutScore: afterScore, verify };
  } finally {
    inFlight--;
  }
}

// ── COPY-REFERENCE agent run ──────────────────────────────────────────────────────────────────────
// The reference-copy flow, unified onto the SAME harness event vocabulary as the edit agent. It:
//   1. runs extractLayout (which itself fans out its deterministic palette/background workers,
//      streaming `subagent` frames) with onStep wired to THIS run's emit → extraction narration
//      becomes `thinking` steps, its fan-out becomes `subagent` steps;
//   2. applies the extracted skeleton onto the current doc (an `op`);
//   3. runs a MAKER-CHECKER verify (deterministic verifyDesign as the checker) and emits `verify`.
// Returns the same shape as runDesignAgent so callers/servers treat it identically. `emit` and
// runId are threaded in from runDesignAgent so steps share one stream.
export async function runCopyReference(doc, reference, emit, opts = {}) {
  const runId = opts.runId || `design_${Date.now().toString(36)}`;
  const kit = opts.kit || null;
  const model = llmInfo();
  const usage = { inTok: 0, outTok: 0 };
  const work = JSON.parse(JSON.stringify(doc));
  const label = reference.label || 'reference';

  emit('thinking', `copying the design from ${label} — reading the reference, then rebuilding it in this comp`);

  // Extraction IS a fan-out orchestrator internally (palette + background workers). Its onStep is
  // wired to emit so its `thinking`/`subagent` frames land on THIS run's unified stream.
  // opts.ext: caller-supplied pre-computed extraction (persisted skeleton / eval harness) —
  // skips the vision round-trip. opts.extractTimeoutMs: budget override for slow local vision
  // models. Neither changes behavior when absent.
  let ext = opts.ext || null;
  if (!ext) try {
    ext = await extractLayout(reference.path, {
      runId,
      timeoutMs: opts.extractTimeoutMs || undefined,
      // The run's AbortSignal now reaches every vision call inside extraction (RUN-1 fix): the
      // Stop button and comp-delete genuinely kill a copy-reference run instead of letting it
      // burn vision cycles to completion against a doc nobody wants.
      signal: opts.signal || null,
      onStep: (step) => {
        if (!step || !step.kind) return;
        // subagent frames pass through verbatim (carry {id,title,model,status,phase}); thinking
        // frames are re-emitted as this run's narration.
        if (step.kind === 'subagent') emit('subagent', step.summary, step.data);
        else emit('thinking', step.summary, step.data || null);
      },
    });
  } catch (e) {
    ext = { ok: false, error: String(e?.message || e) };
  }

  if (!ext || !ext.ok) {
    const err = (ext && ext.error) || 'extraction failed';
    emit('verify', `couldn't copy the reference: ${err}`, { model: 'copy-reference', error: err });
    const verify = verifyDesign(work, { kit, skeletonId: work.skeletonId });
    return { doc: work, source: 'copy-reference', applied: 0, usage, lint: lintDesign(work, kit), totals: { turns: 0, parts: 1, inTok: 0, outTok: 0 }, layoutScore: layoutScore(work, kit), verify, error: err };
  }

  // Lock the doc canvas to the reference's aspect (the extraction already computed it) so the
  // rebuilt comp copies the reference's real proportions.
  if (ext.canvas && ext.canvas.w && ext.canvas.h) work.canvas = { w: ext.canvas.w, h: ext.canvas.h };
  const skeleton = { id: `skel_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, canvas: ext.canvas, layers: ext.layers, archetype: ext.archetype, background: ext.background, theme: ext.theme };

  // MAKER-CHECKER: the "maker" applies the skeleton; the deterministic verifyDesign is the "checker"
  // (a cheap second pass — generate then validate — with no extra model latency).
  const mc = await makerChecker(
    () => { const r = applySkeletonToDoc(work, skeleton); return { work, added: r.added }; },
    ({ work: w }) => {
      const v = verifyDesign(w, { kit, skeletonId: w.skeletonId });
      // a copy that produced no overlays is a real failure; otherwise accept
      const overlays = (w.layers || []).filter((n) => n.type === 'group' || n.role !== 'base').length;
      return { ok: overlays > 0, findings: v.ready ? [] : ['verify not ready — reference copy is approximate'] };
    },
  );
  emit('op', `rebuilt ${mc.candidate.added} layer${mc.candidate.added === 1 ? '' : 's'} from ${label} · ${ext.archetype || 'generic'}${ext.backgroundIsPhoto ? ' · bg photo' : ext.background ? ' · bg ' + (typeof ext.background === 'string' ? ext.background : 'gradient') : ''}`, { deterministic: true });

  // AUTO-CUTOUT: extraction marks regions that should be LIFTED from the reference pixels rather
  // than rebuilt (avatars, complex logos — `cutoutCandidate: {region, shape}` on the skeleton
  // layer). Convert those placeholders into real masked image-crop layers pointing at the
  // reference asset — the same shape the manual {op:'cutout'} produces — so faces/logos in a copy
  // are the ACTUAL reference pixels, not a tinted silhouette. Needs a servable ref id; without
  // one the silhouette placeholder stays (graceful).
  if (reference.ref) {
    const refSrc = `/refasset?id=${reference.ref}`;
    // PHOTO BACKGROUND (copy-fidelity): a photo reference has no flat fill to rebuild — use the
    // reference itself as the full-bleed base (overlays rebuilt on top cover its baked-in text).
    // Only when the skeleton didn't produce its own base.
    if (ext.backgroundIsPhoto && !(work.layers || []).some((n) => n.role === 'base')) {
      work.layers.unshift({
        id: `base_${Date.now().toString(36)}`, type: 'image', role: 'base',
        name: 'Background (reference photo)', src: refSrc,
        box: { x: 0, y: 0, w: work.canvas.w, h: work.canvas.h },
        style: { fit: 'cover' },
      });
      emit('op', 'photo reference → full-bleed reference base under the rebuilt overlays', { deterministic: true });
      // With the reference itself as the base, PLACEHOLDER slabs (grey product/photo stand-ins
      // that never resolved to a cutout) only OCCLUDE the real pixels behind them — drop them.
      // Real overlays (text, pills, cutout crops) stay.
      const isPlaceholderSlab = (n) => !n.text && !n.cutoutCandidate && !n.src
        && (n.type === 'shape' || n.type === 'image')
        && /9aa0a6/i.test(String(n?.style?.background || ''));
      let dropped = 0;
      const prune = (list) => {
        for (let i = list.length - 1; i >= 0; i--) {
          const n = list[i];
          if (!n) continue;
          if (n.type === 'group' && Array.isArray(n.children)) { prune(n.children); continue; }
          if (isPlaceholderSlab(n)) { list.splice(i, 1); dropped++; }
        }
      };
      prune(work.layers);
      if (dropped) emit('op', `dropped ${dropped} placeholder slab${dropped === 1 ? '' : 's'} occluding the reference photo`, { deterministic: true });
    }
    // Two-phase because matteCutout is async and walkNodes is sync: collect candidates, then
    // convert + (best-effort) matte each one.
    const candidates = [];
    walkNodes(work.layers, (n) => { if (n?.cutoutCandidate?.region) candidates.push(n); });
    let lifted = 0;
    let matted = 0;
    for (const n of candidates) {
      const cc = n.cutoutCandidate;
      delete n.cutoutCandidate;
      // VECTOR-FIRST for small logos/emblems (inverse-design principle: a mark the designer drew
      // as a graphic should be a crisp scalable vector, not a fuzzy raster crop). Gated hard in
      // traceRegion — photos/gradients fail and fall through to the crop→matte path below.
      // !n.text guard: a layer that carries TEXT is typography, never a traceable mark — pool
      // reads sometimes label wordmark headlines role:"logo", and tracing them produced the
      // broken uneditable vector-text the owner flagged. Text stays text, always.
      if (cc.shape === 'logo' && !String(n.text || '').trim() && n.box && (n.box.w * n.box.h) / (work.canvas.w * work.canvas.h) <= 0.12 && !opts.signal?.aborted) {
        try {
          const srcPng = join(STATE_DIR, 'refs', `${reference.ref}.png`);
          if (existsSync(srcPng)) {
            const { traceRegion } = await import('./vector-trace.mjs');
            const tr = await traceRegion(srcPng, cc.region, { maxRegionFrac: 0.12 });
            if (tr.ok && Array.isArray(tr.paths) && tr.paths.length) {
              const baseName = n.name || 'Logo (vectorized)';
              if (tr.pathCount === 1) {
                n.type = 'shape';
                n.role = 'logo';
                n.name = baseName;
                n.style = { shapeKind: 'path', path: tr.paths[0].d, background: tr.paths[0].fill };
              } else {
                n.type = 'group';
                n.role = 'logo';
                n.name = baseName;
                n.style = {};
                n.children = tr.paths.map((p, i) => ({
                  id: `${n.id || 'vec'}_p${i}`, type: 'shape', role: 'logo', name: `${baseName} ${i + 1}`,
                  box: { ...n.box }, style: { shapeKind: 'path', path: p.d, background: p.fill },
                }));
              }
              delete n.text;
              delete n.src;
              lifted++;
              emit('op', `vectorized ${baseName} (${tr.pathCount} path${tr.pathCount === 1 ? '' : 's'} traced from the reference)`, { deterministic: true });
              continue; // vector replaces crop + matte entirely
            }
          }
        } catch { /* vector trace is an upgrade, never a gate */ }
      }
      n.type = 'image';
      n.src = refSrc;
      delete n.text;
      const style = { crop: { x: cc.region.x, y: cc.region.y, w: cc.region.w, h: cc.region.h } };
      if (cc.shape === 'avatar') style.shapeKind = 'ellipse';
      else if (cc.shape === 'logo') style.radius = Math.max(4, Math.round(Math.min(n.box?.w || 0, n.box?.h || 0) * 0.12));
      else style.radius = Math.max(8, Math.round(Math.min(n.box?.w || 0, n.box?.h || 0) * 0.035)); // media card corners
      n.style = style;
      n.name = n.name || (cc.shape === 'avatar' ? 'Avatar (cut out)' : 'Cut-out');
      lifted++;
      // ALPHA-MATTE UPGRADE (research TOP-5 #2): a rect crop drags the photo's background along;
      // for product/logo shapes, try a true subject matte of the same region (cached, ~1.5s cold,
      // 1ms cached). A PASSING matte replaces the crop with a transparent-subject PNG served via
      // the same /refasset route (written into .state/refs/). Avatars keep the ellipse crop —
      // round chrome frames ARE the platform-accurate look. Any failure keeps today's rect crop.
      if (cc.shape !== 'avatar' && cc.shape !== 'media' && !opts.signal?.aborted) {
        // 'media' = a post's photograph merged into one rect crop — matting it would strip the
        // photo's own background (the whole point of the merge); 'avatar' keeps its round frame.
        try {
          const srcPng = join(STATE_DIR, 'refs', `${reference.ref}.png`);
          if (existsSync(srcPng)) {
            const key = matteCacheKey(readFileSync(srcPng), cc.region).slice(0, 8);
            const matteId = `${reference.ref}m${key}`;
            const r = await matteCutout(srcPng, cc.region, join(STATE_DIR, 'refs', `${matteId}.png`));
            if (r.ok) {
              n.src = `/refasset?id=${matteId}`;
              delete n.style.crop;
              delete n.style.radius;
              matted++;
            }
          }
        } catch { /* matte is an upgrade, never a gate */ }
      }
    }
    if (lifted) emit('op', `cut ${lifted} region${lifted === 1 ? '' : 's'} out of the reference (real pixels, not placeholders)${matted ? ` · ${matted} upgraded to true subject matte${matted === 1 ? '' : 's'} (background removed)` : ''}`, { deterministic: true });
  }

  // FINAL contrast repair (same as the edit path) so copied text stays legible on the new base.
  try { const ad = smartAdRepair(work, { kit }); if (ad.summaries.length) emit('op', ad.summary, { deterministic: true }); } catch { /* never fatal */ }

  work.updatedAt = Date.now();
  const afterScore = layoutScore(work, kit);
  const verify = verifyDesign(work, { kit, skeletonId: work.skeletonId });
  const lint = lintDesign(work, kit);
  // EXTRACTION METRICS: surface the iterative self-check's metrics so callers (the server,
  // the frontend activity panel) can show fidelity score, iterations, and corrections applied.
  const extractionMetrics = ext && ext.selfCheck ? {
    extractionScore: ext.selfCheck.score ?? null,
    extractionIterations: ext.selfCheck.iterations ?? 0,
    extractionCorrectionsApplied: ext.selfCheck.applied ?? 0,
    extractionTotalCorrections: ext.selfCheck.totalCorrections ?? 0,
  } : null;
  emit('verify', `${verifySummary(verify)} · copied ${mc.candidate.added} layers · ${mc.findings.length ? mc.findings[0] : 'checker ok'} · layout ${afterScore}${extractionMetrics?.extractionScore != null ? ` · extraction fidelity ${extractionMetrics.extractionScore}` : ''}${extractionMetrics?.extractionIterations > 1 ? ` (${extractionMetrics.extractionIterations} iterations)` : ''}`, { model: 'copy-reference', layoutScore: afterScore, verify, extractionMetrics });
  return { doc: work, source: 'copy-reference', applied: mc.candidate.added, usage, lint, totals: { turns: 0, parts: 1, inTok: usage.inTok, outTok: usage.outTok }, layoutScore: afterScore, verify, extractionMetrics };
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
