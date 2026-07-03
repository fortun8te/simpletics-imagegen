// elements.d.mts — TypeScript surface for lib/elements.mjs (the shared parametric element
// library). Keeps the plain-JS module fully typed for the Vite/TS frontend; re-exported by
// src/components/design/elements.ts.

import type { DesignDoc, Layer, LayerBox, SceneNode } from '../src/lib/sceneGraph';

export interface SeriesEntry { label: string; color: string; points: number[] }

export type ParamValue = string | number | boolean | string[] | SeriesEntry[];

export interface ParamSpec {
  key: string;
  type: 'text' | 'color' | 'number' | 'boolean' | 'enum' | 'stringList' | 'series';
  default: ParamValue;
  label?: string;
  min?: number;
  max?: number;
  options?: string[];
  maxItems?: number;
  maxLen?: number;
  /** color params: default from the brand kit (round-robin over kit.colors) when available. */
  brandColor?: boolean;
}

export interface BrandKit { colors?: string[]; fonts?: string[]; notes?: string; prompt?: string }

export interface ElementDef {
  id: string;
  name: string;
  hint: string;
  category: string;
  params: ParamSpec[];
  /** CANVAS FRACTIONS (0..1) of the region the element occupies by default. */
  defaultBox: LayerBox;
  build(doc: DesignDoc, p: Record<string, ParamValue>): Layer[];
}

export declare const ELEMENTS: ElementDef[];
export declare const ELEMENT_CATEGORIES: string[];

export declare function coerceParams(
  def: ElementDef,
  raw?: Record<string, unknown>,
  kit?: BrandKit,
): Record<string, ParamValue>;

export declare function buildElement(
  id: string,
  doc: DesignDoc,
  rawParams?: Record<string, unknown>,
  kit?: BrandKit,
): SceneNode[];

export declare function elementCatalogLine(def: ElementDef): string;

export declare function layerId(prefix?: string): string;

/** v2 measurement-first exports */
export declare function intrinsicTextW(l: SceneNode): number;
export declare function fitElementText(layers: SceneNode[]): SceneNode[];
export declare function findElementInstance(doc: DesignDoc, id: string): { instance: SceneNode } | null;
export declare function applyElementTextEdit(
  doc: DesignDoc,
  layerId: string,
  text: string,
  kit?: BrandKit,
): string | null;
