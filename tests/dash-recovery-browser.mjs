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
  for (const scenario of process.env.DASH_RECOVERY_SCENARIOS?.split(',') ?? [
    'manifest',
    'media',
    'pause',
    'ended',
    'exhausted',
    'authorization',
    'expired',
    'representation',
    'period',
    'patch',
    'clock',
    'clock-paused',
    'topology',
  ]) {
    for (const transport of ['fetch', 'xhr']) {
      const { server, controls } = dashServer();
      if (scenario === 'pause' || scenario === 'expired') controls.depth = 4;
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      if (scenario === 'patch') controls.patch = true;
      const page = await browser.newPage();
      const faults = [];
      page.on('pageerror', (e) => faults.push(e.message));
      try {
        await page.goto(
          `http://127.0.0.1:${server.address().port}/harness.html`,
        );
        await page.evaluate(
          async ({ transport, scenario }) => {
            const { ThePlayer } = await import('/player.js');
            window.player = new ThePlayer(document.querySelector('video'));
            window.errors = [];
            window.player.addEventListener('error', (e) =>
              window.errors.push(e.detail.message),
            );
            await window.player.load({
              protocol: 'dash',
              url: location.origin + '/dash/live.mpd',
              quality: scenario === 'representation' ? 1 : 0,
              targetBuffer: 4,
              liveRecoveryWindowMs: scenario === 'exhausted' ? 1000 : 10000,
              network: { transport },
            });
          },
          { transport, scenario },
        );
        await page.waitForFunction(
          () =>
            document.querySelector('video').currentTime > 4 &&
            document.querySelector('video').readyState >= 3,
        );
        const before = await page
          .locator('video')
          .evaluate((v) => v.currentTime);
        if (scenario === 'clock-paused') {
          await page.locator('video').evaluate((v) => v.pause());
          controls.clockShift = 2000;
          await page.waitForFunction(
            () =>
              window.player.diagnostics.recovery.restarts === 1 &&
              document.querySelector('video').readyState >= 2,
          );
          await page.waitForTimeout(300);
          assert.equal(
            await page.locator('video').evaluate((v) => v.paused),
            true,
            'Clock recovery preserves explicit pause',
          );
          await page.locator('video').evaluate((v) => v.play());
        }
        if (scenario === 'topology') controls.removeAudio = true;
        if (scenario === 'clock') controls.clockShift = 2000;
        if (scenario === 'patch') controls.badPatch = 1;
        if (scenario === 'representation') controls.removeVideo = true;
        if (scenario === 'period') controls.replacePeriod = true;
        if (scenario === 'manifest') controls.manifestFailures = 3;
        if (scenario === 'media') controls.mediaFailures = 3;
        if (scenario === 'expired') {
          controls.status = 410;
          controls.mediaFailures = 1;
          controls.mediaDelayMs = 7000;
        }
        if (scenario === 'exhausted') controls.manifestFailures = 1000;
        if (scenario === 'authorization') {
          controls.status = 403;
          controls.manifestFailures = 1;
        }
        if (scenario === 'pause') {
          await page.locator('video').evaluate((v) => v.pause());
          await page.waitForTimeout(5500);
          assert.ok(
            Math.abs(
              (await page.locator('video').evaluate((v) => v.currentTime)) -
                before,
            ) < 0.3,
            'Pause must not move the playhead',
          );
          await page.locator('video').evaluate((v) => v.play());
          await page.waitForFunction(
            () => window.player.diagnostics.recovery.dvrJumps > 0,
          );
        }
        if (scenario === 'ended') {
          controls.finish = true;
          await page.waitForFunction(() => !window.player.isLive);
          await page.locator('video').evaluate((v) => {
            v.currentTime = 22;
          });
          await page.waitForFunction(
            () => document.querySelector('video').ended,
          );
        } else if (scenario === 'exhausted' || scenario === 'authorization') {
          await page.waitForFunction(() => window.errors.length, null, {
            timeout: 7000,
          });
          const errors = await page.evaluate(() => window.errors);
          assert.equal(errors.length, 1);
          assert.match(
            errors[0],
            scenario === 'exhausted' ? /recovery window exhausted/ : /403/,
          );
        } else {
          await page.waitForFunction(
            (t) => document.querySelector('video').currentTime > t + 6,
            before,
            { timeout: 20000 },
          );
          if (scenario === 'expired') {
            const deadline = Date.now() + 15000;
            while (!controls.mediaFailureResponses && Date.now() < deadline)
              await new Promise((r) => setTimeout(r, 100));
            assert.equal(controls.mediaFailureResponses, 1);
          }
          const frames = await page
            .locator('video')
            .evaluate((v) => v.getVideoPlaybackQuality().totalVideoFrames);
          await page.waitForFunction(
            (n) =>
              document.querySelector('video').getVideoPlaybackQuality()
                .totalVideoFrames >
              n + 25,
            frames,
            { timeout: 12000 },
          );
          const d = await page.evaluate(() => window.player.diagnostics);
          if (scenario === 'topology') {
            assert.equal(d.recovery.restarts, 1);
            assert.equal(
              await page.evaluate(() => window.player.audioTracks.length),
              0,
            );
            controls.removeAudio = false;
            await page.waitForFunction(
              () => window.player.diagnostics.recovery.restarts === 2,
            );
            await page.waitForFunction(
              () => document.querySelector('video').readyState >= 3,
            );
            assert.equal(
              await page.evaluate(() => window.player.audioTracks.length),
              2,
            );
          }
          if (scenario === 'clock' || scenario === 'clock-paused')
            assert.equal(d.recovery.restarts, 1);
          if (scenario === 'patch') {
            assert.equal(d.patches.fallbacks, 1);
            assert.ok(d.patches.applied >= 2);
          }
          if (scenario === 'representation' || scenario === 'period')
            assert.equal(d.recovery.manifestTransitions, 1);
          if (scenario === 'representation')
            assert.equal(
              await page.evaluate(() => window.player.qualityLevels.length),
              1,
            );
          if (scenario === 'manifest')
            assert.equal(d.recovery.manifestFailures, 3);
          if (scenario === 'expired')
            assert.ok(
              d.recovery.expiredSegments >= 1 || d.recovery.dvrJumps >= 1,
            );
          if (scenario === 'media') assert.equal(d.recovery.segmentFailures, 3);
          assert.deepEqual(await page.evaluate(() => window.errors), []);
        }
        assert.deepEqual(faults, []);
        console.log(name, transport, scenario, 'PASS');
      } catch (e) {
        console.log(
          await page.evaluate(() => ({
            errors: window.errors,
            diagnostics: window.player?.diagnostics,
            time: document.querySelector('video').currentTime,
          })),
        );
        throw e;
      } finally {
        await page.evaluate(() => window.player?.destroy());
        await page.close();
        await new Promise((r) => server.close(r));
      }
    }
  }
} finally {
  await browser.close();
}
