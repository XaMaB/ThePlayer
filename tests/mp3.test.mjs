import { test } from 'node:test';
import assert from 'node:assert/strict';
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
const { mp3Header } = await module('mp3'),
  { initialization, inspectInit } = await module('mp4'),
  { browserVariants, normalizeCodec } = await module('renditions');
test('MPEG Layer III frame lengths and sample clocks cover versions 1, 2 and 2.5', () => {
  const one = mp3Header(Uint8Array.of(255, 251, 0x90, 0));
  assert.equal(one.rate, 44100);
  assert.equal(one.bitrate, 128000);
  assert.equal(one.size, 417);
  assert.equal(one.samples, 1152);
  assert.equal(one.channels, 2);
  assert.equal(mp3Header(Uint8Array.of(255, 250, 0x92, 0xc0)).size, 418);
  const two = mp3Header(Uint8Array.of(255, 243, 0x80, 0xc0));
  assert.equal(two.rate, 22050);
  assert.equal(two.size, 208);
  assert.equal(two.samples, 576);
  assert.equal(two.channels, 1);
  const low = mp3Header(Uint8Array.of(255, 227, 0x40, 0));
  assert.equal(low.rate, 11025);
  assert.equal(low.size, 208);
});
test('MPEG headers reject free-format, reserved version/rate/layer and truncation', () => {
  for (const bytes of [
    [255, 251, 0, 0],
    [255, 235, 0x90, 0],
    [255, 251, 0x9c, 0],
    [255, 253, 0x90, 0],
    [255, 251, 0x90],
  ])
    assert.throws(() => mp3Header(Uint8Array.from(bytes)), /MPEG/);
});
test('MP3 fMP4 uses an MPEG audio descriptor without an AAC configuration', () => {
  for (const audioObjectType of [0x69, 0x6b]) {
    const track = {
      id: 2,
      kind: 'audio',
      timescale: 44100,
      channels: 2,
      codec: 'mp3',
      audioObjectType,
    };
    const parsed = inspectInit(initialization([track]))[0];
    assert.equal(parsed.codec, 'mp3');
    assert.equal(parsed.kind, 'audio');
  }
});
test('MP3 variant selection accepts raw-MPEG or MP4 capability and rejects neither-supported browsers', () => {
  const variants = [
    { url: 'https://example.test/a.m3u8', bandwidth: 64000, codecs: 'mp4a.6B' },
  ];
  assert.equal(normalizeCodec('mp4a.69'), 'mp3');
  assert.equal(browserVariants(variants, (m) => m === 'audio/mpeg').length, 1);
  assert.equal(
    browserVariants(variants, (m) => m === 'audio/mp4; codecs="mp3"').length,
    1,
  );
  assert.equal(browserVariants(variants, () => false).length, 0);
});
