import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

/** Isolated scenario namespaces: deterministic faults, no administrative HTTP API. */
export function faultServer({
  fixtures = process.env.THEPLAYER_HLS_FIXTURES ??
    path.join(os.tmpdir(), 'theplayer-hls-fixtures'),
  dist = fileURLToPath(new URL('../../dist/', import.meta.url)),
} = {}) {
  const requests = new Map();
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
      if (match) {
        const [, , scenario, resource] = match;
        root = fixtures;
        relative = 'ts/' + resource;
        const count = (requests.get(url.pathname) ?? 0) + 1;
        requests.set(url.pathname, count);
        const segment = resource === 'segment03.ts';
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
