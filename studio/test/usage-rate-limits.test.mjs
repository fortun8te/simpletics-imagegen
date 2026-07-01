import assert from 'node:assert/strict';
import { parseCodexRateLimits } from '../lib/usage.mjs';

const snapshot = parseCodexRateLimits({
  primary: { used_percent: 28.4, window_minutes: 300, resets_at: 1781745755 },
  secondary: { used_percent: 81.2, window_minutes: 10080, resets_at: 1782051320 },
});

assert.deepEqual(snapshot, {
  fivehLeft: 72,
  fivehResetsAt: 1781745755000,
  weeklyLeft: 19,
  weeklyResetsAt: 1782051320000,
});

assert.equal(parseCodexRateLimits(null), null);
assert.equal(parseCodexRateLimits({ primary: { used_percent: 10, window_minutes: 60, resets_at: 1 } }), null);
