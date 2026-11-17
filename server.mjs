import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { json, serveFile, tlsServer, remoteJson } from './demo/http.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
let config;
try {
  config = JSON.parse(
    await readFile(
      process.env.MOQ_PLAYER_CONFIG ?? path.join(here, 'settings.json'),
      'utf8',
    ),
  );
} catch (error) {
  if (error.code !== 'ENOENT' || process.env.MOQ_PLAYER_CONFIG) throw error;
  config = { webHost: '127.0.0.1', webPort: 5173 };
}
const server = await tlsServer(config, async (req, res) => {
  const u = new URL(req.url, 'https://localhost');
  if (req.method !== 'GET')
    return json(res, { error: 'Method not allowed' }, 405);
  if (u.pathname === '/api/directory') {
    if (!config.relayDirectoryUrl)
      return json(res, { channels: [], error: 'No default relay configured' });
    try {
      return json(
        res,
        await remoteJson(config.relayDirectoryUrl, config.relayTrustPem),
      );
    } catch (e) {
      return json(res, { channels: [], error: e.message }, 502);
    }
  }
  const files = {
    '/': 'index.html',
    '/embed.html': 'embed.html',
    '/app.js': 'app.js',
    '/player.js': 'player.js',
    '/core.js': 'core.js',
    '/style.css': 'style.css',
    '/version.json': 'version.json',
  };
  if (/^\/(?:chunks\/[a-zA-Z0-9_-]+|hls)\.js$/.test(u.pathname))
    return serveFile(res, path.join(here, 'dist', u.pathname.slice(1)));
  if (files[u.pathname])
    return serveFile(res, path.join(here, 'dist', files[u.pathname]));
  if (u.pathname === '/healthz')
    return json(res, { role: 'demo-player', state: 'ready' });
  return json(res, { error: 'Not found' }, 404);
});
process.on('SIGTERM', () => server.close(() => process.exit()));
