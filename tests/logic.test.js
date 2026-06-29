const test = require('node:test');
const assert = require('node:assert/strict');
const Logic = require('../logic.js');

test('the default run count is 2 when nothing is selected', () => {
  assert.equal(Logic.defaultRunCount(), 2);
  assert.equal(Logic.normalizeRunCount(undefined), 2);
  assert.equal(Logic.normalizeRunCount(null), 2);
  assert.equal(Logic.normalizeRunCount('nope'), 2);
  assert.equal(Logic.normalizeRunCount(0), 2);
  assert.equal(Logic.normalizeRunCount(11), 2);
  // a single authored prompt with no chosen count expands to exactly 2 runs
  assert.equal(Logic.promptRuns({ id: 'A', prompt: 'Base prompt' }).length, 2);
});

test('grid mode sets every prompt run count to 1, without mutating input', () => {
  const ad = {
    id: 'IMG01',
    variations: [
      { id: 'A', prompts: [{ id: 'p1' }, { id: 'p2' }] },
      { id: 'B', prompt: 'single' },
    ],
  };
  const state = { promptRunCounts: { 'A:p1': 4, 'A:p2': 3, 'B:p1': 2 } };
  const next = Logic.gridModeRunCounts(state, ad);
  assert.equal(next['A:p1'], 1);
  assert.equal(next['A:p2'], 1);
  assert.equal(next['B:p1'], 1);
  assert.ok(Object.values(next).every((n) => n === 1));
  assert.equal(state.promptRunCounts['A:p1'], 4); // input untouched
  // the key shape matches promptRunKey
  assert.equal(Logic.promptRunKey({ id: 'A' }, 'p1'), 'A:p1');
});

test('model jobs have a unique key and their own folder', () => {
  const job = Logic.modelJobIdentity({ brand: 'simpletics', batch: 'b1', ad: 'IMG01', model: 'm2', run: 1 });
  assert.deepEqual(job, {
    key: 'model:simpletics:b1:IMG01:m2:r1',
    name: 'IMG01_b1_model_m2_r1',
    relativePath: 'simpletics/b1/models/IMG01/m2/run-1.png',
  });
});

test('final jobs keep variation, prompt, and run separate', () => {
  const job = Logic.finalJobIdentity({ brand: 'simpletics', batch: 'b1', ad: 'IMG01', variation: 'A', prompt: 'p2', run: 2 });
  assert.deepEqual(job, {
    key: 'final:simpletics:b1:IMG01:A:p2:r2',
    name: 'IMG01_b1_A_p2_r2',
    relativePath: 'simpletics/b1/ads/IMG01/A/p2/run-2.png',
  });
});

test('a single-prompt variation expands to exactly that one prompt (no phantom alternate take)', () => {
  const jobs = Logic.promptRuns({ id: 'A', prompt: 'Base prompt' });
  assert.deepEqual(jobs.map((job) => [job.promptId, job.run]), [['p1', 1], ['p1', 2]]);
  assert.equal(jobs[0].prompt, 'Base prompt');
});

test('a variation with two authored prompts keeps both, with two runs each by default', () => {
  const variation = { id: 'A', prompts: [{ id: 'p1', prompt: 'Take one' }, { id: 'p2', prompt: 'Take two' }] };
  const jobs = Logic.promptRuns(variation);
  assert.deepEqual(jobs.map((job) => [job.promptId, job.run]), [['p1', 1], ['p1', 2], ['p2', 1], ['p2', 2]]);
  assert.notEqual(jobs[0].prompt, jobs[2].prompt);
});

test('each authored prompt can expand to a selected run count from 1 to 10', () => {
  const variation = { id: 'A', prompts: [{ id: 'p1', prompt: 'Take one' }, { id: 'p2', prompt: 'Take two' }] };
  const jobs = Logic.promptRuns(variation, { runCounts: { p1: 1, p2: 4 } });
  assert.deepEqual(jobs.map((job) => [job.promptId, job.run]), [
    ['p1', 1],
    ['p2', 1],
    ['p2', 2],
    ['p2', 3],
    ['p2', 4],
  ]);
});

test('face ads continue with the selected or default model instead of requiring every model', () => {
  const ad = {
    kind: 'face',
    models: [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }],
    variations: [
      { id: 'A', model: 'm1' },
      { id: 'B', model: 'm1' },
      { id: 'C', model: 'm1' },
    ],
  };

  assert.deepEqual(Logic.faceReadyPlan(ad, { models: {}, varModel: {} }), { modelIds: ['m1'], variationIds: [] });
  assert.deepEqual(Logic.faceReadyPlan(ad, { models: { m1: { dataUrl: 'data:image/png;base64,ok' } }, varModel: {} }), { modelIds: [], variationIds: ['A', 'B', 'C'] });
  assert.deepEqual(Logic.faceReadyPlan(ad, { models: { m1: { dataUrl: 'data:image/png;base64,ok' } }, varModel: { B: 'm2' } }), { modelIds: ['m2'], variationIds: ['A', 'C'] });
});

test('ready prompt planning skips runs that already have saved output', () => {
  const runs = Logic.queueablePromptRuns(
    { id: 'A', prompt: 'Base prompt' },
    {
      runCounts: { p1: 2, p2: 1 },
      existingRuns: {
        'p1:1': { status: 'done', dataUrl: 'data:image/png;base64,ok' },
        'p2:1': { dataUrl: 'data:image/png;base64,ok' },
      },
      keyForRun: (run) => `${run.promptId}:${run.run}`,
    },
  );

  assert.deepEqual(runs.map((run) => [run.promptId, run.run]), [['p1', 2]]);
});

test('versionedRelPath returns the path unchanged when it is free', () => {
  const rel = 'simpletics/b1/ads/IMG01/A/p1/run-1.png';
  assert.equal(Logic.versionedRelPath(rel, () => false), rel);
});

test('versionedRelPath inserts -v2 before the extension when run-1.png exists', () => {
  const rel = 'simpletics/b1/ads/IMG01/A/p1/run-1.png';
  const exists = (p) => p === rel;
  assert.equal(Logic.versionedRelPath(rel, exists), 'simpletics/b1/ads/IMG01/A/p1/run-1-v2.png');
});

test('versionedRelPath skips to -v3 when v1 and v2 both exist', () => {
  const rel = 'simpletics/b1/ads/IMG01/A/p1/run-1.png';
  const taken = new Set([rel, 'simpletics/b1/ads/IMG01/A/p1/run-1-v2.png']);
  assert.equal(
    Logic.versionedRelPath(rel, (p) => taken.has(p)),
    'simpletics/b1/ads/IMG01/A/p1/run-1-v3.png',
  );
});

test('versionedRelPath handles non-png extensions', () => {
  const rel = 'simpletics/b1/ads/IMG01/A/p1/run-2.webp';
  assert.equal(
    Logic.versionedRelPath(rel, (p) => p === rel),
    'simpletics/b1/ads/IMG01/A/p1/run-2-v2.webp',
  );
});

test('parseRelPath parses a plain run as version 1', () => {
  assert.deepEqual(Logic.parseRelPath('simpletics/b1/ads/IMG01/A/p2/run-2.png'), {
    brand: 'simpletics',
    batch: 'b1',
    ad: 'IMG01',
    variation: 'A',
    prompt: 'p2',
    run: 2,
    version: 1,
    ext: 'png',
  });
});

test('parseRelPath parses a versioned run back to its base run slot', () => {
  assert.deepEqual(Logic.parseRelPath('simpletics/b1/ads/IMG01/A/p2/run-2-v3.png'), {
    brand: 'simpletics',
    batch: 'b1',
    ad: 'IMG01',
    variation: 'A',
    prompt: 'p2',
    run: 2,
    version: 3,
    ext: 'png',
  });
});

test('parseRelPath returns null for a non-ads path', () => {
  assert.equal(Logic.parseRelPath('simpletics/b1/models/IMG01/m1/run-1.png'), null);
});
