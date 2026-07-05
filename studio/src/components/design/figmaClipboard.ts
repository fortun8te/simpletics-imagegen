// figmaClipboard.ts — "Copy to Figma as native layers" (scene-graph v3: nested groups,
// gradients, vignette, autoH, stroke, pill captions, Figma passthrough).
//
// Two paths, best first:
//
//   1. figma-native — build Figma's internal clipboard payload (kiwi-encoded NODE_CHANGES
//      message, see src/vendor/figma-kiwi) and write it as text/html. Pasting in Figma then
//      creates REAL nodes: frames (groups), rectangles, gradient fills, image fills (bytes
//      embedded via dataBlob) and text nodes with proper font/size/align.
//   2. svg — designToSvg() written as plain text. Figma pastes raw SVG markup as editable
//      vector layers, so this always works even if the native format drifts.
//
// The native payload is decoded back locally (roundtrip check) before it touches the
// clipboard; on ANY failure we silently fall back to SVG rather than copying garbage.
//
// buildFigmaMessage() / buildFigmaClipboardHtml() are pure (no DOM required) so node scripts
// can roundtrip-test the encoding. Pill wrapping uses a canvas measurer when one exists and a
// deterministic width heuristic otherwise.

import {
  isComponent,
  isGroup,
  resolveCrop,
  resolveGradient,
  type DesignDoc,
  type GradientFill,
  type GroupNode,
  type ImageCrop,
  type Layer,
  type SceneNode,
} from '../../lib/sceneGraph';
import {
  encodeFigmaClipboardHtml,
  decodeFigmaClipboardHtml,
  type FigColor,
  type FigMatrix,
  type FigMessage,
  type FigMeta,
  type FigNodeChange,
  type FigGUID,
} from '../../vendor/figma-kiwi';
import { designToSvg } from './designSvg';
import { ELEMENTS } from './elements';
import { arrowGeometry } from './fills';

// ── effects/structure round: model fields that may not be in sceneGraph.ts yet ───────────────────
// (another agent adds them additively — we type them locally and read defensively).

export type BlendKeyword =
  | 'normal' | 'multiply' | 'screen' | 'overlay' | 'darken' | 'lighten'
  | 'plus-lighter' | 'soft-light' | 'difference';

/** LayerStyle extended with the effects-round fields (blend / blur / radiusCorners). */
type FxStyle = NonNullable<Layer['style']> & {
  blend?: BlendKeyword;
  /** Layer blur (the node's own pixels), px — distinct from backdropBlur. */
  blur?: number;
  /** Per-corner radii [tl, tr, br, bl] — overrides `radius` when present. */
  radiusCorners?: [number, number, number, number];
};

/** CSS mix-blend-mode → Figma BlendMode enum. Schema (v46) enum values verified:
 *  PASS_THROUGH NORMAL DARKEN MULTIPLY LINEAR_BURN COLOR_BURN LIGHTEN SCREEN LINEAR_DODGE
 *  COLOR_DODGE OVERLAY SOFT_LIGHT HARD_LIGHT DIFFERENCE EXCLUSION HUE SATURATION COLOR
 *  LUMINOSITY. There is NO PLUS_LIGHTER — CSS plus-lighter ≈ additive = LINEAR_DODGE. */
export const BLEND_TO_FIGMA: Record<BlendKeyword, string> = {
  normal: 'NORMAL', multiply: 'MULTIPLY', screen: 'SCREEN', overlay: 'OVERLAY',
  darken: 'DARKEN', lighten: 'LIGHTEN', 'plus-lighter': 'LINEAR_DODGE',
  'soft-light': 'SOFT_LIGHT', difference: 'DIFFERENCE',
};

/** Figma blendMode for a layer style, or undefined when default ('normal' still emits NORMAL —
 *  leaf nodes default to PASS_THROUGH in baseNode, so an explicit 'normal' is meaningful). */
function blendOf(s: Layer['style']): string | undefined {
  const b = (s as FxStyle | undefined)?.blend;
  return b ? BLEND_TO_FIGMA[b] : undefined;
}

const ELEMENT_NAMES = new Map(ELEMENTS.map((e) => [e.id, e.name]));

/** Title-case a role/type token ("headline" → "Headline", "x-post" → "X Post") so a fallback
 *  name never pastes into Figma's layers panel as a bare lowercase slug. */
function humanizeName(raw: string): string {
  const cleaned = raw.replace(/[-_]+/g, ' ').trim();
  if (!cleaned) return 'Layer';
  return cleaned.replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Display name for a node: element instances are named after their element def; otherwise the
 *  layer's own name wins, and only then a humanized role/type fallback (never a generic "Frame"/
 *  "Group" slug or an empty string — Figma would autoRename or show a meaningless default). */
function nodeName(n: SceneNode, fallback: string): string {
  const elId = (n as { element?: { id?: string } }).element?.id;
  const elName = elId ? ELEMENT_NAMES.get(elId) : undefined;
  const own = (n.name || '').trim();
  return elName || own || humanizeName(fallback);
}

export type FigmaCopyResult = { method: 'figma-native' | 'svg'; ok: boolean; detail: string };

/** pluginData identity for the shapeKind 'path' fallback (see the path branch in
 *  emitSceneNode); figmaImport matches BOTH to reassemble the path on paste-back. */
export const FIGMA_PATH_PLUGIN_ID = 'neuegen.studio';
export const FIGMA_PATH_PLUGIN_KEY = 'path';
/** pluginData key carrying a text layer's autoH flag. We no longer encode autoH as
 *  textAutoResize:HEIGHT (that mode fights our fixed-box vertical centering — see emitText), so
 *  the flag rides losslessly in pluginData and figmaImport restores Layer.autoH from it. */
export const FIGMA_AUTOH_PLUGIN_KEY = 'autoH';

// ── color parsing (pure — no canvas, so the message builder runs in node too) ────────────────────

const NAMED: Record<string, string> = {
  black: '#000000', white: '#ffffff', red: '#ff0000', transparent: '#00000000',
};

/** Parse #hex / rgb() / rgba() into Figma's 0..1 RGBA. Unknown formats fall back to black. */
export function parseCssColor(input: string | undefined): FigColor {
  const raw = (input || '#000000').trim().toLowerCase();
  const s = NAMED[raw] || raw;
  let m = s.match(/^#([0-9a-f]{3,8})$/);
  if (m) {
    let hex = m[1];
    if (hex.length === 3 || hex.length === 4) hex = [...hex].map((c) => c + c).join('');
    const n = (i: number) => parseInt(hex.slice(i, i + 2), 16) / 255;
    return { r: n(0), g: n(2), b: n(4), a: hex.length === 8 ? n(6) : 1 };
  }
  m = s.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)$/);
  if (m) {
    const a = m[4] == null ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return { r: +m[1] / 255, g: +m[2] / 255, b: +m[3] / 255, a };
  }
  console.warn(`figmaClipboard: unparsed color "${input}", using black`);
  return { r: 0, g: 0, b: 0, a: 1 };
}

// ── gradient transforms ──────────────────────────────────────────────────────────────────────────

/**
 * CSS gradient angle (deg, 0 = to top, 90 = to right) → Figma paint gradientTransform.
 * The matrix maps normalized node coords into gradient space where the paint runs 0→1 along
 * the transformed x axis. Derived so that angle 180 ("to bottom") reproduces EXACTLY the
 * vertical matrix Figma emits itself: {m00:0,m01:1,m02:0,m10:-1,m11:0,m12:1} — asserted in
 * scripts/figma-roundtrip.test.mjs. Inverse: angleFromGradientTransform.
 */
export function gradientTransformFromAngle(angle: number): FigMatrix {
  const rad = ((angle ?? 0) * Math.PI) / 180;
  const snap = (v: number) => (Math.abs(v) < 1e-9 ? 0 : Math.abs(v - 1) < 1e-9 ? 1 : Math.abs(v + 1) < 1e-9 ? -1 : v);
  // Direction in y-down space, same convention as fills.ts gradientDirection().
  const dx = snap(Math.sin(rad));
  const dy = snap(-Math.cos(rad));
  return {
    m00: dx, m01: dy, m02: snap(Math.max(0, -dx) + Math.max(0, -dy)),
    m10: -dy, m11: dx, m12: snap(Math.max(0, dy) + Math.max(0, -dx)),
  };
}

/** Recover the CSS angle from a Figma gradientTransform (inverse of the above). */
export function angleFromGradientTransform(m: FigMatrix | undefined): number {
  if (!m) return 180;
  const deg = (Math.atan2(m.m00, -m.m01) * 180) / Math.PI;
  return Math.round(((deg % 360) + 360) % 360);
}

function gradientPaint(g: GradientFill): Record<string, unknown> {
  const stops = g.stops.map((s) => ({ color: parseCssColor(s.color), position: s.pos }));
  if (g.type === 'radial') {
    return {
      type: 'GRADIENT_RADIAL', visible: true, opacity: 1, blendMode: 'NORMAL',
      stops, transform: IDENTITY,
    };
  }
  return {
    type: 'GRADIENT_LINEAR', visible: true, opacity: 1, blendMode: 'NORMAL',
    stops, transform: gradientTransformFromAngle(g.angle ?? 180),
  };
}

// ── message construction ─────────────────────────────────────────────────────────────────────────

/** Image bytes + metadata for one image layer, keyed by layer id. */
export interface FigImageInput {
  bytes: Uint8Array;
  /** SHA-1 of bytes (Figma's image id). */
  hash: Uint8Array;
  width: number;
  height: number;
}

/** Figma's default family — always installed in every Figma editor. Emitting anything else as
 *  the DEFAULT (we used to emit 'Geist', which Figma does not ship) triggers the "missing
 *  fonts" dialog on paste, listing one entry per family+style combination. Only layers that
 *  explicitly set style.fontFamily emit a non-default family. */
const FIGMA_FALLBACK_FAMILY = 'Inter';

/** Minimal style set Figma is guaranteed to have for Inter (nearest match). Exotic names like
 *  'ExtraLight'/'Black' also show up in the missing-fonts dialog, so we never emit them — the
 *  numeric weight has no wire field of its own (schema-verified: NodeChange carries only
 *  fontName), so extreme weights round to this set on a Figma trip. */
const WEIGHT_STYLES: Array<[number, string]> = [
  [400, 'Regular'], [500, 'Medium'], [600, 'Semi Bold'], [700, 'Bold'],
];

function weightToStyle(w: number): string {
  let best = WEIGHT_STYLES[0];
  for (const cand of WEIGHT_STYLES) if (Math.abs(cand[0] - w) < Math.abs(best[0] - w)) best = cand;
  return best[1];
}

/** style.fontFamily values that name an OS/CSS-only font Figma's editor CANNOT resolve (it ships
 *  a fixed, curated font library — Google Fonts + a few licensed faces — not the host OS's fonts).
 *  Pasting one of these as fontName.family does NOT show the missing-fonts dialog (Figma doesn't
 *  know it's missing until the paste target has no such family) — it just silently substitutes,
 *  which is exactly the "renders text incorrectly" symptom: wrong metrics, wrong weight, a generic
 *  fallback face. Map each to the closest family Figma's own library actually has, so a paste
 *  looks like what we designed instead of a mystery substitution.
 *  - 'Georgia' / 'Menlo' / '-apple-system' are OS system fonts — never in Figma's library.
 *  - 'Bradley Hand' is an Apple-bundled script font — also absent from Figma.
 *  - '' (unset) already falls through to FIGMA_FALLBACK_FAMILY below.
 *  Fraunces / Poppins are NOT remapped: both are real, installable Google Fonts that ship in
 *  Figma's own font picker, so the literal name resolves correctly (unlike the OS fonts above). */
const FIGMA_UNRESOLVABLE_FAMILY: Record<string, string> = {
  georgia: 'Noto Serif',       // nearest Figma-available serif to the Georgia fallback
  menlo: 'Roboto Mono',        // nearest Figma-available monospace
  '-apple-system': 'Inter',    // Apple system font has no Figma equivalent — use our default sans
  'bradley hand': 'Caveat',    // nearest Figma-available handwritten/script face
};

/** Resolve a layer's style.fontFamily to a family name Figma's editor can actually find. */
function resolveFigmaFamily(fontFamily: string | undefined): string {
  const fam = (fontFamily || '').trim();
  if (!fam) return FIGMA_FALLBACK_FAMILY;
  const mapped = FIGMA_UNRESOLVABLE_FAMILY[fam.toLowerCase()];
  return mapped || fam;
}

/** Fractional-index position strings: '!', '"', '#', … kept lexicographically ordered. */
function positionAt(i: number): string {
  return '~'.repeat(Math.floor(i / 93)) + String.fromCharCode(33 + (i % 93));
}

const IDENTITY = { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 };

/**
 * Node transform for a box at (x,y,w,h) parent-relative, rotated `rotation` degrees CLOCKWISE
 * about the box CENTER (CSS `transform: rotate(θdeg)` parity, y-down space). Figma's matrix
 * maps node-local coords (origin = node top-left) into parent space, so the translation is the
 * ROTATED top-left: C − R·(w/2, h/2). Inverse: decodeRotation in figmaImport.ts
 * (θ = atan2(m10, m00)); roundtrip asserted at 15° / −30° in scripts/figma-roundtrip.test.mjs.
 */
export function boxTransform(
  box: { x: number; y: number; w: number; h: number },
  rotation: number | undefined,
  parentOrigin: { x: number; y: number },
): FigMatrix {
  const x = box.x - parentOrigin.x;
  const y = box.y - parentOrigin.y;
  if (!rotation) return { ...IDENTITY, m02: x, m12: y };
  const rad = (rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const cx = x + box.w / 2;
  const cy = y + box.h / 2;
  return {
    m00: cos, m01: -sin, m02: cx - (cos * box.w / 2 - sin * box.h / 2),
    m10: sin, m11: cos, m12: cy - (sin * box.w / 2 + cos * box.h / 2),
  };
}

/** Shared defaults observed on every node of a real Figma clipboard copy. */
function baseNode(guid: FigGUID, parent: FigGUID, index: number): FigNodeChange {
  return {
    guid,
    phase: 'CREATED',
    parentIndex: { guid: parent, position: positionAt(index) },
    type: 'NONE',
    visible: true,
    locked: false,
    opacity: 1,
    blendMode: 'PASS_THROUGH',
    dashPattern: [],
    mask: false,
    maskType: 'ALPHA',
    strokeWeight: 1,
    strokeAlign: 'INSIDE',
    strokeCap: 'NONE',
    strokeJoin: 'MITER',
    strokePaints: [],
    miterLimit: 4,
    horizontalConstraint: 'MIN',
    verticalConstraint: 'MIN',
  };
}

function solidPaint(color: string | undefined, opacity = 1) {
  return { type: 'SOLID', color: parseCssColor(color), opacity, visible: true, blendMode: 'NORMAL' };
}

// ── pill wrapping (local copy — PARITY with textMetrics.ts wrapLines/textLayout; kept local so
//    this module stays importable in node without pulling the DOM-coupled measurer) ──────────────

interface Measurer { width(text: string): number }

let sharedCtx: CanvasRenderingContext2D | null = null;

function measurerFor(s: Layer['style']): Measurer {
  if (typeof document !== 'undefined') {
    if (!sharedCtx) sharedCtx = document.createElement('canvas').getContext('2d');
    if (sharedCtx) {
      const ctx = sharedCtx;
      // Measure in the SAME family we export (resolved to what Figma will actually render) so
      // pill line-wrapping matches the real paste — measuring in a family Figma substitutes away
      // (an OS font it doesn't ship) breaks lines at the wrong points.
      const fam = resolveFigmaFamily(s?.fontFamily);
      ctx.font = `${s?.fontWeight || 600} ${s?.fontSize || 40}px ${fam}, 'Helvetica Neue', Arial, sans-serif`;
      (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${s?.letterSpacing || 0}px`;
      return { width: (t) => ctx.measureText(t).width };
    }
  }
  // Node / no canvas: deterministic heuristic (avg glyph ≈ 0.55em + letterSpacing).
  const size = s?.fontSize || 40;
  const ls = s?.letterSpacing || 0;
  return { width: (t) => t.length * (size * 0.55 + ls) };
}

/** PARITY: textMetrics.ts wrapLines — honors \n, no mid-word breaking. */
function wrapLines(m: Measurer, text: string, maxW: number): string[] {
  const out: string[] = [];
  for (const para of String(text).split('\n')) {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) { out.push(''); continue; }
    let cur = '';
    for (const word of words) {
      const probe = cur ? `${cur} ${word}` : word;
      if (m.width(probe) <= maxW || !cur) cur = probe;
      else { out.push(cur); cur = word; }
    }
    if (cur) out.push(cur);
  }
  return out;
}

// ── figma passthrough merge ──────────────────────────────────────────────────────────────────────

/** Fields WE own on re-export — geometry, identity, ordering, text. Everything else a layer's
 *  `figma` stash carries wins, so a Figma→tool→Figma trip preserves what we can't render. */
const OURS_WIN = new Set([
  'guid', 'phase', 'parentIndex', 'transform', 'size', 'name', 'textData', 'visible', 'locked',
]);

/** Node types whose ONLY geometry is vectorData.vectorNetworkBlob (an opaque per-message binary
 *  blob we drop on import — see figmaImport sanitize). Resurrecting one of these FROM A STASH
 *  yields a node with no geometry, which Figma pastes as an invisible/dropped layer — a prime
 *  "some layers just vanish" bug. When the stash asks for one of these but carries no live
 *  vectorNetworkBlob, we keep OUR renderable type (the visible locked placeholder rectangle). */
const VECTOR_NETWORK_TYPES = new Set(['VECTOR', 'BOOLEAN_OPERATION']);

function mergeFigmaPassthrough(node: FigNodeChange, carried: unknown): FigNodeChange {
  if (!carried || typeof carried !== 'object' || Array.isArray(carried)) return node;
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(carried as Record<string, unknown>)) {
    if (!OURS_WIN.has(k)) extra[k] = v;
  }
  // A stashed effects array would clobber the BACKGROUND_BLUR / FOREGROUND_BLUR we just derived
  // from style.backdropBlur / style.blur (figmaImport strips them from the stash) — keep ours.
  if (Array.isArray(extra.effects) && Array.isArray(node.effects)) {
    const blurs = (node.effects as Array<Record<string, unknown>>)
      .filter((e) => e?.type === 'BACKGROUND_BLUR' || e?.type === 'FOREGROUND_BLUR');
    if (blurs.length) extra.effects = [...(extra.effects as unknown[]), ...blurs];
  }
  // The emitter's chosen `type` is authoritative for geometry: it already picked a renderable
  // shape (ROUNDED_RECTANGLE / ELLIPSE / TEXT / …) sized to the layer box. A stash may restore
  // the original Figma type ONLY when doing so still pastes something visible — i.e. NOT a
  // vector-network type whose geometry blob we could not carry back. Otherwise a broken,
  // invisible VECTOR replaces a perfectly good placeholder rectangle.
  const stashType = extra.type as string | undefined;
  const hasVectorNetwork = !!(extra.vectorData
    && typeof (extra.vectorData as { vectorNetworkBlob?: unknown }).vectorNetworkBlob === 'number');
  let type = node.type;
  if (stashType && !(VECTOR_NETWORK_TYPES.has(stashType) && !hasVectorNetwork)) type = stashType;
  return { ...node, ...extra, type, guid: node.guid, parentIndex: node.parentIndex };
}

// ── the emitter ──────────────────────────────────────────────────────────────────────────────────

interface EmitCtx {
  nodes: FigNodeChange[];
  blobs: Array<{ bytes: Uint8Array }>;
  images: Map<string, FigImageInput>;
  /** Image-layer ids whose bytes are a baked cut-out (crop + shape-as-alpha) — emitted as a plain
   *  rect + FILL because the alpha already carries the shape (see the image branch below). */
  cutoutBaked: Set<string>;
  guid(): FigGUID;
  /** Per-parent child index counters, keyed by parent localID. */
  counters: Map<number, number>;
}

function nextIndex(ctx: EmitCtx, parent: FigGUID): number {
  const i = ctx.counters.get(parent.localID) ?? 0;
  ctx.counters.set(parent.localID, i + 1);
  return i;
}

/** GLASS FIX: BACKGROUND_BLUR only shows through semi-transparent fills. When a layer has
 *  backdropBlur but an OPAQUE solid fill, re-emit the fill at alpha 0.35 so the blur reads
 *  in Figma. Translucent fills pass through untouched. */
function glassifyPaints(fillPaints: unknown[], s: Layer['style']): unknown[] {
  if (!((s?.backdropBlur ?? 0) > 0)) return fillPaints;
  return fillPaints.map((p) => {
    const paint = p as { type?: string; color?: FigColor; opacity?: number };
    if (paint?.type !== 'SOLID' || !paint.color) return p;
    const effA = (paint.color.a ?? 1) * (paint.opacity ?? 1);
    if (effA < 0.999) return p;
    return { ...paint, color: { ...paint.color, a: 0.35 }, opacity: 1 };
  });
}

function rectNode(
  ctx: EmitCtx, parent: FigGUID, parentOrigin: { x: number; y: number },
  l: Layer, name: string, fillPaints: unknown[],
): FigNodeChange {
  const s = (l.style || {}) as FxStyle;
  const r = s.radius || 0;
  // Per-corner radii [tl, tr, br, bl] → independent rectangle*CornerRadius fields.
  const rc = Array.isArray(s.radiusCorners) && s.radiusCorners.length === 4 ? s.radiusCorners : undefined;
  const effects = layerEffects(l);
  const blend = blendOf(s);
  const node: FigNodeChange = {
    ...baseNode(ctx.guid(), parent, nextIndex(ctx, parent)),
    type: 'ROUNDED_RECTANGLE',
    name,
    size: { x: l.box.w, y: l.box.h },
    transform: boxTransform(l.box, l.rotation, parentOrigin),
    opacity: s.opacity ?? 1,
    cornerRadius: rc ? rc[0] : r,
    rectangleTopLeftCornerRadius: rc ? rc[0] : r,
    rectangleTopRightCornerRadius: rc ? rc[1] : r,
    rectangleBottomLeftCornerRadius: rc ? rc[3] : r,
    rectangleBottomRightCornerRadius: rc ? rc[2] : r,
    rectangleCornerRadiiIndependent: !!rc,
    rectangleCornerToolIndependent: false,
    proportionsConstrained: false,
    handleMirroring: 'NONE',
    cornerSmoothing: 0,
    fillPaints: glassifyPaints(fillPaints, s),
    ...(effects ? { effects } : {}),
    ...(blend ? { blendMode: blend } : {}),
  };
  if (s.stroke) {
    node.strokePaints = [solidPaint(s.stroke.color)];
    node.strokeWeight = s.stroke.width;
    node.strokeAlign = 'CENTER';
  }
  return node;
}

/**
 * arrow / line shapeKind → a Figma LINE node: a zero-height line of length L, rotated to the
 * box diagonal (arrowGeometry — the ONE geometry every renderer shares), stroked in the layer's
 * background color. Arrows get strokeCap ARROW_LINES (schema-native); lines stay ROUND.
 * The layer's own `rotation` composes by rotating the endpoints about the box center first.
 */
function lineNode(
  ctx: EmitCtx, parent: FigGUID, parentOrigin: { x: number; y: number },
  l: Layer, name: string, kind: 'arrow' | 'line',
): FigNodeChange {
  const s = l.style || {};
  const geom = arrowGeometry(l.box, s.flipDiag);
  let { x1, y1, x2, y2 } = geom;
  if (l.rotation) {
    const rad = (l.rotation * Math.PI) / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    const cx = l.box.x + l.box.w / 2, cy = l.box.y + l.box.h / 2;
    const rot = (px: number, py: number): [number, number] =>
      [cx + (px - cx) * cos - (py - cy) * sin, cy + (px - cx) * sin + (py - cy) * cos];
    [x1, y1] = rot(x1, y1);
    [x2, y2] = rot(x2, y2);
  }
  const len = Math.max(1, Math.hypot(x2 - x1, y2 - y1));
  const ang = Math.atan2(y2 - y1, x2 - x1);
  const cos = Math.cos(ang), sin = Math.sin(ang);
  return {
    ...baseNode(ctx.guid(), parent, nextIndex(ctx, parent)),
    type: 'LINE',
    name,
    size: { x: len, y: 0 },
    transform: {
      m00: cos, m01: -sin, m02: x1 - parentOrigin.x,
      m10: sin, m11: cos, m12: y1 - parentOrigin.y,
    },
    opacity: s.opacity ?? 1,
    fillPaints: [],
    strokePaints: [solidPaint(s.background || '#ffffff')],
    strokeWeight: geom.width,
    strokeAlign: 'CENTER',
    strokeCap: kind === 'arrow' ? 'ARROW_LINES' : 'ROUND',
    strokeJoin: 'ROUND',
    handleMirroring: 'NONE',
    proportionsConstrained: false,
    ...(blendOf(s) ? { blendMode: blendOf(s) } : {}),
  };
}

/**
 * shapeKind 'polyline' (style.points, flat [x,y,…] normalized 0..1 in the box) → a FRAME group
 * of LINE nodes, one per segment.
 *
 * FALLBACK (documented): a real Figma VECTOR would need vectorData.vectorNetworkBlob, an opaque
 * NON-kiwi binary blob format the vendored schema only references by index — building it means
 * reverse-engineering the blob layout, out of scope here. Instead we emit per-segment LINE nodes
 * whose names carry the passthrough hint 'polyline·N'; figmaImport detects that hint and
 * reassembles the polyline (points + stroke) losslessly. Pasting into Figma gives an editable
 * group of lines. shapeKind 'path' has its own fallback — see the path branch in emitSceneNode.
 */
function emitPolyline(
  ctx: EmitCtx, parent: FigGUID, parentOrigin: { x: number; y: number },
  l: Layer, name: string,
): void {
  const s = (l.style || {}) as FxStyle;
  const pts = s.points || [];
  const abs: Array<[number, number]> = [];
  for (let i = 0; i + 1 < pts.length; i += 2) {
    abs.push([l.box.x + pts[i] * l.box.w, l.box.y + pts[i + 1] * l.box.h]);
  }
  const frameGuid = ctx.guid();
  const blend = blendOf(s);
  ctx.nodes.push(mergeFigmaPassthrough({
    ...baseNode(frameGuid, parent, nextIndex(ctx, parent)),
    type: 'FRAME',
    name,
    size: { x: Math.max(1, l.box.w), y: Math.max(1, l.box.h) },
    transform: { ...IDENTITY, m02: l.box.x - parentOrigin.x, m12: l.box.y - parentOrigin.y },
    opacity: s.opacity ?? 1,
    resizeToFit: true,
    frameMaskDisabled: true,
    fillPaints: [],
    cornerRadius: 0,
    cornerSmoothing: 0,
    exportBackgroundDisabled: false,
    containerSupportsFillStrokeAndCorners: true,
    ...(blend ? { blendMode: blend } : {}),
  }, l.figma));
  const color = s.background || s.color || '#ffffff';
  const width = s.stroke?.width || 4;
  const origin = { x: l.box.x, y: l.box.y };
  for (let i = 0; i + 1 < abs.length; i++) {
    const [x1, y1] = abs[i];
    const [x2, y2] = abs[i + 1];
    const len = Math.max(1, Math.hypot(x2 - x1, y2 - y1));
    const ang = Math.atan2(y2 - y1, x2 - x1);
    const cos = Math.cos(ang), sin = Math.sin(ang);
    ctx.nodes.push({
      ...baseNode(ctx.guid(), frameGuid, nextIndex(ctx, frameGuid)),
      type: 'LINE',
      name: `polyline·${i + 1}`, // passthrough hint — figmaImport reassembles the polyline
      size: { x: len, y: 0 },
      transform: {
        m00: cos, m01: -sin, m02: x1 - origin.x,
        m10: sin, m11: cos, m12: y1 - origin.y,
      },
      fillPaints: [],
      strokePaints: [solidPaint(color)],
      strokeWeight: width,
      strokeAlign: 'CENTER',
      strokeCap: 'ROUND',
      strokeJoin: 'ROUND',
      handleMirroring: 'NONE',
      proportionsConstrained: false,
    });
  }
}

function layerEffects(l: Layer): unknown[] | undefined {
  const s = l.style || {};
  const out: unknown[] = [];
  if (s.shadow) {
    out.push({
      type: 'DROP_SHADOW', color: { r: 0, g: 0, b: 0, a: 0.55 }, offset: { x: 0, y: 2 },
      radius: 12, visible: true, blendMode: 'NORMAL', spread: 0, showShadowBehindNode: false,
    });
  }
  for (const e of s.effects || []) {
    if (e.type === 'drop-shadow') {
      out.push({
        type: 'DROP_SHADOW', color: parseCssColor(e.color || 'rgba(0,0,0,0.55)'),
        offset: { x: e.x ?? 0, y: e.y ?? 2 }, radius: e.blur ?? 12,
        visible: true, blendMode: 'NORMAL', spread: 0, showShadowBehindNode: false,
      });
    }
  }
  if (s.backdropBlur) {
    // Frosted-glass card — true parity with backdrop-filter (see LayerStyle.backdropBlur).
    // NOTE: BACKGROUND_BLUR only reads through a semi-transparent fill — see glassifyPaints.
    out.push({ type: 'BACKGROUND_BLUR', radius: s.backdropBlur, visible: true, blendMode: 'NORMAL' });
  }
  // Layer blur (the node's own pixels). Schema enum is FOREGROUND_BLUR (Figma UI: "Layer blur").
  const ownBlur = (s as FxStyle).blur;
  if (typeof ownBlur === 'number' && ownBlur > 0) {
    out.push({ type: 'FOREGROUND_BLUR', radius: ownBlur, visible: true, blendMode: 'NORMAL' });
  }
  for (const e of s.effects || []) {
    if (e.type === 'blur' && (e.blur ?? 0) > 0) {
      out.push({ type: 'FOREGROUND_BLUR', radius: e.blur, visible: true, blendMode: 'NORMAL' });
    }
  }
  return out.length ? out : undefined;
}

function emitText(
  ctx: EmitCtx, parent: FigGUID, parentOrigin: { x: number; y: number },
  l: Layer, name: string, box: { x: number; y: number; w: number; h: number },
  text: string,
): void {
  const s = l.style || {};
  const size = s.fontSize || 40;
  const weight = s.fontWeight || 600;
  const effects = layerEffects(l);
  ctx.nodes.push(mergeFigmaPassthrough({
    ...baseNode(ctx.guid(), parent, nextIndex(ctx, parent)),
    type: 'TEXT',
    // Element instances keep the element's display name; plain text nodes are named by content.
    name: l.element ? name : String(text || name).slice(0, 40) || name,
    size: { x: Math.max(1, box.w), y: Math.max(1, box.h) },
    transform: boxTransform(box, l.rotation, parentOrigin),
    opacity: s.opacity ?? 1,
    strokeAlign: 'OUTSIDE',
    fontSize: size,
    // Brand-kit font override when EXPLICITLY set (resolved to a family Figma's editor can
    // actually find — see resolveFigmaFamily); otherwise Figma's own default family so a paste
    // never opens the missing-fonts dialog. ONE resolution point for every TEXT node — pill
    // per-line texts and element composites all come through here, so a whole doc resolves to
    // families Figma can render instead of silently substituting a generic fallback.
    fontName: { family: resolveFigmaFamily(s.fontFamily), style: weightToStyle(weight), postscript: '' },
    textDecoration: s.strikethrough ? 'STRIKETHROUGH' : 'NONE',
    textAlignHorizontal: s.align === 'center' ? 'CENTER' : s.align === 'right' ? 'RIGHT' : 'LEFT',
    // ── VERTICAL GEOMETRY — must agree with textAutoResize or text jumps on paste ─────────────
    // raster.ts centers the wrapped block in a FIXED box ((h-blockH)/2). That centering is only
    // meaningful when the box height is fixed. With textAutoResize:HEIGHT, Figma DISCARDS our
    // size.y and hugs the text (box height = content height), so a 'CENTER' vertical align has no
    // slack to center in — the run collapses to a top-anchored block at a DIFFERENT y than our
    // centered design. That HEIGHT+CENTER contradiction is the "massive text issue": every
    // auto-height text node lands at the wrong vertical position (and, when a substituted font
    // re-wraps to more/fewer lines, the auto-growing box shoves neighbours). Fix: keep the box
    // FIXED (textAutoResize:NONE, size = our exact design box) for EVERY text node so Figma
    // reproduces our box verbatim and our vertical CENTER is honoured. A substituted font that
    // measures slightly taller then clips/centres symmetrically inside the box — same as raster.ts
    // — instead of reflowing the whole layout. autoH is preserved for copy-back via pluginData
    // (see below); import restores it without needing the lossy HEIGHT signal.
    textAlignVertical: 'CENTER',
    textAutoResize: 'NONE',
    lineHeight: { value: (s.lineHeight || 1.2) * 100, units: 'PERCENT' },
    letterSpacing: { value: s.letterSpacing || 0, units: 'PIXELS' },
    textCase: s.uppercase ? 'UPPER' : 'ORIGINAL',
    textData: { characters: String(text || '') },
    fillPaints: [solidPaint(s.color || '#ffffff')],
    // ── OVERRIDE TAGS — the actual "text renders incorrectly" root cause ──────────────────────
    // Every overridable text property in Figma's clipboard NodeChange is paired with a
    // `<field>Tag: uint`. The tag is Figma's field-override marker: a TEXT node's own
    // fontSize/fontName/lineHeight/… are applied ONLY when their Tag is present. With NO tags
    // (what we used to emit), Figma treats each property as unset and inherits the empty text
    // style's defaults — so a pasted headline collapsed to Figma's default face/size/spacing
    // regardless of the values we wrote (schema-verified: `*Tag` fields exist for exactly these
    // properties; a value with no tag decodes fine but is ignored by the editor). Set every tag
    // so the styled run renders with the fontSize/family/weight/lineHeight/spacing/fill/case we
    // intended. `1` is a valid non-zero override marker (round-trips through the kiwi schema).
    fontSizeTag: 1,
    fontNameTag: 1,
    textDecorationTag: 1,
    textAlignHorizontalTag: 1,
    textAlignVerticalTag: 1,
    textAutoResizeTag: 1,
    lineHeightTag: 1,
    textCaseTag: 1,
    textDataTag: 1,
    fillPaintsTag: 1,
    // Keep the name WE assigned (element display name / content). autoRename lets Figma rewrite
    // a TEXT node's name from its characters on paste — which clobbers meaningful element names
    // ("CTA button" → "SHOP NOW") and is part of the "frames aren't named properly" report.
    autoRename: false,
    handleMirroring: 'NONE',
    proportionsConstrained: false,
    ...(effects ? { effects } : {}),
    ...(blendOf(s) ? { blendMode: blendOf(s) } : {}),
    // Preserve autoH for copy-back (we no longer signal it via textAutoResize — see above).
    ...(l.autoH ? { pluginData: [{ pluginID: FIGMA_PATH_PLUGIN_ID, key: FIGMA_AUTOH_PLUGIN_KEY, value: '1' }] } : {}),
  }, l.figma));
}

/** Emit children under a parent, marking Layer.isMask children as Figma masks (mask:true,
 *  maskType ALPHA — schema-verified fields) on the FIRST node each child emits. Sibling order
 *  is preserved, so the mask masks the siblings above it exactly like in our model. */
function emitChildren(
  ctx: EmitCtx, parent: FigGUID, origin: { x: number; y: number },
  children: SceneNode[],
): void {
  for (const child of children) {
    const before = ctx.nodes.length;
    emitSceneNode(ctx, parent, origin, child);
    if ((child as Layer)?.isMask === true && ctx.nodes.length > before) {
      const node = ctx.nodes[before];
      node.mask = true;
      node.maskType = 'ALPHA';
    }
  }
}

/**
 * A scene GroupNode becomes a REAL Figma GROUP node (NodeType.GROUP) so the layers panel shows a
 * named, expandable "Group" — not a flat dump and not a Frame the user has to reason about. The
 * group's `name` is preserved and its children nest under it recursively (z-order + absolute→
 * relative coordinate conversion handled by emitChildren/boxTransform), so a paste yields a clean
 * editable tree.
 *
 * Two exceptions fall back to a FRAME:
 *   - clip:true groups — Figma GROUPs cannot clip, so a clipping group is a fixed-size frame
 *     (resizeToFit:false, frameMaskDisabled:false — children clip to the frame bounds).
 *   - empty groups — a Figma GROUP with no children is invalid and gets dropped on paste, so an
 *     empty scene group degrades to a (hugging) frame that still shows up as a container.
 *
 * GROUP nodes carry none of the frame-only paint/layout fields (fillPaints, resizeToFit,
 * cornerRadius, …): Figma derives a group's bounds from its children and a group has no fill of
 * its own. figmaImport maps GROUP (and FRAME) back to a scene GroupNode, so copy→paste→copy is
 * stable.
 */
function emitGroup(
  ctx: EmitCtx, parent: FigGUID, parentOrigin: { x: number; y: number },
  g: GroupNode,
): void {
  const frameGuid = ctx.guid();
  const clip = (g as GroupNode & { clip?: boolean }).clip === true;
  const visibleChildren = g.children.filter((c) => !c.hidden);
  const asGroup = !clip && visibleChildren.length > 0;
  const name = nodeName(g, g.role || 'Group');
  const common = {
    ...baseNode(frameGuid, parent, nextIndex(ctx, parent)),
    name,
    size: { x: Math.max(1, g.box.w), y: Math.max(1, g.box.h) },
    transform: { ...IDENTITY, m02: g.box.x - parentOrigin.x, m12: g.box.y - parentOrigin.y },
    opacity: g.style?.opacity ?? 1,
  };
  if (asGroup) {
    // Real Figma GROUP: a pure container (no fill, no frame layout fields). Figma recomputes its
    // bounds from the children; `size`/`transform` place its origin so child-relative coords land.
    ctx.nodes.push(mergeFigmaPassthrough({ ...common, type: 'GROUP' }, g.figma));
  } else {
    // clip group → real clipping frame; empty group → hugging frame (both keep the group name).
    ctx.nodes.push(mergeFigmaPassthrough({
      ...common,
      type: 'FRAME',
      resizeToFit: !clip,
      frameMaskDisabled: !clip,
      fillPaints: [],
      cornerRadius: 0,
      cornerSmoothing: 0,
      exportBackgroundDisabled: false,
      containerSupportsFillStrokeAndCorners: true,
    }, g.figma));
  }
  const origin = { x: g.box.x, y: g.box.y };
  emitChildren(ctx, frameGuid, origin, g.children);
}

function emitSceneNode(
  ctx: EmitCtx, parent: FigGUID, parentOrigin: { x: number; y: number },
  n: SceneNode,
): void {
  if (n.hidden) return;
  if (isGroup(n)) { emitGroup(ctx, parent, parentOrigin, n); return; }
  if (isComponent(n)) {
    // ComponentLayer (native-component, e.g. 'x-post') has no `style`/`text` — it's rendered by
    // its own HTML/CSS, which no renderer (incl. this one) executes yet. Falling through to the
    // generic text/badge branch below would read undefined `l.text`/`l.style` and emit a near-
    // empty TEXT node — a silent "vanishes on Figma copy" drop. Emit a labeled placeholder
    // rectangle sized to the component's box instead, so the layer and its position are always
    // visible in Figma even though its internal layout isn't reproduced.
    const guid = ctx.guid();
    ctx.nodes.push(mergeFigmaPassthrough({
      ...baseNode(guid, parent, nextIndex(ctx, parent)),
      type: 'ROUNDED_RECTANGLE',
      name: `${n.name || n.component} (component)`,
      size: { x: Math.max(1, n.box.w), y: Math.max(1, n.box.h) },
      transform: boxTransform(n.box, n.rotation, parentOrigin),
      opacity: 1,
      cornerRadius: 0,
      fillPaints: [solidPaint('#2a2a2a')],
      handleMirroring: 'NONE',
      proportionsConstrained: false,
    }, n.figma));
    return;
  }
  const l = n;
  const s = l.style || {};
  const name = nodeName(l, l.role || l.type);

  if (l.type === 'image') {
    const img = ctx.images.get(l.id);
    if (!img) {
      // Image bytes missing (fetch 404 / decode failure / crop bake threw). Emitting nothing here
      // makes the layer VANISH from the paste with no trace — one of the "some layers just don't
      // show up in Figma" reports. Emit a labeled, box-sized placeholder rectangle instead (same
      // discipline as the component / VECTOR fallbacks): the layer and its position stay visible so
      // the user sees WHAT failed and can re-drop the image, rather than silently losing it.
      ctx.nodes.push(mergeFigmaPassthrough({
        ...rectNode(ctx, parent, parentOrigin, l, `${name} (image missing)`, [solidPaint('#3a3a3a')]),
        strokePaints: [solidPaint('#ff5555')],
        strokeWeight: 2,
        strokeAlign: 'INSIDE',
      }, l.figma));
      return;
    }
    const blobIndex = ctx.blobs.length;
    ctx.blobs.push({ bytes: img.bytes });
    // A baked cut-out (crop + shape-as-alpha) is already box-sized with the shape in its alpha, so
    // emit a PLAIN rectangle (no corner radius / not an ellipse — imageForCutout strips those) and
    // FILL: the transparency IS the shape, giving Figma a correct standalone cutout. Non-cut-out
    // images keep the original shape on the node (rectNode reads radius/radiusCorners) + fit.
    const isCutout = ctx.cutoutBaked.has(l.id);
    const nodeLayer = isCutout
      ? { ...l, fit: 'cover' as const, style: { ...(l.style || {}), shapeKind: undefined, radius: 0, radiusCorners: undefined } }
      : l;
    ctx.nodes.push(mergeFigmaPassthrough(rectNode(ctx, parent, parentOrigin, nodeLayer, name, [{
      type: 'IMAGE',
      visible: true,
      opacity: 1,
      blendMode: 'NORMAL',
      image: { hash: img.hash, name: `${name}.png`, dataBlob: blobIndex },
      imageScaleMode: !isCutout && l.fit === 'contain' ? 'FIT' : 'FILL',
      imageShouldColorManage: true,
      originalImageWidth: img.width,
      originalImageHeight: img.height,
      scale: 0.5,
      rotation: 0,
    }]), l.figma));
    return;
  }

  if (l.type === 'vignette') {
    // Edge darkening: radial fill, transparent until `size`, color@strength at the edge.
    const c = parseCssColor(s.background || '#000000');
    const v = s.vignette || { strength: 0.7, size: 0.45 };
    ctx.nodes.push(mergeFigmaPassthrough(rectNode(ctx, parent, parentOrigin, l, name, [{
      type: 'GRADIENT_RADIAL', visible: true, opacity: 1, blendMode: 'NORMAL',
      stops: [
        { color: { ...c, a: 0 }, position: Math.max(0, Math.min(0.95, v.size)) },
        { color: { ...c, a: Math.max(0, Math.min(1, v.strength)) }, position: 1 },
      ],
      transform: IDENTITY,
    }]), l.figma));
    return;
  }

  if (l.type === 'shape') {
    const kind = (s.shapeKind as string) || 'rect';
    if (kind === 'arrow' || kind === 'line') {
      ctx.nodes.push(mergeFigmaPassthrough(lineNode(ctx, parent, parentOrigin, l, name, kind), l.figma));
      return;
    }
    if (kind === 'polyline' && Array.isArray((s as FxStyle).points) && ((s as FxStyle).points?.length ?? 0) >= 4) {
      emitPolyline(ctx, parent, parentOrigin, l, name);
      return;
    }
    const g = resolveGradient(s);
    const paint = g ? gradientPaint(g) : solidPaint(s.background);
    if (kind === 'path' && typeof s.path === 'string' && s.path) {
      // FALLBACK (documented): a real Figma VECTOR needs vectorData.vectorNetworkBlob — a uint
      // index into message.blobs pointing at Figma's OPAQUE vector-network binary, a format the
      // kiwi schema does not describe (schema-verified: VectorData = { vectorNetworkBlob: uint,
      // normalizedSize, styleOverrideTable }). Building that blob means reverse-engineering an
      // undocumented binary layout — timeboxed out. Instead: the layer's box pastes as a
      // ROUNDED_RECTANGLE with the real fill, the name gets the ' (path)' suffix so the
      // substitution is visible in Figma's layers panel, and the d-string rides losslessly in
      // pluginData (schema-native PluginData {pluginID,key,value}) — Figma preserves pluginData,
      // and figmaImport reassembles shapeKind 'path' from it (tryPath).
      const node = rectNode(ctx, parent, parentOrigin, l, `${name} (path)`, [paint]);
      node.pluginData = [{ pluginID: FIGMA_PATH_PLUGIN_ID, key: FIGMA_PATH_PLUGIN_KEY, value: s.path }];
      ctx.nodes.push(mergeFigmaPassthrough(node, l.figma));
      return;
    }
    const node = rectNode(ctx, parent, parentOrigin, l, name, [paint]);
    if (kind === 'ellipse') {
      node.type = 'ELLIPSE';
    } else if (kind === 'starburst') {
      // Native Figma STAR: count = spikes, inner radius ratio matches starburstPoints (0.78).
      node.type = 'STAR';
      node.count = Math.max(6, Math.min(40, Math.round(s.spikes ?? 12)));
      node.starInnerScale = 0.78;
    }
    ctx.nodes.push(mergeFigmaPassthrough(node, l.figma));
    return;
  }

  // text / badge / button.
  const text = s.uppercase ? String(l.text || '').toUpperCase() : String(l.text || '');

  if (s.pill && s.background && text) {
    // Instagram-caption pills: one rect+text pair per wrapped line, inside a FRAME group
    // named after the layer. Wrap PARITY with textMetrics.ts textLayout (pill branch).
    const size = s.fontSize || 40;
    const padX = s.padding || 14;
    const lineH = size * (s.lineHeight || 1.2) * 1.25;
    const padY = padX * 0.55;
    const m = measurerFor(s);
    const lines = wrapLines(m, text, Math.max(8, l.box.w - padX * 2));
    const frameGuid = ctx.guid();
    ctx.nodes.push(mergeFigmaPassthrough({
      ...baseNode(frameGuid, parent, nextIndex(ctx, parent)),
      type: 'FRAME',
      name,
      size: { x: Math.max(1, l.box.w), y: Math.max(1, l.box.h) },
      transform: { ...IDENTITY, m02: l.box.x - parentOrigin.x, m12: l.box.y - parentOrigin.y },
      opacity: s.opacity ?? 1,
      resizeToFit: true,
      frameMaskDisabled: true,
      fillPaints: [],
      cornerRadius: 0,
      cornerSmoothing: 0,
      exportBackgroundDisabled: false,
      containerSupportsFillStrokeAndCorners: true,
    }, l.figma));
    lines.forEach((line, i) => {
      const w = Math.min(l.box.w, m.width(line) + padX * 2);
      const x = s.align === 'center' ? (l.box.w - w) / 2 : s.align === 'right' ? l.box.w - w : 0;
      const y = padY + i * lineH;
      // Same parent counter for both siblings — the FRAME's.
      const pillRect: Layer = {
        ...l, type: 'shape',
        box: { x: l.box.x + x, y: l.box.y + y, w, h: lineH },
        style: { ...s, pill: undefined, gradient: null },
      };
      ctx.nodes.push(rectNode(ctx, frameGuid, { x: l.box.x, y: l.box.y }, pillRect, `${name} pill ${i + 1}`, [solidPaint(s.background)]));
      emitText(ctx, frameGuid, { x: l.box.x, y: l.box.y },
        { ...l, autoH: false }, `${name} line ${i + 1}`,
        { x: l.box.x + x + padX, y: l.box.y + y, w: w - padX * 2, h: lineH }, line);
    });
    return;
  }

  if (s.background) {
    // bg rect + TEXT as siblings, both drawn from the SAME parent counter.
    ctx.nodes.push(rectNode(ctx, parent, parentOrigin, l, `${name} bg`, [solidPaint(s.background)]));
  }
  const pad = s.padding || 0;
  emitText(ctx, parent, parentOrigin, l, name, {
    x: l.box.x + pad, y: l.box.y + pad,
    w: l.box.w - pad * 2, h: l.box.h - pad * 2,
  }, String(l.text || ''));
}

/**
 * Build the NODE_CHANGES message for a doc: DOCUMENT → CANVAS → FRAME(canvas-sized) → the
 * scene tree (groups → FRAMEs with resizeToFit, coordinates parent-relative throughout).
 * Pure function — image bytes are passed in, already fetched and hashed.
 */
export function buildFigmaMessage(
  doc: DesignDoc,
  images: Map<string, FigImageInput>,
  cutoutBaked?: Set<string>,
): { meta: FigMeta; message: FigMessage } {
  const SESSION = 4747;
  let nextLocal = 1;
  const guid = (): FigGUID => ({ sessionID: SESSION, localID: nextLocal++ });
  // Which image layers carry BAKED cut-out bytes (crop + shape-as-alpha). When the caller loaded
  // images (copyForFigma), it passes the set the bake populated. Fall back to deriving it from the
  // doc — any image layer with a resolved crop whose bytes are present was baked as a cut-out — so
  // buildFigmaMessage stays correct even when called with a pre-built images map.
  const cutouts = cutoutBaked
    ?? new Set(collectImageLayers(doc.layers).filter((l) => cropOf(l.style) && images.has(l.id)).map((l) => l.id));

  const docGuid = { sessionID: 0, localID: 0 };
  const pageGuid = { sessionID: 0, localID: 1 };
  const frameGuid = guid();

  const nodes: FigNodeChange[] = [
    {
      guid: docGuid, phase: 'CREATED', type: 'DOCUMENT', name: 'Document',
      visible: true, opacity: 1, blendMode: 'PASS_THROUGH', transform: IDENTITY,
      mask: false, maskType: 'ALPHA',
    },
    {
      guid: pageGuid, phase: 'CREATED', parentIndex: { guid: docGuid, position: '!' },
      type: 'CANVAS', name: 'Page 1', visible: true, opacity: 1, blendMode: 'PASS_THROUGH',
      transform: IDENTITY, mask: false, maskType: 'ALPHA',
      backgroundOpacity: 1, backgroundEnabled: true, exportBackgroundDisabled: false,
    },
    {
      ...baseNode(frameGuid, pageGuid, 0),
      type: 'FRAME',
      name: doc.name || 'Design',
      size: { x: doc.canvas.w, y: doc.canvas.h },
      transform: IDENTITY,
      cornerRadius: 0,
      // raster.ts paints the canvas black under the layers — keep parity.
      fillPaints: [solidPaint('#000000')],
      frameMaskDisabled: false, // clip content, like the canvas does
      resizeToFit: false,
      exportBackgroundDisabled: false,
      cornerSmoothing: 0,
      containerSupportsFillStrokeAndCorners: true,
    },
  ];

  const ctx: EmitCtx = { nodes, blobs: [], images, cutoutBaked: cutouts, guid, counters: new Map() };
  emitChildren(ctx, frameGuid, { x: 0, y: 0 }, doc.layers);

  const fileKey = randomFileKey();
  const pasteID = Math.floor(Math.random() * 0x7fffffff);
  const message: FigMessage = {
    type: 'NODE_CHANGES',
    sessionID: 0,
    ackID: 0,
    pasteID,
    pasteFileKey: fileKey,
    pasteIsPartiallyOutsideEnclosingFrame: false,
    pastePageId: pageGuid,
    isCut: false,
    pasteEditorType: 'DESIGN',
    publishedAssetGuids: [],
    nodeChanges: nodes,
    blobs: ctx.blobs,
  };
  return { meta: { fileKey, pasteID, dataType: 'scene' }, message };
}

function randomFileKey(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 22; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

/**
 * Pure payload builder: message → clipboard HTML, with the roundtrip self-check baked in.
 * Throws on any encode/decode drift — callers fall back to SVG. Testable from node.
 */
export function buildFigmaClipboardHtml(
  doc: DesignDoc,
  images: Map<string, FigImageInput> = new Map(),
  cutoutBaked?: Set<string>,
): string {
  const { meta, message } = buildFigmaMessage(doc, images, cutoutBaked);
  const html = encodeFigmaClipboardHtml(meta, message);
  // Sanity roundtrip before the clipboard sees it — never copy an undecodable payload.
  const back = decodeFigmaClipboardHtml(html);
  if (back.message.nodeChanges.length !== message.nodeChanges.length) {
    throw new Error('roundtrip node count mismatch');
  }
  return html;
}

// ── browser-side image loading ───────────────────────────────────────────────────────────────────

function collectImageLayers(nodes: SceneNode[], out: Layer[] = []): Layer[] {
  for (const n of nodes) {
    if (n.hidden) continue;
    if (isGroup(n)) collectImageLayers(n.children, out);
    else if (n.type === 'image' && n.src) out.push(n);
  }
  return out;
}

/** style.pixelate (block size in px — see sceneGraph.ts LayerStyle.pixelate) has no Figma paint/
 *  effect equivalent, so — same principle as the layer-blur/backdrop-blur handling elsewhere in
 *  this file — we bake the mosaic into the exported PNG bytes rather than silently dropping the
 *  effect. Mirrors raster.ts pixelateSource: downscale-with-smoothing then upscale-without, at the
 *  layer's rendered box size so the block size reads the same as the in-app preview. */
async function pixelateBitmap(bmp: ImageBitmap, blockSize: number, boxW: number, boxH: number): Promise<Blob> {
  const w = Math.max(1, Math.round(boxW));
  const h = Math.max(1, Math.round(boxH));
  const block = Math.max(1, blockSize);
  const smallW = Math.max(1, Math.round(w / block));
  const smallH = Math.max(1, Math.round(h / block));
  const small = document.createElement('canvas');
  small.width = smallW; small.height = smallH;
  const sctx = small.getContext('2d')!;
  sctx.imageSmoothingEnabled = true;
  sctx.drawImage(bmp, 0, 0, smallW, smallH);
  const big = document.createElement('canvas');
  big.width = w; big.height = h;
  const bctx = big.getContext('2d')!;
  bctx.imageSmoothingEnabled = false;
  bctx.drawImage(small, 0, 0, w, h);
  return new Promise((resolve, reject) => {
    big.toBlob((out) => (out ? resolve(out) : reject(new Error('pixelate: toBlob failed'))), 'image/png');
  });
}

function pixelateOf(s: Layer['style']): number {
  const v = (s as FxStyle | undefined)?.pixelate;
  return typeof v === 'number' && v > 0 ? v : 0;
}

/** style.crop (cut-out) normalized, or null (identity/missing). */
function cropOf(s: Layer['style']): ImageCrop | null {
  return resolveCrop((s as (FxStyle & { crop?: ImageCrop }) | undefined)?.crop);
}

/** Corner radii for an image layer's box (px) — uniform `radius`, else per-corner, else 0. */
function imageCornerRadii(s: Layer['style']): [number, number, number, number] {
  const rc = (s as FxStyle | undefined)?.radiusCorners;
  if (Array.isArray(rc) && rc.length === 4) return [rc[0], rc[1], rc[2], rc[3]];
  const r = s?.radius || 0;
  return [r, r, r, r];
}

/** Trace the box's shape into a canvas path (for destination-in alpha masking): ellipse for a
 *  circular avatar, per-corner rounded rect for rounded UI, plain rect otherwise. Box coords are
 *  0,0,w,h (the baked cut-out canvas is box-sized). PARITY with the shape every other renderer
 *  clips the image to. */
function traceCutoutShape(ctx: CanvasRenderingContext2D, s: Layer['style'], w: number, h: number) {
  ctx.beginPath();
  if (s?.shapeKind === 'ellipse') {
    ctx.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    return;
  }
  const [tl, tr, br, bl] = imageCornerRadii(s).map((v) => Math.max(0, Math.min(v, w / 2, h / 2))) as [number, number, number, number];
  ctx.moveTo(tl, 0);
  ctx.arcTo(w, 0, w, h, tr);
  ctx.arcTo(w, h, 0, h, br);
  ctx.arcTo(0, h, 0, 0, bl);
  ctx.arcTo(0, 0, w, 0, tl);
  ctx.closePath();
}

/**
 * Bake a real transparent PNG of a cut-out: crop the SOURCE sub-rect into a box-sized canvas
 * (scaled to fill), optionally mosaic it (crop+pixelate combo), then apply the layer's shape as
 * ALPHA (destination-in) so a circular avatar exports as an actual circle, rounded UI as a rounded
 * rect, with correct transparency outside the shape. Mirrors the pixelate bake: Figma then gets a
 * correct standalone cut-out as the image fill, NOT a raw uncropped square. Same principle used by
 * raster.ts (drawImage src-rect + ctx.clip) and designSvg.ts (cropDataUrl) — this just also bakes
 * the mask into alpha because a Figma image fill can't carry an arbitrary clip of its own.
 */
async function cutoutBitmap(
  bmp: ImageBitmap, crop: ImageCrop, s: Layer['style'], boxW: number, boxH: number,
): Promise<Blob> {
  const w = Math.max(1, Math.round(boxW));
  const h = Math.max(1, Math.round(boxH));
  const sx = crop.x * bmp.width;
  const sy = crop.y * bmp.height;
  const sw = Math.max(1, crop.w * bmp.width);
  const sh = Math.max(1, crop.h * bmp.height);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const pixelate = pixelateOf(s);
  if (pixelate > 0) {
    // Crop → mosaic (downscale-with-smoothing, upscale-without) → then draw box-sized.
    const block = Math.max(1, pixelate);
    const smallW = Math.max(1, Math.round(w / block));
    const smallH = Math.max(1, Math.round(h / block));
    const small = document.createElement('canvas');
    small.width = smallW; small.height = smallH;
    const sctx = small.getContext('2d')!;
    sctx.imageSmoothingEnabled = true;
    sctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, smallW, smallH);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(small, 0, 0, w, h);
    ctx.imageSmoothingEnabled = true;
  } else {
    ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, w, h);
  }
  // Apply the shape as alpha: keep only pixels inside the traced shape.
  ctx.globalCompositeOperation = 'destination-in';
  ctx.fillStyle = '#000';
  traceCutoutShape(ctx, s, w, h);
  ctx.fill();
  ctx.globalCompositeOperation = 'source-over';
  return new Promise((resolve, reject) => {
    canvas.toBlob((out) => (out ? resolve(out) : reject(new Error('cutout: toBlob failed'))), 'image/png');
  });
}

/**
 * Load + bake ONE image layer into a FigImageInput, or return null if anything at all goes wrong.
 *
 * ROBUSTNESS CONTRACT (audit LAYER-27/28): this function NEVER throws and NEVER rejects. Every
 * failure mode — a thrown fetch (CORS, malformed URL, network abort), an HTTP-error response, a
 * corrupt blob that fails createImageBitmap, a crypto.digest failure — resolves to `null`. The
 * caller then simply omits the id from the images map, and emitSceneNode's existing "bytes missing"
 * branch draws a labeled placeholder rectangle for exactly that one layer. One bad image must never
 * reject loadImageInputs and silently degrade the WHOLE doc to the SVG fallback.
 *
 * Exported for direct unit testing (the full copyForFigma path can't run headless — no real fetch /
 * createImageBitmap in Node).
 */
export async function loadOneImage(
  l: Layer,
  cutoutBaked?: Set<string>,
): Promise<FigImageInput | null> {
  try {
    // LAYER-27: wrap the fetch CALL itself, not just the response — a THROWN fetch (CORS / bad URL /
    // abort) must degrade this one image, not reject the whole build.
    let res: Response;
    try {
      res = await fetch(l.src!);
    } catch (err) {
      console.warn(`figmaClipboard: image fetch threw, using placeholder: ${l.src}`, err);
      return null;
    }
    if (!res.ok) {
      console.warn(`figmaClipboard: image fetch failed (${res.status}): ${l.src}`);
      return null;
    }
    let blob = await res.blob();
    const crop = cropOf(l.style);
    const pixelate = pixelateOf(l.style);
    if (crop) {
      // Cut-out: bake a real transparent PNG (crop + shape-as-alpha, + pixelate if set) so Figma
      // gets a correct standalone cutout, not a raw uncropped square. The emitted node then uses a
      // plain rect + FILL (see the image branch in emitSceneNode) — the alpha carries the shape.
      try {
        const srcBmp = await createImageBitmap(blob);
        blob = await cutoutBitmap(srcBmp, crop, l.style, l.box.w, l.box.h);
        srcBmp.close();
        cutoutBaked?.add(l.id);
      } catch (err) {
        console.warn('figmaClipboard: cutout bake failed, using sharp image', err);
      }
    } else if (pixelate > 0) {
      try {
        const srcBmp = await createImageBitmap(blob);
        blob = await pixelateBitmap(srcBmp, pixelate, l.box.w, l.box.h);
        srcBmp.close();
      } catch (err) {
        console.warn('figmaClipboard: pixelate bake failed, using sharp image', err);
      }
    }
    // LAYER-28: the final bytes/hash/bmp construction runs for EVERY image (not just crop/pixelate)
    // and can throw on a corrupt blob (createImageBitmap) or a crypto failure. Wrap it so that one
    // image degrades to the placeholder instead of nuking the whole doc to SVG.
    try {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const hash = new Uint8Array(await crypto.subtle.digest('SHA-1', bytes));
      const bmp = await createImageBitmap(blob);
      const input: FigImageInput = { bytes, hash, width: bmp.width, height: bmp.height };
      bmp.close();
      return input;
    } catch (err) {
      console.warn(`figmaClipboard: image decode/hash failed, using placeholder: ${l.src}`, err);
      return null;
    }
  } catch (err) {
    // Belt-and-braces: any unforeseen throw still degrades this one image, never the whole doc.
    console.warn(`figmaClipboard: image load failed, using placeholder: ${l.src}`, err);
    return null;
  }
}

async function loadImageInputs(
  doc: DesignDoc,
  cutoutBaked?: Set<string>,
): Promise<Map<string, FigImageInput>> {
  const out = new Map<string, FigImageInput>();
  for (const l of collectImageLayers(doc.layers)) {
    const input = await loadOneImage(l, cutoutBaked);
    if (input) out.set(l.id, input);
  }
  return out;
}

// ── public API ───────────────────────────────────────────────────────────────────────────────────

/** Build the native Figma clipboard HTML, or fall back to SVG-as-html. NEVER throws — resolves to
 *  the best payload we can produce, tagging which method won so the caller can report it. */
async function buildBestFigmaHtml(doc: DesignDoc): Promise<{ html: string; method: 'figma-native' | 'svg'; svg: string }> {
  let svg = '';
  try {
    const cutoutBaked = new Set<string>();
    const images = await loadImageInputs(doc, cutoutBaked);
    const html = buildFigmaClipboardHtml(doc, images, cutoutBaked);
    // Pre-build the SVG too so the plaintext part of the same ClipboardItem is always populated.
    svg = await designToSvg(doc).catch(() => '');
    return { html, method: 'figma-native', svg };
  } catch (err) {
    console.warn('figmaClipboard: native path failed, falling back to SVG', err);
  }
  svg = await designToSvg(doc);
  return { html: svg, method: 'svg', svg };
}

/**
 * Copy the doc for pasting into Figma. Writes the native payload (real layers on ⌘V) with an SVG
 * fallback baked into the SAME ClipboardItem, so Figma pastes native nodes while other targets
 * still get the vector markup.
 *
 * GESTURE SAFETY: the clipboard write MUST begin inside the user gesture. Awaiting image fetches /
 * doc saves BEFORE navigator.clipboard.write() drops the gesture in Safari & Firefox (and Chrome
 * under load), so the write is silently rejected — the classic "Copy to Figma sometimes does
 * nothing". We therefore hand ClipboardItem a PROMISE for each part: the browser holds the gesture
 * open while the payload builds. Callers MUST invoke this synchronously from the click handler
 * (do NOT await anything, e.g. a network save, before it).
 */
export async function copyForFigma(doc: DesignDoc): Promise<FigmaCopyResult> {
  // Kick off the (async) payload build, but hand its result to ClipboardItem as promises so the
  // write is REGISTERED synchronously within the gesture.
  const built = buildBestFigmaHtml(doc);
  const htmlBlob = built.then((b) => new Blob([b.html], { type: 'text/html' }));
  const textBlob = built.then((b) => new Blob([b.svg || b.html], { type: 'text/plain' }));

  try {
    await navigator.clipboard.write([
      // text/html carries the native Figma payload (or SVG markup); text/plain carries the SVG so
      // non-Figma paste targets get something useful. Figma prefers text/html → native layers.
      new ClipboardItem({ 'text/html': htmlBlob, 'text/plain': textBlob }),
    ]);
    const { method } = await built;
    return method === 'figma-native'
      ? { method, ok: true, detail: 'native Figma layers' }
      : { method, ok: true, detail: 'SVG — paste as editable vector layers' };
  } catch (err) {
    // ClipboardItem-with-promises isn't universally supported (older Firefox). Retry the eager
    // path: await the payload, then write a plain Blob. Loses gesture safety but is a last resort.
    console.warn('figmaClipboard: promise-based clipboard write failed, retrying eagerly', err);
    try {
      const b = await built;
      await navigator.clipboard.write([
        new ClipboardItem({ 'text/html': new Blob([b.html], { type: 'text/html' }) }),
      ]);
      return b.method === 'figma-native'
        ? { method: 'figma-native', ok: true, detail: 'native Figma layers' }
        : { method: 'svg', ok: true, detail: 'SVG — paste as editable vector layers' };
    } catch (err2) {
      // Final fallback: writeText with the SVG.
      try {
        const b = await built;
        await navigator.clipboard.writeText(b.svg || b.html);
        return { method: 'svg', ok: true, detail: 'SVG — paste as editable vector layers' };
      } catch (err3) {
        return { method: 'svg', ok: false, detail: `copy failed: ${err3 instanceof Error ? err3.message : String(err3)}` };
      }
    }
  }
}
