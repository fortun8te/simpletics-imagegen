// lib/brand-skills.mjs — per-brand agent skills (.state/skills/{brand}.md).
// MagicPath-style reusable instruction bundles: styling rules, layout defaults, copy tone.

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '.state', 'skills');
const safe = (b) => String(b || '').trim().replace(/[^a-zA-Z0-9_-]+/g, '-');

function ensure() { if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true }); }

/** Load skill markdown for a brand (≤1200 chars for prompt injection). */
export function loadBrandSkill(brand) {
  if (!brand) return '';
  try {
    const p = join(DIR, `${safe(brand)}.md`);
    if (!existsSync(p)) return '';
    return readFileSync(p, 'utf8').trim().slice(0, 1200);
  } catch { return ''; }
}

export function saveBrandSkill(brand, text) {
  ensure();
  const b = safe(brand);
  if (!b) throw new Error('brand required');
  const body = String(text || '').trim().slice(0, 4000);
  writeFileSync(join(DIR, `${b}.md`), body ? `${body}\n` : '');
  return body;
}

export function listBrandSkills() {
  ensure();
  return readdirSync(DIR).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, ''));
}
