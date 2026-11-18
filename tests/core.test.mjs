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
test('Inserted presentations own track controls while primary source and selections survive', async () => {
  const { player, engines } = fixture();
  await player.load({ protocol: 'test', url: 'primary' });
  const parent = engines[0],
    calls = [];
  Object.assign(parent, {
    isLive: true,
    audioTracks: [{ name: 'primary-audio' }],
    subtitleTracks: [{ name: 'primary-text' }],
    selectedAudioTrack: 'primary-audio',
    selectedSubtitleTrack: 'primary-text',
    qualityLevels: [{ id: 0 }],
    selectedQuality: 0,
    diagnostics: { interstitial: { active: true } },
  });
  const child = {
    audioTracks: [{ name: 'asset-audio' }],
    subtitleTracks: [{ name: 'asset-text' }],
    selectedAudioTrack: 'asset-audio',
    selectedSubtitleTrack: 'asset-text',
    qualityLevels: [{ id: 1 }],
    selectedQuality: 1,
    diagnostics: { state: 'playing' },
    async selectAudioTrack(name) {
      calls.push(['audio', name]);
    },
    selectSubtitleTrack(name) {
      calls.push(['subtitle', name]);
    },
    async selectQuality(id) {
      calls.push(['quality', id]);
    },
  };
  parent.presentation = child;
  assert.equal(player.isLive, true);
  assert.equal(player.source.url, 'primary');
  assert.equal(player.selectedAudioTrack, 'asset-audio');
  assert.equal(player.selectedSubtitleTrack, 'asset-text');
  assert.equal(player.qualityLevels[0].id, 1);
  assert.deepEqual(player.availableMediaModes, []);
  assert.equal(player.diagnostics.interstitial.active, true);
  assert.equal(player.diagnostics.state, 'playing');
  await player.selectAudioTrack('other');
  player.selectSubtitleTrack('');
  await player.selectQuality(2);
  parent.presentation.videoTracks = [{ name: 'side' }];
  parent.presentation.selectedVideoTrack = 'side';
  parent.presentation.selectVideoTrack = async (name) =>
    calls.push(['video', name]);
  assert.equal(player.selectedVideoTrack, 'side');
  assert.equal(player.videoTracks[0].name, 'side');
  await player.selectVideoTrack('side');
  assert.deepEqual(calls, [
    ['audio', 'other'],
    ['subtitle', ''],
    ['quality', 2],
    ['video', 'side'],
  ]);
  parent.presentation = null;
  assert.deepEqual(player.audioTracks, []);
  assert.deepEqual(player.subtitleTracks, []);
  await assert.rejects(
    player.selectAudioTrack('primary-audio'),
    /No active presentation/,
  );
  parent.presentation = undefined;
  assert.equal(player.selectedAudioTrack, 'primary-audio');
  assert.equal(player.selectedSubtitleTrack, 'primary-text');
  assert.equal(player.selectedQuality, 0);
  await player.destroy();
});
test('failed initialization releases media ownership', async () => {
  const { player, engines } = fixture(true);
  await assert.rejects(player.load({ protocol: 'test' }), /failed/);
  assert.ok(engines[0].destroyed);
  assert.equal(player.source, undefined);
  await player.destroy();
});

test('destroy during lazy engine import releases it without initialization', async () => {
  let release;
  let initialized = false,
    destroyed = false;
  const ready = new Promise((resolve) => (release = resolve));
  const engine = Object.assign(new EventTarget(), {
    async init() {
      initialized = true;
    },
    async destroy() {
      destroyed = true;
    },
  });
  const player = new PlayerCore(
    {},
    {
      lazy: async () => {
        await ready;
        return engine;
      },
    },
  );
  const loading = player.load({ protocol: 'lazy' });
  await Promise.resolve();
  const closing = player.destroy();
  release();
  await assert.rejects(loading, /destroyed/);
  await closing;
  assert.equal(initialized, false);
  assert.equal(destroyed, true);
});
