// lib/skeletons.mjs — the reusable layout library (.state/skeletons/{id}.json).
//
// A skeleton is an extracted or hand-saved layout: overlay layers only, canonical coords,
// with the reference ad it came from (see src/lib/sceneGraph.ts Skeleton). Extractions land
// here once and get stamped onto the TrendTrack ad record (layoutId) so a cached ad's design
// is copied at zero cost forever after. Zero deps: node:* only.

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const STUDIO = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(STUDIO, '.state', 'skeletons');

function ensureDir() { if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true }); }
const safeId = (id) => String(id || '').trim().replace(/[^a-zA-Z0-9_-]+/g, '-');

export function saveSkeleton(skeleton) {
  if (!skeleton || !skeleton.id || !Array.isArray(skeleton.layers)) {
    throw new Error('invalid skeleton');
  }
  ensureDir();
  const clean = { ...skeleton, id: safeId(skeleton.id) };
  writeFileSync(join(DIR, `${clean.id}.json`), JSON.stringify(clean, null, 2));
  return clean;
}

export function getSkeleton(id) {
  try { return JSON.parse(readFileSync(join(DIR, `${safeId(id)}.json`), 'utf8')); } catch { return null; }
}

export function deleteSkeleton(id) {
  try { rmSync(join(DIR, `${safeId(id)}.json`)); return true; } catch { return false; }
}

export function listSkeletons() {
  ensureDir();
  const out = [];
  for (const f of readdirSync(DIR)) {
    if (!f.endsWith('.json')) continue;
    try {
      const s = JSON.parse(readFileSync(join(DIR, f), 'utf8'));
      out.push({
        id: s.id, name: s.name, canvas: s.canvas, brand: s.brand ?? null,
        layerCount: (s.layers || []).length,
        sourceRef: s.sourceRef || null,
        extractedBy: s.extractedBy || 'manual',
        createdAt: s.createdAt,
      });
    } catch { /* skip corrupt */ }
  }
  return out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}
