import { build } from 'esbuild';
import { createDecipheriv } from 'node:crypto';
import { readFile } from 'node:fs/promises';
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
const { demux, TsTransmuxer } = await module('transport-stream'),
  { packedAac } = await module('packed-audio'),
  { decryptSamplePes } = await module('sample-aes');
const playlist = await readFile(path.join(root, 'audio-64/index.m3u8'), 'utf8'),
  files = playlist.split('\n').filter((l) => l.endsWith('.ts'));
for (const mode of ['clear', 'v3', 'rollover', 'aes128', 'sample-aes']) {
  const decoder = new TsTransmuxer();
  let previous = -Infinity,
    epoch;
  for (const [sequence, name] of files.entries()) {
    let bytes = await readFile(
      path.join(root, 'packed-aac-' + mode, name.replace('.ts', '.aac')),
    );
    const key = Buffer.alloc(16, 0x46),
      iv = Buffer.alloc(16);
    iv.writeUInt32BE(sequence, 12);
    if (mode === 'aes128') {
      const d = createDecipheriv('aes-128-cbc', key, iv);
      bytes = Buffer.concat([d.update(bytes), d.final()]);
    }
    const parsed = packedAac(bytes);
    const packets =
      mode === 'sample-aes'
        ? await decryptSamplePes(
            parsed.pes,
            await crypto.subtle.importKey('raw', key, 'AES-CBC', false, [
              'encrypt',
              'decrypt',
            ]),
            iv,
          )
        : parsed.pes;
    const reference = demux(
      await readFile(path.join(root, 'audio-64', name)),
    ).filter((p) => p.type === 0x0f);
    assert.deepEqual(
      Buffer.from(packets[0].data),
      Buffer.concat(reference.map((p) => p.data)),
    );
    epoch ??= reference[0].pts;
    const timestamp =
      mode === 'rollover'
        ? (reference[0].pts + 2 ** 33 - 90000 - epoch) % 2 ** 33
        : reference[0].pts;
    assert.equal(packets[0].pts, timestamp);
    const remux = decoder.transmuxPes(packets, 2);
    assert.ok(remux.start > previous);
    previous = remux.start;
    assert.equal(remux.tracks[0].codec, 'mp4a.40.2');
    assert.equal(parsed.metadata.length, 2);
  }
  console.log(
    'PASS packed AAC byte-exact ADTS payloads, anchors and monotonic remux',
    mode,
    files.length,
  );
}
