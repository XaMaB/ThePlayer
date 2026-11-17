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
for (const kind of ['ts', 'fmp4', 'bframes']) {
  const dir = path.join(root, kind);
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
    'sine=frequency=880:sample_rate=48000',
    '-t',
    '18',
    '-c:v',
    'libx264',
    '-threads',
    '2',
    '-preset',
    kind === 'bframes' ? 'fast' : 'ultrafast',
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
