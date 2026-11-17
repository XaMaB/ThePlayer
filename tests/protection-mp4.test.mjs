import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const built = await build({
  entryPoints: [new URL('../src/engines/hls/mp4.ts', import.meta.url).pathname],
  bundle: true,
  write: false,
  format: 'esm',
});
const { initialization, inspectInit, boxes, box, concat, u32 } = await import(
  'data:text/javascript;base64,' +
    Buffer.from(built.outputFiles[0].text).toString('base64')
);
const ascii = (s) => new TextEncoder().encode(s);
const clear = initialization([
  {
    id: 2,
    kind: 'audio',
    timescale: 48000,
    channels: 2,
    codec: 'mp4a.40.2',
    asc: Uint8Array.of(0x11, 0x90),
  },
]);
function protect(scheme = 'cenc', ivSize = 16, constant) {
  const rewrite = (data) =>
    concat(
      ...boxes(data).map((b) => {
        if (['moov', 'trak', 'mdia', 'minf', 'stbl'].includes(b.type))
          return box(b.type, rewrite(b.body));
        if (b.type !== 'stsd') return box(b.type, b.body);
        const entry = boxes(b.body.subarray(8))[0];
        const tenc = concat(
          Uint8Array.of(scheme === 'cbcs' ? 1 : 0, 0, 0, 0, 0, 0, 1, ivSize),
          new Uint8Array(16),
          ...(constant ? [constant] : []),
        );
        return box(
          'stsd',
          b.body.subarray(0, 8),
          box(
            'enca',
            entry.body,
            box(
              'sinf',
              box('frma', ascii('mp4a')),
              box('schm', new Uint8Array(4), ascii(scheme), u32(65536)),
              box('schi', box('tenc', tenc)),
            ),
          ),
        );
      }),
    );
  return rewrite(clear);
}
test('protected MP4 inspection retains codecs and identifies scheme/KID without altering encrypted bytes', () => {
  for (const scheme of ['cenc', 'cbcs']) {
    const input = protect(scheme),
      original = input.slice(),
      track = inspectInit(input)[0];
    assert.equal(track.codec, 'mp4a.40.2');
    assert.equal(track.encryption.scheme, scheme);
    assert.deepEqual(track.encryption.kid, new Uint8Array(16));
    assert.deepEqual(input, original);
  }
  assert.equal(inspectInit(clear)[0].encryption, undefined);
});
test('protected MP4 rejects unsupported schemes and invalid IV defaults', () => {
  assert.throws(() => inspectInit(protect('xxxx')), /scheme/);
  assert.throws(() => inspectInit(protect('cenc', 0)), /IV size/);
  assert.throws(() => inspectInit(protect('cenc', 7)), /IV size/);
  assert.throws(
    () => inspectInit(protect('cbcs', 0, Uint8Array.of(16, 1))),
    /constant/,
  );
  const valid = protect('cbcs', 0, Uint8Array.of(16, ...new Uint8Array(16)));
  assert.equal(inspectInit(valid)[0].encryption.scheme, 'cbcs');
});
