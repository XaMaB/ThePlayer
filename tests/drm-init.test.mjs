import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const output = await build({
  entryPoints: [
    new URL('../src/engines/hls/drm-init.ts', import.meta.url).pathname,
  ],
  bundle: true,
  write: false,
  format: 'esm',
});
const { playlistInitData } = await import(
  'data:text/javascript;base64,' +
    Buffer.from(output.outputFiles[0].text).toString('base64')
);
const system = 'com.widevine.alpha';
const format = 'urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed';
function pssh(version = 0) {
  const b = Buffer.alloc(version ? 55 : 35);
  b.writeUInt32BE(b.length);
  b.write('pssh', 4);
  b[8] = version;
  Buffer.from('edef8ba979d64acea3c827dcd51d21ed', 'hex').copy(b, 12);
  if (version) {
    b.writeUInt32BE(1, 28);
    b.fill(0x39, 32, 48);
  }
  b.writeUInt32BE(3, b.length - 7);
  b.set([0x08, 0x01, 0x00], b.length - 3);
  return b;
}
const key = (bytes) => ({
  method: 'SAMPLE-AES',
  format,
  url: 'data:text/plain;base64,' + bytes.toString('base64'),
});
test('Playlist PSSH preserves v0/v1 and concatenated initialization bytes', () => {
  for (const bytes of [pssh(), pssh(1), Buffer.concat([pssh(), pssh(1)])])
    assert.deepEqual(
      Buffer.from(playlistInitData([key(bytes)], system)),
      bytes,
    );
  assert.equal(playlistInitData([key(pssh())], 'org.w3.clearkey'), undefined);
  assert.equal(
    playlistInitData([{ ...key(pssh()), versions: [2] }], system),
    undefined,
  );
  assert.equal(
    playlistInitData(
      [{ ...key(pssh()), format: 'com.apple.streamingkeydelivery' }],
      system,
    ),
    undefined,
  );
});
test('Playlist PSSH rejects malformed framing, system, encoding and resource sizes', () => {
  const malformed = [Buffer.alloc(0), pssh().subarray(0, 30)];
  for (const [offset, value] of [
    [0, 255],
    [4, 0],
    [8, 2],
    [11, 1],
    [12, 0],
    [31, 255],
  ]) {
    const bytes = pssh();
    bytes[offset] = value;
    malformed.push(bytes);
  }
  const count = pssh(1);
  count.writeUInt32BE(0xffffffff, 28);
  malformed.push(count);
  for (const bytes of malformed)
    assert.throws(() => playlistInitData([key(bytes)], system));
  for (const url of [
    'https://example.com/key',
    'data:text/plain;base64,!!',
    'data:text/plain;base64,%XX',
    'data:;base64,' + 'A'.repeat(90000),
  ])
    assert.throws(() => playlistInitData([{ ...key(pssh()), url }], system));
});
