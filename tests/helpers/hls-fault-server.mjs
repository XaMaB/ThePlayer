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
        if (scenario.startsWith('ll-parts')) {
          relative = 'll-parts/' + resource;
          const key = match[1];
          if (!starts.has(key)) starts.set(key, Date.now());
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
            const count = 2 + Math.floor((Date.now() - epoch) / 500);
            const completed = Math.floor(count / 4),
              first = Math.max(0, completed - 4);
            let text =
              '#EXTM3U\n#EXT-X-VERSION:9\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:' +
              first +
              '\n#EXT-X-DISCONTINUITY-SEQUENCE:' +
              Math.floor(first / 6) +
              '\n#EXT-X-MAP:URI="init.mp4"\n#EXT-X-PART-INF:PART-TARGET=0.5\n#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES,PART-HOLD-BACK=1.5\n';
            for (let parent = first; parent <= completed; parent++) {
              if (parent > first && parent % 6 === 0)
                text += '#EXT-X-DISCONTINUITY\n';
              const n = parent === completed ? count % 4 : 4;
              if (parent >= completed - 3)
                for (let part = 0; part < n; part++) {
                  const index = parent * 4 + part;
                  text +=
                    '#EXT-X-PART:DURATION=0.5,URI="part' +
                    String(index % 24).padStart(2, '0') +
                    '.m4s?index=' +
                    index +
                    '"' +
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
            if (scenario === 'll-parts-cancel' && count % 5 === 0)
              text +=
                '#EXT-X-PRELOAD-HINT:TYPE=PART,URI="abandoned.m4s?index=' +
                count +
                '"\n';
            else
              text +=
                '#EXT-X-PRELOAD-HINT:TYPE=PART,URI="part' +
                String(count % 24).padStart(2, '0') +
                '.m4s?index=' +
                count +
                '"\n';
            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
            res.end(text);
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
          let skip = url.searchParams.get('_HLS_skip') === 'YES' ? 2 : 0;
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
              '\n#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES,CAN-SKIP-UNTIL=12\n' +
              (skip ? '#EXT-X-SKIP:SKIPPED-SEGMENTS=' + skip + '\n' : '') +
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
        file.endsWith('.js')
          ? 'text/javascript'
          : file.endsWith('.m3u8')
            ? 'application/vnd.apple.mpegurl'
            : 'application/octet-stream',
      );
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
