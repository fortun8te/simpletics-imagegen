# COPY ENGINE V2 — build status & remaining work

*Living checklist. Updated 2026-07-11.*

## DONE — facts modules (all individually tested, standalone-verified)
- [x] `lib/ocr.mjs` — Apple Vision OCR (Swift CLI), ~0.4s, cached
- [x] `lib/text-origin.mjs` — overlay-vs-scene classifier, 95.3%, zero catastrophic
- [x] `lib/text-blocks.mjs` — line→paragraph merge
- [x] `lib/fill-fit.mjs` — flat/linear/radial/photo + scrim solver (the gradient fix)
- [x] `lib/element-detect.mjs` — residual connected-components element detection
- [x] `lib/inpaint.mjs` — MI-GAN ONNX + patch fallback (ghost-text fix)
- [x] `lib/vectorize.mjs` — vtracer + imagetracer, honest quality gates
- [x] `lib/font-match.mjs` — 60-family Google pack, top-5, metric fallback
- [x] `lib/semantics.mjs` — the one model call + strict validator
- [x] `lib/effect-fit.mjs` — drop-shadow + vignette fitting
- [x] `lib/copy-jobs.mjs` — per-job artifact dirs
- [x] `scripts/scorecard.mjs` — honest per-layer score + hard-fails (found 15/42 hidden fails)
- [x] Phase-0: quality stack wired into product `runCopyReference`, placeholders banned
- [x] `figmaVector.ts` — real Figma VECTOR node encoder (vectorNetworkBlob), 80/80 roundtrip
- [x] `lib/copy-pipeline.mjs` + `scripts/copy-batch.mjs` — KEYSTONE assembler (facts→DesignDoc→render), own test suite
- [x] `lib/emoji-detect.mjs`, `lib/icon-match.mjs` wired into copy-pipeline (element-detect `kind:'icon'` → icon-match → emoji-detect → vectorize)
- [x] `lib/scene-truth.mjs` + `lib/typo-truth.mjs` — pixel-measured background/font/style truth, wired into `runCopyReference`
- [x] `lib/occlusion-fill.mjs` v2 — routes through `lib/inpaint.mjs` (MI-GAN → patch fallback)
- [x] placeholder-ban (labeled product silhouettes → real rect cutouts of reference pixels) in `design-agent.mjs`
- [x] final-fidelity gate in `runCopyReference` — retains raw reference on OCR hard-fail (ghost text/placeholder/missing text) instead of shipping a bad render

## PROVEN THIS SESSION
- [x] **Wave A** — `copy-batch` run on the 4 benchmark ads: 004 (98.6), 013 (97.5), 016 (99.1), 018 (99.9) — all `ok:true`, zero hardFails. Report: `~/Downloads/copy-engine-out/batch-report.json`.
- [x] **Wave C** — native-ad gauntlet run: 009 X-post (95.3), 020 strokes/details (95.2), 041 circular mask (99.0), 093 blur/ghost-matte (99.9), 107 complex vectors (96.1) — all `ok:true`, zero hardFails.

## IN PROGRESS
- [~] `docs/FIGMA-POLISH-SPEC.md` — masks/blur/naming audit (feeds Wave B; not yet confirmed shipped end-to-end)
- [~] `scripts/eval-semantics.mjs` + `docs/ASSIST-LLM-EVAL.md` — MIMO/MiniMax/GLM bake-off

## TODO — integration waves (ordered)

### Wave B — Figma export polish (from FIGMA-POLISH-SPEC)
- [ ] semantic layer NAMING (role-based, html.to.design quality)
- [ ] real MASK groups for circular overlays (ad 041 — ellipse mask + image sibling)
- [ ] LAYER-BLUR detection (ad 093) → hook into effect-fit, export existing LAYER_BLUR
- [ ] text fidelity gaps (letterSpacing/lineHeight/textCase → kiwi fields)

### Wave D — scale & product
- [ ] `copy-batch` over all 128 IMAGE AD INSPO ads → zero hard-fails
- [ ] pick best assist-LLM from the eval; set as S10 default (+ facts-only fallback)
- [ ] wire copy-pipeline into `studio-server.mjs` + `runCopyReference` (replace VLM-first path)
- [ ] UI: Copy Inspector panel (per-layer provenance + overrides + re-run-stage)

## Model note
Subagents inherit the session model (currently Sonnet 5) when no override is passed;
the explicit `model:"sonnet"` token is broken in this env — always omit it.
