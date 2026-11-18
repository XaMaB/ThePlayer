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
    : {},
);
try {
  for (const transport of ['fetch', 'xhr'])
    for (const mode of (
      process.env.HLS_DATE_PRELOAD_SCENARIOS ??
      'direct,list,mismatch,removed,vod,fault,slow,join'
    ).split(',')) {
      const page = await browser.newPage({ ignoreHTTPSErrors: true }),
        id = `preload-${mode}-${transport}-${Date.now().toString(36)}`,
        prefix = `/scenario/${id}/interstitial-preload-${mode}/`;
      const requests = new Map();
      const offsets = [];
      page.on('request', (request) => {
        const url = new URL(request.url()),
          path = url.pathname;
        if (path === prefix + 'ad.m3u8')
          offsets.push(url.searchParams.get('_HLS_start_offset'));
        if (request.method() === 'GET' && path.startsWith(prefix))
          requests.set(path, (requests.get(path) ?? 0) + 1);
      });
      try {
        await page.addInitScript(() => {
          Math.random = () => 0.25;
        });
        await page.goto(base + '/harness.html');
        await page.evaluate(
          async ({ prefix, transport, mode }) => {
            const { ThePlayer } = await import('/player.js');
            window.player = new ThePlayer(document.querySelector('video'));
            window.errors = [];
            window.warnings = [];
            window.insertions = [];
            window.restored = false;
            window.player.addEventListener('error', (e) =>
              window.errors.push(String(e.detail)),
            );
            window.player.addEventListener('interstitialwarning', (e) =>
              window.warnings.push(String(e.detail?.message)),
            );
            window.player.addEventListener('interstitialstart', (e) =>
              window.insertions.push(e.detail),
            );
            window.player.addEventListener(
              'interstitialend',
              () => (window.restored = true),
            );
            window.player
              .load({
                protocol: 'hls',
                url: location.origin + prefix + 'index.m3u8',
                network: { transport },
                startTime: mode === 'join' ? 6 : 0,
                targetBuffer: 4,
              })
              .catch((e) => window.errors.push(String(e)));
          },
          { prefix, transport, mode },
        );
        await page.waitForFunction(
          (mode) => {
            const time = document.querySelector('video').currentTime;
            return (
              window.errors.length ||
              (time > 1.2 &&
                (mode !== 'join' || (window.insertions.length && time < 4)))
            );
          },
          mode,
          { timeout: 15000 },
        );
        assert.deepEqual(await page.evaluate(() => window.errors), []);
        const resource = mode === 'list' ? 'list.json' : 'ad.m3u8';
        assert.equal(
          requests.get(prefix + resource) ?? 0,
          ['vod', 'mismatch'].includes(mode) ? 0 : 1,
          'Preload request precedes scheduled insertion',
        );
        assert.equal(requests.get(prefix + 'unused.m3u8') ?? 0, 0);
        await page.waitForFunction(
          () => window.restored || window.errors.length,
          null,
          { timeout: 20000 },
        );
        const result = await page.evaluate(() => ({
          errors: window.errors,
          events: window.insertions,
          time: document.querySelector('video').currentTime,
        }));
        assert.deepEqual(result.errors, []);
        assert.equal(result.events.length, 1);
        assert.ok(result.time >= 4);
        assert.equal(
          requests.get(prefix + resource),
          ['removed', 'fault', 'slow'].includes(mode) ? 2 : 1,
          'Reuse only a valid completed preload; otherwise reload normally',
        );
        if (mode === 'join')
          assert.ok(
            Number(offsets[0]) >= 2,
            'Live join carries a meaningful start offset',
          );
        else
          assert.ok(
            offsets.every((offset) => offset === null),
            'Ordinary scheduling does not add a tune-in offset',
          );
        await page.evaluate(() => window.player.destroy());
        console.log(
          'PASS date-range preload timing, reuse and fallback',
          name,
          transport,
          mode,
        );
      } catch (error) {
        console.error(
          mode,
          transport,
          await page.evaluate(() => ({
            errors: window.errors,
            warnings: window.warnings,
            time: document.querySelector('video').currentTime,
            insertions: window.insertions,
            diag: window.player.diagnostics,
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
