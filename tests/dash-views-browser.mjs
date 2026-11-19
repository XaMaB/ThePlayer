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
    const deadline = caseDeadline(`${name} views ${transport}`);
    const { server } = dashServer();
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
          url: location.origin + '/dash/views.mpd',
          targetBuffer: 2,
          audioLanguage: transport === 'fetch' ? 'bg' : 'en',
          audioRole: transport === 'xhr' ? 'description' : undefined,
          network: { transport },
        });
      }, transport);
      await page.waitForFunction(
        () => document.querySelector('video').currentTime > 1,
      );
      assert.equal(await page.evaluate(() => player.videoTracks.length), 2);
      assert.equal(
        await page.evaluate(
          () =>
            player.audioTracks.find((a) => a.name === player.selectedAudioTrack)
              .language,
        ),
        'bul',
      );
      assert.equal(
        await page.evaluate(() => document.querySelector('video').videoWidth),
        320,
      );
      assert.equal(
        await page.evaluate(
          () =>
            player.audioTracks.find((a) => a.name === player.selectedAudioTrack)
              .channels.value,
        ),
        '1',
      );
      await page.evaluate(() => player.selectVideoTrack('side'));
      await page.waitForFunction(
        () => document.querySelector('video').videoWidth === 640,
      );
      assert.equal(
        await page.evaluate(() => player.selectedVideoTrack),
        'side',
      );
      await page.evaluate(() => player.selectVideoTrack('front'));
      await page.waitForFunction(
        () => document.querySelector('video').videoWidth === 320,
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
      'DASH alternate view decoding, switch-back and language alias PASS',
    );
  }
} finally {
  await browser.close();
}
