// src/lib/fontFaces.ts — client-side @font-face CSS for the bundled woff2 files.
//
// WHY: FONT_SUGGEST.twitter used to name the OS-installed "Chirp" font directly, which broke
// sandboxed server-side rendering (qlmanage can't see ~/Library/Fonts, so it silently drew tofu).
// The fix bundles Inter (SIL OFL, the documented near-identical substitute for X's proprietary
// Chirp) as real woff2 files under src/assets/fonts/ and embeds them via @font-face everywhere —
// including client-side SVG export (designSvg.ts), so a standalone .svg opened outside the app
// still renders in the real font instead of falling through to a name-only system-font guess.
//
// Fraunces (editorial serif display, used by before-after/comparison archetypes) and Poppins (new
// `roundedDisplay` bold-rounded token for punchy offer/telecom-style headlines) are bundled the
// same way: index.html's Google Fonts CDN link was the ONLY source for Fraunces before this pass,
// so a standalone SVG export (no network) would silently drop to the base sans stack even though
// it looked correct in the live browser preview. Both are SIL OFL licensed, same as Inter.
//
// Each woff2 is imported via Vite's `?url` (works in dev AND build, no bundler-specific inline
// query needed), then fetched + base64-encoded ONCE and cached in a module-level promise — repeat
// callers (repeat exports in one session) reuse the same resolved string instead of re-fetching.

import interRegularUrl from '../assets/fonts/Inter-Regular.woff2?url';
import interMediumUrl from '../assets/fonts/Inter-Medium.woff2?url';
import interSemiBoldUrl from '../assets/fonts/Inter-SemiBold.woff2?url';
import interBoldUrl from '../assets/fonts/Inter-Bold.woff2?url';
import interExtraBoldUrl from '../assets/fonts/Inter-ExtraBold.woff2?url';
import frauncesSemiBoldUrl from '../assets/fonts/Fraunces-SemiBold.woff2?url';
import frauncesBoldUrl from '../assets/fonts/Fraunces-Bold.woff2?url';
import poppinsBoldUrl from '../assets/fonts/Poppins-Bold.woff2?url';
import poppinsExtraBoldUrl from '../assets/fonts/Poppins-ExtraBold.woff2?url';

const WEIGHTS: Array<{ family: string; weight: number; url: string }> = [
  { family: 'Inter', weight: 400, url: interRegularUrl },
  { family: 'Inter', weight: 500, url: interMediumUrl },
  { family: 'Inter', weight: 600, url: interSemiBoldUrl },
  { family: 'Inter', weight: 700, url: interBoldUrl },
  { family: 'Inter', weight: 800, url: interExtraBoldUrl },
  { family: 'Fraunces', weight: 600, url: frauncesSemiBoldUrl },
  { family: 'Fraunces', weight: 700, url: frauncesBoldUrl },
  { family: 'Poppins', weight: 700, url: poppinsBoldUrl },
  { family: 'Poppins', weight: 800, url: poppinsExtraBoldUrl },
];

async function toBase64(url: string): Promise<string | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    let binary = '';
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  } catch {
    return null; // missing/blocked fetch — degrades to "no embedded Inter" for this weight
  }
}

/** Module-level cache: computed once per page session, reused across every designToSvg call. */
let cachedCss: Promise<string> | null = null;

async function buildFontFaceCss(): Promise<string> {
  const rules = await Promise.all(
    WEIGHTS.map(async ({ family, weight, url }) => {
      const b64 = await toBase64(url);
      if (!b64) return '';
      return (
        `@font-face{font-family:'${family}';font-style:normal;font-weight:${weight};` +
        `font-display:swap;src:url(data:font/woff2;base64,${b64}) format('woff2');}`
      );
    }),
  );
  return rules.join('');
}

/** Returns the cached @font-face CSS string (all bundled Inter/Fraunces/Poppins weights,
 *  base64-embedded woff2). Safe to await as often as needed — the underlying fetch+encode work
 *  happens exactly once. */
export function fontFaceCss(): Promise<string> {
  if (!cachedCss) cachedCss = buildFontFaceCss();
  return cachedCss;
}
