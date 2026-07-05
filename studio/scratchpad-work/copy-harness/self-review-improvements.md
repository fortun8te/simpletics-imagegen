# Self-Review System: Analysis and Improvement Proposals

Date: 2026-07-04
Scope: `lib/self-vision.mjs`, `lib/native-ui-loop.mjs`, `scripts/pixel-diff.mjs`
Goal: Results must "match the reference exactly, be clean layer-wise, and import smoothly into Figma"

---

## Part 1: Current Architecture

The self-improvement loop (`runSelfImproveLoop`) works as:

1. SEED — copy-reference or generate from brief
2. ITERATE up to maxIters (default 5):
   a. Render doc to PNG via headless Chrome / qlmanage
   b. Score fidelity = 0.7 * visionScore + 0.3 * pixelScore
   c. Score >= 90 = PASS, stop
   d. No gain for `patience` rounds = CONVERGED, stop
   e. Else: discrepancies -> fix instruction -> runDesignAgent -> new doc
3. Return BEST-scoring doc (not necessarily the last)

**Scoring pipeline** (`scoreFidelity`):
- Renders doc to PNG
- Calls `compareToReference()` — sends render PNG + reference PNG to vision model with COMPARE_PROMPT
- Calls `pixelDiff()` — 64x64 grayscale luminance grid, MAE-based score
- Blends: `0.7 * visionScore + 0.3 * pixelScore`
- Blank-render guard: caps score if render has < 50% of reference's luminance spread

---

## Part 2: Identified Problems

### Problem 1: Fix iterations lose the reference (CRITICAL)

**Location**: `native-ui-loop.mjs` line 250

```js
const fixOut = await agent(doc, instruction, () => {}, {
  ...agentOpts,
  reference: undefined, // fixes are edits on the existing doc, not a re-copy
  brief: brief || undefined,
  signal,
});
```

During every fix iteration, `reference: undefined` is passed to `runDesignAgent`. The design agent receives the text instruction (e.g. "recolor headline to #ffffff") but CANNOT see the reference image. This means:

- The agent has no visual context for what "matching the reference" looks like
- It must infer everything from the text discrepancy list alone
- Complex multi-element corrections (e.g. "move badge down 8% AND shrink headline 20% AND add missing CTA label") require the agent to imagine the reference layout from prose
- The agent frequently makes one fix while breaking another, because it lacks the holistic reference view

**Impact**: The loop wastes iterations on partial fixes that introduce new discrepancies. The patience mechanism then kills the loop before convergence.

### Problem 2: Vision compare prompt lacks positional/structural anchoring

**Location**: `self-vision.mjs` COMPARE_PROMPT (line 175)

The prompt asks the vision model to compare two images but provides zero structural metadata. The model must independently identify:
- Which layers exist in each image
- Their approximate positions and sizes
- Their colors and text content
- What is "missing" versus "different"

For small vision models (Gemma, ornith 9b), this is extremely difficult. The model often:
- Reports vague issues ("layout looks different") instead of actionable corrections
- Misses small but critical differences (badges, eyebrow text, icon positions)
- Inflates scores when the overall "vibe" matches even if details are wrong
- Fails to identify missing layers entirely when they're small relative to the canvas

### Problem 3: Pixel diff is too coarse for ad-quality comparison

**Location**: `pixel-diff.mjs` line 150-161

The 64x64 grid means each cell covers ~17x21 pixels on a 1080x1350 canvas. This means:
- A CTA button occupying 5% of the canvas is only 3-4 grid cells
- Text content is completely invisible at this resolution
- A render that's missing the headline but has the right background scores ~95+
- Color differences within small elements are averaged away

The pixel score is useful as a "structural silhouette" check (are the big shapes in the right place?) but is nearly useless for the fine-gridelity that matters for "match the reference exactly."

### Problem 4: Score threshold creates a cliff, not a gradient

**Location**: `native-ui-loop.mjs` line 39

A render at 89.9 scores as a failure; a render at 90.0 passes. But the vision model's scoring has ±3-5 points of noise between identical re-evaluations. This means:
- A legitimately passing render can fail due to scoring noise
- The loop wastes an iteration re-fixing something that was already correct
- The `minGain: 1.0` threshold is too small — scoring noise alone can exceed it, preventing convergence detection

### Problem 5: `discrepanciesToInstruction` drops corrections after the top 4

**Location**: `native-ui-loop.mjs` line 48

```js
const top = (Array.isArray(corrections) ? corrections : []).slice(0, 4);
```

When the vision model returns 5-6 corrections, the bottom 1-2 are silently discarded. If those discarded corrections are the ones the model is most confident about (they happen to be last in the list), the fix run addresses the wrong things.

### Problem 6: `correctionToOp` only handles simple patterns

**Location**: `self-vision.mjs` line 479-567

The automated correction-to-op converter handles: hex color, directional nudge, scale factor, and text content. But vision corrections frequently describe:
- "Text clips off the right edge" (requires resize + reposition, not just nudge)
- "Missing header bar" (requires adding a new element, not adjusting existing)
- "Wrong font weight — should be 800 not 600" (requires font-weight change)
- "Overlap between headline and body" (requires repositioning multiple elements)
- "Background should be gradient not solid" (requires style overhaul)

These all fall through to the generic `op: 'correction'` path, which requires an LLM call to interpret — adding latency and introducing another failure mode.

### Problem 7: The blank-render guard can false-positive on dark references

**Location**: `self-vision.mjs` line 299-315

The guard compares luminance spread. A dark-themed reference (spread ~0.08) with a render that has a dark background + a few light elements (spread ~0.06) might read as "75% content ratio" and NOT trigger the guard — even though the render is missing all overlay text and chrome. Conversely, a reference that's a solid dark color (spread ~0.01) bypasses the guard entirely because `refSpread > 0.02` fails.

### Problem 8: `lookAtComp` never sees the reference

**Location**: `self-vision.mjs` line 158-171

`lookAtComp` renders the doc and critiques it in isolation. It's used in the design-agent's turn-0 vision pass and the fast-path edit validation. Since it never sees the reference, its critique is a generic "does this look like a good ad?" rather than "does this match the reference?" This is by design for the general critique, but it means the agent's mid-run quality checks are not reference-anchored.

---

## Part 3: Improvement Proposals

### Proposal 1: Pass the reference to fix iterations

**Priority**: CRITICAL
**Effort**: Low

In `native-ui-loop.mjs`, change:

```js
reference: undefined, // fixes are edits on the existing doc, not a re-copy
```

to:

```js
reference: { path: referencePath, label: archetype || 'reference' },
```

This lets `runDesignAgent` see the reference image during fix iterations. The agent already supports `opts.reference.path` — it fires `runCopyReference` when a reference is present, but only for the initial copy. For fix iterations, the reference should be injected as an attachment/context, not as a re-copy trigger.

The design-agent's `runDesignAgent` function needs a small modification: when `reference.path` is provided alongside an existing doc (not a fresh seed), it should attach the reference as a visual context image in the system prompt rather than triggering the full copy-reference pipeline. This could be done via the `attachments` mechanism already present in the agent harness.

**Alternative (simpler)**: Keep `reference: undefined` but inject the reference path into the instruction text:
```
Fix ONLY these specific visual discrepancies. The reference image is at: {referencePath}
Render the current state with {"op":"look"} and compare against the reference before and after fixes.
```
This relies on the agent's `{"op":"look"}` (which calls `lookAtComp`) — but `lookAtComp` doesn't see the reference either (Problem 8). So this alone is insufficient without also fixing Proposal 2.

### Proposal 2: Add reference to `lookAtComp` when available

**Priority**: HIGH
**Effort**: Medium

Create a `lookAtCompVsRef(doc, referencePath)` variant (or add an optional `referencePath` param to `lookAtComp`) that renders the doc, then sends BOTH the render and the reference to vision with a comparison prompt. This gives the design agent's mid-run quality check a reference-anchored view.

This is essentially what `compareToReference` already does, but `lookAtComp` is called from the agent's `{"op":"look"}` which is the agent's primary self-inspection tool. Wiring the reference into `lookAtComp` means every `{"op":"look"}` during fix iterations becomes reference-aware.

### Proposal 3: Upgrade pixel diff to multi-scale

**Priority**: MEDIUM
**Effort**: Medium

Replace the single 64x64 grid with a multi-scale comparison:

```
Coarse (32x32):  structural silhouette — are the big shapes in place?
Medium (128x128): element-level — are buttons/blocks in the right zones?
Fine (512x512):  text/detail — is the text legible and positioned correctly?
```

Weight them: 0.3 * coarse + 0.4 * medium + 0.3 * fine. The fine scale catches text-clipping and small element differences that the coarse scale misses entirely.

Additionally, add a **color histogram comparison** — extract the dominant 5-10 colors from each image and compare their proportions. This catches "wrong background color" or "missing brand color" without needing the vision model.

### Proposal 4: Add structural element matching to scoring

**Priority**: HIGH
**Effort**: Medium-High

Before the vision compare, extract a lightweight structural fingerprint from both the render and the reference:

1. **Edge density map**: Canny-like edge detection (simplified: absolute gradient magnitude) downsampled to 32x32. Two renders with the same text/layout have similar edge patterns; a missing headline has a hole in the edge map.

2. **Connected component count**: Count distinct blobs of non-background color. The reference has N blobs (text blocks, buttons, images); the render should have approximately N. Missing or extra blobs indicate missing/phantom elements.

3. **Text region detection**: Convert to grayscale, threshold, find horizontal runs of dark pixels (text lines). Count approximate text lines and their vertical positions. A render missing the headline has fewer text lines at the top.

These are computed in pure Node (no deps) alongside the existing `readPng`/`downsampleGray` pipeline and added as additional blending signals:

```
blended = 0.5 * vision + 0.2 * pixel + 0.15 * edge + 0.1 * components + 0.05 * text
```

### Proposal 5: Soften the pass threshold with a confidence window

**Priority**: MEDIUM
**Effort**: Low

Replace the hard `score >= 90` gate with:

```js
const PASS_SCORE = 90;
const PASS_CONFIDENCE = 3; // need to be THIS far above threshold to pass

if (scored.score >= PASS_SCORE + PASS_CONFIDENCE) {
  // definite pass
} else if (scored.score >= PASS_SCORE && score >= prevBest) {
  // borderline pass — only if score is stable (not a scoring-noise spike)
  consecutiveBorderline++;
  if (consecutiveBorderline >= 2) {
    // two consecutive rounds at/above threshold = real pass
  }
}
```

This prevents a single noisy high score from ending the loop prematurely, while still allowing legitimate passes through.

### Proposal 6: Improve the COMPARE_PROMPT with structural hints

**Priority**: HIGH
**Effort**: Low

Inject extracted structural metadata into the vision comparison prompt. Before calling vision, extract from both PNGs:

- Approximate number of text regions (horizontal dark-pixel runs)
- Dominant colors (top 5 hex values)
- Aspect ratio and fill percentages (how much of the canvas is "content" vs "background")
- Approximate vertical zones where content exists (top third, middle, bottom)

Append this as a "structural fingerprint" block to the COMPARE_PROMPT:

```
STRUCTURAL HINTS (automated pre-analysis):
Render: ~8 text regions, dominant colors [#1a1a2e, #ffffff, #e94560], content fills ~72% of canvas
Reference: ~10 text regions, dominant colors [#1a1a1a, #ffffff, #ff6b35], content fills ~85% of canvas
The render appears to have 2 fewer text regions and less content coverage than the reference.
```

This gives the vision model concrete starting points instead of asking it to do all detection from scratch. Small vision models are much better at confirming/refining hints than doing open-ended detection.

### Proposal 7: Fix `discrepanciesToInstruction` to carry ALL corrections

**Priority**: MEDIUM
**Effort**: Low

Instead of hard-cutting to 4 corrections, pass all corrections but with priority weighting:

```js
const all = Array.isArray(corrections) ? corrections : [];
const primary = all.slice(0, 3);       // must-fix
const secondary = all.slice(3, 6);     // fix if possible
```

In the instruction:

```
Fix these CRITICAL discrepancies first:
1. headline: text clips off right edge → resize to 90% width
2. CTA: missing from render → add "Shop Now" button at bottom
3. background: should be #1a1a2e not #333333

Also fix these if possible:
4. eyebrow: font weight too light → set to 700
5. badge: positioned too high → nudge down 5%
```

The agent sees everything and can prioritize, instead of silently dropping corrections.

### Proposal 8: Add a "diff image" rendering step

**Priority**: MEDIUM-High
**Effort**: Medium

After rendering the doc and having the reference, generate a **difference image**:

1. Both images are already on disk as PNGs
2. Downsample both to the same resolution (e.g. 540x675 for a 1080x1350 canvas)
3. Compute per-pixel absolute difference
4. Amplify differences (multiply by 3x, clamp to 255)
5. Save as a red-channel overlay: areas that differ appear bright red, matching areas are dark

Send this diff image as an additional image to the vision model. The model can then directly SEE where the differences are without having to mentally compare two images. This is especially powerful for small vision models that struggle with cross-image comparison.

Implementation in pure Node: the existing `readPng` + `downsampleGray` pipeline already handles PNG decoding. Add a `diffImage(pathA, pathB)` function that produces a highlighted PNG.

### Proposal 9: Score history smoothing

**Priority**: LOW
**Effort**: Low

The current loop tracks `best.score` as a raw max. But scoring noise means a round that scores 92 might actually be worse than a round that scored 89 (the 92 was a lucky spike). Add exponential moving average:

```js
const alpha = 0.6; // weight for current score
smoothedScore = alpha * currentScore + (1 - alpha) * previousSmoothedScore;
```

Use `smoothedScore` for convergence detection and pass/fail decisions. Raw scores are still logged for debugging.

### Proposal 10: Vision model calibration pass

**Priority**: LOW
**Effort**: Medium

Run a one-time calibration: present the vision model with 10-20 known-good render/reference pairs at various quality levels (perfect, minor drift, major drift, blank). Record the model's scores. Compute the model's actual accuracy and bias. Use this to:

1. Adjust the pass threshold (if the model consistently scores 3 points high, raise the threshold to 93)
2. Weight the vision vs pixel blend per model (a model that's better at structural comparison gets more vision weight; a model that's bad at details gets less)
3. Detect when the model is "stuck" (returning the same score regardless of input) and fall back to pixel-only scoring

---

## Part 4: Recommended Implementation Order

1. **Proposal 1** (pass reference to fix iterations) — immediate win, low effort, biggest impact on convergence
2. **Proposal 6** (structural hints in COMPARE_PROMPT) — easy win, helps small models dramatically
3. **Proposal 5** (soften pass threshold) — prevents premature termination from scoring noise
4. **Proposal 3** (multi-scale pixel diff) — catches what the 64x64 grid misses
5. **Proposal 8** (diff image) — gives vision model a direct visual of differences
6. **Proposal 2** (reference-aware lookAtComp) — makes agent's mid-run checks reference-anchored
7. **Proposal 7** (carry all corrections) — prevents information loss
8. **Proposal 4** (structural element matching) — adds objective signals independent of vision
9. **Proposal 9** (score smoothing) — stabilizes convergence detection
10. **Proposal 10** (calibration) — long-term quality improvement

---

## Part 5: Quick Wins (can be implemented in < 30 minutes each)

### Quick Win A: Pass reference path in fix instructions

In `native-ui-loop.mjs` `discrepanciesToInstruction`, append the reference path:

```js
return [
  `This render currently scores ${score ?? '?'} /100 fidelity against the reference${archetype ? ` (${archetype})` : ''}.`,
  'Fix ONLY these specific visual discrepancies to make it match the reference more closely, then finish:',
  ...lines,
  'Do not change the copy wording. Adjust position, size, color, spacing and hierarchy only.',
  `The reference image is at: ${referencePath || '(unavailable)'}`,
].join('\n');
```

This costs nothing and gives the agent the path even if it can't directly load the image.

### Quick Win B: Increase pixel diff grid resolution

Change the default grid from 64 to 128 in `pixel-diff.mjs`:

```js
export function pixelDiff(pathA, pathB, { grid = 128 } = {}) {
```

This quadruples the resolution (128x128 = 16K cells vs 64x64 = 4K cells), catching smaller element differences. The performance cost is negligible (pure Node, no deps).

### Quick Win C: Add color histogram to pixel diff output

Add a `colorSimilarity(pathA, pathB)` function that:
1. Reads both PNGs
2. Quantizes each pixel to the nearest of 16 named color buckets (red, orange, yellow, green, cyan, blue, purple, pink, white, light-gray, dark-gray, black, brown, beige, gold, silver)
3. Counts pixel percentages per bucket
4. Returns `100 - sum(|a_bucket% - b_bucket%|) / 2`

This catches "wrong background color" or "missing brand accent" without the vision model.

### Quick Win D: Pass all corrections, not just top 4

Change `discrepanciesToInstruction`:

```js
const top = (Array.isArray(corrections) ? corrections : []).slice(0, 6); // was 4
```

And split into primary/secondary in the instruction text as described in Proposal 7.

---

## Part 6: Architecture Notes for Figma Import Quality

The user's goal includes "import smoothly into Figma." This means the self-review system should also verify:

1. **Layer naming**: Every layer has a human-readable name (not "text" or "shape"). The `deriveLayerName` function in design-agent.mjs handles this, but the self-review doesn't check it.

2. **Layer hierarchy**: Groups are clean, no orphaned children, no unnecessary nesting. The `verifyDesign` function in `design-verify.mjs` checks this but is not called from the scoring pipeline.

3. **Text layer integrity**: No text layers with empty content, no text that overflows its box, no text with zero fontSize. The `repairTextLayer` function handles some of this but the self-review doesn't validate it.

4. **Image layer completeness**: No images with missing src, no images stretched beyond recognition. The blank-render guard catches total emptiness but not partial image issues.

**Proposal 11**: Add a `figmaReadiness` check to `scoreFidelity` that runs after the vision+pixel scoring:

```js
const figmaCheck = verifyDesign(doc);
if (!figmaCheck.ready) {
  // Penalize the score by 5-10 points for Figma-import issues
  score = Math.max(0, score - (10 - figmaCheck.score));
}
```

This ensures the loop doesn't PASS on a render that scores well on visual fidelity but would produce a messy Figma import.
