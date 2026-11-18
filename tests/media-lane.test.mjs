import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const bundle = await build({
  stdin: {
    contents: "export { MediaLane } from './src/engines/hls/media-lane';",
    resolveDir: new URL('..', import.meta.url).pathname,
  },
  bundle: true,
  write: false,
  format: 'esm',
});
const { MediaLane } = await import(
  'data:text/javascript;base64,' +
    Buffer.from(bundle.outputFiles[0].text).toString('base64')
);
test('Same-codec rendition replacement works without SourceBuffer.changeType', () => {
  const original = globalThis.MediaSource;
  globalThis.MediaSource = { isTypeSupported: () => true };
  try {
    const lane = () =>
      new MediaLane(
        {},
        'audio',
        async () => {},
        async (data) => data,
      );
    let created = 0;
    const buffer = { mode: '' };
    const media = {
      addSourceBuffer: () => {
        created++;
        return buffer;
      },
    };
    const prepared = { tracks: [{ kind: 'audio', codec: 'mp4a.40.2' }] };
    const previous = lane();
    previous.configure(media, prepared);
    const next = lane();
    next.inheritBuffer(previous);
    next.configure(media, prepared);
    assert.equal(next.buffer, buffer);
    assert.equal(created, 1);
    assert.equal(buffer.mode, 'segments');
    const types = [];
    buffer.changeType = (mime) => types.push(mime);
    next.configure(media, { tracks: [{ kind: 'audio', codec: 'ac-3' }] });
    assert.deepEqual(types, ['audio/mp4; codecs="ac-3"']);
  } finally {
    if (original === undefined) delete globalThis.MediaSource;
    else globalThis.MediaSource = original;
  }
});

test('AVC level changes retain the buffer without changeType, but codec changes fail clearly', () => {
  const original = globalThis.MediaSource;
  globalThis.MediaSource = { isTypeSupported: () => true };
  try {
    const lane = new MediaLane(
      {},
      'main',
      async () => {},
      async (data) => data,
    );
    const buffer = { mode: '' };
    const media = { addSourceBuffer: () => buffer };
    lane.configure(media, {
      tracks: [{ kind: 'video', codec: 'avc1.42c00c' }],
    });
    lane.configure(media, {
      tracks: [{ kind: 'video', codec: 'avc1.42c01e' }],
    });
    assert.equal(lane.buffer, buffer);
    assert.throws(
      () =>
        lane.configure(media, {
          tracks: [{ kind: 'video', codec: 'avc1.64001e' }],
        }),
      /cannot switch SourceBuffer codec types/,
    );
    assert.throws(
      () =>
        lane.configure(media, {
          tracks: [{ kind: 'video', codec: 'hvc1.1.6.L93.B0' }],
        }),
      /cannot switch SourceBuffer codec types/,
    );
  } finally {
    if (original === undefined) delete globalThis.MediaSource;
    else globalThis.MediaSource = original;
  }
});

test('Continuous fragments do not reassign timestampOffset while the MSE parser retains a segment', async () => {
  const lane = new MediaLane(
    {},
    'main',
    async () => {},
    async (data) => data,
  );
  let offset = 0,
    parsing = true;
  const writes = [],
    appends = [];
  lane.buffer = {
    get timestampOffset() {
      return offset;
    },
    set timestampOffset(value) {
      if (parsing)
        throw new DOMException('Parser retains a segment', 'InvalidStateError');
      writes.push(value);
      offset = value;
    },
    appendBuffer(data) {
      appends.push(data);
    },
  };
  const prepared = {
    init: new Uint8Array(),
    data: new Uint8Array([1]),
    rawStart: 8,
    segment: { discontinuity: 0 },
  };
  const operation = async (_buffer, action) => action();
  await lane.append(prepared, 0, operation);
  assert.equal(appends.length, 1);
  assert.deepEqual(writes, []);
  parsing = false;
  await lane.append(prepared, 2, operation);
  assert.deepEqual(writes, [2]);
  await lane.append({ ...prepared, mime: 'audio/mpeg' }, 2, operation);
  assert.deepEqual(writes, [2, 10]);
});
