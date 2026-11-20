import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { withVideoTerminator } from './helpers/video-sample-terminator.mjs';
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
const {
  initialization,
  inspectInit,
  boxes,
  box,
  concat,
  videoSampleEntryBoxes,
} = await module('mp4');
const { fragmentMetadata } = await module('fragment-samples');
const { previewConfiguration } = await module('preview-frame');
const { normalizeVideoSampleEntries } = await module('sample-entry');
const hvcc = new Uint8Array(23);
hvcc[0] = 1;
hvcc[1] = 2;
hvcc[5] = 4;
hvcc[6] = 0xb0;
hvcc[12] = 123;
hvcc[21] = 3;
for (const hevc of [false, true]) {
  const init = initialization([
    {
      id: 1,
      kind: 'video',
      timescale: 90000,
      codec: hevc ? 'hvc1.2.20000000.L123.B0' : 'avc1.64001f',
      width: 320,
      height: 180,
      sps: Uint8Array.of(0x67, 0x64, 0, 0x1f),
      pps: Uint8Array.of(0x68, 0),
      ...(hevc ? { hvcc } : {}),
    },
  ]);
  test(`${hevc ? 'HEVC' : 'AVC'} video terminator preserves codec, captions and preview configuration`, () => {
    const padded = withVideoTerminator(init),
      original = padded.slice();
    assert.deepEqual(inspectInit(padded), inspectInit(init));
    assert.deepEqual(fragmentMetadata(padded), fragmentMetadata(init));
    assert.deepEqual(previewConfiguration(padded), previewConfiguration(init));
    assert.equal(fragmentMetadata(padded)[0].nalLength, 4);
    assert.deepEqual(padded, original);
    assert.deepEqual(normalizeVideoSampleEntries(padded), init);
    assert.equal(normalizeVideoSampleEntries(init), init);
    for (const suffix of [
      Uint8Array.of(0),
      new Uint8Array(3),
      new Uint8Array(5),
      new Uint8Array(8),
      Uint8Array.of(0, 0, 0, 1),
    ]) {
      const malformed = withVideoTerminator(init, suffix);
      assert.throws(() => inspectInit(malformed), /MP4/);
      assert.throws(() => fragmentMetadata(malformed), /MP4/);
      assert.throws(() => previewConfiguration(malformed), /MP4/);
      assert.throws(() => normalizeVideoSampleEntries(malformed), /MP4/);
    }
  });
}
test('terminator is allowed only at a visual-extension box boundary', () => {
  const payload = box('free', new Uint8Array(4));
  const body = concat(new Uint8Array(78), payload);
  assert.equal(
    videoSampleEntryBoxes(body)[0].body.length,
    4,
    'zero box payload is retained',
  );
  assert.equal(
    videoSampleEntryBoxes(concat(body, new Uint8Array(4))).length,
    1,
  );
  assert.throws(
    () => boxes(concat(payload, new Uint8Array(4))),
    /Truncated MP4 header/,
    'general boxes remain strict',
  );
  assert.throws(
    () => videoSampleEntryBoxes(new Uint8Array(77)),
    /Truncated video/,
  );
  assert.throws(
    () =>
      videoSampleEntryBoxes(
        concat(
          new Uint8Array(78),
          Uint8Array.of(0, 0, 0, 32, 104, 118, 99, 67),
          new Uint8Array(4),
        ),
      ),
    /Invalid MP4 box/,
    'truncated box payload is not padding',
  );
});
