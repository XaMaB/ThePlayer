import { chromium, firefox, webkit } from 'playwright';
import assert from 'node:assert/strict';
import { faultServer } from './helpers/hls-fault-server.mjs';
const { server } = faultServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base =
  process.env.HLS_RECOVERY_BASE ?? `http://127.0.0.1:${server.address().port}`;
const name = process.env.HLS_TEST_BROWSER ?? 'chromium';
const browser = await { chromium, firefox, webkit }[name].launch(
  name === 'chromium'
    ? { args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] }
    : {},
);
try {
  for (const transport of ['fetch', 'xhr'])
    for (const requested of process.env.HLS_VIDEO_REQUESTED === undefined
      ? [false, true]
      : [process.env.HLS_VIDEO_REQUESTED === '1']) {
      const page = await browser.newPage({ ignoreHTTPSErrors: true });
      const mediaRequests = [];
      page.on('request', (r) => {
        if (r.url().includes('/video-renditions/')) mediaRequests.push(r.url());
      });
      try {
        await page.goto(base + '/harness.html');
        await page.evaluate(
          async ({ transport, requested }) => {
            const { ThePlayer, mountControls } = await import('/player.js');
            const video = document.querySelector('video');
            const screen = document.createElement('div');
            screen.className = 'screen';
            screen.style.width = '900px';
            video.before(screen);
            screen.append(video);
            const css = document.createElement('link');
            css.rel = 'stylesheet';
            css.href = '/style.css';
            document.head.append(css);
            window.errors = [];
            window.player = new ThePlayer(video);
            window.player.addEventListener('error', (e) =>
              window.errors.push(String(e.detail)),
            );
            window.controls = mountControls(
              screen,
              video,
              () => window.player,
              (error) => window.errors.push(error),
            );
            window.player
              .load({
                protocol: 'hls',
                url: location.origin + '/fixture/video-renditions/master.m3u8',
                videoRendition: requested ? 'Alternate' : undefined,
                quality: 0,
                targetBuffer: 4,
                network: { transport },
              })
              .catch((e) => window.errors.push(String(e)));
          },
          { transport, requested },
        );
        await page.waitForFunction(
          () =>
            window.errors.length ||
            document.querySelector('video').currentTime > 0.3,
        );
        assert.deepEqual(await page.evaluate(() => window.errors), []);
        await page.evaluate(() => document.querySelector('video').pause());
        const inspect = async (time, color, width) => {
          await page.evaluate((time) => {
            document.querySelector('video').currentTime = time;
          }, time);
          await page.waitForFunction(
            ({ color, width }) => {
              const v = document.querySelector('video');
              if (v.seeking || v.readyState < 2 || v.videoWidth !== width)
                return false;
              const c = document.createElement('canvas');
              c.width = c.height = 1;
              c.getContext('2d').drawImage(v, 0, 0, 1, 1);
              const pixel = c.getContext('2d').getImageData(0, 0, 1, 1).data;
              return color.every((n, i) =>
                n === 255 ? pixel[i] > 180 : pixel[i] < 60,
              );
            },
            { color, width },
          );
        };
        assert.equal(
          await page.evaluate(() => window.player.selectedVideoTrack),
          requested ? 'hls-video-Alternate' : 'hls-video-Main',
        );
        if (requested) {
          await inspect(1, [0, 255, 0], 320);
          assert.ok(!mediaRequests.some((url) => url.includes('/blue/')));
        } else {
          await inspect(1, [0, 0, 255], 320);
          await page.locator('#quality-toggle').click();
          await page
            .locator('#quality-menu button[data-track="hls-video-Alternate"]')
            .click();
          await page.waitForFunction(
            () => window.player.selectedVideoTrack === 'hls-video-Alternate',
          );
          await inspect(3, [0, 255, 0], 320);
        }
        await page.evaluate(() => window.player.selectQuality(1));
        await inspect(5, [255, 255, 0], 640);
        assert.equal(
          await page.evaluate(() => window.player.selectedVideoTrack),
          'hls-video-Alternate',
        );
        await page.evaluate(() =>
          window.player.selectVideoTrack('hls-video-Main'),
        );
        await inspect(7, [255, 0, 0], 640);
        await page.evaluate(() => window.player.selectQuality(0));
        await inspect(9, [0, 0, 255], 320);
        assert.equal(
          await page.evaluate(() => document.querySelector('video').paused),
          true,
        );
        assert.equal(
          await page.evaluate(() => window.player.selectedAudioTrack),
          'hls-audio-0',
        );
        assert.deepEqual(await page.evaluate(() => window.errors), []);
        await page.evaluate(() => {
          window.controls.destroy();
          return window.player.destroy();
        });
        console.log(
          'PASS VIDEO defaults, explicit angle, cross-group quality, paused UI and pixels',
          name,
          transport,
          requested,
        );
      } catch (e) {
        console.error(
          await page.evaluate(() => ({
            pixel: (() => {
              const c = document.createElement('canvas');
              c.width = c.height = 1;
              c.getContext('2d').drawImage(
                document.querySelector('video'),
                0,
                0,
                1,
                1,
              );
              return Array.from(
                c.getContext('2d').getImageData(0, 0, 1, 1).data,
              );
            })(),
            switches: JSON.stringify(window.player?.diagnostics?.switches),
            ready: document.querySelector('video').readyState,
            seeking: document.querySelector('video').seeking,
            errors: window.errors,
            diagnostics: window.player?.diagnostics,
            time: document.querySelector('video')?.currentTime,
            videoTracks: window.player?.videoTracks,
            selected: window.player?.selectedVideoTrack,
          })),
        );
        throw e;
      } finally {
        await page.close();
      }
    }
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
