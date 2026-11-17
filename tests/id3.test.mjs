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
const { parseId3 } = await module('id3'),
  { packedAac } = await module('packed-audio');
const ss = (n) =>
  Buffer.from([(n >>> 21) & 127, (n >>> 14) & 127, (n >>> 7) & 127, n & 127]);
const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
const frame = (id, data, version = 4, flags = 0) =>
  Buffer.concat([
    Buffer.from(id),
    version === 4 ? ss(data.length) : u32(data.length),
    Buffer.from([0, flags]),
    data,
  ]);
const tag = (frames, version = 4, flags = 0) => {
  const body = Buffer.concat(frames),
    head = Buffer.concat([
      Buffer.from([73, 68, 51, version, 0, flags]),
      ss(body.length),
    ]);
  return Buffer.concat([
    head,
    body,
    ...(flags & 16
      ? [Buffer.concat([Buffer.from('3DI'), head.subarray(3)])]
      : []),
  ]);
};
const timestamp = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n));
  return Buffer.concat([
    Buffer.from('com.apple.streaming.transportStreamTimestamp\0'),
    b,
  ]);
};
const aac = Buffer.from([255, 241, 0x50, 0x80, 1, 0x3f, 0xfc, 42, 42]);
test('ID3 v2.3/v2.4 extracts the exact 33-bit anchor, text and private bytes', () => {
  for (const version of [3, 4]) {
    const bytes = tag(
      [
        frame('PRIV', timestamp(2 ** 33 - 1), version),
        frame('TIT2', Buffer.from([0, 0x80, 0x41]), version),
        frame('TXXX', Buffer.from([3, ...Buffer.from('name\0Ж中')]), version),
      ],
      version,
    );
    const result = parseId3(bytes);
    assert.equal(result.consumed, bytes.length);
    assert.equal(result.timestamp, 2 ** 33 - 1);
    assert.equal(result.frames[1].text, '\x80A');
    assert.equal(result.frames[2].text, 'Ж中');
    assert.equal(result.frames[2].description, 'name');
  }
});
test('ID3 v2.4 unsynchronization and footer are bounded and validated', () => {
  const bytes = tag(
    [frame('PRIV', Buffer.from([120, 0, 255, 0, 224]), 4, 2)],
    4,
    16,
  );
  assert.deepEqual(parseId3(bytes).frames[0].data, Uint8Array.of(255, 224));
  const bad = Buffer.from(bytes);
  bad[bad.length - 10] = 0;
  assert.throws(() => parseId3(bad), /footer/);
  assert.throws(() => parseId3(bytes.subarray(0, -1)), /Truncated/);
  const invalid = tag([frame('PRIV', timestamp(2 ** 33))]);
  assert.throws(() => parseId3(invalid), /33 bits/);
});
test('packed AAC removes interleaved ID3 while preserving sample bytes and timing', () => {
  const initial = tag([frame('PRIV', timestamp(90000))]),
    middle = tag([frame('TIT2', Buffer.from([3, ...Buffer.from('second')]))]);
  const parsed = packedAac(Buffer.concat([initial, aac, middle, aac]));
  assert.equal(parsed.pes[0].pts, 90000);
  assert.deepEqual(Buffer.from(parsed.pes[0].data), Buffer.concat([aac, aac]));
  assert.equal(parsed.metadata[1].time, 1 + 1024 / 44100);
  assert.throws(
    () => packedAac(Buffer.concat([middle, aac])),
    /leading ID3 timestamp/,
  );
  assert.throws(
    () => packedAac(Buffer.concat([initial, aac.subarray(0, -1)])),
    /Invalid packed AAC/,
  );
});

test('UTF-16 user text inherits a big-endian description BOM for its value', () => {
  const bytes = tag(
    [frame('TXXX', Buffer.from([1, 254, 255, 0, 68, 0, 0, 4, 22]), 3)],
    3,
  );
  const item = parseId3(bytes).frames[0];
  assert.equal(item.description, 'D');
  assert.equal(item.text, 'Ж');
});
