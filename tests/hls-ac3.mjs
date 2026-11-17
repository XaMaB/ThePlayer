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
const { packedAc3 } = await module('packed-ac3'),
  { TsTransmuxer } = await module('transport-stream'),
  { decryptSamplePes } = await module('sample-aes');
const temp = await mkdtemp(path.join(os.tmpdir(), 'theplayer-ac3-'));
const hash = (file) =>
  execFileSync(
    'ffmpeg',
    ['-hide_banner', '-loglevel', 'error', '-i', file, '-f', 'framehash', '-'],
    { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
  )
    .split('\n')
    .filter((l) => l && !l.startsWith('#'));
try {
  for (const mode of ['48', '44', '32', 'surround', 'aes128', 'sample-aes']) {
    const dir = path.join(root, 'packed-ac3-' + mode),
      list = await readFile(path.join(dir, 'index.m3u8'), 'utf8'),
      names = list.split('\n').filter((l) => l.endsWith('.ac3'));
    const payloads = [],
      mp4 = [],
      decoder = new TsTransmuxer();
    for (const [sequence, name] of names.entries()) {
      let data = await readFile(path.join(dir, name));
      const raw = Buffer.alloc(16, 0x51),
        iv = Buffer.alloc(16);
      iv.writeUInt32BE(sequence, 12);
      if (mode === 'aes128') {
        const d = createDecipheriv('aes-128-cbc', raw, iv);
        data = Buffer.concat([d.update(data), d.final()]);
      }
      let { pes } = packedAc3(data);
      if (mode === 'sample-aes')
        pes = await decryptSamplePes(
          pes,
          await crypto.subtle.importKey('raw', raw, 'AES-CBC', false, [
            'encrypt',
            'decrypt',
          ]),
          iv,
        );
      payloads.push(pes[0].data);
      const result = decoder.transmuxPes(pes, 2);
      if (!mp4.length) mp4.push(result.init);
      mp4.push(result.media);
    }
    assert.deepEqual(
      Buffer.concat(payloads),
      await readFile(path.join(dir, 'original.ac3')),
    );
    const output = path.join(temp, mode + '.mp4');
    await writeFile(output, Buffer.concat(mp4));
    const reference = hash(path.join(dir, 'original.ac3'));
    const actual = hash(output);
    // The raw AC-3 demuxer uses a 90 kHz clock and truncates each 44.1 kHz
    // frame duration. Compare decoded PCM independently, then verify the
    // sample-accurate MP4 clock against AC-3's fixed 1536 samples per frame.
    const pcm = (lines) =>
      lines.map((line) =>
        line
          .split(',')
          .slice(3)
          .map((v) => v.trim()),
      );
    assert.deepEqual(pcm(actual), pcm(reference));
    for (const [index, line] of actual.entries()) {
      const columns = line.split(',').map((v) => v.trim());
      assert.equal(Number(columns[1]), index * 1536);
      assert.equal(Number(columns[2]), index * 1536);
      assert.equal(Number(columns[3]), 1536);
    }
    console.log(
      'PASS independent AC-3 decryption/remux: all payloads, hashes and timestamps',
      mode,
      reference.length,
    );
  }
  const ts = await readFile(path.join(root, 'ts-ac3/segment0.ts')),
    result = new TsTransmuxer().transmux(ts, 2);
  const original = path.join(temp, 'original.ts'),
    output = path.join(temp, 'ts.mp4');
  await writeFile(original, ts);
  await writeFile(output, Buffer.concat([result.init, result.media]));
  // FFmpeg normalizes the source PTS epoch when producing decoded output.
  assert.deepEqual(hash(output), hash(original));
  console.log('PASS independent TS AC-3 remux');
} finally {
  await rm(temp, { recursive: true, force: true });
}
