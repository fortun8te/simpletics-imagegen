// DiamondLoader — the loading-ui "diamond" spinner (8 pixels tracing a diamond, each fading in
// sequence). The animation lives in an INLINE <style> inside the SVG, so it runs regardless of
// CSS-module/build state — it can't silently fail to animate. Color comes from `currentColor`
// (accent by default). Class names are uniquely prefixed so the SVG <style> can't collide.
//
// Pixels sit on a 24x24 viewBox with a 1-unit gap between them and a slight corner radius —
// at real render size (~22px) that reads as 8 distinct "pixels" tracing a diamond rather than
// a fused blob (edge-to-edge squares with zero gap visually merge at small sizes). The resting
// (unlit) opacity is low enough to recede into the background so only the lit trace pops.
const CSS = `
@keyframes luiDiamondSpin { 0%, 100% { opacity: 0.08; } 8% { opacity: 1; } 30% { opacity: 0.32; } }
.luiDx { animation: luiDiamondSpin 1.1s ease-in-out infinite; }
.luiDx1 { animation-delay: 0s; }    .luiDx2 { animation-delay: 0.11s; }
.luiDx3 { animation-delay: 0.22s; } .luiDx4 { animation-delay: 0.33s; }
.luiDx5 { animation-delay: 0.44s; } .luiDx6 { animation-delay: 0.55s; }
.luiDx7 { animation-delay: 0.66s; } .luiDx8 { animation-delay: 0.77s; }
@media (prefers-reduced-motion: reduce) { .luiDx { animation: none; opacity: 0.7; } }
`;

export default function DiamondLoader({ size = 22, color = 'var(--accent)' }: { size?: number; color?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      role="status"
      aria-label="Loading"
      style={{ color, flex: 'none' }}
    >
      <style>{CSS}</style>
      <rect className="luiDx luiDx1" x="9.5" y="1" width="5" height="5" rx="1.1" />
      <rect className="luiDx luiDx2" x="15" y="6.5" width="5" height="5" rx="1.1" />
      <rect className="luiDx luiDx3" x="18" y="9.5" width="5" height="5" rx="1.1" />
      <rect className="luiDx luiDx4" x="15" y="15" width="5" height="5" rx="1.1" />
      <rect className="luiDx luiDx5" x="9.5" y="18" width="5" height="5" rx="1.1" />
      <rect className="luiDx luiDx6" x="4" y="15" width="5" height="5" rx="1.1" />
      <rect className="luiDx luiDx7" x="1" y="9.5" width="5" height="5" rx="1.1" />
      <rect className="luiDx luiDx8" x="4" y="6.5" width="5" height="5" rx="1.1" />
    </svg>
  );
}
