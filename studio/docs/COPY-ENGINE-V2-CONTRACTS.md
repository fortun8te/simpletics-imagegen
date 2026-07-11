# COPY ENGINE V2 — build contracts (wave 1)

*Companion to COPY-ENGINE-V2.md. These are the interfaces parallel workstreams build
against. If you must deviate, update THIS file in the same change and say so in your
report. Coordinates are ALWAYS source-image pixels (origin top-left) unless a field is
explicitly suffixed `Pct`.*

## Conventions (all workstreams)
- Backend code: plain `.mjs`, ESM, `node:*` builtins only. Allowed npm exceptions
  (already installed): `sharp`, `onnxruntime-node`, `imagetracerjs`. NO new npm deps.
- Every new file opens with a header comment: role, invariants, who calls it.
- No `git commit`, no `git add`. Work in the working tree only.
- Tests: `studio/test/<name>.test.mjs`, runnable standalone via `node test/<x>.test.mjs`
  (follow existing zero-framework assert style in that dir).
- Corpus for validation: `studio/scratchpad-work/copy-harness/<id>/` — the source image
  is the only `.webp/.png/.jpg` whose name starts with the id + `_`; `extraction.json`,
  `doc.json`, `result.json`, `render.png`, `side-by-side.png` sit next to it.
- Temp/debug output: `studio/.state/` subdirs (gitignored), never the repo.

## Job artifact directory (S-stage outputs)
`studio/.state/copy-jobs/<jobId>/` — `jobId` = content hash prefix (12 hex) of the
source image + a monotonic suffix on collision. Files:
```
source.png            normalized sRGB PNG (S0)
s1.words.json         OCR facts            s3.origin.json   overlay/scene verdicts
s5.fills.json         region/page fills    s6.cutouts/      matte PNGs + meta.json
s7.effects.json       shadows/vignette     s8.fonts.json    per-text font candidates
s10.semantics.json    model labeling       doc.json         assembled DesignDoc
score.json            scorecard            debug/*.png      per-stage overlays
```
Writer helper: `lib/copy-jobs.mjs` (owned by the Phase-0 workstream) exposes
`openJob(imagePath) -> {id, dir, write(name, data), writeJson(name, obj)}` — atomic
writes via `lib/atomic-write.mjs`. Other stages receive the job handle; standalone CLIs
may also run without a job (pure stdin/stdout) for testing.

## S1 — OCR facts (`s1.words.json`)
```jsonc
{
  "engine": "apple-vision",            // producer id
  "source": { "path": "...", "w": 1080, "h": 1350 },
  "ms": 210,
  "lines": [
    {
      "id": "L0",                       // stable within this file: L<n> in reading order
      "text": "THE 10 SECOND",
      "conf": 0.98,                     // 0..1
      "box":  { "x": 96, "y": 340, "w": 512, "h": 74 },   // axis-aligned bbox of quad
      "quad": [[x,y],[x,y],[x,y],[x,y]],                   // TL,TR,BR,BL source px
      "words": [ { "text": "THE", "conf": 0.99, "box": {...}, "quad": [...] } ]
    }
  ]
}
```
Producer: `lib/ocr.mjs` → `recognizeText(imagePath, {cache=true}) -> Promise<that object>`.
Implementation: spawns the compiled Swift CLI `studio/bin/ocrjson` (source in
`studio/tools/ocrjson/`); cache in `.state/ocr-cache/<sha256>.json`. The CLI itself
reads an image path argv, writes the JSON to stdout (no job coupling).

## S3 — text origin (`s3.origin.json`)
```jsonc
{ "lines": [ { "id": "L0", "origin": "overlay",   // "overlay" | "scene" | "ambiguous"
               "score": 0.91,                      // P(overlay), 0..1
               "features": { "edgeRamp": 1.8, "inkTightness": 0.07, "rectangularity": 0.99,
                             "gridAlign": 1, "ringStroke": 0, "semantic": 0.5 } } ] }
```
Producer: `lib/text-origin.mjs` → `classifyTextOrigins(imagePath, s1) -> Promise<that>`.
`ambiguous` = 0.35..0.65 band (downstream may ask the S10 model to break ties).
Scene lines NEVER become layers; they stay in the photo base.

## S5 — fills (`s5.fills.json`)
Producer: `lib/fill-fit.mjs`. Two entry points:
```js
// pixels = { data: Uint8Array RGBA, width, height }  (caller decodes via sharp)
fitRegionFill(pixels, region /* {x,y,w,h} or {mask: Uint8Array} */, opts) -> {
  kind: 'flat' | 'linear' | 'radial' | 'photo',
  color?: '#rrggbb',                       // flat
  stops?: [{ offset: 0..1, color: '#rrggbb' }],   // linear/radial, minimal stops
  angleDeg?: number,                        // linear: CSS convention (0=to top, 90=to right)
  center?: { xPct, yPct }, radiusPct?: number,    // radial, relative to region
  residual: number,                         // mean abs err 0..255 of the fit
  confidence: 0..1
}
solveScrim(pixelsObserved, pixelsBackground, region) -> {
  ok, color: '#rrggbb', alpha: { kind: 'flat'|'linear', value?, from?, to?, angleDeg? },
  residual }
```
Fit in sRGB first; Theil–Sen/Huber robustness; downsample ≥4× before fitting; linear
verdict requires per-channel plane collinearity + near-monotone profile; radial via
structure tensor convergence. `s5.fills.json` = `{ page: <fit>, regions: [{id, box, fit}] }`.
Implementation notes (fill-fit stream, validated on corpus 013/018):
- "monotone profile" is enforced as ≤1 direction reversal per channel with hysteresis —
  real multi-stop gradients are NOT strictly channel-monotone (013's page gradient rises
  then falls ~20 levels in blue), while photos/stripes oscillate.
- `residual` on gradient verdicts is the 15%-trimmed inlier mean abs error so stray
  occluders (shadow bleed past region masks) can't flip a clean gradient to `photo`;
  the untrimmed mean is added as `residualFull` when it diverges. `photo` verdicts carry
  a `detail` field with per-model failure reasons.
- extra export: `renderFill(fit, width, height) -> {data RGBA, width, height}` — S9 uses
  it to re-render fitted fills over occlusion holes; also used for debug overlays.

## S8 — fonts (`s8.fonts.json`)
```jsonc
{ "texts": [ { "lineId": "L0",
    "candidates": [ { "family": "Archivo", "weight": 800, "italic": false,
                      "score": 0.87, "source": "google-pack" } ],   // top-5, sorted
    "chosen": 0 } ] }
```
Font pack: `scripts/fetch-fonts.mjs` downloads into `.state/fonts-pack/<Family>/<file>.ttf`
plus a committed manifest `lib/fonts-manifest.json`
(`[{ family, weights: [400,700...], files: {...}, figma: true }]`). `lib/font-match.mjs`
gains `matchFontAll(cropPng, opts) -> candidates[]` using the manifest families (loaded
via @font-face file URLs in its existing headless-Chrome probe).

## S6/S9 — inpainting
`lib/inpaint.mjs` → `inpaint(pixels, mask /* Uint8Array, 255=hole */, opts) ->
Promise<{ data, width, height, engine: 'migan'|'patch' }>`.
MI-GAN ONNX weights at `.state/models/migan.onnx` (downloader
`scripts/fetch-migan.mjs`); on any model failure fall back to the existing deterministic
patch fill in `occlusion-fill.mjs` (never throw). `occlusion-fill.mjs` keeps its public
API (`planOcclusions`, `fillOccludedRegions`) and routes hole-filling through
`lib/inpaint.mjs`.

## File ownership (wave 1 — do not touch files owned by another stream)
| Stream | Owns (create/modify) |
|---|---|
| phase0-wiring | `lib/design-agent.mjs` (runCopyReference only), `lib/copy-jobs.mjs` (new), `test/copy-jobs.test.mjs` |
| ocr | `tools/ocrjson/` (new), `bin/ocrjson` (built), `lib/ocr.mjs` (new), `test/ocr.test.mjs` |
| fill-fit | `lib/fill-fit.mjs` (new), `test/fill-fit.test.mjs` |
| fonts | `scripts/fetch-fonts.mjs` (new), `lib/fonts-manifest.json` (new), `lib/font-match.mjs`, `lib/font-faces.mjs`, `test/font-match-pack.test.mjs` |
| text-origin | `lib/text-origin.mjs` (new), `test/text-origin.test.mjs` |
| inpaint | `scripts/fetch-migan.mjs` (new), `lib/inpaint.mjs` (new), `lib/occlusion-fill.mjs`, `test/inpaint.test.mjs` |

Shared read-only for everyone: `scene-truth.mjs`, `typo-truth.mjs`, `matte*.mjs`,
`designstore.mjs`, corpus dirs, this file, COPY-ENGINE-V2.md.

---

# Wave 2 contracts (research-locked 2026-07-09; build after wave 1 lands)

## S2.5 — line→block merge (`s2.blocks.json`)
OCR emits LINES; the scene graph wants text BLOCKS (Figma text layers = paragraphs).
Merge rule (deterministic): two vertically adjacent lines join a block iff ALL of:
same origin verdict (S3), |fontSize delta| ≤ 12%, ink color ΔE ≤ 10, same alignment
guide (left/center/right within ±1.5% canvas W), vertical gap ≤ 1.9 × median line
height of the pair, and no region boundary (S4) between them. Block records:
`{ id, lineIds, box, text (\n-joined), align, lineHeightPx (median baseline delta),
fontSizePx, letterSpacing }`. lineHeight exports as px→ratio at assembly.

## S4 — element detection (residual connected components)
After S1/S3 (overlay text mask) + S5 (page/region fills) + photo regions are known:
`residual = |source − explained(background fills + photo regions)|` (text pixels
masked out). Threshold → morphological close → connected components. Each CC ≥ 24px²:
- CC overlapping an OCR box ≥ 0.9 → belongs to that text (ignore; LayerD's OCR-CC rule)
- else → element candidate `{ box, mask, kind: 'icon'|'shape'|'photo-fragment' }` for
  S6 cutout/vectorize. This replaces VLM cutoutCandidates entirely.

## S6b — peeled-layer cleanup (LayerD tricks, verified from their source)
- Peel loop: ≤ 3 iterations is enough for ad-class designs (their default).
- **Unblend/defringe**: after matting an element, decontaminate edge alpha: solve
  fg color per edge pixel assuming observed = α·fg + (1−α)·bg with bg from the S5/S9
  reconstruction (kills halo fringes).
- **Uniform-appearance refinement**: flat-design elements (icons/shapes/badges) refine
  toward a tiny palette — quantize the peeled fg to ≤ 2-3 colors when color count
  measured low; leave photo cutouts untouched (solidity/entropy gate decides).

## S13b — REAL Figma vectors (vectorNetworkBlob encoder)
The blob format is fully known (verified against fig2sketch's decoder,
src/figformat/vector_network.py — we implement the ENCODER):
```
header:  uint32 nVertices, uint32 nSegments, uint32 nRegions   (little-endian)
vertex:  uint32 styleId(0), float32 x, float32 y               (12 B each)
segment: uint32 styleId(0), uint32 v1, float32 t1x, float32 t1y,
         uint32 v2, float32 t2x, float32 t2y                   (28 B each; t = Bézier
         tangent vectors relative to the vertex; straight line ⇒ t = 0,0)
region:  uint32 flags (bit0: 1=NONZERO 0=ODD; rest styleId<<1), uint32 nLoops,
         then per loop: uint32 nLoopVerts, uint32 vertexIdx…
```
Blobs ride in the kiwi message's `blobs` array; `vectorData.vectorNetworkBlob` is the
index; `vectorData.styleOverrideTable` empty; node type VECTOR with `size` + fills.
Pipeline: SVG path (vtracer/imagetracerjs output) → flatten transforms → absolute
cubic segments → vertices/segments/regions → blob. Owner: wave-2 `figma-vectors`
stream; owns `src/components/design/figmaVector.ts` (new) + a figmaClipboard.ts hook
replacing the shapeKind 'path' rounded-rect fallback when a real path is present +
roundtrip test additions. Import side (figmaImport.ts tryPath) must keep working.

## S10 — semantics call (schema locked)
One request. System: "You label facts about an ad. Never invent geometry or text."
User content: the image (downscaled ≤ 768px long edge) + JSON `{ canvas:{w,h},
texts:[{id,text,box,fontSizePx}], elements:[{id,box,kind}], regions:[{id,box,fill}] }`.
Required output (json_schema-constrained where the endpoint supports it):
```jsonc
{ "texts":    [{ "id":"B0", "role":"headline|subhead|body|cta|price|badge|logo|caption|legal|other" }],
  "elements": [{ "id":"E0", "role":"product|logo|icon|decoration|person|ui-chrome|other" }],
  "groups":   [{ "name":"...", "members":["B0","E1"] }],
  "order":    ["ids back-to-front, ONLY when the deterministic z-order was flagged ambiguous"],
  "flags":    [{ "id":"E0", "note":"short free text, e.g. 'starburst badge'" }] }
```
Validator: unknown ids dropped, missing ids defaulted (`other`), `order` ignored unless
it is a permutation of the ambiguous set. Model: config `SEMANTICS_MODEL`; default
local Qwen3-VL-8B via LM Studio, fallback ornith, cloud fallback Gemini Flash free.

## S12 — scorecard (`scripts/scorecard.mjs`, calibration-locked 2026-07-09)
`scoreCopy({sourcePath, renderPath, doc, keptInPhoto?, ocr?, regions?, legacyPixel?})
-> { ok, hardFails:[{rule, detail}], text:{layers, sourceLines, textRecall,
textRenderAcc, meanPosDelta, pileOverlaps, score}, regions:{regions, meanDeltaE,
score}, legacyPixel, composite }` — composite = text 50 / regions 30 / legacy 20
(reweighted over available parts) but ok/hardFails is THE gate. Testability: `ocr`
hook injects S1-shaped fixtures; `regions:false` skips the pixel pass; `legacyPixel`
pins/disables the pixel-diff call. Calibrated deviations from the first-draft rules
(verified over the 42-case corpus, see scripts/scorecard.mjs header):
- ghostText pair similarity is **0.78** (not 0.9) — the baked half OCRs back garbled
  by 1-2 chars; guarded by axis-overlap ≥0.5, a source-duplicate count guard, and a
  positional anchor guard (both occurrences mirroring real source lines = legit
  repetition, e.g. nutrition tables listing "creatine monohydraat" twice).
- placeholderArtifact needs BOTH line-window sim <0.55 AND order-free word-bag
  coverage <0.5 (strict word sim ≥0.9) — multi-column ads interleave OCR reading
  order and would otherwise flag real layers.
- missingText additionally accepts render-baked coverage (string found in the render
  OCR near its source position — photo-base copies) and needs ≥2 missing absolute.
- posDeltaPx is render-position vs source-position of the matched string (doc-vs-
  render would be near-tautological); region score is area-weighted ΔE76.

## Wave 2 file ownership
| Stream | Owns |
|---|---|
| blocks-and-elements | `lib/text-blocks.mjs` (S2.5), `lib/element-detect.mjs` (S4), tests |
| effects-fit | `lib/effect-fit.mjs` (S7 shadow/vignette), tests |
| figma-vectors | `src/components/design/figmaVector.ts`, figmaClipboard.ts path hook, figmaImport parity, roundtrip tests |
| vectorize | `lib/vectorize.mjs` (vtracer subprocess if installed, imagetracerjs fallback, stacking→SVG paths), tests |
| semantics | `lib/semantics.mjs` (S10 call + validator), tests |
| scorecard | `scripts/scorecard.mjs` (S12), copy-harness.mjs integration |
| assembler-v2 | `lib/design-agent.mjs` runCopyReference: consume S1-S10 artifacts instead of VLM extraction (LAST — after all other streams land) |

## Experiments backlog (not gating)
- `cyberagent/layerd-birefnet` (HF): design-tuned BiRefNet for peeling — export to ONNX
  and A/B against BEN2/BiRefNet-lite in matte-v2 on the matte-bench corpus.
- OTR dataset (cyberagent/OTR): benchmark S9 text-removal quality.
- pip-install LayerD, run on the 43-case corpus as external baseline (CPU ok).
