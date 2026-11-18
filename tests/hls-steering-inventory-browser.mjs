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
    for (const scenario of process.env.HLS_INVENTORY_SCENARIOS?.split(',') ?? [
      'shrink',
      'grow',
      'tracks',
      'initial',
      'recover',
    ]) {
      const page = await browser.newPage({ ignoreHTTPSErrors: true });
      try {
        await page.goto(base + '/harness.html');
        await page.evaluate(
          async ({ transport, scenario }) => {
            const { ThePlayer } = await import('/player.js');
            window.player = new ThePlayer(document.querySelector('video'));
            window.errors = [];
            window.player.addEventListener('error', (e) =>
              window.errors.push(String(e.detail)),
            );
            window.player
              .load({
                protocol: 'hls',
                url:
                  location.origin +
                  '/scenario/inventory-' +
                  transport +
                  '-' +
                  scenario +
                  '-' +
                  Date.now() +
                  '/steering-inventory-' +
                  scenario +
                  '/master.m3u8',
                quality: ['shrink', 'initial', 'recover'].includes(scenario)
                  ? 1
                  : 0,
                audioLanguage: 'es',
                subtitleLanguage: 'en',
                targetBuffer: 4,
                network: { transport },
              })
              .catch((e) => window.errors.push(String(e)));
          },
          { transport, scenario },
        );
        await page.waitForFunction(
          (scenario) =>
            window.errors.length ||
            (window.player.diagnostics?.steering?.pathway ===
              (scenario === 'recover' ? 'a' : 'b') &&
              document.querySelector('video').currentTime > 8),
          scenario,
          { timeout: 20000 },
        );
        assert.deepEqual(await page.evaluate(() => window.errors), []);
        assert.equal(
          await page.evaluate(() => window.player.qualityLevels.length),
          ['grow', 'recover'].includes(scenario) ? 2 : 1,
        );
        assert.equal(
          await page.evaluate(() => window.player.selectedQuality),
          0,
        );
        assert.equal(
          await page.evaluate(() => window.player.autoQuality),
          false,
        );
        if (scenario === 'grow') {
          await page.evaluate(() => window.player.selectQuality(1));
          await page.waitForFunction(
            () => document.querySelector('video').videoWidth === 640,
          );
        } else
          assert.equal(
            await page.evaluate(
              () => document.querySelector('video').videoWidth,
            ),
            320,
          );
        if (scenario === 'tracks') {
          assert.deepEqual(
            await page.evaluate(() =>
              window.player.audioTracks.map((t) => t.language),
            ),
            ['fr', 'en'],
          );
          assert.equal(
            await page.evaluate(
              () =>
                window.player.audioTracks.find(
                  (t) => t.name === window.player.selectedAudioTrack,
                ).language,
            ),
            'en',
          );
          assert.equal(
            await page.evaluate(() => window.player.selectedSubtitleTrack),
            '',
          );
          assert.deepEqual(
            await page.evaluate(() => window.player.subtitleTracks),
            [],
          );
          await page.evaluate(() =>
            window.player.selectAudioTrack(window.player.audioTracks[0].name),
          );
          assert.equal(
            await page.evaluate(() => window.player.selectedAudioTrack),
            'hls-audio-0',
          );
        }
        await page.evaluate(() => window.player.destroy());
        console.log(
          'PASS pathway inventory replacement',
          name,
          transport,
          scenario,
        );
      } catch (e) {
        console.error(
          await page.evaluate(() => ({
            errors: window.errors,
            diagnostics: window.player?.diagnostics,
            time: document.querySelector('video')?.currentTime,
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
