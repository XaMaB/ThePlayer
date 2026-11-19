import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { dashServer } from './helpers/dash-server.mjs';
const seconds = Number(process.env.DASH_SOAK_SECONDS ?? 180);
if (!Number.isFinite(seconds) || seconds < 30)
  throw new Error('Invalid soak duration');
const { server, controls } = dashServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
});
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/harness.html`);
  await page.evaluate(async () => {
    const { ThePlayer } = await import('/player.js');
    window.player = new ThePlayer(document.querySelector('video'));
    window.errors = [];
    player.addEventListener('error', (e) => errors.push(e.detail.message));
    await player.load({
      protocol: 'dash',
      url: location.origin + '/dash/ll-soak.mpd',
      targetBuffer: 4,
      latencyControl: true,
      liveRecoveryWindowMs: 10000,
    });
  });
  await page.waitForFunction(
    () => document.querySelector('video').currentTime > 5,
  );
  const started = Date.now();
  let previous,
    iteration = 0,
    maxLatency = 0,
    minLatency = Infinity,
    maxBuffer = 0;
  while (Date.now() - started < seconds * 1000) {
    await page.waitForTimeout(5000);
    const sample = await page.evaluate(() => ({
      time: document.querySelector('video').currentTime,
      frames: document.querySelector('video').getVideoPlaybackQuality()
        .totalVideoFrames,
      latency: player.diagnostics.lowLatency.latency,
      buffer: player.diagnostics.buffer.ahead,
      chunks: player.diagnostics.lowLatency.chunks,
      throughputSamples: player.diagnostics.lowLatency.throughputSamples,
      restarts: player.diagnostics.recovery.restarts,
      errors,
    }));
    assert.deepEqual(sample.errors, []);
    assert.equal(sample.restarts, 0);
    if (previous) {
      assert.ok(
        sample.time > previous.time + 1,
        'Playback advances under producer pacing',
      );
      assert.ok(sample.frames > previous.frames + 20);
    }
    assert.ok(sample.buffer < 12);
    assert.ok(sample.latency < 12);
    maxLatency = Math.max(maxLatency, sample.latency);
    minLatency = Math.min(minLatency, sample.latency);
    maxBuffer = Math.max(maxBuffer, sample.buffer);
    previous = sample;
    iteration++;
    if (iteration % 6 === 2) {
      controls.mediaFailures = 1;
      controls.manifestFailures = 1;
    }
    if (iteration % 6 === 0)
      console.log(
        'LL-DASH soak progress',
        Math.round((Date.now() - started) / 1000),
        sample,
      );
  }
  assert.ok(previous.chunks > 10);
  assert.ok(previous.throughputSamples > 0);
  await page.evaluate(() => player.destroy());
  console.log('LL-DASH paced/jitter/fault soak PASS', {
    seconds: (Date.now() - started) / 1000,
    minLatency,
    maxLatency,
    maxBuffer,
    frames: previous.frames,
  });
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
