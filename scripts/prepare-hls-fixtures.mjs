import { videoPesFixture } from '../tests/helpers/video-pes-fixture.mjs';
import { expandedPsi } from '../tests/helpers/expanded-psi.mjs';
import { createCipheriv } from 'node:crypto';
// Original synthetic test media, generated locally. Requires ffmpeg with libx264.
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
const root =
  process.env.THEPLAYER_HLS_FIXTURES ??
  path.join(os.tmpdir(), 'theplayer-hls-fixtures');
const ffmpeg = (...args) =>
  execFileSync(
    'ffmpeg',
    ['-hide_banner', '-loglevel', 'error', '-y', ...args],
    { stdio: 'inherit' },
  );
for (const kind of ['ts', 'fmp4', 'bframes', 'bframes-high']) {
  const dir = path.join(root, kind);
  await mkdir(dir, { recursive: true });
  ffmpeg(
    '-filter_threads',
    '1',
    '-f',
    'lavfi',
    '-i',
    kind === 'bframes-high'
      ? 'testsrc2=size=640x360:rate=25'
      : 'testsrc2=size=320x180:rate=25',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=880:sample_rate=48000',
    '-t',
    '18',
    '-c:v',
    'libx264',
    '-threads',
    '2',
    '-preset',
    kind.startsWith('bframes') ? 'fast' : 'ultrafast',
    '-g',
    '50',
    '-keyint_min',
    '50',
    '-sc_threshold',
    '0',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '96k',
    '-f',
    'hls',
    '-hls_time',
    '2',
    '-hls_list_size',
    '0',
    '-hls_playlist_type',
    'vod',
    '-hls_segment_type',
    kind === 'fmp4' ? 'fmp4' : 'mpegts',
    '-hls_segment_filename',
    path.join(dir, kind === 'fmp4' ? 'segment%02d.m4s' : 'segment%02d.ts'),
    path.join(dir, 'index.m3u8'),
  );
}
const key = Buffer.from(Array.from({ length: 16 }, (_, i) => i)); // Public test vector, not a production key.
await writeFile(path.join(root, 'key.bin'), key);
await writeFile(
  path.join(root, 'key-info'),
  'key.bin\n' + path.join(root, 'key.bin') + '\n',
);
for (const kind of ['encrypted', 'byterange']) {
  const dir = path.join(root, kind);
  await mkdir(dir, { recursive: true });
  const options =
    kind === 'encrypted'
      ? ['-hls_key_info_file', path.join(root, 'key-info')]
      : ['-hls_flags', 'single_file', '-hls_segment_type', 'fmp4'];
  ffmpeg(
    '-i',
    path.join(root, kind === 'byterange' ? 'fmp4/index.m3u8' : 'ts/index.m3u8'),
    '-c',
    'copy',
    '-f',
    'hls',
    '-hls_time',
    '2',
    '-hls_list_size',
    '0',
    ...options,
    path.join(dir, 'index.m3u8'),
  );
  if (kind === 'encrypted') await writeFile(path.join(dir, 'key.bin'), key);
}
await writeFile(
  path.join(root, 'captions.vtt'),
  'WEBVTT\n\n00:00:00.000 --> 00:00:08.000 line:80% align:start\nThePlayer original HLS — WebVTT\n\n00:00:08.000 --> 00:00:18.000\nSecond caption\n',
);
await writeFile(
  path.join(root, 'subtitles.m3u8'),
  '#EXTM3U\n#EXT-X-TARGETDURATION:18\n#EXT-X-VERSION:3\n#EXTINF:18,\ncaptions.vtt\n#EXT-X-ENDLIST\n',
);
await writeFile(
  path.join(root, 'master.m3u8'),
  '#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",DEFAULT=NO,AUTOSELECT=YES,URI="subtitles.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=900000,CODECS="avc1.42c00c,mp4a.40.2",SUBTITLES="subs"\nfmp4/index.m3u8\n',
);
console.log(root);

const implicit = path.join(root, 'implicit-iv');
await mkdir(implicit, { recursive: true });
let playlist = await readFile(path.join(root, 'ts/index.m3u8'), 'utf8');
playlist = playlist.replace(
  '#EXT-X-MEDIA-SEQUENCE:0',
  '#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"',
);
for (let sequence = 0; sequence < 9; sequence++) {
  const name = `segment${String(sequence).padStart(2, '0')}.ts`,
    data = await readFile(path.join(root, 'ts', name));
  const iv = Buffer.alloc(16);
  iv.writeBigUInt64BE(BigInt(sequence), 8);
  const cipher = createCipheriv('aes-128-cbc', key, iv);
  await writeFile(
    path.join(implicit, name),
    Buffer.concat([cipher.update(data), cipher.final()]),
  );
}
await writeFile(path.join(implicit, 'index.m3u8'), playlist);
await writeFile(path.join(implicit, 'key.bin'), key);

// Independent video and audio renditions with aligned presentation timestamps.
for (const [name, width, height] of [
  ['video-low', 320, 180],
  ['video-high', 640, 360],
]) {
  const dir = path.join(root, name);
  await mkdir(dir, { recursive: true });
  ffmpeg(
    '-filter_threads',
    '1',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=${width}x${height}:rate=25`,
    '-t',
    '36',
    '-an',
    '-c:v',
    'libx264',
    '-threads',
    '2',
    '-preset',
    'ultrafast',
    '-g',
    '50',
    '-keyint_min',
    '50',
    '-sc_threshold',
    '0',
    '-pix_fmt',
    'yuv420p',
    '-f',
    'hls',
    '-hls_time',
    '2',
    '-hls_list_size',
    '0',
    '-hls_segment_type',
    'fmp4',
    '-hls_segment_filename',
    path.join(dir, 'segment%02d.m4s'),
    path.join(dir, 'index.m3u8'),
  );
}
for (const [name, frequency] of [
  ['audio-en', 440],
  ['audio-es', 880],
]) {
  const dir = path.join(root, name);
  await mkdir(dir, { recursive: true });
  ffmpeg(
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=${frequency}:sample_rate=48000`,
    '-t',
    '36',
    '-vn',
    '-c:a',
    'aac',
    '-b:a',
    '96k',
    '-f',
    'hls',
    '-hls_time',
    '2',
    '-hls_list_size',
    '0',
    '-hls_segment_type',
    'fmp4',
    '-hls_segment_filename',
    path.join(dir, 'segment%02d.m4s'),
    path.join(dir, 'index.m3u8'),
  );
}
await writeFile(
  path.join(root, 'renditions.m3u8'),
  `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="audio-en/index.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Spanish",LANGUAGE="es",DEFAULT=NO,AUTOSELECT=YES,URI="audio-es/index.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=500000,CODECS="avc1.42c00c,mp4a.40.2",RESOLUTION=320x180,AUDIO="audio"
video-low/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1500000,CODECS="avc1.42c01e,mp4a.40.2",RESOLUTION=640x360,AUDIO="audio"
video-high/index.m3u8
`,
);

// Deliberately give the high rendition a different decode-time epoch.
// Both variants still describe the same presentation positions in their playlists.
const shifted = path.join(root, 'video-shifted');
await mkdir(shifted, { recursive: true });
const timeBase = JSON.parse(
  execFileSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-show_entries',
      'stream=time_base',
      '-of',
      'json',
      path.join(root, 'video-high/init.mp4'),
    ],
    { encoding: 'utf8' },
  ),
).streams[0].time_base;
const scale = Number(timeBase.split('/')[1]) / Number(timeBase.split('/')[0]);
function shiftTfdt(data) {
  for (let at = 0; at < data.length; ) {
    const size = data.readUInt32BE(at),
      type = data.toString('ascii', at + 4, at + 8);
    if (size < 8 || at + size > data.length)
      throw new Error('Invalid fixture box');
    const body = data.subarray(at + 8, at + size);
    if (type === 'moof' || type === 'traf') shiftTfdt(body);
    if (type === 'tfdt') {
      if (body[0] === 1)
        body.writeBigUInt64BE(body.readBigUInt64BE(4) + BigInt(120 * scale), 4);
      else body.writeUInt32BE(body.readUInt32BE(4) + 120 * scale, 4);
    }
    at += size;
  }
}
await writeFile(
  path.join(shifted, 'init.mp4'),
  await readFile(path.join(root, 'video-high/init.mp4')),
);
for (let i = 0; i < 18; i++) {
  const name = `segment${String(i).padStart(2, '0')}.m4s`,
    data = await readFile(path.join(root, 'video-high', name));
  shiftTfdt(data);
  await writeFile(path.join(shifted, name), data);
}
await writeFile(
  path.join(shifted, 'index.m3u8'),
  await readFile(path.join(root, 'video-high/index.m3u8')),
);
const renditionManifest = await readFile(
  path.join(root, 'renditions.m3u8'),
  'utf8',
);
await writeFile(
  path.join(root, 'renditions.m3u8'),
  renditionManifest.replace(
    'video-high/index.m3u8',
    'video-shifted/index.m3u8',
  ),
);

await writeFile(
  path.join(root, 'ts-renditions.m3u8'),
  `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=320x180
bframes/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=640x360
bframes-high/index.m3u8
`,
);

// HEVC Main/Main10, including reordered pictures, and standalone AAC ladders.
for (const depth of [8, 10]) {
  const dir = path.join(root, 'hevc-' + depth);
  await mkdir(dir, { recursive: true });
  ffmpeg(
    '-filter_threads',
    '1',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=320x180:rate=25',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=660:sample_rate=48000',
    '-t',
    '8',
    '-c:v',
    'libx265',
    '-preset',
    'ultrafast',
    '-threads',
    '2',
    '-x265-params',
    'pools=1:frame-threads=1:keyint=50:min-keyint=50:scenecut=0:open-gop=0:log-level=error',
    '-pix_fmt',
    depth === 10 ? 'yuv420p10le' : 'yuv420p',
    '-c:a',
    'aac',
    '-f',
    'hls',
    '-hls_time',
    '2',
    '-hls_list_size',
    '0',
    '-hls_segment_filename',
    path.join(dir, 'segment%02d.ts'),
    path.join(dir, 'index.m3u8'),
  );
  ffmpeg(
    '-i',
    path.join(dir, 'index.m3u8'),
    '-c',
    'copy',
    '-bsf:a',
    'aac_adtstoasc',
    '-tag:v',
    'hvc1',
    '-f',
    'hls',
    '-hls_time',
    '2',
    '-hls_list_size',
    '0',
    '-hls_segment_type',
    'fmp4',
    '-hls_fmp4_init_filename',
    'init.mp4',
    '-hls_segment_filename',
    path.join(dir, 'segment%02d.m4s'),
    path.join(dir, 'fmp4.m3u8'),
  );
}
for (const rate of [64, 128]) {
  const dir = path.join(root, 'audio-' + rate);
  await mkdir(dir, { recursive: true });
  ffmpeg(
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=48000',
    '-t',
    '18',
    '-c:a',
    'aac',
    '-b:a',
    rate + 'k',
    '-f',
    'hls',
    '-hls_time',
    rate === 128 ? '4' : '2',
    '-hls_list_size',
    '0',
    '-hls_segment_filename',
    path.join(dir, 'segment%02d.ts'),
    path.join(dir, 'index.m3u8'),
  );
  ffmpeg(
    '-i',
    path.join(dir, 'index.m3u8'),
    '-c',
    'copy',
    '-bsf:a',
    'aac_adtstoasc',
    '-f',
    'hls',
    '-hls_time',
    rate === 128 ? '4' : '2',
    '-hls_list_size',
    '0',
    '-hls_segment_type',
    'fmp4',
    '-hls_fmp4_init_filename',
    'init.mp4',
    '-hls_segment_filename',
    path.join(dir, 'segment%02d.m4s'),
    path.join(dir, 'fmp4.m3u8'),
  );
}
const audioLadder =
  '#EXT-X-STREAM-INF:BANDWIDTH=72000,CODECS="mp4a.40.2"\naudio-64/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=140000,CODECS="mp4a.40.2"\naudio-128/index.m3u8\n';
await writeFile(path.join(root, 'audio-only.m3u8'), '#EXTM3U\n' + audioLadder);
await writeFile(
  path.join(root, 'mixed-media.m3u8'),
  '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=320x180,CODECS="avc1.42c00c,mp4a.40.2"\nts/index.m3u8\n' +
    audioLadder,
);

for (const depth of [8, 10]) {
  const dir = path.join(root, 'av1-' + depth);
  await mkdir(dir, { recursive: true });
  ffmpeg(
    '-filter_threads',
    '1',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=${depth === 8 ? '160x90' : '320x180'}:rate=25`,
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=550:sample_rate=48000',
    '-t',
    '12',
    '-c:v',
    'libaom-av1',
    '-cpu-used',
    '8',
    '-row-mt',
    '1',
    '-threads',
    '2',
    '-g',
    '50',
    '-crf',
    '38',
    '-b:v',
    '0',
    '-pix_fmt',
    depth === 10 ? 'yuv420p10le' : 'yuv420p',
    '-color_primaries',
    'bt709',
    '-color_trc',
    'bt709',
    '-colorspace',
    'bt709',
    '-c:a',
    'aac',
    '-f',
    'hls',
    '-hls_time',
    '2',
    '-hls_list_size',
    '0',
    '-hls_segment_type',
    'fmp4',
    '-hls_segment_filename',
    path.join(dir, 'segment%02d.m4s'),
    path.join(dir, 'index.m3u8'),
  );
}
await writeFile(
  path.join(root, 'av1.m3u8'),
  '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=300000,RESOLUTION=160x90,CODECS="av01.0.00M.08,mp4a.40.2"\nav1-8/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=700000,RESOLUTION=320x180,CODECS="av01.0.00M.10,mp4a.40.2"\nav1-10/index.m3u8\n',
);

// Structural regression: an unsupported caption track alongside real A/V.
// Original pop-on caption bytes with odd parity and duplicate controls.
{
  const { build } = await import('esbuild');
  const bundled = await build({
    entryPoints: [
      new URL('../src/engines/hls/mp4.ts', import.meta.url).pathname,
    ],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
  });
  const { boxes, box, concat, fragment } = await import(
    'data:text/javascript;base64,' +
      Buffer.from(bundled.outputFiles[0].text).toString('base64')
  );
  const source = path.join(root, 'fmp4'),
    dir = path.join(root, 'caption-tracks');
  await mkdir(dir, { recursive: true });
  const init = new Uint8Array(await readFile(path.join(source, 'init.mp4')));
  const moov = boxes(init).find((b) => b.type === 'moov');
  const children = boxes(moov.body);
  const caption = children.find((b) => b.type === 'trak').body.slice();
  const child = (data, type) => boxes(data).find((b) => b.type === type).body;
  const tkhd = child(caption, 'tkhd');
  new DataView(tkhd.buffer, tkhd.byteOffset, tkhd.byteLength).setUint32(
    tkhd[0] === 1 ? 20 : 12,
    99,
  );
  const mdia = child(caption, 'mdia');
  child(mdia, 'hdlr').set(new TextEncoder().encode('clcp'), 8);
  const entry = boxes(
    child(child(child(mdia, 'minf'), 'stbl'), 'stsd').subarray(8),
  )[0];
  caption.set(
    new TextEncoder().encode('c608'),
    entry.body.byteOffset - caption.byteOffset - 4,
  );
  const newMoov = box(
    'moov',
    ...children.map((b) => {
      if (b.type !== 'mvex') return box(b.type, b.body);
      const trex = child(b.body, 'trex').slice();
      new DataView(trex.buffer).setUint32(4, 99);
      return box('mvex', b.body, box('trex', trex));
    }),
    box('trak', caption),
  );
  await writeFile(
    path.join(dir, 'init.mp4'),
    concat(
      ...boxes(init).map((b) =>
        b.type === 'moov' ? newMoov : box(b.type, b.body),
      ),
    ),
  );
  const playlist = await readFile(path.join(source, 'index.m3u8'), 'utf8');
  await writeFile(path.join(dir, 'index.m3u8'), playlist);
  for (const name of playlist
    .split('\n')
    .filter((line) => line.endsWith('.m4s'))) {
    const media = await readFile(path.join(source, name));
    const parity = (value) => {
      let n = value,
        bits = 0;
      while (n) {
        bits ^= n & 1;
        n >>>= 1;
      }
      return value | (bits ? 0 : 128);
    };
    const pairs = [
      0x14,
      0x20,
      0x14,
      0x20,
      0x14,
      0x2e,
      0x14,
      0x2e,
      0x11,
      0x54,
      0x11,
      0x54,
      ...Array.from('ThePlayer 608 ', (c) => c.charCodeAt(0)),
      0x14,
      0x2f,
      0x14,
      0x2f,
    ];
    const extra = fragment(
      { id: 99, kind: 'audio', timescale: 90000, codec: 'c608' },
      [
        {
          data: box('cdat', Uint8Array.from(pairs, parity)),
          duration: 90000,
          cts: 0,
          key: true,
        },
      ],
      Number(/segment(\d+)/.exec(name)[1]) * 180000,
      999,
    );
    await writeFile(path.join(dir, name), concat(media, extra));
  }
}

// The same A/V samples with a PMT section spanning two TS packets.
await mkdir(path.join(root, 'psi'), { recursive: true });
const psiPlaylist = await readFile(path.join(root, 'ts/index.m3u8'), 'utf8');
await writeFile(path.join(root, 'psi/index.m3u8'), psiPlaylist);
for (const name of psiPlaylist
  .split('\n')
  .filter((line) => line.endsWith('.ts')))
  await writeFile(
    path.join(root, 'psi', name),
    expandedPsi(await readFile(path.join(root, 'ts', name))),
  );

for (const [source, mode, name] of [
  ['ts', 'split', 'pes-split'],
  ['ts', 'bundle', 'pes-bundle'],
  ['bframes', 'bundle', 'pes-bframes'],
]) {
  const playlist = await readFile(
    path.join(root, source, 'index.m3u8'),
    'utf8',
  );
  await mkdir(path.join(root, name), { recursive: true });
  await writeFile(path.join(root, name, 'index.m3u8'), playlist);
  for (const segment of playlist
    .split('\n')
    .filter((line) => line.endsWith('.ts')))
    await writeFile(
      path.join(root, name, segment),
      videoPesFixture(await readFile(path.join(root, source, segment)), mode),
    );
}

await import('./prepare-ll-hls-fixtures.mjs');
