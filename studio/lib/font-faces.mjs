// lib/font-faces.mjs — server-side @font-face CSS generator for the bundled woff2 files.
//
// WHY: FONT_SUGGEST.twitter used to name the OS-installed "Chirp" font directly, which broke
// server-side export: qlmanage (and any future headless-Chrome render path) runs sandboxed and
// can't see a user's ~/Library/Fonts, so it silently rendered the shaped-but-blank "tofu" glyphs.
// The fix is to EMBED real, license-clean fonts (Inter/Fraunces/Poppins — all SIL OFL) as base64
// data URLs directly in the generated HTML/CSS, so they're available with zero network dependency
// and zero reliance on the host machine having anything installed.
//
// Fraunces and Poppins were added alongside Inter because index.html's Google Fonts CDN link was
// (until this pass) the ONLY source for Fraunces — meaning any offline/server-side export path
// (this module) had zero access to it, so editorial-serif ad styles that use Fraunces as a display
// face would silently fall back to the base sans stack server-side even though it looked correct
// in the live browser preview (which DOES have network access to the CDN). Same reasoning as the
// original Inter fix: embed it for real instead of depending on a network fetch.
//
// Poppins is bundled as a new `roundedDisplay` option (see FONT_SUGGEST/FONT_PAIR in elements.mjs)
// for punchy bold-rounded headline ad styles (e.g. telecom/offer callouts) — it was not previously
// embedded or referenced anywhere, so this is net-new capability, not a bugfix.
//
// This module reads studio/src/assets/fonts/*.woff2 once, base64-encodes them, and caches
// the resulting CSS string in memory — callers (designstore.mjs renderDesignHtml, and any future
// headless-Chrome export path) just call fontFaceCss() and splice it into a <style> block.

import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const STUDIO = join(dirname(fileURLToPath(import.meta.url)), '..');
const FONTS_DIR = join(STUDIO, 'src', 'assets', 'fonts');

/** Bundled Inter static-weight woff2 files (all currently the same variable-font binary — the
 *  exact file Google Fonts itself serves per weight — but named per weight so the @font-face
 *  descriptors below read clearly and stay stable if we ever swap in true per-weight statics). */
const WEIGHTS = [
  { family: 'Inter', weight: 400, file: 'Inter-Regular.woff2' },
  { family: 'Inter', weight: 500, file: 'Inter-Medium.woff2' },
  { family: 'Inter', weight: 600, file: 'Inter-SemiBold.woff2' },
  { family: 'Inter', weight: 700, file: 'Inter-Bold.woff2' },
  { family: 'Inter', weight: 800, file: 'Inter-ExtraBold.woff2' },
  // Editorial serif display face — for before-after/comparison/editorial ad archetypes. Real
  // per-weight static woff2s pulled from Google Fonts' css2 endpoint (SIL OFL licensed).
  { family: 'Fraunces', weight: 600, file: 'Fraunces-SemiBold.woff2' },
  { family: 'Fraunces', weight: 700, file: 'Fraunces-Bold.woff2' },
  // Bold rounded display sans — for punchy telecom/offer-style headline ads. Net-new token
  // (FONT_SUGGEST.roundedDisplay / FONT_PAIR.roundedDisplay in elements.mjs); not yet wired into
  // any template. SIL OFL licensed.
  { family: 'Poppins', weight: 700, file: 'Poppins-Bold.woff2' },
  { family: 'Poppins', weight: 800, file: 'Poppins-ExtraBold.woff2' },
];

/** Module-level cache: computed once on first call, reused for the process lifetime. */
let cachedCss = null;

/** Reads + base64-encodes every bundled weight and builds the @font-face rule block.
 *  Missing files are skipped defensively (never throws) so a partial/absent bundle degrades to
 *  "no embedded font" for that family/weight rather than crashing the render path. */
function buildFontFaceCss() {
  const rules = [];
  for (const { family, weight, file } of WEIGHTS) {
    const path = join(FONTS_DIR, file);
    if (!existsSync(path)) continue;
    let b64;
    try {
      b64 = readFileSync(path).toString('base64');
    } catch {
      continue;
    }
    rules.push(
      `@font-face{font-family:'${family}';font-style:normal;font-weight:${weight};` +
      `font-display:swap;src:url(data:font/woff2;base64,${b64}) format('woff2');}`,
    );
  }
  return rules.join('');
}

/** Returns the cached @font-face CSS string (all bundled Inter/Fraunces/Poppins weights,
 *  base64-embedded woff2). Computed once per process; safe to call as often as needed
 *  (per-request, per-render, etc). */
export function fontFaceCss() {
  if (cachedCss == null) cachedCss = buildFontFaceCss();
  return cachedCss;
}

/** `<style>...</style>`-ready markup, for callers that just want to splice a full tag into
 *  a document <head> rather than compose the CSS themselves. */
export function fontFaceStyleTag() {
  const css = fontFaceCss();
  return css ? `<style>${css}</style>` : '';
}
