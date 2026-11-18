import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const compiled = await build({
  entryPoints: [
    new URL('../src/engines/hls/steering-selection.ts', import.meta.url)
      .pathname,
  ],
  bundle: true,
  write: false,
  format: 'esm',
});
const { pathwayLadder, pathwayQuality, matchingRendition } = await import(
  'data:text/javascript;base64,' +
    Buffer.from(compiled.outputFiles[0].text).toString('base64')
);
const variant = (id, bandwidth) => ({
  stableId: id,
  bandwidth,
  url: id,
  codecs: 'avc1.42c00c',
  resolution: '320x180',
});
test('Pathway inventory replacement retains identity or a conservative bitrate and exposes additions', () => {
  const old = variant('high', 1500000);
  const smaller = pathwayLadder(
    [variant('low', 500000), variant('mid', 900000)],
    old,
    'video',
    () => true,
  );
  assert.equal(smaller.index, 1);
  assert.deepEqual(
    smaller.levels.map((v) => v.id),
    [0, 1],
  );
  const larger = pathwayLadder(
    [old, variant('low', 500000)],
    variant('low', 500000),
    'video',
    () => true,
  );
  assert.equal(larger.index, 0);
  assert.equal(larger.levels.length, 2);
  assert.equal(pathwayQuality([variant('high', 1800000)], old), 0);
  assert.throws(
    () => pathwayLadder([old], old, 'video', () => false),
    /no supported/,
  );
});
test('Language identities survive reordering and missing languages do not silently map by index', () => {
  const en = { stableId: 'en', name: 'English', language: 'en' };
  const fr = { stableId: 'fr', name: 'French', language: 'fr' };
  assert.equal(
    matchingRendition([fr, en], {
      stableId: 'en',
      label: 'Old English',
      language: 'en',
    }),
    en,
  );
  assert.equal(
    matchingRendition([fr, en], {
      stableId: 'es',
      label: 'Spanish',
      language: 'es',
    }),
    undefined,
  );
});
