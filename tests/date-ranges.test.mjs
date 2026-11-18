import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const r = await build({
  stdin: {
    contents:
      "export * from './src/engines/hls/date-ranges';export * from './src/engines/hls/playlist';export * from './src/engines/hls/playlist-reload';",
    resolveDir: new URL('..', import.meta.url).pathname,
  },
  bundle: true,
  write: false,
  format: 'esm',
});
const {
  parsePlaylist,
  parseDateRange,
  hlsDate,
  timedDateRanges,
  DateRangeTimeline,
  reloadUrl,
} = await import(
  'data:text/javascript;base64,' +
    Buffer.from(r.outputFiles[0].text).toString('base64')
);
const base = 'https://example.com/live.m3u8',
  epoch = '2026-01-02T03:04:00Z';
const body = (metadata, tail = '#EXTINF:2,\na.ts\n#EXTINF:2,\nb.ts\n') =>
  '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-PROGRAM-DATE-TIME:' +
  epoch +
  '\n' +
  metadata +
  '\n' +
  tail;
test('Date ranges consolidate attributes, decode SCTE-35 bytes and retain unknown extension values', () => {
  const p = parsePlaylist(
    body(
      '#EXT-X-DATERANGE:ID="x",START-DATE="2026-01-02T03:04:01",PLANNED-DURATION=8,SCTE35-OUT=0xfc0011,X-EXAMPLE="v"\n#EXT-X-DATERANGE:ID="x",DURATION=2,END-DATE="2026-01-02T03:04:03Z"',
    ),
    base,
  );
  assert.equal(p.dateRanges.length, 1);
  const range = p.dateRanges[0];
  assert.equal(range.duration, 2);
  assert.equal(range.plannedDuration, 8);
  assert.deepEqual([...range.scte35['SCTE35-OUT']], [252, 0, 17]);
  assert.equal(range.attributes['X-EXAMPLE'], 'v');
  assert.equal(timedDateRanges(p)[0].start, 1);
  assert.equal(timedDateRanges(p)[0].end, 3);
  assert.equal(hlsDate('2026-01-02T03:04:00'), hlsDate(epoch));
  assert.throws(() => hlsDate('2026-02-31T00:00:00Z'), /calendar/);
});
test('Invalid date range syntax is warned and ignored without breaking media playback', () => {
  const p = parsePlaylist(
    body(
      '#EXT-X-DATERANGE:ID="bad",START-DATE="x"\n#EXT-X-DATERANGE:ID="pre",START-DATE="2026-01-02T03:04:01Z",CUE="PRE,POST"\n#EXT-X-DATERANGE:ID="good",START-DATE="2026-01-02T03:04:01Z"\n#EXT-X-DATERANGE:ID="good",START-DATE="2026-01-02T03:04:02Z"',
    ),
    base,
  );
  assert.equal(p.segments.length, 2);
  assert.equal(p.dateRanges.length, 1);
  assert.equal(p.dateRanges[0].id, 'good');
  assert.equal(p.metadataWarnings.length, 3);
  assert.equal(
    parseDateRange({
      ID: 'planned',
      'START-DATE': epoch,
      'PLANNED-DURATION': '5',
    }).endDate,
    undefined,
  );
});
test('END-ON-NEXT derives ends from the earliest following range of the same class', () => {
  const p = parsePlaylist(
    body(
      '#EXT-X-DATERANGE:ID="a",CLASS="chapter",START-DATE="2026-01-02T03:04:00Z",END-ON-NEXT=YES\n#EXT-X-DATERANGE:ID="c",CLASS="chapter",START-DATE="2026-01-02T03:04:03Z",END-ON-NEXT=YES\n#EXT-X-DATERANGE:ID="b",CLASS="chapter",START-DATE="2026-01-02T03:04:02Z",END-ON-NEXT=YES',
    ),
    base,
  );
  assert.deepEqual(
    p.dateRanges.map((r) => [r.id, r.duration]),
    [
      ['a', 2],
      ['b', 1],
      ['c', undefined],
    ],
  );
});
test('v2 delta updates preserve previous date ranges, merge additions and remove listed IDs', () => {
  const initial = parsePlaylist(
    body(
      '#EXT-X-SERVER-CONTROL:CAN-SKIP-UNTIL=12,CAN-SKIP-DATERANGES=YES\n#EXT-X-DATERANGE:ID="a",START-DATE="2026-01-02T03:04:00Z"\n#EXT-X-DATERANGE:ID="b",START-DATE="2026-01-02T03:04:01Z"',
    ),
    base,
  );
  assert.equal(
    new URL(reloadUrl(initial, 0)).searchParams.get('_HLS_skip'),
    'v2',
  );
  const delta = parsePlaylist(
    '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-SKIP:SKIPPED-SEGMENTS=1,RECENTLY-REMOVED-DATERANGES="a"\n#EXT-X-DATERANGE:ID="b",DURATION=2\n#EXTINF:2,\nb.ts\n',
    base,
    {},
    initial,
  );
  assert.deepEqual(
    delta.dateRanges.map((r) => [r.id, r.duration]),
    [['b', 2]],
  );
  assert.equal(initial.dateRanges[1].duration, undefined);
});
test('Playback cue events distinguish PRE/POST, range entry/exit, backward seek and ONCE', () => {
  const p = parsePlaylist(
    body(
      '#EXT-X-DATERANGE:ID="pre",START-DATE="2026-01-02T03:04:00Z",CUE="PRE,ONCE"\n#EXT-X-DATERANGE:ID="post",START-DATE="2026-01-02T03:04:00Z",CUE="POST"\n#EXT-X-DATERANGE:ID="once",START-DATE="2026-01-02T03:04:01Z",DURATION=1,CUE="ONCE"\n#EXT-X-DATERANGE:ID="again",START-DATE="2026-01-02T03:04:01Z",DURATION=1',
    ),
    base,
  );
  const events = [],
    timeline = new DateRangeTimeline((type, r) =>
      events.push([type, r.id, r.cause]),
    );
  timeline.update(p);
  timeline.update(p);
  assert.equal(events.filter((e) => e[0] === 'daterange').length, 4);
  timeline.phase('PRE');
  timeline.tick(0);
  timeline.tick(1.2);
  timeline.tick(2.2);
  timeline.tick(0, true);
  timeline.tick(1.2);
  timeline.phase('POST');
  const cues = events.filter((e) => e[0] === 'daterangecue').map((e) => e[1]);
  assert.deepEqual(cues, ['pre', 'once', 'again', 'again', 'post']);
  assert.equal(
    events.filter((e) => e[0] === 'daterangeexit' && e[1] === 'once').length,
    1,
  );
});
