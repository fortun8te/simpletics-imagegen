#!/usr/bin/env node
// scripts/fetch-fonts.mjs — one-time downloader for the ad-common Google Fonts pack (S8).
//
// ROLE: fetch ~60 curated families (TTF statics, latin subset) into
//   studio/.state/fonts-pack/<Family>/<Family>-<weight>.ttf   (gitignored — fonts NEVER in repo)
// and (re)write the committed manifest lib/fonts-manifest.json that lib/font-match.mjs and
// lib/font-faces.mjs consume. The manifest also carries entries for the 3 repo-bundled woff2
// families and a small curated set of macOS system fonts Figma also resolves.
//
// INVARIANTS:
// - Idempotent: existing non-empty files are skipped; re-runs only fill gaps.
// - Tolerant: a family that fails to download is reported and omitted from `files` — the run
//   never aborts on individual failures.
// - The manifest is ALWAYS rewritten at the end from what is actually on disk, so it can never
//   name a file that does not exist.
//
// SOURCES (in order):
//   1. google-webfonts-helper JSON API: https://gwfh.mranftl.com/api/fonts/<id>?subsets=latin
//      (returns direct fonts.gstatic.com TTF urls per variant)
//   2. fallback: legacy Google CSS API (no fancy UA → TTF urls) https://fonts.googleapis.com/css?family=...
//
// WHO CALLS: humans / CI, once per machine (`node scripts/fetch-fonts.mjs`). Contract: S8 in
// docs/COPY-ENGINE-V2-CONTRACTS.md.

import { existsSync, mkdirSync, statSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const STUDIO = join(dirname(fileURLToPath(import.meta.url)), '..');
const PACK_DIR = join(STUDIO, '.state', 'fonts-pack');
const MANIFEST_PATH = join(STUDIO, 'lib', 'fonts-manifest.json');

// Weights we want when available. gwfh variant ids: 'regular' = 400, '500', '700', ...
const WANTED_WEIGHTS = [400, 500, 600, 700, 800, 900];

/** Curated pack: visual `cls` drives the matcher's two-phase search (lib/font-match.mjs).
 *  Classes: grotesk | geometric | humanist | condensed | heavy-display | serif-display |
 *  serif-body | mono | script. All families resolve natively in Figma (Google Fonts). */
export const PACK_FAMILIES = [
  { family: 'Inter', cls: 'grotesk' },
  { family: 'Roboto', cls: 'grotesk' },
  { family: 'Archivo', cls: 'grotesk' },
  { family: 'Barlow', cls: 'grotesk' },
  { family: 'Libre Franklin', cls: 'grotesk' },
  { family: 'IBM Plex Sans', cls: 'grotesk' },
  { family: 'Work Sans', cls: 'grotesk' },
  { family: 'Space Grotesk', cls: 'grotesk' },
  { family: 'Manrope', cls: 'grotesk' },
  { family: 'Figtree', cls: 'grotesk' },
  { family: 'Karla', cls: 'grotesk' },
  { family: 'Montserrat', cls: 'geometric' },
  { family: 'Poppins', cls: 'geometric' },
  { family: 'DM Sans', cls: 'geometric' },
  { family: 'Plus Jakarta Sans', cls: 'geometric' },
  { family: 'Sora', cls: 'geometric' },
  { family: 'Outfit', cls: 'geometric' },
  { family: 'Lexend', cls: 'geometric' },
  { family: 'Jost', cls: 'geometric' },
  { family: 'League Spartan', cls: 'geometric' },
  { family: 'Raleway', cls: 'geometric' },
  { family: 'Rubik', cls: 'geometric' },
  { family: 'Nunito', cls: 'geometric' },
  { family: 'Open Sans', cls: 'humanist' },
  { family: 'Lato', cls: 'humanist' },
  { family: 'Nunito Sans', cls: 'humanist' },
  { family: 'Mulish', cls: 'humanist' },
  { family: 'Source Sans 3', cls: 'humanist' },
  { family: 'PT Sans', cls: 'humanist' },
  { family: 'Oswald', cls: 'condensed' },
  { family: 'Bebas Neue', cls: 'condensed' },
  { family: 'Anton', cls: 'condensed' },
  { family: 'Barlow Condensed', cls: 'condensed' },
  { family: 'Roboto Condensed', cls: 'condensed' },
  { family: 'Archivo Black', cls: 'heavy-display' },
  { family: 'Alfa Slab One', cls: 'heavy-display' },
  { family: 'Passion One', cls: 'heavy-display' },
  { family: 'Titan One', cls: 'heavy-display' },
  { family: 'Luckiest Guy', cls: 'heavy-display' },
  { family: 'Bangers', cls: 'heavy-display' },
  { family: 'Righteous', cls: 'heavy-display' },
  { family: 'Abril Fatface', cls: 'serif-display' },
  { family: 'Playfair Display', cls: 'serif-display' },
  { family: 'Fraunces', cls: 'serif-display' },
  { family: 'DM Serif Display', cls: 'serif-display' },
  { family: 'Cormorant Garamond', cls: 'serif-display' },
  { family: 'Lora', cls: 'serif-body' },
  { family: 'Merriweather', cls: 'serif-body' },
  { family: 'Libre Baskerville', cls: 'serif-body' },
  { family: 'EB Garamond', cls: 'serif-body' },
  { family: 'Crimson Text', cls: 'serif-body' },
  { family: 'Bitter', cls: 'serif-body' },
  { family: 'Domine', cls: 'serif-body' },
  { family: 'Space Mono', cls: 'mono' },
  { family: 'IBM Plex Mono', cls: 'mono' },
  { family: 'JetBrains Mono', cls: 'mono' },
  { family: 'Caveat', cls: 'script' },
  { family: 'Pacifico', cls: 'script' },
  { family: 'Dancing Script', cls: 'script' },
  { family: 'Permanent Marker', cls: 'script' },
];

/** Families bundled as woff2 in src/assets/fonts (lib/font-faces.mjs) — flagged so consumers
 *  know an embedded fallback exists even without the pack. */
const BUNDLED = new Set(['Inter', 'Fraunces', 'Poppins']);

/** macOS system fonts that Figma ALSO has (via its desktop-app local-font access) — no files,
 *  matched via the system name in the headless-Chrome probe. figma:false where we're unsure the
 *  web-only Figma editor resolves them. */
const SYSTEM_FAMILIES = [
  { family: 'Helvetica Neue', cls: 'grotesk', category: 'sans-serif', weights: [400, 500, 700], figma: true },
  { family: 'Georgia', cls: 'serif-body', category: 'serif', weights: [400, 700], figma: true },
  { family: 'Futura', cls: 'geometric', category: 'sans-serif', weights: [400, 700], figma: false },
  { family: 'Avenir Next', cls: 'geometric', category: 'sans-serif', weights: [400, 500, 600, 700], figma: false },
  { family: 'Impact', cls: 'condensed', category: 'display', weights: [400], figma: true },
];

const gwfhId = (family) => family.toLowerCase().replace(/ /g, '-');
const safeName = (family) => family.replace(/[^A-Za-z0-9 _-]/g, '').replace(/ /g, '');

async function fetchWithTimeout(url, ms = 30_000, headers = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { signal: ctl.signal, headers });
  } finally {
    clearTimeout(t);
  }
}

/** gwfh: family id → [{ weight, url }] for wanted normal-style TTF variants. */
async function listVariantsGwfh(family) {
  const res = await fetchWithTimeout(`https://gwfh.mranftl.com/api/fonts/${gwfhId(family)}?subsets=latin`);
  if (!res.ok) throw new Error(`gwfh ${res.status}`);
  const json = await res.json();
  const out = [];
  for (const v of json.variants || []) {
    if (v.fontStyle !== 'normal' || !v.ttf) continue;
    const weight = v.id === 'regular' ? 400 : parseInt(v.id, 10);
    if (WANTED_WEIGHTS.includes(weight)) out.push({ weight, url: v.ttf });
  }
  return { variants: out, category: json.category || null };
}

/** Fallback: legacy Google CSS API. A no-UA request returns TTF `src: url(...)` rules. */
async function listVariantsCss(family) {
  const fam = encodeURIComponent(family);
  const weightsQ = WANTED_WEIGHTS.join(',');
  const res = await fetchWithTimeout(
    `https://fonts.googleapis.com/css?family=${fam}:${weightsQ}`,
    30_000,
    { 'User-Agent': 'curl/8' }, // ancient UA → truetype urls, no unicode-range splitting
  );
  if (!res.ok) throw new Error(`css api ${res.status}`);
  const css = await res.text();
  const out = [];
  const re = /font-weight:\s*(\d+);[^}]*?url\((https:[^)]+\.ttf)\)/gs;
  let m;
  while ((m = re.exec(css))) {
    const weight = parseInt(m[1], 10);
    if (WANTED_WEIGHTS.includes(weight) && !out.some((v) => v.weight === weight)) {
      out.push({ weight, url: m[2] });
    }
  }
  return { variants: out, category: null };
}

async function downloadTo(url, path) {
  const res = await fetchWithTimeout(url, 60_000);
  if (!res.ok) throw new Error(`download ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1024) throw new Error(`suspiciously small file (${buf.length}B)`);
  writeFileSync(path, buf);
}

async function fetchFamily(entry, stats) {
  const dir = join(PACK_DIR, safeName(entry.family));
  mkdirSync(dir, { recursive: true });

  // idempotency fast-path: if some weights already exist we still list variants (to fill gaps),
  // but existing files are never re-downloaded.
  let listing;
  try {
    listing = await listVariantsGwfh(entry.family);
  } catch (e1) {
    try {
      listing = await listVariantsCss(entry.family);
      stats.fellBack.push(`${entry.family} (gwfh: ${e1.message})`);
    } catch (e2) {
      stats.failed.push(`${entry.family}: gwfh=${e1.message} css=${e2.message}`);
      return null;
    }
  }

  const files = {};
  let downloaded = 0, skipped = 0;
  for (const { weight, url } of listing.variants) {
    const rel = `${safeName(entry.family)}/${safeName(entry.family)}-${weight}.ttf`;
    const abs = join(PACK_DIR, rel);
    try {
      if (existsSync(abs) && statSync(abs).size > 1024) { skipped++; files[String(weight)] = rel; continue; }
      await downloadTo(url, abs);
      downloaded++;
      files[String(weight)] = rel;
    } catch (e) {
      stats.failed.push(`${entry.family} ${weight}: ${e.message}`);
    }
  }
  if (!Object.keys(files).length) {
    stats.failed.push(`${entry.family}: no weights obtained`);
    return null;
  }
  stats.downloaded += downloaded;
  stats.skipped += skipped;
  return { category: listing.category, files };
}

/** Build the manifest strictly from what exists on disk + curated system entries. */
export function buildManifest() {
  const entries = [];
  for (const entry of PACK_FAMILIES) {
    const dir = join(PACK_DIR, safeName(entry.family));
    const files = {};
    if (existsSync(dir)) {
      for (const f of readdirSync(dir)) {
        const m = f.match(/-(\d{3})\.ttf$/);
        if (m && statSync(join(dir, f)).size > 1024) files[m[1]] = `${safeName(entry.family)}/${f}`;
      }
    }
    const weights = Object.keys(files).map(Number).sort((a, b) => a - b);
    if (!weights.length && !BUNDLED.has(entry.family)) continue; // nothing usable — leave out
    entries.push({
      family: entry.family,
      category: entry.category || guessCategory(entry.cls),
      cls: entry.cls,
      weights,
      files,
      source: 'google-pack',
      ...(BUNDLED.has(entry.family) ? { bundled: true } : {}),
      figma: true,
    });
  }
  for (const sys of SYSTEM_FAMILIES) {
    entries.push({
      family: sys.family, category: sys.category, cls: sys.cls,
      weights: sys.weights, files: {}, source: 'system', figma: sys.figma,
    });
  }
  return entries;
}

function guessCategory(cls) {
  if (cls === 'serif-display' || cls === 'serif-body') return 'serif';
  if (cls === 'mono') return 'monospace';
  if (cls === 'script') return 'handwriting';
  if (cls === 'heavy-display') return 'display';
  return 'sans-serif';
}

async function main() {
  mkdirSync(PACK_DIR, { recursive: true });
  const stats = { downloaded: 0, skipped: 0, failed: [], fellBack: [] };
  const categories = new Map();

  // limited concurrency — polite to gwfh, still fast
  const queue = [...PACK_FAMILIES];
  const workers = Array.from({ length: 6 }, async () => {
    while (queue.length) {
      const entry = queue.shift();
      const r = await fetchFamily(entry, stats);
      if (r?.category) categories.set(entry.family, r.category);
      process.stdout.write(`  ${r ? 'ok  ' : 'FAIL'} ${entry.family}\n`);
    }
  });
  await Promise.all(workers);

  const manifest = buildManifest();
  for (const e of manifest) if (categories.has(e.family)) e.category = categories.get(e.family);
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);

  const packOk = manifest.filter((e) => e.source === 'google-pack' && e.weights.length).length;
  console.log('\n=== fetch-fonts summary ===');
  console.log(`families requested : ${PACK_FAMILIES.length}`);
  console.log(`families on disk   : ${packOk}`);
  console.log(`files downloaded   : ${stats.downloaded}`);
  console.log(`files skipped      : ${stats.skipped} (already present)`);
  if (stats.fellBack.length) console.log(`css-api fallbacks  : ${stats.fellBack.length}\n  ${stats.fellBack.join('\n  ')}`);
  if (stats.failed.length) console.log(`failures           : ${stats.failed.length}\n  ${stats.failed.join('\n  ')}`);
  console.log(`manifest           : ${MANIFEST_PATH} (${manifest.length} entries incl. ${SYSTEM_FAMILIES.length} system)`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
