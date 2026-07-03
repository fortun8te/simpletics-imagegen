// Local-font access utility (Chrome's Local Font Access API).
//
// `listLocalFonts()` returns the user's installed font FAMILIES (deduped, sorted) via
// `window.queryLocalFonts()` — Chrome-only, permission-gated. Everywhere else (Safari/Firefox,
// permission denied, non-secure context) it resolves to [] instead of throwing, so callers can
// always concatenate it with their built-in font list.
//
// Results are cached in-module for the session and mirrored to localStorage for 1 day, so the
// permission prompt / enumeration cost is paid at most once per day.
//
// `ensureFontLoaded(family)` is a deliberate no-op today: locally installed (system) fonts render
// natively in CSS by family name, no FontFace loading needed. It exists so the Editor can call one
// consistent hook per family now, and webfont loading can slot in here later without call-site
// changes.

interface LocalFontData {
  family: string;
  fullName?: string;
  postscriptName?: string;
  style?: string;
}

declare global {
  interface Window {
    queryLocalFonts?: () => Promise<LocalFontData[]>;
  }
}

const LS_KEY = 'neuegen.localFonts.v1';
const TTL_MS = 24 * 60 * 60 * 1000; // 1 day

let memCache: string[] | null = null;

/** Installed local font families — deduped by family, locale-sorted. [] when unsupported/denied. */
export async function listLocalFonts(): Promise<string[]> {
  if (memCache) return memCache;

  // 1-day localStorage cache (avoids re-prompting / re-enumerating every load).
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { at?: number; families?: unknown };
      if (
        typeof parsed.at === 'number' &&
        Date.now() - parsed.at < TTL_MS &&
        Array.isArray(parsed.families) &&
        parsed.families.every((f) => typeof f === 'string')
      ) {
        memCache = parsed.families as string[];
        return memCache;
      }
    }
  } catch { /* corrupt cache / storage unavailable — fall through to a live query */ }

  if (typeof window === 'undefined' || typeof window.queryLocalFonts !== 'function') return [];

  try {
    const fonts = await window.queryLocalFonts();
    const families = [...new Set(fonts.map((f) => f.family).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b));
    memCache = families;
    try { localStorage.setItem(LS_KEY, JSON.stringify({ at: Date.now(), families })); } catch { /* ignore */ }
    return families;
  } catch {
    // Permission denied, user dismissed the prompt, or the API threw — degrade to "no extras".
    return [];
  }
}

/** No-op placeholder: system fonts render natively by family name. Future webfont hook. */
export async function ensureFontLoaded(_family: string): Promise<void> {
  // intentionally empty
}
