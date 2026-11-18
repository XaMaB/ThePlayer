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
    : name === 'firefox'
      ? {
          firefoxUserPrefs: {
            'media.autoplay.default': 0,
            'media.autoplay.block-webaudio': false,
          },
        }
      : {},
);
try {
  for (const kind of ['ts', 'mp4', 'packed'])
    for (const transport of ['fetch', 'xhr']) {
      const page = await browser.newPage({ ignoreHTTPSErrors: true });
      try {
        await page.goto(base + '/harness.html');
        await page.evaluate(
          async ({ kind, transport }) => {
            const { ThePlayer } = await import('/player.js');
            const video = document.querySelector('video');
            window.player = new ThePlayer(video);
            window.errors = [];
            window.player.addEventListener('error', (e) =>
              window.errors.push(String(e.detail)),
            );
            window.audio = new AudioContext();
            const source = window.audio.createMediaElementSource(video),
              split = window.audio.createChannelSplitter(2);
            source.connect(split);
            const sink = window.audio.createGain();
            sink.gain.value = 0;
            sink.connect(window.audio.destination);
            window.analysers = [0, 1].map((channel) => {
              const a = window.audio.createAnalyser();
              a.fftSize = 8192;
              split.connect(a, channel);
              a.connect(sink);
              return a;
            });
            source.connect(window.audio.destination);
            video.muted = false;
            const start = document.createElement('button');
            start.textContent = 'Start audio test';
            start.id = 'start-audio';
            start.addEventListener('click', () => {
              void window.audio.resume();
              void video.play();
            });
            document.body.append(start);
            void window.audio.resume();
            window.loading = window.player
              .load({
                protocol: 'hls',
                url:
                  location.origin +
                  '/fixture/heaac-v2-' +
                  kind +
                  '/master.m3u8',
                network: { transport },
              })
              .catch((e) => window.errors.push(String(e)));
            window.peaks = () =>
              window.analysers.map((a) => {
                const bins = new Float32Array(a.frequencyBinCount);
                a.getFloatFrequencyData(bins);
                let max = -Infinity,
                  index = 0;
                for (let i = 1; i < bins.length; i++)
                  if (bins[i] > max) {
                    max = bins[i];
                    index = i;
                  }
                return {
                  hz: (index * window.audio.sampleRate) / a.fftSize,
                  db: max,
                };
              });
          },
          { kind, transport },
        );
        await page.locator('#start-audio').click();
        await page.waitForFunction(
          () =>
            window.errors.length ||
            (document.querySelector('video').currentTime > 2 &&
              window.peaks().every((p) => p.db > -60)),
          null,
          { timeout: 25000 },
        );
        assert.deepEqual(await page.evaluate(() => window.errors), []);
        const peaks = await page.evaluate(() => window.peaks());
        assert.ok(Math.abs(peaks[0].hz - 440) < 15, JSON.stringify(peaks));
        assert.ok(Math.abs(peaks[1].hz - 880) < 15, JSON.stringify(peaks));
        await page.evaluate(() => {
          const v = document.querySelector('video');
          v.pause();
          v.currentTime = 9;
        });
        await page.waitForFunction(
          () =>
            !document.querySelector('video').seeking &&
            document.querySelector('video').readyState >= 2,
        );
        await page.evaluate(
          () => (document.querySelector('video').currentTime = 1),
        );
        await page.waitForFunction(
          () =>
            !document.querySelector('video').seeking &&
            document.querySelector('video').readyState >= 2,
        );
        assert.deepEqual(await page.evaluate(() => window.errors), []);
        await page.evaluate(async () => {
          await window.player.destroy();
          await window.audio.close();
        });
        console.log(
          'PASS HE-AAC v2 stereo frequencies and bidirectional seek',
          name,
          kind,
          transport,
          peaks,
        );
      } catch (error) {
        console.error(
          await page.evaluate(() => ({
            errors: window.errors,
            diagnostics: window.player?.diagnostics,
            audioState: window.audio?.state,
            video: (() => {
              const v = document.querySelector('video');
              return {
                time: v.currentTime,
                paused: v.paused,
                ended: v.ended,
                ready: v.readyState,
                error: v.error?.message,
                buffer: Array.from({ length: v.buffered.length }, (_, i) => [
                  v.buffered.start(i),
                  v.buffered.end(i),
                ]),
              };
            })(),
            peaks: window.peaks?.(),
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
  await new Promise((resolve) => server.close(resolve));
}
