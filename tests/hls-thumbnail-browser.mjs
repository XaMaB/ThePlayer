import { chromium, firefox, webkit } from 'playwright';
import assert from 'node:assert/strict';
import { faultServer } from './helpers/hls-fault-server.mjs';
const { server, requests } = faultServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
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
    for (const mode of [
      'tiles',
      'single',
      'range',
      'encrypted',
      'gap',
      'mismatch',
      'malformed',
      'live',
    ]) {
      const page = await browser.newPage({ ignoreHTTPSErrors: true });
      page.on('pageerror', (e) => console.error('PAGE ERROR', e));
      try {
        await page.goto(base + '/harness.html');
        await page.evaluate(
          async ({ url, transport }) => {
            const { ThePlayer, mountControls } = await import('/player.js');
            const video = document.querySelector('video');
            const screen = document.createElement('div');
            screen.className = 'screen';
            video.before(screen);
            screen.append(video);
            screen.style.width = '800px';
            const css = document.createElement('link');
            css.rel = 'stylesheet';
            css.href = '/style.css';
            document.head.append(css);
            window.player = new ThePlayer(video);
            window.errors = [];
            window.player.addEventListener('error', (e) =>
              window.errors.push(String(e.detail)),
            );
            window.controls = mountControls(
              screen,
              video,
              () => window.player,
              (e) => window.errors.push(e),
            );
            await window.player.load({
              protocol: 'hls',
              url,
              network: { transport },
            });
          },
          {
            url:
              mode === 'live'
                ? `${base}/scenario/images-${transport}-${Date.now().toString(36)}/images-live/master.m3u8`
                : base + '/fixture/images/' + mode + '-master.m3u8',
            transport,
          },
        );
        await page.waitForFunction(
          () =>
            document.querySelector('video').currentTime > 0.2 ||
            window.errors.length,
        );
        assert.deepEqual(await page.evaluate(() => window.errors), []);
        if (mode === 'live') {
          const first = await page.evaluate(() =>
            window.player.getThumbnail(9.5),
          );
          assert.equal(first.time, 9);
          await page.waitForFunction(
            () => document.querySelector('video').currentTime > 13.5,
          );
          const later = await page.evaluate(() =>
            window.player.getThumbnail(13.5),
          );
          assert.equal(later.time, 13);
          assert.notEqual(later.url, first.url);
          assert.deepEqual(await page.evaluate(() => window.errors), []);
          await page.evaluate(async () => {
            window.controls.destroy();
            await window.player.destroy();
          });
          console.log(
            'PASS live image playlist date alignment and reload',
            name,
            transport,
          );
          continue;
        }
        const result = await page.evaluate(async () => {
          const values = [];
          for (const time of [0.5, 2.5, 4.5, 6.5, 9.5]) {
            try {
              const thumbnail = await window.player.getThumbnail(time);
              if (!thumbnail) {
                values.push(null);
                continue;
              }
              const image = new Image();
              image.src = thumbnail.url;
              await image.decode();
              const canvas = document.createElement('canvas');
              canvas.width = 1;
              canvas.height = 1;
              const ctx = canvas.getContext('2d');
              ctx.drawImage(
                image,
                thumbnail.x + thumbnail.width / 2,
                thumbnail.y + thumbnail.height / 2,
                1,
                1,
                0,
                0,
                1,
                1,
              );
              values.push({
                ...thumbnail,
                pixel: [...ctx.getImageData(0, 0, 1, 1).data],
              });
            } catch (e) {
              values.push({ error: String(e) });
            }
          }
          return values;
        });
        if (mode === 'gap') assert.ok(result.every((v) => v === null));
        else if (['mismatch', 'malformed'].includes(mode))
          assert.ok(result.every((v) => v.error));
        else {
          assert.ok(
            result.every((v) => v && !v.error),
            JSON.stringify(result),
          );
          assert.ok(
            result.every((v) => v.url === result[0].url),
            'cached grid must reuse its object URL',
          );
          if (mode !== 'single') {
            const expected = [
              [255, 0, 0],
              [0, 255, 0],
              [0, 0, 255],
              [255, 255, 0],
              [255, 255, 0],
            ];
            for (let i = 0; i < 5; i++)
              for (let c = 0; c < 3; c++)
                assert.ok(
                  Math.abs(result[i].pixel[c] - expected[i][c]) < 20,
                  JSON.stringify(result[i]),
                );
            assert.equal(result[4].end, 10);
          }
        }
        if (mode === 'tiles') {
          const seek = page.locator('#seek-bar');
          await seek.waitFor({ state: 'visible' });
          const bounds = await seek.boundingBox();
          await seek.hover({
            position: { x: bounds.width * 0.25, y: bounds.height / 2 },
          });
          await page.locator('#seek-preview').waitFor({ state: 'visible' });
          await page
            .locator('#seek-preview canvas')
            .waitFor({ state: 'visible' });
          assert.ok(
            await page
              .locator('#seek-preview canvas')
              .evaluate((c) => c.width > 0),
          );
          const fit = await page.locator('#seek-preview').evaluate((el) => {
            const box = el.getBoundingClientRect(),
              canvas = el.querySelector('canvas').getBoundingClientRect();
            return (
              canvas.top >= box.top &&
              canvas.bottom <= box.bottom &&
              canvas.height > 0
            );
          });
          assert.ok(fit, 'preview image must fit inside its overlay');
          await page.mouse.move(0, 0);
          await page.locator('#seek-preview').waitFor({ state: 'hidden' });
        }
        assert.deepEqual(await page.evaluate(() => window.errors), []);
        await page.evaluate(async () => {
          window.controls.destroy();
          await window.player.destroy();
        });
        console.log(
          'PASS image thumbnails, crop, bounds and UI',
          name,
          transport,
          mode,
        );
      } catch (error) {
        console.error(
          await page.evaluate(() => ({
            preview: document.querySelector('#seek-preview')?.outerHTML,
            seek: document
              .querySelector('#seek-bar')
              ?.getBoundingClientRect()
              .toJSON(),
            screen: document
              .querySelector('.screen')
              ?.getBoundingClientRect()
              .toJSON(),
            duration: document.querySelector('video')?.duration,
          })),
        );
        await page.screenshot({ path: '/tmp/thumbnail-' + name + '.png' });
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
