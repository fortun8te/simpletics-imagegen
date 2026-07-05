# Extraction Accuracy Analysis — NEUEGEN Harness

**Files analyzed:**
- `lib/layout-extract.mjs` (3559 lines)
- `lib/design-agent.mjs` (3043+ lines)
- `lib/elements.mjs` (1792 lines)
- `lib/design-verify.mjs` (197 lines)

---

## Executive Summary

The extraction pipeline has **10 specific issues** causing incorrect preset application and inaccurate element copying. The problems cluster into five categories: text extraction accuracy, element position/size accuracy, color accuracy, font weight/style accuracy, and group structure issues. Most issues have deterministic root causes with clear fixes — they are NOT model-quality limitations but rather insufficient post-processing of what the model does get right.

---

## 1. Font Weight Accuracy — Default Falls to 600 (layout-extract.mjs:1231)

**File:** `lib/layout-extract.mjs`
**Line:** 1231

```js
fontWeight: Math.min(900, Math.max(300, Math.round(Number(s.fontWeight) || 600))),
```

When the vision model omits `fontWeight` (common with small VL models), the default is **600**. This is wrong for:
- **Headlines** — should be 800 (heavy display weight)
- **Body text** — should be 400-500
- **Subheads** — should be 500-600 (happens to land right, but by accident)

The PROMPT at line 675 instructs "800-900 for heavy display headlines, 700 bold, 400-500 body" but small models ignore this nuance and return 600 for everything.

**Impact:** Headlines appear at medium weight instead of heavy; body text appears too bold. Visual hierarchy collapses.

**Fix:** Add a role-based weight heuristic after the default. When `fontWeight === 600` (the default) and the role is known, override:
- `headline|title|price|badge` → 800
- `cta|button` → 700
- `caption|subhead|subline` → 500

This is safe because 600 is the explicit fallback when the model doesn't provide a value — we only override when the model didn't give a deliberate signal.

---

## 2. Emoji Text Color Skip Is Too Aggressive (layout-extract.mjs:1221-1222)

**File:** `lib/layout-extract.mjs`
**Lines:** 1221-1222

```js
const hasEmoji = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u.test(String(l.text));
if ((isPureDefault || !HEX_RE.test(String(s.color))) && !hasEmoji) {
  const sampled = sampleGlyphColor(imagePath, b);
```

When text contains **any** emoji, the entire color sampling is skipped. This means text like `"WAT. EEN. JAAR. 🥹🤝"` gets the model's default `#ffffff` or `#000000` even when the non-emoji glyphs are a brand color.

The guard was added because emoji pixels "poison" the sample (returning brown from multicolor emoji). But the fix is too broad — a 20-word caption with one emoji at the end loses all color recovery.

**Impact:** Any text containing emoji loses its real glyph color, falling back to pure black/white.

**Fix:** Instead of skipping entirely when emoji is present, raise the contrast threshold for the minority-cluster sampling (the existing `sampleGlyphColor` already splits pixels by luminance). Emoji blobs are high-luminance-variance noise; a higher contrast floor (e.g. 0.25 instead of the default 0.12) filters them out while preserving real glyph color. Alternatively, only skip when >50% of characters are emoji.

---

## 3. `isPureDefault` Check Is Too Narrow (layout-extract.mjs:1217)

**File:** `lib/layout-extract.mjs`
**Line:** 1217

```js
const isPureDefault = /^#(fff|ffffff|000|000000)$/i.test(textColor);
```

This only triggers color recovery on exact `#fff`, `#ffffff`, `#000`, or `#000000`. The model also commonly returns near-pure defaults like `#f0f0f0`, `#111111`, `#222222`, `#e0e0e0`, or `#f5f5f5`. These pass the regex check and are treated as "real" colors, even though they're lazy guesses.

**Impact:** Text that is actually a warm amber (#e8a838) or teal (#2c8c8c) gets stuck with #111111 because the model reported a near-black default.

**Fix:** Expand the check to include luminance-based detection: if the color's luminance is within 0.05 of pure white (1.0) or pure black (0.0), treat it as a default and attempt pixel sampling:
```js
const isDefault = isPureDefault || (() => {
  const lum = hexLuminance(textColor);
  return lum != null && (lum > 0.95 || lum < 0.05);
})();
```

---

## 4. `sanitizeGeometry` Only Separates Text-vs-Text (layout-extract.mjs:2109)

**File:** `lib/layout-extract.mjs`
**Lines:** 2109-2127

```js
const texts = list.filter(isTextLayer);
// ... only text layers are de-overlapped
```

The de-overlap pass only handles **text-vs-text** overlaps. When a text layer overlaps a shape or image layer by >30%, nothing happens. The text ends up visually colliding with the shape — on top of a card background without proper spacing, or behind a product image.

**Impact:** Text placed on top of product images or card backgrounds appears unreadable. The reference shows clear separation but the extraction piles elements together.

**Fix:** Expand the overlap check to include text-vs-shape and text-vs-image overlaps. When a text layer overlaps a non-text layer, push the **text** away (not the shape), since text is the overlay that should be repositioned. The existing `isTextLayer` filter should become `isMovableLayer` that includes shapes/images with `role !== 'base'`.

---

## 5. Text Fit Shrink Loop Can Over-Shrink (layout-extract.mjs:1384-1401)

**File:** `lib/layout-extract.mjs`
**Lines:** 1384-1401

```js
const glyph = style.fontWeight >= 700 ? 0.55 : 0.52;
// ...
while (style.fontSize > 18 && wrap(style.fontSize) > box.h * 1.15 && guard++ < 24) {
  style.fontSize = Math.round(style.fontSize * 0.92);
}
```

The glyph estimation factor (0.52-0.55) is **optimistic** for condensed fonts, uppercase text with tracking, and certain character sets. This means the wrap calculation thinks text is wider than it actually is, triggering premature font shrinking. A headline that should be 60px can shrink to 18px (the floor).

The loop runs up to 24 iterations with a 0.92 shrink factor — that's a potential reduction to ~15% of the original size.

**Impact:** Headlines at 6+ fontSizePct can be shrunk to 2-3% on narrow canvases. Text that the reference shows at a readable size comes out tiny.

**Fix:**
1. Use a more conservative glyph factor: `fontWeight >= 800 ? 0.52 : fontWeight >= 700 ? 0.54 : 0.50` (wider estimates = fewer false wraps)
2. Raise the floor from 18 to 24 (text below 24px at 1080w is almost never intentional in social ads)
3. Cap shrink iterations at 8 (if font needs >8 shrink steps, the box estimate is wrong, not the font)

---

## 6. Element `setStyle` Bypasses Builder Intent (design-agent.mjs:1129-1134)

**File:** `lib/design-agent.mjs`
**Lines:** 1129-1134

```js
if (node.sizeLocked) {
  const safe = new Set(['rotation', 'opacity', 'autoH']);
  const blocked = Object.keys(op.style).filter((k) => !safe.has(k));
  if (blocked.length) {
    throw new Error(`${aliasOf(node.id)} is element-built — use {"op":"setParams"}...`);
  }
}
```

The `sizeLocked` guard only protects **individual text leaves** inside an element, not the **element group** itself. When the agent runs `setStyle` on the element group node (the parent wrapper), `sizeLocked` is not set on the group — only on its children. This means the agent can change the group's style properties (background, radius, etc.) without going through `setParams`, creating an inconsistent state between the element's params and its rendered style.

Additionally, when `setParams` is called to rebuild an element, it rebuilds from the element's stored params — any `setStyle` changes made directly to children are overwritten.

**Impact:** Element style edits create inconsistent states. `setParams` rebuilds undo the agent's style changes. Users see their edits disappear when the element is rebuilt.

**Fix:** In the `element` case of `applyOp`, also stamp `sizeLocked` on the element group node itself (not just its children). Then the `setStyle` guard catches edits on the group too. The `setParams` handler should preserve any `setStyle` overrides by merging them back after rebuild.

---

## 7. Product Tint Opacity Makes Products Invisible (layout-extract.mjs:1181)

**File:** `lib/layout-extract.mjs`
**Line:** 1181

```js
background: `${tint}${blurred ? 'bf' : '59'}`,
```

Product placeholder shapes use `#9aa0a659` — a 35% opacity gray tint. On a white or light background, this is nearly invisible. On a dark background, it's a faint ghost. The opacity was chosen to be "subtle" but is too low for the extracted comp to be readable as a design.

The comment at line 1118-1121 says "a FAITHFUL placeholder... tinted with the product's dominant color" — but the 35% opacity means the dominant color is barely visible.

**Impact:** Product regions appear as faint, almost invisible ghosts instead of visible placeholders. The extraction looks empty/unfinished compared to the reference.

**Fix:** Use higher opacity (0.7-0.85) for product placeholders, or use the tint as a solid fill with a contrasting label. The existing stroke (`Math.max(2, Math.round(box.w * 0.008))`) helps define the edge, but the fill opacity is the primary visual.

---

## 8. No Element Consistency Check in Verify (design-verify.mjs)

**File:** `lib/design-verify.mjs`
**Lines:** 157-181

The `verifyDesign` function checks layout score, readability, lint, skeleton IoU, and layer structure — but does **NOT** check:
- Whether element instances have consistent params vs. rendered styles
- Whether text weights match their roles
- Whether font sizes are proportional to their declared roles

An element with `fontWeight: 400` on a headline (should be 800) passes all verification checks.

**Impact:** Incorrect element styling ships without any quality gate catching it.

**Fix:** Add an element consistency check to `verifyDesign`:
```js
// Check element text children have expected weight ranges
walkNodes(doc.layers || [], (n) => {
  if (n.element && n.element.id && n.style?.fontSize) {
    const role = String(n.role || '').toLowerCase();
    if (role === 'headline' && n.style.fontWeight < 700) issues.push('headline weight < 700');
    if (role === 'caption' && n.style.fontWeight > 600) issues.push('caption weight > 600');
  }
});
```

---

## 9. Two-Step Read Has No Cross-Validation (layout-extract.mjs:2499-2514)

**File:** `lib/layout-extract.mjs`
**Lines:** 2499-2514

```js
layers: [...structLayers, ...textLayers].slice(0, MAX_LAYERS),
```

Step A (structural regions) and step B (text layers) are concatenated without any spatial cross-validation. A text layer from step B can be reported at a position that doesn't correspond to any region from step A — floating in empty space, or on top of the wrong element.

**Impact:** Text layers appear in wrong positions. Regions that should contain text come out empty. The merged result has spatial mismatches the single-pass read wouldn't produce.

**Fix:** After merging, run a positional overlap check: for each text layer, verify its center falls within 15% of canvas width/height of at least one non-text region from step A. If not, log a warning and attempt to snap to the nearest region.

---

## 10. `groupBounds` Doesn't Account for Stroke/Shadow/Padding (scene-tree.mjs:59-73)

**File:** `lib/scene-tree.mjs`
**Lines:** 59-73

```js
for (const c of vis) {
  const b = rotatedAabb(c.box, c.type !== 'group' ? c.rotation : undefined);
  x1 = Math.min(x1, b.x);
  // ...
}
```

Group bounds are computed as the axis-aligned bounding box of child boxes. But child layers can have `style.stroke`, `style.shadow`, and `style.padding` that extend beyond their box. A group containing a card with a 4px stroke and 12px padding appears smaller than its visual content — the stroke and padding are clipped by the group bounds.

**Impact:** Groups appear to clip their visual content. Stroke edges and padding are cut off. The Figma export has incorrect group dimensions.

**Fix:** When computing group bounds, expand each child's bounding box by its stroke width and padding:
```js
const expand = (c.style?.stroke?.width || 0) + (c.style?.padding || 0);
const b = rotatedAabb(c.box, c.type !== 'group' ? c.rotation : undefined);
b.x -= expand; b.y -= expand; b.w += expand * 2; b.h += expand * 2;
```

---

## Priority Fix Summary

| Priority | Issue | File:Line | Fix Complexity | Impact |
|----------|-------|-----------|---------------|--------|
| **P0** | Font weight defaults to 600 | layout-extract.mjs:1231 | Low | High |
| **P0** | `isPureDefault` too narrow | layout-extract.mjs:1217 | Low | High |
| **P0** | Element setStyle bypasses builder | design-agent.mjs:1129 | Medium | High |
| **P1** | Emoji color skip too aggressive | layout-extract.mjs:1221 | Low | Medium |
| **P1** | sanitizeGeometry only text-vs-text | layout-extract.mjs:2109 | Medium | High |
| **P1** | Product tint too transparent | layout-extract.mjs:1181 | Low | Medium |
| **P2** | Text fit over-shrinks | layout-extract.mjs:1384 | Low | Medium |
| **P2** | No element consistency in verify | design-verify.mjs:157 | Medium | Medium |
| **P2** | Two-step read no cross-validation | layout-extract.mjs:2499 | Medium | Medium |
| **P3** | groupBounds ignores stroke/padding | scene-tree.mjs:59 | Low | Low |

---

## Detailed Fix Specifications

### Fix 1: Role-Based Font Weight (layout-extract.mjs)

Insert after line 1231 in `toSkeletonLayers`, inside the text/badge/button processing block:

```js
// ROLE-BASED WEIGHT RECOVERY: when the model omitted fontWeight (defaulting to 600),
// override with the role's typical weight. 600 is the explicit fallback, so we only
// override when the model didn't give a deliberate signal.
if (style.fontWeight === 600) {
  const rl = String(l?.role || '').toLowerCase();
  if (/headline|title|price|badge/.test(rl)) style.fontWeight = 800;
  else if (/cta|button/.test(rl)) style.fontWeight = 700;
  else if (/caption|subhead|subline/.test(rl)) style.fontWeight = 500;
  // body/subhead at 600 is acceptable — no override needed
}
```

### Fix 2: Expanded Default Detection (layout-extract.mjs)

Replace line 1217:
```js
// Old: const isPureDefault = /^#(fff|ffffff|000|000000)$/i.test(textColor);
// New: treat any color within 0.05 luminance of pure white/black as a default
const isPureDefault = (() => {
  if (/^#(fff|ffffff|000|000000)$/i.test(textColor)) return true;
  const lum = hexLuminance(textColor);
  return lum != null && (lum > 0.95 || lum < 0.05);
})();
```

### Fix 3: Element Group SizeLocked (design-agent.mjs)

In the `element` case of `applyOp` (around line 954-957), after `doc.layers.push(inst)`:
```js
// Stamp sizeLocked on the element GROUP so setStyle on the group is also blocked
// (individual children already have sizeLocked from buildElement)
if (inst.type === 'group') inst.sizeLocked = true;
```

### Fix 4: Relaxed Emoji Guard (layout-extract.mjs)

Replace lines 1221-1224:
```js
// Old: if ((isPureDefault || !HEX_RE.test(String(s.color))) && !hasEmoji) {
// New: attempt sampling even with emoji, using a higher contrast floor
if (isPureDefault || !HEX_RE.test(String(s.color))) {
  const sampled = sampleGlyphColor(imagePath, b);
  if (sampled && colorDistance(sampled, textColor) > (hasEmoji ? 0.20 : 0.12)) {
    textColor = sampled;
  }
}
```

### Fix 5: Product Placeholder Opacity (layout-extract.mjs)

Change line 1181:
```js
// Old: background: `${tint}${blurred ? 'bf' : '59'}`,
// New: higher opacity for product placeholders (0.82 = visible tint, 0xbf = blurred)
background: `${tint}${blurred ? 'bf' : 'd1'}`,
```
