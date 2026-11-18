import { chromium, firefox, webkit } from 'playwright';
import assert from 'node:assert/strict';
import { faultServer } from './helpers/hls-fault-server.mjs';
const { server } = faultServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base =
    process.env.HLS_RECOVERY_BASE ??
    `http://127.0.0.1:${server.address().port}`,
  name = process.env.HLS_TEST_BROWSER ?? 'chromium';
const browser = await { chromium, firefox, webkit }[name].launch(
  name === 'chromium'
    ? { args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] }
    : {},
);
try {
  for (const transport of ['fetch', 'xhr']) {
    const page = await browser.newPage({ ignoreHTTPSErrors: true });
    try {
      await page.goto(base + '/harness.html');
      await page.evaluate(
        async ({ url, transport }) => {
          const { ThePlayer } = await import('/player.js');
          window.player = new ThePlayer(document.querySelector('video'));
          window.events = [];
          window.errors = [];
          for (const type of [
            'daterange',
            'daterangecue',
            'daterangeenter',
            'daterangeexit',
            'metadatawarning',
          ])
            window.player.addEventListener(type, (e) =>
              window.events.push({
                type,
                id: e.detail.id,
                cause: e.detail.cause,
                time: document.querySelector('video').currentTime,
              }),
            );
          window.player.addEventListener('error', (e) =>
            window.errors.push(String(e.detail)),
          );
          window.loading = window.player
            .load({ protocol: 'hls', url, network: { transport } })
            .catch((e) => window.errors.push(String(e)));
        },
        {
          url: `${base}/scenario/date-${transport}-${Date.now().toString(36)}/dateranges/index.m3u8`,
          transport,
        },
      );
      await page.waitForFunction(
        () =>
          document.querySelector('video').currentTime > 4 ||
          window.errors.length,
        null,
        { timeout: 15000 },
      );
      assert.deepEqual(await page.evaluate(() => window.errors), []);
      await page.evaluate(() => {
        document.querySelector('video').currentTime = 0.2;
      });
      await page.waitForFunction(
        () =>
          document.querySelector('video').currentTime > 2 &&
          window.events.filter(
            (e) => e.type === 'daterangecue' && e.id === 'again',
          ).length === 2,
      );
      await page.evaluate(() => {
        const video = document.querySelector('video');
        video.currentTime = video.duration - 1;
      });
      await page.waitForFunction(
        () => document.querySelector('video').ended,
        null,
        { timeout: 10000 },
      );
      const events = await page.evaluate(() => window.events),
        cues = events.filter((e) => e.type === 'daterangecue');
      assert.equal(cues.filter((e) => e.id === 'once').length, 1);
      assert.equal(cues.filter((e) => e.id === 'again').length, 2);
      assert.equal(cues[0].id, 'pre');
      assert.equal(cues.at(-1).id, 'post');
      assert.ok(events.some((e) => e.type === 'metadatawarning'));
      assert.equal(events.filter((e) => e.type === 'daterange').length, 4);
      assert.ok(
        events.some((e) => e.type === 'daterangeexit' && e.id === 'again'),
      );
      assert.deepEqual(await page.evaluate(() => window.errors), []);
      await page.evaluate(() => window.player.destroy());
      console.log(
        'PASS date range playback cues, replay, warnings and post-roll',
        name,
        transport,
      );
    } catch (error) {
      console.error(
        await page.evaluate(() => ({
          errors: window.errors,
          events: window.events,
          diag: window.player?.diagnostics,
          time: document.querySelector('video').currentTime,
        })),
      );
      throw error;
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
}
