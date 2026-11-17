import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { build } from 'esbuild';
async function module(name) {
  const r = await build({
    entryPoints: [
      new URL('../src/engines/hls/' + name + '.ts', import.meta.url).pathname,
    ],
    bundle: true,
    write: false,
    format: 'esm',
  });
  return import(
    'data:text/javascript;base64,' +
      Buffer.from(r.outputFiles[0].text).toString('base64')
  );
}
const { PreloadCache } = await module('preload'),
  { ResourceClient } = await module('network'),
  { parsePlaylist } = await module('playlist');
const playlist = (url, hints) =>
  parsePlaylist(
    '#EXTM3U\n#EXT-X-VERSION:9\n#EXT-X-TARGETDURATION:2\n#EXT-X-PART-INF:PART-TARGET=0.2\n#EXT-X-PART:DURATION=0.2,URI="previous",INDEPENDENT=YES\n' +
      hints,
    url,
  );
test('PART and MAP hints retain bounded/open ranges and reject duplicates/zero lengths', () => {
  const p = playlist(
    'https://example.com/live.m3u8',
    '#EXT-X-PRELOAD-HINT:TYPE=PART,URI="g.mp4",BYTERANGE-START=20\n#EXT-X-PRELOAD-HINT:TYPE=MAP,URI="init.mp4",BYTERANGE-START=4,BYTERANGE-LENGTH=8',
  );
  assert.equal(p.preload.rangeStart, 20);
  assert.deepEqual(p.preloadMap.range, { offset: 4, length: 8 });
  assert.throws(
    () =>
      playlist(
        p.url,
        '#EXT-X-PRELOAD-HINT:TYPE=PART,URI="a",BYTERANGE-LENGTH=0',
      ),
    /length/,
  );
  assert.throws(
    () =>
      playlist(
        p.url,
        '#EXT-X-PRELOAD-HINT:TYPE=PART,URI="a"\n#EXT-X-PRELOAD-HINT:TYPE=PART,URI="b"',
      ),
    /Duplicate/,
  );
});
test('open-range preload yields only authoritative bytes while response is still growing', async () => {
  let closed = false,
    ended = false,
    range;
  const server = createServer((req, res) => {
    range = req.headers.range;
    res.writeHead(206, { 'Content-Range': 'bytes 10-999/*' });
    res.write(Buffer.from([10, 11, 12]));
    setTimeout(() => {
      if (!res.destroyed) res.write(Buffer.from([13, 14, 15, 16, 17]));
    }, 40);
    req.on('close', () => (closed = true));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`,
    abort = new AbortController();
  try {
    const cache = new PreloadCache(new ResourceClient({}, abort.signal));
    const p = playlist(
      base + '/live.m3u8',
      '#EXT-X-PRELOAD-HINT:TYPE=PART,URI="grow",BYTERANGE-START=10',
    );
    cache.update(p);
    const actual = { url: base + '/grow', range: { offset: 12, length: 4 } };
    cache.update({ ...p, preload: undefined, parts: [{ ...actual }] });
    const got = await cache.take(actual);
    assert.deepEqual([...got.data], [12, 13, 14, 15]);
    assert.equal(cache.diagnostics.used, 1);
    assert.equal(range, 'bytes=10-9007199254740991');
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(closed, true);
    assert.equal(ended, false);
  } finally {
    abort.abort();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
test('invalid range headers cannot feed speculative bytes; MAP bytes are consumed only when referenced', async () => {
  const server = createServer((req, res) => {
    if (req.url === '/bad') {
      res.writeHead(206, { 'Content-Range': 'bytes 0-3/4' });
      res.end('bad!');
    } else res.end('init');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`,
    abort = new AbortController();
  try {
    const cache = new PreloadCache(new ResourceClient({}, abort.signal));
    cache.update(
      playlist(
        base + '/live',
        '#EXT-X-PRELOAD-HINT:TYPE=PART,URI="bad",BYTERANGE-START=10\n#EXT-X-PRELOAD-HINT:TYPE=MAP,URI="init"',
      ),
    );
    assert.equal(
      await cache.take({
        url: base + '/bad',
        range: { offset: 10, length: 4 },
      }),
      undefined,
    );
    cache.update({
      ...playlist(base + '/live', '#EXT-X-MAP:URI="init"'),
      preload: undefined,
      preloadMap: undefined,
    });
    const init = await cache.take({ url: base + '/init' });
    assert.equal(new TextDecoder().decode(init.data), 'init');
    assert.equal(cache.diagnostics.used, 1);
    assert.equal(cache.diagnostics.missed, 1);
  } finally {
    abort.abort();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
