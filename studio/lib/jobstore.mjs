// lib/jobstore.mjs — queue + history + archive, persisted (zero deps; node:fs, node:path only)
//
// Contract: see lib/INTERFACES.md §lib/jobstore.mjs and ../PLAN.md §2 (Job shape).
//   export function createJobStore({ stateDir }) -> store
//
// Persistence:
//   - jobs       -> <stateDir>/jobs.json   (keep the most recent 500)
//   - archive    -> <stateDir>/archive.json (array of archived relPaths)
//   Loaded on create (missing/corrupt -> empty). Saved atomically after every mutation.

import fs from 'node:fs';
import path from 'node:path';

const MAX_JOBS = 500;

// Sanitize one path segment the same way the rest of the studio backend does.
const seg = (s) => String(s).replace(/[^a-zA-Z0-9_-]+/g, '-');

export function createJobStore({ stateDir }) {
  const jobsFile = path.join(stateDir, 'jobs.json');
  const archiveFile = path.join(stateDir, 'archive.json');

  // --- in-memory state ---------------------------------------------------
  let jobs = [];                  // most-recent-first is not required; we keep enqueue order
  const archived = new Set();     // archived relPaths
  let counter = 0;                // monotonic id suffix
  const listeners = [];           // 'change' callbacks (tiny built-in emitter)

  // --- persistence helpers ----------------------------------------------
  function ensureDir() {
    try {
      fs.mkdirSync(stateDir, { recursive: true });
    } catch {
      // best-effort; writes below will surface real problems
    }
  }

  function readJSON(file) {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      return JSON.parse(raw);
    } catch {
      return undefined; // missing or corrupt -> treated as empty by caller
    }
  }

  function writeAtomic(file, data) {
    ensureDir();
    const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
      fs.renameSync(tmp, file);
    } catch (err) {
      // clean up the temp file if the rename never happened
      try { fs.unlinkSync(tmp); } catch {}
      throw err;
    }
  }

  function load() {
    const loadedJobs = readJSON(jobsFile);
    if (Array.isArray(loadedJobs)) {
      jobs = loadedJobs.filter((j) => j && typeof j === 'object' && typeof j.id === 'string');
      // Reconcile orphans: a job left 'running' means the process died mid-generation — no worker
      // owns it now, so mark it 'failed' (never leave a perpetual fake "running" run after restart).
      for (const j of jobs) {
        if (j.status === 'running') { j.status = 'failed'; j.error = j.error || 'interrupted (server restarted)'; }
      }
      // Recover the counter so new ids never collide with persisted ones.
      for (const j of jobs) {
        const m = /_(\d+)$/.exec(j.id || '');
        if (m) {
          const n = Number(m[1]);
          if (Number.isFinite(n) && n >= counter) counter = n + 1;
        }
      }
    }

    const loadedArchive = readJSON(archiveFile);
    if (Array.isArray(loadedArchive)) {
      for (const p of loadedArchive) {
        if (typeof p === 'string') archived.add(p);
      }
    }
  }

  function saveJobs() {
    // Keep only the most recent MAX_JOBS (jobs is in enqueue order; recent = tail).
    if (jobs.length > MAX_JOBS) jobs = jobs.slice(jobs.length - MAX_JOBS);
    writeAtomic(jobsFile, jobs);
  }

  function saveArchive() {
    writeAtomic(archiveFile, [...archived]);
  }

  // Fire 'change' after EVERY mutation. Persist first, then notify.
  function emitChange() {
    for (const cb of listeners.slice()) {
      try { cb(); } catch { /* a bad listener must not break the store */ }
    }
  }

  function find(id) {
    return jobs.find((j) => j.id === id);
  }

  // --- mutations ---------------------------------------------------------
  function enqueue(spec = {}) {
    const {
      brand, batch, ad, variation, prompt,
      run = 1, variants = 1, promptText, size, ref,
    } = spec;

    const id = `${seg(ad)}_${seg(variation)}_${seg(prompt)}_r${run}_${counter++}`;
    const job = {
      id,
      brand, batch, ad, variation, prompt,
      run: Number(run) || 1,
      variants: Number(variants) || 1,
      // generation inputs carried for the worker / gen.mjs
      promptText,
      size,
      ref,
      status: 'queued',
      relPath: undefined,
      error: undefined,
      enqueuedAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      attempts: 0,
    };
    jobs.push(job);
    saveJobs();
    emitChange();
    return job;
  }

  // Atomically pick the oldest 'queued' job, flip it to 'running'.
  function nextQueued() {
    let pick = null;
    for (const j of jobs) {
      if (j.status === 'queued') {
        if (!pick || (j.enqueuedAt ?? 0) < (pick.enqueuedAt ?? 0)) pick = j;
      }
    }
    if (!pick) return null;
    pick.status = 'running';
    pick.startedAt = Date.now();
    saveJobs();
    emitChange();
    return pick;
  }

  function complete(id, { relPath } = {}) {
    const job = find(id);
    if (!job) return null;
    job.status = 'done';
    job.relPath = relPath;
    job.error = undefined;
    job.finishedAt = Date.now();
    saveJobs();
    emitChange();
    return job;
  }

  function fail(id, error) {
    const job = find(id);
    if (!job) return null;
    job.status = 'failed';
    job.error = error != null ? String(error) : undefined;
    job.finishedAt = Date.now();
    job.attempts = (job.attempts || 0) + 1;
    saveJobs();
    emitChange();
    return job;
  }

  function requeue(id) {
    const job = find(id);
    if (!job) return null;
    job.status = 'queued';
    job.startedAt = null;
    job.finishedAt = null;
    // Re-queue at the back of the line: refresh enqueuedAt so it runs after current work.
    job.enqueuedAt = Date.now();
    saveJobs();
    emitChange();
    return job;
  }

  function cancel({ jobId, all } = {}) {
    let changed = 0;
    for (const j of jobs) {
      const active = j.status === 'queued' || j.status === 'running';
      if (!active) continue;
      if (all || j.id === jobId) {
        j.status = 'canceled';
        j.finishedAt = Date.now();
        changed++;
        if (jobId && !all) break;
      }
    }
    if (changed) {
      saveJobs();
      emitChange();
    }
    return changed;
  }

  // --- queries -----------------------------------------------------------
  function get(id) {
    return find(id) || null;
  }

  function list() {
    // Most recent first.
    return jobs.slice().reverse();
  }

  function forBatch(brand, batch) {
    return jobs.filter((j) => j.brand === brand && j.batch === batch);
  }

  function counts() {
    const c = { running: 0, queued: 0, done: 0, failed: 0 };
    for (const j of jobs) {
      if (j.status === 'running') c.running++;
      else if (j.status === 'queued') c.queued++;
      else if (j.status === 'done') c.done++;
      else if (j.status === 'failed') c.failed++;
    }
    return c;
  }

  // --- archive -----------------------------------------------------------
  function isArchived(relPath) {
    return archived.has(relPath);
  }

  function setArchived(relPath, bool) {
    if (relPath == null) return;
    const wanted = !!bool;
    const has = archived.has(relPath);
    if (wanted === has) return; // no-op, no mutation
    if (wanted) archived.add(relPath);
    else archived.delete(relPath);
    saveArchive();
    emitChange();
  }

  function archivedCount(brand, batch) {
    const prefix = `${seg(brand)}/${seg(batch)}/`;
    let n = 0;
    for (const p of archived) {
      if (typeof p === 'string' && p.startsWith(prefix)) n++;
    }
    return n;
  }

  // --- emitter -----------------------------------------------------------
  function on(event, cb) {
    if (event === 'change' && typeof cb === 'function') listeners.push(cb);
  }

  function off(event, cb) {
    if (event !== 'change') return;
    const i = listeners.indexOf(cb);
    if (i !== -1) listeners.splice(i, 1);
  }

  // --- init --------------------------------------------------------------
  ensureDir();
  load();

  return {
    enqueue,
    nextQueued,
    complete,
    fail,
    requeue,
    cancel,
    get,
    list,
    forBatch,
    counts,
    isArchived,
    setArchived,
    archivedCount,
    on,
    off,
  };
}
