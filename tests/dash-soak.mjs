// Original repeated synthetic media with advancing decode clocks; no external source.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { dashServer } from './helpers/dash-server.mjs';
const seconds = Number(process.env.DASH_SOAK_SECONDS ?? 180);
if (!Number.isFinite(seconds) || seconds < 30)
  throw new Error('DASH_SOAK_SECONDS must be at least 30');
const { server, controls } = dashServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
});
try {
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/harness.html`);
  await page.evaluate(async () => {
    const { ThePlayer } = await import('/player.js');
    window.player = new ThePlayer(document.querySelector('video'));
    window.errors = [];
    window.player.addEventListener('error', (e) =>
      window.errors.push(e.detail.message),
    );
    await window.player.load({
      protocol: 'dash',
      url: location.origin + '/dash/soak.mpd',
      targetBuffer: 6,
      liveRecoveryWindowMs: 10000,
    });
  });
  await page.waitForFunction(
    () => document.querySelector('video').currentTime > 5,
  );
  const started = Date.now();
  let previous,
    iteration = 0,
    minBuffer = Infinity,
    maxBuffer = 0,
    maxHeap = 0;
  while (Date.now() - started < seconds * 1000) {
    await page.waitForTimeout(5000);
    const sample = await page.evaluate(() => ({
      time: document.querySelector('video').currentTime,
      frames: document.querySelector('video').getVideoPlaybackQuality()
        .totalVideoFrames,
      buffer: window.player.diagnostics.buffer.ahead,
      restarts: window.player.diagnostics.recovery.restarts,
      errors: window.errors,
      heap: performance.memory?.usedJSHeapSize ?? 0,
    }));
    assert.deepEqual(sample.errors, []);
    assert.deepEqual(pageErrors, []);
    assert.equal(sample.restarts, 0);
    if (previous) {
      assert.ok(
        sample.time > previous.time + 1,
        'Playback advances through faults and switches',
      );
      assert.ok(sample.frames > previous.frames + 20, 'Video keeps decoding');
    }
    assert.ok(sample.buffer < 15, 'Buffer stays bounded');
    minBuffer = Math.min(minBuffer, sample.buffer);
    maxBuffer = Math.max(maxBuffer, sample.buffer);
    maxHeap = Math.max(maxHeap, sample.heap);
    previous = sample;
    iteration++;
    if (iteration % 4 === 1)
      await page.evaluate(
        async (i) => {
          await window.player.selectQuality(i % 3 === 0 ? -1 : i % 2);
          await window.player.selectAudioTrack(
            window.player.audioTracks[i % 2].name,
          );
        },
        Math.floor(iteration / 4),
      );
    if (iteration % 6 === 2) {
      controls.manifestFailures = 1;
      controls.mediaFailures = 1;
    }
    if (iteration % 8 === 3) {
      await page.locator('video').evaluate((v) => v.pause());
      await page.waitForTimeout(1500);
      await page.locator('video').evaluate((v) => v.play());
    }
    if (iteration % 6 === 0)
      console.log(
        'DASH soak progress',
        Math.round((Date.now() - started) / 1000),
        sample,
      );
  }
  await page.evaluate(() => window.player.destroy());
  console.log('DASH live soak PASS', {
    seconds: (Date.now() - started) / 1000,
    samples: iteration,
    minBuffer,
    maxBuffer,
    maxHeap,
    frames: previous.frames,
  });
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
