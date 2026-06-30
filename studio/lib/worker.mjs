// lib/worker.mjs — the generation engine (backend-owned; replaces terminal runs).
//
// The worker is the studio's replacement for launching codexbatch from a terminal. It watches the
// job store and, whenever there is spare capacity, pulls the oldest queued job and renders it via
// lib/gen.mjs's `generateSlot` (the proven codexbatch core, factored to one slot). It ticks on three
// triggers so it never stalls: (1) the store's 'change' event (a new job was enqueued), (2) each job
// finishing (capacity just freed up), and (3) a 1s safety interval (belt-and-suspenders).
//
// Auto-resume on rate limits is backend-owned here: when gen.mjs returns an error prefixed
// 'RATE_LIMIT:' the job is requeued and the whole worker pauses for `cooldownMin` minutes, then
// resumes — exactly what codex-runner.mjs used to do from the terminal. Other errors retry up to 3
// attempts, then the job is marked failed. After every state transition `onChange()` is called so the
// server can broadcast the change over SSE.
//
// Run state machine (NEUEGEN v3): the worker is the single source of truth for the run's lifecycle.
// `runState()` reports one of idle | running | paused | cooling | done plus `resumeAt`:
//   - running : at least one job is in flight.
//   - paused  : the user pressed Pause (pause()); the worker stops pulling NEW jobs but in-flight
//               jobs finish. resume() lifts it.
//   - cooling : a codex RATE_LIMIT triggered the auto-cooldown; resumeAt is when it auto-resumes.
//   - done    : nothing in flight, queue empty, and at least one job completed this run.
//   - idle    : nothing in flight, queue empty, nothing done yet.
// User-pause and rate-limit-cooling are tracked independently (a user can pause during a cooldown,
// and vice-versa); tick() refuses to pull while EITHER is active.
//
// Zero external deps: node:* only (gen.mjs is dynamically imported by spec).

import { isLimitReached } from './usage.mjs';

/**
 * Create the generation worker.
 *
 * @param {object}   opts
 * @param {object}   opts.store        the job store (createJobStore)
 * @param {string}   opts.renders      RENDERS dir (where images are written)
 * @param {string}   opts.repoDir      REPO dir (passed through to generateSlot for logic.js)
 * @param {number}   [opts.concurrency=3]
 * @param {number}   [opts.cooldownMin=30]
 * @param {Function} [opts.onChange]   called after every transition (drives SSE broadcast)
 * @param {Function} [opts.onRateLimit] called when a RATE_LIMIT cooldown begins, with { resumeAt }
 * @param {Function} [opts.onComplete]  called when a job completes successfully (drives usage count)
 * @returns {{ start:Function, stop:Function, status:Function, busy:Function,
 *            pause:Function, resume:Function, runState:Function }}
 */
export function createWorker({ store, renders, repoDir, concurrency = 3, cooldownMin = 30, onChange, onRateLimit, onComplete } = {}) {
  let running = 0;          // count of in-flight generateSlot calls
  let cooling = false;      // true while cooling down after a rate limit (auto-resumes)
  let userPaused = false;   // true while paused by the user (pause(); cleared by resume())
  let resumeAt = null;      // epoch ms the cooldown ends (null when not cooling)
  let didComplete = false;  // a job has completed since this run started (distinguishes done vs idle)
  let runAborted = false;   // user pressed Stop — force idle immediately; cleared on next enqueue
  let runningWorker = false; // true between start() and stop()
  let interval = null;      // the 1s safety-tick interval handle
  let cooldownTimer = null; // the setTimeout that ends a cooldown

  const notify = () => { try { onChange && onChange(); } catch {} };

  // The worker is "blocked" from pulling new jobs while either the user paused it or a rate-limit
  // cooldown is active. In-flight jobs always finish regardless.
  const blocked = () => userPaused || cooling || isLimitReached();

  // Pull and run as many queued jobs as capacity allows. Each finished job re-ticks so the freed
  // slot is immediately refilled. Guarded so it never runs while stopped or blocked.
  function tick() {
    if (!runningWorker || blocked()) return;
    const { queued } = store.counts();
    if (queued > 0 && runAborted) {
      runAborted = false;
      didComplete = false;
    }
    if (runAborted) return;
    while (running < concurrency) {
      const job = store.nextQueued(); // atomically flips the job to 'running'
      if (!job) break;
      running++;
      notify(); // a job just went 'running'
      runJob(job);
    }
  }

  async function runJob(job) {
    let res;
    try {
      const { generateSlot } = await import('./gen.mjs');
      res = await generateSlot(job, { renders, repoDir });
    } catch (e) {
      res = { ok: false, error: String((e && e.message) || e) };
    }

    running--;

    const current = store.get(job.id);
    if (!current || current.status === 'canceled') {
      notify();
      if (!runAborted) tick();
      return;
    }

    if (res && res.ok) {
      store.complete(job.id, { relPath: res.relPath });
      didComplete = true;
      try { onComplete && onComplete(job); } catch {}
      notify();
    } else {
      const error = (res && res.error) || 'unknown error';
      if (/^RATE_LIMIT:/.test(error)) {
        // Usage limit / 429 — don't burn a retry attempt. Requeue this job and pause the whole
        // worker for the cooldown window, then resume (the backend-owned auto-resume).
        store.requeue(job.id);
        notify();
        beginCooldown();
        return; // don't tick while paused
      }
      // Ordinary failure: retry up to 3 attempts, then give up and mark it failed.
      const current = store.get(job.id);
      const attempts = (current && current.attempts) || 0;
      if (attempts < 3) store.requeue(job.id);
      else store.fail(job.id, error);
      notify();
    }

    // Capacity just freed (or we just gave up on a job) — try to refill immediately.
    tick();
  }

  function beginCooldown() {
    if (cooling) return; // already cooling down; a concurrent rate limit just piles onto the same wait
    cooling = true;
    resumeAt = Date.now() + cooldownMin * 60 * 1000;
    try { onRateLimit && onRateLimit({ resumeAt }); } catch {} // let the usage probe note the hit
    notify(); // surface cooling/resumeAt to the UI
    clearTimeout(cooldownTimer);
    cooldownTimer = setTimeout(() => {
      cooling = false;
      resumeAt = null;
      cooldownTimer = null;
      notify();
      tick(); // resume pulling jobs (unless the user has also paused)
    }, cooldownMin * 60 * 1000);
  }

  // User Pause: stop pulling NEW jobs; in-flight jobs finish on their own. Idempotent.
  function pause() {
    if (userPaused) return;
    userPaused = true;
    notify();
  }

  // User Stop: cancel queued/in-flight jobs (via store.cancel) then call this to snap the run back to
  // idle immediately — clears pause/cooldown, suppresses further pulls until the user enqueues again.
  function abortRun() {
    let changed = false;
    if (userPaused) { userPaused = false; changed = true; }
    if (cooling) {
      cooling = false;
      resumeAt = null;
      clearTimeout(cooldownTimer);
      cooldownTimer = null;
      changed = true;
    }
    if (didComplete) { didComplete = false; changed = true; }
    if (!runAborted) { runAborted = true; changed = true; }
    if (changed) notify();
  }

  // User Resume: lift a user pause AND clear any active rate-limit cooldown (so a "Continue" or
  // "Reset" press resumes immediately rather than waiting out the cooldown), then refill capacity.
  function resume() {
    let changed = false;
    if (userPaused) { userPaused = false; changed = true; }
    if (cooling) {
      cooling = false;
      resumeAt = null;
      clearTimeout(cooldownTimer);
      cooldownTimer = null;
      changed = true;
    }
    if (changed) notify();
    tick();
  }

  function start() {
    if (runningWorker) return;
    runningWorker = true;
    // React to enqueues / external mutations.
    store.on('change', tick);
    // 1s safety net so we never wedge even if a 'change' is missed.
    interval = setInterval(tick, 1000);
    if (interval.unref) interval.unref();
    tick();
  }

  function stop() {
    runningWorker = false;
    store.off('change', tick);
    clearInterval(interval);
    interval = null;
    clearTimeout(cooldownTimer);
    cooldownTimer = null;
    // Leave `cooling`/`resumeAt` as-is so status() still reports an in-progress cooldown if asked.
  }

  function status() {
    // `paused` kept for back-compat: true while EITHER a user-pause or a rate-limit cooldown holds.
    return { running, paused: blocked(), userPaused, cooling, resumeAt };
  }

  // The worker is "busy" while any job is in flight OR while it's cooling down (a cooldown means work
  // is pending and codex is effectively engaged with this batch). A user-pause is NOT busy.
  function busy() {
    return running > 0 || cooling;
  }

  // The run-state machine the UI drives off of. Priority: cooling (a real rate-limit) > running >
  // paused (user) > done (work finished, queue drained) > idle.
  function runState() {
    if (runAborted) return { state: 'idle', resumeAt: null };
    const { queued } = store.counts();
    let state;
    if (cooling) state = 'cooling';
    else if (running > 0) state = 'running';
    else if (userPaused) state = 'paused';
    else if (queued === 0 && didComplete) state = 'done';
    else state = 'idle';
    return { state, resumeAt: cooling ? resumeAt : null };
  }

  return { start, stop, status, busy, pause, resume, abortRun, runState };
}
