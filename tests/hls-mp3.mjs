import { build } from 'esbuild';
import { createDecipheriv } from 'node:crypto';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
const root =
  process.env.THEPLAYER_HLS_FIXTURES ??
  path.join(os.tmpdir(), 'theplayer-hls-fixtures');
async function module(name) {
  const r = await build({
    entryPoints: [
      new URL('../src/engines/hls/' + name + '.ts', import.meta.url).pathname,
    ],
    bundle: true,
    write: false,
    format: 'esm',
  });
  return import(
    'data:text/javascript;base64,' +
      Buffer.from(r.outputFiles[0].text).toString('base64')
  );
}
const { packedMp3 } = await module('packed-mp3'),
  { initialization, fragment } = await module('mp4'),
  { unwrap } = await module('transport-stream');
const temp = await mkdtemp(path.join(os.tmpdir(), 'theplayer-mp3-'));
const hash = (file) =>
  execFileSync(
    'ffmpeg',
    ['-hide_banner', '-loglevel', 'error', '-i', file, '-f', 'framehash', '-'],
    { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
  )
    .split('\n')
    .filter((l) => l && !l.startsWith('#'));
try {
  for (const mode of [
    'mpeg1',
    'mpeg2',
    'mpeg25',
    'vbr',
    'aes128',
    'rollover',
  ]) {
    const dir = path.join(root, 'packed-mp3-' + mode),
      list = await readFile(path.join(dir, 'index.m3u8'), 'utf8'),
      names = list.split('\n').filter((l) => l.endsWith('.mp3'));
    const payloads = [],
      mp4 = [];
    let clock,
      epoch,
      serial = 0;
    for (const [sequence, name] of names.entries()) {
      let data = await readFile(path.join(dir, name));
      if (mode === 'aes128') {
        const iv = Buffer.alloc(16);
        iv.writeUInt32BE(sequence, 12);
        const d = createDecipheriv('aes-128-cbc', Buffer.alloc(16, 0x48), iv);
        data = Buffer.concat([d.update(data), d.final()]);
      }
      const packed = packedMp3(data);
      payloads.push(packed.data);
      clock = unwrap(packed.timestamp, clock ?? packed.timestamp);
      epoch ??= clock;
      if (!mp4.length) mp4.push(initialization([packed.track]));
      mp4.push(
        fragment(
          packed.track,
          packed.samples,
          ((clock - epoch) * packed.track.timescale) / 90000,
          ++serial,
        ),
      );
    }
    assert.deepEqual(
      Buffer.concat(payloads),
      await readFile(path.join(dir, 'original.mp3')),
    );
    const output = path.join(temp, mode + '.mp4');
    await writeFile(output, Buffer.concat(mp4));
    const reference = hash(path.join(dir, 'original.mp3'));
    assert.deepEqual(hash(output), reference);
    console.log(
      'PASS independent MP3 remux decode: every payload, audio hash and timestamp',
      mode,
      reference.length,
    );
  }
} finally {
  await rm(temp, { recursive: true, force: true });
}
