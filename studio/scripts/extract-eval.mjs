#!/usr/bin/env node
// scripts/extract-eval.mjs — HONESTY BACKBONE for the copy-from-reference pipeline.
//
// Runs extractLayout() against a fixed set of diverse REAL references and reports, per reference:
//   parse success · layer count vs a hand-set expectation · archetype detected · wall time ·
//   background (photo/solid/gradient) · cutout candidates found · self-check corrections.
// Prints a compact table + a JSON blob so a BEFORE run and an AFTER run can be diffed honestly.
//
//   node scripts/extract-eval.mjs                      # run the whole set
//   node scripts/extract-eval.mjs --selfcheck          # also run the render-compare self-check
//   node scripts/extract-eval.mjs --out baseline.json  # write raw results for diffing
//   node scripts/extract-eval.mjs --only 009,040       # subset by reference index
//
// Requires ornith (or any VL model) live at VISION_BASE_URL (studio/.env). Deterministic pixel
// passes still run without it, but extraction needs vision — a no-vision run is reported as such.

import { extractLayout } from '../lib/layout-extract.mjs';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const INSPO = join(homedir(), 'Downloads', 'IMAGE AD INSPO');

// Fixed, hand-picked diverse set. `expectMin`/`expectMax` is a loose expectation on the number of
// skeleton/preset layers we should see (a sanity band, not a hard assert), and `note` records what
// the reference IS so a regression is legible. Indices are the file-prefix numbers in the folder.
const CASES = [
  { idx: '005', kind: 'photo/product hero (light)', archetype: 'offer-hero', expectMin: 6, expectMax: 16 },
  { idx: '009', kind: 'x-post (dark bg)',            archetype: 'x-post',     expectMin: 5, expectMax: 16 },
  { idx: '010', kind: 'x-post (white bg)',           archetype: 'x-post',     expectMin: 4, expectMax: 14 },
  { idx: '017', kind: 'text-heavy letter (white)',   archetype: 'generic',    expectMin: 3, expectMax: 12 },
  { idx: '013', kind: 'offer-hero (gradient, bag)',  archetype: 'offer-hero', expectMin: 5, expectMax: 16 },
  { idx: '040', kind: 'photo hero full-bleed (tube)',archetype: 'generic',    expectMin: 4, expectMax: 14 },
];

/** Resolve a case index (e.g. "009") to its real path in the inspo folder (png OR webp). */
function resolvePath(idx) {
  let files = [];
  try { files = readdirSync(INSPO); } catch { return null; }
  const hit = files.find((f) => f.startsWith(`${idx}_`) && /\.(png|webp|jpe?g)$/i.test(f));
  return hit ? join(INSPO, hit) : null;
}

/** Count leaves (non-group) in a possibly-grouped skeleton tree. */
function countLeaves(layers) {
  let n = 0;
  for (const l of (Array.isArray(layers) ? layers : [])) {
    if (!l) continue;
    if (l.type === 'group' && Array.isArray(l.children)) n += countLeaves(l.children);
    else n++;
  }
  return n;
}

/** Count layers flagged for cut-out from the reference (additive cutoutCandidate field). */
function countCutouts(layers) {
  let n = 0;
  for (const l of (Array.isArray(layers) ? layers : [])) {
    if (!l) continue;
    if (l.cutoutCandidate) n++;
    if (l.type === 'group' && Array.isArray(l.children)) n += countCutouts(l.children);
  }
  return n;
}

/** Count layers carrying a synthesized organic silhouette path (product previs). */
function countSilhouettes(layers) {
  let n = 0;
  for (const l of (Array.isArray(layers) ? layers : [])) {
    if (!l) continue;
    if (l?.style?.shapeKind === 'path' && l?.style?.path) n++;
    if (l.type === 'group' && Array.isArray(l.children)) n += countSilhouettes(l.children);
  }
  return n;
}

/** Count text layers that carry a non-default FONT signal (a resolved fontFamily, or a serif/mono
 *  flag) — i.e. the font read survived from the raw extraction into the skeleton. Also reports any
 *  comma-list fontFamily (a bug: the export renderer can't load those). */
function fontStats(layers) {
  let textN = 0, withFont = 0, commaLists = 0;
  const walk = (ls) => {
    for (const l of (Array.isArray(ls) ? ls : [])) {
      if (!l) continue;
      if (l.type === 'group' && Array.isArray(l.children)) { walk(l.children); continue; }
      const isText = (l.type === 'text' || l.type === 'badge' || l.type === 'button') && String(l.text || '').trim();
      if (!isText) continue;
      textN++;
      const ff = l.style?.fontFamily;
      if (ff || l.style?.serif || l.style?.mono) withFont++;
      if (typeof ff === 'string' && ff.includes(',')) commaLists++;
    }
  };
  walk(layers);
  return { textN, withFont, commaLists };
}

async function main() {
  const args = process.argv.slice(2);
  const selfCheck = args.includes('--selfcheck');
  const outIdx = args.indexOf('--out');
  const outPath = outIdx >= 0 ? args[outIdx + 1] : null;
  const onlyIdx = args.indexOf('--only');
  const only = onlyIdx >= 0 ? new Set(String(args[onlyIdx + 1] || '').split(',').map((s) => s.trim())) : null;

  const cases = CASES.filter((c) => !only || only.has(c.idx));
  const results = [];

  console.log(`\n=== extract-eval — ${cases.length} references · selfCheck=${selfCheck} ===\n`);

  for (const c of cases) {
    const path = resolvePath(c.idx);
    if (!path || !existsSync(path)) {
      console.log(`  ${c.idx}  MISSING FILE — skipped`);
      results.push({ idx: c.idx, ok: false, error: 'missing file' });
      continue;
    }
    const t0 = Date.now();
    let res;
    try {
      res = await extractLayout(path, { passes: 2, selfCheck: selfCheck ? true : false });
    } catch (e) {
      res = { ok: false, error: String(e?.message || e) };
    }
    const ms = Date.now() - t0;
    const leaves = res.ok ? countLeaves(res.layers) : 0;
    const cutouts = res.ok ? countCutouts(res.layers) : 0;
    const silh = res.ok ? countSilhouettes(res.layers) : 0;
    const fonts = res.ok ? fontStats(res.layers) : { textN: 0, withFont: 0, commaLists: 0 };
    const archOk = res.ok && res.archetype === c.archetype;
    const inBand = leaves >= c.expectMin && leaves <= c.expectMax;
    const sc = res.selfCheck || null;
    const row = {
      idx: c.idx, kind: c.kind, ok: !!res.ok, error: res.error || null,
      leaves, expect: `${c.expectMin}-${c.expectMax}`, inBand,
      archetype: res.archetype || null, expectArch: c.archetype, archOk,
      bg: res.backgroundIsPhoto ? 'photo' : (typeof res.background === 'string' ? res.background : (res.background ? 'gradient' : 'null')),
      bgConfidence: res.backgroundConfidence || null,
      theme: res.theme || null,
      cutouts, silhouettes: silh,
      fonts,
      selfCheck: sc ? { matched: sc.matched, score: sc.score ?? null, corrections: (sc.corrections || []).length, applied: sc.applied } : null,
      ms,
    };
    results.push(row);
    const flag = !res.ok ? 'FAIL' : (inBand && archOk ? 'ok  ' : 'WARN');
    console.log(
      `  ${c.idx} [${flag}] ${String(c.kind).padEnd(30)} ` +
      `layers=${String(leaves).padStart(2)}/${row.expect.padEnd(5)} ${inBand ? '✓' : '✗'}  ` +
      `arch=${String(row.archetype).padEnd(11)}${archOk ? '✓' : `✗(want ${c.archetype})`}  ` +
      `bg=${String(row.bg).padEnd(8)} cut=${cutouts} silh=${silh} font=${fonts.withFont}/${fonts.textN}${fonts.commaLists ? `!${fonts.commaLists}comma` : ''} ` +
      `${sc ? `sc=${sc.applied}/${(sc.corrections || []).length} ` : ''}` +
      `${(ms / 1000).toFixed(1)}s`,
    );
    if (!res.ok) console.log(`        error: ${res.error}`);
  }

  // ── Summary ──────────────────────────────────────────────────────────────────────────────────
  const okN = results.filter((r) => r.ok).length;
  const bandN = results.filter((r) => r.ok && r.inBand).length;
  const archN = results.filter((r) => r.ok && r.archOk).length;
  const totalMs = results.reduce((s, r) => s + (r.ms || 0), 0);
  const totalCut = results.reduce((s, r) => s + (r.cutouts || 0), 0);
  const totalSil = results.reduce((s, r) => s + (r.silhouettes || 0), 0);
  const totalText = results.reduce((s, r) => s + (r.fonts?.textN || 0), 0);
  const totalFont = results.reduce((s, r) => s + (r.fonts?.withFont || 0), 0);
  const totalComma = results.reduce((s, r) => s + (r.fonts?.commaLists || 0), 0);
  console.log(
    `\n  SUMMARY  parse ${okN}/${results.length} · in-band ${bandN}/${results.length} · ` +
    `archetype ${archN}/${results.length} · cutouts ${totalCut} · silhouettes ${totalSil} · ` +
    `font-signals ${totalFont}/${totalText} text layers${totalComma ? ` · ⚠ ${totalComma} comma-list families` : ''} · ` +
    `total ${(totalMs / 1000).toFixed(1)}s (avg ${(totalMs / 1000 / Math.max(1, results.length)).toFixed(1)}s)\n`,
  );

  if (outPath) {
    writeFileSync(outPath, JSON.stringify({ at: new Date().toISOString(), selfCheck, results }, null, 2));
    console.log(`  wrote ${outPath}\n`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
