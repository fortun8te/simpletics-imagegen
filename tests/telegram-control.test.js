const test = require('node:test');
const assert = require('node:assert/strict');

test('Telegram commands are parsed into safe queue actions', async () => {
  const { parseCommand } = await import('../telegram-control.mjs');
  assert.deepEqual(parseCommand('/status'), { type: 'status' });
  assert.deepEqual(parseCommand('/pause'), { type: 'pause' });
  assert.deepEqual(parseCommand('/retry IMG01_b1_A_p1_r1'), { type: 'retry', name: 'IMG01_b1_A_p1_r1' });
  assert.deepEqual(parseCommand('/runs IMG01_b1_A_p1 4'), { type: 'runs', name: 'IMG01_b1_A_p1', count: 4 });
  assert.equal(parseCommand('/runs IMG01 11'), null);
});
