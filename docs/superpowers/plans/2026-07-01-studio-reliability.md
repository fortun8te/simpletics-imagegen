# Studio Reliability & Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make ImageGen Studio's generation pipeline tell the truth about failures instead of silently retrying a dead credential forever, close the one real hang risk in the generation subprocess, and turn the already-built-but-unreachable usage-limit and concurrency controls into real Settings features.

**Architecture:** A worker-level circuit breaker (3 consecutive identical failures ⇒ a new `blocked` run-state with a human-readable reason) layered on top of the existing pause/resume state machine in `lib/worker.mjs`; a bounded timeout around the generation subprocess in `lib/gen.mjs`; two new thin HTTP routes in `studio-server.mjs` wired to backend logic that already exists (`lib/usage.mjs`'s `setUsageLimit`, a new `worker.setConcurrency`). All new logic is covered by `node:test` unit/integration tests run against a local fake generation tool fixture — zero real Codex/OpenAI calls anywhere in this plan.

**Tech Stack:** Node.js (zero-dependency ESM, `node:*` only, matching the existing codebase convention), `node:test` + `node:assert/strict` for testing (built into Node, no new dependency), React + TypeScript + Zustand on the frontend (no new dependencies).

**Spec:** `docs/superpowers/specs/2026-07-01-studio-reliability-design.md`

---

## Notes for the implementer

- **No worktree.** This is a locally-run single-user app the user actively has open at `http://localhost:8788/` — implement directly on `main` in `/Users/michael/Downloads/NEUEGEN`, not an isolated worktree, since the change needs to land where the user's real server actually runs.
- **Zero real Codex/OpenAI calls.** Every test in this plan points `CHATGPT_IMAGEGEN` at a local fake tool (Task 1). Never unset that override to "test against the real thing" — the user has explicitly asked that nothing in this session triggers real generation.
- **The user's live `studio-server.mjs` process needs a restart to pick up any backend change** (`lib/*.mjs`, `studio-server.mjs` itself). That process is actively serving their browser tab. Don't kill/restart it without telling the user first — the final verification task (Task 14) calls this out explicitly.
- All file paths below are relative to `/Users/michael/Downloads/NEUEGEN/studio` unless prefixed otherwise.

---

### Task 1: Test fixture — a fake generation tool

**Files:**
- Create: `studio/test/fixtures/fake-imagegen.py`
- Modify: `studio/package.json`

- [ ] **Step 1: Write the fake tool**

This stands in for `chatgpt-imagegen.py` in every test below. It never touches the network. It reads the same `-o <path>` argument the real tool accepts and behaves according to two env vars: `FAKE_IMAGEGEN_MODE` (`success` default, `fail`, or `hang`) and `FAKE_IMAGEGEN_ERROR` (the stderr text to print in `fail` mode).

```python
#!/usr/bin/env python3
"""Fake chatgpt-imagegen.py stand-in for studio/test/*. Never touches the network.

Modes (via FAKE_IMAGEGEN_MODE env var):
  success (default) - writes a placeholder file at the -o path, exits 0.
  fail              - prints FAKE_IMAGEGEN_ERROR (or a default) to stderr, exits 1.
  hang              - sleeps 5s (long enough to exercise timeouts/concurrency in tests,
                       short enough that a test file never blocks for real), then exits 0
                       without writing an output file.
"""
import os
import sys
import time


def main():
    mode = os.environ.get("FAKE_IMAGEGEN_MODE", "success")
    args = sys.argv[1:]
    out_path = None
    for i, a in enumerate(args):
        if a == "-o" and i + 1 < len(args):
            out_path = args[i + 1]
            break

    if mode == "hang":
        time.sleep(5)
        return 0

    if mode == "fail":
        message = os.environ.get("FAKE_IMAGEGEN_ERROR", "fake failure for testing")
        print(message, file=sys.stderr)
        return 1

    if out_path:
        os.makedirs(os.path.dirname(out_path), exist_ok=True)
        with open(out_path, "wb") as f:
            f.write(b"FAKE_PNG_FOR_TESTS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 2: Smoke-test the fixture directly (no Node involved yet)**

Run:
```bash
cd /Users/michael/Downloads/NEUEGEN/studio
python3 test/fixtures/fake-imagegen.py "a prompt" -o /tmp/fake-imagegen-smoke.png --backend codex --size 1024x1024
echo "exit: $?"
test -f /tmp/fake-imagegen-smoke.png && echo "file written: ok"
rm -f /tmp/fake-imagegen-smoke.png

FAKE_IMAGEGEN_MODE=fail FAKE_IMAGEGEN_ERROR="token refresh failed: HTTP 401" \
  python3 test/fixtures/fake-imagegen.py "a prompt" -o /tmp/fake-imagegen-smoke.png --backend codex --size 1024x1024
echo "exit: $?"
```
Expected: first block prints `exit: 0` and `file written: ok`; second block prints `token refresh failed: HTTP 401` on stderr and `exit: 1`.

- [ ] **Step 3: Add a `test` script to package.json**

Modify `studio/package.json` — the `scripts` block currently reads:
```json
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "typecheck": "tsc --noEmit"
  },
```
Change it to:
```json
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "typecheck": "tsc --noEmit",
    "test": "node --test test/"
  },
```

- [ ] **Step 4: Commit**

```bash
cd /Users/michael/Downloads/NEUEGEN
git add studio/test/fixtures/fake-imagegen.py studio/package.json
git commit -m "test: add a fake generation tool fixture for studio backend tests"
```

---

### Task 2: Stop letting failed jobs pollute the ETA average

**Files:**
- Modify: `studio/lib/jobstore.mjs`
- Test: Create `studio/test/jobstore.test.mjs`

**Why:** `avgDurationSeconds()` feeds the GenerateDialog/TopBar ETA. `recordDuration()` is currently called from both `complete()` and `fail()` — a run of near-instant failures (like the current auth-dead jobs, each ~0.3–0.5s) drags the rolling average toward zero, making the ETA meaningless right when it matters most.

- [ ] **Step 1: Write the failing test**

Create `studio/test/jobstore.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJobStore } from '../lib/jobstore.mjs';

test('avgDurationSeconds ignores failed jobs', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'jobstore-test-'));
  try {
    const store = createJobStore({ stateDir });
    const job = store.enqueue({ brand: 'b', batch: 'x', ad: 'a', variation: 'v', prompt: 'p', run: 1, promptText: 't' });
    store.nextQueued(); // flips to running, sets startedAt
    // Force a large, unmistakable duration so a leak into the average would be obvious.
    const current = store.get(job.id);
    current.startedAt = Date.now() - 9_000_000; // ~2.5 hours "ago"
    store.fail(job.id, 'boom');
    const estimate = store.avgDurationSeconds();
    assert.equal(estimate.samples, 0, 'a failed job must not feed the rolling average');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd /Users/michael/Downloads/NEUEGEN/studio && npm test`
Expected: FAIL — `estimate.samples` is `1`, not `0` (the current code still records duration on failure).

- [ ] **Step 3: Fix it**

In `studio/lib/jobstore.mjs`, find `fail()`:
```js
  function fail(id, error) {
    const job = find(id);
    if (!job || job.status === 'canceled') return null;
    job.status = 'failed';
    job.error = error != null ? String(error) : undefined;
    job.finishedAt = Date.now();
    job.attempts = (job.attempts || 0) + 1;
    recordDuration(job);
    saveJobs();
    emitChange();
    return job;
  }
```
Remove the `recordDuration(job);` line:
```js
  function fail(id, error) {
    const job = find(id);
    if (!job || job.status === 'canceled') return null;
    job.status = 'failed';
    job.error = error != null ? String(error) : undefined;
    job.finishedAt = Date.now();
    job.attempts = (job.attempts || 0) + 1;
    saveJobs();
    emitChange();
    return job;
  }
```

- [ ] **Step 4: Run it again and confirm it passes**

Run: `cd /Users/michael/Downloads/NEUEGEN/studio && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/michael/Downloads/NEUEGEN
git add studio/lib/jobstore.mjs studio/test/jobstore.test.mjs
git commit -m "fix: don't let failed jobs pollute the rolling generation-time average"
```

---

### Task 3: Restarts requeue in-flight jobs instead of failing them

**Files:**
- Modify: `studio/lib/jobstore.mjs`
- Test: Modify `studio/test/jobstore.test.mjs`

**Why:** `load()` currently hard-marks any job that was `running` when the process last stopped as `failed` with `error: 'interrupted (server restarted)'`. 42 of the last 236 "failures" in the live `.state/jobs.json` are exactly this — not real generation failures. It should behave like any other failure: retry under the existing 3-attempt cap, then give up.

- [ ] **Step 1: Write the failing tests**

In `studio/test/jobstore.test.mjs`, change the top import line from:
```js
import { mkdtempSync, rmSync } from 'node:fs';
```
to:
```js
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
```
Then append these two tests to the end of the file:
```js
test('restart requeues an orphaned running job under the retry cap', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'jobstore-test-'));
  try {
    writeFileSync(join(stateDir, 'jobs.json'), JSON.stringify([
      { id: 'orphan_1', brand: 'b', batch: 'x', ad: 'a', variation: 'v', prompt: 'p', run: 1,
        status: 'running', attempts: 1, order: 5, enqueuedAt: 1000, startedAt: 2000, finishedAt: null },
    ]));
    const store = createJobStore({ stateDir });
    const job = store.get('orphan_1');
    assert.equal(job.status, 'queued');
    assert.equal(job.attempts, 2);
    assert.equal(job.startedAt, null);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('restart fails an orphaned running job once its retry cap is exhausted', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'jobstore-test-'));
  try {
    writeFileSync(join(stateDir, 'jobs.json'), JSON.stringify([
      { id: 'orphan_2', brand: 'b', batch: 'x', ad: 'a', variation: 'v', prompt: 'p', run: 1,
        status: 'running', attempts: 3, order: 5, enqueuedAt: 1000, startedAt: 2000, finishedAt: null },
    ]));
    const store = createJobStore({ stateDir });
    const job = store.get('orphan_2');
    assert.equal(job.status, 'failed');
    assert.equal(job.attempts, 4);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd /Users/michael/Downloads/NEUEGEN/studio && npm test`
Expected: FAIL on both new tests — the current code always sets `status: 'failed'` and never touches `attempts` for an orphaned job, so `orphan_1` comes back `failed` (expected `queued`) and `orphan_2` comes back with `attempts: 3` (expected `4`).

- [ ] **Step 3: Fix it**

In `studio/lib/jobstore.mjs`, find this block inside `load()`:
```js
      // Reconcile orphans: a job left 'running' means the process died mid-generation — no worker
      // owns it now, so mark it 'failed' (never leave a perpetual fake "running" run after restart).
      for (const j of jobs) {
        if (j.status === 'running') { j.status = 'failed'; j.error = j.error || 'interrupted (server restarted)'; }
      }
```
Replace it with:
```js
      // Reconcile orphans: a job left 'running' means the process died mid-generation — no worker
      // owns it now. Treat it exactly like any other failed attempt (same 3-attempt cap runJob()
      // uses): requeue if there's budget left, otherwise fail for real. A restart during active
      // development should not manufacture failures that never actually happened.
      for (const j of jobs) {
        if (j.status !== 'running') continue;
        const attempts = (j.attempts || 0) + 1;
        j.startedAt = null;
        if (attempts < 4) {
          j.status = 'queued';
          j.attempts = attempts;
        } else {
          j.status = 'failed';
          j.attempts = attempts;
          j.error = j.error || 'interrupted (server restarted) — retry budget exhausted';
          j.finishedAt = Date.now();
        }
      }
```
Note: the cap check is `attempts < 4` here (not `< 3`) because `attempts` in this block already includes the current incident (it was incremented on the line above), matching `runJob()`'s own semantics where a job that has already failed 3 times (`attempts === 3`) gets one more try before giving up on the 4th.

- [ ] **Step 4: Run it again and confirm it passes**

Run: `cd /Users/michael/Downloads/NEUEGEN/studio && npm test`
Expected: PASS (4 tests total now).

- [ ] **Step 5: Commit**

```bash
cd /Users/michael/Downloads/NEUEGEN
git add studio/lib/jobstore.mjs studio/test/jobstore.test.mjs
git commit -m "fix: requeue restart-orphaned jobs instead of hard-failing them"
```

---

### Task 4: Generation timeout + permanent-error classification

**Files:**
- Modify: `studio/lib/gen.mjs`
- Test: Create `studio/test/gen.test.mjs`

**Why:** `generateSlot()`'s spawned subprocess has no timeout — a hang leaves a job `running` forever, permanently occupying a concurrency slot. Separately, some errors (dead OAuth credential, missing tool) can never succeed by retrying; today they're retried 3 times anyway, each one a wasted subprocess spawn.

- [ ] **Step 1: Write the failing tests**

Create `studio/test/gen.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateSlot } from '../lib/gen.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..'); // studio/test -> studio -> NEUEGEN (has logic.js)
const FAKE_TOOL = join(HERE, 'fixtures', 'fake-imagegen.py');

function job(overrides = {}) {
  return { brand: 'b', batch: 'x', ad: 'a', variation: 'v', prompt: 'p', run: 1, promptText: 'hello', size: '1024x1024', ...overrides };
}

test('generateSlot succeeds against the fake tool', async () => {
  const renders = mkdtempSync(join(tmpdir(), 'gen-test-'));
  process.env.CHATGPT_IMAGEGEN = FAKE_TOOL;
  process.env.FAKE_IMAGEGEN_MODE = 'success';
  try {
    const res = await generateSlot(job(), { renders, repoDir: REPO });
    assert.equal(res.ok, true);
    assert.ok(res.relPath.includes('run-1'));
  } finally {
    rmSync(renders, { recursive: true, force: true });
    delete process.env.CHATGPT_IMAGEGEN;
    delete process.env.FAKE_IMAGEGEN_MODE;
  }
});

test('generateSlot classifies a dead-credential error as FATAL', async () => {
  const renders = mkdtempSync(join(tmpdir(), 'gen-test-'));
  process.env.CHATGPT_IMAGEGEN = FAKE_TOOL;
  process.env.FAKE_IMAGEGEN_MODE = 'fail';
  process.env.FAKE_IMAGEGEN_ERROR = 'token refresh failed: HTTP 401';
  try {
    const res = await generateSlot(job(), { renders, repoDir: REPO });
    assert.equal(res.ok, false);
    assert.match(res.error, /^FATAL:/);
  } finally {
    rmSync(renders, { recursive: true, force: true });
    delete process.env.CHATGPT_IMAGEGEN;
    delete process.env.FAKE_IMAGEGEN_MODE;
    delete process.env.FAKE_IMAGEGEN_ERROR;
  }
});

test('generateSlot times out a hung subprocess instead of waiting forever', async () => {
  const renders = mkdtempSync(join(tmpdir(), 'gen-test-'));
  process.env.CHATGPT_IMAGEGEN = FAKE_TOOL;
  process.env.FAKE_IMAGEGEN_MODE = 'hang';
  process.env.CHATGPT_IMAGEGEN_TIMEOUT_MS = '500';
  try {
    const started = Date.now();
    const res = await generateSlot(job(), { renders, repoDir: REPO });
    const elapsed = Date.now() - started;
    assert.equal(res.ok, false);
    assert.match(res.error, /^TIMEOUT:/);
    assert.ok(elapsed < 4000, `expected the timeout to fire quickly, took ${elapsed}ms`);
  } finally {
    rmSync(renders, { recursive: true, force: true });
    delete process.env.CHATGPT_IMAGEGEN;
    delete process.env.FAKE_IMAGEGEN_MODE;
    delete process.env.CHATGPT_IMAGEGEN_TIMEOUT_MS;
  }
});
```

- [ ] **Step 2: Run it and confirm the new behavior fails**

Run: `cd /Users/michael/Downloads/NEUEGEN/studio && npm test`
Expected: the first test PASSES already (baseline — unmodified `generateSlot` already succeeds against a working tool). The second FAILS (`res.error` is `'token refresh failed: HTTP 401'`, doesn't match `/^FATAL:/`). The third FAILS after ~5s (no timeout exists yet, so it waits for the fake tool's own 5s sleep, then sees no output file and returns an ordinary `exit 0` error, not `TIMEOUT:`).

- [ ] **Step 3: Implement the fix**

In `studio/lib/gen.mjs`, find the constant near the top:
```js
// Codex usage-limit / HTTP 429 surface text. When the tool's error matches this, the returned
// error is PREFIXED with 'RATE_LIMIT: ' so the worker can cool down and retry later.
const RATE_LIMIT_RE = /HTTP 429|usage limit|too many requests|rate.?limit|quota|exceeded/i;
```
Add right after it:
```js

// Errors that can never succeed by retrying (a dead OAuth credential, a missing tool install).
// PREFIXED with 'FATAL: ' so worker.mjs skips the normal 3-attempt retry loop for these — retrying
// a known-permanent error just wastes more subprocess spawns against the same broken setup.
const FATAL_RE = /token refresh failed|refresh_token is no longer valid|auth\.json not found|no ChatGPT OAuth access_token|chatgpt-imagegen tool not found/i;

// How long a single generation attempt may run before it's treated as hung and killed. Overridable
// via CHATGPT_IMAGEGEN_TIMEOUT_MS (same env-override convention as EFFORT/VERBOSITY below).
const TIMEOUT_MS = Number(process.env.CHATGPT_IMAGEGEN_TIMEOUT_MS) || 180_000;

// Apply the RATE_LIMIT / FATAL prefix classification consistently everywhere an error is returned.
function classifyError(error) {
  if (RATE_LIMIT_RE.test(error)) return `RATE_LIMIT: ${error}`;
  if (FATAL_RE.test(error)) return `FATAL: ${error}`;
  return error;
}
```

Then find the tool-missing early return:
```js
  if (!existsSync(TOOL)) {
    return { ok: false, error: `chatgpt-imagegen tool not found at ${TOOL} (set CHATGPT_IMAGEGEN)` };
  }
```
Change to:
```js
  if (!existsSync(TOOL)) {
    return { ok: false, error: classifyError(`chatgpt-imagegen tool not found at ${TOOL} (set CHATGPT_IMAGEGEN)`) };
  }
```

Then find the full spawn block:
```js
  return new Promise((resolve) => {
    mkdirSync(dirname(out), { recursive: true });
    const args = [TOOL, job.promptText, '-o', out, '--backend', 'codex', '--size', size];
    // Reference image(s) — the python CLI's `-i/--ref` is action="append", so multiple are allowed.
    // `refs` (array) takes precedence; `ref` (single string) is kept for back-compat. Used by Revise,
    // which passes the ORIGINAL image (and any board images) so the new version builds on it.
    const refs = Array.isArray(job.refs) ? job.refs : (job.ref ? [job.ref] : []);
    for (const r of refs) if (r) args.push('-i', String(r));
    // Codex on LOW reasoning: just execute the prompt, don't think (faster, less metered spend).
    // Overridable via CHATGPT_IMAGEGEN_EFFORT / _VERBOSITY.
    const env = {
      ...process.env,
      CHATGPT_IMAGEGEN_EFFORT: process.env.CHATGPT_IMAGEGEN_EFFORT || 'low',
      CHATGPT_IMAGEGEN_VERBOSITY: process.env.CHATGPT_IMAGEGEN_VERBOSITY || 'low',
      ...(CA_BUNDLE ? { SSL_CERT_FILE: CA_BUNDLE, REQUESTS_CA_BUNDLE: CA_BUNDLE } : {}),
    };
    const child = spawn('python3', args, { stdio: ['ignore', 'pipe', 'pipe'], env });
    let err = '', sout = '';
    child.stdout.on('data', (d) => { sout += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('close', (code) => {
      if (code === 0 && existsSync(out)) {
        resolve({ ok: true, relPath: finalRel });
        return;
      }
      // Capture BOTH streams: the codex usage-limit / HTTP 429 notice can surface on stdout, so
      // include stdout in the error text the rate-limit detector greps.
      let error = (err + '\n' + sout).trim().split('\n').slice(-4).join(' | ') || `exit ${code}`;
      if (RATE_LIMIT_RE.test(error)) error = `RATE_LIMIT: ${error}`;
      resolve({ ok: false, error });
    });
    child.on('error', (e) => {
      let error = String(e.message || e);
      if (RATE_LIMIT_RE.test(error)) error = `RATE_LIMIT: ${error}`;
      resolve({ ok: false, error });
    });
  });
```
Replace it with:
```js
  return new Promise((resolve) => {
    mkdirSync(dirname(out), { recursive: true });
    const args = [TOOL, job.promptText, '-o', out, '--backend', 'codex', '--size', size];
    // Reference image(s) — the python CLI's `-i/--ref` is action="append", so multiple are allowed.
    // `refs` (array) takes precedence; `ref` (single string) is kept for back-compat. Used by Revise,
    // which passes the ORIGINAL image (and any board images) so the new version builds on it.
    const refs = Array.isArray(job.refs) ? job.refs : (job.ref ? [job.ref] : []);
    for (const r of refs) if (r) args.push('-i', String(r));
    // Codex on LOW reasoning: just execute the prompt, don't think (faster, less metered spend).
    // Overridable via CHATGPT_IMAGEGEN_EFFORT / _VERBOSITY.
    const env = {
      ...process.env,
      CHATGPT_IMAGEGEN_EFFORT: process.env.CHATGPT_IMAGEGEN_EFFORT || 'low',
      CHATGPT_IMAGEGEN_VERBOSITY: process.env.CHATGPT_IMAGEGEN_VERBOSITY || 'low',
      ...(CA_BUNDLE ? { SSL_CERT_FILE: CA_BUNDLE, REQUESTS_CA_BUNDLE: CA_BUNDLE } : {}),
    };
    const child = spawn('python3', args, { stdio: ['ignore', 'pipe', 'pipe'], env });
    let err = '', sout = '', timedOut = false;
    child.stdout.on('data', (d) => { sout += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });

    // A hung subprocess (network stall, etc.) must never occupy a concurrency slot forever.
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch {}
      const killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 5000);
      if (killTimer.unref) killTimer.unref();
    }, TIMEOUT_MS);
    if (timer.unref) timer.unref();

    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({ ok: false, error: `TIMEOUT: generation exceeded ${Math.round(TIMEOUT_MS / 1000)}s` });
        return;
      }
      if (code === 0 && existsSync(out)) {
        resolve({ ok: true, relPath: finalRel });
        return;
      }
      // Capture BOTH streams: the codex usage-limit / HTTP 429 notice can surface on stdout, so
      // include stdout in the error text the rate-limit detector greps.
      let error = (err + '\n' + sout).trim().split('\n').slice(-4).join(' | ') || `exit ${code}`;
      resolve({ ok: false, error: classifyError(error) });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: classifyError(String(e.message || e)) });
    });
  });
```

- [ ] **Step 4: Run it again and confirm it passes**

Run: `cd /Users/michael/Downloads/NEUEGEN/studio && npm test`
Expected: PASS (7 tests total now). The timeout test should complete in well under a second.

- [ ] **Step 5: Commit**

```bash
cd /Users/michael/Downloads/NEUEGEN
git add studio/lib/gen.mjs studio/test/gen.test.mjs
git commit -m "feat: bound generation subprocess with a timeout, classify permanent errors as FATAL"
```

---

### Task 5: Circuit breaker — a `blocked` run-state for structural failures

**Files:**
- Modify: `studio/lib/worker.mjs`
- Test: Create `studio/test/worker.test.mjs`

**Why:** Today the worker only special-cases `RATE_LIMIT:` errors. Everything else — including a dead credential guaranteed to fail every single time — just retries 3 times per job and moves on, leaving the user to notice a wall of red tiles after the fact with no single, clear explanation.

- [ ] **Step 1: Write the failing tests**

Create `studio/test/worker.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJobStore } from '../lib/jobstore.mjs';
import { createWorker } from '../lib/worker.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const FAKE_TOOL = join(HERE, 'fixtures', 'fake-imagegen.py');

function waitFor(predicate, { timeoutMs = 3000, intervalMs = 20 } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error('waitFor timed out'));
      setTimeout(check, intervalMs);
    };
    check();
  });
}

test('three consecutive identical failures block the run with a reason', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'worker-test-'));
  const renders = mkdtempSync(join(tmpdir(), 'worker-renders-'));
  process.env.CHATGPT_IMAGEGEN = FAKE_TOOL;
  process.env.FAKE_IMAGEGEN_MODE = 'fail';
  process.env.FAKE_IMAGEGEN_ERROR = 'token refresh failed: HTTP 401';
  const store = createJobStore({ stateDir });
  const worker = createWorker({ store, renders, repoDir: REPO, concurrency: 1, cooldownMin: 30 });
  worker.start();
  try {
    for (let i = 0; i < 3; i++) {
      store.enqueue({ brand: 'b', batch: 'x', ad: 'a', variation: 'v', prompt: `p${i}`, run: 1, promptText: 't' });
    }
    await waitFor(() => worker.runState().state === 'blocked');
    const state = worker.runState();
    assert.equal(state.state, 'blocked');
    assert.match(state.blockedReason, /FATAL: token refresh failed/);

    worker.resume();
    assert.equal(worker.runState().state, 'idle');
  } finally {
    worker.stop();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(renders, { recursive: true, force: true });
    delete process.env.CHATGPT_IMAGEGEN;
    delete process.env.FAKE_IMAGEGEN_MODE;
    delete process.env.FAKE_IMAGEGEN_ERROR;
  }
});

test('a success resets the failure streak', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'worker-test-'));
  const renders = mkdtempSync(join(tmpdir(), 'worker-renders-'));
  process.env.CHATGPT_IMAGEGEN = FAKE_TOOL;
  const store = createJobStore({ stateDir });
  const worker = createWorker({ store, renders, repoDir: REPO, concurrency: 1, cooldownMin: 30 });
  worker.start();
  try {
    process.env.FAKE_IMAGEGEN_MODE = 'fail';
    process.env.FAKE_IMAGEGEN_ERROR = 'boom';
    store.enqueue({ brand: 'b', batch: 'x', ad: 'a', variation: 'v', prompt: 'p1', run: 1, promptText: 't' });
    store.enqueue({ brand: 'b', batch: 'x', ad: 'a', variation: 'v', prompt: 'p2', run: 1, promptText: 't' });
    await waitFor(() => store.counts().failed >= 2);

    process.env.FAKE_IMAGEGEN_MODE = 'success';
    store.enqueue({ brand: 'b', batch: 'x', ad: 'a', variation: 'v', prompt: 'p3', run: 1, promptText: 't' });
    await waitFor(() => store.counts().done >= 1);

    process.env.FAKE_IMAGEGEN_MODE = 'fail';
    store.enqueue({ brand: 'b', batch: 'x', ad: 'a', variation: 'v', prompt: 'p4', run: 1, promptText: 't' });
    store.enqueue({ brand: 'b', batch: 'x', ad: 'a', variation: 'v', prompt: 'p5', run: 1, promptText: 't' });
    // Two more failures after the success — only 2 in a row since the reset, not enough to trip it.
    await waitFor(() => store.counts().failed >= 4);
    assert.equal(worker.runState().state, 'done');
  } finally {
    worker.stop();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(renders, { recursive: true, force: true });
    delete process.env.CHATGPT_IMAGEGEN;
    delete process.env.FAKE_IMAGEGEN_MODE;
    delete process.env.FAKE_IMAGEGEN_ERROR;
  }
});
```

- [ ] **Step 2: Run it and confirm the first test fails**

Run: `cd /Users/michael/Downloads/NEUEGEN/studio && npm test`
Expected: the first test FAILS with `waitFor timed out` (there's no `'blocked'` state yet, so the condition never becomes true). The second test PASSES already (nothing currently prevents reaching `'done'` — this is a baseline regression guard for behavior we're about to add logic next to).

- [ ] **Step 3: Implement the circuit breaker**

In `studio/lib/worker.mjs`, find the constant block near the top and add a threshold next to `MAX_CONCURRENT_JOBS`:
```js
export const MAX_CONCURRENT_JOBS = 3;
```
Change to:
```js
export const MAX_CONCURRENT_JOBS = 3;

// How many consecutive failures with the IDENTICAL error text mean "this is structurally broken"
// (a dead credential, a missing tool) rather than one-off flakiness. See runState()'s 'blocked'.
const FAIL_STREAK_THRESHOLD = 3;
```

Find the worker's state variables:
```js
  let running = 0;          // count of in-flight generateSlot calls
  let cooling = false;      // true while cooling down after a rate limit (auto-resumes)
  let userPaused = false;   // true while paused by the user (pause(); cleared by resume())
  let resumeAt = null;      // epoch ms the cooldown ends (null when not cooling)
  let didComplete = false;  // a job has completed since this run started (distinguishes done vs idle)
  let runAborted = false;   // user pressed Stop — force idle immediately; cleared on next enqueue
  let runningWorker = false; // true between start() and stop()
  let interval = null;      // the 1s safety-tick interval handle
  let cooldownTimer = null; // the setTimeout that ends a cooldown
  let inTick = false;       // reentrancy guard for tick() — see note below
```
Add three more variables after `let inTick = false;`:
```js
  let blockedReason = null;     // non-null once FAIL_STREAK_THRESHOLD identical failures happen in a row
  let lastFailSignature = null; // the error text of the most recent ordinary (non-RATE_LIMIT) failure
  let consecutiveFails = 0;     // how many times in a row lastFailSignature has repeated
```

Find the `blocked` pull-gate function (name clashes with the new public concept, so rename it):
```js
  // The worker is "blocked" from pulling new jobs while either the user paused it or a rate-limit
  // cooldown is active. In-flight jobs always finish regardless.
  const blocked = () => userPaused || cooling || isLimitReached();
```
Replace with:
```js
  // The worker is gated from pulling new jobs while the user paused it, a rate-limit cooldown is
  // active, a structural failure streak has tripped, or the usage cap is hit. In-flight jobs always
  // finish regardless. (Renamed from `blocked` to avoid clashing with the new public 'blocked'
  // run-state below — this is the internal pull gate, not the same thing as blockedReason.)
  const pullGated = () => userPaused || cooling || blockedReason != null || isLimitReached();
```

Find the two other uses of `blocked()` and update them. In `tick()`:
```js
  function tick() {
    if (!runningWorker || blocked() || inTick) return;
```
becomes:
```js
  function tick() {
    if (!runningWorker || pullGated() || inTick) return;
```
In `status()`:
```js
  function status() {
    // `paused` kept for back-compat: true while EITHER a user-pause or a rate-limit cooldown holds.
    return { running, paused: blocked(), userPaused, cooling, resumeAt };
  }
```
becomes:
```js
  function status() {
    // `paused` kept for back-compat: true while EITHER a user-pause or a rate-limit cooldown holds.
    return { running, paused: pullGated(), userPaused, cooling, resumeAt };
  }
```

Find `runJob()`'s success branch:
```js
    if (res && res.ok) {
      store.complete(job.id, { relPath: res.relPath });
      didComplete = true;
      try { onComplete && onComplete(job); } catch {}
      notify();
    } else {
```
Change to (a real success is proof the pipeline works — clear the streak and any active block):
```js
    if (res && res.ok) {
      store.complete(job.id, { relPath: res.relPath });
      didComplete = true;
      consecutiveFails = 0;
      lastFailSignature = null;
      blockedReason = null;
      try { onComplete && onComplete(job); } catch {}
      notify();
    } else {
```

Find the ordinary-failure branch inside that same `else`:
```js
      // Ordinary failure: retry up to 3 attempts, then give up and mark it failed. requeue() bumps
      // `attempts` for us, so check the CURRENT count before requeuing (i.e. attempts so far, not
      // counting this one yet) — once 3 ordinary failures have already happened, stop retrying.
      const current = store.get(job.id);
      const attempts = (current && current.attempts) || 0;
      if (attempts < 3) store.requeue(job.id);
      else store.fail(job.id, error);
      notify();
```
Replace with:
```js
      // Circuit breaker: N consecutive failures with the IDENTICAL error text means something
      // structural is broken (dead credential, missing tool, ...), not one-off flakiness — stop
      // burning the queue against it and tell the user plainly instead of quietly retrying forever.
      if (error === lastFailSignature) consecutiveFails++;
      else { lastFailSignature = error; consecutiveFails = 1; }
      if (consecutiveFails >= FAIL_STREAK_THRESHOLD) blockedReason = error;
      // Ordinary failure: retry up to 3 attempts, then give up and mark it failed. requeue() bumps
      // `attempts` for us, so check the CURRENT count before requeuing (i.e. attempts so far, not
      // counting this one yet) — once 3 ordinary failures have already happened, stop retrying.
      // A FATAL error (gen.mjs's classification for known-permanent failures) skips straight to
      // failed — retrying it just wastes more subprocess spawns against the same broken setup.
      const current = store.get(job.id);
      const attempts = (current && current.attempts) || 0;
      if (!/^FATAL:/.test(error) && attempts < 3) store.requeue(job.id);
      else store.fail(job.id, error);
      notify();
```

Find `resume()`:
```js
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
```
Change to also clear a structural block (this is what makes the existing "Continue" button double as the block's "Retry" action — no new endpoint needed):
```js
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
    if (blockedReason) {
      blockedReason = null;
      consecutiveFails = 0;
      lastFailSignature = null;
      changed = true;
    }
    if (changed) notify();
    tick();
  }
```

Find `abortRun()`:
```js
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
```
Change to also clear a structural block (so Reset/Stop-all always gets you back to a clean idle state):
```js
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
    if (blockedReason) {
      blockedReason = null;
      consecutiveFails = 0;
      lastFailSignature = null;
      changed = true;
    }
    if (didComplete) { didComplete = false; changed = true; }
    if (!runAborted) { runAborted = true; changed = true; }
    if (changed) notify();
  }
```

Find `runState()`:
```js
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
```
Replace with (`blocked` takes top priority — it needs a human action, unlike a self-resolving cooldown):
```js
  function runState() {
    if (runAborted) return { state: 'idle', resumeAt: null, blockedReason: null };
    const { queued } = store.counts();
    let state;
    if (blockedReason) state = 'blocked';
    else if (cooling) state = 'cooling';
    else if (running > 0) state = 'running';
    else if (userPaused) state = 'paused';
    else if (queued === 0 && didComplete) state = 'done';
    else state = 'idle';
    return {
      state,
      resumeAt: cooling ? resumeAt : null,
      blockedReason: state === 'blocked' ? blockedReason : null,
    };
  }
```

- [ ] **Step 4: Run it again and confirm both tests pass**

Run: `cd /Users/michael/Downloads/NEUEGEN/studio && npm test`
Expected: PASS (9 tests total now).

- [ ] **Step 5: Commit**

```bash
cd /Users/michael/Downloads/NEUEGEN
git add studio/lib/worker.mjs studio/test/worker.test.mjs
git commit -m "feat: circuit breaker — blocked run-state after 3 consecutive identical failures"
```

---

### Task 6: Live-adjustable concurrency

**Files:**
- Modify: `studio/lib/worker.mjs`
- Test: Modify `studio/test/worker.test.mjs`

**Why:** Concurrency is hardcoded to 3, changeable only via a `CONCURRENCY` env var at process start. There's no way to see or change it while the app is running.

- [ ] **Step 1: Write the failing test**

Append to `studio/test/worker.test.mjs`:
```js
test('setConcurrency raises the limit and pulls more work immediately', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'worker-test-'));
  const renders = mkdtempSync(join(tmpdir(), 'worker-renders-'));
  process.env.CHATGPT_IMAGEGEN = FAKE_TOOL;
  // The fixture's hang mode sleeps 5s then exits on its own — plenty of time to observe in-flight
  // counts here, and short enough that we don't need to explicitly kill anything in `finally`.
  process.env.FAKE_IMAGEGEN_MODE = 'hang';
  const store = createJobStore({ stateDir });
  const worker = createWorker({ store, renders, repoDir: REPO, concurrency: 1, cooldownMin: 30 });
  worker.start();
  try {
    for (let i = 0; i < 3; i++) {
      store.enqueue({ brand: 'b', batch: 'x', ad: 'a', variation: 'v', prompt: `p${i}`, run: 1, promptText: 't' });
    }
    await waitFor(() => store.counts().running === 1);
    assert.equal(store.counts().queued, 2);
    assert.equal(worker.status().concurrency, 1);

    worker.setConcurrency(3);
    assert.equal(worker.status().concurrency, 3);
    await waitFor(() => store.counts().running === 3);
    assert.equal(store.counts().queued, 0);
  } finally {
    worker.stop();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(renders, { recursive: true, force: true });
    delete process.env.CHATGPT_IMAGEGEN;
    delete process.env.FAKE_IMAGEGEN_MODE;
  }
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd /Users/michael/Downloads/NEUEGEN/studio && npm test`
Expected: FAIL — `worker.setConcurrency` doesn't exist yet (`TypeError: worker.setConcurrency is not a function`).

- [ ] **Step 3: Implement it**

In `studio/lib/worker.mjs`, find `runState()`'s closing brace, and add a new function right after it (before the final `return { ... }`):
```js
  // Change how many jobs run at once, effective immediately (no restart). Clamped to a sane range;
  // raising it re-ticks so newly-available capacity gets filled right away.
  function setConcurrency(n) {
    concurrency = Math.max(1, Math.min(10, Math.floor(Number(n)) || 1));
    tick();
    return concurrency;
  }
```
Then find `status()` (already modified in Task 5 to use `pullGated()`):
```js
  function status() {
    // `paused` kept for back-compat: true while EITHER a user-pause or a rate-limit cooldown holds.
    return { running, paused: pullGated(), userPaused, cooling, resumeAt };
  }
```
Add `concurrency` to the returned object:
```js
  function status() {
    // `paused` kept for back-compat: true while EITHER a user-pause or a rate-limit cooldown holds.
    return { running, paused: pullGated(), userPaused, cooling, resumeAt, concurrency };
  }
```
Finally, find the factory's return statement:
```js
  return { start, stop, status, busy, pause, resume, abortRun, runState };
```
Change to:
```js
  return { start, stop, status, busy, pause, resume, abortRun, runState, setConcurrency };
```

- [ ] **Step 4: Run it again and confirm it passes**

Run: `cd /Users/michael/Downloads/NEUEGEN/studio && npm test`
Expected: PASS (10 tests total now).

- [ ] **Step 5: Commit**

```bash
cd /Users/michael/Downloads/NEUEGEN
git add studio/lib/worker.mjs studio/test/worker.test.mjs
git commit -m "feat: expose worker.setConcurrency for live, no-restart concurrency changes"
```

---

### Task 7: Wire the backend routes — usage limit, concurrency, blockedReason passthrough

**Files:**
- Modify: `studio/studio-server.mjs`
- Modify: `studio/lib/INTERFACES.md`

**Why:** `lib/usage.mjs`'s `setUsageLimit` already exists and is already honored by the worker's pull gate, but `studio-server.mjs` never imports it, so there is no route to ever call it. There's likewise no route for the new `worker.setConcurrency`, and `RunInfo` needs to carry the new `blockedReason` through to the frontend.

There are no automated tests for this task. `studio-server.mjs` starts an HTTP server as a side effect of being imported (`server.listen(PORT, ...)` runs at module load, not inside an exported function), and none of its 15 existing routes have ever had automated tests — adding a process-spawning HTTP test harness would be new test infrastructure beyond this plan's scope. The logic these routes call (`setUsageLimit`, `worker.setConcurrency`, `worker.runState()`) is already covered by Tasks 5–6. This task is verified manually in Task 14, against the user's real server, with exact curl commands.

- [ ] **Step 1: Import `setUsageLimit`**

In `studio/studio-server.mjs`, find:
```js
import { getCodexUsage, noteGenerated, noteRateLimit } from './lib/usage.mjs';
```
Change to:
```js
import { getCodexUsage, noteGenerated, noteRateLimit, setUsageLimit } from './lib/usage.mjs';
```

- [ ] **Step 2: Make the port configurable (needed so a future test server never collides with a live one on :8788)**

Find:
```js
const BRIDGE = 'http://localhost:8787';
const PORT = 8788;
```
Change to:
```js
const BRIDGE = 'http://localhost:8787';
const PORT = Number(process.env.PORT) || 8788;
```

- [ ] **Step 3: Pass `blockedReason` through `buildRunInfo`**

Find:
```js
function buildRunInfo(brand, batch) {
  const { state, resumeAt } = worker.runState();
  let running = 0, queued = 0, done = 0, failed = 0;
  for (const j of store.forBatch(brand, batch)) {
    if (j.status === 'running') running++;
    else if (j.status === 'queued') queued++;
    else if (j.status === 'done') done++;
    else if (j.status === 'failed') failed++;
  }
  return { state, running, queued, done, failed, total: running + queued + done + failed, resumeAt: resumeAt ?? null };
}
```
Change to:
```js
function buildRunInfo(brand, batch) {
  const { state, resumeAt, blockedReason } = worker.runState();
  let running = 0, queued = 0, done = 0, failed = 0;
  for (const j of store.forBatch(brand, batch)) {
    if (j.status === 'running') running++;
    else if (j.status === 'queued') queued++;
    else if (j.status === 'done') done++;
    else if (j.status === 'failed') failed++;
  }
  return {
    state, running, queued, done, failed,
    total: running + queued + done + failed,
    resumeAt: resumeAt ?? null,
    blockedReason: blockedReason ?? null,
  };
}
```

- [ ] **Step 4: Add the two new routes**

Find the existing run-control routes:
```js
    if (pathname === '/api/reset' && method === 'POST') {
      // Clear the whole queue, drop any rate-limit cooldown, and snap back to idle.
      store.cancel({ all: true });
      worker.abortRun();
      sendJson(res, 200, { ok: true, run: worker.runState() });
      return;
    }
```
Add these two new routes right after it:
```js

    // Set the session usage cap (null/0 = unlimited). The worker's pull gate already honors
    // isLimitReached() — this just makes the existing (previously unreachable) backend logic settable.
    if (pathname === '/api/usage-limit' && method === 'POST') {
      const body = await readBody(req);
      const n = body.limit == null ? null : Number(body.limit);
      const limit = setUsageLimit(Number.isFinite(n) && n > 0 ? n : null);
      sendJson(res, 200, { ok: true, limit });
      return;
    }

    // Change how many jobs generate at once, effective immediately (no restart required).
    if (pathname === '/api/concurrency' && method === 'POST') {
      const body = await readBody(req);
      const concurrency = worker.setConcurrency(body.n);
      sendJson(res, 200, { ok: true, concurrency });
      return;
    }
```

- [ ] **Step 5: Surface the current concurrency in `/api/health`**

Find:
```js
    if (pathname === '/api/health' && method === 'GET') {
      const { bridge } = await fetchBridgeProgress();
      sendJson(res, 200, {
        ok: true,
        bridge,
        codex: { alive: worker.busy() },
        queue: store.counts(),
        codexUsage: getCodexUsage(),
        // Rolling average single-image generation time (lib/jobstore.mjs), for GenerateDialog's
        // per-image / total-batch ETA. Falls back to a 30s default when there's no history yet.
        estimate: store.avgDurationSeconds(),
      });
      return;
    }
```
Change to:
```js
    if (pathname === '/api/health' && method === 'GET') {
      const { bridge } = await fetchBridgeProgress();
      sendJson(res, 200, {
        ok: true,
        bridge,
        codex: { alive: worker.busy() },
        queue: store.counts(),
        codexUsage: getCodexUsage(),
        // Rolling average single-image generation time (lib/jobstore.mjs), for GenerateDialog's
        // per-image / total-batch ETA. Falls back to a 30s default when there's no history yet.
        estimate: store.avgDurationSeconds(),
        concurrency: worker.status().concurrency,
      });
      return;
    }
```

- [ ] **Step 6: Update the contract doc**

In `studio/lib/INTERFACES.md`, find the `studio-server.mjs` section's route list:
```
- Routes per PLAN §3. `/api/generate`: read config; for each targeted slot, `run = (#done renders for that prompt) + (#queued/running jobs for it) + 1`; resolve `promptText` (config variation.prompts[].prompt — use prompt id), `size` (batch.aspect), `ref` (if the prompt is a tube shot, the assets/nanox.png path); enqueue `variants` jobs per slot. `/api/regenerate`: relPath→coords→enqueue 1 at next run. `/api/cancel`, `/api/archive`, `/api/state` (buildState + codex={alive:worker.busy()||pgrep, progress: bridge /status codexProgress}), `/api/health`, `/img?path=` (serve full PNG, path-traversal-guarded; `?w` accepted but may be ignored — serve full for v1), `/events` (SSE: Set of res; broadcast `state`+`queue` on store/worker change; `hello` on connect; `:heartbeat` comment every 20s).
```
Add a line right after it:
```
- Run-state additions (NEUEGEN reliability pass): `run.state` can be `'blocked'` — set when the worker's failure-streak circuit breaker trips (see lib/worker.mjs `FAIL_STREAK_THRESHOLD`); `run.blockedReason` carries the repeated error text. `POST /api/usage-limit` `{limit}` → `lib/usage.mjs` `setUsageLimit`. `POST /api/concurrency` `{n}` → `worker.setConcurrency`. `/api/health.concurrency` reports the live value. `PORT` env var overrides the default `8788`.
```

- [ ] **Step 7: Commit**

```bash
cd /Users/michael/Downloads/NEUEGEN
git add studio/studio-server.mjs studio/lib/INTERFACES.md
git commit -m "feat: wire usage-limit and concurrency API routes, pass blockedReason through RunInfo"
```

---

### Task 8: Frontend contract — types and API client

**Files:**
- Modify: `studio/src/types.ts`
- Modify: `studio/src/api.ts`

**Why:** The frontend needs `RunState`/`RunInfo` to know about `'blocked'`/`blockedReason`, `Health` to know about `concurrency`, and two new client methods to call the routes from Task 7.

There's no meaningful unit test for type declarations (TypeScript checks these at compile time). This task is verified by `npm run typecheck` at the end of Task 11, once every consumer of these types has been updated.

- [ ] **Step 1: Update `RunState` and `RunInfo`**

In `studio/src/types.ts`, find:
```ts
// Run state machine (worker-owned). `cooling` = paused by a codex rate-limit; auto-resumes at resumeAt.
export type RunState = 'idle' | 'running' | 'paused' | 'cooling' | 'done';
export interface RunInfo {
  state: RunState;
  running: number;
  queued: number;
  done: number;
  failed: number;
  total: number;            // running + queued + done + failed for the current run
  resumeAt?: number | null; // epoch ms when a cooling run auto-resumes
}
```
Change to:
```ts
// Run state machine (worker-owned). `cooling` = paused by a codex rate-limit; auto-resumes at resumeAt.
// `blocked` = the circuit breaker tripped (N consecutive identical failures) — needs a human fix,
// does not auto-resume; see blockedReason.
export type RunState = 'idle' | 'running' | 'paused' | 'cooling' | 'blocked' | 'done';
export interface RunInfo {
  state: RunState;
  running: number;
  queued: number;
  done: number;
  failed: number;
  total: number;            // running + queued + done + failed for the current run
  resumeAt?: number | null; // epoch ms when a cooling run auto-resumes
  blockedReason?: string | null; // set only while state === 'blocked'; the repeated error text
}
```

- [ ] **Step 2: Add `concurrency` to `Health`**

Find:
```ts
export interface Health { ok: boolean; bridge: boolean; codex: { alive: boolean }; queue: QueueInfo; estimate?: GenEstimate; }
```
Change to:
```ts
export interface Health { ok: boolean; bridge: boolean; codex: { alive: boolean }; queue: QueueInfo; estimate?: GenEstimate; concurrency?: number; }
```

- [ ] **Step 3: Add the two client methods**

In `studio/src/api.ts`, find:
```ts
  pause: () => jpost<{ ok: boolean }>('/api/pause', {}, { ok: false }),
  resume: () => jpost<{ ok: boolean }>('/api/resume', {}, { ok: false }),
  reset: () => jpost<{ ok: boolean }>('/api/reset', {}, { ok: false }),
```
Add right after it:
```ts
  setUsageLimit: (limit: number | null) =>
    jpost<{ ok: boolean; limit?: number | null }>('/api/usage-limit', { limit }, { ok: false }),
  setConcurrency: (n: number) =>
    jpost<{ ok: boolean; concurrency?: number }>('/api/concurrency', { n }, { ok: false }),
```

- [ ] **Step 4: Commit**

```bash
cd /Users/michael/Downloads/NEUEGEN
git add studio/src/types.ts studio/src/api.ts
git commit -m "feat: add blocked run-state, blockedReason, and usage-limit/concurrency client methods to the shared contract"
```

---

### Task 9: TopBar — the blocked banner

**Files:**
- Modify: `studio/src/components/TopBar.tsx`
- Modify: `studio/src/components/TopBar.module.css`

**Why:** This is the one clear, sticky, unmissable place the user needs to see "generation stopped and here's why" instead of inspecting individual failed tiles.

- [ ] **Step 1: Add the banner styling**

In `studio/src/components/TopBar.module.css`, find the `.cooling` block:
```css
/* ---- cooling countdown ---- */
.cooling {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 var(--space-3);
  border-radius: var(--r-pill);
  background: var(--warn-soft);
  color: var(--warn);
  border: 1px solid color-mix(in srgb, var(--warn) 24%, transparent);
  font-size: 12.5px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
```
Add right after it:
```css

/* ---- blocked banner (circuit breaker tripped — needs a human fix, doesn't self-resolve) ---- */
.blocked {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 var(--space-3);
  border-radius: var(--r-pill);
  background: var(--err-soft);
  color: var(--err);
  border: 1px solid color-mix(in srgb, var(--err) 24%, transparent);
  font-size: 12.5px;
  font-weight: 500;
  white-space: nowrap;
  max-width: 460px;
}
.blockedText {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

- [ ] **Step 2: Add a hint-mapping helper and the banner markup**

In `studio/src/components/TopBar.tsx`, find:
```tsx
// Format a seconds ETA as a terse "~Nm" / "~Ns".
function fmtEta(seconds: number): string {
  if (!isFinite(seconds) || seconds <= 0) return '';
  if (seconds < 60) return `~${Math.round(seconds)}s`;
  return `~${Math.round(seconds / 60)}m`;
}
```
Add right after it:
```tsx

// Turn the worker's raw repeated-error text into a short, actionable hint. Falls back to showing
// the raw text if it doesn't match a known pattern — never hides the real error.
function blockedHint(reason: string): string {
  if (/token refresh|auth\.json|OAuth/i.test(reason)) {
    return 'Codex login has expired. Run `codex login` in your terminal, then hit Retry.';
  }
  if (/tool not found/i.test(reason)) {
    return "The generation tool isn't where the server expects it. Check CHATGPT_IMAGEGEN, then hit Retry.";
  }
  return `Generation stopped — the last 3 attempts failed the same way: "${reason}"`;
}
```

Find the run-state destructuring:
```tsx
  // Run state machine.
  const state: RunState = run?.state ?? 'idle';
  const done = run?.done ?? 0;
  const total = run?.total ?? 0;
  const queued = run?.queued ?? 0;
  const resumeAt = run?.resumeAt ?? null;
```
Change to:
```tsx
  // Run state machine.
  const state: RunState = run?.state ?? 'idle';
  const done = run?.done ?? 0;
  const total = run?.total ?? 0;
  const queued = run?.queued ?? 0;
  const resumeAt = run?.resumeAt ?? null;
  const blockedReason = run?.blockedReason ?? null;
```

Find `showReset`:
```tsx
  const showReset = queued > 0 || state === 'cooling';
```
Change to:
```tsx
  const showReset = queued > 0 || state === 'cooling' || state === 'blocked';
```

Find the cooling-countdown JSX block:
```tsx
          {/* Cooling countdown — auto-resumes, so no Continue button */}
          {state === 'cooling' ? (
            <span className={s.cooling} role="status">
              <Icon name="clock" size={14} />
              <span>
                Resuming in {resumeAt ? fmtCountdown(resumeAt - now) : '—'}
              </span>
            </span>
          ) : null}
```
Add the blocked banner right after it:
```tsx
          {/* Cooling countdown — auto-resumes, so no Continue button */}
          {state === 'cooling' ? (
            <span className={s.cooling} role="status">
              <Icon name="clock" size={14} />
              <span>
                Resuming in {resumeAt ? fmtCountdown(resumeAt - now) : '—'}
              </span>
            </span>
          ) : null}

          {/* Blocked — the circuit breaker tripped. Does not auto-resolve; needs a human fix. */}
          {state === 'blocked' ? (
            <span className={s.blocked} role="alert" title={blockedReason ?? undefined}>
              <Icon name="alert" size={14} />
              <span className={s.blockedText}>{blockedHint(blockedReason ?? 'unknown error')}</span>
            </span>
          ) : null}
```

Find the primary-button state chain:
```tsx
          {/* Primary — label + action change with run state */}
          {state === 'running' ? (
            <button
              type="button"
              className={s.primary}
              onClick={() => api.pause()}
              title="Pause — finish in-flight jobs, stop pulling new ones"
            >
              <PauseGlyph size={15} />
              <span>Pause</span>
            </button>
          ) : state === 'paused' ? (
            <button
              type="button"
              className={s.primary}
              onClick={() => api.resume()}
              title="Continue the run"
            >
              <Icon name="chevron-right" size={15} />
              <span>Continue</span>
            </button>
          ) : state === 'cooling' ? null : (
```
Change the `state === 'cooling' ? null :` branch to also handle `blocked` with a Retry button, reusing the same `api.resume()` call the Continue button already uses:
```tsx
          {/* Primary — label + action change with run state */}
          {state === 'running' ? (
            <button
              type="button"
              className={s.primary}
              onClick={() => api.pause()}
              title="Pause — finish in-flight jobs, stop pulling new ones"
            >
              <PauseGlyph size={15} />
              <span>Pause</span>
            </button>
          ) : state === 'paused' ? (
            <button
              type="button"
              className={s.primary}
              onClick={() => api.resume()}
              title="Continue the run"
            >
              <Icon name="chevron-right" size={15} />
              <span>Continue</span>
            </button>
          ) : state === 'blocked' ? (
            <button
              type="button"
              className={s.primary}
              onClick={() => api.resume()}
              title="Try again — clears the block and resumes the queue"
            >
              <Icon name="refresh" size={15} />
              <span>Retry</span>
            </button>
          ) : state === 'cooling' ? null : (
```

- [ ] **Step 3: Check types**

Run: `cd /Users/michael/Downloads/NEUEGEN/studio && npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Build and eyeball it**

Run: `cd /Users/michael/Downloads/NEUEGEN/studio && npm run build`
Expected: build succeeds with no errors.

- [ ] **Step 5: Commit**

```bash
cd /Users/michael/Downloads/NEUEGEN
git add studio/src/components/TopBar.tsx studio/src/components/TopBar.module.css
git commit -m "feat: TopBar blocked banner with an actionable hint and a Retry action"
```

---

### Task 10: ActivityDock — treat `blocked` like `paused`/`cooling`

**Files:**
- Modify: `studio/src/components/ActivityDock.tsx`

**Why:** The Activity panel's running-jobs eyebrow shows a pause/continue toggle keyed off `isPaused`. It should recognize `blocked` too, so the same Continue/Retry affordance is available there as well.

- [ ] **Step 1: Update the `isPaused` check**

In `studio/src/components/ActivityDock.tsx`, find:
```tsx
  const run = state?.run;
  const isPaused = run?.state === 'paused' || run?.state === 'cooling';
```
Change to:
```tsx
  const run = state?.run;
  const isPaused = run?.state === 'paused' || run?.state === 'cooling' || run?.state === 'blocked';
```

- [ ] **Step 2: Check types and build**

Run:
```bash
cd /Users/michael/Downloads/NEUEGEN/studio
npm run typecheck
npm run build
```
Expected: both succeed with no errors.

- [ ] **Step 3: Commit**

```bash
cd /Users/michael/Downloads/NEUEGEN
git add studio/src/components/ActivityDock.tsx
git commit -m "fix: ActivityDock recognizes the blocked run-state as a paused-like state"
```

---

### Task 11: Settings — usage limit and concurrency controls

**Files:**
- Modify: `studio/src/components/SettingsDialog.tsx`
- Modify: `studio/src/components/SettingsDialog.module.css`

**Why:** This is where the two previously-dead backend controls (Task 7) become something the user can actually see and change.

- [ ] **Step 1: Add a text-input style for the System section**

In `studio/src/components/SettingsDialog.module.css`, find the `.usageSession` rule at the end of the file:
```css
.usageSession {
  color: var(--faint);
  font-weight: 400;
}
```
Add right after it:
```css

/* Small numeric input used by the System section's usage-limit / concurrency rows. */
.numberInput {
  width: 72px;
  height: 30px;
  padding: 0 var(--space-2);
  background: var(--surface-3);
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  font: 500 13px/1 var(--font-mono);
  color: var(--ink);
  text-align: center;
  transition: border-color var(--dur-2) var(--ease), background var(--dur-2) var(--ease);
}
.numberInput::placeholder {
  color: var(--faint);
}
.numberInput:hover {
  border-color: var(--glass-border-strong);
}
.numberInput:focus {
  outline: none;
  border-color: var(--accent);
  background: var(--surface);
}
```

- [ ] **Step 2: Add local state + save handlers**

In `studio/src/components/SettingsDialog.tsx`, find:
```tsx
  // System status — poll /api/health every 5s, but only while the dialog is open.
  // Null until the first probe resolves.
  const [health, setHealth] = useState<Health | null>(null);
  useEffect(() => {
    if (!settingsOpen) { setHealth(null); return; }
    let alive = true;
    const probe = () => api.getHealth().then((h) => { if (alive) setHealth(h); });
    probe();
    const t = window.setInterval(probe, 5000);
    return () => { alive = false; window.clearInterval(t); };
  }, [settingsOpen]);

  const bridgeUp = !!health?.bridge;
  const codexBusy = !!health?.codex?.alive;
```
Change to:
```tsx
  // System status — poll /api/health every 5s, but only while the dialog is open.
  // Null until the first probe resolves.
  const [health, setHealth] = useState<Health | null>(null);
  useEffect(() => {
    if (!settingsOpen) { setHealth(null); return; }
    let alive = true;
    const probe = () => api.getHealth().then((h) => { if (alive) setHealth(h); });
    probe();
    const t = window.setInterval(probe, 5000);
    return () => { alive = false; window.clearInterval(t); };
  }, [settingsOpen]);

  const bridgeUp = !!health?.bridge;
  const codexBusy = !!health?.codex?.alive;

  // Concurrency — free-typed text kept separate from the last-known server value, so mid-edit typing
  // isn't clobbered by the next 5s health poll. Only commits (POSTs) on blur/Enter.
  const [concurrencyInput, setConcurrencyInput] = useState('');
  useEffect(() => {
    if (health?.concurrency != null) setConcurrencyInput(String(health.concurrency));
  }, [health?.concurrency]);
  const commitConcurrency = () => {
    const n = Math.max(1, Math.min(10, Math.round(Number(concurrencyInput)) || 1));
    setConcurrencyInput(String(n));
    api.setConcurrency(n);
  };

  // Usage limit — same free-typed-then-commit pattern. Empty string = unlimited (limit: null).
  const [usageLimitInput, setUsageLimitInput] = useState('');
  useEffect(() => {
    setUsageLimitInput(codexUsage?.limit != null ? String(codexUsage.limit) : '');
  }, [codexUsage?.limit]);
  const commitUsageLimit = () => {
    const trimmed = usageLimitInput.trim();
    const n = trimmed === '' ? null : Math.max(1, Math.round(Number(trimmed)) || 1);
    setUsageLimitInput(n == null ? '' : String(n));
    api.setUsageLimit(n);
  };
```

- [ ] **Step 3: Add the two rows to the System section**

Find the System section's `kvRow` list:
```tsx
            {section === 'system' && (
            <section className={s.section}>
              <p className={`eyebrow ${s.eyebrow}`}>System</p>
              <div className={s.rows}>
                <div className={s.kvRow} role="status" aria-live="polite">
                  <span className={s.kvLabel}>Codex</span>
                  <span className={s.kvValue}>
                    <span className={s.statusDot} data-state={codexBusy ? 'busy' : 'ok'} />
                    {codexBusy ? 'Running' : 'Ready'}
                  </span>
                </div>
                <div className={s.kvRow} role="status" aria-live="polite">
                  <span className={s.kvLabel}>Bridge</span>
                  <span className={s.kvValue}>
                    <span className={s.statusDot} data-state={bridgeUp ? 'ok' : 'err'} />
                    {bridgeUp ? 'Up' : 'Down'}
                  </span>
                </div>
                <div className={s.kvRow}>
                  <span className={s.kvLabel}>Codex usage</span>
                  <span className={s.kvValue} data-known={usageKnown || undefined}>
                    {usageLabel}
                    {sessionCount > 0 && (
                      <span className={s.usageSession}> · {sessionCount} this session</span>
                    )}
                  </span>
                </div>
              </div>
            </section>
            )}
```
Change to:
```tsx
            {section === 'system' && (
            <section className={s.section}>
              <p className={`eyebrow ${s.eyebrow}`}>System</p>
              <div className={s.rows}>
                <div className={s.kvRow} role="status" aria-live="polite">
                  <span className={s.kvLabel}>Codex</span>
                  <span className={s.kvValue}>
                    <span className={s.statusDot} data-state={codexBusy ? 'busy' : 'ok'} />
                    {codexBusy ? 'Running' : 'Ready'}
                  </span>
                </div>
                <div className={s.kvRow} role="status" aria-live="polite">
                  <span className={s.kvLabel}>Bridge</span>
                  <span className={s.kvValue}>
                    <span className={s.statusDot} data-state={bridgeUp ? 'ok' : 'err'} />
                    {bridgeUp ? 'Up' : 'Down'}
                  </span>
                </div>
                <div className={s.kvRow}>
                  <span className={s.kvLabel}>Codex usage</span>
                  <span className={s.kvValue} data-known={usageKnown || undefined}>
                    {usageLabel}
                    {sessionCount > 0 && (
                      <span className={s.usageSession}> · {sessionCount} this session</span>
                    )}
                  </span>
                </div>
                <div className={s.settingRow}>
                  <div className={s.settingText} id="settings-concurrency-label">
                    <span className={s.rowLabel}>Concurrency</span>
                    <span className={s.rowHint}>How many images generate at once (1–10).</span>
                  </div>
                  <input
                    aria-labelledby="settings-concurrency-label"
                    className={`${s.numberInput} ${s.settingControl}`}
                    type="number"
                    min={1}
                    max={10}
                    value={concurrencyInput}
                    onChange={(e) => setConcurrencyInput(e.target.value)}
                    onBlur={commitConcurrency}
                    onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                  />
                </div>
                <div className={s.settingRow}>
                  <div className={s.settingText} id="settings-usage-limit-label">
                    <span className={s.rowLabel}>Usage limit</span>
                    <span className={s.rowHint}>Pause after N images this session. Blank = unlimited.</span>
                  </div>
                  <input
                    aria-labelledby="settings-usage-limit-label"
                    className={`${s.numberInput} ${s.settingControl}`}
                    type="number"
                    min={1}
                    placeholder="Unlimited"
                    value={usageLimitInput}
                    onChange={(e) => setUsageLimitInput(e.target.value)}
                    onBlur={commitUsageLimit}
                    onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                  />
                </div>
              </div>
            </section>
            )}
```

- [ ] **Step 4: Check types and build**

Run:
```bash
cd /Users/michael/Downloads/NEUEGEN/studio
npm run typecheck
npm run build
```
Expected: both succeed with no errors.

- [ ] **Step 5: Commit**

```bash
cd /Users/michael/Downloads/NEUEGEN
git add studio/src/components/SettingsDialog.tsx studio/src/components/SettingsDialog.module.css
git commit -m "feat: Settings controls for usage limit and concurrency"
```

---

### Task 12: Enqueue race hardening (minor)

**Files:**
- Modify: `studio/studio-server.mjs`
- Test: Create `studio/test/enqueue-lock.test.mjs`

**Why:** `enqueueSlot()`'s next-run-number computation (`doneRunCount + inflightCount + 1`) is read-then-write with no lock. Two near-simultaneous `/api/generate` calls targeting the exact same slot could compute the same run number. Files can't actually be overwritten (`versionedRelPath` re-checks disk at write time), but the gallery's "keep newest version per run" display can make a version appear to vanish. This task serializes enqueue per slot key so it can't happen at all. No live evidence this has occurred — this is defensive hardening, not a confirmed-bug fix.

`enqueueSlot`/`doneRunCount`/`inflightCount` are private functions inside `studio-server.mjs` (not exported), consistent with Task 7's constraint (no test harness for this file). Instead, this task adds a small, independently testable mutex helper as its own tiny module, then wires it in.

- [ ] **Step 1: Write the failing test**

Create `studio/test/enqueue-lock.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withKeyLock } from '../lib/keylock.mjs';

test('withKeyLock serializes calls that share a key', async () => {
  const order = [];
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  const a = withKeyLock('slot-1', async () => {
    order.push('a-start');
    await delay(30);
    order.push('a-end');
    return 'a';
  });
  const b = withKeyLock('slot-1', async () => {
    order.push('b-start');
    await delay(5);
    order.push('b-end');
    return 'b';
  });

  const results = await Promise.all([a, b]);
  assert.deepEqual(results, ['a', 'b']);
  // b must not start until a has fully finished, even though b's own work is faster.
  assert.deepEqual(order, ['a-start', 'a-end', 'b-start', 'b-end']);
});

test('withKeyLock does not serialize calls with different keys', async () => {
  const order = [];
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  const a = withKeyLock('slot-1', async () => {
    order.push('a-start');
    await delay(30);
    order.push('a-end');
  });
  const b = withKeyLock('slot-2', async () => {
    order.push('b-start');
    await delay(5);
    order.push('b-end');
  });

  await Promise.all([a, b]);
  // Different keys run concurrently, so b (faster) finishes before a.
  assert.deepEqual(order, ['a-start', 'b-start', 'b-end', 'a-end']);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd /Users/michael/Downloads/NEUEGEN/studio && npm test`
Expected: FAIL — `studio/lib/keylock.mjs` doesn't exist yet (module not found).

- [ ] **Step 3: Implement `lib/keylock.mjs`**

Create `studio/lib/keylock.mjs`:
```js
// lib/keylock.mjs — a tiny per-key async mutex. Zero deps: no timers, no external state beyond a
// Map of the tail of each key's promise chain. Used by studio-server.mjs to serialize the
// read-check-write span of enqueueSlot() per (brand,batch,ad,variation,prompt) key, so two
// near-simultaneous /api/generate calls for the exact same slot can't compute the same run number.
const chains = new Map(); // key -> Promise (the tail of that key's queue)

/**
 * Run `fn` after every previously-queued call for the same `key` has settled, and return its
 * result. Calls under different keys never wait on each other.
 *
 * @param {string} key
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export function withKeyLock(key, fn) {
  const prev = chains.get(key) || Promise.resolve();
  const run = prev.then(fn, fn); // run fn regardless of whether the previous call threw
  // Swallow rejection for the chain's own bookkeeping so one failed call doesn't wedge the key
  // forever — the real result/error still propagates to this call's own returned promise below.
  chains.set(key, run.catch(() => {}));
  return run;
}
```

- [ ] **Step 4: Run it again and confirm it passes**

Run: `cd /Users/michael/Downloads/NEUEGEN/studio && npm test`
Expected: PASS (12 tests total now).

- [ ] **Step 5: Wire it into `enqueueSlot`**

In `studio/studio-server.mjs`, add the import near the top with the other `lib/` imports:
```js
import { createJobStore } from './lib/jobstore.mjs';
import { createWorker, MAX_CONCURRENT_JOBS } from './lib/worker.mjs';
import { buildState } from './lib/state.mjs';
import { getCodexUsage, noteGenerated, noteRateLimit, setUsageLimit } from './lib/usage.mjs';
```
Change to:
```js
import { createJobStore } from './lib/jobstore.mjs';
import { createWorker, MAX_CONCURRENT_JOBS } from './lib/worker.mjs';
import { buildState } from './lib/state.mjs';
import { getCodexUsage, noteGenerated, noteRateLimit, setUsageLimit } from './lib/usage.mjs';
import { withKeyLock } from './lib/keylock.mjs';
```

Find `enqueueSlot`:
```js
function enqueueSlot(brand, batch, ad, v, p, variants, promptOverride, refsOverride) {
  const baseRun = doneRunCount(brand.id, batch.code, ad.id, v.id, p.id)
    + inflightCount(brand.id, batch.code, ad.id, v.id, p.id) + 1;
  const promptText = promptOverride || p.prompt;
  const size = (/^\d+x\d+$/.test(String(batch.aspect || '')) ? batch.aspect : '1024x1024');
  const baseRef = isTubeShot(promptText) ? tubeRefPath() : null;
  // Revise supplies its own refs (the original image + any board uploads); otherwise default to the
  // tube reference when this is a tube shot. `refs` (array) drives gen.mjs; `ref` kept for back-compat.
  const refs = (Array.isArray(refsOverride) && refsOverride.length)
    ? refsOverride.filter(Boolean)
    : (baseRef ? [baseRef] : []);
  const n = Math.max(1, Math.min(10, Number(variants) || 1));
  let enqueued = 0;
  for (let i = 0; i < n; i++) {
    store.enqueue({
      brand: brand.id,
      batch: batch.code,
      ad: ad.id,
      variation: v.id,
      prompt: p.id,
      run: baseRun + i,
      variants: n,
      promptText,
      size,
      refs,
      ref: refs[0] || null,
    });
    enqueued++;
  }
  return enqueued;
}
```
Change to (wrap the whole run-number-then-enqueue span in `withKeyLock`, keyed on the exact slot; the function becomes `async` and every call site must now be awaited):
```js
async function enqueueSlot(brand, batch, ad, v, p, variants, promptOverride, refsOverride) {
  const key = `${brand.id}/${batch.code}/${ad.id}/${v.id}/${p.id}`;
  return withKeyLock(key, async () => {
    const baseRun = doneRunCount(brand.id, batch.code, ad.id, v.id, p.id)
      + inflightCount(brand.id, batch.code, ad.id, v.id, p.id) + 1;
    const promptText = promptOverride || p.prompt;
    const size = (/^\d+x\d+$/.test(String(batch.aspect || '')) ? batch.aspect : '1024x1024');
    const baseRef = isTubeShot(promptText) ? tubeRefPath() : null;
    // Revise supplies its own refs (the original image + any board uploads); otherwise default to
    // the tube reference when this is a tube shot. `refs` (array) drives gen.mjs; `ref` kept for
    // back-compat.
    const refs = (Array.isArray(refsOverride) && refsOverride.length)
      ? refsOverride.filter(Boolean)
      : (baseRef ? [baseRef] : []);
    const n = Math.max(1, Math.min(10, Number(variants) || 1));
    let enqueued = 0;
    for (let i = 0; i < n; i++) {
      store.enqueue({
        brand: brand.id,
        batch: batch.code,
        ad: ad.id,
        variation: v.id,
        prompt: p.id,
        run: baseRun + i,
        variants: n,
        promptText,
        size,
        refs,
        ref: refs[0] || null,
      });
      enqueued++;
    }
    return enqueued;
  });
}
```

Now update the three call sites to `await` it. Find in `/api/generate`:
```js
      let enqueued = 0;
      for (const s of slots) enqueued += enqueueSlot(brand, batch, s.ad, s.variation, s.prompt, variants);
      sendJson(res, 200, { ok: true, enqueued });
```
Change to:
```js
      let enqueued = 0;
      for (const s of slots) enqueued += await enqueueSlot(brand, batch, s.ad, s.variation, s.prompt, variants);
      sendJson(res, 200, { ok: true, enqueued });
```
Find in `/api/regenerate`:
```js
      const enqueued = enqueueSlot(brand, batch, ad, v, p, 1);
      sendJson(res, 200, { ok: true, enqueued });
```
Change to:
```js
      const enqueued = await enqueueSlot(brand, batch, ad, v, p, 1);
      sendJson(res, 200, { ok: true, enqueued });
```
Find in `/api/revise`:
```js
      const enqueued = enqueueSlot(brand, batch, ad, v, p, 1, revisedPrompt, refs);
      sendJson(res, 200, { ok: true, enqueued, refs: refs.length });
```
Change to:
```js
      const enqueued = await enqueueSlot(brand, batch, ad, v, p, 1, revisedPrompt, refs);
      sendJson(res, 200, { ok: true, enqueued, refs: refs.length });
```
(All three call sites are already inside `async (req, res) => { ... }` request handlers, so `await` is valid in all of them.)

- [ ] **Step 6: Commit**

```bash
cd /Users/michael/Downloads/NEUEGEN
git add studio/lib/keylock.mjs studio/test/enqueue-lock.test.mjs studio/studio-server.mjs
git commit -m "fix: serialize enqueue-time run-number assignment per slot to close a rare race"
```

---

### Task 13: Full test suite + typecheck + build

**Files:** none (verification only)

- [ ] **Step 1: Run the full backend test suite**

Run: `cd /Users/michael/Downloads/NEUEGEN/studio && npm test`
Expected: all tests pass (12 tests across `jobstore.test.mjs`, `gen.test.mjs`, `worker.test.mjs`, `enqueue-lock.test.mjs`).

- [ ] **Step 2: Typecheck the frontend**

Run: `cd /Users/michael/Downloads/NEUEGEN/studio && npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Build the frontend**

Run: `cd /Users/michael/Downloads/NEUEGEN/studio && npm run build`
Expected: build succeeds. This produces a fresh `dist/` that the live server will pick up on its next restart (studio-server.mjs serves `dist/`, not `src/` directly).

If any step fails, stop and fix it before proceeding to Task 14 — do not hand a broken build to the manual-verification step.

---

### Task 14: Manual verification against a restarted server (still zero real Codex calls)

**Files:** none (verification only)

**This task restarts the user's real `studio-server.mjs` process.** That process is what serves `http://localhost:8788/` right now. Tell the user before doing this step — it briefly drops any open SSE connection (the page auto-reconnects or falls back to polling per `useEvents.ts`, so this is low-risk, but it IS their live session, not a throwaway one).

- [ ] **Step 1: Find and stop the current server**

Run: `lsof -nP -iTCP:8788 -sTCP:LISTEN`
Note the PID, then: `kill <PID>`

- [ ] **Step 2: Restart it pointed at the fake tool (still zero real Codex calls)**

Run:
```bash
cd /Users/michael/Downloads/NEUEGEN/studio
CHATGPT_IMAGEGEN=/Users/michael/Downloads/NEUEGEN/studio/test/fixtures/fake-imagegen.py \
FAKE_IMAGEGEN_MODE=fail \
FAKE_IMAGEGEN_ERROR="token refresh failed: HTTP 401" \
node studio-server.mjs &
```
Expected output: `[studio] http://localhost:8788`

- [ ] **Step 3: Curl the two new routes**

```bash
curl -s -X POST http://localhost:8788/api/concurrency -H 'content-type: application/json' -d '{"n":5}'
```
Expected: `{"ok":true,"concurrency":5}`

```bash
curl -s -X POST http://localhost:8788/api/usage-limit -H 'content-type: application/json' -d '{"limit":20}'
```
Expected: `{"ok":true,"limit":20}`

```bash
curl -s http://localhost:8788/api/health
```
Expected: JSON containing `"concurrency":5` and `"codexUsage":{...,"limit":20,...}`.

- [ ] **Step 4: Trigger the circuit breaker end-to-end and watch the UI, using the browser preview tools**

With the server still running against the fake tool in `fail` mode from Step 2, open `http://localhost:8788/` and enqueue at least 3 generations for the same batch (e.g. use the existing "Generate" flow in the UI for a small batch/ad). Confirm:
- After 3 identical failures, the TopBar shows the red "blocked" banner with the text "Codex login has expired. Run `codex login` in your terminal, then hit Retry."
- The primary button reads "Retry".
- Clicking Retry clears the banner and returns the run to idle (still against the fake tool — nothing will succeed until `FAKE_IMAGEGEN_MODE` changes, which is expected).
- Open Settings → System: confirm the Concurrency and Usage limit rows show the values set in Step 2 (5 and 20), and that changing them updates immediately (check `/api/health` again after changing).

- [ ] **Step 5: Restore the real server**

```bash
lsof -nP -iTCP:8788 -sTCP:LISTEN   # find the fake-tool server's PID
kill <PID>
cd /Users/michael/Downloads/NEUEGEN/studio
node studio-server.mjs &
```
This restarts the server with no env overrides — i.e. pointed at the real `chatgpt-imagegen.py` again, real `~/.codex/auth.json`. No generation happens automatically just from restarting; the next real generation attempt is still up to the user, and still needs `codex login` re-run first per the spec's root-cause finding.

- [ ] **Step 6: Report back**

Tell the user: all 12 automated tests pass, typecheck/build are clean, the blocked-banner + Settings controls were confirmed working live against the fake tool (zero real Codex calls), and the server is back to normal. Remind them that actual image generation still won't work until they run `npm i -g @openai/codex && codex login` (the root cause from the design spec — unrelated to any code in this plan).

---

## Self-review notes (for whoever executes this plan)

- **Spec coverage:** §1 (circuit breaker) → Tasks 5, 7 (blockedReason passthrough), 8, 9, 10. §2 (timeout) → Task 4. §3 (restart requeue) → Task 3. §4 (usage limit) → Tasks 7, 8, 11. §5 (concurrency) → Tasks 6, 7, 8, 11. §6 (enqueue race) → Task 12. §7 (duration pollution) → Task 2. Verification approach from the spec → Tasks 1, 13, 14. Every spec section has a task.
- **Placeholder scan:** no TBD/TODO; every step has complete, runnable code.
- **Type consistency check:** `blockedReason` is spelled identically in `worker.mjs` (Task 5), `studio-server.mjs`'s `buildRunInfo` (Task 7), `types.ts`'s `RunInfo` (Task 8), and `TopBar.tsx` (Task 9) — verified by re-reading each step above. `setConcurrency`/`status().concurrency` spelled identically in `worker.mjs` (Task 6), `studio-server.mjs` (Task 7), `types.ts`'s `Health` (Task 8), `api.ts` (Task 8), and `SettingsDialog.tsx` (Task 11). `setUsageLimit` (already existed in `lib/usage.mjs`) spelled identically in the new `studio-server.mjs` route (Task 7), `api.ts` (Task 8), and `SettingsDialog.tsx` (Task 11).
