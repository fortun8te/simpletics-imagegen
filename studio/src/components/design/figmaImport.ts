// figmaImport.ts — paste FROM Figma: decode the native clipboard payload back into scene-graph
// v3 nodes. Inverse of figmaClipboard.ts.
//
// Figma's clipboard is text/html carrying two base64 spans — (figmeta) JSON and (figma), a
// fig-kiwi archive (see src/vendor/figma-kiwi). We decode the NODE_CHANGES message, rebuild the
// tree from parentIndex.{guid,position} (fractional-index strings, lexicographic order), and
// map node types onto our layers. Everything we can't render rides along in `layer.figma` and
// is merged back on the next copy-to-Figma, so a Figma → tool → Figma trip is near-lossless.
//
// Mapping (Figma → v3):
//   FRAME / GROUP / SECTION / COMPONENT / INSTANCE → GroupNode (visible frame fill becomes a
//     leading bg shape layer, since our groups have no fill of their own)
//   TEXT → text Layer (fontSize, weight from fontName.style, fills[0] → color, align,
//     textAutoResize HEIGHT → autoH, textCase UPPER → uppercase, lineHeight)
//   RECTANGLE / ROUNDED_RECTANGLE / ELLIPSE / STAR → shape Layer (SOLID → background,
//     GRADIENT_LINEAR/RADIAL → GradientFill with the angle recovered from the paint transform,
//     cornerRadius → radius, strokes → stroke, ELLIPSE → shapeKind 'ellipse', STAR →
//     shapeKind 'starburst' + spikes from count); an IMAGE paint makes it an image Layer
//     instead (bytes returned separately — caller uploads and sets src; hash in figma.imageHash)
//   LINE → shape Layer with shapeKind 'line' (or 'arrow' when strokeCap is ARROW_*), box
//     rebuilt from the rotated segment endpoints
//   ROUNDED_RECTANGLE carrying our pluginData path entry (+ ' (path)' name suffix) → shape
//     Layer with shapeKind 'path' + style.path restored (inverse of the export fallback)
//   rotation: transform matrices decode back to Layer.rotation (degrees clockwise about the
//     box center); textDecoration STRIKETHROUGH → strikethrough; fontName.family → fontFamily;
//     BACKGROUND_BLUR effects → backdropBlur
//   everything else (VECTOR, BOOLEAN_OPERATION, …) → locked placeholder shape.
//
// Coordinates come back ABSOLUTE (canvas space) by accumulating parent m02/m12 — group children
// in our model are absolute (see sceneGraph.ts).

import {
  layerId,
  type GradientFill,
  type GroupNode,
  type Layer,
  type LayerStyle,
  type SceneNode,
} from '../../lib/sceneGraph';
import {
  decodeFigmaClipboardHtml,
  type FigColor,
  type FigMatrix,
  type FigNodeChange,
} from '../../vendor/figma-kiwi';
import {
  angleFromGradientTransform,
  BLEND_TO_FIGMA,
  FIGMA_PATH_PLUGIN_ID,
  FIGMA_PATH_PLUGIN_KEY,
  type BlendKeyword,
} from './figmaClipboard';

// ── effects/structure round: model fields that may not be in sceneGraph.ts yet (added
//    additively by a concurrent change) — typed locally, written defensively. ────────────────────

type FxStyle = LayerStyle & {
  blend?: BlendKeyword;
  blur?: number;
  radiusCorners?: [number, number, number, number];
};

type ClipGroup = GroupNode & { clip?: boolean };

/** Figma BlendMode → CSS blend keyword (inverse of BLEND_TO_FIGMA). */
const FIGMA_TO_BLEND: Record<string, BlendKeyword> = Object.fromEntries(
  (Object.entries(BLEND_TO_FIGMA) as Array<[BlendKeyword, string]>).map(([k, v]) => [v, k]),
) as Record<string, BlendKeyword>;

export interface FigmaImportResult {
  ok: boolean;
  nodes?: SceneNode[];
  canvas?: { w: number; h: number };
  name?: string;
  /** Embedded image fills: caller uploads bytes and sets src on layers whose
   *  `figma.imageHash` matches (see uploadFigmaImages + applyFigmaImageUrls). */
  images?: { hash: string; bytes: Uint8Array }[];
  error?: string;
}

/** Cheap check: does this clipboard HTML look like a Figma native payload? */
export function sniffFigmaClipboard(html: string | null): boolean {
  return !!html && html.includes('(figmeta)') && html.includes('(figma)');
}

// ── decoded-node helpers ─────────────────────────────────────────────────────────────────────────

type AnyNode = FigNodeChange & Record<string, unknown>;

function guidKey(g: unknown): string {
  const gg = g as { sessionID?: number; localID?: number } | undefined;
  return `${gg?.sessionID ?? -1}:${gg?.localID ?? -1}`;
}

function colorToCss(c: FigColor | undefined, opacity = 1): string {
  if (!c) return '#000000';
  const a = (c.a ?? 1) * opacity;
  const h = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');
  return a >= 0.999 ? `#${h(c.r)}${h(c.g)}${h(c.b)}` : `#${h(c.r)}${h(c.g)}${h(c.b)}${h(a)}`;
}

function firstVisiblePaint(node: AnyNode): Record<string, unknown> | null {
  const paints = node.fillPaints as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(paints)) return null;
  for (const p of paints) if (p && p.visible !== false) return p;
  return null;
}

function paintToFill(p: Record<string, unknown>): { background?: string; gradient?: GradientFill } {
  const t = p.type as string;
  if (t === 'SOLID') {
    return { background: colorToCss(p.color as FigColor, (p.opacity as number) ?? 1) };
  }
  if (t === 'GRADIENT_LINEAR' || t === 'GRADIENT_RADIAL') {
    const rawStops = (p.stops as Array<{ color: FigColor; position: number }>) || [];
    const stops = rawStops.map((s) => ({ color: colorToCss(s.color), pos: s.position ?? 0 }));
    if (!stops.length) return {};
    if (t === 'GRADIENT_RADIAL') return { gradient: { type: 'radial', stops } };
    return {
      gradient: {
        type: 'linear',
        angle: angleFromGradientTransform(p.transform as FigMatrix | undefined),
        stops,
      },
    };
  }
  return {};
}

const STYLE_WEIGHTS: Array<[string, number]> = [
  // longest names first so 'ExtraBold' doesn't match 'Bold'.
  ['extralight', 200], ['ultralight', 200], ['extrabold', 800], ['ultrabold', 800],
  ['semibold', 600], ['demibold', 600], ['thin', 100], ['light', 300], ['medium', 500],
  ['bold', 700], ['black', 900], ['heavy', 900], ['regular', 400], ['normal', 400],
];

function styleToWeight(node: AnyNode): number {
  if (typeof node.fontWeight === 'number') return node.fontWeight;
  // Figma style names carry spaces ('Semi Bold', 'Extra Light') — normalize them away so the
  // needle table matches (our own export emits the spaced forms).
  const style = String((node.fontName as { style?: string } | undefined)?.style || '')
    .toLowerCase().replace(/[\s-]+/g, '');
  for (const [needle, w] of STYLE_WEIGHTS) if (style.includes(needle)) return w;
  return 400;
}

// ── figma passthrough stash ──────────────────────────────────────────────────────────────────────

/** Keys we fully re-derive on export — dropping them keeps the stash from fighting geometry. */
const POSITIONAL = new Set([
  'guid', 'phase', 'parentIndex', 'transform', 'size', 'name', 'visible',
]);

/** JSON-safe deep copy: drops functions, huge byte arrays (image bytes travel separately),
 *  turns small Uint8Arrays (hashes) into hex strings. */
function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 8 || value == null) return value ?? undefined;
  const t = typeof value;
  if (t === 'function' || t === 'symbol') return undefined;
  if (t !== 'object') return value;
  if (value instanceof Uint8Array) return value.length <= 64 ? bytesToHex(value) : undefined;
  if (ArrayBuffer.isView(value)) return undefined;
  if (Array.isArray(value)) return value.map((v) => sanitize(v, depth + 1)).filter((v) => v !== undefined);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    // Blob indices are per-message — stale after import. dataBlob (image bytes) and
    // vectorNetworkBlob (VECTOR geometry) would point into the WRONG blobs array on
    // copy-back (our export blobs carry only images), so they never enter the stash.
    if (k === 'dataBlob' || k === 'vectorNetworkBlob') continue;
    const s = sanitize(v, depth + 1);
    if (s !== undefined) out[k] = s;
  }
  return out;
}

function bytesToHex(b: Uint8Array): string {
  let out = '';
  for (const v of b) out += v.toString(16).padStart(2, '0');
  return out;
}

function figmaStash(node: AnyNode, alsoDrop: string[] = []): Record<string, unknown> | undefined {
  const drop = new Set([...POSITIONAL, ...alsoDrop]);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (drop.has(k)) continue;
    const s = sanitize(v, 1);
    if (s !== undefined) out[k] = s;
  }
  return Object.keys(out).length ? out : undefined;
}

// ── tree rebuild ─────────────────────────────────────────────────────────────────────────────────

/** A frame's own visible fill (solid/gradient/image) as a bg layer — our groups carry no fill. */
function frameFillLayer(node: AnyNode, box: { x: number; y: number; w: number; h: number }, name?: string): Layer | null {
  const paint = firstVisiblePaint(node);
  if (!paint) return null;
  if (paint.type === 'IMAGE') {
    const img = paint.image as { hash?: Uint8Array | string } | undefined;
    const hash = img?.hash instanceof Uint8Array ? bytesToHex(img.hash) : String(img?.hash ?? '');
    return {
      id: layerId('image'), type: 'image', name: name ? `${name} bg` : 'Frame bg',
      src: '', fit: paint.imageScaleMode === 'FIT' ? 'contain' : 'cover',
      box: { ...box }, figma: { imageHash: hash },
    };
  }
  const fill = paintToFill(paint);
  if (!fill.background && !fill.gradient) return null;
  return {
    id: layerId('shape'), type: 'shape', name: name ? `${name} bg` : 'Frame bg',
    box: { ...box },
    style: { background: fill.background, gradient: fill.gradient ?? null, radius: Number(node.cornerRadius) || 0 },
  };
}

const GROUPISH = new Set(['FRAME', 'GROUP', 'SECTION', 'COMPONENT', 'INSTANCE', 'COMPONENT_SET']);
const SHAPEISH = new Set(['RECTANGLE', 'ROUNDED_RECTANGLE', 'ELLIPSE', 'STAR']);

interface DecodedTree {
  node: AnyNode;
  children: DecodedTree[];
}

function buildTrees(changes: FigNodeChange[]): DecodedTree[] {
  const byGuid = new Map<string, DecodedTree>();
  for (const n of changes) byGuid.set(guidKey(n.guid), { node: n as AnyNode, children: [] });
  const roots: DecodedTree[] = [];
  for (const t of byGuid.values()) {
    const type = String(t.node.type || '');
    if (type === 'DOCUMENT' || type === 'CANVAS') continue;
    const pi = t.node.parentIndex as { guid?: unknown; position?: string } | undefined;
    const parent = pi ? byGuid.get(guidKey(pi.guid)) : undefined;
    const parentType = parent ? String(parent.node.type || '') : '';
    if (parent && parentType !== 'DOCUMENT' && parentType !== 'CANVAS') parent.children.push(t);
    else roots.push(t);
  }
  const sortRec = (list: DecodedTree[]) => {
    list.sort((a, b) => {
      const pa = String((a.node.parentIndex as { position?: string } | undefined)?.position ?? '');
      const pb = String((b.node.parentIndex as { position?: string } | undefined)?.position ?? '');
      return pa < pb ? -1 : pa > pb ? 1 : 0;
    });
    for (const t of list) sortRec(t.children);
  };
  sortRec(roots);
  return roots;
}

/**
 * Recover box + rotation from a node transform. Inverse of figmaClipboard boxTransform:
 * θ = atan2(m10, m00) (degrees CLOCKWISE, y-down — CSS rotate parity); the matrix translation
 * is the ROTATED top-left, so the unrotated top-left is center − (w/2, h/2) where
 * center = (m02, m12) + R·(w/2, h/2). Sub-0.05° noise decodes as no rotation.
 */
function nodeBox(node: AnyNode, origin: { x: number; y: number }): {
  box: { x: number; y: number; w: number; h: number }; rotation?: number;
} {
  const tr = node.transform as FigMatrix | undefined;
  const size = node.size as { x?: number; y?: number } | undefined;
  const w = Math.round(Math.max(1, size?.x ?? 1));
  const h = Math.round(Math.max(1, size?.y ?? 1));
  const m00 = tr?.m00 ?? 1, m10 = tr?.m10 ?? 0;
  const deg = (Math.atan2(m10, m00) * 180) / Math.PI;
  if (Math.abs(deg) <= 0.05) {
    return { box: { x: Math.round(origin.x + (tr?.m02 ?? 0)), y: Math.round(origin.y + (tr?.m12 ?? 0)), w, h } };
  }
  // center = t + R·(w/2, h/2) with R = [[m00, m01],[m10, m11]]
  const centerX = origin.x + (tr?.m02 ?? 0) + m00 * (w / 2) + (tr?.m01 ?? 0) * (h / 2);
  const centerY = origin.y + (tr?.m12 ?? 0) + m10 * (w / 2) + (tr?.m11 ?? 1) * (h / 2);
  return {
    box: { x: Math.round(centerX - w / 2), y: Math.round(centerY - h / 2), w, h },
    rotation: Math.round(deg * 100) / 100,
  };
}

/** Fields the specific converters already consumed → excluded from the figma stash. */
const CONSUMED_COMMON = ['type', 'opacity', 'fillPaints', 'strokePaints', 'strokeWeight', 'locked'];

/** Extra consumed fields for LEAF layers (Layer.isMask captures these; groups keep them
 *  stashed since GroupNode has no isMask). */
const CONSUMED_MASK = ['mask', 'maskType'];

/** BACKGROUND_BLUR effect → style.backdropBlur; strips it from node.effects IN PLACE so the
 *  stash doesn't re-emit it on copy-back (figmaClipboard derives it from the style again). */
function takeBackdropBlur(node: AnyNode): number | undefined {
  const effects = node.effects as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(effects)) return undefined;
  const blur = effects.find((e) => e?.type === 'BACKGROUND_BLUR' && e.visible !== false);
  if (!blur) return undefined;
  const rest = effects.filter((e) => e !== blur);
  if (rest.length) node.effects = rest;
  else delete node.effects;
  return Number(blur.radius) || undefined;
}

/** blendMode → style.blend + whether the field was consumed. Only multiply/screen/overlay
 *  survive as style.blend (2026-07 restriction); every other mode (incl. formerly-supported
 *  darken/lighten/…) stays in the figma stash so copy-back restores it losslessly.
 *  NORMAL / PASS_THROUGH are defaults → no style.blend. */
const BLEND_KEEP = new Set<BlendKeyword>(['multiply', 'screen', 'overlay']);
function takeBlend(node: AnyNode): { blend?: 'multiply' | 'screen' | 'overlay'; consumed: boolean } {
  const raw = node.blendMode;
  if (typeof raw !== 'string') return { consumed: false };
  if (raw === 'NORMAL' || raw === 'PASS_THROUGH') return { consumed: true };
  const blend = FIGMA_TO_BLEND[raw];
  return blend && BLEND_KEEP.has(blend)
    ? { blend: blend as 'multiply' | 'screen' | 'overlay', consumed: true }
    : { consumed: false };
}

/** FOREGROUND_BLUR effect (Figma UI "Layer blur") → style.blur; strips it from node.effects IN
 *  PLACE like takeBackdropBlur so the stash doesn't re-emit it on copy-back. */
function takeLayerBlur(node: AnyNode): number | undefined {
  const effects = node.effects as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(effects)) return undefined;
  const blur = effects.find((e) => e?.type === 'FOREGROUND_BLUR' && e.visible !== false);
  if (!blur) return undefined;
  const rest = effects.filter((e) => e !== blur);
  if (rest.length) node.effects = rest;
  else delete node.effects;
  return Number(blur.radius) || undefined;
}

/** Independent corner radii → [tl, tr, br, bl], only when they actually differ. */
function takeRadiusCorners(node: AnyNode): [number, number, number, number] | undefined {
  const tl = Number(node.rectangleTopLeftCornerRadius) || 0;
  const tr = Number(node.rectangleTopRightCornerRadius) || 0;
  const br = Number(node.rectangleBottomRightCornerRadius) || 0;
  const bl = Number(node.rectangleBottomLeftCornerRadius) || 0;
  const independent = node.rectangleCornerRadiiIndependent === true
    || tr !== tl || br !== tl || bl !== tl;
  if (!independent || (tl === tr && tr === br && br === bl)) return undefined;
  return [tl, tr, br, bl];
}

/**
 * Polyline reassembly (inverse of emitPolyline): a FRAME whose children are ALL LINE nodes
 * named with the 'polyline·N' passthrough hint decodes back to a shape Layer with shapeKind
 * 'polyline' and style.points recovered from the segment endpoints (normalized 0..1 in the box).
 */
function tryPolyline(tree: DecodedTree, node: AnyNode, box: { x: number; y: number; w: number; h: number }): Layer | null {
  if (!tree.children.length) return null;
  for (const c of tree.children) {
    if (String(c.node.type) !== 'LINE' || !String(c.node.name || '').startsWith('polyline·')) return null;
  }
  const pts: number[] = [];
  const w = Math.max(1, box.w), h = Math.max(1, box.h);
  const push = (x: number, y: number) => { pts.push((x - box.x) / w, (y - box.y) / h); };
  tree.children.forEach((c, i) => {
    const tr = c.node.transform as FigMatrix | undefined;
    const len = Math.max(1, Number((c.node.size as { x?: number } | undefined)?.x) || 1);
    const x1 = box.x + (tr?.m02 ?? 0), y1 = box.y + (tr?.m12 ?? 0);
    if (i === 0) push(x1, y1);
    push(x1 + (tr?.m00 ?? 1) * len, y1 + (tr?.m10 ?? 0) * len);
  });
  const first = tree.children[0].node;
  const strokes = first.strokePaints as Array<Record<string, unknown>> | undefined;
  const strokePaint = Array.isArray(strokes) ? strokes.find((p) => p && p.visible !== false && p.type === 'SOLID') : undefined;
  const style: FxStyle = {
    shapeKind: 'polyline',
    points: pts.map((v) => Math.round(v * 1e4) / 1e4),
    background: strokePaint ? colorToCss(strokePaint.color as FigColor) : '#ffffff',
    stroke: { color: strokePaint ? colorToCss(strokePaint.color as FigColor) : '#ffffff', width: Number(first.strokeWeight) || 4 },
    opacity: typeof node.opacity === 'number' && node.opacity !== 1 ? node.opacity : undefined,
  };
  const { blend } = takeBlend(node);
  if (blend) style.blend = blend;
  return {
    id: layerId('shape'),
    type: 'shape',
    name: typeof node.name === 'string' ? node.name : undefined,
    box,
    style,
    figma: figmaStash(node, [...CONSUMED_COMMON, 'blendMode', 'resizeToFit', 'frameMaskDisabled', 'cornerRadius']),
  };
}

function convertNode(tree: DecodedTree, origin: { x: number; y: number }): SceneNode | null {
  const node = tree.node;
  const type = String(node.type || '');
  if (node.visible === false) return null;
  const { box, rotation } = nodeBox(node, origin);
  const name = typeof node.name === 'string' ? node.name : undefined;

  if (GROUPISH.has(type)) {
    // LINE-group with the polyline passthrough hint → back to a real polyline layer.
    const poly = tryPolyline(tree, node, box);
    if (poly) return poly;
    const childOrigin = { x: box.x, y: box.y };
    const children: SceneNode[] = [];
    if (node.resizeToFit !== true) {
      const bg = frameFillLayer(node, box, name);
      if (bg) children.push(bg);
    }
    for (const c of tree.children) {
      const converted = convertNode(c, childOrigin);
      if (converted) children.push(converted);
    }
    // A FRAME that clips (not resizeToFit, frame mask enabled) → GroupNode with clip:true,
    // keeping its explicit size. Plain Figma GROUPs / resizeToFit frames stay non-clipping.
    const clips = type === 'FRAME' && node.resizeToFit !== true && node.frameMaskDisabled !== true;
    const group: ClipGroup = {
      id: layerId('group'),
      type: 'group',
      name,
      box,
      children,
      style: typeof node.opacity === 'number' && node.opacity !== 1 ? { opacity: node.opacity } : undefined,
      figma: figmaStash(node, [...CONSUMED_COMMON, 'resizeToFit', 'frameMaskDisabled', 'cornerRadius']),
    };
    if (clips) group.clip = true;
    return group;
  }

  if (type === 'TEXT') {
    const paint = firstVisiblePaint(node);
    const lh = node.lineHeight as { value?: number; units?: string } | undefined;
    const fontSize = Number(node.fontSize) || 40;
    const { blend, consumed: blendConsumed } = takeBlend(node);
    const style: FxStyle = {
      blend,
      blur: takeLayerBlur(node),
      fontSize,
      fontWeight: styleToWeight(node),
      color: paint?.type === 'SOLID' ? colorToCss(paint.color as FigColor) : '#ffffff',
      align: node.textAlignHorizontal === 'CENTER' ? 'center' : node.textAlignHorizontal === 'RIGHT' ? 'right' : 'left',
      uppercase: node.textCase === 'UPPER' || undefined,
      strikethrough: node.textDecoration === 'STRIKETHROUGH' || undefined,
      fontFamily: (() => {
        const fam = (node.fontName as { family?: string } | undefined)?.family;
        // Inter is the export-side fallback family (FIGMA_FALLBACK_FAMILY); Geist was the
        // legacy one — neither materializes as an explicit override on import.
        return fam && fam !== 'Inter' && fam !== 'Geist' ? fam : undefined;
      })(),
      backdropBlur: takeBackdropBlur(node),
      opacity: typeof node.opacity === 'number' && node.opacity !== 1 ? node.opacity : undefined,
      lineHeight: lh?.units === 'PERCENT' && lh.value ? lh.value / 100
        : lh?.units === 'PIXELS' && lh.value ? lh.value / fontSize
        : undefined,
      letterSpacing: (() => {
        const ls = node.letterSpacing as { value?: number; units?: string } | undefined;
        if (!ls?.value) return undefined;
        return ls.units === 'PERCENT' ? (ls.value / 100) * fontSize : ls.value;
      })(),
    };
    const layer: Layer = {
      id: layerId('text'),
      type: 'text',
      name,
      text: String((node.textData as { characters?: string } | undefined)?.characters ?? ''),
      box,
      rotation,
      style,
      autoH: node.textAutoResize === 'HEIGHT' || undefined,
      isMask: node.mask === true || undefined,
      figma: figmaStash(node, [...CONSUMED_COMMON, ...CONSUMED_MASK, ...(blendConsumed ? ['blendMode'] : []),
        'fontSize', 'fontName', 'textAlignHorizontal', 'textAlignVertical', 'textAutoResize',
        'textCase', 'textDecoration', 'lineHeight', 'letterSpacing', 'textData', 'fontWeight']),
    };
    return layer;
  }

  if (SHAPEISH.has(type)) {
    const paint = firstVisiblePaint(node);
    const image = paint?.type === 'IMAGE'
      ? (paint.image as { hash?: Uint8Array | string; dataBlob?: number } | undefined)
      : undefined;
    const strokes = node.strokePaints as Array<Record<string, unknown>> | undefined;
    const strokePaint = Array.isArray(strokes) ? strokes.find((p) => p && p.visible !== false && p.type === 'SOLID') : undefined;
    const { blend, consumed: blendConsumed } = takeBlend(node);
    const style: FxStyle = {
      radius: Number(node.cornerRadius) || undefined,
      radiusCorners: takeRadiusCorners(node),
      opacity: typeof node.opacity === 'number' && node.opacity !== 1 ? node.opacity : undefined,
      backdropBlur: takeBackdropBlur(node),
      blur: takeLayerBlur(node),
      blend,
      stroke: strokePaint
        ? { color: colorToCss(strokePaint.color as FigColor), width: Number(node.strokeWeight) || 1 }
        : undefined,
    };
    if (type === 'ELLIPSE') style.shapeKind = 'ellipse';
    if (type === 'STAR') {
      style.shapeKind = 'starburst';
      style.spikes = Number(node.count) || 12;
    }
    const isMask = node.mask === true || undefined;

    // shapeKind 'path' reassembly (inverse of the ROUNDED_RECTANGLE fallback in
    // figmaClipboard's path branch): our export carries the normalized d-string in pluginData
    // and suffixes the name ' (path)'. Strip the suffix, restore style.path, and keep any
    // FOREIGN pluginData entries in the stash (ours is re-derived on the next export).
    let shapeName = name;
    const pluginData = node.pluginData as Array<{ pluginID?: string; key?: string; value?: string }> | undefined;
    const pathEntry = Array.isArray(pluginData)
      ? pluginData.find((p) => p?.pluginID === FIGMA_PATH_PLUGIN_ID && p?.key === FIGMA_PATH_PLUGIN_KEY && p?.value)
      : undefined;
    if (pathEntry) {
      (style as { shapeKind?: string }).shapeKind = 'path';
      style.path = String(pathEntry.value);
      if (shapeName?.endsWith(' (path)')) shapeName = shapeName.slice(0, -' (path)'.length);
    }

    const stash = figmaStash(node, [...CONSUMED_COMMON, ...CONSUMED_MASK,
      ...(blendConsumed ? ['blendMode'] : []), 'cornerRadius',
      ...(pathEntry ? ['pluginData'] : []),
      'rectangleTopLeftCornerRadius', 'rectangleTopRightCornerRadius',
      'rectangleBottomLeftCornerRadius', 'rectangleBottomRightCornerRadius',
      'rectangleCornerRadiiIndependent', 'rectangleCornerToolIndependent',
      'count', 'starInnerScale']) || {};
    if (pathEntry && Array.isArray(pluginData)) {
      const foreign = pluginData.filter((p) => p !== pathEntry);
      if (foreign.length) stash.pluginData = sanitize(foreign, 1);
    }

    if (image) {
      const hash = image.hash instanceof Uint8Array ? bytesToHex(image.hash) : String(image.hash ?? '');
      stash.imageHash = hash;
      const layer: Layer = {
        id: layerId('image'), type: 'image', name, box, rotation, style, isMask,
        src: '', // caller fills in after uploadFigmaImages
        fit: paint?.imageScaleMode === 'FIT' ? 'contain' : 'cover',
        figma: stash,
      };
      return layer;
    }

    const fill = paint ? paintToFill(paint) : {};
    style.background = fill.background;
    if (fill.gradient) style.gradient = fill.gradient;
    const layer: Layer = {
      id: layerId('shape'), type: 'shape', name: shapeName, box, rotation, style, isMask,
      figma: Object.keys(stash).length ? stash : undefined,
    };
    return layer;
  }

  if (type === 'LINE') {
    // A LINE is a zero-height segment of length size.x, rotated by its transform. Recover the
    // endpoints and rebuild our diagonal-of-box representation (inverse of lineNode in
    // figmaClipboard.ts): start = translation, end = start + L·(m00, m10).
    const tr = node.transform as FigMatrix | undefined;
    const len = Math.max(1, Number((node.size as { x?: number } | undefined)?.x) || 1);
    const x1 = origin.x + (tr?.m02 ?? 0), y1 = origin.y + (tr?.m12 ?? 0);
    const x2 = x1 + (tr?.m00 ?? 1) * len, y2 = y1 + (tr?.m10 ?? 0) * len;
    const strokes = node.strokePaints as Array<Record<string, unknown>> | undefined;
    const strokePaint = Array.isArray(strokes) ? strokes.find((p) => p && p.visible !== false && p.type === 'SOLID') : undefined;
    const cap = String(node.strokeCap || '');
    const { blend, consumed: blendConsumed } = takeBlend(node);
    const layer: Layer = {
      id: layerId('shape'),
      type: 'shape',
      name,
      isMask: node.mask === true || undefined,
      box: {
        x: Math.round(Math.min(x1, x2)), y: Math.round(Math.min(y1, y2)),
        w: Math.round(Math.max(1, Math.abs(x2 - x1))), h: Math.round(Math.max(1, Math.abs(y2 - y1))),
      },
      style: {
        shapeKind: cap.startsWith('ARROW') ? 'arrow' : 'line',
        flipDiag: (x2 - x1) * (y2 - y1) < 0 || undefined, // ↗ diagonal (mirrored)
        background: strokePaint ? colorToCss(strokePaint.color as FigColor) : '#ffffff',
        opacity: typeof node.opacity === 'number' && node.opacity !== 1 ? node.opacity : undefined,
        blend,
      } as FxStyle,
      figma: figmaStash(node, [...CONSUMED_COMMON, ...CONSUMED_MASK,
        ...(blendConsumed ? ['blendMode'] : []), 'strokeCap', 'strokeJoin', 'strokeAlign']),
    };
    return layer;
  }

  // VECTOR, BOOLEAN_OPERATION, LINE, STAR, POLYGON, … — locked placeholder that keeps the raw
  // node in `figma` so copy-back restores it.
  const layer: Layer = {
    id: layerId('figma'),
    type: 'shape',
    name: name || type.toLowerCase(),
    locked: true,
    box,
    style: { background: '#8884' },
    figma: figmaStash(node, ['locked']),
  };
  return layer;
}

// ── images ───────────────────────────────────────────────────────────────────────────────────────

function collectImages(changes: FigNodeChange[], blobs: Array<{ bytes: Uint8Array }>): { hash: string; bytes: Uint8Array }[] {
  const out: { hash: string; bytes: Uint8Array }[] = [];
  const seen = new Set<string>();
  const visit = (node: AnyNode) => {
    const paints = node.fillPaints as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(paints)) return;
    for (const p of paints) {
      if (p?.type !== 'IMAGE') continue;
      const img = p.image as { hash?: Uint8Array; dataBlob?: number } | undefined;
      if (!img) continue;
      const hash = img.hash instanceof Uint8Array ? bytesToHex(img.hash) : String(img.hash ?? '');
      if (!hash || seen.has(hash)) continue;
      const bytes = typeof img.dataBlob === 'number' ? blobs[img.dataBlob]?.bytes : undefined;
      if (!bytes) continue;
      seen.add(hash);
      out.push({ hash, bytes });
    }
  };
  for (const n of changes) visit(n as AnyNode);
  return out;
}

function sniffMime(bytes: Uint8Array): string {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return 'image/gif';
  if (bytes[8] === 0x57 && bytes[9] === 0x45) return 'image/webp';
  return 'image/png';
}

function bytesToDataUrl(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  const b64 = typeof btoa !== 'undefined' ? btoa(bin) : Buffer.from(bytes).toString('base64');
  return `data:${sniffMime(bytes)};base64,${b64}`;
}

/** Upload the embedded image fills via the caller's uploader (Editor wires api.uploadRef).
 *  Returns hash → url. */
export async function uploadFigmaImages(
  images: { hash: string; bytes: Uint8Array }[],
  uploadFn: (dataUrl: string) => Promise<{ url: string }>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const img of images) {
    try {
      const { url } = await uploadFn(bytesToDataUrl(img.bytes));
      out.set(img.hash, url);
    } catch (err) {
      console.warn(`figmaImport: image upload failed for ${img.hash}`, err);
    }
  }
  return out;
}

/** Set src on imported image layers from the hash→url map (recursive). */
export function applyFigmaImageUrls(nodes: SceneNode[], urls: Map<string, string>): void {
  for (const n of nodes) {
    if (n.type === 'group') { applyFigmaImageUrls((n as GroupNode).children, urls); continue; }
    const l = n as Layer;
    const hash = (l.figma as { imageHash?: string } | undefined)?.imageHash;
    if (l.type === 'image' && hash && urls.has(hash)) l.src = urls.get(hash)!;
  }
}

// ── main entry ───────────────────────────────────────────────────────────────────────────────────

export async function parseFigmaClipboard(html: string): Promise<FigmaImportResult> {
  try {
    if (!sniffFigmaClipboard(html)) return { ok: false, error: 'not a Figma clipboard payload' };
    const { message } = decodeFigmaClipboardHtml(html);
    const changes = message.nodeChanges || [];
    const blobs = message.blobs || [];
    const roots = buildTrees(changes);
    if (!roots.length) return { ok: false, error: 'no nodes in payload' };

    let name: string | undefined;
    let canvas: { w: number; h: number };
    let nodes: SceneNode[] = [];

    const singleRootFrame = roots.length === 1 && GROUPISH.has(String(roots[0].node.type || ''));
    if (singleRootFrame) {
      // The outermost frame IS the canvas: its size becomes the doc canvas, its children the
      // scene (absolute coords, frame origin treated as 0,0).
      const root = roots[0];
      const size = root.node.size as { x?: number; y?: number } | undefined;
      canvas = { w: Math.round(size?.x || 1080), h: Math.round(size?.y || 1080) };
      name = typeof root.node.name === 'string' ? root.node.name : undefined;
      const bg = frameFillLayer(root.node, { x: 0, y: 0, w: canvas.w, h: canvas.h }, name);
      if (bg) nodes.push(bg);
      for (const c of root.children) {
        const converted = convertNode(c, { x: 0, y: 0 });
        if (converted) nodes.push(converted);
      }
    } else {
      for (const r of roots) {
        const converted = convertNode(r, { x: 0, y: 0 });
        if (converted) nodes.push(converted);
      }
      // Canvas = bounding box of the roots; shift everything so the bbox starts at 0,0.
      const boxes = nodes.map((n) => n.box);
      const minX = Math.min(...boxes.map((b) => b.x));
      const minY = Math.min(...boxes.map((b) => b.y));
      const maxX = Math.max(...boxes.map((b) => b.x + b.w));
      const maxY = Math.max(...boxes.map((b) => b.y + b.h));
      const shift = (list: SceneNode[]) => {
        for (const n of list) {
          n.box = { ...n.box, x: n.box.x - minX, y: n.box.y - minY };
          if (n.type === 'group') shift((n as GroupNode).children);
        }
      };
      shift(nodes);
      canvas = { w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) };
      name = nodes.length === 1 ? nodes[0].name : undefined;
    }

    const images = collectImages(changes, blobs);
    return { ok: true, nodes, canvas, name, images };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
