import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
async function load(name) {
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
const { captionDistributionPacket, extract708 } = await load('c708-mp4');
const { fragmentMetadata } = await load('fragment-samples');
const { initialization, boxes, box, fragment } = await load('mp4');
const checksum = (data) => {
  data[data.length - 1] = 0;
  data[data.length - 1] = (256 - (data.reduce((a, b) => a + b, 0) % 256)) % 256;
  return data;
};
const cdp = (extra = []) => {
  const bytes = Uint8Array.from([
    0x96,
    0x69,
    0,
    0x3f,
    0x43,
    0,
    7,
    0x72,
    0xe2,
    0xff,
    2,
    0x21,
    0xfe,
    65,
    0,
    ...extra,
    0x74,
    0,
    7,
    0,
  ]);
  bytes[2] = bytes.length;
  return checksum(bytes);
};
test('CDP validates framing, checksum, section flags and sequence before yielding caption bytes', () => {
  const data = cdp([0x75, 2, 0x74, 0]);
  assert.deepEqual(captionDistributionPacket(data, 2).packets, [
    { time: 2, type: 3, first: 2, second: 0x21 },
    { time: 2, type: 2, first: 65, second: 0 },
  ]);
  assert.equal(captionDistributionPacket(data, 2).duration, 0.04);
  const damaged = data.slice();
  damaged[11] ^= 1;
  assert.throws(() => captionDistributionPacket(damaged, 0), /checksum/);
  const sequence = data.slice();
  sequence[sequence.length - 2] = 8;
  checksum(sequence);
  assert.throws(() => captionDistributionPacket(sequence, 0), /sequence/);
  const flags = data.slice();
  flags[4] |= 128;
  checksum(flags);
  assert.throws(() => captionDistributionPacket(flags, 0), /flags/);
  const marker = data.slice();
  marker[9] = 3;
  checksum(marker);
  assert.throws(() => captionDistributionPacket(marker, 0), /marker/);
  const truncated = data.slice();
  truncated[8] = 0xff;
  checksum(truncated);
  assert.throws(() => captionDistributionPacket(truncated, 0), /Truncated/);
});
test('c708 ccdp samples use presentation time and CDP cadence with checked MP4 bounds', () => {
  const track = {
    id: 99,
    kind: 'audio',
    timescale: 1000,
    codec: 'mp4a.40.2',
    channels: 2,
    asc: Uint8Array.of(0x11, 0x90),
  };
  const init = initialization([track]);
  const child = (data, name) => boxes(data).find((b) => b.type === name).body;
  const mdia = child(child(child(init, 'moov'), 'trak'), 'mdia');
  child(mdia, 'hdlr').set(new TextEncoder().encode('clcp'), 8);
  const entry = boxes(
    child(child(child(mdia, 'minf'), 'stbl'), 'stsd').subarray(8),
  )[0];
  init.set(
    new TextEncoder().encode('c708'),
    entry.body.byteOffset - init.byteOffset - 4,
  );
  const meta = fragmentMetadata(init),
    sample = {
      data: box('ccdp', cdp(), cdp()),
      duration: 80,
      cts: -1000,
      key: true,
    };
  const media = fragment(track, [sample], 6000, 1);
  assert.deepEqual(
    extract708(media, meta).map((p) => p.time),
    [5, 5, 5.04, 5.04],
  );
  assert.throws(
    () =>
      extract708(fragment(track, [{ ...sample, duration: 20 }], 6000, 1), meta),
    /cadence/,
  );
  const run = child(child(child(media, 'moof'), 'traf'), 'trun');
  new DataView(run.buffer, run.byteOffset, run.byteLength).setInt32(8, 0);
  assert.throws(() => extract708(media, meta), /bounds/);
});
