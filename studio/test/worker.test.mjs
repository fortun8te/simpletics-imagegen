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
