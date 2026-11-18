import { chromium, firefox, webkit } from 'playwright';
import assert from 'node:assert/strict';
import { faultServer } from './helpers/hls-fault-server.mjs';
const { server } = faultServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const name = process.env.HLS_TEST_BROWSER ?? 'chromium';
const browser = await { chromium, firefox, webkit }[name].launch(
  name === 'chromium'
    ? { args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] }
    : {},
);
try {
  for (const transport of ['fetch', 'xhr']) {
    const page = await browser.newPage();
    try {
      await page.goto(`http://127.0.0.1:${server.address().port}/harness.html`);
      await page.evaluate(async (transport) => {
        const { ThePlayer, mountControls } = await import('/player.js');
        const video = document.querySelector('video'),
          screen = document.createElement('div');
        screen.className = 'screen';
        screen.style.width = '900px';
        video.before(screen);
        screen.append(video);
        const css = document.createElement('link');
        css.rel = 'stylesheet';
        css.href = '/style.css';
        document.head.append(css);
        window.player = new ThePlayer(video);
        window.errors = [];
        window.endedInterstitial = false;
        window.player.addEventListener('error', (e) =>
          window.errors.push(String(e.detail)),
        );
        window.player.addEventListener(
          'interstitialend',
          () => (window.endedInterstitial = true),
        );
        window.controls = mountControls(
          screen,
          video,
          () => window.player,
          (e) => window.errors.push(e),
          { skipLabels: { Continue: 'Continue <watching>' } },
        );
        await window.player.load({
          protocol: 'hls',
          url:
            location.origin +
            '/scenario/ui-' +
            transport +
            '/interstitial-ui/index.m3u8',
          network: { transport },
          autoplay: false,
        });
      }, transport);
      await page.waitForFunction(
        () =>
          document.querySelector('.timeline-marker') &&
          document.querySelector('video').readyState >= 2,
      );
      const before = await page.evaluate(() => {
        const seek = document.querySelector('#seek-bar'),
          marker = document.querySelector('.timeline-marker');
        return {
          time: window.player.timelineMarkers[0].time,
          end: window.player.timelineMarkers[0].end,
          markerLeft: parseFloat(marker.style.left),
          markerWidth: parseFloat(marker.style.width),
          duration: document.querySelector('video').duration,
          seekWidth: seek.getBoundingClientRect().width,
          child: marker.childElementCount,
        };
      });
      assert.equal(before.time, 2);
      assert.equal(before.end, 4);
      assert.ok(before.seekWidth > 100);
      assert.ok(Math.abs(before.markerLeft - 200 / before.duration) < 0.001);
      assert.ok(Math.abs(before.markerWidth - 200 / before.duration) < 0.001);
      await page.evaluate(() => document.querySelector('video').play());
      const skip = page.locator('#interstitial-skip');
      await skip.waitFor({ state: 'visible', timeout: 15000 });
      assert.equal(await skip.textContent(), 'Continue <watching>');
      assert.equal(await skip.locator('*').count(), 0);
      assert.equal(await page.locator('#timeline-markers').isVisible(), false);
      await skip.click();
      await page.waitForFunction(() => window.endedInterstitial, null, {
        timeout: 15000,
      });
      await page.waitForFunction(
        () => !document.querySelector('#timeline-markers').hidden,
      );
      assert.deepEqual(await page.evaluate(() => window.errors), []);
      await page.evaluate(() => {
        window.controls.destroy();
        return window.player.destroy();
      });
      console.log(
        'PASS interstitial timeline range, localized safe skip label and restoration',
        name,
        transport,
      );
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
