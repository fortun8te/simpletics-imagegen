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
// Zero external deps: node:* only (gen.mjs is dynamically imported by spec).

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
 * @returns {{ start:Function, stop:Function, status:Function, busy:Function }}
 */
export function createWorker({ store, renders, repoDir, concurrency = 3, cooldownMin = 30, onChange } = {}) {
  let running = 0;          // count of in-flight generateSlot calls
  let paused = false;       // true while cooling down after a rate limit
  let resumeAt = null;      // epoch ms the cooldown ends (null when not paused)
  let runningWorker = false; // true between start() and stop()
  let interval = null;      // the 1s safety-tick interval handle
  let cooldownTimer = null; // the setTimeout that ends a cooldown

  const notify = () => { try { onChange && onChange(); } catch {} };

  // Pull and run as many queued jobs as capacity allows. Each finished job re-ticks so the freed
  // slot is immediately refilled. Guarded so it never runs while stopped or paused.
  function tick() {
    if (!runningWorker || paused) return;
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

    if (res && res.ok) {
      store.complete(job.id, { relPath: res.relPath });
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
    if (paused) return; // already cooling down; a concurrent rate limit just piles onto the same wait
    paused = true;
    resumeAt = Date.now() + cooldownMin * 60 * 1000;
    notify(); // surface paused/resumeAt to the UI
    clearTimeout(cooldownTimer);
    cooldownTimer = setTimeout(() => {
      paused = false;
      resumeAt = null;
      cooldownTimer = null;
      notify();
      tick(); // resume pulling jobs
    }, cooldownMin * 60 * 1000);
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
    // Leave `paused`/`resumeAt` as-is so status() still reports an in-progress cooldown if asked.
  }

  function status() {
    return { running, paused, resumeAt };
  }

  // The worker is "busy" while any job is in flight OR while it's cooling down (a pause means work
  // is pending and codex is effectively engaged with this batch).
  function busy() {
    return running > 0 || paused;
  }

  return { start, stop, status, busy };
}
