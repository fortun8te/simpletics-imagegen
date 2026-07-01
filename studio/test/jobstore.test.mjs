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
