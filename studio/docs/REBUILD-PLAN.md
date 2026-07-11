# IMAGE→FIGMA QUALITY REBUILD — plan

*Synthesized from an 8-agent parallel audit, 2026-07-11. Supersedes scattered patching.*

## The one structural problem behind most failures: TWO assemblers

- **`design-agent.mjs → runCopyReference`** — the PRODUCT path. Editor → `/api/design/agent` → `runDesignAgent` → `runCopyReference`. Also what `scripts/copy-harness.mjs` scores (honest).
- **`copy-pipeline.mjs → runCopyPipeline`** — only `scripts/copy-batch.mjs` calls it. A diverged second assembler with the BETTER occlusion (alpha-erase `:1121`, union S9 fill `:995`) that the product path never got.

The double-inpaint / ghost-text / double-element bugs (owner's #1 complaint) come straight from this split: two implementations of the same occlusion logic, only one of them correct, and it's not the one shipping. **Everything else integrates onto whichever assembler we keep, so this decision is first and blocks the rest.**

## Audit findings by domain (what's actually wrong)

**OCR + hierarchy** (`ocr.mjs`, `text-blocks.mjs`, `semantics.mjs`)
- Single-engine Apple Vision, line-level, no confidence gate, no 2nd engine → missed lines vanish silently.
- Paragraph merge = six ANDed hard-gates; any one failing splits a paragraph.
- **No deterministic hierarchy** — "these texts are peers / same level" is outsourced to one stochastic VLM call that often returns `other`. Fix: type-scale clustering (`fontSizePx` → tiers) as a real deterministic producer.
- Dead code: `weightFromDensity` measured but never used in assembly.

**Segmentation** (`element-detect.mjs`, `matte-v2.mjs`)
- **No SAM anywhere.** Only dichotomous foreground matting (BEN2/BiRefNet/imgly) applied to the main subject only. Icons/badges/arrows/sub-photos never get real per-element masks — kept as flat rects or absorbed. Nested-CC consolidation actively *destroys* sub-element structure.
- Fix: add an element proposer (OmniParser-v2 / Florence-2 for boxes → SAM2 to refine each into a clean mask). Server-side on the RTX 5080; FastSAM/MobileSAM-ONNX or CoreML-SAM2.1-small as Mac fallback.

**Vectorization / icons** (`vectorize.mjs`, `icon-match.mjs`)
- Path-budget mismatch: tracer passes ≤40 paths but `copy-pipeline.mjs:826` hard-drops >14 → medium icons silently crop.
- **No arrow/line/primitive detector at all** (fails 107's arrow, chart polyline). `shape` kind isn't even routed to the vectorizer.
- Icon atlas = 22 hand-authored glyphs; anything else → blurry raster crop. Fix: CLIP/DINOv2 embedding match against a real icon library (Lucide/simple-icons ~1–2k) + a local VLM naming pass on the 5080.

**Inpainting** (`inpaint.mjs`, `occlusion-fill.mjs`)
- Fill silently skips on busy photos → baked ghost survives under the editable overlay = doubled text.
- Partial overlaps (<0.7) never planned; `__photoBase` + per-rect crop fill the same pixels twice with mismatched noise = double-inpaint seam.
- Product path has NO alpha-erase (copy-pipeline does). Fix: single-source-of-truth occupancy map (each region owned by exactly one layer) + one union mask → `inpaint()` + upgrade MI-GAN→**LaMa** (CUDA on 5080) so fills never no-op.

**Font** (`font-match.mjs`, `typo-truth.mjs`)
- No visual classifier — silhouette-NCC over ~60 Google fonts; real ad fonts outside the pack are impossible → "closest of 60", usually Inter.
- Weight hardcoded by size threshold (`fs>=42?800:600`); measured `weightFromDensity` never wired.
- letterSpacing zeroed, lineHeight fixed 1.15, baseline never solved → placement drift. Fix: DeepFont-style/CLIP font classifier vs a large TTF DB (5080) + measured tracking/leading/baseline as first-class channels.

**Figma export** (`figmaClipboard.ts`) — *better than expected*
- Encoder is rich (real VECTOR/TEXT/GROUP/masks/gradients/shadows via kiwi clipboard). The gaps: **no grouping/auto-layout INFERENCE** (output is only as grouped as the input doc, which is flat), no components for repeats, brittle pinned-schema clipboard.
- Fix: pre-export pass that clusters leaves into groups + infers auto-layout (rows/cols/gaps); ship a thin **Figma Plugin** (createFrame/createText tree from JSON) as the robust primary channel, keep clipboard as no-install fallback.

**UI** (`Editor.tsx`) — no Figma plugin, pure web studio
- One opaque agent run; no per-layer provenance, no per-stage artifacts/re-run, revert is all-or-nothing.
- Fix: **Copy Inspector** — per-layer provenance (stage/model/confidence) + per-stage re-run (re-OCR, re-matte, re-fit-gradient, re-match-font) + a pixel-diff overlay mode. Requires the pipeline to emit per-layer provenance metadata (design this into the assembler unification).

## Execution waves (dependency-ordered, file-disjoint for safe parallelism)

**Wave 0 — KEYSTONE (serial, blocks all assembly work).** Unify onto ONE assembler. Single-source-of-truth occupancy compositing. Emit per-layer provenance metadata (feeds UI). Port alpha-erase + union-fill into the survivor; retire the other. Owner files: `design-agent.mjs`, `copy-pipeline.mjs`, `occlusion-fill.mjs`, `inpaint.mjs`.

**Wave 1 — parallel, disjoint files, no GPU:**
- Text/hierarchy: `type-scale.mjs` (new), soften merge, wire `weightFromDensity`. Files: `text-blocks.mjs`, `semantics.mjs`.
- Vector/icons: fix >14 drop, arrow/line detector, route `shape`→vectorizer. Files: `vectorize.mjs`, `icon-match.mjs`, `native-icons.mjs`, element-detect arrow pass.
- Figma-native: grouping + auto-layout inference pre-export pass. Files: `scene-tree`, `figmaClipboard.ts`.
- UI: Copy Inspector + diff overlay (consumes Wave-0 provenance). Files: `Editor.tsx`, new inspector component, server metadata.

**Wave 2 — GPU services on the RTX 5080 (HTTP endpoints, graceful Mac fallback):**
- `segment` service: OmniParser-v2/Florence-2 → SAM2 per-element masks.
- `inpaint` service: LaMa CUDA.
- `fontid` service: visual font classifier vs large TTF DB.
- `iconid` service: CLIP/DINOv2 kNN vs icon library.
- Each wired as optional: endpoint reachable → use it; else current Mac path. New `lib/*-client.mjs` mirroring the ONNX session pattern.

**Wave 3 — Figma plugin** as primary delivery channel (createFrame tree). Clipboard stays fallback.

## Notes
- Subagents: OMIT the `model` param (the sonnet alias is broken in this env — dies instantly). See memory `subagent-model-override-broken`.
- Web tools are broken inside subagents here (route through an unavailable model). Live research must run from the main session or be verified later. SAM 3 availability is UNCONFIRMED — verify before relying on it; SAM 2 is the safe pick.
