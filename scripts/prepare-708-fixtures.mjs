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
  dir = path.join(root, 'cea708-mp4'),
  ts = path.join(root, 'cea708-ts');
await mkdir(dir, { recursive: true });
await mkdir(ts, { recursive: true });
const init = new Uint8Array(await readFile(path.join(source, 'init.mp4'))),
  metadata = fragmentMetadata(init);
await writeFile(path.join(dir, 'init.mp4'), init);
const playlist = await readFile(path.join(source, 'index.m3u8'), 'utf8');
await writeFile(path.join(dir, 'index.m3u8'), playlist);
let packetSequence = 0;
const define = (id, left, columns) => [
  0x98 + id,
  0x38,
  0x80 | 80,
  left,
  0x60,
  columns - 1,
  9,
];
const text = (value) => [...value].map((c) => c.charCodeAt(0));
const blocks = [
  [
    1,
    [
      0x8f,
      ...define(0, 20, 12),
      0x97,
      0xc0,
      0,
      0x0c,
      0,
      ...text('Left aligned'),
      3,
    ],
  ],
  [
    2,
    [
      0x8f,
      ...define(0, 70, 12),
      0x18,
      4,
      0x16,
      0x18,
      0x4e,
      0x2d,
      0x18,
      0xac,
      0,
      3,
    ],
  ],
];
const nal = (index) => {
  const block = blocks[index];
  if (!block) return new Uint8Array();
  const [service, commands] = block;
  assert.ok(commands.length <= 31);
  const packet = [(service << 5) | commands.length, ...commands];
  if (packet.length % 2 === 0) packet.push(0);
  const header = (packetSequence++ % 4 << 6) | ((packet.length + 1) / 2);
  const pairs = [0xff, header, packet[0]];
  for (let i = 1; i < packet.length; i += 2)
    pairs.push(0xfe, packet[i], packet[i + 1]);
  const payload = [
    0xb5,
    0,
    0x31,
    0x47,
    0x41,
    0x39,
    0x34,
    3,
    0x40 | (pairs.length / 3),
    0xff,
    ...pairs,
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
    path.join(root, 'cea708-' + kind + '.m3u8'),
    '#EXTM3U\n#EXT-X-MEDIA:TYPE=CLOSED-CAPTIONS,GROUP-ID="cc",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,INSTREAM-ID="SERVICE1"\n#EXT-X-MEDIA:TYPE=CLOSED-CAPTIONS,GROUP-ID="cc",NAME="P16 Unicode",LANGUAGE="ko",DEFAULT=NO,AUTOSELECT=YES,INSTREAM-ID="SERVICE2"\n#EXT-X-STREAM-INF:BANDWIDTH=600000,CODECS="avc1.42c00c,mp4a.40.2",CLOSED-CAPTIONS="cc"\ncea708-' +
      kind +
      '/index.m3u8\n',
  );
console.log('Generated original CEA-708/P16 SEI captions in fMP4 and TS');

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
