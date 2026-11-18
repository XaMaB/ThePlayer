import { chromium, firefox, webkit } from 'playwright';
import assert from 'node:assert/strict';
import { dashServer } from './helpers/dash-server.mjs';
const { server } = dashServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const name = process.env.DASH_TEST_BROWSER ?? 'chromium';
const browser = await { chromium, firefox, webkit }[name].launch(
  name === 'chromium'
    ? { args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] }
    : {},
);
try {
  for (const transport of ['fetch', 'xhr']) {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/harness.html`);
    await page.evaluate(async (transport) => {
      const { ThePlayer } = await import('/player.js');
      window.player = new ThePlayer(document.querySelector('video'));
      window.events = [];
      window.errors = [];
      window.player.addEventListener('metadata', (e) =>
        window.events.push(e.detail),
      );
      window.player.addEventListener('error', (e) =>
        window.errors.push(e.detail.message),
      );
      await window.player.load({
        protocol: 'dash',
        url: location.origin + '/dash/metadata.mpd',
        quality: 0,
        network: { transport },
      });
    }, transport);
    await page.waitForFunction(
      () => document.querySelector('video').currentTime > 2,
    );
    const events = await page.evaluate(() =>
      window.events.map((e) => ({
        type: e.type,
        time: e.time,
        id: e.id,
        duration: e.duration,
        data:
          typeof e.data === 'string'
            ? e.data
            : new TextDecoder().decode(e.data),
      })),
    );
    assert.equal(events.length, 2);
    assert.ok(
      events.some(
        (e) =>
          e.type === 'dash-event' &&
          e.data === 'safe metadata' &&
          e.time === 1 &&
          e.duration === 0.5,
      ),
    );
    assert.ok(
      events.some(
        (e) =>
          e.type === 'emsg' &&
          e.data === 'payload' &&
          e.time === 1 &&
          e.id === 7,
      ),
    );
    await page.locator('video').evaluate((v) => {
      v.currentTime = 1;
    });
    await page.waitForFunction(
      () => document.querySelector('video').currentTime > 3,
    );
    assert.equal(await page.evaluate(() => window.events.length), 2);
    assert.deepEqual(await page.evaluate(() => window.errors), []);
    await page.evaluate(() => window.player.destroy());
    console.log(
      name,
      transport,
      'DASH EventStream/emsg timestamps, payloads and duplicate suppression PASS',
    );
    await page.close();
  }
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
