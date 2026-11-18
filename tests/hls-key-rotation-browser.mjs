import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { faultServer } from './helpers/hls-fault-server.mjs';
const { server } = faultServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base =
  process.env.HLS_RECOVERY_BASE ?? `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
});
try {
  for (const transport of ['fetch', 'xhr']) {
    const page = await browser.newPage({ ignoreHTTPSErrors: true });
    try {
      await page.goto(base + '/harness.html');
      await page.evaluate(async (transport) => {
        const { ThePlayer } = await import('/player.js');
        const video = document.querySelector('video');
        window.player = new ThePlayer(video);
        window.errors = [];
        window.licenses = 0;
        window.player.addEventListener('error', (event) =>
          window.errors.push(String(event.detail)),
        );
        window.player
          .load({
            protocol: 'hls',
            url: location.origin + '/fixture/cenc-long-rotation/index.m3u8',
            targetBuffer: 4,
            network: { transport },
            drm: {
              keySystem: 'org.w3.clearkey',
              license: async (message) => {
                const request = JSON.parse(new TextDecoder().decode(message));
                window.licenses++;
                return new TextEncoder().encode(
                  JSON.stringify({
                    type: 'temporary',
                    keys: request.kids.map((kid) => ({
                      kty: 'oct',
                      kid,
                      k: btoa(
                        String.fromCharCode(...new Uint8Array(16).fill(0x39)),
                      ).replace(/=/g, ''),
                    })),
                  }),
                );
              },
            },
          })
          .catch((error) => window.errors.push(String(error)));
      }, transport);
      await page.waitForFunction(
        () =>
          document.querySelector('video').currentTime > 0.2 ||
          window.errors.length,
        null,
        { timeout: 15000 },
      );
      assert.deepEqual(await page.evaluate(() => window.errors), []);
      await page.evaluate(() => document.querySelector('video').pause());
      for (let n = 1; n < 80; n++) {
        await page.evaluate(
          (time) => {
            document.querySelector('video').currentTime = time;
          },
          n * 2 + 0.25,
        );
        await page.waitForFunction(
          (time) => {
            const video = document.querySelector('video');
            return (
              window.errors.length ||
              (!video.seeking &&
                video.readyState >= 2 &&
                Math.abs(video.currentTime - time) < 0.1)
            );
          },
          n * 2 + 0.25,
          { timeout: 15000 },
        );
        assert.deepEqual(await page.evaluate(() => window.errors), []);
      }
      const count = await page.evaluate(() => window.licenses);
      assert.ok(count >= 80, 'Each new KID acquired from the CDM request');
      await page.evaluate(() => {
        document.querySelector('video').currentTime = 0.25;
      });
      await page.waitForFunction(
        () => {
          const v = document.querySelector('video');
          return !v.seeking && v.readyState >= 2 && v.currentTime < 1;
        },
        null,
        { timeout: 15000 },
      );
      assert.ok(
        (await page.evaluate(() => window.licenses)) > count,
        'Evicted key reacquired on rewind',
      );
      assert.deepEqual(await page.evaluate(() => window.errors), []);
      await page.evaluate(() => window.player.destroy());
      assert.equal(
        await page.evaluate(() => document.querySelector('video').mediaKeys),
        null,
      );
      console.log(
        'PASS 80 CENC key rotations, buffered retention, rewind and cleanup',
        transport,
        count,
      );
    } catch (error) {
      console.error(
        await page.evaluate(() => ({
          errors: window.errors,
          licenses: window.licenses,
          time: document.querySelector('video').currentTime,
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
