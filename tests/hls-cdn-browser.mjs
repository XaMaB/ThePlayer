import { chromium, firefox, webkit } from 'playwright';
import assert from 'node:assert/strict';
import { faultServer } from './helpers/hls-fault-server.mjs';
const { server, requests } = faultServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base =
  process.env.HLS_RECOVERY_BASE ?? `http://127.0.0.1:${server.address().port}`;
const browserName = process.env.HLS_TEST_BROWSER ?? 'chromium';
const browserType = { chromium, firefox, webkit }[browserName];
if (!browserType) throw new Error('Unknown test browser');
const browser = await browserType.launch(
  browserName === 'chromium'
    ? { args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] }
    : {},
);
try {
  for (const transport of ['fetch', 'xhr'])
    for (const scenario of [
      'll-parts-age',
      'll-parts-age-reject',
      'll-parts-age-invalid',
    ]) {
      const id = `parts-${transport}-${scenario}-${Date.now().toString(36)}`;
      const page = await browser.newPage({ ignoreHTTPSErrors: true });
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
          Date.now() - started < 5000,
          'Bounded cached-playlist tune-in',
        );
        if (scenario !== 'll-parts-age-invalid') {
          const initialTime = await page.evaluate(
            () => document.querySelector('video').currentTime,
          );
          assert.ok(
            initialTime >= 4,
            'Start from refreshed CDN edge: ' + initialTime,
          );
        }
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
        assert.ok(result.frames > 160);
        assert.equal(result.diagnostics.live.restarts, 0);
        const d = result.diagnostics.playlistReload;
        if (scenario === 'll-parts-age-invalid')
          assert.equal(d.tuneInRequests, 0);
        else assert.ok(d.tuneInRequests > 0);
        if (scenario === 'll-parts-age-reject')
          assert.equal(d.tuneInFallbacks, 1);
        else assert.equal(d.tuneInFallbacks, 0);
        assert.equal(d.tuneInLimited, 0);
        if (scenario === 'll-parts-age')
          assert.ok(result.diagnostics.startup.firstFrameMs < 5000);
        await page.evaluate(() => window.player.destroy());
        console.log(
          'PASS CDN Age tune-in and fallback',
          browserName,
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
