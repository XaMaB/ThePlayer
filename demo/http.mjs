import { readFile } from 'node:fs/promises';
import {
  createServer as httpsServer,
  request as httpsRequest,
} from 'node:https';
import { createServer as httpServer, request as httpRequest } from 'node:http';
export function json(res, data, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(data));
}
export async function serveFile(res, file) {
  const data = await readFile(file);
  res.writeHead(200, {
    'Content-Type': file.endsWith('.js')
      ? 'text/javascript'
      : file.endsWith('.css')
        ? 'text/css'
        : 'text/html',
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(data);
}
export function remoteJson(url, ca) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = (u.protocol === 'https:' ? httpsRequest : httpRequest)(
      u,
      { ca: ca || undefined, timeout: 4000 },
      (res) => {
        let s = '';
        res.on('data', (d) => {
          s += d;
          if (s.length > 2 * 1024 * 1024)
            req.destroy(new Error('Response too large'));
        });
        res.on('end', () => {
          try {
            if (res.statusCode !== 200)
              throw new Error(`HTTP ${res.statusCode}`);
            resolve(JSON.parse(s));
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('Request timed out')));
    req.on('error', reject);
    req.end();
  });
}
export async function tlsServer(config, handle) {
  const listener = (req, res) =>
    Promise.resolve(handle(req, res)).catch((e) =>
      json(res, { error: e.message }, e.status ?? 500),
    );
  const server =
    config.cert && config.key
      ? httpsServer(
          {
            cert: await readFile(config.cert),
            key: await readFile(config.key),
          },
          listener,
        )
      : httpServer(listener);
  server.listen(config.webPort, config.webHost ?? '127.0.0.1');
  return server;
}
