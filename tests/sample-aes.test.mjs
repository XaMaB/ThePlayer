import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv } from 'node:crypto';
import { build } from 'esbuild';
const result = await build({
  entryPoints: [
    new URL('../src/engines/hls/sample-aes.ts', import.meta.url).pathname,
  ],
  bundle: true,
  write: false,
  format: 'esm',
});
const {
  decryptCbcBlocks,
  decryptAvcSample,
  decryptAacSamples,
  decryptSamplePes,
} = await import(
  'data:text/javascript;base64,' +
    Buffer.from(result.outputFiles[0].text).toString('base64')
);
const rawKey = Buffer.alloc(16, 0x39),
  iv = Buffer.alloc(16, 0x25);
const key = await crypto.subtle.importKey('raw', rawKey, 'AES-CBC', false, [
  'encrypt',
  'decrypt',
]);
const cbc = (bytes) => {
  const cipher = createCipheriv('aes-128-cbc', rawKey, iv);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(bytes), cipher.final()]);
};
const escape = (bytes) => {
  const out = [];
  let zeros = 0;
  for (const value of bytes) {
    if (zeros >= 2 && value <= 3) {
      out.push(3);
      zeros = 0;
    }
    out.push(value);
    zeros = value === 0 ? zeros + 1 : 0;
  }
  return Uint8Array.from(out);
};
const encryptedAvc = (plain) => {
  if (plain.length <= 48) return plain.slice();
  const data = plain.slice(),
    positions = [];
  for (let i = 32; i + 16 < data.length; i += 160) positions.push(i);
  const encrypted = cbc(
    Buffer.concat(positions.map((i) => data.subarray(i, i + 16))),
  );
  positions.forEach((at, i) =>
    data.set(encrypted.subarray(i * 16, i * 16 + 16), at),
  );
  return escape(data);
};
const aac = (payloadLength, crc = false) => {
  const length = payloadLength + (crc ? 9 : 7),
    data = Buffer.alloc(length, 0x42);
  data.set([
    0xff,
    crc ? 0xf0 : 0xf1,
    0x50,
    0x80 | (length >>> 11),
    (length >>> 3) & 255,
    ((length & 7) << 5) | 31,
    0xfc,
  ]);
  return data;
};
const encryptedAac = (plain) => {
  const data = plain.slice(),
    start = (data[1] & 1 ? 7 : 9) + 16,
    end = start + Math.max(0, Math.floor((data.length - start) / 16)) * 16;
  if (end > start) data.set(cbc(data.subarray(start, end)), start);
  return data;
};
test('unpadded CBC retains every byte, including plaintext that resembles PKCS#7 padding', async () => {
  for (const value of [0, 1, 16, 255]) {
    const bytes = Buffer.alloc(64, value);
    assert.deepEqual(
      Buffer.from(await decryptCbcBlocks(cbc(bytes), key, iv)),
      bytes,
    );
  }
  await assert.rejects(decryptCbcBlocks(new Uint8Array(17), key, iv), /bounds/);
});
test('SAMPLE-AES AVC respects 32-byte leader, strict final-block rule, skip pattern and outer escaping', async () => {
  for (const length of [48, 49, 192, 193, 208, 209, 501]) {
    const plain = Uint8Array.from({ length }, (_, i) =>
      i ? ((37 * i) % 255) + 1 : 0x65,
    );
    plain.set([0, 0, 3, 1], 8);
    assert.deepEqual(
      await decryptAvcSample(encryptedAvc(plain), key, iv),
      plain,
      `NAL length ${length}`,
    );
  }
  const sei = Uint8Array.of(6, ...Array(100).fill(42));
  assert.deepEqual(await decryptAvcSample(sei, key, iv), sei);
});
test('SAMPLE-AES AAC resets CBC per frame, supports CRC headers and leaves partial tails clear', async () => {
  const frames = [aac(15), aac(16), aac(32), aac(67, true)],
    plain = Buffer.concat(frames);
  assert.deepEqual(
    Buffer.from(
      await decryptAacSamples(Buffer.concat(frames.map(encryptedAac)), key, iv),
    ),
    plain,
  );
  await assert.rejects(
    decryptAacSamples(plain.subarray(0, -1), key, iv),
    /Truncated/,
  );
});
test('sample decryption spans PES boundaries without losing timestamps or original escaped AVC bytes', async () => {
  const nal = Uint8Array.from({ length: 501 }, (_, i) =>
    i ? ((37 * i) % 255) + 1 : 0x65,
  );
  nal.set([0, 0, 3, 1], 8);
  const video = Buffer.concat([Buffer.from([0, 0, 0, 1]), encryptedAvc(nal)]),
    audio = encryptedAac(aac(67, true));
  const pes = [
    { type: 0xdb, data: video.subarray(0, 70), pts: 90000, dts: 90000 },
    { type: 0xcf, data: audio.subarray(0, 30), pts: 90000, dts: 90000 },
    { type: 0xdb, data: video.subarray(70), pts: 93600, dts: 93600 },
    { type: 0xcf, data: audio.subarray(30), pts: 91920, dts: 91920 },
  ];
  const clear = await decryptSamplePes(pes, key, iv);
  assert.deepEqual(
    clear.map((p) => [p.pts, p.dts]),
    pes.map((p) => [p.pts, p.dts]),
  );
  assert.deepEqual(
    Buffer.concat(clear.filter((p) => p.type === 0x1b).map((p) => p.data)),
    Buffer.concat([Buffer.from([0, 0, 0, 1]), nal]),
  );
  assert.deepEqual(
    Buffer.concat(clear.filter((p) => p.type === 0x0f).map((p) => p.data)),
    aac(67, true),
  );
  assert.equal(pes[0].type, 0xdb);
});
