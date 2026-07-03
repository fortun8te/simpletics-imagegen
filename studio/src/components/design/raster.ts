// raster.ts — rasterize a scene graph to PNG on a <canvas>, no headless browser.
// Full parity with the Stage DOM renderer: image cover/contain, text boxes with
// bg/radius/padding/align/wrap/letterSpacing, IG-caption pills, gradient fills (angle+stops),
// vignette layers, strokes, group opacity, recursive groups, freeform paths (shapeKind 'path'),
// geometry masks (Layer.isMask clips FOLLOWING siblings), blend modes (style.blend →
// globalCompositeOperation), layer blur (style.blur → ctx.filter), per-corner radii
// (style.radiusCorners) on shapes/text backgrounds, and clipping groups (GroupNode.clip).

import { isGroup, resolveGradient, type DesignDoc, type Layer, type SceneNode } from '../../lib/sceneGraph';
import { arrowGeometry, gradientCanvas, starburstPoints, vignetteCanvas, vignetteSpec } from './fills';
import { pillPadding, textLayout, type Measurer } from './textMetrics';

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`image failed: ${src}`));
    img.src = src;
  });
}

/** style.pixelate (block size in px) isn't declared on LayerStyle yet — see report note for the
 *  sceneGraph.ts addition needed (`pixelate?: number`). Read defensively as a string-indexed
 *  number, same defensive pattern as AnyShapeKind above, so this compiles ahead of that field
 *  landing and needs no changes once it does. */
function pixelateOf(s: Layer['style']): number {
  const v = (s as unknown as Record<string, unknown> | undefined)?.pixelate;
  return typeof v === 'number' && v > 0 ? v : 0;
}

/** True mosaic pixelation: draw the source to an offscreen canvas at a reduced resolution
 *  (block size in px, at the layer's native/output resolution), then scale THAT back up with
 *  smoothing disabled — the standard dependency-free canvas technique for genuine blocky pixels
 *  (visually distinct from style.blur's gaussian softening). Returns a CanvasImageSource sized
 *  dw x dh (the same box the sharp image would have drawn at) so callers can drawImage it
 *  in place of the original — avatar/circle clipping (ellipse etc.) still applies on TOP via
 *  the caller's existing clip path, so this doesn't disturb the avatarShape synthetic-circle path.
 */
function pixelateSource(img: CanvasImageSource, dw: number, dh: number, blockSize: number): CanvasImageSource {
  const w = Math.max(1, Math.round(dw));
  const h = Math.max(1, Math.round(dh));
  const block = Math.max(1, blockSize);
  const smallW = Math.max(1, Math.round(w / block));
  const smallH = Math.max(1, Math.round(h / block));
  const small = document.createElement('canvas');
  small.width = smallW;
  small.height = smallH;
  const sctx = small.getContext('2d')!;
  sctx.imageSmoothingEnabled = true; // downscale WITH smoothing = box-filter-ish average
  sctx.drawImage(img, 0, 0, smallW, smallH);
  const big = document.createElement('canvas');
  big.width = w;
  big.height = h;
  const bctx = big.getContext('2d')!;
  bctx.imageSmoothingEnabled = false; // upscale WITHOUT smoothing = crisp blocky mosaic
  bctx.drawImage(small, 0, 0, w, h);
  return big;
}

function drawImageLayer(ctx: CanvasRenderingContext2D, img: HTMLImageElement, l: Layer) {
  const { x, y, w, h } = l.box;
  const contain = l.fit === 'contain';
  const scale = contain
    ? Math.min(w / img.naturalWidth, h / img.naturalHeight)
    : Math.max(w / img.naturalWidth, h / img.naturalHeight);
  const dw = img.naturalWidth * scale;
  const dh = img.naturalHeight * scale;
  ctx.save();
  // PARITY: Stage puts borderRadius on the <img> (ellipse → 50%, else radiusCorners/radius);
  // designSvg clips the <image> to the same geometry; designstore rounds the overflow:hidden
  // wrapper. Here the clip path IS that geometry (rect when no radius — identical to before).
  if (l.style?.shapeKind === 'ellipse') {
    ctx.beginPath();
    ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
  } else {
    roundRect(ctx, x, y, w, h, cornerRadii(l.style));
  }
  ctx.clip();
  // style.pixelate (block size in px at the drawn resolution) → true mosaic censoring, e.g. for
  // anonymizing a face/username in a real photo/avatar. Additive to blur — if both are set,
  // pixelate wins (mosaic is the intent when explicitly requested for censoring).
  const pixelate = pixelateOf(l.style);
  const source: CanvasImageSource = pixelate ? pixelateSource(img, dw, dh, pixelate) : img;
  ctx.drawImage(source, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  ctx.restore();
}

/** Uniform radius or per-corner [tl, tr, br, bl]. radiusCorners wins over radius —
 *  PARITY: Stage cornerCss / designSvg perCornerRectPath / designstore 4-value border-radius. */
type CornerRadii = number | [number, number, number, number];

function cornerRadii(s: Layer['style']): CornerRadii {
  return s?.radiusCorners ?? (s?.radius || 0);
}

/** Anything we can trace a rounded rect into — the 2D context (current path) or a Path2D. */
type PathSink = Pick<CanvasRenderingContext2D, 'moveTo' | 'arcTo' | 'closePath'>;

function roundRectPath(p: PathSink, x: number, y: number, w: number, h: number, r: CornerRadii) {
  // Per-corner rounded rect (uniform radius = same value on all four). Each corner clamps to
  // the half-extent, matching the old single-radius behavior and CSS border-radius clamping.
  const [tl, tr, br, bl] = Array.isArray(r) ? r : [r, r, r, r];
  const c = (v: number) => Math.max(0, Math.min(v || 0, w / 2, h / 2));
  p.moveTo(x + c(tl), y);
  p.arcTo(x + w, y, x + w, y + h, c(tr));
  p.arcTo(x + w, y + h, x, y + h, c(br));
  p.arcTo(x, y + h, x, y, c(bl));
  p.arcTo(x, y, x + w, y, c(tl));
  p.closePath();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: CornerRadii) {
  ctx.beginPath();
  roundRectPath(ctx, x, y, w, h, r);
}

/** shapeKind including the additive 'path' (freeform SVG path in style.path, coords normalized
 *  0..1 in box space — see sceneGraph.ts LayerStyle.path). The ShapeKind union may not carry
 *  'path' yet, so renderers read it defensively as a string. */
type AnyShapeKind = NonNullable<NonNullable<Layer['style']>['shapeKind']> | 'path';

function shapeKindOf(s: Layer['style']): AnyShapeKind {
  return (s?.shapeKind as AnyShapeKind) || 'rect';
}

/** Path2D for a freeform path: style.path coords are normalized 0..1 in box space, so bake
 *  translate(x,y)·scale(w,h) into the geometry (addPath + DOMMatrix). Filling/stroking the
 *  BAKED path in untransformed canvas space keeps the stroke width uniform (no scaled-pen
 *  distortion) — the raster equivalent of designSvg's vector-effect="non-scaling-stroke". */
function pathGeometry(d: string, box: Layer['box']): Path2D {
  const out = new Path2D();
  out.addPath(new Path2D(d), new DOMMatrix([box.w, 0, 0, box.h, box.x, box.y]));
  return out;
}

// Inter sits ahead of Geist/Helvetica: it's loaded into the canvas via the FontFace API
// (see ensureInterLoaded below) from the BUNDLED woff2 asset, so — unlike Geist (a Google Fonts
// CDN @import with no guaranteed load-before-paint) — it's guaranteed available before fillText
// ever runs. This is the real-font upgrade that replaces name-only fallback fonts (which caused
// the "tofu" bug when a locally-installed-but-sandboxed font was named directly).
const BASE_FONT_STACK = "'Inter', Geist, 'Helvetica Neue', Arial, sans-serif";

/** Font stack with an optional style.fontFamily prepended (quoted when it has spaces).
 *  Used for BOTH drawing and measurement so wrap/centering stay consistent. */
function fontStackFor(s: Layer['style']): string {
  const fam = s?.fontFamily?.trim();
  if (!fam) return BASE_FONT_STACK;
  const quoted = /\s/.test(fam) && !/^['"]/.test(fam) ? `'${fam}'` : fam;
  return `${quoted}, ${BASE_FONT_STACK}`;
}

/** Module-level cached promise: Inter is loaded from the bundled woff2 asset via the FontFace
 *  API exactly ONCE per page session, then registered on document.fonts so every canvas context
 *  (this one and any other on the page) can use it. Repeat rasterizeDesign calls just await the
 *  same resolved promise — no re-fetch, no re-decode. Never throws: if the font fails to load
 *  (e.g. FontFace unsupported), we resolve anyway and let the base stack fall through to system
 *  sans — text still renders, just without the Inter upgrade.
 *  NOTE: uses import.meta.url + fetch so this stays a plain .ts module (no bundler-specific
 *  `?url` import needed) — Vite serves /src/assets/fonts/*.woff2 as a static asset either way. */
let interLoadPromise: Promise<void> | null = null;

async function loadInterWeight(weight: number, fileBase: string): Promise<void> {
  try {
    const url = new URL(`../../assets/fonts/${fileBase}.woff2`, import.meta.url).href;
    const face = new FontFace('Inter', `url(${url})`, { weight: String(weight) });
    const loaded = await face.load();
    document.fonts.add(loaded);
  } catch {
    /* missing/unsupported — base stack falls through to system sans, never blocks rasterizing */
  }
}

/** Ensures Inter (all bundled weights) is loaded + registered on document.fonts before any
 *  canvas text is drawn. Awaited once (module-level cache) so repeat rasterizes are instant. */
export function ensureInterLoaded(): Promise<void> {
  if (!interLoadPromise) {
    interLoadPromise = Promise.all([
      loadInterWeight(400, 'Inter-Regular'),
      loadInterWeight(500, 'Inter-Medium'),
      loadInterWeight(600, 'Inter-SemiBold'),
      loadInterWeight(700, 'Inter-Bold'),
      loadInterWeight(800, 'Inter-ExtraBold'),
    ]).then(() => undefined);
  }
  return interLoadPromise;
}

/** backdropBlur approximation — raster/SVG can't cheaply sample what's beneath the layer, so we
 *  only hint the glass with a 1px inner edge stroke on the CURRENT path. PARITY: DOM/HTML use
 *  backdrop-filter and Figma uses BACKGROUND_BLUR (real blur); this is a noted limitation. */
function glassEdge(ctx: CanvasRenderingContext2D, s: Layer['style'], path?: Path2D) {
  if (!s || !(Number(s.backdropBlur) > 0) || !s.background) return;
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 1;
  if (path) ctx.stroke(path);
  else ctx.stroke();
}

function strokeBox(ctx: CanvasRenderingContext2D, l: Layer) {
  const st = l.style?.stroke;
  if (!st || !(st.width > 0)) return;
  ctx.strokeStyle = st.color;
  ctx.lineWidth = st.width;
  roundRect(ctx, l.box.x, l.box.y, l.box.w, l.box.h, cornerRadii(l.style));
  ctx.stroke();
}

function drawShape(ctx: CanvasRenderingContext2D, l: Layer) {
  const s = l.style || {};
  const { x, y, w, h } = l.box;
  const kind = shapeKindOf(s);

  if (kind === 'arrow' || kind === 'line') {
    // Annotation stroke in the layer's solid color — no fill rect behind.
    const geom = arrowGeometry(l.box, s.flipDiag);
    ctx.strokeStyle = s.background || s.color || '#111';
    ctx.lineWidth = geom.width;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(geom.x1, geom.y1);
    ctx.lineTo(geom.x2, geom.y2);
    if (kind === 'arrow') {
      for (const [hx, hy] of geom.head) {
        ctx.moveTo(geom.x2, geom.y2);
        ctx.lineTo(hx, hy);
      }
    }
    ctx.stroke();
    return;
  }

  if (kind === 'polyline') {
    // PARITY: designSvg.ts <polyline> + designstore.mjs inline-svg branch — style.points are
    // flat x,y pairs normalized 0..1 in the box; stroke background||color at
    // stroke.width || max(2, min(w,h)*0.02), round joins/caps, no fill.
    const pts = s.points || [];
    if (pts.length < 4) return;
    ctx.strokeStyle = s.background || s.color || '#111';
    ctx.lineWidth = s.stroke?.width || Math.max(2, Math.min(w, h) * 0.02);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (let i = 0; i + 1 < pts.length; i += 2) {
      const px = x + pts[i] * w;
      const py = y + pts[i + 1] * h;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
    return;
  }

  const g = resolveGradient(s);
  ctx.fillStyle = g ? gradientCanvas(ctx, g, l.box) : (s.background || '#000000');

  if (kind === 'path') {
    // PARITY: designSvg.ts <path d transform vector-effect="non-scaling-stroke"> — geometry is
    // baked into the Path2D (pathGeometry) so fill AND stroke happen in canvas space and the
    // stroke width is not distorted by the box scale.
    if (!s.path) return;
    const p = pathGeometry(s.path, l.box);
    ctx.fill(p);
    glassEdge(ctx, s, p);
    if (s.stroke && s.stroke.width > 0) {
      ctx.strokeStyle = s.stroke.color;
      ctx.lineWidth = s.stroke.width;
      ctx.stroke(p);
    }
    return;
  }

  if (kind === 'ellipse') {
    ctx.beginPath();
    ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
  } else if (kind === 'starburst') {
    const pts = starburstPoints(l.box, s.spikes ?? 12);
    ctx.beginPath();
    pts.forEach(([px, py], i) => (i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py)));
    ctx.closePath();
  } else {
    // radiusCorners wins over radius — PARITY: Stage cornerCss / designSvg perCornerRectPath.
    roundRect(ctx, x, y, w, h, cornerRadii(s));
  }
  ctx.fill();
  glassEdge(ctx, s); // strokes the current path (rect/ellipse/starburst alike)
  if (s.stroke && s.stroke.width > 0) {
    ctx.strokeStyle = s.stroke.color;
    ctx.lineWidth = s.stroke.width;
    ctx.stroke();
  }
}

function drawVignette(ctx: CanvasRenderingContext2D, l: Layer) {
  ctx.fillStyle = vignetteCanvas(ctx, vignetteSpec(l.style), l.box);
  ctx.fillRect(l.box.x, l.box.y, l.box.w, l.box.h);
}

/** Legacy export kept for callers importing wrapText from here. */
export function wrapText(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const m: Measurer = { width: (t) => ctx.measureText(t).width };
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (const word of words) {
    const probe = cur ? `${cur} ${word}` : word;
    if (m.width(probe) <= maxW || !cur) cur = probe;
    else { lines.push(cur); cur = word; }
  }
  if (cur) lines.push(cur);
  return lines;
}

function drawTextLayer(ctx: CanvasRenderingContext2D, l: Layer) {
  const s = l.style || {};
  const { x, y, w, h } = l.box;
  const pill = !!(s.pill && s.background);
  const size = s.fontSize || 40;
  // style.fontFamily is prepended to the stack — same string for measurement AND drawing.
  ctx.font = `${s.fontWeight || 600} ${size}px ${fontStackFor(s)}`;
  if (s.letterSpacing) (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${s.letterSpacing}px`;
  ctx.textBaseline = 'alphabetic';

  // whole-box background (skipped in pill mode — pills hug per line)
  if (s.background && !pill) {
    const g = resolveGradient(s);
    ctx.fillStyle = g ? gradientCanvas(ctx, g, l.box) : s.background;
    roundRect(ctx, x, y, w, h, cornerRadii(s)); // radiusCorners wins over radius
    ctx.fill();
    glassEdge(ctx, s); // backdropBlur hint — real blur only in DOM/HTML/Figma
  }

  const measurer: Measurer = { width: (t) => ctx.measureText(t).width };
  const { lines, lineH, padY } = textLayout(l, measurer); // shared metrics — same as autoH measurement
  const pillPadX = pillPadding(s); // shared fallback (=14) — matches the wrap pad + Stage/HTML pills
  const pad = pill ? 0 : (s.padding || 0);
  const blockH = lines.length * lineH;
  let ty = y + Math.max(padY, (h - blockH) / 2) + size * 0.82;
  for (const line of lines) {
    const lw = ctx.measureText(line).width;
    const tx = s.align === 'center' ? x + (w - lw) / 2 : s.align === 'right' ? x + w - pad - lw : x + (pill ? pillPadX : pad);
    if (pill) {
      // Per-line hugging pill behind this line (IG caption look).
      ctx.fillStyle = s.background!;
      roundRect(ctx, tx - pillPadX, ty - size * 0.82 - padY, lw + pillPadX * 2, size + padY * 2, s.radius || 10);
      ctx.fill();
    }
    // Text drop shadow on the GLYPHS (the pill rect above was already filled with no shadow set)
    // — PARITY: Stage/HTML text-shadow + designSvg per-glyph <feDropShadow>. Applies in pill mode.
    if (s.shadow) {
      ctx.shadowColor = 'rgba(0,0,0,0.55)';
      ctx.shadowBlur = 12;
      ctx.shadowOffsetY = 2;
    }
    ctx.fillStyle = s.color || '#ffffff';
    ctx.fillText(line, tx, ty);
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    if (s.strikethrough && line) {
      // Per-line strike (works inside pills too): width max(2, size*0.06) at baseline − 0.28em.
      const sy = ty - size * 0.28;
      ctx.strokeStyle = s.color || '#ffffff';
      ctx.lineWidth = Math.max(2, size * 0.06);
      ctx.beginPath();
      ctx.moveTo(tx, sy);
      ctx.lineTo(tx + lw, sy);
      ctx.stroke();
    }
    ty += lineH;
  }
  if (s.letterSpacing) (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = '0px';
  strokeBox(ctx, l);
}

/** Clip geometry for a mask layer (Layer.isMask). shape ellipse/starburst/path clip to their
 *  real outlines; every other leaf (rect shapes, text/badge/button — text→rect fallback —
 *  images, vignette) clips to its rounded box. Rotation is honored.
 *  PARITY: this is a GEOMETRY-ONLY clip — soft/alpha masks (image alpha, blur, gradient
 *  opacity) are NOT supported in raster/SVG. Stage/HTML (CSS masking) and Figma
 *  (mask + maskType ALPHA) can do true alpha masking — noted limitation. */
function maskClipPath(l: Layer): Path2D {
  const s = l.style || {};
  const { x, y, w, h } = l.box;
  const kind = shapeKindOf(s);
  let p = new Path2D();
  if (l.type === 'shape' && kind === 'ellipse') {
    p.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
  } else if (l.type === 'shape' && kind === 'starburst') {
    starburstPoints(l.box, s.spikes ?? 12)
      .forEach(([px, py], i) => (i === 0 ? p.moveTo(px, py) : p.lineTo(px, py)));
    p.closePath();
  } else if (l.type === 'shape' && kind === 'path' && s.path) {
    p = pathGeometry(s.path, l.box);
  } else {
    roundRectPath(p, x, y, w, h, cornerRadii(s));
  }
  const rot = Number(l.rotation) || 0;
  if (rot) {
    const rotated = new Path2D();
    const cx = x + w / 2, cy = y + h / 2;
    rotated.addPath(p, new DOMMatrix().translate(cx, cy).rotate(rot).translate(-cx, -cy));
    return rotated;
  }
  return p;
}

/** style.blend → canvas globalCompositeOperation. The scene-graph enum is the intersection that
 *  maps 1:1 across renderers; the only name that differs on canvas is plus-lighter → 'lighter'.
 *  PARITY: Stage/HTML mix-blend-mode, designSvg style="mix-blend-mode", Figma blendMode enum. */
const BLEND_TO_CANVAS: Record<string, GlobalCompositeOperation> = {
  multiply: 'multiply',
  screen: 'screen',
  overlay: 'overlay',
  darken: 'darken',
  lighten: 'lighten',
  'plus-lighter': 'lighter',
  'soft-light': 'soft-light',
  difference: 'difference',
};

async function drawNodes(ctx: CanvasRenderingContext2D, nodes: SceneNode[]) {
  // Layer.isMask: a mask child clips its FOLLOWING siblings (Figma semantics; parity with
  // designSvg <clipPath> and figmaClipboard mask:true). The mask layer itself does not paint.
  // Several masks in one list nest (each clip intersects the previous).
  let clipSaves = 0;
  for (const n of nodes) {
    if (n.hidden) continue;
    if (!isGroup(n) && n.isMask === true) {
      ctx.save();
      clipSaves++;
      ctx.clip(maskClipPath(n));
      continue;
    }
    if (isGroup(n)) {
      // Group opacity multiplies the current alpha (nested groups compose).
      const prev = ctx.globalAlpha;
      ctx.globalAlpha = prev * (n.style?.opacity ?? 1);
      // GroupNode.clip: children render clipped to the group's box (+ style.radius) — the
      // clipping-frame semantics. Applied BEFORE children (so before any per-leaf
      // rotation/blend/blur inside). PARITY: designSvg <clipPath> rect + <g clip-path>,
      // Stage overflow:hidden frame, Figma real FRAME with clipsContent.
      if (n.clip) {
        ctx.save();
        roundRect(ctx, n.box.x, n.box.y, n.box.w, n.box.h, n.style?.radius || 0);
        ctx.clip();
      }
      await drawNodes(ctx, n.children);
      if (n.clip) ctx.restore();
      ctx.globalAlpha = prev;
      continue;
    }
    const prev = ctx.globalAlpha;
    ctx.globalAlpha = prev * (n.style?.opacity ?? 1);
    // Per-leaf compositing state (blend + blur + rotation) inside one save/restore so it can
    // never leak to siblings. Order: [group clip already applied] → blend/blur → rotation.
    const s = n.style || {};
    const blend = s.blend && s.blend !== 'normal' ? BLEND_TO_CANVAS[s.blend] : undefined;
    const blur = Number(s.blur) > 0 ? Number(s.blur) : 0;
    // Layer.rotation: degrees clockwise about the box center — applies to every leaf type.
    const rot = Number(n.rotation) || 0;
    const saved = !!(rot || blend || blur);
    if (saved) ctx.save();
    // style.blend — per-leaf composite op. PARITY: mix-blend-mode blends against everything
    // beneath in DOM/SVG; canvas composites against the pixels already drawn — same result
    // in bottom→top paint order.
    if (blend) ctx.globalCompositeOperation = blend;
    // style.blur (LAYER blur, not backdropBlur) — ctx.filter is applied at draw time to this
    // leaf's paints only. Supported in Chrome/Edge/Firefox; Safari <17 ignores it (draws
    // sharp) — noted caveat, never throws.
    if (blur) ctx.filter = `blur(${blur}px)`;
    if (rot) {
      const cx = n.box.x + n.box.w / 2;
      const cy = n.box.y + n.box.h / 2;
      ctx.translate(cx, cy);
      ctx.rotate((rot * Math.PI) / 180);
      ctx.translate(-cx, -cy);
    }
    if (n.type === 'image' && n.src) {
      try { drawImageLayer(ctx, await loadImage(n.src), n); }
      catch { /* missing image leaves its box empty */ }
    } else if (n.type === 'shape') {
      drawShape(ctx, n);
    } else if (n.type === 'vignette') {
      drawVignette(ctx, n);
    } else {
      drawTextLayer(ctx, n);
    }
    if (saved) ctx.restore();
    ctx.globalAlpha = prev;
  }
  for (; clipSaves > 0; clipSaves--) ctx.restore();
}

/** Render the doc to a PNG data URL. Missing images leave their box empty (never throws).
 *  `scale` shrinks the output (thumbnails: scale = targetW / canvas.w). */
export async function rasterizeDesign(doc: DesignDoc, scale = 1): Promise<string> {
  // Real font before any fillText — awaited once (module-level cache), so repeat rasterizes
  // after the first call resolve immediately.
  await ensureInterLoaded();
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(doc.canvas.w * scale));
  canvas.height = Math.max(1, Math.round(doc.canvas.h * scale));
  const ctx = canvas.getContext('2d')!;
  if (scale !== 1) ctx.scale(scale, scale);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, doc.canvas.w, doc.canvas.h);
  await drawNodes(ctx, doc.layers);
  return canvas.toDataURL('image/png');
}
