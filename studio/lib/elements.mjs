// lib/elements.mjs — the shared PARAMETRIC element library. Plain JS, zero-dep: runs in Node
// (design agent / server) AND in the browser via Vite (src/components/design/elements.ts
// re-exports it). Every element is an ElementDef: typed params with defaults + a pure build()
// that emits scene-graph layers sized as CANVAS FRACTIONS of the target doc.
//
// Instances carry provenance: buildElement stamps `.element = { id, params, v: 1 }` on the
// inserted node (the wrapping group, or the single layer) so agents/UI can re-open and
// re-build them with new params.
//
// Types (JSDoc — mirrored as TS in src/components/design/elements.ts):
// @typedef {Object} ParamSpec
//   @property {string} key
//   @property {'text'|'color'|'number'|'boolean'|'enum'|'stringList'|'series'} type
//   @property {*} default
//   @property {string} [label]
//   @property {number} [min]
//   @property {number} [max]
//   @property {string[]} [options]     enum only
//   @property {number} [maxItems]      stringList/series
//   @property {number} [maxLen]        text / stringList items
//   @property {boolean} [brandColor]   color: default from the brand kit when available
//   @property {boolean} [quiet]        omit from elementCatalogLine (still coerced + editable
//                                      in the properties panel — keeps agent catalog ≤60 chars)
//   @property {string} [sig]           catalog-line override for this param (e.g. a 24-option
//                                      enum compresses to just its key)
// @typedef {Object} ElementDef
//   @property {string} id
//   @property {string} name
//   @property {string} hint
//   @property {string} category
//   @property {ParamSpec[]} params
//   @property {{x:number,y:number,w:number,h:number}} defaultBox  CANVAS FRACTIONS 0..1
//   @property {(doc: object, p: object) => object[]} build       returns Layer[]

import { groupBounds, walkNodes, findNode } from './scene-tree.mjs';
import { estimateTextBoxH, estimateLineCount } from './type-scale.mjs';
import { NATIVE_ICONS } from './native-icons.mjs';

// ── tiny local id helper (mirrors sceneGraph.ts layerId — same shape, independent counter) ──────
let seq = 0;
export function layerId(prefix = 'layer') {
  return `${prefix}-${Date.now().toString(36)}-${(seq++).toString(36)}`;
}

// ── param coercion ───────────────────────────────────────────────────────────────────────────────

const clampNum = (v, spec) => {
  let n = v;
  if (spec.min != null) n = Math.max(spec.min, n);
  if (spec.max != null) n = Math.min(spec.max, n);
  return n;
};

// trim AFTER capping too — slicing can expose trailing whitespace (keeps coercion idempotent)
const capStr = (v, maxLen) => String(v).trim().slice(0, maxLen || 400).trim();

function coerceValue(spec, v, dflt) {
  if (v === undefined || v === null) v = dflt;
  switch (spec.type) {
    case 'text': {
      if (typeof v !== 'string' && typeof v !== 'number') v = dflt;
      return capStr(v, spec.maxLen);
    }
    case 'color': {
      if (typeof v !== 'string') v = dflt;
      let c = String(v).trim();
      if (/^[0-9a-fA-F]{6}$/.test(c)) c = `#${c}`; // auto-repair bare 6-hex
      if (/^[0-9a-fA-F]{3}$/.test(c)) c = `#${c}`;
      return c || String(dflt);
    }
    case 'number': {
      const n = typeof v === 'number' ? v : Number(String(v).trim()); // '42' → 42
      if (!Number.isFinite(n)) return clampNum(Number(dflt), spec);
      return clampNum(n, spec);
    }
    case 'boolean': {
      if (typeof v === 'boolean') return v;
      if (typeof v === 'string') return v.trim().toLowerCase() === 'true' || v.trim() === '1';
      if (typeof v === 'number') return v !== 0;
      return !!dflt;
    }
    case 'enum': {
      const s = typeof v === 'string' ? v.trim() : v;
      return (spec.options || []).includes(s) ? s : dflt;
    }
    case 'stringList': {
      let list = Array.isArray(v) ? v : v === undefined ? [] : [v]; // scalar → [scalar]
      list = list
        .filter((x) => typeof x === 'string' || typeof x === 'number')
        .map((x) => capStr(x, spec.maxLen || 200));
      if (!list.length) list = Array.isArray(dflt) ? dflt.slice() : [];
      return list.slice(0, spec.maxItems || 12);
    }
    case 'series': {
      let list = Array.isArray(v) ? v : [];
      list = list
        .filter((s) => s && typeof s === 'object')
        .map((s) => ({
          label: capStr(s.label ?? '', 60),
          color: coerceValue({ type: 'color' }, s.color, '#2c5cff'),
          points: (Array.isArray(s.points) ? s.points : [])
            .map((n) => Number(n))
            .filter((n) => Number.isFinite(n))
            .map((n) => Math.max(0, Math.min(1, n)))
            .slice(0, 24),
        }))
        .filter((s) => s.points.length >= 2);
      if (!list.length) list = JSON.parse(JSON.stringify(dflt || []));
      return list.slice(0, spec.maxItems || 2);
    }
    default:
      return dflt;
  }
}

/** Fill in defaults + auto-repair raw params against a def's ParamSpecs. When a spec has
 *  brandColor and the kit has colors, defaults come from kit.colors round-robin. */
export function coerceParams(def, raw = {}, kit = undefined) {
  const out = {};
  const kitColors = kit && Array.isArray(kit.colors) && kit.colors.length ? kit.colors : null;
  let brandIdx = 0;
  for (const spec of def.params || []) {
    let dflt = spec.default;
    if (spec.brandColor && kitColors) dflt = kitColors[brandIdx % kitColors.length];
    if (spec.brandColor) brandIdx++;
    out[spec.key] = coerceValue(spec, raw ? raw[spec.key] : undefined, dflt);
  }
  return out;
}

// ── shared build helpers ─────────────────────────────────────────────────────────────────────────

// Font/radius/padding sizes were historically a pure fraction of canvas WIDTH. That reads fine
// on near-square/landscape-ish canvases, but breaks at the extremes: a 9:16 story is narrow (its
// width is small relative to its height), so width-only sizing UNDER-scales text vs. the tall
// canvas it sits in; a 16:9 landscape is very wide, so the same fraction OVER-scales text into
// huge, disproportionate pills. Sizing off min(w,h) instead tracks whichever dimension is the
// binding constraint for legibility — the short side — which is what actually determines how big
// text can get before it overruns the canvas in EITHER orientation. A px clamp guards the true
// extremes (ultra-tall/ultra-wide) so no element can blow up past ~12% of the short side or
// shrink below a legible floor.
const sized = (doc) => {
  const { w, h } = doc.canvas;
  const m = Math.min(w, h);
  return {
    w, h,
    rx: (f) => Math.round(w * f),
    ry: (f) => Math.round(h * f),
    // font sizes scale with the SHORTER canvas dimension, clamped to a sane px range so neither
    // a very tall (9:16) nor very wide (16:9) canvas pushes text past legible/proportionate bounds.
    fs: (f) => Math.round(Math.max(10, Math.min(m * f, m * 0.12))),
  };
};

const text = (over) => ({ id: layerId(over.role || 'text'), type: 'text', autoH: true, ...over });
const shape = (over) => ({ id: layerId(over.role || 'shape'), type: 'shape', ...over });

/** Shrink a single-line-intent layer's fontSize (floor 55%) until its text fits the box width —
 *  bottom-anchored pills/prices must never wrap past the canvas on long extracted copy. Mutates
 *  and returns the layer. Uses the same glyph model as intrinsicTextW (defined below; hoisted). */
const fitSingleLine = (l) => {
  const s = l.style || {};
  const floor = Math.max(12, Math.round((s.fontSize || 40) * 0.55));
  let guard = 0;
  while (intrinsicTextW(l) > (l.box?.w || 0) && (l.style.fontSize || 0) > floor && guard++ < 20) {
    l.style.fontSize = Math.max(floor, Math.round(l.style.fontSize * 0.93));
  }
  return l;
};

// ── font sensibility ─────────────────────────────────────────────────────────────────────────────
// Tiny opinionated map: pick the ONE font that matches the real-world artifact an element mimics
// — NEVER random decorative fonts.
//
// HARD CONSTRAINT on the VALUE SHAPE (why every value below is a SINGLE bare token, no commas,
// no spaces, no quotes): style.fontFamily is consumed by FIVE renderers that quote it
// inconsistently before prepending the shared base clean-sans stack
// (Geist, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif):
//   • Stage.tsx / textMetrics.ts  → `'${value}', <base>`  (ALWAYS wrap the whole value in quotes)
//   • raster.ts / designSvg.ts    → wrap in quotes only when it has a space & no leading quote
//   • designstore.mjs (SSR PNG)   → strip quotes, then `'${value}',<base>`
// A comma list ("Chirp, Segoe UI") becomes ONE invalid family `'Chirp, Segoe UI'` under Stage;
// a spaced name ("SF Pro Text") becomes nested-quoted `'"SF Pro Text"'` and also dies. The ONLY
// shape that survives ALL FIVE is a single quote-free, space-free token — it resolves to the real
// font when installed and otherwise falls through cleanly to the base system stack (which already
// carries -apple-system → SF Pro on Apple, Segoe UI on Windows, Roboto on Android). So we name the
// real product font with a token that IS space-free, and let the base stack be the graceful OS
// fallback rather than trying (and failing) to encode a comma list here.
//
// What each platform ACTUALLY ships (verified brand facts, 2026):
//   • X / Twitter → "Chirp" (custom grotesque by Grilli Type, adopted 2021, whole X UI). Its X web
//     CSS falls Chirp → -apple-system/Segoe UI/Roboto/Helvetica/Arial — exactly our base stack, so
//     the bare token `Chirp` is faithful. Michael's local TTF also registers as `Chirp`.
//   • Instagram → in-app captions/usernames/DMs render in the OS SYSTEM font (SF Pro on iOS, Roboto
//     on Android) — NOT the "Instagram Sans" brand/logo face. So `-apple-system` (→ SF Pro / falls
//     to Roboto/Segoe via the base stack) is the UI-true choice for caption/DM chrome.
//   • iOS / iMessage / Apple Notes → SF Pro via the single token `-apple-system`.
//   • Serif display → single token `Georgia` (ubiquitous, real serif; base stack ends in sans so a
//     miss won't fall to Times — but Georgia ships on ~every OS, so it renders as intended).
export const FONT_SUGGEST = {
  // Editorial serif display — Georgia is installed on effectively every OS (macOS/iOS/Windows/
  // Android via fallback), so this renders as a true serif. Used by before-after / comparison
  // archetypes for their editorial headlines.
  display: 'Georgia',
  sans: '',                 // '' = default clean stack — leave style.fontFamily unset
  mono: 'Menlo',            // receipts, coupon codes — real Apple mono; base stack has no mono, but
                            //   Menlo→(SF Mono/Consolas/Courier via OS) is the right tabular artifact
  hand: 'Bradley Hand',     // handwritten annotations / sticky notes — single Apple script family;
                            //   on a miss the base sans keeps it legible (never a broken serif)
  // X/Twitter — Chirp is a neo-grotesque whose fallback IS our base stack (Helvetica Neue/system),
  // which X itself uses. We name the base stack directly ('') rather than 'Chirp': a locally-
  // installed Chirp in ~/Library/Fonts is invisible to the sandboxed export renderer (qlmanage
  // can't load user fonts → it matches the name but renders tofu), so depending on it breaks PNG
  // export/thumbnails. The base grotesk is visually ~identical and renders reliably everywhere.
  twitter: '',
  // Instagram feed captions + DM chrome — the OS system font (SF Pro on iOS). The base stack
  // resolves -apple-system → Roboto/Segoe on other OSes, matching what Instagram actually renders.
  instagram: '-apple-system',
  // Apple UI (Notes, iMessage, iOS status bar) — SF Pro via -apple-system.
  notes: '-apple-system',
  // alias so callers can ask for the Apple system font by its real name.
  sf: '-apple-system',
  // Editorial serif DISPLAY face — unlike `display` (Georgia, a text-serif fallback), this names
  // a real, bundled, high-contrast serif for elegant editorial-style headline treatments (e.g. the
  // "Chocolate Collection"-style ad reference). Embedded as a real woff2 via font-faces.mjs /
  // fontFaces.ts (SIL OFL) — NOT a Google Fonts CDN-only dependency, so it renders in offline/
  // server-side export too. Space-free single token, same constraint as every other entry here.
  fraunces: 'Fraunces',
  // Bold rounded display sans — for punchy telecom/offer-style headlines (e.g. "FREEDOM PLUS
  // OFFER"). Real, bundled, SIL OFL-licensed woff2 (Poppins Bold/ExtraBold). Not yet wired into
  // any template — available for other archetypes to consume.
  roundedDisplay: 'Poppins',
};

// ── default display/body pairing for natively-generated ads ────────────────────────────────────
// The #1 "wrong font" complaint: with no brand kit, brandable headlines/CTAs fell through to the
// bare clean-sans stack (Geist/Helvetica) for EVERY role — a flat, template-y look with zero
// contrast between the display line and the body/label. FONT_PAIR gives generated ads a strong,
// legible default pairing so the headline reads as a display line and the supporting copy reads as
// a clean grotesk — WITHOUT touching brand-kit ads (a kit font always wins, see buildElement).
//
// SAME single-token constraint as FONT_SUGGEST (see the note above): the value is consumed by five
// renderers that quote it inconsistently, so a comma list collapses to one invalid family under
// Stage. Each value is therefore ONE space-free family token that renders as the real face when
// installed and otherwise falls cleanly through the base clean-sans stack. We pick tokens that ARE
// space-free AND broadly installed, giving a real display-vs-body contrast on most machines:
//   • display → "Impact" — the one heavy condensed grotesk that ships on ~every OS (macOS/iOS/
//     Windows/Android), so the statement line reads distinctly bolder/tighter than the body.
//   • body    → "Helvetica" — a neutral grotesk present on Apple/most systems; on a miss the base
//     stack (Geist/Segoe/Roboto/Arial) keeps it a clean grotesk, never a serif.
export const FONT_PAIR = {
  // Big statement headlines / badges / offer chips — a heavy condensed grotesk with punch.
  display: 'Impact',
  // Subheads / CTAs / body — a clean neutral grotesk that pairs with the display line.
  body: 'Helvetica',
  // Bold ROUNDED display option for punchy telecom/offer-style headlines (e.g. "FREEDOM PLUS
  // OFFER") — an alternative to the condensed/heavy `display` token above for archetypes that want
  // a friendlier, rounded-terminal bold instead of Impact's condensed grotesque. Real bundled
  // woff2 (Poppins Bold/ExtraBold, SIL OFL — see FONT_SUGGEST.roundedDisplay / font-faces.mjs).
  // NOT consumed by roleFontFamily() or any template yet — this is only the token + asset, left
  // for another pass to wire into a specific archetype.
  roundedDisplay: 'Poppins',
};

/** Default fontFamily for a brandable role when NO brand-kit font is supplied. Headline-class
 *  roles (headline, badge, price, echo) get the display face; supporting roles (subhead, cta,
 *  caption) get the body face. Returns '' for unknown roles so callers leave fontFamily unset. */
export function roleFontFamily(role) {
  if (['headline', 'badge', 'price'].includes(role)) return FONT_PAIR.display;
  if (['subhead', 'cta', 'caption'].includes(role)) return FONT_PAIR.body;
  return '';
}

/** IG-caption pill metrics, matched to real Instagram caption/reel text pills (the native "A"-tool
 *  look + Simpletics native ads):
 *   • fontSize 4.6% of canvas width (the ig-caption `size` param overrides via sizePct)
 *   • weight 700 — IG caption pills are heavy; the base system/Instagram-Sans grotesk reads bold
 *   • lineHeight 1.15 BASE — Stage renders pills at lineHeight*1.25, so the effective per-line
 *     leading lands at ~1.44, which is the true gap between IG's stacked rounded pills. (The old
 *     1.32 base → ~1.65 effective was visibly too airy and detached the pills from each other.)
 *   • color: near-pure — #0a0a0a on white / pure #ffffff on black — for the crisp high contrast IG
 *     uses (a flat #111 read slightly muddy against pure-white pills at ad scale).
 *   • background: solid #ffffff (light) / #000000 (dark) — IG caption pills are OPAQUE, not tinted.
 *   • letterSpacing -0.2px — the tiny optical tightening a heavy grotesk wants at display size.
 *   • padding: the renderer draws `padding` px horizontal and `padding*0.55` vertical per line, so
 *     0.5em horizontal → a snug pill that hugs each line (box-decoration-break clone).
 *   • radius: 0.30em — the softly-rounded (not fully pill) corner IG's text tool actually draws. */
function captionPillStyle(doc, dark, over = {}, sizePct = 4.6) {
  // Sized off the SHORTER canvas dimension (see sized().fs above) — a pure canvas.w fraction blew
  // up into oversized pills on wide 16:9 canvases and under-scaled on narrow 9:16 stories, since
  // width alone doesn't reflect how much vertical room a tall/short canvas actually gives text.
  const m = Math.min(doc.canvas.w, doc.canvas.h);
  const fontSize = Math.round(Math.max(10, Math.min(m * (sizePct / 100), m * 0.12)));
  return {
    fontSize, fontWeight: 700, lineHeight: 1.15, letterSpacing: -0.2,
    color: dark ? '#ffffff' : '#0a0a0a',
    background: dark ? '#000000' : '#ffffff',
    pill: true,
    padding: Math.round(fontSize * 0.5),
    radius: Math.round(fontSize * 0.3),
    align: 'left',
    ...over,
  };
}

// ── aliases ──────────────────────────────────────────────────────────────────────────────────────
// Legacy element ids that were consolidated into a single parametric def. buildElement resolves
// them: alias params are merged UNDER caller params, and the instance is stamped with the
// CANONICAL id so re-opening/re-building always lands on the consolidated def.
export const ELEMENT_ALIASES = {
  'ig-caption-light': { id: 'ig-caption', params: { style: 'light' } },
  'benefit-stack': { id: 'ig-caption', params: {} },
  'benefit-stack-light': { id: 'ig-caption', params: { style: 'light' } },
  'glass-card': { id: 'glass', params: {} }, // legacy id → the re-added frosted glass panel
};

// ── icon library ─────────────────────────────────────────────────────────────────────────────────
// 24 hand-drawn single-path icons, Feather/Lucide-style geometry. Every path is normalized to a
// 0..1 box and authored as SOLID FILL geometry (stroke-look icons are pre-expanded into filled
// bands ≈2px on a 24px grid, i.e. ~0.09 of the box; rings/holes use opposite winding under the
// nonzero fill rule). Rendered as shapeKind:'path' + style.path — renderers scale path coords by
// the layer box. Keep names stable: agents address them via the `icon` element's name enum.
export const ICONS = {
  'check': 'M0.14 0.55 L0.40 0.81 L0.86 0.31 L0.75 0.21 L0.40 0.60 L0.25 0.44 Z',
  'x': 'M0.25 0.15 L0.5 0.40 L0.75 0.15 L0.85 0.25 L0.60 0.5 L0.85 0.75 L0.75 0.85 L0.5 0.60 L0.25 0.85 L0.15 0.75 L0.40 0.5 L0.15 0.25 Z',
  'star': 'M0.5 0.05 L0.62 0.36 L0.95 0.38 L0.69 0.59 L0.78 0.91 L0.5 0.72 L0.22 0.91 L0.31 0.59 L0.05 0.38 L0.38 0.36 Z',
  'heart': 'M0.5 0.88 C0.20 0.66 0.06 0.46 0.06 0.30 C0.06 0.12 0.30 0.06 0.5 0.26 C0.70 0.06 0.94 0.12 0.94 0.30 C0.94 0.46 0.80 0.66 0.5 0.88 Z',
  'arrow-right': 'M0.10 0.44 L0.62 0.44 L0.62 0.26 L0.92 0.50 L0.62 0.74 L0.62 0.56 L0.10 0.56 Z',
  'arrow-up-right': 'M0.30 0.18 L0.82 0.18 L0.82 0.70 L0.68 0.70 L0.68 0.42 L0.28 0.82 L0.18 0.72 L0.58 0.32 L0.30 0.32 Z',
  'bolt': 'M0.58 0.06 L0.24 0.56 L0.46 0.56 L0.40 0.94 L0.76 0.42 L0.54 0.42 Z',
  'flame': 'M0.5 0.04 C0.62 0.20 0.80 0.36 0.80 0.60 C0.80 0.78 0.66 0.92 0.5 0.92 C0.34 0.92 0.20 0.78 0.20 0.60 C0.20 0.46 0.28 0.38 0.34 0.24 C0.42 0.34 0.46 0.38 0.50 0.36 C0.48 0.26 0.46 0.16 0.5 0.04 Z',
  'drop': 'M0.5 0.05 C0.5 0.05 0.16 0.45 0.16 0.65 A0.34 0.34 0 0 0 0.84 0.65 C0.84 0.45 0.5 0.05 0.5 0.05 Z',
  'leaf': 'M0.84 0.12 C0.50 0.10 0.20 0.24 0.14 0.54 C0.10 0.76 0.26 0.90 0.44 0.88 C0.74 0.84 0.88 0.50 0.84 0.12 Z',
  'shield': 'M0.5 0.06 L0.85 0.20 L0.85 0.52 C0.85 0.74 0.68 0.88 0.5 0.94 C0.32 0.88 0.15 0.74 0.15 0.52 L0.15 0.20 Z',
  'lock': 'M0.20 0.45 L0.80 0.45 Q0.86 0.45 0.86 0.51 L0.86 0.86 Q0.86 0.92 0.80 0.92 L0.20 0.92 Q0.14 0.92 0.14 0.86 L0.14 0.51 Q0.14 0.45 0.20 0.45 Z M0.30 0.45 L0.30 0.30 A0.20 0.20 0 0 1 0.70 0.30 L0.70 0.45 L0.60 0.45 L0.60 0.30 A0.10 0.10 0 0 0 0.40 0.30 L0.40 0.45 Z',
  'clock': 'M0.06 0.5 A0.44 0.44 0 1 1 0.94 0.5 A0.44 0.44 0 1 1 0.06 0.5 Z M0.16 0.5 A0.34 0.34 0 1 0 0.84 0.5 A0.34 0.34 0 1 0 0.16 0.5 Z M0.46 0.24 L0.54 0.24 L0.54 0.50 L0.70 0.60 L0.64 0.70 L0.46 0.58 Z',
  'truck': 'M0.04 0.28 L0.60 0.28 L0.60 0.68 L0.04 0.68 Z M0.64 0.40 L0.80 0.40 L0.94 0.54 L0.94 0.68 L0.64 0.68 Z M0.12 0.78 A0.08 0.08 0 1 0 0.28 0.78 A0.08 0.08 0 1 0 0.12 0.78 Z M0.68 0.78 A0.08 0.08 0 1 0 0.84 0.78 A0.08 0.08 0 1 0 0.68 0.78 Z',
  'gift': 'M0.08 0.30 L0.92 0.30 L0.92 0.46 L0.08 0.46 Z M0.14 0.52 L0.86 0.52 L0.86 0.92 L0.14 0.92 Z M0.5 0.28 C0.38 0.28 0.30 0.20 0.34 0.12 C0.38 0.06 0.48 0.10 0.5 0.22 C0.52 0.10 0.62 0.06 0.66 0.12 C0.70 0.20 0.62 0.28 0.5 0.28 Z',
  'sparkle': 'M0.5 0.04 C0.56 0.32 0.68 0.44 0.96 0.5 C0.68 0.56 0.56 0.68 0.5 0.96 C0.44 0.68 0.32 0.56 0.04 0.5 C0.32 0.44 0.44 0.32 0.5 0.04 Z',
  'muscle': 'M0.16 0.78 C0.14 0.58 0.22 0.30 0.34 0.16 L0.48 0.10 L0.56 0.22 L0.46 0.30 C0.42 0.40 0.44 0.46 0.50 0.50 C0.62 0.42 0.78 0.44 0.86 0.56 C0.94 0.70 0.86 0.84 0.70 0.88 C0.50 0.92 0.28 0.90 0.16 0.78 Z',
  'brain': 'M0.48 0.14 C0.36 0.06 0.18 0.12 0.16 0.28 C0.06 0.32 0.06 0.48 0.14 0.54 C0.08 0.66 0.16 0.80 0.30 0.80 C0.34 0.90 0.46 0.92 0.48 0.84 Z M0.52 0.14 C0.64 0.06 0.82 0.12 0.84 0.28 C0.94 0.32 0.94 0.48 0.86 0.54 C0.92 0.66 0.84 0.80 0.70 0.80 C0.66 0.90 0.54 0.92 0.52 0.84 Z',
  'eye': 'M0.03 0.5 C0.20 0.22 0.80 0.22 0.97 0.5 C0.80 0.78 0.20 0.78 0.03 0.5 Z M0.12 0.5 C0.28 0.70 0.72 0.70 0.88 0.5 C0.72 0.30 0.28 0.30 0.12 0.5 Z M0.37 0.5 A0.13 0.13 0 1 0 0.63 0.5 A0.13 0.13 0 1 0 0.37 0.5 Z',
  'sun': 'M0.30 0.5 A0.20 0.20 0 1 0 0.70 0.5 A0.20 0.20 0 1 0 0.30 0.5 Z M0.46 0.04 L0.54 0.04 L0.54 0.18 L0.46 0.18 Z M0.46 0.82 L0.54 0.82 L0.54 0.96 L0.46 0.96 Z M0.04 0.46 L0.18 0.46 L0.18 0.54 L0.04 0.54 Z M0.82 0.46 L0.96 0.46 L0.96 0.54 L0.82 0.54 Z M0.70 0.24 L0.76 0.30 L0.72 0.34 L0.66 0.28 Z M0.30 0.24 L0.24 0.30 L0.28 0.34 L0.34 0.28 Z M0.70 0.76 L0.76 0.70 L0.72 0.66 L0.66 0.72 Z M0.30 0.76 L0.24 0.70 L0.28 0.66 L0.34 0.72 Z',
  'moon': 'M0.66 0.06 A0.45 0.45 0 1 0 0.94 0.68 A0.36 0.36 0 1 1 0.66 0.06 Z',
  'chat-bubble': 'M0.10 0.18 Q0.10 0.10 0.18 0.10 L0.82 0.10 Q0.90 0.10 0.90 0.18 L0.90 0.62 Q0.90 0.70 0.82 0.70 L0.38 0.70 L0.18 0.88 L0.18 0.70 Q0.10 0.70 0.10 0.62 Z',
  'play': 'M0.24 0.12 L0.88 0.5 L0.24 0.88 Z',
  'plus': 'M0.42 0.10 L0.58 0.10 L0.58 0.42 L0.90 0.42 L0.90 0.58 L0.58 0.58 L0.58 0.90 L0.42 0.90 L0.42 0.58 L0.10 0.58 L0.10 0.42 L0.10 0.42 Z',
  // EXACT platform-chrome + brand glyphs from lib/native-icons.mjs (verbatim X.com / Instagram
  // DOM-extracted paths, Bootstrap Icons (MIT) fallbacks, simple-icons (CC0) brand marks) —
  // keys like 'x-like-outline', 'ig-comment', 'ios-check', 'brand-tiktok'. Same 0..1-normalized
  // d-string contract as the hand-drawn set above, so they render/recolor identically.
  ...Object.fromEntries(Object.entries(NATIVE_ICONS).map(([k, v]) => [k, v.d])),
};

// ── the registry ─────────────────────────────────────────────────────────────────────────────────

export const ELEMENT_CATEGORIES = ['Captions', 'Text', 'Cards', 'Buttons', 'Overlays', 'Social', 'Charts', 'Icons'];

const T = (key, dflt, extra = {}) => ({ key, type: 'text', default: dflt, ...extra });
const C = (key, dflt, extra = {}) => ({ key, type: 'color', default: dflt, ...extra });
const N = (key, dflt, min, max, extra = {}) => ({ key, type: 'number', default: dflt, min, max, ...extra });
const B = (key, dflt, extra = {}) => ({ key, type: 'boolean', default: dflt, ...extra });
const E = (key, dflt, options, extra = {}) => ({ key, type: 'enum', default: dflt, options, ...extra });
const SL = (key, dflt, extra = {}) => ({ key, type: 'stringList', default: dflt, ...extra });

// Sibling element libraries (starburst/testimonial badges, background shapes, callouts/Q&A) —
// each is plug-compatible with the ElementDef contract and merged in below. NOTE: elements-badges.mjs
// imports layerId/coerceParams/FONT_SUGGEST/FONT_PAIR back FROM this file — a circular import that
// works because those imports are only used inside build() closures (called later), not at this
// module's top-level evaluation time. Verified at runtime before landing this.
import { BADGE_ELEMENTS } from './elements-badges.mjs';
import { BACKGROUND_ELEMENTS } from './elements-backgrounds.mjs';
import { CALLOUT_ELEMENTS } from './elements-callouts.mjs';

/** @type {ElementDef[]} */
export const ELEMENTS = [
  ...BADGE_ELEMENTS,
  ...BACKGROUND_ELEMENTS,
  ...CALLOUT_ELEMENTS,

  // ── Captions ───────────────────────────────────────────────────────────────────────────────────
  {
    id: 'ig-caption', name: 'IG caption', category: 'Captions',
    hint: 'Caption pills — optional bold hook line + multi-line items (benefit stack)',
    defaultBox: { x: 0.07, y: 0.12, w: 0.86, h: 0.10 },
    params: [
      T('text', 'Why my hair finally holds all day:'),
      T('hook', '', { maxLen: 120, label: 'Bold first pill (optional)' }),
      SL('items', [], { maxItems: 8, label: 'Pill lines (replace text)' }),
      E('style', 'dark', ['dark', 'light']),
      E('preset', 'pill', ['pill', 'bar', 'minimal', 'outline'], { label: 'Caption look' }),
      E('align', 'left', ['left', 'center', 'right'], { quiet: true }),
      N('size', 4.6, 2, 8, { quiet: true, label: 'Font size (% of width)' }),
      B('tight', false, { quiet: true, label: 'Pill lines touching' }),
    ],
    build(doc, p) {
      // Measured against real Simpletics native ads: 4.6%-width pills, weight 700, lh 1.32.
      const { rx, ry, fs } = sized(doc);
      const dark = p.style === 'dark';
      // Same min(w,h)-relative, clamped sizing as captionPillStyle/fs — keeps the preset-derived
      // radius/padding math (below) proportionate to the actual pill font size on every aspect
      // ratio instead of blowing up on wide canvases or shrinking on narrow ones.
      const fsPx = fs(p.size / 100);
      // presets: quick-pick caption looks — one param instead of hand-tuning 5 style fields
      const presetOver = p.preset === 'bar'
        ? { radius: Math.round(fsPx * 0.06) }                                 // square-ish full bars
        : p.preset === 'minimal'
          ? { pill: false, background: undefined, color: dark ? '#ffffff' : '#111111', shadow: true }
          : p.preset === 'outline'
            ? { pill: false, background: undefined, color: dark ? '#ffffff' : '#111111', stroke: { color: dark ? '#ffffff' : '#111111', width: 2 }, padding: Math.round(fsPx * 0.35) }
            : {};                                                              // 'pill' = classic
      const over = { align: p.align, ...(p.tight ? { lineHeight: 1.05 } : {}), ...presetOver };
      const body = p.items.length ? p.items.join('\n') : p.text;
      const layers = [];
      let y = 0.12;
      if (p.hook) {
        // Type scale: the hook pill reads ~18% bigger + heavier than the benefit lines beneath it,
        // the same emphasis IG captions give a bold opening line over its follow-up pills.
        const hookSize = Math.min(8, p.size * 1.18);
        const hookBox = { x: rx(0.07), y: ry(y), w: rx(0.86), h: ry(0.085) };
        const hookStyle = captionPillStyle(doc, dark, { ...over, fontWeight: 800 }, hookSize);
        layers.push(text({
          role: 'headline', name: 'Hook pill', text: p.hook,
          box: hookBox, style: hookStyle,
        }));
        // The hook text can wrap to 2+ lines (long hooks, narrow 1:1/9:16 canvases) — a fixed
        // "y = 0.24" offset assumed a single-line pill and let the benefit pill below overlap/clip
        // the hook's wrapped second line. Derive the gap from the hook's ACTUAL estimated rendered
        // height (same wrap-aware estimator repairTextLayer/autoH growth use) so the benefit pill
        // always starts below wherever the hook pill really ends, on every aspect ratio.
        const hookH = estimateTextBoxH({ type: 'text', text: p.hook, box: hookBox, style: hookStyle });
        const gapPx = Math.round(hookSize && hookStyle.fontSize ? hookStyle.fontSize * 0.5 : ry(0.03));
        y = (hookBox.y + Math.max(hookH, hookBox.h) + gapPx) / doc.canvas.h;
      }
      layers.push(text({
        role: 'caption', name: p.hook || p.items.length ? 'Benefit pills' : 'IG caption', text: body,
        box: { x: rx(0.07), y: ry(y), w: rx(p.hook || p.items.length > 1 ? 0.62 : 0.86), h: ry(0.15) },
        style: captionPillStyle(doc, dark, over, p.size),
      }));
      return layers;
    },
  },

  // ── Text ───────────────────────────────────────────────────────────────────────────────────────
  {
    id: 'headline', name: 'Display headline', category: 'Text', brandFont: true,
    hint: 'Big bold uppercase statement, static-style',
    defaultBox: { x: 0.05, y: 0.09, w: 0.90, h: 0.14 },
    params: [T('text', 'BLACK FRIDAY SALE'), C('color', '#111111'), E('align', 'center', ['left', 'center', 'right'], { quiet: true })],
    build(doc, p) {
      const { rx, ry, fs } = sized(doc);
      return [text({
        role: 'headline', name: 'Headline', text: p.text,
        box: { x: rx(0.05), y: ry(0.09), w: rx(0.90), h: ry(0.14) },
        style: { fontSize: fs(0.078), fontWeight: 800, color: p.color, align: p.align, lineHeight: 1.05, uppercase: true, letterSpacing: -1 },
      })];
    },
  },
  {
    id: 'subline', name: 'Subline', category: 'Text', brandFont: true,
    hint: 'Quiet supporting line under a headline',
    defaultBox: { x: 0.05, y: 0.23, w: 0.90, h: 0.06 },
    params: [T('text', 'Add these to your regimen.'), C('color', '#333333', { quiet: true })],
    build(doc, p) {
      const { rx, ry, fs } = sized(doc);
      return [text({
        role: 'subhead', name: 'Subline', text: p.text,
        box: { x: rx(0.05), y: ry(0.23), w: rx(0.90), h: ry(0.06) },
        style: { fontSize: fs(0.038), fontWeight: 400, color: p.color, align: 'center', lineHeight: 1.3 },
      })];
    },
  },
  {
    id: 'echo', name: 'Echo text', category: 'Text', brandFont: true,
    hint: 'Repeated fading headline rows (EARLY ACCESS look)',
    defaultBox: { x: 0.05, y: 0.08, w: 0.90, h: 0.23 },
    params: [T('text', 'EARLY ACCESS'), N('rows', 3, 1, 6), C('color', '#111111')],
    build(doc, p) {
      const { rx, ry, fs } = sized(doc);
      const rows = Math.round(p.rows);
      // rows=3 keeps today's exact opacities; other counts fade linearly 1 → 0.3.
      const opacity = (i) => (rows === 3 ? [1, 0.55, 0.3][i] : rows === 1 ? 1 : 1 - (i / (rows - 1)) * 0.7);
      return Array.from({ length: rows }, (_, i) => text({
        role: 'headline', name: `Echo ${i + 1}`, text: p.text, autoH: false, // fixed fade rows — growth breaks the stack rhythm
        box: { x: rx(0.05), y: ry(0.08 + i * 0.075), w: rx(0.90), h: ry(0.07) },
        style: { fontSize: fs(0.085), fontWeight: 800, color: p.color, align: 'left', uppercase: true, lineHeight: 1, opacity: opacity(i), letterSpacing: -1 },
      }));
    },
  },

  {
    id: 'checklist', name: 'Checklist', category: 'Text',
    hint: 'Mark + item rows — ✓ / ○, or red ✗ when negative',
    defaultBox: { x: 0.10, y: 0.30, w: 0.80, h: 0.30 },
    params: [
      SL('items', ['Holds all day', 'No grease, no crunch', 'Restyles with fingers'], { maxItems: 8, maxLen: 80 }),
      E('style', 'check', ['circle', 'check']),
      C('color', '#00b67a'),
      B('negative', false, { label: 'Red ✗ marks' }),
    ],
    build(doc, p) {
      const { rx, ry, fs } = sized(doc);
      const x = rx(0.10), y = ry(0.30), w = rx(0.80);
      const rowH = ry(0.055);
      const mark = p.negative ? '✗' : p.style === 'circle' ? '○' : '✓';
      const markColor = p.negative ? '#d92c2c' : p.color;
      const layers = [];
      p.items.forEach((it, i) => {
        layers.push(
          text({
            role: 'caption', name: `Mark ${i + 1}`, text: mark,
            box: { x, y: y + i * rowH, w: rx(0.06), h: rowH },
            style: { fontSize: fs(0.036), fontWeight: 800, color: markColor, align: 'left', lineHeight: 1.25, shadow: true },
          }),
          text({
            role: 'caption', name: `Item ${i + 1}`, text: it,
            box: { x: x + rx(0.07), y: y + i * rowH, w: w - rx(0.07), h: rowH },
            style: { fontSize: fs(0.032), fontWeight: 600, color: '#ffffff', align: 'left', lineHeight: 1.35, shadow: true },
          }),
        );
      });
      return layers;
    },
  },
  {
    id: 'handwritten', name: 'Handwritten note', category: 'Text',
    hint: 'Casual handwriting line, slight tilt',
    defaultBox: { x: 0.10, y: 0.55, w: 0.80, h: 0.10 },
    params: [T('text', 'this one actually works →', { maxLen: 120 }), C('color', '#111111')],
    build(doc, p) {
      const { rx, ry, fs } = sized(doc);
      return [text({
        role: 'caption', name: 'Handwritten', text: p.text, rotation: -2,
        box: { x: rx(0.10), y: ry(0.55), w: rx(0.80), h: ry(0.08) },
        style: { fontSize: fs(0.042), fontWeight: 700, color: p.color, align: 'left', lineHeight: 1.25, fontFamily: FONT_SUGGEST.hand },
      })];
    },
  },

  // ── Cards ──────────────────────────────────────────────────────────────────────────────────────
  {
    id: 'stat-card', name: 'Stat card', category: 'Cards',
    hint: 'Label + big value on a translucent card',
    defaultBox: { x: 0.55, y: 0.62, w: 0.38, h: 0.10 },
    params: [T('label', 'Kcal per portie:'), T('value', '199'), C('bg', '#ffffff', { quiet: true }), C('color', '#111111', { quiet: true, label: 'Value color' })],
    build(doc, p) {
      const { rx, ry, fs } = sized(doc);
      return [
        shape({
          role: 'card', name: 'Stat card bg',
          box: { x: rx(0.55), y: ry(0.62), w: rx(0.38), h: ry(0.10) },
          style: { background: p.bg, opacity: 0.82, radius: fs(0.012) },
        }),
        text({
          role: 'caption', name: 'Stat label', text: p.label, autoH: false, // fixed card rows
          box: { x: rx(0.57), y: ry(0.625), w: rx(0.34), h: ry(0.035) },
          style: { fontSize: fs(0.028), fontWeight: 500, color: '#333333', align: 'left' },
        }),
        text({
          role: 'price', name: 'Stat value', text: p.value, autoH: false,
          box: { x: rx(0.57), y: ry(0.66), w: rx(0.34), h: ry(0.05) },
          style: { fontSize: fs(0.05), fontWeight: 800, color: p.color, align: 'left' },
        }),
      ];
    },
  },
  {
    id: 'price-strip', name: 'Price strip', category: 'Cards', brandFont: true,
    hint: 'Old vs new price row',
    defaultBox: { x: 0.05, y: 0.765, w: 0.53, h: 0.075 },
    params: [T('oldPrice', '$49.99'), T('newPrice', '$19.99'), C('color', '#ffe14d', { brandColor: true })],
    build(doc, p) {
      const { rx, ry, fs } = sized(doc);
      return [
        fitSingleLine(text({
          role: 'price', name: 'Old price', text: p.oldPrice,
          box: { x: rx(0.05), y: ry(0.78), w: rx(0.22), h: ry(0.06) },
          style: { fontSize: fs(0.04), fontWeight: 500, color: 'rgba(255,255,255,0.55)', align: 'left' },
        })),
        fitSingleLine(text({
          role: 'price', name: 'New price', text: p.newPrice,
          box: { x: rx(0.28), y: ry(0.765), w: rx(0.3), h: ry(0.075) },
          style: { fontSize: fs(0.055), fontWeight: 800, color: p.color, align: 'left', shadow: true },
        })),
      ];
    },
  },
  {
    id: 'glass', name: 'Glass panel', category: 'Cards',
    hint: 'Frosted panel — backdrop blur + translucent tint + hairline stroke, for over-photo cards',
    defaultBox: { x: 0.10, y: 0.58, w: 0.80, h: 0.28 },
    params: [
      T('text', '', { maxLen: 200, label: 'Optional label' }),
      C('tint', '#ffffff', { label: 'Glass tint' }),
      N('blur', 18, 0, 60, { label: 'Backdrop blur px' }),
      N('opacity', 0.18, 0, 1, { quiet: true, label: 'Tint opacity' }),
      B('dark', false, { quiet: true, label: 'Dark glass (light text)' }),
    ],
    build(doc, p) {
      const { rx, ry, fs } = sized(doc);
      const x = rx(0.10), y = ry(0.58), w = rx(0.80), h = ry(0.28);
      const radius = fs(0.03);
      // Frosted panel: style.backdropBlur is REAL blur in DOM/HTML previews and a Figma
      // BACKGROUND_BLUR on export; raster/SVG draw a glass-edge hint (see raster.ts glassEdge).
      // A translucent tint over it + a subtle hairline stroke sells the frosted glass.
      const strokeColor = p.dark ? '#ffffff' : '#ffffff';
      const layers = [shape({
        role: 'card', name: 'Glass panel', box: { x, y, w, h },
        style: {
          background: p.tint,
          opacity: Math.max(0, Math.min(1, p.opacity)),
          backdropBlur: Math.round(p.blur),
          radius,
          stroke: { color: strokeColor, width: 2, opacity: 0.35 },
        },
      })];
      if (p.text) {
        layers.push(text({
          role: 'caption', name: 'Glass label', text: p.text,
          box: { x: x + Math.round(w * 0.07), y: y + Math.round(h * 0.5) - fs(0.03), w: w - Math.round(w * 0.14), h: fs(0.06) },
          style: { fontSize: fs(0.036), fontWeight: 700, color: p.dark ? '#ffffff' : '#111111', align: 'center', lineHeight: 1.25 },
        }));
      }
      return layers;
    },
  },
  // glass-card removed 2026-07: raster/SVG exports could only fake backdrop blur (1px edge
  // hint), so DOM previews lied about the export. The `glass` element above re-adds a working
  // frosted panel (backdropBlur renders truly in DOM/HTML/Figma). Saved docs still migrate old
  // solid cards; the alias below keeps old {"op":"element","element":"glass-card"} requests working.
  {
    id: 'image-placeholder', name: 'Image placeholder', category: 'Cards',
    hint: 'Dashed previs frame with a diagonal cross — swap for a real shot later',
    defaultBox: { x: 0.25, y: 0.32, w: 0.5, h: 0.5 },
    params: [T('label', 'IMAGE', { maxLen: 40 }), E('aspect', '1:1', ['1:1', '4:5', '9:16', '16:9'])],
    build(doc, p) {
      const { rx, ry, fs } = sized(doc);
      const ratio = { '1:1': 1, '4:5': 5 / 4, '9:16': 16 / 9, '16:9': 9 / 16 }[p.aspect]; // h/w
      let w = rx(0.5);
      let h = Math.round(w * ratio);
      // tall aspects can outgrow short canvases — clamp to 90% height, keep the aspect, recenter
      const maxH = ry(0.9);
      if (h > maxH) { h = maxH; w = Math.round(h / ratio); }
      const bx = Math.round((doc.canvas.w - w) / 2);
      const by = Math.max(ry(0.05), Math.min(ry(0.32), doc.canvas.h - h - ry(0.05)));
      const box = { x: bx, y: by, w, h };
      return [
        shape({
          role: 'product', name: 'Placeholder frame', box: { ...box },
          style: { background: '#9aa0a615', radius: fs(0.012), stroke: { color: '#9aa0a6', width: Math.max(2, Math.round(w * 0.006)) } },
        }),
        shape({
          role: 'product', name: 'Cross ↘', box: { ...box },
          style: { shapeKind: 'line', background: '#9aa0a6', opacity: 0.5 },
        }),
        shape({
          role: 'product', name: 'Cross ↗', box: { ...box },
          style: { shapeKind: 'line', background: '#9aa0a6', opacity: 0.5, flipDiag: true },
        }),
        text({
          role: 'caption', name: 'Placeholder label', text: p.label,
          box: { x: box.x + Math.round(w * 0.3), y: box.y + Math.round(h / 2) - fs(0.026), w: Math.round(w * 0.4), h: fs(0.052) },
          style: { fontSize: fs(0.024), fontWeight: 700, color: '#5f6368', background: '#ffffff', radius: fs(0.03), align: 'center', uppercase: true, lineHeight: 1 },
        }),
      ];
    },
  },
  {
    id: 'before-after', name: 'Before / After', category: 'Cards',
    hint: 'Two placeholder panels with label pills and a center divider',
    defaultBox: { x: 0.05, y: 0.30, w: 0.90, h: 0.36 },
    params: [T('leftLabel', 'BEFORE', { maxLen: 24 }), T('rightLabel', 'AFTER', { maxLen: 24 })],
    build(doc, p) {
      const { rx, ry, fs } = sized(doc);
      const x = rx(0.05), y = ry(0.30), w = rx(0.90), h = ry(0.36);
      const half = Math.round(w / 2);
      const pillW = rx(0.22), pillH = ry(0.05);
      const pill = (label, px) => text({
        role: 'badge', name: `${label} pill`, text: label, type: 'badge',
        box: { x: px, y: y + ry(0.02), w: pillW, h: pillH },
        style: { fontSize: fs(0.026), fontWeight: 700, color: '#ffffff', background: '#111111cc', radius: fs(0.04), align: 'center', uppercase: true },
      });
      return [
        shape({ role: 'product', name: 'Before panel', box: { x, y, w: half - 2, h }, style: { background: '#9aa0a6', opacity: 0.4, radius: fs(0.012) } }),
        shape({ role: 'product', name: 'After panel', box: { x: x + half + 2, y, w: half - 2, h }, style: { background: '#9aa0a6', opacity: 0.55, radius: fs(0.012) } }),
        shape({ role: 'caption', name: 'Divider', box: { x: x + half - 2, y, w: 4, h }, style: { background: '#ffffff' } }),
        pill(p.leftLabel, x + Math.round(half / 2 - pillW / 2)),
        pill(p.rightLabel, x + half + Math.round(half / 2 - pillW / 2)),
      ];
    },
  },
  {
    id: 'receipt', name: 'Receipt', category: 'Cards',
    hint: 'Store receipt card — item rows, dashed dividers, bold total',
    defaultBox: { x: 0.22, y: 0.20, w: 0.56, h: 0.42 },
    params: [
      T('store', 'NEUEGEN STORE', { maxLen: 40 }),
      SL('items', ['Sea Salt Spray|14.99', 'Matte Clay|16.99', 'Texture Powder|12.99'], { maxItems: 8, maxLen: 60 }),
      T('total', '$44.97', { maxLen: 20 }),
    ],
    build(doc, p) {
      const { rx, ry, fs } = sized(doc);
      const mono = FONT_SUGGEST.mono; // receipts are a tabular mono artifact
      const x = rx(0.22), w = rx(0.56);
      const pad = Math.round(w * 0.08);
      const rowH = ry(0.045);
      let y = ry(0.20);
      const cardH = ry(0.06) + rowH * (p.items.length + 1) + ry(0.06);
      const layers = [shape({
        role: 'card', name: 'Receipt card', box: { x, y, w, h: cardH },
        style: { background: '#fffdf7', radius: fs(0.012), stroke: { color: '#e8e4da', width: 2 } },
      })];
      let cy = y + ry(0.018);
      layers.push(text({
        role: 'headline', name: 'Store', text: p.store,
        box: { x: x + pad, y: cy, w: w - pad * 2, h: rowH },
        style: { fontSize: fs(0.03), fontWeight: 800, color: '#111111', align: 'center', uppercase: true, letterSpacing: 1, fontFamily: mono },
      }));
      cy += rowH + ry(0.012);
      const divider = (dy, name) => shape({
        role: 'caption', name, box: { x: x + pad, y: dy, w: w - pad * 2, h: 2 },
        style: { background: '#111111', opacity: 0.25 },
      });
      layers.push(divider(cy, 'Divider top'));
      cy += ry(0.012);
      for (const item of p.items) {
        const [name, price = ''] = String(item).split('|');
        layers.push(
          text({
            role: 'caption', name: `Item ${name}`.slice(0, 30), text: name.trim(),
            box: { x: x + pad, y: cy, w: Math.round((w - pad * 2) * 0.62), h: rowH },
            style: { fontSize: fs(0.024), fontWeight: 500, color: '#333333', align: 'left', lineHeight: 1.2, fontFamily: mono },
          }),
          text({
            role: 'price', name: 'Item price', text: price.trim(),
            box: { x: x + pad + Math.round((w - pad * 2) * 0.62), y: cy, w: Math.round((w - pad * 2) * 0.38), h: rowH },
            style: { fontSize: fs(0.024), fontWeight: 600, color: '#111111', align: 'right', lineHeight: 1.2, fontFamily: mono },
          }),
        );
        cy += rowH;
      }
      cy += ry(0.008);
      layers.push(divider(cy, 'Divider bottom'));
      cy += ry(0.012);
      layers.push(
        text({
          role: 'caption', name: 'Total label', text: 'TOTAL',
          box: { x: x + pad, y: cy, w: Math.round((w - pad * 2) * 0.5), h: rowH },
          style: { fontSize: fs(0.026), fontWeight: 800, color: '#111111', align: 'left', uppercase: true, fontFamily: mono },
        }),
        text({
          role: 'price', name: 'Total', text: p.total,
          box: { x: x + pad + Math.round((w - pad * 2) * 0.5), y: cy, w: Math.round((w - pad * 2) * 0.5), h: rowH },
          style: { fontSize: fs(0.028), fontWeight: 800, color: '#111111', align: 'right', fontFamily: mono },
        }),
      );
      return layers;
    },
  },

  {
    id: 'comparison-table', name: 'Comparison table', category: 'Cards',
    hint: 'Ours-vs-competitor columns — ✓ rows left, ✗ rows right',
    defaultBox: { x: 0.05, y: 0.28, w: 0.90, h: 0.42 },
    params: [
      T('leftTitle', 'OURS', { maxLen: 24, quiet: true }),
      T('rightTitle', 'THEIRS', { maxLen: 24, quiet: true }),
      SL('leftItems', ['Holds all day', 'Zero residue', 'Restyleable'], { maxItems: 6, maxLen: 60 }),
      SL('rightItems', ['Gone by noon', 'Greasy film', 'One and done'], { maxItems: 6, maxLen: 60 }),
      C('accent', '#2c5cff', { brandColor: true, quiet: true }),
    ],
    build(doc, p) {
      const { rx, ry, fs } = sized(doc);
      const x = rx(0.05), y = ry(0.28), w = rx(0.90);
      const gap = Math.round(w * 0.025);
      const colW = Math.round((w - gap) / 2);
      const headH = ry(0.062);
      // rows are fixed-height slots the text vertically centers in; tall enough that a wrapped
      // two-line item never collides with the next row (the old rowH=0.05 clipped/overlapped).
      const rowFs = fs(0.026);
      const rowH = ry(0.066);
      const rows = Math.max(p.leftItems.length, p.rightItems.length, 1);
      const colH = headH + rows * rowH + ry(0.024);
      const pad = Math.round(colW * 0.075);
      const markW = Math.round(rowFs * 1.4); // dedicated ✓/✗ glyph column so items left-align cleanly
      const col = (cx, title, items, ours) => {
        const mark = ours ? '✓' : '✗';
        const markColor = ours ? p.accent : '#c2410c';
        const layers = [
          shape({
            role: 'card', name: `${title} column`, box: { x: cx, y, w: colW, h: colH },
            style: {
              background: ours ? '#ffffff' : '#f1f3f5', radius: fs(0.016),
              stroke: { color: ours ? p.accent : '#d7dbdf', width: ours ? 3 : 2 },
            },
          }),
          text({
            role: 'headline', name: `${title} title`, text: title,
            box: { x: cx, y: y + ry(0.016), w: colW, h: headH - ry(0.02) },
            style: { fontSize: fs(0.032), fontWeight: 800, color: ours ? p.accent : '#5f6368', align: 'center', uppercase: true, letterSpacing: 1, lineHeight: 1 },
          }),
        ];
        items.forEach((it, i) => {
          const ry0 = y + headH + i * rowH;
          layers.push(
            text({
              role: 'caption', name: `${title} mark ${i + 1}`, text: mark, autoH: false,
              box: { x: cx + pad, y: ry0, w: markW, h: rowH },
              style: { fontSize: rowFs, fontWeight: 800, color: markColor, align: 'left', lineHeight: 1.25 },
            }),
            text({
              role: 'caption', name: `${title} row ${i + 1}`, text: it, autoH: false,
              box: { x: cx + pad + markW + Math.round(rowFs * 0.4), y: ry0, w: colW - pad * 2 - markW - Math.round(rowFs * 0.4), h: rowH },
              style: { fontSize: rowFs, fontWeight: 600, color: ours ? '#111111' : '#8a8f96', align: 'left', lineHeight: 1.25 },
            }),
          );
        });
        return layers;
      };
      return [...col(x, p.leftTitle, p.leftItems, true), ...col(x + colW + gap, p.rightTitle, p.rightItems, false)];
    },
  },
  {
    id: 'sticky-note', name: 'Sticky note', category: 'Cards',
    hint: 'Post-it: handwritten text, -3° tilt, soft shadow',
    defaultBox: { x: 0.30, y: 0.34, w: 0.40, h: 0.32 },
    params: [T('text', 'do NOT skip\nthe sea salt spray', { maxLen: 120 }), C('color', '#ffec8b')],
    build(doc, p) {
      const { rx, ry, fs } = sized(doc);
      const side = rx(0.40);
      const x = rx(0.30), y = ry(0.34);
      const off = Math.max(4, Math.round(side * 0.02));
      const pad = Math.round(side * 0.10);
      return [
        shape({
          role: 'card', name: 'Note shadow', rotation: -3,
          box: { x: x + off, y: y + off, w: side, h: side },
          style: { background: '#000000', opacity: 0.16, radius: fs(0.006) },
        }),
        shape({
          role: 'card', name: 'Note paper', rotation: -3,
          box: { x, y, w: side, h: side },
          style: { background: p.color, radius: fs(0.004) },
        }),
        text({
          role: 'caption', name: 'Note text', text: p.text, rotation: -3,
          box: { x: x + pad, y: y + pad + Math.round(side * 0.14), w: side - pad * 2, h: side - pad * 2 - Math.round(side * 0.14) },
          style: { fontSize: fs(0.04), fontWeight: 700, color: '#3a3324', align: 'center', lineHeight: 1.3, fontFamily: FONT_SUGGEST.hand },
        }),
      ];
    },
  },

  // ── Buttons ────────────────────────────────────────────────────────────────────────────────────
  {
    id: 'badge', name: 'Badge', category: 'Buttons', brandFont: true,
    hint: 'Corner offer chip',
    defaultBox: { x: 0.05, y: 0.05, w: 0.30, h: 0.06 },
    params: [T('text', 'BUY 2 GET 1 FREE'), C('color', '#ffe14d', { brandColor: true }), C('textColor', '#111111')],
    build(doc, p) {
      const { rx, ry, fs } = sized(doc);
      return [{
        id: layerId('badge'), type: 'badge', role: 'badge', name: 'Badge', autoH: true,
        text: p.text,
        box: { x: rx(0.05), y: ry(0.05), w: rx(0.30), h: ry(0.06) },
        // fully-rounded chip; +0.5 tracking on the uppercase label (offer chips read tight
        // otherwise); padding gives the pill real breathing room around the text. No text-shadow —
        // on a filled chip that only muddies the glyphs (Stage maps `shadow`→text-shadow, not a
        // box shadow), so the chip stays crisp and flat.
        style: { fontSize: fs(0.026), fontWeight: 800, color: p.textColor, background: p.color, radius: fs(0.03), align: 'center', uppercase: true, letterSpacing: 0.5, padding: fs(0.014) },
      }];
    },
  },
  {
    id: 'cta', name: 'CTA button', category: 'Buttons', brandFont: true,
    hint: 'Rounded action pill',
    defaultBox: { x: 0.05, y: 0.885, w: 0.35, h: 0.055 },
    params: [T('text', 'SHOP NOW'), C('color', '#2c5cff', { brandColor: true }), C('textColor', '#ffffff')],
    build(doc, p) {
      const { rx, ry, fs } = sized(doc);
      return [fitSingleLine({
        id: layerId('cta'), type: 'button', role: 'cta', name: 'CTA', autoH: true,
        text: p.text,
        box: { x: rx(0.05), y: ry(0.885), w: rx(0.35), h: ry(0.055) },
        // fully-rounded action pill; generous padding so the label never crowds the pill edge;
        // +0.5 tracking on the uppercase text. No `shadow` — Stage maps it to text-shadow, which on
        // a filled button muddies the label rather than lifting the pill; a clean flat pill reads
        // more premium and matches every renderer identically.
        style: { fontSize: fs(0.034), fontWeight: 700, color: p.textColor, background: p.color, radius: fs(0.04), align: 'center', uppercase: true, letterSpacing: 0.5, padding: fs(0.018) },
      })];
    },
  },
  {
    id: 'cta-outline', name: 'CTA outline', category: 'Buttons', brandFont: true,
    hint: 'Outlined text button (UPFRONT-style)',
    defaultBox: { x: 0.30, y: 0.885, w: 0.40, h: 0.055 },
    params: [T('text', 'Bekijk ze hier'), C('color', '#e08a00', { brandColor: true })],
    build(doc, p) {
      const { rx, ry, fs } = sized(doc);
      return [
        shape({
          role: 'cta', name: 'CTA outline bg',
          box: { x: rx(0.30), y: ry(0.885), w: rx(0.40), h: ry(0.055) },
          style: { background: p.color, opacity: 0.14, radius: fs(0.008) },
        }),
        text({
          role: 'cta', name: 'CTA outline text', text: p.text,
          box: { x: rx(0.30), y: ry(0.885), w: rx(0.40), h: ry(0.055) },
          style: { fontSize: fs(0.032), fontWeight: 600, color: p.color, align: 'center', lineHeight: 1 },
        }),
      ];
    },
  },
  {
    id: 'starburst', name: 'Starburst badge', category: 'Buttons', brandFont: true,
    hint: 'Spiky discount badge (61% OFF look)',
    defaultBox: { x: 0.62, y: 0.08, w: 0.30, h: 0.30 },
    params: [T('text', '70%\nOFF', { maxLen: 40 }), C('color', '#d92c2c', { brandColor: true }), N('spikes', 14, 6, 40)],
    build(doc, p) {
      const { rx, ry, fs } = sized(doc);
      return [
        shape({
          role: 'badge', name: 'Starburst',
          box: { x: rx(0.62), y: ry(0.08), w: rx(0.30), h: rx(0.30) },
          style: { background: p.color, shapeKind: 'starburst', spikes: Math.round(p.spikes) },
        }),
        (() => {
          // fit-to-zone: shrink the font until the longest word fits the star's text zone
          const zoneW = rx(0.25);
          const longest = Math.max(1, ...String(p.text).toUpperCase().split(/\s+/).map((w) => w.length));
          const size = Math.min(fs(0.045), Math.floor(zoneW / (longest * 0.58)));
          return text({
            role: 'badge', name: 'Starburst text', text: p.text,
            box: { x: rx(0.645), y: ry(0.08) + rx(0.09), w: zoneW, h: rx(0.12) },
            style: { fontSize: size, fontWeight: 800, color: '#ffffff', align: 'center', uppercase: true, lineHeight: 1.05 },
          });
        })(),
      ];
    },
  },

  {
    id: 'discount-ticket', name: 'Discount ticket', category: 'Buttons', brandFont: true,
    hint: 'Coupon: offer text, perforated edge, mono code pill',
    defaultBox: { x: 0.14, y: 0.36, w: 0.72, h: 0.22 },
    params: [
      T('text', '20% OFF YOUR FIRST ORDER', { maxLen: 80 }),
      T('code', 'NEUE20', { maxLen: 24 }),
      C('color', '#d92c2c', { brandColor: true }),
    ],
    build(doc, p) {
      const { rx, ry, fs } = sized(doc);
      const x = rx(0.14), y = ry(0.36), w = rx(0.72), h = ry(0.22);
      const layers = [shape({
        role: 'card', name: 'Ticket', box: { x, y, w, h },
        style: { background: p.color, radius: fs(0.014) },
      })];
      // perforated divider — dashed edge drawn as a row of small light rects
      const dashW = Math.max(6, Math.round(w * 0.028));
      const dashH = Math.max(3, Math.round(dashW * 0.28));
      const nDash = Math.floor((w * 0.86) / (dashW * 1.8));
      const dashY = y + Math.round(h * 0.56);
      const dashX0 = x + Math.round(w * 0.07);
      for (let i = 0; i < nDash; i++) {
        layers.push(shape({
          role: 'caption', name: `Perforation ${i + 1}`,
          box: { x: dashX0 + Math.round(i * dashW * 1.8), y: dashY, w: dashW, h: dashH },
          style: { background: '#ffffff', opacity: 0.65, radius: dashH },
        }));
      }
      const codeW = Math.round(w * 0.4);
      layers.push(
        text({
          role: 'headline', name: 'Offer text', text: p.text,
          box: { x: x + Math.round(w * 0.07), y: y + Math.round(h * 0.14), w: Math.round(w * 0.86), h: Math.round(h * 0.34) },
          style: { fontSize: fs(0.036), fontWeight: 800, color: '#ffffff', align: 'center', uppercase: true, lineHeight: 1.15 },
        }),
        text({
          role: 'badge', name: 'Code pill', text: `CODE: ${p.code}`,
          box: { x: x + Math.round((w - codeW) / 2), y: dashY + Math.round(h * 0.10), w: codeW, h: Math.round(h * 0.22) },
          style: { fontSize: fs(0.026), fontWeight: 700, color: p.color, background: '#ffffff', radius: fs(0.008), align: 'center', lineHeight: 1, padding: fs(0.01), fontFamily: FONT_SUGGEST.mono },
        }),
      );
      return layers;
    },
  },

  // ── Overlays ───────────────────────────────────────────────────────────────────────────────────
  {
    id: 'callout', name: 'Callout arrow', category: 'Overlays',
    hint: 'Annotation arrow + label pointing at the product',
    defaultBox: { x: 0.08, y: 0.32, w: 0.28, h: 0.13 },
    params: [T('label', 'Pure Honey', { maxLen: 60 }), C('color', '#111111')],
    build(doc, p) {
      const { rx, ry, fs } = sized(doc);
      return [
        text({
          role: 'caption', name: 'Callout label', text: p.label,
          box: { x: rx(0.08), y: ry(0.32), w: rx(0.28), h: ry(0.045) },
          style: { fontSize: fs(0.032), fontWeight: 600, color: p.color, align: 'left' },
        }),
        shape({
          role: 'caption', name: 'Callout arrow',
          box: { x: rx(0.14), y: ry(0.37), w: rx(0.16), h: ry(0.08) },
          style: { background: p.color, shapeKind: 'arrow' },
        }),
      ];
    },
  },
  {
    id: 'scrim-bottom', name: 'Bottom scrim', category: 'Overlays',
    hint: 'Gradient fade for legibility',
    defaultBox: { x: 0, y: 0.62, w: 1, h: 0.38 },
    params: [C('color', '#000000')],
    build(doc, p) {
      const { w, ry } = sized(doc);
      return [shape({
        role: 'scrim', name: 'Bottom scrim',
        box: { x: 0, y: ry(0.62), w, h: ry(0.38) },
        style: { background: p.color, gradient: 'to-top', opacity: 0.75 },
      })];
    },
  },
  {
    id: 'vignette', name: 'Vignette', category: 'Overlays',
    hint: 'Edge darkening with strength/size controls',
    defaultBox: { x: 0, y: 0, w: 1, h: 1 },
    params: [N('strength', 0.7, 0, 1), N('size', 0.45, 0, 0.95)],
    build(doc, p) {
      const { w, h } = sized(doc);
      return [{
        id: layerId('vignette'), type: 'vignette', role: 'vignette', name: 'Vignette',
        box: { x: 0, y: 0, w, h },
        style: { background: '#000000', vignette: { strength: p.strength, size: p.size } },
      }];
    },
  },
  {
    id: 'marquee', name: 'Marquee strip', category: 'Overlays', brandFont: true,
    hint: 'Full-width repeating offer banner',
    defaultBox: { x: 0, y: 0.955, w: 1, h: 0.045 },
    params: [
      T('text', 'BUY 2 GET 1 FREE + FREE SHIPPING $100+  ✪  BUY 2 GET 1 FREE + FREE SHIPPING $100+  ✪  BUY 2 GET 1 FREE'),
      C('color', '#d4af37', { brandColor: true }),
      C('textColor', '#111111'),
    ],
    build(doc, p) {
      const { w, ry, fs } = sized(doc);
      return [text({
        role: 'caption', name: 'Marquee strip', text: p.text, autoH: false, // single strip — horizontal overflow is the design
        box: { x: 0, y: ry(0.955), w, h: ry(0.045) },
        style: { fontSize: fs(0.028), fontWeight: 700, color: p.textColor, background: p.color, align: 'left', uppercase: true, lineHeight: 1, padding: fs(0.01) },
      })];
    },
  },

  {
    id: 'phone-status-bar', name: 'Phone status bar', category: 'Overlays',
    hint: 'iOS-style top bar — time left, signal + battery right',
    defaultBox: { x: 0, y: 0, w: 1, h: 0.045 },
    params: [T('time', '9:41', { maxLen: 12 }), B('dark', true, { label: 'White glyphs (dark photo)' })],
    build(doc, p) {
      const { w, rx, ry, fs } = sized(doc);
      const c = p.dark ? '#ffffff' : '#111111';
      const barH = ry(0.045);
      const glyphH = Math.round(barH * 0.34);
      const gy = Math.round((barH - glyphH) / 2);
      const battW = rx(0.055), battH = glyphH;
      const battX = w - rx(0.05) - battW;
      const layers = [
        text({
          role: 'caption', name: 'Time', text: p.time,
          box: { x: rx(0.05), y: Math.round(barH * 0.18), w: rx(0.2), h: Math.round(barH * 0.64) },
          style: { fontSize: fs(0.03), fontWeight: 700, color: c, align: 'left', lineHeight: 1 },
        }),
        // signal bars (4 ascending rects)
        ...[0, 1, 2, 3].map((i) => shape({
          role: 'caption', name: `Signal ${i + 1}`,
          box: {
            x: battX - rx(0.075) + i * Math.round(rx(0.012) * 1.3),
            y: gy + Math.round(glyphH * (0.6 - i * 0.2)),
            w: Math.round(rx(0.012) * 0.75),
            h: Math.round(glyphH * (0.4 + i * 0.2)),
          },
          style: { background: c, radius: 2 },
        })),
        // battery: shell + fill
        shape({
          role: 'caption', name: 'Battery shell', box: { x: battX, y: gy, w: battW, h: battH },
          style: { background: 'transparent', radius: Math.round(battH * 0.3), stroke: { color: c, width: 2 }, opacity: 0.5 },
        }),
        shape({
          role: 'caption', name: 'Battery fill',
          box: { x: battX + 3, y: gy + 3, w: Math.round((battW - 6) * 0.82), h: battH - 6 },
          style: { background: c, radius: Math.round(battH * 0.18) },
        }),
      ];
      return layers;
    },
  },

  // ── Social ─────────────────────────────────────────────────────────────────────────────────────
  {
    id: 'x-post', name: 'X post', category: 'Social',
    hint: 'Tweet-style card: avatar, name/handle, body, muted metrics',
    defaultBox: { x: 0.05, y: 0.28, w: 0.90, h: 0.34 },
    params: [
      T('name', 'Sam Carter', { maxLen: 40 }),
      T('handle', '@samcarter', { maxLen: 30 }),
      T('text', 'okay I was skeptical but this stuff actually works. hair still holds at 11pm. not sponsored, just impressed.'),
      B('pixelated', false, { label: 'Anonymize author' }),
      T('timestamp', '10:44 · 04/10/2026', { maxLen: 40, quiet: true }),
      T('replies', '186', { maxLen: 12, quiet: true }),
      T('reposts', '412', { maxLen: 12, quiet: true }),
      T('likes', '2,318', { maxLen: 12, quiet: true }),
      T('views', '48.2K', { maxLen: 14, quiet: true }),
      B('verified', true, { quiet: true }),
      E('avatar', 'initial', ['blur', 'initial'], { quiet: true }),
      B('dark', true),
    ],
    build(doc, p) {
      const { rx, ry, fs } = sized(doc);
      const bg = p.dark ? '#000000' : '#ffffff';
      const fg = p.dark ? '#e7e9ea' : '#0f1419';
      const muted = p.dark ? '#71767b' : '#536471';
      const chirp = FONT_SUGGEST.twitter; // graceful fallback to the clean sans stack
      const x = rx(0.05), y = ry(0.28), w = rx(0.90);
      const pad = Math.round(w * 0.05);
      const av = rx(0.085);
      const h = ry(0.30);
      const layers = [shape({
        role: 'card', name: 'Post card', box: { x, y, w, h },
        style: { background: bg, radius: fs(0.018), stroke: { color: p.dark ? '#2f3336' : '#e1e8ed', width: 2 } },
      })];
      // avatar
      if (p.pixelated) {
        // DISTINCT pixelate look: a blocky mosaic grid clipped to a circle (renderer-independent,
        // NOT a gaussian blur) — the censored/anonymized poster avatar.
        const n = 5, cw = av / n, ch = av / n, cxm = av / 2, cym = av / 2, r = av / 2;
        for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
          const cpx = (i + 0.5) * cw, cpy = (j + 0.5) * ch;
          if (((cpx - cxm) ** 2 + (cpy - cym) ** 2) > (r + Math.min(cw, ch) * 0.25) ** 2) continue;
          const gg = Math.round(96 + (Math.sin((i + 1) * 12.9898 + (j + 1) * 78.233) * 43758.5453 % 1 + 1) % 1 * 96);
          const hx = `#${gg.toString(16).padStart(2, '0').repeat(2)}${Math.min(255, gg + 10).toString(16).padStart(2, '0')}`;
          layers.push(shape({ role: 'caption', name: `Avatar mosaic ${j * n + i}`,
            box: { x: Math.round(x + pad + i * cw), y: Math.round(y + pad + j * ch), w: Math.ceil(cw) + 1, h: Math.ceil(ch) + 1 },
            style: { background: hx } }));
        }
      } else if (p.avatar === 'blur') {
        // style.blur is a placeholder field renderers elsewhere pick up (privacy-blurred avatar).
        layers.push(shape({
          role: 'caption', name: 'Avatar', box: { x: x + pad, y: y + pad, w: av, h: av },
          style: { background: '#9aa0a6', shapeKind: 'ellipse', blur: 8 },
        }));
      } else {
        layers.push(
          shape({
            role: 'caption', name: 'Avatar', box: { x: x + pad, y: y + pad, w: av, h: av },
            style: { background: '#2c5cff', shapeKind: 'ellipse' },
          }),
          text({
            role: 'caption', name: 'Avatar initial', text: (p.name.trim()[0] || 'A').toUpperCase(),
            box: { x: x + pad, y: y + pad, w: av, h: av },
            style: { fontSize: Math.round(av * 0.5), fontWeight: 700, color: '#ffffff', align: 'center', lineHeight: 1, fontFamily: chirp },
          }),
        );
      }
      const tx = x + pad + av + Math.round(pad * 0.6);
      if (p.pixelated) {
        // anonymized-author look: name + handle become small gray rounded rects
        const rectBg = p.dark ? '#3a3f44' : '#c9ced3';
        layers.push(
          shape({
            role: 'caption', name: 'Name (anon)',
            box: { x: tx, y: y + pad + Math.round(av * 0.05), w: Math.round(w * 0.30), h: Math.round(av * 0.34) },
            style: { background: rectBg, radius: fs(0.008) },
          }),
          shape({
            role: 'caption', name: 'Handle (anon)',
            box: { x: tx, y: y + pad + Math.round(av * 0.55), w: Math.round(w * 0.20), h: Math.round(av * 0.30) },
            style: { background: rectBg, opacity: 0.7, radius: fs(0.008) },
          }),
        );
      } else {
        layers.push(
          text({
            role: 'caption', name: 'Name', text: p.verified ? `${p.name} ✓` : p.name,
            box: { x: tx, y: y + pad, w: w - (tx - x) - pad, h: Math.round(av * 0.5) },
            style: { fontSize: fs(0.028), fontWeight: 800, color: fg, align: 'left', lineHeight: 1.1, fontFamily: chirp },
          }),
          text({
            role: 'caption', name: 'Handle', text: p.handle,
            box: { x: tx, y: y + pad + Math.round(av * 0.52), w: w - (tx - x) - pad, h: Math.round(av * 0.45) },
            style: { fontSize: fs(0.024), fontWeight: 500, color: muted, align: 'left', lineHeight: 1.1, fontFamily: chirp },
          }),
        );
      }
      layers.push(
        text({
          role: 'headline', name: 'Post body', text: p.text,
          box: { x: x + pad, y: y + pad + av + Math.round(pad * 0.6), w: w - pad * 2, h: ry(0.12) },
          style: { fontSize: fs(0.03), fontWeight: 500, color: fg, align: 'left', lineHeight: 1.35, fontFamily: chirp },
        }),
        text({
          role: 'caption', name: 'Post timestamp', text: `${p.timestamp} · ${p.views} Views`,
          box: { x: x + pad, y: y + h - pad - ry(0.055), w: w - pad * 2, h: ry(0.028) },
          style: { fontSize: fs(0.022), fontWeight: 500, color: muted, align: 'left', lineHeight: 1.2, fontFamily: chirp },
        }),
        text({
          role: 'caption', name: 'Post metrics',
          text: `${p.replies} Replies · ${p.reposts} Reposts · ${p.likes} Likes · ${p.views} Views`,
          box: { x: x + pad, y: y + h - pad - ry(0.025), w: w - pad * 2, h: ry(0.028) },
          style: { fontSize: fs(0.022), fontWeight: 600, color: muted, align: 'left', lineHeight: 1.2, fontFamily: chirp },
        }),
      );
      return layers;
    },
  },
  {
    id: 'ig-story-qa', name: 'IG story Q&A', category: 'Social',
    hint: 'Ask-me-anything sticker: question card + answer card',
    defaultBox: { x: 0.10, y: 0.30, w: 0.80, h: 0.34 },
    params: [
      T('question', 'what do you use for volume??', { maxLen: 140 }),
      T('answer', 'texture powder at the roots — tiny pinch, huge difference', { maxLen: 240 }),
      B('dark', false),
    ],
    build(doc, p) {
      const { rx, ry, fs } = sized(doc);
      const x = rx(0.10), w = rx(0.80);
      const qBg = p.dark ? '#262626' : '#ffffff';
      const qFg = p.dark ? '#ffffff' : '#111111';
      const aBg = p.dark ? '#3a3a3a' : '#efefef';
      const aFg = p.dark ? '#e7e7e7' : '#262626';
      const qY = ry(0.30), qH = ry(0.145);
      const aY = qY + qH + ry(0.012), aH = ry(0.17);
      const pad = Math.round(w * 0.07);
      return [
        shape({
          role: 'card', name: 'Question card', box: { x, y: qY, w, h: qH },
          style: { background: qBg, radius: fs(0.022) },
        }),
        text({
          role: 'caption', name: 'Q&A label', text: 'Ask me anything',
          box: { x: x + pad, y: qY + ry(0.016), w: w - pad * 2, h: ry(0.028) },
          style: { fontSize: fs(0.02), fontWeight: 600, color: p.dark ? '#9aa0a6' : '#8e8e8e', align: 'center', lineHeight: 1, uppercase: true, letterSpacing: 1 },
        }),
        text({
          role: 'headline', name: 'Question', text: p.question,
          box: { x: x + pad, y: qY + ry(0.052), w: w - pad * 2, h: qH - ry(0.068) },
          style: { fontSize: fs(0.034), fontWeight: 700, color: qFg, align: 'center', lineHeight: 1.25 },
        }),
        shape({
          role: 'card', name: 'Answer card', box: { x, y: aY, w, h: aH },
          style: { background: aBg, radius: fs(0.022) },
        }),
        text({
          role: 'caption', name: 'Answer', text: p.answer,
          box: { x: x + pad, y: aY + ry(0.024), w: w - pad * 2, h: aH - ry(0.048) },
          style: { fontSize: fs(0.03), fontWeight: 500, color: aFg, align: 'center', lineHeight: 1.35 },
        }),
      ];
    },
  },
  {
    id: 'notes-card', name: 'Notes card', category: 'Social',
    hint: 'Apple-Notes-style checklist card',
    defaultBox: { x: 0.10, y: 0.24, w: 0.80, h: 0.34 },
    params: [
      T('title', 'my hair routine that finally works', { maxLen: 80 }),
      SL('items', ['damp towel dry', 'pea-size clay, rub it HOT', 'blow dry up + back', 'sea salt spray to finish'], { maxItems: 10 }),
      B('checked', true),
    ],
    build(doc, p) {
      const { rx, ry, fs } = sized(doc);
      const notesFont = FONT_SUGGEST.notes; // Apple Notes look
      const x = rx(0.10), y = ry(0.24), w = rx(0.80);
      const pad = Math.round(w * 0.06);
      const h = ry(0.10) + p.items.length * ry(0.042) + pad;
      const prefix = p.checked ? '✓ ' : '○ ';
      return [
        shape({
          role: 'card', name: 'Notes card', box: { x, y, w, h },
          style: { background: '#fffdf5', radius: fs(0.02), stroke: { color: '#efe9d8', width: 2 } },
        }),
        text({
          role: 'headline', name: 'Notes title', text: p.title,
          box: { x: x + pad, y: y + pad, w: w - pad * 2, h: ry(0.05) },
          style: { fontSize: fs(0.034), fontWeight: 800, color: '#1c1c1e', align: 'left', lineHeight: 1.2, fontFamily: notesFont },
        }),
        text({
          role: 'caption', name: 'Notes items', text: p.items.map((it) => prefix + it).join('\n'),
          box: { x: x + pad, y: y + pad + ry(0.06), w: w - pad * 2, h: p.items.length * ry(0.042) },
          style: { fontSize: fs(0.028), fontWeight: 500, color: '#3a3a3c', align: 'left', lineHeight: 1.5, fontFamily: notesFont },
        }),
      ];
    },
  },
  {
    id: 'review-row', name: 'Review row', category: 'Social',
    hint: 'Gold stars + quote + author',
    defaultBox: { x: 0.10, y: 0.68, w: 0.80, h: 0.14 },
    params: [
      N('stars', 5, 1, 5),
      C('color', '#ffffff', { quiet: true, label: 'Text color' }),
      T('quote', '“Best purchase I made this year. My hair has never looked better.”'),
      T('author', '— Daniel R.', { maxLen: 60 }),
    ],
    build(doc, p) {
      const { rx, ry, fs } = sized(doc);
      const x = rx(0.10), y = ry(0.68), w = rx(0.80);
      const n = Math.round(p.stars);
      const quoteBox = { x, y: y + ry(0.05), w, h: ry(0.085) };
      const quoteStyle = { fontSize: fs(0.03), fontWeight: 400, color: p.color, align: 'left', lineHeight: 1.35, shadow: true };
      // Author Y used to be a hardcoded "y + ry(0.125)" offset that assumed the quote fits in a
      // fixed ~2-line box — a longer quote (or a squarer 1:1 canvas, which narrows the quote's
      // wrap width) wraps to more lines and the fixed offset clips the author line behind it.
      // Derive the author's Y from the quote's actual estimated wrapped height instead.
      const quoteH = estimateTextBoxH({ type: 'text', text: p.quote, box: quoteBox, style: quoteStyle });
      const authorY = quoteBox.y + Math.max(quoteH, quoteBox.h) + Math.round(ry(0.02));
      return [
        text({
          role: 'caption', name: 'Stars', text: '★★★★★☆☆☆☆☆'.slice(5 - n, 10 - n), // n filled + (5−n) outline
          box: { x, y, w, h: ry(0.04) },
          // #ffb400 = the warm amber the amber-gold-star review widgets (Yotpo/Google/Amazon) use —
          // reads gold, not the muddy mustard #f5b301 gave at ad scale; letterSpacing opens an even
          // star track. (Trustpilot is NOT amber — its green #00b67a is used by the trust-badge below.)
          style: { fontSize: fs(0.036), fontWeight: 700, color: '#ffb400', align: 'left', lineHeight: 1, letterSpacing: 2, shadow: true },
        }),
        text({
          role: 'caption', name: 'Quote', text: p.quote,
          box: quoteBox, style: quoteStyle,
        }),
        text({
          role: 'caption', name: 'Author', text: p.author,
          box: { x, y: authorY, w, h: ry(0.035) },
          style: { fontSize: fs(0.026), fontWeight: 700, color: p.color, align: 'left', lineHeight: 1.2, shadow: true },
        }),
      ];
    },
  },
  {
    id: 'trust-badge', name: 'Trust badge', category: 'Social',
    hint: 'Green stars + review-count pill',
    defaultBox: { x: 0.28, y: 0.80, w: 0.44, h: 0.05 },
    params: [N('rating', 5, 1, 5), T('count', '55,000+', { maxLen: 20 })],
    build(doc, p) {
      const { rx, ry, fs } = sized(doc);
      const x = rx(0.28), y = ry(0.80), w = rx(0.44), h = ry(0.05);
      return [
        shape({
          role: 'badge', name: 'Trust pill', box: { x, y, w, h },
          style: { background: '#ffffff', radius: fs(0.05), opacity: 0.95 },
        }),
        text({
          role: 'badge', name: 'Trust stars', text: '★★★★★☆☆☆☆☆'.slice(5 - Math.round(p.rating), 10 - Math.round(p.rating)),
          box: { x: x + Math.round(w * 0.06), y, w: Math.round(w * 0.32), h },
          style: { fontSize: fs(0.026), fontWeight: 700, color: '#00b67a', align: 'left', lineHeight: 1, letterSpacing: 1 }, // Trustpilot green
        }),
        text({
          role: 'badge', name: 'Trust count', text: `${p.count} reviews`,
          box: { x: x + Math.round(w * 0.38), y, w: Math.round(w * 0.58), h },
          style: { fontSize: fs(0.024), fontWeight: 700, color: '#111111', align: 'left', lineHeight: 1 },
        }),
      ];
    },
  },

  // ── Charts ─────────────────────────────────────────────────────────────────────────────────────
  {
    id: 'chart-bar', name: 'Bar chart', category: 'Charts',
    hint: 'Simple bar chart — values above, labels beneath',
    defaultBox: { x: 0.12, y: 0.50, w: 0.76, h: 0.32 },
    params: [
      SL('labels', ['Q1', 'Q2', 'Q3', 'Q4'], { maxItems: 8, maxLen: 16 }),
      SL('values', ['40', '65', '52', '90'], { maxItems: 8, maxLen: 12 }),
      C('color', '#2c5cff', { brandColor: true }),
    ],
    build(doc, p) {
      const { rx, ry, fs } = sized(doc);
      const x = rx(0.12), w = rx(0.76);
      const plotY = ry(0.55), plotH = ry(0.22);
      const nums = p.values.map((v) => Math.max(0, Number(v) || 0));
      const n = Math.max(1, nums.length);
      const max = Math.max(...nums, 1);
      const slot = w / n;
      const barW = Math.round(slot * 0.6);
      const layers = [];
      nums.forEach((v, i) => {
        const bh = Math.max(4, Math.round((v / max) * plotH));
        const bx = Math.round(x + i * slot + (slot - barW) / 2);
        layers.push(
          shape({
            role: 'chart', name: `Bar ${i + 1}`,
            box: { x: bx, y: plotY + plotH - bh, w: barW, h: bh },
            style: { background: p.color, radius: fs(0.006) },
          }),
          text({
            role: 'caption', name: `Bar value ${i + 1}`, text: String(p.values[i] ?? ''),
            box: { x: bx - Math.round(slot * 0.2), y: plotY + plotH - bh - ry(0.032), w: barW + Math.round(slot * 0.4), h: ry(0.026) },
            style: { fontSize: fs(0.022), fontWeight: 700, color: '#ffffff', align: 'center', lineHeight: 1, shadow: true },
          }),
          text({
            role: 'caption', name: `Bar label ${i + 1}`, text: String(p.labels[i] ?? ''),
            box: { x: bx - Math.round(slot * 0.2), y: plotY + plotH + ry(0.01), w: barW + Math.round(slot * 0.4), h: ry(0.026) },
            style: { fontSize: fs(0.022), fontWeight: 500, color: '#ffffff', align: 'center', lineHeight: 1, opacity: 0.8, shadow: true },
          }),
        );
      });
      return layers;
    },
  },
  {
    id: 'chart-line', name: 'Line chart', category: 'Charts',
    hint: 'Up to two series — polyline, dot markers, legend',
    defaultBox: { x: 0.12, y: 0.35, w: 0.76, h: 0.36 },
    params: [
      SL('labels', ['Wk 1', 'Wk 2', 'Wk 3', 'Wk 4'], { maxItems: 8, maxLen: 16 }),
      {
        key: 'series', type: 'series', maxItems: 2,
        default: [
          { label: 'With it', color: '#2c5cff', points: [0.15, 0.35, 0.55, 0.9] },
          { label: 'Without', color: '#9aa0a6', points: [0.2, 0.25, 0.28, 0.3] },
        ],
      },
    ],
    build(doc, p) {
      const { rx, ry, fs } = sized(doc);
      const x = rx(0.12), y = ry(0.35), w = rx(0.76), h = ry(0.26);
      const axisW = Math.max(2, Math.round(w * 0.004));
      const layers = [
        // gridlines: 1px rects at 25/50/75% of the plot height
        ...[0.25, 0.5, 0.75].map((f, i) => shape({
          role: 'chart', name: `Gridline ${i + 1}`,
          box: { x, y: Math.round(y + h * f), w, h: 1 },
          style: { background: '#ffffff', opacity: 0.25 },
        })),
        // axes: 'line' shapes over near-degenerate boxes (diagonal ≈ the axis)
        shape({ role: 'chart', name: 'Y axis', box: { x, y, w: 1, h }, style: { shapeKind: 'line', background: '#ffffff', opacity: 0.7 } }),
        shape({ role: 'chart', name: 'X axis', box: { x, y: y + h, w, h: 1 }, style: { shapeKind: 'line', background: '#ffffff', opacity: 0.7 } }),
      ];
      const dotR = Math.max(4, Math.round(w * 0.012));
      p.series.forEach((s, si) => {
        const n = s.points.length;
        const pts = [];
        s.points.forEach((v, i) => {
          pts.push(n === 1 ? 0.5 : i / (n - 1), 1 - v);
        });
        layers.push(shape({
          role: 'chart', name: `Series ${s.label || si + 1}`,
          box: { x, y, w, h },
          style: { shapeKind: 'polyline', points: pts, background: s.color, stroke: { color: s.color, width: Math.max(3, axisW * 2) } },
        }));
        s.points.forEach((v, i) => {
          const px = Math.round(x + (n === 1 ? 0.5 : i / (n - 1)) * w);
          const py = Math.round(y + (1 - v) * h);
          layers.push(shape({
            role: 'chart', name: `Dot ${si + 1}.${i + 1}`,
            box: { x: px - dotR, y: py - dotR, w: dotR * 2, h: dotR * 2 },
            style: { shapeKind: 'ellipse', background: s.color },
          }));
        });
      });
      // x labels
      const nl = Math.max(1, p.labels.length);
      p.labels.forEach((lb, i) => {
        const cx = Math.round(x + (nl === 1 ? 0.5 : i / (nl - 1)) * w);
        layers.push(text({
          role: 'caption', name: `X label ${i + 1}`, text: lb,
          box: { x: cx - rx(0.06), y: y + h + ry(0.012), w: rx(0.12), h: ry(0.024) },
          style: { fontSize: fs(0.02), fontWeight: 500, color: '#ffffff', align: 'center', lineHeight: 1, opacity: 0.8, shadow: true },
        }));
      });
      // legend chips
      p.series.forEach((s, si) => {
        const lx = x + si * Math.round(w * 0.34);
        const ly = y + h + ry(0.05);
        layers.push(
          shape({
            role: 'caption', name: `Legend chip ${si + 1}`,
            box: { x: lx, y: ly, w: fs(0.022), h: fs(0.022) },
            style: { background: s.color, radius: fs(0.006) },
          }),
          text({
            role: 'caption', name: `Legend label ${si + 1}`, text: s.label || `Series ${si + 1}`,
            box: { x: lx + fs(0.032), y: ly - Math.round(fs(0.003)), w: Math.round(w * 0.3), h: fs(0.028) },
            style: { fontSize: fs(0.022), fontWeight: 600, color: '#ffffff', align: 'left', lineHeight: 1.2, shadow: true },
          }),
        );
      });
      return layers;
    },
  },
];

// ── building ─────────────────────────────────────────────────────────────────────────────────────

function localGroupBounds(children) {
  const b = groupBounds(children);
  return b || { x: 0, y: 0, w: 0, h: 0 };
}

// ── v2 measurement-first fit pass ────────────────────────────────────────────────────────────────
// Principle: a text box is the OUTPUT of measurement, never an input. Builders still express
// design intent (anchors, stacks, max widths), but every text layer's final box hugs its
// measured content — the handwritten note is as wide as its words, a caption pill as wide as
// its longest line. Same glyph model as type-scale.mjs so server & browser agree.

const glyphW = (fontWeight) => (fontWeight >= 800 ? 0.58 : fontWeight >= 700 ? 0.55 : 0.52);

// Wide-advance glyphs the average Latin factor above under-measures. Star/box symbols (★☆✓✗○●
// ✪ and CJK/emoji) render ~1 em wide; treating them as ~0.55 em made fitElementText shrink star
// tracks and clip the last star. Per-char advance = base factor, bumped for these.
const WIDE_GLYPHS = /[★☆✪✓✗✔✘○●◆■□→←↑↓·—✦]/;
const glyphAdvance = (ch, base) => (WIDE_GLYPHS.test(ch) ? Math.max(base, 0.95) : ch === ' ' ? base * 0.5 : base);

/** Longest-line width estimate (px) for a text layer, incl. pill/padding chrome. Sums per-glyph
 *  advances so wide symbol runs (star ratings) reserve their true width and never clip. */
export function intrinsicTextW(l) {
  const s = l.style || {};
  const fs = s.fontSize || 40;
  const base = glyphW(s.fontWeight || 600);
  const text = s.uppercase ? String(l.text || '').toUpperCase() : String(l.text || '');
  let widest = 0;
  for (const line of text.split('\n')) {
    const chars = [...line]; // spread → code-point safe (astral glyphs are one advance, not two)
    let w = 0;
    for (const ch of chars) w += glyphAdvance(ch, base);
    const ls = (s.letterSpacing || 0) * Math.max(0, chars.length - 1);
    widest = Math.max(widest, w * fs + ls);
  }
  const pad = s.pill && s.background ? fs * 0.55 : (s.padding || 0);
  return Math.ceil(Math.max(widest, fs * base) + pad * 2);
}

/**
 * Fit every measurable text leaf of a freshly-built (or re-built) element:
 *   • width  → min(built width, intrinsic longest-line width), re-anchored by style.align
 *   • height → estimateTextBoxH (wrap-aware, pill-aware)
 * Skips autoH:false artifacts (marquee strip, echo rows, stat rows) — their clipping is the
 * design. Mutates in place; returns the layers.
 */
export function fitElementText(layers) {
  walkNodes(layers, (l) => {
    if (!l || l.type === 'group' || !l.box) return;
    if (!(l.type === 'text' || l.type === 'badge' || l.type === 'button')) return;
    if (l.autoH === false || !l.text) return;
    const s = l.style || {};
    const iw = Math.max(24, intrinsicTextW(l));
    if (iw < l.box.w) {
      const align = s.align || 'left';
      if (align === 'center') l.box.x = Math.round(l.box.x + (l.box.w - iw) / 2);
      else if (align === 'right') l.box.x = l.box.x + l.box.w - iw;
      l.box.w = iw;
    }
    const need = estimateTextBoxH(l);
    if (need !== l.box.h) l.box.h = need;
  });
  return layers;
}

/** Stamp `paramRef` on text leaves whose content came from a text/stringList param, so text
 *  edits can route back through setParams → clean rebuild (single edit path, v2). */
function stampParamRefs(layers, def, params) {
  const textParams = (def.params || []).filter((p) => p.type === 'text' || p.type === 'stringList');
  walkNodes(layers, (l) => {
    if (!l || l.type === 'group' || l.text == null) return;
    for (const p of textParams) {
      const v = params[p.key];
      if (typeof v === 'string' && v && v === l.text) { l.paramRef = { key: p.key }; return; }
      if (Array.isArray(v) && v.length) {
        if (v.join('\n') === l.text) { l.paramRef = { key: p.key, join: true }; return; }
        const idx = v.indexOf(l.text);
        if (idx !== -1) { l.paramRef = { key: p.key, index: idx }; return; }
      }
    }
  });
}

/** Walk up from a node id to its enclosing element instance (the node itself when it carries
 *  the stamp). Returns { instance, parentList } or null. */
export function findElementInstance(doc, id) {
  const target = findNode(doc, id);
  if (!target) return null;
  if (target.element) return { instance: target };
  let hit = null;
  const scan = (nodes) => {
    for (const n of nodes || []) {
      if (n.type === 'group') {
        if (n.element) {
          let inside = false;
          walkNodes(n.children || [], (c) => { if (c.id === id) inside = true; });
          if (inside) { hit = n; return; }
        }
        scan(n.children);
        if (hit) return;
      }
    }
  };
  scan(doc.layers);
  return hit ? { instance: hit } : null;
}

/**
 * v2 single-edit-path: route a text edit on an element child back through its param and
 * REBUILD the instance in place (no stale styles, full re-measure; position preserved, size
 * derived from content). Returns a summary string, or null when the layer isn't an element
 * child with a paramRef (caller falls back to a plain text set).
 * Shared by the design agent (setText) and the Editor commit path.
 */
export function applyElementTextEdit(doc, layerId, text, kit = undefined) {
  const leaf = findNode(doc, layerId);
  if (!leaf || !leaf.paramRef) return null;
  const found = findElementInstance(doc, layerId);
  if (!found || !found.instance.element) return null;
  const inst = found.instance;
  const { key, index, join } = leaf.paramRef;
  const params = { ...inst.element.params };
  if (join) params[key] = String(text).split('\n');
  else if (index != null) {
    const list = Array.isArray(params[key]) ? params[key].slice() : [];
    list[index] = String(text);
    params[key] = list;
  } else params[key] = String(text);
  const fresh = buildElement(inst.element.id, doc, params, kit)[0];
  if (!fresh) return null;
  // keep position + identity; size comes from the re-measured content
  const dx = inst.box.x - fresh.box.x;
  const dy = inst.box.y - fresh.box.y;
  const shift = (n) => { walkNodes([n], (x) => { if (x.box) { x.box.x += dx; x.box.y += dy; } }); };
  shift(fresh);
  fresh.id = inst.id;
  fresh.name = inst.name;
  if (inst.locked) fresh.locked = inst.locked;
  // swap in place
  const swap = (nodes) => {
    const at = (nodes || []).indexOf(inst);
    if (at !== -1) { nodes.splice(at, 1, fresh); return true; }
    for (const n of nodes || []) if (n.type === 'group' && swap(n.children)) return true;
    return false;
  };
  if (!swap(doc.layers)) return null;
  return `text ${inst.element.id}.${key}${index != null ? `[${index}]` : ''} → “${String(text).slice(0, 40)}” (rebuilt)`;
}

/** Build one element for the doc's canvas: coerce params → def.build → wrap multi-layer results
 *  in a group → stamp `.element` provenance on the instance. Pure — the caller inserts (and may
 *  reposition afterwards; builders already place at defaultBox canvas fractions). */
export function buildElement(id, doc, rawParams = undefined, kit = undefined) {
  // legacy alias ids → canonical def + preset params (caller params win over the preset)
  const alias = ELEMENT_ALIASES[id];
  if (alias) {
    const merged = { ...alias.params };
    for (const [k, v] of Object.entries(rawParams || {})) if (v !== undefined) merged[k] = v;
    return buildElement(alias.id, doc, merged, kit);
  }
  const def = ELEMENTS.find((e) => e.id === id);
  if (!def) return [];
  const params = coerceParams(def, rawParams || {}, kit);
  const layers = def.build(doc, params) || [];
  // Brand-kit font applies ONLY to brandable defs (headline/subline/cta/badge…, flagged
  // brandFont) — artifact elements (receipt/x-post/notes…) keep their sensible fonts.
  const kitFont = def.brandFont && kit && Array.isArray(kit.fonts) && kit.fonts[0];
  for (const l of layers) {
    if (l.type === 'text' || l.type === 'badge' || l.type === 'button') {
      // Element text is pre-measured by its builder — sizeLocked exempts it from the
      // role-based font snap / width cap in type-scale.mjs and from smartAdRepair chrome.
      l.sizeLocked = true;
      if (l.style && !l.style.fontFamily) {
        // Kit font wins; otherwise a brandable def falls to the default display/body PAIRING
        // (roleFontFamily) instead of the flat clean-sans default — this is what gives
        // natively-generated ads a real headline-vs-body type contrast without a brand kit.
        if (kitFont) l.style.fontFamily = String(kitFont);
        else if (def.brandFont) {
          const fam = roleFontFamily(l.role || '');
          if (fam) l.style.fontFamily = fam;
        }
      }
    }
  }
  // v2: boxes are measurement OUTPUT — hug every text leaf, then stamp param provenance so
  // text edits rebuild through params instead of mutating styles in place.
  fitElementText(layers);
  stampParamRefs(layers, def, params);
  const stamp = { id: def.id, params, v: 2 };
  if (layers.length <= 1) {
    if (layers[0]) layers[0].element = stamp;
    return layers;
  }
  const group = {
    id: layerId('group'),
    type: 'group',
    name: def.name || id,
    box: localGroupBounds(layers),
    children: layers,
    element: stamp,
  };
  return [group];
}

// ── smart vector/raster decision ─────────────────────────────────────────────────────────────────
// Determines whether a shape layer should remain as a vector (rect, ellipse, arrow, line, polyline,
// simple path) or needs rasterization (complex paths, effects like blur/backdropBlur/vignette).

/** Shape kinds that are ALWAYS rendered as vectors (no rasterization needed). */
const VECTOR_SHAPE_KINDS = new Set(['rect', 'ellipse', 'line', 'arrow']);

/**
 * Decide whether a shape layer should be rasterized or kept as a vector.
 * Simple shapes (rect, ellipse, line, arrow) are ALWAYS vectors. Complex paths, effects, and
 * high-complexity geometries may need rasterization.
 *
 * @param {object} layer — a scene-graph layer with style
 * @param {object} [opts] — optional context
 * @returns {{ rasterize:boolean, reason:string }}
 */
export function shouldRasterize(layer, opts = {}) {
  const s = layer?.style || {};
  const kind = s.shapeKind || 'rect';

  // Simple shapes: NEVER rasterize
  if (VECTOR_SHAPE_KINDS.has(kind)) {
    return { rasterize: false, reason: `simple shape: ${kind}` };
  }

  // Starburst: vector polygon (computed from spike count)
  if (kind === 'starburst') {
    const spikes = s.spikes || 12;
    if (spikes <= 40) return { rasterize: false, reason: `starburst with ${spikes} spikes (vector polygon)` };
    return { rasterize: true, reason: `starburst with ${spikes} spikes (>40, complex polygon)` };
  }

  // Freeform SVG path: check complexity by counting path commands
  if (kind === 'path' && s.path) {
    const cmdCount = (s.path.match(/[CcSsQqTtAa]/g) || []).length;
    const pointCount = (s.path.match(/[MLml]/g) || []).length;
    if (cmdCount > 30 || pointCount > 50) {
      return { rasterize: true, reason: `complex path (${cmdCount} curves, ${pointCount} points)` };
    }
    return { rasterize: false, reason: `simple path (${cmdCount} curves, ${pointCount} points)` };
  }

  // Polyline: vector for reasonable point counts
  if (kind === 'polyline' && Array.isArray(s.points)) {
    const n = s.points.length / 2;
    if (n <= 24) return { rasterize: false, reason: `polyline with ${n} points` };
    return { rasterize: true, reason: `polyline with ${n} points (>24, complex)` };
  }

  // Effects that require rasterization
  if (s.backdropBlur && s.backdropBlur > 0) {
    return { rasterize: true, reason: `backdropBlur effect (${s.backdropBlur}px)` };
  }
  if (s.blur && s.blur > 0) {
    return { rasterize: true, reason: `blur effect (${s.blur}px)` };
  }
  if (s.vignette) {
    return { rasterize: true, reason: 'vignette effect' };
  }

  // Gradient: depends on complexity
  if (s.gradient) {
    if (typeof s.gradient === 'object' && Array.isArray(s.gradient.stops) && s.gradient.stops.length > 6) {
      return { rasterize: true, reason: `gradient with ${s.gradient.stops.length} stops (>6)` };
    }
    return { rasterize: false, reason: 'simple gradient (vector CSS)' };
  }

  // Default: vector
  return { rasterize: false, reason: 'no complex features detected' };
}

// ── agent catalog ────────────────────────────────────────────────────────────────────────────────

function paramSig(spec) {
  if (spec.sig) return spec.sig; // explicit compression (huge enums like icon names)
  switch (spec.type) {
    case 'number':
      return spec.min != null && spec.max != null ? `${spec.key}:${spec.min}-${spec.max}` : spec.key;
    case 'enum':
      return `${spec.key}:${(spec.options || []).join('|')}`;
    case 'boolean':
      return `${spec.key}:bool`;
    case 'stringList':
      return `${spec.key}[]`;
    case 'series':
      return `${spec.key}:series`;
    default:
      return spec.key;
  }
}

/** Compact one-line signature for agent prompts: `id(param1,param2:1-5,…)`.
 *  `quiet` params are omitted (still coerced + editable) — keeps every line ≤60 chars. */
export function elementCatalogLine(def) {
  return `${def.id}(${(def.params || []).filter((s) => !s.quiet).map(paramSig).join(',')})`;
}
