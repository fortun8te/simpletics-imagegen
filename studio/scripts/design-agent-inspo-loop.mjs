#!/usr/bin/env node
// design-agent-inspo-loop.mjs — back-test the design agent against image-ad inspo with escalating difficulty.
// DeepSeek only (no Codex). 5 generation passes + 5 improve passes per level.
//
// Usage:
//   node scripts/design-agent-inspo-loop.mjs [--live] [--level=N] [--refs=K] [--vision]
//
// Levels:
//   1 single text overlay from cached skeleton
//   2 multi-layer skeleton (headline + cta)
//   3 full cached TrendTrack skeleton
//   4 synthetic busy layout (5 layers, wrong sizes)
//   5 placeholder preview comp (no real image, SVG base)
//   6 INSPO RECREATION — iterate ~/Downloads/IMAGE AD INSPO: describe each reference (cached),
//     agent recreates the layout from a blank doc, deterministic score → one improve round →
//     rescore. Emits report.csv (per-ref score/tokens/turns) — the regression gate for all
//     harness tuning — and indexes good results into .state/layout-library/ for retrieval.

import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { runDesignAgent } from '../lib/design-agent.mjs';
import { lintDesign } from '../lib/design-lint.mjs';
import { layoutScore, autoLayoutDoc } from '../lib/layout-engine.mjs';
import { hasLlm, llmInfo } from '../lib/llm.mjs';
import { describeImage } from '../lib/layout-extract.mjs';
import { verifyDesign } from '../lib/design-verify.mjs';
import { docSkeleton, indexLayout, aspectTag } from '../lib/layout-library.mjs';

const STUDIO = join(dirname(fileURLToPath(import.meta.url)), '..');
const STATE = join(STUDIO, '.state');
const OUT = join(STUDIO, '.state', 'inspo-loop');
const args = process.argv.slice(2);
const LIVE = args.includes('--live');
const levelArg = args.find((a) => a.startsWith('--level='));
const MAX_LEVEL = levelArg ? Number(levelArg.split('=')[1]) : 5;
const refsArg = args.find((a) => a.startsWith('--refs='));
const MAX_REFS = refsArg ? Number(refsArg.split('=')[1]) : 12; // level-6 references per run
const INSPO_DIR = process.env.INSPO_DIR || join(homedir(), 'Downloads', 'IMAGE AD INSPO');

const GENS = 5;
const IMPROVES = 5;

const PLACEHOLDER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1350" viewBox="0 0 1080 1350">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#1a1a2e"/><stop offset="100%" stop-color="#16213e"/></linearGradient></defs>
  <rect width="1080" height="1350" fill="url(#g)"/>
  <text x="540" y="680" text-anchor="middle" fill="#e94560" font-size="48" font-family="sans-serif">PLACEHOLDER PREVIEW</text>
</svg>`;

function mkDoc(canvas, layers = [], name = 'inspo-test') {
  return {
    id: `inspo_${Date.now().toString(36)}`,
    name,
    canvas,
    layers: [
      { id: 'base-1', type: 'image', role: 'base', name: 'Base', box: { x: 0, y: 0, w: canvas.w, h: canvas.h }, src: '/img?path=placeholder.png' },
      ...layers,
    ],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    schemaVersion: 3,
  };
}

function loadSkeletons() {
  const dir = join(STATE, 'skeletons');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => {
    try { return JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { return null; }
  }).filter(Boolean);
}

function skeletonToLayers(skel, scale = 1) {
  const sw = skel.canvas?.w || 1080;
  const sh = skel.canvas?.h || 1080;
  return (skel.layers || []).map((l, i) => {
    const sx = scale;
    const layer = JSON.parse(JSON.stringify(l));
    layer.id = `ly-${i}`;
    layer.box = {
      x: Math.round(layer.box.x * sx),
      y: Math.round(layer.box.y * sx),
      w: Math.round(layer.box.w * sx),
      h: Math.round(layer.box.h * sx),
    };
    if (layer.type === 'text' || layer.type === 'badge' || layer.type === 'button') layer.autoH = true;
    return layer;
  });
}

const LEVELS = [
  {
    name: 'L1 · single caption',
    canvas: { w: 1080, h: 1350 },
    build() {
      return mkDoc({ w: 1080, h: 1350 }, [{
        id: 'cap-1', type: 'text', role: 'caption', name: 'Caption', autoH: true,
        text: 'act like the person you want to become.',
        box: { x: 315, y: 917, w: 495, h: 60 },
        style: { fontSize: 28, fontWeight: 700, color: '#ffffff', align: 'center' },
      }]);
    },
    instruction: 'Recreate this ad caption layout: centered white text in the lower third. Use correct IG font size.',
    brief: 'Gymshark motivational story ad',
  },
  {
    name: 'L2 · headline + cta',
    canvas: { w: 1080, h: 1080 },
    build() {
      return mkDoc({ w: 1080, h: 1080 }, [
        { id: 'hd-1', type: 'text', role: 'headline', autoH: true, text: 'SUMMER DROP', box: { x: 60, y: 620, w: 500, h: 80 }, style: { fontSize: 42, color: '#fff', fontWeight: 800 } },
        { id: 'cta-1', type: 'button', role: 'cta', autoH: true, text: 'SHOP NOW', box: { x: 60, y: 920, w: 280, h: 50 }, style: { fontSize: 22, background: '#2c5cff', color: '#fff' } },
      ]);
    },
    instruction: 'Fix hierarchy: headline must dominate, CTA bottom-right. Use element ops where possible.',
    brief: 'DTC summer sale square ad',
  },
  {
    name: 'L3 · cached skeleton',
    canvas: { w: 1080, h: 1920 },
    build() {
      const skels = loadSkeletons();
      const skel = skels.find((s) => (s.layers || []).length >= 1) || skels[0];
      if (!skel) return mkDoc({ w: 1080, h: 1920 });
      const target = { w: 1080, h: skel.canvas?.h || 1920 };
      return mkDoc(target, skeletonToLayers(skel, target.w / (skel.canvas?.w || 1080)), skel.name?.slice(0, 40) || 'cached skeleton');
    },
    instruction: 'Match the reference overlay layout: correct positions, font sizes, and spacing for IG story.',
    brief: 'Recreate extracted competitor overlay',
  },
  {
    name: 'L4 · messy layout',
    canvas: { w: 1080, h: 1350 },
    build() {
      return mkDoc({ w: 1080, h: 1350 }, [
        { id: 'b1', type: 'badge', role: 'badge', autoH: true, text: 'NEW', box: { x: 5, y: 5, w: 200, h: 30 }, style: { fontSize: 14, background: '#ffe14d', color: '#111' } },
        { id: 'h1', type: 'text', role: 'headline', autoH: true, text: 'tiny headline', box: { x: 400, y: 200, w: 300, h: 40 }, style: { fontSize: 22, color: '#fff' } },
        { id: 'c1', type: 'text', role: 'caption', autoH: true, text: 'huge caption text', box: { x: 50, y: 600, w: 900, h: 200 }, style: { fontSize: 72, color: '#fff' } },
        { id: 'cta', type: 'button', role: 'cta', autoH: true, text: 'BUY', box: { x: 900, y: 1200, w: 150, h: 40 }, style: { fontSize: 16, background: '#fff', color: '#111' } },
      ]);
    },
    instruction: 'This layout is broken: weak hierarchy, wrong sizes, bad positions. Fix it for IG 4:5.',
    brief: 'Fix broken ad layout',
  },
  {
    name: 'L5 · placeholder preview',
    canvas: { w: 1080, h: 1350 },
    build() {
      mkdirSync(OUT, { recursive: true });
      const svgPath = join(OUT, 'placeholder-preview.svg');
      writeFileSync(svgPath, PLACEHOLDER_SVG);
      return mkDoc({ w: 1080, h: 1350 }, [
        { id: 'h1', type: 'text', role: 'headline', autoH: true, text: 'YOUR BRAND HERE', box: { x: 80, y: 900, w: 920, h: 100 }, style: { fontSize: 48, color: '#ffffff', fontWeight: 800, align: 'center' } },
        { id: 'sub', type: 'text', role: 'subhead', autoH: true, text: 'Limited time offer', box: { x: 80, y: 1020, w: 920, h: 50 }, style: { fontSize: 32, color: '#cccccc', align: 'center' } },
        { id: 'cta', type: 'button', role: 'cta', autoH: true, text: 'GET STARTED', box: { x: 340, y: 1150, w: 400, h: 70 }, style: { fontSize: 28, background: '#e94560', color: '#fff' } },
      ], 'placeholder preview');
    },
    instruction: 'Polish this placeholder ad for IG feed: hierarchy, spacing, contrast. No new layers unless needed.',
    brief: 'Placeholder brand ad — make it production-ready',
  },
];

async function runLevel(level, report) {
  const doc = level.build();
  const results = { level: level.name, gens: [], improves: [], limitations: [] };

  console.log(`\n━━ ${level.name} ━━`);
  console.log(`  canvas ${doc.canvas.w}×${doc.canvas.h} · ${doc.layers.length - 1} overlay(s)`);

  if (!LIVE) {
    const work = JSON.parse(JSON.stringify(doc));
    const pre = autoLayoutDoc(work);
    const score = layoutScore(work);
    const lint = lintDesign(work);
    console.log(`  [dry] autolayout: ${pre.summary}`);
    console.log(`  [dry] layout score: ${score} · lint findings: ${lint.length}`);
    if (lint.length) console.log(`  [dry] lint: ${lint.slice(0, 3).join(' · ')}`);
    results.gens.push({ dry: true, layoutScore: score, lint: lint.length, summary: pre.summary });
    results.limitations.push(lint.length ? `Lint still flags: ${lint[0]}` : null);
    results.limitations = results.limitations.filter(Boolean);
    report.levels.push(results);
    return;
  }

  if (!hasLlm()) {
    results.limitations.push('No LLM configured — set DEEPSEEK_API_KEY or LLM_BASE_URL in studio/.env');
    report.levels.push(results);
    return;
  }

  const opts = { noCodex: true, brief: level.brief, maxTokensPerTurn: 220, maxApplied: 4 };

  for (let g = 0; g < GENS; g++) {
    const work = JSON.parse(JSON.stringify(doc));
    const t0 = Date.now();
    try {
      const useGenerate = g % 2 === 0;
      const r = await runDesignAgent(work, level.instruction, () => {}, {
        ...opts,
        mode: useGenerate ? 'generate' : 'edit',
        maxSteps: useGenerate ? 3 : 6,
        skipVerifyRetry: g < GENS - 1,
      });
      const lint = lintDesign(r.doc);
      const entry = {
        pass: g + 1, ms: Date.now() - t0, applied: r.applied, source: r.source,
        layoutScore: r.layoutScore, lint: lint.length, tokens: (r.usage?.inTok || 0) + (r.usage?.outTok || 0),
        turns: r.totals?.turns || 0, verifyReady: r.verify?.ready,
      };
      results.gens.push(entry);
      console.log(`  gen ${g + 1}/${GENS}: ${entry.applied} ops · layout ${entry.layoutScore} · lint ${entry.lint} · ${entry.tokens} tok · ${entry.ms}ms`);
    } catch (e) {
      results.gens.push({ pass: g + 1, error: String(e.message || e) });
      console.log(`  gen ${g + 1}/${GENS}: ERROR ${e.message}`);
    }
  }

  for (let i = 0; i < IMPROVES; i++) {
    const work = JSON.parse(JSON.stringify(doc));
    autoLayoutDoc(work); // start from repaired baseline
    const t0 = Date.now();
    try {
      const r = await runDesignAgent(work, '', () => {}, { ...opts, mode: 'improve', maxSteps: 5 });
      const lint = lintDesign(r.doc);
      const entry = {
        pass: i + 1, ms: Date.now() - t0, applied: r.applied, layoutScore: r.layoutScore,
        lint: lint.length, tokens: (r.usage?.inTok || 0) + (r.usage?.outTok || 0),
      };
      results.improves.push(entry);
      console.log(`  improve ${i + 1}/${IMPROVES}: layout ${entry.layoutScore} · lint ${entry.lint} · ${entry.tokens} tok`);
    } catch (e) {
      results.improves.push({ pass: i + 1, error: String(e.message || e) });
    }
  }

  // Diagnose limitations
  const avgScore = results.gens.filter((g) => g.layoutScore).reduce((s, g) => s + g.layoutScore, 0) / Math.max(1, results.gens.filter((g) => g.layoutScore).length);
  const avgTok = results.gens.filter((g) => g.tokens).reduce((s, g) => s + g.tokens, 0) / Math.max(1, results.gens.filter((g) => g.tokens).length);
  if (avgScore < 70) results.limitations.push('Layout score still low — model ignores TYPE SIZES or zones');
  if (avgTok > 3000) results.limitations.push('Token burn high — tighten maxSteps or use more autolayout');
  const lintFails = results.improves.filter((x) => x.lint > 0).length;
  if (lintFails > IMPROVES / 2) results.limitations.push('Improve mode not clearing lint — contrast/hierarchy still model-dependent');
  if (!hasLlm()) results.limitations.push('No vision — image inspo is structural only (skeleton), not pixel-matched');

  report.levels.push(results);
}

// ── Level 6: recreate real inspo ads (describe → generate → score → improve → rescore) ──────────
async function runInspoRecreation(report) {
  console.log(`\n━━ L6 · inspo recreation (${INSPO_DIR}) ━━`);
  const results = { level: 'L6 · inspo recreation', refs: [], limitations: [] };
  if (!existsSync(INSPO_DIR)) {
    results.limitations.push(`inspo folder not found: ${INSPO_DIR} (set INSPO_DIR to override)`);
    report.levels.push(results);
    return;
  }
  const files = readdirSync(INSPO_DIR)
    .filter((f) => /\.(png|jpe?g|webp)$/i.test(f))
    .sort()
    .slice(0, MAX_REFS);
  console.log(`  ${files.length} reference(s) this run (of ${readdirSync(INSPO_DIR).length} in folder, cap --refs=${MAX_REFS})`);
  if (!LIVE) {
    results.limitations.push('dry-run: level 6 needs --live (describe + generate are LLM/vision calls)');
    report.levels.push(results);
    return;
  }
  if (!hasLlm()) {
    results.limitations.push('No LLM configured — set DEEPSEEK_API_KEY or LLM_BASE_URL in studio/.env');
    report.levels.push(results);
    return;
  }

  const csv = ['ref,scoreGen,scoreImproved,lintGen,lintImproved,tokens,turns,applied,ms'];
  for (const f of files) {
    const refId = `inspo-${f.replace(/\.[^.]+$/, '').replace(/[^\w-]+/g, '-')}`.slice(0, 60);
    const t0 = Date.now();
    try {
      // 1. describe (vision, cached per ref in .state/refs/{refId}.desc.txt)
      const d = await describeImage(join(INSPO_DIR, f), { cacheId: refId });
      const desc = d.ok ? d.text : null;
      if (!desc) {
        console.log(`  ${f}: describe failed (${d.error || 'no codex vision'}) — skipped`);
        results.refs.push({ ref: f, error: d.error || 'describe failed' });
        continue;
      }
      // 2. recreate from a blank portrait doc
      const doc = mkDoc({ w: 1080, h: 1350 }, [], refId);
      const r = await runDesignAgent(doc, `Recreate this ad's layout and copy structure: ${desc}`, () => {}, {
        noCodex: true, mode: 'generate', brief: desc.slice(0, 300),
      });
      const genScore = r.layoutScore;
      const genLint = lintDesign(r.doc).length;
      // 3. one improve round on the result
      const r2 = await runDesignAgent(r.doc, '', () => {}, { noCodex: true, mode: 'improve' });
      const impScore = r2.layoutScore;
      const impLint = lintDesign(r2.doc).length;
      const tokens = (r.usage?.inTok || 0) + (r.usage?.outTok || 0) + (r2.usage?.inTok || 0) + (r2.usage?.outTok || 0);
      const turns = (r.totals?.turns || 0) + (r2.totals?.turns || 0);
      const ms = Date.now() - t0;
      const entry = { ref: f, genScore, impScore, genLint, impLint, tokens, turns, applied: r.applied + r2.applied, ms };
      results.refs.push(entry);
      csv.push(`${f},${genScore},${impScore},${genLint},${impLint},${tokens},${turns},${entry.applied},${ms}`);
      console.log(`  ${f}: gen ${genScore} → improved ${impScore} · lint ${genLint}→${impLint} · ${tokens} tok · ${turns} turns · ${ms}ms`);
      // 4. good recreations feed the retrieval library (with the verify gate as curation)
      const v = verifyDesign(r2.doc);
      if (impScore >= 85 && v.ready) {
        indexLayout({
          id: refId,
          tags: desc.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 3).slice(0, 12),
          aspect: aspectTag(1080, 1350),
          skeleton: docSkeleton(r2.doc),
          score: impScore,
          source: `inspo:${f}`,
        });
      }
    } catch (e) {
      results.refs.push({ ref: f, error: String(e.message || e) });
      console.log(`  ${f}: ERROR ${e.message}`);
    }
  }

  mkdirSync(OUT, { recursive: true });
  const csvPath = join(OUT, 'report.csv');
  writeFileSync(csvPath, csv.join('\n') + '\n');
  const ok = results.refs.filter((x) => x.impScore != null);
  const avg = (k) => (ok.length ? Math.round(ok.reduce((s, x) => s + x[k], 0) / ok.length) : null);
  console.log(`  L6 avg: gen ${avg('genScore')} → improved ${avg('impScore')} · ${avg('tokens')} tok/ref · csv → ${csvPath}`);
  if (avg('impScore') != null && avg('impScore') < 75) results.limitations.push('L6 improved score <75 — recreation quality is the current harness ceiling');
  report.levels.push(results);
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const info = llmInfo();
  const report = {
    at: new Date().toISOString(),
    llm: info,
    live: LIVE,
    levels: [],
    summary: {},
  };

  console.log(`Design agent inspo loop · ${LIVE ? 'LIVE (DeepSeek)' : 'dry-run'} · model: ${info.model || 'none'}`);

  for (let i = 0; i < Math.min(MAX_LEVEL, LEVELS.length); i++) {
    await runLevel(LEVELS[i], report);
  }
  if (MAX_LEVEL >= 6) await runInspoRecreation(report);

  // Aggregate
  const allGens = report.levels.flatMap((l) => l.gens || []);
  const scores = allGens.filter((g) => g.layoutScore != null).map((g) => g.layoutScore);
  report.summary = {
    avgLayoutScore: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null,
    avgTokens: allGens.filter((g) => g.tokens).length
      ? Math.round(allGens.filter((g) => g.tokens).reduce((s, g) => s + g.tokens, 0) / allGens.filter((g) => g.tokens).length)
      : null,
    limitations: [...new Set(report.levels.flatMap((l) => l.limitations || []))],
  };

  const outPath = join(OUT, `report-${Date.now().toString(36)}.json`);
  writeFileSync(outPath, JSON.stringify(report, null, 2));

  console.log('\n━━ SUMMARY ━━');
  console.log(`  avg layout score: ${report.summary.avgLayoutScore ?? 'n/a'}`);
  console.log(`  avg tokens/gen: ${report.summary.avgTokens ?? 'n/a'}`);
  if (report.summary.limitations.length) {
    console.log('  LIMITATIONS:');
    for (const l of report.summary.limitations) console.log(`    • ${l}`);
  }
  console.log(`  report → ${outPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
