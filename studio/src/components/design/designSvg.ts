// designSvg.ts — render a scene graph to a faithful SVG string.
//
// Figma pastes raw SVG markup as fully editable vector layers, so this is the always-works
// export path for "Copy to Figma" (and a decent generic vector export). Rendering semantics
// mirror raster.ts exactly — same wrapLines, same vertical centering and baseline math, same
// cover/contain and gradient behavior — so what you paste is what the PNG looks like.
//
// Structure: nested <g> per group (Figma keeps the hierarchy AND uses the id as layer name),
// one <g> per leaf layer, <rect> for shapes and text backgrounds (a per-corner <path> when
// style.radiusCorners is set), one <text> per WRAPPED line, <image> with an embedded data URL
// clipped to its box, <path> for freeform shapes (shapeKind 'path'), <clipPath> + <g clip-path>
// for Layer.isMask geometry masks AND GroupNode.clip frames, style="mix-blend-mode" for
// style.blend, and <feGaussianBlur> filters for style.blur (layer blur).

import { isGroup, resolveGradient, type DesignDoc, type Layer, type SceneNode } from '../../lib/sceneGraph';
import { fontFaceCss } from '../../lib/fontFaces';
import { arrowGeometry, gradientSvgDef, starburstPoints, vignetteSpec, vignetteSvgDef } from './fills';
import { pillPadding, textLayout, type Measurer } from './textMetrics';

// Inter sits ahead of Geist/Helvetica — it's embedded as a real @font-face (base64 woff2, see
// designToSvg below) inside the SVG's own <defs>, so the exported .svg renders in the real font
// even when opened standalone (outside the app, offline, on another machine) rather than falling
// through to a name-only system-font guess.
const FONT_STACK = "'Inter', Geist, 'Helvetica Neue', Arial, sans-serif";

/** style.fontFamily prepended to the base stack (quoted when it has spaces) — same string is
 *  used for measurement and the emitted font-family attr, matching raster.ts. */
function fontStackFor(s: Layer['style']): string {
  const fam = s?.fontFamily?.trim();
  if (!fam) return FONT_STACK;
  const quoted = /\s/.test(fam) && !/^['"]/.test(fam) ? `'${fam}'` : fam;
  return `${quoted}, ${FONT_STACK}`;
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function nodeName(n: SceneNode): string {
  return esc((n.name || n.role || n.type).replace(/[^\w \-]/g, '').slice(0, 40) || n.type);
}

/** Fetch a same-origin image and inline it as a data URL (SVG must be self-contained). */
async function fetchAsDataUrl(src: string): Promise<string> {
  const res = await fetch(src);
  if (!res.ok) throw new Error(`fetch failed (${res.status}): ${src}`);
  const blob = await res.blob();
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error(`read failed: ${src}`));
    reader.readAsDataURL(blob);
  });
}

/** style.pixelate (block size in px) isn't declared on LayerStyle yet — see report note for the
 *  sceneGraph.ts addition needed (`pixelate?: number`). Read defensively, same pattern as
 *  raster.ts pixelateOf, so this compiles ahead of that field landing. */
function pixelateOf(s: Layer['style']): number {
  const v = (s as unknown as Record<string, unknown> | undefined)?.pixelate;
  return typeof v === 'number' && v > 0 ? v : 0;
}

/** SVG has no native pixelate filter, and feFlood/feTile mosaic tricks are unreliable across
 *  renderers/viewers. This file is browser-side (fetch + FileReader above), so the practical
 *  zero-dep approach for a STATIC export is to PRE-RASTERIZE the mosaic here: decode the data
 *  URL into an <img>, downscale-then-upscale on an offscreen <canvas> with smoothing disabled
 *  (same technique as raster.ts pixelateSource), and re-encode as a PNG data URL. The <image>
 *  element then just embeds already-pixelated pixels — no filter magic needed, and it matches
 *  how this file already embeds images (data URLs), so pasting into Figma still works. */
async function pixelateDataUrl(dataUrl: string, dw: number, dh: number, blockSize: number): Promise<string> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error('pixelate: image decode failed'));
    im.src = dataUrl;
  });
  const w = Math.max(1, Math.round(dw));
  const h = Math.max(1, Math.round(dh));
  const block = Math.max(1, blockSize);
  const smallW = Math.max(1, Math.round(w / block));
  const smallH = Math.max(1, Math.round(h / block));
  const small = document.createElement('canvas');
  small.width = smallW;
  small.height = smallH;
  const sctx = small.getContext('2d')!;
  sctx.imageSmoothingEnabled = true;
  sctx.drawImage(img, 0, 0, smallW, smallH);
  const big = document.createElement('canvas');
  big.width = w;
  big.height = h;
  const bctx = big.getContext('2d')!;
  bctx.imageSmoothingEnabled = false;
  bctx.drawImage(small, 0, 0, w, h);
  return big.toDataURL('image/png');
}

/** Measurement context configured like raster.ts drawTextLayer. */
function measurerFor(l: Layer): { ctx: CanvasRenderingContext2D; m: Measurer } {
  const ctx = document.createElement('canvas').getContext('2d')!;
  const s = l.style || {};
  ctx.font = `${s.fontWeight || 600} ${s.fontSize || 40}px ${fontStackFor(s)}`;
  if (s.letterSpacing) {
    (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${s.letterSpacing}px`;
  }
  return { ctx, m: { width: (t) => ctx.measureText(t).width } };
}

function strokeAttrs(l: Layer): string {
  const st = l.style?.stroke;
  return st && st.width > 0 ? ` stroke="${esc(st.color)}" stroke-width="${st.width}"` : '';
}

function fillFor(l: Layer, defs: string[]): string {
  const s = l.style || {};
  const g = resolveGradient(s);
  if (!g) return esc(s.background || '#000000');
  const id = `grad-${l.id}`;
  defs.push(gradientSvgDef(g, id));
  return `url(#${id})`;
}

/** backdropBlur approximation: a 1px inner-edge outline over the same geometry. PARITY: DOM/HTML
 *  use backdrop-filter and Figma uses BACKGROUND_BLUR (real blur); SVG/raster can't sample what's
 *  beneath, so this only hints the glass edge — noted limitation. */
function glassEdgeSvg(s: Layer['style'], tag: string, geomAttrs: string): string {
  if (!s || !(Number(s.backdropBlur) > 0) || !s.background) return '';
  return `<${tag} ${geomAttrs} fill="none" stroke="rgba(255,255,255,0.35)" stroke-width="1"/>`;
}

/** shapeKind including the additive 'path' (freeform SVG path in style.path, coords normalized
 *  0..1 in box space — see sceneGraph.ts LayerStyle.path). Read defensively as a string since
 *  the ShapeKind union may not carry 'path' yet. */
type AnyShapeKind = NonNullable<NonNullable<Layer['style']>['shapeKind']> | 'path';

function shapeKindOf(s: Layer['style']): AnyShapeKind {
  return (s?.shapeKind as AnyShapeKind) || 'rect';
}

/** Geometry attrs for a freeform path: the d-string stays normalized, translate+scale maps it
 *  into the box, vector-effect keeps stroke widths in user units (PARITY: raster.ts bakes the
 *  same transform into a Path2D and strokes in canvas space). */
function pathGeomAttrs(d: string, box: Layer['box']): string {
  return `d="${esc(d)}" transform="translate(${box.x} ${box.y}) scale(${box.w} ${box.h})"` +
    ` vector-effect="non-scaling-stroke"`;
}

/** d-attr for a per-corner rounded rect [tl, tr, br, bl] — arc corners, each clamped to the
 *  half-extent like CSS border-radius / raster.ts roundRectPath. Emitted INSTEAD of <rect rx>
 *  when style.radiusCorners is set (SVG rect has no per-corner rx).
 *  PARITY: Stage cornerCss 4-value border-radius / raster.ts cornerRadii / Figma
 *  rectangleTopLeftCornerRadius et al. */
export function perCornerRectPath(
  x: number, y: number, w: number, h: number, r: [number, number, number, number],
): string {
  const c = (v: number) => Math.max(0, Math.min(v || 0, w / 2, h / 2));
  const [tl, tr, br, bl] = r.map(c) as [number, number, number, number];
  const n = (v: number) => Math.round(v * 100) / 100;
  return (
    `M ${n(x + tl)} ${n(y)} ` +
    `L ${n(x + w - tr)} ${n(y)} ` + (tr ? `A ${n(tr)} ${n(tr)} 0 0 1 ${n(x + w)} ${n(y + tr)} ` : '') +
    `L ${n(x + w)} ${n(y + h - br)} ` + (br ? `A ${n(br)} ${n(br)} 0 0 1 ${n(x + w - br)} ${n(y + h)} ` : '') +
    `L ${n(x + bl)} ${n(y + h)} ` + (bl ? `A ${n(bl)} ${n(bl)} 0 0 1 ${n(x)} ${n(y + h - bl)} ` : '') +
    `L ${n(x)} ${n(y + tl)} ` + (tl ? `A ${n(tl)} ${n(tl)} 0 0 1 ${n(x + tl)} ${n(y)} ` : '') +
    `Z`
  );
}

/** Rounded-box geometry as [tag, geomAttrs]: a per-corner <path> when radiusCorners is set,
 *  otherwise the plain <rect rx> (byte-identical markup to before for uniform radii). */
function roundedBoxGeom(
  s: Layer['style'], x: number, y: number, w: number, h: number,
): { tag: string; geomAttrs: string } {
  if (s?.radiusCorners) {
    return { tag: 'path', geomAttrs: `d="${perCornerRectPath(x, y, w, h, s.radiusCorners)}"` };
  }
  const rx = s?.radius ? ` rx="${Math.min(s.radius, w / 2, h / 2)}"` : '';
  return { tag: 'rect', geomAttrs: `x="${x}" y="${y}" width="${w}" height="${h}"${rx}` };
}

function shapeSvg(l: Layer, defs: string[]): string {
  const s = l.style || {};
  const { x, y, w, h } = l.box;
  const kind = shapeKindOf(s);

  if (kind === 'path') {
    if (!s.path) return '';
    const geomAttrs = pathGeomAttrs(s.path, l.box);
    return `<path ${geomAttrs} fill="${fillFor(l, defs)}"${strokeAttrs(l)}/>` + glassEdgeSvg(s, 'path', geomAttrs);
  }

  if (kind === 'arrow' || kind === 'line') {
    // Annotation stroke in the layer's solid color — no fill rect behind.
    const gm = arrowGeometry(l.box, s.flipDiag);
    const attrs = ` stroke="${esc(s.background || s.color || '#111')}" stroke-width="${gm.width}" stroke-linecap="round"`;
    let out = `<line x1="${gm.x1}" y1="${gm.y1}" x2="${gm.x2}" y2="${gm.y2}"${attrs}/>`;
    if (kind === 'arrow') {
      for (const [hx, hy] of gm.head) {
        out += `<line x1="${gm.x2}" y1="${gm.y2}" x2="${hx}" y2="${hy}"${attrs}/>`;
      }
    }
    return out;
  }

  if (kind === 'polyline') {
    // PARITY: raster.ts drawShape polyline + designstore.mjs inline-svg branch — points are
    // normalized 0..1 pairs in the box, stroked (no fill) with round joins/caps.
    const pts = s.points || [];
    if (pts.length < 4) return '';
    const mapped: string[] = [];
    for (let i = 0; i + 1 < pts.length; i += 2) {
      mapped.push(`${Math.round((x + pts[i] * w) * 100) / 100},${Math.round((y + pts[i + 1] * h) * 100) / 100}`);
    }
    const width = s.stroke?.width || Math.max(2, Math.min(w, h) * 0.02);
    return `<polyline points="${mapped.join(' ')}" fill="none" stroke="${esc(s.background || s.color || '#111')}"` +
      ` stroke-width="${width}" stroke-linejoin="round" stroke-linecap="round"/>`;
  }

  let tag: string;
  let geomAttrs: string;
  if (kind === 'ellipse') {
    tag = 'ellipse';
    geomAttrs = `cx="${x + w / 2}" cy="${y + h / 2}" rx="${w / 2}" ry="${h / 2}"`;
  } else if (kind === 'starburst') {
    tag = 'polygon';
    const pts = starburstPoints(l.box, s.spikes ?? 12)
      .map(([px, py]) => `${Math.round(px * 100) / 100},${Math.round(py * 100) / 100}`)
      .join(' ');
    geomAttrs = `points="${pts}"`;
  } else {
    ({ tag, geomAttrs } = roundedBoxGeom(s, x, y, w, h)); // per-corner <path> when radiusCorners
  }
  return `<${tag} ${geomAttrs} fill="${fillFor(l, defs)}"${strokeAttrs(l)}/>` + glassEdgeSvg(s, tag, geomAttrs);
}

function vignetteSvg(l: Layer, defs: string[]): string {
  const { x, y, w, h } = l.box;
  const id = `vig-${l.id}`;
  defs.push(vignetteSvgDef(vignetteSpec(l.style), id));
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="url(#${id})"/>`;
}

function textSvg(l: Layer, defs: string[]): string {
  const s = l.style || {};
  const { x, y, w, h } = l.box;
  const pill = !!(s.pill && s.background);
  const parts: string[] = [];
  if (s.background && !pill) {
    // Whole-box text background — per-corner <path> when radiusCorners is set, else <rect rx>.
    const { tag, geomAttrs } = roundedBoxGeom(s, x, y, w, h);
    parts.push(`<${tag} ${geomAttrs} fill="${fillFor(l, defs)}"${strokeAttrs(l)}/>` + glassEdgeSvg(s, tag, geomAttrs));
  }
  const pad = pill ? 0 : (s.padding || 0);
  const size = s.fontSize || 40;
  const { ctx, m } = measurerFor(l);
  // Shared metrics (same numbers as raster.ts + the autoH measurement).
  const { lines, lineH, padY } = textLayout(l, m);
  const pillPadX = pillPadding(s); // shared fallback (=14) — matches the wrap pad + Stage/HTML pills
  const blockH = lines.length * lineH;
  // Same baseline math as raster.ts: first baseline at top offset + 0.82em.
  let ty = y + Math.max(padY, (h - blockH) / 2) + size * 0.82;
  const anchor = s.align === 'center' ? 'middle' : s.align === 'right' ? 'end' : 'start';
  // Text drop shadow on the GLYPHS only (not the pill rects) — PARITY: Stage/HTML text-shadow
  // sits on the text span, raster.ts shadows only fillText. Applies in pill mode too.
  if (s.shadow) {
    defs.push(
      `<filter id="tsh-${l.id}" x="-30%" y="-30%" width="160%" height="160%">` +
        `<feDropShadow dx="0" dy="2" stdDeviation="6" flood-color="#000000" flood-opacity="0.55"/></filter>`,
    );
  }
  const shadowAttr = s.shadow ? ` filter="url(#tsh-${l.id})"` : '';
  const attrs =
    `font-family="${esc(fontStackFor(s))}" font-size="${size}" font-weight="${s.fontWeight || 600}"` +
    ` fill="${esc(s.color || '#ffffff')}" text-anchor="${anchor}"` +
    (s.letterSpacing ? ` letter-spacing="${s.letterSpacing}"` : '') +
    (s.strikethrough ? ' text-decoration="line-through"' : '');
  for (const line of lines) {
    const lw = ctx.measureText(line).width;
    const lineLeft = s.align === 'center' ? x + (w - lw) / 2 : s.align === 'right' ? x + w - pad - lw : x + (pill ? pillPadX : pad);
    if (pill) {
      // Per-line hugging pill (IG caption look) — one rounded rect per wrapped line.
      const rr = Math.min(s.radius || 10, (size + padY * 2) / 2);
      parts.push(
        `<rect x="${lineLeft - pillPadX}" y="${ty - size * 0.82 - padY}" width="${lw + pillPadX * 2}"` +
        ` height="${size + padY * 2}" rx="${rr}" fill="${esc(s.background!)}"/>`,
      );
    }
    const tx = s.align === 'center' ? x + w / 2 : s.align === 'right' ? x + w - pad : lineLeft;
    parts.push(`<text x="${tx}" y="${ty}" ${attrs}${shadowAttr}>${esc(line)}</text>`);
    if (s.strikethrough && line) {
      // Explicit strike line too — some SVG consumers ignore text-decoration. Same rule as
      // raster.ts: width max(2, size*0.06) at baseline − 0.28em, per wrapped line (pills incl.).
      const sy = ty - size * 0.28;
      parts.push(
        `<line x1="${lineLeft}" y1="${sy}" x2="${lineLeft + lw}" y2="${sy}"` +
        ` stroke="${esc(s.color || '#ffffff')}" stroke-width="${Math.max(2, size * 0.06)}"/>`,
      );
    }
    ty += lineH;
  }
  // Box border for a text layer's stroke (PARITY: raster.ts strokeBox strokes the whole box even
  // with no background; Stage insets a boxShadow; HTML sets a border). The background rect above
  // only carried the stroke when s.background was set — a border-only text layer had none.
  const st = s.stroke;
  if (st && st.width > 0 && !s.background) {
    const { tag, geomAttrs } = roundedBoxGeom(s, x, y, w, h);
    parts.push(`<${tag} ${geomAttrs} fill="none" stroke="${esc(st.color)}" stroke-width="${st.width}"/>`);
  }
  return parts.join('');
}

async function imageSvg(l: Layer, defs: string[]): Promise<string> {
  const { x, y, w, h } = l.box;
  const s = l.style || {};
  let href = await fetchAsDataUrl(l.src!);
  // style.pixelate: pre-rasterize the mosaic into the embedded data URL — see pixelateDataUrl
  // above. Pixelating at the FULL box size (w x h) keeps the block size meaningful relative to
  // the rendered output regardless of the source image's native resolution, and the <image>
  // preserveAspectRatio below still covers/contains it exactly like the sharp path did.
  const pixelate = pixelateOf(s);
  if (pixelate) {
    try { href = await pixelateDataUrl(href, w, h, pixelate); }
    catch { /* fall back to the sharp source rather than failing the whole export */ }
  }
  const clipId = `clip-${l.id}`;
  // PARITY: Stage puts borderRadius on the <img> (ellipse → 50%, else radiusCorners/radius) and
  // raster.ts clips the drawImage to that geometry — clip the <image> to the SAME shape here
  // (was always a plain rect, so rounded/ellipse image layers rendered square in SVG export).
  let clipGeom: string;
  if (s.shapeKind === 'ellipse') {
    clipGeom = `<ellipse cx="${x + w / 2}" cy="${y + h / 2}" rx="${w / 2}" ry="${h / 2}"/>`;
  } else if (s.radiusCorners) {
    clipGeom = `<path d="${perCornerRectPath(x, y, w, h, s.radiusCorners)}"/>`;
  } else if (s.radius) {
    clipGeom = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${Math.min(s.radius, w / 2, h / 2)}"/>`;
  } else {
    clipGeom = `<rect x="${x}" y="${y}" width="${w}" height="${h}"/>`;
  }
  defs.push(`<clipPath id="${esc(clipId)}">${clipGeom}</clipPath>`);
  // slice = cover, meet = contain — both centered, matching raster.ts drawImageLayer.
  const par = l.fit === 'contain' ? 'xMidYMid meet' : 'xMidYMid slice';
  return (
    `<image x="${x}" y="${y}" width="${w}" height="${h}" href="${esc(href)}"` +
    ` preserveAspectRatio="${par}" clip-path="url(#${clipId})"/>`
  );
}

/** Clip geometry markup for a mask layer (Layer.isMask), used inside <clipPath>. shape
 *  ellipse/starburst/path clip to their real outlines; every other leaf (rect shapes,
 *  text/badge/button — text→rect fallback — images, vignette) clips to its rounded box.
 *  Rotation is honored via a transform on the geometry element.
 *  PARITY: geometry-only clip — soft/alpha masks (image alpha, blur, gradient opacity) are NOT
 *  supported in raster/SVG. Stage/HTML (CSS masking) and Figma (mask + maskType ALPHA) can do
 *  true alpha masking — noted limitation. Same rules as raster.ts maskClipPath. */
function maskShapeSvg(l: Layer): string {
  const s = l.style || {};
  const { x, y, w, h } = l.box;
  const kind = shapeKindOf(s);
  const rot = Number(l.rotation) || 0;
  const rotAttr = rot ? ` transform="rotate(${rot} ${x + w / 2} ${y + h / 2})"` : '';
  if (l.type === 'shape' && kind === 'ellipse') {
    return `<ellipse cx="${x + w / 2}" cy="${y + h / 2}" rx="${w / 2}" ry="${h / 2}"${rotAttr}/>`;
  }
  if (l.type === 'shape' && kind === 'starburst') {
    const pts = starburstPoints(l.box, s.spikes ?? 12)
      .map(([px, py]) => `${Math.round(px * 100) / 100},${Math.round(py * 100) / 100}`)
      .join(' ');
    return `<polygon points="${pts}"${rotAttr}/>`;
  }
  if (l.type === 'shape' && kind === 'path' && s.path) {
    // rotate composes OUTSIDE translate·scale (leftmost applies last), same as raster's
    // rotate-about-center over the baked geometry.
    const rotPrefix = rot ? `rotate(${rot} ${x + w / 2} ${y + h / 2}) ` : '';
    return `<path d="${esc(s.path)}" transform="${rotPrefix}translate(${x} ${y}) scale(${w} ${h})"/>`;
  }
  // Rounded-box fallback — per-corner path when radiusCorners is set (PARITY: raster.ts
  // maskClipPath uses cornerRadii, i.e. radiusCorners wins over radius).
  const { tag, geomAttrs } = roundedBoxGeom(s, x, y, w, h);
  return `<${tag} ${geomAttrs}${rotAttr}/>`;
}

async function nodesSvg(nodes: SceneNode[], defs: string[]): Promise<string[]> {
  const out: string[] = [];
  // Layer.isMask: a mask child clips its FOLLOWING siblings (Figma semantics; parity with
  // raster.ts ctx.clip and figmaClipboard mask:true). The mask layer itself does not paint;
  // several masks in one list nest (intersection).
  let openClips = 0;
  for (const n of nodes) {
    if (n.hidden) continue;
    if (!isGroup(n) && n.isMask === true) {
      const clipId = `mask-${n.id}`;
      defs.push(`<clipPath id="${esc(clipId)}">${maskShapeSvg(n)}</clipPath>`);
      out.push(`<g clip-path="url(#${esc(clipId)})">`);
      openClips++;
      continue;
    }
    if (isGroup(n)) {
      const inner = await nodesSvg(n.children, defs);
      const opacity = n.style?.opacity != null && n.style.opacity < 1 ? ` opacity="${n.style.opacity}"` : '';
      // GroupNode.clip: children clipped to the group's box (+ style.radius) — clipping-frame
      // semantics, applied on the group <g> so it wraps children BEFORE their own
      // rotation/blend/blur. PARITY: raster.ts ctx.clip, Stage overflow:hidden, Figma FRAME.
      let clipAttr = '';
      if (n.clip) {
        const clipId = `gclip-${n.id}`;
        const { x, y, w, h } = n.box;
        const rx = n.style?.radius ? ` rx="${Math.min(n.style.radius, w / 2, h / 2)}"` : '';
        defs.push(`<clipPath id="${esc(clipId)}"><rect x="${x}" y="${y}" width="${w}" height="${h}"${rx}/></clipPath>`);
        clipAttr = ` clip-path="url(#${esc(clipId)})"`;
      }
      out.push(`<g id="${nodeName(n)}"${opacity}${clipAttr}>${inner.join('')}</g>`);
      continue;
    }
    const l = n;
    const s = l.style || {};
    let inner = '';
    if (l.type === 'image' && l.src) {
      try {
        inner = await imageSvg(l, defs);
      } catch (err) {
        console.warn(`designToSvg: skipping image layer "${l.id}"`, err);
        continue;
      }
    } else if (l.type === 'shape') {
      inner = shapeSvg(l, defs);
    } else if (l.type === 'vignette') {
      inner = vignetteSvg(l, defs);
    } else {
      inner = textSvg(l, defs);
    }
    // Layer blur (style.blur) on the leaf <g>. PARITY: raster.ts sets ctx.filter=blur(...) per
    // leaf; Stage sets filter:blur(...). Text drop shadow is handled per-glyph inside textSvg so
    // it doesn't shadow pill rects — kept separate. blur radius r ≈ stdDeviation r/2 (CSS look).
    const blur = Number(s.blur) > 0 ? Number(s.blur) : 0;
    let filter = '';
    if (blur) {
      const fid = `fx-${l.id}`;
      defs.push(
        `<filter id="${esc(fid)}" x="-50%" y="-50%" width="200%" height="200%">` +
          `<feGaussianBlur stdDeviation="${blur / 2}"/></filter>`,
      );
      filter = ` filter="url(#${fid})"`;
    }
    const opacity = s.opacity != null && s.opacity < 1 ? ` opacity="${s.opacity}"` : '';
    // style.blend → mix-blend-mode. PARITY: Stage mixBlendMode, raster globalCompositeOperation,
    // Figma blendMode. Restricted to multiply/screen/overlay (migrateDoc drops the rest).
    const blendStyle = s.blend && s.blend !== 'normal' ? ` style="mix-blend-mode:${esc(s.blend)}"` : '';
    // Layer.rotation: degrees clockwise about the box center (SVG rotate() is clockwise in
    // y-down coords — same direction as raster.ts ctx.rotate).
    const rot = Number(l.rotation) || 0;
    if (rot) {
      const cx = l.box.x + l.box.w / 2;
      const cy = l.box.y + l.box.h / 2;
      inner = `<g transform="rotate(${rot} ${cx} ${cy})">${inner}</g>`;
    }
    // id becomes the layer name when Figma converts the pasted SVG.
    out.push(`<g id="${nodeName(l)}"${opacity}${filter}${blendStyle}>${inner}</g>`);
  }
  for (; openClips > 0; openClips--) out.push('</g>');
  return out;
}

/** Render the doc to an SVG string. Missing images leave their box empty (never throws).
 *  Embeds Inter as a base64 @font-face inside <defs> so the exported SVG is self-contained and
 *  renders in the real font even opened standalone/offline (fontFaceCss fetches+encodes the
 *  bundled woff2 assets once per session and caches the result — never blocks on a miss). */
export async function designToSvg(doc: DesignDoc): Promise<string> {
  const { w: W, h: H } = doc.canvas;
  const defs: string[] = [];
  const fontCss = await fontFaceCss();
  if (fontCss) defs.push(`<style>${fontCss}</style>`);
  // raster.ts paints the canvas black before layers — keep parity.
  const body: string[] = [`<rect x="0" y="0" width="${W}" height="${H}" fill="#000000"/>`];
  body.push(...(await nodesSvg(doc.layers, defs)));
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    (defs.length ? `<defs>${defs.join('')}</defs>` : '') +
    body.join('') +
    `</svg>`
  );
}
