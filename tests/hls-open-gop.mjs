import { build } from 'esbuild';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
const root =
  process.env.THEPLAYER_HLS_FIXTURES ??
  path.join(os.tmpdir(), 'theplayer-hls-fixtures');
const compiled = await build({
  entryPoints: [
    new URL('../src/engines/hls/transport-stream.ts', import.meta.url).pathname,
  ],
  bundle: true,
  write: false,
  format: 'esm',
});
const { TsTransmuxer } = await import(
  'data:text/javascript;base64,' +
    Buffer.from(compiled.outputFiles[0].text).toString('base64')
);
const dir = await mkdtemp(path.join(os.tmpdir(), 'theplayer-open-gop-'));
try {
  const decoder = new TsTransmuxer(),
    output = [];
  const playlist = await readFile(
    path.join(root, 'open-gop/index.m3u8'),
    'utf8',
  );
  for (const name of playlist
    .split('\n')
    .filter((line) => line.endsWith('.ts'))) {
    const result = decoder.transmux(
      new Uint8Array(await readFile(path.join(root, 'open-gop', name))),
      2,
    );
    if (!output.length) output.push(result.init);
    output.push(result.media);
    assert.match(
      result.tracks.find((t) => t.kind === 'video').codec,
      /^avc3\./,
    );
  }
  const file = path.join(dir, 'remux.mp4');
  await writeFile(file, Buffer.concat(output));
  const hashes = (file) =>
    execFileSync(
      'ffmpeg',
      [
        '-v',
        'error',
        '-i',
        file,
        '-map',
        '0:v:0',
        '-vsync',
        '0',
        '-f',
        'framemd5',
        '-',
      ],
      { encoding: 'utf8' },
    )
      .split('\n')
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => line.split(',').at(-1).trim());
  const reference = hashes(path.join(root, 'open-gop/index.m3u8'));
  assert.equal(reference.length, 300);
  assert.deepEqual(hashes(file), reference);
  console.log('PASS AVC open-GOP recovery: all 300 decoded frame hashes match');
} finally {
  await rm(dir, { recursive: true, force: true });
}
