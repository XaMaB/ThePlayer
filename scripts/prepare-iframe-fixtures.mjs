import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createCipheriv } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
const root =
  process.env.THEPLAYER_HLS_FIXTURES ??
  path.join(os.tmpdir(), 'theplayer-hls-fixtures');
const dir = path.join(root, 'iframes');
await mkdir(dir, { recursive: true });
const key = Buffer.alloc(16, 0x38),
  iv = Buffer.alloc(16, 0x19);
await writeFile(path.join(dir, 'key.bin'), key);
execFileSync('ffmpeg', [
  '-hide_banner',
  '-loglevel',
  'error',
  '-y',
  '-f',
  'lavfi',
  '-i',
  'color=c=red:s=320x180:r=25',
  '-frames:v',
  '3',
  '-an',
  '-c:v',
  'libx264',
  '-threads',
  '1',
  '-preset',
  'ultrafast',
  '-g',
  '1',
  '-f',
  'mpegts',
  path.join(dir, 'multiple.ts'),
]);
const frames = [];
const tsFrames = [];
for (const [i, color] of ['red', 'lime', 'blue'].entries()) {
  const common = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `color=c=${color}:s=320x180:r=25`,
    '-frames:v',
    '1',
    '-an',
    '-c:v',
    'libx264',
    '-threads',
    '1',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    '-g',
    '1',
  ];
  execFileSync('ffmpeg', [
    ...common,
    '-f',
    'mpegts',
    path.join(dir, `${i}.ts`),
  ]);
  execFileSync('ffmpeg', [
    ...common,
    '-movflags',
    'empty_moov+frag_keyframe+default_base_moof',
    path.join(dir, `${i}.mp4`),
  ]);
  const ts = await readFile(path.join(dir, `${i}.ts`));
  let tsOffset = 0;
  while (
    tsOffset < ts.length &&
    (ts[tsOffset + 1] & 31) * 256 + ts[tsOffset + 2] !== 256
  )
    tsOffset += 188;
  if (!tsOffset || tsOffset >= ts.length)
    throw new Error('Missing TS initialization/picture');
  tsFrames.push({ offset: tsOffset, length: ts.length - tsOffset });
  const tsCipher = createCipheriv('aes-128-cbc', key, iv);
  await writeFile(
    path.join(dir, `${i}.tsenc`),
    Buffer.concat([tsCipher.update(ts), tsCipher.final()]),
  );
  for (const codec of ['hevc', 'av1']) {
    const prefix = common.slice(0, common.indexOf('-c:v'));
    const encoder =
      codec === 'hevc'
        ? [
            '-c:v',
            'libx265',
            '-preset',
            'ultrafast',
            '-x265-params',
            'pools=1:frame-threads=1:log-level=error:keyint=25',
            '-tag:v',
            'hvc1',
          ]
        : ['-c:v', 'libaom-av1', '-cpu-used', '8', '-crf', '40', '-g', '1'];
    execFileSync('ffmpeg', [
      ...prefix,
      ...encoder,
      '-threads',
      '1',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      'delay_moov+frag_keyframe+default_base_moof',
      path.join(dir, `${i}-${codec}.mp4`),
    ]);
    const encoded = await readFile(path.join(dir, `${i}-${codec}.mp4`));
    let start = 0;
    while (
      start < encoded.length &&
      encoded.toString('ascii', start + 4, start + 8) !== 'moof'
    )
      start += encoded.readUInt32BE(start);
    if (start >= encoded.length)
      throw new Error('Missing codec fixture fragment');
    await writeFile(
      path.join(dir, `${i}-${codec}-init.mp4`),
      encoded.subarray(0, start),
    );
    await writeFile(
      path.join(dir, `${i}-${codec}.m4s`),
      encoded.subarray(start),
    );
  }
  const data = await readFile(path.join(dir, `${i}.mp4`));
  let at = 0;
  while (at < data.length && data.toString('ascii', at + 4, at + 8) !== 'moof')
    at += data.readUInt32BE(at);
  if (at >= data.length) throw new Error('Missing fixture fragment');
  let end = at;
  while (
    end < data.length &&
    data.toString('ascii', end + 4, end + 8) !== 'mfra'
  )
    end += data.readUInt32BE(end);
  frames.push({ offset: at, length: end - at });
  await writeFile(path.join(dir, `${i}-init.mp4`), data.subarray(0, at));
  await writeFile(path.join(dir, `${i}.m4s`), data.subarray(at, end));
  const cipher = createCipheriv('aes-128-cbc', key, iv);
  await writeFile(
    path.join(dir, `${i}.enc`),
    Buffer.concat([cipher.update(data), cipher.final()]),
  );
}
for (const mode of [
  'ts',
  'fmp4',
  'range',
  'implicit',
  'encrypted',
  'ts-range',
  'ts-implicit',
  'ts-encrypted',
  'hevc',
  'av1',
  'gap',
  'multiple',
]) {
  await writeFile(
    path.join(dir, `${mode}-master.m3u8`),
    '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=600000,CODECS="avc1.42c00c,mp4a.40.2",RESOLUTION=320x180\n../ts/index.m3u8\n#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=10000,CODECS="avc1.42c00c",RESOLUTION=320x180,URI="' +
      mode +
      '.m3u8"\n',
  );
  let text =
    '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:2\n#EXT-X-I-FRAMES-ONLY\n#EXT-X-PLAYLIST-TYPE:VOD\n';
  if (mode.endsWith('encrypted'))
    text +=
      '#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x' +
      iv.toString('hex') +
      '\n';
  for (let i = 0; i < 3; i++) {
    if (mode === 'gap' || mode === 'multiple') {
      text +=
        (mode === 'gap' ? '#EXT-X-GAP\n' : '') + '#EXTINF:2,\nmultiple.ts\n';
      continue;
    }
    if (mode === 'hevc' || mode === 'av1') {
      text += `#EXT-X-MAP:URI="${i}-${mode}-init.mp4"\n#EXTINF:2,\n${i}-${mode}.m4s\n`;
      continue;
    }
    const isTs = mode.startsWith('ts');
    const { offset, length } = (isTs ? tsFrames : frames)[i];
    const extension = isTs
      ? mode.endsWith('encrypted')
        ? 'tsenc'
        : 'ts'
      : mode === 'fmp4'
        ? 'm4s'
        : mode === 'encrypted'
          ? 'enc'
          : 'mp4';
    if (mode === 'fmp4') text += `#EXT-X-MAP:URI="${i}-init.mp4"\n`;
    if (mode.endsWith('range') || mode.endsWith('encrypted'))
      text += `#EXT-X-MAP:URI="${i}.${extension}",BYTERANGE="${offset}@0"\n`;
    if (mode !== 'ts' && mode !== 'fmp4')
      text += `#EXT-X-BYTERANGE:${length}@${offset}\n`;
    text += `#EXTINF:2,\n${i}.${extension}\n`;
  }
  await writeFile(path.join(dir, mode + '.m3u8'), text + '#EXT-X-ENDLIST\n');
}
console.log(
  'Prepared synthetic independent AVC pictures in TS/fMP4, byte ranges and AES-CBC',
);
