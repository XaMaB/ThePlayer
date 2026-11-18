import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const compiled = await build({
  stdin: {
    contents:
      "export { videoRenditions } from './src/engines/hls/video-renditions'; export { parsePlaylist } from './src/engines/hls/playlist'; export { parseSteering } from './src/engines/hls/steering';",
    resolveDir: new URL('..', import.meta.url).pathname,
  },
  bundle: true,
  write: false,
  format: 'esm',
});
const { videoRenditions, parsePlaylist, parseSteering } = await import(
  'data:text/javascript;base64,' +
    Buffer.from(compiled.outputFiles[0].text).toString('base64')
);
const master = parsePlaylist(
  '#EXTM3U\n#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="v",NAME="Main",DEFAULT=YES,AUTOSELECT=YES\n#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="v",NAME="Other",DEFAULT=NO,AUTOSELECT=NO,URI="other.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=500000,VIDEO="v",PATHWAY-ID="a"\nmain.m3u8',
  'https://example.org/master.m3u8',
);
test('VIDEO URI omission uses variant media; explicit manual angle overrides default', () => {
  const variant = master.variants[0];
  assert.equal(variant.video, 'v');
  assert.equal(
    videoRenditions(master, variant).url,
    'https://example.org/main.m3u8',
  );
  const alternate = videoRenditions(master, variant, 'Other');
  assert.equal(alternate.url, 'https://example.org/other.m3u8');
  assert.equal(alternate.selected.name, 'hls-video-Other');
  assert.equal(videoRenditions(undefined, variant).url, variant.url);
});
test('Steering clones retain VIDEO groups and rewrite their media URLs', () => {
  const manifest = parseSteering(
    {
      VERSION: 1,
      TTL: 10,
      'PATHWAY-PRIORITY': ['b'],
      'PATHWAY-CLONES': [
        {
          ID: 'b',
          'BASE-ID': 'a',
          'URI-REPLACEMENT': { HOST: 'cdn.example.org' },
        },
      ],
    },
    'https://example.org/steering.json',
    master,
  );
  const pathway = manifest.pathways.get('b');
  assert.equal(pathway.variants[0].video, pathway.renditions[0].group);
  assert.equal(
    videoRenditions(
      { ...master, renditions: pathway.renditions },
      pathway.variants[0],
      'Other',
    ).url,
    'https://cdn.example.org/other.m3u8',
  );
});
