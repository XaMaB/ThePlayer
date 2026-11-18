import { mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
const root = path.join(
  process.env.THEPLAYER_HLS_FIXTURES ??
    path.join(os.tmpdir(), 'theplayer-hls-fixtures'),
  'video-renditions',
);
await mkdir(root, { recursive: true });
for (const [name, color, size] of [
  ['blue', 'blue', '320x180'],
  ['green', '0x00ff00', '320x180'],
  ['red', 'red', '640x360'],
  ['yellow', 'yellow', '640x360'],
]) {
  const dir = path.join(root, name);
  await mkdir(dir, { recursive: true });
  const result = spawnSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `color=c=${color}:s=${size}:r=25:d=18`,
      '-an',
      '-c:v',
      'libx264',
      '-profile:v',
      'baseline',
      '-pix_fmt',
      'yuv420p',
      '-g',
      '50',
      '-keyint_min',
      '50',
      '-sc_threshold',
      '0',
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
    ],
    { encoding: 'utf8' },
  );
  if (result.status) throw new Error(result.stderr);
}
let master =
  '#EXTM3U\n#EXT-X-INDEPENDENT-SEGMENTS\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="../audio-en/index.m3u8"\n';
for (const [id, main, alternate, size, codec, bandwidth] of [
  ['low', 'blue', 'green', '320x180', 'avc1.42c00c', 500000],
  ['high', 'red', 'yellow', '640x360', 'avc1.42c01e', 1500000],
]) {
  const tracks = [
    `#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="${id}",NAME="Main",DEFAULT=YES,AUTOSELECT=YES`,
    `#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="${id}",NAME="Alternate",DEFAULT=NO,AUTOSELECT=NO,URI="${alternate}/index.m3u8"`,
  ];
  if (id === 'high') tracks.reverse();
  master +=
    tracks.join('\n') +
    `\n#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},CODECS="${codec},mp4a.40.2",RESOLUTION=${size},AUDIO="audio",VIDEO="${id}"\n${main}/index.m3u8\n`;
}
await writeFile(path.join(root, 'master.m3u8'), master);
console.log('Prepared original video-angle fixtures', root);
