import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
const root =
  process.env.THEPLAYER_HLS_FIXTURES ??
  path.join(os.tmpdir(), 'theplayer-hls-fixtures');
const dir = path.join(root, 'll-parts');
await mkdir(dir, { recursive: true });
execFileSync(
  'ffmpeg',
  [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-filter_threads',
    '1',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=320x180:rate=24',
    '-t',
    '12',
    '-an',
    '-c:v',
    'libx264',
    '-threads',
    '1',
    '-preset',
    'ultrafast',
    '-profile:v',
    'baseline',
    '-g',
    '48',
    '-keyint_min',
    '48',
    '-sc_threshold',
    '0',
    '-f',
    'hls',
    '-hls_segment_type',
    'fmp4',
    '-hls_time',
    '0.5',
    '-hls_flags',
    'split_by_time',
    '-hls_list_size',
    '0',
    '-hls_segment_filename',
    path.join(dir, 'part%02d.m4s'),
    path.join(dir, 'index.m3u8'),
  ],
  { stdio: 'inherit' },
);
for (let i = 0; i < 6; i++) {
  const parts = await Promise.all(
    Array.from({ length: 4 }, (_, n) =>
      readFile(path.join(dir, `part${String(i * 4 + n).padStart(2, '0')}.m4s`)),
    ),
  );
  await writeFile(path.join(dir, `parent${i}.m4s`), Buffer.concat(parts));
}
console.log('Generated LL-HLS 500 ms parts, including dependent pictures');
