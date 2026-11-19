import { chromium, firefox, webkit } from 'playwright';
import assert from 'node:assert/strict';
import { dashServer } from './helpers/dash-server.mjs';
import { caseDeadline } from './helpers/case-deadline.mjs';
const name = process.env.DASH_TEST_BROWSER ?? 'chromium';
const browser = await { chromium, firefox, webkit }[name].launch(
  name === 'chromium'
    ? { args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] }
    : {},
);
try {
  for (const mode of ['load', 'request', 'fallback'])
    for (const transport of ['fetch', 'xhr']) {
      const deadline = caseDeadline(`${name} XLink ${mode} ${transport}`);
      const { server, requests } = dashServer();
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      const page = await browser.newPage();
      try {
        await page.goto(
          `http://127.0.0.1:${server.address().port}/harness.html`,
        );
        await page.evaluate(
          async ({ mode, transport }) => {
            const { ThePlayer } = await import('/player.js');
            window.player = new ThePlayer(document.querySelector('video'));
            window.errors = [];
            player.addEventListener('error', (e) =>
              errors.push(e.detail.message),
            );
            await player.load({
              protocol: 'dash',
              url: location.origin + `/dash/xlink-${mode}.mpd`,
              quality: 0,
              targetBuffer: 2,
              network: { transport },
            });
          },
          { mode, transport },
        );
        await page.waitForFunction(
          () => document.querySelector('video').currentTime > 1,
        );
        if (mode === 'request')
          assert.equal(
            requests.filter((u) => u.startsWith('/remote/')).length,
            0,
            'Future remote Period stays deferred',
          );
        await page.locator('video').evaluate((v) => (v.currentTime = 16));
        await page.waitForFunction(
          () => document.querySelector('video').currentTime > 17,
        );
        if (mode === 'request')
          assert.equal(
            requests.filter((u) => u === '/remote/period.xml').length,
            1,
          );
        await page.locator('video').evaluate((v) => (v.currentTime = 2));
        await page.waitForFunction(
          () => document.querySelector('video').currentTime > 3,
        );
        assert.deepEqual(await page.evaluate(() => errors), []);
        if (mode === 'fallback')
          assert.ok(
            await page.evaluate(() => player.diagnostics.xlink.fallbacks > 0),
          );
        console.log(
          name,
          transport,
          'XLink',
          mode,
          'playback, seek and fallback PASS',
        );
      } finally {
        await page.evaluate(() => window.player?.destroy());
        await page.close();
        await new Promise((r) => server.close(r));
        deadline.finish();
      }
    }
} finally {
  await browser.close();
}
