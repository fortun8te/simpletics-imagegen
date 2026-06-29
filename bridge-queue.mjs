import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { versionedRelPath } = require('./logic.js');

// Write one file per captured variant under OUT. images[i] -> variantPaths[i] (falling back to
// relativePath for i==0, then `${name}-${i+1}.png`). This is the ONLY writer rooted at OUT, so all
// N variants land in the right place regardless of where ~/Downloads is. A malformed/empty image
// entry is skipped (no 0-byte file). Returns the files actually written, in order, with
// `relativePath` set to the ACTUAL path written. `fs` is injectable so this stays unit-testable.
// Back-compat: a single-image array writes exactly one file. NEVER overwrites: every target is
// routed through versionedRelPath, so a write that would land on an existing file is bumped to a new
// version (run-1.png -> run-1-v2.png) instead.
export function writeVariants(out, job, images, fs = { writeFileSync, mkdirSync, existsSync }) {
  const list = Array.isArray(images) ? images : (images ? [images] : []);
  const written = [];
  for (let i = 0; i < list.length; i++) {
    const b64 = String(list[i] || '').split(',')[1];
    if (!b64) continue;
    const desired = (job.variantPaths && job.variantPaths[i])
      || (i === 0 ? (job.relativePath || `${job.name}.png`) : `${job.name}-${i + 1}.png`);
    const relativePath = versionedRelPath(desired, (rel) => fs.existsSync(join(out, rel)));
    const path = join(out, relativePath);
    fs.mkdirSync(dirname(path), { recursive: true });
    fs.writeFileSync(path, Buffer.from(b64, 'base64'));
    written.push({ variantIndex: i, relativePath, path });
  }
  return written;
}

// Which variant slots did NOT get an image (a partial M-of-N capture). Pure: returns
// [{ variantIndex, relativePath }] for indices writtenCount..expected-1.
export function missingVariantSlots(job, writtenCount) {
  const expected = job.variants || (job.variantPaths && job.variantPaths.length) || 1;
  const missing = [];
  for (let i = writtenCount; i < expected; i++) {
    missing.push({ variantIndex: i, relativePath: (job.variantPaths && job.variantPaths[i]) || `${job.name}-${i + 1}.png` });
  }
  return missing;
}

function runNumber(name, prefix) {
  const match = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_r(\\d+)$`).exec(name || '');
  return match ? Number(match[1]) : null;
}

function rewriteRunPath(relativePath, run) {
  if (!relativePath) return relativePath;
  return String(relativePath).replace(/run-\d+(\.[a-z0-9]+)$/i, `run-${run}$1`);
}

function cloneJobForRun(template, id, prefix, run) {
  const job = {
    ...template,
    id,
    name: `${prefix}_r${run}`,
    relativePath: rewriteRunPath(template.relativePath, run),
    status: 'pending',
  };
  delete job.path;
  delete job.error;
  delete job.renamed;
  delete job.moved;
  delete job.diag;
  delete job.runCount;
  return job;
}

function jobList(jobs) {
  return Array.isArray(jobs) ? jobs : [...jobs.values()];
}

export function queueSnapshot(jobs, options = {}) {
  const all = jobList(jobs);
  const by = (status) => all.filter((job) => job.status === status).length;
  const done = by('done');
  const partial = by('partial');
  const error = by('error');
  const skipped = by('skipped');
  const pending = by('pending');
  const running = by('running');
  const current = all.find((job) => job.status === 'running')?.name || null;
  return {
    out: options.out,
    paused: !!options.paused,
    total: all.length,
    pending,
    running,
    done,
    partial,
    error,
    skipped,
    // 'partial' SAVED its image(s), so it settles the batch (no hang) but is reported apart from done.
    settled: done + partial + error + skipped,
    current,
    jobs: all.map((job) => ({ name: job.name, status: job.status, path: job.path, error: job.error, renamed: job.renamed, moved: job.moved, diag: job.diag, chatUrl: job.chatUrl })),
  };
}

export function formatQueueStatus(snapshot) {
  const paused = snapshot.paused ? ', paused' : '';
  return `ImageGen: ${snapshot.done}/${snapshot.total} finished, ${snapshot.pending} waiting, ${snapshot.running} running, ${snapshot.error} failed, ${snapshot.skipped} skipped${paused}.`;
}

export function applyQueueCommand(jobs, command, options = {}) {
  if (command.type !== 'runs') return { message: 'Unknown command.' };
  const prefix = command.name;
  const count = command.count;
  const nextId = options.nextId || (() => {
    throw new Error('nextId is required to add runs');
  });
  const matching = [...jobs.entries()]
    .map(([id, job]) => ({ id, job, run: runNumber(job.name, prefix) }))
    .filter((entry) => entry.run !== null);
  const adjustable = matching.filter((entry) => entry.job.status === 'pending');
  if (!adjustable.length) return { message: `No waiting job matched ${prefix}.` };

  let removed = 0;
  for (const entry of adjustable) {
    if (entry.run > count) {
      jobs.delete(entry.id);
      removed++;
    }
  }

  const afterRemoval = [...jobs.values()]
    .map((job) => ({ job, run: runNumber(job.name, prefix) }))
    .filter((entry) => entry.run !== null);
  const existingRuns = new Set(afterRemoval.map((entry) => entry.run));
  const template = adjustable.sort((a, b) => a.run - b.run)[0].job;
  let added = 0;
  for (let run = 1; run <= count; run++) {
    if (existingRuns.has(run)) continue;
    const id = nextId();
    jobs.set(id, cloneJobForRun(template, id, prefix, run));
    added++;
  }

  const changed = added || removed || adjustable.length !== count;
  return { message: changed ? `Set ${count} runs for ${prefix}.` : `${prefix} already has ${count} waiting runs.` };
}
