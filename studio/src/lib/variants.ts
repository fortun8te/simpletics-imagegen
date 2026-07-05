// variants.ts — pure client-side variant sets over DesignDocs (no server changes).
//
// A "variant set" is N sibling comps of the same ad. Membership is encoded WITHOUT any new
// server field: every member carries a hidden tag `set:vset_xxx` (tags already ride through
// summaries + saves), plus optional `variantSet`/`variantName` fields on the doc itself
// (unknown extra fields are tolerated by the server and survive round-trips).
//
// Two operations:
//   makeVariants(doc, n)         — n deep copies with fresh ids sharing one set id; the source
//                                  is stamped too (variantName 'A', copies 'B', 'C', …).
//   pushToVariants(src, tgt, f)  — copy chosen field groups (layout/styles/text/images) from a
//                                  source variant onto a sibling, matching nodes conservatively.
//
// Matching rules (first hit wins, leaf-to-leaf, types must agree, each target used once):
//   1. element id + ordinal  — nth leaf built from the same lib/elements def
//   2. role + ordinal        — nth leaf with the same semantic role
//   3. name + ordinal        — nth leaf with the same panel name
//   4. tree-path index       — same position in the (group-nested) tree
// Unmatched nodes are left untouched; nothing is ever added or removed on the target.

import {
  designId, isGroup, isLeafLayer, scaleStyle,
  type DesignDoc, type Layer, type LayerBox, type SceneNode,
} from './sceneGraph';

export type VariantDoc = DesignDoc & {
  variantSet?: string;
  variantName?: string;
};

// ── set membership via hidden tags ───────────────────────────────────────────────────────────────

export const SET_TAG_PREFIX = 'set:';

export function isSetTag(t: string): boolean {
  return t.startsWith(SET_TAG_PREFIX);
}

/** Tags safe to show in chips/filters (set-membership tags are plumbing, not labels). */
export function visibleTags(tags?: string[]): string[] {
  return (tags || []).filter((t) => !isSetTag(t));
}

/** The variant-set id encoded in a doc/summary's tags, or null. */
export function setIdOf(tags?: string[]): string | null {
  const t = (tags || []).find(isSetTag);
  return t ? t.slice(SET_TAG_PREFIX.length) : null;
}

export function variantSetId(): string {
  return `vset_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Stamp a doc as a member of `setId` (idempotent: replaces any previous set tag). */
export function stampVariant(doc: VariantDoc, setId: string, variantName?: string): VariantDoc {
  const tags = visibleTags(doc.tags).concat(`${SET_TAG_PREFIX}${setId}`);
  return { ...doc, tags, variantSet: setId, ...(variantName ? { variantName } : {}) };
}

/** n deep copies of `doc` with fresh ids, all sharing one new set id. The returned `source`
 *  is the input doc stamped into the set as 'A'; copies are 'B', 'C', … Save all of them. */
export function makeVariants(doc: VariantDoc, n: number): { source: VariantDoc; variants: VariantDoc[]; setId: string } {
  const setId = doc.variantSet || setIdOf(doc.tags) || variantSetId();
  const source = stampVariant(doc, setId, doc.variantName || 'A');
  // continue lettering after existing members when the doc is already in a set
  const start = Math.max(1, LETTERS.indexOf((source.variantName || 'A').charAt(0)) + 1);
  const baseName = doc.name.replace(/\s+·\s+[A-Z]$/, '');
  const variants: VariantDoc[] = [];
  for (let i = 0; i < n; i++) {
    const letter = LETTERS[Math.min(start + i, LETTERS.length - 1)];
    const copy = JSON.parse(JSON.stringify(doc)) as VariantDoc;
    copy.id = designId();
    copy.createdAt = Date.now();
    copy.updatedAt = Date.now();
    copy.name = `${baseName} · ${letter}`;
    variants.push(stampVariant(copy, setId, letter));
  }
  return { source, variants, setId };
}

// ── node matching ────────────────────────────────────────────────────────────────────────────────

interface LeafRef { leaf: Layer; path: string }

function collectLeaves(nodes: SceneNode[], prefix = ''): LeafRef[] {
  const out: LeafRef[] = [];
  nodes.forEach((n, i) => {
    const path = prefix ? `${prefix}/${i}` : String(i);
    if (isGroup(n)) out.push(...collectLeaves(n.children, path));
    else if (isLeafLayer(n)) out.push({ leaf: n, path });
    // ComponentLayer: not a style/text leaf — variant swaps don't apply to native components.
  });
  return out;
}

/** Match source leaves to target leaves. Exported for tests. Returns [sourceLeaf, targetLeaf]
 *  pairs; each target leaf is claimed at most once and types must agree. */
export function matchNodes(source: DesignDoc, target: DesignDoc): [Layer, Layer][] {
  const src = collectLeaves(source.layers);
  const tgt = collectLeaves(target.layers);
  const used = new Set<Layer>();

  const bucket = (refs: LeafRef[], key: (r: LeafRef) => string | null) => {
    const m = new Map<string, LeafRef[]>();
    for (const r of refs) {
      const k = key(r);
      if (k == null) continue;
      const list = m.get(k) || [];
      list.push(r);
      m.set(k, list);
    }
    return m;
  };
  const byElement = bucket(tgt, (r) => r.leaf.element?.id ?? null);
  const byRole = bucket(tgt, (r) => r.leaf.role ?? null);
  const byName = bucket(tgt, (r) => r.leaf.name ?? null);
  const byPath = new Map(tgt.map((r) => [r.path, r] as const));

  // per-key ordinal counters on the SOURCE side (the nth source headline → the nth target one)
  const ord = new Map<string, number>();
  const nth = (key: string) => {
    const i = ord.get(key) || 0;
    ord.set(key, i + 1);
    return i;
  };

  const pairs: [Layer, Layer][] = [];
  for (const s of src) {
    const candidates: (LeafRef | undefined)[] = [
      s.leaf.element?.id ? byElement.get(s.leaf.element.id)?.[nth(`e:${s.leaf.element.id}`)] : undefined,
      s.leaf.role ? byRole.get(s.leaf.role)?.[nth(`r:${s.leaf.role}`)] : undefined,
      s.leaf.name ? byName.get(s.leaf.name)?.[nth(`n:${s.leaf.name}`)] : undefined,
      byPath.get(s.path),
    ];
    const hit = candidates.find((c) => c && !used.has(c.leaf) && c.leaf.type === s.leaf.type);
    if (hit) {
      used.add(hit.leaf);
      pairs.push([s.leaf, hit.leaf]);
    }
  }
  return pairs;
}

// ── field-group push ─────────────────────────────────────────────────────────────────────────────

export interface PushFields { layout?: boolean; styles?: boolean; text?: boolean; images?: boolean }

function scaleBoxBetween(b: LayerBox, from: { w: number; h: number }, to: { w: number; h: number }): LayerBox {
  const sx = to.w / from.w;
  const sy = to.h / from.h;
  return { x: Math.round(b.x * sx), y: Math.round(b.y * sy), w: Math.round(b.w * sx), h: Math.round(b.h * sy) };
}

/** Copy the chosen field groups from `source` onto a deep copy of `target`. Conservative:
 *  only matched leaves change; unmatched target nodes (and node count/order) stay as-is. */
export function pushToVariants(
  source: DesignDoc,
  target: VariantDoc,
  fields: PushFields,
): { doc: VariantDoc; matched: number; total: number } {
  const doc = JSON.parse(JSON.stringify(target)) as VariantDoc;
  const pairs = matchNodes(source, doc);
  const sx = doc.canvas.w / source.canvas.w;
  const differs = source.canvas.w !== doc.canvas.w || source.canvas.h !== doc.canvas.h;

  for (const [s, t] of pairs) {
    if (fields.layout && t.role !== 'base') {
      t.box = differs ? scaleBoxBetween(s.box, source.canvas, doc.canvas) : { ...s.box };
      if (s.rotation !== undefined) t.rotation = s.rotation;
      else delete t.rotation;
    }
    if (fields.styles) {
      // style carries no text content (text lives on leaf.text) — copy whole, rescale metrics
      const style = s.style ? JSON.parse(JSON.stringify(s.style)) : undefined;
      t.style = differs ? scaleStyle(style, sx) : style;
    }
    if (fields.text && (s.type === 'text' || s.type === 'badge' || s.type === 'button')) {
      if (s.text !== undefined) t.text = s.text;
      // text-typed element params (string values) — keeps parametric instances re-buildable
      if (s.element && t.element && s.element.id === t.element.id) {
        for (const [k, v] of Object.entries(s.element.params)) {
          if (typeof v === 'string') t.element.params[k] = v;
        }
      }
    }
    if (fields.images && s.type === 'image' && t.role !== 'base') {
      if (s.src !== undefined) t.src = s.src;
      if (s.fit !== undefined) t.fit = s.fit;
    }
  }
  doc.updatedAt = Date.now();
  return { doc, matched: pairs.length, total: collectLeaves(doc.layers).length };
}
