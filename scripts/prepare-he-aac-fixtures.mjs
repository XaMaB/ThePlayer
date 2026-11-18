import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
const root =
  process.env.THEPLAYER_HLS_FIXTURES ??
  path.join(os.tmpdir(), 'theplayer-hls-fixtures');
const source = new URL('../tests/fixtures/he-aac-v2.aac', import.meta.url)
  .pathname;
const bundle = await build({
  stdin: {
    contents:
      "export { demux, TsTransmuxer } from './src/engines/hls/transport-stream';",
    resolveDir: new URL('..', import.meta.url).pathname,
  },
  bundle: true,
  write: false,
  format: 'esm',
});
const { demux, TsTransmuxer } = await import(
  'data:text/javascript;base64,' +
    Buffer.from(bundle.outputFiles[0].text).toString('base64')
);
const dirs = Object.fromEntries(
  ['ts', 'mp4', 'packed'].map((kind) => [
    kind,
    path.join(root, 'heaac-v2-' + kind),
  ]),
);
for (const dir of Object.values(dirs)) await mkdir(dir, { recursive: true });
execFileSync('ffmpeg', [
  '-hide_banner',
  '-loglevel',
  'error',
  '-y',
  '-i',
  source,
  '-c:a',
  'copy',
  '-f',
  'hls',
  '-hls_time',
  '2',
  '-hls_playlist_type',
  'vod',
  '-hls_segment_filename',
  dirs.ts + '/segment%02d.ts',
  dirs.ts + '/index.m3u8',
]);
const playlist = await readFile(dirs.ts + '/index.m3u8', 'utf8');
const transmuxer = new TsTransmuxer('mp4a.40.29');
const ss = (n) =>
  Buffer.from([(n >>> 21) & 127, (n >>> 14) & 127, (n >>> 7) & 127, n & 127]);
const joined = [];
for (const name of playlist
  .split('\n')
  .filter((line) => line.endsWith('.ts'))) {
  const bytes = new Uint8Array(await readFile(dirs.ts + '/' + name));
  const result = transmuxer.transmux(bytes, 2);
  assert.equal(result.tracks[0].codec, 'mp4a.40.29');
  assert.equal(result.tracks[0].channels, 2);
  assert.equal(result.tracks[0].timescale, 48000);
  if (!joined.length) {
    joined.push(result.init);
    await writeFile(dirs.mp4 + '/init.mp4', result.init);
  }
  joined.push(result.media);
  await writeFile(dirs.mp4 + '/' + name.replace('.ts', '.m4s'), result.media);
  const pes = demux(bytes).filter((packet) => packet.type === 15);
  const time = Buffer.alloc(8);
  time.writeBigUInt64BE(BigInt(pes[0].pts));
  const body = Buffer.concat([
    Buffer.from('com.apple.streaming.transportStreamTimestamp\0'),
    time,
  ]);
  const frame = Buffer.concat([
    Buffer.from('PRIV'),
    ss(body.length),
    Buffer.alloc(2),
    body,
  ]);
  const tag = Buffer.concat([
    Buffer.from([73, 68, 51, 4, 0, 0]),
    ss(frame.length),
    frame,
  ]);
  await writeFile(
    dirs.packed + '/' + name.replace('.ts', '.aac'),
    Buffer.concat([tag, ...pes.map((packet) => packet.data)]),
  );
}
await writeFile(
  dirs.mp4 + '/index.m3u8',
  playlist
    .replace('#EXTM3U', '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"')
    .replaceAll('.ts', '.m4s'),
);
await writeFile(
  dirs.packed + '/index.m3u8',
  playlist.replaceAll('.ts', '.aac'),
);
for (const dir of Object.values(dirs))
  await writeFile(
    dir + '/master.m3u8',
    '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=40000,CODECS="mp4a.40.29"\nindex.m3u8\n',
  );
const mp4 = path.join(root, 'heaac-v2-reference.mp4');
await writeFile(mp4, Buffer.concat(joined));
const decode = (file) =>
  execFileSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      file,
      '-f',
      's16le',
      '-acodec',
      'pcm_s16le',
      'pipe:1',
    ],
    { maxBuffer: 10 * 1024 * 1024 },
  );
const original = decode(source),
  remuxed = decode(mp4);
assert.deepEqual(
  remuxed,
  original,
  'Explicit PS configuration must preserve independently decoded stereo PCM',
);
console.log(
  'PASS HE-AAC v2 TS/fMP4/packed fixtures and byte-identical stereo PCM',
  original.length,
);
