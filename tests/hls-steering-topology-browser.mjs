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
    for (const scenario of process.env.HLS_TOPOLOGY_SCENARIOS?.split(',') ?? [
      'forward',
      'reverse',
      'paused',
      'preflight',
      'live',
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
                  '/scenario/topology-' +
                  transport +
                  '-' +
                  scenario +
                  '-' +
                  Date.now() +
                  '/steering-topology-' +
                  scenario +
                  '/master.m3u8',
                quality: 0,
                targetBuffer: 4,
                network: { transport },
              })
              .catch((e) => window.errors.push(String(e)));
          },
          { transport, scenario },
        );
        await page.waitForFunction(
          () =>
            window.errors.length ||
            document.querySelector('video').currentTime > 0.5,
        );
        const before = await page.evaluate((paused) => {
          const video = document.querySelector('video');
          if (paused) video.pause();
          return { src: video.src, time: video.currentTime };
        }, scenario === 'paused');
        if (scenario === 'paused') {
          await page.waitForFunction(
            () =>
              window.errors.length ||
              (window.player.diagnostics?.topologySwitches === 1 &&
                document.querySelector('video').currentTime > 0.45 &&
                !document.querySelector('video').seeking),
          );
          const state = await page.evaluate(() => ({
            time: document.querySelector('video').currentTime,
            paused: document.querySelector('video').paused,
            errors: window.errors,
          }));
          assert.deepEqual(state.errors, []);
          assert.equal(state.paused, true);
          assert.ok(Math.abs(state.time - before.time) < 0.06);
          await page.evaluate(() => window.player.play());
        }
        await page.waitForFunction(
          () =>
            window.errors.length ||
            document.querySelector('video').currentTime > 8,
          null,
          { timeout: 20000 },
        );
        const state = await page.evaluate(() => ({
          errors: window.errors,
          diagnostics: window.player.diagnostics,
          live: window.player.isLive,
          audio: window.player.audioTracks,
          src: document.querySelector('video').src,
          width: document.querySelector('video').videoWidth,
          frames: document.querySelector('video').getVideoPlaybackQuality()
            .totalVideoFrames,
        }));
        assert.deepEqual(state.errors, []);
        assert.equal(
          state.diagnostics.topologySwitches,
          scenario === 'preflight' ? 0 : 1,
        );
        assert.equal(
          state.diagnostics.steering.pathway,
          scenario === 'preflight' ? 'a' : 'b',
        );
        assert.equal(state.src === before.src, scenario === 'preflight');
        assert.equal(
          state.audio.length,
          ['reverse', 'preflight'].includes(scenario) ? 0 : 1,
        );
        assert.equal(state.live, scenario === 'live');
        assert.equal(state.width, 320);
        assert.ok(state.frames > 100);
        await page.evaluate(() => window.player.destroy());
        console.log(
          'PASS muxed/separate audio topology, preflight and position preservation',
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
