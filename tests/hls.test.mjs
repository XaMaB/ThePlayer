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
test('codec filtering accepts declared AAC/Dolby formats and excludes unknown audio codecs', () => {
  const variants = [
    { url: 'a', bandwidth: 1, codecs: 'avc1.64001f,mp4a.40.2' },
    { url: 'b', bandwidth: 2, codecs: 'avc1.64001f,mp4a.40.5' },
    { url: 'c', bandwidth: 3, codecs: 'hvc1.1.6.L93,ac-3' },
    { url: 'd', bandwidth: 4, codecs: 'avc1.64001f,unknown.audio' },
  ];
  assert.deepEqual(
    compatibleVariants(variants).map((v) => v.url),
    ['a', 'b', 'c'],
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

test('HE-AAC v2 declares PS with a mono core and stereo output at the original sample clock', async () => {
  const config = aacConfiguration(6, 1, 'mp4a.40.29');
  assert.equal(config.codec, 'mp4a.40.29');
  assert.equal(config.channels, 2);
  assert.equal(config.rate, 48000);
  assert.equal(config.duration / config.rate, 1024 / 24000);
  assert.deepEqual([...config.asc], [0xeb, 0x09, 0x88, 0x00]);
  assert.throws(() => aacConfiguration(6, 2, 'mp4a.40.29'), /mono AAC core/);
  const { initialization, inspectInit } = await module('mp4');
  const init = initialization([
    {
      id: 2,
      kind: 'audio',
      timescale: config.rate,
      channels: config.channels,
      codec: config.codec,
      asc: config.asc,
    },
  ]);
  assert.equal(inspectInit(init)[0].codec, 'mp4a.40.29');
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
    const { fragmentMetadata } = await module('fragment-samples');
    const sanitized = filterCaptionMedia(
      media,
      filtered.ignored,
      fragmentMetadata(init),
    );
    assert.deepEqual(
      boxes(sanitized).map((box) => box.type),
      ['moof', 'mdat', 'free', 'free'],
    );
    assert.deepEqual(sanitized.subarray(0, active.length), active);
    assert.equal(sanitized.length, media.length);

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

test('AVC slice metadata detects pictures without AUD and preserves multi-slice grouping', async () => {
  const { AvcPictures, newPicture } = await module('avc-access');
  const ue = (n) => {
    const value = (n + 1).toString(2);
    return '0'.repeat(value.length - 1) + value;
  };
  const bits = (n, size) => n.toString(2).padStart(size, '0');
  const nal = (header, syntax) => {
    const data = syntax + '1';
    return Uint8Array.from([
      header,
      ...Array.from({ length: Math.ceil(data.length / 8) }, (_, i) =>
        parseInt(data.slice(i * 8, i * 8 + 8).padEnd(8, '0'), 2),
      ),
    ]);
  };
  const decoder = new AvcPictures();
  decoder.parameter(
    nal(
      0x67,
      bits(66, 8) +
        bits(0, 8) +
        bits(30, 8) +
        ue(0) +
        ue(0) +
        ue(0) +
        ue(0) +
        ue(1) +
        '0' +
        ue(19) +
        ue(10) +
        '110' +
        '0',
    ),
  );
  decoder.parameter(nal(0x68, ue(0) + ue(0) + '00'));
  const slice = (firstMb, frame, poc) =>
    decoder.picture(
      nal(0x41, ue(firstMb) + ue(0) + ue(0) + bits(frame, 4) + bits(poc, 4)),
    );
  const first = slice(0, 0, 0),
    continuation = slice(20, 0, 0),
    next = slice(0, 1, 2);
  assert.equal(newPicture(first, continuation), false);
  assert.equal(newPicture(first, next), true);
  assert.throws(
    () => decoder.picture(nal(0x41, ue(0) + ue(0) + ue(255))),
    /Missing AVC/,
  );
  assert.throws(
    () => decoder.parameter(Uint8Array.from([0x67, 0x64])),
    /Truncated/,
  );
});

test('ABR quarantines failed variants without choosing blocked intermediate upgrades', () => {
  const abr = new AbrController();
  const levels = [300000, 800000, 2000000].map((bandwidth) => ({ bandwidth }));
  abr.observe(1000000, 1000);
  abr.observe(1000000, 1000);
  abr.quarantine(1, 0, 'HTTP 503');
  assert.equal(abr.choose(levels, 0, 12, 12, 1000), 2);
  assert.equal(abr.fallback(levels, 2, 1000), 0);
  assert.equal(abr.fallback(levels, 2, 30000), 1);
  abr.quarantine(1, 30000, 'HTTP 503');
  assert.equal(abr.fallback(levels, 2, 89999), 0);
  assert.equal(abr.fallback(levels, 2, 90000), 1);
  abr.clear(1);
  assert.deepEqual(abr.quarantined(40000), []);
});

test('Emergency ABR compares replacement cost with finishing the current response', () => {
  const abr = new AbrController();
  const levels = [300000, 800000, 2000000].map((bandwidth) => ({ bandwidth }));
  assert.equal(
    abr.emergency(levels, 2, { loaded: 0, elapsedMs: 500 }, 1, 2, 0),
    undefined,
  );
  assert.equal(
    abr.emergency(levels, 2, { loaded: 0, elapsedMs: 2000 }, 2, 2, 0),
    1,
  );
  assert.equal(
    abr.emergency(
      levels,
      2,
      { loaded: 100000, total: 500000, elapsedMs: 1000 },
      2,
      2,
      0,
    ),
    0,
  );
  assert.equal(
    abr.emergency(
      levels,
      2,
      { loaded: 490000, total: 500000, elapsedMs: 2000 },
      1,
      2,
      0,
    ),
    undefined,
  );
  abr.quarantine(0, 0, 'failed');
  assert.equal(
    abr.emergency(
      levels,
      2,
      { loaded: 100000, total: 500000, elapsedMs: 1000 },
      2,
      2,
      0,
    ),
    1,
  );
  abr.quarantine(1, 0, 'failed');
  assert.equal(
    abr.emergency(levels, 2, { loaded: 0, elapsedMs: 2000 }, 2, 2, 0),
    undefined,
  );
});

test('Per-resource cancellation and progress abort leave sibling requests usable', async () => {
  const server = createServer((req, res) => {
    if (req.url === '/fast') return res.end('ok');
    const timer = setTimeout(() => res.end('late'), 5000);
    res.on('close', () => clearTimeout(timer));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const root = new AbortController();
  const client = new ResourceClient({}, root.signal);
  try {
    const reason = new Error('emergency downshift');
    await assert.rejects(
      client.get(
        { url: base + '/slow' },
        {
          onProgress: (progress) => {
            assert.equal(progress.loaded, 0);
            if (progress.elapsedMs >= 200) throw reason;
          },
        },
      ),
      (error) => error === reason,
    );
    assert.equal(client.retries, 0);
    const single = new AbortController();
    const pending = client.get(
      { url: base + '/slow' },
      { signal: single.signal },
    );
    single.abort(reason);
    await assert.rejects(pending, (error) => error === reason);
    assert.equal(
      new TextDecoder().decode(
        (await client.get({ url: base + '/fast' })).data,
      ),
      'ok',
    );
    assert.equal(root.signal.aborted, false);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('Delta update restores skipped resource, map, key, discontinuity and implicit byte-range state', () => {
  const base = 'https://example.test/live.m3u8';
  const common =
    '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:10\n#EXT-X-DISCONTINUITY-SEQUENCE:3\n';
  const previous = parsePlaylist(
    common +
      '#EXT-X-MAP:URI="init.mp4"\n#EXT-X-KEY:METHOD=AES-128,URI="key",IV=0x1\n#EXT-X-BYTERANGE:10@0\n#EXTINF:2,\nmedia\n#EXT-X-BYTERANGE:10\n#EXTINF:2,\nmedia\n',
    base,
  );
  const delta =
    common +
    '#EXT-X-SKIP:SKIPPED-SEGMENTS=2\n#EXT-X-BYTERANGE:10\n#EXTINF:2,\nmedia\n';
  const next = parsePlaylist(delta, base, {}, previous);
  assert.equal(next.segments.length, 3);
  assert.equal(next.duration, 6);
  assert.equal(next.segments[2].sequence, 12);
  assert.equal(next.segments[2].discontinuity, 3);
  assert.equal(next.segments[2].range.offset, 20);
  assert.equal(next.segments[2].key.url, 'https://example.test/key');
  assert.equal(next.segments[2].map.url, 'https://example.test/init.mp4');
  assert.throws(() => parsePlaylist(delta, base), /complete playlist reload/);
  assert.throws(
    () =>
      parsePlaylist(
        delta.replace('SEGMENTS=2', 'SEGMENTS=3'),
        base,
        {},
        previous,
      ),
    /complete playlist reload/,
  );
  assert.equal(previous.segments.length, 2);
});

test('Playlist delivery directives preserve signed queries and require advertised capabilities and fresh cache', async () => {
  const { reloadUrl, canonicalPlaylistUrl } = await module('playlist-reload');
  const p = parsePlaylist(
    '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:10\n#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES,CAN-SKIP-UNTIL=12\n#EXTINF:2,\na.ts\n',
    'https://example.test/live.m3u8?token=abc',
  );
  let url = new URL(reloadUrl(p, 1000));
  assert.equal(url.searchParams.get('_HLS_msn'), '11');
  assert.equal(url.searchParams.get('_HLS_skip'), 'YES');
  assert.equal(url.searchParams.get('token'), 'abc');
  assert.equal(canonicalPlaylistUrl(url.href), p.url);
  url = new URL(reloadUrl(p, 6001, false));
  assert.equal(url.searchParams.has('_HLS_msn'), false);
  assert.equal(url.searchParams.has('_HLS_skip'), false);
  assert.equal(reloadUrl({ ...p, live: false }, 0), p.url);
  assert.equal(reloadUrl({ ...p, serverControl: undefined }, 0), p.url);
});

test('LL-HLS parts retain parent sequence, dependencies, duration and delta reload cursor', async () => {
  const { playablePlaylist, independentIndex } = await module('playlist');
  const { reloadUrl } = await module('playlist-reload');
  const header =
    '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:5\n#EXT-X-PART-INF:PART-TARGET=0.5\n#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES\n#EXT-X-MAP:URI="init.mp4"\n';
  const parts = Array.from(
    { length: 4 },
    (_, i) =>
      `#EXT-X-PART:DURATION=0.5,URI="part${i}.m4s"${i === 0 ? ',INDEPENDENT=YES' : ''}\n`,
  ).join('');
  const partial = playablePlaylist(parsePlaylist(header + parts, base));
  assert.equal(partial.duration, 2);
  assert.deepEqual(
    partial.segments.map((s) => s.sequence),
    [5, 5, 5, 5],
  );
  assert.deepEqual(
    partial.segments.map((s) => s.part),
    [0, 1, 2, 3],
  );
  assert.equal(independentIndex(partial, 3), 0);
  const next = playablePlaylist(
    parsePlaylist(
      header +
        parts +
        '#EXTINF:2,\nparent.m4s\n#EXT-X-PART:DURATION=0.5,URI="next.m4s",INDEPENDENT=YES\n',
      base,
    ),
  );
  assert.equal(next.segments.length, 5);
  assert.equal(next.duration, 2.5);
  assert.equal(next.segments[4].sequence, 6);
  assert.equal(next.segments[4].start, 2);
  const url = new URL(reloadUrl(next, 0));
  assert.equal(url.searchParams.get('_HLS_msn'), '6');
  assert.equal(url.searchParams.get('_HLS_part'), '1');
  assert.equal(alignPlaylist(next, partial).segments[4].start, 2);
  const collapsed = playablePlaylist(
    parsePlaylist(header + '#EXTINF:2,\nparent.m4s\n', base),
  );
  assert.equal(alignPlaylist(collapsed, partial).segments[0].start, 0);
  assert.throws(
    () =>
      parsePlaylist(
        header.replace('#EXT-X-PART-INF:PART-TARGET=0.5\n', '') + parts,
        base,
      ),
    /PART-INF/,
  );
});

test('Rendition reports default to the local edge and request the reported peer position', async () => {
  const { PlaylistLoader } = await module('playlist-reload');
  const text =
    '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:8\n#EXT-X-PART-INF:PART-TARGET=0.5\n#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES\n#EXT-X-PART:DURATION=0.5,URI="part.m4s",INDEPENDENT=YES\n#EXT-X-RENDITION-REPORT:URI="peer.m3u8"\n';
  const reference = parsePlaylist(text, base);
  assert.equal(reference.reports[0].sequence, 8);
  assert.equal(reference.reports[0].part, 0);
  const requests = [];
  const client = {
    signal: new AbortController().signal,
    options: {},
    get: async (resource) => {
      requests.push(resource.url);
      return {
        data: new TextEncoder().encode(text),
        url: resource.url,
        elapsed: 1,
      };
    },
  };
  const loader = new PlaylistLoader(client, () => ({}));
  const result = await loader.rendition(reference.reports[0].url, reference);
  const request = new URL(requests[0]);
  assert.equal(request.searchParams.get('_HLS_msn'), '8');
  assert.equal(request.searchParams.get('_HLS_part'), '0');
  assert.equal(result.url, reference.reports[0].url);
  assert.equal(loader.diagnostics.renditionReports, 1);
});

test('Subtitle codec declarations do not enter the audio/video MSE capability request', async () => {
  const { browserVariants } = await module('renditions');
  const queried = [];
  const variants = browserVariants(
    [
      {
        url: 'x',
        bandwidth: 500000,
        codecs: 'avc1.42c00c,mp4a.40.2,stpp.ttml.im1t,wvtt',
      },
    ],
    (mime) => {
      queried.push(mime);
      return true;
    },
  );
  assert.equal(variants.length, 1);
  assert.equal(variants[0].codecs, 'avc1.42c00c,mp4a.40.2');
  assert.equal(queried[0], 'video/mp4; codecs="avc1.42c00c,mp4a.40.2"');
});

test('WebVTT timestamp maps unwrap the 33-bit media clock around the current playback position', () => {
  const wrap = 2 ** 33 / 90000;
  const text =
    'WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:90000\n\n00:00:00.000 --> 00:00:01.000\nAfter wrap\n';
  const cue = parseVtt(text, 0, wrap + 1)[0];
  assert.equal(cue.start, wrap + 1);
  assert.equal(cue.end, wrap + 2);
  assert.throws(
    () => parseVtt('WEBVTT\n\n00:61.000 --> 00:62.000\nbad'),
    /timestamp/,
  );
});

test('ATSC caption SEI validates markers, ignores unrelated user data and retains both fields/DTVCC', async () => {
  const { registeredCaptions, seiCaptions } = await module('cea-sei');
  const payload = Uint8Array.from([
    0xb5, 0, 0x31, 0x47, 0x41, 0x39, 0x34, 3, 0x43, 0xff, 0xfc, 0x94, 0x29,
    0xfd, 0x94, 0x29, 0xff, 0x02, 0x21, 0xff,
  ]);
  assert.deepEqual(
    registeredCaptions(payload, 1).map((p) => p.type),
    [0, 1, 3],
  );
  assert.equal(
    seiCaptions(
      Uint8Array.from([6, 4, payload.length, ...payload, 0x80]),
      false,
      2,
    )[0].time,
    2,
  );
  assert.equal(
    seiCaptions(
      Uint8Array.from([0x4e, 1, 4, payload.length, ...payload, 0x80]),
      true,
      2,
    ).length,
    3,
  );
  assert.deepEqual(registeredCaptions(Uint8Array.of(0), 1), []);
  assert.throws(() => registeredCaptions(payload.slice(0, -1), 0), /Truncated/);
  const bad = payload.slice();
  bad[10] = 4;
  assert.throws(() => registeredCaptions(bad, 0), /marker/);
});

test('Field 2 captions produce CC3 and ignore XDS bytes without changing field 1', () => {
  const timeline = new Cea608Timeline();
  const data = [
    [1, 0x14, 0x29],
    [1, 0x41, 0],
    [2, 0x14, 0x29],
    [2, 0x42, 0],
    [2, 0x01, 0x01],
    [2, 0x58, 0x59],
    [2, 0x0f, 0],
    [2, 0x43, 0],
  ].map(([field, first, second], i) => ({
    time: i / 30,
    field,
    first: parity608(first),
    second: parity608(second),
  }));
  timeline.update(data, 0, 0, 2, 0, 0);
  assert.equal(
    plain608(timeline.events.filter((e) => e.service === 1).at(-1)),
    'A',
  );
  assert.equal(
    plain608(timeline.events.filter((e) => e.service === 3).at(-1)),
    'BC',
  );
});

test('AVC immediate intra recovery points are random access; gradual recovery is not', async () => {
  const { avcRandomAccess } = await module('avc-access');
  // first_mb=0, slice_type=2 (I); recovery_frame_cnt=0.
  const intra = Uint8Array.of(0x41, 0xb8);
  assert.equal(
    avcRandomAccess([intra, Uint8Array.of(6, 6, 1, 0x84, 0x80)]),
    true,
  );
  assert.equal(
    avcRandomAccess([intra, Uint8Array.of(6, 6, 1, 0x44, 0x80)]),
    false,
  );
  assert.equal(
    avcRandomAccess([
      Uint8Array.of(0x41, 0xe0),
      Uint8Array.of(6, 6, 1, 0x84, 0x80),
    ]),
    false,
  );
  assert.equal(avcRandomAccess([Uint8Array.of(0x65)]), true);
});

test('HLS map encryption captures its declaration key across rotation and METHOD=NONE', () => {
  const p = parsePlaylist(
    vod(
      '#EXT-X-KEY:METHOD=AES-128,URI="a.key",IV=0x1\n#EXT-X-MAP:URI="init.mp4"\n#EXT-X-KEY:METHOD=AES-128,URI="b.key",IV=0x2\n#EXTINF:2,\na.m4s\n#EXT-X-KEY:METHOD=NONE\n#EXTINF:2,\nb.m4s\n#EXT-X-ENDLIST',
    ),
    base,
  );
  assert.equal(p.segments[0].key.url, 'https://example.com/live/b.key');
  assert.equal(p.segments[0].map.key.url, 'https://example.com/live/a.key');
  assert.equal(p.segments[1].key, undefined);
  assert.equal(p.segments[1].map.key.iv[15], 1);
});
test('HLS identity key alternatives survive unsupported KEYFORMAT declarations', () => {
  const p = parsePlaylist(
    vod(
      '#EXT-X-KEY:METHOD=AES-128,URI="a.key",KEYFORMATVERSIONS="1/2"\n#EXT-X-KEY:METHOD=AES-128,URI="skd://example-key",KEYFORMAT="example.drm"\n#EXTINF:2,\na.ts\n#EXT-X-ENDLIST',
    ),
    base,
  );
  assert.equal(p.segments[0].key.method, 'AES-128');
  assert.equal(p.segments[0].keys.length, 2);
  assert.deepEqual(p.segments[0].key.versions, [1, 2]);
  assert.throws(
    () => parsePlaylist(vod('#EXT-X-KEY:METHOD=NONE,URI="a"'), base),
    /NONE/,
  );
  assert.throws(
    () => parsePlaylist(vod('#EXT-X-KEY:METHOD=AES-128'), base),
    /URI/,
  );
  assert.throws(
    () =>
      parsePlaylist(vod('#EXT-X-KEY:METHOD=AES-256-GCM,URI="a",IV=0x1'), base),
    /forbidden/,
  );
});
test('Opaque DRM key identifiers preserve nonnumeric colon suffixes', () => {
  const id =
    'skd://302f80dd-411e-4886-bca5-bb1f8018a024:77FD1889AAF4143B085548B3C0F95B9A';
  const p = parsePlaylist(
    vod(
      '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="data:text/plain;base64,AAAA",KEYFORMAT="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"\n' +
        `#EXT-X-KEY:METHOD=SAMPLE-AES,URI="${id}",KEYFORMAT="com.apple.streamingkeydelivery"\n#EXTINF:2,\na.m4s`,
    ),
    base,
  );
  assert.equal(p.segments[0].keys[1].url, id);
  assert.equal(p.segments[0].keys[0].url, 'data:text/plain;base64,AAAA');
  assert.throws(() =>
    parsePlaylist(
      vod(`#EXT-X-KEY:METHOD=AES-128,URI="${id}"\n#EXTINF:2,\na.ts`),
      base,
    ),
  );
  assert.throws(() => parsePlaylist(vod(`#EXTINF:2,\n${id}`), base));
});
test('SESSION-KEY is distinct from media encryption and repeated key declarations have separate cache scopes', () => {
  const p = parsePlaylist(
    '#EXTM3U\n#EXT-X-SESSION-KEY:METHOD=AES-256-GCM,URI="key"\n#EXT-X-STREAM-INF:BANDWIDTH=100\nmedia.m3u8',
    base,
  );
  assert.equal(p.sessionKeys[0].method, 'AES-256-GCM');
  const media = parsePlaylist(
    vod(
      '#EXT-X-KEY:METHOD=AES-128,URI="key"\n#EXTINF:2,\na.ts\n#EXT-X-KEY:METHOD=AES-128,URI="key"\n#EXTINF:2,\nb.ts\n#EXT-X-ENDLIST',
    ),
    base,
  );
  assert.notEqual(media.segments[0].key.scope, media.segments[1].key.scope);
});

test('Live reset diagnostics identify changes without exposing signed URLs', async () => {
  const { timelineDifference } = await module('live');
  const before = parsePlaylist(
    vod('#EXTINF:2,\na.ts?token=secret-before', 10),
    base,
  );
  const after = parsePlaylist(
    vod('#EXTINF:2.4,\na.ts?token=secret-after', 10),
    base,
  );
  const diff = timelineDifference(after, before);
  assert.equal(diff.overlap.sequence, 10);
  assert.equal(diff.overlap.previousDuration, 2);
  assert.equal(diff.overlap.incomingDuration, 2.4);
  assert.deepEqual(diff.overlap.addressChanged, {
    origin: false,
    path: false,
    query: true,
  });
  assert.ok(!JSON.stringify(diff).includes('secret'));
  assert.ok(!JSON.stringify(diff).includes('example.com'));
  const reset = parsePlaylist(vod('#EXTINF:2,\nnew.ts', 0), base);
  assert.equal(timelineDifference(reset, before).overlap, null);
});

test('Live segment query renewal preserves the timeline and does not disguise a stalled publisher', async () => {
  const { reconcileLive, LiveProgress } = await module('live');
  const playlist = (query, duration = 4, resource = 'segment.ts') =>
    parsePlaylist(
      vod(`#EXTINF:${duration},\n${resource}?${query}`, 13978404),
      base,
    );
  const before = playlist('session=old&signature=old');
  const after = playlist('session=new&signature=new');
  const result = reconcileLive(after, before, 13978405);
  assert.equal(result.restart, false);
  assert.equal(result.playlist.segments[0].start, before.segments[0].start);
  assert.equal(result.playlist.segments[0].url, after.segments[0].url);
  assert.ok(result.playlist.segments[0].url.includes('signature=new'));
  const progress = new LiveProgress();
  assert.equal(progress.observe(before, 1000), 0);
  assert.equal(progress.observe(after, 5000), 4000);
  assert.equal(
    reconcileLive(playlist('session=new', 4.2), before, 13978405).restart,
    true,
  );
  assert.equal(
    reconcileLive(
      playlist('session=new', 4, 'replacement.ts'),
      before,
      13978405,
    ).restart,
    true,
  );
  const ranged = playlist('session=new');
  ranged.segments[0].range = { offset: 100, length: 500 };
  assert.equal(reconcileLive(ranged, before, 13978405).restart, true);
});

test('ABR startup policy chooses a compatible ladder endpoint and snapshots configuration', () => {
  const levels = [200000, 500000, 1000000, 2000000].map((bandwidth) => ({
    bandwidth,
  }));
  const config = { startup: 'highest', upswitch: 'direct' };
  const abr = new AbrController(config);
  config.startup = 'lowest';
  assert.equal(abr.initialIndex(levels), 3);
  assert.equal(new AbrController().initialIndex(levels), 0);
  assert.equal(abr.initialIndex([levels[0]]), 0);
  assert.equal(Object.isFrozen(abr.options), true);
});
test('direct ABR skips intermediate levels but respects measured bandwidth and buffer', () => {
  const levels = [200000, 500000, 1000000, 2000000].map((bandwidth) => ({
    bandwidth,
  }));
  const abr = new AbrController({ upswitch: 'direct' });
  abr.observe(500000, 1000);
  assert.equal(abr.choose(levels, 0, 12, 12, 1000), 0);
  abr.observe(500000, 1000);
  assert.equal(abr.choose(levels, 0, 1, 12, 2000), 0);
  assert.equal(abr.choose(levels, 0, 12, 12, 3000), 3);
  const limited = new AbrController({ upswitch: 'direct' });
  limited.observe(200000, 1000);
  limited.observe(200000, 1000);
  assert.equal(limited.choose(levels, 0, 12, 12, 1000), 2);
});
test('direct ABR retains cooldown/quarantine and drops quality without upgrade cooldown', () => {
  const levels = [200000, 500000, 1000000, 2000000].map((bandwidth) => ({
    bandwidth,
  }));
  const abr = new AbrController({ upswitch: 'direct' });
  abr.observe(500000, 1000);
  abr.observe(500000, 1000);
  abr.quarantine(3, 0, 'failure');
  assert.equal(abr.choose(levels, 0, 12, 12, 1000), 2);
  abr.switched(1000);
  abr.clear(3);
  assert.equal(abr.choose(levels, 2, 12, 12, 3000), 2);
  assert.equal(abr.choose(levels, 2, 12, 12, 9000), 3);
  abr.switched(9000);
  abr.observe(50000, 8000);
  assert.equal(abr.choose(levels, 3, 1, 12, 10000), 0);
});
test('ABR rejects unknown startup and upgrade policies', () => {
  assert.throws(() => new AbrController({ startup: 'middle' }), /Invalid ABR/);
  assert.throws(() => new AbrController({ upswitch: 'random' }), /Invalid ABR/);
});
