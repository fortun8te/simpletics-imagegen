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
const MAX_DURATION_SAMPLES = 20; // rolling-average window for completed-job duration
// How long a `failed` / `canceled` record lingers before the periodic sweep drops it (Area 2). This
// is what makes the "Failed" nag drain to 0 on its own instead of piling up red tiles forever. The
// server can override via FAILED_TTL (ms); tests pass a short value through the factory option.
const DEFAULT_FAILED_TTL = 45_000;

// Sanitize one path segment the same way the rest of the studio backend does.
const seg = (s) => String(s).replace(/[^a-zA-Z0-9_-]+/g, '-');

export function createJobStore({ stateDir, failedTtl } = {}) {
  const jobsFile = path.join(stateDir, 'jobs.json');
  const archiveFile = path.join(stateDir, 'archive.json');
  // Auto-clear TTL for failed/canceled records (Area 2). Precedence: explicit option > env > default.
  const FAILED_TTL = (() => {
    if (Number.isFinite(Number(failedTtl)) && Number(failedTtl) >= 0) return Number(failedTtl);
    const env = Number(process.env.FAILED_TTL);
    if (Number.isFinite(env) && env >= 0) return env;
    return DEFAULT_FAILED_TTL;
  })();

  // --- in-memory state ---------------------------------------------------
  let jobs = [];                  // most-recent-first is not required; we keep enqueue order
  const archived = new Set();     // archived relPaths
  let counter = 0;                // monotonic id suffix
  let orderCounter = 0;           // monotonic queue-priority suffix (lower = earlier in line)
  const listeners = [];           // 'change' callbacks (tiny built-in emitter)

  // Rolling average of completed-job duration (ms), in-memory only (does not survive a restart —
  // not persisted by design, per ../PLAN.md scope: this is a live estimate, not history).
  const durationSamples = []; // last MAX_DURATION_SAMPLES { ms } from done/failed jobs with both timestamps

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
        if (j.status === 'running') { j.status = 'failed'; j.reason = j.reason || 'other'; j.error = j.error || 'interrupted (server restarted)'; }
        // A `waiting` job never spent Codex (the grace timer hadn't fired) — the timer died with the
        // process, so just drop it back to 'queued' to be re-armed cleanly rather than failing it.
        else if (j.status === 'waiting') { j.status = 'queued'; j.spendAt = null; }
      }
      // Recover the counter so new ids never collide with persisted ones.
      for (const j of jobs) {
        const m = /_(\d+)$/.exec(j.id || '');
        if (m) {
          const n = Number(m[1]);
          if (Number.isFinite(n) && n >= counter) counter = n + 1;
        }
      }
      // Recover the order counter so freshly enqueued jobs always sort after restored ones.
      for (const j of jobs) {
        const o = Number(j.order);
        if (Number.isFinite(o) && o >= orderCounter) orderCounter = o + 1;
      }
      // Backfill `order` for jobs persisted before this field existed, preserving enqueuedAt order.
      let needsBackfill = jobs.some((j) => j.status === 'queued' && !Number.isFinite(Number(j.order)));
      if (needsBackfill) {
        const queuedByEnqueue = jobs
          .filter((j) => j.status === 'queued')
          .sort((a, b) => (a.enqueuedAt ?? 0) - (b.enqueuedAt ?? 0));
        for (const j of queuedByEnqueue) {
          if (!Number.isFinite(Number(j.order))) j.order = orderCounter++;
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

  // Auto-clear (Area 2): drop 'failed' / 'canceled' records whose finishedAt is older than FAILED_TTL
  // so the "Failed" nag drains to 0 on its own. 'done' records are kept (bounded by MAX_JOBS). Called
  // by a periodic timer AND lazily before any read (counts/forBatch/list) so exposed counts never
  // include an already-expired record even between ticks. Returns true if anything was removed.
  function sweepExpired() {
    if (!(FAILED_TTL >= 0)) return false;
    const now = Date.now();
    const before = jobs.length;
    jobs = jobs.filter((j) => {
      if (j.status !== 'failed' && j.status !== 'canceled') return true;
      // Use the most recent known timestamp; a record with no usable timestamp (legacy jobs from
      // before this field existed, or orphans) resolves to 0 → treated as long-expired and swept,
      // so failures can never get permanently stuck in the "Failed" nag.
      const fin = Number(j.finishedAt) || Number(j.startedAt) || Number(j.enqueuedAt) || 0;
      return !((now - fin) >= FAILED_TTL);
    });
    return jobs.length !== before;
  }

  // Public sweep: run the auto-clear and persist/notify if it removed anything.
  function sweep() {
    if (sweepExpired()) { saveJobs(); emitChange(); return true; }
    return false;
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
      reason: undefined,     // failure class (auth|rate_limit|other), set by fail()
      spendAt: null,         // waiting-window spawn deadline (epoch ms), set by beginWaiting()
      enqueuedAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      attempts: 0,
      // Queue priority: lower runs first. Defaults to enqueue order; reorder() can rewrite it so a
      // dragged-up queued job actually runs sooner (see ../PLAN.md "draggable queue reorder").
      order: orderCounter++,
    };
    jobs.push(job);
    saveJobs();
    emitChange();
    return job;
  }

  // Atomically pick the queued job with the lowest `order` (ties broken by enqueuedAt) and flip it
  // into the next lifecycle state. `order` is what reorder() rewrites, so this is what makes a
  // drag-drop reorder a REAL priority change rather than a cosmetic one.
  //
  // Waiting window (Area 1): pass { toWaiting:true, spendAt } to flip the job to 'waiting' with its
  // spawn deadline (it occupies a concurrency slot but hasn't spent Codex). Default (no opts, or
  // graceSeconds===0) flips straight to 'running' as before. This single atomic pick preserves the
  // worker's reentrancy invariants (the pick happens before running++ in the worker).
  function nextQueued({ toWaiting = false, spendAt = null } = {}) {
    let pick = null;
    for (const j of jobs) {
      if (j.status === 'queued') {
        if (!pick
          || (j.order ?? 0) < (pick.order ?? 0)
          || ((j.order ?? 0) === (pick.order ?? 0) && (j.enqueuedAt ?? 0) < (pick.enqueuedAt ?? 0))) {
          pick = j;
        }
      }
    }
    if (!pick) return null;
    if (toWaiting) {
      pick.status = 'waiting';
      pick.spendAt = Number(spendAt) || Date.now();
    } else {
      pick.status = 'running';
      pick.spendAt = null;
      pick.startedAt = Date.now();
    }
    saveJobs();
    emitChange();
    return pick;
  }

  // Promote a 'waiting' job to 'running' when its grace timer fires (Area 1). No-op (returns null)
  // if the job was canceled/paused-away or is no longer 'waiting' — the worker checks the return so
  // it never spawns a job that slipped out of the waiting state under it.
  function promote(id) {
    const job = find(id);
    if (!job || job.status !== 'waiting') return null;
    job.status = 'running';
    job.spendAt = null;
    job.startedAt = Date.now();
    saveJobs();
    emitChange();
    return job;
  }

  // Record a completed job's wall-clock duration into the rolling average window. Only meaningful
  // generations (both startedAt and finishedAt present) count.
  function recordDuration(job) {
    if (!job || !job.startedAt || !job.finishedAt) return;
    const ms = job.finishedAt - job.startedAt;
    if (!Number.isFinite(ms) || ms <= 0) return;
    durationSamples.push(ms);
    if (durationSamples.length > MAX_DURATION_SAMPLES) durationSamples.shift();
  }

  function complete(id, { relPath } = {}) {
    const job = find(id);
    if (!job || job.status === 'canceled') return null;
    job.status = 'done';
    job.relPath = relPath;
    job.error = undefined;
    job.reason = undefined;
    job.spendAt = null;
    job.finishedAt = Date.now();
    recordDuration(job);
    saveJobs();
    emitChange();
    return job;
  }

  function fail(id, error, reason) {
    const job = find(id);
    if (!job || job.status === 'canceled') return null;
    job.status = 'failed';
    job.error = error != null ? String(error) : undefined;
    // Failure class (Area 2): auth | rate_limit | other. Defaults to 'other' when unclassified.
    job.reason = reason === 'auth' || reason === 'rate_limit' ? reason : 'other';
    job.spendAt = null;
    job.finishedAt = Date.now();
    job.attempts = (job.attempts || 0) + 1;
    recordDuration(job);
    saveJobs();
    emitChange();
    return job;
  }

  // Average completed-job duration in seconds, from the last MAX_DURATION_SAMPLES done/failed jobs.
  // Falls back to a reasonable default (30s) when there's no history yet — never returns nothing.
  function avgDurationSeconds() {
    if (durationSamples.length === 0) return { seconds: 30, samples: 0, fallback: true };
    const avgMs = durationSamples.reduce((a, b) => a + b, 0) / durationSamples.length;
    return { seconds: Math.round(avgMs / 1000), samples: durationSamples.length, fallback: false };
  }

  // `countsAsAttempt` (default true): whether this requeue burns one of the job's 3 retry attempts.
  // The worker passes false for RATE_LIMIT requeues (a 429 isn't the job's fault — don't burn a
  // retry on it) and true for ordinary-failure retries. Without this the ordinary-failure retry
  // loop in worker.mjs never advances `attempts` (only fail() used to increment it, which is
  // unreachable while attempts stays 0 < 3 forever) — a job with a persistent non-rate-limit error
  // would retry forever instead of giving up after 3 tries, silently eating a concurrency slot.
  function requeue(id, { countsAsAttempt = true } = {}) {
    const job = find(id);
    if (!job || job.status === 'canceled') return null;
    job.status = 'queued';
    job.startedAt = null;
    job.finishedAt = null;
    job.reason = undefined;
    job.spendAt = null;
    if (countsAsAttempt) job.attempts = (job.attempts || 0) + 1;
    // Re-queue at the back of the line: refresh enqueuedAt AND order so it runs after current work.
    job.enqueuedAt = Date.now();
    job.order = orderCounter++;
    saveJobs();
    emitChange();
    return job;
  }

  // Reorder QUEUED jobs for one brand/batch. `orderedIds` is the full desired front-to-back order of
  // that batch's currently-queued job ids (as dragged in the UI). Jobs are rewritten with fresh,
  // strictly increasing `order` values matching that sequence — so nextQueued() (and therefore the
  // worker) actually honors it, not just the displayed list. Ids not in this batch's queued set, or
  // not 'queued' anymore (e.g. picked up mid-drag), are ignored rather than erroring. Returns the
  // count of jobs actually reordered.
  function reorder(brand, batch, orderedIds) {
    if (!Array.isArray(orderedIds) || orderedIds.length === 0) return 0;
    const queuedInBatch = new Map();
    for (const j of jobs) {
      if (j.status === 'queued' && j.brand === brand && j.batch === batch) queuedInBatch.set(j.id, j);
    }
    if (queuedInBatch.size === 0) return 0;

    // Base the new order values below the current minimum so reordered jobs immediately take
    // priority over any queued job NOT in this batch (cross-batch interleaving stays first-queued).
    let base = orderCounter;
    for (const j of jobs) {
      if (j.status === 'queued' && Number.isFinite(Number(j.order)) && j.order < base) base = j.order;
    }

    let n = 0;
    let next = base;
    const seen = new Set();
    for (const id of orderedIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      const job = queuedInBatch.get(id);
      if (!job) continue; // not queued / not in this batch anymore — skip rather than error
      job.order = next++;
      n++;
    }
    if (n === 0) return 0;
    // Keep orderCounter ahead of every order value we just assigned (and any pre-existing ones) so
    // future enqueue()/requeue() calls never collide with the reordered block.
    if (next > orderCounter) orderCounter = next;
    saveJobs();
    emitChange();
    return n;
  }

  function cancel({ jobId, all } = {}) {
    let changed = 0;
    for (const j of jobs) {
      // 'waiting' is an active state that occupies a slot (Area 1) — it must be cancelable so a job
      // can be stopped BEFORE it spawns (no Codex spent). The worker clears its grace timer on the
      // 'change' this emits (it re-checks each waiting job's live status when the timer fires).
      const active = j.status === 'queued' || j.status === 'waiting' || j.status === 'running';
      if (!active) continue;
      if (all || j.id === jobId) {
        j.status = 'canceled';
        j.spendAt = null;
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

  // Remove job records now (Area 2 manual clear). `scope` ∈ 'failed'|'canceled'|'done'|'all',
  // optionally narrowed to a brand/batch. Only ever removes terminal records (failed/canceled/done) —
  // never queued/waiting/running (use cancel() for those). Returns the count removed.
  function clear({ scope = 'failed', brand, batch } = {}) {
    const terminal = new Set(['failed', 'canceled', 'done']);
    const wanted = scope === 'all' ? terminal : new Set([scope].filter((s) => terminal.has(s)));
    if (wanted.size === 0) return 0;
    const before = jobs.length;
    jobs = jobs.filter((j) => {
      if (!wanted.has(j.status)) return true;
      if (brand != null && j.brand !== brand) return true;
      if (batch != null && j.batch !== batch) return true;
      return false; // matches scope (+ optional brand/batch) → remove
    });
    const removed = before - jobs.length;
    if (removed) { saveJobs(); emitChange(); }
    return removed;
  }

  // Requeue failed jobs (Area 2 retry): reset attempts to 0 and flip back to 'queued' so the worker
  // picks them up again. Optionally scoped to a brand/batch. Returns the count requeued.
  function retryFailed({ brand, batch } = {}) {
    let n = 0;
    for (const j of jobs) {
      if (j.status !== 'failed') continue;
      if (brand != null && j.brand !== brand) continue;
      if (batch != null && j.batch !== batch) continue;
      j.status = 'queued';
      j.attempts = 0;
      j.error = undefined;
      j.reason = undefined;
      j.spendAt = null;
      j.startedAt = null;
      j.finishedAt = null;
      j.enqueuedAt = Date.now();
      j.order = orderCounter++;
      n++;
    }
    if (n) { saveJobs(); emitChange(); }
    return n;
  }

  // --- queries -----------------------------------------------------------
  function get(id) {
    return find(id) || null;
  }

  function list() {
    sweepExpired(); // don't surface already-expired failed/canceled records (Area 2)
    // Most recent first.
    return jobs.slice().reverse();
  }

  function forBatch(brand, batch) {
    sweepExpired();
    return jobs.filter((j) => j.brand === brand && j.batch === batch);
  }

  function counts() {
    sweepExpired();
    const c = { running: 0, queued: 0, waiting: 0, done: 0, failed: 0 };
    for (const j of jobs) {
      if (j.status === 'running') c.running++;
      else if (j.status === 'queued') c.queued++;
      else if (j.status === 'waiting') c.waiting++;
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

  // Periodic auto-clear sweep (Area 2). Runs on a fixed interval so expired failed/canceled records
  // are dropped even with no reads/mutations happening. unref'd so it never keeps the process alive
  // (matters for the throwaway test scripts). Skipped when TTL is disabled (<0, never used here).
  let sweepTimer = null;
  if (FAILED_TTL >= 0) {
    const period = Math.max(1000, Math.min(FAILED_TTL || DEFAULT_FAILED_TTL, DEFAULT_FAILED_TTL));
    sweepTimer = setInterval(() => { try { sweep(); } catch {} }, period);
    if (sweepTimer.unref) sweepTimer.unref();
  }

  return {
    enqueue,
    nextQueued,
    promote,
    complete,
    fail,
    requeue,
    cancel,
    clear,
    retryFailed,
    reorder,
    sweep,
    get,
    list,
    forBatch,
    counts,
    avgDurationSeconds,
    isArchived,
    setArchived,
    archivedCount,
    on,
    off,
    // Stop the periodic sweep timer (used by tests; the server runs for the process lifetime).
    dispose() { if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; } },
  };
}
