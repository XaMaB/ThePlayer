import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const bundle = await build({
  stdin: {
    contents:
      "export * from './steering.ts'; export { HttpError } from '../hls/recovery.ts';",
    resolveDir: new URL('../src/engines/dash/', import.meta.url).pathname,
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
});
const { parseDashSteering, DashSteering, HttpError } = await import(
  'data:text/javascript;base64,' +
    Buffer.from(bundle.outputFiles[0].text).toString('base64')
);
const url = 'https://steering.example/current.json';
test('DASH steering validates clones, percent-encoded query replacement and priority', async () => {
  const manifest = {
    VERSION: 1,
    TTL: 30,
    'PATHWAY-PRIORITY': ['clone', 'b', 'a'],
    'RELOAD-URI': 'next.json',
    'PATHWAY-CLONES': [
      {
        'BASE-ID': 'a',
        ID: 'clone',
        'URI-REPLACEMENT': {
          HOST: 'clone.example',
          PARAMS: { token: 'x%2Fy' },
          'PER-VARIANT-URIS': { v: 'ignored' },
        },
      },
    ],
  };
  const parsed = parseDashSteering(manifest, url);
  assert.equal(parsed.reload, 'https://steering.example/next.json');
  const client = {
    signal: new AbortController().signal,
    get: async () => ({
      data: new TextEncoder().encode(JSON.stringify(manifest)),
      url,
    }),
  };
  const steering = new DashSteering(
    { url, defaults: ['a'], queryBeforeStart: true },
    client,
  );
  await steering.refresh(false, 0);
  const resource = {
    url: 'https://a.example/video.m4s?token=old&keep=1',
    alternatives: ['https://b.example/video.m4s'],
    serviceLocations: ['a', 'b'],
  };
  const candidates = steering.candidates(resource);
  assert.equal(
    candidates[0].url,
    'https://clone.example/video.m4s?keep=1&token=x%2Fy',
  );
  assert.deepEqual(
    candidates.map((c) => c.id),
    ['clone', 'b', 'a'],
  );
  steering.failure('clone');
  assert.equal(steering.candidates(resource)[0].id, 'b');
  assert.throws(
    () => parseDashSteering({ ...manifest, VERSION: 2 }, url),
    /version/,
  );
  assert.throws(
    () =>
      parseDashSteering({ ...manifest, 'PATHWAY-PRIORITY': ['a', 'a'] }, url),
    /Duplicate/,
  );
  assert.throws(
    () =>
      parseDashSteering(
        {
          ...manifest,
          'PATHWAY-CLONES': [
            {
              'BASE-ID': 'a',
              ID: 'x',
              'URI-REPLACEMENT': { HOST: 'evil/path' },
            },
          ],
        },
        url,
      ),
    /HOST/,
  );
});
test('DASH steering respects deferred startup, 429 delay and terminal 410', async () => {
  let calls = 0;
  const client = {
    signal: new AbortController().signal,
    get: async () => {
      calls++;
      throw new HttpError(429, '60');
    },
  };
  const steering = new DashSteering(
    { url, defaults: ['a'], queryBeforeStart: false },
    client,
  );
  await steering.refresh(false, 1000);
  assert.equal(calls, 0);
  await steering.refresh(true, 1000);
  await steering.refresh(true, 1000);
  assert.equal(calls, 1);
  const gone = new DashSteering(
    { url, defaults: ['a'], queryBeforeStart: true },
    {
      signal: client.signal,
      get: async () => {
        throw new HttpError(410);
      },
    },
  );
  await gone.refresh(false, 0);
  assert.equal(gone.diagnostics.disabled, true);
});
