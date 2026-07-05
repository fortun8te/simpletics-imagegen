// canvas-shim.mjs — a real, pixel-accurate (enough) 2D canvas + DOM shim for the cutout parity
// harness, so the ACTUAL browser renderer code (raster.ts drawImageLayer, figmaClipboard.ts
// cutoutBitmap, designSvg.ts cropDataUrl) runs unmodified in Node and we can sample the pixels it
// produces. Zero dependencies.
//
// Scope: exactly the ops the cut-out / image code paths touch — drawImage(src-rect→dest-rect) with
// nearest-neighbor scaling, path building (moveTo/lineTo/arcTo/ellipse/rect/beginPath/closePath),
// clip() as a rasterized mask, globalCompositeOperation 'destination-in'/'source-over', fill,
// fillRect, save/restore of transform+clip+compositing, scale/translate/rotate, toDataURL/toBlob.
// It is NOT a general canvas — text (fillText) is a no-op (irrelevant to cut-out pixels), and
// imageSmoothing flags are honored only insofar as they don't change which source pixel maps where
// (we use point sampling, which is what matters for "does the crop land on the right sub-rect").

import { encodePng, decodePng } from './mini-png.mjs';

// ── geometry: a polygon/subpath rasterizer for clip masks ────────────────────────────────────────
// We flatten each subpath (arcs → line segments) into polygons and test point-in-polygon per pixel
// for clip masks. Good enough to verify "inside the circle = kept, outside = transparent".

function ellipsePts(cx, cy, rx, ry, n = 128) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    pts.push([cx + rx * Math.cos(t), cy + ry * Math.sin(t)]);
  }
  return pts;
}

// arcTo flattening: approximate the rounded corner between the incoming point and (x1,y1)->(x2,y2).
function arcToPts(from, x1, y1, x2, y2, r) {
  // Replicate canvas arcTo: tangent circle of radius r touching line(from->p1) and line(p1->p2).
  if (r <= 0) return [[x1, y1]];
  const v1 = [from[0] - x1, from[1] - y1];
  const v2 = [x2 - x1, y2 - y1];
  const n1 = Math.hypot(v1[0], v1[1]) || 1;
  const n2 = Math.hypot(v2[0], v2[1]) || 1;
  const u1 = [v1[0] / n1, v1[1] / n1];
  const u2 = [v2[0] / n2, v2[1] / n2];
  const cross = u1[0] * u2[1] - u1[1] * u2[0];
  if (Math.abs(cross) < 1e-6) return [[x1, y1]];
  const angle = Math.acos(Math.max(-1, Math.min(1, u1[0] * u2[0] + u1[1] * u2[1])));
  const tan = r / Math.tan(angle / 2);
  const t1 = [x1 + u1[0] * tan, x1 + 0 + u1[1] * tan]; // placeholder; fixed below
  // tangent points
  const p1 = [x1 + u1[0] * tan, y1 + u1[1] * tan];
  const p2 = [x1 + u2[0] * tan, y1 + u2[1] * tan];
  // center: along the bisector
  const bis = [u1[0] + u2[0], u1[1] + u2[1]];
  const bn = Math.hypot(bis[0], bis[1]) || 1;
  const ub = [bis[0] / bn, bis[1] / bn];
  const dist = r / Math.sin(angle / 2);
  const center = [x1 + ub[0] * dist, y1 + ub[1] * dist];
  const a0 = Math.atan2(p1[1] - center[1], p1[0] - center[0]);
  const a1 = Math.atan2(p2[1] - center[1], p2[0] - center[0]);
  let da = a1 - a0;
  while (da > Math.PI) da -= 2 * Math.PI;
  while (da < -Math.PI) da += 2 * Math.PI;
  const steps = 16;
  const out = [p1];
  for (let i = 1; i <= steps; i++) {
    const a = a0 + (da * i) / steps;
    out.push([center[0] + r * Math.cos(a), center[1] + r * Math.sin(a)]);
  }
  void t1;
  return out;
}

function pointInPolys(polys, px, py) {
  let inside = false;
  for (const poly of polys) {
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i][0], yi = poly[i][1];
      const xj = poly[j][0], yj = poly[j][1];
      const hit = (yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
      if (hit) inside = !inside;
    }
  }
  return inside;
}

// ── the 2D context ───────────────────────────────────────────────────────────────────────────────

class Ctx2D {
  constructor(canvas) {
    this.canvas = canvas;
    this._w = canvas.width;
    this._h = canvas.height;
    this._buf = new Uint8Array(this._w * this._h * 4); // RGBA, starts fully transparent
    this._t = [1, 0, 0, 1, 0, 0]; // affine transform a,b,c,d,e,f
    this._clip = null;            // array of polygons (device space) or null
    this._sub = [];               // current subpaths (device space)
    this._cur = null;             // current subpath being built
    this._stack = [];
    this.fillStyle = '#000';
    this.strokeStyle = '#000';
    this.lineWidth = 1;
    this.globalAlpha = 1;
    this.globalCompositeOperation = 'source-over';
    this.imageSmoothingEnabled = true;
    this.filter = 'none';
    this.font = '';
    this.textBaseline = 'alphabetic';
    this.shadowColor = 'transparent';
    this.shadowBlur = 0;
    this.shadowOffsetY = 0;
    this.lineCap = 'butt';
    this.lineJoin = 'miter';
    this.letterSpacing = '0px';
  }
  // transform application (point → device)
  _apply(x, y) {
    const [a, b, c, d, e, f] = this._t;
    return [a * x + c * y + e, b * x + d * y + f];
  }
  save() {
    this._stack.push({ t: [...this._t], clip: this._clip ? this._clip.map((p) => p.map((q) => [...q])) : null,
      fillStyle: this.fillStyle, globalAlpha: this.globalAlpha, gco: this.globalCompositeOperation });
  }
  restore() {
    const s = this._stack.pop();
    if (!s) return;
    this._t = s.t; this._clip = s.clip; this.fillStyle = s.fillStyle;
    this.globalAlpha = s.globalAlpha; this.globalCompositeOperation = s.gco;
  }
  scale(sx, sy) { this._t = mul(this._t, [sx, 0, 0, sy, 0, 0]); }
  translate(tx, ty) { this._t = mul(this._t, [1, 0, 0, 1, tx, ty]); }
  rotate(rad) { const c = Math.cos(rad), s = Math.sin(rad); this._t = mul(this._t, [c, s, -s, c, 0, 0]); }
  // path building — points stored in DEVICE space (transform baked in at build time, like canvas)
  beginPath() { this._sub = []; this._cur = null; }
  closePath() { if (this._cur && this._cur.length) { this._sub.push(this._cur); this._cur = null; } }
  moveTo(x, y) { if (this._cur && this._cur.length) this._sub.push(this._cur); this._cur = [this._apply(x, y)]; }
  lineTo(x, y) { if (!this._cur) this._cur = []; this._cur.push(this._apply(x, y)); }
  rect(x, y, w, h) {
    this.moveTo(x, y); this.lineTo(x + w, y); this.lineTo(x + w, y + h); this.lineTo(x, y + h); this.closePath();
  }
  arcTo(x1, y1, x2, y2, r) {
    if (!this._cur || !this._cur.length) { this._cur = [this._apply(x1, y1)]; return; }
    // build the arc in USER space then map to device
    const fromDev = this._cur[this._cur.length - 1];
    const fromUser = this._invApply(fromDev);
    const pts = arcToPts(fromUser, x1, y1, x2, y2, r);
    for (const [ux, uy] of pts) this._cur.push(this._apply(ux, uy));
  }
  ellipse(cx, cy, rx, ry, _rot, _a0, _a1) {
    if (this._cur && this._cur.length) { this._sub.push(this._cur); this._cur = null; }
    const pts = ellipsePts(cx, cy, rx, ry).map(([x, y]) => this._apply(x, y));
    this._sub.push(pts);
  }
  arc(cx, cy, r, _a0, _a1) { this.ellipse(cx, cy, r, r); }
  _invApply(dev) {
    const [a, b, c, d, e, f] = this._t;
    const det = a * d - b * c;
    const x = dev[0] - e, y = dev[1] - f;
    return [(d * x - c * y) / det, (-b * x + a * y) / det];
  }
  _polys() {
    const polys = this._sub.map((p) => p);
    if (this._cur && this._cur.length) polys.push(this._cur);
    return polys.filter((p) => p.length >= 3);
  }
  clip() {
    const polys = this._polys();
    // intersect with existing clip by AND at sample time — store as a list of poly-groups
    if (!this._clip) this._clip = [];
    this._clip.push(polys);
  }
  _clipTest(px, py) {
    if (!this._clip) return true;
    // _clip is a list of clip regions (each a set of polys); pixel must be inside ALL of them
    for (const region of this._clip) if (!pointInPolys(region, px, py)) return false;
    return true;
  }
  _plot(px, py, rgba) {
    if (px < 0 || py < 0 || px >= this._w || py >= this._h) return;
    if (!this._clipTest(px + 0.5, py + 0.5)) return;
    const i = (py * this._w + px) * 4;
    const [r, g, b, a] = rgba;
    const alpha = (a / 255) * this.globalAlpha;
    if (this.globalCompositeOperation === 'destination-in') {
      // keep destination scaled by source alpha (source color ignored)
      const da = this._buf[i + 3] / 255;
      const na = da * alpha;
      this._buf[i + 3] = Math.round(na * 255);
      return;
    }
    // source-over
    const sa = alpha;
    const da = this._buf[i + 3] / 255;
    const outA = sa + da * (1 - sa);
    if (outA <= 0) { this._buf[i] = this._buf[i + 1] = this._buf[i + 2] = this._buf[i + 3] = 0; return; }
    this._buf[i] = Math.round((r * sa + this._buf[i] * da * (1 - sa)) / outA);
    this._buf[i + 1] = Math.round((g * sa + this._buf[i + 1] * da * (1 - sa)) / outA);
    this._buf[i + 2] = Math.round((b * sa + this._buf[i + 2] * da * (1 - sa)) / outA);
    this._buf[i + 3] = Math.round(outA * 255);
  }
  _destInSweep() {
    // For destination-in with a filled path (the cutout alpha step): zero every pixel NOT in the
    // path. We handle this in fill() by sweeping the whole buffer against the path.
  }
  fill() {
    const polys = this._polys();
    const col = parseColor(this.fillStyle);
    if (this.globalCompositeOperation === 'destination-in') {
      // Sweep entire canvas: keep only pixels inside the path (respect clip too).
      for (let y = 0; y < this._h; y++) {
        for (let x = 0; x < this._w; x++) {
          const inside = pointInPolys(polys, x + 0.5, y + 0.5) && this._clipTest(x + 0.5, y + 0.5);
          if (!inside) {
            const i = (y * this._w + x) * 4;
            this._buf[i + 3] = 0;
          }
        }
      }
      return;
    }
    // source-over fill of the path region
    const bb = bbox(polys, this._w, this._h);
    for (let y = bb.y0; y < bb.y1; y++) {
      for (let x = bb.x0; x < bb.x1; x++) {
        if (pointInPolys(polys, x + 0.5, y + 0.5)) this._plot(x, y, col);
      }
    }
  }
  fillRect(x, y, w, h) {
    const col = parseColor(this.fillStyle);
    const p0 = this._apply(x, y), p1 = this._apply(x + w, y), p2 = this._apply(x + w, y + h), p3 = this._apply(x, y + h);
    const poly = [p0, p1, p2, p3];
    const bb = bbox([poly], this._w, this._h);
    for (let yy = bb.y0; yy < bb.y1; yy++) {
      for (let xx = bb.x0; xx < bb.x1; xx++) {
        if (pointInPolys([poly], xx + 0.5, yy + 0.5)) this._plot(xx, yy, col);
      }
    }
  }
  stroke() { /* not needed for cut-out pixel parity */ }
  fillText() { /* text irrelevant to cut-out pixels */ }
  measureText(t) { return { width: String(t).length * 10 }; }
  setLineDash() {}
  // drawImage: (img, dx, dy, dw, dh) OR (img, sx, sy, sw, sh, dx, dy, dw, dh)
  drawImage(img, ...a) {
    const src = imgData(img);
    let sx, sy, sw, sh, dx, dy, dw, dh;
    if (a.length === 8) { [sx, sy, sw, sh, dx, dy, dw, dh] = a; }
    else if (a.length === 4) { [dx, dy, dw, dh] = a; sx = 0; sy = 0; sw = src.width; sh = src.height; }
    else { [dx, dy] = a; dw = src.width; dh = src.height; sx = 0; sy = 0; sw = src.width; sh = src.height; }
    // For each destination pixel, map back into the source sub-rect (point sampling).
    const p0 = this._apply(dx, dy), p1 = this._apply(dx + dw, dy), p2 = this._apply(dx + dw, dy + dh), p3 = this._apply(dx, dy + dh);
    const poly = [p0, p1, p2, p3];
    const bb = bbox([poly], this._w, this._h);
    const [a0, b0, c0, d0, e0, f0] = this._t;
    const det = a0 * d0 - b0 * c0;
    for (let yy = bb.y0; yy < bb.y1; yy++) {
      for (let xx = bb.x0; xx < bb.x1; xx++) {
        const cxp = xx + 0.5, cyp = yy + 0.5;
        // device → user
        const ux = (d0 * (cxp - e0) - c0 * (cyp - f0)) / det;
        const uy = (-b0 * (cxp - e0) + a0 * (cyp - f0)) / det;
        // user → dest-local 0..1
        const fx = (ux - dx) / dw;
        const fy = (uy - dy) / dh;
        if (fx < 0 || fx >= 1 || fy < 0 || fy >= 1) continue;
        // → source pixel
        const spx = Math.min(src.width - 1, Math.max(0, Math.floor(sx + fx * sw)));
        const spy = Math.min(src.height - 1, Math.max(0, Math.floor(sy + fy * sh)));
        const si = (spy * src.width + spx) * 4;
        this._plot(xx, yy, [src.data[si], src.data[si + 1], src.data[si + 2], src.data[si + 3]]);
      }
    }
  }
  getImageData(x, y, w, h) {
    const data = new Uint8ClampedArray(w * h * 4);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const si = ((y + j) * this._w + (x + i)) * 4;
      const di = (j * w + i) * 4;
      data[di] = this._buf[si]; data[di + 1] = this._buf[si + 1];
      data[di + 2] = this._buf[si + 2]; data[di + 3] = this._buf[si + 3];
    }
    return { width: w, height: h, data };
  }
}

function mul(m, n) {
  // m ∘ n (apply n first) — both [a,b,c,d,e,f]
  const [a, b, c, d, e, f] = m;
  const [A, B, C, D, E, F] = n;
  return [a * A + c * B, b * A + d * B, a * C + c * D, b * C + d * D, a * E + c * F + e, b * E + d * F + f];
}
function bbox(polys, W, H) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of polys) for (const [x, y] of p) {
    if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y;
  }
  return {
    x0: Math.max(0, Math.floor(x0)), y0: Math.max(0, Math.floor(y0)),
    x1: Math.min(W, Math.ceil(x1)), y1: Math.min(H, Math.ceil(y1)),
  };
}

const NAMED = { black: [0, 0, 0, 255], white: [255, 255, 255, 255], transparent: [0, 0, 0, 0], red: [255, 0, 0, 255] };
function parseColor(s) {
  if (Array.isArray(s)) return s;
  const raw = String(s || '#000').trim().toLowerCase();
  if (NAMED[raw]) return NAMED[raw];
  let m = raw.match(/^#([0-9a-f]{3,8})$/);
  if (m) {
    let hex = m[1];
    if (hex.length === 3 || hex.length === 4) hex = [...hex].map((c) => c + c).join('');
    const n = (i) => parseInt(hex.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), hex.length === 8 ? n(6) : 255];
  }
  m = raw.match(/^rgba?\(([^)]+)\)/);
  if (m) {
    const parts = m[1].split(/[,\s/]+/).filter(Boolean);
    return [+parts[0], +parts[1], +parts[2], parts[3] != null ? Math.round(parseFloat(parts[3]) * 255) : 255];
  }
  return [0, 0, 0, 255];
}

// ── image sources (Image, ImageBitmap) carry a decoded {width,height,data} ──────────────────────
const IMG_DATA = new WeakMap();
function imgData(img) {
  // A Canvas source (offscreen used by pixelate/crop) → read its live pixel buffer.
  if (img instanceof Canvas) {
    const ctx = img._ctx;
    return { width: img.width, height: img.height, data: ctx ? ctx._buf : new Uint8Array(img.width * img.height * 4) };
  }
  const d = IMG_DATA.get(img);
  if (!d) throw new Error('drawImage: source has no decoded data (shim)');
  return d;
}
export function attachImageData(obj, decoded) { IMG_DATA.set(obj, decoded); return obj; }

// ── canvas element ───────────────────────────────────────────────────────────────────────────────
class Canvas {
  constructor() { this.width = 0; this.height = 0; this._ctx = null; }
  getContext() { if (!this._ctx) this._ctx = new Ctx2D(this); else { this._ctx._w = this.width; this._ctx._h = this.height; this._ctx._buf = new Uint8Array(this.width * this.height * 4); } return this._ctx; }
  toDataURL() {
    const ctx = this._ctx;
    const png = encodePng({ width: this.width, height: this.height, data: ctx._buf });
    return `data:image/png;base64,${png.toString('base64')}`;
  }
  toBlob(cb) {
    const ctx = this._ctx;
    const png = encodePng({ width: this.width, height: this.height, data: ctx._buf });
    cb(makeBlob(png, 'image/png'));
  }
}

// ── Blob / fetch / Image / createImageBitmap / FileReader / FontFace / document / crypto ─────────
function makeBlob(buf, type) {
  return {
    type,
    _buf: Buffer.from(buf),
    async arrayBuffer() { return this._buf.buffer.slice(this._buf.byteOffset, this._buf.byteOffset + this._buf.byteLength); },
    async text() { return this._buf.toString('utf8'); },
  };
}

// The last text/html payload written to navigator.clipboard.write — the figma-native clipboard
// HTML. Read via getClipboardHtml() after copyForFigma().
let LAST_CLIPBOARD_HTML = null;
export function getClipboardHtml() { return LAST_CLIPBOARD_HTML; }
export function resetClipboard() { LAST_CLIPBOARD_HTML = null; }

async function blobToText(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  if (typeof v.then === 'function') return blobToText(await v);
  if (typeof v.text === 'function') return await v.text();
  if (v._buf) return v._buf.toString('utf8');
  return String(v);
}

let FETCH_MAP = new Map(); // src → PNG Buffer
export function registerFetch(src, pngBuffer) { FETCH_MAP.set(src, Buffer.from(pngBuffer)); }
export function clearFetch() { FETCH_MAP = new Map(); }

export function installShim() {
  const g = globalThis;
  g.document = {
    createElement: (t) => (t === 'canvas' ? new Canvas() : { getContext: () => new Ctx2D(new Canvas()) }),
    fonts: { add() {}, ready: Promise.resolve() },
  };
  g.OffscreenCanvas = undefined;
  class ImageShim {
    constructor() { this._onload = null; this._onerror = null; }
    set onload(fn) { this._onload = fn; }
    set onerror(fn) { this._onerror = fn; }
    set src(v) {
      try {
        const dec = dataUrlOrFetch(v);
        attachImageData(this, dec);
        this.naturalWidth = dec.width; this.naturalHeight = dec.height;
        this.width = dec.width; this.height = dec.height;
        queueMicrotask(() => this._onload && this._onload());
      } catch (e) {
        queueMicrotask(() => (this._onerror ? this._onerror(e) : null));
      }
    }
  }
  g.Image = ImageShim;
  g.createImageBitmap = async (blob) => {
    const buf = blob._buf || Buffer.from(await blob.arrayBuffer());
    const dec = decodePng(buf);
    const bmp = { width: dec.width, height: dec.height, close() {} };
    attachImageData(bmp, dec);
    return bmp;
  };
  g.FileReader = class {
    set onload(fn) { this._onload = fn; }
    set onerror(fn) { this._onerror = fn; }
    readAsDataURL(blob) {
      const buf = blob._buf;
      this.result = `data:${blob.type};base64,${buf.toString('base64')}`;
      queueMicrotask(() => this._onload && this._onload());
    }
  };
  g.fetch = async (src) => {
    const buf = FETCH_MAP.get(src);
    if (!buf) return { ok: false, status: 404, async blob() { throw new Error('404'); } };
    return { ok: true, status: 200, async blob() { return makeBlob(buf, 'image/png'); } };
  };
  g.FontFace = class { constructor() {} async load() { return this; } };
  if (!g.crypto) g.crypto = {};
  if (!g.crypto.subtle) {
    // Deterministic 20-byte SHA-1-shaped hash (content-derived) so distinct images get distinct
    // Figma image hashes — enough for the harness (Figma dedupes fills by hash).
    g.crypto.subtle = {
      async digest(_alg, data) {
        const bytes = new Uint8Array(data);
        const out = new Uint8Array(20);
        for (let i = 0; i < bytes.length; i++) out[i % 20] = (out[i % 20] + bytes[i] * (i + 1)) & 0xff;
        return out.buffer;
      },
    };
  }
  g.ClipboardItem = class ClipboardItem {
    constructor(map) { this._map = map; }
    async _read(type) { return blobToText(this._map[type]); }
  };
  const clipboard = {
    async write(items) {
      for (const it of items) {
        if (it._map && ('text/html' in it._map)) LAST_CLIPBOARD_HTML = await it._read('text/html');
      }
    },
    async writeText(t) { LAST_CLIPBOARD_HTML = t; },
  };
  // navigator is a read-only getter in Node — define it.
  try { Object.defineProperty(g, 'navigator', { value: { clipboard }, configurable: true }); }
  catch { g.navigator = { clipboard }; }
}

function dataUrlOrFetch(v) {
  const m = /^data:image\/png;base64,(.+)$/s.exec(String(v));
  if (m) return decodePng(Buffer.from(m[1], 'base64'));
  const buf = FETCH_MAP.get(v);
  if (buf) return decodePng(buf);
  throw new Error('image src not registered: ' + String(v).slice(0, 40));
}

export { Canvas, Ctx2D };
