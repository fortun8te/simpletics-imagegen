// lib/design-verify.mjs — MagicPath-style quality gate before saving agent output.
// Combines layout score, lint, and optional skeleton IoU into a single ready/not-ready verdict.

import { leaves } from './scene-tree.mjs';
import { lintDesign } from './design-lint.mjs';
import { layoutScore } from './layout-engine.mjs';
import { readabilityScore } from './ad-context.mjs';
import { getSkeleton } from './skeletons.mjs';

const TEXTY = new Set(['text', 'badge', 'button']);

function boxIoU(a, b) {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

/** Match doc overlay roles to skeleton layers by role; return mean IoU 0..1 or null. */
export function skeletonIoU(doc, skeleton) {
  if (!skeleton || !Array.isArray(skeleton.layers)) return null;
  const sw = skeleton.canvas?.w || doc.canvas.w;
  const sh = skeleton.canvas?.h || doc.canvas.h;
  const sx = doc.canvas.w / sw;
  const sy = doc.canvas.h / sh;
  const skelByRole = new Map();
  for (const l of skeleton.layers) {
    if (l.role && l.box) skelByRole.set(l.role, l);
  }
  const docTexts = leaves(doc.layers || []).filter((n) => TEXTY.has(n.type) && n.role !== 'base');
  const ious = [];
  for (const n of docTexts) {
    const ref = skelByRole.get(n.role);
    if (!ref || !ref.box) continue;
    const refBox = {
      x: Math.round(ref.box.x * sx),
      y: Math.round(ref.box.y * sy),
      w: Math.round(ref.box.w * sx),
      h: Math.round(ref.box.h * sy),
    };
    ious.push(boxIoU(n.box, refBox));
  }
  if (!ious.length) return null;
  return Math.round((ious.reduce((a, b) => a + b, 0) / ious.length) * 100) / 100;
}

/**
 * Verify a comp is ready to ship. Returns { ready, layoutScore, lintCount, lint, skeletonIoU, issues }.
 * ready = layout≥70 AND lint≤1 AND (no skeleton OR IoU≥0.4).
 */
export function verifyDesign(doc, { kit = null, skeleton = null, skeletonId = null } = {}) {
  const skel = skeleton || (skeletonId ? getSkeleton(skeletonId) : null);
  const layout = layoutScore(doc, kit);
  const read = readabilityScore(doc);
  const lint = lintDesign(doc, kit);
  const iou = skel ? skeletonIoU(doc, skel) : null;
  const issues = [];
  if (layout < 70) issues.push(`layout score ${layout} < 70`);
  if (read < 70) issues.push(`readability ${read} < 70`);
  if (lint.length > 1) issues.push(`${lint.length} lint findings`);
  if (iou != null && iou < 0.4) issues.push(`skeleton match ${Math.round(iou * 100)}% < 40%`);
  const ready = layout >= 70 && read >= 70 && lint.length <= 1 && (iou == null || iou >= 0.4);
  return {
    ready,
    layoutScore: layout,
    readabilityScore: read,
    lintCount: lint.length,
    lint: lint.slice(0, 8),
    skeletonIoU: iou,
    issues,
  };
}

/** One-line summary for agent verify step. */
export function verifySummary(v) {
  const parts = [
    v.ready ? 'ready' : 'needs work',
    `layout ${v.layoutScore}`,
    v.readabilityScore != null ? `read ${v.readabilityScore}` : null,
    `lint ${v.lintCount}`,
  ].filter(Boolean);
  if (v.skeletonIoU != null) parts.push(`match ${Math.round(v.skeletonIoU * 100)}%`);
  return parts.join(' · ');
}
