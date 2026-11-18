import { chromium, firefox, webkit } from 'playwright';
import assert from 'node:assert/strict';
import { dashServer } from './helpers/dash-server.mjs';
const name = process.env.DASH_TEST_BROWSER ?? 'chromium';
const browser = await { chromium, firefox, webkit }[name].launch(
  name === 'chromium'
    ? { args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] }
    : {},
);
const { server } = dashServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
try {
  for (const format of ['608', '708'])
    for (const transport of ['fetch', 'xhr']) {
      const page = await browser.newPage();
      const faults = [];
      page.on('pageerror', (e) => faults.push(e.message));
      try {
        await page.goto(
          `http://127.0.0.1:${server.address().port}/harness.html`,
        );
        await page.evaluate(
          async ({ format, transport }) => {
            const { ThePlayer } = await import('/player.js');
            const video = document.querySelector('video');
            video.style.width = '640px';
            video.style.height = '360px';
            window.player = new ThePlayer(video);
            window.errors = [];
            window.warnings = [];
            window.player.addEventListener('error', (e) =>
              window.errors.push(e.detail.message),
            );
            window.player.addEventListener('captionwarning', (e) =>
              window.warnings.push(e.detail.message),
            );
            await window.player.load({
              protocol: 'dash',
              url: location.origin + `/dash/cea${format}.mpd`,
              quality: 0,
              network: { transport },
            });
          },
          { format, transport },
        );
        await page.waitForFunction(
          (format) =>
            window.player.subtitleTracks.some(
              (t) => t.name === `dash-cea-${format}-1`,
            ),
          format,
        );
        await page.evaluate(
          (format) => window.player.selectSubtitleTrack(`dash-cea-${format}-1`),
          format,
        );
        const expected = format === '608' ? 'SEI CC1' : 'Left aligned';
        await page.waitForFunction(
          ({ format, expected }) =>
            document
              .querySelector(`.theplayer-cea${format}`)
              ?.textContent.includes(expected),
          { format, expected },
        );
        if (format === '708') {
          const layout = await page.evaluate(() => {
            const overlay = document
              .querySelector('.theplayer-cea708')
              .getBoundingClientRect();
            const row = document
              .querySelector('.theplayer-cea708 [data-window="0"]')
              .getBoundingClientRect();
            return {
              x: (row.left - overlay.left) / overlay.width,
              width: row.width / overlay.width,
              cells: document.querySelectorAll('.theplayer-cea708 span').length,
            };
          });
          assert.ok(layout.x > 0.25 && layout.x < 0.28, JSON.stringify(layout));
          assert.equal(layout.cells, 12);
        }
        await page.evaluate(
          (format) =>
            window.player.selectSubtitleTrack(
              `dash-cea-${format}-${format === '608' ? 3 : 2}`,
            ),
          format,
        );
        const second = format === '608' ? 'SEI CC3' : 'Ж中가';
        await page.waitForFunction(
          ({ format, second }) =>
            document
              .querySelector(`.theplayer-cea${format}`)
              ?.textContent.includes(second),
          { format, second },
        );
        await page.locator('video').evaluate((v) => {
          v.currentTime = 8.75;
        });
        await page.waitForFunction(
          ({ format, second }) =>
            !document.querySelector('video').seeking &&
            document
              .querySelector(`.theplayer-cea${format}`)
              ?.textContent.includes(second),
          { format, second },
        );
        assert.deepEqual(await page.evaluate(() => window.errors), []);
        assert.deepEqual(await page.evaluate(() => window.warnings), []);
        assert.deepEqual(faults, []);
        await page.evaluate(() => window.player.selectSubtitleTrack(''));
        assert.equal(
          await page.locator('.theplayer-cea608,.theplayer-cea708').count(),
          0,
        );
        console.log(
          name,
          transport,
          format,
          'SEI captions, services, alignment/P16, seeking and Off PASS',
        );
      } catch (e) {
        console.log(
          await page.evaluate(() => ({
            errors: window.errors,
            warnings: window.warnings,
            tracks: window.player?.subtitleTracks.map((t) => t.name),
            time: document.querySelector('video').currentTime,
          })),
        );
        throw e;
      } finally {
        await page.evaluate(() => window.player?.destroy());
        await page.close();
      }
    }
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
