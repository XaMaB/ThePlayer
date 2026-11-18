import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const result = await build({
  stdin: {
    contents:
      "export * from './src/engines/hls/thumbnails';export * from './src/engines/hls/playlist';",
    resolveDir: new URL('..', import.meta.url).pathname,
  },
  bundle: true,
  write: false,
  format: 'esm',
});
const { parsePlaylist, imageTile, jpegSize } = await import(
  'data:text/javascript;base64,' +
    Buffer.from(result.outputFiles[0].text).toString('base64')
);
const base = 'https://example.com/index.m3u8';
test('Image variants are separate from playback qualities and unsupported codecs are ignored', () => {
  const p = parsePlaylist(
    '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=500000\nvideo.m3u8\n#EXT-X-IMAGE-STREAM-INF:BANDWIDTH=1000,CODECS="jpeg",RESOLUTION=160x90,URI="images.m3u8"\n#EXT-X-IMAGE-STREAM-INF:BANDWIDTH=1000,CODECS="unknown",URI="bad"',
    base,
  );
  assert.equal(p.variants.length, 1);
  assert.equal(p.images.length, 1);
  assert.equal(p.images[0].url, 'https://example.com/images.m3u8');
});
test('Tile selection is row-major, clips to EXTINF and holds the last tile', () => {
  const s = {
    start: 10,
    duration: 10,
    gap: false,
    tiles: { width: 160, height: 90, columns: 2, rows: 2, duration: 2 },
  };
  assert.equal(imageTile(s, 9.99, 320, 180), undefined);
  assert.deepEqual(imageTile(s, 14, 320, 180), {
    x: 0,
    y: 90,
    width: 160,
    height: 90,
    time: 14,
    end: 16,
  });
  assert.equal(imageTile(s, 19.9, 320, 180).time, 16);
  assert.equal(imageTile(s, 19.9, 320, 180).end, 20);
  assert.equal(imageTile({ ...s, duration: 5 }, 14.9, 320, 180).end, 15);
  assert.equal(imageTile({ ...s, gap: true }, 12, 320, 180), undefined);
  assert.throws(() => imageTile(s, 12, 300, 180), /grid/);
});
test('Tile attributes apply only to the next image and reject oversized grids', () => {
  const prefix = '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-IMAGES-ONLY\n';
  const p = parsePlaylist(
    prefix +
      '#EXT-X-TILES:RESOLUTION=160x90,LAYOUT=2x2,DURATION=2\n#EXTINF:8,\na.jpg\n#EXTINF:2,\nb.jpg\n#EXT-X-ENDLIST',
    base,
  );
  assert.equal(p.segments[0].tiles.columns, 2);
  assert.equal(p.segments[1].tiles, undefined);
  assert.throws(
    () =>
      parsePlaylist(
        prefix +
          '#EXT-X-TILES:RESOLUTION=32000x32000,LAYOUT=2x2,DURATION=2\n#EXTINF:8,\na.jpg',
        base,
      ),
    /pixel limit/,
  );
});
test('JPEG signature, segment bounds and pixel limits are validated before decode', () => {
  const bytes = Uint8Array.from([
    255, 216, 255, 192, 0, 8, 8, 0, 90, 0, 160, 0, 255, 217,
  ]);
  assert.deepEqual(jpegSize(bytes), { width: 160, height: 90 });
  assert.throws(() => jpegSize(bytes.slice(0, 7)), /Truncated/);
  assert.throws(() => jpegSize(new Uint8Array(20)), /not JPEG/);
  bytes[7] = 255;
  bytes[8] = 255;
  bytes[9] = 255;
  bytes[10] = 255;
  assert.throws(() => jpegSize(bytes), /pixel limit/);
});
