import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cachedStartPlan } from '../src/engines/moq/startup.mjs';
test('cache window covers four seconds plus a delivery cycle, with independently numbered audio', () => {
  const p = cachedStartPlan(
    { group: 50n, timing: { end: 100, duration: 2 } },
    { group: 100n, timing: { end: 100, duration: 1 } },
  );
  assert.equal(p.desiredStart, 94);
  assert.equal(p.video, 48n);
  assert.equal(p.audio, 95n);
  assert.equal(p.historyAvailable, true);
});
test('three-second GOP keeps four-second reserve and clamps young streams to available group IDs', () => {
  const p = cachedStartPlan(
    { group: 2n, timing: { end: 6, duration: 3 } },
    { group: 6n, timing: { end: 6, duration: 1 } },
  );
  assert.equal(p.reserve, 4);
  assert.equal(p.video, 1n);
  assert.equal(p.audio, 1n);
  assert.equal(p.historyAvailable, false);
  assert.throws(() => cachedStartPlan({ timing: null }, { timing: null }));
});
