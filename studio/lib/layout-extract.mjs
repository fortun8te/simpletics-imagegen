// lib/layout-extract.mjs — "copy this ad's design": reference image → layout skeleton.
//
// The core of reference-first Design mode. Sends the ad image to codex vision
// (`codex exec -i <file>` — verified available) and asks for the OVERLAY design only —
// text blocks, badges, buttons, scrims — as constrained JSON with percentage coords.
// The reply is parsed tolerantly, validated, clamped, and converted to canonical
// 1080-wide canvas px (see src/lib/sceneGraph.ts Skeleton).
//
// Won't be pixel-perfect and doesn't need to be: the editor shows the reference as a
// tracing-paper underlay so the user nudges what vision got wrong. Extraction runs ONCE
// per reference — the resulting skeleton is persisted (lib/skeletons.mjs) and stamped on
// the TrendTrack ad record, so re-using a reference costs nothing.
//
// A failed/unparsable extraction returns { ok:false } with a retryable error. Never throws
// for model reasons. Vision is ONLY the configured endpoint (llmVision/LM Studio) — the codex
// CLI vision fallback has been removed.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { llmVision, llmInfo } from './llm.mjs';
import { spawnSync } from 'node:child_process';
import { buildTemplate } from './templates.mjs';
import { groupBounds } from './scene-tree.mjs';

/** Real image aspect ratio (h/w) via sips — deterministic, so the comp copies the reference's
 *  EXACT proportions instead of trusting the vision model's guessed canvasRatio. */
function imageRatio(imagePath) {
  try {
    const r = spawnSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', imagePath], { encoding: 'utf8', timeout: 5000 });
    const w = Number((r.stdout.match(/pixelWidth:\s*(\d+)/) || [])[1]);
    const h = Number((r.stdout.match(/pixelHeight:\s*(\d+)/) || [])[1]);
    if (w > 0 && h > 0) return h / w;
  } catch { /* sips unavailable → fall back to the model ratio */ }
  return null;
}

// ── Deterministic background sampler ─────────────────────────────────────────────────────────
// FIX 1: the model routinely omits `background` (→ caller defaults to white) or reports a color
// with the wrong luminance ("picked white when the bg was clearly black"). Fix at the source:
// decode the PNG ourselves (node:zlib is built in — no npm dep) and AVERAGE the border/frame
// pixels, which are almost always the ad's background. Non-PNG inputs (JPG/WEBP, or a PNG-named
// WEBP) are transcoded to PNG via `sips -s format png` first.

const toHex = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
const rgbToHex = (r, g, b) => `#${toHex(r)}${toHex(g)}${toHex(b)}`;
const relLum = (r, g, b) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; // 0..1
function hexToRgb(hex) {
  const h = String(hex || '').replace('#', '');
  if (h.length >= 6) return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
  if (h.length >= 3) return { r: parseInt(h[0] + h[0], 16), g: parseInt(h[1] + h[1], 16), b: parseInt(h[2] + h[2], 16) };
  return null;
}

/** Paeth predictor (PNG filter type 4). */
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * Minimal zero-dep PNG decoder → { width, height, channels, data } (raw bytes, 8-bit).
 * Handles 8-bit RGB (colorType 2) and RGBA (colorType 6), non-interlaced, with all five
 * standard line filters (0 None, 1 Sub, 2 Up, 3 Average, 4 Paeth). Returns null for anything
 * else (grayscale/palette/16-bit/interlaced) so the caller can transcode + retry. Never throws.
 */
function decodePng(buf) {
  try {
    if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) return null; // PNG signature
    let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
    const idat = [];
    let off = 8;
    while (off + 8 <= buf.length) {
      const len = buf.readUInt32BE(off);
      const type = buf.toString('ascii', off + 4, off + 8);
      const dataStart = off + 8;
      if (type === 'IHDR') {
        width = buf.readUInt32BE(dataStart);
        height = buf.readUInt32BE(dataStart + 4);
        bitDepth = buf[dataStart + 8];
        colorType = buf[dataStart + 9];
        interlace = buf[dataStart + 12];
      } else if (type === 'IDAT') {
        idat.push(buf.subarray(dataStart, dataStart + len));
      } else if (type === 'IEND') {
        break;
      }
      off = dataStart + len + 4; // skip data + CRC
    }
    if (!width || !height || bitDepth !== 8 || interlace !== 0) return null;
    const channels = colorType === 2 ? 3 : colorType === 6 ? 4 : 0;
    if (!channels) return null; // only RGB / RGBA
    const raw = inflateSync(Buffer.concat(idat));
    const stride = width * channels;
    if (raw.length < (stride + 1) * height) return null;
    const out = Buffer.alloc(stride * height);
    let prevRow = Buffer.alloc(stride); // all-zero scanline above row 0
    let pos = 0;
    for (let y = 0; y < height; y++) {
      const filter = raw[pos++];
      const row = out.subarray(y * stride, y * stride + stride);
      for (let i = 0; i < stride; i++) {
        const x = raw[pos++];
        const a = i >= channels ? row[i - channels] : 0;       // left
        const b = prevRow[i];                                   // up
        const c = i >= channels ? prevRow[i - channels] : 0;    // up-left
        let val;
        switch (filter) {
          case 1: val = x + a; break;                           // Sub
          case 2: val = x + b; break;                           // Up
          case 3: val = x + ((a + b) >> 1); break;              // Average
          case 4: val = x + paeth(a, b, c); break;              // Paeth
          default: val = x;                                     // None (0) or unknown
        }
        row[i] = val & 0xff;
      }
      prevRow = row;
    }
    return { width, height, channels, data: out };
  } catch { return null; }
}

/** Decode via our PNG reader, transcoding JPG/WEBP (or PNG-named non-PNG) to PNG with sips
 *  first when needed. Returns { width, height, channels, data } or null. Never throws. */
function decodeImage(imagePath) {
  let buf;
  try { buf = readFileSync(imagePath); } catch { return null; }
  const isPng = buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47;
  if (isPng) {
    const d = decodePng(buf);
    if (d) return d;
  }
  // Not a PNG we can decode (JPG/WEBP, or a mis-named/exotic PNG) → transcode with sips, retry.
  let tmp = null;
  try {
    tmp = join(tmpdir(), `bgsample-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.png`);
    const r = spawnSync('sips', ['-s', 'format', 'png', imagePath, '--out', tmp], { timeout: 15_000, encoding: 'utf8' });
    if (r.status === 0 && existsSync(tmp)) {
      const d = decodePng(readFileSync(tmp));
      if (d) return d;
    }
  } catch { /* sips unavailable / failed → give up gracefully */ }
  finally { if (tmp) { try { rmSync(tmp, { force: true }); } catch { /* best effort */ } } }
  return null;
}

/**
 * Deterministic background color from the image's BORDER frame (top+bottom rows, left+right
 * columns) — this frame is almost always the ad's background. Averages border pixels, ignoring
 * near-transparent ones (alpha < 32). Also reports how FLAT the frame is (mean absolute deviation
 * of luminance across the sampled border) so the caller can decide how strongly to trust it: a
 * low `flatness` means a solid-color frame (a real background we should honor over the model);
 * a high one means the border straddles a photo/edge and the model may know better.
 * Returns { hex, lum, flatness, from:'pixels' } or null if undecodable.
 */
function sampleBorderBackground(imagePath) {
  const img = decodeImage(imagePath);
  if (!img) return null;
  const { width: w, height: h, channels: ch, data } = img;
  if (w < 2 || h < 2) return null;
  const at = (x, y) => {
    const p = (y * w + x) * ch;
    const a = ch === 4 ? data[p + 3] : 255;
    return { r: data[p], g: data[p + 1], b: data[p + 2], a };
  };
  let r = 0, g = 0, b = 0, n = 0;
  const lums = [];
  const add = (px) => { if (px.a >= 32) { r += px.r; g += px.g; b += px.b; n++; lums.push(relLum(px.r, px.g, px.b)); } };
  // Sample every few pixels along the frame — enough for a stable average, cheap on big images.
  const stepX = Math.max(1, Math.floor(w / 200));
  const stepY = Math.max(1, Math.floor(h / 200));
  for (let x = 0; x < w; x += stepX) { add(at(x, 0)); add(at(x, h - 1)); }
  for (let y = 0; y < h; y += stepY) { add(at(0, y)); add(at(w - 1, y)); }
  if (!n) return null;
  const avg = { r: r / n, g: g / n, b: b / n };
  const lum = relLum(avg.r, avg.g, avg.b);
  // Flatness: mean |luminance − meanLuminance| over the frame (0 = perfectly uniform).
  const meanL = lums.reduce((s, v) => s + v, 0) / lums.length;
  const flatness = lums.reduce((s, v) => s + Math.abs(v - meanL), 0) / lums.length;
  return { hex: rgbToHex(avg.r, avg.g, avg.b), lum, flatness, from: 'pixels' };
}

// ── Dominant color palette (median-cut quantization, zero-dep) ──────────────────────────────────
// Border-only sampling (above) misses the ad's actual accent/product/brand colors, which live in
// the INTERIOR. This extracts a small palette over the FULL decoded image by median-cut: recursive
// splitting of the sampled pixel set along its widest color-channel range, until we have the
// requested number of buckets, then averaging each bucket to one swatch. Pure JS, no npm deps —
// reuses decodeImage's raw pixel buffer. Runs on a DOWNSAMPLED grid (every Nth pixel per axis) so
// it stays cheap even on large images; the grid step is capped so a huge image never blows up
// runtime (worst case ~40k sampled pixels).
const PALETTE_MAX_SAMPLES = 40_000; // hard cap on sampled pixel count regardless of image size

/** Sample a grid of pixels (every `stepX`/`stepY`th one), skipping near-transparent pixels.
 *  Returns an array of [r,g,b] triples (plain arrays — fast to sort/slice in median-cut). */
function sampleGridPixels(img) {
  const { width: w, height: h, channels: ch, data } = img;
  if (w < 1 || h < 1) return [];
  // Start from "every 4th pixel in each dimension" per the task, then widen the step further if
  // that still exceeds the sample cap (guards huge images without a second decode pass).
  let stepX = 4, stepY = 4;
  let estimated = Math.ceil(w / stepX) * Math.ceil(h / stepY);
  while (estimated > PALETTE_MAX_SAMPLES) {
    stepX += 2; stepY += 2;
    estimated = Math.ceil(w / stepX) * Math.ceil(h / stepY);
  }
  const pixels = [];
  for (let y = 0; y < h; y += stepY) {
    for (let x = 0; x < w; x += stepX) {
      const p = (y * w + x) * ch;
      const a = ch === 4 ? data[p + 3] : 255;
      if (a < 32) continue; // skip near-transparent
      pixels.push([data[p], data[p + 1], data[p + 2]]);
    }
  }
  return pixels;
}

/** Median-cut: recursively split `bucket` along its widest channel range until `depth` splits
 *  have been performed (2^depth buckets), then return the leaf buckets. */
function medianCutSplit(buckets, targetCount) {
  while (buckets.length < targetCount) {
    // Pick the bucket with the largest color-volume (widest single-channel range) to split.
    let bestIdx = -1, bestRange = -1, bestChannel = 0;
    for (let i = 0; i < buckets.length; i++) {
      const b = buckets[i];
      if (b.length < 2) continue;
      for (let c = 0; c < 3; c++) {
        let lo = 255, hi = 0;
        for (const px of b) { const v = px[c]; if (v < lo) lo = v; if (v > hi) hi = v; }
        const range = hi - lo;
        if (range > bestRange) { bestRange = range; bestIdx = i; bestChannel = c; }
      }
    }
    if (bestIdx < 0 || bestRange <= 0) break; // nothing left worth splitting
    const bucket = buckets[bestIdx];
    bucket.sort((a, b) => a[bestChannel] - b[bestChannel]);
    const mid = Math.floor(bucket.length / 2);
    const left = bucket.slice(0, mid), right = bucket.slice(mid);
    buckets.splice(bestIdx, 1, left, right);
  }
  return buckets;
}

/**
 * Extract the TOP `count` dominant colors from an image via median-cut quantization over a
 * downsampled pixel grid. Returns [{ hex, share, r, g, b }] sorted by descending share (share =
 * fraction of SAMPLED pixels in that bucket, 0..1). Returns [] if the image can't be decoded or
 * has no non-transparent pixels. Never throws.
 */
export function extractDominantPalette(imagePath, count = 5) {
  try {
    const img = decodeImage(imagePath);
    if (!img) return [];
    const pixels = sampleGridPixels(img);
    if (!pixels.length) return [];
    const buckets = medianCutSplit([pixels], Math.max(1, count));
    const total = pixels.length;
    const swatches = buckets
      .filter((b) => b.length)
      .map((b) => {
        let r = 0, g = 0, bl = 0;
        for (const px of b) { r += px[0]; g += px[1]; bl += px[2]; }
        const n = b.length;
        r /= n; g /= n; bl /= n;
        return { hex: rgbToHex(r, g, bl), share: n / total, r, g, b: bl };
      })
      .sort((a, b) => b.share - a.share)
      .slice(0, count);
    return swatches;
  } catch { return []; }
}

/** Euclidean RGB distance between two hex colors, normalized to 0..1 (0 = identical, 1 = max
 *  possible distance i.e. black vs white). Returns 1 (max distance) if either hex is invalid. */
function colorDistance(hexA, hexB) {
  const a = hexToRgb(hexA), b = hexToRgb(hexB);
  if (!a || !b) return 1;
  const d = Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);
  return d / 441.67295593; // sqrt(255^2 * 3)
}

const STUDIO_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const CODEX_CLI = process.env.CODEX_CLI
  || (existsSync('/Applications/Codex.app/Contents/Resources/codex')
    ? '/Applications/Codex.app/Contents/Resources/codex'
    : 'codex');

const MAX_LAYERS = 18;
const CANON_W = 1080;

// v2 (2026-07): digitize the FULL design, not just "overlays on a photo". The old prompt
// excluded the photo/panels/cards, so fully-designed ads (comparison tables, X-post ads,
// before/afters on solid backgrounds) correctly returned zero layers → "extraction found no
// overlay layers". Now every design element is captured — photo/product regions come back as
// type "image" placeholders — and the ad's ARCHETYPE is classified for template seeding.
// FIX 3: crisp, unambiguous prompt for Gemma-4-e4b (a SMALL reasoning VL model). Kept short —
// reasoning models waste tokens on long prompts — but demands the four things it gets wrong:
// EXACT text, EXACT hex sampled at named points, back-to-front paint order, the archetype.
const PROMPT = `You digitize a social-media ad into JSON. Be exact and literal — no invention.

Capture EVERY element back-to-front (paint order: backgrounds/panels first, text last):
text blocks, badges/chips, buttons, cards/panels, background regions, gradient scrims, and each
photo/product region as type "image" with a 2-4 word label. Skip only platform chrome (app nav,
like/comment bars outside the ad).

Rules — get these RIGHT:
1. TEXT: copy the EXACT visible characters. Keep numbers in offers ("45% OFF" → "45% OFF") and
   struck-through prices verbatim. Do not paraphrase or translate.
2. COLORS: give real #hex sampled AT that element — text color = a glyph pixel; background =
   the fill behind it. Do NOT default to #ffffff/#000000 unless the pixel truly is white/black.
3. BACKGROUND: first decide the KIND, then report it.
   - "solid": the page is filled edge-to-edge with ONE flat color (or a simple 2-color gradient).
     Sample a corner pixel and report that real hex. If the whole frame is dark, say so (e.g.
     "#0a0a0a"), not white. Match the luminance you actually see — a black/near-black ad must
     report a dark hex, a white ad a light hex. A genuinely solid black background IS correct and
     should be reported as such — don't avoid black.
   - "photo": a lifestyle/product PHOTO fills the canvas edge-to-edge (no letterboxing, no solid
     color bars) — the photo itself IS the background, there is no separate flat fill behind it.
   - "gradient": a smooth multi-color gradient fill (not a photo).
   Report both "backgroundKind" ("solid"|"photo"|"gradient") AND "background" (the hex/gradient for
   solid/gradient, or null for photo — never invent a flat hex to stand in for a photo background).
4. FONT (read the type, don't guess): for EVERY text layer report the real letterforms.
   - "serif": true only if the glyphs have obvious serifs / bracketed feet or an editorial book
     face (Times, Georgia, Playfair); false for clean sans (Helvetica/Inter/SF/Chirp/Roboto).
   - "mono": true for fixed-width / code / receipt type; else omit.
   - "fontWeight": match the stroke — 800-900 for heavy display headlines, 700 bold, 400-500 body,
     300 thin. Don't call everything 600.
   - "platform": if the type is a recognizable UI font, name it: "ios" (SF Pro — Apple Notes,
     Messages), "twitter" (Chirp — X posts), "instagram" (IG UI), else omit. This maps to the
     right font stack downstream.
5. IMAGES: add "shape":"rect|ellipse|sphere" (ellipse/sphere for round products, bottles, avatars)
   and "color":"#hex" = the region's dominant color.
6. EFFECTS: if a region is a BLURRED or PIXELATED avatar/username (common privacy blur on social
   posts) add "effect":"blur". If a panel/card is FROSTED GLASS (translucent, blurs what's behind)
   add "effect":"glass". Otherwise omit "effect".

BOXES — place regions where they truly are. x,y = the element's TOP-LEFT as a % of the full image;
w,h = its width/height as a %. A centered headline still has a real left edge (x>0) — never snap
everything to x:0. Group tight lines of the same paragraph into ONE text box (don't split every
line). Keep boxes inside 0-100 and non-overlapping unless the design overlaps them.

ARCHETYPE — pick the ONE that matches; look for these exact tells, in this priority:
- "apple-notes": iOS Notes screenshot — a YELLOW "‹ Notes" back link top-left and/or a yellow
  "Done" top-right, a bold near-black title, a • bullet list. Yellow nav = apple-notes.
- "x-post": an X / Twitter post — a top bar reading "Post" with a ← back arrow and ⋯; an avatar +
  bold display name + BLUE VERIFIED CHECK + "@handle"; a "Follow"/"Volgend" pill; a timestamp +
  view count ("121K views/weergaven"); a bottom action row of reply/repost/like/bookmark counts
  (💬 257 · 🔁 66 · ♥ 21K · 🔖 89). Any of: Post-nav + verified badge + action-count row ⇒ x-post.
- "ig-dm": an Instagram DM / chat thread — rounded chat BUBBLES in a card, gray received vs
  colored sent, avatars, a "New Messages" divider or "Replied to you" quote.
- "stat-chart": a GIANT %/number stat (e.g. "58%") paired with a line/area CHART that has axis or
  WEEK labels. Big stat + chart ⇒ stat-chart.
- "before-after": two side-by-side panels explicitly labeled Before / After.
- "comparison": two columns pitched against each other (Ours vs Theirs) with ✓ check rows vs ✗
  cross rows.
- "offer-hero": a price/offer headline ("Save £48", "45% OFF", was/now price) with benefit chips
  over a hero photo.
- "story-native": a vertical full-photo story with stacked caption pills over it.
- "generic": none of the above clearly fits.

Reply with ONLY this JSON, no prose:
{"canvasRatio": <height/width, e.g. 1.78>,
 "archetype": "story-native|x-post|before-after|comparison|offer-hero|ig-dm|apple-notes|stat-chart|generic",
 "backgroundKind": "solid|photo|gradient",
 "background": "#hex OR {\"from\":\"#hex\",\"to\":\"#hex\",\"angle\":<0-360>} for a gradient, or null if backgroundKind is photo",
 "layers": [
  {"type":"text|badge|button|shape|image",
   "role":"headline|subhead|caption|badge|cta|price|scrim|card|product|avatar|logo",
   "text":"exact text (image: 2-4 word label)",
   "box":{"x":<left %>,"y":<top %>,"w":<width %>,"h":<height %>},
   "style":{"color":"#hex","background":"#hex|rgba()|null",
            "fontSizePct":<cap height as % of image WIDTH, e.g. 4.5>,
            "fontWeight":<300-900>,"align":"left|center|right",
            "radiusPct":<corner radius % of width, 0 if square>,
            "uppercase":<true|false>,"serif":<true|false>,"mono":<true|false>,
            "platform":"ios|twitter|instagram (optional)",
            "gradient":"to-top|to-bottom|null"},
   "effect":"blur|glass (optional — blurred username / frosted panel)"}
 ]}
All boxes in % of the full image (0-100). Max ${MAX_LAYERS} layers. Approximate boxes are fine;
TEXT, COLORS, FONT and ARCHETYPE must be exact.`;

// FIX 2: refine prompt — pass 1's JSON goes back IN so the model corrects itself instead of
// re-guessing from scratch. Terse: point it at the four failure classes and demand complete JSON.
const REFINE_PROMPT = (priorJson) => `You digitized this ad once. Here is that first-pass JSON:

${priorJson}

Look at the image again and CORRECT it. Specifically:
- ADD any layer that is present in the image but missing from the JSON.
- REMOVE any layer that is not actually in the image (hallucinations).
- FIX wrong text (must be EXACT characters), wrong #hex colors (sample the real pixel), and
  wrong box position/size (x,y is the element's real top-left %).
- FIX the "backgroundKind" ("solid"|"photo"|"gradient") and "background": a full-bleed lifestyle/
  product photo with no flat fill behind it is backgroundKind "photo" with background null — do NOT
  invent a flat hex for it. A genuine flat color/gradient page IS backgroundKind "solid"/"gradient"
  with a real hex — fix wrong luminance (dark bg must be a dark hex), don't null out a real solid.
- FIX the font read per text layer: serif vs sans, real fontWeight (heavy display = 800-900),
  and a "platform" hint (ios / twitter / instagram) when it's a recognizable UI font.
- FIX the archetype using the tells: yellow ‹ Notes nav ⇒ apple-notes; a "Post" nav + blue
  verified check + reply/repost/like count row ⇒ x-post; chat bubbles ⇒ ig-dm; giant % + chart ⇒
  stat-chart. Don't leave it "generic" if one of these clearly matches.

Reply with ONLY the corrected COMPLETE JSON in the same schema (canvasRatio, archetype ∈
{story-native,x-post,before-after,comparison,offer-hero,ig-dm,apple-notes,stat-chart,generic},
backgroundKind, background, layers[] with per-layer style incl. serif/mono/platform). Include ALL
layers, not just changed ones. No prose.`;

function extractJson(out) {
  // codex --json emits JSONL events; the agent message may also be plain in the tail.
  // Find the LAST {...} blob that parses and has a `layers` array.
  const candidates = [];
  for (const line of String(out).split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const obj = JSON.parse(t);
      const text = obj?.item?.text ?? obj?.msg?.message ?? (typeof obj?.text === 'string' ? obj.text : null);
      if (typeof text === 'string') candidates.push(text);
    } catch { /* not an event line */ }
  }
  candidates.push(String(out)); // raw tail fallback
  for (let i = candidates.length - 1; i >= 0; i--) {
    const m = String(candidates[i]).match(/\{[\s\S]*"layers"[\s\S]*\}/);
    if (!m) continue;
    try {
      const obj = JSON.parse(m[0]);
      if (Array.isArray(obj.layers)) return obj;
    } catch { /* keep scanning */ }
  }
  return null;
}

const clampPct = (v) => Math.max(0, Math.min(100, Number(v) || 0));
const HEX_RE = /^#[0-9a-fA-F]{3,8}$|^rgba?\(/;

// Font stacks — mirror lib/elements.mjs FONT_SUGGEST (inlined to keep this module import-light).
// The model reports serif/mono/platform per text layer; map to the real family so an X post reads
// in Chirp, an Apple Notes screenshot in SF Pro, a receipt in mono, an editorial serif in Georgia.
const FONT_STACKS = {
  twitter: 'Chirp, "Twitter Font", -apple-system, "Segoe UI", Roboto, sans-serif',
  ios: '-apple-system, "SF Pro Text", "SF Pro", "Segoe UI", Roboto, sans-serif',
  instagram: '"Instagram Sans", -apple-system, "Segoe UI", Roboto, sans-serif',
  mono: 'Menlo, "SF Mono", Consolas, monospace',
  serif: 'Georgia, "Times New Roman", serif',
};
/** Resolve a text layer's font family from the model's style read. Named platform UI font wins,
 *  then mono, then serif; a plain sans returns undefined (uses the doc's default sans). */
function fontStack(s) {
  const p = String(s?.platform || '').toLowerCase();
  if (p === 'twitter' || p === 'x') return FONT_STACKS.twitter;
  if (p === 'ios' || p === 'apple' || p === 'sf' || p === 'notes' || p === 'imessage') return FONT_STACKS.ios;
  if (p === 'instagram' || p === 'ig') return FONT_STACKS.instagram;
  if (s?.mono === true) return FONT_STACKS.mono;
  if (s?.serif === true) return FONT_STACKS.serif;
  return undefined;
}

// ── Organic product-silhouette synthesis ─────────────────────────────────────────────────────────
// Raw vision extraction only gives a bounding box for a product region. A plain rect/ellipse reads
// as a placeholder slab; a soft organic silhouette reads as "a real product is roughly here". We
// synthesize an 8-point outline BIASED by the model's shape hint (bottle/tube/jar/etc., reported
// as l.shape) — tall-narrow for bottle-like, squat-round for jar-like — then smooth the 8 corner
// points with a Catmull-Rom-derived cubic-bezier pass into an SVG path. Fully deterministic: every
// offset is a fixed fraction of the box, no Math.random, so the same extraction always yields the
// same shape.

/** Per-shape-hint bias applied to the 8 octagon corner points (as fractions of half-width/
 *  half-height from box center), going clockwise from top-center: [top, top-right, right,
 *  bottom-right, bottom, bottom-left, left, top-left]. 1.0 = the point sits exactly on the
 *  rect edge/corner; <1 pulls it inward (rounds that corner off). */
const SHAPE_BIAS = {
  // Bottle/tube: tall & narrow — round the shoulders (top corners) in hard, keep the body
  // (sides) nearly straight, taper the base slightly.
  bottle: { top: 0.62, topCorner: 0.55, side: 0.94, botCorner: 0.7, bot: 0.85 },
  tube: { top: 0.6, topCorner: 0.5, side: 0.92, botCorner: 0.68, bot: 0.82 },
  // Jar: squat & round — soften every corner evenly, fuller sides.
  jar: { top: 0.82, topCorner: 0.75, side: 1.0, botCorner: 0.78, bot: 0.85 },
  can: { top: 0.85, topCorner: 0.8, side: 0.98, botCorner: 0.82, bot: 0.85 },
  // Box/pack: mostly rectangular — just take the hard edge off each corner.
  box: { top: 0.94, topCorner: 0.85, side: 0.96, botCorner: 0.85, bot: 0.94 },
  pack: { top: 0.94, topCorner: 0.85, side: 0.96, botCorner: 0.85, bot: 0.94 },
  // Default / unknown product shape: a gentle all-round organic taper.
  default: { top: 0.8, topCorner: 0.7, side: 0.96, botCorner: 0.72, bot: 0.82 },
};

/** Resolve a shape-hint string (as reported by vision, e.g. "bottle"/"tube"/"jar"/"can"/"box") to
 *  its bias profile, defaulting to a gentle all-round taper for unknown/absent hints. */
function biasForShapeHint(hint) {
  const h = String(hint || '').toLowerCase();
  if (SHAPE_BIAS[h]) return SHAPE_BIAS[h];
  if (/bottle|flask/.test(h)) return SHAPE_BIAS.bottle;
  if (/tube/.test(h)) return SHAPE_BIAS.tube;
  if (/jar|pot/.test(h)) return SHAPE_BIAS.jar;
  if (/can|cylinder/.test(h)) return SHAPE_BIAS.can;
  if (/box|pack|carton/.test(h)) return SHAPE_BIAS.box;
  return SHAPE_BIAS.default;
}

/**
 * Build 8 outline points (normalized 0..1, box-local, 0,0 = top-left) approximating a product's
 * rough silhouette from just its bounding box + an optional shape hint. Points run clockwise from
 * top-center: top, top-right corner, right-mid, bottom-right corner, bottom-center, bottom-left
 * corner, left-mid, top-left corner. Deterministic — pure function of (aspect, hint).
 */
function octagonPoints(hint) {
  const b = biasForShapeHint(hint);
  // Center-relative half-extents pulled in by the bias factor (1 = full extent = box edge).
  const cx = 0.5, cy = 0.5;
  const pt = (fx, fy) => [cx + fx * 0.5, cy + fy * 0.5];
  return [
    pt(0, -b.top),               // top-center
    pt(b.topCorner, -b.topCorner), // top-right corner
    pt(b.side, 0),                // right-mid
    pt(b.botCorner, b.botCorner), // bottom-right corner
    pt(0, b.bot),                 // bottom-center
    pt(-b.botCorner, b.botCorner),// bottom-left corner
    pt(-b.side, 0),               // left-mid
    pt(-b.topCorner, -b.topCorner),// top-left corner
  ];
}

/**
 * Smooth a closed loop of points with a Catmull-Rom → cubic-bezier conversion (the standard
 * uniform Catmull-Rom-to-Bezier tangent formula, tension 1/6) and emit an SVG path `d` string.
 * Deterministic, zero-dep. Coordinates are passed through as-is (caller supplies normalized
 * 0..1 box-local points to match the shapeKind:'path' convention).
 */
function smoothClosedPath(points) {
  const n = points.length;
  if (n < 3) return '';
  const fmt = (v) => Number(v.toFixed(4));
  const P = (i) => points[((i % n) + n) % n];
  let d = `M ${fmt(P(0)[0])} ${fmt(P(0)[1])} `;
  for (let i = 0; i < n; i++) {
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
    // Uniform Catmull-Rom control points (tension 1/6) between p1 and p2.
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += `C ${fmt(c1x)} ${fmt(c1y)} ${fmt(c2x)} ${fmt(c2y)} ${fmt(p2[0])} ${fmt(p2[1])} `;
  }
  return `${d.trim()} Z`;
}

/** Synthesize a smoothed organic product-silhouette SVG path (normalized 0..1, box-local) from a
 *  shape hint. Returns the path `d` string, or '' if it couldn't be built (caller falls back to a
 *  plain rect/ellipse). Deterministic — same hint always yields the same path. */
function productSilhouettePath(shapeHint) {
  try {
    const pts = octagonPoints(shapeHint);
    return smoothClosedPath(pts);
  } catch { return ''; }
}

/** Convert the model's percentage layers to a canonical-px Skeleton layer list. */
export function toSkeletonLayers(raw, canvas) {
  const layers = [];
  let seq = 0;
  for (const l of (raw.layers || []).slice(0, MAX_LAYERS)) {
    const type = ['text', 'badge', 'button', 'shape', 'image'].includes(l?.type) ? l.type : 'text';
    const b = l?.box || {};
    const x = Math.round((clampPct(b.x) / 100) * canvas.w);
    const y = Math.round((clampPct(b.y) / 100) * canvas.h);
    const w = Math.max(40, Math.round((clampPct(b.w) / 100) * canvas.w));
    const h = Math.max(30, Math.round((clampPct(b.h) / 100) * canvas.h));
    const s = l?.style || {};
    const id = `ext-${Date.now().toString(36)}-${(seq++).toString(36)}`;
    const box = {
      x: Math.min(x, canvas.w - 40),
      y: Math.min(y, canvas.h - 30),
      w: Math.min(w, canvas.w),
      h: Math.min(h, canvas.h),
    };
    // product/photo regions → a FAITHFUL placeholder: a shape sized to the analyzed region and
    // TINTED with the product's dominant color (a sphere/ellipse for round products, a rounded
    // frame otherwise), plus a label. So extracted comps read as real designs we can replicate,
    // not gray slabs — and the product's size + color + position are captured for swap-in.
    const effect = String(l?.effect || '').toLowerCase();
    if (type === 'image') {
      const label = String(l?.text || 'photo').slice(0, 30);
      const shapeHint = String(l?.shape || '').toLowerCase();
      const round = shapeHint === 'ellipse' || shapeHint === 'sphere';
      const tint = HEX_RE.test(String(l?.color)) ? String(l.color) : '#9aa0a6';
      const fs = Math.max(16, Math.round(box.w * 0.11));
      const radius = round ? undefined : (Math.round((clampPct(s.radiusPct) / 100) * canvas.w) || Math.round(canvas.w * 0.02));
      // EFFECT: a blurred/pixelated avatar (privacy blur on social posts) → a blurred tinted disc
      // with no label; the harness reproduces the redaction rather than a clean product slot.
      const blurred = effect === 'blur';
      // ORGANIC SILHOUETTE: a plain rect/ellipse reads as a placeholder slab. For a non-round,
      // non-blurred product region, synthesize a smoothed 8-point outline biased by the model's
      // shape hint (tall-narrow for bottle/tube, squat-round for jar/can, near-rect for box/pack)
      // so the comp reads as a soft, plausible product silhouette instead of a hard box.
      const silhouette = (!round && !blurred) ? productSilhouettePath(shapeHint) : '';
      layers.push({
        id, type: 'shape', role: blurred ? 'avatar' : 'product', name: `${blurred ? 'Blurred' : 'Product'} · ${label}`, box,
        style: {
          background: `${tint}${blurred ? 'bf' : '59'}`, radius,
          ...(round ? { shapeKind: 'ellipse' } : {}),
          ...(silhouette ? { shapeKind: 'path', path: silhouette } : {}),
          ...(blurred ? { blur: Math.max(6, Math.round(box.w * 0.06)) } : { stroke: { color: tint, width: Math.max(2, Math.round(box.w * 0.008)) } }),
        },
      });
      if (blurred) continue; // no label on a redacted avatar
      layers.push({
        id: `${id}-lb`, type: 'text', role: 'caption', name: 'Product label', autoH: false, sizeLocked: true,
        text: label.toUpperCase(),
        box: { x: box.x, y: box.y + Math.round(box.h / 2) - fs, w: box.w, h: fs * 2 },
        style: { fontSize: Math.min(fs, Math.round(canvas.w * 0.03)), fontWeight: 700, color: '#ffffff', align: 'center', uppercase: true, lineHeight: 1, shadow: true },
      });
      continue;
    }
    const style = {
      color: HEX_RE.test(String(s.color)) ? s.color : '#ffffff',
      background: s.background && HEX_RE.test(String(s.background)) ? s.background : undefined,
      fontSize: Math.max(18, Math.round((clampPct(s.fontSizePct || 4) / 100) * canvas.w)),
      fontWeight: Math.min(900, Math.max(300, Math.round(Number(s.fontWeight) || 600))),
      align: ['left', 'center', 'right'].includes(s.align) ? s.align : 'left',
      radius: Math.round((clampPct(s.radiusPct) / 100) * canvas.w) || undefined,
      uppercase: !!s.uppercase,
      // FONT: map the model's type read to a real stack. A named platform UI font wins (SF/Chirp/IG),
      // then mono, then serif; plain sans falls through to the doc default (undefined).
      fontFamily: fontStack(s),
      lineHeight: 1.2,
      gradient: type === 'shape' && ['to-top', 'to-bottom'].includes(s.gradient) ? s.gradient : undefined,
      opacity: type === 'shape' ? 0.8 : undefined,
      padding: s.background ? Math.round(canvas.w * 0.015) : undefined,
      // EFFECTS: frosted glass panel → backdropBlur; a blurred text/shape → layer blur.
      ...(effect === 'glass' ? { backdropBlur: Math.round(canvas.w * 0.02), opacity: 1 } : {}),
      ...(effect === 'blur' ? { blur: Math.max(4, Math.round(canvas.w * 0.01)) } : {}),
    };
    const textual = type !== 'shape';
    // TEXT-FIT clamp: vision's fontSizePct is often optimistic — when the estimated wrapped
    // block exceeds the reported box, shrink the font to fit rather than letting text spill
    // out of its box ("text ends up inside boxes"). Same glyph model as type-scale.mjs.
    if (textual && l?.text) {
      const glyph = style.fontWeight >= 700 ? 0.55 : 0.52;
      const usableW = Math.max(20, box.w - (style.padding || 0) * 2);
      const text = style.uppercase ? String(l.text).toUpperCase() : String(l.text);
      const wrap = (fs) => {
        const cw = fs * glyph;
        let lines = 1; let cur = 0;
        for (const w of text.split(/\s+/).filter(Boolean)) {
          const ww = w.length * cw;
          if (cur > 0 && cur + cw + ww > usableW) { lines++; cur = ww; } else cur = cur ? cur + cw + ww : ww;
        }
        return lines * fs * 1.25 + (style.padding || 0) * 2;
      };
      let guard = 0;
      while (style.fontSize > 18 && wrap(style.fontSize) > box.h * 1.15 && guard++ < 24) {
        style.fontSize = Math.round(style.fontSize * 0.92);
      }
    }
    layers.push({
      id,
      type,
      role: String(l?.role || type).slice(0, 24),
      name: String(l?.role || type).slice(0, 24),
      text: type === 'shape' ? undefined : String(l?.text || '').slice(0, 240),
      ...(textual ? { autoH: true } : {}),
      box,
      style,
    });
  }

  // ── PAINT ORDER: enforce a sane z-stack so text is never buried behind a product or panel
  // ("text appears behind other elements"). Bands, back→front:
  //   0 full-bleed background · 1 cards/panels · 2 products/avatars · 3 glass/scrim · 4 all text.
  const canvasArea = canvas.w * canvas.h;
  const band = (l) => {
    if (l.role === 'base') return 0;
    const textual = l.type === 'text' || l.type === 'badge' || l.type === 'button' ||
      (typeof l.text === 'string' && l.text.trim().length > 0);
    if (textual) return 4;
    if (l.style && (l.style.backdropBlur || l.style.gradient)) return 3; // glass / scrim: over product, under text
    if (l.role === 'product' || l.role === 'avatar' || l.type === 'image') return 2;
    const area = (l.box?.w || 0) * (l.box?.h || 0);
    return area > canvasArea * 0.6 ? 0 : 1; // big flat shape = background, small = card
  };
  return layers
    .map((l, i) => ({ l, i, z: band(l) }))
    .sort((a, b) => a.z - b.z || a.i - b.i) // stable within each band
    .map((e) => e.l);
}

// Cancel registry: runId → abort() for an in-flight multi-pass extraction.
const activeRuns = new Map();

/** Cancel an in-flight extraction by runId. Aborts the remaining vision passes. */
export function cancelExtraction(runId) {
  const run = runId && activeRuns.get(runId);
  if (!run) return false;
  run.cancel();
  return true;
}

/** Score a parsed extraction for "hardness" pass selection: more real layers + a present
 *  archetype + a background + text content = a more complete read. */
function scoreRaw(raw) {
  if (!raw || !Array.isArray(raw.layers)) return -1;
  let s = raw.layers.length;
  for (const l of raw.layers) {
    if (l && typeof l.text === 'string' && l.text.trim()) s += 0.5;
    if (l && l.box && Number(l.box.w) > 0 && Number(l.box.h) > 0) s += 0.25;
  }
  if (raw.archetype && raw.archetype !== 'generic') s += 2;
  if (raw.background) s += 1;
  return s;
}

// ── Deterministic archetype detection (FIX 4) ────────────────────────────────────────────────
// A small VL model often returns "generic" (or the wrong archetype) even when the ad is an obvious
// preset. We re-derive the archetype from the extracted LAYERS + their text using the exact chrome
// tells for each preset. When a signal is STRONG we override the model so downstream can drop the
// pixel-tight template. Loose reads (no strong signal) keep the model's own guess.
const ARCH_ENUM = ['story-native', 'x-post', 'before-after', 'comparison', 'offer-hero', 'ig-dm', 'apple-notes', 'stat-chart', 'generic'];

/** All layer text joined + lowercased, for cheap signal scanning. */
function allText(raw) {
  return (Array.isArray(raw?.layers) ? raw.layers : [])
    .map((l) => String(l?.text || '')).join(' ␟ ').toLowerCase();
}

/**
 * Infer the archetype from the read. Returns { archetype, strong } where `strong` means the tells
 * are unambiguous enough to OVERRIDE the model. Signals (priority order = the prompt's):
 *  - apple-notes: a yellow "‹ Notes" back / "Done" nav.
 *  - x-post: a "Post" nav + verified badge + reply/repost/like action-count row / views.
 *  - ig-dm: several chat bubbles / DM chrome.
 *  - stat-chart: a giant %-stat + chart/week labels.
 *  - before-after / comparison / offer-hero: their labeled panels / columns / offer copy.
 */
function detectArchetypeFromLayers(raw) {
  const layers = Array.isArray(raw?.layers) ? raw.layers : [];
  const t = allText(raw);
  const has = (re) => re.test(t);
  const roleText = (re) => layers.some((l) => re.test(String(l?.role || '')));
  const effects = layers.map((l) => String(l?.effect || '').toLowerCase());

  // apple-notes: yellow Notes nav is the giveaway.
  if (has(/(^|\s|‹|<)\s*notes\b/) && (has(/\bdone\b/) || has(/‹|back/))) {
    return { archetype: 'apple-notes', strong: true };
  }

  // x-post: X/Twitter chrome. Count strong tells; 2+ ⇒ definitely a tweet.
  let xTells = 0;
  if (has(/\bpost\b/) && (has(/⋯|…|back|←/) || roleText(/nav|header/))) xTells++;      // "Post" nav bar
  if (layers.some((l) => /badge|verified|check/i.test(String(l?.role || '')) && /✓|✔|verified/i.test(String(l?.text || '')))
    || has(/verified/)) xTells++;                                                       // blue verified check
  if (has(/\b(views|weergaven|impressions)\b/) || has(/\b\d[\d.,]*\s*[km]\b.*\b(views|weergaven)\b/)) xTells++; // view count
  if (has(/\b(follow|volg|volgend|following)\b/)) xTells++;                              // Follow pill
  if (has(/\b(repost|retweet|reply|replies|bookmark)\b/) || has(/🔁|💬|♥|🔖/)) xTells++;  // action row
  if (has(/@[a-z0-9_]{2,}/)) xTells++;                                                   // @handle
  if (xTells >= 2) return { archetype: 'x-post', strong: true };

  // ig-dm: chat bubbles / DM chrome. Multiple caption bubbles + DM markers.
  const bubbleish = layers.filter((l) => /caption|bubble|message/i.test(String(l?.role || '')) && String(l?.text || '').trim()).length;
  if (has(/\b(new messages|replied to you|active now|send message)\b/) || (bubbleish >= 4 && effects.some((e) => e === 'blur'))) {
    return { archetype: 'ig-dm', strong: has(/\b(new messages|replied to you)\b/) };
  }

  // stat-chart: a giant %-stat + chart/week cue.
  const bigStat = layers.some((l) => /^\s*\d{1,3}\s*%\s*$/.test(String(l?.text || '')) || /^\s*[\d.,]+x\s*$/i.test(String(l?.text || '')));
  if (bigStat && (has(/\bweek\b/) || roleText(/chart/) || has(/\b(n=\d|self-reported|study|panel)\b/))) {
    return { archetype: 'stat-chart', strong: true };
  }

  // before-after: explicit Before / After panel labels.
  if (has(/\bbefore\b/) && has(/\bafter\b/)) return { archetype: 'before-after', strong: true };

  // comparison: check vs cross rows / us-vs-them columns.
  const checks = (t.match(/✓|✔/g) || []).length, crosses = (t.match(/✗|✘|❌|×/g) || []).length;
  if ((checks >= 2 && crosses >= 1) || has(/\b(ours|theirs|us vs|vs them|others)\b/)) {
    return { archetype: 'comparison', strong: checks >= 2 && crosses >= 1 };
  }

  // offer-hero: price / discount / bundle offer copy.
  if (has(/\d+%\s*off/) || has(/save\s*[£$€]/) || has(/[£$€]\s?\d/) || has(/\b(bundle|first order|shop now)\b/)) {
    return { archetype: 'offer-hero', strong: false };
  }

  return { archetype: 'generic', strong: false };
}

/**
 * Reconcile the model's archetype with the deterministic detector. A STRONG deterministic signal
 * wins (the model said generic on an obvious tweet); otherwise the model's non-generic guess is
 * kept, and the detector only fills in when the model punted to generic. Returns a valid enum value.
 */
function resolveArchetype(modelArch, raw, progress) {
  const model = ARCH_ENUM.includes(modelArch) ? modelArch : 'generic';
  const det = detectArchetypeFromLayers(raw);
  if (det.strong && det.archetype !== model && det.archetype !== 'generic') {
    if (progress) progress(`archetype: signals say ${det.archetype} (model said ${model}) — using ${det.archetype}`);
    return det.archetype;
  }
  if (model === 'generic' && det.archetype !== 'generic') {
    if (progress) progress(`archetype: model said generic — signals suggest ${det.archetype}`);
    return det.archetype;
  }
  return model;
}

// ── DETECTION → PRESET FILL ───────────────────────────────────────────────────────────────────
// When the extraction recognizes a KNOWN preset archetype, we don't emit loose boxes — we map the
// DETECTED text/regions onto that template's param SLOTS and BUILD the 1:1 preset (grouped,
// composed). Unmapped params fall back to the template's own defaults (Michael: "detect what you
// can, map it onto the preset, let the preset supply the rest"). archetypes that have no matching
// template (generic) are handled by the loose-layer path instead.
const ARCHETYPE_TO_TEMPLATE = {
  'x-post': 'x-post-ad',
  'apple-notes': 'apple-notes',
  'ig-dm': 'ig-dm',
  comparison: 'comparison',
  'stat-chart': 'stat-chart',
  'offer-hero': 'offer-hero',
  'story-native': 'story-native',
  'before-after': 'before-after',
};

const rawText = (l) => String(l?.text || '').trim();
const roleOf = (l) => String(l?.role || '').toLowerCase();
/** Text of the first layer whose role matches `re`, else null. */
const textByRole = (layers, re) => {
  const hit = layers.find((l) => re.test(roleOf(l)) && rawText(l));
  return hit ? rawText(hit) : null;
};
/** Every non-empty text, top-to-bottom (the read is already z-ordered but we sort by y to be safe). */
const textsByY = (layers) => layers
  .filter((l) => rawText(l))
  .slice()
  .sort((a, b) => (Number(a?.box?.y) || 0) - (Number(b?.box?.y) || 0));

/** First @handle token anywhere in the read. */
function findHandle(layers) {
  for (const l of layers) {
    const m = rawText(l).match(/@[A-Za-z0-9_]{2,}/);
    if (m) return m[0];
  }
  return null;
}
/** A "12.3K" / "1,024" / "58%" style count token near a keyword, else null. */
function findCount(text, re) {
  const t = String(text || '');
  const m = t.match(re);
  return m ? m[1] : null;
}

/**
 * Map an x-post extraction → the x-post-ad template params. Pulls the display NAME (the top,
 * non-@ bold caption), the @handle, the BODY (the longest / stacked text block), the viewcount,
 * reply/repost/like/bookmark counts, the verified flag (a verified/check badge in the read), and
 * a blurred-avatar flag (an avatar layer that came back with effect:"blur").
 */
function mapXPost(layers) {
  const params = {};
  const handle = findHandle(layers);
  if (handle) params.handle = handle;
  // display name: a header/name-role caption that is NOT the @handle and NOT the "Post" nav word
  const named = layers.find((l) => /name|display|author|header/.test(roleOf(l)) && rawText(l) && !/^@/.test(rawText(l)) && !/^post$/i.test(rawText(l)));
  const name = named ? rawText(named)
    : (() => {
      const cand = textsByY(layers).find((l) => !/^@/.test(rawText(l)) && !/^post$/i.test(rawText(l)) && rawText(l).length <= 30 && !/\bviews?\b|weergaven/i.test(rawText(l)));
      return cand ? rawText(cand) : null;
    })();
  if (name) params.name = name;
  // body: the single longest text block (X body paragraphs are long); keep its exact copy
  const body = layers
    .filter((l) => rawText(l).length >= 24)
    .sort((a, b) => rawText(b).length - rawText(a).length)[0];
  if (body) params.body = rawText(body);
  // counts: scan the whole read text for view/reply/repost/like/bookmark tokens
  const all = layers.map(rawText).join(' ␟ ');
  const views = findCount(all, /([\d][\d.,]*\s*[km]?)\s*(?:views|weergaven|impressions)/i);
  if (views) params.views = views.trim();
  const rep = findCount(all, /(?:reply|replies|💬)[^\d]*([\d][\d.,]*\s*[km]?)/i)
    || findCount(all, /([\d][\d.,]*\s*[km]?)[^\d]*(?:replies|reply)/i);
  if (rep) params.replies = rep.trim();
  const rt = findCount(all, /(?:repost|retweet|🔁|⇄)[^\d]*([\d][\d.,]*\s*[km]?)/i);
  if (rt) params.reposts = rt.trim();
  const lk = findCount(all, /(?:like|likes|♥|❤)[^\d]*([\d][\d.,]*\s*[km]?)/i);
  if (lk) params.likes = lk.trim();
  const bm = findCount(all, /(?:bookmark|🔖)[^\d]*([\d][\d.,]*\s*[km]?)/i);
  if (bm) params.bookmarks = bm.trim();
  // verified flag: a verified/check badge OR "verified"/✔ in the read
  params.verified = layers.some((l) => /verified|check|badge/.test(roleOf(l)) && /✓|✔|verified/i.test(rawText(l)))
    || /\bverified\b/i.test(all) || layers.some((l) => /^\s*[✓✔]\s*$/.test(rawText(l)));
  // blurred-avatar flag: an avatar layer flagged with a blur effect (privacy blur)
  params.blurAvatar = layers.some((l) => /avatar/.test(roleOf(l)) && (String(l?.effect || '').toLowerCase() === 'blur' || l?.style?.blur));
  return params;
}

/** Map an apple-notes extraction → the apple-notes template. Title = the headline; items = the
 *  bullet/caption lines under it; footnote = a trailing small disclaimer line. */
function mapAppleNotes(layers) {
  const params = {};
  const title = textByRole(layers, /headline|title/) || (textsByY(layers)[0] && rawText(textsByY(layers)[0]));
  if (title) params.title = title;
  const bullets = layers
    .filter((l) => /caption|item|bullet|list/.test(roleOf(l)) && rawText(l) && rawText(l) !== title)
    .map((l) => rawText(l).replace(/^[•\-•]\s*/, ''));
  if (bullets.length) params.items = bullets.slice(0, 10);
  // footnote: a "not sponsored" / disclaimer-ish trailing line
  const foot = layers.find((l) => /footnote|disclaimer|legal/.test(roleOf(l)) && rawText(l))
    || layers.find((l) => /not sponsored|just what|disclaimer/i.test(rawText(l)));
  if (foot) params.footnote = rawText(foot);
  return params;
}

/** Map an offer-hero extraction → the offer-hero template. */
function mapOfferHero(layers) {
  const params = {};
  const logo = textByRole(layers, /logo|brand/);
  if (logo) params.logo = logo;
  const headline = textByRole(layers, /headline/) || (() => {
    const h = layers.find((l) => /off|save|£|\$|€/i.test(rawText(l)) && rawText(l).length <= 60);
    return h ? rawText(h) : null;
  })();
  if (headline) params.headline = headline;
  const price = layers.find((l) => /price/.test(roleOf(l)) && rawText(l))
    || layers.find((l) => /now\s|was\s|normally|£|\$|€/i.test(rawText(l)) && /\d/.test(rawText(l)));
  if (price) params.priceLine = rawText(price);
  const chips = layers.filter((l) => /badge|chip/.test(roleOf(l)) && rawText(l) && rawText(l) !== headline).map(rawText);
  if (chips.length) params.chips = chips.slice(0, 4);
  return params;
}

/** Map a stat-chart extraction → the stat-chart template. */
function mapStatChart(layers) {
  const params = {};
  const stat = layers.find((l) => /^\s*[\d.,]{1,4}\s*%\s*$/.test(rawText(l)) || /^\s*[\d.,]+x\s*$/i.test(rawText(l)));
  if (stat) params.stat = rawText(stat);
  const sub = layers.find((l) => /subhead/.test(roleOf(l)) && rawText(l))
    || textsByY(layers).find((l) => stat && rawText(l) !== rawText(stat) && rawText(l).length > 12);
  if (sub) params.subhead = rawText(sub);
  const cite = layers.find((l) => /citation|caption/.test(roleOf(l)) && /n=|self-reported|study|panel|based on/i.test(rawText(l)));
  if (cite) params.citation = rawText(cite);
  const weeks = layers.filter((l) => /^\s*week\s*\d/i.test(rawText(l))).map(rawText);
  if (weeks.length) params.weeks = weeks.slice(0, 8);
  return params;
}

/** Map a before/after extraction → the before-after template. */
function mapBeforeAfter(layers) {
  const params = {};
  const head = textByRole(layers, /headline/) || (textsByY(layers).find((l) => rawText(l).length > 12) && rawText(textsByY(layers).find((l) => rawText(l).length > 12)));
  if (head) params.headline = head;
  const before = layers.find((l) => /^before\b/i.test(rawText(l)));
  const after = layers.find((l) => /^after\b/i.test(rawText(l)));
  if (before) params.leftLabel = rawText(before);
  if (after) params.rightLabel = rawText(after);
  const closing = layers.find((l) => /subhead|closing/.test(roleOf(l)) && rawText(l) && rawText(l) !== head);
  if (closing) params.closing = rawText(closing);
  return params;
}

/** Map a comparison extraction → the comparison template. */
function mapComparison(layers) {
  const params = {};
  const head = textByRole(layers, /headline/) || (textsByY(layers)[0] && rawText(textsByY(layers)[0]));
  if (head) params.headline = head;
  const checks = layers.filter((l) => /^[✓✔]/.test(rawText(l))).map((l) => rawText(l).replace(/^[✓✔]\s*/, ''));
  const crosses = layers.filter((l) => /^[✗✘❌×]/.test(rawText(l))).map((l) => rawText(l).replace(/^[✗✘❌×]\s*/, ''));
  if (checks.length) params.leftItems = checks.slice(0, 5);
  if (crosses.length) params.rightItems = crosses.slice(0, 5);
  return params;
}

/** Map a story-native extraction → the story-native template (two stacked hook pills). */
function mapStoryNative(layers) {
  const params = {};
  const pills = textsByY(layers).filter((l) => rawText(l).length >= 4 && rawText(l).length <= 60);
  if (pills[0]) params.hook = rawText(pills[0]);
  if (pills[1]) params.hook2 = rawText(pills[1]);
  return params;
}

const PARAM_MAPPERS = {
  'x-post': mapXPost,
  'apple-notes': mapAppleNotes,
  'offer-hero': mapOfferHero,
  'stat-chart': mapStatChart,
  'before-after': mapBeforeAfter,
  comparison: mapComparison,
  'story-native': mapStoryNative,
  // ig-dm has no reliable per-message extraction from loose boxes → build with template defaults.
  'ig-dm': () => ({}),
};

/**
 * DETECTION → PRESET FILL. When `archetype` maps to a known preset, map the extracted text/regions
 * onto that template's param slots and BUILD the composed 1:1 preset (grouped layers) at `canvas`.
 * Unmapped params fall back to template defaults. Returns { layers, templateId, params } or null
 * when the archetype has no matching preset (→ caller keeps the loose-layer path). Never throws.
 */
export function fillPresetFromExtraction(archetype, raw, canvas, kit) {
  const templateId = ARCHETYPE_TO_TEMPLATE[archetype];
  if (!templateId) return null;
  const layers = Array.isArray(raw?.layers) ? raw.layers : [];
  const mapper = PARAM_MAPPERS[archetype];
  let params = {};
  try { params = (mapper ? mapper(layers) : {}) || {}; } catch { params = {}; }
  // drop empty/undefined so buildTemplate keeps its defaults for unmapped slots
  for (const k of Object.keys(params)) {
    const v = params[k];
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)) delete params[k];
  }
  try {
    const { def, layers: built } = buildTemplate(templateId, { canvas }, params, kit);
    if (!def || !built || !built.length) return null;
    return { layers: built, templateId: def.id, params };
  } catch {
    return null;
  }
}

// ── LOOSE-LAYER GROUPING ───────────────────────────────────────────────────────────────────────
// When we DON'T fill a preset (generic / low-confidence), the loose skeleton layers get grouped
// into named REGION groups (header / body / product / cta) by vertical band + role, so the layer
// tree has hierarchy instead of a flat 50-layer pile. Groups are Figma-clean GroupNodes (box =
// bounds of absolute-coord children); ungrouped stragglers stay at the top level.
let groupSeq = 0;
const groupId = () => `grp-${Date.now().toString(36)}-${(groupSeq++).toString(36)}`;

/** Classify a loose skeleton layer into a region bucket by role + vertical position. */
function regionOf(layer, canvasH) {
  const role = String(layer?.role || '').toLowerCase();
  const y = Number(layer?.box?.y) || 0;
  const cy = y / Math.max(1, canvasH);
  if (/cta|button/.test(role) || layer?.type === 'button') return 'cta';
  if (/product|avatar|image|photo|logo/.test(role) || layer?.type === 'image') return 'product';
  if (/headline|title|nav|header|badge/.test(role) && cy < 0.28) return 'header';
  if (cy < 0.2) return 'header';
  if (cy > 0.82) return 'cta';
  return 'body';
}

const REGION_NAMES = { header: 'Header', body: 'Body', product: 'Product', cta: 'CTA' };
const REGION_ORDER = ['header', 'body', 'product', 'cta'];

/**
 * Group loose skeleton layers into named region groups so the layer tree reads with hierarchy.
 * A region with 2+ members becomes a group; a lone member stays a top-level leaf. Base/background
 * layers stay ungrouped at the very back. Returns a new top-level layer list. Never throws.
 */
export function groupLooseLayers(layers, canvasH) {
  if (!Array.isArray(layers) || layers.length < 2) return layers || [];
  const buckets = { header: [], body: [], product: [], cta: [] };
  const loose = [];
  for (const l of layers) {
    if (!l || l.role === 'base' || l.role === 'background') { loose.push(l); continue; }
    try { buckets[regionOf(l, canvasH)].push(l); } catch { loose.push(l); }
  }
  const out = [...loose];
  for (const key of REGION_ORDER) {
    const kids = buckets[key];
    if (kids.length >= 2) {
      out.push({ id: groupId(), type: 'group', name: REGION_NAMES[key], box: groupBounds(kids) || { x: 0, y: 0, w: 0, h: 0 }, children: kids });
    } else if (kids.length === 1) {
      out.push(kids[0]);
    }
  }
  return out;
}

/** Parse a vision reply string → raw extraction object (tolerant). */
function parseRaw(text) {
  return extractJson(String(text || '')) || (() => {
    try { const j = JSON.parse(text); return Array.isArray(j.layers) ? j : null; } catch { return null; }
  })();
}

// ── Refine-loop merge/diff (FIX 2) ─────────────────────────────────────────────────────────────

/** A layer is "high confidence" (worth keeping if a refine pass drops it) when it carries real
 *  text or is a real region with a sane box. */
function isHighConfidenceLayer(l) {
  if (!l || !l.box) return false;
  const hasText = typeof l.text === 'string' && l.text.trim().length >= 2;
  const hasBox = Number(l.box.w) > 3 && Number(l.box.h) > 1;
  return hasBox && (hasText || l.type === 'image');
}

/** Loose identity for a layer so we can tell "same layer, adjusted" from "new/dropped". Text
 *  layers key on normalized text; region layers key on type+role+rough position. */
function layerKey(l) {
  const t = (l?.text || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (t) return `t:${t.slice(0, 40)}`;
  const b = l?.box || {};
  const gx = Math.round((Number(b.x) || 0) / 12), gy = Math.round((Number(b.y) || 0) / 12);
  return `r:${l?.type || '?'}:${l?.role || '?'}:${gx},${gy}`;
}

/** Did this layer's box move/resize meaningfully vs its prior twin? (>3% on any edge.) */
function boxAdjusted(a, b) {
  if (!a?.box || !b?.box) return false;
  const d = (k) => Math.abs((Number(a.box[k]) || 0) - (Number(b.box[k]) || 0));
  return d('x') > 3 || d('y') > 3 || d('w') > 3 || d('h') > 3;
}

// ── Spatial de-duplication ("same product 40 times" fix) ─────────────────────────────────────
/** Intersection-over-union of two percent-space boxes (0 when disjoint). */
function iou(a, b) {
  if (!a || !b) return 0;
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = ix * iy;
  if (inter <= 0) return 0;
  const uni = a.w * a.h + b.w * b.h - inter;
  return uni > 0 ? inter / uni : 0;
}
/** Fraction of `inner`'s area that falls inside `outer` (containment, 0..1). */
function coverage(inner, outer) {
  if (!inner || !outer) return 0;
  const ix = Math.max(0, Math.min(inner.x + inner.w, outer.x + outer.w) - Math.max(inner.x, outer.x));
  const iy = Math.max(0, Math.min(inner.y + inner.h, outer.y + outer.h) - Math.max(inner.y, outer.y));
  const area = inner.w * inner.h;
  return area > 0 ? (ix * iy) / area : 0;
}
const normText = (t) => String(t || '').toLowerCase().replace(/\s+/g, ' ').trim();
const isProductLike = (l) => l?.type === 'image' || /product|photo|bottle|pack|jar|tube|can|device|phone|hero/i.test(String(l?.role || ''));
/** Rough "how real is this layer" score — real copy + bigger area + a color = more trustworthy. */
function layerConfidence(l) {
  let c = 0;
  if (normText(l?.text).length >= 2) c += 3;
  const b = l?.box || {};
  c += Math.min(3, ((Number(b.w) || 0) * (Number(b.h) || 0)) / 400);
  if (l?.color || l?.style?.background || l?.style?.color) c += 0.5;
  return c;
}

/**
 * Collapse near-duplicate layers vision emits when it re-reports the same region — the "same
 * product 40 times" bug. Two PRODUCT/IMAGE regions that overlap (IoU>0.4 or one mostly inside the
 * other) are the SAME product: we merge them into the UNION box, which tracks the product's true
 * OUTER EDGES across every read (the "beyond four corners" ask — the union of all overlapping reads
 * is the real silhouette bound) and keep the higher-confidence layer's label/color. Duplicate text
 * (same copy, overlapping) collapses to the stronger copy. Returns {layers, removed}.
 */
export function dedupeRawLayers(layers) {
  const src = (Array.isArray(layers) ? layers : []).filter((l) => l && l.box);
  const out = [];
  let removed = 0;
  for (const l of src) {
    let hit = null;
    for (const k of out) {
      const ov = iou(l.box, k.box);
      const contained = coverage(l.box, k.box) > 0.7 || coverage(k.box, l.box) > 0.7;
      const t1 = normText(l.text), t2 = normText(k.text);
      if (isProductLike(l) && isProductLike(k) && (ov > 0.4 || contained)) {
        const keep = layerConfidence(k) >= layerConfidence(l) ? k : l;
        const drop = keep === k ? l : k;
        const nx = Math.min(l.box.x, k.box.x), ny = Math.min(l.box.y, k.box.y);
        keep.box = { x: nx, y: ny,
          w: Math.max(l.box.x + l.box.w, k.box.x + k.box.w) - nx,
          h: Math.max(l.box.y + l.box.h, k.box.y + k.box.h) - ny };
        if (!normText(keep.text) && normText(drop.text)) keep.text = drop.text;
        if (!keep.color && drop.color) keep.color = drop.color;
        if (keep === l) { const i = out.indexOf(k); if (i >= 0) out[i] = l; }
        hit = keep; break;
      }
      if (t1 && t1 === t2 && (ov > 0.15 || contained)) {
        const keep = layerConfidence(k) >= layerConfidence(l) ? k : l;
        if (keep === l) { const i = out.indexOf(k); if (i >= 0) out[i] = l; }
        hit = keep; break;
      }
      if (l.type === k.type && contained && ov > 0.6) {
        const keep = layerConfidence(k) >= layerConfidence(l) ? k : l;
        if (keep === l) { const i = out.indexOf(k); if (i >= 0) out[i] = l; }
        hit = keep; break;
      }
    }
    if (hit) removed++;
    else out.push(l);
  }
  return { layers: out, removed };
}

/**
 * Merge a refined pass over the prior best: prefer the refined layers (the model's correction),
 * but re-add any HIGH-CONFIDENCE prior layer the refine dropped (so refinement never loses a
 * solid layer to a careless omission). Returns { merged, summary:{added,dropped,adjusted} }.
 */
function mergeRefined(prior, refined) {
  const priorLayers = Array.isArray(prior?.layers) ? prior.layers : [];
  const refinedLayers = Array.isArray(refined?.layers) ? refined.layers : [];
  const priorByKey = new Map(priorLayers.map((l) => [layerKey(l), l]));
  const refinedKeys = new Set(refinedLayers.map(layerKey));

  let added = 0, adjusted = 0;
  for (const rl of refinedLayers) {
    const twin = priorByKey.get(layerKey(rl));
    if (!twin) added++;
    else if (boxAdjusted(twin, rl)) adjusted++;
  }
  // Re-add high-confidence prior layers the refine forgot (respect MAX_LAYERS).
  const merged = refinedLayers.slice(0, MAX_LAYERS);
  let dropped = 0;
  for (const pl of priorLayers) {
    if (refinedKeys.has(layerKey(pl))) continue;
    if (isHighConfidenceLayer(pl) && merged.length < MAX_LAYERS) { merged.push(pl); dropped++; }
  }
  const out = {
    canvasRatio: Number(refined?.canvasRatio) || Number(prior?.canvasRatio) || null,
    archetype: (refined?.archetype && refined.archetype !== 'generic') ? refined.archetype : (prior?.archetype || refined?.archetype),
    background: refined?.background != null ? refined.background : prior?.background,
    backgroundKind: refined?.backgroundKind || prior?.backgroundKind,
    layers: merged,
  };
  return { merged: out, summary: { added, dropped, adjusted } };
}

// Above this flatness (mean |Δluminance| across the sampled border), the frame is NOT a flat fill —
// it's a busy photo edge — and we must not collapse it to a single averaged "dominant" hex. This is
// looser than the `strongFlat` solid-color threshold below; it marks the upper end where averaging
// would actively misrepresent the reference (Michael: "pure black is fine IF the bg truly is solid;
// it's wrong when a full-bleed photo gets flattened into a black/solid swatch").
const PHOTO_VARIANCE_THRESHOLD = 0.09;

/**
 * Reconcile the model's `background` (+ its own backgroundKind judgment) against a deterministic
 * border-pixel sample (FIX 1). The border sampler reads REAL pixels, so we trust it hard — the
 * model routinely mis-reports background luminance (says white on a black ad) AND routinely
 * flattens a full-bleed photo into a solid hex. Priority:
 * - Model gave a valid GRADIENT → trust it (the sampler only yields a flat color).
 * - Model explicitly said backgroundKind "photo" (background null) AND the sampled border is NOT
 *   strongly flat → trust the model + pixels agreeing it's a photo: return null + isPhoto.
 * - Sampler read a HIGH-VARIANCE (non-flat) border → this is a photo edge, not a solid fill, even
 *   if the model guessed a hex. Do NOT average it into a dominant color: return null + isPhoto so
 *   downstream uses the actual reference photo as the base layer instead of a flat swatch.
 * - Sampler read a STRONG FLAT frame (low flatness = a genuine solid-color border) → the pixels ARE
 *   the background. Keep the model's hex only when it agrees closely (Δlum ≤ 0.12); otherwise use
 *   the sampled hex. This is what stops a dark ad from resolving to white — and also what lets a
 *   truly solid black background resolve to black without being "corrected" away.
 * - Sampler read a mildly noisy (but not photo-level) frame → the model may know better; keep its
 *   hex unless luminance is WILDLY off (>0.4 delta), then fall back to pixels.
 * - Model gave null → use the sampled hex (unless variance says photo, handled above).
 * - Sampler failed (undecodable) → fall back to whatever the model gave (or null).
 * Returns { background, isPhoto, confidence }: background is a hex string, a {from,to,angle}
 * gradient, or null; isPhoto is true whenever background is null because the reference is a
 * full-bleed photo (as opposed to null just meaning "unknown"); confidence is 'high'|'normal' —
 * 'high' when the border average agrees closely with the image's single most dominant color
 * cluster (cross-checked via the median-cut palette), meaning two independent reads concur.
 * Never throws.
 */
function resolveBackground(modelBg, imagePath, progress, modelKind) {
  // A valid gradient from the model wins outright — our sampler can't represent gradients.
  if (modelBg && typeof modelBg === 'object' && HEX_RE.test(String(modelBg.from)) && HEX_RE.test(String(modelBg.to))) {
    return { background: { from: modelBg.from, to: modelBg.to, angle: Number(modelBg.angle) || 180 }, isPhoto: false, confidence: 'normal' };
  }
  const modelHex = (modelBg && HEX_RE.test(String(modelBg)) && String(modelBg).startsWith('#')) ? String(modelBg) : null;
  const modelSaysPhoto = String(modelKind || '').toLowerCase() === 'photo';

  let sample = null;
  try { sample = sampleBorderBackground(imagePath); } catch { sample = null; }

  // Cross-check: does the border average agree with the single most dominant interior color
  // cluster? When they're close, two independent reads concur → report higher confidence on
  // whichever background hex we end up returning.
  let borderAgreesWithDominant = false;
  if (sample) {
    try {
      const palette = extractDominantPalette(imagePath, 5);
      if (palette.length) borderAgreesWithDominant = colorDistance(sample.hex, palette[0].hex) <= 0.12;
    } catch { /* palette is a bonus signal, never fatal */ }
  }
  const confidence = borderAgreesWithDominant ? 'high' : 'normal';

  if (sample) {
    const tone = sample.lum < 0.35 ? 'dark' : sample.lum > 0.72 ? 'light' : 'mid';
    const strongFlat = typeof sample.flatness === 'number' && sample.flatness <= 0.05;
    const highVariance = typeof sample.flatness === 'number' && sample.flatness >= PHOTO_VARIANCE_THRESHOLD;

    // A busy/non-uniform border means we're sampling a photo, not a solid fill — never collapse
    // it to a single "dominant" hex (the bug: a full-bleed photo misreported as a black/solid
    // swatch). Trust this over any hex the model guessed, and over a bare model hex with no kind.
    if (highVariance && !strongFlat) {
      progress(`border is non-flat (flatness ${sample.flatness.toFixed(3)}) — treating as photo background, not a solid fill`);
      return { background: null, isPhoto: true, confidence: 'normal' };
    }
    if (modelSaysPhoto && !strongFlat) {
      progress('model reports a photo background — honoring it (no flat fill)');
      return { background: null, isPhoto: true, confidence: 'normal' };
    }

    if (!modelHex) {
      progress(`background sampled from pixels: ${sample.hex} (${tone})${borderAgreesWithDominant ? ' · confirmed by dominant-color cross-check' : ''}`);
      return { background: sample.hex, isPhoto: false, confidence };
    }
    const mrgb = hexToRgb(modelHex);
    const modelLum = mrgb ? relLum(mrgb.r, mrgb.g, mrgb.b) : null;
    const dLum = modelLum != null ? Math.abs(modelLum - sample.lum) : 1;
    // A low flatness (≤0.05) means the frame is a genuine solid color — the deterministic read is
    // authoritative. Trust the pixels unless the model's hex is essentially the same tone. This is
    // also what lets a real solid-black background stay black instead of being second-guessed.
    if (strongFlat && dLum > 0.12) {
      progress(`solid ${tone} border ${sample.hex} overrides model bg ${modelHex} (Δlum ${dLum.toFixed(2)})`);
      return { background: sample.hex, isPhoto: false, confidence };
    }
    if (dLum > 0.4) {
      // The model is grossly wrong (e.g. said white on a black bg) — trust the pixels.
      progress(`model bg ${modelHex} contradicts pixels — using sampled ${sample.hex} (${tone})`);
      return { background: sample.hex, isPhoto: false, confidence };
    }
    // Model & pixels agree closely → keep the model's (usually more precise) hex.
    return { background: modelHex, isPhoto: false, confidence };
  }

  // Undecodable image (sampler failed) → whatever the model gave (still honor an explicit photo call).
  if (modelSaysPhoto) return { background: null, isPhoto: true, confidence: 'normal' };
  return { background: modelHex, isPhoto: false, confidence: 'normal' };
}

/**
 * One vision read with TRANSIENT-FAILURE RETRIES that do NOT consume a "real" pass. Empty
 * completions, parse failures, and timeouts get up to `maxAttempts` tries before giving up
 * (Michael: "retries 5 times first before stopping if gemma doesn't work"). A `noVision`
 * response is fatal (no point retrying) and is signaled via the returned shape.
 * Returns { raw, error, noVision, attempts }.
 */
async function visionRead(prompt, imagePath, { timeoutMs, maxAttempts, purpose, label, progress, isCanceled }) {
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (isCanceled()) return { raw: null, error: 'canceled', canceled: true };
    const vr = await llmVision(prompt, imagePath, { json: true, timeoutMs, purpose });
    if (vr.noVision) return { raw: null, error: vr.error, noVision: true };
    if (!vr.ok) {
      lastErr = vr.error;
      progress(`${label}: attempt ${attempt}/${maxAttempts} failed (${vr.error})${attempt < maxAttempts ? ' — retrying' : ''}`);
      continue;
    }
    const raw = parseRaw(vr.text);
    if (!raw || !Array.isArray(raw.layers) || raw.layers.length === 0) {
      lastErr = 'unparsable / empty layout';
      progress(`${label}: attempt ${attempt}/${maxAttempts} unparsable${attempt < maxAttempts ? ' — retrying' : ''}`);
      continue;
    }
    return { raw, error: null, attempts: attempt };
  }
  return { raw: null, error: lastErr || 'no parsable layout from vision' };
}

/**
 * Extract the COMPLETE design from an ad image — VISION-ENDPOINT ONLY (no codex; the operator
 * runs a local VL model like Gemma via VISION_BASE_URL). TRUE ITERATIVE REFINEMENT (not best-of-N):
 * pass 1 extracts fresh, then each later pass gets the SAME image PLUS the prior JSON and is asked
 * to correct it (add missing / fix wrong / drop hallucinated). The merge keeps the refined result
 * but re-adds any high-confidence layer a pass carelessly dropped; the loop stops once the score
 * stops rising. Transient failures RETRY without burning a pass. The BACKGROUND is then reconciled
 * against a DETERMINISTIC border-pixel sample (FIX 1) so a dark bg never resolves to white.
 * Returns { ok, layers, canvas, archetype, background, backgroundIsPhoto, error, passes }.
 * `background` is a hex string, a {from,to,angle} gradient, or null; `backgroundIsPhoto` is true
 * when background is null specifically because the reference is a full-bleed photo (a busy,
 * non-flat border was sampled and/or the model itself called it a photo) — a genuine solid-color
 * or gradient background is preserved as its real value, never forced to null or vice versa.
 * Options: timeoutMs, runId (cancelable), onProgress(msg), passes (default 5).
 */
export async function extractLayout(imagePath, { timeoutMs = 120_000, runId = null, onProgress = null, passes = 2 } = {}) {
  const progress = (msg) => { try { if (onProgress) onProgress(msg); } catch { /* observer only */ } };
  if (!existsSync(imagePath)) {
    progress(`failed: no such image: ${imagePath}`);
    return { ok: false, error: `no such image: ${imagePath}` };
  }
  const info = llmInfo();
  const vinfo = process.env.VISION_BASE_URL ? `vision@${process.env.VISION_MODEL || 'gemma-4-e4b'}` : `${info.provider} vision`;

  let canceled = false;
  if (runId) activeRuns.set(runId, { cancel: () => { canceled = true; } });
  const isCanceled = () => canceled;
  const cleanup = () => { if (runId) activeRuns.delete(runId); };

  const perPass = Math.min(timeoutMs, 90_000);
  const n = Math.max(1, Math.min(4, passes));
  // Up to 5 vision ATTEMPTS for the (harder) first read before giving up entirely.
  const RETRIES = Math.max(5, n);

  // ── Pass 1: fresh extraction ────────────────────────────────────────────────────────────────
  progress(`reading the reference with ${vinfo} — pass 1/${n}…`);
  const first = await visionRead(PROMPT, imagePath, {
    timeoutMs: perPass, maxAttempts: RETRIES, purpose: 'layout-extract',
    label: 'pass 1', progress, isCanceled,
  });
  if (first.canceled) { cleanup(); return { ok: false, error: 'canceled', canceled: true }; }
  if (first.noVision) {
    const msg = `no vision endpoint — start LM Studio with a VL model (e.g. gemma-4-e4b) and set VISION_BASE_URL in studio/.env. (${info.provider}·${info.model} is text-only.)`;
    progress(`failed: ${msg}`); cleanup();
    return { ok: false, error: msg, noVision: true };
  }
  if (!first.raw) {
    progress(`failed: ${first.error}`); cleanup();
    return { ok: false, error: first.error };
  }
  let best = first.raw;
  let bestScore = scoreRaw(best);
  progress(`pass 1: ${best.layers.length} layers · ${best.archetype || 'generic'} (score ${bestScore.toFixed(1)})`);

  // FAST PATH: a strong first read (enough real layers, a recognized archetype, high score) needs
  // no refine — this is what turns the common case from ~4 min (5 sequential passes) into a single
  // ~60 s read. A weak read still gets ONE corrective pass.
  const firstStrong = best.layers.length >= 6 && bestScore >= 10 && best.archetype && best.archetype !== 'generic';
  const lastPass = firstStrong ? 1 : n;
  if (firstStrong && n >= 2) progress('first read is strong — skipping refinement');

  // ── Passes 2..N: REFINE against the prior best ──────────────────────────────────────────────
  for (let pass = 2; pass <= lastPass; pass++) {
    if (canceled) { cleanup(); return { ok: false, error: 'canceled', canceled: true }; }
    progress(`refining — pass ${pass}/${n}…`);
    const priorJson = JSON.stringify({ archetype: best.archetype, backgroundKind: best.backgroundKind, background: best.background, layers: best.layers });
    const ref = await visionRead(REFINE_PROMPT(priorJson), imagePath, {
      timeoutMs: perPass, maxAttempts: RETRIES, purpose: 'layout-refine',
      label: `pass ${pass}`, progress, isCanceled,
    });
    if (ref.canceled) { cleanup(); return { ok: false, error: 'canceled', canceled: true }; }
    if (!ref.raw) { progress(`pass ${pass}: no usable correction — keeping best`); break; }

    const { merged, summary } = mergeRefined(best, ref.raw);
    const mergedScore = scoreRaw(merged);
    const changed = summary.added || summary.dropped || summary.adjusted;
    progress(`pass ${pass}: +${summary.added} layers, ${summary.adjusted} boxes adjusted${summary.dropped ? `, kept ${summary.dropped} it dropped` : ''} (score ${mergedScore.toFixed(1)})`);
    if (mergedScore > bestScore) {
      best = merged; bestScore = mergedScore;
    } else if (!changed) {
      progress('refinement converged — stopping'); break;
    } else {
      // It changed things but didn't improve the score → stop; the read is stable.
      progress('no further improvement — stopping'); break;
    }
  }
  cleanup();

  // ── De-dupe: collapse the same product/text reported across passes into ONE (union outer edges) ─
  const beforeDedup = Array.isArray(best.layers) ? best.layers.length : 0;
  const dd = dedupeRawLayers(best.layers);
  best.layers = dd.layers;
  if (dd.removed) progress(`merged ${dd.removed} duplicate region${dd.removed === 1 ? '' : 's'} → ${best.layers.length} unique (from ${beforeDedup})`);

  const trueRatio = imageRatio(imagePath);
  const ratio = trueRatio || Math.max(0.5, Math.min(2.6, Number(best.canvasRatio) || 1));
  const canvas = { w: CANON_W, h: Math.round(CANON_W * ratio) };
  if (trueRatio) progress(`canvas locked to reference aspect ${Math.round(CANON_W)}x${Math.round(CANON_W * ratio)}`);
  // Archetype: reconcile the model's guess with deterministic chrome-signal detection so an obvious
  // preset (x-post, apple-notes, …) is recognized even when the small VL model punts to generic.
  const archetype = resolveArchetype(best.archetype, best, progress);
  const det = detectArchetypeFromLayers(best);

  // ── Background: model report, then RECONCILE against deterministic border pixels (FIX 1) ─────
  const { background, isPhoto: backgroundIsPhoto, confidence: backgroundConfidence } = resolveBackground(best.background, imagePath, progress, best.backgroundKind);

  // ── DOMINANT PALETTE: top 3-5 colors over the FULL image (median-cut), additive field for
  // downstream consumers (accent/product/brand color picking) — never affects layers/background.
  let dominantPalette = [];
  try {
    dominantPalette = extractDominantPalette(imagePath, 5).map((c) => ({ hex: c.hex, share: Number(c.share.toFixed(3)) }));
  } catch { dominantPalette = []; }
  if (dominantPalette.length) progress(`palette: ${dominantPalette.map((c) => `${c.hex} (${Math.round(c.share * 100)}%)`).join(', ')}`);

  // ── DETECTION → PRESET FILL ─────────────────────────────────────────────────────────────────
  // When the archetype is a KNOWN preset AND we're reasonably confident (a strong deterministic
  // chrome signal, OR the vision model itself named this same non-generic archetype), map the
  // detected copy/regions onto the template's param slots and BUILD the composed 1:1 preset —
  // grouped, on-format — instead of loose boxes. Unmapped slots keep the template's defaults.
  if (archetype !== 'generic' && ARCHETYPE_TO_TEMPLATE[archetype]) {
    const confident = (det.strong && det.archetype === archetype) || best.archetype === archetype;
    if (confident) {
      const filled = fillPresetFromExtraction(archetype, best, canvas, null);
      if (filled && filled.layers.length) {
        const mapped = Object.keys(filled.params);
        progress(`detected ${archetype} → filled ${filled.templateId} preset (${mapped.length ? 'mapped ' + mapped.join(', ') : 'template defaults'} · ${filled.layers.length} groups)`);
        progress(`done · ${filled.layers.length} layers · ${archetype} (preset)${backgroundIsPhoto ? ' · bg photo (full-bleed)' : background ? ' · bg ' + (typeof background === 'string' ? background : 'gradient') : ''}`);
        return { ok: true, layers: filled.layers, canvas, archetype, background, backgroundIsPhoto, backgroundConfidence, dominantPalette, error: null, passes: n };
      }
      progress(`preset fill for ${archetype} produced nothing — falling back to grouped loose layers`);
    }
  }

  // ── LOOSE-LAYER PATH (generic / low-confidence): skeleton boxes, GROUPED into region groups ──
  const flat = toSkeletonLayers(best, canvas);
  if (!flat.length) { progress('failed: extraction found no design layers'); return { ok: false, error: 'extraction found no design layers' }; }
  const layers = groupLooseLayers(flat, canvas.h);

  progress(`done · ${flat.length} layers · ${archetype}${backgroundIsPhoto ? ' · bg photo (full-bleed)' : background ? ' · bg ' + (typeof background === 'string' ? background : 'gradient') : ''}`);
  return { ok: true, layers, canvas, archetype, background, backgroundIsPhoto, backgroundConfidence, dominantPalette, error: null, passes: n };
}

// ── describeImage (v3 agent attachments) ─────────────────────────────────────────────────────────

const DESC_PROMPT = 'You are a senior ad designer. Describe the attached image in EXACTLY 2 sentences: what it shows and what makes it useful as a design reference (palette, composition, mood). Plain text only, no lists, no preamble.';

/** Pull the agent's final plain-text message out of codex --json JSONL output. */
function extractPlainText(out) {
  let text = null;
  for (const line of String(out).split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    let obj;
    try { obj = JSON.parse(t); } catch { continue; }
    const kind = obj?.item?.type || obj?.msg?.type || obj?.type || '';
    const c = obj?.item?.text ?? obj?.msg?.message ?? (typeof obj?.text === 'string' ? obj.text : null);
    if (typeof c === 'string' && c.trim() && /agent|assistant|message/i.test(String(kind))) text = c;
  }
  return text ? text.trim() : null;
}

/**
 * 2-sentence designer description of an image via codex vision, cached at
 * .state/refs/{cacheId}.desc.txt so each reference is described at most once.
 * Returns { ok, text, error, cached? }. Never throws.
 */
export async function describeImage(imagePath, { cacheId = null, timeoutMs = 60_000 } = {}) {
  const refsDir = join(STUDIO_DIR, '.state', 'refs');
  const cacheFile = cacheId ? join(refsDir, `${String(cacheId).replace(/[^\w-]+/g, '-')}.desc.txt`) : null;
  if (cacheFile && existsSync(cacheFile)) {
    try {
      const text = readFileSync(cacheFile, 'utf8').trim();
      if (text) return { ok: true, text, error: null, cached: true };
    } catch { /* fall through to a fresh call */ }
  }
  // ONLY the configured vision endpoint (LM Studio) — codex-vision fallback removed entirely.
  const vr = await llmVision(DESC_PROMPT, imagePath, { timeoutMs: Math.min(timeoutMs, 60_000), purpose: 'describe-image' });
  if (vr.ok) {
    const trimmed = vr.text.replace(/\s+/g, ' ').slice(0, 500);
    if (cacheFile) { try { mkdirSync(refsDir, { recursive: true }); writeFileSync(cacheFile, trimmed); } catch { /* best-effort */ } }
    return { ok: true, text: trimmed, error: null };
  }
  if (vr.noVision) {
    return { ok: false, text: null, error: 'configured model has no vision — switch LM Studio to a vision-capable model', noVision: true };
  }
  return { ok: false, text: null, error: vr.error };
}

/** Generic codex-vision text call (fallback engine for self-vision & friends): prompt + image
 *  → plain text. Same spawn shape as describeImage. Returns { ok, text, error }. */
export function codexSee(prompt, imagePath, { timeoutMs = 90_000 } = {}) {
  return new Promise((resolve) => {
    if (!existsSync(imagePath)) { resolve({ ok: false, text: null, error: `no such image: ${imagePath}` }); return; }
    const args = [
      '-a', 'never', '-s', 'read-only', 'exec', '--json', '--skip-git-repo-check', '--ignore-rules',
      '-i', imagePath, '-C', STUDIO_DIR, String(prompt),
    ];
    const child = spawn(CODEX_CLI, args, { cwd: STUDIO_DIR, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try { child.kill('SIGTERM'); } catch { /* gone */ }
      const text = extractPlainText(out);
      resolve(text ? { ok: true, text: text.trim(), error: null } : { ok: false, text: null, error: 'no reply from codex vision' });
    };
    const t = setTimeout(finish, timeoutMs);
    const collect = (d) => { out += d.toString(); if (out.length > 200_000) out = out.slice(-200_000); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', () => { clearTimeout(t); finish(); });
    child.on('close', () => { clearTimeout(t); finish(); });
  });
}
