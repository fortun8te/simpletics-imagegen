// lib/designstore.mjs — Design mode persistence + export (BRIEF Phase 2.6/2.7).
//
// Designs are scene-graph JSON documents (src/lib/sceneGraph.ts is the authoritative contract;
// this module treats them as data and validates only shape essentials). Stored one file per doc
// under studio/.state/designs/{id}.json. Exports write a self-contained bundle to
// studio/.state/designs/exports/{id}/:
//   comp.json    — the scene graph (agents / re-import)
//   comp.html    — standalone HTML render (absolute layout, same-origin image URLs rewritten to
//                  data URLs so the file works offline AND pastes into html-to-Figma importers)
//   comp.png     — client-rendered PNG when the browser sent one (base64), else omitted
//   FIGMA.md     — the documented Figma clipboard workflow
// Zero external deps: node:* only.

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync, deflateSync } from 'node:zlib';
import { fontFaceStyleTag } from './font-faces.mjs';

const STUDIO = join(dirname(fileURLToPath(import.meta.url)), '..');
const DESIGNS = join(STUDIO, '.state', 'designs');
const EXPORTS = join(DESIGNS, 'exports');

function ensureDirs() {
  for (const d of [DESIGNS, EXPORTS]) if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

const safeId = (id) => String(id || '').trim().replace(/[^a-zA-Z0-9_-]+/g, '-');

/** Minimal server-side shape check (the full validator lives in sceneGraph.ts client-side).
 *  Recursive: v3 docs nest groups ({type:'group', children:[…]}) to any depth. */
export function checkDesign(doc) {
  if (!doc || typeof doc !== 'object') return 'not an object';
  if (!doc.id) return 'missing id';
  if (!doc.canvas || !(Number(doc.canvas.w) > 0) || !(Number(doc.canvas.h) > 0)) return 'bad canvas';
  if (!Array.isArray(doc.layers)) return 'layers must be an array';
  const checkNodes = (nodes, depth) => {
    if (depth > 12) return 'nesting too deep';
    for (const l of nodes) {
      if (!l || !l.id || !l.box) return `bad layer ${l && l.id}`;
      if (l.type === 'group') {
        if (!Array.isArray(l.children)) return `group ${l.id} without children`;
        const err = checkNodes(l.children, depth + 1);
        if (err) return err;
      }
    }
    return null;
  };
  return checkNodes(doc.layers, 0);
}

/** Count nodes across the tree (list summaries). */
function countNodes(nodes) {
  let n = 0;
  for (const l of nodes || []) {
    n += 1;
    if (l && l.type === 'group' && Array.isArray(l.children)) n += countNodes(l.children);
  }
  return n;
}

export function saveDesign(doc) {
  const err = checkDesign(doc);
  if (err) throw new Error(`invalid design: ${err}`);
  ensureDirs();
  const clean = { ...doc, id: safeId(doc.id), updatedAt: Date.now() };
  // Optional free-form tags (DesignDoc.tags) — sanitized, deduped, capped.
  if (Array.isArray(doc.tags)) {
    clean.tags = [...new Set(doc.tags.map((t) => String(t).trim().slice(0, 32)).filter(Boolean))].slice(0, 12);
  } else {
    delete clean.tags;
  }
  writeFileSync(join(DESIGNS, `${clean.id}.json`), JSON.stringify(clean, null, 2));
  return clean;
}

/** Allowed blend modes after the v5 cleanup — the rest mapped poorly across renderers. */
const BLEND_KEEP = new Set(['multiply', 'screen', 'overlay']);

/** Load-time migration (blend restriction only, 2026-07): blend modes are restricted to
 *  multiply/screen/overlay; others → normal. backdropBlur ("glass") is KEPT — glass is back
 *  (real frosted panels render in DOM/HTML/Figma; benchmark 129). Idempotent, never throws. */
function migrateDoc(doc) {
  const walk = (nodes) => {
    for (const n of nodes || []) {
      if (!n) continue;
      const s = n.style;
      if (s && s.blend && s.blend !== 'normal' && !BLEND_KEEP.has(s.blend)) delete s.blend;
      if (n.type === 'group') walk(n.children);
    }
  };
  try { walk(doc.layers); } catch { /* migration must never block a load */ }
  return doc;
}

export function getDesign(id) {
  try { return migrateDoc(JSON.parse(readFileSync(join(DESIGNS, `${safeId(id)}.json`), 'utf8'))); } catch { return null; }
}

export function deleteDesign(id) {
  try { rmSync(join(DESIGNS, `${safeId(id)}.json`)); } catch { return false; }
  try { rmSync(join(DESIGNS, `${safeId(id)}.png`)); } catch { /* no thumb */ }
  return true;
}

/** Gallery thumbnail: a small PNG rasterized client-side on save (data URL in). */
export function saveThumb(id, dataUrl) {
  const m = /^data:image\/png;base64,(.+)$/.exec(String(dataUrl || ''));
  if (!m) return false;
  ensureDirs();
  try {
    writeFileSync(join(DESIGNS, `${safeId(id)}.png`), Buffer.from(m[1], 'base64'));
    return true;
  } catch { return false; }
}

export function thumbPath(id) {
  const p = join(DESIGNS, `${safeId(id)}.png`);
  return existsSync(p) ? p : null;
}

export function listDesigns() {
  ensureDirs();
  const out = [];
  for (const f of readdirSync(DESIGNS)) {
    if (!f.endsWith('.json')) continue;
    try {
      const d = JSON.parse(readFileSync(join(DESIGNS, f), 'utf8'));
      out.push({
        id: d.id, name: d.name, template: d.template, adType: d.adType, brand: d.brand ?? null,
        tags: Array.isArray(d.tags) && d.tags.length ? d.tags : undefined,
        layers: countNodes(d.layers), updatedAt: d.updatedAt, createdAt: d.createdAt,
        thumb: existsSync(join(DESIGNS, `${safeId(d.id)}.png`)) ? `/api/design/thumb?id=${encodeURIComponent(d.id)}` : null,
      });
    } catch { /* skip corrupt file */ }
  }
  return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

// ── agent chats (v3) ─────────────────────────────────────────────────────────────────────────────
// One JSON file per doc under .state/agent-chats/{docId}.json:
//   { messages: [{ role:'user'|'agent', text, at, runId?, attachments?, result? }] }  (cap 60)

const CHATS = join(STUDIO, '.state', 'agent-chats');
const MAX_CHAT_MESSAGES = 60;

export function getChat(docId) {
  try {
    const j = JSON.parse(readFileSync(join(CHATS, `${safeId(docId)}.json`), 'utf8'));
    return { messages: Array.isArray(j.messages) ? j.messages : [] };
  } catch { return { messages: [] }; }
}

/** Append one message ({role,text,at,…}) to a doc's agent chat. Returns the saved chat. */
export function appendChat(docId, message) {
  if (!message || typeof message !== 'object') return getChat(docId);
  const chat = getChat(docId);
  chat.messages.push({ at: Date.now(), ...message, text: String(message.text || '').slice(0, 2000) });
  chat.messages = chat.messages.slice(-MAX_CHAT_MESSAGES);
  try {
    mkdirSync(CHATS, { recursive: true });
    writeFileSync(join(CHATS, `${safeId(docId)}.json`), JSON.stringify(chat, null, 2));
  } catch { /* chat persistence is best-effort */ }
  return chat;
}

export function clearChat(docId) {
  try { rmSync(join(CHATS, `${safeId(docId)}.json`)); return true; } catch { return false; }
}

// ── standalone HTML render ───────────────────────────────────────────────────────────────────────
// One absolutely-positioned <div> per layer — the same geometry the live Canvas renders, emitted
// as plain HTML+inline CSS so html→Figma importers translate it into real layers.

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// PARITY: gradient/vignette CSS mirrors src/components/design/fills.ts — change both together.
function gradientCssJs(s) {
  const g = s && s.gradient;
  if (!g) return null;
  if (typeof g === 'object' && Array.isArray(g.stops) && g.stops.length) {
    const stops = g.stops.map((st) => `${st.color} ${Math.round((st.pos || 0) * 100)}%`).join(', ');
    return g.type === 'radial' ? `radial-gradient(circle, ${stops})` : `linear-gradient(${g.angle || 0}deg, ${stops})`;
  }
  const bg = s.background || '#000';
  if (g === 'to-top') return `linear-gradient(to top, ${bg}, transparent)`;
  if (g === 'to-bottom') return `linear-gradient(to bottom, ${bg}, transparent)`;
  return null;
}

function vignetteCssJs(s) {
  const v = (s && s.vignette) || {};
  const strength = Math.max(0, Math.min(1, v.strength == null ? 0.7 : v.strength));
  const size = Math.max(0, Math.min(0.95, v.size == null ? 0.45 : v.size));
  const color = s && s.background ? s.background : '#000000';
  const m = /^#([0-9a-fA-F]{6})$/.exec(color);
  const edge = m
    ? `rgba(${parseInt(m[1].slice(0, 2), 16)}, ${parseInt(m[1].slice(2, 4), 16)}, ${parseInt(m[1].slice(4, 6), 16)}, ${strength.toFixed(3)})`
    : color;
  return `radial-gradient(ellipse at center, rgba(0,0,0,0) ${Math.round(size * 100)}%, ${edge} 100%)`;
}

// PARITY: duplicates starburstPoints in src/components/design/fills.ts (same inner=0.78, same
// spike clamp), but emits PERCENTAGES relative to the box for CSS clip-path — change both together.
function starburstPolygonCss(spikes) {
  const inner = 0.78;
  const n = Math.max(6, Math.min(40, Math.round(spikes || 12)));
  const pts = [];
  for (let i = 0; i < n * 2; i++) {
    const a = (i * Math.PI) / n - Math.PI / 2;
    const k = i % 2 === 0 ? 1 : inner;
    pts.push(`${(50 + Math.cos(a) * 50 * k).toFixed(2)}% ${(50 + Math.sin(a) * 50 * k).toFixed(2)}%`);
  }
  return pts.join(', ');
}

/** Per-corner radius override wins over uniform radius — PARITY: Stage cornerCss /
 *  raster cornerRadii / designSvg roundedBoxGeom. Returns a CSS border-radius value or ''. */
function cornerCssJs(s, fallback = 0) {
  if (Array.isArray(s.radiusCorners) && s.radiusCorners.length === 4) {
    return s.radiusCorners.map((r) => `${r || 0}px`).join(' ');
  }
  if (s.radius) return `${s.radius}px`;
  return fallback ? `${fallback}px` : '';
}

/** style.fontFamily prepended to the base stack — Inter (embedded via @font-face, see
 *  fontFaceStyleTag) sits ahead of Geist/Helvetica because it's actually available offline/
 *  server-side, unlike Geist (Google Fonts CDN dependency). PARITY with raster.ts/designSvg.ts
 *  fontStackFor: a bare CSS keyword token (no whitespace, e.g. `-apple-system`, `sans-serif`) is
 *  left UNQUOTED so it resolves as the real keyword rather than a literal custom family name;
 *  only multi-word names (e.g. "Segoe UI") get single-quoted. This is MORE robust than the old
 *  unconditional-quote behavior (which broke `-apple-system`), matching the other four renderers.*/
function fontFamilyCss(s) {
  const fam = s.fontFamily ? String(s.fontFamily).trim().replace(/^['"]|['"]$/g, '') : '';
  const prefix = fam ? (/\s/.test(fam) ? `'${fam}',` : `${fam},`) : '';
  return `font-family:${prefix}'Inter','Geist','Helvetica Neue',Arial,sans-serif`;
}

// ── Server-side true pixelation (zero-dep: node:zlib only) ──────────────────────────────────────
// style.pixelate on an image layer needs GENUINE blocky mosaic pixels in the server-rendered
// comp.html too (not just the browser renderers), since Node has no DOM/canvas. Rather than fall
// back to the existing blur filter (which looks nothing like a mosaic and defeats the point of a
// dedicated pixelate control), this decodes the resolved image's raw pixels, downsamples with a
// box-filter average, replicates each averaged block back up to the block size (nearest-neighbor
// upscale — the same "shrink then enlarge with no smoothing" trick raster.ts/designSvg.ts use on
// canvas), and re-encodes a fresh PNG — all with node:zlib (inflate/deflate), no new npm deps.
// Mirrors lib/layout-extract.mjs's decodePng pattern (that file is owned by another agent, so this
// is a small self-contained copy rather than an import/edit there).

/** Paeth predictor (PNG filter type 4) — same algorithm as layout-extract.mjs's decoder. */
function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Minimal zero-dep PNG decoder → { width, height, channels, data } (raw 8-bit RGB/RGBA bytes).
 *  Handles non-interlaced 8-bit colorType 2 (RGB) / 6 (RGBA) with all 5 standard line filters.
 *  Returns null for anything else (grayscale/palette/16-bit/interlaced) so the caller can skip
 *  pixelation gracefully rather than throw. */
function decodePngBuffer(buf) {
  try {
    if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) return null;
    let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
    const idat = [];
    let off = 8;
    while (off + 8 <= buf.length) {
      const len = buf.readUInt32BE(off);
      const type = buf.toString('ascii', off + 4, off + 8);
      const dataStart = off + 8;
      if (type === 'IHDR') {
        width = buf.readUInt32BE(dataStart);
        height = buf.readUInt32BE(dataStart + 4);
        bitDepth = buf[dataStart + 8];
        colorType = buf[dataStart + 9];
        interlace = buf[dataStart + 12];
      } else if (type === 'IDAT') {
        idat.push(buf.subarray(dataStart, dataStart + len));
      } else if (type === 'IEND') break;
      off = dataStart + len + 4;
    }
    if (!width || !height || bitDepth !== 8 || interlace !== 0) return null;
    const channels = colorType === 2 ? 3 : colorType === 6 ? 4 : 0;
    if (!channels) return null;
    const raw = inflateSync(Buffer.concat(idat));
    const stride = width * channels;
    if (raw.length < (stride + 1) * height) return null;
    const out = Buffer.alloc(stride * height);
    let prevRow = Buffer.alloc(stride);
    let pos = 0;
    for (let y = 0; y < height; y++) {
      const filter = raw[pos++];
      const row = out.subarray(y * stride, y * stride + stride);
      for (let i = 0; i < stride; i++) {
        const x = raw[pos++];
        const a = i >= channels ? row[i - channels] : 0;
        const b = prevRow[i];
        const c = i >= channels ? prevRow[i - channels] : 0;
        let val;
        switch (filter) {
          case 1: val = x + a; break;
          case 2: val = x + b; break;
          case 3: val = x + ((a + b) >> 1); break;
          case 4: val = x + paethPredictor(a, b, c); break;
          default: val = x;
        }
        row[i] = val & 0xff;
      }
      prevRow = row;
    }
    return { width, height, channels, data: out };
  } catch { return null; }
}

/** CRC-32 (IEEE 802.3), table-based — PNG chunk CRCs. Self-contained rather than relying on
 *  node:zlib's crc32 (only added in newer Node — this keeps the encoder portable). */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32Buf(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** One length-prefixed, CRC-suffixed PNG chunk. */
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32Buf(typeData), 0);
  return Buffer.concat([len, typeData, crc]);
}

/** Encode raw RGBA (or RGB) 8-bit pixels back to a minimal PNG (no filtering — filter type 0/None
 *  per row is valid PNG, just less compressible; fine for small pixelated block-averaged images). */
function encodePngBuffer({ width, height, channels, data }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = channels === 4 ? 6 : 2; // colorType
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type None
    data.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = deflateSync(raw);
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Downscale-then-upscale mosaic pixelation on raw decoded pixels — box-filter average per block
 *  on the way down, nearest-neighbor replication on the way back up. `blockSize` is in PIXELS at
 *  the image's own decoded resolution (matches raster.ts/designSvg.ts semantics: block size at
 *  the layer's native/rendered resolution). */
function pixelatePixels({ width, height, channels, data }, blockSize) {
  const block = Math.max(1, Math.round(blockSize));
  if (block <= 1) return { width, height, channels, data };
  const out = Buffer.alloc(data.length);
  for (let by = 0; by < height; by += block) {
    const bh = Math.min(block, height - by);
    for (let bx = 0; bx < width; bx += block) {
      const bw = Math.min(block, width - bx);
      const sums = new Array(channels).fill(0);
      for (let y = by; y < by + bh; y++) {
        for (let x = bx; x < bx + bw; x++) {
          const p = (y * width + x) * channels;
          for (let ch = 0; ch < channels; ch++) sums[ch] += data[p + ch];
        }
      }
      const n = bw * bh;
      const avg = sums.map((s) => Math.round(s / n));
      for (let y = by; y < by + bh; y++) {
        for (let x = bx; x < bx + bw; x++) {
          const p = (y * width + x) * channels;
          for (let ch = 0; ch < channels; ch++) out[p + ch] = avg[ch];
        }
      }
    }
  }
  return { width, height, channels, data: out };
}

/** style.pixelate (block size in px) isn't declared on LayerStyle (src/lib/sceneGraph.ts) yet —
 *  see this task's report for the exact field addition needed (`pixelate?: number`). Read
 *  defensively so this works ahead of that field landing. */
function pixelateBlockSize(style) {
  const v = style && style.pixelate;
  return typeof v === 'number' && v > 0 ? v : 0;
}

/** Given a resolved image src (data URL OR a plain http(s)/relative URL we can't fetch
 *  synchronously here), returns a pixelated data URL, or the ORIGINAL src unchanged if the input
 *  isn't a decodable PNG data URL (JPEG data URLs, remote URLs, or anything our zero-dep decoder
 *  can't handle — e.g. grayscale/palette/interlaced PNGs). Never throws: worst case the export
 *  falls through to the sharp image (no pixelation) rather than failing the whole render. Real
 *  pixelation server-side is thus feasible+applied for the common case (PNG data URLs, which is
 *  what makeImageResolver produces for every local/same-origin image); the documented gap is
 *  JPEG-sourced or unresolvable/remote images, where this returns the src unchanged.
 */
function pixelateDataUrlServer(src, blockSize) {
  try {
    const m = /^data:image\/png;base64,(.+)$/.exec(String(src || ''));
    if (!m) return src; // not a PNG data URL — see documented gap above
    const buf = Buffer.from(m[1], 'base64');
    const decoded = decodePngBuffer(buf);
    if (!decoded) return src; // undecodable (grayscale/palette/16-bit/interlaced) — leave sharp
    const mosaic = pixelatePixels(decoded, blockSize);
    const png = encodePngBuffer(mosaic);
    return `data:image/png;base64,${png.toString('base64')}`;
  } catch { return src; }
}

function styleFor(layer) {
  const s = layer.style || {};
  const b = layer.box;
  // autoH text grows with content (never clips) — height becomes a floor, overflow visible.
  const autoH = layer.autoH && layer.type !== 'image' && layer.type !== 'shape' && layer.type !== 'vignette';
  const parts = [
    `position:absolute`, `left:${b.x}px`, `top:${b.y}px`, `width:${b.w}px`,
    autoH ? `min-height:${b.h}px` : `height:${b.h}px`,
    `box-sizing:border-box`, autoH ? 'overflow:visible' : `overflow:hidden`,
  ];
  if (s.opacity != null && s.opacity < 1) parts.push(`opacity:${s.opacity}`);
  // PARITY: style.blend → mix-blend-mode (Stage), globalCompositeOperation (raster),
  // mix-blend-mode (designSvg). Restricted to multiply/screen/overlay by migrateDoc.
  if (s.blend && s.blend !== 'normal') parts.push(`mix-blend-mode:${s.blend}`);
  // PARITY: style.blur (LAYER blur) → CSS filter blur (Stage) / ctx.filter blur (raster) /
  // feGaussianBlur (designSvg). Distinct from backdropBlur below.
  if (s.blur > 0) parts.push(`filter:blur(${s.blur}px)`);
  // polyline uses style.stroke for its LINE width (drawn in the inline <svg>) — no box border.
  if (s.stroke && s.stroke.width > 0 && !(layer.type === 'shape' && s.shapeKind === 'polyline')) {
    parts.push(`border:${s.stroke.width}px solid ${s.stroke.color}`);
  }
  // PARITY: Layer.rotation (degrees clockwise about box center) — raster/SVG rotate about the
  // same center; CSS default transform-origin is the center, made explicit here.
  if (layer.rotation) parts.push(`transform:rotate(${layer.rotation}deg)`, 'transform-origin:center');
  // PARITY: backdropBlur — HTML gets REAL frosted glass via backdrop-filter; raster/SVG only
  // approximate with a 1px glass-edge stroke (noted limitation there).
  if (s.backdropBlur > 0) {
    parts.push(`backdrop-filter:blur(${s.backdropBlur}px)`, `-webkit-backdrop-filter:blur(${s.backdropBlur}px)`);
  }
  if (layer.type === 'image') {
    parts.push('display:block');
  } else if (layer.type === 'vignette') {
    parts.push(`background:${vignetteCssJs(s)}`);
  } else if (layer.type === 'shape') {
    // Shapes: a fill (solid or gradient) — scrims, color blocks, cards.
    // shapeKind (PARITY with raster.ts drawShape / designSvg.ts shapeSvg):
    const kind = s.shapeKind || 'rect';
    if (kind === 'arrow' || kind === 'line' || kind === 'polyline' || kind === 'path') {
      // Shaft/head/polyline/freeform-path drawn by an inline <svg> child in renderDesignHtml —
      // no CSS fill behind. PARITY: raster pathGeometry / designSvg <path>.
      parts.push('background:transparent');
    } else {
      parts.push(`background:${gradientCssJs(s) || s.background || '#000'}`);
      if (kind === 'ellipse') parts.push('border-radius:50%');
      else if (kind === 'starburst') parts.push(`clip-path:polygon(${starburstPolygonCss(s.spikes)})`);
      else {
        // radiusCorners wins over radius — PARITY: Stage cornerCss / raster cornerRadii.
        const rr = cornerCssJs(s);
        if (rr) parts.push(`border-radius:${rr}`);
      }
    }
  } else {
    parts.push(
      `display:flex`, `align-items:center`,
      `justify-content:${s.align === 'center' ? 'center' : s.align === 'right' ? 'flex-end' : 'flex-start'}`,
      `text-align:${s.align || 'left'}`,
      fontFamilyCss(s),
      `font-size:${s.fontSize || 40}px`,
      `font-weight:${s.fontWeight || 600}`,
      `line-height:${s.lineHeight || 1.2}`,
      `color:${s.color || '#ffffff'}`,
    );
    if (s.letterSpacing) parts.push(`letter-spacing:${s.letterSpacing}px`);
    if (s.background || (s.gradient && typeof s.gradient === 'object')) parts.push(`background:${gradientCssJs(s) || s.background}`);
    {
      // radiusCorners wins over radius — PARITY: Stage cornerCss / raster cornerRadii / designSvg.
      const rr = cornerCssJs(s);
      if (rr) parts.push(`border-radius:${rr}`);
    }
    if (s.padding) parts.push(`padding:${s.padding}px`);
    // PARITY: Stage/raster/designSvg only uppercase the glyphs — they do NOT add extra tracking.
    // The old `letter-spacing:0.04em` here silently widened every uppercased line vs the canvas.
    if (s.uppercase) parts.push('text-transform:uppercase');
    // PARITY: raster/SVG draw an explicit strike line with the same €19→€11 treatment.
    if (s.strikethrough) parts.push('text-decoration:line-through');
    if (s.shadow) parts.push('text-shadow:0 2px 12px rgba(0,0,0,0.55)');
  }
  return parts.join(';');
}

/** Render the doc to a standalone HTML string. `resolveImage(src) -> dataUrl|src` lets the
 *  export inline same-origin images as data URLs; pass identity for a live-server preview. */
export function renderDesignHtml(doc, resolveImage = (s) => s) {
  // Flatten the v3 tree in paint order — child coords are absolute, so groups only contribute
  // opacity (multiplied into each leaf) and ordering.
  const flat = [];
  const collect = (nodes, groupOpacity) => {
    for (const n of nodes || []) {
      if (!n || n.hidden) continue;
      if (n.type === 'group') {
        collect(n.children, groupOpacity * (n.style && n.style.opacity != null ? n.style.opacity : 1));
      } else if (groupOpacity < 1) {
        const s = { ...(n.style || {}) };
        s.opacity = (s.opacity == null ? 1 : s.opacity) * groupOpacity;
        flat.push({ ...n, style: s });
      } else {
        flat.push(n);
      }
    }
  };
  collect(doc.layers, 1);
  const layers = flat.map((layer) => {
    if (layer.type === 'image') {
      const is = layer.style || {};
      let resolved = resolveImage(layer.src || '');
      // style.pixelate: true mosaic censoring server-side too (e.g. a face/username in a real
      // photo/avatar), decoded+downsampled+re-encoded as PNG entirely in Node — see
      // pixelateDataUrlServer above. Falls through to the sharp image (documented gap) when the
      // resolved src isn't a decodable PNG data URL (JPEG-sourced or unresolved/remote images).
      const blockSize = pixelateBlockSize(is);
      if (blockSize) resolved = pixelateDataUrlServer(resolved, blockSize);
      const src = esc(resolved);
      // PARITY: Stage puts borderRadius on the <img> (ellipse → 50%, else radiusCorners/radius);
      // raster clips drawImage to that geometry; designSvg clips the <image>. Was square before.
      const imgRadius = is.shapeKind === 'ellipse' ? '50%' : cornerCssJs(is);
      const radiusCss = imgRadius ? `;border-radius:${imgRadius}` : '';
      return `  <div style="${styleFor(layer)}"><img src="${src}" alt="" style="width:100%;height:100%;object-fit:${layer.fit || 'cover'};display:block${radiusCss}"/></div>`;
    }
    if (layer.type === 'shape' || layer.type === 'vignette') {
      const s = layer.style || {};
      const kind = layer.type === 'shape' ? (s.shapeKind || 'rect') : 'rect';
      if (kind === 'path') {
        // PARITY: raster pathGeometry / designSvg <path> — style.path coords are normalized
        // 0..1 in box space; bake translate·scale into the inline <svg> so the box-local d-string
        // fills at the right place. Fill = gradient||background; optional stroke.
        const b = layer.box;
        if (!s.path) return `  <div style="${styleFor(layer)}"></div>`;
        // NOTE: SVG <path> fill can't take a CSS gradient string — solid background only here
        // (raster/designSvg support gradient path fills); noted approximation for the HTML export.
        const fill = esc(s.background || '#000');
        const strokeAttr = s.stroke && s.stroke.width > 0
          ? ` stroke="${esc(s.stroke.color)}" stroke-width="${s.stroke.width}" vector-effect="non-scaling-stroke"` : '';
        const inner = `<path d="${esc(s.path)}" transform="translate(0 0) scale(${b.w} ${b.h})" fill="${fill}"${strokeAttr}/>`;
        return `  <div style="${styleFor(layer)}"><svg width="${b.w}" height="${b.h}" viewBox="0 0 ${b.w} ${b.h}" style="display:block;overflow:visible" xmlns="http://www.w3.org/2000/svg">${inner}</svg></div>`;
      }
      if (kind === 'polyline') {
        // PARITY: raster.ts drawShape polyline / designSvg.ts <polyline> — style.points are
        // flat x,y pairs normalized 0..1 in the box; stroke background||color at
        // stroke.width || max(2, min(w,h)*0.02), round joins/caps, no fill. Emitted as an
        // inline <svg> child in box-local coords, like arrow/line below.
        const b = layer.box;
        const pts = Array.isArray(s.points) ? s.points : [];
        if (pts.length < 4) return `  <div style="${styleFor(layer)}"></div>`;
        const mapped = [];
        for (let i = 0; i + 1 < pts.length; i += 2) {
          mapped.push(`${Math.round(pts[i] * b.w * 100) / 100},${Math.round(pts[i + 1] * b.h * 100) / 100}`);
        }
        const wdt = (s.stroke && s.stroke.width) || Math.max(2, Math.min(b.w, b.h) * 0.02);
        const color = esc(s.background || s.color || '#111');
        const inner = `<polyline points="${mapped.join(' ')}" fill="none" stroke="${color}" stroke-width="${wdt}" stroke-linejoin="round" stroke-linecap="round"/>`;
        return `  <div style="${styleFor(layer)}"><svg width="${b.w}" height="${b.h}" viewBox="0 0 ${b.w} ${b.h}" style="display:block;overflow:visible" xmlns="http://www.w3.org/2000/svg">${inner}</svg></div>`;
      }
      if (kind === 'arrow' || kind === 'line') {
        // PARITY: duplicates arrowGeometry in src/components/design/fills.ts (diagonal + head
        // wings + width rule) in box-local coords — change both together.
        const b = layer.box;
        const x1 = 0, y1 = s.flipDiag ? b.h : 0, x2 = b.w, y2 = s.flipDiag ? 0 : b.h;
        const ang = Math.atan2(y2 - y1, x2 - x1);
        const len = Math.hypot(x2 - x1, y2 - y1);
        const headLen = Math.max(10, Math.min(len * 0.25, 42));
        const spread = Math.PI / 7;
        const wdt = Math.max(2, Math.min(b.w, b.h) * 0.06);
        const color = esc(s.background || s.color || '#111');
        const seg = (ax, ay, bx, by) =>
          `<line x1="${ax}" y1="${ay}" x2="${bx}" y2="${by}" stroke="${color}" stroke-width="${wdt}" stroke-linecap="round"/>`;
        let inner = seg(x1, y1, x2, y2);
        if (kind === 'arrow') {
          inner += seg(x2, y2, x2 - headLen * Math.cos(ang - spread), y2 - headLen * Math.sin(ang - spread));
          inner += seg(x2, y2, x2 - headLen * Math.cos(ang + spread), y2 - headLen * Math.sin(ang + spread));
        }
        return `  <div style="${styleFor(layer)}"><svg width="${b.w}" height="${b.h}" viewBox="0 0 ${b.w} ${b.h}" style="display:block;overflow:visible" xmlns="http://www.w3.org/2000/svg">${inner}</svg></div>`;
      }
      return `  <div style="${styleFor(layer)}"></div>`;
    }
    const text = esc(layer.text || '');
    const st = layer.style || {};
    if (st.pill && st.background) {
      // IG-caption pill: block wrapper (text-align) + inline span with box-decoration-break
      // so every wrapped line hugs its own rounded background (same as the live Stage).
      const padX = st.padding || 14;
      const pillSpan =
        `background:${st.background};border-radius:${st.radius || 10}px;` +
        `padding:${Math.round(padX * 0.55)}px ${padX}px;display:inline;` +
        `box-decoration-break:clone;-webkit-box-decoration-break:clone;white-space:pre-wrap`;
      return `  <div style="${styleFor(layer)};background:transparent;padding:0;line-height:${(st.lineHeight || 1.2) * 1.25}">` +
        `<span style="display:block;width:100%;text-align:${st.align || 'left'}">` +
        `<span style="${pillSpan}">${text}</span></span></div>`;
    }
    return `  <div style="${styleFor(layer)}"><span style="width:100%">${text}</span></div>`;
  });
  // Embed Inter as @font-face (base64 woff2, cached in-process by font-faces.mjs) so this HTML
  // renders with real fonts offline and server-side — qlmanage (sandboxed, can't see the host's
  // installed fonts) AND any future headless-Chrome export path both get Inter with zero network
  // dependency, avoiding the "tofu" bug a name-only font reference caused.
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${esc(doc.name)}</title>${fontFaceStyleTag()}</head>
<body style="margin:0;background:#111">
<div id="comp" style="position:relative;width:${doc.canvas.w}px;height:${doc.canvas.h}px;overflow:hidden;background:#000">
${layers.join('\n')}
</div>
</body></html>
`;
}

// Resolve a same-origin image URL to a local file we can inline. Mirrors the server's own
// URL conventions: /img?path=REL → renders tree; /asset?name=X → repo assets; /refs?name=F →
// assets/refs; /api/trendtrack/image/ID → trendtrack cache.
export function makeImageResolver({ renders, repo, ttImagePath }) {
  return (src) => {
    try {
      const u = new URL(String(src || ''), 'http://localhost');
      let file = null;
      if (u.pathname === '/img') file = join(renders, u.searchParams.get('path') || '');
      else if (u.pathname === '/asset') file = join(repo, 'assets', `${u.searchParams.get('name')}.png`);
      else if (u.pathname === '/refs') file = join(repo, 'assets', 'refs', u.searchParams.get('name') || '');
      else if (u.pathname.startsWith('/api/trendtrack/image/')) file = ttImagePath(u.pathname.split('/').pop());
      else if (u.pathname === '/refasset') file = join(repo, 'studio', '.state', 'refs', `${u.searchParams.get('id')}.png`);
      if (!file || !existsSync(file)) return src;
      const ext = file.toLowerCase().endsWith('.jpg') || file.toLowerCase().endsWith('.jpeg') ? 'jpeg' : 'png';
      return `data:image/${ext};base64,${readFileSync(file).toString('base64')}`;
    } catch { return src; }
  };
}

const FIGMA_MD = `# Getting this comp into Figma as real layers

Three free paths (no Figma Enterprise API needed):

## A. Paste the SVG (fastest — native layers, no plugin)
1. Open comp.svg in a text editor and copy ALL of it
   (or use "Copy SVG for Figma" in NEUEGEN Design mode — same thing).
2. In Figma, just paste (⌘V). Figma converts SVG natively into real, editable
   layers: text stays text, rectangles stay rectangles, the photo lands as an
   image fill. Ungroup and edit.

## B. html.to.design plugin
1. Open Figma (free Starter is fine) → Plugins → "html.to.design".
2. Choose "Paste HTML" and paste the full contents of comp.html
   (every image is inlined as a data URL — nothing needs to be hosted).
3. The importer recreates the absolute-layout divs as real, editable Figma layers.

## B. Figma MCP (if you use Claude with the Figma connector)
1. Ask Claude: "generate a Figma design from this HTML" and attach comp.html.
2. The generate_figma_design tool pushes it to your open Figma file via the clipboard.

comp.json is the scene graph — re-import it in NEUEGEN Design mode or hand it to the
design agent. comp.png is the flattened preview (not the primary deliverable).
`;

/** Write the export bundle. `pngBase64` + `svg` optional (browser-rendered). Returns paths. */
export function exportDesign(doc, { resolveImage, pngBase64 = null, svg = null } = {}) {
  ensureDirs();
  const dir = join(EXPORTS, safeId(doc.id));
  mkdirSync(dir, { recursive: true });
  const files = {};
  writeFileSync(join(dir, 'comp.json'), JSON.stringify(doc, null, 2));
  files.json = join(dir, 'comp.json');
  writeFileSync(join(dir, 'comp.html'), renderDesignHtml(doc, resolveImage || ((s) => s)));
  files.html = join(dir, 'comp.html');
  if (svg) {
    // Browser-generated (accurate text wrapping via canvas measurement, images inlined).
    writeFileSync(join(dir, 'comp.svg'), String(svg));
    files.svg = join(dir, 'comp.svg');
  }
  if (pngBase64) {
    try {
      writeFileSync(join(dir, 'comp.png'), Buffer.from(String(pngBase64).replace(/^data:image\/png;base64,/, ''), 'base64'));
      files.png = join(dir, 'comp.png');
    } catch { /* png is best-effort */ }
  }
  writeFileSync(join(dir, 'FIGMA.md'), FIGMA_MD);
  files.figmaMd = join(dir, 'FIGMA.md');
  return { dir, files };
}
