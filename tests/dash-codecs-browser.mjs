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
  for (const codec of ['av1', 'hevc', 'ac3', 'eac3'])
    for (const transport of ['fetch', 'xhr']) {
      const deadline = caseDeadline(`${name} ${codec} ${transport}`);
      const { server } = dashServer();
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      const page = await browser.newPage();
      try {
        await page.goto(
          `http://127.0.0.1:${server.address().port}/harness.html`,
        );
        const supported = await page.evaluate(
          async ({ codec, transport }) => {
            const url = location.origin + `/profiles/${codec}/manifest.mpd`;
            const doc = new DOMParser().parseFromString(
              await (await fetch(url)).text(),
              'application/xml',
            );
            const rep = doc.querySelector('Representation');
            const mime =
              rep.getAttribute('mimeType') ??
              rep.parentElement.getAttribute('mimeType');
            const codecs = rep.getAttribute('codecs');
            const supported = MediaSource.isTypeSupported(
              `${mime};codecs="${codecs}"`,
            );
            const { ThePlayer } = await import('/player.js');
            window.player = new ThePlayer(document.querySelector('video'));
            window.errors = [];
            player.addEventListener('error', (e) =>
              errors.push(e.detail.message),
            );
            window.loading = player
              .load({
                protocol: 'dash',
                url,
                targetBuffer: 2,
                network: { transport },
              })
              .catch((e) => errors.push(e.message));
            return supported;
          },
          { codec, transport },
        );
        if (supported) {
          await page.waitForFunction(
            () => document.querySelector('video').currentTime > 2,
            null,
            { timeout: 20000 },
          );
          await page.locator('video').evaluate((v) => (v.currentTime = 7));
          await page.waitForFunction(
            () => document.querySelector('video').currentTime > 8,
          );
          assert.deepEqual(await page.evaluate(() => errors), []);
          if (['hevc', 'av1'].includes(codec))
            assert.ok(
              await page
                .locator('video')
                .evaluate(
                  (v) => v.getVideoPlaybackQuality().totalVideoFrames > 30,
                ),
            );
        } else {
          await page.waitForFunction(() => errors.length > 0);
          assert.ok(
            await page.evaluate(() =>
              errors.some((e) =>
                e.includes('No supported DASH audio/video representation'),
              ),
            ),
          );
        }
        console.log(
          name,
          transport,
          codec,
          supported
            ? 'decoded playback and seek PASS'
            : 'explicit browser capability rejection PASS',
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
