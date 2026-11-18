import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const r = await build({
  stdin: {
    contents:
      "export * from './src/engines/hls/interstitials';export * from './src/engines/hls/date-ranges';",
    resolveDir: new URL('..', import.meta.url).pathname,
  },
  bundle: true,
  write: false,
  format: 'esm',
});
const {
  parseInterstitial,
  parseDateRange,
  parseAssetList,
  interstitialUrl,
  interstitialResume,
  interstitialMarker,
  skipAvailable,
  snapInterstitial,
} = await import(
  'data:text/javascript;base64,' +
    Buffer.from(r.outputFiles[0].text).toString('base64')
);
const range = (extra = {}) => ({
  ...parseDateRange({
    ID: 'ad',
    CLASS: 'com.apple.hls.interstitial',
    'START-DATE': '2026-01-01T00:00:00Z',
    'X-ASSET-URI': 'https://cdn.example/ad.m3u8',
    ...extra,
  }),
  start: 4,
});
test('Interstitial timeline markers distinguish points, skipped ranges and PRE/POST', () => {
  const parse = (attributes) =>
    parseInterstitial(range(attributes), 'https://example.com/master.m3u8');
  assert.equal(interstitialMarker(parse({}), 12).end, undefined);
  assert.deepEqual(
    interstitialMarker(
      parse({
        'X-TIMELINE-OCCUPIES': 'RANGE',
        'X-RESUME-OFFSET': '3',
        'X-TIMELINE-STYLE': 'PRIMARY',
      }),
      12,
    ),
    {
      id: 'ad',
      time: 4,
      end: 7,
      label: 'Inserted content',
      style: 'primary',
    },
  );
  assert.equal(
    interstitialMarker(
      parse({
        'X-TIMELINE-OCCUPIES': 'RANGE',
        'PLANNED-DURATION': '8',
        'X-PLAYOUT-LIMIT': '2',
      }),
      12,
    ).end,
    6,
  );
  assert.equal(interstitialMarker(parse({ CUE: 'PRE' }), 12).time, 0);
  assert.equal(interstitialMarker(parse({ CUE: 'POST' }), 12).time, 12);
  assert.equal(
    interstitialMarker(
      parse({ 'X-TIMELINE-OCCUPIES': 'RANGE', 'X-RESUME-OFFSET': '-2' }),
      12,
    ).end,
    4,
  );
});
test('Interstitial assets, signed resume offsets, limits and skip windows', () => {
  const event = parseInterstitial(
    range({
      'X-RESUME-OFFSET': '-2',
      'X-PLAYOUT-LIMIT': '5',
      'X-SKIP-CONTROL-OFFSET': '2',
      'X-SKIP-CONTROL-DURATION': '3',
    }),
    'https://a.example/index.m3u8',
  );
  assert.equal(interstitialResume(event, 4, 10), 2);
  assert.equal(interstitialResume(event, 4, 10, true), 4);
  assert.equal(skipAvailable(event.skip, 1.99), false);
  assert.equal(skipAvailable(event.skip, 2), true);
  assert.equal(skipAvailable(event.skip, 5), false);
  const implicit = parseInterstitial(
    range({ 'X-PLAYOUT-LIMIT': '5' }),
    'https://a.example/index.m3u8',
  );
  assert.equal(interstitialResume(implicit, 4, 10), 9);
  assert.throws(
    () =>
      parseInterstitial(
        range({ 'X-ASSET-LIST': 'list.json' }),
        'https://a.example/index.m3u8',
      ),
    /exactly one/,
  );
});
test('Asset lists require absolute HTTP URIs and durations; empty lists are valid', () => {
  assert.deepEqual(parseAssetList({ ASSETS: [] }).assets, []);
  assert.equal(
    parseAssetList({
      ASSETS: [{ URI: 'https://a.example/ad', DURATION: 2.5 }],
      'SKIP-CONTROL': { OFFSET: 0 },
    }).skip.offset,
    0,
  );
  for (const ASSETS of [
    [{ URI: 'relative', DURATION: 1 }],
    [{ URI: 'javascript:alert(1)', DURATION: 1 }],
    [{ URI: 'https://a.example', DURATION: -1 }],
  ])
    assert.throws(() => parseAssetList({ ASSETS }));
});
test('Interstitial query context preserves signed query bytes and existing identifiers', () => {
  const uri = interstitialUrl(
    'https://a.example/ad?sig=a%20b&_HLS_interstitial_id=existing',
    'ad',
    'session',
    2,
  );
  assert.ok(uri.includes('sig=a%20b'));
  assert.ok(uri.includes('_HLS_interstitial_id=existing'));
  assert.ok(uri.includes('_HLS_start_offset=2'));
});
test('Snap chooses the closest segment boundary across media lanes', () => {
  const a = {
      segments: [
        { start: 0, duration: 2 },
        { start: 2, duration: 2 },
      ],
    },
    b = {
      segments: [
        { start: 0, duration: 2.1 },
        { start: 2.1, duration: 2.1 },
      ],
    };
  assert.equal(snapInterstitial(2.05, [a, b], 'OUT'), 2);
  assert.equal(snapInterstitial(2.05, [a, b], 'IN'), 2.1);
  assert.equal(snapInterstitial(1.9, [a, b], 'OUT'), 2);
  assert.equal(snapInterstitial(2.2, [a, b], 'IN'), 2.1);
  assert.equal(snapInterstitial(2, [], 'OUT'), 2);
});
