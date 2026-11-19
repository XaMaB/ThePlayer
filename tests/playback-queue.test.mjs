import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const bundle = await build({
  entryPoints: [
    new URL('../src/ui/playback-queue.ts', import.meta.url).pathname,
  ],
  bundle: true,
  write: false,
  format: 'esm',
});
const { PlaybackQueue, chaptersFor } = await import(
  'data:text/javascript;base64,' +
    Buffer.from(bundle.outputFiles[0].text).toString('base64')
);
const items = [
  { id: 'one', title: 'One', source: { protocol: 'hls' } },
  { id: 'two', title: 'Two', source: { protocol: 'dash' } },
];
test('queue loads, advances only VOD, propagates failures and removes ended listener', async () => {
  const video = new EventTarget();
  let loaded = [],
    plays = 0;
  const player = {
    video,
    isLive: false,
    load: async (source) => {
      loaded.push(source.protocol);
    },
    play: async () => {
      plays++;
    },
  };
  const queue = new PlaybackQueue(() => player, items);
  await queue.select(0);
  assert.equal(queue.index, 0);
  assert.equal(plays, 1);
  video.dispatchEvent(new Event('ended'));
  await new Promise((r) => setImmediate(r));
  assert.equal(queue.index, 1);
  assert.deepEqual(loaded, ['hls', 'dash']);
  await queue.previous();
  player.isLive = true;
  video.dispatchEvent(new Event('ended'));
  await new Promise((r) => setImmediate(r));
  assert.equal(queue.index, 0);
  player.isLive = false;
  player.load = async () => {
    throw new Error('offline');
  };
  await assert.rejects(queue.next(), /offline/);
  assert.equal(queue.index, -1);
  queue.destroy();
  await assert.rejects(queue.select(0), /destroyed/);
});
test('queue reset/destroy while loading cannot restart playback', async () => {
  for (const action of ['reset', 'destroy']) {
    let done,
      plays = 0;
    const player = {
      video: new EventTarget(),
      isLive: false,
      load: () => new Promise((r) => (done = r)),
      play: async () => plays++,
    };
    const q = new PlaybackQueue(() => player, items);
    const pending = q.select(0);
    await assert.rejects(q.select(1), /already loading/);
    q[action]();
    done();
    await pending;
    assert.equal(plays, 0);
    assert.equal(q.index, -1);
    q.destroy();
  }
});
test('chapters use explicit entries or native chapter cues and validate boundaries', () => {
  assert.deepEqual(
    chaptersFor({ textTracks: [] }, [
      { title: 'b', start: 20 },
      { title: 'a', start: 0 },
      { title: 'bad', start: -1 },
    ]),
    [
      { title: 'a', start: 0 },
      { title: 'b', start: 20 },
    ],
  );
  assert.deepEqual(
    chaptersFor({
      textTracks: [
        { kind: 'chapters', cues: [{ startTime: 2, text: 'Opening' }] },
        { kind: 'subtitles', cues: [{ startTime: 1, text: 'Caption' }] },
      ],
    }),
    [{ title: 'Opening', start: 2 }],
  );
  assert.throws(
    () =>
      new PlaybackQueue(
        () => ({ video: new EventTarget() }),
        [items[0], items[0]],
      ),
    /unique/,
  );
});
