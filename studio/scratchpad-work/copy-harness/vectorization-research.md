# Vector Shape Extraction, SVG Generation, and Icon Handling — Research Report

## Executive Summary

The NEUEGEN harness has a well-structured vector shape pipeline — vision detection, pixel-based fallback detection, SVG/canvas/HTML rendering, and Figma export — but three systemic issues undermine it:

1. **Arrow SVG paths are hardcoded and disconnected from renderers.** The extraction generates a filled polygon `<path>` for arrows, but every renderer (canvas, SVG, HTML, Figma) uses `arrowGeometry()` to draw stroked lines with arrowheads. The extracted path data is silently ignored.

2. **`strokeWidth` is set by extraction but never read by renderers.** Extraction writes `style.strokeWidth`; renderers read `style.stroke?.width`. Line stroke widths fall back to a heuristic calculation.

3. **The entire icon extraction pipeline is orphaned.** `icon-extract.mjs` is never imported — `extractIcon`, `detectIconRegion`, `removeBackground`, `cropIcon`, `analyzeShapeComplexity`, and `shouldRasterize` are all dead code. No integration point exists for icons that can't be reproduced as vectors.

---

## 1. Current Issues with Vector Shape Handling

### 1A. Arrow Detection and Path Generation

**Where it happens:** `lib/layout-extract.mjs`, lines 1253–1304 (inside `toSkeletonLayers`).

The extraction has THREE code paths that produce arrow shapes:

1. **Model-reported `shapeKind:'arrow'`** (lines 1258–1268): When the vision model correctly identifies `style.shapeKind` as `"arrow"`.

2. **Keyword fallback** (lines 1274–1281): When the model's `role` or `text` matches `/arrow|pointer|leader\s?line/`.

3. **Pixel-based detection** (lines 1291–1304): When `detectPixelVector()` analyzes the region's real pixels and detects an arrow pattern.

All three produce the **same hardcoded SVG path**:

```javascript
const w = box.w, h = box.h;
const shaftH = Math.max(2, h * 0.04);
const headH = Math.min(h * 0.35, 20);
style.path = `M 0,${h/2 - shaftH/2} L ${w - headH},${h/2 - shaftH/2} L ${w - headH},${h/2 - headH/2} L ${w},${h/2} L ${w - headH},${h/2 + headH/2} L ${w - headH},${h/2 + shaftH/2} L 0,${h/2 + shaftH/2} Z`;
```

**Problems:**

- **Right-pointing only.** This path always draws a right-pointing arrow. A diagonal or vertical arrow from the reference gets a horizontal right-pointing shape that ignores its real direction.

- **Fills a polygon, but renderers draw stroked lines.** The extraction generates a filled `<path>` (a closed polygon), but all three renderers (canvas via `raster.ts`, SVG via `designSvg.ts`, HTML via `Stage.tsx`) check `kind === 'arrow'` BEFORE checking for `kind === 'path'`, and call `arrowGeometry()` to draw a line + arrowhead instead. The extracted `style.path` is completely ignored for arrows.

- **The arrowhead detection is fragile.** `detectPixelVector` (lines 570–589) detects arrows by checking if the foreground width varies by >1.8x along the primary axis and the fill ratio is <0.2. This misses filled arrowheads, small annotation arrows, and multi-stroke arrows.

### 1B. Line Detection

**Where it happens:** `lib/layout-extract.mjs`, lines 1269, 1282–1286, 1302–1304.

When a line is detected (model-reported `shapeKind:'line'`, keyword fallback, or pixel detection), the extraction sets:

```javascript
style.strokeWidth = Math.max(2, Math.round(box.h * 0.08));
```

**Problems:**

- **`strokeWidth` is the wrong property name.** Renderers read `style.stroke?.width`, not `style.strokeWidth`. This means the extracted stroke width is never used — renderers fall back to `Math.max(2, Math.min(w, h) * 0.02)`.

- **Line direction is lost.** The `detectPixelVector` function computes the line's aspect ratio and can tell it's horizontal or vertical, but this information is not stored. The rendering uses `arrowGeometry()` which draws along the box diagonal — so a horizontal line in the reference becomes a diagonal line in the render if the box is not perfectly horizontal.

- **No actual line coordinates.** The pixel detector identifies the foreground as "line-like" but doesn't extract the actual start/end points or angle.

### 1C. Polyline Detection

**Where it happens:** `lib/layout-extract.mjs`, lines 614–626 (detection) and nowhere in `toSkeletonLayers` (no polyline output path).

The `detectPixelVector` function can classify a region as `shapeKind:'polyline'` (quadrant presence heuristic), but:

- **No polyline points are ever extracted.** The detection returns `{ shapeKind: 'polyline', color, confidence }` but `toSkeletonLayers` has no branch that converts this into `style.points` (the flat `[x,y,...]` array renderers expect).

- **The model almost never reports `shapeKind:'polyline'`.** The vision prompt asks for it, but small VL models typically output `shapeKind:'rect'` or nothing for polyline-like regions. The pixel-based fallback detects polylines but can't recover the vertex coordinates from edge-direction analysis alone.

### 1D. Pixel-Based Detection Quality

**Where it happens:** `lib/layout-extract.mjs`, lines 473–629 (`detectPixelVector`).

The function works by:
1. Sampling border pixels to determine background luminance
2. Building a foreground/background edge map (grid-based, ~50 cells per axis)
3. Computing geometric properties (aspect ratio, fill ratio, centroid correlation)
4. Classifying: line (aspect >4 or <0.25 + low fill), arrow (width variation), polyline (quadrant presence)

**Strengths:**
- Zero-dep, deterministic, fast
- Catches simple geometric shapes the model misses
- Color extraction from foreground pixel average is reliable

**Weaknesses:**
- Arrow detection confidence is only 0.65 (line 589) — frequent false positives
- Polyline confidence is only 0.55 (line 624) — more guess than detection
- No direction/angle recovery for lines
- No vertex extraction for polylines
- The grid-based approach (~50 cells per axis) loses fine detail on thin lines

---

## 2. How to Properly Generate SVG Paths for Arrows

### 2A. The Rendering Side Is Already Correct

All three renderers (canvas, SVG, HTML) use `arrowGeometry()` from `fills.ts` (line 86), which computes:
- `x1, y1` → `x2, y2` along the box diagonal
- Two arrowhead wing points at `headLen = max(10, min(len * 0.25, 42))` with spread `PI/7`
- `width = max(2, min(box.w, box.h) * 0.06)`

This is correct and well-tested. **Do not change the rendering.**

### 2B. Fix the Extraction to Match the Renderer

Instead of generating a filled polygon `<path>`, the extraction should set properties that the existing renderers already consume correctly:

```javascript
// For arrow shapes:
style.shapeKind = 'arrow';
style.background = detectedColor;  // the ink color
style.opacity = 1;
// DO NOT set style.path — the renderer uses arrowGeometry() for arrows
// The renderer draws: line from (x1,y1) to (x2,y2) + arrowhead lines

// For line shapes:
style.shapeKind = 'line';
style.background = detectedColor;
style.opacity = 1;
style.stroke = { color: detectedColor, width: detectedWidth };
// The renderer draws: a single stroked line along the box diagonal
```

### 2C. Recommended Code Changes

**File: `lib/layout-extract.mjs`, lines 1258–1304**

Replace the hardcoded arrow path generation with renderer-compatible properties:

```javascript
// BEFORE (lines 1258-1268) — model-reported shapeKind
if (modelShapeKind && ['arrow', 'line', 'polyline', 'rect', 'ellipse'].includes(modelShapeKind)) {
  style.shapeKind = modelShapeKind;
  style.background = HEX_RE.test(String(s.color)) ? String(s.color) : '#111111';
  style.opacity = 1;
  // REMOVE: the hardcoded SVG path — renderer uses arrowGeometry() for arrows
  if (modelShapeKind === 'arrow') {
    // Arrow renderer handles direction via box diagonal + flipDiag
    // Just set the color and shapeKind; no path needed
  } else if (modelShapeKind === 'line') {
    // Set stroke.width correctly so renderers pick it up
    style.stroke = {
      color: style.background,
      width: Math.max(2, Math.round(box.h * 0.08)),
    };
  }
}

// AFTER (keyword fallback, lines 1274-1281):
if (/arrow|pointer|leader\s?line/.test(hay)) {
  style.shapeKind = 'arrow';
  style.background = HEX_RE.test(String(s.color)) ? String(s.color) : '#111111';
  style.opacity = 1;
  // No path needed — renderer draws arrow via arrowGeometry()
} else if (/\bline\b|divider|rule\b/.test(hay)) {
  style.shapeKind = 'line';
  style.background = HEX_RE.test(String(s.color)) ? String(s.color) : '#111111';
  style.opacity = 1;
  style.stroke = {
    color: style.background,
    width: Math.max(2, Math.round(box.h * 0.08)),
  };
}

// AFTER (pixel-detected, lines 1297-1304):
if (pixelVec) {
  style.shapeKind = pixelVec.shapeKind;
  style.background = pixelVec.color || '#111111';
  style.opacity = 1;
  if (pixelVec.shapeKind === 'line') {
    style.stroke = {
      color: style.background,
      width: Math.max(2, Math.round(box.h * 0.08)),
    };
  }
  // No path generation needed for arrow/line — renderers handle it
}
```

### 2D. Diagonal Line Direction (Optional Enhancement)

If you want extracted lines to match the reference's actual angle rather than always rendering along the box diagonal, the `detectPixelVector` function can recover the principal angle from the foreground pixel covariance matrix (lines 596–609 already compute this). Store it as a new property:

```javascript
// In detectPixelVector, after computing covariance:
const angle = Math.atan2(covariance, varianceX); // radians
// Return it:
return { shapeKind: 'line', color: inkHex, confidence: 0.55, angle };

// In toSkeletonLayers:
if (pixelVec.shapeKind === 'line' && pixelVec.angle != null) {
  // Store angle for the renderer (new optional property)
  style.lineAngle = pixelVec.angle;
}
```

This requires a small renderer change to use `lineAngle` when present (rotating the arrowGeometry endpoints), but is not critical for basic functionality.

---

## 3. How to Handle Icons That Can't Be Reproduced as Vectors

### 3A. Current State: Dead Code

`lib/icon-extract.mjs` exports five functions:
- `detectIconRegion()` — find tight icon bounds within a larger box
- `removeBackground()` — threshold-based background removal
- `cropIcon()` — crop with padding, output transparent PNG
- `extractIcon()` — full pipeline: detect → bg remove → crop → write
- `analyzeShapeComplexity()` — edge density / color entropy analysis
- `shouldRasterize()` — decide vector vs raster for an element

**None of these are imported or called anywhere in the codebase.** The icon extraction pipeline is completely orphaned.

### 3B. What the Pipeline Should Do

When the extraction detects a region that is too complex to reproduce as a vector shape (a brand logo, an intricate icon, a multi-color illustration), it should:

1. **Detect the tight icon boundary** (`detectIconRegion`) — trim transparent/matching-background margins
2. **Remove the background** (`removeBackground`) — make near-background pixels transparent
3. **Crop and export** (`cropIcon`) — output a transparent PNG at 2x resolution
4. **Mark as cutout** — the icon becomes an image layer with `cutoutCandidate` pointing at the source, same as avatar/photo cutouts

### 3C. Integration Points

The integration should happen in `toSkeletonLayers` (layout-extract.mjs), after the shape type is determined but before the layer is pushed. The decision tree should be:

```
type === 'shape' AND NOT (rect|ellipse|arrow|line|polyline|starburst)
  → analyzeShapeComplexity(region)
  → IF complex (type === 'complex'):
      → extractIcon(imagePath, box)
      → IF extraction succeeds:
          → Create image layer with src = extracted PNG path
          → Set style.crop or cutoutCandidate to reference the source
      → ELSE:
          → Fall back to the current behavior (translucent rect)
```

### 3D. Recommended Code Changes

**File: `lib/layout-extract.mjs`, near the end of the shape-handling block (after line 1345)**

Add icon extraction integration:

```javascript
// After the existing shape handling, before pushing the layer:
if (type === 'shape' && imagePath) {
  // Check if this shape is too complex for vector reproduction
  const complexity = analyzeShapeComplexity(imagePath, {
    x: clampPct(b.x), y: clampPct(b.y),
    w: clampPct(b.w), h: clampPct(b.h),
  });

  if (complexity && complexity.type === 'complex') {
    // Complex icon/logo — extract as raster PNG
    const iconResult = extractIcon(imagePath, {
      x: clampPct(b.x), y: clampPct(b.y),
      w: clampPct(b.w), h: clampPct(b.h),
    });

    if (iconResult) {
      // Convert to an image layer pointing at the extracted PNG
      const iconLayer = {
        id: `${id}-icon`,
        type: 'image',
        role: String(l?.role || 'icon').slice(0, 24),
        name: `${String(l?.text || 'Icon').slice(0, 20)} (extracted)`,
        box,
        src: iconResult.path, // local file path
        fit: 'contain',
        style: {
          background: 'transparent',
          opacity: 1,
        },
      };
      layers.push(iconLayer);
      continue; // skip the vector shape layer
    }
  }
}
```

**File: `lib/icon-extract.mjs`** — no changes needed to the module itself; it's correct. Just needs to be imported.

**Import at top of `lib/layout-extract.mjs`:**

```javascript
import { extractIcon, analyzeShapeComplexity } from './icon-extract.mjs';
```

### 3E. Alternative: Use cutoutCandidate for Icons

A cleaner approach that reuses the existing cutout mechanism:

```javascript
if (complexity && complexity.type === 'complex') {
  // Mark as a cutout candidate — the source region will be cropped from the reference
  shapeLayer.cutoutCandidate = {
    region: {
      x: Math.round(clampPct(b.x)) / 100,
      y: Math.round(clampPct(b.y)) / 100,
      w: Math.round(clampPct(b.w)) / 100,
      h: Math.round(clampPct(b.h)) / 100,
    },
    shape: 'rect',
  };
  cutoutCount++;
  // Keep the shape layer as a fallback (the tinted rect) until cutout is applied
  layers.push(shapeLayer);
  continue;
}
```

This is simpler because:
- No new PNG writing needed at extraction time
- The cutout is applied later in `runCopyReference` (design-agent.mjs line 2894) using the reference image directly
- The existing auto-cutout mechanism handles it

---

## 4. Summary of Recommended Fixes

### Fix 1: Remove hardcoded arrow SVG paths (HIGH PRIORITY)

**File:** `lib/layout-extract.mjs`, lines 1263-1267, 1277-1281, 1297-1301

Remove the three instances of:
```javascript
style.path = `M 0,${h/2 - shaftH/2} L ${w - headH},${h/2 - shaftH/2} ...`;
```

The renderers already handle arrows via `arrowGeometry()`. Setting `style.path` for arrows is dead data — it's never consumed because `kind === 'arrow'` is checked before `kind === 'path'`.

### Fix 2: Use `style.stroke` instead of `style.strokeWidth` (HIGH PRIORITY)

**File:** `lib/layout-extract.mjs`, lines 1269, 1286, 1303

Change:
```javascript
style.strokeWidth = Math.max(2, Math.round(box.h * 0.08));
```
To:
```javascript
style.stroke = {
  color: style.background || '#111111',
  width: Math.max(2, Math.round(box.h * 0.08)),
};
```

Renderers read `s.stroke?.width` (raster.ts line 296, designSvg.ts line 247). The current `style.strokeWidth` property is ignored.

### Fix 3: Remove duplicate `shouldRasterize` (LOW PRIORITY)

**File:** `lib/icon-extract.mjs`, lines 624-682

The `shouldRasterize` function in `icon-extract.mjs` duplicates the one in `elements.mjs` (lines 1711+). Since `icon-extract.mjs` is never imported, this is dead code. Either:
- Delete the duplicate from `icon-extract.mjs`
- Or consolidate: have `elements.mjs` re-export from `icon-extract.mjs`

### Fix 4: Wire up icon extraction (MEDIUM PRIORITY)

**Files:** `lib/layout-extract.mjs` (add import + integration), `lib/icon-extract.mjs` (already correct)

Import `extractIcon` and `analyzeShapeComplexity` from `icon-extract.mjs`, and add the complexity check + cutout candidate path in `toSkeletonLayers` for shape regions that don't match simple vector patterns.

### Fix 5: Improve polyline point extraction (LOW PRIORITY, FUTURE)

The `detectPixelVector` function can detect polylines but can't recover vertex coordinates. A proper fix would add a contour-tracing algorithm (e.g., marching squares on the foreground mask) to extract the actual polyline vertices. This is a significant algorithmic addition and should be a separate task.

---

## 5. Files Referenced

| File | Role |
|---|---|
| `lib/layout-extract.mjs` | Vision extraction + pixel-based vector detection + skeleton building |
| `lib/icon-extract.mjs` | Icon extraction pipeline (orphaned — never imported) |
| `lib/design-agent.mjs` | Agent ops, cutout application, skeleton-to-doc conversion |
| `lib/design-lint.mjs` | Design validation (no shape-specific checks) |
| `lib/elements.mjs` | Element library + `shouldRasterize` (the live copy) |
| `src/components/design/fills.ts` | `arrowGeometry()` — the shared arrow/line geometry |
| `src/components/design/raster.ts` | Canvas rendering of shapes |
| `src/components/design/designSvg.ts` | SVG export of shapes |
| `src/components/design/Stage.tsx` | HTML/React rendering of shapes |
| `src/components/design/figmaClipboard.ts` | Figma native clipboard export |
| `src/lib/sceneGraph.ts` | Layer types, ShapeKind union, style schema |
