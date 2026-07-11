# Emoji detection + known-icon substitution — spec

Research + implementation spec for two capabilities in the copy-engine rebuild
(`docs/COPY-ENGINE-V2.md` §"Native-ad gauntlet"). Both hook into the element pipeline
BEFORE `vectorizeElement()`, so native chrome and emoji never get traced.

- **Owner:** copy-engine V2. **Status:** spec only (no code written by this workstream).
- **New modules to build:** `lib/emoji-detect.mjs`, `lib/icon-match.mjs`.
- **Constraint:** everything local + free. No paid APIs, no network at runtime (atlases
  are downloaded once into `.state/` and committed/cached).
- **Golden rule:** emoji are NEVER vectorized. Output is either the emoji **character** as a
  Figma text run (Figma renders the platform emoji font natively) or the **platform PNG
  asset** as an image fill when set fidelity matters. Known icons are replaced with
  **canonical vectors** from `lib/native-icons.mjs`, keeping the detected box + a proper name.

---

## 0. Where this sits in the pipeline

`lib/element-detect.mjs` already classifies each connected-component candidate into
`kind: 'shape' | 'icon' | 'photo-fragment'` (see `element-detect.mjs:294-302`). The `'icon'`
rule: `area < 4% canvas AND edgeDensity ≥ 12%` (`opts.iconMaxCanvasFrac=0.04`,
`iconEdgeDensity=0.12`). Emoji candidates land here too — they are small, square-ish, and
edge-dense — but they are **colorful** (many dominant colors) whereas UI-chrome icons are
**monochrome**. That colorfulness split is the first-line router.

Current flow (S4 detect → S6 cutout/vectorize):

```
element-detect → kind:'icon' candidate ──▶ vectorizeElement()   (traces everything today)
```

New flow — insert two matchers ahead of the tracer:

```
kind:'icon' candidate
   │  colorfulness gate  (dominantColors, saturation, non-gray fraction)
   ├─ COLORFUL  ─▶ emoji-detect.matchEmoji()   → hit? emit {kind:'emoji', char, codepoint, set}
   │                                             miss ▼
   └─ MONOCHROME ─▶ icon-match.matchIcon()      → hit? emit {kind:'icon', iconId, d, box}
                                                  miss ▼
                                        vectorizeElement()   (unchanged fallback / trace)
```

Both matchers are pure functions over `(imagePath, box)` returning
`{ hit, confidence, ... } | null`. The pipeline takes the first hit above its gate; on
double-miss it falls through to the existing `vectorizeElement()` (`lib/vectorize.mjs:374`,
which already has its own `VEC_MIN_SCORE = 0.90` accept gate). No existing behavior changes
on a miss — this is strictly additive.

Reuse: `lib/icon-extract.mjs` already provides `detectIconRegion`, `cropIcon`,
`removeBackground`, `analyzeShapeComplexity` — the crop/normalize front-half of both matchers
should call these rather than re-implement. `sharp` is installed and is the raster workhorse.

---

## 1. Sources — atlases + icon sets (exact curl commands)

All CDNs below were live-verified (HTTP 200) from this machine. **Filename casing differs
per set** — Twemoji + Noto use **lowercase** hex; OpenMoji uses **UPPERCASE** hex. Multi-
codepoint sequences (skin tone, ZWJ) join codepoints with `-` (Twemoji/OpenMoji) — Noto
prefixes each with `_u`/`_` in one filename.

| Set | Purpose | License | Layout | Download |
|---|---|---|---|---|
| **jdecked/twemoji** (Twitter/X, Discord) | atlas + runtime asset for Twemoji-set ads | MIT (code) / CC-BY 4.0 (art) | `assets/72x72/<lower-hex>.png`, also `svg/` | see below |
| **googlefonts/noto-emoji** (Google/Android) | Noto-set atlas | Apache-2.0 (code) / OFL (font) | `png/128/emoji_u<lower-hex>.png` | see below |
| **hfg-gmuend/openmoji** | open fallback set, distinctive style | CC-BY-SA 4.0 | `color/72x72/<UPPER-HEX>.png`, `color/svg/` | see below |
| **Apple Color Emoji** | Apple-set atlas (dominant in this corpus) | Apple proprietary — **local render only, do NOT redistribute** | render from `/System/Library/Fonts/Apple Color Emoji.ttc` (on-Mac) | §1.4 |
| **WhatsApp / Samsung** | rarer sets — identification only | proprietary | not bundled; identify by pHash distance being *far* from all bundled sets → label "other" | — |

### 1.1 Twemoji (jdecked — the maintained fork; twitter/twemoji is archived)
```bash
# single glyph (hourglass U+231B):
curl -sL "https://cdn.jsdelivr.net/gh/jdecked/twemoji@latest/assets/72x72/231b.png" -o 231b.png
# whole 72x72 set as a tarball (pin a tag in practice, e.g. @15.1.0):
curl -sL "https://github.com/jdecked/twemoji/archive/refs/heads/master.tar.gz" -o twemoji.tgz
tar xzf twemoji.tgz && ls twemoji-*/assets/72x72 | wc -l   # ~3600 pngs
```

### 1.2 Noto emoji (Google)
```bash
curl -sL "https://raw.githubusercontent.com/googlefonts/noto-emoji/main/png/128/emoji_u231b.png" -o noto_231b.png
# bulk:
curl -sL "https://github.com/googlefonts/noto-emoji/archive/refs/heads/main.tar.gz" -o noto.tgz
tar xzf noto.tgz && ls noto-emoji-*/png/128 | wc -l
```

### 1.3 OpenMoji (note UPPERCASE filenames)
```bash
curl -sL "https://cdn.jsdelivr.net/gh/hfg-gmuend/openmoji@latest/color/72x72/231B.png" -o openmoji_231B.png
curl -sL "https://github.com/hfg-gmuend/openmoji/archive/refs/heads/master.tar.gz" -o openmoji.tgz
```

### 1.4 Apple Color Emoji atlas — render locally (font is on this Mac)
`Apple Color Emoji.ttc` (192 MB, `/System/Library/Fonts/`) ships the CBDT/sbix bitmap
strikes. Build a `160x160` PNG per codepoint once, cache under
`.state/emoji-atlas/apple/<lower-hex>.png`. Two viable renderers (headless Chrome is already
a project dependency for render/score):

**Option A — headless Chrome (preferred, matches our render stack):** load an HTML page that
sets `font-family: "Apple Color Emoji"` and prints one emoji per codepoint at large size;
screenshot each glyph box. Emoji font substitution happens automatically on macOS Chrome.

**Option B — CoreText via a tiny Swift CLI** (same pattern as the Apple Vision OCR CLI the
repo already uses): `CTFontCreateWithName("Apple Color Emoji", 128)` → draw glyph → write
PNG. Fastest, no browser.

Codepoint list to render = the **top-500 union** of the three bundled sets' filenames (covers
essentially every emoji seen in ads — see §3 corpus, which only uses ~9 distinct glyphs).
Include the skin-tone-modified and ZWJ variants that actually appear (§2.4).

### 1.5 Known-icon vectors — ALREADY IN REPO (no download needed)
`lib/native-icons.mjs` (284 lines) is the canonical vector library. It exports
`NATIVE_ICONS` (flat-id registry) + `nativeIcon(id)`. Full inventory in §4. Provenance is
strong: X and Instagram action icons are **verbatim paths extracted from logged-in
x.com/instagram.com live DOM**; the rest are Bootstrap Icons (MIT) + simple-icons (CC0) brand
marks. Paths are pre-normalized to a `0..1` box (`style.path` convention) so they drop
straight into a layer. `lib/notes-icons.mjs` adds iOS-Notes chrome (chevron, share, more-dots,
checklist). Legal SVG top-up sources if a glyph is missing: Bootstrap Icons (MIT), Lucide/
Feather (ISC/MIT), simple-icons (CC0) — all `curl`-able from their GH raw, but the in-repo set
already covers the gauntlet's X/IG/iOS chrome.

---

## 2. Emoji detect + identify — `lib/emoji-detect.mjs`

### 2.1 Module API
```js
// Build once at startup (or lazy on first call); caches decoded 64x64 atlases in memory.
export async function loadEmojiAtlases(opts = {}) : Promise<EmojiAtlas>
//   EmojiAtlas = { sets: { apple, twemoji, noto, openmoji }, phash: Map<codepoint, {set: hash}> }

// Main entry — called by the pipeline on a COLORFUL kind:'icon' candidate.
export async function matchEmoji(imagePath, box, atlas, opts = {}) : Promise<{
  hit: boolean,
  char: string,        // the actual emoji character(s), e.g. "⏳", "🙌🏻"
  codepoint: string,   // dash-joined lower-hex, e.g. "231b", "1f64c-1f3fb"
  set: 'apple'|'twemoji'|'noto'|'openmoji'|'other',
  setConfidence: number,   // 0..1, how strongly it matches THAT set vs others
  confidence: number,      // 0..1 overall glyph-ID confidence
} | null>

// Convenience for a whole text line (see §2.5 OCR interplay).
export async function scanTextRunForEmoji(imagePath, textBox, atlas, opts) : Promise<EmojiSpan[]>
```

### 2.2 Colorfulness gate (routes candidate to emoji vs icon)
Compute on the cropped candidate (reuse `icon-extract.cropIcon`):
- `distinctDominantColors` (quantize to 3-bit/channel, same as element-detect's `domColors`).
- `meanSaturation` (HSV) and `nonGrayFraction` (pixels with S > 0.15).
- **Emoji route** when `nonGrayFraction ≥ 0.25` OR `distinctDominantColors ≥ 4`.
  Monochrome UI icons fail this and go to `icon-match` first. (A monochrome emoji rendered on
  a matching-color bg is rare in ads; on a miss it still falls through to icon-match → trace.)

### 2.3 Matching pipeline (per candidate)
1. **Normalize:** alpha-trim to glyph bbox, pad to square, resize to `64×64` (sharp,
   `fit:'contain'`, transparent → white flatten to match atlas backgrounds).
2. **Coarse recall — perceptual hash:** DCT pHash (16×16 → top-left 8×8, 64-bit). Compare the
   candidate's pHash to every atlas entry's pHash for **each set**; keep the top-K (K≈10)
   nearest codepoints by Hamming distance. pHash is illumination/scale robust and cheap
   (precomputed for the atlas).
3. **Fine rank — NCC on 64×64:** for the K candidates, run normalized cross-correlation (or
   per-pixel SSIM) of the RGBA against each set's rendering. Best `(codepoint, set)` wins.
4. **Set identification:** the SAME codepoint is scored across all 4 sets; the set with the
   highest NCC is the identified platform. Report `setConfidence = best − secondBest` (margin).
   Apple vs Noto vs Twemoji renderings differ strongly in shading/outline, so the margin is
   usually decisive; a small margin (< 0.05) → keep codepoint, set `'other'` (unknown set,
   still emit the character).

### 2.4 Skin tone + ZWJ sequences
- **Skin tone:** modifiers U+1F3FB..1F3FF attach to the base. Detect by matching the base
  glyph then classifying the dominant hand/face hue into one of 5 Fitzpatrick buckets; append
  the modifier codepoint. Corpus 010 has `🙌🏻` = `1f64c-1f3fb`. The atlas must include the
  toned variants for glyphs that commonly appear toned (hands, faces).
- **ZWJ sequences** (e.g. families, `🧑‍🍳`): treated as ONE glyph by the renderer and by our
  atlas — key the atlas by the full dash-joined codepoint string. Match against the composed
  rendering, not the parts. Keep only the ZWJ sequences present in the top-500 union.
- Output the composed **character** verbatim so the Figma text path reproduces it exactly.

### 2.5 OCR interplay (important, and a gotcha)
- **Apple Vision OCR generally DROPS emoji** from recognized-text results (it returns the
  surrounding letters and silently omits the emoji glyph), and even when present, box
  coordinates are unreliable. So **do not rely on OCR to find emoji.** Detect them as
  colorful `kind:'icon'` connected components from element-detect instead.
- The practical consequence: after OCR lays out a text run, there may be a **gap** where an
  emoji sat (e.g. 009 `"...VAN 2026 ⏳"` — OCR yields the text, the ⏳ is a separate colorful
  CC to the right of the last word). `scanTextRunForEmoji()` reconciles: find colorful CCs
  whose vertical center sits on a text line's baseline band and whose height ≈ cap-height →
  splice them into the run as inline emoji spans at the correct character offset.
- Inline vs standalone: 017's `😤` is a standalone large emoji (its own layer); 010's
  `🥹😪🤝` is an inline cluster inside a heading run. Both handled by the same detector; the
  difference is only whether the emoji span is merged into a text layer (inline) or emitted as
  its own layer (standalone, height ≳ 1.5× line cap-height).

### 2.6 Thresholds (starting values — tune on corpus)
| Gate | Value |
|---|---|
| colorfulness → emoji route | `nonGrayFraction ≥ 0.25 OR domColors ≥ 4` |
| pHash recall Hamming max | `≤ 18 / 64` to stay in top-K |
| NCC accept (`confidence`) | `≥ 0.82` → hit; else fall through to trace |
| set-ID margin | `≥ 0.05` → name the set; else `set:'other'` |
| skin-tone hue confidence | `≥ 0.6` else emit base glyph (no modifier) |

---

## 3. Corpus ground truth (vision inventory)

Read directly from the images. Boxes are approximate fractions of the frame `(x, y, w, h)`,
origin top-left. This is the **test oracle** for both matchers.

### 009 — `009_attached_885c19be…png` — X post, DARK theme (1080²)
Emoji:
- `⏳` **hourglass with sand** U+231B — Apple set — inline, end of headline "…VAN 2026 ⏳" —
  box ≈ `(0.66, 0.30, 0.05, 0.05)`.
- `👀` **eyes** U+1F440 — Apple set — inline, end of "…om 20:00 uur. 👀" —
  box ≈ `(0.60, 0.68, 0.055, 0.045)`.

Known icons (monochrome chrome → substitute from `NATIVE_ICONS`):
- back chevron `x-back` top-left ≈ `(0.02, 0.05, 0.06, 0.05)`.
- more `x-more` (··· ) top-right ≈ `(0.90, 0.05, 0.07, 0.03)`.
- verified badge `x-verified-badge` after "UPFRONT" ≈ `(0.33, 0.145, 0.035, 0.035)`.
- action row bottom: `x-reply` `(0.03,0.95)`, `x-repost` `(0.27,0.95)`, `x-like-outline`
  `(0.51,0.95)`, `x-bookmark-outline` `(0.71,0.95)`, `x-share` `(0.95,0.95)` (each ≈0.05 wide).
- "Volgend" (Follow) pill = shape+text, not an icon; avatar = circular image (Figma ellipse mask).

### 010 — `010_attached_d1da6c1f…png` — X post, LIGHT theme (1080×1920)
Emoji:
- `🥹` face-holding-back-tears U+1F979, `😪` sleepy U+1F62A, `🤝` handshake U+1F91D — Apple set
  — inline cluster after "WAT. EEN. JAAR. " ≈ `(0.40, 0.35, 0.14, 0.03)` (three adjacent).
- `🙌🏻` raising-hands + light skin tone `1f64c-1f3fb` — Apple set — end of last line
  "…voordeel mee. 🙌🏻" ≈ `(0.38, 0.79, 0.05, 0.03)`. **Skin-tone modifier test case.**

Known icons: `x-verified-badge` after "UPFRONT" ≈ `(0.40, 0.26, 0.03, 0.03)`; avatar =
circular monochrome logo mark (line-art crest) — trace or image, not in icon set.

### 017 — `017_attached_92769a94…png` — IG-caption style (1080×1920)
Emoji:
- `😤` face-with-steam-from-nose U+1F624 — Apple set — **standalone, large, centered** at top
  ≈ `(0.45, 0.13, 0.10, 0.06)`. No native chrome; pure text + one hero emoji.

### 107 — `107_attached_3fba9647…png` — complex-vector benchmark (1080×1920)
No emoji. Vector/icon content (these go to `vectorize`, not the icon set):
- circled down-arrow glyph left of "58%" ≈ `(0.27, 0.24, 0.06, 0.055)` — could match a generic
  "arrow-down-circle" if we add it to the set; otherwise trace.
- line chart: polyline + 5 dot markers + arrowhead terminal; horizontal gridlines; orange
  callout box "DAILY HYDRATION". All crisp-vector → `vectorize` (the IG-simple-graphics path).

### 005 — `005_attached_23b6641d…png` — product/brand (control)
No emoji, no native chrome. Confirms the colorfulness gate must not fire on product photos
(they're colorful but large — element-detect's `kind:'photo-fragment'`/area gate excludes
them before emoji-detect ever sees them).

**Set-identification finding:** every emoji in the native-ad corpus is **Apple**-rendered
(these are iOS screenshots / iOS-authored captions). Apple-set fidelity therefore matters most
— confirming §1.4 (local Apple atlas) is the priority build. Twemoji/Noto atlases exist mainly
to *disambiguate* (prove it's Apple by large NCC margin) and to serve the occasional Android/
web-sourced ad.

---

## 4. In-repo icon inventory (`lib/native-icons.mjs` + `lib/notes-icons.mjs`)

Already available as canonical `0..1`-normalized vector paths — this is the substitution
atlas. `nativeIcon(id)` → `{ d, viewBox, source, hex? }`.

**X / Twitter** (`x-*`): `reply`, `repost`, `like-outline`, `like-filled`, `bookmark-outline`,
`bookmark-filled`, `share`, `verified-badge`, `more`, `back`.
_reply/repost/like-outline/bookmark-outline/share/verified-badge/more = verbatim x.com DOM
paths; like-filled/back = Bootstrap approximations._

**Instagram** (`ig-*`): `heart-outline`, `heart-filled`, `comment`, `repost`, `share`,
`bookmark-outline`, `bookmark-filled`, `more`, `verified-badge`.
_heart-outline/comment/repost/share = verbatim instagram.com DOM paths; rest = Bootstrap._

**iOS** (`ios-*`): `back`, `check`, `circle-unchecked` (Bootstrap Icons).

**Brand marks** (`...BRAND_ICONS`, simple-icons CC0, carry `hex`): X, Instagram, Facebook,
TikTok, WhatsApp, Trustpilot star.

**Notes chrome** (`lib/notes-icons.mjs`): `NOTES_CHEVRON_BACK`, `NOTES_SHARE_ICON`,
`NOTES_MORE_CIRCLE_RING`+`_HOLE`+`_DOTS`, `NOTES_CHECKLIST_DONE_CIRCLE`+`_CHECK`, plus
`NOTES_REAL_COLORS`.

**Gaps to fill** (top-up from Bootstrap/Lucide MIT when the gauntlet needs them):
- X `like-filled` / `back` are approximations — capture verbatim from live DOM for parity.
- No `arrow-down-circle` (107 uses one) — add from Bootstrap `arrow-down-circle`.
- No generic iOS chevron-right, share-up-arrow, bell (notification mockups) — add as needed.

---

## 5. Known-icon substitution — `lib/icon-match.mjs`

### 5.1 Module API
```js
// Build a rendered atlas of NATIVE_ICONS once: rasterize each path to 64x64 monochrome, cache.
export async function loadIconAtlas(opts = {}) : Promise<IconAtlas>
//   IconAtlas = { entries: [{ id, silhouette: Float32Array(64*64), aspect }] }

export async function matchIcon(imagePath, box, atlas, opts = {}) : Promise<{
  hit: boolean,
  iconId: string,      // e.g. 'x-like-outline'  → caller does nativeIcon(iconId)
  confidence: number,  // 0..1
  d: string, viewBox,  // convenience passthrough of the canonical path
} | null>
```

### 5.2 Pipeline
1. **Binarize** the crop (monochrome chrome → Otsu threshold; keep foreground mask). Reuse
   `icon-extract.detectIconRegion` / `analyzeShapeComplexity` for the region + complexity.
2. **Normalize** to `64×64` silhouette (aspect-preserve, center).
3. **Silhouette NCC** against every atlas entry's rendered silhouette (rotation not needed —
   UI icons are axis-aligned). This mirrors the existing font silhouette-matcher approach the
   repo already uses (`lib/font-match.mjs`). Optionally gate candidates first by aspect ratio.
4. **Accept** on `confidence ≥ 0.88`. On accept, emit a layer that **keeps the detected box**
   and swaps geometry for `nativeIcon(iconId)`'s canonical `d` + a **role-based name**
   (§6). On miss → `vectorizeElement()` (trace) unchanged.

### 5.3 Thresholds
| Gate | Value |
|---|---|
| icon route | monochrome (fails emoji colorfulness gate) |
| silhouette NCC accept | `≥ 0.88` |
| aspect prefilter | keep entries within `±25%` of candidate aspect |
| ambiguous filled/outline | tie-break by foreground-fill fraction (filled ≫ outline) |

---

## 6. Figma export notes

**Emoji → text, not vector.**
- **Inline** emoji (009 ⏳, 010 🥹😪🤝🙌🏻): keep as characters inside the text run's string.
  Figma renders them with the platform emoji font — no glyph work needed. The text layer's
  font stack should include the emoji font so the intended set shows (name the layer
  e.g. `heading/text` and leave emoji in the string).
- **Standalone / set-fidelity-critical** (017 😤 as a hero element, or when the identified set
  must be preserved regardless of the viewer's OS): emit an **image fill** layer using the
  platform PNG asset (`.state/emoji-atlas/<set>/<codepoint>.png`) at the detected box. Name it
  `emoji/<name>` (e.g. `emoji/face-with-steam`). This guarantees Apple-set rendering even when
  opened on a non-Apple machine.
- Carry metadata on the layer: `{ emoji: true, codepoint, set, char }` so downstream can flip
  between text-run and image-fill representations.

**Known icon → canonical vector, keep the box, give it a real name.**
- Substitute the `nativeIcon(id).d` path into a vector layer at the original detected box.
- **Role-based naming** (html.to.design quality): `x-like-outline` → layer name
  `action/like`; `x-verified-badge` → `badge/verified`; `x-back` → `nav/back`. Group the X
  action row under a frame `post/actions`. This is what makes the exported tree read
  semantically instead of `Vector 47`.
- Circular avatars/images (009, 010) export as a real **Figma ellipse mask** over the image
  fill (per gauntlet requirement 041), independent of this icon work.

---

## 7. Build order (smallest useful increments)

1. `icon-match.mjs` first — zero new assets (atlas renders from in-repo `NATIVE_ICONS`), and
   it immediately upgrades the 009 X-chrome (10+ icons) from traced to canonical.
2. Apple emoji atlas (§1.4) + `emoji-detect.mjs` colorfulness gate + pHash/NCC — unlocks 009,
   010, 017 emoji as text/asset instead of garbage traces. Apple-only atlas is enough for the
   whole corpus; add Twemoji/Noto for set-ID margin + non-iOS ads.
3. Skin-tone + ZWJ handling (§2.4) — needed for 010 `🙌🏻`.
4. Wire both ahead of `vectorizeElement()` in the S4→S6 route; regression-test the five named
   gauntlet ads (009, 107, 093, 041, 020) for zero regressions on miss.
