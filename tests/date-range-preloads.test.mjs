import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const result = await build({
  stdin: {
    contents:
      "export * from './src/engines/hls/date-range-preloads'; export * from './src/engines/hls/date-ranges';",
    resolveDir: new URL('..', import.meta.url).pathname,
  },
  bundle: true,
  write: false,
  format: 'esm',
});
const { DateRangePreloads, parseDateRange } = await import(
  'data:text/javascript;base64,' +
    Buffer.from(result.outputFiles[0].text).toString('base64')
);
const range = (attributes = {}) =>
  parseDateRange({
    ID: 'hint',
    CLASS: 'com.apple.hls.preload',
    'START-DATE': '2026-01-01T00:00:00Z',
    DURATION: '6',
    'X-URI': 'ad.m3u8',
    'X-TARGET-ID': 'ad',
    'X-TARGET-CLASS': 'com.apple.hls.interstitial',
    ...attributes,
  });
const playlist = (ranges = [range()], live = true) => ({
  live,
  url: 'https://example.com/index.m3u8',
  segments: [{ start: 0, programDateTime: '2026-01-01T00:00:00Z' }],
  parts: [],
  dateRanges: ranges,
});
const tick = () => new Promise((r) => setTimeout(r, 0));
test('Date-range preload chooses a future time, reuses once and ignores VOD', async () => {
  const requests = [],
    warnings = [];
  const client = {
    get: async (resource, options) => {
      requests.push({ resource, options });
      return {
        data: Uint8Array.of(1),
        url: resource.url,
        elapsed: 1,
        receivedAt: performance.now(),
      };
    },
  };
  const cache = new DateRangePreloads(
    client,
    'session',
    (s) => warnings.push(s),
    () => 0.5,
  );
  cache.update(playlist(), 1);
  cache.tick(3);
  assert.equal(requests.length, 0);
  cache.tick(4);
  await tick();
  assert.equal(requests.length, 1);
  assert.ok(requests[0].resource.url.includes('_HLS_interstitial_id=ad'));
  assert.deepEqual(
    cache.take('ad', requests[0].resource.url).data,
    Uint8Array.of(1),
  );
  assert.equal(cache.take('ad', requests[0].resource.url), undefined);
  cache.update(playlist(), 1);
  cache.tick(5);
  assert.equal(requests.length, 1);
  cache.update(playlist([], false), 0);
  cache.update(playlist([range()], false), 0);
  cache.tick(4);
  assert.equal(requests.length, 1);
  assert.deepEqual(warnings, []);
});
test('Preload removal aborts requests; mismatched targets and invalid classes never load', async () => {
  const requests = [],
    warnings = [];
  const cache = new DateRangePreloads(
    {
      get: (r, o) => {
        requests.push(o);
        return new Promise(() => {});
      },
    },
    'session',
    (s) => warnings.push(s),
    () => 0,
  );
  cache.update(playlist(), 0);
  assert.equal(requests.length, 1);
  cache.update(playlist([]), 0);
  assert.equal(requests[0].signal.aborted, true);
  const target = parseDateRange({
    ID: 'ad',
    CLASS: 'com.apple.hls.interstitial',
    'START-DATE': '2026-01-01T00:00:08Z',
    'X-ASSET-URI': 'https://example.com/other.m3u8',
  });
  cache.update(playlist([range(), target]), 0);
  assert.equal(requests.length, 1);
  cache.update(playlist([range({ 'X-TARGET-CLASS': 'other' })]), 0);
  assert.equal(requests.length, 1);
  cache.update(playlist([range({ CUE: 'PRE' })]), 0);
  assert.equal(warnings.length, 1);
  cache.clear();
});
test('A pending preload cannot delay ordinary playback and cache resources are bounded', async () => {
  const requests = [];
  const cache = new DateRangePreloads(
    {
      get: (r, o) => {
        requests.push({ r, o });
        return new Promise(() => {});
      },
    },
    's',
    () => {},
    () => 0,
  );
  cache.update(playlist(), 0);
  assert.equal(cache.take('ad', requests[0].r.url), undefined);
  assert.equal(requests[0].o.signal.aborted, true);
  cache.clear();
  cache.update(
    playlist(
      Array.from({ length: 30 }, (_, n) =>
        range({ ID: 'hint' + n, 'X-TARGET-ID': 'ad' + n }),
      ),
    ),
    0,
  );
  assert.equal(
    requests.length,
    2,
    'Only two requests can be active, including the cancelled request awaiting settlement',
  );
  cache.clear();
});
