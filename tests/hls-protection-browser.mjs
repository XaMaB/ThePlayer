import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { faultServer } from './helpers/hls-fault-server.mjs';
const { server } = faultServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base =
  process.env.HLS_RECOVERY_BASE ?? `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
});
try {
  for (const transport of ['fetch', 'xhr'])
    for (const mode of ['map-rotation', 'gcm', 'gcm-tampered']) {
      const page = await browser.newPage({ ignoreHTTPSErrors: true }),
        requests = [],
        errors = [];
      page.on('request', (r) => {
        if (r.url().endsWith('.bin'))
          requests.push({ url: r.url(), type: r.resourceType() });
      });
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(base + '/harness.html');
      await page.evaluate(
        async ({ url, transport }) => {
          const { ThePlayer } = await import('/player.js');
          window.player = new ThePlayer(document.querySelector('video'));
          window.errors = [];
          window.player.addEventListener('error', (e) =>
            window.errors.push(String(e.detail)),
          );
          window.loading = window.player
            .load({ protocol: 'hls', url, network: { transport } })
            .catch((e) => window.errors.push(String(e)));
        },
        { url: base + '/fixture/crypto-' + mode + '.m3u8', transport },
      );
      try {
        if (mode === 'gcm-tampered') {
          await page.waitForFunction(() => window.errors.length > 0, null, {
            timeout: 15000,
          });
          assert.equal(
            await page.evaluate(
              () =>
                document.querySelector('video').getVideoPlaybackQuality()
                  .totalVideoFrames,
            ),
            0,
          );
        } else {
          await page.waitForFunction(
            () => document.querySelector('video').currentTime > 3,
            null,
            { timeout: 20000 },
          );
          await page.evaluate(() => {
            document.querySelector('video').pause();
            document.querySelector('video').currentTime = 10;
          });
          await page.waitForFunction(
            () =>
              !document.querySelector('video').seeking &&
              document.querySelector('video').readyState >= 2,
          );
          await page.evaluate(
            () => (document.querySelector('video').currentTime = 1),
          );
          await page.waitForFunction(
            () =>
              !document.querySelector('video').seeking &&
              document.querySelector('video').readyState >= 2,
          );
          assert.deepEqual(await page.evaluate(() => window.errors), []);
          assert.ok(requests.some((r) => r.url.endsWith('key0.bin')));
          assert.ok(requests.some((r) => r.url.endsWith('key2.bin')));
          assert.ok(requests.every((r) => r.type === transport));
          // Session preloads should be consumed by the first map/media decryption.
          assert.equal(
            requests.filter((r) => r.url.endsWith('key0.bin')).length,
            1,
          );
        }
        assert.deepEqual(errors, []);
        await page.evaluate(() => window.player.destroy());
        console.log('PASS encryption', mode, transport);
      } catch (error) {
        console.error(
          await page.evaluate(() => ({
            errors: window.errors,
            diagnostics: window.player.diagnostics,
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
  await new Promise((r) => server.close(r));
}
