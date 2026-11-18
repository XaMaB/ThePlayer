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
  for (const transport of ['fetch', 'xhr']) {
    const page = await browser.newPage();
    const faults = [];
    page.on('pageerror', (e) => faults.push(e.message));
    try {
      await page.goto(`http://127.0.0.1:${server.address().port}/harness.html`);
      await page.evaluate(async (transport) => {
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
          url: location.origin + '/dash/text.mpd',
          quality: 0,
          network: { transport },
        });
      }, transport);
      await page.waitForFunction(
        () => document.querySelector('video').currentTime > 1,
      );
      assert.equal(
        await page.evaluate(() => window.player.subtitleTracks.length),
        4,
      );
      for (const format of ['vtt', 'ttml', 'wvtt', 'stpp']) {
        console.log('Text case', format);
        await page.locator('video').evaluate((v) => {
          v.currentTime = 0.5;
        });
        await page.waitForFunction(
          () => !document.querySelector('video').seeking,
        );
        await page.evaluate(
          (format) => window.player.selectSubtitleTrack(format),
          format,
        );
        await expectCaption(page, format);
        if (format === 'vtt')
          assert.equal(
            await page.evaluate(
              () =>
                document.querySelector('video').textTracks[0].activeCues[0]
                  .align,
            ),
            'start',
          );
        await page.locator('video').evaluate((v) => {
          v.currentTime = 8.1;
        });
        await expectCaption(page, format);
        await page.evaluate(() => window.player.selectSubtitleTrack(''));
        assert.equal(await page.locator('.theplayer-ttml').count(), 0);
        assert.equal(await page.locator('video track').count(), 0);
      }
      assert.deepEqual(await page.evaluate(() => window.errors), []);
      assert.deepEqual(await page.evaluate(() => window.warnings), []);
      assert.deepEqual(faults, []);
      await page.evaluate(() => window.player.destroy());
      assert.equal(
        await page.locator('.theplayer-ttml, video track').count(),
        0,
      );
      console.log(
        name,
        transport,
        'external WebVTT/TTML, wvtt/stpp, seek, Off and teardown PASS',
      );
    } catch (error) {
      console.log(
        await page.evaluate(() => ({
          errors: window.errors,
          warnings: window.warnings,
          tracks: window.player?.subtitleTracks.map((t) => t.name),
          native: Array.from(document.querySelector('video').textTracks).map(
            (t) => ({
              mode: t.mode,
              cues: Array.from(t.cues ?? []).map((c) => [
                c.startTime,
                c.endTime,
                c.text,
              ]),
              active: t.activeCues?.length,
            }),
          ),
          time: document.querySelector('video').currentTime,
          text: document.querySelector('.theplayer-ttml')?.textContent,
        })),
      );
      throw error;
    } finally {
      await page.evaluate(() => window.player?.destroy());
      await page.close();
    }
  }
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
async function expectCaption(page, format) {
  await page.waitForFunction(
    (format) => {
      if (document.querySelector('video').seeking) return false;
      if (['vtt', 'wvtt'].includes(format))
        return Array.from(document.querySelector('video').textTracks).some(
          (t) => t.mode === 'showing' && t.activeCues?.length,
        );
      return !!document
        .querySelector('.theplayer-ttml')
        ?.textContent?.includes('TTML');
    },
    format,
    { timeout: 10000 },
  );
}
