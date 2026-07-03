# Plan: better native ads + general bug sweep

## The problem (Michael, this round)
- Output is still poor: **wrong background, wrong font, wrong layout**, and it **fails to recognize
  presets**. The system "still cannot handle ad 9 properly" (the X/Twitter testimonial post).
- Quick-select on the canvas is hard to use; multi-select delete in the gallery should work off the
  keyboard; the extraction UI should be a live **side-by-side** (reference left, building comp right).
- ornith9b (a smarter local model than Gemma) should drive both vision + reasoning when loaded. ✅ done
- Diamond loader must actually animate and show what it's doing. ✅ done (loading-ui diamond + text-shimmer)

## Split: deterministic presets vs. best-effort extraction
The KPI we can truly hit is the **deterministic archetype templates** (x-post, ig-dm, apple-notes,
comparison, stat-chart…). Extraction should DETECT the archetype and drop the matching preset, then
let vision fill copy/positions — instead of emitting loose, wrong-font/wrong-bg layers. Ad 9 is a
pure preset case: it IS the x-post archetype, so it must route to a pixel-tight x-post-ad template.

## Team A — Native ads (3 agents, disjoint backend files)
- **A1 · ad 9 / x-post-ad to 1:1** — `lib/templates.mjs`. Rebuild x-post-ad against the real X post
  chrome: avatar, display name + grey @handle, blue verified check, body copy, optional photo, the
  reply/repost/like/view action row with counts, timestamp·client footer. Correct fonts (Chirp/系),
  metrics, spacing. Reference: `~/Downloads/IMAGE AD INSPO` (ad 9 = the Twitter/X testimonial).
- **A2 · extraction accuracy + preset recognition** — `lib/layout-extract.mjs`. Fix wrong background
  (trust the deterministic border sampler more), wrong font (map platform → font stack), wrong layout.
  Add strong **archetype detection**: when the read clearly matches an archetype (x-post, ig-dm,
  apple-notes, comparison, stat-chart), return that archetype so the app drops the preset template
  instead of loose layers.
- **A3 · native generation quality** — `lib/design-agent.mjs` + `lib/elements.mjs`. Improve building an
  ad from a brief: sane font/layout/background choices, better element defaults, contrast, hierarchy.

## Team B — General bugs (3 agents, disjoint frontend files)
- **B1 · gallery multi-select + delete** — `src/components/views/DesignView.tsx` (+ css). Multi-select
  already exists; make **Delete/Backspace** delete the selection (with confirm), and make selecting
  EASIER (hover checkbox affordance, clearer selected state) so it isn't "a very specific action".
- **B2 · canvas quick-select** — `src/components/design/Stage.tsx` (+ Editor selection). Make selecting
  layers on the canvas easy: single-click selects top hit, marquee, shift-add — no fiddly gesture.
- **B3 · side-by-side live build** — `src/components/design/NewCompFlow.tsx` (+ css). During extraction
  show reference LEFT + the building comp RIGHT as **grey shimmer boxes** that fill in per pass. Import
  the shared `DiamondLoader` + `TextShimmer` (do not edit them).

## Foundational (already landed this round)
- ornith9b routing in `lib/llm.mjs` (auto-detect any loaded "ornith*" model; `PREFERRED_MODEL` to pin).
- Real loading-ui `DiamondLoader` (inline-SVG animation) + `TextShimmer` (legible base + sweep).
