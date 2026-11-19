import { webkit } from 'playwright';
import assert from 'node:assert/strict';
import { dashServer } from './helpers/dash-server.mjs';
import { faultServer } from './helpers/hls-fault-server.mjs';

// Real WebKit ManagedMediaSource, with ordinary MSE hidden as on iPhone.
// Desktop WebKit is a regression gate, not physical iOS certification.
const servers = [dashServer().server, faultServer().server];
for (const server of servers)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const bases = servers.map((s) => `http://127.0.0.1:${s.address().port}`);
const browser = await webkit.launch();
try {
  for (const managed of [false, true]) {
    for (const transport of ['fetch', 'xhr']) {
      for (const [protocol, base, path] of [
        ['dash', bases[0], '/dash/timeline.mpd'],
        ['hls', bases[1], '/fixture/ts/index.m3u8'],
        ['hls', bases[1], '/fixture/fmp4/index.m3u8'],
      ]) {
        const page = await browser.newPage();
        const deadline = setTimeout(() => {
          console.error('Media source playback watchdog', {
            managed,
            transport,
            path,
          });
          process.exit(1);
        }, 90000);
        try {
          if (managed)
            await page.addInitScript(() => {
              if (typeof ManagedMediaSource !== 'function')
                throw new Error('Test requires real ManagedMediaSource');
              Object.defineProperty(window, 'MediaSource', {
                value: undefined,
              });
            });
          const errors = [];
          page.on('pageerror', (e) => errors.push(e.message));
          await page.goto(base + '/harness.html');
          await page.evaluate(
            async (source) => {
              const { ThePlayer } = await import('/player.js');
              const video = document.querySelector('video');
              window.originalRemotePlayback = video.disableRemotePlayback;
              window.player = new ThePlayer(video);
              window.errors = [];
              player.addEventListener('error', (e) =>
                errors.push(String(e.detail)),
              );
              await player.load(source);
            },
            {
              protocol,
              url: base + path,
              targetBuffer: 4,
              network: { transport },
            },
          );
          await page.waitForFunction(
            () =>
              document.querySelector('video').getVideoPlaybackQuality()
                .totalVideoFrames > 30,
          );
          assert.equal(
            await page.locator('video').evaluate((v) => v.playsInline),
            true,
          );
          if (managed)
            assert.equal(
              await page
                .locator('video')
                .evaluate((v) => v.disableRemotePlayback),
              true,
            );
          await page.locator('video').evaluate((v) => {
            v.currentTime = 6;
          });
          await page.waitForFunction(() => {
            const v = document.querySelector('video');
            return !v.seeking && v.currentTime > 7;
          });
          assert.deepEqual(await page.evaluate(() => window.errors), []);
          assert.deepEqual(errors, []);
          await page.evaluate(() => player.destroy());
          assert.equal(
            await page
              .locator('video')
              .evaluate((v) => v.disableRemotePlayback),
            await page.evaluate(() => originalRemotePlayback),
          );
          await page.close();
          console.log(
            'PASS',
            managed ? 'ManagedMediaSource' : 'MediaSource',
            transport,
            path,
            'decoded playback, seek and cleanup',
          );
        } finally {
          await page.close();
          clearTimeout(deadline);
        }
      }
    }
  }
} finally {
  await browser.close();
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
}
