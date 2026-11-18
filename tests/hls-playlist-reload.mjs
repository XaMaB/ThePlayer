import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { faultServer } from './helpers/hls-fault-server.mjs';
const { server, requests } = faultServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base =
  process.env.HLS_RECOVERY_BASE ?? `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
});
try {
  for (const transport of ['fetch', 'xhr'])
    for (const scenario of process.env.HLS_RELOAD_SCENARIOS?.split(',') ?? [
      'll-block',
      'll-missing',
      'll-reject',
      'll-timeout',
      'll-dates',
      'll-dates-invalid',
    ]) {
      const id = `${transport}-${scenario}-${Date.now().toString(36)}`;
      const page = await browser.newPage({ ignoreHTTPSErrors: true });
      await page.goto(base + '/harness.html');
      await page.evaluate(
        async ({ url, transport, scenario }) => {
          const { ThePlayer } = await import('/player.js');
          window.player = new ThePlayer(document.querySelector('video'));
          window.failures = [];
          window.dateEvents = [];
          for (const type of ['daterange', 'daterangeremove'])
            window.player.addEventListener(type, (e) =>
              window.dateEvents.push({
                type,
                id: e.detail.id,
                duration: e.detail.duration,
              }),
            );
          window.player.addEventListener('error', (event) =>
            window.failures.push(String(event.detail)),
          );
          await window.player.load({
            protocol: 'hls',
            url,
            targetBuffer: 4,
            network: {
              transport,
              timeoutMs: scenario === 'll-timeout' ? 500 : undefined,
            },
          });
        },
        {
          url: `${base}/scenario/${id}/${scenario}/index.m3u8`,
          transport,
          scenario,
        },
      );
      try {
        await page.waitForFunction(
          () => document.querySelector('video').currentTime > 18,
          null,
          { timeout: 22000 },
        );
        const result = await page.evaluate(() => ({
          diagnostics: window.player.diagnostics,
          failures: window.failures,
          dateEvents: window.dateEvents,
        }));
        assert.deepEqual(result.failures, []);
        assert.equal(result.diagnostics.live.restarts, 0);
        const d = result.diagnostics.playlistReload;
        assert.ok(d.blocking > 0);
        if (scenario === 'll-block') assert.ok(d.delta > 0);
        if (scenario.startsWith('ll-dates')) {
          assert.ok(
            result.dateEvents.some(
              (e) =>
                e.type === 'daterange' &&
                e.id === 'persist' &&
                e.duration === 4,
            ),
          );
          assert.ok(
            result.dateEvents.some(
              (e) => e.type === 'daterangeremove' && e.id === 'old',
            ),
          );
          if (scenario === 'll-dates') {
            assert.ok(d.delta > 0);
            assert.equal(d.fullReloads, 0);
          } else assert.ok(d.fullReloads > 0);
        }
        if (scenario === 'll-missing') assert.ok(d.fullReloads > 0);
        if (scenario === 'll-reject' || scenario === 'll-timeout')
          assert.equal(d.directiveFallbacks, 1);
        if (!process.env.HLS_RECOVERY_BASE && scenario !== 'll-reject')
          assert.ok(requests.get(id + ':waited') > 0);
        await page.evaluate(() => window.player.destroy());
        console.log('PASS playlist delivery', transport, scenario, d);
      } catch (error) {
        console.error(
          await page.evaluate(() => ({
            diagnostics: window.player.diagnostics,
            errors: window.failures,
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
