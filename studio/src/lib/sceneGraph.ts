// sceneGraph.ts — the Design mode document model (v3, nested + Figma-fidelity).
//
// A design ("comp") is a JSON scene graph: a fixed-size canvas + a TREE of nodes (bottom → top
// paint order). Leaf layers are absolutely positioned boxes; groups are Figma-style containers
// that hold layers AND other groups. Child coordinates stay ABSOLUTE (canvas space) — a group is
// purely a selection/opacity/ordering construct, so every renderer's geometry math is unchanged
// and a group's own box is just the cached bounding box of its children (normalizeGroups).
//
// Five renderers stay in parity over this contract: the Stage DOM editor, raster.ts (canvas→PNG),
// designSvg.ts, the server's renderDesignHtml, and figmaClipboard.ts (native Figma paste — both
// directions; Figma-only properties we can't render ride along losslessly in `figma`).
//
// v3 over v2: groups (full nesting), auto-height text (autoH — text can never clip), real
// gradient fills (angle + stops; legacy 'to-top'/'to-bottom' strings stay valid forever via
// resolveGradient), vignette as a first-class layer type, stroke/effects, workspace brand.

export type LayerType = 'image' | 'text' | 'badge' | 'button' | 'shape' | 'vignette';

export interface LayerBox { x: number; y: number; w: number; h: number }

export interface GradientStop { color: string; pos: number } // pos 0..1
export interface GradientFill {
  type: 'linear' | 'radial';
  /** CSS convention: degrees, 0 = to top, 90 = to right. Linear only. */
  angle?: number;
  stops: GradientStop[];
}

/** Shape primitives beyond the rounded rect — the vocabulary real statics are built from:
 *  ellipse (photo circles, dots), starburst (discount badges), arrow/line (callout annotations). */
export type ShapeKind = 'rect' | 'ellipse' | 'starburst' | 'arrow' | 'line' | 'polyline';

export interface LayerStyle {
  fontSize?: number;        // px at canvas scale
  fontWeight?: number;
  /** Best-effort font override (brand kits). Falls back to the app stack when not loaded. */
  fontFamily?: string;
  color?: string;           // any CSS color
  background?: string;      // fill behind text / badge / button; the fill of a shape
  radius?: number;          // px corner radius
  align?: 'left' | 'center' | 'right';
  lineHeight?: number;      // unitless multiplier
  padding?: number;         // px inner padding
  shadow?: boolean;         // soft drop shadow for legibility over photos
  uppercase?: boolean;
  /** text: line-through (the €19 → €11 price treatment). */
  strikethrough?: boolean;
  /** shapes: which primitive to draw (default 'rect'). starburst uses `spikes` (default 12);
   *  arrow/line draw along the box diagonal — `flipDiag` mirrors it. */
  shapeKind?: ShapeKind;
  spikes?: number;
  flipDiag?: boolean;
  /** @deprecated Glass removed 2026-07 — raster/SVG could only fake it, so exports lied about
   *  the DOM preview. Kept in the type so old docs/Figma imports parse; designstore's
   *  load-time migration strips it (→ solid fill at ~85% opacity). No UI or agent sets it. */
  backdropBlur?: number;
  opacity?: number;         // 0..1, whole-layer
  letterSpacing?: number;   // px at canvas scale
  /** Fill fade. Legacy strings ('to-top' = solid at bottom fading up) are normalized by
   *  resolveGradient — never branch on the raw union outside that function. */
  gradient?: 'to-top' | 'to-bottom' | GradientFill | null;
  /** text only: Instagram-caption style — every wrapped LINE hugs its own rounded background
   *  pill (box-decoration-break in DOM; per-line rects in raster/SVG/Figma exports). */
  pill?: boolean;
  /** vignette layers: edge darkening. strength = max alpha at the edge, size = clear inner
   *  radius fraction (0..1). Color comes from `background` (default #000). */
  vignette?: { strength: number; size: number };
  /** shapeKind 'polyline': vertices as a FLAT list of x,y pairs normalized 0..1 within the
   *  layer's box (0,0 = box top-left). Stroked with background||color at stroke.width. */
  points?: number[];
  /** Reserved: an SVG path string for future freeform shapes. No renderer reads it yet. */
  path?: string;
  /** Blend mode — restricted 2026-07 to the three that read well and map 1:1 across CSS,
   *  canvas, SVG and Figma. Old docs with other modes migrate to normal on load. */
  blend?: 'normal' | 'multiply' | 'screen' | 'overlay';
  /** LAYER blur in px (blurs the layer itself — blurred avatars, glows). Distinct from
   *  backdropBlur (frosted glass behind the layer). */
  blur?: number;
  /** Mosaic pixelation block size in px (real censoring effect on an image layer's actual
   *  pixels — box-downscale then nearest-neighbor upscale — distinct from the soft `blur`
   *  above). Applies to `type:'image'` layers with a real src. */
  pixelate?: number;
  /** Per-corner radius override [tl, tr, br, bl] — wins over `radius` when set. */
  radiusCorners?: [number, number, number, number];
  /** Border (Figma stroke). Rendered center-aligned in all renderers. */
  stroke?: { color: string; width: number };
  /** Figma-style effects we can render. Anything richer survives via Layer.figma. */
  effects?: { type: 'drop-shadow' | 'blur'; color?: string; blur?: number; x?: number; y?: number }[];
}

export interface Layer {
  id: string;
  type: LayerType;
  /** Semantic role — agents, skeletons and fill-from-brief address layers by role. */
  role?: 'base' | 'headline' | 'subhead' | 'caption' | 'badge' | 'cta' | 'logo' | 'price' | string;
  /** Display name in the layers panel (defaults to role/type). */
  name?: string;
  /** Locked layers can't be selected/moved on the canvas (panel still edits them). */
  locked?: boolean;
  /** image layers: same-origin src (/img?path=…, /api/trendtrack/image/…, /refasset?id=…). */
  src?: string;
  fit?: 'cover' | 'contain';
  /** text/badge/button layers */
  text?: string;
  box: LayerBox;
  /** Degrees clockwise about the box center. All renderers + Figma honor it. */
  rotation?: number;
  style?: LayerStyle;
  hidden?: boolean;
  /** text-ish layers: box.h is derived from wrapped content (re-measured on edit) so text
   *  never clips. Stored h stays ≥ content, so non-DOM renderers need no measurement.
   *  Default true for NEW layers; undefined on migrated v2 docs (pixel-identical). */
  autoH?: boolean;
  /** Reserved: marks this layer as a mask for its siblings. Field only — NO renderer or
   *  editor behavior is attached yet; adding it now keeps docs forward-compatible. */
  isMask?: boolean;
  /** Parametric-element provenance: which lib/elements.mjs def built this node and with what
   *  coerced params — lets agents/UI re-open and re-build an instance. */
  element?: { id: string; params: Record<string, unknown>; v: 1 };
  /** Lossless passthrough of Figma-only node properties from a Figma paste (exotic fills,
   *  effects, strokes, component refs …). Untouched by the editor; re-emitted on copy-back. */
  figma?: unknown;
}

/** Figma-style group: contains layers and other groups, full nesting. Child boxes are ABSOLUTE
 *  canvas coordinates; `box` is the cached bounding box of visible children (normalizeGroups). */
export interface GroupNode {
  id: string;
  type: 'group';
  name?: string;
  role?: string;
  locked?: boolean;
  hidden?: boolean;
  box: LayerBox;
  children: SceneNode[];
  /** Clipping frame: children render clipped to this box (+ style.radius). Exports as a real
   *  Figma frame. Without it a group is selection/opacity/ordering only. */
  clip?: boolean;
  style?: { opacity?: number; radius?: number };
  /** Parametric-element provenance (see Layer.element) — stamped on multi-layer instances. */
  element?: { id: string; params: Record<string, unknown>; v: 1 };
  figma?: unknown;
}

/** Groundwork for the "native component" architecture (lib/native-components/*.mjs): a preset
 *  like the X/Twitter Post chrome authored as real browser-laid-out HTML/CSS (flexbox/grid) —
 *  the browser computes child geometry, so this node carries only the outer `box` (where the
 *  component sits on the canvas) plus the `params` that drove its render, NOT a hand-positioned
 *  layer tree. `component` names the render function's key (e.g. 'x-post' → renderXPost in
 *  lib/native-components/x-post.mjs). Purely additive: no renderer/editor consumes this yet —
 *  wiring it into the Stage/raster/SVG/Figma renderers and the layers panel is later work.
 *  Once a capture step exists (see native-components/README.md) it may also carry a snapshot of
 *  captured child geometry for renderers that can't run the component's own HTML/CSS. */
export interface ComponentLayer {
  id: string;
  type: 'component';
  /** Which lib/native-components/*.mjs render function produced this (e.g. 'x-post'). */
  component: string;
  /** Display name in the layers panel (defaults to component id). */
  name?: string;
  role?: string;
  locked?: boolean;
  hidden?: boolean;
  /** Outer placement on the canvas — the component's OWN markup lays out everything inside it. */
  box: LayerBox;
  rotation?: number;
  /** The params object passed to the component's render(params) => {html, css} function. */
  params: Record<string, unknown>;
  /** Optional: captured per-element geometry/styles from a future browser-side capture step,
   *  keyed by the element's data-role. No renderer reads this yet. */
  capture?: Record<string, unknown>;
  figma?: unknown;
}

export type SceneNode = Layer | GroupNode | ComponentLayer;

export function isGroup(n: SceneNode): n is GroupNode {
  return n.type === 'group';
}

export function isComponent(n: SceneNode): n is ComponentLayer {
  return n.type === 'component';
}

/** Where a comp's reference (the ad being copied) came from. `url` is a same-origin image URL
 *  the editor can render as underlay / side-by-side. */
export interface DesignReference {
  kind: 'trendtrack' | 'upload' | 'render' | 'figma';
  ref: string;   // ad id / upload id / relPath
  url: string;
  label?: string;
}

/** Which ad/variation this comp serves (drives fill-from-brief + export naming). */
export interface DesignLink { brand: string; batch: string; ad: string; variation?: string }

export interface DesignDoc {
  id: string;
  name: string;
  canvas: { w: number; h: number };
  /** Canvas background paint — shown wherever no layer covers the frame. Any CSS color;
   *  defaults to '#000000' (what the renderers hardcoded before this field existed). */
  canvasBg?: string;
  layers: SceneNode[];
  /** Workspace this comp belongs to (null on legacy docs = visible everywhere). */
  brand?: string | null;
  reference?: DesignReference | null;
  link?: DesignLink | null;
  /** Skeleton this comp was built from, when any. */
  skeletonId?: string | null;
  adType?: 'native' | 'static' | 'offer' | 'carousel' | 'ugc' | 'face';
  /** Provenance of the BASE image. */
  source?: { kind: 'render' | 'trendtrack' | 'upload' | 'figma'; ref: string } | null;
  /** Free-form organizing tags (server sanitizes: ≤12 tags, ≤32 chars each). */
  tags?: string[];
  createdAt: number;
  updatedAt: number;
  schemaVersion?: 3;
}

/** A reusable layout: overlay nodes only (no base image), in canonical 1080-wide coords,
 *  with the reference ad it was extracted from. */
export interface Skeleton {
  id: string;
  name: string;
  canvas: { w: number; h: number };   // the canvas the coords were authored against
  layers: SceneNode[];                 // no role:'base' layer
  brand?: string | null;
  sourceRef?: DesignReference | null;  // the ad this layout came from
  extractedBy?: 'codex' | 'vision' | 'manual' | 'figma';
  /** extraction v2+: classified ad archetype (story-native | x-post | comparison | …). */
  archetype?: string;
  /** extraction v3: the reference's own background — a solid hex or a gradient — so a comp can
   *  be created straight from the reference with no base-image step. null when it's a photo. */
  background?: string | { from: string; to: string; angle: number } | null;
  createdAt: number;
}

// ── migration ────────────────────────────────────────────────────────────────────────────────────

/** One-way v2 → v3 on load. A flat v2 Layer[] is already a valid SceneNode[] (a tree with no
 *  groups); legacy gradient strings stay valid in the union; autoH stays undefined so migrated
 *  docs render pixel-identically. Cheap and idempotent — safe to call on every load. */
export function migrateDoc<T extends { schemaVersion?: number }>(raw: T): T & { schemaVersion: 3 } {
  return { ...raw, schemaVersion: 3 };
}

// ── gradients ────────────────────────────────────────────────────────────────────────────────────

/** Normalize the gradient union. Legacy 'to-top' (solid at BOTTOM, fading up — see raster.ts)
 *  becomes angle 0 with the solid color at pos 1; 'to-bottom' mirrors it. Renderers only ever
 *  see GradientFill. */
export function resolveGradient(s: LayerStyle | undefined): GradientFill | null {
  const g = s?.gradient;
  if (!g) return null;
  if (typeof g === 'object') return g.stops?.length ? g : null;
  const c = s?.background || '#000000';
  return g === 'to-top'
    ? { type: 'linear', angle: 0, stops: [{ color: c, pos: 0 }, { color: 'transparent', pos: 1 }] }
    : { type: 'linear', angle: 180, stops: [{ color: c, pos: 0 }, { color: 'transparent', pos: 1 }] };
  // NOTE angle semantics: 0deg = "to top" — stops run bottom→top, so solid-at-bottom means
  // the SOLID stop sits at pos 0. Parity-checked against raster.ts drawShape.
}

// ── validation ───────────────────────────────────────────────────────────────────────────────────

const LAYER_TYPES: LayerType[] = ['image', 'text', 'badge', 'button', 'shape', 'vignette'];

/** Validate a candidate doc (agent / extractor / import / Figma paste). Returns problems —
 *  empty means valid. Never throws; unknown extra fields are tolerated. Recursive over groups. */
export function validateDesign(doc: unknown): string[] {
  const errs: string[] = [];
  const d = doc as Partial<DesignDoc> | null;
  if (!d || typeof d !== 'object') return ['not an object'];
  if (!d.id) errs.push('missing id');
  if (!d.canvas || !(Number(d.canvas.w) > 0) || !(Number(d.canvas.h) > 0)) errs.push('bad canvas');
  if (!Array.isArray(d.layers)) { errs.push('layers must be an array'); return errs; }
  const checkNodes = (nodes: unknown[], path: string, depth: number) => {
    if (depth > 12) { errs.push(`${path}: nesting too deep`); return; }
    nodes.forEach((n, i) => {
      const node = n as Partial<SceneNode> | null;
      const at = `${path}[${i}]`;
      if (!node || typeof node !== 'object') { errs.push(`${at}: not an object`); return; }
      if (!node.id) errs.push(`${at}: missing id`);
      const b = node.box;
      if (!b || [b.x, b.y, b.w, b.h].some((v) => !Number.isFinite(Number(v)))) errs.push(`${at}: bad box`);
      if (node.type === 'group') {
        const g = node as Partial<GroupNode>;
        if (!Array.isArray(g.children)) errs.push(`${at}: group without children array`);
        else checkNodes(g.children, `${at}.children`, depth + 1);
        return;
      }
      if (!LAYER_TYPES.includes(node.type as LayerType)) errs.push(`${at}: bad type "${node.type}"`);
      if (node.type === 'image' && !(node as Partial<Layer>).src) errs.push(`${at}: image without src`);
    });
  };
  checkNodes(d.layers, 'layer', 0);
  return errs;
}

// ── construction ─────────────────────────────────────────────────────────────────────────────────

let seq = 0;
export function layerId(prefix = 'layer'): string {
  return `${prefix}-${Date.now().toString(36)}-${(seq++).toString(36)}`;
}

export function designId(): string {
  return `comp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Canvas size presets — the three formats ads actually ship in. */
export const CANVAS_PRESETS = [
  { id: 'square', name: '1:1 · IG feed', w: 1080, h: 1080 },
  { id: 'portrait', name: '4:5 · IG feed', w: 1080, h: 1350 },
  { id: 'story', name: '9:16 · IG story', w: 1080, h: 1920 },
] as const;
export type CanvasPresetId = (typeof CANVAS_PRESETS)[number]['id'];

/** Lookup preset by id or aspect nickname. */
export function canvasPreset(id: CanvasPresetId | 'ig-square' | 'ig-portrait' | 'ig-story') {
  const map: Record<string, CanvasPresetId> = {
    'ig-square': 'square', 'ig-portrait': 'portrait', 'ig-story': 'story',
  };
  const pid = (map[id] || id) as CanvasPresetId;
  return CANVAS_PRESETS.find((p) => p.id === pid) || CANVAS_PRESETS[0];
}

export function baseImageLayer(src: string, canvas: { w: number; h: number }): Layer {
  // "color:#hex" = SOLID base; "gradient:#from|#to|angle" = GRADIENT base (auto-detected from
  // references) — no image required; the frame stays editable in the top strip.
  const solid = /^color:(#[0-9a-fA-F]{3,8})$/.exec(src);
  if (solid) {
    return {
      id: layerId('base'), type: 'shape', role: 'base', name: 'Base color',
      box: { x: 0, y: 0, w: canvas.w, h: canvas.h },
      style: { background: solid[1] },
    };
  }
  const grad = /^gradient:(#[0-9a-fA-F]{3,8})\|(#[0-9a-fA-F]{3,8})\|(\d+)$/.exec(src);
  if (grad) {
    return {
      id: layerId('base'), type: 'shape', role: 'base', name: 'Base gradient',
      box: { x: 0, y: 0, w: canvas.w, h: canvas.h },
      style: {
        background: grad[1],
        gradient: { type: 'linear', angle: Number(grad[3]), stops: [{ color: grad[1], pos: 0 }, { color: grad[2], pos: 1 }] },
      },
    };
  }
  return {
    id: layerId('base'), type: 'image', role: 'base', name: 'Base image',
    src, fit: 'cover', box: { x: 0, y: 0, w: canvas.w, h: canvas.h },
  };
}

/** A blank comp: just the base image. Layers come from a skeleton, elements, or by hand. */
export function buildBlankDoc(
  src: string,
  canvas: { w: number; h: number },
  extras: Partial<Pick<DesignDoc, 'name' | 'brand' | 'reference' | 'link' | 'source' | 'adType'>> = {},
): DesignDoc {
  const now = Date.now();
  return {
    id: designId(),
    name: extras.name || 'Untitled comp',
    canvas: { ...canvas },
    layers: [baseImageLayer(src, canvas)],
    brand: extras.brand ?? null,
    reference: extras.reference ?? null,
    link: extras.link ?? null,
    skeletonId: null,
    adType: extras.adType,
    source: extras.source ?? null,
    createdAt: now,
    updatedAt: now,
    schemaVersion: 3,
  };
}

// ── scaling (leaf-walking; groups get their cached boxes refreshed by the caller) ───────────────

/** Scale a box authored on `from` canvas onto `to` canvas (proportional per axis). */
function scaleBox(b: LayerBox, from: { w: number; h: number }, to: { w: number; h: number }): LayerBox {
  const sx = to.w / from.w;
  const sy = to.h / from.h;
  return {
    x: Math.round(b.x * sx), y: Math.round(b.y * sy),
    w: Math.round(b.w * sx), h: Math.round(b.h * sy),
  };
}

/** Scale typographic metrics by a width ratio (the shared recipe for canvas + group resize). */
export function scaleStyle(style: LayerStyle | undefined, sx: number): LayerStyle | undefined {
  if (!style) return style;
  return {
    ...style,
    fontSize: style.fontSize ? Math.round(style.fontSize * sx) : style.fontSize,
    radius: style.radius ? Math.round(style.radius * sx) : style.radius,
    padding: style.padding ? Math.round(style.padding * sx) : style.padding,
    letterSpacing: style.letterSpacing ? Math.round(style.letterSpacing * sx * 10) / 10 : style.letterSpacing,
    stroke: style.stroke ? { ...style.stroke, width: Math.max(1, Math.round(style.stroke.width * sx)) } : style.stroke,
  };
}

/** Map every node in a tree (leaves AND groups) through `fn`, recursing into children. */
function mapTree(nodes: SceneNode[], fn: (n: SceneNode) => SceneNode): SceneNode[] {
  return nodes.map((n) => {
    const mapped = fn(n);
    if (isGroup(mapped)) return { ...mapped, children: mapTree(mapped.children, fn) };
    return mapped;
  });
}

/** Re-target a doc to a new canvas size (the 1:1/4:5/9:16 preset switch): boxes scale per
 *  axis, typographic metrics scale with width, the base image re-covers the full canvas.
 *  Caller re-measures autoH text + clamps + normalizes groups (Editor commit path). */
export function resizeDocCanvas(doc: DesignDoc, to: { w: number; h: number }): DesignDoc {
  const from = doc.canvas;
  if (from.w === to.w && from.h === to.h) return doc;
  const sx = to.w / from.w;
  const layers = mapTree(doc.layers, (n) => {
    const copy = { ...n };
    copy.box = !isGroup(n) && !isComponent(n) && n.role === 'base' ? { x: 0, y: 0, w: to.w, h: to.h } : scaleBox(n.box, from, to);
    // ComponentLayer has no `style` (its own HTML/CSS owns typography) — not wired up yet either
    // way, so just leave it unscaled here (box scaling above still applies to its outer frame).
    if (!isGroup(copy) && !isComponent(copy)) copy.style = scaleStyle(copy.style, sx);
    return copy;
  });
  return { ...doc, canvas: { ...to }, layers, updatedAt: Date.now() };
}

/** Apply a skeleton's overlay nodes onto a doc (fresh ids; boxes + type scale to the doc's
 *  canvas; existing overlay layers are REPLACED, base stays). */
export function applySkeleton(doc: DesignDoc, skeleton: Skeleton): DesignDoc {
  const s = Math.min(doc.canvas.w / skeleton.canvas.w, doc.canvas.h / skeleton.canvas.h);
  const fresh = mapTree(
    JSON.parse(JSON.stringify(skeleton.layers)) as SceneNode[],
    (n) => {
      const copy = { ...n, id: layerId(n.role || n.type) };
      copy.box = scaleBox(n.box, skeleton.canvas, doc.canvas);
      // ComponentLayer has no `style`/`autoH` — skeletons don't emit these yet anyway (purely
      // additive groundwork), so just skip the typographic-scale step for them.
      if (!isGroup(copy) && !isComponent(copy)) {
        copy.style = scaleStyle(copy.style, s);
        // Text layers from extraction/skeletons need autoH so copy never clips before Editor opens.
        if (copy.type === 'text' || copy.type === 'badge' || copy.type === 'button') copy.autoH = true;
      }
      return copy;
    },
  ).filter((n) => isGroup(n) || n.role !== 'base');
  return {
    ...doc,
    layers: [...doc.layers.filter((l) => !isGroup(l) && l.role === 'base'), ...fresh],
    skeletonId: skeleton.id,
    updatedAt: Date.now(),
  };
}

/** Extract a comp's overlay nodes as a reusable skeleton. */
export function skeletonFromDoc(doc: DesignDoc, name?: string): Skeleton {
  return {
    id: `skel_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name: name || `${doc.name} layout`,
    canvas: { ...doc.canvas },
    layers: JSON.parse(JSON.stringify(doc.layers.filter((l) => isGroup(l) || l.role !== 'base'))),
    brand: doc.brand ?? null,
    sourceRef: doc.reference ?? null,
    extractedBy: 'manual',
    createdAt: Date.now(),
  };
}

/** Same design, new base image — the batch-apply primitive. */
export function duplicateForImage(
  doc: DesignDoc,
  src: string,
  source: DesignDoc['source'],
  name?: string,
): DesignDoc {
  const copy = JSON.parse(JSON.stringify(doc)) as DesignDoc;
  copy.id = designId();
  copy.name = name || doc.name;
  copy.source = source ?? null;
  copy.createdAt = Date.now();
  copy.updatedAt = Date.now();
  const base = copy.layers.find((l): l is Layer => !isGroup(l) && l.role === 'base');
  if (base) base.src = src;
  else copy.layers.unshift(baseImageLayer(src, copy.canvas));
  return copy;
}
