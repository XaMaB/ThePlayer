import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { dashServer } from './helpers/dash-server.mjs';
const { server } = dashServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
});
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(
    `${base}/index.html?src=${encodeURIComponent(base + '/dash/timeline.mpd')}`,
  );
  await page.waitForFunction(
    () =>
      window.player?.protocol === 'dash' &&
      document.querySelector('video').currentTime > 1,
  );
  assert.equal(await page.locator('#source-protocol').inputValue(), 'dash');
  assert.equal(await page.locator('#hls-example option').count(), 6);
  assert.equal(await page.locator('#live-button').isVisible(), false);
  await page.locator('#screen').hover();
  await page.locator('#quality-toggle').click();
  assert.equal(
    await page.locator('#quality-menu [role=menuitemradio]').count(),
    3,
  );
  await page.locator('#quality-toggle').click();
  await page.locator('#audio-toggle').click();
  assert.equal(
    await page.locator('#audio-menu [role=menuitemradio]').count(),
    2,
  );
  await page.locator('#audio-toggle').click();
  await page.locator('#screen').click({ button: 'right' });
  assert.match(await page.locator('#player-menu').innerText(), /ThePlayer/);
  assert.match(
    await page.locator('#player-menu').innerText(),
    /1\.0\.0-alpha\.9/,
  );
  await page.locator('#hls-url').fill(base + '/dash/live.mpd?session=ui');
  await page.locator('#connect').click();
  await page.waitForFunction(
    () =>
      window.player?.isLive && document.querySelector('video').currentTime > 1,
  );
  await page.waitForFunction(
    () => !document.querySelector('#live-button').hidden,
  );
  await page.waitForFunction(
    () => window.player?.diagnostics.state === 'playing',
  );
  await page.locator('#disconnect').click();
  await page.waitForFunction(
    () => !document.querySelector('video').getAttribute('src'),
  );
  assert.deepEqual(errors, []);

  console.log(
    'DASH demo source detection, examples, quality/audio menus, VOD LIVE visibility and version PASS',
  );
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
