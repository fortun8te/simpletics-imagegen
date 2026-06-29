const test = require('node:test');
const assert = require('node:assert/strict');
const Logic = require('../logic.js');

test('resetting a model only clears runs that use that model', () => {
  const state = {
    models: { m1: { status: 'done', dataUrl: 'model-1' }, m2: { status: 'done', dataUrl: 'model-2' } },
    runs: {
      'final:simpletics:b1:IMG01:A:p1:r1': { status: 'done', modelId: 'm1', dataUrl: 'a' },
      'final:simpletics:b1:IMG01:B:p1:r1': { status: 'done', modelId: 'm2', dataUrl: 'b' },
    },
  };
  assert.deepEqual(Logic.resetModel(state, 'm1'), {
    models: { m2: { status: 'done', dataUrl: 'model-2' } },
    runs: {
      'final:simpletics:b1:IMG01:B:p1:r1': { status: 'done', modelId: 'm2', dataUrl: 'b' },
    },
  });
});

test('resetting a variation clears its final runs but keeps models', () => {
  const state = { models: { m1: { status: 'done' } }, runs: { a: { variation: 'A' }, b: { variation: 'B' } } };
  assert.deepEqual(Logic.resetVariation(state, 'A'), { models: { m1: { status: 'done' } }, runs: { b: { variation: 'B' } } });
});
