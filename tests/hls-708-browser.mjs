import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
await mkdir(new URL('../test-results/', import.meta.url), { recursive: true });
import { faultServer } from './helpers/hls-fault-server.mjs';
const { server } = faultServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base =
  process.env.HLS_RECOVERY_BASE ?? `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
});
try {
  for (const kind of ['mp4', 'ts', 'cdp'])
    for (const transport of ['fetch', 'xhr']) {
      const page = await browser.newPage({ ignoreHTTPSErrors: true });
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(base + '/harness.html');
      await page.evaluate(
        async ({ url, transport }) => {
          const { ThePlayer } = await import('/player.js');
          const video = document.querySelector('video');
          video.style.width = '640px';
          video.style.height = '360px';
          window.player = new ThePlayer(video);
          window.failures = [];
          window.player.addEventListener('error', (e) =>
            window.failures.push(String(e.detail)),
          );
          window.loading = window.player
            .load({ protocol: 'hls', url, network: { transport } })
            .catch((e) => window.failures.push(String(e)));
        },
        { url: base + '/fixture/cea708-' + kind + '.m3u8', transport },
      );
      try {
        await page.waitForFunction(
          () =>
            document
              .querySelector('.theplayer-cea708')
              ?.textContent.includes('Left aligned'),
          null,
          { timeout: 15000 },
        );
        await page.waitForFunction(
          () => document.querySelector('video').currentTime > 0.2,
        );
        const layout = await page.evaluate(() => {
          const overlay = document
            .querySelector('.theplayer-cea708')
            .getBoundingClientRect();
          const window = document
            .querySelector('.theplayer-cea708 [data-window="0"]')
            .getBoundingClientRect();
          const cells = [
            ...document.querySelectorAll('.theplayer-cea708 span'),
          ].map((s) => s.getBoundingClientRect());
          document.querySelector('video').pause();
          return {
            x: (window.left - overlay.left) / overlay.width,
            width: window.width / overlay.width,
            count: cells.length,
            oneRow: cells.every((c) => c.top === cells[0].top),
          };
        });
        assert.ok(layout.x > 0.25 && layout.x < 0.28, JSON.stringify(layout));
        assert.equal(layout.count, 12);
        assert.equal(layout.oneRow, true);
        assert.ok(layout.width > 0.22 && layout.width < 0.24);
        if (kind === 'mp4' && transport === 'fetch')
          await page.screenshot({
            path: new URL('../test-results/cea708-layout.png', import.meta.url)
              .pathname,
          });
        await page.evaluate(() =>
          window.player.selectSubtitleTrack('hls-708-2'),
        );
        await page.waitForFunction(
          () =>
            document.querySelector('.theplayer-cea708')?.textContent ===
            'Ж中가',
        );
        await page.evaluate(
          () => (document.querySelector('video').currentTime = 8.75),
        );
        await page.waitForFunction(
          () =>
            !document.querySelector('video').seeking &&
            document.querySelector('.theplayer-cea708')?.textContent ===
              'Ж中가',
        );
        const state = await page.evaluate(() => ({
          errors: window.failures,
          diagnostics: window.player.diagnostics,
          tracks: window.player.subtitleTracks,
        }));
        assert.deepEqual(state.errors, []);
        assert.deepEqual(errors, []);
        assert.equal(state.diagnostics.captions708.errors, 0);
        assert.ok(state.diagnostics.captions708.packets > 20);
        assert.equal(
          state.tracks.filter((t) => t.format === 'cea-708').length,
          2,
        );
        await page.evaluate(() => window.player.selectSubtitleTrack(''));
        assert.equal(await page.locator('.theplayer-cea708').count(), 0);
        await page.evaluate(() => window.player.destroy());
        console.log(
          'PASS CEA-708 geometry, P16, services, seek and Off',
          kind,
          transport,
        );
      } catch (error) {
        console.error(
          await page.evaluate(() => ({
            diagnostics: window.player.diagnostics,
            tracks: window.player.subtitleTracks,
            failures: window.failures,
            caption: document.querySelector('.theplayer-cea708')?.outerHTML,
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
