import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const bundled = await build({
  entryPoints: ['src/core/media-source.ts'],
  bundle: true,
  write: false,
  format: 'esm',
});
const {
  createMediaSource,
  releaseMediaSource,
  supportsMediaType,
  mediaSourceConstructor,
} = await import(
  'data:text/javascript;base64,' +
    Buffer.from(bundled.outputFiles[0].text).toString('base64')
);
class Standard {
  static isTypeSupported(type) {
    return type === 'standard';
  }
}
class Managed {
  static isTypeSupported(type) {
    return type === 'managed';
  }
}
function environment(standard, managed, run) {
  const original = [globalThis.MediaSource, globalThis.ManagedMediaSource];
  globalThis.MediaSource = standard;
  globalThis.ManagedMediaSource = managed;
  try {
    run();
  } finally {
    for (const [i, key] of ['MediaSource', 'ManagedMediaSource'].entries())
      if (original[i] === undefined) delete globalThis[key];
      else globalThis[key] = original[i];
  }
}
test('ordinary MSE remains preferred and keeps remote playback policy', () =>
  environment(Standard, Managed, () => {
    const video = { playsInline: false, disableRemotePlayback: false };
    assert.ok(createMediaSource(video) instanceof Standard);
    assert.equal(video.playsInline, true);
    assert.equal(video.disableRemotePlayback, false);
    assert.equal(supportsMediaType('standard'), true);
    assert.equal(supportsMediaType('managed'), false);
    releaseMediaSource(video);
    assert.equal(video.disableRemotePlayback, false);
  }));
test('managed-only codec probes and attachment retain original remote policy across restarts', () =>
  environment(undefined, Managed, () => {
    for (const initial of [false, true]) {
      const video = { playsInline: false, disableRemotePlayback: initial };
      assert.ok(createMediaSource(video) instanceof Managed);
      assert.equal(supportsMediaType('managed'), true);
      assert.equal(video.disableRemotePlayback, true);
      createMediaSource(video);
      releaseMediaSource(video);
      assert.equal(video.disableRemotePlayback, initial);
      releaseMediaSource(video);
      assert.equal(video.disableRemotePlayback, initial);
    }
  }));
test('missing media-source APIs report an actionable error', () =>
  environment(undefined, undefined, () => {
    assert.throws(mediaSourceConstructor, /MediaSource or ManagedMediaSource/);
  }));
