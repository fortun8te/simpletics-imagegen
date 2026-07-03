// lib/generation-mode.mjs — MagicPath-inspired GENERATION mode: template-first, minimal LLM.
// Seeds headline/cta/badge from the element library, autolayouts, then LLM only polishes copy/contrast.

import { leaves } from './scene-tree.mjs';
import { buildElement } from './elements.mjs';
import { autoLayoutDoc } from './layout-engine.mjs';
import { smartAdRepair } from './ad-context.mjs';

const GENERATE_RE = /\b(generate|create|build|from scratch|recreate|design a|make a|new (ad|comp|layout)|inspo|inspired by|match (the|this) (ref|reference|layout))\b/i;

export function isGenerateIntent(instruction, mode) {
  if (mode === 'generate') return true;
  const s = String(instruction || '');
  if (!s.trim()) return false;
  if (GENERATE_RE.test(s)) return true;
  return false;
}

/** Restricted op allow-list for generation polish pass. */
export const GENERATE_OPS = new Set(['setText', 'setStyle', 'draftText', 'template', 'look', 'autolayout', 'done']);

export function filterGenerateOp(op) {
  if (!op || typeof op !== 'object') return null;
  if (op.op === 'done' || op.op === 'autolayout') return op;
  if (op.op === 'setText' || op.op === 'draftText' || op.op === 'template' || op.op === 'look') return op;
  if (op.op === 'setStyle' && op.style && typeof op.style === 'object') {
    const style = {};
    if ('color' in op.style) style.color = op.style.color;
    if ('background' in op.style) style.background = op.style.background;
    if ('opacity' in op.style) style.opacity = op.style.opacity;
    if (Object.keys(style).length) return { ...op, style };
    return null;
  }
  return null;
}

/**
 * Deterministic template seed: insert missing headline/cta/badge via element library.
 * Mutates doc via applyOp. Returns summary lines.
 */
export function seedFromTemplate(doc, opCtx, { brief = '', kit = null } = {}) {
  const summaries = [];
  const texts = leaves(doc.layers || []).filter((n) => n.role !== 'base');
  const roles = new Set(texts.map((t) => t.role));

  const headlineText = pickBriefLine(brief, 0) || 'YOUR HEADLINE';
  const ctaText = 'SHOP NOW';

  if (!roles.has('headline')) {
    const layers = buildElement('headline', doc, { text: headlineText }, kit);
    if (layers[0]) {
      doc.layers.push(layers[0]);
      summaries.push(`seed headline → ${headlineText.slice(0, 40)}`);
    }
  }
  if (!roles.has('cta')) {
    const layers = buildElement('cta', doc, { text: ctaText }, kit);
    if (layers[0]) {
      doc.layers.push(layers[0]);
      summaries.push('seed cta → SHOP NOW');
    }
  }
  if (!roles.has('badge') && doc.canvas.h / doc.canvas.w < 1.2) {
    const layers = buildElement('badge', doc, { text: 'NEW' }, kit);
    if (layers[0]) {
      doc.layers.push(layers[0]);
      summaries.push('seed badge → NEW');
    }
  }

  if (opCtx.aliases) opCtx.aliases.sync(doc);
  const layout = autoLayoutDoc(doc, { kit });
  if (layout.summary) summaries.push(layout.summary);
  const ad = smartAdRepair(doc, { kit });
  if (ad.summary) summaries.push(ad.summary);

  return summaries;
}

function pickBriefLine(brief, idx) {
  const s = String(brief || '').trim();
  if (!s) return '';
  // split on em/en dash or pipe only — plain hyphens are inside words ("Anti-frizz")
  const parts = s.split(/[—–|]/).map((x) => x.trim()).filter(Boolean);
  return parts[idx] || parts[0] || s.slice(0, 80);
}

/** Compact system prompt for generation polish (copy + contrast only). */
export function buildGeneratePrompt(instruction, ctx = {}) {
  const { brief, kit, brandSkill, runMemory, exemplars, copyLock } = ctx;
  const lines = [];
  if (Array.isArray(runMemory)) for (const l of runMemory.slice(-2)) lines.push(String(l).slice(0, 100));
  if (brief) lines.push(`Brief: ${String(brief).slice(0, 400)}`);
  if (kit?.prompt) lines.push(`BRAND STYLE: ${String(kit.prompt).slice(0, 400)}`);
  else if (kit?.notes) lines.push(`Brand notes: ${String(kit.notes).slice(0, 200)}`);
  if (brandSkill) lines.push(`BRAND SKILL:\n${brandSkill.slice(0, 1200)}`);

  return `GENERATION MODE — layout is already seeded. Your job: polish COPY and CONTRAST only.
Each turn reply with ONE JSON object: {"plan":"<one sentence>","ops":[…1-4 ops…],"done":true|false}.

ALLOWED OPS:
{"op":"setText","id":"L2","text":"…"}
{"op":"draftText","ids":["L2","L3"]}   (copywriter rewrites those layers to fit their boxes — best for captions)
{"op":"setStyle","id":"L2","style":{"color":"#fff","background":"#111"}}
{"op":"autolayout"}

Do NOT move, resize, add, or remove layers. Do NOT change fontSize. Use setText for copy; setStyle only for color/background/contrast.
${copyLock ? 'COPY LOCK: keep the reference copy VERBATIM — setText/draftText are disabled; adjust color/contrast only.' : ''}
COPY BUDGETS (max chars per line — write copy to fit): headline≤22 subhead≤36 caption≤42 cta≤18 badge≤24.
${exemplars ? `\n${exemplars}\n` : ''}
${lines.length ? `CONTEXT:\n${lines.join('\n')}\n` : ''}
TASK: ${instruction}

Set "done":true when copy reads well and contrast is solid. No prose, no code fences.`;
}
