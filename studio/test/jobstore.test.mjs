import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
