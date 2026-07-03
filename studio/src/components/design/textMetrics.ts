// textMetrics.ts — the ONE word-wrap + block-height implementation shared by every renderer.
// Auto-height (Layer.autoH) works by re-measuring box.h with these functions on every edit and
// persisting the result, so raster/SVG/HTML/Figma render with zero measurement of their own and
// text can never clip.

import type { Layer, LayerStyle } from '../../lib/sceneGraph';

export interface Measurer { width(text: string): number }

export const FONT_STACK = "Geist, 'Helvetica Neue', Arial, sans-serif";

export function fontCss(s: LayerStyle | undefined): string {
  // PARITY with Stage.tsx: a layer's own fontFamily leads the stack — measuring everything
  // as Geist gave wrong boxes for every custom-font layer (handwritten, receipts, x-posts).
  // Quote ONLY when the family has whitespace and isn't already quoted — byte-identical to
  // raster.ts/designSvg.ts fontStackFor, so the measured font string == the drawn font string
  // (a mismatched quote style can select a different fallback and skew wrap widths).
  const fam = s?.fontFamily?.trim();
  const quoted = fam ? (/\s/.test(fam) && !/^['"]/.test(fam) ? `'${fam}'` : fam) : '';
  const stack = fam ? `${quoted}, ${FONT_STACK}` : FONT_STACK;
  return `${s?.fontWeight || 600} ${s?.fontSize || 40}px ${stack}`;
}

let sharedCtx: CanvasRenderingContext2D | null = null;

/** Browser measurer via a shared offscreen canvas — matches raster.ts exactly. */
export function canvasMeasurer(s: LayerStyle | undefined): Measurer {
  if (!sharedCtx) sharedCtx = document.createElement('canvas').getContext('2d')!;
  const ctx = sharedCtx;
  ctx.font = fontCss(s);
  if (s?.letterSpacing) (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${s.letterSpacing}px`;
  else (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = '0px';
  return { width: (t) => ctx.measureText(t).width };
}

/** Word-wrap `text` into lines fitting `maxW`. Honors explicit \n. A word that alone exceeds
 *  maxW stays on its own line (no mid-word breaking — parity with raster/SVG today). */
export function wrapLines(m: Measurer, text: string, maxW: number): string[] {
  const out: string[] = [];
  for (const para of String(text).split('\n')) {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) { out.push(''); continue; }
    let cur = '';
    for (const word of words) {
      const probe = cur ? `${cur} ${word}` : word;
      if (m.width(probe) <= maxW || !cur) cur = probe;
      else { out.push(cur); cur = word; }
    }
    if (cur) out.push(cur);
  }
  return out;
}

/** Pill horizontal padding. Fallback is 14px to MATCH what actually paints: Stage.tsx renders
 *  the pill inner span with `padding: (s.padding||14)*0.55  (s.padding||14)` and the server HTML
 *  (designstore.renderDesignHtml) uses the identical `st.padding||14`. The old `fontSize*0.55`
 *  fallback made wrap/measurement and the raster/SVG per-line rects ~0.6em wider than the DOM
 *  pill (wrapping earlier, wider selection boxes). padY stays 0.55×padX and lineHeight ×1.25,
 *  which Stage/HTML also apply, so all five renderers now agree. */
export function pillPadding(s: LayerStyle | undefined): number {
  return s?.padding || 14;
}

/** Effective metrics for a text-ish layer — the same numbers raster.ts draws with. */
export function textLayout(l: Layer, m: Measurer): { lines: string[]; lineH: number; padY: number; blockH: number } {
  const s = l.style || {};
  const pill = !!(s.pill && s.background);
  const size = s.fontSize || 40;
  const pillPadX = pillPadding(s);
  const pad = pill ? pillPadX : (s.padding || 0);
  const lineH = pill ? size * (s.lineHeight || 1.2) * 1.25 : size * (s.lineHeight || 1.2);
  const text = s.uppercase ? String(l.text || '').toUpperCase() : String(l.text || '');
  const lines = wrapLines(m, text, Math.max(8, l.box.w - pad * 2));
  const padY = pill ? pillPadX * 0.55 : (s.padding || 0);
  // Pills are INLINE spans: vertical padding PAINTS (box-decoration-break) but adds no layout
  // height — the ×1.25 lineHeight already holds the paint. Counting padY×2 made every pill
  // box ~0.6em too tall (visible gap under the pill in selection outlines). padY stays in the
  // return for raster/SVG per-line rect placement.
  const blockH = lines.length * lineH + (pill ? 0 : padY * 2);
  return { lines, lineH, padY, blockH };
}

/** The height an autoH layer's box should be for its current text/width/style. */
export function textBlockHeight(l: Layer, m: Measurer = canvasMeasurer(l.style)): number {
  return Math.max(l.style?.fontSize || 40, Math.ceil(textLayout(l, m).blockH));
}

const TEXTUAL = new Set(['text', 'badge', 'button']);

export function isTextual(l: Layer): boolean {
  return TEXTUAL.has(l.type);
}

/** Widest explicit line of a text layer, canvas-measured, incl. horizontal chrome. */
export function measuredTextW(l: Layer, m: Measurer = canvasMeasurer(l.style)): number {
  const s = l.style || {};
  const pill = !!(s.pill && s.background);
  const padX = pill ? pillPadding(s) : (s.padding || 0);
  const text = s.uppercase ? String(l.text || '').toUpperCase() : String(l.text || '');
  // letterSpacing is already applied on the measurer's canvas context — no extra addend
  const widest = Math.max(1, ...text.split('\n').map((t) => m.width(t)));
  return Math.ceil(widest + padX * 2);
}

/** Re-measure every autoH text leaf in place with the REAL canvas measurer (browser only).
 *  Heights always; widths too for element-built (sizeLocked) leaves — their build-time widths
 *  are server-side glyph ESTIMATES (~0.55em/char) that run wide of real font metrics, which
 *  left visible slop around every element's text. Width shrink re-anchors by style.align.
 *  Called from Editor.commit() and once at doc load. */
export function remeasureAutoHeights(leafList: Layer[]): void {
  for (const l of leafList) {
    if (!l.autoH || !isTextual(l)) continue;
    if ((l as Layer & { sizeLocked?: boolean }).sizeLocked && l.text) {
      const iw = Math.max(24, measuredTextW(l));
      if (iw < l.box.w) {
        const align = l.style?.align || 'left';
        if (align === 'center') l.box.x = Math.round(l.box.x + (l.box.w - iw) / 2);
        else if (align === 'right') l.box.x = l.box.x + l.box.w - iw;
        l.box.w = iw;
      }
    }
    l.box.h = textBlockHeight(l);
  }
}
