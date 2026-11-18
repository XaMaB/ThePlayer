import { chromium, firefox, webkit } from 'playwright';
import assert from 'node:assert/strict';
import { faultServer } from './helpers/hls-fault-server.mjs';
const { server } = faultServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base =
  process.env.HLS_RECOVERY_BASE ?? `http://127.0.0.1:${server.address().port}`;
const browserName = process.env.HLS_TEST_BROWSER ?? 'chromium';
const browser = await { chromium, firefox, webkit }[browserName].launch(
  browserName === 'chromium'
    ? { args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] }
    : {},
);
try {
  for (const [kind, transport] of (process.env.HLS_CAPTION_KIND
    ? [process.env.HLS_CAPTION_KIND]
    : ['mp4', 'ts', 'c608']
  ).flatMap((kind) => ['fetch', 'xhr'].map((transport) => [kind, transport]))) {
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
            window.failures.push(e.detail?.stack ?? String(e.detail)),
          );
        window.captionText = () =>
          document.querySelector('.theplayer-cea608')?.textContent ??
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
      {
        url:
          base +
          '/fixture/' +
          (kind === 'c608'
            ? 'caption-tracks/index.m3u8'
            : 'sei-' + kind + '.m3u8'),
        transport,
      },
    );
    try {
      if (kind === 'c608') {
        await page.waitForFunction(() =>
          window.player.subtitleTracks.some(
            (track) => track.name === 'hls-608-1',
          ),
        );
        await page.evaluate(() =>
          window.player.selectSubtitleTrack('hls-608-1'),
        );
      }
      await page.waitForFunction(
        (text) => window.captionText().includes(text),
        kind === 'c608' ? 'ThePlayer' : 'SEI CC1',
        { timeout: 15000 },
      );
      await page.evaluate((kind) => {
        document.querySelector('video').pause();
        if (kind !== 'c608') window.player.selectSubtitleTrack('hls-608-3');
      }, kind);
      const expectedText = kind === 'c608' ? 'ThePlayer' : 'SEI CC3';
      await page.waitForFunction(
        (text) => window.captionText().includes(text),
        expectedText,
      );
      await page.evaluate(() => {
        document.querySelector('video').currentTime = 8.75;
      });
      await page.waitForFunction(
        (text) =>
          !document.querySelector('video').seeking &&
          window.captionText().includes(text),
        expectedText,
      );
      const state = await page.evaluate(() => ({
        errors: window.failures,
        diagnostics: window.player.diagnostics,
        tracks: window.player.subtitleTracks,
      }));
      assert.deepEqual(state.errors, []);
      assert.deepEqual(errors, []);
      assert.ok(state.diagnostics.captions608.packets > 0);
      assert.ok(state.tracks.some((track) => track.service === 1));
      if (kind !== 'c608')
        assert.ok(state.tracks.some((track) => track.service === 3));
      await page.evaluate(() => window.player.selectSubtitleTrack(''));
      assert.equal(await page.locator('.theplayer-cea608').count(), 0);
      assert.equal(await page.evaluate(() => window.captionText()), '');
      await page.evaluate(() => window.player.destroy());
      assert.equal(await page.locator('.theplayer-cea608').count(), 0);
      console.log(
        'PASS AVC SEI 608 fields, rendered text, seeking and cleanup',
        browserName,
        kind,
        transport,
      );
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
