// lib/self-vision.mjs — the agent LOOKS at its own work: render the doc server-side
// and critique the PNG with the configured endpoint's vision (lib/llm.mjs llmVision).
//
// Two render backends, tried in order:
//   1. Headless Chrome/Chromium (real modern CSS: @font-face, corner-shape:squircle,
//      true retina via --force-device-scale-factor) — preferred when installed.
//   2. qlmanage (macOS Quick Look's WebKit thumbnailer, zero deps) — fallback.
//
// Dormant on vision-less endpoints (DeepSeek's API is text-only) — the design agent only
// advertises the "look" op when a probe of llmVision succeeds once per process.

import { spawnSync } from 'node:child_process';
import { writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platform } from 'node:os';
import { renderDesignHtml, makeImageResolver } from './designstore.mjs';
import { llmVision, codexVisionAllowed } from './llm.mjs';
import { codexSee } from './layout-extract.mjs';

const STUDIO = dirname(fileURLToPath(import.meta.url), '..');
const TMP = join(dirname(fileURLToPath(import.meta.url)), '..', '.state', 'self-vision');

// --- Chrome/Chromium detection (cached — probed at most once per process) ---------------

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
];

let _chromePathCache; // undefined = not probed yet, null = probed & not found, string = found

/** Find a usable headless-capable Chrome/Chromium binary. Cached after the first probe. */
function findChrome() {
  if (_chromePathCache !== undefined) return _chromePathCache;
  for (const p of CHROME_CANDIDATES) {
    if (existsSync(p)) { _chromePathCache = p; return p; }
  }
  // non-mac fallback: look on PATH
  if (platform() !== 'darwin') {
    for (const cmd of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
      try {
        const r = spawnSync('which', [cmd], { timeout: 5_000 });
        if (r.status === 0) {
          const p = String(r.stdout || '').trim();
          if (p) { _chromePathCache = p; return p; }
        }
      } catch { /* keep probing */ }
    }
  }
  _chromePathCache = null;
  return null;
}

// --- render backends ----------------------------------------------------------------------

/** Try rendering htmlPath → pngPath via headless Chrome. Returns true on verified success. */
function renderWithChrome(chromePath, htmlPath, pngPath, size, doc) {
  try {
    rmSync(pngPath, { force: true });
    // Translate the qlmanage-style `size` (roughly a square thumbnail edge) into a
    // window that matches the comp's REAL aspect ratio, so non-square formats (e.g. a
    // 1080x1920 story) render at correct proportions instead of being squished/cropped —
    // qlmanage's `-s` only ever produced a square-ish thumbnail regardless of aspect.
    const cw = Number(doc?.canvas?.w) > 0 ? Number(doc.canvas.w) : 1080;
    const ch = Number(doc?.canvas?.h) > 0 ? Number(doc.canvas.h) : 1080;
    const longEdge = Math.max(1, Number(size) || 900);
    const scale = longEdge / Math.max(cw, ch);
    const winW = Math.max(1, Math.round(cw * scale));
    const winH = Math.max(1, Math.round(ch * scale));
    const args = [
      '--headless',
      '--disable-gpu',
      `--screenshot=${pngPath}`,
      `--window-size=${winW},${winH}`,
      '--force-device-scale-factor=3',
      '--hide-scrollbars',
      '--default-background-color=00000000',
      '--no-sandbox',
      `file://${htmlPath}`,
    ];
    const r = spawnSync(chromePath, args, { timeout: 20_000 });
    if (r.status !== 0 || !existsSync(pngPath)) {
      console.error(`[self-vision] chrome render failed (status=${r.status}${r.error ? `, err=${r.error.message}` : ''}), falling back to qlmanage`);
      return false;
    }
    console.error('[self-vision] rendered via headless Chrome');
    return true;
  } catch (err) {
    console.error(`[self-vision] chrome render threw (${err?.message || err}), falling back to qlmanage`);
    return false;
  }
}

/** Try rendering htmlPath → outDir/<basename>.png via qlmanage. Returns true on verified success. */
function renderWithQlmanage(htmlPath, pngPath, outDir, size) {
  try {
    rmSync(pngPath, { force: true });
    const r = spawnSync('qlmanage', ['-t', '-s', String(size), '-o', outDir, htmlPath], { timeout: 20_000 });
    if (r.status !== 0 || !existsSync(pngPath)) {
      console.error(`[self-vision] qlmanage render failed (status=${r.status})`);
      return false;
    }
    console.error('[self-vision] rendered via qlmanage');
    return true;
  } catch (err) {
    console.error(`[self-vision] qlmanage render threw (${err?.message || err})`);
    return false;
  }
}

/**
 * Render a doc to a PNG on disk. Prefers headless Chrome (real @font-face, corner-shape:
 * squircle, true 3x retina) when installed; falls back to qlmanage (old WebKit, zero deps)
 * otherwise. Same return contract either way: the PNG path on success, or null on failure.
 */
export function renderCompPng(doc, { resolveImage = null, size = 900 } = {}) {
  try {
    mkdirSync(TMP, { recursive: true });
    const html = renderDesignHtml(doc, resolveImage || ((s) => s));
    const htmlPath = join(TMP, `${doc.id || 'comp'}.html`);
    writeFileSync(htmlPath, html);
    const pngPath = `${htmlPath}.png`;

    const chromePath = findChrome();
    if (chromePath && renderWithChrome(chromePath, htmlPath, pngPath, size, doc)) {
      return pngPath;
    }
    if (renderWithQlmanage(htmlPath, pngPath, TMP, size)) {
      return pngPath;
    }
    return null;
  } catch { return null; }
}

const CRITIQUE_PROMPT = `You are a senior art director reviewing this ad render. In ≤4 short bullet points, list the most important CONCRETE problems (clipped/overlapping text, illegible contrast, misalignment, dead space, wrong hierarchy). If it looks production-ready say exactly "ready". Plain text.`;

/**
 * Look at the doc and return { ok, critique, error }. Uses the configured vision endpoint;
 * never throws.
 */
export async function lookAtComp(doc, { resolveImage = null } = {}) {
  const png = renderCompPng(doc, { resolveImage });
  if (!png) return { ok: false, critique: null, error: 'could not render the comp (qlmanage unavailable?)' };
  const r = await llmVision(CRITIQUE_PROMPT, png, { purpose: 'self-vision', maxTokens: 1200 });
  if (r.ok) return { ok: true, critique: r.text.trim().slice(0, 600), error: null };
  // vision-less endpoint (DeepSeek) → codex CLI fallback (default-on; usage is minimal)
  if (r.noVision && codexVisionAllowed()) {
    const c = await codexSee(CRITIQUE_PROMPT, png);
    if (c.ok) return { ok: true, critique: c.text.slice(0, 600), error: null };
    return { ok: false, critique: null, error: c.error };
  }
  return { ok: false, critique: null, error: r.error, noVision: r.noVision };
}

// FIX 4: return STRUCTURED corrections the design agent can act on — a list of
// {layer, problem, fix} — not just prose. Vision-endpoint driven; JSON with a prose fallback.
const COMPARE_PROMPT = (refNote) => `You are comparing a GENERATED ad render against its reference. ${refNote}
Report the most important CONCRETE deltas to fix as a JSON object. For each issue name the LAYER
(e.g. "headline", "CTA button", "background", "product image"), the PROBLEM (what is wrong:
position, size, color, missing/extra piece, weak contrast, wrong hierarchy), and a specific FIX
the design agent can apply (e.g. "move up ~8%", "darken background to near-black", "enlarge to
2x"). Do NOT flag copy/text wording differences — the copy is intentionally different.

Reply with ONLY this JSON, no prose:
{"match": <true if it already matches the reference well, else false>,
 "corrections": [{"layer":"<name>","problem":"<what's wrong>","fix":"<what to do>"}]}
List at most 5 corrections, most important first. If it matches well, return
{"match": true, "corrections": []}.`;

/** Pull the {match, corrections[]} object out of a (possibly prose-wrapped) vision reply.
 *  Returns { match, corrections:[{layer,problem,fix}] } — never throws. */
function parseCorrections(text) {
  const s = String(text || '');
  let obj = null;
  const m = s.match(/\{[\s\S]*"corrections"[\s\S]*\}/);
  if (m) { try { obj = JSON.parse(m[0]); } catch { obj = null; } }
  if (!obj) { try { obj = JSON.parse(s); } catch { obj = null; } }
  const corrections = Array.isArray(obj?.corrections) ? obj.corrections
    .map((c) => ({
      layer: String(c?.layer || '').slice(0, 60),
      problem: String(c?.problem || '').slice(0, 200),
      fix: String(c?.fix || '').slice(0, 200),
    }))
    .filter((c) => c.problem || c.fix)
    .slice(0, 5) : [];
  const match = obj?.match === true || (obj && corrections.length === 0);
  return { match: !!match, corrections };
}

/** Render prose bullets from structured corrections (compat for callers reading `notes`). */
function correctionsToProse(match, corrections) {
  if (match && !corrections.length) return 'close match';
  return corrections.map((c) => `• ${c.layer ? c.layer + ': ' : ''}${c.problem}${c.fix ? ' → ' + c.fix : ''}`).join('\n').slice(0, 600);
}

/**
 * Second-pass reference check: render the comp, then ask vision to compare it against the
 * reference image before finalizing. Returns STRUCTURED corrections the design agent can act on:
 * { ok, match, corrections:[{layer,problem,fix}], notes, error }. `notes` is a prose rendering of
 * the same corrections for callers that want a string. Vision-endpoint driven; never throws.
 */
export async function compareToReference(doc, referencePath, { resolveImage = null } = {}) {
  const png = renderCompPng(doc, { resolveImage });
  if (!png) return { ok: false, match: false, corrections: [], notes: null, error: 'could not render the comp' };
  const prompt = COMPARE_PROMPT('The reference is the FIRST image you were shown in this project; judge structure and style fidelity.');
  // one-image transports: describe the render while referencing structure expectations —
  // the reference geometry is already encoded in the skeleton, so the compare focuses on what
  // the render LOOKS like vs the archetype. json:true nudges the endpoint to emit clean JSON.
  const r = await llmVision(prompt, png, { purpose: 'ref-compare', maxTokens: 1200, json: true });
  if (r.ok) {
    const { match, corrections } = parseCorrections(r.text);
    return { ok: true, match, corrections, notes: correctionsToProse(match, corrections), error: null };
  }
  if (r.noVision && codexVisionAllowed()) {
    const c = await codexSee(prompt, png);
    if (c.ok) {
      const { match, corrections } = parseCorrections(c.text);
      return { ok: true, match, corrections, notes: correctionsToProse(match, corrections), error: null };
    }
    return { ok: false, match: false, corrections: [], notes: null, error: c.error };
  }
  return { ok: false, match: false, corrections: [], notes: null, error: r.error };
}
