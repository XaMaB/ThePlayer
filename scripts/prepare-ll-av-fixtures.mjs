import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
const root =
  process.env.THEPLAYER_HLS_FIXTURES ??
  path.join(os.tmpdir(), 'theplayer-hls-fixtures');
const directory = path.join(root, 'll-av');
const inventory = {};
for (const lane of ['video', 'audio', 'audio2']) {
  const dir = path.join(directory, lane);
  await mkdir(dir, { recursive: true });
  const input =
    lane === 'video'
      ? [
          '-f',
          'lavfi',
          '-i',
          'testsrc2=size=320x180:rate=24',
          '-an',
          '-c:v',
          'libx264',
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
        ]
      : [
          '-f',
          'lavfi',
          '-i',
          `sine=frequency=${lane === 'audio' ? 523 : 784}:sample_rate=48000`,
          '-vn',
          '-c:a',
          'aac',
          '-b:a',
          '96000',
        ];
  execFileSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    ...input,
    '-t',
    '30',
    '-threads',
    '1',
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
    path.join(dir, 'part%03d.m4s'),
    path.join(dir, 'index.m3u8'),
  ]);
  const playlist = await readFile(path.join(dir, 'index.m3u8'), 'utf8');
  let start = 0;
  const parts = [...playlist.matchAll(/#EXTINF:([\d.]+),\s*([^\n]+)/g)].map(
    (m) => {
      const item = { start, duration: Number(m[1]), file: m[2].trim() };
      start += item.duration;
      return item;
    },
  );
  const parents = [];
  for (let i = 0; i + 4 <= parts.length; i += 4) {
    const selected = parts.slice(i, i + 4);
    const file = `parent${i / 4}.m4s`;
    await writeFile(
      path.join(dir, file),
      Buffer.concat(
        await Promise.all(
          selected.map((s) => readFile(path.join(dir, s.file))),
        ),
      ),
    );
    parents.push({
      start: selected[0].start,
      duration: selected.reduce((n, s) => n + s.duration, 0),
      file,
    });
  }
  inventory[lane] = { parts, parents };
}
await writeFile(
  path.join(directory, 'inventory.json'),
  JSON.stringify(inventory),
);
console.log(
  'Prepared independent LL-HLS video/audio parts with different clocks and durations',
);
