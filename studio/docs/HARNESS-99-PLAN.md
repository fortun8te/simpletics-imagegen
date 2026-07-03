# Plan: 99% on the benchmark ads

## The core realization

Two very different problems are tangled together, and the fix is to separate them:

1. **Preset archetypes** (X-post, DM, Apple Notes, comparison, stat-chart…) — these should be
   DETERMINISTIC and near-1:1, because they're hand-built templates. The user picks the preset,
   gets a pixel-faithful scaffold, edits copy. This is 100% achievable and is where "easy as
   fuck to make these social things" comes from. THIS is the KPI we can truly hit.
2. **Arbitrary-ad extraction** (copy any random ad 1:1) — this is bounded by the vision model
   (Gemma-4-e4b, a small local VL). We make it as good as possible (grouping, effects, native
   detection, refine loop) but it will never be pixel-perfect on every ad. Honest.

So: pour effort into the templates + a dead-simple preset picker, and make extraction feed those
templates (detect archetype → drop the matching preset → let vision fill copy/positions).

## Benchmark → archetype map

| ad | what it is | plan |
|----|-----------|------|
| 9   | X/Twitter testimonial post | tighten x-post-ad to 1:1 (fonts, metrics, grouping) |
| 11  | Apple Notes screenshot | NEW `apple-notes` template (yellow nav, bullets, footnote) |
| 107 | giant %-stat + area chart + product | NEW `stat-chart` template (chart-line + product-on-chart) |
| 129 | photo bg + product + glass panel | glass element (re-added, working) + product-over-photo |
| 137 | pixelated/blurred username | blur/pixelate avatar effect + extraction detects it |
| 7   | product (with its own label text) + overlay text | product placeholder keeps label; overlay text separate |
| 26, 49, 78, 83 | testimonial / offer / comparison variants | covered by existing archetypes, tightened |

## Work streams (parallel agents)

**Agent A — archetypes, grouping, effects (`lib/templates.mjs`, `lib/elements.mjs`)**
- Every template returns ONE named top-level GROUP with meaningful SUB-GROUPS (e.g. x-post →
  "X Post" › {"Header"›[avatar,name,handle], "Body", "Photo", "Meta"}). Clean layer tree =
  clean Figma export. tplRef stamps preserved on nested text leaves.
- NEW `apple-notes` (yellow ‹ Notes … Done nav, share/more glyphs, bold headline, • bullets,
  product slot, footnote) and `stat-chart` (giant stat + circled arrow, filled line chart with
  week labels, product on the curve, pill label, caption).
- Re-add a WORKING glass element (backdrop-blur panel) for over-photo product cards.
- Blur/pixelate avatar option on x-post & ig-dm (privacy usernames, ad 137).
- x-post & ig-dm to 1:1 (already 90% there).

**Agent B — Figma export + layer structure (`figmaClipboard.ts`, `figmaImport.ts`, `designstore.mjs`)**
- Grouped layer trees export as real nested Figma frames/groups with the group names; verify
  round-trip (import back → same structure). This is the "figma export isn't working" fix.

**Agent C — preset picker UX (`Editor.tsx` + a new Presets panel)**
- A one-click "Presets" panel/menu: X-post, Instagram DM, Apple Notes, Comparison, Stat-chart,
  Offer, Before/After, Story — each drops the full archetype instantly. "easy as fuck."

**Me — extraction grouping + effects + native detection + design-agent contract (`layout-extract.mjs`, `design-agent.mjs`)**
- Extraction groups its output by region and detects effects (blurred avatar → blur; glass
  panels). Native-post archetype detection routes to the matching preset template instead of
  loose layers. design-agent handles the grouped template return + keeps applyTemplateTextEdit
  working through groups.

## KPI loop
Render each benchmark archetype, compare to the reference, fix the template until the preset is
~1:1. Deterministic templates are the ones we drive to 99%; extraction is best-effort on top.
