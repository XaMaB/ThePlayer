import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
const temp = await mkdtemp(path.join(os.tmpdir(), 'theplayer-server-'));
let server;
try {
  const config = path.join(temp, 'settings.json');
  await writeFile(config, JSON.stringify({ webHost: '127.0.0.1', webPort: 0 }));
  process.env.MOQ_PLAYER_CONFIG = config;
  ({ server } = await import('../server.mjs'));
  if (!server.listening) await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const file of ['dash.js', 'hls.js', 'player.js', 'core.js']) {
    const response = await fetch(base + '/' + file);
    assert.equal(response.status, 200, file);
    assert.match(response.headers.get('content-type'), /javascript/);
    assert.ok((await response.text()).length > 100);
  }
  assert.equal((await fetch(base + '/settings.json')).status, 404);
  console.log(
    'Demo server serves DASH/HLS/core modules and keeps settings private PASS',
  );
} finally {
  if (server) await new Promise((r) => server.close(r));
  await rm(temp, { recursive: true, force: true });
}
