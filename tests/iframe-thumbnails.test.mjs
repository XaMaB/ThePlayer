import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv } from 'node:crypto';
import { build } from 'esbuild';
const result = await build({
  stdin: {
    contents:
      "export * from './src/engines/hls/iframe-thumbnails';export * from './src/engines/hls/playlist';export * from './src/engines/hls/sample-aes';export * from './src/engines/hls/preview-frame';",
    resolveDir: new URL('..', import.meta.url).pathname,
  },
  bundle: true,
  write: false,
  format: 'esm',
});
const { parsePlaylist, widenedCbcRange, decryptCbcBlocks, av1HasSequence } =
  await import(
    'data:text/javascript;base64,' +
      Buffer.from(result.outputFiles[0].text).toString('base64')
  );
const base = 'https://example.com/master.m3u8';
test('I-frame renditions remain separate from normal ABR qualities', () => {
  const p = parsePlaylist(
    '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100000\nvideo.m3u8\n#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=10000,URI="iframes.m3u8",RESOLUTION=320x180\n',
    base,
  );
  assert.equal(p.variants.length, 1);
  assert.equal(p.iframes.length, 1);
  assert.equal(p.iframes[0].url, 'https://example.com/iframes.m3u8');
  for (const attribute of [
    'AUDIO="group"',
    'SUBTITLES="group"',
    'CLOSED-CAPTIONS=NONE',
    'FRAME-RATE=25',
  ])
    assert.equal(
      parsePlaylist(
        '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100000\nvideo.m3u8\n#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=10000,URI="x",' +
          attribute,
        base,
      ).iframes.length,
      1,
    );
  assert.throws(
    () =>
      parsePlaylist(
        '#EXTM3U\n#EXT-X-I-FRAMES-ONLY\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nf.ts',
        base,
      ),
    /version/i,
  );
});
test('Widened encrypted I-frame ranges recover exact bytes across CBC boundaries', async () => {
  const rawKey = Buffer.alloc(16, 0x38),
    iv = Buffer.alloc(16, 0x19),
    plain = Buffer.from(Array.from({ length: 512 }, (_, i) => i % 251));
  const cipher = createCipheriv('aes-128-cbc', rawKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const key = await crypto.subtle.importKey('raw', rawKey, 'AES-CBC', false, [
    'encrypt',
    'decrypt',
  ]);
  for (const offset of [0, 1, 15, 16, 17, 31, 32, 113, 255])
    for (const length of [1, 15, 16, 17, 47, 129]) {
      const r = widenedCbcRange(offset, length),
        data = ciphertext.subarray(r.offset, r.offset + r.length);
      const decoded = await decryptCbcBlocks(
        data.subarray(r.prefix),
        key,
        r.prefix ? data.subarray(0, 16) : iv,
      );
      assert.deepEqual(
        Buffer.from(decoded.subarray(r.skip, r.skip + length)),
        plain.subarray(offset, offset + length),
        `${offset}:${length}`,
      );
    }
  for (const [offset, length] of [
    [-1, 1],
    [0, 0],
    [0, Infinity],
    [NaN, 1],
    [Number.MAX_SAFE_INTEGER, 2],
  ])
    assert.throws(() => widenedCbcRange(offset, length), /Invalid/);
});
test('AV1 preview sequence-header detection rejects malformed OBU lengths', () => {
  assert.equal(av1HasSequence(Uint8Array.of(0x12, 0)), false);
  assert.equal(av1HasSequence(Uint8Array.of(0x12, 0, 0x0a, 1, 0)), true);
  for (const bytes of [[0x80], [0x0a, 0x80], [0x0a, 4, 0], [0x0c]])
    assert.throws(() => av1HasSequence(Uint8Array.from(bytes)));
});
