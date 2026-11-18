import { chromium, firefox, webkit } from 'playwright';
import assert from 'node:assert/strict';
import { dashServer } from './helpers/dash-server.mjs';
const name = process.env.DASH_TEST_BROWSER ?? 'chromium';
const browser = await { chromium, firefox, webkit }[name].launch(
  name === 'chromium'
    ? { args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] }
    : {},
);
try {
  for (const transport of ['fetch', 'xhr']) {
    const { server, controls } = dashServer();
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const page = await browser.newPage();
    try {
      await page.goto(`http://127.0.0.1:${server.address().port}/harness.html`);
      await page.evaluate(async (transport) => {
        const { ThePlayer } = await import('/player.js');
        window.player = new ThePlayer(document.querySelector('video'));
        window.errors = [];
        window.player.addEventListener('error', (e) =>
          window.errors.push(e.detail.message),
        );
        await window.player.load({
          protocol: 'dash',
          url: location.origin + '/dash/ll.mpd',
          quality: 0,
          targetBuffer: 4,
          latencyControl: true,
          network: { transport },
        });
      }, transport);
      await page.waitForFunction(
        () =>
          document.querySelector('video').getVideoPlaybackQuality()
            .totalVideoFrames > 5,
        null,
        { timeout: 12000 },
      );
      const closedAtFirstFrames = controls.chunkResponsesClosed;
      if (transport === 'fetch')
        assert.equal(
          closedAtFirstFrames,
          0,
          'Decode before the first segment responses finish',
        );
      else
        assert.ok(
          closedAtFirstFrames >= 2,
          'XHR uses complete-response fallback',
        );
      const before = await page.locator('video').evaluate((v) => v.currentTime);
      await page.waitForFunction(
        (t) => document.querySelector('video').currentTime > t + 4,
        before,
        { timeout: 15000 },
      );
      const diagnostics = await page.evaluate(() => window.player.diagnostics);
      assert.equal(diagnostics.lowLatency.target, 3);
      if (transport === 'fetch') assert.ok(diagnostics.lowLatency.chunks >= 4);
      assert.ok(
        diagnostics.lowLatency.playbackRate >= 0.97 &&
          diagnostics.lowLatency.playbackRate <= 1.03,
      );
      assert.deepEqual(await page.evaluate(() => window.errors), []);
      console.log(
        name,
        transport,
        'LL CMAF decode, ServiceDescription and playback progress PASS',
        { closedAtFirstFrames, chunks: diagnostics.lowLatency.chunks },
      );
    } catch (e) {
      console.log(
        await page.evaluate(() => ({
          errors: window.errors,
          diagnostics: window.player?.diagnostics,
          time: document.querySelector('video').currentTime,
          ready: document.querySelector('video').readyState,
        })),
      );
      throw e;
    } finally {
      await page.evaluate(() => window.player?.destroy());
      await page.close();
      await new Promise((r) => server.close(r));
    }
  }
} finally {
  await browser.close();
}
