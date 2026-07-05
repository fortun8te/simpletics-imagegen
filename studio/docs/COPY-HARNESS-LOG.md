# COPY-HARNESS-LOG — Copy-fidelity marathon

Mission: make `runCopyReference` (lib/design-agent.mjs) reproduce these 8 target ads from
`~/Downloads/IMAGE AD INSPO/` as closely as possible, then generalize to more ads.

Target set:
- 009_attached_885c19be02ccf229.png
- 010_attached_d1da6c1ffd909d18.png
- 026_attached_84a042d29cdfff93.webp
- 050_attached_0d40eff6fd3e3051.webp (1:1 canvas)
- 052_attached_6e7a2d035eee1c7e.webp
- 053_attached_3a7620d3e291fe78.webp
- 078_attached_efa4c7170a656935.webp
- 103_attached_056bb15bf6d6c82e.webp

Harness: `scripts/copy-harness.mjs`. For each ad: registers the reference PNG into
`.state/refs/harness-<id>.png` (the SAME path `makeImageResolver`'s `/refasset` route reads in
production — no server needed, no prod code touched) → `extractLayout` → blank doc at the
reference's real aspect → `runCopyReference(doc, {path, ref: harness-<id>, label}, emit, {})`
(the exact function `runDesignAgent` calls in prod for copy-mode) → `renderCompPng` with the
real `makeImageResolver` (so auto-cutout crops resolve exactly like prod) → `pixelDiff` (64×64
luminance grid, scripts/pixel-diff.mjs) vs a lossless PNG transcode of the source. Outputs land
in `scratchpad-work/copy-harness/<id>/{render.png,side-by-side.png,result.json}` +
`scratchpad-work/copy-harness/report.json`.

Run: `node scripts/copy-harness.mjs` (all 8) or `--only 009,050` (subset) or
`--files a.png,b.webp` (Phase-3 generalization batches, bypasses the built-in target set).

Runtime note: each ad's extraction is 1 ornith vision call (or 2 in two-step mode) plus a
render pass. Observed wall time per ad in this environment: ~3-4 min end-to-end (extraction
dominates). Sequential only — do not parallelize vision calls.

---

## Iteration 0 — harness build + smoke test

Built `scripts/copy-harness.mjs` from scratch (did not exist). Key design decisions:
- **Cutout-src problem solved via `.state/refs/harness-<id>.png` registration** — this is
  EXACTLY the path `designstore.mjs makeImageResolver` reads for `/refasset?id=X` in production
  (`join(repo, 'studio', '.state', 'refs', id + '.png')`, where `repo` = `NEUEGEN/`). No server
  process needed, no prod code path changed — the harness just pre-populates the same directory
  prod would populate via upload. webp/jpg sources are transcoded to PNG via `sips` (matches
  `imageRatio()`'s existing sips usage in layout-extract.mjs).
- Assembly calls `runCopyReference` directly (not through `runDesignAgent`), which is the exact
  function used in production's copy-reference path per the mission brief.
- Render uses the real `renderCompPng` + real `makeImageResolver`, so AUTO-CUTOUT crops that
  reference `/refasset?id=harness-<id>` resolve to actual pixels, matching prod behavior exactly.
- Score = `pixelDiff` 64×64 luminance-grid similarity (0-100) between the harness's PNG-transcoded
  source and the render. This is a coarse STRUCTURAL signal (dark/light mass placement), not a
  perceptual/semantic one — side-by-side.png (Chrome-rendered 2-up comparison) is the primary
  diagnostic for "does this read as the same ad", pixel score is the trend/regression number.

Smoke test: ran `--only 050` end-to-end successfully (first attempt was accidentally `kill`ed by
the operator mid-write while investigating an apparent hang — LM Studio's reported
`loaded_context_length` is a static max-seen figure, not a liveness signal, so it looked stuck
when it wasn't; confirmed by a clean rerun). Extraction + assembly + Chrome render all completed.
Per-ad wall time in this environment: ~3-4 minutes (slower than the "~1-3 min" guidance —
likely this machine/model combo; not a bug, just the real budget to plan around for 8-64 ad
sweeps).

### BASELINE 8-ad table

STATUS: full 8-ad baseline sweep in progress / pending completion — this table will be filled
with real numbers as `node scripts/copy-harness.mjs` (no `--only` filter) completes each ad.
Placeholder structure below; a fresh session should re-run the full sweep if this table is still
marked PENDING when picking up this log, and fill in the columns.

| id  | ok | pixel score | layers applied/extracted | archetype | bg | cutouts | parse path | ms total | notes |
|-----|----|--------------|---------------------------|-----------|----|---------|------------|----------|-------|
| 009 | PENDING | | | | | | | | |
| 010 | PENDING | | | | | | | | |
| 026 | PENDING | | | | | | | | |
| 050 | ok (smoke test) | see scratchpad-work/copy-harness/050/result.json | | | | | | | 1:1 canvas confirmed |
| 052 | PENDING | | | | | | | | |
| 053 | PENDING | | | | | | | | |
| 078 | PENDING | | | | | | | | |
| 103 | PENDING | | | | | | | | |

---

## Iteration 1 — deterministic clip audit + timeout/double-extraction fixes (pre-baseline)

While the baseline sweep ran, built the owner-mandated deterministic clip test:
`test/template-element-clip.test.mjs` — builds EVERY template at 3 canvas sizes (1:1, 4:5, 9:16)
and every element at defaults, and asserts via the builders' own measurement utils
(intrinsicTextW / estimateTextBoxH) that (a) no unbreakable word is wider than its box, (b) no
autoH text needs more height than its box, (c) no text box escapes the canvas. A LONG-copy
stress case stuffs every prose-looking string param with realistic 80-char extracted copy.

FOUND + FIXED 6 clipping templates (all lib/templates.mjs — sequential rows sized from
`text.length * factor` with no canvas clamp):
- `x-post-ad` meta row (Meta time / Viewcount / views label) — segments now clamp to the body column.
- `offer-hero` chips — row shrinks chip font to a floor, then hard-clamps per-chip width.
- `stat-chart` pill label — width clamped to the chart column.
- `imessage` + `sms` timestamp row (shared builder) — clamped to 90% canvas, x floored at 5%.
- `before-after` closing line — was autoH-grown PAST the canvas bottom by fitElementText after
  build; now pre-measured with estimateTextBoxH and bottom-anchored.
All green after: test:agent 52/52, templates.test 12/12, clip test 3/3.

HARNESS/LIB FIXES from the first sweep attempt (ads 009+010 both FAILED `extraction timeout`):
1. lib/layout-extract.mjs: `perPass` was hard-capped at 90s and two-step steps at 55s regardless
   of the caller's timeoutMs — this machine's ornith takes 1.5-4 min per call, so EVERY pass
   timed out. Both caps now scale up when the caller passes an explicitly larger budget
   (defaults unchanged for prod).
2. lib/design-agent.mjs runCopyReference: accepts `opts.ext` (pre-computed extraction) +
   `opts.extractTimeoutMs`. Harness passes its extraction in → no double vision round-trip
   (was doubling per-ad wall time). No behavior change when opts absent.
3. scripts/copy-harness.mjs: passes `timeoutMs: 360_000` to extractLayout.

Baseline sweep restarted with fixed code (log: /tmp/harness-full-sweep2.log).

### Next hypothesis / next steps
1. Run the full 8-ad sweep (`node scripts/copy-harness.mjs`, no filters) to completion — budget
   ~25-35 min wall time given the ~3-4 min/ad observed rate.
   grade against exact scores and layer counts.
3. Read every side-by-side.png with the Read tool (they're real PNGs) to diagnose the worst
   3-4 ads first — the owner explicitly wants LOOKING at renders, not just trusting the score.
4. Cross-reference each failure against the expected failure classes in the mission brief:
   presets stealing copies, template-copied-image regions not triggering cutout, font/size/color
   fidelity, geometry/stacking/background-kind mismatches.

---

## Iteration 2 — first render diagnosis (ad 009) + x-post copy-fidelity fixes

Looked at 009's side-by-side (score 90 — INFLATED by the mostly-black canvas; treat pixel score
as trend only on dark ads). Diagnosis:
1. **3 of 4 body paragraphs MISSING** — root cause in `mapXPost` (lib/layout-extract.mjs):
   `params.body` took only the SINGLE LONGEST text block. FIXED: all text blocks ≥24 chars
   (top-to-bottom, minus name/handle/meta/image-labels) join with `\n\n` — the x-post-ad
   template already splits body on blank lines into per-paragraph layers.
2. **Avatar showed as white circle + display name read "upfront logo"** — the name fallback
   grabbed the avatar's LABEL text. FIXED: name candidates now exclude image-ish layers
   (type image, role/label logo|avatar|icon|photo).
3. **cutouts=0 on the preset path** — cutoutCandidate marking only existed in the LOOSE path
   (toSkeletonLayers). FIXED: `fillPresetFromExtraction` now stamps the built template's avatar
   node and media image slot with cutoutCandidate (region = raw box as source fractions) when
   the extraction saw real avatar/photo regions → runCopyReference converts them to real crops.
4. **Embedded media never mapped** — mapXPost now sets `media:'photo'` + photo label when a
   large (≥15% canvas height) non-avatar image region exists (ads 050/103 need this).
Verified with a synthetic extraction: params.body joins 3 paragraphs, avatar + media both
stamped. Tests: test:agent 52/52, extract tests 16/16, clip test 3/3.

Also instrumented the harness: saves extraction.json + doc.json per ad; fixed parsePath
operator-precedence bug; added leavesInResult.

NOTE: the in-flight baseline sweep still runs iteration-0 lib code (loaded at process start) —
its numbers are the true BASELINE. Re-runs after it finishes will show the fix deltas.

### Open failure classes (watch for in remaining baseline ads)
- Pixel-score inflation on dark ads (009: 90 despite missing 60% of body).
- Meta/action row rendered slightly LOW vs reference on 009 (bottom-anchored rows in template
  sit lower than X's real spacing at 1:1) — measure after re-run.

---

## Iteration 3 — element long-copy clip fixes

Fixed the element clip test being VACUOUS (buildElement returns an array; the audit was wrapping
it wrong and inspecting nothing). With the real audit, long-copy stress found 2 element bugs:
- `cta` (bottom-anchored pill, autoH) — long text wrapped to 5+ lines and grew 300px past the
  canvas bottom.
- `price-strip` (old/new price texts, autoH) — same, up to 700px past.
FIX: new `fitSingleLine()` helper in lib/elements.mjs — shrinks fontSize (floor 55%) until the
text fits the box width; applied to cta + both price-strip texts. Single-line-intent bottom
elements now shrink instead of wrap-past-canvas. All 4 clip tests + test:agent 52/52 green.

---

## Iteration 4 — ad 010 diagnosis + loose-path fixes

010 baseline: score 95.7 (white-bg inflated), arch generic (loose path — fair: this X-post
screenshot has no nav/action chrome so archetype detection is genuinely ambiguous), extraction
took 770s and read only 7 leaves. Side-by-side diagnosis:
- **Avatar cutout WORKED** — real reference pixels in the render (first proof of the refasset
  wiring end-to-end). Oversized vs the reference, but present and unmistakable.
- **Body ¶1 ran off the RIGHT edge of the canvas** — extraction box x+w exceeded 100%. FIXED in
  toSkeletonLayers: far-edge clamp `w ≤ canvas.w - x`, `h ≤ canvas.h - y` (was only clamping
  w ≤ canvas.w independently of x).
- **"WAT. EEN. JAAR." rendered as a giant BROWN headline** — the deterministic glyph-color
  sampler read the emoji pixels (🥹🤝 are brown/yellow). FIXED: emoji guard — text containing
  emoji skips glyph sampling (model color or default wins).
- **3 paragraphs + display name missing** — extraction-level (7 leaves read). Open class:
  dense text posts under-read on the loose path; the two-step read exists but wasn't
  triggered/didn't recover them. NEXT: check extraction.json of the re-run (instrumented now).
Tests: 52/52 agent + 20 extract/clip subtests green.

---

## Iteration 5 — 026 timeout + 050 diagnosis + mask/rescue fixes

- **026 FAILED: extraction timeout even at 360s budget** (dense comparison layout). Harness
  budget raised to 600s (perPass→200s, two-step steps→100s). 026 re-runs after the sweep.
- **050 scored 87.8 and reads as the SAME AD** — best result yet: BOTH cutouts (avatar + media
  photo) landed real reference pixels via /refasset. Diagnosis of remaining gaps:
  - media photo was ELLIPSE-masked (model gave a round shape hint; classifier believed it).
    FIXED: >30% of either canvas dimension forces the rect mask (big media is never an avatar).
  - rect cutouts now get soft card-radius corners in the runCopyReference conversion (X media
    style), avatars keep ellipse, logos keep 12%.
  - missing bottom meta line (timestamp · views) — extraction miss (7 leaves), the weak-text
    rescue (below) should recover this class.
- **WEAK-TEXT RESCUE added** (root fix for 010's missing paragraphs): a successful-but-sparse
  pass-1 read (<6 text layers AND <260 chars on a non-photo reference) now triggers the scoped
  two-step re-read and merges recovered layers (mergeRefined + scoreRaw gate). Costs extra
  vision calls only on weak reads.
Tests 52/52 green. Baseline sweep continues (052 in flight).

---

## Iteration 6 — 052 diagnosis: the grey-slab fix

052 baseline 83.7 (arch before-after, loose path, bg photo→green solid read ok). WINS: serif
display font survived into the render; green palette right; headline/closing copy right.
FAILS: both before/after PHOTO PANELS rendered as grey slabs (labels "before panel"/"after
panel" miss CUTOUT_PHOTO_RE; cutouts=0), product tube missing (extraction miss).
FIX (the owner's "photos come out as grey slabs" class): SIZE DEFAULT in toSkeletonLayers —
any image region ≥8% of canvas area that matched no cutout keyword and is NOT packshot-ish
(bottle|tube|jar|pouch|…) now defaults to a rect cut-out of the reference. Packshots keep the
silhouette treatment (owner-intended). Tests 52/52 + extract 7/7 green.

---

## Iteration 7 — 053 diagnosis: photo-background class + blank render

053 baseline 55.1 (WORST) — arch story-native, bg photo, 3 layers applied. The render is
COMPLETELY BLACK: no base (photo reference keeps doc's empty base → renderDesignHtml's #000
comp div shows through) and the 3 story pills are invisible on it (or mis-scaled). TWO fixes:
1. (landed) runCopyReference: photo reference + reference.ref → full-bleed reference image
   becomes the base layer (fit:cover) under rebuilt overlays. Rebuilt pills sit at the same
   spots as the baked-in ones and cover them. This should transform 053/103-class ads.
2. (open) WHY are the 3 pills invisible? Re-run with doc.json instrumentation will tell.
Tests 52/52 green. Sweep at 078.

---

## Iteration 8 — CRITICAL RENDERER BUG: Chrome captured only a crop of every comp

Reproducing 053's blank render deterministically exposed it: self-vision's renderWithChrome
sized the Chrome window to canvas×(size/longEdge) (e.g. 506×900 for a 1080×1920 story) while
renderDesignHtml draws the comp at NATIVE canvas px (1080 wide) — the screenshot only captured
the top-left window-sized region. A 9:16 story lost >50% of its width; a 1:1 lost ~17% right+
bottom. EVERY prior pixel score compared a CROPPED render vs the full reference; 053's "blank
black" render was the dark top-left crop of an unlit region.
FIX (lib/self-vision.mjs): window = exact canvas CSS px, device-scale-factor 1 → the PNG is
exactly canvas-sized. Verified: story-native at 1080×1920 renders complete with correct pill
wrapping (the "pill overflow" I chased in iteration 4's render was also this crop, not a CSS
bug).
CONSEQUENCE: all baseline pixel scores are UNDERSTATED/mismeasured; the failure-class diagnoses
(missing text, grey slabs, ellipse masks, missing photo bg) remain valid from the side-by-sides.
After the sweep completes 078+103 (old code), rerun ALL 8 with the full fix stack for the
honest post-fix table. Tests 52/52 green.

---

## BASELINE SWEEP COMPLETE (iteration-0 lib code, CROPPED renders — see iteration 8 caveat)

| id  | ok | pixel | applied/extracted | archetype | bg | cutouts | wall |
|-----|----|-------|-------------------|-----------|----|---------|------|
| 009 | ok | 87.9 | 4/21 | x-post | #000000 | 1 | 100s |
| 010 | ok | 95.7 | 3/7 | generic | #FFFFFF | 1 | 779s |
| 026 | FAIL (extraction timeout @360s) | — | — | — | — | — | 360s |
| 050 | ok | 87.8 | 3/7 | x-post | #161616 | 2 | 104s |
| 052 | ok | 83.7 | 5/10 | before-after | photo | 0 | 836s |
| 053 | ok | 55.1 | 3/8 | story-native | photo | 0 | 232s |
| 078 | ok | 84.8 | 4/17 | offer-hero | #f2f3f5 | 1 | 668s |
| 103 | ok | 77.2 | 3/5 | x-post | #000000 | 1 | 111s |

avg 82 over the 7 ok. Scores measured against CROPPED renders (renderer bug fixed in iter 8) —
treat as directional only. 078 diagnosis (side-by-side): structure/headline/callout text good,
logo cutout landed; ARROWS + fill-less shapes rendered as BLACK SLABS (shape default #000 in
renderDesignHtml) — FIXED in toSkeletonLayers: arrow/line-ish shapes → real shapeKind arrows in
ink color; other fill-less shapes → translucent neutral. Product tube kept the silhouette
treatment (owner-intended for packshots).

## POST-FIX SWEEP LAUNCHED — full fix stack:
clip fixes (templates+elements) · mapXPost multi-paragraph body/name/media · preset avatar+media
cutout stamping · far-edge box clamp · emoji glyph-sampling guard · weak-text rescue read ·
big-photo rect masks + media card radius · grey-slab size-default cutouts · photo-reference
full-bleed base · arrow/black-slab shape fixes · EXACT-canvas Chrome renders · 600s budget.

---

## Iteration 9 — post-fix 009 is near-exact; 010 exposed the DARK-TEMPLATE bug

POST-FIX 009: 90 (dark-inflation caveat) but the side-by-side now reads as the SAME POST:
all 4 body paragraphs, full meta line ("05:00 PM · 12-05-2026 · 121K views"), action row with
real counts (257/66/21K/89), avatar = real reference pixels. Remaining nit: display name showed
"Volgend" (model emitted the follow label as a caption above the handle) — FIXED: isFollowish
exclusion (button/cta/badge roles + follow words in 6 languages) in mapXPost name pick.

POST-FIX 010: **9.8/100 CATASTROPHE** — archetype resolved x-post this run, and x-post-ad's
template was HARD-CODED DARK (#000): white reference → black render. FIXED: x-post-ad gets a
`theme` param (dark = Lights-out tokens, light = X default #fff/#0f1419/#536471 incl. follow
pill + media frame tokens); fillPresetFromExtraction sets params.theme from the reference
background luminance. Any themable template picks it up automatically (unknown param dropped
elsewhere).
Tests: 52/52 agent, clip+preset 11 subtests green. NOTE: the running post-fix sweep still has
the old lib loaded — 010/009 need a FINAL re-run after it completes.

---

## Iteration 10 — 026 first success reveals PIXEL-COORDS pileup

026 extracted for the first time (600s budget, 393s) at 82.9 — but the render was near-blank:
doc.json showed nearly every box at x=1040,y=1890,w=40,h=30. Root cause: the model answered in
PIXELS (x=540, w=980, fontSizePct=130) where the prompt asks 0-100 percentages; clampPct()
flattened all coords to 100% → the whole design piled into the bottom-right corner (the visible
"DORE & ROSE"/"S"/"GREY PILLOW" fragments). FIXED in extractLayout: post-merge normalizer —
when any box edge exceeds 130, rescale all boxes per-axis so the outermost edge hits 100%, and
scale fontSizePct>15 by the tighter axis. Tests 52/52.

---

## Iteration 11 — post-fix 050/052/053 results

- 050: **97.5** (was 87.8) — rect media mask + card radius + real avatar; reads near-exact.
  Nits: name fontsize too big (overlaps handle), caption line 3 slips under the photo.
- 053: **93.5** (was 55.1) — photo-base fix landed; render is virtually the reference with
  rebuilt pills sitting on the baked-in ones. The photo-background class is SOLVED.
- 052: 85.4 (was 83.7) — photo base also landed here (bg misread as photo, but harmless-to-
  good: the reference IS the background now). Remaining: a grey placeholder Panels slab
  occludes the reference's real panels + one mis-regioned cutout strip. FIXED (next run):
  photo-base branch now PRUNES placeholder slabs (grey #9aa0a6 stand-ins with no text/src/
  cutout) that only occlude real reference pixels.
Tests 52/52 green.

---

## POST-FIX SWEEP COMPLETE (renders now full-canvas & honest)

| id  | pixel | Δ vs baseline | notes |
|-----|-------|----------------|-------|
| 009 | 90    | ~=  | near-exact post; name="Volgend" bug → fixed after |
| 010 | 9.8   | −86 | DARK-TEMPLATE bug → theme param added after |
| 026 | 82.9  | new | first extraction success; pixel-coords pileup → normalizer added after |
| 050 | 97.5  | +9.7 | near-exact (avatar + rect media cutouts) |
| 052 | 85.4  | +1.7 | photo base landed; slab-prune fix after |
| 053 | 93.5  | +38.4 | photo-background class SOLVED |
| 078 | 89    | +4.2 | arrows fixed; structure good |
| 103 | 79.8  | +2.6 | x-post w/ media; inspect on final sweep |

avg 78.5 (dragged by 010's theme bug). FINAL sweep launching with the four mid-sweep fixes:
x-post light theme · follow-word name exclusion · pixel-coords normalizer · photo-base slab prune.

---

## Iteration 12 — 103 diagnosis: template-default LEAK class + redaction handling

103 post-fix render: chrome + media cutout right, but THREE default-leaks and one narration bug:
- Display name rendered the model's narration "blurred username text"; the reference scribbles
  the poster identity. FIXED: redaction detection in mapXPost (blur/redact/censor words or a
  blur-effect avatar/name layer) → name/handle become ▓-blocks + blurAvatar:true.
- Template DEMO DEFAULTS leaked: '@UpfrontFood' handle, '05:00 PM · 12-05-2026' timestamp and
  257/66/21K/89 counts stamped onto a DIFFERENT brand's ad. FIXED: mapXPost reads the real
  timestamp (time+date regex) and real counts; anything unfound is set to ' ' (blank), never
  the demo default.
Verified via synthetic extraction: redacted identity → blocks, real timestamp/views kept, counts
blanked. Tests 52/52 + preset 7/7. These fixes trail the FINAL sweep (in flight) — 103 (and any
x-post ad) gets one more re-run after it completes.

---

## Iteration 13 — FINAL sweep first half + 010/026 diagnosis

FINAL sweep so far: 009: 89.6 · 010: **93.5** (light theme fix worked — was 9.8) · 026: 79
(pixel normalizer worked; comparison preset now builds) · 050: 95.8.
- 010 render is near-exact (all ¶s, light chrome, real meta) EXCEPT the display name grabbed
  the headline "WAT. EEN. JAAR.". FIXED: name fallback anchors to the @handle — prefer the text
  layer sitting DIRECTLY ABOVE the handle; never take a candidate BELOW it.
- 026 shows the owner's "preset steals the copy" class: comparison preset replaced the pillow
  hero photo with its own furniture + demo leaks ("BUY 3, GET 1 FREE!", teal column). FIXES:
  (1) presetGeometryMatch SIGNAL C — a big (≥10% area) extracted photo region with no template
  image slot within 0.22 diag ⇒ photoMismatch ⇒ loose path; (2) mapComparison: badge blanked
  unless the reference has one; merged check/cross strings split into real items.
Tests 52/52 + 20 extract/clip green. These land AFTER the final sweep → 010/026 rerun needed.

---

## FINAL SWEEP COMPLETE — 8/8 · avg 90 (honest full-canvas renders)

| id  | pixel | trend (baseline→postfix→final) | state |
|-----|-------|-------------------------------|-------|
| 009 | 89.6 | 87.9 → 90 → 89.6 | near-exact; name fix pending re-run |
| 010 | 93.5 | 95.7* → 9.8 → 93.5 | near-exact; name fix pending re-run (*cropped) |
| 026 | 79   | FAIL → 82.9 → 79 | preset-steal; photo-slot gate pending re-run |
| 050 | 95.8 | 87.8 → 97.5 → 95.8 | near-exact |
| 052 | 98.1 | 83.7 → 85.4 → 98.1 | slab-prune landed; near-exact |
| 053 | 95.7 | 55.1 → 93.5 → 95.7 | photo-bg class solved |
| 078 | 88.3 | 84.8 → 89 → 88.3 | good structure; silhouette product (owner-intended) |
| 103 | 79.8 | 77.2 → 79.8 → 79.8 | redaction/leak fixes pending re-run |

Re-running 009,010,026,103 with the iteration-12/13 fixes for the closing table.

---

## Iteration 14 — content-level text dedupe (052 fragment pile)

052@98.1 verified visually: photo base + aligned overlays ≈ the original — EXCEPT a pile of
garbled duplicate text fragments top-left (multi-pass re-reads of the same copy at different
boxes; geometry dedupe can't see them). FIXED in extractLayout after dedupeRawLayers: WORD-level
content dedupe — a text layer whose words are ≥70% contained in a longer retained layer is a
re-read fragment and is dropped. Tests 52/52 + extract 16/16 green. (Lands after the in-flight
4-ad rerun; 052 numbers unaffected by that rerun anyway.)

---

## SESSION CLOSE — current state + HANDOFF (resume here)

### Current per-ad best (all honest full-canvas renders)
| id  | pixel | visual verdict |
|-----|-------|----------------|
| 009 | 89.8 | near-exact X-post (all ¶s, real avatar, meta, action counts) |
| 010 | 93.8 | near-exact light X-post (verify name fix in render — extraction took 43min this run) |
| 026 | 80   | STILL preset-stolen (see ESCALATE below) |
| 050 | 95.8 | near-exact (avatar + rect media cutouts) |
| 052 | 98.1 | near-exact; fragment-pile fix landed AFTER this number — expect cleaner rerun |
| 053 | 95.7 | photo-bg class solved, virtually the reference |
| 078 | 88.3 | good structure; arrows fixed; packshot = silhouette (owner-intended) |
| 103 | 79.6 | verify redaction/leak fixes in render (rerun used them) |
avg ≈ 90. Threshold judgment: ≥88 + side-by-side sanity = "same ad". 026/103 below bar.

### ESCALATE-TO-FABLE / open items (ranked)
1. **026 preset-steal persists (80)**: photoMismatch gate (SIGNAL C) may not fire because the
   extraction emits the pillow as `shape`, not `image` (Signal C only reads type image). Check
   scratchpad-work/copy-harness/026/extraction.json; if so, include big photo-ish `shape`
   regions (or any cutoutCandidate) in Signal C. Alternative: force loose path when the
   reference has ANY ≥10%-area image/shape region the template can't host. 4 focused attempts
   spent on 026 total — this is attempt 3; one more, then park it.
2. **103 at 79.6**: verify the ▓-redaction + blank counts landed (render at
   scratchpad-work/copy-harness/103/render.png); remaining gap is probably media crop region
   including the baked meta line (crop h too tall). Fix candidate: shrink cutout region bottom
   by the meta-line height when a timestamp text sits inside the media box.
3. **x-post meta row when reference has NO meta/actions** (010-class): template always renders
   the action row; a minimal screenshot reference has none. Consider `showActions:false` param
   set when no counts were read.
4. **name-fix verification** for 009/010 renders (was "Volgend"/headline before).
5. **PHASE 3 not started**: extend to the other 120 ads in ~8-ad batches
   (`node scripts/copy-harness.mjs --files a.webp,b.png,…`), fix new classes per batch.

---

## Iteration 15 (successor session) — Fable's 026-escalation diagnosis, all 3 fixes landed

Fable looked at the 026 side-by-side directly and diagnosed 3 generalizable failure mechanisms
(not re-diagnosed here, just implemented):

1. **Photo regions → grey slabs when extracted as `type:'shape'` (cutoutCandidates:0).** Root
   cause confirmed by reading `toSkeletonLayers`: the avatar/logo/photo cutout classifier
   (`cutoutClassify`) only ever runs inside the `type === 'image'` branch — a `type:'shape'`
   region (which is exactly how the model reads a giant two-column pillow photo) never reaches
   it at all. FIX: new deterministic pixel samplers in lib/layout-extract.mjs —
   `sampleRegionStats(imagePath, boxPct)` (border-inset region crop → luminance variance +
   16-bucket Shannon entropy + median-cut dominant hex) and `isPhotoLike(stats)` (entropy ≥1.8
   AND variance ≥0.0025 ⇒ real photo texture, not a flat fill). Wired into the `type==='shape'`
   branch: a ≥8%-canvas-area shape/card region that reads as photo-like gets
   `cutoutCandidate:{region,shape:'rect'}` stamped (same shape the image-branch produces) and
   counts toward `cutoutCount`. Both helpers exported for testing.
2. **Hallucinated region colors** (026's giant teal #19a5b8 column vs the real #f1f3f5 light
   grey). Same `sampleRegionStats` call: for a large shape/card region that is NOT photo-like,
   its real dominant hex is compared to the model's declared background/color via the existing
   `colorDistance` helper — a disagreement >0.18 overrides `style.background` with the sampled
   truth. Mirrors the existing glyph-color-sampler pattern (text) for region fills.
3. **Hallucinated/missing text content** (comparison preset's "OURS/THEIRS" replacing "Premium
   Silk/Satin"; dropped eyebrow/"vs" chip/CTA). The copy self-check's compare prompt
   (`COMPARE_PROMPT` in lib/self-vision.mjs) explicitly told the judge "Do NOT flag copy/text
   wording differences" — backwards for a COPY self-check, where reproducing the real words IS
   the point. FIX: new `COPY_TEXT_COMPARE_PROMPT` variant (self-vision.mjs) — explicitly asks
   for verbatim missing/different text vs the reference and tags text-content corrections
   `textFix:true`. `compareToReference(doc, path, {checkText:true})` selects it.
   `parseCorrections` now carries the `textFix` flag through. In design-agent.mjs's copy
   self-check block (`runDesignAgent`'s `opts.reference.path` branch): corrections are split into
   `textFixes` (run FIRST, nested `runDesignAgent` call gets `allowReferenceTextFix:true`) and
   `visualFixes` (existing behavior, still `keepCopy`-locked). The `keepCopy` setText/draftText
   guard in the op-apply loop now reads `if (keepCopy && !opts.allowReferenceTextFix && ...)` —
   surgical bypass, only set on that one nested self-check run; a normal user edit under
   `keepCopy` is still locked (verified both directions, see tests below).

New test/extract-photo-region.test.mjs (4 tests): synthetic flat PNG region → `isPhotoLike` false
+ hex sampled correctly; synthetic noisy PNG region → `isPhotoLike` true; `toSkeletonLayers` end
to-end on a big noisy shape region → cutoutCandidate stamped; on a big flat mis-colored shape
region → background overridden, no cutout. New test in test/design-agent-v3.test.mjs: `keepCopy
+ allowReferenceTextFix` bypasses the setText lock (the pre-existing `keepCopy` lock test is
untouched and still passes — both directions verified). Full suite: 91/91 green (was 86; +4 photo
-region +1 text-fix-bypass).

Also implemented ranked-queue item 4 (103's next-step): in `fillPresetFromExtraction`, the
`rawMedia` cutout-region stamping now checks for a timestamp/meta text layer (regex matches
`H:MM`, "views"/"weergaven"/"impressions", or a date) whose box sits inside the media box's
lower ~40% — if found, the cutout `region.h` is shrunk so the crop's bottom edge sits just above
that meta line, preventing the baked-in meta text from being cut out and then double-rendered
under the template's own rebuilt meta row.

FIRST 026 re-run (log: /tmp/harness-026-rerun.log) came back at 80, cutouts=0 — UNCHANGED. Root-
caused by reading extraction.json: 026 resolves to the `comparison` ARCHETYPE/PRESET path
(`fillPresetFromExtraction`/`presetGeometryMatch`), not the generic `toSkeletonLayers` loose path
my type:'shape' photo-ness fix targets — that fix was correct but simply never reached for this
ad. The REAL gate for "should this snap onto the comparison preset" is `presetGeometryMatch`'s
SIGNAL C (`photoMismatch`), and it had TWO bugs of its own, both now fixed:
  a. Signal C only ever considered `type==='image'` layers — the model reads 026's giant pillow
     photo as two `type:'shape', role:'card'` regions ("Left half"/"Right half"), so `bigImgs`
     was always empty and `photoMismatch` never fired. FIX: `bigImgs` (factored into a new
     exported `bigPhotoMismatch(raw, presetLayers, canvas)` helper) now also accepts large
     shape/card regions matched by a loose keyword regex.
  b. WORSE: `presetGeometryMatch` has an EARLY RETURN — "too little text to judge geometry →
     trust the preset" — whenever fewer than 2 text layers were extracted on EITHER side. 026's
     read only produced ONE text layer ("Silk"), so this fired and skipped Signal C entirely
     regardless of fix (a). FIX: the early-return branch now still calls `bigPhotoMismatch` before
     trusting the preset.
  c. STILL WOULDN'T HAVE FIRED even with (a)+(b): the comparison template's own small packshot
     slots (`role:'product'`, ~324×576px, ~16% of canvas) sit in the same left/right COLUMNS as
     026's half-canvas photo panels, so a purely proximity-based "is there a nearby slot" check
     (centroid distance ≤0.22 diag) falsely counted them as covering a region roughly 3x their
     area. FIX: `bigPhotoMismatch` now also requires the candidate slot to be ≥50% the extracted
     region's AREA, not just nearby — verified with a standalone repro script before committing
     (mismatch flips false→true only after all three fixes land together).
New test/extract-preset-fill.test.mjs case ("a big shape/card photo region with no comparable
preset slot forces the loose path (ad 026)") locks in all three fixes together: `pairs:0` (sparse-
text path), `photoMismatch:true`, `match:false`. Full suite 92/92 green.

SECOND 026 re-run launched in background (log: /tmp/harness-026-rerun2.log) with all three
fixes — check scratchpad-work/copy-harness/026/{result.json,side-by-side.png} for the outcome
before trusting any number in a closing table. Expect it to now take the LOOSE path (real photo
cutout of the pillow, real "Premium Silk"/"Premium Satin" copy) instead of the comparison preset.

### SESSION CLOSE (this successor) — HANDOFF

026's SECOND re-run (all 3 presetGeometryMatch/bigPhotoMismatch fixes landed) was STILL IN
FLIGHT (background pid, log /tmp/harness-026-rerun2.log) when this session closed — check
`scratchpad-work/copy-harness/026/{result.json,side-by-side.png,extraction.json}` FIRST THING
next session. Expected: 026 now takes the LOOSE path (photoMismatch:true correctly rejects the
comparison-preset snap), so extraction.json should show real cutoutCandidate regions on the two
photo halves instead of the `comparison` template/params block with hallucinated "OURS/THEIRS"
and the teal `#19a5b8` — read the side-by-side to confirm visually, don't trust pixel score alone
(same discipline as every prior iteration).

### Ranked queue status
1. **026 preset-steal — 3 root-cause bugs FIXED this session** (see Iteration 15 above): Signal C
   type-restriction, sparse-text early-return skipping Signal C, and proximity-only slot matching
   with no area check. Verify with the in-flight rerun above; if the loose-path render still has
   issues (e.g. the two photo-halves crop correctly but copy/labels are off), that's a NEW
   iteration, not a re-diagnosis of the same bug — Fable's original 3-bug diagnosis is now fully
   implemented in code.
2. **103 media-crop shrink (was queue item 4) — IMPLEMENTED this session**: `fillPresetFromExtraction`
   now shrinks the media cutout region's bottom edge above any timestamp/meta text layer sitting
   inside the media box's lower ~40%. NOT YET RE-VERIFIED against a live 103 render — do that
   next (`node scripts/copy-harness.mjs --only 103`).
3. **x-post showActions:false (was queue item 3, 010-class) — IMPLEMENTED this session**:
   x-post-ad template gets a new `showActions` param (default true); mapXPost sets it false when
   NO timestamp/views/reply/repost/like/bookmark signal was found at all, collapsing the meta+
   action rows to zero height so the body gets full canvas space. NOT YET RE-VERIFIED against a
   live render.
4. **009/010 name-fix verification (queue item 4/5, still open)**: run
   `node scripts/copy-harness.mjs --only 009,010` next (AFTER 026 finishes — sequential only) and
   confirm both still score ≥ their last-known-good numbers (009: 89.6-90, 010: 93.5-93.8) with
   the accumulated fixes from this session (none of this session's changes should regress either,
   but neither was re-run this session — verify, don't assume).
5. **Fable's copy self-check text-fix (queue item "3" in the escalation brief) — IMPLEMENTED**:
   `compareToReference(doc, path, {checkText:true})` + `COPY_TEXT_COMPARE_PROMPT` +
   `opts.allowReferenceTextFix` bypass in design-agent.mjs's copy self-check block. This is
   ACTIVE on every live copy-reference run now (guarded by `process.env.VISION_BASE_URL` same as
   before) — the next full harness sweep will exercise it for real; watch for hallucinated-copy
   ads (026-class, any future comparison/before-after ad) actually getting their real text fixed
   in the self-check round, not just flagged.
6. **PHASE 3 not started**: 128 ads confirmed present in `~/Downloads/IMAGE AD INSPO/`
   (`ls | wc -l` = 128). Once the 8-target regression is clean, batch via
   `node scripts/copy-harness.mjs --files <8 filenames>,...` per the ranked queue's original
   plan — batches of ~8, diagnose new failure classes, full 8-ad regression every ~3 batches.

### This session's code changes (all uncommitted, lib/* + test/* only — no src/ or studio-server.mjs touched)
- lib/layout-extract.mjs: `sampleRegionStats` + `isPhotoLike` (exported) — photo-ness/dominant-
  color pixel sampler for `type:'shape'` regions; wired into `toSkeletonLayers`'s shape branch
  (cutout stamping + hallucinated-fill override). `bigPhotoMismatch` (exported, factored out of
  `presetGeometryMatch`) — the 3-bug-fixed Signal C, also now runs on the sparse-text early-return
  path. `fillPresetFromExtraction`'s `rawMedia` stamping shrinks the cutout region above a baked-
  in meta line. `mapXPost` sets `params.showActions = false` when no meta/action signal was read.
- lib/templates.mjs: x-post-ad gets `showActions` param — collapses meta+action rows to zero
  height when false.
- lib/self-vision.mjs: `COPY_TEXT_COMPARE_PROMPT` (new) + `compareToReference(...,{checkText})`
  + `parseCorrections` carries `textFix` flag.
- lib/design-agent.mjs: copy self-check splits corrections into textFixes (nested run gets
  `allowReferenceTextFix:true`, bypasses keepCopy's setText/draftText lock ONLY there) and
  visualFixes (unchanged existing behavior). The keepCopy lock guard itself now reads
  `if (keepCopy && !opts.allowReferenceTextFix && ...)`.
- New tests: test/extract-photo-region.test.mjs (4 tests, synthetic PNGs), 1 new test in
  test/design-agent-v3.test.mjs (text-fix bypass, verified BOTH directions against the existing
  lock test), 1 new test in test/extract-preset-fill.test.mjs (026-class photo-slot-mismatch
  regression guard). Full suite 92/92 green as of this session's close (was 86 at handoff).

### Runtime facts for the successor
- ornith at :1234 (only model; never gemma). Extraction 2-43 min/ad (high variance; dense/light
  posts are slowest). Harness budget 600s; sequential only.
- Lib changes are ALL uncommitted in the working tree (many other-agent changes present too —
  do NOT commit without the owner). Tests: `npm run test:agent` (52) + `node --test
  test/template-element-clip.test.mjs test/extract-*.test.mjs` all green as of close; full
  `npm test` 86/86 green mid-session.
- Artifacts: scratchpad-work/copy-harness{,-baseline,-postfix1,-final1}/<ad>/{render,side-by-side,
  extraction,doc,result}. Old sweeps' logs: /tmp/harness-{full-sweep2,postfix-sweep,final-sweep,
  rerun4}.log.
