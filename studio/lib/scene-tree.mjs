// lib/scene-tree.mjs — server-side helpers for the v3 scene-graph tree (plain-JS mirror of
// the frontend's tree utilities). doc.layers is a tree: leaf layers or groups
// { id, type:'group', name, box, children:[…] } with ABSOLUTE child coordinates.
// Flat v2 docs are just trees with no groups, so everything here works on both.

/** Depth-first walk. fn(node, depth, parentList) — return false to stop descending into a group. */
export function walkNodes(nodes, fn, depth = 0) {
  for (const n of nodes || []) {
    const r = fn(n, depth, nodes);
    if (n.type === 'group' && Array.isArray(n.children) && r !== false) {
      walkNodes(n.children, fn, depth + 1);
    }
  }
}

/** All leaf (non-group) nodes in order. */
export function leaves(nodes) {
  const out = [];
  walkNodes(nodes, (n) => { if (n.type !== 'group') out.push(n); });
  return out;
}

/** Find a node anywhere in the tree by id first, then by role. Groups are findable by id. */
export function findNode(doc, idOrRole) {
  if (!idOrRole) return null;
  let byId = null;
  let byRole = null;
  walkNodes(doc.layers || [], (n) => {
    if (!byId && n.id === idOrRole) byId = n;
    if (!byRole && n.role === idOrRole) byRole = n;
  });
  return byId || byRole;
}

/** The array (doc.layers or some group's children) that directly contains node `id`. */
export function findParentList(doc, id) {
  let found = null;
  walkNodes(doc.layers || [], (n, _d, list) => {
    if (n.id === id) found = list;
  });
  return found;
}

/** Axis-aligned bounding box of a (possibly rotated) box, rotated about its own center — same
 *  math the DOM/CSS `rotate()` transform produces. Unrotated boxes pass through unchanged. */
function rotatedAabb(b, rotation) {
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

/** Bounding box of a set of child nodes (absolute coords). Null when empty. */
export function groupBounds(children) {
  const vis = (children || []).filter((c) => c && c.box && !c.hidden);
  if (!vis.length) return null;
  // Rotated children (badges/stickers at an angle) render as a bigger axis-aligned footprint
  // than their stored box — groups must size to THAT, or a clipping group cuts off the corners.
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const c of vis) {
    const b = rotatedAabb(c.box, c.type !== 'group' ? c.rotation : undefined);
    x1 = Math.min(x1, b.x);
    y1 = Math.min(y1, b.y);
    x2 = Math.max(x2, b.x + b.w);
    y2 = Math.max(y2, b.y + b.h);
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/** Recompute every group's box bottom-up from its visible children. Mutates doc. */
export function normalizeGroups(doc) {
  const fix = (nodes) => {
    for (const n of nodes || []) {
      if (n.type === 'group' && Array.isArray(n.children)) {
        fix(n.children);
        const b = groupBounds(n.children);
        if (b) n.box = b;
      }
    }
  };
  fix(doc.layers || []);
  return doc;
}

/** Translate a node (and, recursively, a group's children) by dx/dy. */
export function translateNode(node, dx, dy) {
  if (!node) return;
  if (node.box) { node.box.x += dx; node.box.y += dy; }
  if (node.type === 'group' && Array.isArray(node.children)) {
    for (const c of node.children) translateNode(c, dx, dy);
  }
}

/** Scale typographic metrics by a width ratio. Plain-JS port of sceneGraph.ts scaleStyle —
 *  same recipe: fontSize/radius/padding rounded, letterSpacing to 0.1px, stroke.width ≥ 1. */
export function scaleStyle(style, sx) {
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

/** Proportionally map a node (and its subtree) from one box to another. Plain-JS port of
 *  sceneTree.ts scaleNodeInto — boxes map linearly per axis; leaf typographic metrics scale
 *  with the horizontal ratio. Mutates in place. */
export function scaleNodeInto(node, fromBox, toBox) {
  const sx = fromBox.w ? toBox.w / fromBox.w : 1;
  const sy = fromBox.h ? toBox.h / fromBox.h : 1;
  const map = (n) => {
    if (!n || !n.box) return;
    n.box = {
      x: Math.round(toBox.x + (n.box.x - fromBox.x) * sx),
      y: Math.round(toBox.y + (n.box.y - fromBox.y) * sy),
      w: Math.max(1, Math.round(n.box.w * sx)),
      h: Math.max(1, Math.round(n.box.h * sy)),
    };
    if (n.type === 'group' && Array.isArray(n.children)) n.children.forEach(map);
    else n.style = scaleStyle(n.style, sx);
  };
  map(node);
}

/** Total node count (groups + leaves). */
export function countNodes(doc) {
  let n = 0;
  walkNodes(doc.layers || [], () => { n++; });
  return n;
}
