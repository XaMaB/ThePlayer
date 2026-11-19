import { mkdir, copyFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
const root =
  process.env.THEPLAYER_DASH_FIXTURES ??
  path.join(os.tmpdir(), 'theplayer-dash-fixtures');
await mkdir(root, { recursive: true });
execFileSync(
  'ffmpeg',
  [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=320x180:rate=25',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=48000',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=880:sample_rate=48000',
    '-map',
    '0:v',
    '-map',
    '0:v',
    '-map',
    '1:a',
    '-map',
    '2:a',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-g',
    '50',
    '-keyint_min',
    '50',
    '-sc_threshold',
    '0',
    '-bf',
    '0',
    '-b:v:0',
    '250k',
    '-b:v:1',
    '700k',
    '-filter:v:1',
    'scale=640:360',
    '-c:a',
    'aac',
    '-b:a',
    '64k',
    '-metadata:s:a:0',
    'language=eng',
    '-metadata:s:a:1',
    'language=bul',
    '-t',
    '24',
    '-f',
    'dash',
    '-seg_duration',
    '2',
    '-use_template',
    '1',
    '-use_timeline',
    '1',
    '-init_seg_name',
    'init-$RepresentationID$.mp4',
    '-media_seg_name',
    'segment-$RepresentationID$-$Number%05d$.m4s',
    '-adaptation_sets',
    'id=0,streams=0,1 id=1,streams=2 id=2,streams=3',
    path.join(root, 'timeline.mpd'),
  ],
  { stdio: 'inherit' },
);
console.log('Generated original DASH test media in', root);

await mkdir(path.join(root, 'fmp4'), { recursive: true });
await copyFile(path.join(root, 'init-0.mp4'), path.join(root, 'fmp4/init.mp4'));
execFileSync(
  process.execPath,
  [new URL('./prepare-text-fixtures.mjs', import.meta.url).pathname],
  { stdio: 'inherit', env: { ...process.env, THEPLAYER_HLS_FIXTURES: root } },
);
await writeFile(
  path.join(root, 'captions.vtt'),
  'WEBVTT\n\n00:00:00.000 --> 00:00:23.000 align:start position:15%\nDASH WebVTT caption\n',
);
await writeFile(
  path.join(root, 'captions.ttml'),
  '<tt xmlns="http://www.w3.org/ns/ttml" xmlns:tts="http://www.w3.org/ns/ttml#styling"><body><div><p begin="0s" end="23s" tts:textAlign="left">DASH TTML caption</p></div></body></tt>',
);
let encryptedPlaylist =
  '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MAP:URI="init.mp4"\n';
for (let i = 0; i < 12; i++) {
  const name = `segment${String(i).padStart(2, '0')}.m4s`;
  await copyFile(
    path.join(root, `segment-0-${String(i + 1).padStart(5, '0')}.m4s`),
    path.join(root, 'fmp4', name),
  );
  encryptedPlaylist += `#EXTINF:2,\n${name}\n`;
}
await writeFile(
  path.join(root, 'fmp4/index.m3u8'),
  encryptedPlaylist + '#EXT-X-ENDLIST\n',
);
execFileSync(
  process.execPath,
  [new URL('./prepare-cenc-fixtures.mjs', import.meta.url).pathname],
  { stdio: 'inherit', env: { ...process.env, THEPLAYER_HLS_FIXTURES: root } },
);

for (const name of ['prepare-sei-fixtures.mjs', 'prepare-708-fixtures.mjs'])
  execFileSync(process.execPath, [new URL(name, import.meta.url).pathname], {
    stdio: 'inherit',
    env: { ...process.env, THEPLAYER_HLS_FIXTURES: root },
  });

execFileSync(
  'ffmpeg',
  [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=160x90:rate=1',
    '-vf',
    'tile=2x2',
    '-frames:v',
    '1',
    '-threads',
    '1',
    path.join(root, 'thumbnails.jpg'),
  ],
  { stdio: 'inherit' },
);

await import('./prepare-dash-seig-fixtures.mjs');

await import('./prepare-dash-codec-fixtures.mjs');
