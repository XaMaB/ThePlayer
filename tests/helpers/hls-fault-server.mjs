import { createCipheriv } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFileSync } from 'node:fs';
const createServer =
  process.env.TLS_KEY && process.env.TLS_CERT
    ? (handler) =>
        createHttpsServer(
          {
            key: readFileSync(process.env.TLS_KEY),
            cert: readFileSync(process.env.TLS_CERT),
          },
          handler,
        )
    : createHttpServer;
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

/** Isolated scenario namespaces: deterministic faults, no administrative HTTP API. */
export function faultServer({
  fixtures = process.env.THEPLAYER_HLS_FIXTURES ??
    path.join(os.tmpdir(), 'theplayer-hls-fixtures'),
  dist = process.env.THEPLAYER_DIST ??
    fileURLToPath(new URL('../../dist/', import.meta.url)),
} = {}) {
  const requests = new Map();
  const epochs = new Map();
  const starts = new Map();
  let llAvInventory;
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'no-store');
      if (url.pathname === '/harness.html') {
        res.setHeader('Content-Type', 'text/html');
        res.end('<!doctype html><video muted></video>');
        return;
      }
      const match = /^\/scenario\/([a-z0-9-]+)\/([a-z-]+)\/(.+)$/.exec(
        url.pathname,
      );
      let root = dist,
        relative = url.pathname.slice(1);
      if (url.pathname.startsWith('/fixture/')) {
        root = fixtures;
        relative = url.pathname.slice(9);
      }
      if (match) {
        const [, , scenario, resource] = match;
        root = fixtures;
        relative = 'ts/' + resource;
        const count = (requests.get(url.pathname) ?? 0) + 1;
        requests.set(url.pathname, count);
        const segment = resource === 'segment03.ts';
        if (scenario === 'images-live' || scenario === 'iframes-live') {
          const iframes = scenario === 'iframes-live';
          const epochKey = match[1] + '-images';
          if (!epochs.has(epochKey)) epochs.set(epochKey, Date.now());
          const elapsed = (Date.now() - epochs.get(epochKey)) / 1000;
          if (resource === 'master.m3u8') {
            res.end(
              '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=600000,CODECS="avc1.42c00c,mp4a.40.2"\nprimary.m3u8\n' +
                (iframes
                  ? '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=10000,CODECS="avc1.42c00c",RESOLUTION=320x180,URI="preview.m3u8"\n'
                  : '#EXT-X-IMAGE-STREAM-INF:BANDWIDTH=2000,CODECS="jpeg",RESOLUTION=160x90,URI="preview.m3u8"\n'),
            );
            return;
          }
          if (resource === 'primary.m3u8') {
            const first = Math.min(4, Math.floor(elapsed / 2));
            let text = `#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:${first}\n#EXT-X-PROGRAM-DATE-TIME:${new Date(Date.UTC(2026, 0, 2, 3, 4, first * 2)).toISOString()}\n`;
            for (let n = first; n <= Math.min(8, first + 6); n++)
              text += `#EXTINF:2,\nsegment${String(n).padStart(2, '0')}.ts\n`;
            res.end(text);
            return;
          }
          if (resource === 'preview.m3u8') {
            const first = Math.floor(elapsed / 4);
            let text = `#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:4\n${iframes ? '#EXT-X-I-FRAMES-ONLY' : '#EXT-X-IMAGES-ONLY'}\n#EXT-X-MEDIA-SEQUENCE:${100 + first}\n#EXT-X-PROGRAM-DATE-TIME:${new Date(Date.UTC(2026, 0, 2, 3, 4, first * 4)).toISOString()}\n`;
            for (let n = first; n < first + 3; n++)
              text += iframes
                ? `#EXTINF:4,\nframe${n}.ts\n`
                : `#EXT-X-TILES:RESOLUTION=160x90,LAYOUT=2x2,DURATION=1\n#EXTINF:4,\nsheet${n}.jpg\n`;
            res.end(text);
            return;
          }
          if (iframes && /^frame\d+\.ts$/.test(resource)) {
            res.end(
              await readFile(
                path.join(
                  fixtures,
                  'iframes',
                  (Number(resource.slice(5, -3)) % 3) + '.ts',
                ),
              ),
            );
            return;
          }
          if (/^sheet\d+\.jpg$/.test(resource)) {
            res.setHeader('Content-Type', 'image/jpeg');
            res.end(await readFile(path.join(fixtures, 'images/grid.jpg')));
            return;
          }
        }
        if (scenario.startsWith('interstitial-')) {
          const origin =
            (req.socket.encrypted ? 'https' : 'http') +
            '://' +
            req.headers.host;
          const prefix = `${origin}/scenario/${match[1]}/${scenario}/`;
          if (scenario.startsWith('interstitial-preload-')) {
            const mode = scenario.slice('interstitial-preload-'.length);
            if (resource === 'index.m3u8') {
              let source = await readFile(
                path.join(fixtures, 'ts/index.m3u8'),
                'utf8',
              );
              if (mode !== 'vod')
                source = source
                  .replace('#EXT-X-ENDLIST', '')
                  .replace(
                    '#EXT-X-PLAYLIST-TYPE:VOD',
                    '#EXT-X-PLAYLIST-TYPE:EVENT',
                  );
              const list = mode === 'list';
              const target = `#EXT-X-DATERANGE:ID="ad",CLASS="com.apple.hls.interstitial",START-DATE="2026-01-02T03:04:04Z",DURATION=4,CUE="ONCE",X-RESUME-OFFSET=0,${list ? 'X-ASSET-LIST="list.json"' : `X-ASSET-URI="${prefix}ad.m3u8"`}\n`;
              const hint = `#EXT-X-DATERANGE:ID="hint",CLASS="com.apple.hls.preload",START-DATE="2026-01-02T03:04:00Z",DURATION=1,X-TARGET-ID="ad",X-TARGET-CLASS="com.apple.hls.interstitial",X-URI="${mode === 'mismatch' ? 'unused.m3u8' : list ? 'list.json' : 'ad.m3u8'}"\n`;
              res.end(
                source.replace(
                  '#EXTM3U\n',
                  '#EXTM3U\n#EXT-X-PROGRAM-DATE-TIME:2026-01-02T03:04:00Z\n' +
                    (list && count === 1 ? '' : target) +
                    (mode === 'removed' && count > 1 ? '' : hint),
                ),
              );
              return;
            }
            if (resource === 'list.json') {
              res.end(
                JSON.stringify({
                  ASSETS: [{ URI: prefix + 'ad.m3u8', DURATION: 4 }],
                }),
              );
              return;
            }
            if (resource === 'ad.m3u8' && count === 1 && mode === 'fault') {
              res.writeHead(503);
              res.end();
              return;
            }
            if (resource === 'ad.m3u8' && count === 1 && mode === 'slow')
              await new Promise((resolve) => setTimeout(resolve, 5000));
          }
          if (scenario === 'interstitial-live' && resource === 'index.m3u8') {
            const key = url.pathname;
            if (!epochs.has(key)) epochs.set(key, Date.now());
            const first = Math.min(
              4,
              Math.floor((Date.now() - epochs.get(key)) / 2000),
            );
            const last = Math.min(8, first + 6);
            let text = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:${first}\n#EXT-X-PROGRAM-DATE-TIME:${new Date(Date.UTC(2026, 0, 2, 3, 4, first * 2)).toISOString()}\n`;
            text += `#EXT-X-DATERANGE:ID="ad",CLASS="com.apple.hls.interstitial",START-DATE="2026-01-02T03:04:08Z",DURATION=4,CUE="ONCE",X-ASSET-URI="${prefix}ad.m3u8"\n`;
            for (let n = first; n <= last; n++)
              text += `#EXTINF:2,\nsegment${String(n).padStart(2, '0')}.ts\n`;
            res.end(text);
            return;
          }
          if (resource === 'index.m3u8') {
            const original = await readFile(
              path.join(fixtures, 'ts/index.m3u8'),
              'utf8',
            );
            const pre = scenario === 'interstitial-pre';
            const list = ['interstitial-list', 'interstitial-empty'].includes(
              scenario,
            );
            const asset =
              scenario === 'interstitial-error' ? 'missing.m3u8' : 'ad.m3u8';
            const kind = scenario.slice('interstitial-'.length);
            const cue = pre
              ? 'PRE,ONCE'
              : kind === 'post'
                ? 'POST'
                : kind === 'negative'
                  ? ''
                  : 'ONCE';
            const offset =
              kind === 'default'
                ? ''
                : `,X-RESUME-OFFSET=${kind === 'negative' ? -1 : kind === 'multiple' ? 1 : kind === 'ui' ? 2 : 0}`;
            const extras =
              {
                limit: ',X-PLAYOUT-LIMIT=1',
                skip: ',X-RESTRICT="SKIP",X-SKIP-CONTROL-OFFSET=1',
                ui: ',X-TIMELINE-OCCUPIES="RANGE",X-SKIP-CONTROL-OFFSET=0,X-SKIP-CONTROL-LABEL-ID="Continue"',
                controls: ',X-SKIP-CONTROL-OFFSET=0',
                jump: ',X-RESTRICT="JUMP"',
                snap: ',X-SNAP="OUT,IN"',
              }[kind] ?? '';
            const tag = `#EXT-X-DATERANGE:ID="ad",CLASS="com.apple.hls.interstitial",START-DATE="2026-01-02T03:04:0${pre ? 0 : kind === 'snap' ? '2.4' : 2}Z",DURATION=4,${list ? 'X-ASSET-LIST="list.json"' : `X-ASSET-URI="${prefix}${asset}"`}${offset}${cue ? `,CUE="${cue}"` : ''}${extras}\n`;
            const metadata =
              '#EXT-X-PROGRAM-DATE-TIME:2026-01-02T03:04:00Z\n' +
              tag +
              (kind === 'multiple' ? tag.replace('ID="ad"', 'ID="ad2"') : '');
            res.end(original.replace('#EXTM3U\n', '#EXTM3U\n' + metadata));
            return;
          }
          if (resource === 'list.json') {
            res.setHeader('Content-Type', 'application/json');
            res.end(
              JSON.stringify({
                ASSETS:
                  scenario === 'interstitial-empty'
                    ? []
                    : [
                        { URI: prefix + 'missing.m3u8', DURATION: 4 },
                        { URI: prefix + 'ad.m3u8', DURATION: 4 },
                      ],
              }),
            );
            return;
          }
          if (resource === 'missing.m3u8') {
            res.writeHead(404);
            res.end();
            return;
          }
          if (resource === 'ad.m3u8') {
            if (scenario === 'interstitial-controls') {
              let master = await readFile(
                path.join(fixtures, 'renditions.m3u8'),
                'utf8',
              );
              master = master
                .replace(
                  /URI="([^\"]+)"/g,
                  (_, uri) => `URI="${origin}/fixture/${uri}"`,
                )
                .replace(/^(video-[^\n]+)$/gm, `${origin}/fixture/$1`)
                .replace(/AUDIO="audio"/g, 'AUDIO="audio",SUBTITLES="s"');
              master += `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",NAME="English",LANGUAGE="en",DEFAULT=NO,AUTOSELECT=YES,URI="${origin}/fixture/subtitles.m3u8"\n`;
              res.end(master);
              return;
            }
            let content =
              '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:2,\nsegment06.ts\n#EXTINF:2,\nsegment07.ts\n#EXT-X-ENDLIST\n';
            if (scenario === 'interstitial-nested')
              content = content.replace(
                '#EXTM3U\n',
                `#EXTM3U\n#EXT-X-PROGRAM-DATE-TIME:2026-01-02T03:04:00Z\n#EXT-X-DATERANGE:ID="nested",CLASS="com.apple.hls.interstitial",START-DATE="2026-01-02T03:04:00Z",CUE="PRE",X-ASSET-URI="${prefix}ad.m3u8"\n`,
              );
            if (scenario === 'interstitial-live-asset')
              content = content
                .replace('#EXT-X-PLAYLIST-TYPE:VOD\n', '')
                .replace('#EXT-X-ENDLIST\n', '');
            res.end(content);
            return;
          }
        }
        if (scenario === 'dateranges' && resource === 'index.m3u8') {
          const original = await readFile(
            path.join(fixtures, 'ts/index.m3u8'),
            'utf8',
          );
          const metadata =
            '#EXT-X-PROGRAM-DATE-TIME:2026-01-02T03:04:00Z\n' +
            '#EXT-X-DATERANGE:ID="pre",START-DATE="2026-01-02T03:04:00Z",CUE="PRE,ONCE"\n' +
            '#EXT-X-DATERANGE:ID="post",START-DATE="2026-01-02T03:04:00Z",CUE="POST"\n' +
            '#EXT-X-DATERANGE:ID="once",START-DATE="2026-01-02T03:04:01Z",DURATION=2,CUE="ONCE",SCTE35-OUT=0xfc0011\n' +
            '#EXT-X-DATERANGE:ID="again",START-DATE="2026-01-02T03:04:01Z",DURATION=2\n' +
            '#EXT-X-DATERANGE:ID="invalid",START-DATE="not-a-date"\n';
          res.end(original.replace('#EXTM3U\n', '#EXTM3U\n' + metadata));
          return;
        }
        if (scenario.startsWith('steering-')) {
          const origin =
            (req.socket.encrypted ? 'https' : 'http') +
            '://' +
            req.headers.host;
          const prefix = `${origin}/scenario/${match[1]}/${scenario}/`;
          if (resource === 'master.m3u8') {
            if (scenario === 'steering-abr') {
              const variants = ['a', 'b']
                .flatMap((id) =>
                  [
                    ['low', 500000, 'avc1.42c00c', '320x180'],
                    ['high', 1500000, 'avc1.42c01e', '640x360'],
                  ].map(
                    ([level, rate, codec, size]) =>
                      `#EXT-X-STREAM-INF:BANDWIDTH=${rate},CODECS="${codec}",RESOLUTION=${size},STABLE-VARIANT-ID="${level}",PATHWAY-ID="${id}"\n${id}/video-${level}/index.m3u8\n`,
                  ),
                )
                .join('');
              res.end(
                '#EXTM3U\n#EXT-X-CONTENT-STEERING:SERVER-URI="steering.json",PATHWAY-ID="a"\n' +
                  variants,
              );
              return;
            }
            if (scenario === 'steering-audio') {
              const tracks = ['a', 'b']
                .map(
                  (id) =>
                    ['en', 'es']
                      .map(
                        (lang, i) =>
                          `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio-${id}",NAME="${lang}-${id}",LANGUAGE="${lang}",DEFAULT=${i ? 'NO' : 'YES'},AUTOSELECT=YES,STABLE-RENDITION-ID="audio-${lang}",URI="${id}/audio-${lang}/index.m3u8"\n`,
                      )
                      .join('') +
                    `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs-${id}",NAME="English",LANGUAGE="en",AUTOSELECT=YES,STABLE-RENDITION-ID="subs-en",URI="${id}/subtitles.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=500000,CODECS="avc1.42c00c,mp4a.40.2",STABLE-VARIANT-ID="main",PATHWAY-ID="${id}",AUDIO="audio-${id}",SUBTITLES="subs-${id}"\n${id}/video-low/index.m3u8\n`,
                )
                .join('');
              res.end(
                '#EXTM3U\n#EXT-X-CONTENT-STEERING:SERVER-URI="steering.json",PATHWAY-ID="a"\n' +
                  tracks,
              );
              return;
            }

            res.end(
              '#EXTM3U\n#EXT-X-CONTENT-STEERING:SERVER-URI="steering.json",PATHWAY-ID="a"\n' +
                ['a', 'b']
                  .map(
                    (id) =>
                      '#EXT-X-STREAM-INF:BANDWIDTH=900000,CODECS="avc1.42c00c,mp4a.40.2",STABLE-VARIANT-ID="main",PATHWAY-ID="' +
                      id +
                      '"\n' +
                      id +
                      '/index.m3u8\n',
                  )
                  .join(''),
            );
            return;
          }
          if (resource === 'steering.json') {
            if (scenario === 'steering-gone') {
              res.writeHead(410);
              res.end();
              return;
            }
            if (scenario === 'steering-malformed' && count > 1) {
              res.end('{bad');
              return;
            }
            const target = scenario === 'steering-clone' ? 'c' : 'b';
            const priority =
              count > 1 &&
              ![
                'steering-failover',
                'steering-initial',
                'steering-first-media',
              ].includes(scenario)
                ? [target, 'a']
                : ['a', 'b'];
            const manifest = {
              VERSION: 1,
              TTL: 2,
              'PATHWAY-PRIORITY': priority,
            };
            if (scenario === 'steering-clone')
              manifest['PATHWAY-CLONES'] = [
                {
                  'BASE-ID': 'a',
                  ID: 'c',
                  'URI-REPLACEMENT': {
                    'PER-VARIANT-URIS': { main: prefix + 'c/index.m3u8' },
                  },
                },
              ];
            res.setHeader(
              'Content-Type',
              'application/vnd.apple.steering-list',
            );
            res.end(JSON.stringify(manifest));
            return;
          }
          const media = /^([abc])\/(.+)$/.exec(resource);
          if (media) {
            if (
              media[1] === 'a' &&
              ((scenario === 'steering-initial' && media[2] === 'index.m3u8') ||
                (scenario === 'steering-first-media' &&
                  media[2] === 'segment00.ts'))
            ) {
              res.writeHead(503);
              res.end();
              return;
            }
            requests.set(
              match[1] + ':pathway:' + media[1],
              (requests.get(match[1] + ':pathway:' + media[1]) ?? 0) + 1,
            );
            if (
              scenario === 'steering-failover' &&
              media[1] === 'a' &&
              media[2] === 'segment03.ts'
            ) {
              res.writeHead(503);
              res.end();
              return;
            }
            relative = ['steering-audio', 'steering-abr'].includes(scenario)
              ? media[2]
              : 'ts/' + media[2];
          }
        }
        if (scenario.startsWith('ll-av')) {
          llAvInventory ??= JSON.parse(
            await readFile(path.join(fixtures, 'll-av/inventory.json'), 'utf8'),
          );
          relative = 'll-av/' + resource;
          const key = match[1];
          if (!starts.has(key)) starts.set(key, Date.now());
          const epoch = starts.get(key);
          if (resource === 'index.m3u8') {
            res.end(
              '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Tone",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="audio/index.m3u8"\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Alternate",LANGUAGE="bg",DEFAULT=NO,AUTOSELECT=YES,URI="audio2/index.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=700000,CODECS="avc1.42c00c,mp4a.40.2",AUDIO="a"\nvideo/index.m3u8\n',
            );
            return;
          }
          const lane = resource.split('/')[0];
          if (!['video', 'audio', 'audio2'].includes(lane)) {
            res.writeHead(404);
            res.end();
            return;
          }
          const inventory = llAvInventory[lane];
          const sequenceBase =
            lane === 'audio' ? 1000 : lane === 'audio2' ? 5000 : 0;
          const lag = scenario === 'll-av-lag' && lane === 'audio' ? 500 : 0;
          const available = () =>
            Math.max(0, (Date.now() - epoch + 1000 - lag) / 1000);
          if (resource.endsWith('/index.m3u8')) {
            const firstWait = Math.max(
              0,
              (inventory.parts[0].duration - available()) * 1000,
            );
            if (firstWait)
              await new Promise((resolve) =>
                setTimeout(resolve, firstWait + 1),
              );
            if (res.destroyed) return;
            if (url.searchParams.has('_HLS_msn')) {
              const wanted =
                (Number(url.searchParams.get('_HLS_msn')) - sequenceBase) * 4 +
                Number(url.searchParams.get('_HLS_part') ?? 3);
              const target = inventory.parts[wanted];
              if (target) {
                const wait = Math.max(
                  0,
                  (target.start + target.duration - available()) * 1000,
                );
                if (wait)
                  await new Promise((resolve) => {
                    const timer = setTimeout(resolve, Math.min(wait, 6000));
                    res.once('close', () => {
                      clearTimeout(timer);
                      resolve();
                    });
                  });
              }
              if (res.destroyed) return;
              requests.set(
                key + ':' + lane + ':blocking',
                (requests.get(key + ':' + lane + ':blocking') ?? 0) + 1,
              );
            }
            const count = inventory.parts.filter(
              (p) => p.start + p.duration <= available() + 0.0001,
            ).length;
            const completed = Math.min(
              inventory.parents.length,
              Math.floor(count / 4),
            );
            const first = Math.max(0, completed - 4);
            let text = `#EXTM3U\n#EXT-X-VERSION:9\n#EXT-X-TARGETDURATION:3\n#EXT-X-MEDIA-SEQUENCE:${sequenceBase + first}\n#EXT-X-MAP:URI="init.mp4"\n#EXT-X-PART-INF:PART-TARGET=${lane !== 'video' ? 0.512 : 0.5}\n#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES,PART-HOLD-BACK=1.6\n`;
            for (let parent = first; parent <= completed; parent++) {
              const partStart = parent * 4;
              if (!inventory.parts[partStart] || partStart >= count) break;
              text +=
                '#EXT-X-PROGRAM-DATE-TIME:' +
                new Date(
                  Date.UTC(2026, 0, 2) +
                    inventory.parts[partStart].start * 1000,
                ).toISOString() +
                '\n';
              for (
                let part = partStart;
                part < Math.min(count, partStart + 4);
                part++
              ) {
                const p = inventory.parts[part];
                text += `#EXT-X-PART:DURATION=${p.duration},URI="${p.file}"${lane !== 'video' || part % 4 === 0 ? ',INDEPENDENT=YES' : ''}\n`;
              }
              if (parent < completed)
                text += `#EXTINF:${inventory.parents[parent].duration},\n${inventory.parents[parent].file}\n`;
            }
            if (inventory.parts[count])
              text += `#EXT-X-PRELOAD-HINT:TYPE=PART,URI="${inventory.parts[count].file}"\n`;
            for (const peer of ['video', 'audio', 'audio2'].filter(
              (p) => p !== lane,
            )) {
              const peerAvailable =
                (Date.now() -
                  epoch +
                  1000 -
                  (scenario === 'll-av-lag' && peer === 'audio' ? 500 : 0)) /
                1000;
              const peerParts = llAvInventory[peer].parts.filter(
                (p) => p.start + p.duration <= peerAvailable,
              ).length;
              if (peerParts)
                text += `#EXT-X-RENDITION-REPORT:URI="../${peer}/index.m3u8",LAST-MSN=${(peer === 'audio' ? 1000 : peer === 'audio2' ? 5000 : 0) + Math.floor((peerParts - 1) / 4)},LAST-PART=${(peerParts - 1) % 4}\n`;
            }
            res.end(text);
            return;
          }
          const part = inventory.parts.find(
            (p) => resource === lane + '/' + p.file,
          );
          if (part) {
            const wait = Math.max(
              0,
              (part.start + part.duration - available()) * 1000,
            );
            if (wait)
              await new Promise((resolve) => {
                const timer = setTimeout(resolve, Math.min(wait, 6000));
                res.once('close', () => {
                  clearTimeout(timer);
                  resolve();
                });
              });
            if (res.destroyed) return;
            if (
              scenario === 'll-av-fault' &&
              resource === 'audio/part008.m4s' &&
              count < 3
            ) {
              res.writeHead(503);
              res.end('temporary audio fault');
              return;
            }
          }
        }
        if (scenario.startsWith('ll-parts')) {
          relative = 'll-parts/' + resource;
          const aged = scenario.startsWith('ll-parts-age');
          const gcm = scenario === 'll-parts-gcm-range';
          const encrypted = scenario.startsWith('ll-parts-encrypted') || gcm;
          const rangeParts =
            scenario === 'll-parts-open' ||
            scenario === 'll-parts-encrypted-range' ||
            gcm;
          const key = match[1];
          if (!starts.has(key)) starts.set(key, Date.now() - (aged ? 6000 : 0));
          const epoch = starts.get(key);
          const waitFor = async (index) => {
            const wait = Math.max(0, epoch + (index - 1) * 500 - Date.now());
            if (wait)
              await new Promise((resolve) => {
                const timer = setTimeout(resolve, Math.min(wait, 6000));
                res.on('close', () => {
                  clearTimeout(timer);
                  resolve();
                });
              });
          };
          if (resource === 'index.m3u8') {
            if (aged) {
              res.setHeader('Access-Control-Expose-Headers', 'Age');
              res.setHeader(
                'Age',
                scenario === 'll-parts-age-invalid'
                  ? 'invalid'
                  : !url.searchParams.has('_HLS_msn') && count === 1
                    ? '6'
                    : '0',
              );
              if (
                scenario === 'll-parts-age-reject' &&
                url.searchParams.has('_HLS_msn') &&
                !requests.get(key + ':age-rejected')
              ) {
                requests.set(key + ':age-rejected', 1);
                res.writeHead(400);
                res.end('directive rejected');
                return;
              }
            }
            if (url.searchParams.has('_HLS_msn')) {
              requests.set(
                key + ':parts-blocking',
                (requests.get(key + ':parts-blocking') ?? 0) + 1,
              );
              await waitFor(
                Number(url.searchParams.get('_HLS_msn')) * 4 +
                  Number(url.searchParams.get('_HLS_part') ?? 3),
              );
              if (res.destroyed) return;
            }
            const cached =
              aged && count === 1 && !url.searchParams.has('_HLS_msn');
            const countParts = cached
              ? 2
              : 2 + Math.floor((Date.now() - epoch) / 500);
            const completed = Math.floor(countParts / 4),
              first = Math.max(0, completed - 4);
            let text =
              '#EXTM3U\n#EXT-X-VERSION:9\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:' +
              first +
              '\n#EXT-X-DISCONTINUITY-SEQUENCE:' +
              Math.floor(first / 6) +
              '\n#EXT-X-MAP:URI="init.mp4"\n#EXT-X-PART-INF:PART-TARGET=0.5\n#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES,PART-HOLD-BACK=1.5\n';
            if (scenario === 'll-parts-map' && first >= 2)
              text = text.replace('init.mp4', 'init2.mp4');
            for (let parent = first; parent <= completed; parent++) {
              if (scenario === 'll-parts-map' && parent === 2)
                text += '#EXT-X-MAP:URI="init2.mp4"\n';
              if (encrypted)
                text += gcm
                  ? '#EXT-X-KEY:METHOD=AES-256-GCM,URI="part.key"\n'
                  : '#EXT-X-KEY:METHOD=AES-128,URI="part.key",IV=0x' +
                    parent.toString(16).padStart(32, '0') +
                    '\n';
              if (parent > first && parent % 6 === 0)
                text += '#EXT-X-DISCONTINUITY\n';
              const n = parent === completed ? countParts % 4 : 4;
              if (parent >= completed - 3)
                for (let part = 0; part < n; part++) {
                  const index = parent * 4 + part;
                  text +=
                    '#EXT-X-PART:DURATION=0.5,URI="part' +
                    String(index % 24).padStart(2, '0') +
                    '.m4s?index=' +
                    index +
                    '"' +
                    (rangeParts
                      ? ',BYTERANGE="' +
                        (await (async () => {
                          const size = (
                            await readFile(
                              path.join(
                                fixtures,
                                'll-parts',
                                'part' +
                                  String(index % 24).padStart(2, '0') +
                                  '.m4s',
                              ),
                            )
                          ).length;
                          return gcm
                            ? size + 32
                            : encrypted
                              ? (Math.floor(size / 16) + 1) * 16
                              : size;
                        })()) +
                        '@128"'
                      : '') +
                    (part === 0 ? ',INDEPENDENT=YES' : '') +
                    '\n';
                }
              if (parent < completed)
                text +=
                  '#EXTINF:2,\nparent' +
                  (parent % 6) +
                  '.m4s?sequence=' +
                  parent +
                  '\n';
            }
            if (scenario === 'll-parts-cancel' && countParts % 5 === 0)
              text +=
                '#EXT-X-PRELOAD-HINT:TYPE=PART,URI="abandoned.m4s?index=' +
                countParts +
                '"\n';
            else
              text +=
                '#EXT-X-PRELOAD-HINT:TYPE=PART,URI="part' +
                String(countParts % 24).padStart(2, '0') +
                '.m4s?index=' +
                countParts +
                '"\n';
            if (scenario === 'll-parts-map' && completed < 2)
              text += '#EXT-X-PRELOAD-HINT:TYPE=MAP,URI="init2.mp4"\n';
            if (rangeParts)
              text = text.replace(
                /(#EXT-X-PRELOAD-HINT:TYPE=PART[^\n]*)/,
                '$1,BYTERANGE-START=128',
              );
            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
            res.end(text);
            return;
          }
          if (resource === 'init2.mp4') {
            res.end(
              await readFile(path.join(fixtures, 'll-parts', 'init.mp4')),
            );
            return;
          }
          if (resource === 'part.key') {
            res.end(Buffer.alloc(gcm ? 32 : 16, 0x59));
            return;
          }
          if (resource === 'abandoned.m4s') {
            await waitFor(Number(url.searchParams.get('index')) + 3);
            if (!res.destroyed) {
              res.writeHead(404);
              res.end();
            }
            return;
          }
          if (resource.startsWith('part')) {
            const id = key + ':part:' + url.searchParams.get('index');
            requests.set(id, (requests.get(id) ?? 0) + 1);
            await waitFor(Number(url.searchParams.get('index')));
            if (res.destroyed) return;
            let bytes = await readFile(
              path.join(fixtures, 'll-parts', resource),
            );
            if (encrypted) {
              const iv = Buffer.alloc(16);
              iv.writeUInt32BE(
                gcm
                  ? Number(url.searchParams.get('index'))
                  : Math.floor(Number(url.searchParams.get('index')) / 4),
                12,
              );
              const cipher = createCipheriv(
                gcm ? 'aes-256-gcm' : 'aes-128-cbc',
                Buffer.alloc(gcm ? 32 : 16, 0x59),
                iv,
              );
              const payload = Buffer.concat([
                cipher.update(bytes),
                cipher.final(),
              ]);
              bytes = gcm
                ? Buffer.concat([iv, payload, cipher.getAuthTag()])
                : payload;
              if (!rangeParts) {
                res.end(bytes);
                return;
              }
            }
            if (rangeParts) {
              const open = req.headers.range === 'bytes=128-9007199254740991';
              if (!req.headers.range?.startsWith('bytes=128-'))
                throw Error('Expected byte range');
              res.writeHead(206, {
                'Content-Range': `bytes 128-${127 + bytes.length}/*`,
                'Content-Type': 'video/mp4',
              });
              if (open) {
                res.write(bytes.subarray(0, Math.floor(bytes.length / 2)));
                const next = setTimeout(() => {
                  if (!res.destroyed)
                    res.write(bytes.subarray(Math.floor(bytes.length / 2)));
                }, 30);
                const finish = setTimeout(() => res.end(), 4000);
                res.on('close', () => {
                  clearTimeout(next);
                  clearTimeout(finish);
                });
              } else res.end(bytes);
              return;
            }
          }
        }
        if (
          !scenario.startsWith('ll-parts') &&
          scenario.startsWith('ll-') &&
          resource === 'index.m3u8'
        ) {
          const key = match[1];
          if (!starts.has(key)) starts.set(key, Date.now());
          const epoch = starts.get(key);
          const requested = Number(url.searchParams.get('_HLS_msn'));
          if (url.searchParams.has('_HLS_msn')) {
            requests.set(
              key + ':blocking',
              (requests.get(key + ':blocking') ?? 0) + 1,
            );
            if (scenario === 'll-reject') {
              res.writeHead(400);
              res.end();
              return;
            }
            const wait = Math.max(
              0,
              epoch + (requested - 7) * 2000 - Date.now(),
            );
            if (wait > 0) {
              requests.set(
                key + ':waited',
                (requests.get(key + ':waited') ?? 0) + 1,
              );
              await new Promise((resolve) => {
                const timer = setTimeout(resolve, Math.min(wait, 6000));
                res.on('close', () => {
                  clearTimeout(timer);
                  resolve();
                });
              });
              if (res.destroyed) return;
            }
          }
          const first = Math.floor((Date.now() - epoch) / 2000);
          let skip = ['YES', 'v2'].includes(url.searchParams.get('_HLS_skip'))
            ? 2
            : 0;
          if (skip)
            requests.set(
              key + ':delta',
              (requests.get(key + ':delta') ?? 0) + 1,
            );
          if (skip && scenario === 'll-missing') skip = 9;
          res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
          res.end(
            '#EXTM3U\n#EXT-X-VERSION:9\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:' +
              first +
              '\n#EXT-X-DISCONTINUITY-SEQUENCE:' +
              Math.floor(first / 9) +
              '\n#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES,CAN-SKIP-UNTIL=12' +
              (scenario.startsWith('ll-dates')
                ? ',CAN-SKIP-DATERANGES=YES'
                : '') +
              '\n' +
              (skip
                ? '#EXT-X-SKIP:SKIPPED-SEGMENTS=' +
                  skip +
                  (scenario === 'll-dates'
                    ? ',RECENTLY-REMOVED-DATERANGES="' +
                      (first >= 2 ? 'old' : '') +
                      '"'
                    : '') +
                  '\n'
                : '') +
              (scenario.startsWith('ll-dates')
                ? '#EXT-X-PROGRAM-DATE-TIME:' +
                  new Date(
                    Date.parse('2026-01-02T03:04:00Z') + (first + skip) * 2000,
                  ).toISOString() +
                  '\n' +
                  (first < 2 && !skip
                    ? '#EXT-X-DATERANGE:ID="old",START-DATE="2026-01-02T03:04:00Z",DURATION=1\n'
                    : '') +
                  '#EXT-X-DATERANGE:ID="persist",START-DATE="2026-01-02T03:04:10Z"' +
                  (first >= 1 ? ',DURATION=4' : '') +
                  '\n'
                : '') +
              Array.from({ length: Math.max(1, 8 - skip) }, (_, i) => {
                const n = first + skip + i;
                return (
                  (i + skip && n % 9 === 0 ? '#EXT-X-DISCONTINUITY\n' : '') +
                  '#EXTINF:2,\nsegment' +
                  String(n % 9).padStart(2, '0') +
                  '.ts?sequence=' +
                  n +
                  '\n'
                );
              }).join(''),
          );
          return;
        }

        if (scenario === 'soak' && resource === 'index.m3u8') {
          const key = match[1];
          if (!starts.has(key)) starts.set(key, Date.now());
          const first = Math.floor((Date.now() - starts.get(key)) / 2000);
          res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
          res.end(
            '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:' +
              first +
              '\n#EXT-X-DISCONTINUITY-SEQUENCE:' +
              Math.floor(first / 9) +
              '\n' +
              Array.from({ length: 6 }, (_, i) => {
                const n = first + i;
                return (
                  (i && n % 9 === 0 ? '#EXT-X-DISCONTINUITY\n' : '') +
                  '#EXTINF:2,\nsegment' +
                  String(n % 9).padStart(2, '0') +
                  '.ts?sequence=' +
                  n +
                  '\n'
                );
              }).join(''),
          );
          return;
        }

        if (scenario === 'restart-audio') {
          relative = resource === 'index.m3u8' ? 'renditions.m3u8' : resource;
          if (resource.endsWith('.m3u8')) {
            let data = await readFile(path.join(root, relative), 'utf8');
            if (resource !== 'index.m3u8') {
              const key = match[1];
              if (resource.startsWith('video-') && count >= 3)
                epochs.set(key, true);
              const restarted = epochs.has(key);
              data = data
                .replace('#EXT-X-ENDLIST', '')
                .replace(
                  /#EXT-X-MEDIA-SEQUENCE:\d+/,
                  '#EXT-X-MEDIA-SEQUENCE:' + (restarted ? 0 : 10),
                );
              data = data
                .split('\n')
                .map((line) =>
                  line && !line.startsWith('#')
                    ? line + '?epoch=' + (restarted ? 'new' : 'old')
                    : line,
                )
                .join('\n');
            }
            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
            res.end(data);
            return;
          }
        }

        if (
          resource === 'index.m3u8' &&
          [
            'restart',
            'restart-paused',
            'window-jump',
            'stale-resume',
            'stale-terminal',
          ].includes(scenario)
        ) {
          let first = 0,
            sequence = 10,
            epoch = 'old';
          if (scenario.startsWith('restart') && count >= 3) {
            sequence = 0;
            epoch = 'new';
          }
          if (scenario === 'window-jump' && count >= 3) {
            sequence = 30;
            epoch = 'new';
          }
          if (scenario === 'stale-resume' && count >= 4) {
            first = 1;
            sequence = 11;
          }
          res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
          res.end(
            '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:' +
              sequence +
              '\n' +
              Array.from(
                { length: 5 },
                (_, i) =>
                  '#EXTINF:2,\nsegment' +
                  String(first + i).padStart(2, '0') +
                  '.ts?epoch=' +
                  epoch +
                  '\n',
              ).join(''),
          );
          return;
        }

        if (scenario === 'gap' && resource === 'index.m3u8') {
          const data = (await readFile(path.join(root, relative), 'utf8'))
            .replace('segment03.ts', '#EXT-X-GAP\nsegment03.ts')
            .replace('segment04.ts', '#EXT-X-GAP\nsegment04.ts');
          res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
          res.end(data);
          return;
        }

        if (scenario === 'forbidden') {
          res.writeHead(403);
          res.end();
          return;
        }
        if (segment && scenario === 'missing') {
          res.writeHead(404);
          res.end();
          return;
        }
        if (segment && count <= 3) {
          if (scenario === 'http-outage') {
            res.writeHead(503);
            res.end();
            return;
          }
          if (scenario === 'disconnect') {
            res.writeHead(200, { 'Content-Length': '10000' });
            res.write(Buffer.alloc(100));
            const timer = setTimeout(() => res.destroy(), 30);
            res.on('close', () => clearTimeout(timer));
            return;
          }
          if (scenario === 'timeout') {
            return;
          } // Client timeout closes the response.
        }
        if (scenario === 'playlist-outage' && resource === 'index.m3u8') {
          if (count >= 2 && count <= 4) {
            res.writeHead(503);
            res.end();
            return;
          }
          const data = (
            await readFile(path.join(root, relative), 'utf8')
          ).replace('#EXT-X-ENDLIST', '');
          res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
          res.end(data);
          return;
        }
      }
      const file = path.resolve(root, relative);
      if (!file.startsWith(path.resolve(root) + path.sep)) {
        res.writeHead(403);
        res.end();
        return;
      }
      const data = await readFile(file);
      res.setHeader(
        'Content-Type',
        file.endsWith('.css')
          ? 'text/css'
          : file.endsWith('.js')
            ? 'text/javascript'
            : file.endsWith('.m3u8')
              ? 'application/vnd.apple.mpegurl'
              : 'application/octet-stream',
      );
      const rangeHeader = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
      if (rangeHeader) {
        const start = Number(rangeHeader[1]),
          end = Math.min(
            data.length - 1,
            rangeHeader[2] ? Number(rangeHeader[2]) : data.length - 1,
          );
        if (
          !Number.isSafeInteger(start) ||
          start > end ||
          start >= data.length
        ) {
          res.writeHead(416, { 'Content-Range': `bytes */${data.length}` });
          res.end();
          return;
        }
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${data.length}`,
          'Content-Length': end - start + 1,
        });
        res.end(data.subarray(start, end + 1));
        return;
      }
      res.end(data);
    } catch {
      if (!res.headersSent) res.writeHead(404);
      res.end();
    }
  });
  return { server, requests };
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { server } = faultServer();
  const port = Number(process.env.PORT ?? 9088);
  server.listen(port, process.env.HOST ?? '127.0.0.1', () =>
    console.log(`ThePlayer HLS fault server listening on ${port}`),
  );
}
