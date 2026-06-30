// Inline-SVG icon set. Stroke icons, currentColor, thin 1.5–1.6 stroke, no fill.
// One source of truth for the whole app — NO icon font / CDN. Add a name → add a path here.
// 24×24 viewBox, rounded line caps/joins, optically tuned to read at 12–16 px.

interface IconProps {
  name: string;
  size?: number;
  className?: string;
  /** Override default 1.6 — use for large display icons only */
  strokeWidth?: number;
}

// Each entry returns the inner SVG markup for a 24×24 viewBox.
// fill:none + stroke:currentColor are applied on the <svg>, so children stay terse.
const paths: Record<string, JSX.Element> = {
  // NEUEGEN monogram — a single continuous-stroke N, tuned to read at 12–16 px.
  // Drawn bottom-left → top-left → diagonal to bottom-right → top-right (one path).
  brand: <path d="M7.5 19V5l9 14V5" />,
  // Refined two-star sparkle for Generate / AI moments. Clean 4-point outlines,
  // pinched just enough to stay crisp (not fuzzy) at 14–15 px.
  sparkles: (
    <>
      <path d="M11 6.5L12.1 9.4 15 10.5 12.1 11.6 11 14.5 9.9 11.6 7 10.5 9.9 9.4z" />
      <path d="M17.5 14L18.2 15.8 20 16.5 18.2 17.2 17.5 19 16.8 17.2 15 16.5 16.8 15.8z" />
    </>
  ),
  'chevron-down': <path d="M6 9l6 6 6-6" />,
  'chevron-right': <path d="M9 6l6 6-6 6" />,
  // Two side-by-side panels — distinct from table (grid lines) and layout-grid (2×2).
  columns: (
    <>
      <rect x="4" y="4" width="7" height="16" rx="1.5" />
      <rect x="13" y="4" width="7" height="16" rx="1.5" />
    </>
  ),
  // Bordered grid with header + body rows — distinct from columns (no outer frame).
  table: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M4 10h16M4 15h16M10 4v16" />
    </>
  ),
  activity: <path d="M3 12h4l3 7 4-14 3 7h4" />,
  // Lucide-style cog — smooth petal teeth + center bore. Reads clean at 14–15 px.
  settings: (
    <>
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
  plus: <path d="M12 5v14M5 12h14" />,
  refresh: (
    <>
      <path d="M20 11a8 8 0 0 0-14-4.5L4 9" />
      <path d="M4 4v5h5" />
      <path d="M4 13a8 8 0 0 0 14 4.5L20 15" />
      <path d="M20 20v-5h-5" />
    </>
  ),
  archive: (
    <>
      <rect x="4" y="4" width="16" height="4" rx="1.5" />
      <path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8" />
      <path d="M10 12h4" />
    </>
  ),
  restore: (
    <>
      <rect x="4" y="4" width="16" height="4" rx="1.5" />
      <path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8" />
      <path d="M12 17v-5M9.5 14.5L12 12l2.5 2.5" />
    </>
  ),
  download: (
    <>
      <path d="M12 3v12" />
      <path d="M8 11l4 4 4-4" />
      <path d="M5 19h14" />
    </>
  ),
  expand: (
    <>
      <path d="M9 4H4v5" />
      <path d="M15 4h5v5" />
      <path d="M20 15v5h-5" />
      <path d="M4 15v5h5" />
    </>
  ),
  x: <path d="M6 6l12 12M18 6L6 18" />,
  // Smooth single-arc spinner — pairs with the rotating wrapper in Spinner.tsx.
  loader: <path d="M21 12a9 9 0 1 1-6.219-8.56" />,
  alert: (
    <>
      <path d="M12 4l9 16H3l9-16z" />
      <path d="M12 10v4" />
      <path d="M12 17h.01" />
    </>
  ),
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v4.5l3 2" />
    </>
  ),
  photo: (
    <>
      <rect x="4" y="5" width="16" height="14" rx="2" />
      <circle cx="9" cy="10" r="1.5" />
      <path d="M5 17l4.5-4.5 3 3 3-3L19 16" />
    </>
  ),
  filter: <path d="M4 5h16l-6 7v6l-4 2v-8L4 5z" />,
  sliders: (
    <>
      <path d="M4 8h10M18 8h2" />
      <circle cx="16" cy="8" r="2" />
      <path d="M4 16h2M10 16h10" />
      <circle cx="8" cy="16" r="2" />
    </>
  ),
  dot: <circle cx="12" cy="12" r="3" />,
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </>
  ),
  moon: <path d="M20 13.5A8 8 0 1 1 10.5 4a6.5 6.5 0 0 0 9.5 9.5z" />,
  search: (
    <>
      <circle cx="11" cy="11" r="6" />
      <path d="M20 20l-3.5-3.5" />
    </>
  ),
  // Three stacked pill rows — reads as a list layout, distinct from layout-grid.
  'layout-list': (
    <>
      <rect x="4" y="5" width="16" height="3" rx="1.5" />
      <rect x="4" y="10.5" width="16" height="3" rx="1.5" />
      <rect x="4" y="16" width="16" height="3" rx="1.5" />
    </>
  ),
  // Four equal rounded squares — a clean 2×2 grid, distinct from columns/table.
  'layout-grid': (
    <>
      <rect x="3.5" y="3.5" width="7.5" height="7.5" rx="1.5" />
      <rect x="13" y="3.5" width="7.5" height="7.5" rx="1.5" />
      <rect x="3.5" y="13" width="7.5" height="7.5" rx="1.5" />
      <rect x="13" y="13" width="7.5" height="7.5" rx="1.5" />
    </>
  ),
  // ⌘ command glyph for ⌘+K hints (looped square, single path).
  command: (
    <path d="M18 3a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3 3 3 0 0 0 3-3 3 3 0 0 0-3-3H6a3 3 0 0 0-3 3 3 3 0 0 0 3 3 3 3 0 0 0 3-3V6a3 3 0 0 0-3-3 3 3 0 0 0-3 3 3 3 0 0 0 3 3h12a3 3 0 0 0 3-3 3 3 0 0 0-3-3z" />
  ),
};

export function Icon({ name, size = 16, className, strokeWidth }: IconProps) {
  const glyph = paths[name] ?? paths.dot; // unknown name → neutral dot
  const sw = strokeWidth ?? (name === 'brand' ? 1.5 : 1.6);
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={sw}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {glyph}
    </svg>
  );
}
