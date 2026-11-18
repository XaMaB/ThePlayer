import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createCipheriv } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
const root =
  process.env.THEPLAYER_HLS_FIXTURES ??
  path.join(os.tmpdir(), 'theplayer-hls-fixtures');
const dir = path.join(root, 'images');
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
    'color=c=red:s=320x180,drawbox=x=160:y=0:w=160:h=90:color=lime:t=fill,drawbox=x=0:y=90:w=160:h=90:color=blue:t=fill,drawbox=x=160:y=90:w=160:h=90:color=yellow:t=fill',
    '-frames:v',
    '1',
    '-threads',
    '1',
    '-q:v',
    '2',
    path.join(dir, 'grid.jpg'),
  ],
  { stdio: 'inherit' },
);
const data = await readFile(path.join(dir, 'grid.jpg'));
await writeFile(
  path.join(dir, 'range.bin'),
  Buffer.concat([Buffer.alloc(128), data, Buffer.alloc(64)]),
);
const key = Buffer.alloc(16, 0x72),
  iv = Buffer.alloc(16);
const cipher = createCipheriv('aes-128-cbc', key, iv);
await writeFile(
  path.join(dir, 'encrypted.bin'),
  Buffer.concat([cipher.update(data), cipher.final()]),
);
await writeFile(path.join(dir, 'key.bin'), key);
for (const mode of [
  'tiles',
  'single',
  'range',
  'encrypted',
  'gap',
  'mismatch',
  'malformed',
]) {
  await writeFile(
    path.join(dir, mode + '-master.m3u8'),
    '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=600000,CODECS="avc1.42c00c,mp4a.40.2",RESOLUTION=320x180\n../ts/index.m3u8\n#EXT-X-IMAGE-STREAM-INF:BANDWIDTH=2000,CODECS="jpeg",RESOLUTION=' +
      (mode === 'single' ? '320x180' : '160x90') +
      ',URI="' +
      mode +
      '.m3u8"\n',
  );
  let text =
    '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:2\n#EXT-X-IMAGES-ONLY\n#EXT-X-PLAYLIST-TYPE:VOD\n';
  if (mode === 'encrypted')
    text += '#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x0\n';
  if (mode !== 'single')
    text +=
      '#EXT-X-TILES:RESOLUTION=' +
      (mode === 'mismatch' ? '159x90' : '160x90') +
      ',LAYOUT=2x2,DURATION=2\n';
  if (mode === 'gap') text += '#EXT-X-GAP\n';
  if (mode === 'range') text += '#EXT-X-BYTERANGE:' + data.length + '@128\n';
  text +=
    '#EXTINF:10,\n' +
    ({ range: 'range.bin', encrypted: 'encrypted.bin', malformed: 'bad.jpg' }[
      mode
    ] ?? 'grid.jpg') +
    '\n#EXT-X-ENDLIST\n';
  await writeFile(path.join(dir, mode + '.m3u8'), text);
}
await writeFile(path.join(dir, 'bad.jpg'), Buffer.from('not a JPEG'));
console.log('Prepared synthetic JPEG thumbnail grids, ranges and encryption');
