import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnosticJson } from '../demo/diagnostics.mjs';

test('catalog diagnostics preserve exact nested DASH BigInts as strings', () => {
  const value = {
    subtitles: [
      { address: { presentationTimeOffset: 9007199254740993n, duration: 0n } },
    ],
    tracks: [{ id: 1 }],
    empty: null,
  };
  const result = JSON.parse(diagnosticJson(value));
  assert.equal(
    result.subtitles[0].address.presentationTimeOffset,
    '9007199254740993',
  );
  assert.equal(result.subtitles[0].address.duration, '0');
  assert.equal(result.tracks[0].id, 1);
  assert.equal(result.empty, null);
  assert.equal(
    typeof value.subtitles[0].address.presentationTimeOffset,
    'bigint',
  );
  assert.equal(Object.hasOwn(BigInt.prototype, 'toJSON'), false);
});
