import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
async function module(name) {
  const result = await build({
    entryPoints: [
      new URL('../src/engines/hls/' + name + '.ts', import.meta.url).pathname,
    ],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
  });
  return import(
    'data:text/javascript;base64,' +
      Buffer.from(result.outputFiles[0].text).toString('base64')
  );
}
const { parsePlaylist, attributes, alignPlaylist } = await module('playlist');
const { unwrap } = await module('transport-stream');
const { parseVtt } = await module('subtitles');
const base = 'https://example.com/live/index.m3u8';
const vod = (body, sequence = 0) =>
  `#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:${sequence}\n${body}`;
test('quoted commas and query URLs remain intact; duplicate attributes fail', () => {
  assert.deepEqual(
    attributes('CODECS="avc1.64001f,mp4a.40.2",URI="a?x=1,y=2"'),
    { CODECS: 'avc1.64001f,mp4a.40.2', URI: 'a?x=1,y=2' },
  );
  assert.throws(() => attributes('A=1,A=2'), /Duplicate/);
});
test('fMP4 map, implicit same-resource byte ranges and VOD duration', () => {
  const p = parsePlaylist(
    vod(
      '#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2,\n#EXT-X-BYTERANGE:100@5\na.mp4\n#EXTINF:1.5,\n#EXT-X-BYTERANGE:60\na.mp4\n#EXT-X-ENDLIST',
    ),
    base,
  );
  assert.equal(p.live, false);
  assert.equal(p.duration, 3.5);
  assert.deepEqual(p.segments[1].range, { length: 60, offset: 105 });
  assert.equal(p.segments[0].map.url, 'https://example.com/live/init.mp4');
  assert.throws(
    () => parsePlaylist(vod('#EXTINF:2,\n#EXT-X-BYTERANGE:10\na.mp4'), base),
    /offset/,
  );
});
test('keys, NONE resets and discontinuity sequence are scoped per segment', () => {
  const p = parsePlaylist(
    vod(
      '#EXT-X-DISCONTINUITY-SEQUENCE:5\n#EXT-X-KEY:METHOD=AES-128,URI="key",IV=0x01\n#EXTINF:2,\na.ts\n#EXT-X-DISCONTINUITY\n#EXT-X-KEY:METHOD=NONE\n#EXTINF:2,\nb.ts',
    ),
    base,
  );
  assert.equal(p.segments[0].key.iv[15], 1);
  assert.equal(p.segments[1].key, undefined);
  assert.equal(p.segments[1].discontinuity, 6);
});
test('live window alignment retains overlapping media positions and refuses resets', () => {
  const old = parsePlaylist(
    vod('#EXTINF:2,\na.ts\n#EXTINF:2,\nb.ts', 10),
    base,
  );
  const next = alignPlaylist(
    parsePlaylist(vod('#EXTINF:2,\nb.ts\n#EXTINF:2,\nc.ts', 11), base),
    old,
  );
  assert.equal(next.segments[0].start, 2);
  assert.equal(next.segments[1].start, 4);
  assert.throws(
    () => alignPlaylist(parsePlaylist(vod('#EXTINF:2,\nz.ts', 100), base), old),
    /synchronization/,
  );
});
test('variable substitution, required unsupported extensions and malformed input', () => {
  const p = parsePlaylist(
    vod('#EXT-X-DEFINE:NAME="file",VALUE="abc"\n#EXTINF:2,\n{$file}.ts'),
    base,
  );
  assert.equal(p.segments[0].url, 'https://example.com/live/abc.ts');
  assert.throws(() => parsePlaylist('not a playlist', base), /Not an HLS/);
  assert.throws(
    () => parsePlaylist(vod('#EXTINF:2,\na.ts\n#EXT-X-VERSION:99'), base),
    /Unsupported/,
  );
  const required = parsePlaylist(
    vod('#EXT-X-FOO:REQ-BAR=YES\n#EXTINF:2,\na.ts'),
    base,
  );
  assert.equal(required.unsupported.length, 1);
});
test('33-bit PES timestamp rollover preserves the nearest epoch', () => {
  assert.equal(unwrap(500, 2 ** 33 - 100), 2 ** 33 + 500);
  assert.equal(unwrap(2 ** 33 - 100, 500), -100);
});
test('WebVTT HLS timestamp map, explicit line breaks and cue settings', () => {
  const cues = parseVtt(
    'WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:900000\n\n1\n00:00:01.000 --> 00:00:03.500 align:start\nOne\nTwo\n',
    -10,
  );
  assert.deepEqual(cues, [
    { start: 1, end: 3.5, text: 'One\nTwo', settings: 'align:start' },
  ]);
});

const { ResourceClient } = await module('network');
const { createServer } = await import('node:http');
test('HTTP client retries, slices ignored range requests and aborts pending reads', async () => {
  let attempts = 0;
  const server = createServer((req, res) => {
    if (req.url === '/retry' && attempts++ === 0) {
      res.writeHead(503);
      res.end();
      return;
    }
    if (req.url === '/slow') {
      const timer = setTimeout(() => res.end('late'), 3000);
      req.on('close', () => clearTimeout(timer));
      return;
    }
    res.end(Buffer.from([0, 1, 2, 3, 4]));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const client = new ResourceClient(
      { retries: 1 },
      new AbortController().signal,
    );
    const result = await client.get({
      url: url + '/retry',
      range: { offset: 1, length: 2 },
    });
    assert.deepEqual(Array.from(result.data), [1, 2]);
    assert.equal(client.retries, 1);
    const abort = new AbortController();
    const pending = new ResourceClient({}, abort.signal).get({
      url: url + '/slow',
    });
    abort.abort();
    await assert.rejects(pending, { name: 'AbortError' });
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});

const { compatibleVariants, alignRendition, segmentAt, switchBoundary } =
  await module('renditions');
test('codec filtering excludes declared HE-AAC/HEVC and Dolby alternatives', () => {
  const variants = [
    { url: 'a', bandwidth: 1, codecs: 'avc1.64001f,mp4a.40.2' },
    { url: 'b', bandwidth: 2, codecs: 'avc1.64001f,mp4a.40.5' },
    { url: 'c', bandwidth: 3, codecs: 'hvc1.1.6.L93,ac-3' },
  ];
  assert.deepEqual(
    compatibleVariants(variants).map((v) => v.url),
    ['a'],
  );
});
test('renditions with different media sequence numbers align by program date', () => {
  const reference = parsePlaylist(
    vod(
      '#EXT-X-PROGRAM-DATE-TIME:2026-01-01T00:00:10Z\n#EXTINF:2,\na.ts\n#EXTINF:2,\nb.ts',
      20,
    ),
    base,
  );
  reference.segments = reference.segments.map((s) => ({
    ...s,
    start: s.start + 30,
  }));
  const audio = parsePlaylist(
    vod(
      '#EXT-X-PROGRAM-DATE-TIME:2026-01-01T00:00:12Z\n#EXTINF:2,\na.aac',
      400,
    ),
    base,
  );
  assert.equal(alignRendition(audio, reference).segments[0].start, 32);
  assert.equal(segmentAt(reference, 31), 0);
  assert.equal(switchBoundary(reference, 30), 32);
});
test('live rendition switch rejects unrelated timelines; VOD uses presentation positions', () => {
  const a = parsePlaylist(vod('#EXTINF:2,\na.ts', 1), base),
    b = parsePlaylist(vod('#EXTINF:2,\nb.ts', 99), base);
  assert.throws(() => alignRendition(a, b), /overlapping/);
  a.live = false;
  b.live = false;
  assert.equal(alignRendition(a, b).segments[0].start, 0);
  assert.throws(() => switchBoundary(a, 1.9), /No future/);
});

const { bufferedAhead, nextGapPosition } = await module('buffer');
const ranges = (items) => ({
  length: items.length,
  start: (i) => items[i][0],
  end: (i) => items[i][1],
});
test('buffer accounting merges frame-sized holes, but not missing segments', () => {
  assert.equal(
    bufferedAhead(
      ranges([
        [0, 10],
        [10.033, 30],
      ]),
      7,
    ),
    23,
  );
  assert.equal(
    bufferedAhead(
      ranges([
        [0, 10],
        [11, 30],
      ]),
      7,
    ),
    3,
  );
  assert.equal(bufferedAhead(ranges([[10, 20]]), 0), 0);
});
test('gap recovery only crosses tiny holes at the playback boundary', () => {
  assert.equal(
    nextGapPosition(
      ranges([
        [0, 10],
        [10.033, 30],
      ]),
      9.99,
    ),
    10.033 + 0.001,
  );
  assert.equal(
    nextGapPosition(
      ranges([
        [0, 10],
        [11, 30],
      ]),
      10,
    ),
    undefined,
  );
  assert.equal(
    nextGapPosition(
      ranges([
        [0, 10],
        [10.033, 30],
      ]),
      7,
    ),
    undefined,
  );
});
