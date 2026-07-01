// lib/worker.mjs — the generation engine (backend-owned; replaces terminal runs).
//
// The worker is the studio's replacement for launching codexbatch from a terminal. It watches the
// job store and, whenever there is spare capacity, pulls the oldest queued job and renders it via
// lib/gen.mjs's `generateSlot` (the proven codexbatch core, factored to one slot). It ticks on three
// triggers so it never stalls: (1) the store's 'change' event (a new job was enqueued), (2) each job
// finishing (capacity just freed up), and (3) a 1s safety interval (belt-and-suspenders).
//
// Rate-limit cooldown is backend-owned here: when gen.mjs returns an error prefixed 'RATE_LIMIT:'
// the job is requeued and the whole worker pauses for `cooldownMin` minutes, then moves to `ready`
// and waits for an explicit user "check & continue" (with a live Codex probe) — it does NOT
// auto-resume while you're away. Other errors retry up to 3
// attempts, then the job is marked failed. After every state transition `onChange()` is called so the
// server can broadcast the change over SSE.
//
// Run state machine (NEUEGEN v3): the worker is the single source of truth for the run's lifecycle.
// `runState()` reports one of idle | running | paused | cooling | done plus `resumeAt`:
//   - running : at least one job is in flight.
//   - paused  : the user pressed Pause (pause()); the worker stops pulling NEW jobs but in-flight
//               jobs finish. resume() lifts it.
//   - cooling : a codex RATE_LIMIT cooldown is counting down; resumeAt is when it becomes `ready`.
//   - ready   : the cooldown elapsed; waiting for the user to verify quota and continue.
//   - done    : nothing in flight, queue empty, and at least one job completed this run.
//   - idle    : nothing in flight, queue empty, nothing done yet.
// User-pause and rate-limit-cooling are tracked independently (a user can pause during a cooldown,
// and vice-versa); tick() refuses to pull while EITHER is active.
//
// Zero external deps: node:* only (gen.mjs is dynamically imported by spec).

import { isLimitReached, getGraceSeconds, noteAuthFailure } from './usage.mjs';
import { classifyError } from './gen.mjs';

// The generation concurrency limit: how many jobs run at once. This is the single source of
// truth for the default — callers (studio-server.mjs) may still override via the `concurrency`
// option (e.g. from process.env.CONCURRENCY), but this constant is what "X at a time" means when
// nothing else is configured. Tune this number to change default throughput.
export const MAX_CONCURRENT_JOBS = 3;

/**
 * Create the generation worker.
 *
 * @param {object}   opts
 * @param {object}   opts.store        the job store (createJobStore)
 * @param {string}   opts.renders      RENDERS dir (where images are written)
 * @param {string}   opts.repoDir      REPO dir (passed through to generateSlot for logic.js)
 * @param {number}   [opts.concurrency=MAX_CONCURRENT_JOBS]
 * @param {number}   [opts.cooldownMin=30]
 * @param {Function} [opts.onChange]   called after every transition (drives SSE broadcast)
 * @param {Function} [opts.onRateLimit] called when a RATE_LIMIT cooldown begins, with { resumeAt }
 * @param {Function} [opts.onComplete]  called when a job completes successfully (drives usage count)
 * @returns {{ start:Function, stop:Function, status:Function, busy:Function,
 *            pause:Function, resume:Function, runState:Function }}
 */
export function createWorker({ store, renders, repoDir, concurrency = MAX_CONCURRENT_JOBS, cooldownMin = 30, onChange, onRateLimit, onComplete, generate } = {}) {
  let running = 0;          // count of in-flight generateSlot calls
  // Waiting window (Area 1): jobs in the cancel-free grace phase. They OCCUPY a concurrency slot but
  // haven't spent Codex yet. jobId → timer handle. `waiting = waitTimers.size`. The concurrency cap
  // applies to running + waiting together (never exceeds `concurrency`).
  const waitTimers = new Map();
  let cooling = false;      // true while in a rate-limit cooldown (countdown or awaiting confirm)
  let rateLimitHold = false; // stays true after a rate-limit hit until a verified resume clears it
  let userPaused = false;   // true while paused by the user (pause(); cleared by resume())
  let resumeAt = null;      // epoch ms the cooldown ends (null when not cooling)
  let didComplete = false;  // a job has completed since this run started (distinguishes done vs idle)
  let runAborted = false;   // user pressed Stop — force idle immediately; cleared on next enqueue
  let runningWorker = false; // true between start() and stop()
  let interval = null;      // the 1s safety-tick interval handle
  let cooldownTimer = null; // the setTimeout that ends a cooldown
  let inTick = false;       // reentrancy guard for tick() — see note below

  const notify = () => { try { onChange && onChange(); } catch {} };

  // The worker is "blocked" from pulling new jobs while either the user paused it or a rate-limit
  // cooldown is active. In-flight jobs always finish regardless.
  const blocked = () => userPaused || cooling || isLimitReached();

  // Pull and run as many queued jobs as capacity allows. Each finished job re-ticks so the freed
  // slot is immediately refilled. Guarded so it never runs while stopped or blocked.
  //
  // Reentrancy guard (`inTick`): store.nextQueued() fires the store's 'change' event synchronously
  // (via emitChange()) BEFORE returning the picked job — and tick() itself is registered as a
  // 'change' listener (see start()). Without this guard, calling nextQueued() on line below
  // re-enters tick() from inside its own while-loop, at a point where `running` has NOT been
  // incremented yet for the job just picked (running++ is still pending later in this same
  // iteration). That nested call would see a stale, too-low `running` count and pull MORE jobs than
  // the concurrency limit allows — and it recurses once per queued job, so a big batch enqueued at
  // once could flip its ENTIRE queue to 'running' in one synchronous cascade, blowing straight past
  // `concurrency`. Guarding tick() to a single active frame makes nested calls a no-op; the outer
  // loop's own next iteration picks up any newly-freed capacity correctly once `running` is current.
  function tick() {
    if (!runningWorker || blocked() || inTick) return;
    inTick = true;
    try {
      const { queued } = store.counts();
      if (queued > 0 && runAborted) {
        runAborted = false;
        didComplete = false;
      }
      if (runAborted) return;
      // Concurrency cap covers BOTH in-flight (running) and grace-window (waiting) jobs, so a big
      // batch keeps only ~`concurrency` in-window and the rest stay 'queued'.
      const grace = Math.max(0, Number(getGraceSeconds()) || 0);
      while (running + waitTimers.size < concurrency) {
        if (grace === 0) {
          // No waiting phase: flip straight to 'running' and spawn (unchanged legacy behavior).
          const job = store.nextQueued(); // atomically flips the job to 'running'
          if (!job) break;
          running++;
          notify(); // a job just went 'running'
          runJob(job);
        } else {
          // Enter the cancel-free waiting window: flip to 'waiting' with a spawn deadline and arm a
          // timer. The slot is occupied by this waiting job; it becomes 'running' only when the timer
          // fires (Codex spent from there) — or is canceled first (no spend).
          const spendAt = Date.now() + grace * 1000;
          const job = store.nextQueued({ toWaiting: true, spendAt });
          if (!job) break;
          armWaiting(job.id, grace * 1000);
          notify(); // a job just went 'waiting'
        }
      }
    } finally {
      inTick = false;
    }
  }

  // Arm the grace timer for a 'waiting' job. On expiry, if the job is STILL waiting and we're not
  // paused/aborted, promote it to 'running' and spawn generateSlot(). If anything changed under us
  // (canceled, paused, or no longer waiting) we spawn nothing — the cardinal rule of the window is
  // "cancel during waiting never spends Codex".
  function armWaiting(jobId, ms) {
    clearTimeout(waitTimers.get(jobId));
    const t = setTimeout(() => {
      waitTimers.delete(jobId);
      spawnWaiting(jobId);
    }, ms);
    if (t.unref) t.unref();
    waitTimers.set(jobId, t);
  }

  // Fire a waiting job's spawn: promote 'waiting' → 'running' and start generateSlot(). Refuses to
  // spawn if the worker is paused/cooling/aborted (the job holds in 'waiting' — resume() re-arms it)
  // or if the job is no longer 'waiting' (canceled → store.promote() returns null, so no spawn).
  function spawnWaiting(jobId) {
    if (!runningWorker) return;
    const cur = store.get(jobId);
    if (!cur || cur.status !== 'waiting') return; // canceled or gone — never spawn (no spend)
    if (userPaused || cooling || runAborted) return; // hold; resume()/tick() will re-arm it
    // Claim the concurrency slot BEFORE store.promote() — promote() emits 'change' synchronously,
    // which re-enters tick(); if `running` weren't already incremented, that nested tick would see a
    // free slot (this job is no longer in waitTimers, not yet counted in running) and arm an EXTRA
    // waiter, briefly pushing waiting+running past the cap. Incrementing first keeps the cap exact.
    running++;
    const job = store.promote(jobId); // atomically flips 'waiting' → 'running'
    if (!job) { running--; return; } // slipped out from under us (canceled) — release the slot
    notify(); // a job just went 'running' (Codex spent from here)
    runJob(job);
    // A slot may have freed conceptually (waiting→running is net-zero on the cap) but re-tick so any
    // queued job can enter the window now that this one committed.
    tick();
  }

  // Cancel any armed grace timers whose job is no longer 'waiting' (e.g. canceled via store.cancel()
  // from an HTTP route). Called on every store 'change' so a cancel during the window promptly clears
  // its timer and frees the slot. Timers whose job is still 'waiting' are left running.
  function reconcileWaiters() {
    for (const [jobId, timer] of waitTimers) {
      const cur = store.get(jobId);
      if (!cur || cur.status !== 'waiting') {
        clearTimeout(timer);
        waitTimers.delete(jobId);
      }
    }
  }

  // Drop ALL waiting timers (used by abortRun). The store transitions the jobs themselves.
  function clearAllWaiters() {
    for (const timer of waitTimers.values()) clearTimeout(timer);
    waitTimers.clear();
  }

  async function runJob(job) {
    let res;
    try {
      // `generate` is injectable (tests pass a mock); default is the real gen.mjs single-slot core.
      const generateSlot = generate || (await import('./gen.mjs')).generateSlot;
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
      // Failure classification (Area 2): prefer gen.mjs's tag, else derive from the error text.
      const reason = (res && res.reason) || classifyError(error);
      if (reason === 'rate_limit' || /^RATE_LIMIT:/.test(error)) {
        // Usage limit / 429 — don't burn a retry attempt. Requeue this job and pause the whole
        // worker for the cooldown window, then resume (the backend-owned auto-resume).
        store.requeue(job.id, { countsAsAttempt: false });
        notify();
        beginCooldown();
        return; // don't tick while paused
      }
      // Dead codex sign-in: record it so blockers.auth stays true even after this failed record is
      // auto-cleared. (We still run the ordinary retry path below — attempts cap eventually fails it.)
      if (reason === 'auth') { try { noteAuthFailure(); } catch {} }
      // Ordinary failure: retry up to 3 attempts, then give up and mark it failed with its reason.
      // requeue() bumps `attempts` for us, so check the CURRENT count before requeuing (i.e. attempts
      // so far) — once 3 failures have already happened, stop retrying.
      const cur = store.get(job.id);
      const attempts = (cur && cur.attempts) || 0;
      if (attempts < 3) store.requeue(job.id);
      else store.fail(job.id, error, reason);
      notify();
    }

    // Capacity just freed (or we just gave up on a job) — try to refill immediately.
    tick();
  }

  function beginCooldown() {
    if (cooling) return; // already cooling down; a concurrent rate limit just piles onto the same wait
    rateLimitHold = true;
    cooling = true;
    clearAllWaiters(); // freeze the waiting window during a cooldown; rearmWaiters() restores it
    resumeAt = Date.now() + cooldownMin * 60 * 1000;
    try { onRateLimit && onRateLimit({ resumeAt }); } catch {} // let the usage probe note the hit
    notify(); // surface cooling/resumeAt to the UI
    clearTimeout(cooldownTimer);
    cooldownTimer = setTimeout(() => {
      cooldownReady = true;
      cooldownTimer = null;
      notify(); // UI shows the ready prompt — no auto-resume
    }, cooldownMin * 60 * 1000);
  }

  // User dismissed the ready prompt ("not now") — keep the queue but hold until they continue.
  function dismissReady() {
    if (!cooldownReady) return;
    cooldownReady = false;
    cooling = false;
    resumeAt = null;
    userPaused = true;
    notify();
  }

  // User Pause: stop pulling NEW jobs; in-flight jobs finish on their own. Idempotent.
  function pause() {
    if (userPaused) return;
    userPaused = true;
    // Freeze the waiting window: clear the grace timers so nothing spawns while paused. The jobs
    // stay in 'waiting' (still occupying their slots); resume() re-arms a fresh grace window.
    clearAllWaiters();
    notify();
  }

  // Re-arm grace timers for any jobs currently in 'waiting' that have no live timer (e.g. after a
  // pause froze them, or a timer fired while blocked). Uses a fresh full grace window from now.
  function rearmWaiters() {
    const grace = Math.max(0, Number(getGraceSeconds()) || 0);
    for (const j of store.list()) {
      if (j.status !== 'waiting') continue;
      if (waitTimers.has(j.id)) continue;
      if (grace === 0) { spawnWaiting(j.id); continue; }
      // Re-arm using the job's existing spendAt deadline (honor time already elapsed); if it's
      // already past, spawn on the next tick immediately.
      const remaining = Math.max(0, (Number(j.spendAt) || Date.now()) - Date.now());
      if (remaining === 0) spawnWaiting(j.id);
      else armWaiting(j.id, remaining);
    }
  }

  // User Stop: cancel queued/in-flight jobs (via store.cancel) then call this to snap the run back to
  // idle immediately — clears pause/cooldown, suppresses further pulls until the user enqueues again.
  function abortRun() {
    let changed = false;
    if (userPaused) { userPaused = false; changed = true; }
    if (cooling) {
      cooling = false;
      cooldownReady = false;
      resumeAt = null;
      clearTimeout(cooldownTimer);
      cooldownTimer = null;
      changed = true;
    }
    rateLimitHold = false;
    if (didComplete) { didComplete = false; changed = true; }
    if (!runAborted) { runAborted = true; changed = true; }
    // Clear every waiting grace timer — the store.cancel({all}) that precedes abortRun flips those
    // jobs to 'canceled', so their timers must never fire (no spawn, no spend).
    if (waitTimers.size) { clearAllWaiters(); changed = true; }
    if (changed) notify();
  }

  // User Resume: lift a user pause AND clear any active rate-limit hold, then refill capacity.
  // Callers that need a live quota check should probe first (see studio-server /api/resume).
  function resume() {
    let changed = false;
    if (userPaused) { userPaused = false; changed = true; }
    if (cooling) {
      cooling = false;
      cooldownReady = false;
      resumeAt = null;
      clearTimeout(cooldownTimer);
      cooldownTimer = null;
      changed = true;
    }
    rateLimitHold = false;
    if (changed) notify();
    rearmWaiters(); // re-arm any waiting jobs frozen by the pause/cooldown
    tick();
  }

  // Single 'change' handler: first reconcile the waiting timers (so an external cancel clears its
  // timer and frees the slot), then tick to refill capacity. Registered instead of bare tick().
  function onStoreChange() {
    reconcileWaiters();
    tick();
  }

  function start() {
    if (runningWorker) return;
    runningWorker = true;
    // React to enqueues / external mutations.
    store.on('change', onStoreChange);
    // 1s safety net so we never wedge even if a 'change' is missed.
    interval = setInterval(onStoreChange, 1000);
    if (interval.unref) interval.unref();
    tick();
  }

  function stop() {
    runningWorker = false;
    store.off('change', onStoreChange);
    clearAllWaiters();
    clearInterval(interval);
    interval = null;
    clearTimeout(cooldownTimer);
    cooldownTimer = null;
    // Leave `cooling`/`resumeAt` as-is so status() still reports an in-progress cooldown if asked.
  }

  function status() {
    // `paused` kept for back-compat: true while EITHER a user-pause or a rate-limit cooldown holds.
    return { running, waiting: waitTimers.size, paused: blocked(), userPaused, cooling, cooldownReady, rateLimitHold, resumeAt };
  }

  // The worker is "busy" while any job is in flight, in the waiting window, OR while it's cooling
  // down (all mean work is pending / codex is effectively engaged). A user-pause is NOT busy.
  function busy() {
    return running > 0 || waitTimers.size > 0 || cooling;
  }

  // The run-state machine the UI drives off of. Priority: cooling/ready (rate-limit) > running
  // (in-flight OR waiting-window) > paused (user) > done (work finished, queue drained) > idle.
  function runState() {
    if (runAborted) return { state: 'idle', resumeAt: null };
    const { queued } = store.counts();
    let state;
    if (cooling && cooldownReady) state = 'ready';
    else if (cooling) state = 'cooling';
    else if (running > 0 || waitTimers.size > 0) state = 'running';
    else if (userPaused) state = 'paused';
    else if (queued === 0 && didComplete) state = 'done';
    else state = 'idle';
    return { state, resumeAt: cooling && !cooldownReady ? resumeAt : null };
  }

  return { start, stop, status, busy, pause, resume, dismissReady, abortRun, runState };
}
