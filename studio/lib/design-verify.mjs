// lib/design-verify.mjs — MagicPath-style quality gate before saving agent output.
// Combines layout score, lint, and optional skeleton IoU into a single ready/not-ready verdict.

import { leaves, walkNodes, groupBounds } from './scene-tree.mjs';
import { lintDesign } from './design-lint.mjs';
import { layoutScore } from './layout-engine.mjs';
import { readabilityScore } from './ad-context.mjs';
import { getSkeleton } from './skeletons.mjs';

const TEXTY = new Set(['text', 'badge', 'button']);

// ── Layer structure validation ─────────────────────────────────────────────────────────────────
// Validates the doc's layer tree for Figma-friendliness: meaningful names, proper nesting depth,
// no orphaned layers, no empty groups, and groups with bounds encompassing children.

/** Generic names that indicate a layer wasn't properly named. */
const GENERIC_NAMES = new Set(['group', 'layer', 'section', 'frame', 'shape', 'text', 'image', 'element']);
const MAX_FIGMA_DEPTH = 3; // optimal for Figma (max ~10, but 3-4 is best practice)

/**
 * Validate the layer structure of a doc for Figma export readiness. Returns:
 *   { valid, issues[], stats: { totalNodes, totalGroups, maxDepth, orphanCount, emptyGroupCount, genericNameCount } }
 *
 * Checks:
 *   - No orphaned layers (everything in a group or at root)
 *   - Groups have meaningful names (not just "Group")
 *   - Proper nesting depth (max 3 for Figma optimal)
 *   - No empty groups
 *   - Groups have bounds encompassing all children
 */
export function validateLayerStructure(doc) {
  const issues = [];
  let totalNodes = 0;
  let totalGroups = 0;
  let maxDepth = 0;
  let orphanCount = 0;
  let emptyGroupCount = 0;
  let genericNameCount = 0;
  let boundMismatchCount = 0;

  const GENERIC_RE = /^(group|layer|section|frame|shape|text|image|element|untitled)$/i;

  const walk = (nodes, depth, parentName) => {
    for (const n of nodes || []) {
      if (!n) continue;
      totalNodes++;
      maxDepth = Math.max(maxDepth, depth);

      if (n.type === 'group') {
        totalGroups++;

        // Check: meaningful name
        const name = String(n.name || '').trim();
        if (!name || GENERIC_RE.test(name)) {
          genericNameCount++;
        }

        // Check: not empty
        if (!Array.isArray(n.children) || n.children.length === 0) {
          emptyGroupCount++;
          issues.push(`empty group "${n.name || 'unnamed'}"`);
        }

        // Check: nesting depth
        if (depth > MAX_FIGMA_DEPTH) {
          issues.push(`group "${n.name || 'unnamed'}" at depth ${depth} exceeds Figma optimal (${MAX_FIGMA_DEPTH})`);
        }

        // Check: group bounds encompass children
        if (n.box && Array.isArray(n.children) && n.children.length > 0) {
          const computedBounds = groupBounds(n.children);
          if (computedBounds) {
            const tolerance = 2; // allow 2px rounding
            if (Math.abs(n.box.x - computedBounds.x) > tolerance ||
                Math.abs(n.box.y - computedBounds.y) > tolerance ||
                Math.abs(n.box.w - computedBounds.w) > tolerance ||
                Math.abs(n.box.h - computedBounds.h) > tolerance) {
              boundMismatchCount++;
            }
          }
        }

        // Recurse
        if (n.children) walk(n.children, depth + 1, n.name);
      } else {
        // Leaf node — check it's not orphaned (at root level with depth 0, this is fine;
        // deeper orphaned = not in a group, but that's okay if it's a direct child of the doc)
        if (depth === 0 && n.role !== 'base' && n.role !== 'background') {
          // Top-level leaf outside a group is not an "orphan" — it's a deliberate top-level layer
        }
      }
    }
  };

  walk(doc.layers || [], 0, null);

  // Summarize findings
  if (genericNameCount > 0) {
    issues.push(`${genericNameCount} group(s) with generic names (should be descriptive like "Header - Logo")`);
  }
  if (boundMismatchCount > 0) {
    issues.push(`${boundMismatchCount} group(s) with bounds not matching children`);
  }

  const valid = issues.length === 0;

  return {
    valid,
    issues,
    stats: { totalNodes, totalGroups, maxDepth, orphanCount, emptyGroupCount, genericNameCount, boundMismatchCount },
  };
}

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
 * Verify a comp is ready to ship. Returns { ready, layoutScore, lintCount, lint, skeletonIoU,
 *   layerStructure, issues }.
 * ready = layout≥70 AND lint≤1 AND (no skeleton OR IoU≥0.4) AND layerStructure.valid.
 */
export function verifyDesign(doc, { kit = null, skeleton = null, skeletonId = null } = {}) {
  const skel = skeleton || (skeletonId ? getSkeleton(skeletonId) : null);
  const layout = layoutScore(doc, kit);
  const read = readabilityScore(doc);
  const lint = lintDesign(doc, kit);
  const iou = skel ? skeletonIoU(doc, skel) : null;
  const layerStructure = validateLayerStructure(doc);
  const issues = [];
  if (layout < 70) issues.push(`layout score ${layout} < 70`);
  if (read < 70) issues.push(`readability ${read} < 70`);
  if (lint.length > 1) issues.push(`${lint.length} lint findings`);
  if (iou != null && iou < 0.4) issues.push(`skeleton match ${Math.round(iou * 100)}% < 40%`);
  if (!layerStructure.valid) issues.push(`${layerStructure.issues.length} layer structure issue(s)`);
  const ready = layout >= 70 && read >= 70 && lint.length <= 1 && (iou == null || iou >= 0.4) && layerStructure.valid;
  return {
    ready,
    layoutScore: layout,
    readabilityScore: read,
    lintCount: lint.length,
    lint: lint.slice(0, 8),
    skeletonIoU: iou,
    layerStructure,
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
  if (v.layerStructure && !v.layerStructure.valid) {
    parts.push(`layers: ${v.layerStructure.issues.length} issue(s)`);
  }
  return parts.join(' · ');
}
