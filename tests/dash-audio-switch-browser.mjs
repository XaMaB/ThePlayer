import assert from 'node:assert/strict';
import { chromium, firefox, webkit } from 'playwright';
import { dashServer } from './helpers/dash-server.mjs';
const { server } = dashServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const name = process.env.DASH_TEST_BROWSER ?? 'chromium';
const browser = await { chromium, firefox, webkit }[name].launch({
  ...(name === 'chromium'
    ? { args: ['--autoplay-policy=no-user-gesture-required'] }
    : {}),
});
try {
  // Subtitle Adaptations contain BigInt timeline fields in real DASH catalogs.
  const demo = await browser.newPage(),
    demoErrors = [];
  demo.on('pageerror', (e) => demoErrors.push(e.message));
  await demo.goto(
    base +
      '/index.html?' +
      new URLSearchParams({ src: base + '/dash/text.mpd' }),
  );
  await demo.waitForFunction(() => window.player?.video.currentTime > 0.3);
  assert.match(
    await demo.locator('#details').textContent(),
    /presentationTimeOffset/,
  );
  assert.deepEqual(demoErrors, []);
  await demo.close();
  for (const mode of ['timeline', 'audio', 'hierarchical']) {
    const page = await browser.newPage(),
      errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(base + '/harness.html');
    await page.evaluate(
      async (url) => {
        const { ThePlayer } = await import('/player.js');
        const video = document.querySelector('video');
        window.seekEvents = [];
        video.addEventListener('seeking', () =>
          window.seekEvents.push({
            time: video.currentTime,
            media: player.engine?.media?.readyState,
          }),
        );
        window.player = new ThePlayer(video);
        window.failures = [];
        player.addEventListener('error', (e) =>
          failures.push(String(e.detail)),
        );
        await player.load({
          protocol: 'dash',
          url,
          quality: 0,
          targetBuffer: 12,
          audioLanguage: 'eng',
          network: { retries: 0, recoveryWindowMs: 0 },
        });
        await video.play();
      },
      base + '/dash/' + mode + '.mpd',
    );
    await page.waitForFunction(
      () =>
        player.video.currentTime > 0.4 &&
        player.video.buffered.length &&
        player.video.buffered.end(0) > 10,
    );
    if (name === 'chromium') {
      await page.evaluate(async () => {
        player.video.muted = false;
        const context = new AudioContext(),
          analyser = context.createAnalyser();
        analyser.fftSize = 4096;
        context.createMediaElementSource(player.video).connect(analyser);
        analyser.connect(context.destination);
        await context.resume();
        window.audioTest = { context, analyser };
      });
      await tone(page, 440);
    }
    if (mode !== 'hierarchical') {
      await page.route('**/dash/init-3.mp4', (route) =>
        route.fulfill({ status: 503, body: 'Test unavailable audio' }),
      );
      const failed = await page.evaluate(async () => {
        const selected = player.selectedAudioTrack;
        try {
          await player.selectAudioTrack(player.audioTracks[1].name);
          return { rejected: false };
        } catch {
          return {
            rejected: true,
            retained: player.selectedAudioTrack === selected,
          };
        }
      });
      assert.deepEqual(failed, { rejected: true, retained: true });
      assert.deepEqual(await page.evaluate(() => failures), []);
      if (name === 'chromium') await tone(page, 440);
      await page.unroute('**/dash/init-3.mp4');
    }
    const first = await page.evaluate(async () => {
      const before = player.video.currentTime;
      await player.selectAudioTrack(player.audioTracks[1].name);
      return {
        before,
        after: player.video.currentTime,
        change: player.diagnostics.switches.at(-1),
      };
    });
    assert.ok(
      first.change.effectiveAt <= first.after + 0.2,
      JSON.stringify(first),
    );
    assert.ok(
      first.change.effectiveAt < first.before + 1,
      JSON.stringify(first),
    );
    if (name === 'chromium') await tone(page, 880, 2000);
    await page
      .evaluate(() =>
        Promise.all([
          player.selectAudioTrack(player.audioTracks[0].name),
          player.selectAudioTrack(player.audioTracks[1].name),
        ]),
      )
      .catch(async (e) => {
        console.error(
          await page.evaluate(() => ({
            time: player.video.currentTime,
            seeks: window.seekEvents,
            switches: player.diagnostics.switches,
            media: player.engine.media.readyState,
          })),
        );
        throw e;
      });
    assert.equal(await page.evaluate(() => player.selectedAudioTrack), '2');
    if (name === 'chromium') await tone(page, 880, 2000);
    // At EOF all old audio has already been downloaded: no future boundary exists.
    await page.evaluate(() => {
      player.video.pause();
      player.video.currentTime = 22;
    });
    await page.waitForFunction(
      () =>
        !player.video.seeking &&
        player.video.buffered.length &&
        player.video.buffered.end(player.video.buffered.length - 1) > 23.9,
    );
    await page.evaluate(() =>
      player.selectAudioTrack(player.audioTracks[0].name),
    );
    await page.evaluate(() =>
      Promise.all([
        player.selectAudioTrack(player.audioTracks[1].name),
        player.selectAudioTrack(player.audioTracks[0].name),
      ]),
    );
    const tail = await page.evaluate(() => ({
      time: player.video.currentTime,
      change: player.diagnostics.switches.at(-1),
      paused: player.video.paused,
    }));
    assert.equal(tail.paused, true);
    assert.ok(tail.change.effectiveAt < 22.3, JSON.stringify(tail));
    await page.evaluate(() => player.video.play());
    if (name === 'chromium') await tone(page, 440, 2000);
    await page
      .waitForFunction(() => player.video.ended, null, { timeout: 8000 })
      .catch(async (e) => {
        console.error(
          JSON.stringify(
            await page.evaluate(() => ({
              time: player.video.currentTime,
              duration: player.video.duration,
              ready: player.video.readyState,
              paused: player.video.paused,
              mediaState: player.engine?.media?.readyState,
              signalledEnd: player.engine?.ended,
              diagnostics: player.diagnostics,
              lanes: player.engine?.lanes.map((l) => ({
                kind: l.adaptation.kind,
                cursor: l.cursor,
                done: l.done,
                ranges: Array.from(
                  { length: l.buffer.buffered.length },
                  (_, i) => [
                    l.buffer.buffered.start(i),
                    l.buffer.buffered.end(i),
                  ],
                ),
              })),
            })),
          ),
        );
        throw e;
      });
    // Replaying/rewinding must not retain the temporary appendWindowStart.
    await page.evaluate(() => {
      player.video.currentTime = 1;
      player.video.play();
    });
    await page.waitForFunction(
      () => player.video.currentTime > 1.5 && !player.video.seeking,
    );
    assert.deepEqual(await page.evaluate(() => failures), []);
    assert.deepEqual(errors, []);
    await page.evaluate(async () => {
      await window.audioTest?.context.close();
      await player.destroy();
    });
    await page.close();
    console.log(
      'PASS DASH immediate audio switch, tail/paused switch, EOS and rewind',
      name,
      mode,
    );
  }
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
}
async function tone(page, hz, timeout = 5000) {
  await page.waitForFunction(
    (hz) => {
      const { context, analyser } = window.audioTest;
      const data = new Float32Array(analyser.frequencyBinCount);
      analyser.getFloatFrequencyData(data);
      let peak = 0;
      for (let i = 1; i < data.length; i++) if (data[i] > data[peak]) peak = i;
      return (
        data[peak] > -70 &&
        Math.abs((peak * context.sampleRate) / analyser.fftSize - hz) < 35
      );
    },
    hz,
    { timeout },
  );
}
