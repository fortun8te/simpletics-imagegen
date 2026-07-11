// figmaVector.ts — REAL Figma vectors (S13b): SVG path → vector network → vectorNetworkBlob.
//
// A Figma VECTOR node's geometry does NOT live in kiwi fields: vectorData.vectorNetworkBlob is
// an index into the message's `blobs` array (struct Blob { byte[] bytes } — the same array the
// image bytes ride in), pointing at an opaque little-endian binary: the "vector network"
// (vertices + cubic segments + fill regions). The byte layout is verified against fig2sketch's
// DECODER (src/figformat/vector_network.py); we implement the ENCODER plus a decoder port
// (roundtrip tests + foreign-vector import):
//
//   header:  uint32 nVertices, uint32 nSegments, uint32 nRegions
//   vertex:  uint32 styleId(=0), float32 x, float32 y                          12 B each
//   segment: uint32 styleId(=0), uint32 v1, float32 t1x, float32 t1y,
//            uint32 v2, float32 t2x, float32 t2y                               28 B each
//            (t = Bézier tangent vectors RELATIVE to their vertex; straight line ⇒ 0,0)
//   region:  uint32 flags (bit0: 1=NONZERO 0=ODD, rest styleId<<1), uint32 nLoops,
//            then per loop: uint32 nLoopVerts, uint32 vertexIdx…
//
// Pipeline (export): style.path d-string (normalized 0..1 in the layer box — same convention as
// designSvg.ts / fills.ts) → parseSvgPath (absolute cubics; quadratics exact-converted, arcs
// endpoint→center converted and approximated at ≤90° per cubic) → pathToVectorNetwork (vertex
// dedupe ε=0.01, one NONZERO region over all closed loops) → encodeVectorNetworkBlob. Import
// runs the inverse for FOREIGN vectors whose pluginData we didn't write: decodeVectorNetworkBlob
// → vectorNetworkToSvgPath (approximate d-string reconstruction).
//
// Pure module — no DOM, no deps — so node scripts (scripts/figma-roundtrip.test.mjs) exercise
// the encoder byte-for-byte.

// ── SVG path parsing → absolute cubic segments ───────────────────────────────────────────────────

/** One drawable piece of a path: an absolute cubic (or straight line) in path coordinates. */
export interface Segment {
  x1: number; y1: number;
  /** Absolute cubic control points — for a straight line they sit ON the endpoints. */
  cx1: number; cy1: number; cx2: number; cy2: number;
  x2: number; y2: number;
  /** Straight line — encodes as zero tangents in the network. */
  line: boolean;
  /** 0-based subpath index. */
  subpath: number;
  /** Subpath was closed with Z (or geometrically returns to its start). */
  closed: boolean;
}

/**
 * Parse an SVG path d-string into absolute cubic/line segments. Supports M/L/H/V/C/S/Q/T/A/Z in
 * absolute and relative form, implicit command repetition (M → L per spec), multiple subpaths.
 * Quadratics convert to exact cubics; arcs go through the standard endpoint→center conversion
 * and are approximated at ≤90° per cubic. THROWS on malformed input (missing numbers, unknown
 * leading tokens) — callers treat that as "not a clean path" and use their documented fallback.
 * Compact arc-flag syntax ("…0 11 0.5…") is not supported; our writers always emit separators.
 */
export function parseSvgPath(d: string): Segment[] {
  const tokens: Array<string | number> = [];
  const re = /[MmLlHhVvCcSsQqTtAaZz]|[+-]?(?:\d*\.\d+|\d+\.?)(?:[eE][+-]?\d+)?/g;
  for (const m of String(d || '').matchAll(re)) {
    tokens.push(/^[A-Za-z]$/.test(m[0]) ? m[0] : parseFloat(m[0]));
  }
  let i = 0;
  const num = (): number => {
    const t = tokens[i];
    if (typeof t !== 'number') throw new Error(`expected number at token ${i} of path`);
    i++;
    return t;
  };

  const out: Segment[] = [];
  const closedSubs = new Set<number>();
  let cx = 0, cy = 0;         // current point
  let sx = 0, sy = 0;         // current subpath start
  let sub = -1;               // current subpath index (first M/draw → 0)
  let needNewSub = true;      // next drawing command opens a new subpath
  let pcx: number | null = null, pcy: number | null = null; // previous cubic control (S reflects)
  let pqx: number | null = null, pqy: number | null = null; // previous quad control (T reflects)

  const ensureSub = () => {
    if (needNewSub) { sub++; sx = cx; sy = cy; needNewSub = false; }
  };
  const pushLine = (x2: number, y2: number) => {
    ensureSub();
    if (Math.abs(x2 - cx) > 1e-9 || Math.abs(y2 - cy) > 1e-9) {
      out.push({ x1: cx, y1: cy, cx1: cx, cy1: cy, cx2: x2, cy2: y2, x2, y2, line: true, subpath: sub, closed: false });
    }
    cx = x2; cy = y2;
  };
  const pushCubic = (c1x: number, c1y: number, c2x: number, c2y: number, x2: number, y2: number) => {
    ensureSub();
    out.push({ x1: cx, y1: cy, cx1: c1x, cy1: c1y, cx2: c2x, cy2: c2y, x2, y2, line: false, subpath: sub, closed: false });
    cx = x2; cy = y2;
  };

  let cmd = '';
  while (i < tokens.length) {
    const t = tokens[i];
    if (typeof t === 'string') { cmd = t; i++; }
    else if (!cmd) throw new Error('path data before any command');
    // Implicit repetition: a bare number re-runs the previous command (M repeats as L).
    else if (cmd === 'M') cmd = 'L';
    else if (cmd === 'm') cmd = 'l';
    else if (cmd === 'Z' || cmd === 'z') throw new Error('numbers after Z'); // Z takes no args

    const rel = cmd >= 'a' && cmd <= 'z';
    const abs = cmd.toUpperCase();
    // Segments produced by every command except M/Z clear the "previous control" memory unless
    // re-set below (SVG spec: S/T reflect only immediately-preceding C/S / Q/T).
    let nextPc: [number, number] | null = null;
    let nextPq: [number, number] | null = null;

    if (abs === 'Z') {
      if (sub >= 0) {
        if (Math.abs(cx - sx) > 1e-9 || Math.abs(cy - sy) > 1e-9) pushLine(sx, sy);
        closedSubs.add(sub);
      }
      cx = sx; cy = sy;
      needNewSub = true; // drawing after Z starts a fresh subpath at the same point (SVG spec)
    } else if (abs === 'M') {
      const x = num() + (rel ? cx : 0);
      const y = num() + (rel ? cy : 0);
      cx = x; cy = y;
      needNewSub = true;
      ensureSub();
    } else if (abs === 'L') {
      pushLine(num() + (rel ? cx : 0), num() + (rel ? cy : 0));
    } else if (abs === 'H') {
      pushLine(num() + (rel ? cx : 0), cy);
    } else if (abs === 'V') {
      pushLine(cx, num() + (rel ? cy : 0));
    } else if (abs === 'C') {
      const c1x = num() + (rel ? cx : 0), c1y = num() + (rel ? cy : 0);
      const c2x = num() + (rel ? cx : 0), c2y = num() + (rel ? cy : 0);
      const x2 = num() + (rel ? cx : 0), y2 = num() + (rel ? cy : 0);
      pushCubic(c1x, c1y, c2x, c2y, x2, y2);
      nextPc = [c2x, c2y];
    } else if (abs === 'S') {
      const c1x = pcx != null ? 2 * cx - pcx : cx;
      const c1y = pcy != null ? 2 * cy - pcy : cy;
      const c2x = num() + (rel ? cx : 0), c2y = num() + (rel ? cy : 0);
      const x2 = num() + (rel ? cx : 0), y2 = num() + (rel ? cy : 0);
      pushCubic(c1x, c1y, c2x, c2y, x2, y2);
      nextPc = [c2x, c2y];
    } else if (abs === 'Q' || abs === 'T') {
      let qx: number, qy: number;
      if (abs === 'Q') {
        qx = num() + (rel ? cx : 0);
        qy = num() + (rel ? cy : 0);
      } else {
        qx = pqx != null ? 2 * cx - pqx : cx;
        qy = pqy != null ? 2 * cy - pqy : cy;
      }
      const x2 = num() + (rel ? cx : 0), y2 = num() + (rel ? cy : 0);
      // Exact quadratic→cubic: c1 = p0 + ⅔(q − p0), c2 = p2 + ⅔(q − p2).
      pushCubic(cx + (2 / 3) * (qx - cx), cy + (2 / 3) * (qy - cy),
        x2 + (2 / 3) * (qx - x2), y2 + (2 / 3) * (qy - y2), x2, y2);
      nextPq = [qx, qy];
    } else if (abs === 'A') {
      const rx = num(), ry = num(), phi = num(), largeArc = num(), sweep = num();
      const x2 = num() + (rel ? cx : 0), y2 = num() + (rel ? cy : 0);
      for (const c of arcToCubics(cx, cy, rx, ry, phi, largeArc !== 0, sweep !== 0, x2, y2)) {
        if (c.line) pushLine(c.x2, c.y2);
        else pushCubic(c.cx1, c.cy1, c.cx2, c.cy2, c.x2, c.y2);
      }
      cx = x2; cy = y2;
    } else {
      throw new Error(`unsupported path command "${cmd}"`);
    }

    [pcx, pcy] = nextPc ?? [null, null];
    [pqx, pqy] = nextPq ?? [null, null];
  }

  return out.map((s) => (closedSubs.has(s.subpath) ? { ...s, closed: true } : s));
}

/** Arc piece emitted by arcToCubics — either a cubic or (degenerate radii) a straight line. */
interface ArcPiece { line: boolean; cx1: number; cy1: number; cx2: number; cy2: number; x2: number; y2: number }

/**
 * SVG arc → cubic Béziers, ≤90° each: the standard endpoint→center parameterization
 * (SVG spec F.6.5/F.6.6 — radii scale-up correction included) then one cubic per ≤π/2 slice
 * with the classic tangent-length factor α = 4/3·tan(δ/4). The FINAL endpoint is pinned to the
 * exact (x2,y2) input so consecutive arcs (e.g. a circle drawn as two 180° arcs) dedupe cleanly.
 */
function arcToCubics(
  x1: number, y1: number, rx: number, ry: number, phiDeg: number,
  largeArc: boolean, sweep: boolean, x2: number, y2: number,
): ArcPiece[] {
  if (Math.abs(x2 - x1) < 1e-12 && Math.abs(y2 - y1) < 1e-12) return [];
  rx = Math.abs(rx); ry = Math.abs(ry);
  if (rx < 1e-12 || ry < 1e-12) {
    return [{ line: true, cx1: x1, cy1: y1, cx2: x2, cy2: y2, x2, y2 }];
  }
  const phi = (phiDeg * Math.PI) / 180;
  const cosP = Math.cos(phi), sinP = Math.sin(phi);
  // F.6.5.1: midpoint-relative coords in the ellipse's rotated frame.
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
  const x1p = cosP * dx + sinP * dy;
  const y1p = -sinP * dx + cosP * dy;
  // F.6.6: scale radii up when the endpoints don't fit.
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) { const s = Math.sqrt(lambda); rx *= s; ry *= s; }
  // F.6.5.2: center in the rotated frame.
  const sign = largeArc !== sweep ? 1 : -1;
  const numTerm = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const co = sign * Math.sqrt(Math.max(0, numTerm) / den);
  const cxp = (co * rx * y1p) / ry;
  const cyp = (-co * ry * x1p) / rx;
  // F.6.5.3: back to user space.
  const cx = cosP * cxp - sinP * cyp + (x1 + x2) / 2;
  const cy = sinP * cxp + cosP * cyp + (y1 + y2) / 2;
  // F.6.5.5/6: start angle + sweep extent.
  const angle = (ux: number, uy: number, vx: number, vy: number): number => {
    const dot = ux * vx + uy * vy;
    const len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    let a = Math.acos(Math.max(-1, Math.min(1, dot / len)));
    if (ux * vy - uy * vx < 0) a = -a;
    return a;
  };
  const ux = (x1p - cxp) / rx, uy = (y1p - cyp) / ry;
  const vx = (-x1p - cxp) / rx, vy = (-y1p - cyp) / ry;
  const theta1 = angle(1, 0, ux, uy);
  let dTheta = angle(ux, uy, vx, vy) % (2 * Math.PI);
  if (!sweep && dTheta > 0) dTheta -= 2 * Math.PI;
  if (sweep && dTheta < 0) dTheta += 2 * Math.PI;

  const n = Math.max(1, Math.ceil(Math.abs(dTheta) / (Math.PI / 2)));
  const delta = dTheta / n;
  const alpha = (4 / 3) * Math.tan(delta / 4);
  const point = (t: number): [number, number] => [
    cx + rx * Math.cos(t) * cosP - ry * Math.sin(t) * sinP,
    cy + rx * Math.cos(t) * sinP + ry * Math.sin(t) * cosP,
  ];
  const deriv = (t: number): [number, number] => [
    -rx * Math.sin(t) * cosP - ry * Math.cos(t) * sinP,
    -rx * Math.sin(t) * sinP + ry * Math.cos(t) * cosP,
  ];
  const pieces: ArcPiece[] = [];
  for (let k = 0; k < n; k++) {
    const ta = theta1 + k * delta;
    const tb = ta + delta;
    const [pax, pay] = point(ta);
    const [dax, day] = deriv(ta);
    const [dbx, dby] = deriv(tb);
    // Pin the very last endpoint to the exact input so chained arcs meet dedupe-exactly.
    const [pbx, pby] = k === n - 1 ? [x2, y2] : point(tb);
    pieces.push({
      line: false,
      cx1: pax + alpha * dax, cy1: pay + alpha * day,
      cx2: pbx - alpha * dbx, cy2: pby - alpha * dby,
      x2: pbx, y2: pby,
    });
  }
  return pieces;
}

// ── vector network construction ──────────────────────────────────────────────────────────────────

export interface VectorVertex { x: number; y: number }
export interface VectorSegment {
  start: number;
  end: number;
  /** Tangents RELATIVE to their vertex (blob convention); straight line ⇒ {0,0}. */
  tangentStart: { x: number; y: number };
  tangentEnd: { x: number; y: number };
}
export interface VectorRegion { windingRule: 'NONZERO' | 'ODD'; loops: number[][] }
export interface VectorNetwork {
  vertices: VectorVertex[];
  segments: VectorSegment[];
  regions: VectorRegion[];
}

/** Vertex dedupe tolerance in px (post-scale) — matches Figma's own editor snapping. */
const VERTEX_EPS = 0.01;

/**
 * Segments (path coords, normally 0..1) → a vector network in px: coordinates scale by the layer
 * box (blob coords live in normalizedSize space), vertices dedupe at ε=0.01, tangents become
 * control-point offsets relative to each vertex (straight line ⇒ 0,0), and every closed subpath
 * contributes a vertex-index loop to ONE fill region with NONZERO winding — Figma fills exactly
 * the loops listed, so a donut's two loops in one region punch the hole like nonzero/evenodd SVG
 * fills do. Open subpaths carry no region (stroke-only geometry).
 */
export function pathToVectorNetwork(
  segments: Segment[],
  size: { width: number; height: number },
): VectorNetwork {
  const w = size.width || 1;
  const h = size.height || 1;
  const vertices: VectorVertex[] = [];
  const addVertex = (x: number, y: number): number => {
    for (let i = 0; i < vertices.length; i++) {
      if (Math.abs(vertices[i].x - x) < VERTEX_EPS && Math.abs(vertices[i].y - y) < VERTEX_EPS) return i;
    }
    vertices.push({ x, y });
    return vertices.length - 1;
  };

  const segsOut: VectorSegment[] = [];
  // Per-subpath vertex chain (first v1 then every v2) — the raw material for the region loops.
  const chains = new Map<number, number[]>();

  for (const s of segments) {
    const v1 = addVertex(s.x1 * w, s.y1 * h);
    const v2 = addVertex(s.x2 * w, s.y2 * h);
    const a = vertices[v1];
    const b = vertices[v2];
    const t1 = s.line ? { x: 0, y: 0 } : { x: s.cx1 * w - a.x, y: s.cy1 * h - a.y };
    const t2 = s.line ? { x: 0, y: 0 } : { x: s.cx2 * w - b.x, y: s.cy2 * h - b.y };
    // Degenerate: both endpoints deduped together and no curvature — adds nothing drawable.
    if (v1 === v2 && Math.abs(t1.x) < VERTEX_EPS && Math.abs(t1.y) < VERTEX_EPS
      && Math.abs(t2.x) < VERTEX_EPS && Math.abs(t2.y) < VERTEX_EPS) continue;
    segsOut.push({ start: v1, end: v2, tangentStart: t1, tangentEnd: t2 });
    let chain = chains.get(s.subpath);
    if (!chain) { chain = [v1]; chains.set(s.subpath, chain); }
    chain.push(v2);
  }

  // One region, all closed loops: a loop is the subpath's vertex cycle (Z'd, or geometrically
  // returning to its start after dedupe — either way the chain ends where it began) with the
  // duplicated closing vertex dropped. ≥4 chain entries = at least a triangle.
  const loops: number[][] = [];
  for (const verts of chains.values()) {
    if (verts.length >= 4 && verts[0] === verts[verts.length - 1]) {
      loops.push(verts.slice(0, -1));
    }
  }
  return {
    vertices,
    segments: segsOut,
    regions: loops.length ? [{ windingRule: 'NONZERO', loops }] : [],
  };
}

// ── blob encode/decode (little-endian, layout at the top of this file) ───────────────────────────

/** Encode a vector network into Figma's vectorNetworkBlob bytes (all styleIds 0). */
export function encodeVectorNetworkBlob(network: VectorNetwork): Uint8Array {
  let size = 12 + network.vertices.length * 12 + network.segments.length * 28;
  for (const r of network.regions) {
    size += 8;
    for (const loop of r.loops) size += 4 + loop.length * 4;
  }
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  let o = 0;
  const u32 = (v: number) => { view.setUint32(o, v >>> 0, true); o += 4; };
  const f32 = (v: number) => { view.setFloat32(o, v, true); o += 4; };

  u32(network.vertices.length);
  u32(network.segments.length);
  u32(network.regions.length);
  for (const v of network.vertices) { u32(0); f32(v.x); f32(v.y); }
  for (const s of network.segments) {
    u32(0);
    u32(s.start); f32(s.tangentStart.x); f32(s.tangentStart.y);
    u32(s.end); f32(s.tangentEnd.x); f32(s.tangentEnd.y);
  }
  for (const r of network.regions) {
    u32(r.windingRule === 'NONZERO' ? 1 : 0); // flags: bit0 winding, styleId<<1 = 0
    u32(r.loops.length);
    for (const loop of r.loops) {
      u32(loop.length);
      for (const idx of loop) u32(idx);
    }
  }
  return bytes;
}

/**
 * Decode a vectorNetworkBlob (port of fig2sketch's decoder, styleIds read-and-ignored). THROWS
 * on truncated buffers or out-of-range vertex indices, so callers can safely probe a foreign
 * blob and fall back to a placeholder when the layout isn't what we expect.
 */
export function decodeVectorNetworkBlob(bytes: Uint8Array): VectorNetwork {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 0;
  const u32 = (): number => {
    if (o + 4 > bytes.byteLength) throw new Error(`vector network blob truncated at ${o}`);
    const v = view.getUint32(o, true); o += 4; return v;
  };
  const f32 = (): number => {
    if (o + 4 > bytes.byteLength) throw new Error(`vector network blob truncated at ${o}`);
    const v = view.getFloat32(o, true); o += 4; return v;
  };

  const nVertices = u32();
  const nSegments = u32();
  const nRegions = u32();
  if (12 + nVertices * 12 + nSegments * 28 > bytes.byteLength) {
    throw new Error(`vector network blob too short for ${nVertices} vertices / ${nSegments} segments`);
  }
  const vertices: VectorVertex[] = [];
  for (let i = 0; i < nVertices; i++) {
    u32(); // styleId
    vertices.push({ x: f32(), y: f32() });
  }
  const segments: VectorSegment[] = [];
  for (let i = 0; i < nSegments; i++) {
    u32(); // styleId
    const start = u32();
    const tangentStart = { x: f32(), y: f32() };
    const end = u32();
    const tangentEnd = { x: f32(), y: f32() };
    if (start >= nVertices || end >= nVertices) {
      throw new Error(`segment ${i} references vertex out of range (${start}/${end} of ${nVertices})`);
    }
    segments.push({ start, end, tangentStart, tangentEnd });
  }
  const regions: VectorRegion[] = [];
  for (let i = 0; i < nRegions; i++) {
    const flags = u32();
    const nLoops = u32();
    const loops: number[][] = [];
    for (let j = 0; j < nLoops; j++) {
      const count = u32();
      const loop: number[] = [];
      for (let k = 0; k < count; k++) {
        const idx = u32();
        if (idx >= nVertices) throw new Error(`region ${i} loop ${j} vertex ${idx} out of range`);
        loop.push(idx);
      }
      loops.push(loop);
    }
    regions.push({ windingRule: flags % 2 ? 'NONZERO' : 'ODD', loops });
  }
  return { vertices, segments, regions };
}

// ── network → d-string (approximate reconstruction for foreign-vector import) ────────────────────

/**
 * Rebuild a normalized (0..1 in `size`) d-string from a network: segments walk in stored order,
 * a new subpath opens whenever a segment doesn't continue from the previous end vertex, zero
 * tangents emit L (a straight closing line back to the subpath start collapses to Z), non-zero
 * tangents emit C with the controls re-absolutized (vertex + tangent). Approximate by design —
 * region winding beyond the segment walk (e.g. partial-fill regions) doesn't survive — but the
 * geometry does, which beats the locked placeholder rectangle it replaces.
 */
export function vectorNetworkToSvgPath(
  network: VectorNetwork,
  size: { width: number; height: number },
): string {
  const w = size.width || 1;
  const h = size.height || 1;
  const fmt = (v: number): string => {
    const r = Math.round(v * 1e4) / 1e4;
    return String(Object.is(r, -0) ? 0 : r);
  };
  const px = (x: number) => fmt(x / w);
  const py = (y: number) => fmt(y / h);
  const parts: string[] = [];
  let cur = -1;
  let subStart = -1;
  for (const s of network.segments) {
    const a = network.vertices[s.start];
    const b = network.vertices[s.end];
    if (!a || !b) continue;
    if (s.start !== cur) {
      parts.push(`M ${px(a.x)} ${py(a.y)}`);
      subStart = s.start;
    }
    const straight = !s.tangentStart.x && !s.tangentStart.y && !s.tangentEnd.x && !s.tangentEnd.y;
    if (straight && s.end === subStart) {
      parts.push('Z');
      cur = -1;
      continue;
    }
    if (straight) {
      parts.push(`L ${px(b.x)} ${py(b.y)}`);
    } else {
      parts.push(`C ${px(a.x + s.tangentStart.x)} ${py(a.y + s.tangentStart.y)} `
        + `${px(b.x + s.tangentEnd.x)} ${py(b.y + s.tangentEnd.y)} ${px(b.x)} ${py(b.y)}`);
    }
    cur = s.end;
    if (cur === subStart) { parts.push('Z'); cur = -1; }
  }
  return parts.join(' ');
}
