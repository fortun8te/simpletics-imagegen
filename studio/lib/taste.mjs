// lib/taste.mjs — the taste layer's storage + ranking boost (BRIEF Phase 4, feedback half).
//
// Every thumbs-up/-down the user gives (Plan ref cards, Design comps) lands here as a vote:
// .state/taste.json = { votes: { [key]: 1 | -1 } } where key is "ref:{adId}" or "design:{id}".
// The planner's ref ranking folds these in as a score boost, so approved styles float up and
// rejected ones sink — retrieval weights, not fine-tuning (fine-tuning stays deferred until a
// real approve/reject corpus exists; see BRIEF "What's explicitly NOT realistic").
// Zero deps: node:* only.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const STATE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '.state');
const TASTE_PATH = join(STATE_DIR, 'taste.json');

let votes = (() => {
  try {
    const raw = JSON.parse(readFileSync(TASTE_PATH, 'utf8'));
    return raw && typeof raw.votes === 'object' ? raw.votes : {};
  } catch { return {}; }
})();

function persist() {
  try {
    if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(TASTE_PATH, JSON.stringify({ votes }, null, 2), 'utf8');
  } catch { /* best effort */ }
}

/** Record a vote. verdict: 1 (approve) / -1 (reject) / 0 (clear). Returns the stored map. */
export function vote(key, verdict) {
  const k = String(key || '').trim();
  if (!k) return getVotes();
  const v = Number(verdict);
  if (v === 0) delete votes[k];
  else votes[k] = v > 0 ? 1 : -1;
  persist();
  return getVotes();
}

export function getVotes() {
  return { ...votes };
}

/** Ranking boost for one key: approved +2.5, rejected -4 (rejects sink hard), unknown 0. */
export function boostFor(key) {
  const v = votes[String(key)];
  return v === 1 ? 2.5 : v === -1 ? -4 : 0;
}
