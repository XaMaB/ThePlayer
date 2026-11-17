import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
const root =
  process.env.THEPLAYER_HLS_FIXTURES ??
  path.join(os.tmpdir(), 'theplayer-hls-fixtures');
const load = async (name) => {
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
};
const { fragmentMetadata, fragmentSamples } = await load('fragment-samples');
const { fragment, concat } = await load('mp4');
const source = path.join(root, 'fmp4'),
  dir = path.join(root, 'sei-mp4'),
  ts = path.join(root, 'sei-ts');
await mkdir(dir, { recursive: true });
await mkdir(ts, { recursive: true });
const init = new Uint8Array(await readFile(path.join(source, 'init.mp4'))),
  metadata = fragmentMetadata(init);
await writeFile(path.join(dir, 'init.mp4'), init);
const playlist = await readFile(path.join(source, 'index.m3u8'), 'utf8');
await writeFile(path.join(dir, 'index.m3u8'), playlist);
const parity = (value) => {
  let bits = 0;
  for (let n = value; n; n >>= 1) bits ^= n & 1;
  return value | (bits ? 0 : 128);
};
const pairs = (text) => [
  [0x14, 0x29],
  [0x14, 0x29],
  [0x14, 0x2c],
  [0x14, 0x2c],
  [0x11, 0x40],
  [0x11, 0x40],
  ...Array.from({ length: Math.ceil(text.length / 2) }, (_, i) => [
    text.charCodeAt(i * 2),
    text.charCodeAt(i * 2 + 1) || 0,
  ]),
];
const a = pairs('SEI CC1'),
  b = pairs('SEI CC3');
const nal = (index) => {
  if (!a[index]) return new Uint8Array();
  const payload = [
    0xb5,
    0,
    0x31,
    0x47,
    0x41,
    0x39,
    0x34,
    3,
    0x42,
    0xff,
    0xfc,
    ...a[index].map(parity),
    0xfd,
    ...b[index].map(parity),
    0xff,
  ];
  const rbsp = [4, payload.length, ...payload, 0x80],
    escaped = [];
  let zeros = 0;
  for (const byte of rbsp) {
    if (zeros >= 2 && byte <= 3) {
      escaped.push(3);
      zeros = 0;
    }
    escaped.push(byte);
    zeros = byte === 0 ? zeros + 1 : 0;
  }
  const data = Uint8Array.from([6, ...escaped]),
    size = new Uint8Array(4);
  new DataView(size.buffer).setUint32(0, data.length);
  return concat(size, data);
};
const all = [init];
let serial = 1;
for (const name of playlist
  .split('\n')
  .filter((line) => line.endsWith('.m4s'))) {
  const samples = fragmentSamples(
    new Uint8Array(await readFile(path.join(source, name))),
    metadata,
  );
  const fragments = metadata.map((track) => {
    const selected = samples.filter((sample) => sample.track.id === track.id);
    return fragment(
      {
        id: track.id,
        kind: track.video ? 'video' : 'audio',
        codec: track.format,
        timescale: track.timescale,
      },
      selected.map((sample, i) => ({
        data: track.video ? concat(nal(i), sample.data) : sample.data,
        duration: Math.round(sample.duration * track.timescale),
        cts: Math.round((sample.time - sample.dts) * track.timescale),
        key: !(sample.flags & 0x10000),
      })),
      Math.round(selected[0].dts * track.timescale),
      serial++,
    );
  });
  const data = concat(...fragments);
  await writeFile(path.join(dir, name), data);
  all.push(data);
}
await writeFile(path.join(dir, 'all.mp4'), concat(...all));
execFileSync(
  'ffmpeg',
  [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    path.join(dir, 'all.mp4'),
    '-map',
    '0',
    '-c',
    'copy',
    '-f',
    'hls',
    '-hls_time',
    '2',
    '-hls_list_size',
    '0',
    '-hls_segment_filename',
    path.join(ts, 'segment%02d.ts'),
    path.join(ts, 'index.m3u8'),
  ],
  { stdio: 'inherit' },
);
for (const kind of ['mp4', 'ts'])
  await writeFile(
    path.join(root, 'sei-' + kind + '.m3u8'),
    '#EXTM3U\n#EXT-X-MEDIA:TYPE=CLOSED-CAPTIONS,GROUP-ID="cc",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,INSTREAM-ID="CC1"\n#EXT-X-MEDIA:TYPE=CLOSED-CAPTIONS,GROUP-ID="cc",NAME="Second field",LANGUAGE="es",DEFAULT=NO,AUTOSELECT=YES,INSTREAM-ID="CC3"\n#EXT-X-STREAM-INF:BANDWIDTH=600000,CODECS="avc1.42c00c,mp4a.40.2",CLOSED-CAPTIONS="cc"\nsei-' +
      kind +
      '/index.m3u8\n',
  );
console.log('Generated original AVC SEI captions in fMP4 and TS');

for (const file of [path.join(dir, 'all.mp4'), path.join(ts, 'segment00.ts')]) {
  const probe = JSON.parse(
    execFileSync(
      'ffprobe',
      [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-read_intervals',
        '%+#1',
        '-show_frames',
        '-show_entries',
        'frame=side_data_list',
        '-of',
        'json',
        file,
      ],
      { encoding: 'utf8' },
    ),
  );
  assert.ok(
    probe.frames.some((frame) =>
      frame.side_data_list?.some(
        (data) => data.side_data_type === 'ATSC A53 Part 4 Closed Captions',
      ),
    ),
    'Independent decoder must recognize the generated caption carriage',
  );
}
