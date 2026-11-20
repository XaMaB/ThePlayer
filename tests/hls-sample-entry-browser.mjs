import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chromium, firefox, webkit } from 'playwright';
import { faultServer } from './helpers/hls-fault-server.mjs';
import { withVideoTerminator } from './helpers/video-sample-terminator.mjs';
const fixtures =
  process.env.THEPLAYER_HLS_FIXTURES ??
  path.join(os.tmpdir(), 'theplayer-hls-fixtures');
const init = await readFile(path.join(fixtures, 'fmp4/init.mp4'));
const playlist = await readFile(path.join(fixtures, 'fmp4/index.m3u8'), 'utf8');
const { server } = faultServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const name = process.env.HLS_TEST_BROWSER ?? 'chromium';
const browser = await { chromium, firefox, webkit }[name].launch();
try {
  const page = await browser.newPage();
  const errors = [];
  let paddedRequests = 0;
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/sample-entry/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('master.m3u8'))
      return route.fulfill({
        contentType: 'application/vnd.apple.mpegurl',
        body: '#EXTM3U\n#EXT-X-INDEPENDENT-SEGMENTS\n#EXT-X-STREAM-INF:BANDWIDTH=400000\nclear.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=800000\npadded.m3u8\n',
      });
    if (url.pathname.endsWith('.m3u8'))
      return route.fulfill({
        contentType: 'application/vnd.apple.mpegurl',
        body: playlist
          .replace(
            'URI="init.mp4"',
            `URI="${url.pathname.includes('padded') ? 'padded' : 'clear'}.mp4"`,
          )
          .replace(/segment\d+\.m4s/g, (s) => base + '/fixture/fmp4/' + s),
      });
    const padded = url.pathname.endsWith('padded.mp4');
    if (padded) paddedRequests++;
    return route.fulfill({
      contentType: 'video/mp4',
      body: Buffer.from(padded ? withVideoTerminator(init) : init),
    });
  });
  await page.goto(base + '/harness.html');
  await page.evaluate(async (url) => {
    const { ThePlayer } = await import('/player.js');
    window.errors = [];
    window.player = new ThePlayer(document.querySelector('video'));
    window.player.addEventListener('error', (e) =>
      window.errors.push(String(e.detail)),
    );
    window.loading = window.player
      .load({ protocol: 'hls', url, quality: 0 })
      .catch((e) => window.errors.push(String(e)));
  }, base + '/sample-entry/master.m3u8');
  await page.waitForFunction(
    () => document.querySelector('video').currentTime > 1,
    null,
    { timeout: 30000 },
  );
  await page.evaluate(() => window.player.selectQuality(1));
  const boundary = await page.evaluate(
    () => window.player.diagnostics.switches.at(-1).effectiveAt,
  );
  await page.waitForFunction(
    (t) => document.querySelector('video').currentTime > t + 2,
    boundary,
    { timeout: 20000 },
  );
  assert.ok(paddedRequests > 0, 'switch loaded a terminated sample entry');
  assert.equal(await page.evaluate(() => window.player.currentQuality), 1);
  const before = await page.evaluate(
    () =>
      document.querySelector('video').getVideoPlaybackQuality()
        .totalVideoFrames,
  );
  await page.evaluate(() => {
    document.querySelector('video').currentTime = 12;
  });
  await page.waitForFunction(
    () => document.querySelector('video').currentTime > 14,
    null,
    { timeout: 20000 },
  );
  assert.ok(
    await page.evaluate(
      (n) =>
        document.querySelector('video').getVideoPlaybackQuality()
          .totalVideoFrames >
        n + 20,
      before,
    ),
    'frames continue after seek',
  );
  assert.deepEqual(await page.evaluate(() => window.errors), []);
  assert.deepEqual(errors, []);
  console.log(
    name,
    'QuickTime video sample terminator: quality switch and seek PASS',
  );
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
