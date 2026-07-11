// lib/copy-jobs.mjs — per-run job artifact directories for the copy pipeline (COPY-ENGINE-V2).
//
// Role: every "copy an ad" run gets a durable, human-inspectable artifact dir under
// .state/copy-jobs/<jobId>/ (extraction.json, extraction.truth.json, occlusion-plan.json,
// fontmatch.json, doc.json, debug/*.png, …). This is the recoverability story: a bad result is
// a stage re-run or an override, not a re-roll.
//
// Invariants:
//   • jobId = sha256 content-hash prefix (12 hex) of the source image; an existing dir with that
//     id is a collision → monotonic "-2", "-3", … suffix (each openJob call gets a FRESH dir).
//   • all writes are crash-safe via lib/atomic-write.mjs (temp file + rename swap).
//   • artifact names are dir-relative; nested names like 'debug/foo.png' are supported; absolute
//     paths and '..' traversal are rejected (artifacts can never escape the job dir).
//
// Callers: lib/design-agent.mjs runCopyReference (the product copy path); stage CLIs may also
// receive the job handle. Standalone use without a job stays possible — this module is optional
// everywhere (callers treat openJob failure as "no artifacts", never as a run failure).

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname, normalize, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeAtomic } from './atomic-write.mjs';

const DEFAULT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '.state', 'copy-jobs');

/**
 * Open a fresh job artifact directory for a source image.
 *
 * @param {string} imagePath — the source/reference image the job operates on
 * @param {{root?: string}} [opts] — root override (tests); defaults to studio/.state/copy-jobs
 * @returns {{ id: string, dir: string, write(name, data): string, writeJson(name, obj): string }}
 *   write/writeJson return the absolute path of the written artifact.
 */
export function openJob(imagePath, opts = {}) {
  const root = opts.root || DEFAULT_ROOT;
  let hash;
  try {
    hash = createHash('sha256').update(readFileSync(imagePath)).digest('hex').slice(0, 12);
  } catch {
    // unreadable source: hash the path string so the job still opens (artifacts >> strict ids)
    hash = createHash('sha256').update(String(imagePath)).digest('hex').slice(0, 12);
  }
  let id = hash;
  for (let n = 2; existsSync(join(root, id)); n++) id = `${hash}-${n}`;
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });

  const resolveName = (name) => {
    const rel = normalize(String(name || ''));
    // reject escapes: writeAtomic mkdirs the parent, so a '..' name would silently write outside
    if (!rel || rel === '.' || isAbsolute(rel) || rel.split(sep).includes('..')) {
      throw new Error(`copy-jobs: unsafe artifact name ${JSON.stringify(name)}`);
    }
    return join(dir, rel);
  };
  const write = (name, data) => {
    const p = resolveName(name);
    writeAtomic(p, data);
    return p;
  };
  const writeJson = (name, obj) => write(name, `${JSON.stringify(obj, null, 2)}\n`);

  // provenance stamp — which image, when (best-effort; never blocks the job)
  try { writeJson('job.json', { id, source: String(imagePath), at: new Date().toISOString() }); } catch { /* best-effort */ }

  return { id, dir, write, writeJson };
}
