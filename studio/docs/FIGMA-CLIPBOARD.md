# Copy to Figma as native layers

`copyForFigma(doc)` (src/components/design/figmaClipboard.ts) puts a design on the clipboard
so that ⌘V in Figma recreates it as layers. Two paths, best first:

| method | what lands in Figma | when used |
| --- | --- | --- |
| `figma-native` | Real nodes: frame, rectangles, image fills, TEXT nodes with font/size/align/case | default |
| `svg` | Figma's SVG importer output — editable vectors, text as one `<text>` per wrapped line | any native-path failure |

## How Figma's clipboard format works

Copying in Figma writes `text/html` shaped like:

```html
<meta charset="utf-8">
<span data-metadata="<!--(figmeta)BASE64_JSON(/figmeta)-->"></span>
<span data-buffer="<!--(figma)BASE64_ARCHIVE(/figma)-->"></span>
```

- **figmeta** — JSON `{ fileKey, pasteID, dataType: "scene" }`.
- **figma buffer** — a `.fig`-style archive: 8-byte magic `fig-kiwi`, uint32 LE version (46),
  then length-prefixed chunks. Chunk 0 is the deflate-raw-compressed **kiwi binary schema**;
  chunk 1 is the deflate-raw-compressed **kiwi message** (a `NODE_CHANGES` Message with a
  `nodeChanges` list: DOCUMENT → CANVAS → your nodes, each with `guid`, `parentIndex`
  (fractional-index `position` string), `type`, `size`, `transform`, `fillPaints`, text
  fields, …). The payload is self-describing: Figma decodes it with the embedded schema, so a
  writer just needs a valid captured schema chunk. Kiwi is Evan Wallace's format
  (github.com/evanw/kiwi); the npm packages `fig-kiwi` and the repo
  `interlace-app/fig-kiwi-toolbox` document the container.
- **Images** are embedded inline: `Paint.image.dataBlob` is an index into `Message.blobs`,
  whose entries are the raw PNG/JPEG bytes; `image.hash` is the SHA-1 of those bytes.

## What we implemented

- `src/vendor/figma-kiwi/` — schema chunk (captured byte-for-byte from a real Figma copy,
  format v46, via fig-kiwi-toolbox's published sample; see its README for provenance) +
  a small archive/HTML encoder-decoder on top of `kiwi-schema` and `pako` (both MIT,
  frontend-only deps added to package.json).
- `buildFigmaMessage(doc, images)` — pure scene-graph → NODE_CHANGES mapping:
  - root FRAME sized to the canvas with a black fill (parity with raster.ts background);
  - image layers → ROUNDED_RECTANGLE with an IMAGE fill, bytes embedded via `dataBlob`,
    `FILL`/`FIT` for cover/contain;
  - shape layers → ROUNDED_RECTANGLE, solid or 2-stop GRADIENT_LINEAR fading to transparent;
  - text/badge/button → optional background rectangle + a fixed-size TEXT node
    (`textAutoResize: NONE`, vertical CENTER — Figma re-wraps the text itself), font
    "Geist" with weight-mapped style name, `UPPER` text case, PERCENT line-height,
    PIXELS letter-spacing, drop-shadow effect when `style.shadow`;
  - hidden layers skipped; per-layer opacity carried over.
- `src/components/design/designSvg.ts` — self-contained SVG mirroring raster.ts exactly
  (same `wrapText`, same 0.82em baseline & centering math, cover/contain via
  `preserveAspectRatio` slice/meet + clipPath, gradient defs, data-URL images,
  feDropShadow for text shadows).

## Verified vs untested — honest status

**Verified (automated):**
- kiwi roundtrip: our encoded payload decodes back (using only the embedded schema, the way
  Figma reads it) with identical node count, types, text characters, fonts, enums, gradient
  stops, opacity and image blob bytes. Run during development via a node script; the same
  decode check also runs at runtime before every clipboard write.
- `npx tsc --noEmit` and `npm run build` pass.

**Untested (needs a human with Figma):**
- An actual ⌘V into the Figma editor. The payload matches the observed real-copy structure
  (we omit derived data like glyph outlines and vector-network blobs, which Figma should
  recompute), but Figma's tolerance for a 2023-era schema version and for minimal TEXT
  nodes has not been confirmed here.
- Gradient direction convention (`Paint.transform`) — worst case a fade is flipped.
- Whether Figma has the Geist font; if not it pastes with a missing-font warning
  (layout intact once the font is set).

If the native paste ever misbehaves, the immediate workaround is the SVG path (it is also
what you get automatically when the native path throws).

## Manual test steps

1. Open the studio, load a comp with an image, a gradient shape, and some text layers.
2. Trigger `copyForFigma(doc)` (from whatever UI hook wires it up, or the dev console:
   `await copyForFigma(useStore.getState().doc)` equivalent). Note the returned `detail`.
3. In Figma (desktop app or browser), open any design file and press ⌘V.
   - `detail: "native Figma layers"` → expect a frame named after the comp containing
     rectangles/images/text as separate, individually editable nodes. Check: image fills
     present, text is a TEXT node (not outlines), corner radii and opacity correct,
     gradient fade direction correct.
   - `detail: "SVG — paste as editable vector layers"` → expect Figma's SVG import: a group
     with rects/images/text lines.
4. Force the fallback to test it: in devtools, temporarily block clipboard `write`
   (or run in a browser without ClipboardItem HTML support) and repeat — the SVG path
   must always produce a paste-able result.
5. Cross-check fidelity against the PNG export of the same comp.
