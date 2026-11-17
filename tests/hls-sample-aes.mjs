import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
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
  });
  return import(
    'data:text/javascript;base64,' +
      Buffer.from(result.outputFiles[0].text).toString('base64')
  );
}
const { demux, TsTransmuxer } = await module('transport-stream');
const { decryptSamplePes } = await module('sample-aes');
for (const mode of ['explicit', 'sequence']) {
  const playlist = await readFile(
    path.join(root, 'sample-aes-' + mode, 'index.m3u8'),
    'utf8',
  );
  const files = playlist.split('\n').filter((l) => l.endsWith('.ts'));
  const referenceMux = new TsTransmuxer(),
    decryptedMux = new TsTransmuxer();
  for (const [sequence, name] of files.entries()) {
    const original = demux(await readFile(path.join(root, 'ts', name)));
    const encrypted = demux(
      await readFile(path.join(root, 'sample-aes-' + mode, name)),
    );
    assert.ok(encrypted.some((p) => p.type === 0xdb));
    assert.ok(encrypted.some((p) => p.type === 0xcf));
    const raw = await readFile(
      path.join(root, 'sample-aes-' + mode, `key${sequence % 2}.bin`),
    );
    const key = await crypto.subtle.importKey('raw', raw, 'AES-CBC', false, [
      'encrypt',
      'decrypt',
    ]);
    const iv = new Uint8Array(16);
    new DataView(iv.buffer).setUint32(
      12,
      mode === 'explicit' ? sequence + 100 : sequence,
    );
    const decoded = await decryptSamplePes(encrypted, key, iv);
    assert.deepEqual(
      decoded,
      original,
      `${mode}/${name}: elementary bytes and timestamps`,
    );
    const expected = referenceMux.transmuxPes(original, 2),
      actual = decryptedMux.transmuxPes(decoded, 2);
    assert.deepEqual(actual, expected, `${mode}/${name}: remux output`);
  }
  console.log(
    'PASS SAMPLE-AES byte-exact elementary data, timing and remux',
    mode,
    files.length,
    'segments',
  );
}
