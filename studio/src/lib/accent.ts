// Accent token helpers — derive --accent/--accent-2/--on-accent/--accent-ink/--accent-soft
// from a base RGB so every accent preset (including white + dark custom) stays legible.
//
// Two foreground roles:
//   --on-accent / --accent-contrast → text ON a solid accent fill (buttons, avatar)
//   --accent-ink                    → accent-colored text/icons ON dark (or light) surfaces & tints

import type { AccentRGB } from '../store';

export type AccentPreset = { accent: string; accent2: string };

export const hexToRgb = (hex: string): AccentRGB | null => {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
};

export const rgbToHex = ({ r, g, b }: AccentRGB): string =>
  `#${[r, g, b].map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`;

export const lighten = ({ r, g, b }: AccentRGB, amt: number): AccentRGB => ({
  r: r + (255 - r) * amt,
  g: g + (255 - g) * amt,
  b: b + (255 - b) * amt,
});

export const darken = ({ r, g, b }: AccentRGB, amt: number): AccentRGB => ({
  r: r * (1 - amt),
  g: g * (1 - amt),
  b: b * (1 - amt),
});

/** WCAG relative luminance on sRGB. */
export const relLuminance = ({ r, g, b }: AccentRGB): number => {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};

/** Foreground for solid accent fills — only flip to dark ink on genuinely light accents. */
export const onAccentFor = (rgb: AccentRGB): string => {
  const L = relLuminance(rgb);
  return L > 0.62 ? 'oklch(0.18 0 0)' : 'oklch(0.99 0 0)';
};

/**
 * Foreground for accent-tinted chips, links, labels on the app canvas (not solid fills).
 * Dark theme → always a light, chromatic-readable tone; light theme → a deeper accent tone.
 */
export const accentInkFor = (rgb: AccentRGB, dark: boolean): string => {
  const L = relLuminance(rgb);
  if (dark) {
    if (L > 0.72) return rgbToHex(lighten(rgb, 0.08));
    if (L > 0.45) return rgbToHex(lighten(rgb, 0.28));
    return rgbToHex(lighten(rgb, 0.58));
  }
  if (L < 0.35) return rgbToHex(lighten(rgb, 0.12));
  return rgbToHex(darken(rgb, 0.38));
};

export const accentSoftFor = (hex: string, dark: boolean): string =>
  dark
    ? `color-mix(in srgb, ${hex} 14%, var(--surface-2))`
    : `color-mix(in srgb, ${hex} 12%, var(--surface-2))`;

const isDarkTheme = (): boolean => {
  try {
    return document.documentElement.dataset.theme !== 'light';
  } catch {
    return true;
  }
};

/** Push accent tokens to :root. Called on boot, accent pick, and theme change. */
export const applyAccentColor = (
  rgb: AccentRGB,
  presetAccent?: AccentPreset,
) => {
  try {
    const root = document.documentElement;
    const dark = isDarkTheme();
    const hex = rgbToHex(rgb);

    if (presetAccent) {
      root.style.setProperty('--accent', presetAccent.accent);
      root.style.setProperty('--accent-2', presetAccent.accent2);
    } else {
      root.style.setProperty('--accent', hex);
      root.style.setProperty('--accent-2', rgbToHex(lighten(rgb, 0.18)));
    }

    const onAccent = onAccentFor(rgb);
    root.style.setProperty('--on-accent', onAccent);
    root.style.setProperty('--accent-contrast', onAccent);
    root.style.setProperty('--accent-ink', accentInkFor(rgb, dark));
    root.style.setProperty('--accent-soft', accentSoftFor(hex, dark));
  } catch { /* SSR/no-DOM */ }
};

/** Re-apply ink/soft only (theme flipped, accent RGB unchanged). */
export const refreshAccentDerivatives = (rgb: AccentRGB) => {
  try {
    const root = document.documentElement;
    const dark = isDarkTheme();
    const hex = rgbToHex(rgb);
    root.style.setProperty('--accent-ink', accentInkFor(rgb, dark));
    root.style.setProperty('--accent-soft', accentSoftFor(hex, dark));
  } catch { /* SSR/no-DOM */ }
};
