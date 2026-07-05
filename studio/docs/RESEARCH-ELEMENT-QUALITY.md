# Research: Element Quality — vectorization, cutouts, Figma hygiene, platform glyphs

Date: 2026-07-05. Scope: reference-ad pipeline (lib/layout-extract.mjs → lib/design-agent.mjs → HTML render → src/components/design/figmaClipboard.ts kiwi export). Read-only research; no code changed.

---

## 1. Vectorization of small raster regions (icons/logos → shapeKind:'path')

**Verdict: ADOPT — imagetracerjs, with potrace as B/W fallback. Skip vtracer (no maintained npm/wasm binding).**

| Package | Version | License | Notes |
|---|---|---|---|
| `imagetracerjs` | 1.2.6 | Unlicense | Pure JS, zero deps, runs in Node AND browser. Color-capable. |
| `@image-tracer-ts/core` | 1.0.2 | MIT | TS rewrite of imagetracerjs, same algorithm/options; nicer types. Either works. |
| `potrace` | 2.1.8 | **GPL-2.0** | Node port (jimp-based). Best-quality curves but B/W only (1 fill per trace) and GPL is a distribution risk — keep server-side only or skip. |
| vtracer (Rust) | — | — | Best-in-class color tracing (visioncortex), but npm bindings (`vtracer` 1.0.8, `vtracer-wasm` 0.1.0) are unmaintained toys. Skip unless we shell out to the `vtracer` CLI binary (viable later; adds a native dep). |

**API sketch (imagetracerjs, Node):**
```js
import ImageTracer from 'imagetracerjs';
// imageData = { width, height, data: Uint8ClampedArray } (RGBA) — get via sharp/canvas
const svg = ImageTracer.imagedataToSVG(imageData, {
  numberofcolors: 4,      // ← biggest lever: flat icons need 2–6 colors, not 16
  colorquantcycles: 3,
  pathomit: 12,           // ← drop tiny speckle paths (in px) — kills noise layers
  ltres: 1, qtres: 1,     // line/quad fit tolerance — raise to 2 for fewer nodes
  roundcoords: 2,
  blurradius: 0,          // pre-blur 1–2 helps JPEG-noisy crops
});
// or ImageTracer.imagedataToTracedata(...) → per-color path arrays (better for our
// scene graph: one Layer per color, style.path = d-string normalized to the box).
```
Path-count control = `numberofcolors` (dominant), `pathomit` (speckle filter), `rightangleenhance`. For a 2-color checkmark badge expect 2–4 paths.

**Integration point:** new `lib/vector-trace.mjs`; called from `lib/design-agent.mjs` where small photo regions are classified (near the cutout/crop decision, ~line 1360 `shape === 'circle'` branch): if a crop region is small (≤ ~8% canvas) and low color-count, emit `shapeKind:'path'` layers instead of an image crop. Render already works (`designSvg.ts:219` path branch); Figma export currently degrades to rect+pluginData (see §3 — pair with the VECTOR fix or accept the pluginData round-trip).
**Effort:** M (S for the tracer itself; M with region classification + normalization to 0..1 box).
**Risk:** Low-medium — photographic/gradient regions trace badly; gate on a color-count heuristic and fall back to cutout.

---

## 2. Background removal — true subject cutouts

**Verdict: ADOPT — `@imgly/background-removal-node` 1.4.5 server-side; browser path already exists.**

- Already shipped in-browser: `src/lib/bgRemoval.ts` dynamically imports `@imgly/background-removal` ^1.7.0 (used by graveyarded `ImageActions.tsx`; the plumbing is alive and tested — ~40MB isnet model from imgly CDN, PNG-with-alpha out).
- Node package: `@imgly/background-removal-node` 1.4.5, deps `onnxruntime-node` + `sharp`. API mirrors the browser one: `removeBackground(input, config) → Blob(PNG)`. **License: "SEE LICENSE" — imgly dual-licenses (AGPL-style / commercial); verify before shipping server-side in a product.** If license is a blocker: run the same isnet/u2net ONNX via `onnxruntime-node` directly, or `rembg` python subprocess (MIT).
- **STATUS (2026-07): implemented in `lib/matte.mjs` (`matteCutout`).** The browser variant was already a repo dependency (`src/lib/bgRemoval.ts`), so adding the node variant leaves our licensing posture unchanged — but commercial distribution still requires the IMG.LY commercial-license check before shipping.
- Cutout layers today carry `{src, style.crop}`; figmaClipboard `cutoutBitmap()` (line ~1132) already bakes crop + shape-as-alpha into a real transparent PNG. Background removal slots in as one extra step: after the crop bake, run the cropped bitmap through removeBackground and use the matte'd PNG as the baked bytes. Zero scene-graph schema change — optionally add `style.matte: true` so agents/UI can toggle it.

**Integration sketch:**
1. `lib/` (server, studio-server.mjs image route or a new `lib/cutout-matte.mjs`): on request, crop via sharp using `style.crop`, feed to `removeBackground`, cache result keyed by `(srcHash, crop)`.
2. `design-agent.mjs` (~line 1368 shape mapping): let the vision model mark subjects `shape:'subject'` → sets `style.matte`; rect/circle stay as-is.
3. Figma export: nothing new — baked PNG path already treats cutouts as plain IMAGE-fill rects.

**Effort:** M. **Risk:** Medium — model download size, license review, occasional halo/edge artifacts on busy ads (mitigate: keep rect crop as instant fallback, matte on demand).

---

## 3. Figma layer hygiene (figmaClipboard.ts audit)

**Verdict: ADOPT targeted consolidation; the big win is real VECTOR nodes.**

What multiplies layers today (all in `src/components/design/figmaClipboard.ts`):
- **`shapeKind:'path'` → ROUNDED_RECTANGLE + pluginData** (`emitSceneNode` line 863–876): every traced icon/wave/blob pastes as a *rectangle* named "… (path)". Not extra layers, but wrong layers — and it makes §1 output look broken in Figma. The blocker is documented: Figma VECTOR needs `vectorData.vectorNetworkBlob`, an opaque binary the kiwi schema doesn't describe. Options: (a) reverse the blob format (it is partially documented in the community — figma-to-json/fig-kiwi projects decode vectorNetwork blobs; effort M, highest payoff), (b) paste-as-SVG sidecar for icon layers, (c) live with pluginData round-trip.
- **`emitPolyline` (line 514–570): one FRAME + one LINE node per segment.** A 10-point squiggle = 11 nodes. Consolidation: same vectorNetworkBlob fix, or collapse to a single LINE when points are collinear, or cap agent-side polyline point counts.
- **Pill captions (line ~894+): one rect + one text PER WRAPPED LINE inside a FRAME.** 4-line caption = 9 nodes. Acceptable (matches IG look) but could be a component.
- **Mosaic/pixelate is already clean** — baked into PNG bytes (`pixelateBitmap`, line 1065), not emitted as cells. Good.
- Starburst → native STAR (line 881), ellipse/rect → single nodes, shadows → effects not extra rects. Good.

**Effort:** M (vectorNetworkBlob) / S (polyline collapse + naming). **Risk:** Medium for the blob (undocumented format; test against Figma versions), low for the rest.

---

## 4. Platform-chrome glyphs

**Verdict: ADOPT — resurrect + extend the graveyarded exact-path set; add simple-icons for brand marks.**

Current state:
- `src/graveyard/nativeIcons.ts` — GOOD exact 0..1-normalized paths already drawn and abandoned: `TWITTER_ICONS` (reply, repost, likeOutline/Filled, bookmarkOutline/Filled, share, verifiedBadge, more, back), `INSTAGRAM_ICONS` (heartOutline/Filled, comment, repost, share, bookmarkOutline/Filled, more, verifiedBadge), `IOS_ICONS` (back chevron, check, circleUnchecked). `lib/native-components/x-post.mjs:62` even has a TODO to swap these in.
- Live inventory is only the 24 generic Feather-style `ICONS` in `lib/elements.mjs:316+` (check, x, star, heart, arrows…) — these are the "approximations" the owner sees. Plus `lib/notes-icons.mjs` (Apple Notes chrome) and `lib/instagram-colors.mjs`.
- Missing after resurrection: X "views/analytics" bar icon, iOS forward chevron + share-sheet glyph, Facebook like/comment/share row, TikTok side-rail (heart/comment/bookmark/share), Trustpilot star box (exact `#00B67A` already noted in research memory).

Sources: `simple-icons` 16.25.0 (CC0-1.0) exposes exact brand glyph `path` per brand (`siTiktok.path` etc., 24×24 viewBox → divide by 24 to normalize) — use for logos/brand marks. Platform *UI* chrome (action rows, chevrons) isn't in simple-icons; keep hand-tracing into nativeIcons format (SF Symbols are NOT redistributable — recreate as beziers, which `IOS_ICONS.back` already does).

**Integration point:** move `nativeIcons.ts` out of graveyard → shared module consumed by `lib/native-components/*.mjs` and merged into the `ICONS` enum in `lib/elements.mjs`; add `simple-icons` as a build-time import (tree-shakeable per-icon).
**Effort:** S–M. **Risk:** Low (paths exist; only wiring + a dozen new glyphs).

---

## TOP 5 (ranked)

1. **Resurrect `graveyard/nativeIcons.ts` into `lib/` icon registry + add `simple-icons` (CC0) brand paths** — S effort, immediately kills the "approximated chrome" complaint; x-post.mjs already has the TODO.
2. **Server-side subject mattes via `@imgly/background-removal-node`** hooked into the existing `cutoutBitmap` bake (crop → matte → alpha PNG), `style.matte` flag, rect-crop fallback — M effort; solves complaint (2) with zero Figma-side changes. Verify imgly license first.
3. **Real Figma VECTOR export for `shapeKind:'path'`** by building `vectorNetworkBlob` (fig-kiwi / figma-to-json document the blob) — M effort; upgrades every icon/wave/blob from "(path)" rectangles to editable vectors; also fixes polyline segment spam.
4. **Icon vectorization with `imagetracerjs` (`imagedataToTracedata`, numberofcolors≤6, pathomit≥12)** for small flat-color reference regions → `shapeKind:'path'` layers instead of raster crops — M effort; depends on #3 to look right in Figma.
5. **Polyline consolidation + layer naming pass in figmaClipboard** (collapse collinear segments, cap points, component-ize caption pills) — S effort, incremental hygiene win.
