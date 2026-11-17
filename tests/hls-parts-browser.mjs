import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { faultServer } from './helpers/hls-fault-server.mjs';
const { server, requests } = faultServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base =
  process.env.HLS_RECOVERY_BASE ?? `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
});
try {
  for (const transport of ['fetch', 'xhr'])
    for (const scenario of ['ll-parts', 'll-parts-cancel']) {
      const id = `parts-${transport}-${scenario}-${Date.now().toString(36)}`;
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(base + '/harness.html');
      const started = Date.now();
      await page.evaluate(
        async ({ url, transport }) => {
          const { ThePlayer } = await import('/player.js');
          window.player = new ThePlayer(document.querySelector('video'));
          window.failures = [];
          window.player.addEventListener('error', (event) =>
            window.failures.push(String(event.detail)),
          );
          await window.player.load({
            protocol: 'hls',
            url,
            targetBuffer: 4,
            network: { transport },
          });
        },
        { url: `${base}/scenario/${id}/${scenario}/index.m3u8`, transport },
      );
      try {
        await page.waitForFunction(
          () => document.querySelector('video').currentTime > 0.1,
          null,
          { timeout: 5000 },
        );
        assert.ok(
          Date.now() - started < 2000,
          'Start on partial-only playlist before the first parent is complete',
        );
        await page.waitForFunction(
          () => document.querySelector('video').currentTime > 15,
          null,
          { timeout: 20000 },
        );
        const result = await page.evaluate(() => ({
          diagnostics: window.player.diagnostics,
          failures: window.failures,
          width: document.querySelector('video').videoWidth,
          frames: document.querySelector('video').getVideoPlaybackQuality()
            .totalVideoFrames,
        }));
        assert.deepEqual(result.failures, []);
        assert.deepEqual(errors, []);
        assert.equal(result.width, 320);
        assert.ok(result.frames > 250);
        assert.equal(result.diagnostics.live.restarts, 0);
        assert.ok(result.diagnostics.playlistReload.blocking > 20);
        assert.ok(result.diagnostics.preload.used > 20);
        if (scenario === 'll-parts-cancel')
          assert.ok(result.diagnostics.preload.cancelled > 0);
        if (!process.env.HLS_RECOVERY_BASE) {
          const parts = [...requests].filter(([key]) =>
            key.startsWith(id + ':part:'),
          );
          assert.ok(parts.length > 25);
          for (const [key, count] of parts)
            assert.equal(count, 1, 'No duplicate part request: ' + key);
          assert.equal(
            [...requests.keys()].some((key) =>
              key.startsWith(`/scenario/${id}/${scenario}/parent`),
            ),
            false,
          );
        }
        await page.evaluate(() => window.player.destroy());
        console.log(
          'PASS LL-HLS parts',
          transport,
          scenario,
          result.diagnostics.playlistReload,
        );
      } catch (error) {
        console.error(
          await page.evaluate(() => ({
            diagnostics: window.player.diagnostics,
            errors: window.failures,
            time: document.querySelector('video').currentTime,
            mediaError: document.querySelector('video').error?.message,
          })),
        );
        throw error;
      } finally {
        await page.close();
      }
    }
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
