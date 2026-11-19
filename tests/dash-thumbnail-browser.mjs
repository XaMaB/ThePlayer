import { caseDeadline } from './helpers/case-deadline.mjs';
import { chromium, firefox, webkit } from 'playwright';
import assert from 'node:assert/strict';
import { dashServer } from './helpers/dash-server.mjs';
const name = process.env.DASH_TEST_BROWSER ?? 'chromium';
const browser = await { chromium, firefox, webkit }[name].launch(
  name === 'chromium' ? { args: ['--no-sandbox'] } : {},
);
try {
  for (const transport of ['fetch', 'xhr']) {
    const deadline = caseDeadline('DASH thumbnail/telemetry browser case');
    const { server, requests } = dashServer();
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const page = await browser.newPage();
    try {
      await page.goto(`http://127.0.0.1:${server.address().port}/harness.html`);
      const result = await page.evaluate(async (transport) => {
        const { ThePlayer } = await import('/player.js');
        window.player = new ThePlayer(document.querySelector('video'));
        await player.load({
          protocol: 'dash',
          url: location.origin + '/dash/thumbnails.mpd',
          autoplay: false,
          network: { transport },
        });
        const tiles = [];
        for (const time of [1, 7, 13, 19]) {
          const t = await player.getThumbnail(time);
          const image = new Image();
          image.src = t.url;
          await image.decode();
          if (image.naturalWidth !== 320 || image.naturalHeight !== 180)
            throw new Error('JPEG was not decoded');
          tiles.push([t.x, t.y, t.width, t.height, t.time, t.end]);
        }
        const sheet = await player.getThumbnail(1);
        const missing = await player.getThumbnail(25);
        await player.destroy();
        let revoked = false;
        try {
          await fetch(sheet.url);
        } catch {
          revoked = true;
        }
        return { tiles, missing: missing === undefined, revoked };
      }, transport);
      assert.deepEqual(result.tiles, [
        [0, 0, 160, 90, 0, 6],
        [160, 0, 160, 90, 6, 12],
        [0, 90, 160, 90, 12, 18],
        [160, 90, 160, 90, 18, 24],
      ]);
      assert.ok(result.missing);
      assert.ok(result.revoked);
      assert.equal(
        requests.filter((u) => u.endsWith('thumbnails.jpg')).length,
        1,
      );
    } finally {
      await page.close();
      await new Promise((r) => server.close(r));
      deadline.finish();
    }
    console.log(
      name,
      transport,
      'DASH thumbnail decoding, row order, cache and teardown PASS',
    );
  }
} finally {
  await browser.close();
}
