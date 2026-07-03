// elements.ts — thin typed re-export of the SHARED parametric element library, which lives in
// lib/elements.mjs (plain JS, zero-dep) so the SAME registry runs in Node (design agent /
// server) and in the browser (Vite resolves the .mjs; types come from lib/elements.d.mts).
//
// Compatibility: the names the Editor already uses keep working — ELEMENTS (now full
// ElementDefs, a superset of the old ElementMeta {id,name,hint,category}), ELEMENT_CATEGORIES,
// and buildElement(id, doc) (params + brand kit are optional trailing args).

export {
  ELEMENTS,
  ELEMENT_CATEGORIES,
  buildElement,
  coerceParams,
  elementCatalogLine,
  applyElementTextEdit,
  fitElementText,
  findElementInstance,
} from '../../../lib/elements.mjs';

export type {
  ElementDef,
  ParamSpec,
  ParamValue,
  SeriesEntry,
  BrandKit,
} from '../../../lib/elements.mjs';

/** Legacy aliases (pre-parametric library). */
export type ElementCategory = string;
export interface ElementMeta { id: string; name: string; hint: string; category: string }
