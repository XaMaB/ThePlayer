import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { faultServer } from './helpers/hls-fault-server.mjs';
const { server } = faultServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base =
  process.env.HLS_RECOVERY_BASE ?? `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
});
try {
  for (const [kind, transport] of ['mp4', 'ts'].flatMap((kind) =>
    ['fetch', 'xhr'].map((transport) => [kind, transport]),
  )) {
    const page = await browser.newPage({ ignoreHTTPSErrors: true });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(base + '/harness.html');
    await page.evaluate(
      async ({ url, transport }) => {
        const { ThePlayer } = await import('/player.js');
        window.player = new ThePlayer(document.querySelector('video'));
        window.failures = [];
        for (const name of ['error', 'captionwarning'])
          window.player.addEventListener(name, (e) =>
            window.failures.push(String(e.detail)),
          );
        window.captionText = () =>
          [...document.querySelector('video').textTracks]
            .filter((track) => track.mode === 'showing')
            .flatMap((track) => [...(track.activeCues ?? [])])
            .map((cue) =>
              cue.getCueAsHTML().textContent.replaceAll('\u00a0', ' '),
            )
            .join('\n');
        await window.player.load({
          protocol: 'hls',
          url,
          network: { transport },
        });
      },
      { url: base + '/fixture/sei-' + kind + '.m3u8', transport },
    );
    try {
      await page.waitForFunction(
        () => window.captionText().includes('SEI CC1'),
        null,
        { timeout: 15000 },
      );
      await page.evaluate(() => {
        document.querySelector('video').pause();
        window.player.selectSubtitleTrack('hls-608-3');
      });
      await page.waitForFunction(() =>
        window.captionText().includes('SEI CC3'),
      );
      await page.evaluate(() => {
        document.querySelector('video').currentTime = 8.75;
      });
      await page.waitForFunction(
        () =>
          !document.querySelector('video').seeking &&
          window.captionText().includes('SEI CC3'),
      );
      const state = await page.evaluate(() => ({
        errors: window.failures,
        diagnostics: window.player.diagnostics,
        tracks: window.player.subtitleTracks,
      }));
      assert.deepEqual(state.errors, []);
      assert.deepEqual(errors, []);
      assert.ok(state.diagnostics.captions608.packets > 20);
      assert.ok(state.tracks.some((track) => track.service === 1));
      assert.ok(state.tracks.some((track) => track.service === 3));
      await page.evaluate(() => window.player.destroy());
      console.log('PASS AVC SEI 608 fields and seeking', kind, transport);
    } catch (error) {
      console.error(
        await page.evaluate(() => ({
          failures: window.failures,
          captions: window.captionText(),
          diagnostics: window.player.diagnostics,
          tracks: window.player.subtitleTracks,
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
