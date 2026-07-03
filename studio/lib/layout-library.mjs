// lib/layout-library.mjs — template retrieval for the design agent (weak-model superpower).
//
// Research (LayoutGPT arXiv:2305.15393, PosterO arXiv:2505.07843): retrieval-augmented ICL —
// retrieve similar layouts as exemplars and let the model ADAPT a skeleton instead of
// generating from scratch — is the highest-leverage technique for small models. This module
// keeps a zero-dep JSON library of layout skeletons in .state/layout-library/ and retrieves
// the top-N by cheap lexical overlap on tags + brief keywords + aspect match.
//
// A skeleton is a compact layout-as-code serialization (CSS-flavored, LayoutNUWA
// arXiv:2309.09506): one line per top-level node, coords as % of canvas so exemplars
// transfer across sizes.

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '.state', 'layout-library');

const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'for', 'with', 'of', 'to', 'in', 'on', 'is', 'it', 'this', 'that', 'your', 'my']);

function ensure() { if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true }); }

const tokens = (s) => String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2 && !STOP.has(t));

/** square | portrait | story from w/h. */
export function aspectTag(w, h) {
  const ratio = (h || 1) / (w || 1);
  if (ratio > 1.6) return 'story';
  if (ratio > 1.15) return 'portrait';
  return 'square';
}

/** Compact percentage-coordinate skeleton of a doc: one line per top-level node. */
export function docSkeleton(doc) {
  const { w: cw, h: ch } = doc.canvas || { w: 1080, h: 1080 };
  const pct = (v, base) => Math.round((v / base) * 100);
  const lines = [];
  for (const n of doc.layers || []) {
    if (!n || n.hidden || !n.box) continue;
    const tag = n.element ? `el:${n.element.id}` : (n.role || n.type);
    const txt = n.text ? ` "${String(n.text).replace(/\s+/g, ' ').slice(0, 30)}"` : '';
    lines.push(`${tag} left=${pct(n.box.x, cw)}% top=${pct(n.box.y, ch)}% width=${pct(n.box.w, cw)}% height=${pct(n.box.h, ch)}%${txt}`);
  }
  return lines.join('\n');
}

/**
 * Save one layout to the library. entry: { id, tags:[…], aspect, skeleton, score?, source? }.
 * Same id overwrites (curation-friendly).
 */
export function indexLayout(entry) {
  ensure();
  const id = String(entry.id || '').replace(/[^\w-]+/g, '-');
  if (!id) throw new Error('layout id required');
  const rec = {
    id,
    tags: (entry.tags || []).map((t) => String(t).toLowerCase()).slice(0, 24),
    aspect: entry.aspect || 'square',
    skeleton: String(entry.skeleton || '').slice(0, 2000),
    score: Number.isFinite(entry.score) ? entry.score : null,
    source: entry.source || null,
    at: Date.now(),
  };
  writeFileSync(join(DIR, `${id}.json`), JSON.stringify(rec, null, 2));
  return rec;
}

export function listLayouts() {
  ensure();
  const out = [];
  for (const f of readdirSync(DIR)) {
    if (!f.endsWith('.json')) continue;
    try { out.push(JSON.parse(readFileSync(join(DIR, f), 'utf8'))); } catch { /* skip corrupt */ }
  }
  return out;
}

/**
 * Retrieve the top-N layouts for a brief: lexical tag/keyword overlap + aspect bonus +
 * library-score tiebreak. Returns [] on a cold library — callers fall back gracefully.
 */
export function retrieveLayouts({ brief = '', aspect = 'square', n = 2 } = {}) {
  const kw = new Set(tokens(brief));
  const scored = listLayouts().map((rec) => {
    let s = 0;
    for (const t of rec.tags || []) if (kw.has(t)) s += 2;
    for (const t of tokens(rec.skeleton)) if (kw.has(t)) s += 0.25;
    if (rec.aspect === aspect) s += 3;
    if (Number.isFinite(rec.score)) s += rec.score / 100; // gentle quality tiebreak
    return { rec, s };
  }).filter((x) => x.s > 0);
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, n).map((x) => x.rec);
}

/** Exemplar block for prompts: "EXEMPLAR LAYOUTS (adapt, don't copy):\n…". '' when cold. */
export function exemplarBlock({ brief = '', aspect = 'square', n = 2 } = {}) {
  const hits = retrieveLayouts({ brief, aspect, n });
  if (!hits.length) return '';
  const blocks = hits.map((r, i) => `— exemplar ${i + 1} (${r.aspect}${r.tags?.length ? `, ${r.tags.slice(0, 5).join(' ')}` : ''}):\n${r.skeleton}`);
  return `EXEMPLAR LAYOUTS (proven structures — adapt the closest one to this brief, don't copy text):\n${blocks.join('\n')}`;
}
