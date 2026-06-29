const test = require('node:test');
const assert = require('node:assert/strict');
const Logic = require('../logic.js');

test('fresh generated output ignores uploaded references', () => {
  const baseline = new Set(['https://cdn.example/ref.png']);
  const candidates = [
    { src: 'https://cdn.example/ref.png', generated: false },
    { src: 'https://files.oaiusercontent.com/final.png', generated: true },
  ];
  assert.equal(Logic.freshGeneratedSrc(candidates, baseline), 'https://files.oaiusercontent.com/final.png');
});

test('a generated image already present before the prompt is ignored', () => {
  const baseline = new Set(['https://files.oaiusercontent.com/old.png']);
  const candidates = [{ src: 'https://files.oaiusercontent.com/old.png', generated: true }];
  assert.equal(Logic.freshGeneratedSrc(candidates, baseline), null);
});
