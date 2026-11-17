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
test('codec filtering accepts HE-AAC v1 and excludes unsupported Dolby combinations', () => {
  const variants = [
    { url: 'a', bandwidth: 1, codecs: 'avc1.64001f,mp4a.40.2' },
    { url: 'b', bandwidth: 2, codecs: 'avc1.64001f,mp4a.40.5' },
    { url: 'c', bandwidth: 3, codecs: 'hvc1.1.6.L93,ac-3' },
  ];
  assert.deepEqual(
    compatibleVariants(variants).map((v) => v.url),
    ['a', 'b'],
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

const { AbrController } = await module('abr');
test('ABR needs evidence and buffer before upgrading, and limits upgrade churn', () => {
  const abr = new AbrController(),
    levels = [
      { bandwidth: 300000 },
      { bandwidth: 800000 },
      { bandwidth: 2000000 },
    ];
  abr.observe(500000, 1000);
  assert.equal(abr.choose(levels, 0, 12, 12, 1000), 0);
  abr.observe(500000, 1000);
  assert.equal(abr.choose(levels, 0, 1, 12, 2000), 0);
  assert.equal(abr.choose(levels, 0, 8, 12, 3000), 1);
  abr.switched(3000);
  assert.equal(abr.choose(levels, 1, 12, 12, 5000), 1);
  assert.equal(abr.choose(levels, 1, 12, 12, 12000), 2);
});
test('ABR reacts downwards to sustained slow delivery without waiting for upgrade cooldown', () => {
  const abr = new AbrController(),
    levels = [
      { bandwidth: 300000 },
      { bandwidth: 800000 },
      { bandwidth: 2000000 },
    ];
  abr.observe(500000, 1000);
  abr.observe(500000, 1000);
  abr.switched(1000);
  abr.observe(100000, 8000);
  assert.equal(abr.choose(levels, 2, 1, 12, 2000), 0);
  assert.ok(abr.estimate > 0);
});
const { aacConfiguration } = await module('aac');
test('HE-AAC ASC signals SBR and preserves the duration of its LC core', () => {
  const lc = aacConfiguration(7, 2),
    he = aacConfiguration(7, 2, 'mp4a.40.5');
  assert.equal(lc.rate, 22050);
  assert.equal(he.rate, 44100);
  assert.equal(lc.duration / lc.rate, he.duration / he.rate);
  assert.equal(he.asc[0] >>> 3, 5);
  assert.deepEqual([...he.asc], [0x2b, 0x92, 0x08, 0x00]);
  assert.throws(() => aacConfiguration(0, 2, 'mp4a.40.5'), /output rate/);
});

const { selectRendition } = await module('selection');
const renditionMaster = (body) =>
  `#EXTM3U\n${body}\n#EXT-X-STREAM-INF:BANDWIDTH=100000\nv.m3u8`;
test('DEFAULT/AUTOSELECT defaults and required group constraints follow EXT-X-MEDIA', () => {
  const p = parsePlaylist(
    renditionMaster(
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="English",LANGUAGE="en",DEFAULT=YES,URI="en.m3u8"',
    ),
    base,
  );
  assert.equal(p.renditions[0].default, true);
  assert.equal(p.renditions[0].autoselect, false);
  for (const attrs of [
    'DEFAULT=YES,AUTOSELECT=NO',
    'AUTOSELECT=MAYBE',
    'FORCED=NO',
  ])
    assert.throws(() =>
      parsePlaylist(
        renditionMaster(
          `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="A",${attrs}`,
        ),
        base,
      ),
    );
  assert.throws(
    () =>
      parsePlaylist(
        renditionMaster(
          '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="A",DEFAULT=YES\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="B",DEFAULT=YES',
        ),
        base,
      ),
    /Multiple DEFAULT/,
  );
});
test('selection honors explicit preferences, defaults and manual-only renditions', () => {
  const tracks = [
    { language: 'en', default: true, autoselect: true },
    { language: 'bg', default: false, autoselect: false },
    { language: 'es', default: false, autoselect: true },
  ];
  assert.equal(
    selectRendition(tracks, 'audio', { systemLanguages: ['bg'] }),
    tracks[0],
  );
  assert.equal(selectRendition(tracks, 'audio', { language: 'bg' }), tracks[1]);
  assert.equal(
    selectRendition(tracks.slice(1), 'audio', {
      systemLanguages: ['bg', 'es-MX'],
    }),
    tracks[2],
  );
  assert.equal(
    selectRendition([tracks[1]], 'audio', { systemLanguages: ['bg'] }),
    undefined,
  );
});
test('subtitle Off wins; forced environmental selection excludes full non-default subtitles', () => {
  const full = {
    language: 'en',
    default: false,
    autoselect: true,
    forced: false,
  };
  const forced = { ...full, forced: true };
  assert.equal(
    selectRendition([full], 'subtitles', { systemLanguages: ['en'] }),
    undefined,
  );
  assert.equal(
    selectRendition([full, forced], 'subtitles', {
      systemLanguages: ['en-US'],
    }),
    forced,
  );
  assert.equal(
    selectRendition([{ ...full, default: true }], 'subtitles', {
      language: 'off',
    }),
    undefined,
  );
  assert.equal(selectRendition([full], 'subtitles', { language: 'en' }), full);
});
test('MP4 descriptors preserve the explicit HE-AAC object type', async () => {
  const { initialization, inspectInit } = await module('mp4');
  const config = aacConfiguration(7, 2, 'mp4a.40.5');
  const data = initialization([
    {
      id: 2,
      kind: 'audio',
      timescale: config.rate,
      channels: 2,
      codec: config.codec,
      asc: config.asc,
    },
  ]);
  assert.equal(inspectInit(data)[0].codec, 'mp4a.40.5');
});

const { normalizeCodec } = await module('renditions');
test('legacy decimal AVC profile/level metadata is normalized without changing the playlist', () => {
  assert.equal(normalizeCodec('avc1.66.30'), 'avc1.42001e');
  assert.equal(normalizeCodec('avc1.77.31'), 'avc1.4d001f');
  assert.equal(normalizeCodec('avc1.100.40'), 'avc1.640028');
  const input = [
    { url: 'low', bandwidth: 493000, codecs: 'mp4a.40.2, avc1.66.30' },
    { url: 'hevc', bandwidth: 1024000, codecs: 'mp4a.40.2,hvc1.1.6.L150.90' },
    { url: 'invalid', bandwidth: 1, codecs: 'avc1.256.30' },
  ];
  assert.deepEqual(
    compatibleVariants(input).map((v) => v.codecs),
    ['mp4a.40.2,avc1.42001e', 'mp4a.40.2,hvc1.1.6.L150.90'],
  );
  assert.equal(input[0].codecs, 'mp4a.40.2, avc1.66.30');
});

const { browserVariants } = await module('renditions');
const { hevcCodec, hevcConfiguration } = await module('hevc');
test('HEVC codec strings retain tier case and reverse compatibility bits', () => {
  const config = new Uint8Array(23);
  config.set([1, 1, 0x60, 0, 0, 0, 0x90, 0, 0, 0, 0, 0, 150]);
  assert.equal(hevcCodec(config), 'hvc1.1.6.L150.90');
  assert.equal(normalizeCodec(' HVC1.1.6.l150.90 '), 'hvc1.1.6.L150.90');
  assert.throws(() => hevcCodec(config.slice(0, 12)), /Invalid/);
  assert.throws(
    () =>
      hevcConfiguration(new Uint8Array(), new Uint8Array(), new Uint8Array()),
    /Truncated/,
  );
});
test('browser capability filters HEVC without losing standalone audio', () => {
  const variants = [
    { url: 'hevc', bandwidth: 1000000, codecs: 'hvc1.1.6.L150.90,mp4a.40.2' },
    { url: 'audio', bandwidth: 64000, codecs: 'mp4a.40.2' },
    { url: 'avc', bandwidth: 500000, codecs: 'avc1.640028,mp4a.40.2' },
  ];
  assert.deepEqual(
    browserVariants(variants, (mime) => !mime.includes('hvc1')).map(
      (v) => v.url,
    ),
    ['audio', 'avc'],
  );
  assert.equal(browserVariants(variants, () => true).length, 3);
});

const { av1Codec, normalizeAv1Codec } = await module('av1');
test('AV1 configuration reads profile, tier, depth and nclx color metadata', () => {
  assert.equal(av1Codec(Uint8Array.of(0x81, 0, 0x0c, 0)), 'av01.0.00M.08');
  assert.equal(
    av1Codec(
      Uint8Array.of(0x81, 0, 0x4d, 0),
      Uint8Array.of(110, 99, 108, 120, 0, 1, 0, 1, 0, 1, 0),
    ),
    'av01.0.00M.10.0.111.01.01.01.0',
  );
  assert.equal(av1Codec(Uint8Array.of(0x81, 0x48, 0xe0, 0)), 'av01.2.08H.12');
  assert.throws(() => av1Codec(Uint8Array.of(1, 0, 12, 0)), /configuration/);
  assert.throws(() => av1Codec(Uint8Array.of(0x81, 0, 0x6c, 0)), /bit depth/);
  assert.throws(() => av1Codec(Uint8Array.of(0x81, 0, 12, 1)), /configuration/);
  assert.throws(() => av1Codec(Uint8Array.of(0x81, 0, 0x4f, 0)), /chroma/);
  assert.throws(
    () => av1Codec(Uint8Array.of(0x81, 0, 0x8c, 0)),
    /profile or level/,
  );
});
test('AV1 codec normalization retains tier and requires all optional fields together', () => {
  assert.equal(
    normalizeCodec('AV01.0.00m.10.0.111.01.01.01.0'),
    'av01.0.00M.10.0.111.01.01.01.0',
  );
  assert.equal(normalizeAv1Codec('av01.0.00M.10.0'), undefined);
  assert.equal(normalizeAv1Codec('av01.0.00M.10?ignored'), 'av01.0.00M.10');
  assert.equal(normalizeAv1Codec('av01.0.00M.12'), undefined);
  assert.equal(normalizeAv1Codec('av01.3.00M.10'), undefined);
  assert.equal(normalizeAv1Codec('av01.0.25M.08'), undefined);
  assert.equal(
    browserVariants(
      [{ url: 'a', bandwidth: 1, codecs: 'av01.0.00M.10,mp4a.40.2' }],
      (mime) => mime.includes('av01.0.00M.10'),
    ).length,
    1,
  );
});

test('ancillary c608/c708 tracks cannot block A/V or change fragment offsets', async () => {
  const { initialization, inspectInit, boxes, fragment, concat, decodeTime } =
    await module('mp4');
  const { filterCaptionInit, filterCaptionMedia } =
    await module('caption-tracks');
  const audio = {
    id: 1,
    kind: 'audio',
    timescale: 48000,
    codec: 'mp4a.40.2',
    channels: 2,
    asc: Uint8Array.of(0x11, 0x90),
  };
  const caption = { ...audio, id: 99 };
  const child = (data, type) => boxes(data).find((b) => b.type === type).body;
  for (const format of ['c608', 'c708']) {
    const init = initialization([audio, caption]);
    const trak = boxes(child(init, 'moov')).filter((b) => b.type === 'trak')[1]
      .body;
    const mdia = child(trak, 'mdia');
    child(mdia, 'hdlr').set(new TextEncoder().encode('clcp'), 8);
    const entry = boxes(
      child(child(child(mdia, 'minf'), 'stbl'), 'stsd').subarray(8),
    )[0];
    init.set(
      new TextEncoder().encode(format),
      entry.body.byteOffset - init.byteOffset - 4,
    );
    const original = init.slice();
    const filtered = filterCaptionInit(init);
    assert.deepEqual(init, original, 'input init remains immutable');
    assert.equal(filtered.data.length, init.length);
    assert.deepEqual(filtered.ignored, [{ id: 99, format }]);
    assert.deepEqual(
      inspectInit(filtered.data).map((t) => t.id),
      [1],
    );
    const sample = {
      data: Uint8Array.of(1, 2, 3),
      duration: 1024,
      cts: 0,
      key: true,
    };
    const active = fragment(audio, [sample], 5 * 48000, 1);
    const media = concat(active, fragment(caption, [sample], 0, 2));
    const before = media.slice();
    const output = filterCaptionMedia(media, filtered.ignored);
    assert.deepEqual(media, before);
    assert.equal(output.length, media.length);
    assert.deepEqual(
      output.subarray(0, active.length),
      active,
      'A/V bytes and trun offsets stay untouched',
    );
    assert.deepEqual(
      boxes(output)
        .filter((b) => b.type === 'mdat')
        .map((b) => b.body),
      boxes(media)
        .filter((b) => b.type === 'mdat')
        .map((b) => b.body),
    );
    assert.equal(
      decodeTime(output, inspectInit(filtered.data)),
      5,
      'caption timestamp must not anchor the A/V timeline',
    );
    assert.throws(() => inspectInit(init), /Unsupported HLS sample entry/);
  }
  const init = initialization([audio]);
  assert.equal(filterCaptionInit(init).data, init);
});

const { Cea608Decoder, row608Text } = await module('cea608');
const parity608 = (value) => {
  let n = value,
    bits = 0;
  while (n) {
    bits ^= n & 1;
    n >>>= 1;
  }
  return value | (bits ? 0 : 128);
};
function feed608(decoder, pairs, time = 0) {
  return pairs.flatMap(([a, b], i) =>
    decoder.push(parity608(a), parity608(b), time + i / 30),
  );
}
const plain608 = (event) =>
  event.rows.map((r) => r.cells.map((c) => c?.char ?? ' ').join('')).join('\n');
test('608 pop-on remains hidden until EOC; duplicate controls, PAC and erasure', () => {
  const d = new Cea608Decoder();
  assert.deepEqual(
    feed608(d, [
      [0x14, 0x20],
      [0x14, 0x20],
      [0x11, 0x54],
      [0x11, 0x54],
      [72, 73],
    ]),
    [],
  );
  const out = feed608(
    d,
    [
      [0x14, 0x2f],
      [0x14, 0x2f],
    ],
    1,
  );
  assert.equal(out.length, 1);
  assert.equal(plain608(out[0]), 'HI');
  assert.equal(out[0].rows[0].row, 0);
  assert.equal(out[0].rows[0].column, 8);
  assert.equal(
    feed608(
      d,
      [
        [0x14, 0x2c],
        [0x14, 0x2c],
      ],
      2,
    ).length,
    1,
  );
});
test('608 roll-up requires CR; PAC moves its base without implicitly scrolling', () => {
  const d = new Cea608Decoder();
  feed608(d, [
    [0x14, 0x25],
    [0x14, 0x25],
    [0x14, 0x70],
    [65, 65],
  ]);
  feed608(d, [
    [0x14, 0x2d],
    [0x14, 0x2d],
    [66, 66],
  ]);
  let rows = d.screens(0)[0].rows;
  assert.deepEqual(
    rows.map((r) => r.row),
    [13, 14],
  );
  assert.equal(plain608(d.screens(0)[0]), 'AA\nBB');
  feed608(d, [[0x16, 0x40]]);
  rows = d.screens(0)[0].rows;
  assert.deepEqual(
    rows.map((r) => r.row),
    [5, 6],
  );
  assert.equal(plain608(d.screens(0)[0]), 'AA\nBB');
});
test('608 extended replacement, special glyphs, channel isolation, parity and escaping', () => {
  const d = new Cea608Decoder();
  feed608(d, [
    [0x14, 0x29],
    [65, 0],
    [0x12, 0x20],
    [0x11, 0x37],
    [60, 38],
  ]);
  assert.equal(plain608(d.screens(0)[0]), 'Á♪<&');
  assert.match(row608Text(d.screens(0)[0].rows[0]), /&lt;/);
  feed608(d, [
    [0x1c, 0x29],
    [66, 66],
  ]);
  assert.equal(plain608(d.screens(0)[1]), 'BB');
  assert.equal(plain608(d.screens(0)[0]), 'Á♪<&');
  assert.deepEqual(d.push(0x14, parity608(0x2c), 2), []);
  assert.equal(d.parityErrors, 1);
  const copy = d.clone();
  feed608(copy, [[0x1c, 0x2c]]);
  assert.equal(plain608(d.screens(0)[1]), 'BB');
});
const { Cea608Timeline } = await module('cea608-timeline');
test('608 timeline replaces buffered future captions and checkpoints long-lived screens', () => {
  const t = new Cea608Timeline();
  const packets = (text, time) =>
    [[0x14, 0x29], ...Array.from(text, (c) => [c.charCodeAt(0), 0])].map(
      ([a, b], i) => ({
        first: parity608(a),
        second: parity608(b),
        time: time + i / 30,
      }),
    );
  t.update(packets('A', 0), 0, 0, 2, 0, 0);
  t.update(packets('B', 2), 0, 2, 4, 0, 0);
  assert.equal(plain608(t.events.at(-1)), 'AB');
  t.update(packets('C', 2), 0, 2, 4, 0, 0, true);
  assert.equal(plain608(t.events.at(-1)), 'AC');
  t.update([], 0, 50, 52, 0, 50);
  assert.ok(t.events.some((e) => plain608(e) === 'AC'));
  t.reset();
  assert.deepEqual(t.events, []);
});

test('c608 sample extraction honors composition offsets and rejects pointers outside mdat', async () => {
  const { initialization, boxes, fragment, box } = await module('mp4');
  const { captionMetadata, extract608 } = await module('c608-mp4');
  const track = {
    id: 2,
    kind: 'audio',
    timescale: 1000,
    codec: 'mp4a.40.2',
    channels: 2,
    asc: Uint8Array.of(0x11, 0x90),
  };
  const init = initialization([track]);
  const child = (d, t) => boxes(d).find((b) => b.type === t).body;
  const mdia = child(child(child(init, 'moov'), 'trak'), 'mdia');
  child(mdia, 'hdlr').set(new TextEncoder().encode('clcp'), 8);
  const entry = boxes(
    child(child(child(mdia, 'minf'), 'stbl'), 'stsd').subarray(8),
  )[0];
  init.set(
    new TextEncoder().encode('c608'),
    entry.body.byteOffset - init.byteOffset - 4,
  );
  const metadata = captionMetadata(init);
  const sample = {
    data: box('cdat', Uint8Array.of(parity608(0x14), parity608(0x2f))),
    duration: 1000,
    cts: -1000,
    key: true,
  };
  const media = fragment(track, [sample], 6000, 1);
  assert.deepEqual(extract608(media, metadata), [
    { time: 5, first: parity608(0x14), second: parity608(0x2f) },
  ]);
  const run = child(child(child(media, 'moof'), 'traf'), 'trun');
  new DataView(run.buffer, run.byteOffset, run.byteLength).setInt32(8, 0);
  assert.throws(() => extract608(media, metadata), /sample bounds/);
});
test('608 tab, underline/italics, backspace and delete-to-end stay inside the 32-column row', () => {
  const d = new Cea608Decoder();
  feed608(d, [
    [0x14, 0x29],
    [0x11, 0x4f],
    [0x17, 0x23],
    [65, 66],
    [0x14, 0x21],
    [67, 0],
    [0x14, 0x24],
  ]);
  const r = d.screens(0)[0].rows[0];
  assert.equal(r.column, 3);
  assert.equal(plain608(d.screens(0)[0]), 'AC');
  assert.equal(r.cells[0].italic, true);
  assert.equal(r.cells[0].underline, true);
  feed608(d, [
    [0x11, 0x5e],
    [0x17, 0x23],
    [65, 66],
    [67, 68],
  ]);
  assert.equal(d.screens(0)[0].rows[0].cells.at(-1).char, 'D');
});

test('recovery classifies transient transport failures, not auth or malformed media', async () => {
  const { HttpError, NetworkError, retryable, retryDelay } =
    await module('recovery');
  for (const code of [404, 408, 429, 500, 503])
    assert.equal(retryable(new HttpError(code)), true);
  for (const code of [400, 401, 403, 416])
    assert.equal(retryable(new HttpError(code)), false);
  assert.equal(retryable(new NetworkError('offline')), true);
  assert.equal(retryable(new DOMException('timeout', 'TimeoutError')), true);
  assert.equal(retryable(new DOMException('cancel', 'AbortError')), false);
  assert.equal(retryable(new Error('Invalid MP4')), false);
  assert.equal(retryDelay(100), 4000);
});
test('recovery validates budgets and can retain strict retry-count behavior', () => {
  for (const options of [
    { retries: -1 },
    { timeoutMs: 0 },
    { recoveryWindowMs: Infinity },
  ])
    assert.throws(
      () => new ResourceClient(options, new AbortController().signal),
      /Invalid HLS/,
    );
  assert.doesNotThrow(
    () =>
      new ResourceClient(
        { recoveryWindowMs: 0, retries: 0 },
        new AbortController().signal,
      ),
  );
});

test('declared GAP recovery crosses adjacent known gaps but not unknown missing content', async () => {
  const { declaredGapPosition } = await module('buffer');
  const ranges = {
    length: 2,
    start: (i) => [0, 10][i],
    end: (i) => [6, 14][i],
  };
  assert.equal(
    declaredGapPosition(ranges, 5.98, [
      { start: 6, end: 8 },
      { start: 8, end: 10 },
    ]),
    10.001,
  );
  assert.equal(
    declaredGapPosition(ranges, 6, [{ start: 6, end: 8 }]),
    undefined,
  );
  assert.equal(
    declaredGapPosition(ranges, 3, [{ start: 6, end: 10 }]),
    undefined,
  );
});

test('live progress counts media advancement, not repeated successful HTTP responses', async () => {
  const { LiveProgress, reconcileLive } = await module('live');
  const p = parsePlaylist(vod('#EXTINF:2,\na.ts\n#EXTINF:2,\nb.ts', 10), base);
  const tracker = new LiveProgress();
  assert.equal(tracker.observe(p, 100), 0);
  assert.equal(tracker.observe(p, 4100), 4000);
  const moved = parsePlaylist(
    vod('#EXTINF:2,\nb.ts\n#EXTINF:2,\nc.ts', 11),
    base,
  );
  assert.equal(tracker.observe(moved, 5000), 0);
  assert.equal(reconcileLive(moved, p, 11).restart, false);
  assert.equal(reconcileLive(moved, p, 10).reason, 'live-window-missed');
  const reset = parsePlaylist(vod('#EXTINF:2,\nnew.ts', 0), base);
  assert.equal(reconcileLive(reset, p, 12).restart, true);
  const changed = parsePlaylist(vod('#EXTINF:2,\nnew.ts', 10), base);
  assert.equal(reconcileLive(changed, p, 12).restart, true);
});

test('PSI assembler handles pointer tails, multi-packet sections, multiple sections and CRC corruption', async () => {
  const { PsiAssembler, PsiTable, psiCrc } = await module('psi');
  assert.equal(psiCrc(new TextEncoder().encode('123456789')), 0x0376e6e7);
  const section = (number, last, size = 200) => {
    const d = new Uint8Array(size);
    d.set([
      0,
      0xb0 | ((size - 3) >> 8),
      (size - 3) & 255,
      0,
      1,
      0xc1,
      number,
      last,
    ]);
    new DataView(d.buffer).setUint32(size - 4, psiCrc(d.subarray(0, -4)));
    return d;
  };
  const a = section(0, 1),
    b = section(1, 1, 16);
  const assembler = new PsiAssembler();
  assert.deepEqual(
    assembler.push(Uint8Array.from([0, ...a.slice(0, 150)]), true),
    [],
  );
  const result = assembler.push(
    Uint8Array.from([50, ...a.slice(150), ...b, 255, 255]),
    true,
  );
  assert.deepEqual(result, [a, b]);
  const table = new PsiTable();
  assert.equal(table.accept(a), undefined);
  assert.deepEqual(table.accept(b), [a, b]);
  const corrupt = b.slice();
  corrupt[9] ^= 1;
  assert.throws(
    () => new PsiAssembler().push(Uint8Array.from([0, ...corrupt]), true),
    /CRC/,
  );
  assert.throws(
    () => new PsiAssembler().push(Uint8Array.from([255]), true),
    /pointer/,
  );
});
