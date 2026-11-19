import { caseDeadline } from './helpers/case-deadline.mjs';
import { chromium, firefox, webkit } from 'playwright';
import assert from 'node:assert/strict';
import { dashServer } from './helpers/dash-server.mjs';
const name = process.env.DASH_TEST_BROWSER ?? 'chromium';
const browser = await { chromium, firefox, webkit }[name].launch(
  name === 'chromium'
    ? { args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] }
    : {},
);
try {
  for (const transport of ['fetch', 'xhr'])
    for (const mode of ['query', 'headers'])
      for (const version of [1, 2]) {
        const deadline = caseDeadline('DASH thumbnail/telemetry browser case');
        const { server, controls } = dashServer();
        await new Promise((r) => server.listen(0, '127.0.0.1', r));
        const page = await browser.newPage();
        try {
          await page.goto(
            `http://127.0.0.1:${server.address().port}/harness.html`,
          );
          await page.evaluate(
            async (options) => {
              const { ThePlayer } = await import('/player.js');
              window.player = new ThePlayer(document.querySelector('video'));
              window.qoe = [];
              window.periods = [];
              player.addEventListener('qoe', (e) => qoe.push(e.detail));
              player.addEventListener('periodchange', (e) =>
                periods.push(e.detail),
              );
              await player.load({
                protocol: 'dash',
                url: location.origin + '/dash/periods.mpd',
                targetBuffer: 2,
                quality: 0,
                cmcd: {
                  version: options.version,
                  mode: options.mode,
                  sessionId: 'test-session',
                },
                network: { transport: options.transport },
              });
            },
            { transport, mode, version },
          );
          await page.waitForFunction(
            () => document.querySelector('video').currentTime > 1,
          );
          const media = controls.telemetry.find((r) =>
            r.path.includes('segment-0-'),
          );
          assert.ok(media);
          const report = mode === 'query' ? media.query : media.object;
          assert.ok(report.includes(version === 2 ? 'br=(' : 'br='));
          assert.ok(report.includes('ot=v'));
          const qoe = await page.evaluate(() => player.diagnostics.qoe);
          assert.ok(qoe.startupMs >= 0);
          assert.ok(qoe.totalFrames > 0);
          assert.equal(
            await page.evaluate(() => player.diagnostics.delivery.cmsd.dynamic),
            'testcdn;etp=5000',
          );
          await page.locator('video').evaluate((v) => (v.currentTime = 15));
          await page.waitForFunction(() => periods.some((p) => p.start === 12));
          assert.ok(await page.evaluate(() => qoe.length > 0));
          await page.evaluate(() => player.destroy());
        } finally {
          await page.close();
          await new Promise((r) => server.close(r));
          deadline.finish();
        }
        console.log(
          name,
          transport,
          mode,
          version,
          'CMCD, CMSD, QoE and playhead Period lifecycle PASS',
        );
      }
} finally {
  await browser.close();
}
