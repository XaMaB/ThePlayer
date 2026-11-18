import { chromium, firefox, webkit } from 'playwright';
import assert from 'node:assert/strict';
import { faultServer } from './helpers/hls-fault-server.mjs';
const { server } = faultServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const name = process.env.HLS_TEST_BROWSER ?? 'chromium';
const browser = await { chromium, firefox, webkit }[name].launch(
  name === 'chromium'
    ? { args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] }
    : {},
);
try {
  for (const scenario of [
    'delayed-fetch',
    'delayed-xhr',
    'timeout',
    'destroy',
  ]) {
    const page = await browser.newPage();
    const errors = [];
    let waitingSince;
    let reloads = 0;
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route('**/switch-*.m3u8', (route) => {
      const url = route.request().url();
      if (url.endsWith('switch-master.m3u8'))
        return route.fulfill({
          body: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=300000,CODECS="avc1.42c00c,mp4a.40.2"\nswitch-low.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=600000,CODECS="avc1.42c00c,mp4a.40.2"\nswitch-high.m3u8\n',
        });
      const low = url.endsWith('switch-low.m3u8');
      if (low) {
        waitingSince ??= Date.now();
        reloads++;
      }
      const waiting =
        low &&
        (!scenario.startsWith('delayed') || Date.now() - waitingSince < 7000);
      let body = '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n';
      for (let i = 0; i <= (waiting ? 0 : 11); i++)
        body += `#EXTINF:2,\n/fixture/ts/segment${String(i).padStart(2, '0')}.ts\n`;
      return route.fulfill({
        contentType: 'application/vnd.apple.mpegurl',
        body,
      });
    });
    await page.goto(base + '/harness.html');
    await page.evaluate(async (scenario) => {
      const { ThePlayer } = await import('/player.js');
      window.failures = [];
      window.player = new ThePlayer(document.querySelector('video'));
      window.player.addEventListener('error', (e) =>
        window.failures.push(String(e.detail)),
      );
      await window.player.load({
        protocol: 'hls',
        url: location.origin + '/switch-master.m3u8',
        quality: 1,
        startTime: 0,
        targetBuffer: 4,
        network: { transport: scenario.endsWith('xhr') ? 'xhr' : 'fetch' },
      });
    }, scenario);
    await page.waitForFunction(
      () => document.querySelector('video').currentTime > 0.5,
    );
    await page.evaluate(() => {
      window.switchDone = false;
      window.switchError = '';
      void window.player.selectQuality(0).then(
        () => {
          window.switchDone = true;
        },
        (e) => {
          window.switchError = String(e);
        },
      );
    });
    if (scenario === 'destroy') {
      await page.waitForFunction(
        () => window.player.diagnostics.renditionSwitchWaits > 0,
      );
      await page.evaluate(() => window.player.destroy());
      await page.waitForFunction(() => !!window.switchError);
    } else {
      await page.waitForFunction(
        () => window.switchDone || window.switchError,
        null,
        { timeout: 20000 },
      );
      const state = await page.evaluate(() => ({
        error: window.switchError,
        done: window.switchDone,
        time: document.querySelector('video').currentTime,
        quality: window.player.selectedQuality,
        failures: window.failures,
        restarts: window.player.diagnostics.live.restarts,
      }));
      assert.deepEqual(state.failures, []);
      assert.equal(state.restarts, 0);
      assert.ok(
        state.time > 6,
        'The active rendition must keep playing while the target is unavailable',
      );
      if (scenario === 'timeout') {
        assert.match(state.error, /current rendition retained/);
        assert.equal(state.quality, 1);
      } else {
        assert.equal(state.error, '');
        assert.equal(state.done, true);
        assert.equal(state.quality, 0);
        await page.waitForFunction(
          () => document.querySelector('video').currentTime > 9,
        );
      }
      assert.ok(
        reloads >= 5 && reloads <= 15,
        'Bounded, paced playlist updates',
      );
      await page.evaluate(() => window.player.destroy());
    }
    assert.deepEqual(errors, []);
    await page.close();
    console.log(`${name} ${scenario}: rendition wait PASS`);
  }
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
