# NEUEGEN Studio — Architecture

Local ad-production studio: plan competitor-informed ad batches, generate images through the
codex/ChatGPT engine, and assemble finished ad comps in a Figma-grade design editor that a very
small LLM can also drive. One zero-dependency Node server (`studio-server.mjs`, port 8788) serves
the built React app, the JSON APIs, the SSE event stream, and owns all state on disk.

```
studio/
├── studio-server.mjs      HTTP + SSE server (node:http only — the backend has ZERO npm deps)
├── lib/                   server-side modules (plain .mjs, zero-dep)
├── src/                   React 18 + TypeScript + Vite frontend
├── scripts/               node test scripts (figma roundtrip, element gauntlet …)
└── .state/                ALL persistent state (gitignored)
```

## The document model — scene graph v3

`src/lib/sceneGraph.ts` is the single contract everything renders from.

- A **DesignDoc** ("comp") = fixed-size canvas + a TREE of `SceneNode`s in paint order
  (bottom → top). Leaves are `Layer`s (image / text / badge / button / shape / vignette);
  `GroupNode`s nest arbitrarily (Figma-style).
- **Child coordinates are ABSOLUTE canvas coordinates.** A group is only a
  selection/opacity/ordering construct whose `box` is the cached bounding box of its children
  (`normalizeGroups` in `src/lib/sceneTree.ts` recomputes it after every commit). This one
  decision keeps all renderer geometry flat and identical.
- **autoH text**: `Layer.autoH` marks text whose `box.h` is derived from wrapped content.
  The Editor re-measures on every commit via the ONE shared wrap implementation
  (`src/components/design/textMetrics.ts`), persists the height, and therefore no other
  renderer ever measures text — and text can never clip.
- Styling: gradients (`resolveGradient` normalizes legacy `'to-top'` strings), vignette,
  stroke, blend modes, layer blur + backdrop blur (glass), per-corner radius, rotation
  (degrees about box center), shape kinds (rect/ellipse/starburst/arrow/line/polyline),
  IG-caption `pill` mode (per wrapped line hugs its own rounded background).
- `Layer.figma` is a lossless passthrough: anything imported from Figma that we can't render
  rides along untouched and is re-emitted on copy-back.
- `migrateDoc` upgrades v2 flat docs on load (a flat Layer[] is already a valid tree).

## Five renderers, one contract

Any styling feature must land in ALL of these (grep "PARITY" for the duplication points):

| Renderer | File | Used for |
|---|---|---|
| Stage (DOM) | `src/components/design/Stage.tsx` | the live editor canvas |
| Raster (canvas 2D) | `src/components/design/raster.ts` | PNG export + gallery thumbnails |
| SVG | `src/components/design/designSvg.ts` | vector export + Figma SVG-paste fallback |
| Server HTML | `lib/designstore.mjs renderDesignHtml` | standalone previews/exports |
| Figma clipboard | `src/components/design/figmaClipboard.ts` | native ⌘V into Figma |

Shared math lives in `src/components/design/fills.ts` (gradient serializers, starburst points,
arrow geometry, vignette stops) and `textMetrics.ts` (wrap + block height). The server-side
`.mjs` duplicates the tiny CSS serializers with parity comments (it can't import TS).

## Figma round-trip

`figmaClipboard.ts` encodes a genuine Figma clipboard payload (kiwi schema, vendored in
`src/vendor/figma-kiwi/`): nested FRAMEs for groups, gradient/radial paints, BACKGROUND_BLUR
(glass), LAYER_BLUR, blend modes, masks, textAutoResize, per-corner radii, STAR/LINE/ELLIPSE
nodes. `figmaImport.ts` decodes a paste FROM Figma back into SceneNodes (unknown node types
become locked placeholders; unknown fields go into the `figma` passthrough).
`scripts/figma-roundtrip.test.mjs` asserts the whole loop.

## The design agent (small-model-first)

- `lib/llm.mjs` — provider-agnostic OpenAI-compatible client. Env: `LLM_BASE_URL`
  (default DeepSeek), `LLM_MODEL` (default `deepseek-v4-flash`), `LLM_API_KEY`/`DEEPSEEK_API_KEY`.
  Point it at LM Studio with `LLM_BASE_URL=http://localhost:1234/v1` — nothing else changes.
  Every call logs tokens to `.state/llm-usage.jsonl` (`GET /api/llm/usage` for rollups).
- `lib/agent-harness.mjs` — ONE op per turn, tolerant JSON parse, one retry with the error
  echoed, skip-then-stop. Context per turn = system prompt (≤ ~900 tokens incl. the element
  catalog) + compact op log + a compressed observation (short ids, non-default styles only,
  element groups collapsed) — ≤ ~2.5k tokens so a 9B model with a small window survives.
- `lib/design-agent.mjs` — validates/applies ops (`move/resize/setText/setStyle/align/add/
  remove/group/ungroup/element/setParams/done`), auto-repairs sloppy output instead of
  rejecting it, clamps everything inside the canvas. Context: brief copy, reference-ad text,
  brand kit, workspace memory, attached-image descriptions. `mode:'improve'` runs a
  deterministic lint (overlaps, edge-hugging, contrast, hierarchy) and hands the model a
  concrete numbered fix list. Fallback chain: LLM → codex CLI → deterministic layout.
- Vision (reading reference ads) stays on the codex CLI (`lib/layout-extract.mjs`) until
  DeepSeek ships API image input; extraction results are cached as Skeletons forever.

## Parametric elements

`lib/elements.mjs` (shared server+client; `src/components/design/elements.ts` re-exports it)
is a registry of `ElementDef`s with typed `ParamSpec`s. `buildElement(id, doc, params, kit)`
coerces params (auto-repair, brand-kit color/font prefill), builds pure SceneNodes, and stamps
`node.element = {id, params, v:1}` so both the Editor's auto-generated param form and the
agent's `setParams` op can rebuild an instance in place (bounds preserved via `scaleNodeInto`).
Composites (x-post, notes-card, review-row, charts, receipt, comparison table …) are built
ONLY from the shared primitives, so every renderer and the Figma export work for free.

## Server state (`.state/`)

designs/ (docs + thumb PNGs) · skeletons/ · elements.json · brandkits/ · agent-chats/ ·
memory/ (per-brand notes) · refs/ (uploads + cached vision descriptions) · trendtrack-cache/
(1 credit per row — local search is free, live import is explicit) · llm-usage.jsonl ·
daily-cap.json · taste.json · jobs.json.

SSE channels on `/events`: `state`/`queue` (jobs), `plan` + `design` (agent step streams),
`doc` (any design/skeleton/element/brandkit change → live cross-tab sync).

## Conventions

- Backend stays zero-dep ESM (`node:*` only). Frontend deps are allowed.
- Every file opens with a header comment explaining its role and invariants; cross-file
  duplication points carry a `PARITY:` comment naming their twins.
- Undo/redo = whole-doc JSON snapshots; the Stage streams gestures with `commit=false`
  frames and exactly one `commit=true`, so one gesture = one undo step.
- Workspace scoping: docs/skeletons/brand kits carry `brand`; lists filter server-side.
