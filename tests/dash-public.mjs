// Network-dependent interop checks; publisher media is not redistributed.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { faultServer } from './helpers/hls-fault-server.mjs';
const sources = [
  [
    'livesim-captions',
    'https://livesim.dashif.org/livesim2/timecc608_CC1-eng/testpic_2s/Manifest.mpd',
  ],
  [
    'livesim-ll',
    'https://livesim.dashif.org/livesim2/ato_1.5/chunkdur_0.5/ltgt_3000/testpic_2s/Manifest.mpd',
  ],
  [
    'livesim-patch',
    'https://livesim.dashif.org/livesim2/patch_60/segtimeline_1/testpic_2s/Manifest.mpd',
  ],
  ['akamai-bbb', 'https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps.mpd'],
  ['envivio', 'https://dash.akamaized.net/envivio/EnvivioDash3/manifest.mpd'],
  [
    'angel-one',
    'https://storage.googleapis.com/shaka-demo-assets/angel-one/dash.mpd',
  ],
  [
    'livesim-number',
    'https://livesim.dashif.org/livesim2/testpic_2s/Manifest.mpd',
  ],
  [
    'livesim-timeline',
    'https://livesim.dashif.org/livesim2/segtimeline_1/testpic_2s/Manifest.mpd',
  ],
];
const { server } = faultServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
});
try {
  for (const [id, url] of sources.filter(
    ([id]) =>
      !process.env.DASH_PUBLIC_SOURCE || process.env.DASH_PUBLIC_SOURCE === id,
  )) {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.goto(base + '/harness.html');
    await page.evaluate(async (url) => {
      const { ThePlayer } = await import('/player.js');
      window.player = new ThePlayer(document.querySelector('video'));
      window.errors = [];
      window.player.addEventListener('error', (e) =>
        window.errors.push(String(e.detail)),
      );
      try {
        await window.player.load({
          protocol: 'dash',
          url,
          quality: 0,
          targetBuffer: 6,
        });
      } catch (e) {
        window.errors.push(String(e));
      }
    }, url);
    try {
      await page.waitForFunction(
        () =>
          window.errors.length ||
          document.querySelector('video').getVideoPlaybackQuality()
            .totalVideoFrames > 60,
        null,
        { timeout: 30000 },
      );
      assert.deepEqual(await page.evaluate(() => window.errors), []);
      if (id === 'livesim-captions') {
        await page.waitForFunction(() =>
          window.player.subtitleTracks.some((t) => t.format === 'cea-608'),
        );
        await page.evaluate(() =>
          window.player.selectSubtitleTrack(
            window.player.subtitleTracks.find((t) => t.format === 'cea-608')
              .name,
          ),
        );
        await page.waitForFunction(() =>
          document.querySelector('.theplayer-cea608')?.textContent.trim(),
        );
      }
      const before = await page.locator('video').evaluate((v) => v.currentTime);
      if (await page.evaluate(() => window.player.qualityLevels.length > 1))
        await page.evaluate(() => window.player.selectQuality(1));
      await page.waitForFunction(
        (time) => document.querySelector('video').currentTime > time + 4,
        before,
        { timeout: 15000 },
      );
      if (!(await page.evaluate(() => window.player.isLive))) {
        await page.locator('video').evaluate((v) => {
          v.currentTime = 20;
        });
        await page.waitForFunction(
          () => document.querySelector('video').currentTime > 22,
          null,
          { timeout: 20000 },
        );
      }
      assert.deepEqual(await page.evaluate(() => window.errors), []);
      assert.deepEqual(pageErrors, []);
      if (id === 'livesim-ll')
        assert.ok(
          await page.evaluate(
            () => window.player.diagnostics.lowLatency.chunks > 0,
          ),
        );
      if (id === 'livesim-patch')
        assert.ok(
          await page.evaluate(
            () => window.player.diagnostics.patches.applied > 0,
          ),
        );
      console.log(
        id,
        'PASS',
        await page.evaluate(() => ({
          live: window.player.isLive,
          quality: window.player.qualityLevels.length,
          audio: window.player.audioTracks.length,
          time: document.querySelector('video').currentTime,
        })),
      );
    } catch (error) {
      console.log(
        id,
        await page.evaluate(() => ({
          errors: window.errors,
          diagnostics: window.player.diagnostics,
          time: document.querySelector('video').currentTime,
          ready: document.querySelector('video').readyState,
        })),
      );
      throw error;
    } finally {
      await page.evaluate(() => window.player.destroy());
      await page.close();
    }
  }
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
