// Inline-SVG icon set. Stroke icons, currentColor, 1.6 stroke width, no fill.
// One source of truth for the whole app — NO icon font / CDN. Add a name → add a path here.

interface IconProps {
  name: string;
  size?: number;
  className?: string;
}

// Each entry returns the inner SVG markup for a 24x24 viewBox.
// fill:none + stroke:currentColor are applied on the <svg>, so children stay terse.
const paths: Record<string, JSX.Element> = {
  sparkles: (
    <>
      <path d="M12 4l1.6 4.4L18 10l-4.4 1.6L12 16l-1.6-4.4L6 10l4.4-1.6L12 4z" />
      <path d="M18 15l.7 1.9 1.9.7-1.9.7-.7 1.9-.7-1.9-1.9-.7 1.9-.7.7-1.9z" />
    </>
  ),
  'chevron-down': <path d="M6 9l6 6 6-6" />,
  'chevron-right': <path d="M9 6l6 6-6 6" />,
  'layout-grid': (
    <>
      <rect x="4" y="4" width="7" height="7" rx="1.5" />
      <rect x="13" y="4" width="7" height="7" rx="1.5" />
      <rect x="4" y="13" width="7" height="7" rx="1.5" />
      <rect x="13" y="13" width="7" height="7" rx="1.5" />
    </>
  ),
  columns: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M10 4v16M16 4v16" />
    </>
  ),
  table: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M4 10h16M4 15h16M10 4v16" />
    </>
  ),
  activity: <path d="M3 12h4l3 7 4-14 3 7h4" />,
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2.5l1.2 2.3 2.5-.4 1 2.4 2.3 1.2-.4 2.5 1.6 2-.4 2.5-2.3 1.2-1 2.4-2.5-.4L12 21.5l-1.2-2.3-2.5.4-1-2.4-2.3-1.2.4-2.5L4 12l.4-2.5L6.7 8.3l1-2.4 2.5.4L12 2.5z" />
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
      <rect x="4" y="4" width="16" height="4" rx="1" />
      <path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8" />
      <path d="M10 12h4" />
    </>
  ),
  restore: (
    <>
      <rect x="4" y="4" width="16" height="4" rx="1" />
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
  loader: (
    <>
      <path d="M12 3v4" opacity="1" />
      <path d="M12 17v4" opacity="0.4" />
      <path d="M5.6 5.6l2.8 2.8" opacity="0.85" />
      <path d="M15.6 15.6l2.8 2.8" opacity="0.55" />
      <path d="M3 12h4" opacity="0.7" />
      <path d="M17 12h4" opacity="0.45" />
      <path d="M5.6 18.4l2.8-2.8" opacity="0.6" />
      <path d="M15.6 8.4l2.8-2.8" opacity="0.5" />
    </>
  ),
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
};

export function Icon({ name, size = 16, className }: IconProps) {
  const glyph = paths[name] ?? paths.dot; // unknown name → neutral dot
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {glyph}
    </svg>
  );
}
