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
const { emsgMetadata, filterEmsg } = await module('metadata'),
  { box, boxes, u32, concat } = await module('mp4');
const str = (s) => new TextEncoder().encode(s + '\0');
const v0 = (scale = 1000) =>
  box(
    'emsg',
    new Uint8Array(4),
    str('urn:test'),
    str('v'),
    u32(scale),
    u32(500),
    u32(2000),
    u32(7),
    Uint8Array.of(1, 2, 3),
  );
const v1 = (high = 0, low = 90000) =>
  box(
    'emsg',
    Uint8Array.of(1, 0, 0, 0),
    u32(90000),
    u32(high),
    u32(low),
    u32(0xffffffff),
    u32(4),
    str('urn:test'),
    str(''),
    Uint8Array.of(9),
  );
test('emsg v0 uses earliest presentation time, while v1 is absolute and independent of lazy anchor', () => {
  const event = emsgMetadata(v0(), 12)[0];
  assert.equal(event.time, 12.5);
  assert.equal(event.duration, 2);
  assert.equal(event.id, 7);
  assert.equal(event.scheme, 'urn:test');
  assert.deepEqual(event.data, Uint8Array.of(1, 2, 3));
  const absolute = emsgMetadata(v1(), () => {
    throw Error('Unused anchor');
  })[0];
  assert.equal(absolute.time, 1);
  assert.equal(absolute.duration, undefined);
});
test('emsg validates timescale, large integer bounds and string terminators', () => {
  assert.throws(() => emsgMetadata(v0(0), 0), /timescale/);
  assert.throws(() => emsgMetadata(v1(0x200000, 0), 0), /Unsafe/);
  const malformed = box('emsg', Uint8Array.of(0, 0, 0, 0, 65, 65));
  assert.throws(() => emsgMetadata(malformed, 0), /Unterminated/);
});
test('metadata neutralization preserves every box offset and all media payload bytes', () => {
  const source = concat(
    v0(),
    box('moof', box('mfhd', new Uint8Array(8)), v1()),
    box('mdat', Uint8Array.of(4, 5, 6)),
  );
  const filtered = filterEmsg(source);
  assert.equal(filtered.length, source.length);
  assert.equal(boxes(source)[0].type, 'emsg');
  assert.deepEqual(
    boxes(filtered).map((b) => [b.at, b.body.length]),
    boxes(source).map((b) => [b.at, b.body.length]),
  );
  assert.equal(boxes(filtered)[0].type, 'free');
  assert.equal(boxes(boxes(filtered)[1].body)[1].type, 'free');
  assert.deepEqual(boxes(filtered)[2].body, Uint8Array.of(4, 5, 6));
});
