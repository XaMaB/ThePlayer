import { mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
const root =
  process.env.THEPLAYER_HLS_FIXTURES ??
  path.join(os.tmpdir(), 'theplayer-hls-fixtures');
const dir = path.join(root, 'open-gop');
await mkdir(dir, { recursive: true });
execFileSync(
  'ffmpeg',
  [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=320x180:rate=25',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=48000',
    '-t',
    '12',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-x264-params',
    'open-gop=1:keyint=50:min-keyint=50:scenecut=0:bframes=3',
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
  ],
  { stdio: 'inherit' },
);
console.log('Generated AVC open-GOP recovery-point fixture');
