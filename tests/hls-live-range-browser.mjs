import { chromium, firefox, webkit } from 'playwright';
import assert from 'node:assert/strict';
import { faultServer } from './helpers/hls-fault-server.mjs';

// A refreshed window can include media older than the initial presentation zero.
// A quality switch aligns that older window with the running presentation.
// Keep its negative timeline coordinates internally, but never pass them to MSE.
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
  for (const direction of ['up', 'down']) {
    for (const transport of ['fetch', 'xhr']) {
      const page = await browser.newPage();
      const errors = [];
      const sessions = [];
      page.on('request', (request) => {
        const url = new URL(request.url());
        if (url.pathname.endsWith('.ts'))
          sessions.push(Number(url.searchParams.get('session')));
      });
      let reloads = 0;
      page.on('pageerror', (error) => errors.push(error.message));
      await page.route('**/negative-window.m3u8*', (route) => {
        reloads++;
        const first = !route.request().url().includes('wide=1');
        const start = first ? 4 : 0;
        const end = first ? 6 : 11;
        let body = `#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:${start}\n`;
        for (let i = start; i <= end; i++)
          body += `#EXTINF:2,\n/fixture/ts/segment${String(i).padStart(2, '0')}.ts?session=${reloads}\n`;
        return route.fulfill({
          contentType: 'application/vnd.apple.mpegurl',
          body,
        });
      });
      await page.route('**/range-master.m3u8', (route) =>
        route.fulfill({
          contentType: 'application/vnd.apple.mpegurl',
          body: `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=300000,CODECS="avc1.42c00c,mp4a.40.2"\nnegative-window.m3u8${direction === 'down' ? '?wide=1' : ''}\n#EXT-X-STREAM-INF:BANDWIDTH=600000,CODECS="avc1.42c00c,mp4a.40.2"\nnegative-window.m3u8${direction === 'up' ? '?wide=1' : ''}\n`,
        }),
      );
      await page.goto(base + '/harness.html');
      await page.evaluate(
        async ({ transport, direction }) => {
          const original = MediaSource.prototype.setLiveSeekableRange;
          window.ranges = [];
          MediaSource.prototype.setLiveSeekableRange = function (start, end) {
            window.ranges.push([start, end]);
            return original.call(this, start, end);
          };
          const { ThePlayer } = await import('/player.js');
          window.failures = [];
          window.player = new ThePlayer(document.querySelector('video'));
          window.player.addEventListener('error', (e) =>
            window.failures.push(String(e.detail)),
          );
          await window.player.load({
            protocol: 'hls',
            debug: direction === 'up' ? true : undefined,
            url: location.origin + '/range-master.m3u8',
            quality: direction === 'up' ? 0 : 1,
            targetBuffer: 4,
            network: { transport },
          });
        },
        { transport, direction },
      );
      await page.waitForFunction(
        () => document.querySelector('video').currentTime > 0.5,
      );
      await page.evaluate(
        (direction) => window.player.selectQuality(direction === 'up' ? 1 : 0),
        direction,
      );
      await page.waitForFunction(
        () =>
          window.failures.length ||
          document.querySelector('video').currentTime > 8,
        null,
        { timeout: 20000 },
      );
      const result = await page.evaluate(() => ({
        failures: window.failures,
        restarts: window.player.diagnostics.live.restarts,
        resetHistory: window.player.diagnostics.live.resetHistory,
        ranges: window.ranges,
        time: document.querySelector('video').currentTime,
        frames: document.querySelector('video').getVideoPlaybackQuality()
          .totalVideoFrames,
      }));
      assert.deepEqual(result.failures, []);
      assert.deepEqual(
        result.resetHistory,
        direction === 'up' ? [] : undefined,
      );
      assert.equal(
        result.restarts,
        0,
        'A quality switch must not restart the presentation',
      );
      assert.deepEqual(errors, []);
      assert.ok(reloads >= 3, 'Live playlist must keep refreshing');
      assert.ok(
        sessions.some((session) => session >= 3),
        'Downloads must retain refreshed query parameters',
      );
      assert.ok(
        result.time > 8 && result.frames > 100,
        'Playback must cross the initial three-segment window',
      );
      assert.ok(result.ranges.some(([start, end]) => start === 0 && end >= 16));
      assert.ok(
        result.ranges.every(([start, end]) => start >= 0 && end >= start),
      );
      await page.evaluate(() => window.player.destroy());
      await page.close();
      console.log(
        `${name} ${transport} ${direction}: negative live window playback PASS`,
      );
    }
  }
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
