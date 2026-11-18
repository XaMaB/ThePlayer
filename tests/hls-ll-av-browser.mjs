import { chromium, firefox, webkit } from 'playwright';
import assert from 'node:assert/strict';
import { faultServer } from './helpers/hls-fault-server.mjs';
const { server, requests } = faultServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base =
  process.env.HLS_RECOVERY_BASE ?? `http://127.0.0.1:${server.address().port}`;
const browserName = process.env.HLS_TEST_BROWSER ?? 'chromium';
const browserType = { chromium, firefox, webkit }[browserName];
if (!browserType) throw new Error('Unknown test browser');
const browser = await browserType.launch(
  browserName === 'chromium'
    ? { args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] }
    : {},
);
try {
  for (const transport of ['fetch', 'xhr'])
    for (const scenario of process.env.HLS_PART_SCENARIOS?.split(',') ?? [
      'll-av',
      'll-av-lag',
      'll-av-fault',
    ]) {
      const id = `parts-${transport}-${scenario}-${Date.now().toString(36)}`;
      const page = await browser.newPage({ ignoreHTTPSErrors: true });
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(base + '/harness.html');
      const started = Date.now();
      await page.evaluate(
        async ({ url, transport }) => {
          const { ThePlayer } = await import('/player.js');
          window.player = new ThePlayer(document.querySelector('video'));
          window.failures = [];
          window.player.addEventListener('error', (event) =>
            window.failures.push(String(event.detail)),
          );
          await window.player.load({
            protocol: 'hls',
            url,
            targetBuffer: 4,
            network: { transport },
          });
        },
        { url: `${base}/scenario/${id}/${scenario}/index.m3u8`, transport },
      );
      try {
        await page.waitForFunction(
          () => document.querySelector('video').currentTime > 0.1,
          null,
          { timeout: 5000 },
        );
        assert.ok(
          Date.now() - started < 2000,
          'Start on partial-only playlist before the first parent is complete',
        );
        await page.waitForFunction(
          () => document.querySelector('video').currentTime > 7,
          null,
          { timeout: 20000 },
        );
        await page.evaluate(() =>
          window.player.selectAudioTrack(window.player.audioTracks[1].name),
        );
        await page.waitForFunction(
          () => document.querySelector('video').currentTime > 10,
          null,
          { timeout: 8000 },
        );
        assert.equal(
          await page.evaluate(() => window.player.selectedAudioTrack),
          await page.evaluate(() => window.player.audioTracks[1].name),
        );
        await page.evaluate(() =>
          window.player.selectAudioTrack(window.player.audioTracks[0].name),
        );
        await page.waitForFunction(
          () => document.querySelector('video').currentTime > 13,
          null,
          { timeout: 8000 },
        );
        const result = await page.evaluate(() => ({
          diagnostics: window.player.diagnostics,
          failures: window.failures,
          width: document.querySelector('video').videoWidth,
          audio: window.player.audioTracks,
          selected: window.player.selectedAudioTrack,
          audioBytes:
            document.querySelector('video').webkitAudioDecodedByteCount,
          frames: document.querySelector('video').getVideoPlaybackQuality()
            .totalVideoFrames,
        }));
        assert.deepEqual(result.failures, []);
        assert.deepEqual(errors, []);
        assert.equal(result.width, 320);
        assert.ok(result.frames > 220);
        assert.equal(result.diagnostics.live.restarts, 0);
        assert.ok(result.diagnostics.playlistReload.blocking > 20);
        assert.equal(result.audio.length, 2);
        assert.ok(result.selected);
        if (typeof result.audioBytes === 'number')
          assert.ok(result.audioBytes > 0, 'Audio samples are decoded');
        if (!process.env.HLS_RECOVERY_BASE) {
          for (const lane of ['audio', 'video', 'audio2']) {
            assert.ok(
              (requests.get(id + ':' + lane + ':blocking') ?? 0) >
                (lane === 'audio2' ? 2 : 10),
              'Independent blocking reload ' + lane,
            );
            assert.ok(
              [...requests.keys()].filter((k) =>
                k.startsWith(`/scenario/${id}/${scenario}/${lane}/part`),
              ).length > (lane === 'audio2' ? 4 : 20),
              'Independent partial delivery ' + lane,
            );
          }
          if (scenario === 'll-av-fault')
            assert.ok(
              requests.get(`/scenario/${id}/${scenario}/audio/part008.m4s`) >=
                3,
              'Audio fault recovered',
            );
        }
        await page.evaluate(() => window.player.destroy());
        console.log(
          'PASS independent LL-HLS audio/video parts',
          browserName,
          transport,
          scenario,
          result.diagnostics.playlistReload,
        );
      } catch (error) {
        console.error(
          await page.evaluate(() => ({
            diagnostics: window.player.diagnostics,
            errors: window.failures,
            time: document.querySelector('video').currentTime,
            mediaError: document.querySelector('video').error?.message,
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
