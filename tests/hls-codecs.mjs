// Independent decoding verifies our HEVC remux even on browsers without HEVC.
import { build } from 'esbuild';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
const root =
  process.env.THEPLAYER_HLS_FIXTURES ??
  path.join(os.tmpdir(), 'theplayer-hls-fixtures');
async function module(name) {
  const result = await build({
    entryPoints: [
      new URL('../src/engines/hls/' + name + '.ts', import.meta.url).pathname,
    ],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
  });
  return import(
    'data:text/javascript;base64,' +
      Buffer.from(result.outputFiles[0].text).toString('base64')
  );
}
const { TsTransmuxer } = await module('transport-stream');
const { inspectInit } = await module('mp4');
const temp = await mkdtemp(path.join(os.tmpdir(), 'theplayer-codecs-'));
try {
  const { expandedPsi } = await import('./helpers/expanded-psi.mjs');
  const input = expandedPsi(await readFile(path.join(root, 'ts/segment00.ts')));
  const expanded = new TsTransmuxer().transmux(input, 2);
  const expandedFile = path.join(temp, 'expanded-psi.mp4');
  await writeFile(expandedFile, Buffer.concat([expanded.init, expanded.media]));
  const expandedProbe = JSON.parse(
    execFileSync(
      'ffprobe',
      [
        '-v',
        'error',
        '-count_frames',
        '-show_streams',
        '-of',
        'json',
        expandedFile,
      ],
      { encoding: 'utf8' },
    ),
  );
  assert.equal(
    Number(
      expandedProbe.streams.find((s) => s.codec_type === 'video')
        .nb_read_frames,
    ),
    50,
  );
  assert.ok(
    Number(
      expandedProbe.streams.find((s) => s.codec_type === 'audio')
        .nb_read_frames,
    ) > 0,
  );
  console.log(
    'PASS multi-packet PMT remux: 50 AVC frames and audio independently decoded',
  );
  for (const depth of [8, 10]) {
    const decoder = new TsTransmuxer();
    const fragments = [];
    for (let i = 0; i < 4; i++) {
      const result = decoder.transmux(
        await readFile(path.join(root, 'hevc-' + depth, `segment0${i}.ts`)),
        2,
      );
      const video = result.tracks.find((t) => t.kind === 'video');
      assert.equal(video.width, 320);
      assert.equal(video.height, 180);
      assert.match(video.codec, depth === 10 ? /^hvc1\.2\./ : /^hvc1\.1\./);
      assert.equal(inspectInit(result.init)[0].codec, video.codec);
      if (!i) fragments.push(result.init);
      fragments.push(result.media);
    }
    const file = path.join(temp, 'hevc-' + depth + '.mp4');
    await writeFile(file, Buffer.concat(fragments));
    const probe = JSON.parse(
      execFileSync(
        'ffprobe',
        ['-v', 'error', '-count_frames', '-show_streams', '-of', 'json', file],
        { encoding: 'utf8' },
      ),
    );
    const video = probe.streams.find((s) => s.codec_type === 'video');
    assert.equal(Number(video.nb_read_frames), 200);
    assert.equal(video.pix_fmt, depth === 10 ? 'yuv420p10le' : 'yuv420p');
    execFileSync(
      'ffmpeg',
      ['-v', 'error', '-xerror', '-i', file, '-f', 'null', '-'],
      { stdio: 'pipe' },
    );
    const native = inspectInit(
      await readFile(path.join(root, 'hevc-' + depth, 'init.mp4')),
    );
    assert.match(native[0].codec, /^hvc1\./);
    console.log(
      `PASS HEVC Main${depth === 10 ? '10' : ''}: 200 decoded frames, audio, TS remux and fMP4 init`,
    );
  }
  for (const rate of [64, 128]) {
    const result = new TsTransmuxer().transmux(
      await readFile(path.join(root, 'audio-' + rate, 'segment00.ts')),
      2,
    );
    assert.deepEqual(
      result.tracks.map((t) => t.kind),
      ['audio'],
    );
    const file = path.join(temp, 'audio-' + rate + '.mp4');
    await writeFile(file, Buffer.concat([result.init, result.media]));
    execFileSync(
      'ffmpeg',
      ['-v', 'error', '-xerror', '-i', file, '-f', 'null', '-'],
      { stdio: 'pipe' },
    );
    console.log('PASS standalone AAC ' + rate + ' kb/s');
  }
} finally {
  await rm(temp, { recursive: true, force: true });
}
