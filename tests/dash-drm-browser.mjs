import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { dashServer } from './helpers/dash-server.mjs';
const browser = await chromium.launch({
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
});
const { server } = dashServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
try {
  for (const scheme of process.env.DASH_DRM_SCHEMES?.split(',') ?? [
    'cenc',
    'cbcs',
    'cbcs-constant',
    'cenc-rotation',
    'cbcs-rotation',
    'cenc-seig',
    'cbcs-seig',
  ]) {
    for (const transport of ['fetch', 'xhr']) {
      const page = await browser.newPage();
      const faults = [];
      page.on('pageerror', (e) => faults.push(e.message));
      try {
        await page.goto(
          `http://127.0.0.1:${server.address().port}/harness.html`,
        );
        await page.evaluate(
          async ({ scheme, transport }) => {
            const { ThePlayer } = await import('/player.js');
            window.player = new ThePlayer(document.querySelector('video'));
            window.errors = [];
            window.player.addEventListener('error', (e) =>
              window.errors.push(e.detail.message),
            );
            await window.player.load({
              protocol: 'dash',
              url: location.origin + '/dash/' + scheme + '.mpd',
              quality: 0,
              network: { transport },
              drm: {
                keySystem: 'org.w3.clearkey',
                clearKeys: {
                  '0123456789abcdef0123456789abcdef':
                    '39393939393939393939393939393939',
                  '0123456789abcdef0123456789abcdee':
                    '3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a',
                },
              },
            });
          },
          { scheme, transport },
        );
        await page.waitForFunction(
          () =>
            document.querySelector('video').getVideoPlaybackQuality()
              .totalVideoFrames > 30,
          null,
          { timeout: 15000 },
        );
        await page.locator('video').evaluate((v) => {
          v.currentTime = 11;
        });
        await page.waitForFunction(
          () => document.querySelector('video').currentTime > 14,
          null,
          { timeout: 15000 },
        );
        await page.locator('video').evaluate((v) => {
          v.currentTime = 2;
        });
        await page.waitForFunction(
          () => document.querySelector('video').currentTime > 3,
          null,
          { timeout: 15000 },
        );
        assert.deepEqual(await page.evaluate(() => window.errors), []);
        assert.deepEqual(faults, []);
        await page.evaluate(() => window.player.destroy());
        assert.equal(
          await page.locator('video').evaluate((v) => v.mediaKeys),
          null,
        );
        console.log(
          scheme,
          transport,
          'ClearKey playback, seek, key rotation and teardown PASS',
        );
      } catch (e) {
        console.log(
          scheme,
          await page.evaluate(() => ({
            errors: window.errors,
            diagnostics: window.player?.diagnostics,
            time: document.querySelector('video').currentTime,
          })),
        );
        throw e;
      } finally {
        await page.evaluate(() => window.player?.destroy());
        await page.close();
      }
    }
  }
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
