import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const compiled = await build({
  entryPoints: [new URL('../src/core/player.ts', import.meta.url).pathname],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
});
const { PlayerCore } = await import(
  'data:text/javascript;base64,' +
    Buffer.from(compiled.outputFiles[0].text).toString('base64')
);
function fixture(fail = false) {
  const engines = [];
  const factory = (_video, source) => {
    const engine = new EventTarget();
    Object.assign(engine, {
      source,
      protocol: 'test',
      stack: 'test',
      audioTracks: [],
      subtitleTracks: [],
      diagnostics: {},
      async init() {
        if (fail) throw new Error('failed');
      },
      async destroy() {
        engine.destroyed = true;
      },
      async play() {},
      async selectAudioTrack() {},
      selectSubtitleTrack() {},
    });
    engines.push(engine);
    return engine;
  };
  return { engines, player: new PlayerCore({}, { test: factory }) };
}
test('source replacement releases old engine and ignores its later events', async () => {
  const { player, engines } = fixture();
  let events = 0;
  player.addEventListener('caption', () => events++);
  await player.load({ protocol: 'test' });
  engines[0].dispatchEvent(new CustomEvent('caption', { detail: {} }));
  await player.load({ protocol: 'test' });
  assert.ok(engines[0].destroyed);
  engines[0].dispatchEvent(new CustomEvent('caption', { detail: {} }));
  engines[1].dispatchEvent(new CustomEvent('caption', { detail: {} }));
  assert.equal(events, 2);
  await player.destroy();
  assert.ok(engines[1].destroyed);
  await assert.rejects(player.load({ protocol: 'test' }), /destroyed/);
});
test('unsupported engine does not interrupt current source', async () => {
  const { player, engines } = fixture();
  await player.load({ protocol: 'test' });
  await assert.rejects(player.load({ protocol: 'hls' }), /No playback engine/);
  assert.equal(engines[0].destroyed, undefined);
  await player.destroy();
});
test('failed initialization releases media ownership', async () => {
  const { player, engines } = fixture(true);
  await assert.rejects(player.load({ protocol: 'test' }), /failed/);
  assert.ok(engines[0].destroyed);
  assert.equal(player.source, undefined);
  await player.destroy();
});
