import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PublishedRate } from '../src/core/rate.mjs';
test('fragment bursts are averaged across the window and channel switches reset the baseline', () => {
  const r = new PublishedRate();
  assert.equal(r.update('bnt-1', 0, 0), null);
  assert.equal(r.update('bnt-1', 2500000, 2000), 10);
  assert.equal(r.update('bnt-1', 2500000, 4000), 5);
  assert.equal(r.update('bnt-1', 5000000, 6000), 20 / 3);
  assert.equal(r.update('cineedge-1', 100000000, 8000), null);
  assert.equal(r.update('cineedge-1', 101000000, 10000), 4);
  assert.equal(r.update('cineedge-1', 1, 12000), null);
});
