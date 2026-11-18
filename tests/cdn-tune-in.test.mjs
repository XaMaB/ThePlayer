import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const result = await build({
  stdin: {
    contents:
      "export * from './src/engines/hls/cdn-tune-in';export {httpAge} from './src/engines/hls/network';export {PlaylistLoader} from './src/engines/hls/playlist-reload';",
    resolveDir: new URL('..', import.meta.url).pathname,
  },
  bundle: true,
  write: false,
  format: 'esm',
});
const { httpAge, tuneInUrl, advancedMedia, PlaylistLoader } = await import(
  'data:text/javascript;base64,' +
    Buffer.from(result.outputFiles[0].text).toString('base64')
);
test('HTTP Age accepts integer cache seconds and rejects malformed metadata', () => {
  assert.equal(httpAge('0'), 0);
  assert.equal(httpAge(' 12 '), 12);
  for (const value of [
    null,
    '',
    '-1',
    '1.5',
    '1e3',
    'Infinity',
    '999999999999999999999',
  ])
    assert.equal(httpAge(value), undefined);
});
const first = {
  url: 'https://example.com/live.m3u8?token=keep&_HLS_skip=YES',
  targetDuration: 2,
  partTarget: 0.5,
  segments: [
    {
      sequence: 10,
      discontinuity: 0,
      part: 1,
      partOffset: 0.5,
      start: 0.5,
      duration: 0.5,
    },
  ],
};
test('CDN tune-in advances from the cached partial edge across parent boundaries', () => {
  for (const [duration, sequence, part] of [
    [0.5, 10, 2],
    [1, 10, 3],
    [1.1, 11, 0],
    [3, 11, 3],
    [7, 13, 3],
  ]) {
    const url = new URL(tuneInUrl(first, duration));
    assert.equal(url.searchParams.get('_HLS_msn'), String(sequence));
    assert.equal(url.searchParams.get('_HLS_part'), String(part));
    assert.equal(url.searchParams.get('token'), 'keep');
    assert.equal(url.searchParams.has('_HLS_skip'), false);
  }
  assert.throws(() => tuneInUrl(first, NaN), /Invalid/);
});
test('Additional published duration uses actual overlap or date anchors', () => {
  const current = {
    ...first,
    segments: [
      {
        sequence: 10,
        discontinuity: 0,
        part: 0,
        partOffset: 0,
        start: 0,
        duration: 0.5,
      },
      {
        sequence: 11,
        discontinuity: 0,
        part: 0,
        partOffset: 0,
        start: 2,
        duration: 0.5,
      },
    ],
  };
  assert.equal(advancedMedia(first, current), 1.5);
  assert.equal(
    advancedMedia(first, { ...current, segments: [current.segments[1]] }),
    undefined,
  );
  const dated = {
    ...first,
    segments: [
      { ...first.segments[0], programDateTime: '2026-01-01T00:00:00.500Z' },
    ],
  };
  assert.equal(
    advancedMedia(dated, {
      ...current,
      segments: [
        { ...current.segments[1], programDateTime: '2026-01-01T00:00:02.000Z' },
      ],
    }),
    1.5,
  );
});

test('A cache that never refreshes cannot cause unbounded tune-in requests', async () => {
  const data = new TextEncoder().encode(
    '#EXTM3U\n#EXT-X-VERSION:9\n#EXT-X-TARGETDURATION:2\n#EXT-X-PART-INF:PART-TARGET=0.5\n#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES,PART-HOLD-BACK=1.5\n#EXT-X-PART:DURATION=0.5,URI="p.ts",INDEPENDENT=YES\n',
  );
  let calls = 0;
  const abort = new AbortController();
  const client = {
    signal: abort.signal,
    options: {},
    get: async ({ url }) => {
      calls++;
      return { data, url, age: 6, elapsed: 0, receivedAt: performance.now() };
    },
  };
  const loader = new PlaylistLoader(client, () => ({}));
  const playlist = await loader.read('https://example.com/live.m3u8');
  assert.equal(playlist.segments.length, 1);
  assert.equal(calls, 4);
  assert.equal(loader.diagnostics.tuneInRequests, 3);
  assert.equal(loader.diagnostics.tuneInLimited, 1);
});
