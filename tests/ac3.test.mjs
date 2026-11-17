import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv } from 'node:crypto';
import { build } from 'esbuild';
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
const { ac3Header, ac3Samples } = await module('ac3');
const { decryptAc3Samples } = await module('sample-aes');
const header = (rate, code, bsid = 8, acmod = 2) =>
  Uint8Array.of(11, 119, 0, 0, (rate << 6) | code, bsid << 3, acmod << 5, 0);
test('AC-3 standard frame-size table, half rates and 44.1 kHz alternation', () => {
  for (const [rate, code, size, hz] of [
    [0, 0, 128, 48000],
    [1, 0, 138, 44100],
    [1, 1, 140, 44100],
    [2, 0, 192, 32000],
    [0, 36, 2560, 48000],
    [1, 36, 2786, 44100],
    [1, 37, 2788, 44100],
    [2, 36, 3840, 32000],
  ]) {
    const actual = ac3Header(header(rate, code));
    assert.equal(actual.size, size);
    assert.equal(actual.rate, hz);
    assert.equal(actual.channels, 2);
  }
  assert.equal(ac3Header(header(0, 0, 9)).rate, 24000);
  assert.equal(ac3Header(header(0, 0, 10)).rate, 12000);
  const surround = header(0, 0, 8, 7);
  surround[6] |= 1;
  assert.equal(ac3Header(surround).channels, 6);
});
test('AC-3 rejects reserved headers, truncated frames and configuration changes', () => {
  for (const data of [
    header(3, 0),
    header(0, 38),
    header(0, 0, 16),
    new Uint8Array(6),
  ])
    assert.throws(() => ac3Header(data), /AC-3/);
  const first = new Uint8Array(128);
  first.set(header(0, 0));
  assert.equal(ac3Samples(first).samples[0].duration, 1536);
  assert.throws(() => ac3Samples(first.subarray(0, 127)), /Incomplete/);
  const second = first.slice();
  second[6] = 1 << 5;
  assert.throws(
    () => ac3Samples(Uint8Array.from([...first, ...second])),
    /configuration changed/,
  );
});
test('SAMPLE-AES AC-3 resets CBC each frame and preserves the clear tail', async () => {
  const raw = Buffer.alloc(16, 0x91),
    iv = Buffer.alloc(16, 0x37);
  const key = await crypto.subtle.importKey('raw', raw, 'AES-CBC', false, [
    'encrypt',
    'decrypt',
  ]);
  const frames = [0, 1].map((code) => {
    const h = header(1, code),
      data = Buffer.alloc(ac3Header(h).size, 0x11);
    data.set(h);
    return data;
  });
  const encrypted = frames.map((data) => {
    const result = Buffer.from(data),
      end = 16 + Math.floor((data.length - 16) / 16) * 16;
    const c = createCipheriv('aes-128-cbc', raw, iv);
    c.setAutoPadding(false);
    Buffer.concat([c.update(data.subarray(16, end)), c.final()]).copy(
      result,
      16,
    );
    return result;
  });
  assert.deepEqual(
    Buffer.from(await decryptAc3Samples(Buffer.concat(encrypted), key, iv)),
    Buffer.concat(frames),
  );
  await assert.rejects(
    decryptAc3Samples(encrypted[0].subarray(0, 100), key, iv),
    /Truncated/,
  );
});
