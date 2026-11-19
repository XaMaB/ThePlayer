import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const bundled = await build({
  stdin: {
    contents:
      "export * from './segments.ts'; export * from './mpd.ts'; export * from './sidx.ts'; export * from './chunks.ts'; export * from './producer-time.ts'; export * from './chunk-throughput.ts';",
    resolveDir: new URL('../src/engines/dash/', import.meta.url).pathname,
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
});
const {
  expandTemplate,
  segmentReferences,
  duration,
  initializationResource,
  parseSidx,
  loadSidx,
  CmafChunks,
  producerClocks,
  ChunkThroughput,
} = await import(
  'data:text/javascript;base64,' +
    Buffer.from(bundled.outputFiles[0].text).toString('base64')
);
const rep = (address = {}) => ({
  id: 'video',
  bandwidth: 800000,
  codecs: 'avc1.42c01e',
  mimeType: 'video/mp4',
  baseUrls: ['https://example.com/final/media/'],
  protection: [],
  address: {
    kind: 'template',
    timescale: 1000,
    presentationTimeOffset: 0n,
    eptDelta: 0n,
    startNumber: 1n,
    media: '$RepresentationID$-$Number%05d$-$Time$.m4s',
    initialization: '$RepresentationID$-init.mp4',
    duration: 2000n,
    availabilityTimeOffset: 0,
    availabilityTimeComplete: true,
    ...address,
  },
});
const period = { id: 'p0', start: 0, duration: 10, adaptations: [] };
test('DASH durations retain subsecond precision and reject ambiguous calendar units', () => {
  assert.equal(duration('P1DT2H3M4.125S'), 93784.125);
  assert.equal(duration('PT0S'), 0);
  assert.equal(duration(undefined), undefined);
  for (const value of ['P', 'PT', 'P1M', '-PT1S', 'PTNaNS'])
    assert.throws(() => duration(value));
});
test('DASH template substitution supports exact 64-bit Time values and escaped dollars', () => {
  const r = rep();
  assert.equal(
    expandTemplate(
      '$$/$RepresentationID$/$Number%05d$/$Time$/$Bandwidth$',
      r,
      7n,
      9007199254740993n,
    ),
    '$/video/00007/9007199254740993/800000',
  );
  assert.equal(expandTemplate('$Number%04X$', r, 255n), '00FF');
  for (const value of [
    '$Unknown$',
    '$Time$',
    '$Number%099d$',
    '$RepresentationID%03d$',
  ])
    assert.throws(() => expandTemplate(value, r));
});
test('DASH duration addressing starts at PTO without skipping segment numbers', () => {
  const refs = segmentReferences(
    rep({ presentationTimeOffset: 9000n, startNumber: 800n }),
    period,
    0,
    6,
  );
  assert.deepEqual(
    refs.map((r) => [r.number, r.time, r.start]),
    [
      [800n, 9000n, 0],
      [801n, 11000n, 2],
      [802n, 13000n, 4],
    ],
  );
});
test('DASH eptDelta affects presentation timing but not simple Time paths', () => {
  const refs = segmentReferences(
    rep({ presentationTimeOffset: 900n, eptDelta: -500n, duration: 4001n }),
    period,
    0,
    5,
  );
  assert.equal(refs[0].start, -0.5);
  assert.ok(refs[0].url.endsWith('video-00001-900.m4s'));
  assert.equal(refs[1].start, 3.501);
});
test('DASH Timeline maps sample time relative to PTO and Period start', () => {
  const refs = segmentReferences(
    rep({
      presentationTimeOffset: 9007199254740993n,
      timeline: [{ time: 9007199254740993n, duration: 2000n, repeat: 3 }],
    }),
    { ...period, start: 30 },
    30,
    36,
  );
  assert.deepEqual(
    refs.map((r) => r.start),
    [30, 32, 34],
  );
  assert.ok(refs[0].url.includes('9007199254740993'));
});
test('DASH negative repeats are bounded by the next timestamp and Period end', () => {
  const refs = segmentReferences(
    rep({
      timeline: [
        { time: 0n, duration: 2000n, repeat: -1 },
        { time: 6000n, duration: 1000n, repeat: -1 },
      ],
    }),
    period,
    0,
    30,
  );
  assert.deepEqual(
    refs.map((r) => r.start),
    [0, 2, 4, 6, 7, 8, 9],
  );
  assert.equal(refs.at(-1).end, 10);
});
test('DASH live duration enumeration jumps directly into a large numbered window', () => {
  const refs = segmentReferences(
    rep(),
    { ...period, duration: undefined },
    1800000000,
    1800000006,
  );
  assert.equal(refs.length, 3);
  assert.equal(refs[0].number, 900000001n);
});
test('DASH Timeline repeat counts do not allocate the entire presentation', () => {
  const refs = segmentReferences(
    rep({ timeline: [{ time: 0n, duration: 2000n, repeat: 1000000000 }] }),
    { ...period, duration: undefined },
    1800000000,
    1800000006,
  );
  assert.equal(refs.length, 3);
  assert.equal(refs[0].number, 900000001n);
});
test('DASH SegmentList preserves explicit byte ranges and relative resource URLs', () => {
  const r = rep({
    kind: 'list',
    urls: [
      { media: 'packed.mp4', range: { offset: 100, length: 200 } },
      { media: 'packed.mp4', range: { offset: 300, length: 250 } },
    ],
  });
  const refs = segmentReferences(r, period, 0, 10);
  assert.equal(refs.length, 2);
  assert.deepEqual(refs[1].range, { offset: 300, length: 250 });
  assert.equal(refs[1].url, 'https://example.com/final/media/packed.mp4');
  assert.equal(
    initializationResource(r).url,
    'https://example.com/final/media/video-init.mp4',
  );
});
test('DASH rejects overlapping timelines, unbounded repeat ambiguity and excess windows', () => {
  assert.throws(
    () =>
      segmentReferences(
        rep({
          timeline: [
            { time: 0n, duration: 2000n, repeat: 1 },
            { time: 3000n, duration: 1000n, repeat: 0 },
          ],
        }),
        period,
        0,
        10,
      ),
    /Overlapping/,
  );
  assert.throws(
    () =>
      segmentReferences(
        rep({
          timeline: [
            { duration: 2000n, repeat: -1 },
            { duration: 1000n, repeat: 0 },
          ],
        }),
        period,
        0,
        10,
      ),
    /explicit time/,
  );
  assert.throws(
    () =>
      segmentReferences(
        rep({ duration: 1n }),
        { ...period, duration: undefined },
        0,
        100,
      ),
    /limit/,
  );
});
test('SIDX offsets include the absolute index location and first_offset', () => {
  const d = new Uint8Array(56),
    v = new DataView(d.buffer);
  v.setUint32(0, d.length);
  d.set(new TextEncoder().encode('sidx'), 4);
  v.setUint32(16, 1000);
  v.setUint32(20, 5000);
  v.setUint32(24, 20);
  v.setUint16(30, 2);
  v.setUint32(32, 100);
  v.setUint32(36, 2000);
  v.setUint32(40, 0x90000000);
  v.setUint32(44, 120);
  v.setUint32(48, 2000);
  v.setUint32(52, 0x90000000);
  const refs = parseSidx(
    d,
    1000,
    'https://example.com/file.mp4',
    rep({ presentationTimeOffset: 5000n }),
    { ...period, start: 10 },
  );
  assert.deepEqual(
    refs.map((r) => [r.start, r.end, r.range]),
    [
      [10, 12, { offset: 1076, length: 100 }],
      [12, 14, { offset: 1176, length: 120 }],
    ],
  );
  v.setUint32(32, 0x80000064);
  assert.throws(
    () => parseSidx(d, 1000, 'https://example.com/file.mp4', rep(), period),
    /Hierarchical/,
  );
});

test('CMAF streaming frames moof/mdat across every byte boundary', () => {
  const box = (name, data = Buffer.alloc(0)) => {
    const b = Buffer.alloc(8 + data.length);
    b.writeUInt32BE(b.length);
    b.write(name, 4);
    data.copy(b, 8);
    return b;
  };
  const unit = Buffer.concat([
    box('styp'),
    box('moof', Buffer.alloc(5)),
    box('mdat', Buffer.alloc(17, 4)),
  ]);
  const input = Buffer.concat([unit, unit]);
  for (let cut = 1; cut < input.length; cut++) {
    const parser = new CmafChunks();
    const output = [
      ...parser.push(input.subarray(0, cut)),
      ...parser.push(input.subarray(cut)),
    ];
    parser.finish();
    assert.equal(output.length, 2);
    assert.deepEqual(Buffer.from(output[0]), unit);
    assert.deepEqual(Buffer.from(output[1]), unit);
  }
  const truncated = new CmafChunks();
  truncated.push(unit.subarray(0, unit.length - 1));
  assert.throws(() => truncated.finish(), /Truncated/);
  assert.throws(() => new CmafChunks().push(box('mdat')), /no moof/);
  const huge = box('moof');
  huge.writeUInt32BE(0xffffffff);
  assert.throws(() => new CmafChunks().push(huge), /size/);
});

test('Hierarchical SIDX expands child ranges and rejects inconsistent timing', async () => {
  const make = (size, duration, firstOffset = 0) => {
    const b = Buffer.alloc(44);
    b.writeUInt32BE(44);
    b.write('sidx', 4);
    b.writeUInt32BE(1, 12);
    b.writeUInt32BE(1000, 16);
    b.writeUInt32BE(firstOffset, 24);
    b.writeUInt16BE(1, 30);
    b.writeUInt32BE(size, 32);
    b.writeUInt32BE(duration, 36);
    return b;
  };
  const parent = make(0x80000000 + 44, 2000),
    child = make(100, 2000);
  const calls = [];
  const url = 'https://example.com/media.mp4';
  const client = {
    get: async (r) => {
      calls.push(r);
      return { url, data: child };
    },
  };
  const references = await loadSidx(client, parent, 100, url, rep(), period);
  assert.deepEqual(calls[0].range, { offset: 144, length: 44 });
  assert.deepEqual(references[0].range, { offset: 188, length: 100 });
  child.writeUInt32BE(3000, 36);
  await assert.rejects(
    loadSidx(client, parent, 100, url, rep(), period),
    /timing/,
  );
  await assert.rejects(
    loadSidx(client, make(0x80000000 + 9000000, 2000), 100, url, rep(), period),
    /limit/,
  );
});

test('Producer reference time preserves fractional NTP, era rollover and media clock', () => {
  const b = Buffer.alloc(32);
  b.writeUInt32BE(32);
  b.write('prft', 4);
  b[8] = 1;
  b.writeUInt32BE(7, 12);
  const unix = Date.UTC(2040, 0, 1) / 1000;
  b.writeUInt32BE((unix + 2208988800) % 2 ** 32, 16);
  b.writeUInt32BE(2 ** 31, 20);
  b.writeBigUInt64BE(900900n, 24);
  const tracks = [{ id: 7, timescale: 90000 }];
  assert.deepEqual(producerClocks(b, tracks, unix), [
    { type: 'encoder', wallClockTime: unix + 0.5, mediaTime: 10.01 },
  ]);
  b[11] = 24;
  assert.equal(producerClocks(b, tracks, unix)[0].type, 'captured');
  b[11] = 1;
  assert.deepEqual(producerClocks(b, tracks, unix), []);
  b[8] = 2;
  assert.throws(() => producerClocks(b, tracks, unix), /Invalid/);
});

test('CMAF throughput excludes production waits but retains in-unit network stalls', () => {
  const sample = new ChunkThroughput();
  sample.observe(16384, 0, 0);
  sample.observe(49152, 65536, 50);
  sample.observe(16384, 0, 2050);
  sample.observe(49152, 65536, 2100);
  assert.equal(sample.samples, 2);
  assert.equal(sample.bytes, 131072);
  assert.equal(sample.elapsed, 100);
  sample.observe(65536, 65536, 3000);
  assert.equal(sample.samples, 2);
  sample.observe(16384, 0, 4000);
  sample.observe(49152, 65536, 5000);
  assert.equal(sample.elapsed, 1100);
});
