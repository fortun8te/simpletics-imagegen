// lib/copy-pipeline.mjs — image → editable DesignDoc, from scratch out of the landed module APIs.
//
// runCopyPipeline(imgPath, opts) -> { ok, doc, job, keptInPhoto }
//   Turns one ad image into a DesignDoc matching the corpus schema. Every stage is
//   try/catch → degrade, never abort.
//
//   Stage map (fidelity-fix round 2 — see the D1-D7 defect list):
//     S0   sharp → PNG sRGB, register ref at .state/refs/<refId>.png
//     S1   ocr.recognizeText
//     S5   page-fill fit; when the raw fit says photo, RE-FIT with text+element pixels masked
//          out (D4: a gradient page with a big product on it must NOT become a photo base)
//     SUB  subject detection (photo-fragment / low-solidity CCs), box EXTENSION to the full
//          un-text-masked residual (D6: the pouch's printed 'grüns' region belongs to the
//          subject), matte chain BEN2 → BiRefNet → matte-v1 → rect crop
//     S3   text-origin classify with photoRegions = FULL matte alpha bboxes (D6)
//     PICT leading/trailing pictograph split per overlay line (D3: OCR's substituted bullet
//          is never rendered — icon-match → emoji-detect → crop layer)
//     S2.5 overlay lines → blocks → ONE TEXT LAYER PER SOURCE LINE, width-locked font size
//          from a real Inter advance-width table (D2: rendered line count == source count,
//          wrap can never add lines because box.w always ≥ measured text width)
//     S4   non-photo elements → icon-match → emoji → vectorize → crop/panel
//     S7   drop shadows; S8 font-match (budgeted); S10 semantics roles
//     S9   photo-base hole fills (D1/D4/D7): every overlay text/icon region is removed from
//          the photo base; holes whose surrounding ring fits flat/linear/radial are filled
//          with renderFill (deterministic, zero smear), only true photo areas go to MI-GAN;
//          engine logged per fill. Cutout mattes get overlay-text alpha ERASED (D1: the
//          matte must not carry a baked twin of a rebuilt overlay).
//
// Pure helpers (measureTextWidthPx / fitFontToWidth / splitLeadingPictograph /
// weightFromDensity / dilateBoxPx / normalizePathD / rgbToHex / zRankForRole /
// formatLayerName / partitionKeptInPhoto) are exported for unit tests — no Chrome, no model.

import { existsSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { recognizeText } from './ocr.mjs';
import { classifyTextOrigins } from './text-origin.mjs';
import { mergeLinesToBlocks, measureInkColor } from './text-blocks.mjs';
import { loadPixels, fitRegionFill, renderFill } from './fill-fit.mjs';
import { detectElements } from './element-detect.mjs';
import { matchIcon } from './icon-match.mjs';
import { fitDropShadow } from './effect-fit.mjs';
import { buildFactsPayload, labelFacts } from './semantics.mjs';
import { measureInkDensity } from './typo-truth.mjs';
import { openJob } from './copy-jobs.mjs';
import { partitionWordmarks } from './wordmarks.mjs';

const STUDIO = join(dirname(fileURLToPath(import.meta.url)), '..');
const REFS_DIR = join(STUDIO, '.state', 'refs');

// ── Inter advance widths (em units), measured in headless Chrome from the SAME embedded
// @font-face the renderer uses (scratchpad-work/fidelity-fix/measure-inter.mjs). This IS the
// renderer's wrap math: box.w derived from these widths can never wrap where Chrome wouldn't
// (Chrome kerning only ever makes real text narrower than this per-char sum). ──────────────
const INTER_WIDTHS = { '400': { 0: 0.631, 1: 0.407, 2: 0.61, 3: 0.618, 4: 0.646, 5: 0.593, 6: 0.62, 7: 0.566, 8: 0.619, 9: 0.62, ' ': 0.281, '!': 0.288, '"': 0.466, '#': 0.633, $: 0.642, '%': 0.982, '&': 0.644, "'": 0.3, '(': 0.365, ')': 0.365, '*': 0.501, '+': 0.662, ',': 0.288, '-': 0.46, '.': 0.288, '/': 0.36, ':': 0.288, ';': 0.302, '<': 0.662, '=': 0.662, '>': 0.662, '?': 0.511, '@': 0.966, A: 0.69, B: 0.654, C: 0.731, D: 0.722, E: 0.601, F: 0.59, G: 0.746, H: 0.743, I: 0.269, J: 0.571, K: 0.672, L: 0.565, M: 0.903, N: 0.753, O: 0.765, P: 0.639, Q: 0.765, R: 0.644, S: 0.642, T: 0.646, U: 0.744, V: 0.69, W: 0.985, X: 0.682, Y: 0.679, Z: 0.629, '[': 0.365, '\\': 0.36, ']': 0.365, '^': 0.471, _: 0.456, '`': 0.323, a: 0.562, b: 0.612, c: 0.571, d: 0.612, e: 0.583, f: 0.37, g: 0.613, h: 0.591, i: 0.242, j: 0.242, k: 0.549, l: 0.242, m: 0.876, n: 0.591, o: 0.6, p: 0.612, q: 0.612, r: 0.377, s: 0.528, t: 0.327, u: 0.591, v: 0.562, w: 0.818, x: 0.546, y: 0.562, z: 0.552, '{': 0.426, '|': 0.333, '}': 0.426, '~': 0.662, '€': 0.667, '’': 0.261, '‘': 0.261, '“': 0.44, '”': 0.44, '–': 0.5, '—': 1, '…': 0.864, ü: 0.591, é: 0.583, ä: 0.562, ö: 0.6, ß: 0.616, '•': 0.563, '·': 0.288, '×': 0.662, '│': 1, '¦': 0.27 }, '500': { 0: 0.645, 1: 0.415, 2: 0.617, 3: 0.627, 4: 0.656, 5: 0.603, 6: 0.63, 7: 0.571, 8: 0.63, 9: 0.63, ' ': 0.267, '!': 0.304, '"': 0.494, '#': 0.639, $: 0.646, '%': 0.993, '&': 0.653, "'": 0.313, '(': 0.369, ')': 0.369, '*': 0.52, '+': 0.667, ',': 0.303, '-': 0.463, '.': 0.303, '/': 0.37, ':': 0.303, ';': 0.316, '<': 0.667, '=': 0.667, '>': 0.667, '?': 0.527, '@': 0.983, A: 0.709, B: 0.657, C: 0.734, D: 0.722, E: 0.603, F: 0.589, G: 0.748, H: 0.744, I: 0.273, J: 0.575, K: 0.688, L: 0.565, M: 0.913, N: 0.756, O: 0.767, P: 0.642, Q: 0.769, R: 0.648, S: 0.646, T: 0.653, U: 0.74, V: 0.709, W: 1.003, X: 0.701, Y: 0.696, Z: 0.641, '[': 0.369, '\\': 0.37, ']': 0.369, '^': 0.476, _: 0.463, '`': 0.337, a: 0.568, b: 0.618, c: 0.577, d: 0.618, e: 0.587, f: 0.379, g: 0.619, h: 0.602, i: 0.252, j: 0.252, k: 0.559, l: 0.252, m: 0.888, n: 0.601, o: 0.604, p: 0.618, q: 0.618, r: 0.387, s: 0.539, t: 0.34, u: 0.602, v: 0.575, w: 0.829, x: 0.557, y: 0.575, z: 0.559, '{': 0.441, '|': 0.346, '}': 0.441, '~': 0.667, '€': 0.673, '’': 0.277, '‘': 0.277, '“': 0.474, '”': 0.471, '–': 0.5, '—': 1, '…': 0.91, ü: 0.602, é: 0.587, ä: 0.568, ö: 0.604, ß: 0.63, '•': 0.533, '·': 0.303, '×': 0.667, '│': 0.625, '¦': 0.293 }, '600': { 0: 0.66, 1: 0.423, 2: 0.623, 3: 0.636, 4: 0.666, 5: 0.612, 6: 0.64, 7: 0.576, 8: 0.64, 9: 0.64, ' ': 0.252, '!': 0.321, '"': 0.523, '#': 0.644, $: 0.65, '%': 1.004, '&': 0.663, "'": 0.326, '(': 0.373, ')': 0.373, '*': 0.54, '+': 0.673, ',': 0.319, '-': 0.465, '.': 0.319, '/': 0.379, ':': 0.319, ';': 0.329, '<': 0.673, '=': 0.673, '>': 0.673, '?': 0.543, '@': 0.999, A: 0.728, B: 0.659, C: 0.737, D: 0.722, E: 0.605, F: 0.588, G: 0.749, H: 0.746, I: 0.277, J: 0.58, K: 0.703, L: 0.565, M: 0.922, N: 0.759, O: 0.769, P: 0.645, Q: 0.773, R: 0.652, S: 0.65, T: 0.66, U: 0.736, V: 0.728, W: 1.02, X: 0.72, Y: 0.714, Z: 0.653, '[': 0.373, '\\': 0.379, ']': 0.373, '^': 0.482, _: 0.469, '`': 0.351, a: 0.574, b: 0.624, c: 0.583, d: 0.624, e: 0.591, f: 0.389, g: 0.626, h: 0.612, i: 0.262, j: 0.262, k: 0.57, l: 0.262, m: 0.9, n: 0.612, o: 0.609, p: 0.624, q: 0.624, r: 0.397, s: 0.55, t: 0.353, u: 0.612, v: 0.587, w: 0.84, x: 0.569, y: 0.589, z: 0.566, '{': 0.455, '|': 0.359, '}': 0.455, '~': 0.673, '€': 0.679, '’': 0.294, '‘': 0.294, '“': 0.507, '”': 0.501, '–': 0.5, '—': 1, '…': 0.956, ü: 0.612, é: 0.591, ä: 0.574, ö: 0.609, ß: 0.644, '•': 0.503, '·': 0.319, '×': 0.673, '│': 1, '¦': 0.316 }, '700': { 0: 0.674, 1: 0.431, 2: 0.63, 3: 0.645, 4: 0.676, 5: 0.622, 6: 0.65, 7: 0.582, 8: 0.651, 9: 0.65, ' ': 0.237, '!': 0.338, '"': 0.552, '#': 0.649, $: 0.655, '%': 1.015, '&': 0.672, "'": 0.339, '(': 0.377, ')': 0.377, '*': 0.559, '+': 0.679, ',': 0.334, '-': 0.468, '.': 0.334, '/': 0.388, ':': 0.334, ';': 0.343, '<': 0.679, '=': 0.679, '>': 0.679, '?': 0.56, '@': 1.016, A: 0.747, B: 0.662, C: 0.74, D: 0.722, E: 0.607, F: 0.587, G: 0.751, H: 0.747, I: 0.281, J: 0.584, K: 0.719, L: 0.565, M: 0.932, N: 0.762, O: 0.77, P: 0.648, Q: 0.777, R: 0.657, S: 0.655, T: 0.668, U: 0.732, V: 0.747, W: 1.038, X: 0.738, Y: 0.731, Z: 0.664, '[': 0.377, '\\': 0.388, ']': 0.377, '^': 0.487, _: 0.476, '`': 0.365, a: 0.581, b: 0.63, c: 0.588, d: 0.63, e: 0.596, f: 0.398, g: 0.632, h: 0.623, i: 0.271, j: 0.271, k: 0.58, l: 0.271, m: 0.912, n: 0.623, o: 0.613, p: 0.63, q: 0.63, r: 0.407, s: 0.56, t: 0.366, u: 0.623, v: 0.6, w: 0.85, x: 0.58, y: 0.602, z: 0.573, '{': 0.469, '|': 0.372, '}': 0.469, '~': 0.679, '€': 0.685, '’': 0.311, '‘': 0.311, '“': 0.54, '”': 0.532, '–': 0.5, '—': 1, '…': 1.002, ü: 0.623, é: 0.596, ä: 0.581, ö: 0.613, ß: 0.657, '•': 0.474, '·': 0.334, '×': 0.679, '│': 1, '¦': 0.339 }, '800': { 0: 0.692, 1: 0.441, 2: 0.638, 3: 0.657, 4: 0.689, 5: 0.634, 6: 0.662, 7: 0.588, 8: 0.664, 9: 0.662, ' ': 0.219, '!': 0.359, '"': 0.586, '#': 0.655, $: 0.66, '%': 1.029, '&': 0.683, "'": 0.355, '(': 0.382, ')': 0.382, '*': 0.583, '+': 0.686, ',': 0.353, '-': 0.471, '.': 0.353, '/': 0.4, ':': 0.353, ';': 0.36, '<': 0.686, '=': 0.686, '>': 0.686, '?': 0.579, '@': 1.036, A: 0.77, B: 0.665, C: 0.744, D: 0.722, E: 0.61, F: 0.586, G: 0.752, H: 0.748, I: 0.286, J: 0.59, K: 0.738, L: 0.565, M: 0.943, N: 0.766, O: 0.773, P: 0.652, Q: 0.782, R: 0.662, S: 0.66, T: 0.677, U: 0.727, V: 0.77, W: 1.059, X: 0.761, Y: 0.752, Z: 0.679, '[': 0.382, '\\': 0.4, ']': 0.382, '^': 0.493, _: 0.484, '`': 0.383, a: 0.588, b: 0.638, c: 0.595, d: 0.638, e: 0.601, f: 0.41, g: 0.639, h: 0.636, i: 0.283, j: 0.283, k: 0.593, l: 0.283, m: 0.927, n: 0.635, o: 0.619, p: 0.638, q: 0.638, r: 0.42, s: 0.574, t: 0.382, u: 0.636, v: 0.615, w: 0.863, x: 0.594, y: 0.618, z: 0.581, '{': 0.486, '|': 0.388, '}': 0.486, '~': 0.686, '€': 0.692, '’': 0.331, '‘': 0.331, '“': 0.58, '”': 0.569, '–': 0.5, '—': 1, '…': 1.058, ü: 0.636, é: 0.601, ä: 0.588, ö: 0.619, ß: 0.674, '•': 0.438, '·': 0.353, '×': 0.686, '│': 1, '¦': 0.367 } };
const WEIGHT_KEYS = [400, 500, 600, 700, 800];

// ── pure helpers (unit-tested) ───────────────────────────────────────────────────────────────

/** [r,g,b] (0-255) → #rrggbb. Clamps + rounds. */
export function rgbToHex(rgb) {
  const c = (v) => Math.max(0, Math.min(255, Math.round(Number(v) || 0))).toString(16).padStart(2, '0');
  const [r, g, b] = Array.isArray(rgb) ? rgb : [0, 0, 0];
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** Paint-order rank for a role: base → scrims → cutouts → shapes/vectors → text → badges. */
export function zRankForRole(role) {
  switch (role) {
    case 'base': return 0;
    case 'scrim': return 1;
    case 'product': case 'person': case 'rect': return 2; // subject cutouts
    case 'icon': case 'decoration': case 'logo': return 3; // shapes / vectors
    case 'badge': case 'price': return 5;                  // badges float on top
    default: return 4;                                     // text / other
  }
}

/** Truncate a string to n chars with an ellipsis, collapsing newlines. */
function ellipsize(s, n = 18) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/** Semantic layer name, e.g. `Headline — "THE 10 SEC…"`, `Product — cutout`. */
export function formatLayerName(kind, { role, text, label } = {}) {
  const cap = (r) => (r ? r.charAt(0).toUpperCase() + r.slice(1) : '');
  if (kind === 'text') {
    const head = cap(role || 'Text');
    return `${head} — "${ellipsize(text, 18)}"`;
  }
  if (kind === 'image') return `${cap(role || 'Element')} — ${label || 'cutout'}`;
  if (kind === 'shape') return `${cap(role || 'Shape')} — ${label || 'shape'}`;
  return cap(role || kind);
}

/** Split classified OCR lines into overlay lines and keptInPhoto strings. */
export function partitionKeptInPhoto(lines, origins, { keepAmbiguousAsOverlay = true } = {}) {
  const originOf = {};
  const arr = Array.isArray(origins?.lines) ? origins.lines : (Array.isArray(origins) ? origins : []);
  for (const o of arr) originOf[o.id] = o.origin;
  const overlay = [];
  const keptInPhoto = [];
  for (const l of (Array.isArray(lines) ? lines : [])) {
    const o = originOf[l.id] || 'overlay';
    if (o === 'scene' || (o === 'ambiguous' && !keepAmbiguousAsOverlay)) {
      if (l.text && l.text.trim()) keptInPhoto.push(l.text.trim());
    } else {
      overlay.push(l);
    }
  }
  return { overlay, keptInPhoto };
}

/** Softly reconcile font picks for clearly similar peer labels, never for an entire ad. */
export function reconcileFontFamilies(blockMatches, { fontSizeTolerance = 4, weightTolerance = 150 } = {}) {
  const rows = [];
  for (const item of (Array.isArray(blockMatches) ? blockMatches : [])) {
    if (!item?.block || !Array.isArray(item.matches) || !item.matches.length) continue;
    const b = item.block;
    const fs = Number(b._fontSize) || 0, weight = Number(b._weight) || 400;
    const cy = (Number(b.box?.y) || 0) + (Number(b.box?.h) || 0) / 2;
    let row = rows.find((r) => Math.abs(r.fs - fs) <= fontSizeTolerance
      && Math.abs(r.weight - weight) <= weightTolerance);
    if (!row) { row = { fs, weight, cy, items: [] }; rows.push(row); }
    row.items.push(item);
  }
  for (const row of rows) {
    if (row.items.length < 2) continue;
    const votes = new Map();
    for (const item of row.items) for (const m of item.matches.slice(0, 5)) {
      votes.set(m.family, (votes.get(m.family) || 0) + Math.max(0, Number(m.score) || 0));
    }
    const winner = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (!winner) continue;
    for (const item of row.items) {
      const own = item.matches[0];
      const sibling = item.matches.find((m) => m.family === winner);
      // A clearly stronger individual match wins; the row is only a noisy-short-label tie-break.
      if (row.items.length >= 3 || (sibling && (!own || Number(own.score) - Number(sibling.score) < 0.08))) item.family = winner;
    }
  }
  return blockMatches;
}

/** Measured Inter text width in px (per-char advance sum + CSS letter-spacing). Unknown chars
 *  fall back to the weight's average width. This intentionally IGNORES kerning — Chrome's kerned
 *  runs are always ≤ this sum, so a box sized from it can never wrap. */
export function measureTextWidthPx(text, fontSize, fontWeight = 600, letterSpacing = 0) {
  const wk = WEIGHT_KEYS.reduce((a, b) => (Math.abs(b - fontWeight) < Math.abs(a - fontWeight) ? b : a));
  const table = INTER_WIDTHS[String(wk)];
  const avg = 0.6;
  let em = 0;
  const s = String(text || '');
  for (const ch of s) em += table[ch] ?? (ch === ' ' ? table[' '] : avg);
  return em * fontSize + letterSpacing * [...s].length;
}

/** Largest fontSize whose measured width fits targetW (solves width = em·fs + ls·n). ≥6px. */
export function fitFontToWidth(text, targetW, fontWeight = 600, letterSpacing = 0) {
  const n = [...String(text || '')].length;
  if (!n || !(targetW > 0)) return 12;
  const emSum = measureTextWidthPx(text, 1, fontWeight, 0); // em width at fs=1
  if (emSum <= 0) return 12;
  const fs = (targetW - letterSpacing * n) / emSum;
  return Math.max(6, fs);
}

/** Ink-density → Inter weight class (calibration constants from lib/typo-truth.mjs header). */
export function weightFromDensity(density, uppercase = false) {
  if (!(density > 0)) return null;
  const curve = uppercase
    ? [[0.376, 400], [0.434, 500], [0.488, 600], [0.527, 700], [0.587, 800]]
    : [[0.319, 400], [0.355, 500], [0.395, 600], [0.430, 700], [0.462, 800]];
  let best = curve[0][1], bestD = Infinity;
  for (const [d, w] of curve) {
    const dd = Math.abs(density - d);
    if (dd < bestD) { bestD = dd; best = w; }
  }
  return best;
}

const BULLET_LIKE = new Set(['•', '●', '◦', '▪', '·', '∙', '‣', '⁃', '*', '★', '☆', '♡', '♥', '❤', '✓', '✔', '→', '➜', '►', '▶', '¤', '☐', '■', '□', '¦']);
const isPictoWord = (t) => {
  const s = String(t || '').trim();
  if (!s) return false;
  if (s.length === 1 && BULLET_LIKE.has(s)) return true;
  // 1-2 chars, no letters/digits/common punctuation → an OCR-mangled pictograph
  return s.length <= 2 && !/[\p{L}\p{N}€$£%&@#!?.,:;'"()\-+/|]/u.test(s);
};

/**
 * D3: detect a pictograph at the head/tail of an OCR line (OCR substitutes marks like ♡ with
 * a bullet, or leaves a leading ink gap). Returns { text, textBox, picto:{box}|null }.
 * `line` = S1 line ({ text, box, words }); fontH = glyph height estimate.
 */
export function splitLeadingPictograph(line) {
  const words = Array.isArray(line?.words) ? line.words.filter((w) => w?.box) : [];
  const out = { text: String(line?.text || ''), textBox: line?.box ? { ...line.box } : null, picto: null };
  if (!out.textBox) return out;
  const fontH = line.box.h || 20;
  if (words.length >= 2 && isPictoWord(words[0].text)) {
    const rest = words.slice(1);
    const x0 = Math.min(...rest.map((w) => w.box.x));
    const x1 = Math.max(...rest.map((w) => w.box.x + w.box.w));
    out.picto = { box: { ...words[0].box } };
    out.text = rest.map((w) => w.text).join(' ');
    out.textBox = { x: x0, y: line.box.y, w: x1 - x0, h: line.box.h };
    return out;
  }
  if (words.length >= 2 && isPictoWord(words[words.length - 1].text)) {
    const rest = words.slice(0, -1);
    const x0 = Math.min(...rest.map((w) => w.box.x));
    const x1 = Math.max(...rest.map((w) => w.box.x + w.box.w));
    out.picto = { box: { ...words[words.length - 1].box } };
    out.text = rest.map((w) => w.text).join(' ');
    out.textBox = { x: x0, y: line.box.y, w: x1 - x0, h: line.box.h };
    return out;
  }
  // leading ink gap ≥ 0.8em before the first recognized word (OCR drew the line box over
  // un-recognized ink) — the caller must verify ink presence pixel-side.
  if (words.length >= 1) {
    const gap = words[0].box.x - line.box.x;
    if (gap >= 0.8 * fontH) {
      out.picto = { box: { x: line.box.x, y: line.box.y, w: gap * 0.94, h: line.box.h }, needsInkCheck: true };
      const x1 = Math.max(...words.map((w) => w.box.x + w.box.w));
      out.textBox = { x: words[0].box.x, y: line.box.y, w: x1 - words[0].box.x, h: line.box.h };
    }
  }
  return out;
}

/** Dilate a box by (dx,dy), clamped into (W,H). */
export function dilateBoxPx(box, dx, dy, W, H) {
  const x = Math.max(0, Math.floor(box.x - dx));
  const y = Math.max(0, Math.floor(box.y - dy));
  return {
    x, y,
    w: Math.min(W, Math.ceil(box.x + box.w + dx)) - x,
    h: Math.min(H, Math.ceil(box.y + box.h + dy)) - y,
  };
}

/** Scale every coordinate of an absolute M/L/C/Z d-string by (sx, sy) — vectorize emits
 *  viewBox-px paths; the doc schema wants 0..1 normalized. */
export function normalizePathD(d, sx, sy) {
  let axis = 0;
  return String(d || '').replace(/-?\d*\.?\d+(?:e[-+]?\d+)?|[a-zA-Z]/gi, (tok) => {
    if (/[a-zA-Z]/.test(tok)) { axis = 0; return tok; }
    const v = Number(tok) * (axis % 2 === 0 ? sx : sy);
    axis++;
    return String(Math.round(v * 10000) / 10000);
  });
}

// ── internal helpers ─────────────────────────────────────────────────────────────────────────

/** Mean luminance (0-255) of a box in an RGBA pixels buffer. */
function boxLuma(pixels, box) {
  if (!pixels) return 128;
  const { data, width, height } = pixels;
  const x0 = Math.max(0, Math.floor(box.x)), y0 = Math.max(0, Math.floor(box.y));
  const x1 = Math.min(width, Math.ceil(box.x + box.w)), y1 = Math.min(height, Math.ceil(box.y + box.h));
  let sum = 0, n = 0;
  const step = Math.max(1, Math.floor((x1 - x0) / 32));
  for (let y = y0; y < y1; y += step) for (let x = x0; x < x1; x += step) {
    const o = (y * width + x) * 4;
    sum += 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2]; n++;
  }
  return n ? sum / n : 128;
}

/** Luminance stddev of a box (ink presence check for gap pictographs). */
function boxLumaStd(pixels, box) {
  if (!pixels) return 0;
  const { data, width, height } = pixels;
  const x0 = Math.max(0, Math.floor(box.x)), y0 = Math.max(0, Math.floor(box.y));
  const x1 = Math.min(width, Math.ceil(box.x + box.w)), y1 = Math.min(height, Math.ceil(box.y + box.h));
  const vals = [];
  const step = Math.max(1, Math.floor((x1 - x0) / 24));
  for (let y = y0; y < y1; y += step) for (let x = x0; x < x1; x += step) {
    const o = (y * width + x) * 4;
    vals.push(0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2]);
  }
  if (vals.length < 4) return 0;
  const m = vals.reduce((a, b) => a + b, 0) / vals.length;
  return Math.sqrt(vals.reduce((a, v) => a + (v - m) * (v - m), 0) / vals.length);
}

/** Locate a saturated green/blue/red accent stroke inside the lower part of a headline region.
 * These underlines/scribbles are illustration, not OCR text; retaining them as a source crop is
 * both more faithful and safer than asking a font/background pass to recreate them. */
export function accentStrokeBox(pixels, box) {
  if (!pixels?.data || !box) return null;
  const W = pixels.width, H = pixels.height;
  const xA = Math.max(0, Math.floor(box.x)), xB = Math.min(W, Math.ceil(box.x + box.w));
  // Start at the very bottom of the headline box: broad colour scans higher up catch the text
  // itself and would reintroduce a baked duplicate.
  const yA = Math.max(0, Math.floor(box.y + box.h * 0.9)), yB = Math.min(H, Math.ceil(box.y + box.h + Math.max(18, box.h * 0.3)));
  let x0 = W, y0 = H, x1 = -1, y1 = -1, n = 0;
  for (let y = yA; y < yB; y++) for (let x = xA; x < xB; x++) {
    const i = (y * W + x) * 4, r = pixels.data[i], g = pixels.data[i + 1], b = pixels.data[i + 2];
    const vivid = (g > r * 1.18 && g > b * 1.08 && g > 75) || (b > r * 1.18 && b > g * 1.08 && b > 75) || (r > g * 1.28 && r > b * 1.2 && r > 100);
    if (!vivid) continue;
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); n++;
  }
  if (n < 40 || x1 - x0 < 18 || y1 - y0 < 2 || (x1 - x0) / Math.max(1, y1 - y0 + 1) < 3) return null;
  return dilateBoxPx({ x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }, 3, 3, W, H);
}

/** fill-fit result → a shape/base layer style. */
function fillToStyle(fit) {
  if (!fit || fit.kind === 'flat') return { shapeKind: 'rect', background: fit?.color || '#ffffff' };
  const stops = (fit.stops || []).map((s) => ({ color: s.color, pos: s.offset ?? s.pos ?? 0 }));
  if (fit.kind === 'linear') {
    return { shapeKind: 'rect', gradient: { type: 'linear', angle: Math.round(fit.angleDeg || 0), stops } };
  }
  if (fit.kind === 'radial') {
    const g = { type: 'radial', stops };
    // fitRegionFill radial centers are {xPct,yPct} percentages (renderFill contract)
    g.cx = (fit.center?.xPct ?? 50) / 100;
    g.cy = (fit.center?.yPct ?? 50) / 100;
    if (fit.radiusPct) g.r = fit.radiusPct / 100;
    return { shapeKind: 'rect', gradient: g };
  }
  return { shapeKind: 'rect', background: fit.color || '#ffffff' };
}

const boxArea = (b) => Math.max(0, b.w) * Math.max(0, b.h);
function interArea(a, b) {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return ix * iy;
}
const insideFrac = (a, b) => interArea(a, b) / Math.max(1, boxArea(a));
function unionBox(a, b) {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

let _uid = 0;
const uid = (p) => `${p}-${Date.now().toString(36)}-${(_uid++).toString(36)}`;

/** Decode a cutout PNG (RGBA) → { data, width, height } or null. */
async function decodeRGBA(path) {
  try {
    const sharp = (await import('sharp')).default;
    const { data, info } = await sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height };
  } catch { return null; }
}

/** bbox of alpha>127 pixels of a cutout, in CANVAS coords (crop origin ox,oy). */
function alphaBBox(cut, ox, oy) {
  const { data, width, height } = cut;
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 127) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  return { x: ox + x0, y: oy + y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** Fraction of a canvas-space box covered by matte alpha (>127) across cutouts. */
function alphaCoverage(box, cutouts) {
  let hit = 0, n = 0;
  const x0 = Math.floor(box.x), y0 = Math.floor(box.y);
  const x1 = Math.ceil(box.x + box.w), y1 = Math.ceil(box.y + box.h);
  const step = Math.max(1, Math.floor(Math.max(box.w, box.h) / 48));
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      n++;
      for (const c of cutouts) {
        if (!c.alpha) continue;
        const lx = x - c.box.x, ly = y - c.box.y;
        if (lx < 0 || ly < 0 || lx >= c.alpha.width || ly >= c.alpha.height) continue;
        if (c.alpha.data[(ly * c.alpha.width + lx) * 4 + 3] > 127) { hit++; break; }
      }
    }
  }
  return n ? hit / n : 0;
}

// ── the pipeline ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {string} imgPath  source ad image (png/webp/jpg)
 * @param {object} [opts]   { fonts=true, semantics=true, matte=true, log=console.log }
 * @returns {Promise<{ok, doc, job, keptInPhoto, error?}>}
 */
export async function runCopyPipeline(imgPath, opts = {}) {
  const doFonts = opts.fonts !== false;
  const doSemantics = opts.semantics !== false;
  const doMatte = opts.matte !== false;
  const log = typeof opts.log === 'function' ? opts.log : (...a) => console.log('[copy]', ...a);

  mkdirSync(REFS_DIR, { recursive: true });
  const job = openJob(imgPath);
  const keptInPhoto = [];

  // ── S0: sharp → PNG sRGB, register ref ──────────────────────────────────────────────────────
  let png, canvasW = 1080, canvasH = 1080, refId, sharp;
  try {
    sharp = (await import('sharp')).default;
    png = job.write('s0.png', await sharp(imgPath).toColourspace('srgb').png().toBuffer());
    const meta = await sharp(png).metadata();
    canvasW = meta.width || 1080; canvasH = meta.height || 1080;
    refId = `copyref-${job.id}`;
    copyFileSync(png, join(REFS_DIR, `${refId}.png`));
  } catch (e) {
    return { ok: false, error: `S0 failed: ${e.message}`, job, doc: null, keptInPhoto };
  }
  const refSrc = `/refasset?id=${refId}`;
  const canvas = { w: canvasW, h: canvasH };

  // ── S1: OCR ─────────────────────────────────────────────────────────────────────────────────
  let s1 = { lines: [] };
  try { const r = await recognizeText(png); if (r.ok) s1 = r; } catch { /* degrade to no text */ }
  const ocrLines = (s1.lines || []).filter((l) => l?.box && l.box.w > 0 && l.box.h > 0);

  // ── S5: page fill (with masked re-fit — D4) ─────────────────────────────────────────────────
  let pixels = null, pageFit = null;
  try { pixels = await loadPixels(png); } catch { /* no pixel measurements */ }
  try { if (pixels) pageFit = fitRegionFill(pixels, { x: 0, y: 0, w: canvasW, h: canvasH }); } catch { /* */ }

  if (pixels && pageFit?.kind === 'photo') {
    // The raw full-page fit says "photo" — but a flat/gradient page carrying a big product +
    // text (013, 016) lands here too. Re-fit with all foreground pixels masked out; a clean
    // masked fit means the PAGE is a designed fill and only the foreground is photographic.
    try {
      const { elements: el0 } = detectElements(pixels, { textLines: ocrLines.map((l) => l.box), background: null, photoRegions: [] });
      const mask = new Uint8Array(canvasW * canvasH).fill(1);
      const zero = (b, dx, dy) => {
        const d = dilateBoxPx(b, dx, dy, canvasW, canvasH);
        for (let y = d.y; y < d.y + d.h; y++) mask.fill(0, y * canvasW + d.x, y * canvasW + d.x + d.w);
      };
      for (const l of ocrLines) zero(l.box, l.box.w * 0.06 + 4, l.box.h * 0.2 + 4);
      for (const el of el0) if ((el.coverage ?? 0) >= 0.0005) zero(el.box, 4, 4);
      let valid = 0;
      for (let i = 0; i < mask.length; i++) valid += mask[i];
      const validFrac = valid / mask.length;
      if (validFrac >= 0.18) {
        const refit = fitRegionFill(pixels, { x: 0, y: 0, w: canvasW, h: canvasH, mask });
        if (refit && refit.kind !== 'photo' && (refit.residual ?? 99) <= 6.5) {
          log(`S5 masked re-fit: page is ${refit.kind} (residual ${refit.residual}, bg coverage ${(validFrac * 100).toFixed(0)}%) — photo verdict overridden`);
          pageFit = refit;
        }
      }
    } catch { /* keep photo verdict */ }
  }
  const pageIsPhoto = !pixels || !pageFit || pageFit.kind === 'photo';
  const pageFlatColor = pageFit && pageFit.kind === 'flat' ? pageFit.color : null;
  const bgForDetect = pageIsPhoto ? null : pageFit;
  log(`S5 page fill: ${pageIsPhoto ? 'photo' : pageFit.kind}${pageFit?.residual != null ? ` (residual ${pageFit.residual})` : ''}`);

  // ── SUB: subjects → matte cutouts ───────────────────────────────────────────────────────────
  // Seeds: photo-fragment CCs, plus low-solidity multi-color 'shape' CCs (a white product on a
  // dark photo classifies as 'shape' — 018's white earplug). Threshold is LOWER on designed
  // (non-photo) pages: white-on-white product shots barely clear the residual gate (D5, 004).
  let detected = { elements: [] };
  try {
    if (pixels) {
      detected = detectElements(pixels, { textLines: ocrLines.map((l) => l.box), background: bgForDetect, photoRegions: [] });
    }
  } catch { /* subjects optional */ }
  const seedThresh = pageIsPhoto ? 0.08 : 0.02;
  const seeds = [];
  for (const el of (detected.elements || [])) {
    if ((el.coverage ?? 0) < seedThresh) continue;
    const subjecty = el.kind === 'photo-fragment'
      || (el.kind === 'shape' && ((el.stats?.solidity ?? 1) < 0.9 || (el.stats?.domColors ?? 0) >= 3));
    if (subjecty) seeds.push({ box: { ...el.box } });
  }

  // D6 extension (non-photo pages): the text mask cuts subjects that carry big package print
  // ('grüns'). Re-detect WITHOUT text masking and union every unmasked CC that overlaps a seed.
  if (!pageIsPhoto && seeds.length && pixels) {
    try {
      const { elements: un } = detectElements(pixels, { textLines: [], background: bgForDetect, photoRegions: [] });
      let grew = true, guard = 0;
      while (grew && guard++ < 4) {
        grew = false;
        for (const s of seeds) {
          for (const el of un) {
            if ((el.coverage ?? 0) < 0.002) continue;
            if (interArea(s.box, el.box) > 0) {
              const u = unionBox(s.box, el.box);
              if (boxArea(u) > boxArea(s.box) + 1) { s.box = u; grew = true; }
            }
          }
        }
      }
    } catch { /* extension optional */ }
  }
  // merge overlapping seeds
  const subjects = [];
  for (const s of seeds.sort((a, b) => boxArea(b.box) - boxArea(a.box))) {
    const host = subjects.find((h) => insideFrac(s.box, h.box) > 0.55 || insideFrac(h.box, s.box) > 0.55);
    if (host) host.box = unionBox(host.box, s.box);
    else subjects.push(s);
  }

  // materialize cutouts (matte chain ben2 → birefnet → matte-v1 → rect crop)
  const cutouts = []; // { layer, box, alpha? (decoded), path?, isRect }
  for (const s of subjects.slice(0, 6)) {
    const box = s.box;
    const cropFrac = { x: box.x / canvasW, y: box.y / canvasH, w: box.w / canvasW, h: box.h / canvasH };
    let src = refSrc, style = { crop: cropFrac, radius: 0 }, label = 'crop', outPath = null, matted = false;
    if (doMatte) {
      try {
        const cutId = `${refId}-cut${cutouts.length}`;
        outPath = join(REFS_DIR, `${cutId}.png`);
        const { matteCutoutV2 } = await import('./matte-v2.mjs');
        let m = await matteCutoutV2(png, cropFrac, outPath, { backend: 'ben2' }).catch(() => ({ ok: false }));
        let engine = 'ben2';
        if (!m?.ok) {
          m = await matteCutoutV2(png, cropFrac, outPath, { backend: 'birefnet' }).catch(() => ({ ok: false }));
          engine = 'birefnet';
        }
        if (!m?.ok) {
          try {
            const { matteCutout } = await import('./matte.mjs');
            m = await matteCutout(png, cropFrac, outPath);
            engine = 'matte-v1';
          } catch { m = { ok: false }; }
        }
        if (m?.ok && existsSync(outPath)) {
          src = `/refasset?id=${cutId}`;
          style = { radius: 0 };
          label = 'cutout';
          matted = true;
          log(`SUB matte ok engine=${engine} box=${JSON.stringify(box)} subjectFrac=${m.subjectFrac ?? '?'}`);
        } else {
          log(`SUB matte FAILED (${m?.reason || 'chain exhausted'}) box=${JSON.stringify(box)} → rect crop`);
          outPath = null;
        }
      } catch { outPath = null; }
    }
    const layer = {
      id: uid('cut'), type: 'image', role: 'product',
      name: formatLayerName('image', { role: 'product', label }),
      box: { ...box }, style, src, _z: zRankForRole('product'),
    };
    const cut = { layer, box: { ...box }, path: outPath, isRect: !matted, alpha: null };
    if (matted && outPath) cut.alpha = await decodeRGBA(outPath);
    cutouts.push(cut);
  }
  const cutoutLayers = cutouts.map((c) => c.layer);

  // photoRegions for S3 = the FULL matte alpha bbox per subject (D6) — the residual CC box
  // under-covers printed package text; the alpha extent is the honest subject footprint.
  const photoRegions = cutouts.map((c) => {
    if (c.alpha) {
      const bb = alphaBBox(c.alpha, c.box.x, c.box.y);
      if (bb) return bb;
    }
    return { ...c.box };
  });

  // ── S3: text-origin classify (photoRegions = matte bboxes) ──────────────────────────────────
  let origins = { lines: [] };
  try { origins = await classifyTextOrigins(png, { ...s1, lines: ocrLines }, { photoRegions }); } catch { /* all overlay */ }
  let { overlay, keptInPhoto: kept } = partitionKeptInPhoto(ocrLines, origins);
  // Package/scene print baked onto a matted subject: text-origin often misreads big bold package
  // print as overlay. Discriminator: print sits ON the product SURFACE (local luminance far from
  // the page background); floating callouts sit on the page background.
  if (photoRegions.length && pixels) {
    const corners = [
      { x: 0, y: 0, w: canvasW * 0.08, h: canvasH * 0.06 },
      { x: canvasW * 0.92, y: 0, w: canvasW * 0.08, h: canvasH * 0.06 },
      { x: 0, y: canvasH * 0.94, w: canvasW * 0.08, h: canvasH * 0.06 },
    ];
    const pageLuma = corners.reduce((s, c) => s + boxLuma(pixels, c), 0) / corners.length;
    const near = (a, b) => {
      const ex = { x: b.x - b.w * 0.12, y: b.y - b.h * 0.12, w: b.w * 1.24, h: b.h * 1.24 };
      return insideFrac(a, ex) >= 0.55;
    };
    const stay = [];
    for (const l of overlay) {
      const onProduct = l.box && photoRegions.some((sb) => near(l.box, sb));
      const offPage = l.box && Math.abs(boxLuma(pixels, l.box) - pageLuma) > 55;
      if (onProduct && offPage) { if (l.text && l.text.trim()) kept.push(l.text.trim()); }
      else stay.push(l);
    }
    overlay = stay;
  }
  // If OCR finds lettering embedded deep inside a photographed product or a compact, coloured
  // scene badge, preserve those source pixels. Rebuilding them as generic text both destroys a
  // brand mark (grüns) and forces destructive inpainting through a detailed product photo.
  const sceneLocked = [];
  const editable = [];
  for (const l of overlay) {
    const b = l.box || {};
    const productWordmark = b.y >= canvasH * 0.68 && b.h >= canvasH * 0.12
      && /^[\p{L}& .'-]{3,}$/u.test(String(l.text || '').trim());
    const embeddedBadgeCopy = b.x >= canvasW * 0.68 && b.y >= canvasH * 0.5
      && b.w <= canvasW * 0.26 && b.h <= canvasH * 0.11;
    if (productWordmark || embeddedBadgeCopy) sceneLocked.push(l);
    else editable.push(l);
  }
  overlay = editable;
  for (const l of sceneLocked) if (l.text?.trim()) kept.push(l.text.trim());
  for (const t of kept) if (!keptInPhoto.includes(t)) keptInPhoto.push(t);

  // ── WORDMARK: brand lettering is artwork, not editable copy (D8) ───────────────────────────
  // Do this BEFORE pictograph splitting so an OCR-substituted heart stays with “Hears Earplugs”.
  const { wordmarks, text: overlayText } = partitionWordmarks(overlay, canvas);
  const wordmarkLayers = wordmarks.map((l) => {
    const pad = Math.max(2, Math.round(l.box.h * 0.12));
    const b = dilateBoxPx(l.box, pad, pad, canvasW, canvasH);
    log(`WORDMARK crop "${ellipsize(l.text, 28)}" box=${JSON.stringify(b)}`);
    return {
      id: uid('logo'), type: 'image', role: 'logo',
      name: formatLayerName('image', { role: 'logo', label: 'wordmark crop' }),
      box: b, src: refSrc,
      style: { crop: { x: b.x / canvasW, y: b.y / canvasH, w: b.w / canvasW, h: b.h / canvasH }, radius: 0 },
      _z: zRankForRole('logo'), _sourceLine: l,
    };
  });

  // ── PICT: pictograph split per remaining overlay line (D3) ──────────────────────────────────
  const pictoLayers = [];
  const pictoJobs = []; // resolved below (icon → emoji → crop)
  const overlayForBlocks = [];
  for (const l of overlayText) {
    // Vision occasionally reads an arrow stroke as a lone `)`. It is artwork, not text.
    if (/^[)\]}]$/.test(String(l.text || '').trim())) {
      pictoJobs.push({ box: l.box, line: l });
      continue;
    }
    let split = null;
    try { split = splitLeadingPictograph(l); } catch { split = null; }
    if (split?.picto) {
      const pb = split.picto.box;
      const inkOk = !split.picto.needsInkCheck || boxLumaStd(pixels, pb) > 16;
      if (inkOk && pb.w >= 6 && pb.h >= 6 && split.text.trim()) {
        pictoJobs.push({ box: pb, line: l });
        overlayForBlocks.push({ ...l, text: split.text, box: split.textBox, words: (l.words || []).filter((w) => !isPictoWord(w.text)) });
        continue;
      }
    }
    overlayForBlocks.push(l);
  }
  for (const pj of pictoJobs) {
    const pb = dilateBoxPx(pj.box, pj.box.w * 0.08 + 1, pj.box.h * 0.08 + 1, canvasW, canvasH);
    let made = null;
    // 1) icon-match → canonical vector path
    try {
      const m = await matchIcon(png, pj.box, { units: 'px' });
      if (m?.matched && m.path && /^[Mm]/.test(String(m.path))) {
        let fill = null;
        try { const ink = measureInkColor(pixels, pj.box); if (ink) fill = rgbToHex(ink.rgb); } catch { /* */ }
        if (!fill) fill = boxLuma(pixels, pj.box) > 140 ? '#111111' : '#ffffff';
        made = {
          id: uid('ico'), type: 'shape', role: 'icon',
          name: formatLayerName('shape', { role: 'icon', label: m.name || 'icon' }),
          box: pb, style: { shapeKind: 'path', path: m.path, background: fill, viewBox: m.viewBox },
          _z: zRankForRole('icon'),
        };
        log(`PICT icon-match "${m.name}" score=${m.score} for "${ellipsize(pj.line.text, 24)}"`);
      }
    } catch { /* chain on */ }
    // 2) emoji-detect → emoji text layer
    if (!made) {
      try {
        const { detectEmoji } = await import('./emoji-detect.mjs');
        const r = await detectEmoji(png, [pj.box], { boxUnits: 'px' });
        const hit = r?.emoji?.[0];
        if (hit?.char) {
          made = {
            id: uid('emo'), type: 'text', role: 'icon',
            name: formatLayerName('text', { role: 'icon', text: hit.char }),
            text: hit.char, autoH: true, box: pb,
            style: { color: '#111111', fontSize: Math.round(pb.h * 0.9), fontWeight: 400, align: 'center', lineHeight: 1 },
            _z: zRankForRole('icon'),
          };
          log(`PICT emoji "${hit.char}" conf=${hit.confidence} for "${ellipsize(pj.line.text, 24)}"`);
        }
      } catch { /* chain on */ }
    }
    // 3) unmatched → small image crop layer (never render OCR's substituted bullet)
    if (!made) {
      made = {
        id: uid('pic'), type: 'image', role: 'icon',
        name: formatLayerName('image', { role: 'icon', label: 'pictograph' }),
        box: pb, src: refSrc,
        style: { crop: { x: pb.x / canvasW, y: pb.y / canvasH, w: pb.w / canvasW, h: pb.h / canvasH }, radius: 0 },
        _z: zRankForRole('icon'),
      };
      log(`PICT crop fallback for "${ellipsize(pj.line.text, 24)}"`);
    }
    pictoLayers.push(made);
  }

  // ── S2.5: overlay lines → blocks → PER-SOURCE-LINE text layers (D2) ─────────────────────────
  // One text layer per OCR line, box.w always ≥ the measured Inter width at the chosen font
  // size → the renderer can never wrap where the source didn't. Font size is WIDTH-LOCKED:
  // solved so the rendered line is exactly as wide as the source line.
  const textLayers = [];
  let blocks = [];
  try {
    const overlayS1 = { ...s1, lines: overlayForBlocks };
    blocks = (mergeLinesToBlocks(overlayS1, { origins, pixels }).blocks) || [];
  } catch { blocks = []; }
  const imgForDensity = pixels ? { ...pixels, channels: 4 } : null;
  const lineById = {};
  for (const l of overlayForBlocks) lineById[l.id] = l;
  for (const b of blocks) {
    if (!b.text || !b.text.trim()) continue;
    const memberLines = (b.lineIds || []).map((id) => lineById[id]).filter(Boolean);
    if (!memberLines.length) continue;
    const uppercase = b.text === b.text.toUpperCase() && /[A-Z]/.test(b.text);
    // OCR-derived tracking is very noisy on ads: it measured 5.9px on the grüns headline where
    // the real lettering is tight. Keep only truly subtle tracking; the font matcher may refine.
    const avgLineH = memberLines.reduce((s, l) => s + (l.box.h || 0), 0) / memberLines.length;
    const rawLs = Number.isFinite(b.letterSpacing) ? Math.max(0, b.letterSpacing) : 0;
    const ls = rawLs <= Math.max(0.5, avgLineH * 0.02) ? rawLs : 0;
    let weight = 600;
    // block-uniform font size: median of per-line width solutions
    const solves = memberLines.map((l) => Math.min(
      fitFontToWidth(l.text, l.box.w, weight, ls),
      (l.box.h || 24) * 1.6,
    )).sort((a, b2) => a - b2);
    const fsBlock = Math.max(8, Math.round(solves[solves.length >> 1] * 0.99));
    // Large display copy is reliably heavier; local pixel density on a yellow/photo background
    // was incorrectly downgrading it to 400.
    weight = fsBlock >= 42 ? 800 : 600;
    // block ink color (per-line fallback)
    let blockColor = null;
    try { const ink = measureInkColor(pixels, b.box); if (ink) blockColor = rgbToHex(ink.rgb); } catch { /* */ }
    const blockLayerIds = [];
    for (const l of memberLines) {
      if (!l.text || !l.text.trim()) continue;
      let color = null;
      try { const ink = measureInkColor(pixels, l.box); if (ink) color = rgbToHex(ink.rgb); } catch { /* */ }
      if (!color) color = blockColor;
      if (!color) color = boxLuma(pixels, l.box) > 140 ? '#111111' : '#ffffff';
      // box.w = max(measured render width, source extent) + pad → wrap-proof (D2)
      const needW = measureTextWidthPx(l.text, fsBlock, weight, ls);
      const w = Math.ceil(Math.max(needW, l.box.w)) + 2;
      let x = l.box.x;
      if (b.align === 'center') x = l.box.x + l.box.w / 2 - w / 2;
      else if (b.align === 'right') x = l.box.x + l.box.w - w;
      const layer = {
        id: uid('txt'), type: 'text', role: 'other',
        name: formatLayerName('text', { role: 'text', text: l.text }),
        text: l.text, autoH: true,
        box: { x: Math.round(x), y: Math.round(l.box.y), w, h: Math.round(l.box.h) },
        style: {
          color, fontSize: fsBlock, fontWeight: weight,
          align: b.align || 'left', uppercase, lineHeight: 1.15,
          ...(ls ? { letterSpacing: Math.round(ls * 10) / 10 } : {}),
        },
        _z: zRankForRole('other'), _blockId: b.id, _srcLineBox: { ...l.box },
      };
      textLayers.push(layer);
      blockLayerIds.push(layer.id);
    }
    b._layerIds = blockLayerIds;
    b._fontSize = fsBlock;
    b._weight = weight;
  }

  // ── S4: non-photo elements → icon chain / fitted-fill panel / crop ──────────────────────────
  const elementLayers = [];
  const rebuiltElementHoles = []; // boxes whose baked pixels must be inpainted on a photo base
  try {
    if (pixels) {
      for (const el of (detected.elements || [])) {
        const cov = el.coverage ?? 0;
        if (cov < 0.0004) continue;
        // covered by a subject matte → lives in the cutout, never a separate element
        if (cutouts.length) {
          const ac = alphaCoverage(el.box, cutouts);
          if (ac > 0.6) continue;
          if (!cutouts.some((c) => c.alpha) && photoRegions.some((r) => insideFrac(el.box, r) > 0.6)) continue;
        }
        const subjecty = subjects.some((s) => insideFrac(el.box, s.box) > 0.9 && boxArea(el.box) > 0.5 * boxArea(s.box));
        if (subjecty) continue;
        // ICON candidates → icon-match → emoji → vectorize → crop (first hit wins)
        if (el.kind === 'icon' && cov <= 0.02) {
          let made = null, engine = null;
          try {
            const m = await matchIcon(png, el.box, { units: 'px' });
            if (m?.matched && m.path && /^[Mm]/.test(String(m.path))) {
              let fill = null;
              try { const ink = measureInkColor(pixels, el.box); if (ink) fill = rgbToHex(ink.rgb); } catch { /* */ }
              if (!fill) fill = boxLuma(pixels, el.box) > 140 ? '#111111' : '#ffffff';
              made = [{
                id: uid('ico'), type: 'shape', role: 'icon',
                name: formatLayerName('shape', { role: 'icon', label: m.name || 'icon' }),
                box: { ...el.box },
                style: { shapeKind: 'path', path: m.path, background: fill, viewBox: m.viewBox },
                _z: zRankForRole('icon'),
              }];
              engine = `icon-match:${m.name}`;
            }
          } catch { /* chain on */ }
          if (!made) {
            try {
              const { detectEmoji } = await import('./emoji-detect.mjs');
              const r = await detectEmoji(png, [el.box], { boxUnits: 'px' });
              const hit = r?.emoji?.[0];
              if (hit?.char) {
                made = [{
                  id: uid('emo'), type: 'text', role: 'icon',
                  name: formatLayerName('text', { role: 'icon', text: hit.char }),
                  text: hit.char, autoH: true, box: { ...el.box },
                  style: { color: '#111111', fontSize: Math.round(el.box.h * 0.9), fontWeight: 400, align: 'center', lineHeight: 1 },
                  _z: zRankForRole('icon'),
                }];
                engine = `emoji:${hit.char}`;
              }
            } catch { /* chain on */ }
          }
          if (!made) {
            try {
              const { vectorizeElement } = await import('./vectorize.mjs');
              const v = await vectorizeElement(pixels, { box: el.box });
              if (v?.ok && v.paths?.length && v.paths.length <= 14) {
                made = v.paths.slice(0, 14).map((p, i) => ({
                  id: uid('vec'), type: 'shape', role: 'icon',
                  name: formatLayerName('shape', { role: 'icon', label: `vector ${i + 1}` }),
                  box: { ...el.box },
                  style: {
                    shapeKind: 'path',
                    path: normalizePathD(p.d, 1 / (v.viewBox.w || 1), 1 / (v.viewBox.h || 1)),
                    background: p.fill || '#111111',
                    ...(p.opacity != null && p.opacity < 1 ? { opacity: p.opacity } : {}),
                  },
                  _z: zRankForRole('icon'),
                }));
                engine = `vectorize:${v.engine} score=${v.score}`;
              }
            } catch { /* chain on */ }
          }
          if (made) {
            elementLayers.push(...made);
            rebuiltElementHoles.push({ ...el.box });
            log(`S4 icon ${engine} box=${JSON.stringify(el.box)}`);
            continue;
          }
          if (!pageIsPhoto) {
            // designed page: the baked pixels won't be under the base — carry them as a crop
            const pb = dilateBoxPx(el.box, 2, 2, canvasW, canvasH);
            elementLayers.push({
              id: uid('pic'), type: 'image', role: 'icon',
              name: formatLayerName('image', { role: 'icon', label: 'crop' }),
              box: pb, src: refSrc,
              style: { crop: { x: pb.x / canvasW, y: pb.y / canvasH, w: pb.w / canvasW, h: pb.h / canvasH }, radius: 0 },
              _z: zRankForRole('icon'),
            });
            log(`S4 icon crop-fallback box=${JSON.stringify(el.box)}`);
          }
          continue;
        }
        // PANELS (badge/pill/band backgrounds) — designed pages only; on a photo base the baked
        // pixels ride along and painting a fitted fill OVER them is what washed 018 out (D7).
        if (!pageIsPhoto && (el.stats?.solidity ?? 0) >= 0.82 && cov <= 0.3) {
          let fit = null;
          try { fit = fitRegionFill(pixels, el.box); } catch { /* */ }
          if (fit && fit.kind !== 'photo') {
            const aspect = el.box.w / Math.max(1, el.box.h);
            const radius = el.box.w >= canvasW * 0.85 ? 0 : (aspect >= 2.5 ? Math.round(el.box.h / 2) : 16);
            elementLayers.push({
              id: uid('pan'), type: 'shape', role: 'decoration',
              name: formatLayerName('shape', { role: 'panel', label: 'shape' }),
              box: { ...el.box }, style: { ...fillToStyle(fit), radius },
              _z: zRankForRole('decoration'),
            });
            log(`S4 panel fill=${fit.kind} box=${JSON.stringify(el.box)}`);
          } else if (cov >= 0.002) {
            // solid-ish but unfittable → crop so the pixels aren't lost on a designed page
            const pb = dilateBoxPx(el.box, 2, 2, canvasW, canvasH);
            elementLayers.push({
              id: uid('pic'), type: 'image', role: 'decoration',
              name: formatLayerName('image', { role: 'decoration', label: 'crop' }),
              box: pb, src: refSrc,
              style: { crop: { x: pb.x / canvasW, y: pb.y / canvasH, w: pb.w / canvasW, h: pb.h / canvasH }, radius: 0 },
              _z: zRankForRole('decoration'),
            });
          }
          continue;
        }
        // small photo-fragments on designed pages (013's floating gummies): carry as crops
        if (!pageIsPhoto && el.kind === 'photo-fragment' && cov >= 0.0012 && cov < seedThresh) {
          const pb = dilateBoxPx(el.box, 3, 3, canvasW, canvasH);
          elementLayers.push({
            id: uid('frag'), type: 'image', role: 'decoration',
            name: formatLayerName('image', { role: 'decoration', label: 'photo fragment' }),
            box: pb, src: refSrc,
            style: { crop: { x: pb.x / canvasW, y: pb.y / canvasH, w: pb.w / canvasW, h: pb.h / canvasH }, radius: 0 },
            _z: zRankForRole('decoration'),
          });
        }
      }
    }
  } catch { /* elements optional */ }

  // Accent strokes beneath a headline (e.g. the green grüns underline) survive as a real image
  // layer after text removal. Only add one when the pixels show an actual saturated stroke.
  try {
    const headline = blocks.find((b) => b.box?.y < canvasH * 0.24 && (b._fontSize || 0) >= 36);
    const ab = headline ? accentStrokeBox(pixels, headline.box) : null;
    if (ab) {
      elementLayers.push({
        id: uid('acc'), type: 'image', role: 'decoration',
        name: formatLayerName('image', { role: 'decoration', label: 'headline accent' }),
        box: ab, src: refSrc,
        style: { crop: { x: ab.x / canvasW, y: ab.y / canvasH, w: ab.w / canvasW, h: ab.h / canvasH }, radius: 0 },
        _z: zRankForRole('decoration'),
      });
      log(`S4 headline accent crop box=${JSON.stringify(ab)}`);
    }
  } catch { /* decoration detection is optional */ }

  // ── S7: drop shadows on text ────────────────────────────────────────────────────────────────
  try {
    for (const t of textLayers) {
      const sh = fitDropShadow(pixels, { box: t.box, alpha: 1 }, pageFlatColor);
      if (sh && sh.found) t.style.shadow = true;
    }
  } catch { /* shadows optional */ }

  // ── S8: font-match (budgeted; per block; needs Chrome; skips cleanly) ───────────────────────
  if (doFonts) {
    try {
      const { matchFontAll } = await import('./font-match.mjs');
      // Every eligible block is matched. The old six-block cap silently left text-heavy ads in
      // fallback Inter. Probe sheets and the on-disk cache keep this bounded without omission.
      const eligible = blocks.filter((b) => (b._fontSize || 0) >= 18 && b._layerIds?.length);
      const blockMatches = [];
      for (const b of eligible) {
        const bb = b.box;
        const cropBuf = await sharp(png).extract({
          left: Math.max(0, Math.round(bb.x)), top: Math.max(0, Math.round(bb.y)),
          width: Math.max(1, Math.min(canvasW - Math.round(bb.x), Math.round(bb.w))),
          height: Math.max(1, Math.min(canvasH - Math.round(bb.y), Math.round(bb.h))),
        }).png().toBuffer();
        const cropPath = join(REFS_DIR, `${refId}-font-${b.id}.png`);
        writeFileSync(cropPath, cropBuf);
        const res = await matchFontAll(cropPath, { text: b.text, weightHint: b._weight, maxTiles: 32 });
        blockMatches.push({ block: b, matches: Array.isArray(res) ? res : [], family: res?.[0]?.family || null });
      }
      reconcileFontFamilies(blockMatches);
      for (const item of blockMatches) {
        if (item.family) for (const id of item.block._layerIds) {
          const t = textLayers.find((x) => x.id === id);
          if (t) {
            t.style.fontFamily = item.family;
            // A family change can be wider than Inter even when its silhouette is the right
            // answer. Preserve the source's one-line OCR geometry by giving the text a small
            // invisible overflow allowance; alignment keeps its visible position unchanged.
            const oldW = t.box.w;
            const wantW = Math.ceil(Math.max(oldW, (t._srcLineBox?.w || oldW) * 1.28));
            if (wantW > oldW) {
              if (t.style.align === 'center') t.box.x -= Math.round((wantW - oldW) / 2);
              else if (t.style.align === 'right') t.box.x -= wantW - oldW;
              t.box.w = wantW;
            }
          }
        }
      }
    } catch { /* font-match is an upgrade, never a gate */ }
  }

  // ── S10: semantics → roles, layer names ─────────────────────────────────────────────────────
  if (doSemantics && (blocks.length || elementLayers.length)) {
    try {
      const semBlocks = blocks.filter((b) => b._layerIds?.length);
      const textFacts = semBlocks.map((b, i) => ({ id: `T${i}`, text: b.text, box: b.box, fontSizePx: b._fontSize }));
      const elFacts = [...cutoutLayers, ...elementLayers].map((e, i) => ({ id: `E${i}`, box: e.box, kind: 'shape' }));
      const facts = buildFactsPayload({ canvas, blocks: textFacts, elements: elFacts }).facts;
      const sem = await labelFacts(png, facts, { ambiguousIds: [] });
      const roleOfText = {};
      (sem.texts || []).forEach((r) => { roleOfText[r.id] = r.role; });
      semBlocks.forEach((b, i) => {
        const role = roleOfText[`T${i}`] || 'other';
        for (const id of b._layerIds) {
          const t = textLayers.find((x) => x.id === id);
          if (!t) continue;
          t.role = role;
          t.name = formatLayerName('text', { role, text: t.text });
        }
      });
    } catch { /* roles default to 'other' */ }
  }

  // ── S9: photo-base hole fills (D1/D4/D7) ────────────────────────────────────────────────────
  // Every overlay text line (ORIGINAL OCR quads, incl. stripped pictographs) and every rebuilt
  // icon/vector element must have its source pixels removed from the photo base. Fill order per
  // hole: ring-fit → renderFill (deterministic, no smear) when the surrounding ring is a fitted
  // flat/linear/radial; else MI-GAN on a padded local crop; else patch. Engine logged per fill.
  let baseSrc = refSrc;
  const rebuiltTextLines = [...overlayText, ...wordmarks];
  if (pageIsPhoto && pixels && (rebuiltTextLines.length || rebuiltElementHoles.length)) {
    try {
      const W = pixels.width, H = pixels.height;
      const basePx = { data: Buffer.from(pixels.data), width: W, height: H };
      // holes: overlay OCR line boxes dilated 18% of HEIGHT + 4px (descenders/underline cover —
      // width-proportional dilation bled onto neighbors and smeared, D4)
      const holes = [];
      for (const l of rebuiltTextLines) {
        const d = l.box.h * 0.18 + 4;
        holes.push({ box: dilateBoxPx(l.box, d, d, W, H), tag: `"${ellipsize(l.text, 24)}"` });
      }
      for (const b of rebuiltElementHoles) {
        holes.push({ box: dilateBoxPx(b, 4, 4, W, H), tag: 'element' });
      }
      const holeMask = new Uint8Array(W * H);
      for (const h of holes) {
        for (let y = h.box.y; y < h.box.y + h.box.h; y++) holeMask.fill(1, y * W + h.box.x, y * W + h.box.x + h.box.w);
      }
      const smallEls = (detected.elements || []).filter((e) => (e.coverage ?? 0) <= 0.02 && (e.stats?.solidity ?? 0) >= 0.5);
      const inCutoutAlpha = (x, y) => {
        for (const c of cutouts) {
          if (!c.alpha) continue;
          const lx = x - c.box.x, ly = y - c.box.y;
          if (lx < 0 || ly < 0 || lx >= c.alpha.width || ly >= c.alpha.height) continue;
          if (c.alpha.data[(ly * c.alpha.width + lx) * 4 + 3] > 100) return true;
        }
        return false;
      };

      const migonHoles = [];
      for (const h of holes) {
        // ring domain: if the hole sits inside a small solid element (a pill/badge), sample
        // ONLY that element's interior; else a pad ring around the hole.
        const host = smallEls.find((e) => insideFrac(h.box, e.box) >= 0.7 && boxArea(e.box) > boxArea(h.box));
        const pad = Math.max(16, Math.round(h.box.h * 0.8));
        const dom = host ? { ...host.box } : dilateBoxPx(h.box, pad, pad, W, H);
        const mask = new Uint8Array(dom.w * dom.h);
        let valid = 0;
        for (let y = 0; y < dom.h; y++) {
          for (let x = 0; x < dom.w; x++) {
            const gx = dom.x + x, gy = dom.y + y;
            if (holeMask[gy * W + gx]) continue;
            if (inCutoutAlpha(gx, gy)) continue;
            mask[y * dom.w + x] = 1; valid++;
          }
        }
        let fit = null;
        if (valid >= 0.15 * dom.w * dom.h && valid > 80) {
          try { fit = fitRegionFill(pixels, { ...dom, mask }); } catch { fit = null; }
        }
        if (fit && fit.kind !== 'photo' && (fit.residual ?? 99) <= 7) {
          const fillPx = renderFill(fit, dom.w, dom.h);
          for (let y = Math.max(h.box.y, dom.y); y < Math.min(h.box.y + h.box.h, dom.y + dom.h); y++) {
            for (let x = Math.max(h.box.x, dom.x); x < Math.min(h.box.x + h.box.w, dom.x + dom.w); x++) {
              const si = ((y - dom.y) * dom.w + (x - dom.x)) * 4, di = (y * W + x) * 4;
              // A fitted gradient can differ by a shade from the original photo. Feather the
              // first few pixels at each edge so a text-hole never reads as a hard rectangle.
              const edge = Math.min(x - h.box.x, h.box.x + h.box.w - 1 - x, y - h.box.y, h.box.y + h.box.h - 1 - y);
              const a = Math.max(0, Math.min(1, (edge + 1) / 6));
              basePx.data[di] = Math.round(basePx.data[di] * (1 - a) + fillPx.data[si] * a);
              basePx.data[di + 1] = Math.round(basePx.data[di + 1] * (1 - a) + fillPx.data[si + 1] * a);
              basePx.data[di + 2] = Math.round(basePx.data[di + 2] * (1 - a) + fillPx.data[si + 2] * a);
            }
          }
          log(`S9 fill ${h.tag} engine=renderFill:${fit.kind} residual=${fit.residual}`);
        } else {
          migonHoles.push(h);
        }
      }
      if (migonHoles.length) {
        const { tryMigan, miganAvailable } = await import('./inpaint.mjs');
        const mask = new Uint8Array(W * H);
        let bbox = null;
        for (const h of migonHoles) {
          for (let y = h.box.y; y < h.box.y + h.box.h; y++) mask.fill(255, y * W + h.box.x, y * W + h.box.x + h.box.w);
          bbox = bbox ? unionBox(bbox, h.box) : { ...h.box };
        }
        let filled = null;
        if (miganAvailable() && bbox && boxArea(bbox) <= 0.35 * W * H) {
          // padded local crop: migan trained at ~512 — local context beats a full-frame pass
          const c = dilateBoxPx(bbox, 96, 96, W, H);
          const sub = { data: Buffer.alloc(c.w * c.h * 4), width: c.w, height: c.h };
          const subMask = new Uint8Array(c.w * c.h);
          for (let y = 0; y < c.h; y++) {
            const src = ((c.y + y) * W + c.x) * 4;
            basePx.data.copy(sub.data, y * c.w * 4, src, src + c.w * 4);
            for (let x = 0; x < c.w; x++) subMask[y * c.w + x] = mask[(c.y + y) * W + (c.x + x)];
          }
          const m = await tryMigan(sub, subMask);
          if (m) {
            for (let y = 0; y < c.h; y++) {
              for (let x = 0; x < c.w; x++) {
                if (mask[(c.y + y) * W + (c.x + x)] < 128) continue;
                const si = (y * c.w + x) * 4, di = ((c.y + y) * W + (c.x + x)) * 4;
                basePx.data[di] = m.data[si]; basePx.data[di + 1] = m.data[si + 1]; basePx.data[di + 2] = m.data[si + 2];
              }
            }
            filled = 'migan(crop)';
          }
        }
        // Never run one full-frame inpaint for scattered text holes. It caused the wide green
        // smear across the product in 016. A local matte may be used above; otherwise the
        // deterministic patch is contained to the affected boxes.
        if (!filled) {
          const { patchFillRects } = await import('./occlusion-fill.mjs');
          const pf = await patchFillRects(basePx, migonHoles.map((h) => h.box));
          if (pf?.data) { basePx.data = Buffer.from(pf.data); filled = 'patch'; }
        }
        for (const h of migonHoles) log(`S9 fill ${h.tag} engine=${filled || 'none'}`);
      }
      const baseId = `${refId}-base`;
      const outPath = join(REFS_DIR, `${baseId}.png`);
      await sharp(basePx.data, { raw: { width: W, height: H, channels: 4 } }).png().toFile(outPath);
      baseSrc = `/refasset?id=${baseId}`;
    } catch (e) {
      log(`S9 FAILED (${e.message}) — raw photo base kept`);
    }
  }

  // ── cutout alpha ERASE (D1): a matte must not carry the baked twin of a rebuilt overlay ─────
  for (const c of cutouts) {
    if (!c.alpha || !c.path) continue;
    try {
      let touched = 0;
      for (const l of rebuiltTextLines) {
        const d = dilateBoxPx(l.box, l.box.h * 0.15 + 3, l.box.h * 0.15 + 3, canvasW, canvasH);
        if (interArea(d, c.box) <= 0) continue;
        const x0 = Math.max(0, Math.floor(d.x - c.box.x)), y0 = Math.max(0, Math.floor(d.y - c.box.y));
        const x1 = Math.min(c.alpha.width, Math.ceil(d.x + d.w - c.box.x));
        const y1 = Math.min(c.alpha.height, Math.ceil(d.y + d.h - c.box.y));
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) { c.alpha.data[(y * c.alpha.width + x) * 4 + 3] = 0; touched++; }
        }
      }
      for (const b of rebuiltElementHoles) {
        const d = dilateBoxPx(b, 3, 3, canvasW, canvasH);
        if (interArea(d, c.box) <= 0) continue;
        const x0 = Math.max(0, Math.floor(d.x - c.box.x)), y0 = Math.max(0, Math.floor(d.y - c.box.y));
        const x1 = Math.min(c.alpha.width, Math.ceil(d.x + d.w - c.box.x));
        const y1 = Math.min(c.alpha.height, Math.ceil(d.y + d.h - c.box.y));
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) { c.alpha.data[(y * c.alpha.width + x) * 4 + 3] = 0; touched++; }
        }
      }
      if (touched) {
        await sharp(c.alpha.data, { raw: { width: c.alpha.width, height: c.alpha.height, channels: 4 } })
          .png().toFile(c.path);
        log(`SUB cutout overlay-erase ${touched}px box=${JSON.stringify(c.box)}`);
      }
    } catch { /* erase is best-effort */ }
  }

  // rect-crop cutouts (matte failed): baked overlay text inside must be occlusion-filled so the
  // crop can't ghost a rebuilt overlay (D1). fillOccludedRegions handles migan→patch itself.
  for (const c of cutouts) {
    if (!c.isRect) continue;
    const occ = rebuiltTextLines
      .map((l) => dilateBoxPx(l.box, l.box.h * 0.15 + 3, l.box.h * 0.15 + 3, canvasW, canvasH))
      .filter((d) => interArea(d, c.box) > 0)
      .map((d) => ({
        x: Math.max(0, (d.x - c.box.x) / c.box.w), y: Math.max(0, (d.y - c.box.y) / c.box.h),
        w: Math.min(1, d.w / c.box.w), h: Math.min(1, d.h / c.box.h),
      }));
    if (!occ.length) continue;
    try {
      const cutId = `${refId}-cut${cutouts.indexOf(c)}-filled`;
      const rawCrop = join(REFS_DIR, `${cutId}-src.png`);
      await sharp(png).extract({
        left: Math.max(0, Math.round(c.box.x)), top: Math.max(0, Math.round(c.box.y)),
        width: Math.min(canvasW - Math.round(c.box.x), Math.round(c.box.w)),
        height: Math.min(canvasH - Math.round(c.box.y), Math.round(c.box.h)),
      }).png().toFile(rawCrop);
      const outPath = join(REFS_DIR, `${cutId}.png`);
      const { fillOccludedRegions } = await import('./occlusion-fill.mjs');
      const r = await fillOccludedRegions(rawCrop, occ, outPath);
      if (r?.ok && existsSync(outPath)) {
        c.layer.src = `/refasset?id=${cutId}`;
        c.layer.style = { radius: 0 };
        log(`SUB rect-crop occlusion fill engine=${r.engine} filled=${r.filled}`);
      }
    } catch { /* keep raw crop */ }
  }

  // ── ASSEMBLE: base → cutouts → element shapes → pictographs → text ──────────────────────────
  const base = pageIsPhoto
    ? { id: uid('base'), type: 'image', role: 'base', name: 'Background (reference photo)', src: baseSrc, box: { x: 0, y: 0, w: canvasW, h: canvasH }, style: { fit: 'cover' }, _z: 0 }
    : { id: uid('base'), type: 'shape', role: 'base', name: 'Base fill', box: { x: 0, y: 0, w: canvasW, h: canvasH }, style: fillToStyle(pageFit || { kind: 'flat', color: '#ffffff' }), _z: 0 };

  const all = [base, ...cutoutLayers, ...elementLayers, ...wordmarkLayers, ...pictoLayers, ...textLayers];
  all.sort((a, b) => (a._z ?? 4) - (b._z ?? 4));
  const layers = all.map(({ _z, _blockId, _srcLineBox, _sourceLine, ...l }) => l);

  const doc = {
    id: `copy_${job.id}`,
    name: `copy ${job.id}`,
    canvas,
    layers,
    skeletonId: null,
    updatedAt: Date.now(),
    keptInPhoto,
  };

  try { job.writeJson('doc.json', doc); job.writeJson('keptInPhoto.json', keptInPhoto); } catch { /* */ }

  return { ok: true, doc, job, keptInPhoto };
}

export default {
  runCopyPipeline, rgbToHex, zRankForRole, formatLayerName, partitionKeptInPhoto,
  measureTextWidthPx, fitFontToWidth, weightFromDensity, splitLeadingPictograph, reconcileFontFamilies,
  dilateBoxPx, normalizePathD,
};
