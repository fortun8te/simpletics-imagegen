const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, existsSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const png = (tag) => `data:image/png;base64,${Buffer.from(tag).toString('base64')}`;

test('a result with images:[a,b] writes one file per variantPath', async () => {
  const { writeVariants } = await import('../bridge-queue.mjs');
  const out = mkdtempSync(join(tmpdir(), 'imagegen-'));
  const job = {
    name: 'IMG01_b1_A_p1',
    relativePath: 'simpletics/b1/ads/IMG01/A/p1/run-1.png',
    variants: 2,
    variantPaths: ['simpletics/b1/ads/IMG01/A/p1/run-1.png', 'simpletics/b1/ads/IMG01/A/p1/run-2.png'],
  };
  const written = writeVariants(out, job, [png('first'), png('second')]);
  assert.deepEqual(written.map((w) => w.relativePath), job.variantPaths);
  for (const w of written) assert.equal(existsSync(w.path), true);
  assert.equal(readFileSync(written[0].path).toString(), 'first');
  assert.equal(readFileSync(written[1].path).toString(), 'second');
});

test('a single-image result still writes one file to relativePath', async () => {
  const { writeVariants } = await import('../bridge-queue.mjs');
  const out = mkdtempSync(join(tmpdir(), 'imagegen-'));
  const job = { name: 'IMG01_b1_A_p1', relativePath: 'a/b/run-1.png', variants: 1, variantPaths: null };
  const written = writeVariants(out, job, [png('solo')]);
  assert.equal(written.length, 1);
  assert.equal(written[0].relativePath, 'a/b/run-1.png');
  assert.equal(readFileSync(written[0].path).toString(), 'solo');
});

test('a partial capture (2 of 3) writes 2 files and reports the missing slot', async () => {
  const { writeVariants, missingVariantSlots } = await import('../bridge-queue.mjs');
  const out = mkdtempSync(join(tmpdir(), 'imagegen-'));
  const job = { name: 'IMG01_b1_A_p1', relativePath: 'ads/run-1.png', variants: 3, variantPaths: ['ads/run-1.png', 'ads/run-2.png', 'ads/run-3.png'] };
  const written = writeVariants(out, job, [png('one'), png('two')]);
  assert.equal(written.length, 2);
  assert.deepEqual(missingVariantSlots(job, written.length), [{ variantIndex: 2, relativePath: 'ads/run-3.png' }]);
});

test('writeVariants never overwrites: an existing target is written to its -v2 path', async () => {
  const { writeVariants } = await import('../bridge-queue.mjs');
  const out = '/out';
  const taken = new Set([join(out, 'simpletics/b1/ads/IMG01/A/p1/run-1.png')]);
  const writes = [];
  const fs = {
    existsSync: (p) => taken.has(p),
    mkdirSync: () => {},
    writeFileSync: (p) => writes.push(p),
  };
  const job = {
    name: 'IMG01_b1_A_p1',
    relativePath: 'simpletics/b1/ads/IMG01/A/p1/run-1.png',
    variants: 1,
    variantPaths: ['simpletics/b1/ads/IMG01/A/p1/run-1.png'],
  };

  const written = writeVariants(out, job, [png('fresh')], fs);

  assert.equal(written.length, 1);
  assert.equal(written[0].relativePath, 'simpletics/b1/ads/IMG01/A/p1/run-1-v2.png');
  assert.equal(written[0].path, join(out, 'simpletics/b1/ads/IMG01/A/p1/run-1-v2.png'));
  // the original file was never touched
  assert.deepEqual(writes, [join(out, 'simpletics/b1/ads/IMG01/A/p1/run-1-v2.png')]);
});

test('Telegram runs command expands real pending jobs instead of only changing a label', async () => {
  const { applyQueueCommand } = await import('../bridge-queue.mjs');
  const jobs = new Map([
    ['j1', { id: 'j1', name: 'IMG01_b1_A_p1_r1', prompt: 'prompt', refs: [], project: 'Batch', relativePath: 'simpletics/b1/ads/IMG01/A/p1/run-1.png', status: 'pending' }],
    ['j2', { id: 'j2', name: 'IMG01_b1_A_p1_r2', prompt: 'prompt', refs: [], project: 'Batch', relativePath: 'simpletics/b1/ads/IMG01/A/p1/run-2.png', status: 'pending' }],
  ]);
  let next = 2;

  const result = applyQueueCommand(jobs, { type: 'runs', name: 'IMG01_b1_A_p1', count: 4 }, { nextId: () => `j${++next}` });

  assert.equal(result.message, 'Set 4 runs for IMG01_b1_A_p1.');
  assert.deepEqual([...jobs.values()].map((job) => [job.id, job.name, job.relativePath, job.status]), [
    ['j1', 'IMG01_b1_A_p1_r1', 'simpletics/b1/ads/IMG01/A/p1/run-1.png', 'pending'],
    ['j2', 'IMG01_b1_A_p1_r2', 'simpletics/b1/ads/IMG01/A/p1/run-2.png', 'pending'],
    ['j3', 'IMG01_b1_A_p1_r3', 'simpletics/b1/ads/IMG01/A/p1/run-3.png', 'pending'],
    ['j4', 'IMG01_b1_A_p1_r4', 'simpletics/b1/ads/IMG01/A/p1/run-4.png', 'pending'],
  ]);
});

test('queue snapshot reports skipped jobs as visible settled work', async () => {
  const { queueSnapshot, formatQueueStatus } = await import('../bridge-queue.mjs');
  const jobs = new Map([
    ['j1', { id: 'j1', name: 'done-job', status: 'done' }],
    ['j2', { id: 'j2', name: 'failed-job', status: 'error' }],
    ['j3', { id: 'j3', name: 'skipped-job', status: 'skipped' }],
    ['j4', { id: 'j4', name: 'waiting-job', status: 'pending' }],
    ['j5', { id: 'j5', name: 'current-job', status: 'running' }],
  ]);

  const snapshot = queueSnapshot(jobs, { paused: true, out: '/tmp/out' });

  assert.equal(snapshot.total, 5);
  assert.equal(snapshot.done, 1);
  assert.equal(snapshot.error, 1);
  assert.equal(snapshot.skipped, 1);
  assert.equal(snapshot.pending, 1);
  assert.equal(snapshot.running, 1);
  assert.equal(snapshot.settled, 3);
  assert.equal(snapshot.current, 'current-job');
  assert.equal(formatQueueStatus(snapshot), 'ImageGen: 1/5 finished, 1 waiting, 1 running, 1 failed, 1 skipped, paused.');
});
