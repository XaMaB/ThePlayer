import { mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
const root =
  process.env.THEPLAYER_DASH_FIXTURES ??
  path.join(os.tmpdir(), 'theplayer-dash-fixtures');
for (const codec of ['av1', 'hevc', 'ac3', 'eac3']) {
  const dir = path.join(root, 'profiles', codec);
  await mkdir(dir, { recursive: true });
  const video = ['av1', 'hevc'].includes(codec);
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    video
      ? 'testsrc2=size=320x180:rate=25'
      : 'sine=frequency=440:sample_rate=48000',
  ];
  if (codec === 'av1')
    args.push(
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
      '-b:v',
      '250k',
    );
  if (codec === 'hevc')
    args.push(
      '-c:v',
      'libx265',
      '-preset',
      'ultrafast',
      '-x265-params',
      'pools=1:frame-threads=1:keyint=50:min-keyint=50:scenecut=0:log-level=error',
      '-tag:v',
      'hvc1',
      '-b:v',
      '250k',
    );
  if (!video) args.push('-c:a', codec, '-b:a', '192k');
  args.push(
    '-t',
    '12',
    '-f',
    'dash',
    '-seg_duration',
    '2',
    '-use_template',
    '1',
    '-use_timeline',
    '1',
    path.join(dir, 'manifest.mpd'),
  );
  execFileSync('ffmpeg', args, { stdio: 'inherit' });
}
console.log('Generated original DASH AV1/HEVC/AC-3/E-AC-3 codec profiles');
