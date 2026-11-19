// Optional live-relay integration test. No private source URLs or media in fixtures.
import { webkit } from 'playwright';
import assert from 'node:assert/strict';
import { faultServer } from './helpers/hls-fault-server.mjs';
const relayUrl = process.env.MOQ_TEST_RELAY;
const namespace = process.env.MOQ_TEST_NAMESPACE;
if (!relayUrl || !namespace)
  throw new Error(
    'Set MOQ_TEST_RELAY and MOQ_TEST_NAMESPACE to a compatible live relay',
  );
const { server } = faultServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await webkit.launch();
const deadline = setTimeout(() => {
  console.error('MoQ WebSocket playback watchdog');
  process.exit(1);
}, 90000);
try {
  const page = await browser.newPage({
    ignoreHTTPSErrors: process.env.MOQ_TEST_INSECURE_TLS === '1',
  });
  await page.addInitScript(() =>
    Object.defineProperty(window, 'MediaSource', { value: undefined }),
  );
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/harness.html`);
  await page.evaluate(
    async (source) => {
      const { ThePlayer } = await import('/player.js');
      window.originalRemotePlayback =
        document.querySelector('video').disableRemotePlayback;
      window.player = new ThePlayer(document.querySelector('video'));
      window.errors = [];
      player.addEventListener('error', (e) => errors.push(String(e.detail)));
      void player.load(source).catch((e) => errors.push(String(e)));
    },
    { protocol: 'moq', relayUrl, namespace },
  );
  await page.waitForFunction(
    () =>
      window.errors.length ||
      document.querySelector('video').getVideoPlaybackQuality()
        .totalVideoFrames > 60,
    null,
    { timeout: 45000 },
  );
  assert.deepEqual(await page.evaluate(() => errors), []);
  const before = await page
    .locator('video')
    .evaluate((v) => v.getVideoPlaybackQuality().totalVideoFrames);
  await page.waitForTimeout(15000);
  const result = await page.evaluate(() => ({
    transport: player.diagnostics.transport,
    frames: document.querySelector('video').getVideoPlaybackQuality()
      .totalVideoFrames,
    errors,
  }));
  assert.equal(result.transport, 'websocket');
  assert.ok(result.frames > before + 100);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(pageErrors, []);
  await page.evaluate(() => player.destroy());
  assert.equal(
    await page.locator('video').evaluate((v) => v.disableRemotePlayback),
    await page.evaluate(() => originalRemotePlayback),
  );
  console.log(
    'MoQ WebSocket + ManagedMediaSource decoded playback and cleanup PASS',
    { frames: result.frames },
  );
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
  clearTimeout(deadline);
}
