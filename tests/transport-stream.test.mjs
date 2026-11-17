import { test } from 'node:test';
import assert from 'node:assert/strict';
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
const { demux } = await module('transport-stream'),
  { psiCrc } = await module('psi');
function section(bytes) {
  const result = Uint8Array.from([...bytes, 0, 0, 0, 0]);
  const size = result.length - 3;
  result[1] = 0xb0 | (size >>> 8);
  result[2] = size & 255;
  new DataView(result.buffer).setUint32(
    result.length - 4,
    psiCrc(result.subarray(0, -4)),
  );
  return result;
}
function packet(pid, table) {
  const p = new Uint8Array(188).fill(255);
  p.set([0x47, 0x40 | (pid >>> 8), pid & 255, 0x10, 0]);
  p.set(table, 5);
  return p;
}
function stream(types) {
  const pat = packet(0, section([0, 0, 0, 0, 1, 0xc1, 0, 0, 0, 1, 0xf0, 0]));
  const pmt = packet(
    4096,
    section([
      2,
      0,
      0,
      0,
      1,
      0xc1,
      0,
      0,
      0xe1,
      0,
      0xf0,
      0,
      ...types.flatMap((type, i) => [type, 0xe1, i, 0xf0, 0]),
    ]),
  );
  return Uint8Array.from([...pat, ...pmt]);
}
test('TS rejects unsupported encrypted audio instead of silently dropping it', () => {
  for (const type of [0xc2])
    assert.throws(
      () => demux(stream([0x1b, type])),
      /AVC\/HEVC\/AAC\/AC-3 only/,
    );
});
test('TS rejects multiple video/audio streams even with mixed clear/encrypted stream types', () => {
  for (const types of [
    [0x1b, 0xdb],
    [0x0f, 0xcf],
    [0x1b, 0x24],
  ])
    assert.throws(() => demux(stream(types)), /Multiple same-kind/);
});
