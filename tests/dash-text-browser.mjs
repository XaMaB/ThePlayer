import { chromium, firefox, webkit } from 'playwright';
import assert from 'node:assert/strict';
import { caseDeadline } from './helpers/case-deadline.mjs';
import { dashServer } from './helpers/dash-server.mjs';
const name = process.env.DASH_TEST_BROWSER ?? 'chromium';
let browser;
const { server } = dashServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
try {
  for (const scenario of process.env.DASH_TEXT_SCENARIOS?.split(',') ?? [
    'text',
    'text-periods',
    'text-pto',
  ]) {
    for (const transport of ['fetch', 'xhr']) {
      const deadline = caseDeadline(`${name} ${transport} ${scenario}`);
      console.log(name, transport, scenario, 'START');
      // Isolate independent scenarios, including WebKit's media process.
      deadline.phase('launch browser');
      browser = await { chromium, firefox, webkit }[name].launch(
        name === 'chromium'
          ? {
              args: [
                '--no-sandbox',
                '--autoplay-policy=no-user-gesture-required',
              ],
            }
          : {},
      );
      deadline.phase('create page');
      const page = await browser.newPage();
      const faults = [];
      page.on('pageerror', (e) => faults.push(e.message));
      try {
        deadline.phase('navigate');
        await page.goto(
          `http://127.0.0.1:${server.address().port}/harness.html`,
        );
        deadline.phase('initialize player');
        await page.evaluate(
          async ({ transport, scenario }) => {
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
              url: location.origin + '/dash/' + scenario + '.mpd',
              quality: 0,
              network: { transport },
            });
          },
          { transport, scenario },
        );
        deadline.phase('startup playback');
        await page.waitForFunction(
          () => document.querySelector('video').currentTime > 1,
        );
        assert.equal(
          await page.evaluate(() => window.player.subtitleTracks.length),
          4,
        );
        for (const format of ['vtt', 'ttml', 'wvtt', 'stpp']) {
          deadline.phase('subtitle selection and seek');
          console.log('Text case', scenario, format);
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
          await page.locator('video').evaluate(
            (v, time) => {
              v.currentTime = time;
            },
            scenario === 'text-periods' ? 14.1 : 8.1,
          );
          await expectCaption(page, format);
          const position = await page
            .locator('video')
            .evaluate((v) => v.currentTime);
          await page.waitForFunction(
            (t) => document.querySelector('video').currentTime > t + 0.15,
            position,
            { timeout: 5000 },
          );
          await page.evaluate(() => window.player.selectSubtitleTrack(''));
          assert.equal(await page.locator('.theplayer-ttml').count(), 0);
          assert.equal(await page.locator('video track').count(), 0);
        }
        assert.deepEqual(await page.evaluate(() => window.errors), []);
        assert.deepEqual(await page.evaluate(() => window.warnings), []);
        assert.deepEqual(faults, []);
        deadline.phase('destroy player');
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
        console.error(name, transport, scenario, error);
        deadline.phase('collect failure diagnostics');
        console.dir(
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
            seeking: document.querySelector('video').seeking,
            paused: document.querySelector('video').paused,
            ready: document.querySelector('video').readyState,
            buffered: Array.from(
              { length: document.querySelector('video').buffered.length },
              (_, i) => [
                document.querySelector('video').buffered.start(i),
                document.querySelector('video').buffered.end(i),
              ],
            ),
            diagnostics: window.player.diagnostics,
            text: document.querySelector('.theplayer-ttml')?.textContent,
          })),
          { depth: null },
        );
        throw error;
      } finally {
        deadline.phase('cleanup player');
        await page.evaluate(() => window.player?.destroy());
        deadline.phase('close page');
        await page.close();
        deadline.phase('close browser');
        await browser?.close();
        browser = undefined;
        deadline.finish();
      }
    }
  }
} finally {
  await browser?.close();
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
