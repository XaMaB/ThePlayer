import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { faultServer } from './helpers/hls-fault-server.mjs';
const { server, requests } = faultServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base =
  process.env.HLS_RECOVERY_BASE ?? `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
});
try {
  for (const transport of ['fetch', 'xhr'])
    for (const scenario of process.env.HLS_STEERING_SCENARIOS?.split(',') ?? [
      'steering-switch',
      'steering-audio',
      'steering-abr',
      'steering-initial',
      'steering-first-media',
      'steering-failover',
      'steering-clone',
      'steering-gone',
      'steering-malformed',
    ]) {
      const id = `steer-${transport}-${scenario}-${Date.now().toString(36)}`,
        page = await browser.newPage({ ignoreHTTPSErrors: true });
      try {
        await page.goto(base + '/harness.html');
        await page.evaluate(
          async ({ url, transport }) => {
            const { ThePlayer } = await import('/player.js');
            window.player = new ThePlayer(document.querySelector('video'));
            window.errors = [];
            window.paths = [];
            window.player.addEventListener('error', (e) =>
              window.errors.push(String(e.detail)),
            );
            window.player.addEventListener('pathwaychange', (e) =>
              window.paths.push(e.detail),
            );
            window.loading = window.player
              .load({
                protocol: 'hls',
                url,
                targetBuffer: 4,
                audioLanguage: 'es',
                subtitleLanguage: 'en',
                quality: url.includes('/steering-abr/') ? 'auto' : 0,
                network: { transport },
              })
              .catch((e) => window.errors.push(String(e)));
          },
          { url: `${base}/scenario/${id}/${scenario}/master.m3u8`, transport },
        );
        await page.waitForFunction(
          () =>
            document.querySelector('video').currentTime > 11 ||
            window.errors.length,
          null,
          { timeout: 23000 },
        );
        const state = await page.evaluate(() => ({
          time: document.querySelector('video').currentTime,
          width: document.querySelector('video').videoWidth,
          errors: window.errors,
          paths: window.paths,
          diag: window.player.diagnostics,
          audio: window.player.audioTracks.find(
            (t) => t.name === window.player.selectedAudioTrack,
          ),
          subtitles: window.player.subtitleTracks,
          cues: Array.from(document.querySelector('video').textTracks).flatMap(
            (t) => Array.from(t.cues ?? []).map((c) => c.text),
          ),
        }));
        assert.deepEqual(state.errors, []);
        if (scenario === 'steering-abr') {
          assert.equal(state.width, 640);
          assert.equal(state.diag.quality.mode, 'auto');
          assert.equal(state.diag.quality.current, 1);
        }
        if (scenario === 'steering-audio') {
          assert.equal(state.audio.language, 'es');
          assert.ok(state.audio.url.includes('/b/'));
          assert.ok(state.subtitles.some((t) => t.url?.includes('/b/')));
          assert.ok(state.cues.length > 0);
        }
        assert.ok(state.time > 11);
        const target =
          scenario === 'steering-clone'
            ? 'c'
            : ['steering-gone', 'steering-malformed'].includes(scenario)
              ? 'a'
              : 'b';
        assert.equal(state.diag.steering.pathway, target);
        if (target !== 'a') {
          assert.ok(state.paths.some((p) => p.pathway === target));
          if (!process.env.HLS_RECOVERY_BASE)
            assert.ok(requests.get(id + ':pathway:' + target) > 2);
        }
        await page.evaluate(() => {
          const v = document.querySelector('video');
          v.pause();
          v.currentTime = 2;
        });
        await page.waitForFunction(
          () =>
            !document.querySelector('video').seeking &&
            document.querySelector('video').readyState >= 2,
        );
        assert.deepEqual(await page.evaluate(() => window.errors), []);
        await page.evaluate(() => window.player.destroy());
        console.log(
          'PASS steering playback, pathway changes and seek',
          transport,
          scenario,
        );
      } catch (e) {
        console.error(
          await page.evaluate(() => ({
            errors: window.errors,
            diag: window.player?.diagnostics,
            time: document.querySelector('video').currentTime,
          })),
        );
        throw e;
      } finally {
        await page.close();
      }
    }
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
}
