// Stage.tsx — the canvas: a scaled artboard rendering the scene graph, with direct manipulation.
//
// One of the five views over a DesignDoc (Stage DOM / raster.ts PNG / SVG export / server HTML /
// Figma clipboard) — rendering here must stay in parity with raster.ts. Leaves are absolutely
// positioned by percentage against the artboard; the artboard is a CSS container
// (container-type: inline-size) so every canvas-px length renders in cqw and stays proportional
// at any zoom without re-measuring. Groups have ABSOLUTE child coords, so they render as plain
// recursion — no nested coordinate spaces.
//
// Interaction model (Figma-ish):
//   • Click selects the TOPMOST ROOT ancestor of what you hit; double-click drills one level
//     into a group (the shell tracks the entered-group stack; Esc exits). Shift-click toggles
//     multi-select among siblings at the current level.
//   • Drag on empty canvas = marquee select (nodes at the current level intersecting the rect).
//     Holding SPACE while starting a drag ALWAYS marquees, no matter what's under the cursor —
//     real comps are usually covered edge-to-edge by overlay layers (scrim/second photo/shape),
//     so "empty canvas" is rare in practice; Space is the deliberate "lasso-select" affordance.
//   • Drag / resize use pointer capture; geometry cached at pointer-down. Moves stream
//     onChange(commit=false); pointer-up sends ONE commit=true. Multi-selection drags together.
//   • Modifiers are read PER MOVE (Figma parity): resize ⇧ = aspect-lock on corner handles,
//     ⌥ = resize from center, ⇧⌥ combined; ⌥ during a move = duplicate-and-drag (clones get
//     fresh ids, originals stay; the whole gesture is still one undo step).
//   • Snapping: canvas edges/centers + other visible nodes' edges/centers at the SAME level,
//     6 SCREEN px threshold. Snapped axes draw accent guides. Smart spacing: the 8 nearest
//     visible leaves are cached at gesture start; equal gaps (±2 canvas px) snap and draw
//     dashed spacing guides.
//   • autoH text layers grow with content (height:auto, min-height) and hide n/s handles.
//   • ⌘/ctrl+wheel zooms about the cursor (the shell owns the zoom number); plain wheel pans.
//   • X-ray mode overlays numbered outlines per node — the "how this ad is built" view.

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import { isGroup, type DesignDoc, type GroupNode, type Layer, type LayerBox, type SceneNode, type ShapeKind } from '../../lib/sceneGraph';
import { ancestorsOf, cloneNodeDeep, findNode, findParentList, leaves, translateNode, scaleNodeInto, walk } from '../../lib/sceneTree';
import { arrowGeometry, fillCss, starburstPoints, vignetteCss, vignetteSpec } from './fills';
import { pillPadding, textBlockHeight } from './textMetrics';
import { applyElementTextEdit } from './elements';
import AgentCursorOverlay from './AgentCursorOverlay';
import styles from './Stage.module.css';

/** style.pixelate (block size in px) isn't declared on LayerStyle yet — see the sceneGraph.ts
 *  addition noted in this task's report (`pixelate?: number`). Read defensively so this compiles
 *  ahead of that field landing. */
function pixelateOf(s: Layer['style']): number {
  const v = (s as unknown as Record<string, unknown> | undefined)?.pixelate;
  return typeof v === 'number' && v > 0 ? v : 0;
}

/** Live-editor true mosaic pixelation for an image layer: downscale the source to a canvas at
 *  a reduced resolution then scale back up with smoothing disabled — genuine blocky pixels,
 *  same technique as raster.ts pixelateSource / designSvg.ts pixelateDataUrl. Renders a plain
 *  <img> pointed at the produced data URL so it drops in exactly where the sharp <img> was
 *  (same CSS: objectFit, borderRadius etc. from the caller). Recomputes when src/box/blockSize
 *  change; leaves the ORIGINAL src showing until the pixelated version is ready (never blank). */
function PixelatedImage({
  src, blockSize, w, h, className, style,
}: {
  src: string; blockSize: number; w: number; h: number;
  className?: string; style?: CSSProperties;
}) {
  const [out, setOut] = useState<string>(src);
  useEffect(() => {
    let cancelled = false;
    setOut(src); // show the sharp source immediately; swap once pixelated
    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      const dw = Math.max(1, Math.round(w));
      const dh = Math.max(1, Math.round(h));
      const block = Math.max(1, blockSize);
      const small = document.createElement('canvas');
      small.width = Math.max(1, Math.round(dw / block));
      small.height = Math.max(1, Math.round(dh / block));
      const sctx = small.getContext('2d');
      if (!sctx) return;
      sctx.imageSmoothingEnabled = true;
      sctx.drawImage(img, 0, 0, small.width, small.height);
      const big = document.createElement('canvas');
      big.width = dw;
      big.height = dh;
      const bctx = big.getContext('2d');
      if (!bctx) return;
      bctx.imageSmoothingEnabled = false;
      bctx.drawImage(small, 0, 0, dw, dh);
      if (!cancelled) setOut(big.toDataURL('image/png'));
    };
    img.onerror = () => { if (!cancelled) setOut(src); };
    img.src = src;
    return () => { cancelled = true; };
  }, [src, blockSize, w, h]);
  return <img src={out} alt="" draggable={false} className={className} style={style} />;
}

export interface UnderlayState { url: string; mode: 'off' | 'over'; opacity: number }

export interface StageProps {
  doc: DesignDoc;
  selectedIds: string[];
  /** Group the user has drilled into (double-click); selection happens among its children. */
  enteredGroupId: string | null;
  /** 'fit' fits the whole canvas; a number is a zoom factor where 1 = 100% canvas px. */
  zoom: number | 'fit';
  underlay: UnderlayState | null;
  xray: boolean;
  onSelect: (ids: string[], opts?: { toggle?: boolean }) => void;
  onEnterGroup: (id: string | null) => void;
  /** ⌘-wheel: the shell owns zoom. `next` is the numeric zoom to apply. */
  onZoom: (next: number) => void;
  onChange: (mutate: (d: DesignDoc) => void, commit: boolean) => void;
  /** Agent-edited nodes to flash (one-shot accent outline; keyed by id+at so re-edits re-flash). */
  flashes?: { id: string; at: number }[];
  /** Agent run in flight — canvas is read-only: pointer gestures are refused (defense in depth
   *  alongside the shell's `pointer-events:none` wrapper), any in-progress text edit is force-
   *  cancelled so a stale contentEditable session can't clobber the agent's write, the cursor
   *  shows `wait`, and the animated agent-cursor overlay renders. */
  locked?: boolean;
}

// ── geometry / snapping (pure helpers) ───────────────────────────────────────────────────────────

const SNAP_SCREEN_PX = 6;
const MIN_SIZE = 24;
const HANDLE_PX = 10;

type HandleId = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

const HANDLES: { id: HandleId; x: number; y: number; cursor: string }[] = [
  { id: 'nw', x: 0, y: 0, cursor: 'nwse-resize' },
  { id: 'n', x: 0.5, y: 0, cursor: 'ns-resize' },
  { id: 'ne', x: 1, y: 0, cursor: 'nesw-resize' },
  { id: 'e', x: 1, y: 0.5, cursor: 'ew-resize' },
  { id: 'se', x: 1, y: 1, cursor: 'nwse-resize' },
  { id: 's', x: 0.5, y: 1, cursor: 'ns-resize' },
  { id: 'sw', x: 0, y: 1, cursor: 'nesw-resize' },
  { id: 'w', x: 0, y: 0.5, cursor: 'ew-resize' },
];

interface SnapTargets { v: number[]; h: number[] }
interface Guides { v: number | null; h: number | null }
const NO_GUIDES: Guides = { v: null, h: null };

/** Snap targets = canvas edges/centers + every visible node (all levels) except the dragged set. */
function buildSnapTargets(doc: DesignDoc, excludeIds: Set<string>): SnapTargets {
  const v = [0, doc.canvas.w / 2, doc.canvas.w];
  const h = [0, doc.canvas.h / 2, doc.canvas.h];
  walk(doc.layers, (n) => {
    if (excludeIds.has(n.id)) return false; // skip dragged subtree entirely
    if (n.hidden) return false;
    v.push(n.box.x, n.box.x + n.box.w / 2, n.box.x + n.box.w);
    h.push(n.box.y, n.box.y + n.box.h / 2, n.box.y + n.box.h);
  });
  return { v, h };
}

function nearest(targets: number[], value: number, threshold: number): number | null {
  let best: number | null = null;
  let bestD = threshold;
  for (const t of targets) {
    const d = Math.abs(t - value);
    if (d <= bestD) { bestD = d; best = t; }
  }
  return best;
}

function snapMoveAxis(
  pos: number, size: number, targets: number[], threshold: number,
): { pos: number; guide: number | null } {
  let bestAbs = Infinity;
  let guide: number | null = null;
  let snapped = pos;
  for (const cand of [pos, pos + size / 2, pos + size]) {
    const t = nearest(targets, cand, threshold);
    if (t !== null && Math.abs(t - cand) < bestAbs) {
      bestAbs = Math.abs(t - cand);
      guide = t;
      snapped = pos + (t - cand);
    }
  }
  return { pos: snapped, guide };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function verifyGuide(guide: number | null, edges: number[]): number | null {
  if (guide === null) return null;
  return edges.some((e) => Math.abs(e - guide) < 0.51) ? guide : null;
}

function moveBox(
  start: LayerBox, dx: number, dy: number,
  canvas: { w: number; h: number }, targets: SnapTargets, threshold: number,
  loose = false,
): { box: LayerBox; guides: Guides } {
  const sx = snapMoveAxis(start.x + dx, start.w, targets.v, threshold);
  const sy = snapMoveAxis(start.y + dy, start.h, targets.h, threshold);
  // loose (base-image pan): a box BIGGER than the canvas slides between cover extremes
  // (negative x up to 0) instead of being pinned at 0 by the lo>hi clamp.
  const x = Math.round(loose
    ? clamp(sx.pos, Math.min(0, canvas.w - start.w), Math.max(0, canvas.w - start.w))
    : clamp(sx.pos, 0, Math.max(0, canvas.w - start.w)));
  const y = Math.round(loose
    ? clamp(sy.pos, Math.min(0, canvas.h - start.h), Math.max(0, canvas.h - start.h))
    : clamp(sy.pos, 0, Math.max(0, canvas.h - start.h)));
  return {
    box: { x, y, w: start.w, h: start.h },
    guides: {
      v: verifyGuide(sx.guide, [x, x + start.w / 2, x + start.w]),
      h: verifyGuide(sy.guide, [y, y + start.h / 2, y + start.h]),
    },
  };
}

function resizeBox(
  start: LayerBox, handle: HandleId, dx: number, dy: number,
  canvas: { w: number; h: number }, targets: SnapTargets, threshold: number,
  mods: { aspect?: boolean; center?: boolean; loose?: boolean } = {},
): { box: LayerBox; guides: Guides } {
  let left = start.x;
  let top = start.y;
  let right = start.x + start.w;
  let bottom = start.y + start.h;
  let gv: number | null = null;
  let gh: number | null = null;

  if (handle.includes('w')) {
    left = start.x + dx;
    const t = nearest(targets.v, left, threshold);
    if (t !== null) { left = t; gv = t; }
  }
  if (handle.includes('e')) {
    right = start.x + start.w + dx;
    const t = nearest(targets.v, right, threshold);
    if (t !== null) { right = t; gv = t; }
  }
  if (handle.includes('n')) {
    top = start.y + dy;
    const t = nearest(targets.h, top, threshold);
    if (t !== null) { top = t; gh = t; }
  }
  if (handle.includes('s')) {
    bottom = start.y + start.h + dy;
    const t = nearest(targets.h, bottom, threshold);
    if (t !== null) { bottom = t; gh = t; }
  }

  // ⌥ scale-from-center: mirror the dragged edges about the start center (Figma parity).
  if (mods.center) {
    const cx = start.x + start.w / 2;
    const cy = start.y + start.h / 2;
    if (handle.includes('e')) left = cx - (right - cx);
    if (handle.includes('w')) right = cx + (cx - left);
    if (handle.includes('s')) top = cy - (bottom - cy);
    if (handle.includes('n')) bottom = cy + (cy - top);
    gv = null; gh = null; // mirrored edges make single-edge guides misleading
  }

  // ⇧ aspect-lock on corner handles: dominant axis wins, box re-derived from the anchor
  // (opposite corner, or center when ⌥ is also held).
  const isCorner = handle.length === 2;
  if (mods.aspect && isCorner && start.w > 0 && start.h > 0) {
    const candW = right - left;
    const candH = bottom - top;
    const s = Math.max(Math.abs(candW) / start.w, Math.abs(candH) / start.h);
    const w = Math.max(MIN_SIZE, start.w * s);
    const h = Math.max(MIN_SIZE, start.h * s);
    if (mods.center) {
      const cx = start.x + start.w / 2;
      const cy = start.y + start.h / 2;
      left = cx - w / 2; right = cx + w / 2;
      top = cy - h / 2; bottom = cy + h / 2;
    } else {
      // anchor = the corner opposite the handle
      const ax = handle.includes('w') ? start.x + start.w : start.x;
      const ay = handle.includes('n') ? start.y + start.h : start.y;
      left = handle.includes('w') ? ax - w : ax;
      right = handle.includes('w') ? ax : ax + w;
      top = handle.includes('n') ? ay - h : ay;
      bottom = handle.includes('n') ? ay : ay + h;
    }
    gv = null; gh = null;
  }

  if (handle.includes('w')) left = Math.min(left, right - MIN_SIZE);
  if (handle.includes('e')) right = Math.max(right, left + MIN_SIZE);
  if (handle.includes('n')) top = Math.min(top, bottom - MIN_SIZE);
  if (handle.includes('s')) bottom = Math.max(bottom, top + MIN_SIZE);
  // loose (base image): may grow/sit beyond the canvas — cover-crop the frame.
  if (!mods.loose) {
    left = Math.max(0, left);
    top = Math.max(0, top);
    right = Math.min(canvas.w, right);
    bottom = Math.min(canvas.h, bottom);
  }

  const box: LayerBox = {
    x: Math.round(left),
    y: Math.round(top),
    w: Math.max(1, Math.round(right - left)),
    h: Math.max(1, Math.round(bottom - top)),
  };
  return {
    box,
    guides: {
      v: verifyGuide(gv, [box.x, box.x + box.w]),
      h: verifyGuide(gh, [box.y, box.y + box.h]),
    },
  };
}

// ── smart spacing (Figma-style equal-gap guides) ─────────────────────────────────────────────────

interface SpacingSeg { axis: 'h' | 'v'; at: number; from: number; to: number }

const SPACING_TOL = 2; // canvas px

/** Equal-gap snapping against neighbor boxes cached at gesture start. Two cases per axis:
 *  the moving box sits BETWEEN two neighbors and its gaps are within ±tol of equal → center
 *  it; or it has a neighbor on ONE side and that gap is within ±tol of an existing gap
 *  between a neighbor pair → match it. Returns the adjusted position + dashed-guide segments
 *  (canvas coords; `at` is the cross-axis line position). Locked axes (already edge-snapped)
 *  are left alone. */
function spacingSnap(
  box: LayerBox,
  neighbors: LayerBox[],
  lock: { x: boolean; y: boolean },
  tol = SPACING_TOL,
): { x: number; y: number; segs: SpacingSeg[] } {
  const out = { x: box.x, y: box.y, segs: [] as SpacingSeg[] };
  const overlaps = (a0: number, a1: number, b0: number, b1: number) => a0 < b1 && b0 < a1;

  const solve = (horiz: boolean): void => {
    if (horiz ? lock.x : lock.y) return;
    const p = horiz ? box.x : box.y;
    const size = horiz ? box.w : box.h;
    const lo = (b: LayerBox) => (horiz ? b.x : b.y);
    const hi = (b: LayerBox) => (horiz ? b.x + b.w : b.y + b.h);
    // only neighbors sharing the cross-axis lane can form a spacing relationship
    const lane = neighbors.filter((n) => (horiz
      ? overlaps(box.y, box.y + box.h, n.y, n.y + n.h)
      : overlaps(box.x, box.x + box.w, n.x, n.x + n.w)));
    if (!lane.length) return;
    const before = lane.filter((n) => hi(n) <= p + tol).sort((a, b) => hi(b) - hi(a))[0];
    const after = lane.filter((n) => lo(n) >= p + size - tol).sort((a, b) => lo(a) - lo(b))[0];
    const axis = horiz ? ('h' as const) : ('v' as const);
    const mid = horiz ? box.y + box.h / 2 : box.x + box.w / 2;
    const apply = (np: number) => { if (horiz) out.x = np; else out.y = np; };

    if (before && after) {
      const gapL = p - hi(before);
      const gapR = lo(after) - (p + size);
      const shift = (gapR - gapL) / 2;
      if (gapL >= 0 && gapR >= 0 && Math.abs(shift) <= tol) {
        const np = Math.round(p + shift);
        apply(np);
        out.segs.push({ axis, at: mid, from: hi(before), to: np });
        out.segs.push({ axis, at: mid, from: np + size, to: lo(after) });
        return;
      }
    }
    const flank = before ?? after;
    if (!flank) return;
    // one-sided: match the nearest existing neighbor-pair gap on this axis
    const sorted = [...lane].sort((a, b) => lo(a) - lo(b));
    const c = horiz ? box.x + box.w / 2 : box.y + box.h / 2;
    let ref: { gap: number; from: number; to: number; at: number; d: number } | null = null;
    for (let i = 0; i < sorted.length - 1; i++) {
      const a = sorted[i];
      const b = sorted[i + 1];
      const gap = lo(b) - hi(a);
      if (gap <= 0) continue;
      const crossOk = horiz
        ? overlaps(a.y, a.y + a.h, b.y, b.y + b.h)
        : overlaps(a.x, a.x + a.w, b.x, b.x + b.w);
      if (!crossOk) continue;
      const at = horiz ? (a.y + a.h / 2 + b.y + b.h / 2) / 2 : (a.x + a.w / 2 + b.x + b.w / 2) / 2;
      const d = Math.abs((hi(a) + lo(b)) / 2 - c);
      if (!ref || d < ref.d) ref = { gap, from: hi(a), to: lo(b), at, d };
    }
    if (!ref) return;
    const gap = before ? p - hi(before) : lo(after) - (p + size);
    if (gap < 0 || Math.abs(gap - ref.gap) > tol) return;
    const np = Math.round(before ? hi(before) + ref.gap : lo(after) - ref.gap - size);
    apply(np);
    out.segs.push(before
      ? { axis, at: mid, from: hi(before), to: np }
      : { axis, at: mid, from: np + size, to: lo(after) });
    out.segs.push({ axis, at: ref.at, from: ref.from, to: ref.to });
  };

  solve(true);
  solve(false);
  return out;
}

// ── selection resolution ─────────────────────────────────────────────────────────────────────────

const EDITABLE_TYPES = new Set(['text', 'badge', 'button']);

function isInert(l: Layer): boolean {
  return l.role === 'base' || !!l.locked;
}

/** The base image is click-through by default (hits land on overlays), but once EXPLICITLY
 *  selected (layers panel) it becomes draggable/resizable — that's how you reposition the
 *  photo inside a different aspect ratio. Its box may extend beyond the canvas (cover pan). */
function isBase(n: SceneNode | null | undefined): boolean {
  return !!n && !isGroup(n) && n.role === 'base';
}

/** What a click on leaf `hitId` selects: the ancestor at the CURRENT drill level.
 *  Root level → the outermost root node containing the leaf; inside group G → G's child. */
function resolveSelection(doc: DesignDoc, hitId: string, enteredGroupId: string | null): string {
  const chain = ancestorsOf(doc, hitId); // outermost first
  if (!enteredGroupId) return chain[0]?.id ?? hitId;
  const idx = chain.findIndex((g) => g.id === enteredGroupId);
  if (idx === -1) return chain[0]?.id ?? hitId; // hit outside the entered group → root rules
  return chain[idx + 1]?.id ?? hitId;           // the entered group's child on the path
}

function boxContains(b: LayerBox, x: number, y: number): boolean {
  return x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;
}

/** Geometric hit-test: the TOP-MOST selectable leaf whose box contains the canvas point.
 *  `leaves()` is bottom→top paint order, so scanning from the end returns the visually
 *  top layer under the cursor — independent of which DOM node caught the event, so a big
 *  transparent overlay no longer steals clicks meant for a smaller layer above it in z.
 *  Skips hidden/base/locked leaves (base stays click-through until explicitly selected). */
function hitTest(doc: DesignDoc, x: number, y: number): Layer | null {
  const ls = leaves(doc.layers);
  for (let i = ls.length - 1; i >= 0; i--) {
    const l = ls[i];
    if (l.hidden || isInert(l)) continue;
    if (boxContains(l.box, x, y)) return l;
  }
  return null;
}

// ── component ────────────────────────────────────────────────────────────────────────────────────

interface DragState {
  mode: 'move' | 'resize' | 'marquee';
  ids: string[];
  handle: HandleId | null;
  startClientX: number;
  startClientY: number;
  startBoxes: Map<string, LayerBox>;
  /** Deep snapshots of dragged nodes — resize restores from these each frame so streamed
   *  frames never compound scaling error on group children. */
  startNodes: Map<string, SceneNode>;
  primaryStart: LayerBox;        // bounding box of the dragged set (resize scales into it)
  scale: number;
  targets: SnapTargets;
  moved: boolean;
  additive: boolean;             // marquee with shift
  /** ⌥-drag duplicate already happened this gesture (ids/startBoxes now point at the clones). */
  duplicated: boolean;
  /** The dragged set is a single base image — cover-pan/crop instead of clamping into frame. */
  loose: boolean;
  /** Smart-spacing candidates: the 8 nearest visible leaf boxes, cached once at gesture start. */
  neighbors: LayerBox[];
}

const XRAY_COLORS: Record<string, string> = {
  group: '#a78bfa', image: '#60a5fa', text: '#34d399', badge: '#fbbf24',
  button: '#fbbf24', shape: '#f472b6', vignette: '#94a3b8',
};

export default function Stage({
  doc, selectedIds, enteredGroupId, zoom, underlay, xray,
  onSelect, onEnterGroup, onZoom, onChange, flashes, locked,
}: StageProps): JSX.Element {
  const artboardRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const drag = useRef<DragState | null>(null);
  const [guides, setGuides] = useState<Guides>(NO_GUIDES);
  const [spacing, setSpacing] = useState<SpacingSeg[]>([]);
  const [gesture, setGesture] = useState<'move' | 'resize' | 'marquee' | null>(null);
  const [marquee, setMarquee] = useState<LayerBox | null>(null); // canvas coords
  const [editingId, setEditingId] = useState<string | null>(null);
  /** Which edit session already got its one-shot focus+select (see the textarea ref). */
  const focusedEditFor = useRef<string | null>(null);
  /** Latest text typed in the WYSIWYG session (read from the DOM on input). Declared here
   *  (rather than beside its other usages below) so the lock effect can reach it. */
  const editTextRef = useRef('');
  const [box, setBox] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  /** Deliberate "always marquee" affordance: real comps are usually covered edge-to-edge by
   *  overlay layers (a scrim, a second full-bleed photo, a background shape), so plain
   *  empty-canvas marquee rarely has anywhere to start from. Holding Space while pressing down
   *  forces a marquee regardless of what's under the cursor — read from a ref (not state) so
   *  the pointerdown handler sees the live value without re-subscribing. Mirrored into state
   *  only for the cursor affordance below. */
  const spaceHeld = useRef(false);
  const [spaceDown, setSpaceDown] = useState(false);

  // AgentCursorOverlay stays mounted ~280ms after `locked` clears so its CSS exit-fade can
  // actually play — an instant unmount on `locked=false` would just vanish it with no transition.
  const [showCursor, setShowCursor] = useState(locked);
  const [cursorExiting, setCursorExiting] = useState(false);
  useEffect(() => {
    if (locked) { setShowCursor(true); setCursorExiting(false); return; }
    if (!showCursor) return;
    setCursorExiting(true);
    const t = window.setTimeout(() => { setShowCursor(false); setCursorExiting(false); }, 280);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locked]);

  useEffect(() => {
    const isTypingTarget = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || isTypingTarget(e.target)) return;
      e.preventDefault(); // stop the page from scrolling on Space
      spaceHeld.current = true;
      setSpaceDown(true);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      spaceHeld.current = false;
      setSpaceDown(false);
    };
    const onBlur = () => { spaceHeld.current = false; setSpaceDown(false); };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setBox({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const { w: cw, h: ch } = doc.canvas;

  useEffect(() => {
    if (editingId && !findNode(doc, editingId)) setEditingId(null);
  }, [doc, editingId]);

  // Agent run started mid-gesture/mid-edit: drop any in-progress WYSIWYG text session and
  // clear drag state immediately — a stale contentEditable span must never keep accepting
  // keystrokes (or a stale gesture keep streaming frames) once the canvas goes read-only.
  useEffect(() => {
    if (!locked) return;
    if (editingId) { editTextRef.current = ''; setEditingId(null); focusedEditFor.current = null; }
    drag.current = null;
    setGesture(null);
    setMarquee(null);
    clearGuides();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locked]);

  const pctBox = (b: LayerBox): CSSProperties => ({
    left: `${(b.x / cw) * 100}%`,
    top: `${(b.y / ch) * 100}%`,
    width: `${(b.w / cw) * 100}%`,
    height: `${(b.h / ch) * 100}%`,
  });
  const cq = (n: number) => `${(n / cw) * 100}cqw`;

  const clearGuides = () => {
    setGuides((g) => (g.v === null && g.h === null ? g : NO_GUIDES));
    setSpacing((s) => (s.length ? [] : s));
  };

  // Fit = largest scale where the WHOLE canvas is visible (16px breathing room, both dims).
  const fitW = box.w && box.h
    ? Math.max(120, Math.min(box.w - 16, (box.h - 16) * (cw / ch)))
    : undefined;
  const effectiveZoom = zoom === 'fit' ? ((fitW ?? cw) / cw) : zoom;

  // ── wheel: ⌘/pinch zooms about the cursor; plain wheel scrolls (native) ──
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return; // native pan
      e.preventDefault();
      const cur = zoom === 'fit' ? ((fitW ?? cw) / cw) : zoom;
      const next = clamp(cur * Math.exp(-e.deltaY / 300), 0.05, 4);
      // keep the canvas point under the cursor fixed
      const rect = el.getBoundingClientRect();
      const px = e.clientX - rect.left + el.scrollLeft;
      const py = e.clientY - rect.top + el.scrollTop;
      const ratio = next / cur;
      onZoom(next);
      requestAnimationFrame(() => {
        el.scrollLeft = px * ratio - (e.clientX - rect.left);
        el.scrollTop = py * ratio - (e.clientY - rect.top);
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoom, fitW, cw, onZoom]);

  // ── gesture lifecycle ──
  const clientToCanvas = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const ab = artboardRef.current;
    if (!ab) return null;
    const rect = ab.getBoundingClientRect();
    return { x: ((clientX - rect.left) / rect.width) * cw, y: ((clientY - rect.top) / rect.height) * ch };
  };

  const startNodeDrag = (e: ReactPointerEvent, ids: string[], mode: 'move' | 'resize', handle: HandleId | null) => {
    const ab = artboardRef.current;
    if (!ab || !ids.length) return;
    const rect = ab.getBoundingClientRect();
    const startBoxes = new Map<string, LayerBox>();
    const startNodes = new Map<string, SceneNode>();
    for (const id of ids) {
      const n = findNode(doc, id);
      if (n) {
        startBoxes.set(id, { ...n.box });
        startNodes.set(id, JSON.parse(JSON.stringify(n)));
      }
    }
    const xs = [...startBoxes.values()];
    const primaryStart: LayerBox = {
      x: Math.min(...xs.map((b) => b.x)),
      y: Math.min(...xs.map((b) => b.y)),
      w: Math.max(...xs.map((b) => b.x + b.w)) - Math.min(...xs.map((b) => b.x)),
      h: Math.max(...xs.map((b) => b.y + b.h)) - Math.min(...xs.map((b) => b.y)),
    };
    const exclude = new Set(ids);
    // smart-spacing candidates: the 8 nearest visible leaves by center distance, computed
    // ONCE per gesture (cheap — the per-move check only scans these boxes)
    let neighbors: LayerBox[] = [];
    if (mode === 'move') {
      const excludeDeep = new Set<string>();
      for (const id of ids) {
        const n = findNode(doc, id);
        if (n) walk([n], (x) => { excludeDeep.add(x.id); });
      }
      const cx0 = primaryStart.x + primaryStart.w / 2;
      const cy0 = primaryStart.y + primaryStart.h / 2;
      const dist = (b: LayerBox) => Math.hypot(b.x + b.w / 2 - cx0, b.y + b.h / 2 - cy0);
      neighbors = leaves(doc.layers)
        .filter((l) => !excludeDeep.has(l.id) && l.role !== 'base')
        .map((l) => ({ ...l.box }))
        .sort((a, b) => dist(a) - dist(b))
        .slice(0, 8);
    }
    drag.current = {
      mode, ids, handle,
      startClientX: e.clientX, startClientY: e.clientY,
      startBoxes, startNodes, primaryStart,
      scale: rect.width / cw,
      targets: buildSnapTargets(doc, exclude),
      moved: false,
      additive: false,
      duplicated: false,
      loose: ids.length === 1 && (() => { const n = findNode(doc, ids[0]); return !!n && isBase(n); })(),
      neighbors,
    };
    setGesture(mode);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onLeafPointerDown = (e: ReactPointerEvent, leaf: Layer) => {
    e.stopPropagation();
    if (locked) return; // agent run in flight — read-only (CSS pointer-events:none normally
    // stops this before it fires; kept as defense in depth against any future overlay that
    // doesn't route through the locked wrapper).
    if (e.button !== 0) return;
    // SPACE-drag ALWAYS marquees, even when the pointer lands directly on a leaf — leaves stop
    // propagation, so without this check onStagePointerDown's own Space handling never runs and
    // a drag starting on any overlay layer would always move it instead. See onStagePointerDown.
    if (spaceHeld.current) {
      const pt = clientToCanvas(e.clientX, e.clientY);
      if (pt) startMarquee(e, pt);
      return;
    }
    // Trust GEOMETRY, not which DOM node caught the event: re-resolve the top-most selectable
    // leaf under the exact pointer position. A single click on any point inside a layer's box
    // now selects that layer's top hit — no fiddly "aim at the visible pixel" gesture, and big
    // transparent overlays can't steal a click from a layer that sits above them in z.
    const pt = clientToCanvas(e.clientX, e.clientY);
    const hit = pt ? (hitTest(doc, pt.x, pt.y) ?? leaf) : leaf;
    const targetId = resolveSelection(doc, hit.id, enteredGroupId);
    const target = findNode(doc, targetId);
    if (!target) return;
    let ids: string[];
    const additive = e.shiftKey || e.metaKey || e.ctrlKey; // ⇧ or ⌘/ctrl toggles multi-select
    if (additive) {
      ids = selectedIds.includes(targetId)
        ? selectedIds.filter((i) => i !== targetId)
        : [...selectedIds, targetId];
      onSelect(ids);
    } else {
      ids = selectedIds.includes(targetId) ? selectedIds : [targetId];
      onSelect(ids);
    }
    if (editingId === hit.id) return;
    // base is movable only when it was already explicitly selected (panel or prior click)
    const movable = ids.filter((id) => {
      const n = findNode(doc, id);
      return n && !n.locked && (!isBase(n) || selectedIds.includes(id));
    });
    if (movable.length) startNodeDrag(e, movable, 'move', null);
  };

  const onHandlePointerDown = (e: ReactPointerEvent, handle: HandleId) => {
    e.stopPropagation();
    if (locked) return; // agent run in flight — read-only
    if (e.button !== 0) return;
    const movable = selectedIds.filter((id) => {
      const n = findNode(doc, id);
      return n && !n.locked;
    });
    if (movable.length) startNodeDrag(e, movable, 'resize', handle);
  };

  const startMarquee = (e: ReactPointerEvent, pt: { x: number; y: number }) => {
    drag.current = {
      mode: 'marquee', ids: [], handle: null,
      startClientX: e.clientX, startClientY: e.clientY,
      startBoxes: new Map(), startNodes: new Map(), primaryStart: { x: pt.x, y: pt.y, w: 0, h: 0 },
      scale: 1, targets: { v: [], h: [] }, moved: false,
      additive: e.shiftKey,
      duplicated: false,
      loose: false,
      neighbors: [],
    };
    setGesture('marquee');
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onStagePointerDown = (e: ReactPointerEvent) => {
    if (locked) return; // agent run in flight — read-only
    if (e.button !== 0) return;
    const pt = clientToCanvas(e.clientX, e.clientY);
    if (!pt) { onSelect([]); return; }
    // SPACE-drag ALWAYS marquees, regardless of what's under the cursor. Real ad comps are
    // usually covered edge-to-edge by overlay layers (scrim, second full-bleed photo, shape),
    // so the "click empty canvas" marquee below has nowhere to start from in practice — this
    // is the deliberate lasso-select affordance for that case.
    if (spaceHeld.current) { startMarquee(e, pt); return; }
    // The event reaches the stage only when the DOM node under the cursor was click-through
    // (an inert base/locked layer, a `pointer-events:none` overlay, or truly empty canvas).
    // Geometrically re-test first so a click still lands on a real selectable layer sitting
    // beneath that overlay — otherwise it falls through to marquee/deselect as before.
    const hit = hitTest(doc, pt.x, pt.y);
    if (hit) { onLeafPointerDown(e, hit); return; }
    // empty canvas: start a marquee; click (no move) deselects on pointer-up
    startMarquee(e, pt);
  };

  const onStagePointerMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dxs = e.clientX - d.startClientX;
    const dys = e.clientY - d.startClientY;
    if (!d.moved && Math.abs(dxs) < 3 && Math.abs(dys) < 3) return;
    d.moved = true;

    if (d.mode === 'marquee') {
      const pt = clientToCanvas(e.clientX, e.clientY);
      if (!pt) return;
      const s = d.primaryStart;
      setMarquee({
        x: Math.min(s.x, pt.x), y: Math.min(s.y, pt.y),
        w: Math.abs(pt.x - s.x), h: Math.abs(pt.y - s.y),
      });
      return;
    }

    const threshold = SNAP_SCREEN_PX / d.scale;
    if (d.mode === 'move') {
      const r = moveBox(d.primaryStart, dxs / d.scale, dys / d.scale, doc.canvas, d.targets, threshold);
      let box = r.box;
      let segs: SpacingSeg[] = [];
      if (d.neighbors.length) {
        const sp = spacingSnap(box, d.neighbors, { x: r.guides.v !== null, y: r.guides.h !== null });
        box = {
          ...box,
          x: Math.round(clamp(sp.x, 0, Math.max(0, doc.canvas.w - box.w))),
          y: Math.round(clamp(sp.y, 0, Math.max(0, doc.canvas.h - box.h))),
        };
        segs = sp.segs;
      }
      const ddx = box.x - d.primaryStart.x;
      const ddy = box.y - d.primaryStart.y;
      setGuides((g) => (g.v === r.guides.v && g.h === r.guides.h ? g : r.guides));
      setSpacing((prev) => (prev.length === 0 && segs.length === 0 ? prev : segs));

      // ⌥ on a move = duplicate-and-drag (Figma parity, read PER MOVE so pressing ⌥ mid-drag
      // works): the first altKey frame clones the dragged nodes with fresh ids, restores the
      // originals to their gesture-start spot, and retargets the gesture at the clones. The
      // insertion streams through the SAME onChange mutation as the move frame, so the
      // pointer-up commit still closes everything as ONE undo step. The mutate is idempotent
      // (clone ids checked) in case the shell invokes it against more than one draft.
      let dupClones: { srcId: string; clone: SceneNode }[] | null = null;
      let dupRestore: Map<string, SceneNode> | null = null;
      if (e.altKey && !d.duplicated) {
        dupClones = [];
        dupRestore = d.startNodes;
        const newBoxes = new Map<string, LayerBox>();
        const newNodes = new Map<string, SceneNode>();
        for (const id of d.ids) {
          const snap = d.startNodes.get(id);
          const start = d.startBoxes.get(id);
          if (!snap || !start) continue;
          const clone = cloneNodeDeep(snap);
          dupClones.push({ srcId: id, clone });
          newBoxes.set(clone.id, { ...start });
          newNodes.set(clone.id, JSON.parse(JSON.stringify(clone)) as SceneNode);
          d.neighbors.push({ ...start }); // the stationary original becomes a spacing neighbor
        }
        d.duplicated = true;
        d.ids = dupClones.map((c) => c.clone.id);
        d.startBoxes = newBoxes;
        d.startNodes = newNodes;
      }

      onChange((next) => {
        if (dupClones && dupRestore) {
          for (const { srcId, clone } of dupClones) {
            if (findNode(next, clone.id)) continue; // already inserted in this draft
            const list = findParentList(next, srcId);
            const idx = list ? list.findIndex((n) => n.id === srcId) : -1;
            const snap = dupRestore.get(srcId);
            if (!list || idx < 0 || !snap) continue;
            list[idx] = JSON.parse(JSON.stringify(snap)) as SceneNode;                 // original stays put
            list.splice(idx + 1, 0, JSON.parse(JSON.stringify(clone)) as SceneNode);   // clone rides the drag
          }
          d.targets = buildSnapTargets(next, new Set(d.ids)); // originals now snap-attract
        }
        for (const [id, start] of d.startBoxes) {
          const n = findNode(next, id);
          if (!n) continue;
          const curDx = start.x + ddx - n.box.x;
          const curDy = start.y + ddy - n.box.y;
          translateNode(n, curDx, curDy);
        }
      }, false);
      if (dupClones) onSelect(d.ids);
    } else {
      const r = resizeBox(d.primaryStart, d.handle!, dxs / d.scale, dys / d.scale, doc.canvas, d.targets, threshold, { aspect: e.shiftKey, center: e.altKey });
      setGuides((g) => (g.v === r.guides.v && g.h === r.guides.h ? g : r.guides));
      onChange((next) => {
        for (const [id, snap] of d.startNodes) {
          const n = findNode(next, id);
          if (!n) continue;
          // restore the whole node from its drag-start snapshot, then scale from the set's
          // start bounds into the new bounds — no compounding across streamed frames
          const fresh = JSON.parse(JSON.stringify(snap)) as SceneNode;
          n.box = fresh.box;
          if (isGroup(n) && isGroup(fresh)) n.children = fresh.children;
          else if (!isGroup(n) && !isGroup(fresh)) n.style = fresh.style;
          scaleNodeInto(n, d.primaryStart, r.box);
        }
      }, false);
    }
  };

  const onStagePointerUp = (e: ReactPointerEvent) => {
    const d = drag.current;
    drag.current = null;
    clearGuides();
    setGesture(null);
    if (!d) return;
    if (d.mode === 'marquee') {
      if (!d.moved) {
        onSelect([]);
        onEnterGroup(null);
      } else if (marquee) {
        // select nodes at the current level intersecting the marquee
        const level: SceneNode[] = enteredGroupId
          ? ((findNode(doc, enteredGroupId) as GroupNode | null)?.children ?? doc.layers)
          : doc.layers;
        const hit = level
          .filter((n) => !n.hidden && !(!isGroup(n) && (n.role === 'base' || n.locked)))
          .filter((n) =>
            n.box.x < marquee.x + marquee.w && n.box.x + n.box.w > marquee.x &&
            n.box.y < marquee.y + marquee.h && n.box.y + n.box.h > marquee.y)
          .map((n) => n.id);
        onSelect(d.additive ? [...new Set([...selectedIds, ...hit])] : hit);
      }
      setMarquee(null);
      return;
    }
    if (d.moved) onChange(() => {}, true);
    void e;
  };

  // ── inline text editing ──
  const openEditor = (e: ReactMouseEvent, leaf: Layer) => {
    e.stopPropagation();
    if (locked) return; // agent run in flight — no new text-edit sessions
    drag.current = null;
    clearGuides();
    setGesture(null);
    // resolve the leaf under the cursor geometrically (same top-hit rule as single-click)
    const pt = clientToCanvas(e.clientX, e.clientY);
    const hit = pt ? (hitTest(doc, pt.x, pt.y) ?? leaf) : leaf;
    const targetId = resolveSelection(doc, hit.id, enteredGroupId);
    const target = findNode(doc, targetId);
    if (target && isGroup(target)) {
      // drill one level into the group
      onEnterGroup(target.id);
      const inner = resolveSelection({ ...doc }, hit.id, target.id);
      onSelect([inner]);
      return;
    }
    if (!EDITABLE_TYPES.has(hit.type) || isInert(hit)) return;
    setEditingId(hit.id);
    onSelect([hit.id]);
  };

  /** One-shot mount for the contentEditable span: focus + select-all exactly once per edit
   *  session (an unguarded callback ref re-selected the text on every parent re-render —
   *  that was the "erratic caption editing" bug). */
  const mountEditable = (l: Layer) => (el: HTMLSpanElement | null) => {
    if (!el || focusedEditFor.current === l.id) return;
    focusedEditFor.current = l.id;
    editTextRef.current = l.text || '';
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  };
  const onEditableInput = (e: React.FormEvent<HTMLSpanElement>) => {
    editTextRef.current = (e.currentTarget.innerText || '').replace(/ /g, ' ');
  };
  const onEditableKeyDown = (e: React.KeyboardEvent<HTMLSpanElement>) => {
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      editTextRef.current = ''; // discard
      (e.currentTarget as HTMLSpanElement).blur();
    }
  };

  const commitEdit = () => {
    const id = editingId;
    if (!id) return;
    setEditingId(null);
    focusedEditFor.current = null;
    const text = editTextRef.current;
    editTextRef.current = '';
    const l = findNode(doc, id);
    if (!l || isGroup(l) || !text || (l.text || '') === text) return;
    onChange((next) => {
      // v2 single edit path: element children rebuild through their param (clean re-measure,
      // no stale styles). Plain layers fall through to a direct set + autoH growth.
      if (applyElementTextEdit(next, id, text)) return;
      const t = findNode(next, id);
      if (t && !isGroup(t)) {
        t.text = text;
        if (t.autoH !== false) {
          const need = textBlockHeight(t as Layer);
          if (need > t.box.h) t.box.h = need;
        }
      }
    }, true);
  };

  // ── leaf rendering (groups recurse; coords are absolute so nesting is flat DOM) ──
  const renderLeaf = (l: Layer, groupOpacity: number): ReactNode => {
    const s = l.style || {};
    const editing = editingId === l.id;
    const autoH = !!l.autoH && EDITABLE_TYPES.has(l.type);
    // PARITY: raster.ts/designSvg.ts AnyShapeKind — 'path' isn't in the ShapeKind union yet,
    // so read shapeKind defensively as a string to allow the freeform-path case below.
    const kind = (s.shapeKind as ShapeKind | 'path' | undefined) || 'rect';
    const strokeCss = s.stroke && s.stroke.width > 0 && kind === 'rect'
      ? { boxShadow: `inset 0 0 0 ${cq(s.stroke.width)} ${s.stroke.color}` }
      : undefined;
    // starburst clip-path — same math as raster/SVG (fills.starburstPoints), as % of the box
    const starClip = kind === 'starburst'
      ? `polygon(${starburstPoints({ x: 0, y: 0, w: 100, h: 100 }, s.spikes ?? 12)
        .map(([px, py]) => `${px.toFixed(2)}% ${py.toFixed(2)}%`).join(', ')})`
      : undefined;
    const glass = s.backdropBlur && s.backdropBlur > 0
      ? { backdropFilter: `blur(${cq(s.backdropBlur)})`, WebkitBackdropFilter: `blur(${cq(s.backdropBlur)})` }
      : undefined;
    // corner radius: per-corner override wins over uniform radius
    const cornerCss = (fallback = 0) => s.radiusCorners
      ? s.radiusCorners.map((r) => cq(r)).join(' ')
      : (s.radius ? cq(s.radius) : (fallback ? cq(fallback) : 0));
    return (
      <div
        key={l.id}
        className={styles.layer}
        data-inert={isInert(l) || undefined}
        data-autoh={autoH || undefined}
        style={{
          ...pctBox(l.box),
          ...(autoH ? { height: 'auto', minHeight: `${(l.box.h / ch) * 100}%` } : null),
          opacity: (s.opacity ?? 1) * groupOpacity,
          transform: l.rotation ? `rotate(${l.rotation}deg)` : undefined,
          mixBlendMode: s.blend && s.blend !== 'normal' ? s.blend : undefined,
          filter: s.blur && s.blur > 0 ? `blur(${cq(s.blur)})` : undefined,
          ...strokeCss,
        }}
        onPointerDown={(e) => onLeafPointerDown(e, l)}
        onDoubleClick={(e) => openEditor(e, l)}
      >
        {l.type === 'image' && l.src ? (
          pixelateOf(s) > 0 ? (
            // True mosaic censoring (block size in px at the layer's rendered box) — e.g.
            // blurring/pixelating a face or username in a real photo/avatar. Additive to
            // style.blur; when both are set pixelate wins (mosaic is the explicit censor intent).
            // Same objectFit/borderRadius CSS as the sharp path below, so it drops in cleanly —
            // the avatarShape synthetic-circle blur/pixelate path (templates.mjs) is untouched.
            <PixelatedImage
              src={l.src}
              blockSize={pixelateOf(s)}
              w={l.box.w}
              h={l.box.h}
              style={{ objectFit: l.fit || 'cover', borderRadius: kind === 'ellipse' ? '50%' : cornerCss() }}
            />
          ) : (
            <img src={l.src} alt="" draggable={false} style={{ objectFit: l.fit || 'cover', borderRadius: kind === 'ellipse' ? '50%' : cornerCss() }} />
          )
        ) : l.type === 'vignette' ? (
          <div className={styles.shape} style={{ background: vignetteCss(vignetteSpec(s)) }} />
        ) : l.type === 'shape' && (kind === 'arrow' || kind === 'line') ? (
          // callout annotation: line along the box diagonal (+ arrowhead), same geometry
          // as raster/SVG via fills.arrowGeometry — drawn in an inline SVG scaled to the box
          (() => {
            const g = arrowGeometry({ x: 0, y: 0, w: l.box.w, h: l.box.h }, s.flipDiag);
            const c = s.background || s.color || '#111';
            return (
              <svg className={styles.shape} viewBox={`0 0 ${l.box.w} ${l.box.h}`} preserveAspectRatio="none">
                <line x1={g.x1} y1={g.y1} x2={g.x2} y2={g.y2} stroke={c} strokeWidth={g.width} strokeLinecap="round" />
                {kind === 'arrow' ? g.head.map(([hx, hy], i) => (
                  <line key={i} x1={g.x2} y1={g.y2} x2={hx} y2={hy} stroke={c} strokeWidth={g.width} strokeLinecap="round" />
                )) : null}
              </svg>
            );
          })()
        ) : l.type === 'shape' && kind === 'path' && s.path ? (
          // freeform vector icon: d-string coords are normalized 0..1 in box space (PARITY:
          // raster.ts pathGeometry bakes translate(x,y)·scale(w,h); designSvg.ts/designstore.mjs
          // emit transform="translate(box.x box.y) scale(box.w box.h)"). Here the wrapper <div>
          // is already positioned/sized to the box via pctBox(l.box), so a 0..1 viewBox with
          // preserveAspectRatio="none" reproduces the identical scale(w,h) mapping with no
          // extra transform math — non-scaling-stroke keeps stroke width uniform under the
          // non-uniform scale, matching the SVG export's vector-effect.
          <svg className={styles.shape} viewBox="0 0 1 1" preserveAspectRatio="none">
            <path
              d={s.path}
              fill={s.background || '#000000'}
              stroke={s.stroke && s.stroke.width > 0 ? s.stroke.color : undefined}
              strokeWidth={s.stroke && s.stroke.width > 0 ? s.stroke.width : undefined}
              vectorEffect="non-scaling-stroke"
            />
          </svg>
        ) : l.type === 'shape' ? (
          <div
            className={styles.shape}
            style={{
              background: fillCss(s) || '#000',
              borderRadius: kind === 'ellipse' ? '50%' : cornerCss(),
              clipPath: starClip,
              ...glass,
            }}
          />
        ) : (
          <span
            className={styles.text}
            data-autoh={autoH || undefined}
            data-editing={editing || undefined}
            style={{
              fontSize: cq(s.fontSize || 40),
              fontWeight: s.fontWeight || 600,
              fontFamily: s.fontFamily ? `'${s.fontFamily}', var(--font-sans)` : undefined,
              color: s.color || '#fff',
              background: s.pill ? 'transparent' : fillCss(s) || 'transparent',
              borderRadius: s.pill ? 0 : cornerCss(),
              padding: s.pill ? 0 : s.padding ? cq(s.padding) : 0,
              textAlign: s.align || 'left',
              justifyContent: s.align === 'center' ? 'center' : s.align === 'right' ? 'flex-end' : 'flex-start',
              lineHeight: s.pill ? (s.lineHeight || 1.2) * 1.25 : s.lineHeight || 1.2,
              letterSpacing: s.letterSpacing ? cq(s.letterSpacing) : undefined,
              textTransform: s.uppercase ? 'uppercase' : 'none',
              textDecoration: s.strikethrough ? 'line-through' : undefined,
              textShadow: s.shadow ? '0 2px 12px rgba(0,0,0,0.55)' : 'none',
              ...glass,
            }}
          >
            {s.pill && s.background ? (
              // Instagram-caption pill: a BLOCK wrapper (text-align positions each line)
              // holding a true INLINE span — box-decoration-break clones the background,
              // padding and radius onto EVERY wrapped line, so each line hugs its own
              // rounded pill. (The inline span can't be a direct flex child: flex items
              // are block-ified, which collapses the per-line backgrounds into one rect.)
              // WYSIWYG editing happens ON this exact span (contentEditable) — same renderer,
              // so per-line pills, wraps and fonts are pixel-identical while typing.
              <span style={{ display: 'block', width: '100%', textAlign: s.align || 'left' }}>
                <span
                  key={editing ? 'edit' : 'view'}
                  ref={editing ? mountEditable(l) : undefined}
                  className={styles.pillInner}
                  contentEditable={editing || undefined}
                  suppressContentEditableWarning
                  spellCheck={false}
                  onInput={editing ? onEditableInput : undefined}
                  onBlur={editing ? commitEdit : undefined}
                  onKeyDown={editing ? onEditableKeyDown : undefined}
                  onPointerDown={editing ? (e) => e.stopPropagation() : undefined}
                  style={{
                    background: s.background,
                    borderRadius: s.radius ? cq(s.radius) : cq(10),
                    padding: `${cq((s.padding || 14) * 0.55)} ${cq(s.padding || 14)}`,
                    ...(editing ? { outline: 'none', cursor: 'text', minWidth: '1ch' } : null),
                  }}
                >
                  {l.text}
                </span>
              </span>
            ) : editing ? (
              <span
                key="edit"
                ref={mountEditable(l)}
                contentEditable
                suppressContentEditableWarning
                spellCheck={false}
                onInput={onEditableInput}
                onBlur={commitEdit}
                onKeyDown={onEditableKeyDown}
                onPointerDown={(e) => e.stopPropagation()}
                style={{ outline: 'none', cursor: 'text', minWidth: '1ch', whiteSpace: 'pre-wrap' }}
              >
                {l.text}
              </span>
            ) : l.text}
          </span>
        )}
      </div>
    );
  };

  /** Clip/mask groups need a real positioned wrapper; children keep ABSOLUTE canvas coords by
   *  rendering inside an inner div sized to the full canvas and offset by -group origin, so
   *  pctBox percentages stay valid. Plain groups keep flattening (opacity only). */
  const renderClippedGroup = (g: GroupNode, groupOpacity: number): ReactNode => {
    const maskChild = g.children.find((c) => !isGroup(c) && (c as Layer).isMask) as Layer | undefined;
    const visible = g.children.filter((c) => c !== maskChild);
    const b = g.box;
    let clipPath: string | undefined;
    if (maskChild) {
      // mask shape geometry relative to the WRAPPER (group box)
      const mb = maskChild.box;
      const rx = ((mb.x - b.x) / b.w) * 100;
      const ry = ((mb.y - b.y) / b.h) * 100;
      const rw = (mb.w / b.w) * 100;
      const rh = (mb.h / b.h) * 100;
      const kind = maskChild.style?.shapeKind || (maskChild.type === 'image' ? 'rect' : maskChild.style?.shapeKind) || 'rect';
      if (kind === 'ellipse') {
        clipPath = `ellipse(${rw / 2}% ${rh / 2}% at ${rx + rw / 2}% ${ry + rh / 2}%)`;
      } else if (kind === 'starburst') {
        const pts = starburstPoints({ x: rx, y: ry, w: rw, h: rh }, maskChild.style?.spikes ?? 12)
          .map(([px, py]) => `${px.toFixed(2)}% ${py.toFixed(2)}%`).join(', ');
        clipPath = `polygon(${pts})`;
      } else {
        const rr = maskChild.style?.radius ? `round ${cq(maskChild.style.radius)}` : '';
        clipPath = `inset(${ry}% ${100 - rx - rw}% ${100 - ry - rh}% ${rx}% ${rr})`;
      }
    }
    return (
      <div
        key={g.id}
        className={styles.groupClip}
        style={{
          ...pctBox(b),
          opacity: (g.style?.opacity ?? 1) * groupOpacity,
          overflow: g.clip ? 'hidden' : undefined,
          borderRadius: g.clip && g.style?.radius ? cq(g.style.radius) : undefined,
          clipPath,
        }}
      >
        <div
          className={styles.groupInner}
          style={{
            width: `${(cw / b.w) * 100}%`,
            height: `${(ch / b.h) * 100}%`,
            left: `${(-b.x / b.w) * 100}%`,
            top: `${(-b.y / b.h) * 100}%`,
          }}
        >
          {renderNodes(visible, 1)}
        </div>
      </div>
    );
  };

  const renderNodes = (nodes: SceneNode[], groupOpacity: number): ReactNode[] =>
    nodes.flatMap((n) => {
      if (n.hidden) return [];
      if (isGroup(n)) {
        const hasMask = n.children.some((c) => !isGroup(c) && (c as Layer).isMask);
        if (n.clip || hasMask) return [renderClippedGroup(n, groupOpacity)];
        return renderNodes(n.children, groupOpacity * (n.style?.opacity ?? 1));
      }
      return [renderLeaf(n, groupOpacity)];
    });

  // ── selection / xray chrome ──
  const selectedNodes = selectedIds
    .map((id) => findNode(doc, id))
    .filter((n): n is SceneNode => !!n && !n.hidden && !(!isGroup(n) && n.role === 'base'));

  const xrayItems = useMemo(() => {
    if (!xray) return [];
    const items: { n: SceneNode; depth: number; idx: number }[] = [];
    let i = 0;
    walk(doc.layers, (n, _p, depth) => {
      if (n.hidden) return false;
      items.push({ n, depth, idx: ++i });
    });
    return items;
  }, [xray, doc]);

  const artboardStyle: CSSProperties = {
    aspectRatio: `${cw} / ${ch}`,
    width: zoom === 'fit' ? (fitW ?? '100%') : cw * zoom,
  };

  return (
    <div
      ref={stageRef}
      className={styles.stage}
      data-locked={locked || undefined}
      data-marquee-ready={spaceDown || undefined}
      onPointerDown={onStagePointerDown}
      onPointerMove={onStagePointerMove}
      onPointerUp={onStagePointerUp}
      onPointerCancel={onStagePointerUp}
    >
      <div ref={artboardRef} className={styles.artboard} style={artboardStyle}>
        <div className={styles.clip}>
          {renderNodes(doc.layers, 1)}

          {showCursor ? <AgentCursorOverlay exiting={cursorExiting} /> : null}

          {underlay && underlay.mode === 'over' ? (
            <img
              className={styles.underlay}
              src={underlay.url}
              alt=""
              draggable={false}
              style={{ opacity: underlay.opacity }}
            />
          ) : null}

          {guides.v !== null ? (
            <div className={styles.guideV} style={{ left: `${(guides.v / cw) * 100}%` }} />
          ) : null}
          {guides.h !== null ? (
            <div className={styles.guideH} style={{ top: `${(guides.h / ch) * 100}%` }} />
          ) : null}

          {marquee ? <div className={styles.marquee} style={pctBox(marquee)} /> : null}

          {xray ? xrayItems.map(({ n, depth, idx }) => (
            <div
              key={`xr-${n.id}`}
              className={styles.xrayBox}
              data-group={isGroup(n) || undefined}
              style={{ ...pctBox(n.box), borderColor: XRAY_COLORS[n.type] || '#999', zIndex: 4 + depth }}
            >
              <span className={styles.xrayTag} style={{ background: XRAY_COLORS[n.type] || '#999' }}>
                {idx} {n.name || n.role || n.type}
              </span>
            </div>
          )) : null}
        </div>

        {/* selection chrome + inline editor live OUTSIDE the clip so handles never get cut off */}
        {selectedNodes.map((n, i) => {
          const primary = i === selectedNodes.length - 1 && selectedNodes.length === 1;
          const autoH = !isGroup(n) && !!n.autoH;
          return (
            <div
              key={`sel-${n.id}`}
              className={styles.selection}
              data-group={isGroup(n) || undefined}
              style={{
                ...pctBox(n.box),
                transform: !isGroup(n) && n.rotation ? `rotate(${n.rotation}deg)` : undefined,
              }}
            >
              {primary && !n.locked && editingId !== n.id
                ? HANDLES.filter((h) => !(autoH && (h.id === 'n' || h.id === 's'))).map((h) => (
                  <div
                    key={h.id}
                    className={styles.handle}
                    style={{
                      left: `${h.x * 100}%`,
                      top: `${h.y * 100}%`,
                      width: HANDLE_PX,
                      height: HANDLE_PX,
                      cursor: h.cursor,
                    }}
                    onPointerDown={(e) => onHandlePointerDown(e, h.id)}
                  />
                ))
                : null}
            </div>
          );
        })}

        {/* agent edit flashes — one-shot outline per touched node (animation runs once, forwards) */}
        {(flashes || []).map((f) => {
          const n = findNode(doc, f.id);
          if (!n || !n.box) return null;
          return <div key={`${f.id}-${f.at}`} className={styles.editFlash} style={pctBox(n.box)} aria-hidden="true" />;
        })}

        {/* WYSIWYG text editing happens inline on the rendered text node itself (renderLeaf)
            — same renderer as the canvas, so nothing here to mirror. */}
      </div>
      <span className={styles.zoomBadge}>{Math.round(effectiveZoom * 100)}%</span>
    </div>
  );
}
