// scripts/build-emoji-atlas.mjs — build local emoji atlases for lib/emoji-detect.mjs.
//
// Per docs/EMOJI-ICONS-SPEC.md §1. Produces, under .state/emoji-atlas/ (gitignored):
//   apple/<lower-hex>.png     — rendered locally from "Apple Color Emoji.ttc" via headless
//                               Chrome (the corpus is 100% Apple-rendered; this is priority).
//   twemoji/<lower-hex>.png   — jsdelivr (jdecked/twemoji, 72x72), lowercase hex filenames.
//   noto/<lower-hex>.png      — jsdelivr (googlefonts/noto-emoji, png/128, emoji_u<lower>).
//   openmoji/<lower-hex>.png  — jsdelivr (hfg-gmuend/openmoji, 72x72), UPPERCASE hex source.
//   manifest.json             — per codepoint × set: file, 64x64 gray (base64), dHash, aHash.
//
// The Apple set is rendered in ONE headless-Chrome pass (a grid of glyphs) then sliced with
// sharp — 500 individual Chrome launches would be far too slow. Downloads use `curl` (web
// tools are unavailable this session) with bounded concurrency; individual failures are
// tolerated. Re-running is idempotent: existing PNGs are reused, only the manifest is rebuilt.
//
// Casing gotcha (spec §1): Twemoji + Noto use lowercase hex; OpenMoji uses UPPERCASE. The
// canonical key everywhere in the manifest is dash-joined LOWER hex ("231b", "1f64c-1f3fb").
//
// No npm deps beyond sharp. Run:  node scripts/build-emoji-atlas.mjs

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import sharp from 'sharp';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const ATLAS_DIR = join(ROOT, '.state', 'emoji-atlas');
const CELL = 64; // atlas normalization size (spec §2.3)

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
];
function findChrome() {
  for (const p of CHROME_CANDIDATES) if (existsSync(p)) return p;
  for (const cmd of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    try {
      const r = spawnSync('which', [cmd], { timeout: 5000 });
      if (r.status === 0) { const p = String(r.stdout).trim(); if (p) return p; }
    } catch {}
  }
  return null;
}

// ── Curated codepoint list ──────────────────────────────────────────────────────────────
// Ad-common emoji: faces, hands (+ 5 Fitzpatrick skin tones), hearts, symbols, common objects.
// Corpus ground truth (spec §3) is included explicitly: 231b 1f440 1f979 1f62a 1f91d 1f64c(+tones) 1f624.
const SKIN = ['1f3fb', '1f3fc', '1f3fd', '1f3fe', '1f3ff'];
// hand/person bases that commonly appear skin-toned in ads → expand with all 5 modifiers
const TONEABLE = [
  '1f64c', '1f450', '1f44f', '1f44d', '1f44e', '1f44a', '1f91d', '1f64f', '1f4aa',
  '1f44b', '1f918', '1f919', '1f91e', '1f596', '270a', '270b', '270c', '261d',
  '1f446', '1f447', '1f448', '1f449', '1f90c', '1f90f', '1f91f', '1f595', '1f485',
];
const BASE = [
  // faces (smileys)
  '1f600', '1f601', '1f602', '1f923', '1f603', '1f604', '1f605', '1f606', '1f609', '1f60a',
  '1f60b', '1f60e', '1f60d', '1f970', '1f618', '1f617', '1f619', '1f61a', '1f642', '1f643',
  '1f917', '1f929', '1f914', '1f928', '1f610', '1f611', '1f636', '1f60f', '1f612', '1f644',
  '1f62c', '1f925', '1f60c', '1f614', '1f62a', '1f924', '1f634', '1f637', '1f912', '1f915',
  '1f922', '1f92e', '1f927', '1f975', '1f976', '1f974', '1f635', '1f92f', '1f920', '1f973',
  '1f978', '1f60d', '1f929', '1f61b', '1f61c', '1f61d', '1f911', '1f917', '1f92d', '1f92b',
  '1f914', '1f910', '1f928', '1f610', '1f622', '1f62d', '1f626', '1f627', '1f628', '1f630',
  '1f625', '1f624', '1f621', '1f620', '1f92c', '1f608', '1f47f', '1f480', '1f4a9', '1f921',
  '1f479', '1f47b', '1f47d', '1f47e', '1f916', '1f383', '1f631', '1f61e', '1f61f', '1f613',
  '1f616', '1f623', '1f629', '1f62b', '1f971', '1f979', '1f97a', '1f640', '1f63b', '1f649',
  '1f648', '1f64a', '1f4af', '1f440', '1f441',
  // hearts + emotion symbols
  '2764', '1f9e1', '1f49b', '1f49a', '1f499', '1f49c', '1f5a4', '1f90d', '1f90e', '1f494',
  '2763', '1f495', '1f49e', '1f493', '1f497', '1f496', '1f498', '1f49d', '1f49f', '1f48c',
  '1f4a2', '1f4a5', '1f4ab', '1f4a6', '1f4a8', '1f4a4', '1f573', '1f4a3',
  // hands / gestures (base, also toned above)
  '1f91a', '1f590', '1f44c', '1f90c', '1f91b', '1f91c', '1f450', '1f932', '1f64c', '1f450',
  '1f64f', '270d', '1f933', '1f4aa', '1f9be', '1f9b5', '1f9b6',
  // celebration / hype / commerce
  '1f525', '2b50', '1f31f', '2728', '1f4a1', '1f38a', '1f389', '1f388', '1f381', '1f380',
  '1f3c6', '1f947', '1f948', '1f949', '1f451', '1f48e', '1f4b0', '1f4b5', '1f4b8', '1f4b3',
  '1f6d2', '1f381', '1f3af', '1f680', '2601', '1f4c8', '1f4c9', '1f4ca', '1f4b9',
  // check / cross / status symbols
  '2705', '2714', '2611', '274c', '274e', '2716', '2795', '2796', '2797', '2753', '2754',
  '2757', '2755', '203c', '2049', '26a0', '1f6ab', '1f4a2', '1f51e', '1f195', '1f193',
  '1f197', '1f199', '1f6d1', '1f4e2', '1f4e3', '1f514', '1f515',
  // time / hourglass (corpus 009)
  '231b', '23f3', '23f0', '23f1', '23f2', '1f550', '1f55b', '231a', '1f4c5', '1f4c6', '1f5d3',
  // arrows / pointers
  '27a1', '2b05', '2b06', '2b07', '2197', '2198', '2199', '2196', '1f519', '1f51d', '1f53c',
  '1f53d', '25b6', '23e9', '1f504', '1f503',
  // common objects seen in ads
  '1f4f1', '1f4bb', '1f4e7', '1f4ac', '1f4dd', '270f', '1f4cc', '1f4ce', '1f517', '1f512',
  '1f513', '1f511', '1f50d', '1f50e', '1f4a3', '1f9ff', '1f440', '1f9e0', '1f440',
  '1f382', '1f370', '2615', '1f37b', '1f377', '1f942', '1f355', '1f354', '1f35f', '1f32e',
  '1f3e0', '1f697', '2708', '1f6d2', '1f4b2', '1f3c1', '1f6a8', '1f4cd', '1f30d', '1f30e',
  // weather / nature
  '2600', '1f31e', '1f324', '26c5', '2601', '1f327', '26c8', '1f329', '26a1', '2744', '2603',
  '1f308', '1f30a', '1f4a7', '1f33f', '1f340', '1f331', '1f333', '1f338', '1f339', '1f337',
  // symbols / misc
  '267b', '2b55', '274c', '1f4a0', '303d', '2049', '1f4ce', '1f381', '1f4e6', '1f6ce',
];

function buildCodepointList() {
  const set = new Set();
  for (const b of BASE) set.add(b.toLowerCase());
  for (const b of TONEABLE) {
    set.add(b.toLowerCase());
    for (const t of SKIN) set.add(`${b.toLowerCase()}-${t}`);
  }
  return [...set];
}

// dash-joined lower-hex codepoint → JS string (the actual emoji char[s])
function cpToChar(cp) {
  try { return cp.split('-').map((h) => String.fromCodePoint(parseInt(h, 16))).join(''); }
  catch { return ''; }
}

const RGB = 32; // color thumbnail edge for color-NCC fine ranking

// Normalize an atlas glyph PNG (has real alpha): trim to the alpha bbox so scale/position match
// the candidate normalization in emoji-detect, flatten onto WHITE, then emit both a CELL×CELL
// gray (for hashing) and an RGB×RGB color thumbnail (for color-NCC). Returns {gray, rgb}.
async function normalizeGlyph(buf) {
  // trim transparent border to the glyph's tight bbox
  let base = sharp(buf).ensureAlpha();
  try { base = sharp(await base.trim({ threshold: 8 }).toBuffer()); } catch { base = sharp(buf).ensureAlpha(); }
  const onWhite = await base.flatten({ background: '#ffffff' }).png().toBuffer();
  const gray = Uint8Array.from(
    (await sharp(onWhite).resize(CELL, CELL, { fit: 'fill' }).grayscale().raw().toBuffer()).subarray(0, CELL * CELL),
  );
  const rgb = Uint8Array.from(
    await sharp(onWhite).resize(RGB, RGB, { fit: 'fill' }).removeAlpha().raw().toBuffer(),
  );
  return { gray, rgb };
}
function aHash(gray) {
  // downsample CELL→8x8 by block-averaging, threshold at mean
  const s = 8, block = CELL / s, small = new Float64Array(64);
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
    let sum = 0;
    for (let by = 0; by < block; by++) for (let bx = 0; bx < block; bx++)
      sum += gray[(y * block + by) * CELL + (x * block + bx)];
    small[y * s + x] = sum / (block * block);
  }
  let mean = 0; for (const v of small) mean += v; mean /= 64;
  let bits = 0n; for (let i = 0; i < 64; i++) if (small[i] >= mean) bits |= (1n << BigInt(i));
  return bits.toString(16).padStart(16, '0');
}
function dHash(gray) {
  // 9x8 block-average, compare adjacent columns
  const w = 9, h = 8, bw = CELL / w, bh = CELL / h, small = new Float64Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let sum = 0, n = 0;
    const x0 = Math.floor(x * bw), x1 = Math.floor((x + 1) * bw);
    const y0 = Math.floor(y * bh), y1 = Math.floor((y + 1) * bh);
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { sum += gray[yy * CELL + xx]; n++; }
    small[y * w + x] = n ? sum / n : 0;
  }
  let bits = 0n, i = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w - 1; x++) {
    if (small[y * w + x] < small[y * w + x + 1]) bits |= (1n << BigInt(i));
    i++;
  }
  return bits.toString(16).padStart(16, '0');
}

// ── Apple atlas: render a grid of glyphs in one Chrome pass, slice with sharp ──
function renderAppleGrid(chromePath, chars, outPng, cols) {
  const rows = Math.ceil(chars.length / cols);
  const W = cols * CELL, H = rows * CELL;
  const cells = chars.map((c, i) => {
    const x = (i % cols) * CELL, y = Math.floor(i / cols) * CELL;
    // HTML-escape as numeric refs so the source is ASCII-safe
    const ref = [...c].map((ch) => `&#x${ch.codePointAt(0).toString(16)};`).join('');
    return `<div class="c" style="left:${x}px;top:${y}px">${ref}</div>`;
  }).join('');
  const html = `<!doctype html><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;background:transparent}
    .c{position:absolute;width:${CELL}px;height:${CELL}px;font-family:"Apple Color Emoji";
       font-size:52px;line-height:${CELL}px;text-align:center;overflow:hidden}
  </style><body>${cells}</body>`;
  const htmlPath = join(ATLAS_DIR, '_apple-grid.html');
  writeFileSync(htmlPath, html);
  rmSync(outPng, { force: true });
  const args = [
    '--headless', '--disable-gpu', `--screenshot=${outPng}`,
    `--window-size=${W},${H}`, '--force-device-scale-factor=1', '--hide-scrollbars',
    '--default-background-color=00000000', '--no-sandbox', `file://${htmlPath}`,
  ];
  const r = spawnSync(chromePath, args, { timeout: 120000 });
  if (r.status !== 0 || !existsSync(outPng)) {
    console.error(`[atlas] apple grid render failed (status=${r.status}${r.error ? ', ' + r.error.message : ''})`);
    return false;
  }
  return true;
}

async function buildAppleSet(chromePath, codepoints) {
  const dir = join(ATLAS_DIR, 'apple');
  mkdirSync(dir, { recursive: true });
  const chars = codepoints.map(cpToChar);
  const cols = 20;
  const gridPng = join(ATLAS_DIR, '_apple-grid.png');
  if (!renderAppleGrid(chromePath, chars, gridPng, cols)) return new Set();
  const built = new Set();
  const gridBuf = readFileSync(gridPng);
  for (let i = 0; i < codepoints.length; i++) {
    const cp = codepoints[i];
    const x = (i % cols) * CELL, y = Math.floor(i / cols) * CELL;
    const out = join(dir, `${cp}.png`);
    try {
      const cell = await sharp(gridBuf).extract({ left: x, top: y, width: CELL, height: CELL }).png().toBuffer();
      // reject blank cells (font substitution failed → transparent/near-empty)
      const st = await sharp(cell).stats();
      const alpha = st.channels[st.channels.length - 1];
      const nonEmpty = st.channels[0].max > 0 && (alpha ? alpha.mean > 2 : true);
      if (!nonEmpty) continue;
      writeFileSync(out, cell);
      built.add(cp);
    } catch (e) { /* tolerate */ }
  }
  rmSync(gridPng, { force: true });
  rmSync(join(ATLAS_DIR, '_apple-grid.html'), { force: true });
  return built;
}

// ── Download sets via curl with bounded concurrency ──
function curlOne(url, out) {
  const r = spawnSync('curl', ['-sfL', '--max-time', '25', url, '-o', out], { timeout: 30000 });
  if (r.status === 0 && existsSync(out)) {
    try { if (readFileSync(out).length > 100) return true; } catch {}
  }
  rmSync(out, { force: true });
  return false;
}
function urlFor(set, cp) {
  const lower = cp; // canonical is lower already
  const upper = cp.toUpperCase();
  switch (set) {
    case 'twemoji': return `https://cdn.jsdelivr.net/gh/jdecked/twemoji@latest/assets/72x72/${lower}.png`;
    case 'noto':    return `https://cdn.jsdelivr.net/gh/googlefonts/noto-emoji@main/png/128/emoji_u${lower.replace(/-/g, '_')}.png`;
    case 'openmoji':return `https://cdn.jsdelivr.net/gh/hfg-gmuend/openmoji@latest/color/72x72/${upper}.png`;
    default: return null;
  }
}
async function buildDownloadSet(set, codepoints, concurrency = 12) {
  const dir = join(ATLAS_DIR, set);
  mkdirSync(dir, { recursive: true });
  const built = new Set();
  let idx = 0;
  async function worker() {
    while (idx < codepoints.length) {
      const cp = codepoints[idx++];
      const out = join(dir, `${cp}.png`);
      if (existsSync(out) && readFileSync(out).length > 100) { built.add(cp); continue; }
      const url = urlFor(set, cp);
      if (url && curlOne(url, out)) built.add(cp);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return built;
}

async function main() {
  mkdirSync(ATLAS_DIR, { recursive: true });
  const codepoints = buildCodepointList();
  console.error(`[atlas] target codepoints: ${codepoints.length}`);

  const chromePath = findChrome();
  const results = {}; // set → Set(cp)

  if (chromePath) {
    console.error(`[atlas] rendering Apple set via ${chromePath} ...`);
    results.apple = await buildAppleSet(chromePath, codepoints);
    console.error(`[atlas] apple: ${results.apple.size}/${codepoints.length}`);
  } else {
    console.error('[atlas] no Chrome found — SKIPPING Apple set (Twemoji path still builds)');
    results.apple = new Set();
  }

  for (const set of ['twemoji', 'noto', 'openmoji']) {
    console.error(`[atlas] downloading ${set} set ...`);
    results[set] = await buildDownloadSet(set, codepoints);
    console.error(`[atlas] ${set}: ${results[set].size}/${codepoints.length}`);
  }

  // ── Build manifest: per codepoint, per available set → gray(base64) + hashes ──
  console.error('[atlas] hashing + assembling manifest ...');
  const entries = {};
  const setCounts = { apple: 0, twemoji: 0, noto: 0, openmoji: 0 };
  for (const cp of codepoints) {
    const entry = { char: cpToChar(cp) };
    let any = false;
    for (const set of ['apple', 'twemoji', 'noto', 'openmoji']) {
      if (!results[set].has(cp)) continue;
      const file = join(ATLAS_DIR, set, `${cp}.png`);
      if (!existsSync(file)) continue;
      try {
        const { gray, rgb } = await normalizeGlyph(readFileSync(file));
        entry[set] = {
          file: `${set}/${cp}.png`,
          gray: Buffer.from(gray).toString('base64'),
          rgb: Buffer.from(rgb).toString('base64'),
          dhash: dHash(gray),
          ahash: aHash(gray),
        };
        setCounts[set]++;
        any = true;
      } catch (e) { /* tolerate */ }
    }
    if (any) entries[cp] = entry;
  }

  const manifest = {
    version: 1,
    cell: CELL,
    builtAt: new Date().toISOString(),
    setCounts,
    codepointCount: Object.keys(entries).length,
    entries,
  };
  writeFileSync(join(ATLAS_DIR, 'manifest.json'), JSON.stringify(manifest));

  console.error('\n[atlas] ── coverage summary ──');
  console.error(`  target codepoints : ${codepoints.length}`);
  console.error(`  entries in manifest: ${manifest.codepointCount}`);
  for (const set of ['apple', 'twemoji', 'noto', 'openmoji'])
    console.error(`  ${set.padEnd(9)}: ${setCounts[set]}`);
  console.error(`  manifest: ${join(ATLAS_DIR, 'manifest.json')}`);
}

main().catch((e) => { console.error('[atlas] FATAL', e); process.exit(1); });
