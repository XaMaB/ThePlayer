import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { faultServer } from './helpers/hls-fault-server.mjs';
const seconds = Number(process.env.HLS_SOAK_SECONDS ?? 60);
if (!Number.isFinite(seconds) || seconds < 30)
  throw new Error('HLS_SOAK_SECONDS must be at least 30');
const { server } = faultServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base =
  process.env.HLS_RECOVERY_BASE ?? `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  headless: true,
  args: [
    '--no-sandbox',
    '--autoplay-policy=no-user-gesture-required',
    '--enable-precise-memory-info',
  ],
});
const snapshots = [],
  errors = [];
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base + '/harness.html');
  await page.evaluate(
    async (url) => {
      const { ThePlayer } = await import('/player.js');
      window.player = new ThePlayer(document.querySelector('video'));
      window.failures = [];
      window.player.addEventListener('error', (e) =>
        window.failures.push(String(e.detail)),
      );
      await window.player.load({ protocol: 'hls', url, targetBuffer: 4 });
    },
    base + '/scenario/soak-' + Date.now().toString(36) + '/soak/index.m3u8',
  );
  await page.waitForFunction(
    () => document.querySelector('video').currentTime > 0,
  );
  const started = Date.now();
  let last = -1;
  while (Date.now() - started < seconds * 1000) {
    await new Promise((r) => setTimeout(r, 5000));
    const sample = await page.evaluate(() => {
      const v = document.querySelector('video'),
        q = v.getVideoPlaybackQuality();
      return {
        time: v.currentTime,
        state: window.player.diagnostics.state,
        frames: q.totalVideoFrames,
        dropped: q.droppedVideoFrames,
        buffer: window.player.diagnostics.buffer.ahead,
        heap: performance.memory?.usedJSHeapSize,
        errors: window.failures,
        live: window.player.diagnostics.live,
      };
    });
    snapshots.push({ elapsed: (Date.now() - started) / 1000, ...sample });
    assert.deepEqual(sample.errors, []);
    assert.deepEqual(errors, []);
    assert.ok(
      sample.time > last + 1,
      'Live clock must advance across repeated timestamp resets',
    );
    assert.ok(sample.buffer < 20, 'Buffer must remain bounded');
    last = sample.time;
    if (snapshots.length % 12 === 0)
      console.log('SOAK', JSON.stringify(snapshots.at(-1)));
  }
  await page.evaluate(() => window.player.destroy());
  console.log('PASS live soak', seconds, 'seconds', snapshots.at(-1));
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await mkdir(new URL('../test-results/', import.meta.url), {
    recursive: true,
  });
  await writeFile(
    new URL('../test-results/hls-soak.json', import.meta.url),
    JSON.stringify({ seconds, snapshots, errors }, null, 2),
  );
}
