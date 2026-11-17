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
