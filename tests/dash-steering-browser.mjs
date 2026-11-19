import { chromium, firefox, webkit } from 'playwright';
import assert from 'node:assert/strict';
import { dashServer } from './helpers/dash-server.mjs';
import { caseDeadline } from './helpers/case-deadline.mjs';
const name = process.env.DASH_TEST_BROWSER ?? 'chromium';
const browser = await { chromium, firefox, webkit }[name].launch(
  name === 'chromium'
    ? { args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] }
    : {},
);
try {
  for (const transport of ['fetch', 'xhr']) {
    const deadline = caseDeadline(`${name} steering ${transport}`);
    const { server, controls, requests } = dashServer();
    if (transport === 'fetch') {
      controls.steeringPriority = ['clone', 'good'];
      controls.steeringClones = [
        {
          'BASE-ID': 'good',
          ID: 'clone',
          'URI-REPLACEMENT': { PARAMS: { pathway: 'clone' } },
        },
      ];
    }
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const page = await browser.newPage();
    try {
      await page.goto(`http://127.0.0.1:${server.address().port}/harness.html`);
      await page.evaluate(async (transport) => {
        const { ThePlayer } = await import('/player.js');
        window.player = new ThePlayer(document.querySelector('video'));
        window.errors = [];
        player.addEventListener('error', (e) => errors.push(e.detail.message));
        await player.load({
          protocol: 'dash',
          url: location.origin + '/dash/steering.mpd',
          targetBuffer: 2,
          quality: 0,
          network: { transport },
        });
      }, transport);
      await page.waitForFunction(
        () => document.querySelector('video').currentTime > 1,
      );
      assert.ok(controls.steeringRequests.length > 0);
      assert.equal(
        requests.filter((u) => u.startsWith('/missing/')).length,
        0,
        'Startup steering precedes media load',
      );
      if (transport === 'fetch')
        assert.ok(
          controls.cloneRequests > 0,
          'Cloned URI parameters reach the media server',
        );
      controls.steeringPriority = ['bad', 'good'];
      await page.waitForFunction(
        () => player.diagnostics.delivery.failures > 0,
      );
      await page.waitForFunction(
        () => document.querySelector('video').currentTime > 5,
      );
      assert.equal(
        await page.evaluate(() => player.diagnostics.steering.pathway),
        'good',
      );
      controls.steeringStatus = 410;
      await page.waitForFunction(() => player.diagnostics.steering.disabled);
      const count = controls.steeringRequests.length;
      await page.waitForFunction(
        () => document.querySelector('video').currentTime > 8,
      );
      assert.equal(
        controls.steeringRequests.length,
        count,
        '410 stops steering reloads',
      );
      assert.deepEqual(await page.evaluate(() => errors), []);
    } finally {
      await page.evaluate(() => window.player?.destroy());
      await page.close();
      await new Promise((r) => server.close(r));
      deadline.finish();
    }
    console.log(
      name,
      transport,
      'DASH steering startup, TTL, CDN outage and 410 retention PASS',
    );
  }
} finally {
  await browser.close();
}
