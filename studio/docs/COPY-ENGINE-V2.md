# COPY ENGINE V2 — ground-up rethink of "flattened ad PNG → editable Figma layers"

*2026-07-09. Supersedes the extraction parts of SYSTEM-V2-PLAN.md and HARNESS-99-PLAN.md.
Everything here was derived from a full codebase audit, first-hand failure analysis of the
43-case copy-harness corpus, and outside research (Canva Magic Layers, commercial
image→Figma tools, 2025-26 layer-decomposition literature, local CV primitives).*

---

## 1. Diagnosis — why the current system fails

### 1.1 The architecture is inverted
Today a small vision model **guesses everything** — boxes, text, colors, styles, z-order,
background kind — and ~4,000 lines of deterministic code (`layout-extract.mjs` retries,
degenerate-coords detection, pixel-snap oracle, weak-text rescue, self-check loops) try to
un-guess it afterward. Every one of the recurring complaints traces to this:

| Complaint | Root cause |
|---|---|
| Can't do gradients | Gradients are never *measured* — the VLM occasionally reports one; the only fitted detection (`typo-truth.mjs measureBackgroundGradient`) is page-background-only, linear-only, harness-only |
| Text vs text-over-image | **There is no OCR in the pipeline at all.** All text reading is VLM. No classifier exists for "overlay vs printed-on-the-photo" — case 004 turned a nutrition label into 30 text layers; 016 boxed the grüns bag print |
| Slow, dirty layers | 1.5–4 min per local VLM call × up to 5 retries × self-check rounds; the free pool is stochastic (same ad scored 41 → 94 → 86 across runs) |
| Cutouts fail ugly | Matte-chain failure falls back to a **labeled placeholder shape** ("WHITE EARPLUG" circle) instead of a rect crop |
| Fonts | Matcher candidate set is 7 archetype families; only Inter/Poppins/Fraunces are bundled → identified fonts can't be *used*, substitutes have wrong metrics |
| Bad result → can't do anything | One-shot black box. No per-stage artifacts, no per-layer provenance, nothing to re-run or override |

### 1.2 The quality stack isn't even wired in
`scene-truth.mjs`, `typo-truth.mjs`, `font-match.mjs`, `planOcclusions`, `refine-loop.mjs`
are imported **only by `scripts/copy-harness.mjs`**. The editor's copy button runs raw
extraction → assembly. The 94.4 harness average was never what the product shipped.

### 1.3 The score is lying
`pixel-diff.mjs` = 64×64 **grayscale** mean-abs-error. Case 004 scores **88.6** while being
unreadable text soup, because the big flat background dominates the grid. The refine loop
optimizes this number — i.e. it optimizes noise. The best harness cases (95–99) were
hand-fed **Claude Sonnet scene-reads**, not the free pool, so the corpus average conflates
two different systems.

### 1.4 What is genuinely good and must survive
- **Scene graph v3** + group normalization (`src/lib/sceneGraph.ts`, `sceneTree.ts`)
- **The five parity renderers**, esp. the **Figma kiwi clipboard** round-trip (crown jewel)
- **Matte chain** BEN2 → BiRefNet-lite ONNX (+ translucency "ghost" gate) — genuinely SOTA-class
- **Measured-box lock + shrink-only font fit** in the assembler (text can never overflow)
- The *math* inside scene-truth / typo-truth (ink-cluster text color, weight-from-density,
  italic shear, plane-fit gradient) — right ideas, wrong place in the flow
- **Silhouette font matching** through the real renderer (right idea, starved candidate set)
- The 43-case harness corpus + side-by-sides — becomes the regression suite

---

## 2. What the market says (research summary)

- **Canva Magic Layers** (canva.com/magic-layers) is exactly this feature: flat PNG/JPEG →
  selectable/movable layers, direct text edit, font/color changes. It is **beta** and
  **premium-metered** (burns monthly AI allowance) — even Canva, owning Kaleido/remove.bg,
  treats this as expensive and imperfect. Positioning is "fix your AI-generated design",
  not pixel-perfect ad cloning. Its precursors (Magic Grab = click-subject→layer+inpaint,
  Grab Text = OCR+erase+re-set) are single-object interactions, i.e. two stages of our
  pipeline productized. We don't need to beat Canva — we need *our* corpus (DTC ads) at
  near-perfect, which a specialized deterministic pipeline can do.
- **The consensus architecture is published.** Every serious 2024-26 system (LayerD ICCV
  2025, OmniPSD, LayerPeeler, AmodalSVG, Alibaba's production AutoPoster) converged on:
  OCR + element detection → **iterative top-down peeling** (matte topmost element →
  remove → inpaint revealed background → repeat) → parametric fitting per layer →
  z-order from peel sequence → verify by re-compositing. Nobody trusts a VLM with geometry.
- **LayerD** (CyberAgent AILab — an *ad company's* research lab, arXiv:2509.25134,
  github.com/CyberAgentAILab/LayerD, pip-installable, runs on CPU) is our architecture
  with code: BiRefNet-based peeling (same family as our matte stack), uniform-appearance
  layer refinement, text/vector/image classification, SVG+PSD export, and a
  **reference-free decomposition quality metric**. Use as baseline + benchmark; steal the
  refinement trick and the metric.
- **De-rendering Stylized Texts** (CyberAgent, arXiv:2110.01890, code available) recovers
  per-text **font (Google Fonts vocab), size, fill, stroke, shadow + hidden background**
  by render-and-compare — the definitive reference for our S2/S7/S8 text stages. Related:
  "VLMs Get Lost in Font Recognition" (arXiv:2503.23768) confirms VLM font ID is bad —
  the silhouette matcher is the right call.
- **Free assets**: OTR dataset (cyberagent/OTR — overlay-text removal over complex
  backgrounds; benchmark for S9), crello dataset (thousands of real layered promo designs
  — font/color/layout priors), PosterLayout/CGL (ad element boxes).
- **Vectorizers emit flat fills only** (vtracer `--gradient_step` is posterization, not
  gradients) → gradient fitting must be built, and the plane-fit approach has 20 years of
  prior art (ARDECO 2006, Photo2ClipArt 2017 — which also fitted layered linear gradients).
  vtracer's *stacking* mode (hole-free stacked paths) maps cleanly to Figma vector layers
  for logos/badges; Recraft's vectorize API is a metered paid fallback for stubborn logos.
- **html.to.design** output conventions (named groups, real gradient fills, effects as
  Figma effects, live text) = the spec for what users recognize as "clean layers"; Codia AI
  ("Visual Struct" image→design-JSON API) = the commercial feature checklist, pipeline
  undisclosed.

---

## 3. The new architecture: FACTS → DECISIONS → ASSEMBLY

One principle: **deterministic code extracts facts; the model only labels them.**
The LLM never invents geometry, never reads text, never picks colors. Every stage emits a
typed, cached, human-inspectable artifact; any stage can be re-run or overridden alone.

```
                         ┌────────────────────────────────────────────────┐
 reference.png ──────────►  S0 normalize (png, sRGB, analysis downscale)  │
                         └────────────────────────────────────────────────┘
   FACTS (all deterministic, all local, no LLM)
   S1 text-ocr        Apple Vision CLI → words/lines/quads/confidence      ~0.2 s
   S2 text-attrs      per line: ink color, weight, italic, spacing,        ~0.1 s
                      case, align  (harvested scene-truth/typo-truth math)
   S3 text-origin     overlay vs scene-text classifier (rules, below)      ~0 s
   S4 regions         text-masked segmentation: rect/rrect detection +     ~0.5-1 s
                      SAM2.1-small (CoreML) proposals for organic shapes
   S5 fills           per region + page: flat → linear grad → radial grad  ~0.1 s
                      → photo  (plane-fit + structure-tensor, Theil-Sen)
   S6 subjects        product/person cutouts: BEN2→BiRefNet matte,         ~1-3 s
                      solidity gate; FAIL ⇒ rect crop (placeholders BANNED)
   S7 effects         shadow fit (analysis-by-synthesis vs own renderer),  ~1 s
                      vignette radial-polynomial fit, scrim alpha-ramp fit
   S8 fonts           silhouette match vs REAL library (Google-Fonts pack  ~1-2 s
                      + system), top-5 kept, metric-compatible substitution
   S9 background      photo-base reconstruction: remove overlay regions,   ~1-3 s
                      re-render fitted fills; photo holes → MI-GAN (ONNX),
                      escalate LaMa; never inpaint what a fitted fill covers
   DECISIONS (the ONE model call)
   S10 semantics      small VLM gets image + compact FACTS json → returns  ~2-10 s
                      roles (headline/cta/badge/logo), reading order,
                      grouping, flags. Output validated: may only reference
                      fact ids; any coordinate it emits is snapped to facts
   ASSEMBLY (deterministic)
   S11 assemble       scene graph build, measured-box lock + shrink-fit,
                      z-order from containment + S10, design-verify
   S12 score          per-layer scorecard (below) + render diff; optional
                      refine-loop nudges gated on the NEW score
   S13 export         Figma kiwi clipboard (gradients ✓ + DROP_SHADOW ✓ already in
                      figmaClipboard.ts; + Google-Font names Figma resolves natively;
                      + REAL VECTOR nodes via vectorNetworkBlob encoder — byte format
                      verified from fig2sketch, spec in CONTRACTS §S13b)
```

Per-job artifact directory (`.state/copy-jobs/<id>/`): `s1.words.json`,
`s3.origin.json`, `s5.fills.json`, `s6.cutouts/`, `s10.semantics.json`, … each with a
debug PNG. This is the recoverability story: a bad result is one stage re-run or one
override, not a re-roll.

### 3.1 S1 — OCR replaces VLM text reading
- **Apple Vision framework** via a ~60-line Swift CLI (`VNRecognizeTextRequest`,
  accurate mode): per-word quads + confidence + reading order, ~200 ms/image on
  Apple Silicon, free, offline, and trained on real-world/stylized text (better than
  document OCR stacks on display fonts). JSON to stdout, cached by image hash.
- Optional second engine for cross-checks: RapidOCR (PP-OCRv5 via onnxruntime-node,
  `@gutenye/ocr-node` pattern) — union by IoU; disagreement marks a line "low-trust"
  for the S10 model to arbitrate. Crops both engines fail on → optional local OCR-VLM
  (mlx-vlm + PaddleOCR-VL) as a last resort, still local.
- Everything downstream keys off these boxes. The VLM never supplies text or geometry.

### 3.2 S3 — overlay vs scene text (the 004/016 killer)
Score each OCR line on six deterministic features, logistic threshold, VLM tiebreak only
in the ambiguous band:
1. **Edge-ramp sharpness ratio** — overlay glyphs keep a 1–2 px anti-alias ramp regardless
   of local photo blur; scene text inherits the photo's blur (transition-map idea,
   Kim & Kim TIP 2009)
2. **Ink-cluster tightness** — overlay = 1–2 tight color clusters; print on packaging
   varies with lighting along the baseline
3. **Quad rectangularity / rotation** — perspective-distorted quad ⇒ on-object print
4. **Grid alignment** — shares left/center/right guides with other overlay boxes
5. **Contrast ring / stroke / shadow of uniform width** ⇒ overlay
6. **Semantic prior** — CTA/price/offer patterns ("SHOP NOW", "50% OFF") ⇒ overlay;
   ingredient-list/nutrition patterns ⇒ scene
Scene text → stays in the photo, listed in the artifact as `keptInPhoto` (visible,
overridable). Overlay text → becomes a layer + an occlusion region for S9.

### 3.3 S5 — gradient fitting (the gradient fix)
Per region and for the page background:
1. Fit `c(x,y)=ax+by+k` per RGB channel (least squares on a 4×-downsampled, lightly
   lowpassed region; Theil–Sen/Huber for dither robustness; fit in sRGB first — CSS/Figma
   gradients interpolate in sRGB).
2. Residual small + (a,b) collinear across channels ⇒ **linear gradient**; angle from the
   shared direction; stops from the 1-D profile along the axis, piecewise-fit then greedily
   merged to minimal stops (catches multi-stop).
3. Else structure tensor: gradient directions converging on a point ⇒ **radial**; center =
   least-squares intersection; profile fit along radius.
4. Else flat (tight color histogram) or photo (high residual).
Scrims over photos — solved analytically: once the base photo behind the scrim is known
(inpaint or clean crop), solve `observed = α·scrim + (1−α)·photo` per region by least
squares ⇒ parametric semi-transparent overlay (flat or gradient alpha). This is the cheap
answer to what DiffDecompose (arXiv:2505.21541) built a diffusion model for. Diagonal
banner stripes (case 018) = rotated rect regions from S4 with flat/gradient fills from S5
— no special case needed.

### 3.4 S6 + S9 — cutouts and background reconstruction
- Adopt the published **peel order**: elements are removed topmost-first, each removal
  followed by background recovery, so z-order falls out of the peel sequence instead of
  being guessed. After each peel, re-composite and pixel-diff the region (LayerD's
  verification pattern); a low-confidence peel downgrades to a rect crop.
- Matte chain unchanged (BEN2 → BiRefNet-lite → imgly, solidity gate) but the failure
  path is **rect image crop, never a labeled placeholder**. Placeholder shapes are deleted
  from the codebase.
- Background holes: where the covering layer sits on a **fitted fill**, re-render the fill
  (perfect, free). Only true photo holes go to inpainting: **MI-GAN ONNX**
  (onnxruntime-node, in-process, no Python) first-line; LaMa (IOPaint server) escalation;
  SD-inpaint only for huge semantic holes, and only if enabled.
- "Gradient on top of product" (scrim case) resolves naturally: photo base + fitted scrim
  layer above it, product cutout above that if it overlaps.

### 3.5 S7 — effects (shadows, vignette)
- **Drop shadow**: we have the element's alpha. Forward-model it with our own renderer —
  `shadow(dx,dy,σ,opacity,color)`; coarse grid (dx,dy ±30 px, σ 0–40) then Nelder–Mead on
  L1 vs the residual halo. <1 s per element. Sanity: one shared light direction per ad.
  Same render-and-compare pattern extends to **text stroke/shadow** (the De-rendering
  Stylized Texts recipe): hypothesize params, render with our own text renderer, minimize
  pixel loss on the crop.
- **Vignette**: radial polynomial luminance falloff fit (standard vignetting-correction
  model) on the element-masked background ⇒ vignette layer params.
- Both export to Figma as native effects (DROP_SHADOW exists in the kiwi schema).

### 3.6 S8 — fonts (identification AND availability)
- Ship a **Google Fonts pack** (~150 ad-common families: Inter, Montserrat, Poppins,
  Oswald, Bebas Neue, Anton, Archivo, Barlow, DM Sans, Manrope, Space Grotesk, Playfair,
  Lora, …, several weights each, woff2, one-time download script) + system fonts.
- Silhouette matcher (existing NCC approach) runs against this real library; per text
  layer keep **top-5 candidates + scores** in the artifact (UI can flip between them).
- **Figma resolves Google Fonts natively** → the export names a font Figma actually has.
  If best match is low-confidence, substitute by **metrics** (x-height/advance-width
  match) — and the measured-box lock already guarantees no reflow.

### 3.7 S10 — the one model call
Input: the image + compact facts JSON (ids, boxes, text, fills — ~1-2k tokens).
Output schema: `{ role, group, order, flags }` per fact id. Hard validation: unknown ids
rejected, geometry ignored, coordinate snap-back. Model options (all cheap):
- local: **Qwen3-VL-8B-Instruct** (MLX 4-bit, LM Studio — ~5-6 GB) — replaces ornith as
  the vision default; ornith stays as fallback
- free cloud: **Gemini Flash free tier** (best free structured extraction) or OpenRouter
  free pool ($10 one-time unlock → ~1000 req/day)
Because it's ONE small labeling call — not 5 retries of full-scene geometry — even a weak
model can't destroy the result: the worst case is a mislabeled role, not a broken layout.

### 3.8 S12 — a score that can't lie
Per-layer scorecard replacing the 64×64 grayscale MAE as the gate:
- **Text**: per-layer string F1 (OCR the RENDER, align to source strings), position delta
  (px), font-size delta, color ΔE
- **Regions/fills**: masked SSIM per region + fill-param delta (gradient angle/stops)
- **Cutouts**: IoU of alpha vs source silhouette
- **Global**: the old pixel score, demoted to a tiebreaker; text-pile penalty kept
- **Hard fails** (any ⇒ job flagged, regardless of averages): duplicate ghost text
  (render OCR finds the same string twice at offset), placeholder artifacts, overlapping
  text piles, missing >20% of source OCR strings
Refine-loop keeps its render-nudge mechanics but gates on the new scorecard.

---

## 4. Recoverability — "if it's bad I can do something"

- `.state/copy-jobs/<id>/` keeps every stage artifact + debug overlay PNG.
- **Copy Inspector** panel in the editor (v1 = one afternoon): layer list with provenance
  chips (OCR conf, font score, matte solidity, fill type); per-layer actions:
  *toggle overlay/scene-text*, *rect-crop ↔ matte*, *pick font from top-5*,
  *flat ↔ gradient fill*; per-stage “re-run from here”.
- Overrides are stored in the job dir and survive re-runs (idempotent pipeline: same
  input + same overrides ⇒ same output; stage caches keyed by content hash).

---

## 5. What we delete / park (the "bullshit" ledger)

**Delete from the copy path** (park the files in `attic/` until confident):
- VLM-first extraction: the retry ladders, degenerate-coords detection, pixel-snap oracle,
  weak-text rescue, two-step scoped read, `iterativeSelfCheck`, VLM self-vision compare
  (~3,000+ lines of `layout-extract.mjs` shrink to S0 orchestration)
- `templates.mjs` archetype presets + `native-components/` + `elements-*.mjs` staging
  files on the copy path (IG-caption pill mode survives — it lives in the renderer, not
  the element library)
- Labeled-placeholder fallbacks, `icon-extract.mjs` (unwired; vector-trace covers it)
- The edit-agent op loop stays for later but is **off** the copy path

**Park untouched** (different product): repo-root Chrome extension, codex batch tooling,
telegram-control, dashboard, worker/jobstore image-gen queue, planner, trendtrack, taste,
brand-skills, layout-library, native-ui-loop.

**Keep** (shared spine): scene graph, five renderers, figma clipboard + import +
roundtrip test, textMetrics, fills, matte stack + ONNX weights, design-verify,
copy-harness corpus + scene-reads (as regression fixtures), llm.mjs client.

---

## 6. Build order — each phase independently shippable

**Phase 0 — wire what exists (≈ half a day).** Move the harness-only stack into the
product path: `runCopyReference` gains scene-truth, typo-truth, occlusion plan+fill,
font-match, refine-loop; ban placeholder fallbacks (rect crop instead); persist stage
artifacts. *No new capability, but the product immediately matches the 94-avg harness —
and every later phase ships through one pipeline, not two.*

**Phase 1 — the facts layer (≈ 1 day).** Swift OCR CLI + S2 attrs (harvest scene-truth/
typo-truth math) + S3 overlay/scene classifier + S5 fill fitting (extend the existing
plane fit: per-region, radial, multi-stop, scrims). Kill VLM text/geometry reads; the VLM
call shrinks to S10 semantics. Google-Fonts pack + font-match against it.
*This phase alone fixes: 004/016-class disasters, gradients, fonts, and ~10× extraction
latency (VLM minutes → CV seconds + one small model call).*

**Phase 2 — regions, cutouts, effects (≈ 1 day).** S4 segmentation (rect/rrect contours
+ SAM2.1-small CoreML for organic shapes), S6 gate rework, S9 MI-GAN inpainting, S7
shadow/vignette fitting, z-order assembly from containment. Figma export: shadows.
**Icon/element vectorization gets first-class treatment** (field intel 2026-07: Canva
Magic Layers' standout strength is clean vector icons/elements from flat images — match
it): vtracer in stacking mode (hole-free stacked paths → clean Figma vectors) for
badges/logos/arrows/decorative elements, existing imagetracerjs gates as fallback,
raster crop as last resort. Same intel: Canva is ALSO bad at overlay-vs-scene text and
ships no self-verification pass — S3 and S12 are our edge; keep them strict.

**Phase 3 — score + inspector (≈ half a day).** S12 scorecard, Copy Inspector v1, kill
switch for old pixel-score gating.

**Acceptance target (owner-set 2026-07-09):** the FULL corpus is
`~/Downloads/IMAGE AD INSPO/` — 128 ads (110 webp, 18 png, mixed aspect incl. 338×600
up to 1080×1920); the 43 harness cases are a subset of it. Definition of done:
- every one of the 128 runs end-to-end in the backend with zero hard-fails
  (no ghost text, no placeholders, no text piles, no missing strings >20%)
- cheap: no metered calls in the loop; one small semantics call per ad max;
  full-corpus re-run is an unattended batch (`scripts/copy-batch.mjs <dir>`)
- output quality bars: real text blocks (merged paragraphs, correct font from the
  manifest), named/grouped Figma layers (semantic group names, back-to-front order),
  real vector nodes for icons/badges where traceable, fills as parametric
  gradients/scrims not baked pixels
- UI integration comes AFTER the backend hits the bar on all 128.

**Native-ad gauntlet (owner-set 2026-07-09, second pass):** five named ads in
`~/Downloads/IMAGE AD INSPO/` are the vector/native quality benchmarks, each exercising
a specific capability — regression-test all five by name:
| Ad | File prefix | Tests |
|---|---|---|
| 009 | 009_attached_885c19be | X-post with many components (native chrome, icons, avatar) |
| 107 | 107_attached_3fba9647 | complex-vector benchmark |
| 093 | 093_attached_d4e120c8 | LAYER BLUR detection + export |
| 041 | 041_attached_88505203 | text + image + CIRCULAR image overlay (⇒ Figma ellipse mask) |
| 020 | 020_attached_7ba93f7f | hardest: text + product overlaid with strokes/details |
Additional owner requirements:
- **Emoji**: detect emoji in ads, identify WHICH platform set (Apple/Google/Twemoji/…),
  never vectorize them — export as emoji text or the platform's asset.
- **IG captions / simple graphics**: lines, dots, underline squiggles vectorize crisply.
- **Known-icon substitution**: native UI chrome (X/IG like/reply/share icons, verified
  badges) should match against a canonical icon library and substitute perfect vectors
  instead of tracing.
- **Figma export polish**: every layer semantically NAMED (role-based, html.to.design
  quality), masks exported as real Figma masks (circular crops etc.), text rendering
  faithful (weight/spacing/lineHeight).
- **Assist-LLM options** (modest, non-load-bearing): MIMO v2.5 (vision, current default
  via 9router), MiniMax 3, GLM 5.2 (text-only, strong reasoning) — benchmark for the S10
  semantics/tiebreak role; never give them geometry authority.

Total ≈ 3 focused days, but value lands at every checkpoint, starting half a day in.

**Optional side-quest (≈ 1 hour, anytime):** `pip install` **LayerD** and run it over the
43-case corpus as an external baseline — it CPU-runs, exports PSD/SVG, and its
decomposition metric gives us a second opinion on our scorecard. If it beats a stage of
ours, steal that stage.

---

## 8. Reference shelf

- LayerD — iterative peeling + refinement + metric: arXiv:2509.25134,
  github.com/CyberAgentAILab/LayerD
- De-rendering Stylized Texts — text→render-params: arXiv:2110.01890,
  github.com/CyberAgentAILab/derendering-text
- OTR overlay-text-removal benchmark: huggingface.co/datasets/cyberagent/OTR
- crello layered-design dataset (template priors): CyberAgent CanvasVAE
- Photo2ClipArt (layered gradient fitting, SIGGRAPH Asia 2017); ARDECO (EGSR 2006)
- DiffDecompose (semi-transparent layers): arXiv:2505.21541 — we solve its core case
  analytically (§3.3)
- Illustrator's Depth (per-pixel layer index, Adobe): arXiv:2511.17454
- Qwen-Image-Layered (one-model RGBA decomposition, batch-scale fallback): arXiv:2512.15603
- OmniParser V2 (MIT, local element detector) / UIED (classical-CV detector, hackable)
- "VLMs Get Lost in Font Recognition": arXiv:2503.23768
- Apple CoreML SAM 2.1 ports: huggingface.co/apple/coreml-sam2.1-small
- MI-GAN inpainting (ONNX, in-process): github.com/Picsart-AI-Research/MI-GAN;
  IOPaint (LaMa server): github.com/Sanster/IOPaint
- OCR: Apple Vision via ocrmac/own Swift CLI; RapidOCR (PP-OCRv5 ONNX);
  @gutenye/ocr-node for in-process Node
- Local VLMs: Qwen3-VL-8B (MLX 4-bit), Moondream 3 (detection/pointing);
  free cloud: Gemini Flash free tier, OpenRouter free pool ($10 unlock)
- vtracer stacking mode (shapes→Figma vectors): github.com/visioncortex/vtracer
- Output spec inspiration: html.to.design node conventions; Codia "Visual Struct"

---

## 7. Runtime & model inventory (all local or free)

| Need | Tool | Cost |
|---|---|---|
| OCR | Apple Vision (Swift CLI) [+ RapidOCR ONNX cross-check] | free, local, ~0.2 s |
| Segmentation | contour rect/rrect + Apple CoreML SAM 2.1-small | free, local |
| Matte | BEN2 / BiRefNet-lite ONNX (already in `.state/models/`) | free, local |
| Inpaint | MI-GAN ONNX (onnxruntime-node); LaMa via IOPaint escalation | free, local |
| Gradient/shadow/vignette fits | ~600 lines of our own numeric code | free, local, ms |
| Fonts | Google-Fonts pack + system; silhouette NCC (existing) | free, local |
| Semantics (1 call/ad) | Qwen3-VL-8B MLX local; Gemini Flash free / OpenRouter free fallback | free |
| Render/score | headless Chrome (existing), no VLM judging | free, local |

Expected steady-state: **< 15 s per ad** on an M-series Mac, deterministic, with the only
stochastic component being one small labeling call that cannot move geometry.
