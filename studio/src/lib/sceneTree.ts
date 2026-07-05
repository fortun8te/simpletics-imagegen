// sceneTree.ts — pure helpers over the v3 node tree (no DOM, node-testable).
//
// Invariants they maintain:
//   • child boxes are ABSOLUTE canvas coordinates — a group is selection/opacity/ordering only
//   • a group's own box is the cached bounding box of its VISIBLE children; call
//     normalizeGroups(doc) after any mutation (the Editor does this once, in commit())
//   • sibling order in every array = paint order, bottom → top

import {
  isGroup, isLeafLayer, layerId, scaleStyle,
  type DesignDoc, type GroupNode, type Layer, type LayerBox, type SceneNode,
} from './sceneGraph';

/** Depth-first visit, parents before children. Return false from fn to skip a group's children. */
export function walk(
  nodes: SceneNode[],
  fn: (n: SceneNode, parent: GroupNode | null, depth: number) => void | boolean,
  parent: GroupNode | null = null,
  depth = 0,
): void {
  for (const n of nodes) {
    const r = fn(n, parent, depth);
    if (isGroup(n) && r !== false) walk(n.children, fn, n, depth + 1);
  }
}

/** All renderable leaf layers in paint order (what raster/snap iterate). Skips hidden subtrees
 *  and native ComponentLayers (no renderer consumes those yet — they carry their own HTML/CSS,
 *  not a `style`/`text` leaf shape the raster/SVG/DOM leaf renderers understand). */
export function leaves(nodes: SceneNode[], includeHidden = false): Layer[] {
  const out: Layer[] = [];
  for (const n of nodes) {
    if (n.hidden && !includeHidden) continue;
    if (isGroup(n)) out.push(...leaves(n.children, includeHidden));
    else if (isLeafLayer(n)) out.push(n);
  }
  return out;
}

/** Find a node anywhere in the tree — by id first, then by role. */
export function findNode(doc: DesignDoc, idOrRole: string): SceneNode | null {
  let byId: SceneNode | null = null;
  let byRole: SceneNode | null = null;
  walk(doc.layers, (n) => {
    if (n.id === idOrRole && !byId) byId = n;
    if (n.role === idOrRole && !byRole) byRole = n;
  });
  return byId || byRole;
}

/** The array that directly contains `id` (doc.layers or some group's children). */
export function findParentList(doc: DesignDoc, id: string): SceneNode[] | null {
  const scan = (list: SceneNode[]): SceneNode[] | null => {
    for (const n of list) {
      if (n.id === id) return list;
      if (isGroup(n)) {
        const hit = scan(n.children);
        if (hit) return hit;
      }
    }
    return null;
  };
  return scan(doc.layers);
}

/** The group that directly contains `id`, or null when it sits at the root. */
export function findParentGroup(doc: DesignDoc, id: string): GroupNode | null {
  let out: GroupNode | null = null;
  walk(doc.layers, (n, parent) => { if (n.id === id) out = parent; });
  return out;
}

/** Chain of ancestor groups for a node, outermost first. */
export function ancestorsOf(doc: DesignDoc, id: string): GroupNode[] {
  const path: GroupNode[] = [];
  const scan = (list: SceneNode[], trail: GroupNode[]): boolean => {
    for (const n of list) {
      if (n.id === id) { path.push(...trail); return true; }
      if (isGroup(n) && scan(n.children, [...trail, n])) return true;
    }
    return false;
  };
  scan(doc.layers, []);
  return path;
}

/** Axis-aligned bounding box of a (possibly rotated) box, rotated about its own center — same
 *  math the DOM/CSS `rotate()` transform produces. Unrotated boxes pass through unchanged. */
function rotatedAabb(b: LayerBox, rotation?: number): LayerBox {
  if (!rotation) return b;
  const rad = (rotation * Math.PI) / 180;
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  const w = b.w * cos + b.h * sin;
  const h = b.w * sin + b.h * cos;
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

export function groupBounds(children: SceneNode[]): LayerBox {
  const vis = children.filter((c) => !c.hidden);
  const list = vis.length ? vis : children;
  if (!list.length) return { x: 0, y: 0, w: 0, h: 0 };
  // Rotated children (badges/stickers at an angle) render as a bigger axis-aligned footprint
  // than their stored box — groups must size to THAT, or a clipping group cuts off the corners.
  const boxes = list.map((c) => rotatedAabb(c.box, isGroup(c) ? undefined : (c as Layer).rotation));
  const x1 = Math.min(...boxes.map((b) => b.x));
  const y1 = Math.min(...boxes.map((b) => b.y));
  const x2 = Math.max(...boxes.map((b) => b.x + b.w));
  const y2 = Math.max(...boxes.map((b) => b.y + b.h));
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/** Recompute every group's cached box bottom-up. Mutates in place; call after any commit. */
export function normalizeGroups(doc: DesignDoc): void {
  const fix = (nodes: SceneNode[]) => {
    for (const n of nodes) {
      if (!isGroup(n)) continue;
      fix(n.children);
      n.box = groupBounds(n.children);
    }
  };
  fix(doc.layers);
}

/** Move a node (and, for groups, every descendant) by (dx, dy). */
export function translateNode(n: SceneNode, dx: number, dy: number): void {
  n.box = { ...n.box, x: n.box.x + dx, y: n.box.y + dy };
  if (isGroup(n)) for (const c of n.children) translateNode(c, dx, dy);
}

/** Proportionally map a node from one box to another (group resize). Boxes map linearly;
 *  leaf typographic metrics scale with the horizontal ratio — same recipe as canvas resize. */
export function scaleNodeInto(n: SceneNode, from: LayerBox, to: LayerBox): void {
  const sx = from.w ? to.w / from.w : 1;
  const sy = from.h ? to.h / from.h : 1;
  const map = (node: SceneNode) => {
    node.box = {
      x: Math.round(to.x + (node.box.x - from.x) * sx),
      y: Math.round(to.y + (node.box.y - from.y) * sy),
      w: Math.max(1, Math.round(node.box.w * sx)),
      h: Math.max(1, Math.round(node.box.h * sy)),
    };
    if (isGroup(node)) node.children.forEach(map);
    else if (isLeafLayer(node)) node.style = scaleStyle(node.style, sx);
    // ComponentLayer: no `style`/typography — its own HTML/CSS owns layout; box already scaled.
  };
  map(n);
}

/** Wrap the nodes with those ids (which must share ONE parent list) in a new group inserted at
 *  the topmost member's position. Returns the group, or null if the ids don't share a parent. */
export function groupNodes(doc: DesignDoc, ids: string[], name?: string): GroupNode | null {
  const uniq = [...new Set(ids)];
  if (uniq.length < 1) return null;
  const list = findParentList(doc, uniq[0]);
  if (!list) return null;
  const members = list.filter((n) => uniq.includes(n.id));
  if (members.length !== uniq.length) return null; // not all in the same parent list
  if (members.some((n) => !isGroup(n) && n.role === 'base')) return null; // base stays at root
  const topIndex = Math.max(...members.map((n) => list.indexOf(n)));
  const group: GroupNode = {
    id: layerId('group'),
    type: 'group',
    name: name || 'Group',
    box: groupBounds(members),
    children: members, // keeps relative paint order (list order preserved by filter)
  };
  // remove members, insert group where the topmost member sat (minus removed-below shift)
  const removedBelow = members.filter((m) => list.indexOf(m) < topIndex).length;
  for (const m of members) list.splice(list.indexOf(m), 1);
  list.splice(topIndex - removedBelow, 0, group);
  return group;
}

/** Dissolve a group: splice its children back into the parent list at its position. */
export function ungroupNode(doc: DesignDoc, id: string): SceneNode[] | null {
  const list = findParentList(doc, id);
  if (!list) return null;
  const i = list.findIndex((n) => n.id === id);
  const node = list[i];
  if (!node || !isGroup(node)) return null;
  list.splice(i, 1, ...node.children);
  return node.children;
}

/** Move a node into a group (or to the root when into=null) at `index`. Refuses cycles. */
export function reparentNode(doc: DesignDoc, id: string, into: string | null, index: number): boolean {
  const list = findParentList(doc, id);
  if (!list) return false;
  const node = list[list.findIndex((n) => n.id === id)];
  if (!node) return false;
  if (isGroup(node) && into) {
    // no dropping a group into itself/its own descendant
    let cyclic = into === id;
    walk(node.children, (n) => { if (n.id === into) cyclic = true; });
    if (cyclic) return false;
  }
  let target: SceneNode[];
  if (into === null) target = doc.layers;
  else {
    const g = findNode(doc, into);
    if (!g || !isGroup(g)) return false;
    target = g.children;
  }
  list.splice(list.indexOf(node), 1);
  target.splice(Math.max(0, Math.min(target.length, index)), 0, node);
  return true;
}

/** Deep-clone a node with FRESH ids throughout (⌥-drag duplicate, paste). Pure — the source
 *  node is untouched; every node in the copied subtree gets a new id. */
export function cloneNodeDeep(n: SceneNode): SceneNode {
  const copy = JSON.parse(JSON.stringify(n)) as SceneNode;
  const rename = (node: SceneNode): void => {
    node.id = layerId(isGroup(node) ? 'group' : node.role || node.type);
    if (isGroup(node)) node.children.forEach(rename);
  };
  rename(copy);
  return copy;
}

// ── alignment / distribution (Figma-style, translate-only — groups move as units) ───────────────

export type AlignDir = 'l' | 'c' | 'r' | 't' | 'm' | 'b';

/** Align nodes: l/c/r = left/center/right (x axis), t/m/b = top/middle/bottom (y axis).
 *  scope 'canvas' aligns against the canvas rect; 'selection' against the selection's bounding
 *  box (falls back to canvas for a single node — selection-aligning one node is a no-op). */
export function alignNodes(
  doc: DesignDoc, ids: string[], dir: AlignDir, scope: 'canvas' | 'selection',
): void {
  const nodes = [...new Set(ids)]
    .map((id) => findNode(doc, id))
    .filter((n): n is SceneNode => !!n);
  if (!nodes.length) return;
  const ref: LayerBox = scope === 'selection' && nodes.length > 1
    ? groupBounds(nodes)
    : { x: 0, y: 0, w: doc.canvas.w, h: doc.canvas.h };
  for (const n of nodes) {
    const b = n.box;
    const dx = dir === 'l' ? ref.x - b.x
      : dir === 'c' ? ref.x + ref.w / 2 - (b.x + b.w / 2)
      : dir === 'r' ? ref.x + ref.w - (b.x + b.w)
      : 0;
    const dy = dir === 't' ? ref.y - b.y
      : dir === 'm' ? ref.y + ref.h / 2 - (b.y + b.h / 2)
      : dir === 'b' ? ref.y + ref.h - (b.y + b.h)
      : 0;
    if (dx || dy) translateNode(n, Math.round(dx), Math.round(dy));
  }
}

/** Distribute ≥3 nodes with EQUAL GAPS inside the selection's bounds along `axis` — the two
 *  outermost nodes stay put, the rest slide between them, ordered by current position. */
export function distributeNodes(doc: DesignDoc, ids: string[], axis: 'h' | 'v'): void {
  const nodes = [...new Set(ids)]
    .map((id) => findNode(doc, id))
    .filter((n): n is SceneNode => !!n);
  if (nodes.length < 3) return;
  const pos = (b: LayerBox) => (axis === 'h' ? b.x : b.y);
  const len = (b: LayerBox) => (axis === 'h' ? b.w : b.h);
  const sorted = [...nodes].sort((a, b) =>
    pos(a.box) - pos(b.box) || (axis === 'h' ? a.box.y - b.box.y : a.box.x - b.box.x));
  const first = sorted[0].box;
  const last = sorted[sorted.length - 1].box;
  const span = pos(last) + len(last) - pos(first);
  const total = sorted.reduce((s, n) => s + len(n.box), 0);
  const gap = (span - total) / (sorted.length - 1); // may be negative (overlap) — still equalizes
  let cursor = pos(first);
  for (const n of sorted) {
    const d = Math.round(cursor) - pos(n.box);
    if (d) translateNode(n, axis === 'h' ? d : 0, axis === 'h' ? 0 : d);
    cursor += len(n.box) + gap;
  }
}

/** Clamp every leaf box inside the canvas (post-rescale "nothing goes out of frame"). */
export function clampIntoCanvas(doc: DesignDoc): void {
  for (const l of leaves(doc.layers, true)) {
    if (l.role === 'base') continue;
    l.box.w = Math.min(l.box.w, doc.canvas.w);
    l.box.h = Math.min(l.box.h, doc.canvas.h);
    l.box.x = Math.max(0, Math.min(doc.canvas.w - l.box.w, l.box.x));
    l.box.y = Math.max(0, Math.min(doc.canvas.h - l.box.h, l.box.y));
  }
}

export function countNodes(nodes: SceneNode[]): number {
  let n = 0;
  walk(nodes, () => { n++; });
  return n;
}
