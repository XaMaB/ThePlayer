import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv } from 'node:crypto';
import { build } from 'esbuild';
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
const { eac3Header, eac3Samples } = await module('eac3'),
  { decryptEac3Samples } = await module('sample-aes');
function frame(blockCode = 0, rateCode = 0, type = 0) {
  const b = Buffer.alloc(128, 0x31);
  b.fill(0, 0, 16);
  b.set([
    11,
    119,
    type << 6,
    63,
    (rateCode << 6) | (blockCode << 4) | 4,
    16 << 3,
  ]);
  return b;
}
test('E-AC-3 packs one, two, three or six-block syncframes into 1536-sample MP4 samples', () => {
  for (const [code, count] of [
    [0, 6],
    [1, 3],
    [2, 2],
    [3, 1],
  ]) {
    const f = frame(code),
      r = eac3Samples(Buffer.concat(Array(count * 2).fill(f)));
    assert.equal(r.samples.length, 2);
    assert.equal(r.samples[0].duration, 1536);
    assert.equal(r.samples[0].data.length, count * 128);
    assert.equal(r.track.codec, 'ec-3');
    assert.equal(r.track.dec3.length, 5);
    assert.equal(r.track.timescale, 48000);
  }
  assert.equal(eac3Header(frame(0, 3)).rate, 24000);
  assert.equal(eac3Header(frame(0, 3)).blocks, 6);
});
test('E-AC-3 rejects incomplete groups, reserved syntax and unimplemented substreams', () => {
  assert.throws(() => eac3Samples(frame()), /six-block/);
  assert.throws(
    () => eac3Samples(Buffer.concat([frame(3), frame(0)])),
    /six-block/,
  );
  assert.throws(() => eac3Samples(frame(3, 0, 1)), /substreams/);
  assert.throws(() => eac3Header(frame(3, 0, 3)), /header/);
  assert.throws(() => eac3Header(frame(3, 3)), /header/);
  assert.throws(() => eac3Samples(frame(3).subarray(0, 60)), /Incomplete/);
});
test('E-AC-3 SAMPLE-AES chains across short syncframes and resets at the audio sample', async () => {
  const raw = Buffer.alloc(16, 0x29),
    iv = Buffer.alloc(16, 0x75),
    key = await crypto.subtle.importKey('raw', raw, 'AES-CBC', false, [
      'encrypt',
      'decrypt',
    ]);
  const original = Array.from({ length: 12 }, () => frame()),
    encrypted = original.map((b) => Buffer.from(b));
  for (let at = 0; at < 12; at += 6) {
    const cipher = createCipheriv('aes-128-cbc', raw, iv);
    cipher.setAutoPadding(false);
    const bytes = Buffer.concat([
      cipher.update(
        Buffer.concat(original.slice(at, at + 6).map((b) => b.subarray(16))),
      ),
      cipher.final(),
    ]);
    for (let i = 0; i < 6; i++)
      bytes.copy(encrypted[at + i], 16, i * 112, (i + 1) * 112);
  }
  assert.deepEqual(
    Buffer.from(await decryptEac3Samples(Buffer.concat(encrypted), key, iv)),
    Buffer.concat(original),
  );
  await assert.rejects(decryptEac3Samples(encrypted[0], key, iv), /Incomplete/);
});
