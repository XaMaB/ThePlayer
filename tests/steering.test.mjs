import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const result = await build({
  stdin: {
    contents:
      "export * from './src/engines/hls/steering';export * from './src/engines/hls/playlist';export * from './src/engines/hls/recovery';",
    resolveDir: new URL('..', import.meta.url).pathname,
  },
  bundle: true,
  write: false,
  format: 'esm',
});
const { parsePlaylist, parseSteering, ContentSteering, HttpError } =
  await import(
    'data:text/javascript;base64,' +
      Buffer.from(result.outputFiles[0].text).toString('base64')
  );
const master = () =>
  parsePlaylist(
    `#EXTM3U
#EXT-X-CONTENT-STEERING:SERVER-URI="steering.json",PATHWAY-ID="a"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="English",URI="audio.m3u8",LANGUAGE="en",STABLE-RENDITION-ID="en"
#EXT-X-STREAM-INF:BANDWIDTH=800000,CODECS="avc1.42e01e,mp4a.40.2",PATHWAY-ID="a",STABLE-VARIANT-ID="low",AUDIO="a"
video.m3u8?signature=a%20b&token=old
#EXT-X-STREAM-INF:BANDWIDTH=800000,CODECS="avc1.42e01e,mp4a.40.2",PATHWAY-ID="b",STABLE-VARIANT-ID="low"
https://b.example/video.m3u8
`,
    'https://a.example/master.m3u8',
  );
const manifest = (extra = {}) => ({
  VERSION: 1,
  TTL: 2,
  'PATHWAY-PRIORITY': ['a', 'b'],
  ...extra,
});
test('Steering parses stable identities and clones groups, encoded parameters and per-rendition overrides', () => {
  const p = master();
  assert.equal(p.steering.url, 'https://a.example/steering.json');
  assert.equal(p.variants[0].stableId, 'low');
  const m = parseSteering(
    manifest({
      'PATHWAY-CLONES': [
        {
          'BASE-ID': 'a',
          ID: 'c',
          'URI-REPLACEMENT': {
            HOST: 'c.example',
            PARAMS: { token: 'new%20value', z: '1' },
            'PER-RENDITION-URIS': { en: 'https://audio.example/en.m3u8' },
          },
        },
        { 'BASE-ID': 'c', ID: 'd', 'URI-REPLACEMENT': { HOST: 'd.example' } },
      ],
    }),
    'https://control.example/s.json',
    p,
  );
  const c = m.pathways.get('c');
  assert.equal(
    c.variants[0].url,
    'https://c.example/video.m3u8?signature=a%20b&token=new%20value&z=1',
  );
  assert.equal(c.renditions[0].url, 'https://audio.example/en.m3u8');
  assert.equal(c.variants[0].audio, c.renditions[0].group);
  assert.equal(
    m.pathways.get('d').renditions[0].url,
    'https://d.example/en.m3u8',
  );
  assert.equal(
    p.variants[0].url,
    'https://a.example/video.m3u8?signature=a%20b&token=old',
  );
});
test('Steering rejects malformed versions, priority duplicates, clone collisions and unsafe replacement URIs', () => {
  for (const m of [
    manifest({ VERSION: 2 }),
    manifest({ TTL: -1 }),
    manifest({ 'PATHWAY-PRIORITY': ['a', 'a'] }),
    manifest({
      'PATHWAY-CLONES': [{ 'BASE-ID': 'a', ID: 'a', 'URI-REPLACEMENT': {} }],
    }),
    manifest({
      'PATHWAY-CLONES': [
        {
          'BASE-ID': 'a',
          ID: 'c',
          'URI-REPLACEMENT': {
            'PER-VARIANT-URIS': { low: 'javascript:alert(1)' },
          },
        },
      ],
    }),
    manifest({
      'PATHWAY-CLONES': [
        {
          'BASE-ID': 'a',
          ID: 'c',
          'URI-REPLACEMENT': { PARAMS: { token: 'raw&value' } },
        },
      ],
    }),
  ])
    assert.throws(() =>
      parseSteering(m, 'https://control.example/s', master()),
    );
  assert.deepEqual(
    parseSteering(
      manifest({ 'PATHWAY-PRIORITY': ['unknown', 'b'] }),
      'https://control.example/s',
      master(),
    ).priority,
    ['b'],
  );
});
test('Steering TTL, redirect-relative reloads, penalties and HTTP 410 are session bounded', async () => {
  const abort = new AbortController(),
    urls = [];
  let response = manifest({
      'PATHWAY-PRIORITY': ['b', 'a'],
      'RELOAD-URI': 'next.json',
    }),
    failure;
  const client = {
    signal: abort.signal,
    async get(r) {
      urls.push(r.url);
      if (failure) throw failure;
      return {
        data: new TextEncoder().encode(JSON.stringify(response)),
        url: 'https://control.example/path/first.json',
        elapsed: 1,
      };
    },
  };
  const steering = new ContentSteering(master(), client);
  await steering.refresh(900000);
  assert.equal(steering.diagnostics.pathway, 'b');
  assert.match(urls[0], /_HLS_throughput=900000/);
  await steering.refresh(900000);
  assert.equal(urls.length, 1);
  steering.penalize();
  assert.equal(steering.diagnostics.pathway, 'a');
  failure = new HttpError(410);
  await steering.refresh(1, performance.now() + 3000);
  assert.match(urls[1], /^https:\/\/control.example\/path\/next.json/);
  await steering.refresh(1, performance.now() + 1000000);
  assert.equal(urls.length, 2);
});
test('HTTP 429 Retry-After overrides TTL and malformed updates retain the last working pathway', async () => {
  const abort = new AbortController();
  let calls = 0;
  const client = {
    signal: abort.signal,
    async get() {
      calls++;
      throw new HttpError(429, '30');
    },
  };
  const steering = new ContentSteering(master(), client);
  await steering.refresh(0);
  await steering.refresh(0, performance.now() + 10000);
  assert.equal(calls, 1);
  await steering.refresh(0, performance.now() + 31000);
  assert.equal(calls, 2);
  assert.equal(steering.diagnostics.pathway, 'a');
});
